/**
 * Pure Blocks CMSIS-DAP RAM-exchange codec — no transport imports, so it loads
 * in any environment (browser, Node test runner). The transport-bound driver
 * (loop, lifecycle, ArmDebug wiring) lives in `blocks-dap.ts`.
 *
 * This is the Blocks-runtime sibling of `jacdac-mailbox.ts`. It reuses the same
 * proven CMSIS-DAP RAM-exchange mechanics — locate a "mailbox" struct in device
 * RAM by magic words, exchange single-slot frames over the debug memory port
 * (no core halt), pend an NVIC IRQ after each transfer — but with:
 *   - DISTINCT magic words (so it never collides with a Jacdac mailbox),
 *   - Blocks framing: each slot carries exactly one BlocksSerial wire frame
 *     `[SFD, type, ch_hi, ch_lo, len, data…, chksum]`. The slot's 4-byte head
 *     word holds that frame's byte length in byte 2 (an empty slot reads 0), and
 *     the frame bytes follow the head. No Jacdac 12-byte frame header.
 *   - NO 0xFF validity sentinel: the two 32-bit magic words are signature enough,
 *     and a sentinel that doubles as the inbound size flag would break on a host
 *     reconnect. The device instead attaches on the first COMMAND read (just like
 *     the serial transport sets `serialConnected`).
 *
 * The codal blocks-runtime exposes the matching struct + magic + offsets (see
 * source/BlocksDap.{h,cpp}). Keep the layout here and on the device in lockstep.
 *
 * Mailbox struct layout (relative to the exchange base `xchgAddr`):
 *   0    u32  magic0  (BLK_MAGIC0)
 *   4    u32  magic1  (BLK_MAGIC1)
 *   8    u32  info    — byte 8 = irqn; bytes 9..11 reserved
 *   12   u32  inbound head (device→host). byte 14 (byte 2 of the word) = size (0 = empty)
 *   16   …    inbound body — one Blocks frame, up to INBOUND_MAX bytes
 *   268  u32  send head (host→device). byte 2 = size (0 = slot free)
 *   272  …    send body — one Blocks frame, up to SEND_MAX bytes
 */

/** Mailbox struct signature words — DISTINCT from Jacdac's (0x786d444a/0xb0a6c0e9). */
export const BLK_MAGIC0 = 0x426c6f63; // ascii "colB"
export const BLK_MAGIC1 = 0x4d61696c; // ascii "liaM"

// RAM scan window + stride. nRF52833 RAM is 0x20000000..0x20020000 (128K), but
// the SoftDevice (s113) reserves the low ~0x2040 bytes and PROTECTS them: a
// debug-port read of that region faults ("Bad status") and can trip a device
// panic. So start the scan at the app-RAM boundary (0x20002400, the first 1 KB
// block at/after s113's app-RAM start 0x20002040) and never read below it. The
// device places its exchange struct 1 KB-aligned at/above this (see BlocksDap).
const MEM_START = 0x20002400;
const MEM_STOP = 0x20000000 + 128 * 1024;
const CHECK_SIZE = 1024;
const SCAN_ANCHOR = 0x20006000;

/** NVIC ISPR base — writing here pends the runtime's mailbox IRQ (if it enables one). */
const NVIC_ISPR_BASE = 0xe000e200;

/** Field offsets relative to the exchange base `xchgAddr`. */
const OFF_INBOUND = 12; //                  inbound head word (device→host)
const OFF_INBOUND_BODY = 16; //             inbound frame bytes
const INBOUND_MAX = 252; //                 inbound body capacity (4 head + 252 = 256)
const OFF_SEND = 12 + 256; //               send head word (host→device)
const OFF_SEND_BODY = 12 + 256 + 4; //      send frame bytes
const SEND_MAX = 64; //                     send body capacity (host→device cmd ≤ 26B)

/**
 * Minimal memory interface the mailbox needs — a thin slice of ArmDebug
 * (`readBlock`/`writeBlock`), so this module stays transport-free and testable
 * with an in-memory fake. (Same shape as Jacdac's `JacdacMemIO`.)
 */
export interface BlocksMemIO {
  /** Read `count` 32-bit words starting at byte address `addr`. */
  readWords(addr: number, count: number): Promise<Uint32Array>;
  /** Write 32-bit `words` starting at byte address `addr`. */
  writeWords(addr: number, words: Uint32Array): Promise<void>;
}

function writeWord(io: BlocksMemIO, addr: number, val: number): Promise<void> {
  return io.writeWords(addr, Uint32Array.of(val >>> 0));
}

/**
 * Pend the device-side mailbox IRQ. DISABLED for the polling spike: the device
 * services the mailbox from a poll fiber and never enables this IRQ, so pending
 * it is unnecessary — and writing NVIC registers over the debug port on a
 * SoftDevice device is a needless risk. Re-enable for the Phase-3 SWI0_EGU0 IRQ.
 */
function triggerIRQ(_io: BlocksMemIO, _irqn: number): Promise<void> {
  void NVIC_ISPR_BASE;
  return Promise.resolve();
}

/**
 * Scan device RAM for the exchange mailbox. Returns the mailbox base address, or
 * null if no Blocks-DAP runtime is exposing one. Mirrors `findExchange` in
 * jacdac-mailbox.ts (same window/stride, different magic).
 */
export async function findBlocksExchange(io: BlocksMemIO): Promise<number | null> {
  let p0 = SCAN_ANCHOR;
  let p1 = SCAN_ANCHOR + CHECK_SIZE;

  const check = async (addr: number): Promise<number | null> => {
    if (addr < MEM_START) return null;
    if (addr + CHECK_SIZE > MEM_STOP) return null;
    let buf: Uint32Array;
    try {
      buf = await io.readWords(addr, CHECK_SIZE >> 2);
    } catch {
      // A block that faults (e.g. a protected region) isn't where our struct is;
      // skip it and keep scanning rather than aborting the whole search.
      return 0;
    }
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === BLK_MAGIC0 && buf[i + 1] === BLK_MAGIC1) return addr + (i << 2);
    }
    return 0;
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const a0 = await check(p0);
    if (a0) return a0;
    const a1 = await check(p1);
    if (a1) return a1;
    if (a0 === null && a1 === null) return null;
    p0 -= CHECK_SIZE;
    p1 += CHECK_SIZE;
  }
}

/**
 * Stateful driver for one located Blocks mailbox. Construct with a `BlocksMemIO`,
 * call `scan()` once, then poll `readInbound()` / `trySendOutbound()`. Single
 * slot per direction; the head's size byte is the ready/free flag.
 */
export class BlocksMailbox {
  private xchgAddr: number | null = null;
  private irqn = 0;
  private readonly io: BlocksMemIO;

  constructor(io: BlocksMemIO) {
    this.io = io;
  }

  get available(): boolean {
    return this.xchgAddr !== null;
  }

  /** Locate the mailbox, read its IRQ number, and discard any stale inbound
   *  frame so we start from a known-empty slot. Returns false if no exchange is
   *  present. (Validity = the 8-byte magic match in findBlocksExchange.) */
  async scan(): Promise<boolean> {
    const xchg = await findBlocksExchange(this.io);
    if (xchg === null) {
      this.xchgAddr = null;
      return false;
    }
    const info = await this.io.readWords(xchg + 8, 1); // info byte 8 = irqn
    this.irqn = info[0] & 0xff;
    await writeWord(this.io, xchg + OFF_INBOUND, 0); // clear any stale inbound frame
    this.xchgAddr = xchg;
    return true;
  }

  /** Diagnostic (spike-only): read the raw head words. `inbound` ≠ 0 ⇒ the device
   *  is producing frames; `send` ≠ 0 ⇒ a host frame is still unconsumed (the
   *  device poll fiber isn't reading the slot). */
  async debugHeads(): Promise<{ addr: number; inbound: number; send: number } | null> {
    if (this.xchgAddr === null) return null;
    const inb = await this.io.readWords(this.xchgAddr + OFF_INBOUND, 1);
    const snd = await this.io.readWords(this.xchgAddr + OFF_SEND, 1);
    return { addr: this.xchgAddr, inbound: inb[0] >>> 0, send: snd[0] >>> 0 };
  }

  reset(): void {
    this.xchgAddr = null;
    this.irqn = 0;
  }

  /**
   * Read one inbound (device→host) Blocks frame if present, clear the slot, and
   * pend the IRQ. Returns the frame bytes, or null when the slot is empty.
   */
  async readInbound(): Promise<Uint8Array | null> {
    if (this.xchgAddr === null) return null;
    const head = await this.io.readWords(this.xchgAddr + OFF_INBOUND, 1);
    const size = (head[0] >>> 16) & 0xff;
    if (!size) return null;
    const total = Math.min(size, INBOUND_MAX);
    const words = (total + 3) >> 2;
    const buf = await this.io.readWords(this.xchgAddr + OFF_INBOUND_BODY, words);
    const frame = new Uint8Array(buf.buffer, buf.byteOffset, words * 4).slice(0, total);
    await writeWord(this.io, this.xchgAddr + OFF_INBOUND, 0); // signal consumed
    await triggerIRQ(this.io, this.irqn);
    return frame;
  }

  /**
   * Write one outbound (host→device) Blocks frame into the send slot if it is
   * free, then pend the IRQ. Returns false (no-op) if the slot is still occupied
   * by an unconsumed frame — retry next poll.
   */
  async trySendOutbound(frame: Uint8Array): Promise<boolean> {
    if (this.xchgAddr === null) return false;
    const sendBase = this.xchgAddr + OFF_SEND;
    const sendHdr = await this.io.readWords(sendBase, 1);
    const busy = (sendHdr[0] >>> 16) & 0xff;
    if (busy) return false;
    if (frame.length === 0 || frame.length > SEND_MAX) return true; // drop oversized/empty

    // Body first, then the head word (whose byte-2 size arms the slot), then IRQ.
    // Order matters: the size byte is the "ready" flag the device polls, so it
    // must become non-zero only after the body is fully committed.
    const bodyLen = (frame.length + 3) & ~3;
    const body = new Uint8Array(bodyLen);
    body.set(frame);
    await this.io.writeWords(sendBase + 4, new Uint32Array(body.buffer));
    await writeWord(this.io, sendBase, (frame.length & 0xff) << 16);
    await triggerIRQ(this.io, this.irqn);
    return true;
  }
}
