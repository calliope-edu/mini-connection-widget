/**
 * MbitMore protocol helpers for the pxt-scratch blocks runtime.
 *
 * Two transports speak the same protocol over the wire:
 *   - BLE GATT — service `0b50f3e4-…-5c`, characteristic UUIDs `0b50_XXXX_…`,
 *     where the 16-bit `XXXX` is the channel ID (0x0100, 0x0101, …).
 *   - USB serial — framed packets with start byte `0xFF` (SFD) then
 *     `[req_type, ch_hi, ch_lo, len, ...data, chksum]`. Both ends of the
 *     link broadcast the same channel content on this frame format.
 *
 * The frame logic here matches scratch-vm/extensions/calliopeMini/serial-web.js
 * verbatim so the firmware doesn't care which transport we use. Embedded
 * mode (controller=2 iframe) needs this because Scratch's BLE driver always
 * speaks ScratchLink JSON-RPC, but the host may have only USB connected —
 * the proxy translates JSON-RPC to/from MbitMore serial frames.
 */

import { ConnectionStatus } from '@microbit/microbit-connection';
import { getUsbConn } from './usb';
import { appendLog } from './log';

// ---- Wire format constants ------------------------------------------------

/** Start-of-frame delimiter — must precede every MbitMore serial frame. */
export const MM_SFD = 0xff;

/** Request types we put in `frame[1]` when writing TO the device. */
export const MM_REQ = {
  READ: 0x01,
  WRITE: 0x10,
  WRITE_RESPONSE: 0x11,
  NOTIFY_STOP: 0x20,
  NOTIFY_START: 0x21,
} as const;

/** Response types the device puts in `frame[1]` when writing back to us. */
export const MM_RES = {
  READ: 0x01,
  WRITE_RESPONSE: 0x11,
  NOTIFY: 0x21,
} as const;

/** Service UUID — same as the BLE service. */
export const MBIT_MORE_SERVICE_UUID = '0b50f3e4-607f-4151-9091-7d008d6ffc5c';

/**
 * Map full 128-bit characteristic UUIDs (what Scratch-Link RPC carries) to
 * 16-bit channel IDs (what MbitMore serial frames carry). The middle 16
 * bits of the UUID encode the channel — extract them or use this table.
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
 * Resolve a Scratch-Link characteristic identifier (full UUID, short UUID
 * number, or raw 16-bit) into the MbitMore channel byte pair.
 */
export function characteristicToChannel(id: number | string): number {
  if (typeof id === 'number') return id & 0xffff;
  const lower = String(id).toLowerCase();
  if (lower in CHANNEL_BY_UUID) return CHANNEL_BY_UUID[lower];
  // Fallback: extract bytes 2-3 from a 128-bit UUID like
  // `0b50XXXX-607f-…` — these are the channel id.
  const m = /^[0-9a-f]{4}([0-9a-f]{4})/.exec(lower);
  if (m) return parseInt(m[1], 16);
  return 0;
}

// ---- Frame codec ----------------------------------------------------------

/** chksum8 over the bytes preceding it — sum mod 0xFF. */
function chksum8(bytes: ArrayLike<number>, len: number): number {
  let sum = 0;
  for (let i = 0; i < len; i++) sum = (sum + bytes[i]) % 0xff;
  return sum;
}

/** Build a TX frame to write to the wire: `[SFD, type, ch_hi, ch_lo, len, ...data, chk]`. */
export function buildMbitMoreFrame(
  type: number,
  channel: number,
  data: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const len = data.byteLength;
  const frame = new Uint8Array(6 + len);
  frame[0] = MM_SFD;
  frame[1] = type;
  frame[2] = (channel >> 8) & 0xff;
  frame[3] = channel & 0xff;
  frame[4] = len;
  frame.set(data, 5);
  frame[5 + len] = chksum8(frame, 5 + len);
  return frame;
}

export interface MbitMoreFrame {
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
export class MbitMoreFrameParser {
  private buf: number[] = [];

  push(bytes: Iterable<number>): MbitMoreFrame[] {
    for (const b of bytes) this.buf.push(b & 0xff);
    return this.drain();
  }

  private drain(): MbitMoreFrame[] {
    const out: MbitMoreFrame[] = [];
    while (this.buf.length > 0) {
      // Resync on SFD.
      const sfdIdx = this.buf.indexOf(MM_SFD);
      if (sfdIdx === -1) {
        this.buf.length = 0;
        return out;
      }
      if (sfdIdx > 0) this.buf.splice(0, sfdIdx);
      if (this.buf.length < 5) return out;
      const type = this.buf[1];
      const validType = type === MM_RES.READ || type === MM_RES.WRITE_RESPONSE || type === MM_RES.NOTIFY;
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

// ---- USB transport --------------------------------------------------------

/**
 * Write an MbitMore frame to the connected USB Calliope. Upstream's
 * `serialWrite` accepts a string (one char per byte); we convert here so
 * binary bytes (0xFF etc) survive the trip.
 */
export async function sendMbitMoreFrameOverUsb(frame: Uint8Array): Promise<void> {
  const usb = getUsbConn();
  if (!usb || usb.status !== ConnectionStatus.Connected) {
    throw new Error('USB not connected');
  }
  let s = '';
  for (let i = 0; i < frame.length; i++) s += String.fromCharCode(frame[i]);
  await usb.serialWrite(s);
}

/**
 * Subscribe to MbitMore frames arriving over USB. Returns an unsubscribe
 * function. Multiple subscribers may coexist; each gets a copy of every
 * parsed frame.
 */
export function onMbitMoreFrameFromUsb(
  cb: (frame: MbitMoreFrame) => void,
): () => void {
  const usb = getUsbConn();
  if (!usb) return () => {};
  const parser = new MbitMoreFrameParser();
  const handler = (ev: { data: string }) => {
    if (!ev?.data) return;
    const bytes: number[] = new Array(ev.data.length);
    for (let i = 0; i < ev.data.length; i++) bytes[i] = ev.data.charCodeAt(i) & 0xff;
    const frames = parser.push(bytes);
    for (const f of frames) {
      try { cb(f); } catch (err) { appendLog({ direction: 'info', text: `mbitmore handler error: ${(err as Error)?.message ?? err}` }); }
    }
  };
  usb.addEventListener('serialdata', handler);
  return () => {
    try { usb.removeEventListener('serialdata', handler); } catch { /* ignore */ }
  };
}
