/**
 * Pure IoT CMSIS-DAP RAM-exchange codec — no transport imports, so it loads in
 * any environment (browser, Node test runner). The transport-bound driver
 * (loop, lifecycle, ArmDebug wiring) lives in `iot-dap.ts`.
 *
 * Third sibling of `blocks-mailbox.ts` / `jacdac-mailbox.ts`, and the host half
 * of the device↔campus data channel that replaces the SERIAL link on mini 3
 * (BLE keeps using serial). Same proven mechanics — locate a "mailbox" struct in
 * device RAM by magic words, exchange one slot per direction over the debug
 * memory port (no core halt) — but with:
 *   - DISTINCT magic words (so it never collides with a Blocks or Jacdac mailbox),
 *   - the same geometry as the Blocks mailbox ON PURPOSE (252-byte inbound body,
 *     64-byte send body, length in byte 2 of the head word),
 *   - and NO frame at all: a slot carries ONE TEXT LINE in latin1, without a
 *     trailing newline. The line is an `IOT1:` wire line (campus
 *     `src/lib/services/iot/wire.ts`), so the length byte IS the whole framing —
 *     no header, no checksum, nothing to validate here. Whatever the device
 *     wrote is what campus parses, exactly as if it had arrived over serial.
 *   - NO 0xFF validity sentinel: the two 32-bit magic words are signature enough,
 *     and a sentinel that doubles as the inbound size flag would break on a host
 *     reconnect.
 *
 * The pxt extension on the device side is built against exactly this layout.
 * Keep the struct here and on the device in lockstep — the offsets are a
 * contract, not an implementation detail.
 *
 * Two device-side facts shape the scan:
 *   - LAZY MAGIC. The magic pair is written when the program first uses the
 *     exchange (~100 ms after start) and deliberately LAST, after the rest of
 *     the struct, so a scanning host never sees a half-built one. A scan right
 *     after reset therefore finds nothing — "not found" means "not yet" as much
 *     as "no IoT program", and the driver has to retry rather than conclude.
 *   - WHERE IT LANDS. The struct is `aligned(1024)` in .bss; whether that is
 *     above the SoftDevice-safe scan floor depends on whether the build has a
 *     SoftDevice at all. See {@link detectIotScanFloor}.
 *
 * Mailbox struct layout (relative to the exchange base `xchgAddr`):
 *   0    u32  magic0  (IOT_MAGIC0)
 *   4    u32  magic1  (IOT_MAGIC1)
 *   8    u32  info    — byte 8 = irqn; bytes 9..11 reserved
 *   12   u32  inbound head (device→host). byte 14 (byte 2 of the word) = length (0 = empty)
 *   16   …    inbound body — one text line, up to IOT_INBOUND_MAX bytes
 *   268  u32  send head (host→device). byte 2 = length (0 = slot free)
 *   272  …    send body — one text line, up to IOT_SEND_MAX bytes
 */

import { DEFAULT_MEM_START, findExchangeByMagic, registerExchangeSignature } from './ram-scan';

/** Mailbox struct signature words — DISTINCT from Blocks' (0x426c6f63/0x4d61696c)
 *  and Jacdac's (0x786d444a/0xb0a6c0e9). */
export const IOT_MAGIC0 = 0x496f5443; // bytes 'I','o','T','C' — reads "CToI" in RAM
export const IOT_MAGIC1 = 0x4c696e65; // bytes 'L','i','n','e' — reads "eniL" in RAM

/** Channel key under which the shared RAM sweep (`ram-scan.ts`) tracks us. */
export const IOT_SIGNATURE = { key: 'iot', magic0: IOT_MAGIC0, magic1: IOT_MAGIC1 };

// Register at import time so a sweep started by ANOTHER channel (typically the
// connect-time Blocks probe, which walks all of RAM when no Blocks program is
// running) already matches our magic and records where it saw it. That is what
// keeps this channel from adding a second ~1 s of blind time on connect.
registerExchangeSignature(IOT_SIGNATURE);

/** NVIC ISPR base — writing here pends the runtime's mailbox IRQ (if it enables one). */
const NVIC_ISPR_BASE = 0xe000e200;

/** Field offsets relative to the exchange base `xchgAddr`. */
const OFF_INFO = 8; //                      info word (byte 8 = irqn)
const OFF_INBOUND = 12; //                  inbound head word (device→host)
const OFF_INBOUND_BODY = 16; //             inbound line bytes
const OFF_SEND = 12 + 256; //               send head word (host→device)
const OFF_SEND_BODY = 12 + 256 + 4; //      send line bytes

/** Inbound body capacity (4 head + 252 = 256). A device line longer than this is
 *  cut on the device, not here. */
export const IOT_INBOUND_MAX = 252;
/** Send body capacity — a hard cap, not a hint. The slot cannot grow, so a
 *  longer line is REJECTED (`sendIotLine` returns false), never truncated: half
 *  an `IOT1:v:` line is a wrong value, not a shorter one. Callers that compose
 *  downlinks must keep them within this, splitting where the protocol allows
 *  (that is why the clock downlink is two lines). */
export const IOT_SEND_MAX = 64;

/** True when `line` fits the host→device slot — check before composing a
 *  downlink, so an over-long value can be shortened at the source. */
export function iotLineFits(line: string): boolean {
  return line.replace(/[\r\n]+$/, '').length <= IOT_SEND_MAX;
}

/**
 * Minimal memory interface the mailbox needs — a thin slice of ArmDebug
 * (`readBlock`/`writeBlock`), so this module stays transport-free and testable
 * with an in-memory fake. (Same shape as `BlocksMemIO` / `JacdacMemIO`.)
 */
export interface IotMemIO {
  /** Read `count` 32-bit words starting at byte address `addr`. */
  readWords(addr: number, count: number): Promise<Uint32Array>;
  /** Write 32-bit `words` starting at byte address `addr`. */
  writeWords(addr: number, words: Uint32Array): Promise<void>;
}

function writeWord(io: IotMemIO, addr: number, val: number): Promise<void> {
  return io.writeWords(addr, Uint32Array.of(val >>> 0));
}

/**
 * Latin-1 in, latin-1 out — one byte per code unit, masked to 0x00–0xFF. Same
 * encoding as the serial path (`serial.ts:latin1Bytes`), so a line that
 * travelled over the UART and the same line through this mailbox arrive as the
 * identical string. UTF-8 would mangle every byte ≥ 0x80 (0xFF → 0xC3 0xBF).
 */
function latin1Encode(line: string): Uint8Array {
  return Uint8Array.from(line, (c) => c.charCodeAt(0) & 0xff);
}

function latin1Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Pend the device-side mailbox IRQ. DISABLED, exactly as in `blocks-mailbox.ts`:
 * the device services the mailbox from a poll fiber and never enables this IRQ,
 * so pending it is unnecessary — and writing NVIC registers over the debug port
 * on a SoftDevice device is a needless risk.
 */
function triggerIRQ(_io: IotMemIO, _irqn: number): Promise<void> {
  void NVIC_ISPR_BASE;
  return Promise.resolve();
}

// --- Where the struct may live ------------------------------------------------
//
// The device places it `aligned(1024)` in .bss, and nothing guarantees it lands
// above the shared scan floor (0x20002400). That floor exists because the
// SoftDevice owns the RAM below it AND protects it: a debug-port read there
// faults and can trip the device's APP_MEMACC panic (071) — we would crash a
// program we were only probing.
//
// So the floor is chosen per device instead of per channel: a build WITHOUT a
// SoftDevice has no protected region and no reason to keep the struct high, and
// there the sweep may safely start at the bottom of RAM. The presence check
// reads FLASH (never protected RAM): the Nordic SoftDevice info struct sits at
// 0x3000 and carries a magic word at 0x3008. Unknown or unreadable ⇒ assume a
// SoftDevice and keep the cautious floor.
//
// If a mini 3 ever turns up whose IoT struct sits low AND whose SoftDevice is
// present, this detection is the place to look — read the actual address off
// the device before touching the floor by hand.

/** Nordic SoftDevice info struct: magic word at SOFTDEVICE_INFO_STRUCT + 0x08. */
const SD_INFO_MAGIC_ADDR = 0x00003008;
const SD_INFO_MAGIC = 0x51b1e5db;

/** SoftDevice present: the shared, protected-RAM-safe floor. */
export const IOT_SCAN_FLOOR_SOFTDEVICE = DEFAULT_MEM_START;
/** No SoftDevice: nothing protects low RAM, so the struct may be anywhere. */
export const IOT_SCAN_FLOOR_BARE = 0x20000000;

/**
 * Decide how deep the IoT sweep may read on THIS device. One flash word; cheap
 * enough to redo on every scan, so a reflash that swaps runtimes is picked up.
 */
export async function detectIotScanFloor(io: IotMemIO): Promise<number> {
  try {
    const w = await io.readWords(SD_INFO_MAGIC_ADDR, 1);
    return w[0] === SD_INFO_MAGIC ? IOT_SCAN_FLOOR_SOFTDEVICE : IOT_SCAN_FLOOR_BARE;
  } catch {
    return IOT_SCAN_FLOOR_SOFTDEVICE; // can't tell ⇒ stay above the protected region
  }
}

/**
 * Scan device RAM for the IoT exchange mailbox. Returns the mailbox base
 * address, or null if no IoT-enabled program is exposing one. Runs through the
 * SHARED sweep (`ram-scan.ts`), so it is free when another channel has already
 * walked past our magic.
 *
 * `memStart` overrides how deep the sweep reads (see {@link detectIotScanFloor});
 * it applies to this channel alone and never widens the Blocks/Jacdac windows.
 */
export function findIotExchange(io: IotMemIO, memStart?: number): Promise<number | null> {
  return findExchangeByMagic(io, memStart === undefined ? IOT_SIGNATURE : { ...IOT_SIGNATURE, memStart });
}

/**
 * Stateful driver for one located IoT mailbox. Construct with an `IotMemIO`,
 * call `scan()` once, then poll `readInbound()` / `trySendOutbound()`. Single
 * slot per direction; the head's length byte is the ready/free flag.
 */
export class IotMailbox {
  private xchgAddr: number | null = null;
  private irqn = 0;
  private readonly io: IotMemIO;

  constructor(io: IotMemIO) {
    this.io = io;
  }

  get available(): boolean {
    return this.xchgAddr !== null;
  }

  /** The located mailbox base, or null before a successful `scan()` — so a
   *  session can log which address it attached to. */
  get address(): number | null {
    return this.xchgAddr;
  }

  /** Locate the mailbox, read its IRQ number, and discard any stale inbound line
   *  so we start from a known-empty slot. Returns false if no exchange is
   *  present — which on a freshly reset device also means "not yet": the runtime
   *  writes the magic pair lazily, when the program first uses the exchange
   *  (~100 ms after start), and deliberately AFTER the rest of the struct, so a
   *  host can never see a half-built one. A single false is therefore not proof
   *  of absence; the driver retries (see `iot-dap.ts`).
   *  (Validity = the 8-byte magic match in findIotExchange.) */
  async scan(): Promise<boolean> {
    const xchg = await findIotExchange(this.io, await detectIotScanFloor(this.io));
    if (xchg === null) {
      this.xchgAddr = null;
      return false;
    }
    const info = await this.io.readWords(xchg + OFF_INFO, 1); // info byte 8 = irqn
    this.irqn = info[0] & 0xff;
    await writeWord(this.io, xchg + OFF_INBOUND, 0); // clear any stale inbound line
    this.xchgAddr = xchg;
    return true;
  }

  reset(): void {
    this.xchgAddr = null;
    this.irqn = 0;
  }

  /**
   * Read one inbound (device→host) line if present, clear the slot, and pend the
   * IRQ. Returns the line WITHOUT its terminator, or null when the slot is
   * empty. An armed slot whose bytes decode to nothing yields `''` rather than
   * null — the slot was consumed, and the caller should count that as work done
   * even though there is nothing to hand on.
   */
  async readInbound(): Promise<string | null> {
    if (this.xchgAddr === null) return null;
    const head = await this.io.readWords(this.xchgAddr + OFF_INBOUND, 1);
    const size = (head[0] >>> 16) & 0xff;
    if (!size) return null;
    const total = Math.min(size, IOT_INBOUND_MAX);
    const words = (total + 3) >> 2;
    const buf = await this.io.readWords(this.xchgAddr + OFF_INBOUND_BODY, words);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, words * 4).slice(0, total);
    await writeWord(this.io, this.xchgAddr + OFF_INBOUND, 0); // signal consumed
    await triggerIRQ(this.io, this.irqn);
    // The contract says "no trailing newline", but a device that appends one
    // (or pads with NULs) must not produce a line campus then fails to parse.
    return latin1Decode(bytes).replace(/[\r\n\0]+$/, '');
  }

  /**
   * Write one outbound (host→device) line into the send slot if it is free, then
   * pend the IRQ. Returns false (no-op) if the slot is still occupied by an
   * unconsumed line — retry next poll. An empty or oversized line is DROPPED and
   * reports true: it will never fit, so retrying it forever would wedge the
   * queue. Callers should reject over-long lines before queueing them
   * ({@link IOT_SEND_MAX}) so the drop can be reported instead of silent.
   */
  async trySendOutbound(line: string): Promise<boolean> {
    if (this.xchgAddr === null) return false;
    const sendBase = this.xchgAddr + OFF_SEND;
    const sendHdr = await this.io.readWords(sendBase, 1);
    const busy = (sendHdr[0] >>> 16) & 0xff;
    if (busy) return false;

    const bytes = latin1Encode(line.replace(/[\r\n]+$/, ''));
    if (bytes.length === 0 || bytes.length > IOT_SEND_MAX) return true; // drop empty/oversized

    // Body first, then the head word (whose byte-2 length arms the slot), then
    // IRQ. Order matters: the length byte is the "ready" flag the device polls,
    // so it must become non-zero only after the body is fully committed.
    const bodyLen = (bytes.length + 3) & ~3;
    const body = new Uint8Array(bodyLen);
    body.set(bytes);
    await this.io.writeWords(sendBase + 4, new Uint32Array(body.buffer)); // = xchg + OFF_SEND_BODY
    await writeWord(this.io, sendBase, (bytes.length & 0xff) << 16);
    await triggerIRQ(this.io, this.irqn);
    return true;
  }
}
