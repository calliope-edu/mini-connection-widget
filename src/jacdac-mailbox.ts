/**
 * Pure Jacdac CMSIS-DAP RAM-exchange codec — no transport imports, so it loads
 * in any environment (browser, Node test runner). The transport-bound driver
 * (loop, lifecycle, ArmDebug wiring) lives in `jacdac.ts`.
 *
 * A Calliope mini / micro:bit running a MakeCode program built with the Jacdac
 * extension exposes a "mailbox" exchange struct in device RAM. The host reads
 * inbound Jacdac frames out of it and writes outbound frames into it over the
 * CMSIS-DAP debug memory port (no core halt), pending an NVIC IRQ after each
 * transfer so the on-device runtime services the mailbox.
 *
 * Every constant and step here is ported VERBATIM from jacdac-ts
 * `src/jdom/transport/microbit.ts` (class CMSISProto). Line references are
 * against https://raw.githubusercontent.com/microsoft/jacdac-ts/main/src/jdom/transport/microbit.ts.
 * Do NOT "improve" the offsets/magics — they mirror the firmware's struct.
 *
 * Difference from jacdac-ts: jacdac-ts owns the whole CMSIS-DAP/SWD stack and
 * does a full SWD init + core reset in postConnectAsync before scanning. Here
 * the connection widget already holds an initialized, RUNNING session, so we
 * must NOT re-init or reset (that would reboot the device and kill the running
 * Jacdac program). We only do findExchange + the steady-state exchange, driven
 * through the widget's existing ArmDebug memory primitives.
 */

/** Mailbox struct signature words (microbit.ts:465). */
export const JD_MAGIC0 = 0x786d444a;
export const JD_MAGIC1 = 0xb0a6c0e9;

/** RAM scan window + stride (microbit.ts:453-458). */
const MEM_START = 0x20000000;
const MEM_STOP = MEM_START + 128 * 1024;
const CHECK_SIZE = 1024;
const SCAN_ANCHOR = 0x20006000;

/** NVIC ISPR base — writing here pends the runtime's Jacdac IRQ (microbit.ts:484). */
const NVIC_ISPR_BASE = 0xe000e200;

/** Core soft-reset registers (microbit.ts:493-496). DEMCR cleared, then AIRCR
 *  written with VECTKEY | SYSRESETREQ to reset the core. */
const SCB_DEMCR = 0xe000edfc;
const SCB_AIRCR = 0xe000ed0c;
const AIRCR_SYSRESETREQ = 0x05fa0000 | (1 << 2);

/** Jacdac frame header length in bytes (microbit.ts:201, slice(0, inp[2]+12)). */
const JD_FRAME_HEADER = 12;
/** Byte offset of the frame `_size` field within a frame (microbit.ts:198 inp[2]). */
const JD_SIZE_OFFSET = 2;

/** Mailbox field offsets relative to the exchange base `xchgAddr`. */
const OFF_INBOUND = 12; //                      inbound frame buffer (microbit.ts:197)
const OFF_SEND = 12 + 256; //                   outbound slot header (microbit.ts:208)
const OFF_SEND_BODY = 12 + 256 + 4; //          outbound slot body  (microbit.ts:229)
const INBOUND_MAX = 256; //                     inbound buffer size  (microbit.ts:197)

/** Thrown when the exchange header is present but its memory looks corrupt
 *  (info byte 14 != 0xFF — microbit.ts:561). jacdac-ts: "try power-cycling". */
export class JacdacInvalidMemoryError extends Error {
  constructor() {
    super('Jacdac exchange memory invalid; try power-cycling the Calliope mini');
    this.name = 'JacdacInvalidMemoryError';
  }
}

/**
 * Minimal memory interface the mailbox needs — a thin slice of ArmDebug
 * (`readBlock`/`writeBlock`), so this module stays transport-free and testable
 * with an in-memory fake.
 */
export interface JacdacMemIO {
  /** Read `count` 32-bit words starting at byte address `addr`. */
  readWords(addr: number, count: number): Promise<Uint32Array>;
  /** Write 32-bit `words` starting at byte address `addr`. */
  writeWords(addr: number, words: Uint32Array): Promise<void>;
}

async function readBytes(io: JacdacMemIO, addr: number, count: number): Promise<Uint8Array> {
  const words = await io.readWords(addr, count >> 2);
  return new Uint8Array(words.buffer, words.byteOffset, count);
}

function writeWord(io: JacdacMemIO, addr: number, val: number): Promise<void> {
  return io.writeWords(addr, Uint32Array.of(val >>> 0));
}

/** Pend the device-side Jacdac IRQ (microbit.ts:483-487). */
function triggerIRQ(io: JacdacMemIO, irqn: number): Promise<void> {
  const addr = NVIC_ISPR_BASE + (irqn >> 5) * 4;
  return io.writeWords(addr, Uint32Array.of((1 << (irqn & 31)) >>> 0));
}

/**
 * Scan device RAM for the exchange mailbox (microbit.ts:452-481). Returns the
 * mailbox base address, or null if no Jacdac program is running (jacdac-ts's
 * ERROR_MICROBIT_JACDAC_MISSING condition).
 */
export async function findExchange(io: JacdacMemIO): Promise<number | null> {
  let p0 = SCAN_ANCHOR;
  let p1 = SCAN_ANCHOR + CHECK_SIZE;

  const check = async (addr: number): Promise<number | null> => {
    if (addr < MEM_START) return null;
    if (addr + CHECK_SIZE > MEM_STOP) return null;
    const buf = await io.readWords(addr, CHECK_SIZE >> 2);
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === JD_MAGIC0 && buf[i + 1] === JD_MAGIC1) return addr + (i << 2);
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
 * Stateful driver for one located mailbox. Construct with a `JacdacMemIO`, call
 * `scan()` once, then poll `readInbound()` / `trySendOutbound()` in a loop. All
 * device-state mutation (clear + IRQ handshake) is contained here.
 */
export class JacdacMailbox {
  private xchgAddr: number | null = null;
  private irqn = 0;
  private readonly io: JacdacMemIO;

  constructor(io: JacdacMemIO) {
    this.io = io;
  }

  get available(): boolean {
    return this.xchgAddr !== null;
  }

  /** Locate the mailbox + read its header (microbit.ts:550-569). Returns false
   *  if no exchange is present (no Jacdac program). Throws JacdacInvalidMemoryError. */
  async scan(): Promise<boolean> {
    const xchg = await findExchange(this.io);
    if (xchg === null) {
      this.xchgAddr = null;
      return false;
    }
    const info = await readBytes(this.io, xchg, 16);
    const irqn = info[8]; // microbit.ts:560
    if (info[JD_FRAME_HEADER + JD_SIZE_OFFSET] !== 0xff) throw new JacdacInvalidMemoryError(); // info[14], microbit.ts:561
    await writeWord(this.io, xchg + OFF_INBOUND, 0); // clear initial lock (microbit.ts:569)
    this.xchgAddr = xchg;
    this.irqn = irqn;
    return true;
  }

  reset(): void {
    this.xchgAddr = null;
    this.irqn = 0;
  }

  /**
   * Soft-reset the target core (DEMCR clear + AIRCR SYSRESETREQ), matching
   * jacdac-ts CMSISProto.reset() (microbit.ts:493-496). The firmware then
   * re-initialises the exchange struct to its clean post-boot state (the
   * info[14]==0xff "waiting for host" sentinel). The debug power domain stays
   * up across a SYSRESETREQ (CDBGPWRUPREQ is held), so the SWD connection
   * survives and memory access works once the firmware is back (~700ms+).
   * Caller must wait before re-scanning.
   */
  async resetTarget(): Promise<void> {
    await writeWord(this.io, SCB_DEMCR, 0);
    await writeWord(this.io, SCB_AIRCR, AIRCR_SYSRESETREQ);
  }

  /**
   * Read one inbound frame if present, performing the clear + IRQ handshake
   * (microbit.ts:197-204). Returns the full Jacdac frame (header + payload) or
   * null when the inbound slot is empty. Uses jacdac-ts's jdmode optimisation:
   * peek the size byte first so an empty slot costs a single word read.
   */
  async readInbound(): Promise<Uint8Array | null> {
    if (this.xchgAddr === null) return null;
    const base = this.xchgAddr + OFF_INBOUND;
    const head = await this.io.readWords(base, 1);
    const size = (head[0] >>> (JD_SIZE_OFFSET * 8)) & 0xff; // byte 2 of the frame
    if (!size) return null;
    const totalBytes = Math.min(size + JD_FRAME_HEADER, INBOUND_MAX);
    const words = (totalBytes + 3) >> 2;
    const buf = await this.io.readWords(base, words);
    const frame = new Uint8Array(buf.buffer, buf.byteOffset, words * 4).slice(0, totalBytes);
    await writeWord(this.io, base, 0); // signal consumed (microbit.ts:199)
    await triggerIRQ(this.io, this.irqn); // microbit.ts:200
    return frame;
  }

  /**
   * Write one outbound frame into the send slot if it is free, then pend the
   * IRQ (microbit.ts:208-239). Returns false (no-op) if the slot is still
   * occupied by an unconsumed frame — the caller should retry next poll. The
   * single-slot protocol means only one outbound frame is in flight at a time.
   */
  async trySendOutbound(frame: Uint8Array): Promise<boolean> {
    if (this.xchgAddr === null) return false;
    const sendBase = this.xchgAddr + OFF_SEND;
    const sendHdr = await this.io.readWords(sendBase, 1); // 4 bytes (microbit.ts:208)
    const busy = (sendHdr[0] >>> (JD_SIZE_OFFSET * 8)) & 0xff; // send[2]
    if (busy) return false;

    // Pad to a 32-bit boundary (microbit.ts:82-86).
    let buf = frame;
    if (buf.length & 3) {
      const padded = new Uint8Array((buf.length + 3) & ~3);
      padded.set(buf);
      buf = padded;
    }
    if (buf.length < 4) return true; // not a real frame — swallow

    // Body first, then the 4-byte head (whose size byte arms the slot), then
    // IRQ — order matters, the head is the "ready" flag (microbit.ts:227-237).
    const body = buf.slice(4);
    if (body.length) await this.io.writeWords(sendBase + 4, new Uint32Array(body.buffer));
    const headBytes = buf.slice(0, 4);
    await this.io.writeWords(sendBase, new Uint32Array(headBytes.buffer));
    await triggerIRQ(this.io, this.irqn);
    return true;
  }
}
