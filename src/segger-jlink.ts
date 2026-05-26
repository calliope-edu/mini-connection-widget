/**
 * SEGGER J-Link USB transport + MSD-image-program flash for Calliope mini v2.
 *
 * The mini v2 interface chip runs SEGGER J-Link OB firmware, not DAPLink.
 * Its USB protocol is SEGGER's proprietary J-Link Standard Protocol (not
 * CMSIS-DAP), so the widget's WebUSB CMSIS-DAP path doesn't work.
 *
 * This module talks J-Link's small "MSD image programming" command subset —
 * the same operation as drag-flashing the hex to the mass-storage drive,
 * but routed through USB control commands instead of FAT writes (which
 * Web APIs can't do). The J-Link OB on the device parses the hex and
 * programs the target chip's flash over SWD itself; we just stream the
 * bytes.
 *
 * Protocol reference: SEGGER's published WebUSB sample at
 * https://www.segger.com/seggerbulk.js + https://www.segger.com/programming.js
 * (combined "(c) SEGGER Microcontroller GmbH" code). SEGGER has given
 * the Calliope team permission to implement this for the Calliope mini v2
 * interface chip; the wire commands are documented in J-Link's protocol
 * manual.
 *
 * Wire-level summary:
 *
 *   1. Send EMU_CMD_GET_CAPS_EX (1 byte: 237) → receive 32-byte caps
 *      bitfield. Bit EMU_CAP_EX_GET_PROBE_INFO (64) must be set.
 *
 *   2. Send EMU_CMD_GET_PROBE_INFO + GET_CAPS sub-cmd (2 bytes: 28, 0)
 *      → receive 4-byte LE u32 probe-caps bitfield. Bit
 *      EMU_PROBE_INFO_CAP_MSD_IMG (2) must be set.
 *
 *   3. Loop: EMU_CMD_GET_PROBE_INFO + WRITE_MSD_IMG_CHUNK (5) + 4-byte LE
 *      u32 chunk length + chunk bytes. Chunk size up to 4096 bytes;
 *      first byte of next chunk is the same command frame. J-Link OB
 *      auto-detects target chip type from embedded knowledge tables.
 *
 *   4. EMU_CMD_GET_PROBE_INFO + WRITE_MSD_IMG_END (6) → receive 4-byte
 *      LE u32 result code (0 = OK; non-zero = number of bytes of an
 *      ASCII error string that follows).
 */

// ---- USB device matching ----------------------------------------------------

/** SEGGER's vendor ID. J-Link OB and standalone J-Link probes all share it. */
export const SEGGER_VENDOR_ID = 0x1366;

/**
 * Generated from SEGGER's official seggerbulk.js descriptor table — every
 * USB composite layout J-Link OB ships in. The vendor-specific BULK
 * interface always exposes the same protocol; only the surrounding USB
 * descriptors differ (MSD-only, MSD+CDC, MSD+HID, etc.). We match on the
 * full set so any mini v2 with a J-Link OB build is reachable.
 */
export const SEGGER_USB_FILTERS: USBDeviceFilter[] = [
  // Legacy single-channel J-Link layouts
  ...range(0x0101, 0x0108),
  // "New format" composite layouts — 0x1000–0x107f, the contiguous set
  ...range(0x1001, 0x102f),
  ...range(0x1050, 0x106f),
].map((productId) => ({ vendorId: SEGGER_VENDOR_ID, productId }));

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let n = lo; n <= hi; n++) out.push(n);
  return out;
}

// ---- WebUSB transport (port of SeggerBulk) ---------------------------------

/**
 * Thin WebUSB wrapper. J-Link's USB descriptors put the BULK in/out
 * endpoints behind a vendor-specific (class 0xFF) interface; the
 * surrounding interfaces (MSD, CDC, HID …) shift the BULK interface's
 * index depending on the configuration. So we have to walk the
 * interface list and find the vendor-specific one rather than
 * hard-coding an index.
 */
export class SeggerBulkTransport {
  private device: USBDevice;
  private interfaceNumber = 0;
  private epIn = 0;
  private epOut = 0;
  /** Mirrors SEGGER's kernel-mode driver behaviour: 2 KB per Receive(). */
  private maxTransferSize = 2048;

  constructor(device: USBDevice) {
    this.device = device;
  }

  async connect(): Promise<void> {
    await this.device.open();
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }
    this.locateVendorInterface();
    await this.device.claimInterface(this.interfaceNumber);
    await this.device.selectAlternateInterface(this.interfaceNumber, 0);
  }

  async disconnect(): Promise<void> {
    try {
      await this.device.releaseInterface(this.interfaceNumber);
    } catch { /* ignore — close handles cleanup */ }
    await this.device.close();
  }

  async send(data: Uint8Array): Promise<USBOutTransferResult> {
    // TS's lib.dom.d.ts types `transferOut`'s second arg as `BufferSource`
    // which is `ArrayBufferView | ArrayBuffer`. With strict mode +
    // ES2024-typed Uint8Array (parameterised by ArrayBufferLike) the
    // implicit conversion fails. Cast through `unknown` — at runtime any
    // ArrayBufferView is accepted.
    return this.device.transferOut(this.epOut, data as unknown as BufferSource);
  }

  async receive(): Promise<USBInTransferResult> {
    return this.device.transferIn(this.epIn, this.maxTransferSize);
  }

  /** Receive at least `min` bytes, concatenating multiple transfers if needed. */
  async receiveAtLeast(min: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < min) {
      const r = await this.receive();
      if (!r.data) throw new Error('J-Link USB receive: empty result');
      const u8 = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      chunks.push(u8);
      total += u8.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  setMaxTransferSize(size: number): void {
    this.maxTransferSize = size;
  }

  private locateVendorInterface(): void {
    const cfg = this.device.configuration;
    if (!cfg) throw new Error('J-Link USB: no active configuration');
    for (const iface of cfg.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === 0xFF) {
          if (alt.endpoints.length !== 2) {
            throw new Error('J-Link USB: vendor interface lacks expected in/out endpoints');
          }
          this.interfaceNumber = iface.interfaceNumber;
          // Two endpoints: one IN, one OUT. Direction reported in `direction`.
          for (const ep of alt.endpoints) {
            if (ep.direction === 'in') this.epIn = ep.endpointNumber;
            else if (ep.direction === 'out') this.epOut = ep.endpointNumber;
          }
          return;
        }
      }
    }
    throw new Error('J-Link USB: no vendor-specific (class 0xFF) interface found');
  }
}

// ---- J-Link MSD-image-programming command set ------------------------------

const EMU_CMD_GET_PROBE_INFO = 28;
const EMU_CMD_GET_CAPS_EX = 237;
const EMU_PROBE_INFO_CMD_GET_CAPS = 0;
const EMU_PROBE_INFO_SUB_CMD_WRITE_MSD_IMG_CHUNK = 5;
const EMU_PROBE_INFO_SUB_CMD_WRITE_MSD_IMG_END = 6;

/** Bit position in the 32-byte CAPS_EX bitfield. */
const EMU_CAP_EX_GET_PROBE_INFO = 64;
/** Bit position in the 4-byte PROBE_INFO caps bitfield. */
const EMU_PROBE_INFO_CAP_MSD_IMG = 2;

/** Match SEGGER's reference — keep each chunk small enough that no single
 *  USB command takes long enough for the host-side watchdog to trip. */
const MAX_CHUNK_BYTES = 4096;

export interface JlinkFlashOptions {
  /** 0..1 progress callback fires after each chunk write. */
  onProgress?: (fraction: number) => void;
  /** Optional log sink for human-readable progress (stage transitions etc.). */
  onLog?: (line: string) => void;
  /** Abort signal: best-effort cancellation between chunks. */
  signal?: AbortSignal;
}

/**
 * Stream a raw hex file (Intel HEX text) to a J-Link OB which routes it to
 * its built-in flash programmer for the connected target chip. Calliope
 * mini v2's J-Link OB is preconfigured for nRF52833, so the host doesn't
 * need to know any target-specific details — just hand the J-Link the
 * bytes.
 *
 * Caller is responsible for opening the WebUSB device via
 * `navigator.usb.requestDevice({ filters: SEGGER_USB_FILTERS })` first.
 */
export async function flashViaJLinkMsdImage(
  device: USBDevice,
  hexText: string,
  opts: JlinkFlashOptions = {},
): Promise<void> {
  const log = (m: string) => opts.onLog?.(m);
  const aborted = () => {
    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
  };

  const bulk = new SeggerBulkTransport(device);
  log('jlink: connecting…');
  await bulk.connect();
  try {
    log('jlink: checking EMU_CAP_EX_GET_PROBE_INFO');
    await assertCapsEx(bulk);
    aborted();

    log('jlink: checking EMU_PROBE_INFO_CAP_MSD_IMG');
    await assertProbeInfoCaps(bulk);
    aborted();

    const bytes = new TextEncoder().encode(hexText);
    log(`jlink: streaming ${bytes.length} bytes in ${MAX_CHUNK_BYTES} B chunks`);
    let written = 0;
    while (written < bytes.length) {
      aborted();
      const remaining = bytes.length - written;
      const chunkLen = Math.min(remaining, MAX_CHUNK_BYTES);
      const chunk = bytes.subarray(written, written + chunkLen);
      await sendImageChunk(bulk, chunk);
      written += chunkLen;
      opts.onProgress?.(written / bytes.length);
    }

    log('jlink: finalising');
    await sendImageEnd(bulk);
    log('jlink: target flashed');
  } finally {
    try { await bulk.disconnect(); } catch { /* ignore */ }
  }
}

/** Send EMU_CMD_GET_CAPS_EX and verify the probe-info bit. */
async function assertCapsEx(bulk: SeggerBulkTransport): Promise<void> {
  await bulk.send(new Uint8Array([EMU_CMD_GET_CAPS_EX]));
  const caps = await bulk.receiveAtLeast(32);
  if (!getBit(caps, EMU_CAP_EX_GET_PROBE_INFO)) {
    throw new Error('J-Link does not advertise EMU_CAP_EX_GET_PROBE_INFO — too old to flash via WebUSB');
  }
}

/** Send EMU_CMD_GET_PROBE_INFO/GET_CAPS and verify the MSD-image bit. */
async function assertProbeInfoCaps(bulk: SeggerBulkTransport): Promise<void> {
  await bulk.send(new Uint8Array([EMU_CMD_GET_PROBE_INFO, EMU_PROBE_INFO_CMD_GET_CAPS]));
  const caps = await bulk.receiveAtLeast(4);
  if (!getBit(caps, EMU_PROBE_INFO_CAP_MSD_IMG)) {
    throw new Error('J-Link does not support MSD-image target flash — update J-Link OB firmware');
  }
}

async function sendImageChunk(bulk: SeggerBulkTransport, chunk: Uint8Array): Promise<void> {
  const frame = new Uint8Array(2 + 4 + chunk.length);
  frame[0] = EMU_CMD_GET_PROBE_INFO;
  frame[1] = EMU_PROBE_INFO_SUB_CMD_WRITE_MSD_IMG_CHUNK;
  // 4-byte little-endian length
  const n = chunk.length;
  frame[2] = n & 0xFF;
  frame[3] = (n >>> 8) & 0xFF;
  frame[4] = (n >>> 16) & 0xFF;
  frame[5] = (n >>> 24) & 0xFF;
  frame.set(chunk, 6);
  await bulk.send(frame);
  // No response per chunk — J-Link only acknowledges via the final END
  // command. SEGGER's reference confirms this; we'd otherwise hang here
  // on `transferIn`.
}

async function sendImageEnd(bulk: SeggerBulkTransport): Promise<void> {
  await bulk.send(new Uint8Array([EMU_CMD_GET_PROBE_INFO, EMU_PROBE_INFO_SUB_CMD_WRITE_MSD_IMG_END]));
  // The response is a 4-byte LE u32. 0 means success; non-zero is the
  // length of an ASCII error string that follows. Some J-Link OB builds
  // can sit on the END for ~10–30 s while they finalise the target
  // flash write — receiveAtLeast handles arbitrary streaming.
  const head = await bulk.receiveAtLeast(4);
  const code = readU32LE(head, 0);
  if (code === 0) return;
  // Error string follows; pull `code` bytes more if we don't have them yet.
  let buf = head;
  while (buf.length < 4 + code) {
    const more = await bulk.receive();
    if (!more.data) break;
    const u = new Uint8Array(more.data.buffer, more.data.byteOffset, more.data.byteLength);
    const merged = new Uint8Array(buf.length + u.length);
    merged.set(buf, 0);
    merged.set(u, buf.length);
    buf = merged;
  }
  const msg = new TextDecoder('utf-8').decode(buf.subarray(4, 4 + code));
  throw new Error(`J-Link target flash failed: ${msg}`);
}

// ---- High-level entry point: request + flash in one go --------------------

/**
 * Prompt the user for a J-Link device, then stream the hex to it.
 *
 * Requires a user gesture (button click, etc.) because
 * `navigator.usb.requestDevice` does. The caller is responsible for
 * invoking this from a click handler.
 *
 * Doesn't touch the widget's USB-connection state (which is wired for
 * upstream DAPLink/CMSIS-DAP). Treat this as a parallel transport that
 * the campus / widget-demo / consumer triggers explicitly for mini v2.
 */
export async function requestAndFlashJLink(
  hexText: string,
  opts: JlinkFlashOptions = {},
): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.usb) {
    throw new Error('WebUSB not available — required for J-Link flashing');
  }
  const device = await navigator.usb.requestDevice({ filters: SEGGER_USB_FILTERS });
  await flashViaJLinkMsdImage(device, hexText, opts);
}

// ---- Tiny helpers ----------------------------------------------------------

/** Read a bit out of a little-endian byte array (LSB-first within each byte). */
function getBit(bytes: Uint8Array, bitPos: number): boolean {
  const byteIdx = bitPos >>> 3;
  if (byteIdx >= bytes.length) return false;
  return (bytes[byteIdx] >>> (bitPos & 7) & 1) === 1;
}

function readU32LE(bytes: Uint8Array, off: number): number {
  return (
    bytes[off] |
    (bytes[off + 1] << 8) |
    (bytes[off + 2] << 16) |
    (bytes[off + 3] << 24)
  ) >>> 0;
}
