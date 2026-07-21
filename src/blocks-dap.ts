/**
 * Blocks-over-CMSIS-DAP transport driver (the codal/mini-3 USB transport).
 *
 * Sibling of `jacdac.ts`: it runs the `BlocksMailbox` RAM-exchange (see
 * `blocks-mailbox.ts`) over the widget's already-open `ArmDebug` handle, sharing
 * the same serialized DAP queue the serial + Jacdac paths use, so no second
 * WebUSB claim is needed and reads/writes interleave safely. It bypasses the
 * nRF↔interface UART entirely — fast and reliable (USB CRC + retransmit), no
 * 115200 bottleneck — replacing the legacy serial Blocks transport on mini 3.
 *
 * Public surface (consumed by campus `calliopeRemoteHost.ts`):
 *   sendBlocksDapFrame(frame) — host → device; starts the exchange loop lazily.
 *   onBlocksDapFrame(cb)      — device → host; receives parsed BlocksFrame
 *                               objects (same shape as `onBlocksFrameFromUsb`).
 *   isBlocksDapAvailable()    — true once the mailbox is located.
 *   stopBlocksDapExchange()   — tear down (program switch / disconnect).
 *   pause/resumeBlocksDapExchange() — quiet the bus during a flash.
 *
 * Inert until used: the first `sendBlocksDapFrame` triggers a RAM scan; if no
 * Blocks-DAP runtime is present (e.g. a J-Link mini, or a non-Blocks program)
 * the loop stops quietly until the next send.
 */

import { ConnectionStatus } from '@microbit/microbit-connection';
import { getUsbConn } from './usb';
import { appendLog } from './log';
import { BlocksMailbox, findBlocksExchange, type BlocksMemIO } from './blocks-mailbox';
import { BlocksFrameParser, buildBlocksFrame, BLOCKS_REQ, BLOCKS_RES, type BlocksFrame } from './blocks-frame';
import { logIncomingFrame, logOutgoingFrame } from './blocks-protocol';
import { noteBlocksFrame, noteBlocksVersion, resetBlocksLiveness } from './blocks-liveness';
import { getDapOwner, setDapOwner, onDapOwnerChange, withDapBus } from './dap-arbiter';

/** The slice of @microbit/microbit-connection's ArmDebug we use (same as jacdac.ts). */
interface ArmDebugLike {
  readonly isOpen: boolean;
  /** Bring up the SWD debug port. Idempotent; does NOT halt or reset the core. */
  connect(maxRetries?: number): Promise<void>;
  /** Reset cached DP/AP state and reconnect (no re-enumeration). The lib's remedy
   *  after a DAPLink flash resets the target and leaves the protocol cache stale.
   *  Optional so older lib builds without it fall back to `connect()`. */
  reinit?(): Promise<void>;
  readBlock(address: number, count: number): Promise<Uint32Array>;
  writeBlock(address: number, values: Uint32Array): Promise<void>;
}

/** Reach the ArmDebug handle on the held USB connection (see jacdac.ts:getArmDebug). */
function getArmDebug(): ArmDebugLike | null {
  const usb = getUsbConn();
  if (!usb || usb.status !== ConnectionStatus.Connected) return null;
  const adi = (usb as unknown as { device?: { adi?: ArmDebugLike } }).device?.adi;
  return adi ?? null;
}

function memIO(adi: ArmDebugLike): BlocksMemIO {
  return {
    readWords: (addr, count) => withDapBus(() => adi.readBlock(addr, count)),
    writeWords: (addr, words) => withDapBus(() => adi.writeBlock(addr, words)),
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 0ms while frames are flowing; a small idle gap otherwise so an idle session
// doesn't saturate the DAP bus or starve other DAP users. (Mirror jacdac.ts.)
const POLL_IDLE_MS = 4;
/** Bounded outbound FIFO; drop-oldest past this so a stuck device can't leak. */
const MAX_OUTBOUND = 256;
/** Min gap between RAM scans after a "not found", so repeated sends don't scan-storm. */
const SCAN_COOLDOWN_MS = 2000;

const subscribers = new Set<(frame: BlocksFrame) => void>();
let outbound: Uint8Array[] = [];
let loopActive = false;
let stopRequested = false;
let paused = false;
let available = false;
let scanCooldownUntil = 0;
let droppedFrames = 0;
// Set after a flash: the next scan must REINIT the SWD session, not reuse the
// idempotent connect. A DAPLink flash resets the target, so ArmDebug's cached
// DP_SELECT/AP_CSW go stale; subsequent RAM reads fault and the mailbox scan
// finds nothing ("exchange buffer not found") until a full reconnect. reinit()
// clears the cache + re-powers the debug domain — the lib's fix for exactly this.
let needsReinit = false;

/**
 * After a USB flash, force the next Blocks-DAP scan to rebuild the SWD session.
 * Also drops the running loop (it was only paused across the flash, so it would
 * otherwise resume on the pre-flash mailbox address + stale cache) so the next
 * send/probe does a clean re-scan.
 */
export function reinitBlocksDapAfterFlash(): void {
  needsReinit = true;
  stopRequested = true;
  available = false;
  outbound = [];
  scanCooldownUntil = 0;
  // The flash may have replaced the program — stale liveness must not keep
  // reporting "blocks" for a hex that is no longer there.
  resetBlocksLiveness();
  // CRITICAL: we just STOPPED the loop, but nothing restarts it on its own —
  // the campus host only re-subscribes on a usbStatus false→true edge, which a
  // USB flash never produces (status is frozen 'connected' across the flash),
  // and a target reset's resume clobbers a just-restarted loop. So the loop
  // stayed dead → no live comms until a manual reconnect. Own the restart:
  // after the device has had time to reboot, re-scan ourselves if a consumer
  // (the campus bridge subscriber) is still attached. The gate inside
  // kickBlocksDapRescan keeps this safe (never during a flash/jacdac/cooldown).
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => { rescanTimer = null; kickBlocksDapRescan(); }, 2500);
}

let rescanTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Proactively restart the exchange loop (re-scan) WITHOUT waiting for an
 * outbound frame — used after a flash / target-reset teardown, where the
 * campus host won't re-trigger a send (its subscriptions still look "active",
 * and no usbStatus edge fires). Only kicks when a consumer is attached and the
 * bus is genuinely free, so it can never scan mid-flash (the TAR-clobber page
 * corruption guard) or fight Jacdac.
 */
export function kickBlocksDapRescan(): void {
  if (loopActive) return;
  if (paused) return;                      // flash in progress — never scan
  if (getDapOwner() === 'jacdac') return;  // MakeCode owns the bus
  if (subscribers.size === 0) return;      // no live-comms consumer to serve
  if (Date.now() < scanCooldownUntil) return;
  void runLoop();
}

/** Bring up SWD for a scan: a full `reinit()` once after a flash (the cache is
 *  stale), otherwise the cheap idempotent `connect()`. Clears the flag only on a
 *  successful bring-up so a still-rebooting device retries reinit next scan. */
async function ensureSwd(adi: ArmDebugLike): Promise<void> {
  if (needsReinit && typeof adi.reinit === 'function') {
    await adi.reinit();
  } else {
    await adi.connect();
  }
  needsReinit = false;
}

/** True once the exchange mailbox has been located on the connected device. */
export function isBlocksDapAvailable(): boolean {
  return available;
}

/** Version payload from a COMMAND read, mirroring probeBle's return shape. */
export interface BlocksDapInfo {
  hardwareVersion?: number;
  protocolVersion?: number;
  runtimeVersion?: number;
}

/**
 * One-shot detection for program-type probing: bring up SWD (idempotent, no
 * halt), scan RAM for the Blocks-DAP mailbox, and — once found — issue ONE
 * COMMAND (0x0100) read so the caller gets the runtime version, exactly like
 * the BLE probe. Returns the version payload when a Blocks-DAP runtime is
 * present, else `null`. Does NOT start the exchange loop.
 *
 * The COMMAND read is what makes USB detection version-complete: without it a
 * mini 3 confirmed Blocks over USB with runtimeVersion=undefined, so an old
 * hex was never flagged outdated over USB (it was over BLE). Bounded so it
 * can't blow the probe's own timeout.
 */
export async function detectBlocksDap(): Promise<BlocksDapInfo | null> {
  // Bus owned by Jacdac (MakeCode editor) — don't probe over a contended bus.
  if (getDapOwner() === 'jacdac') return null;
  // Flash in progress (paused) — NEVER scan: interleaved DAP commands retarget
  // the flash's TAR auto-increment mid-chunk and silently corrupt written pages.
  // The program-type auto-refresh re-probes once the flash window closes.
  if (paused) return null;
  // If the live exchange loop is already running it has already located the
  // mailbox; return that instead of issuing a CONCURRENT scan. ArmDebug
  // readBlock isn't atomic across callers, so a second reader here would corrupt
  // the loop's in-flight reads (and its own) — exactly the contention we avoid.
  // The loop's noteBlocksFrame already feeds the liveness latch (incl. version),
  // and getRunningProgramType's isBlocksAlive fast-path carries it.
  if (loopActive) return available ? {} : null;
  const adi = getArmDebug();
  if (!adi) return null;
  try {
    await ensureSwd(adi);
    const io = memIO(adi);
    const mailbox = new BlocksMailbox(io);
    if (!(await mailbox.scan())) return null;
    // Mailbox present ⇒ Blocks runtime. Ask for the COMMAND payload to learn
    // the version. Bounded: send once, poll a few short cycles for the reply
    // (the runtime answers exactly one RES_READ 0x0100 frame).
    const parser = new BlocksFrameParser();
    await mailbox.trySendOutbound(buildBlocksFrame(BLOCKS_REQ.READ, 0x0100));
    for (let i = 0; i < 12; i++) {
      const inbound = await mailbox.readInbound();
      if (inbound) {
        for (const f of parser.push(inbound)) {
          if (f.type === BLOCKS_RES.READ && f.channel === 0x0100 && f.data.length >= 2) {
            const info: BlocksDapInfo = {
              hardwareVersion: f.data[0],
              protocolVersion: f.data[1],
              runtimeVersion: f.data.length >= 4 ? f.data[3] : undefined,
            };
            noteBlocksVersion(info);
            return info;
          }
        }
      }
      await delay(40);
    }
    // Mailbox found but no COMMAND reply in time — still a Blocks runtime,
    // just without a version this pass (a later probe / the live loop fills it).
    return {};
  } catch {
    return null;
  }
}

/**
 * Send one raw Blocks wire frame (built by buildBlocksFrame) to the device.
 * Lazily starts the exchange loop. Resolves immediately (fire-and-forget into a
 * bounded FIFO); the loop drains it one frame per cycle.
 */
export async function sendBlocksDapFrame(frame: Uint8Array): Promise<void> {
  if (!frame || frame.length === 0) return;
  // Jacdac (MakeCode editor) owns the shared DAP bus — stay inert so two
  // exchange loops never run at once (concurrent ArmDebug reads cross + corrupt).
  if (getDapOwner() === 'jacdac') return;
  outbound.push(frame);
  if (outbound.length > MAX_OUTBOUND) {
    outbound.shift();
    droppedFrames++;
    if (droppedFrames % 100 === 1) {
      appendLog({ direction: 'info', text: `Blocks-DAP: outbound queue full — dropped ${droppedFrames} frame(s) (loop not draining)` });
    }
  }
  // While paused (flash in progress) only queue — restarting the loop here
  // would run ensureSwd + a full RAM scan concurrently with the flash's SWD
  // traffic and silently corrupt pages (TAR clobber). This lazy restart is
  // exactly how a dead loop (e.g. after a failed scan against an old hex)
  // used to resurrect itself mid-flash. resumeBlocksDapExchange() kicks the
  // drain once the flash window closes.
  if (!loopActive && !paused && Date.now() >= scanCooldownUntil) void runLoop();
}

/**
 * Subscribe to parsed Blocks frames read from the device. Returns an unsubscribe.
 * Does not itself start the loop (only sendBlocksDapFrame does).
 */
export function onBlocksDapFrame(cb: (frame: BlocksFrame) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Force-stop the exchange loop and clear queued frames. Idempotent. */
export function stopBlocksDapExchange(): void {
  stopRequested = true;
  available = false;
  outbound = [];
}

/** Pause the loop for the duration of a flash (quiet bus). */
export function pauseBlocksDapExchange(): void {
  paused = true;
}

export function resumeBlocksDapExchange(): void {
  paused = false;
  // Drain anything queued while the gate was closed. Without this kick a frame
  // sent mid-flash would sit in the FIFO until the NEXT send restarts the loop.
  if (!loopActive && outbound.length > 0 && Date.now() >= scanCooldownUntil) void runLoop();
}

// Lose the bus → tear down immediately. Jacdac (or "no editor") taking ownership
// must stop this loop before its reads can collide with ours.
onDapOwnerChange((o) => {
  if (o !== 'blocks') stopBlocksDapExchange();
});

function emit(frame: BlocksFrame): void {
  for (const cb of subscribers) {
    try {
      cb(frame);
    } catch (err) {
      appendLog({ direction: 'info', text: `Blocks-DAP frame handler error: ${(err as Error)?.message ?? err}` });
    }
  }
}

async function runLoop(): Promise<void> {
  if (loopActive) return;
  loopActive = true;
  stopRequested = false;
  let mailbox: BlocksMailbox | null = null;
  // Each inbound slot read is one complete Blocks frame, but feed it through the
  // streaming parser so framing/checksum validation is shared with the serial path.
  const parser = new BlocksFrameParser();
  try {
    // Hard flash gate: park BEFORE any SWD access. The old code only checked
    // `paused` inside the exchange while-loop, so a loop started just as a
    // flash began (or resurrected by a mid-flash send) would run ensureSwd +
    // the full RAM scan concurrently with the flash — the silent page-
    // corruption vector behind "dark display, shrinking changed-pages".
    while (paused && !stopRequested) {
      await delay(20);
    }
    if (stopRequested) return;
    const adi = getArmDebug();
    if (!adi) {
      appendLog({ direction: 'info', text: 'Blocks-DAP: USB not connected — exchange not started' });
      return;
    }
    mailbox = new BlocksMailbox(memIO(adi));
    let found = false;
    try {
      // Bring up SWD before any memory access — a full reinit once after a flash
      // (stale cache), else the idempotent connect.
      await ensureSwd(adi);
      found = await mailbox.scan();
    } catch (err) {
      appendLog({ direction: 'error', text: `Blocks-DAP scan failed: ${(err as Error)?.message ?? err}` });
    }
    if (!found) {
      available = false;
      scanCooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
      appendLog({ direction: 'info', text: 'Blocks-DAP: exchange buffer not found (no Blocks-DAP runtime / J-Link mini?)' });
      return;
    }
    available = true;
    // We found the Blocks mailbox → this device runs the Blocks runtime, so
    // claim the bus. Stops any Jacdac loop for real (device-truth, regardless of
    // whether the editor set the owner).
    setDapOwner('blocks');
    appendLog({ direction: 'info', text: 'Blocks-DAP: exchange ready' });

    while (!stopRequested) {
      const adiNow = getArmDebug();
      if (!adiNow || !adiNow.isOpen) break;
      if (paused) {
        await delay(20);
        continue;
      }
      let didWork = false;
      const inbound = await mailbox.readInbound();
      if (inbound) {
        for (const f of parser.push(inbound)) {
          logIncomingFrame('usb', f); // surface device→host frames in the comms panel
          // Passive liveness: every checksum-valid frame proves the Blocks
          // runtime — program-type detection answers from this instead of
          // racing its own probe against the busy exchange.
          noteBlocksFrame(f);
          emit(f);
        }
        didWork = true;
      }
      if (outbound.length) {
        const out = outbound[0];
        const sent = await mailbox.trySendOutbound(out);
        if (sent) {
          outbound.shift();
          logOutgoingFrame('usb', out); // surface host→device frames in the comms panel
          didWork = true;
        }
      }
      await delay(didWork ? 0 : POLL_IDLE_MS);
    }
  } catch (err) {
    appendLog({ direction: 'error', text: `Blocks-DAP exchange loop error: ${(err as Error)?.message ?? err}` });
    // A mid-loop SWD fault = the target rebooted — almost always the RESET
    // button (or a post-flash reboot). This is the ONLY reliable USB reset
    // signal for a DAP-comms session: the lib's 'serialreset' never fires
    // because the DAPLink interface stays enumerated (its serial read loop
    // never ends), so attemptSilentDaplinkResume is never called and USB comms
    // would otherwise stay dead until a manual reconnect. Own the recovery
    // here: after the reset the SWD DP/AP cache is stale, so force a full
    // reinit on the next scan, and re-kick the exchange once the device is
    // back (gated in kickBlocksDapRescan: not paused, not jacdac, cooldown
    // elapsed, a live-comms consumer still attached). Back off first so we
    // don't tight-loop against a still-rebooting target.
    scanCooldownUntil = Date.now() + 1500;
    needsReinit = true;
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => { rescanTimer = null; kickBlocksDapRescan(); }, 2000);
  } finally {
    mailbox?.reset();
    available = false;
    loopActive = false;
  }
}
