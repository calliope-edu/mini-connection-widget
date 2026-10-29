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

import { findExchangeByMagic, registerExchangeSignature } from './ram-scan';

/** Mailbox struct signature words — DISTINCT from Jacdac's (0x786d444a/0xb0a6c0e9)
 *  and IoT's (0x496f5443/0x4c696e65). */
export const BLK_MAGIC0 = 0x426c6f63; // ascii "colB"
export const BLK_MAGIC1 = 0x4d61696c; // ascii "liaM"

/** Channel key under which the shared RAM sweep (`ram-scan.ts`) tracks us. The
 *  scan window + stride live there now, shared by all mailbox channels — one
 *  sweep matches every registered magic pair, so a second channel costs no
 *  extra USB transfer. Registered at import time so a sweep started by ANOTHER
 *  channel already looks for ours too. */
export const BLOCKS_SIGNATURE = { key: 'blocks', magic0: BLK_MAGIC0, magic1: BLK_MAGIC1 };
registerExchangeSignature(BLOCKS_SIGNATURE);

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
 * jacdac-mailbox.ts (same window/stride, different magic) — both now run the
 * shared sweep in `ram-scan.ts`, which behaves identically for one caller and
 * additionally remembers the other channels' magics it passes on the way.
 */
export function findBlocksExchange(io: BlocksMemIO): Promise<number | null> {
  return findExchangeByMagic(io, BLOCKS_SIGNATURE);
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
