/**
 * Pure Blocks wire-protocol codec for the pxt-blocks runtime — no transport
 * imports, so it loads in any environment (browser, Node test runner).
 *
 * The same protocol rides two transports:
 *   - BLE GATT — service `0b50f3e4-…-5c`, characteristic UUIDs `0b50_XXXX_…`
 *     where the 16-bit `XXXX` is the channel ID.
 *   - USB serial — framed packets `[SFD(0xFF), type, ch_hi, ch_lo, len, …data, chk]`.
 *
 * Frame logic mirrors the firmware (pxt-blocks BlocksSerial.cpp). The
 * transport-bound helpers (USB write/subscribe, comms logging) live in
 * `blocks-protocol.ts`, which re-exports everything here.
 */

/** Start-of-frame delimiter — must precede every Blocks serial frame. */
export const BLOCKS_SFD = 0xff;

/** Request types we put in `frame[1]` when writing TO the device. */
export const BLOCKS_REQ = {
  READ: 0x01,
  WRITE: 0x10,
  WRITE_RESPONSE: 0x11,
  NOTIFY_STOP: 0x20,
  NOTIFY_START: 0x21,
} as const;

/** Response types the device puts in `frame[1]` when writing back to us. */
export const BLOCKS_RES = {
  READ: 0x01,
  WRITE_RESPONSE: 0x11,
  NOTIFY: 0x21,
} as const;

/**
 * Map full 128-bit characteristic UUIDs (what the iframe carries) to the
 * 16-bit channel IDs (what Blocks serial frames carry). The middle 16 bits
 * of the UUID encode the channel — extract them or use this table.
 */
const CHANNEL_BY_UUID: Record<string, number> = {
  '0b500100-607f-4151-9091-7d008d6ffc5c': 0x0100, // COMMAND
  '0b500101-607f-4151-9091-7d008d6ffc5c': 0x0101, // STATE
  '0b500102-607f-4151-9091-7d008d6ffc5c': 0x0102, // MOTION
  '0b500110-607f-4151-9091-7d008d6ffc5c': 0x0110, // PIN_EVENT
  '0b500111-607f-4151-9091-7d008d6ffc5c': 0x0111, // ACTION_EVENT
  '0b500120-607f-4151-9091-7d008d6ffc5c': 0x0120, // ANALOG_IN_P0
  '0b500121-607f-4151-9091-7d008d6ffc5c': 0x0121, // ANALOG_IN_P1
  '0b500122-607f-4151-9091-7d008d6ffc5c': 0x0122, // ANALOG_IN_P2
  '0b500123-607f-4151-9091-7d008d6ffc5c': 0x0123, // ANALOG_IN_P3
  '0b500130-607f-4151-9091-7d008d6ffc5c': 0x0130, // DATA
};

/**
 * Resolve an iframe-supplied characteristic identifier (full UUID, short
 * UUID number, or raw 16-bit) into the Blocks channel byte pair.
 */
export function characteristicToChannel(id: number | string): number {
  if (typeof id === 'number') return id & 0xffff;
  const lower = String(id).toLowerCase();
  if (lower in CHANNEL_BY_UUID) return CHANNEL_BY_UUID[lower];
  // Fallback: extract bytes 2-3 from a 128-bit UUID like `0b50XXXX-607f-…`.
  const m = /^[0-9a-f]{4}([0-9a-f]{4})/.exec(lower);
  if (m) return parseInt(m[1], 16);
  return 0;
}

/** chksum8 over the bytes preceding it — sum mod 0xFF. */
function chksum8(bytes: ArrayLike<number>, len: number): number {
  let sum = 0;
  for (let i = 0; i < len; i++) sum = (sum + bytes[i]) % 0xff;
  return sum;
}

/** Build a TX frame to write to the wire: `[SFD, type, ch_hi, ch_lo, len, ...data, chk]`. */
export function buildBlocksFrame(
  type: number,
  channel: number,
  data: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const len = data.byteLength;
  const frame = new Uint8Array(6 + len);
  frame[0] = BLOCKS_SFD;
  frame[1] = type;
  frame[2] = (channel >> 8) & 0xff;
  frame[3] = channel & 0xff;
  frame[4] = len;
  frame.set(data, 5);
  frame[5 + len] = chksum8(frame, 5 + len);
  return frame;
}

export interface BlocksFrame {
  /** Response type byte (RES_READ / RES_WRITE_RESPONSE / RES_NOTIFY). */
  type: number;
  /** 16-bit channel id. */
  channel: number;
  /** Payload bytes (length excludes header + checksum). */
  data: Uint8Array;
}

/**
 * Stateful streaming parser — feed bytes in any chunking, get back zero or
 * more complete frames. Invalid checksums and out-of-range types are dropped.
 */
export class BlocksFrameParser {
  private buf: number[] = [];

  push(bytes: Iterable<number>): BlocksFrame[] {
    for (const b of bytes) this.buf.push(b & 0xff);
    return this.drain();
  }

  private drain(): BlocksFrame[] {
    const out: BlocksFrame[] = [];
    while (this.buf.length > 0) {
      // Resync on SFD.
      const sfdIdx = this.buf.indexOf(BLOCKS_SFD);
      if (sfdIdx === -1) {
        this.buf.length = 0;
        return out;
      }
      if (sfdIdx > 0) this.buf.splice(0, sfdIdx);
      if (this.buf.length < 5) return out;
      const type = this.buf[1];
      const validType = type === BLOCKS_RES.READ || type === BLOCKS_RES.WRITE_RESPONSE || type === BLOCKS_RES.NOTIFY;
      if (!validType) {
        // Drop this SFD candidate, scan for next.
        this.buf.shift();
        continue;
      }
      const len = this.buf[4];
      const totalNoChk = 5 + len;
      if (this.buf.length < totalNoChk + 1) return out;
      const chk = this.buf[totalNoChk];
      const computed = chksum8(this.buf, totalNoChk);
      if (chk !== computed) {
        // Bad checksum — drop SFD, resync.
        this.buf.shift();
        continue;
      }
      const channel = (this.buf[2] << 8) | this.buf[3];
      const data = new Uint8Array(this.buf.slice(5, 5 + len));
      out.push({ type, channel, data });
      this.buf.splice(0, totalNoChk + 1);
    }
    return out;
  }
}

/** Default number of valid frame headers before the USB probe confirms Blocks. */
export const BLOCKS_USB_CONFIRM_HITS = 2;

/**
 * Stateful matcher for the USB Blocks-frame heuristic, kept dependency-free so
 * it can be unit-tested without a serial port. Feed serial bytes in any
 * chunking; confirms once it has seen `confirmHits` SFD-then-valid-response-type
 * pairs.
 *
 * Note: header-shape heuristic only (no checksum validation) — arbitrary binary
 * serial containing `0xFF` followed by 0x01/0x11/0x21 can false-positive.
 * Hardening to full `BlocksFrameParser` validation is tracked as T2.6.
 */
export class BlocksUsbProbe {
  private prev = -1;
  private hits = 0;
  private readonly confirmHits: number;

  constructor(confirmHits: number = BLOCKS_USB_CONFIRM_HITS) {
    this.confirmHits = confirmHits;
  }

  /** Returns true once enough valid frame headers have been seen. */
  push(bytes: ArrayLike<number>): boolean {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] & 0xff;
      if (this.prev === BLOCKS_SFD && (b === 0x01 || b === 0x11 || b === 0x21)) {
        this.hits++;
        if (this.hits >= this.confirmHits) {
          this.prev = b;
          return true;
        }
      }
      this.prev = b;
    }
    return false;
  }
}
