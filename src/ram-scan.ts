/**
 * One RAM sweep for every CMSIS-DAP mailbox channel.
 *
 * Jacdac (`jacdac-mailbox.ts`), Blocks (`blocks-mailbox.ts`) and IoT
 * (`iot-mailbox.ts`) all locate their exchange struct the same way: walk device
 * RAM outwards from an anchor in 1 KB blocks, read each block WHOLE over the
 * debug memory port, and look for a 64-bit magic pair inside it. The transfer is
 * the entire cost — a full 128 KB sweep is ~1 s of blind time — while matching
 * an extra magic pair in an already-fetched block is free (measured: 1069 ms for
 * three pairs vs 1062 ms for one).
 *
 * So the sweep lives here once, and every block it fetches is checked against
 * ALL registered signatures. The caller still gets the old semantics — return as
 * soon as MY magic is found, `null` when the window is exhausted — but any other
 * channel's magic seen along the way is remembered as a "sighting". The next
 * channel to scan starts with a single 2-word confirmation read at that address
 * instead of a second 1-second sweep. That is the whole point: a Blocks probe on
 * connect already sweeps all of RAM when no Blocks program is running, and that
 * sweep flies straight past the IoT mailbox.
 *
 * A sighting is a CACHE, never a source of truth: it is re-verified (the magic
 * pair must still be at that address) before it is handed out, and it expires.
 * A reflash, a reboot, or a different mini therefore costs at most one wasted
 * 8-byte read before the normal sweep takes over.
 *
 * Transport-free on purpose (same rule as the mailbox codecs): it only needs a
 * `readWords`, so it loads in a Node test runner with an in-memory fake.
 */

// Scan window + stride, shared verbatim by all channels (ported from jacdac-ts
// `microbit.ts:453-458`). MEM_START is raised above the SoftDevice-protected low
// RAM (s113 reserves up to ~0x20002040): a debug-port read of that region faults
// and can trip the device's APP_MEMACC panic (071) — a panic screen on a device
// we were only probing. Every SoftDevice-hosted mailbox lives in app RAM well
// above this, 1 KB-aligned at or above the anchor.
//
// A runtime built WITHOUT a SoftDevice may legitimately place its struct below
// that boundary, so a signature can carry its own lower bound (`memStart`). It
// is per signature, never global: lowering one channel's floor cannot make
// another channel read memory it doesn't read today — not even through the
// shared sightings, which are recorded only within the sighted channel's own
// window.
export const DEFAULT_MEM_START = 0x20002400;
const MEM_START = DEFAULT_MEM_START;
const MEM_STOP = 0x20000000 + 128 * 1024;
const CHECK_SIZE = 1024;
const SCAN_ANCHOR = 0x20006000;

/** How long a sighting from another channel's sweep stays usable. Short enough
 *  that a stale one can't linger across a session, long enough to cover the gap
 *  between the connect-time program-type probe and the first channel start. */
const SIGHTING_TTL_MS = 30_000;

/**
 * Minimal read interface the sweep needs — a thin slice of ArmDebug
 * (`readBlock`), structurally satisfied by `JacdacMemIO` / `BlocksMemIO` /
 * `IotMemIO`.
 */
export interface RamScanIO {
  /** Read `count` 32-bit words starting at byte address `addr`. */
  readWords(addr: number, count: number): Promise<Uint32Array>;
}

/** A channel's mailbox signature: the two 32-bit words that mark its struct. */
export interface ExchangeSignature {
  /** Stable channel id ('jacdac' | 'blocks' | 'iot'). */
  key: string;
  magic0: number;
  magic1: number;
  /**
   * Lowest address this channel's struct may live at. Defaults to
   * {@link DEFAULT_MEM_START} — the SoftDevice-safe floor every channel used
   * before. Only lower it for a runtime that is known to have no SoftDevice:
   * below the boundary a debug-port read can panic the device (071).
   */
  memStart?: number;
}

function floorOf(sig: ExchangeSignature): number {
  return sig.memStart === undefined ? MEM_START : Math.max(sig.memStart, 0x20000000);
}

/** Every signature we know about, so one sweep can match them all. Each mailbox
 *  module registers itself on first scan (and at import time), so the set grows
 *  with the channels that are actually loaded. */
const signatures = new Map<string, ExchangeSignature>();

/** Where each channel's magic was last seen, and when. */
const sightings = new Map<string, { addr: number; at: number }>();

/**
 * Which channels have been SEEN at all since the last forget — the address-free,
 * TTL-free half of a sighting.
 *
 * `sightings` answers "where is it, so I can skip the sweep", and for that a
 * short TTL is right: an address goes stale. But there is a second question
 * with a different lifetime — "what KIND of program is this mini running?" —
 * and that answer holds for as long as the program does. A host that wants to
 * know whether a Jacdac / Blocks / IoT runtime is on the other end should not
 * have to start a transport (and pay a poll loop) to find out, and it should
 * not lose the answer 30 seconds later.
 *
 * Costs nothing: the sweep has the block in host memory and matches every
 * signature over it anyway. This just keeps the by-product.
 */
const everSighted = new Set<string>();

/**
 * Has this channel's mailbox been seen on the device since the last forget?
 *
 * A one-way fact per connection: false means "not seen YET" (maybe nothing ever
 * swept), never "definitely absent". Callers must treat it as evidence, not as
 * a gate — which is exactly how it is useful, because the evidence arrives for
 * free during somebody else's sweep.
 */
export function wasExchangeSighted(key: string): boolean {
  return everSighted.has(key);
}

/**
 * Teach the sweep about a channel's magic pair. Idempotent (keyed by `key`);
 * call it at module load so a sweep triggered by ANOTHER channel already looks
 * for yours.
 */
export function registerExchangeSignature(sig: ExchangeSignature): void {
  signatures.set(sig.key, {
    key: sig.key,
    magic0: sig.magic0 >>> 0,
    magic1: sig.magic1 >>> 0,
    memStart: sig.memStart,
  });
}

/**
 * Drop cached sightings — all of them, or one channel's. Not required for
 * correctness (every sighting is re-verified before use), but a caller that
 * KNOWS the device changed (disconnect, flash) can save the wasted read.
 */
export function forgetExchangeSightings(key?: string): void {
  if (key === undefined) {
    sightings.clear();
    everSighted.clear();
  } else {
    sightings.delete(key);
    everSighted.delete(key);
  }
}

/** Confirm a remembered address still carries the channel's magic pair. */
async function confirmSighting(io: RamScanIO, sig: ExchangeSignature, addr: number): Promise<boolean> {
  try {
    const head = await io.readWords(addr, 2);
    return head[0] === sig.magic0 && head[1] === sig.magic1;
  } catch {
    return false;
  }
}

/**
 * Find one channel's exchange struct in device RAM. Returns its base address, or
 * null when that channel's runtime isn't there.
 *
 * Identical in observable behaviour to the per-channel scans it replaces: same
 * window, same anchor, same outward-spiral order, same "a block that faults is
 * skipped, not fatal", same early return on the first hit. The additions are
 * invisible to the caller — the cheap sighting shortcut up front, and the
 * sideband bookkeeping for the other channels during the sweep.
 */
export async function findExchangeByMagic(io: RamScanIO, sig: ExchangeSignature): Promise<number | null> {
  registerExchangeSignature(sig);
  const want = signatures.get(sig.key) as ExchangeSignature;

  // Another channel's sweep may already have flown past our magic. One 8-byte
  // read to confirm beats a second full sweep; a miss just falls through.
  const seen = sightings.get(want.key);
  if (seen && Date.now() - seen.at < SIGHTING_TTL_MS) {
    if (await confirmSighting(io, want, seen.addr)) return seen.addr;
    sightings.delete(want.key);
  }

  const all = [...signatures.values()];
  // How far down THIS sweep may read. Another channel's lower floor never
  // widens ours, and a magic seen below a channel's own floor is not recorded
  // for it (see below) — so a lowered floor stays contained to its channel.
  const floor = floorOf(want);
  let p0 = SCAN_ANCHOR;
  let p1 = SCAN_ANCHOR + CHECK_SIZE;

  const check = async (addr: number): Promise<number | null> => {
    if (addr < floor) return null;
    if (addr + CHECK_SIZE > MEM_STOP) return null;
    let buf: Uint32Array;
    try {
      buf = await io.readWords(addr, CHECK_SIZE >> 2);
    } catch {
      // A block that faults (e.g. a protected region) isn't where any struct
      // is; skip it and keep scanning rather than aborting the whole search.
      return 0;
    }
    // The block is already in host memory — matching every known signature over
    // it costs CPU only, no further USB traffic.
    let hit = 0;
    const now = Date.now();
    for (let i = 0; i < buf.length - 1; i++) {
      const w = buf[i];
      for (const s of all) {
        if (w === s.magic0 && buf[i + 1] === s.magic1) {
          const at = addr + (i << 2);
          // Only inside that channel's own window: a sweep with a lower floor
          // must not hand another channel an address its own scan would never
          // have reached.
          if (at >= floorOf(s)) {
            sightings.set(s.key, { addr: at, at: now });
            everSighted.add(s.key);
          }
          if (s.key === want.key && !hit) hit = at;
        }
      }
    }
    return hit;
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
