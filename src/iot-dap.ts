/**
 * IoT line transport over CMSIS-DAP (the codal/mini-3 USB data channel).
 *
 * Third sibling of `jacdac.ts` and `blocks-dap.ts`: it runs the `IotMailbox`
 * RAM-exchange (see `iot-mailbox.ts`) over the widget's already-open `ArmDebug`
 * handle, through the same serialized DAP queue the serial, Jacdac and
 * Blocks-DAP paths use — so no second WebUSB claim is needed and reads/writes
 * interleave safely.
 *
 * What it replaces: the `IOT1:` lines that a MakeCode/pxt program writes with
 * `serial.writeLine` today. The moment a program hands its UART to a WLAN
 * module, that pipe is gone — this one isn't, because it goes through the debug
 * port instead. Campus does not care which pipe carried a line (campus
 * `src/lib/services/iot/wire.ts`), so `onIotLine` / `sendIotLine` deliberately
 * mirror `onSerialLine` / `sendSerialLine`. USB (mini 3) only; BLE keeps using
 * serial, and so does mini 2 (J-Link, no CMSIS-DAP memory port here).
 *
 * Public surface (consumed by campus `iot/serialRelay.ts`):
 *   sendIotLine(line)   — host → device; starts the exchange loop lazily.
 *                         Returns false when the line is REFUSED (empty, or
 *                         over the device's 64-byte slot) — never truncated.
 *   onIotLine(cb)       — device → host; one line per callback, no terminator.
 *   startIotExchange()  — proactively scan + poll without an outbound line.
 *   stopIotExchange()   — tear down (program switch / disconnect).
 *   isIotAvailable()    — true once the mailbox is located.
 *   pause/resumeIotExchange() — quiet the bus during a flash.
 *
 * Inert until asked: nothing here touches the bus until `startIotExchange` or
 * the first `sendIotLine`. A scan that finds nothing is not taken as final —
 * the device builds its struct and writes the magic lazily, so a start / flash /
 * reset arms a bounded series of retries (~20 s) and then goes quiet until
 * something asks again. Bounded because a miss costs a full ~1 s RAM sweep, and
 * most sessions run a program without the IoT extension.
 *
 * Bus manners. This channel does NOT claim the DAP arbiter: an IoT program is
 * an ordinary MakeCode program that may ALSO be driving the Jacdac relay, and
 * taking ownership would tear that relay down. Correctness comes from
 * `withDapBus`, which makes every whole readBlock/writeBlock atomic against
 * other users (see `dap-arbiter.ts` — the owner is an optimization, the bus
 * chain is the floor). The one owner we do yield to is 'blocks': the codal
 * Blocks runtime cannot host the pxt IoT extension, so a scan there could only
 * ever fail — at the price of a ~1 s sweep on a bus the Blocks loop is using.
 */

import { ConnectionStatus } from '@microbit/microbit-connection';
import { getUsbConn } from './usb';
import { appendLog } from './log';
import { pushProxy } from './comms';
import { IotMailbox, IOT_SEND_MAX, iotLineFits } from './iot-mailbox';
import { wasExchangeSighted } from './ram-scan';
import { getDapOwner, onDapOwnerChange, withDapBus } from './dap-arbiter';

/** The slice of @microbit/microbit-connection's ArmDebug we use (same as blocks-dap.ts). */
interface ArmDebugLike {
  readonly isOpen: boolean;
  /** Bring up the SWD debug port. Idempotent; does NOT halt or reset the core. */
  connect(maxRetries?: number): Promise<void>;
  /** Reset cached DP/AP state and reconnect (no re-enumeration). Optional so
   *  older lib builds without it fall back to `connect()`. */
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

function memIO(adi: ArmDebugLike) {
  return {
    readWords: (addr: number, count: number) => withDapBus(() => adi.readBlock(addr, count)),
    writeWords: (addr: number, words: Uint32Array) => withDapBus(() => adi.writeBlock(addr, words)),
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 0ms while lines are flowing; an idle gap otherwise so an idle session doesn't
// saturate the DAP bus or starve the other users of it.
//
// NOT the 4ms that jacdac.ts and blocks-dap.ts use, and the difference is not
// an oversight. Those two are the only user of the bus while they run. This
// mailbox shares it with the CDC serial reader — every `withDapBus` slot the
// poll takes is one the serial read waits for — and 4ms meant ~250 slots a
// second against a reader that needs them to keep up with a talking device.
// The symptoms were a truncated uplink (`IOT1:h:akah…` arriving as `ypc`),
// "Transfer WAIT (target busy)" on the next scan, and a USB link that dropped
// every few seconds.
//
// 50ms costs nothing in latency, because the DEVICE only looks into the
// mailbox every 100ms itself (`basic.pause(100)` in the extension's background
// fiber). Polling faster than the other end answers buys no speed at all.
const POLL_IDLE_MS = 50;
/** Bounded outbound FIFO; drop-oldest past this so a stuck device can't leak. */
const MAX_OUTBOUND = 256;
/** Min gap between RAM scans after a "not found", so repeated sends don't scan-storm. */
const SCAN_COOLDOWN_MS = 2000;
/**
 * How long the bus stays quiet after a flash before the first scan.
 *
 * The device is rebooting for roughly the first second, and a scan that lands
 * in that window does not merely fail — it fails inside `reinit()` with a
 * "Transfer WAIT (target busy)", which takes the USB link down.
 */
const POST_FLASH_QUIET_MS = 2500;

const subscribers = new Set<(line: string) => void>();
let outbound: string[] = [];
let loopActive = false;
let stopRequested = false;
let paused = false;
let available = false;
let scanCooldownUntil = 0;
let droppedLines = 0;
/** A consumer wants this channel live — set by start/send, cleared by stop. It
 *  is what lets a rescan (after a flash, a target reset, or a bus handover)
 *  restart the loop without a fresh send. */
let wanted = false;
// Set after a flash: the next scan must REINIT the SWD session, not reuse the
// idempotent connect. A DAPLink flash resets the target, so ArmDebug's cached
// DP_SELECT/AP_CSW go stale; subsequent RAM reads fault and the scan finds
// nothing until a full reconnect.
let needsReinit = false;
let rescanTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Bounded "try again" budget for a scan that found nothing. Refilled where a
 * miss plausibly means "too early" rather than "no IoT program": on an explicit
 * start, after a flash, after a target reset.
 *
 * It has to be bounded: unlike Blocks-DAP this channel is usually LISTEN-only
 * (campus subscribes, the device talks), so there is no outbound line to
 * resurrect a dead loop — but a not-found scan is a full ~1 s RAM sweep, so
 * retrying forever would chew the DAP bus in every ordinary non-IoT session.
 */
let rescanBudget = 0;

/**
 * Delays between those retries (ms), indexed by how many have been spent. The
 * device writes its magic pair LAZILY — the runtime builds the struct when the
 * program first uses the exchange, ~100 ms after start, and writes the magic
 * last so a host never sees a half-built struct. Add a reboot (~1-2 s after a
 * flash or a RESET press) and the first scan legitimately finds nothing. These
 * four attempts cover ~20 s, then the channel goes quiet until something asks
 * again.
 */
const RESCAN_DELAYS_MS = [1500, 2500, 6000, 10000];
const RESCAN_BUDGET = RESCAN_DELAYS_MS.length;

/**
 * Set once a full retry series has concluded that the running program has no
 * mailbox — an ordinary non-IoT hex, or one built before the exchange existed.
 *
 * It exists because {@link startIotExchange} is called again by every consumer
 * that (re)mounts, and a scan can itself cost the link: a miss leaves
 * `needsReinit` set from a previous target reset, the next attempt runs
 * `adi.reinit()`, and reinitialising SWD against a device that is busy or
 * rebooting drops USB. The consumer then remounts, calls in here again, and a
 * refill turned "this program has no mailbox" into an endless
 * connect → scan → drop → reconnect loop, at roughly one round every 3 s.
 *
 * Cleared only by the events that can genuinely change what is running on the
 * device: a flash, a target reset, and losing the bus.
 */
let scanConcluded = false;

/** Start a fresh series of retries — on start, after a flash, after a reset. */
function refillRescanBudget(): void {
  rescanBudget = RESCAN_BUDGET;
  scanConcluded = false;
}

/**
 * Schedule the next "try again" scan, spending one unit of budget. Does nothing
 * once the budget is gone, which is what keeps an ordinary non-IoT session from
 * sweeping RAM forever.
 */
function armRescan(): void {
  if (rescanBudget <= 0) return;
  const spent = RESCAN_BUDGET - rescanBudget;
  const delayMs = RESCAN_DELAYS_MS[spent] ?? RESCAN_DELAYS_MS[RESCAN_DELAYS_MS.length - 1];
  rescanBudget--;
  scheduleRescan(delayMs);
}

function scheduleRescan(delayMs: number): void {
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    // An armed retry ignores the post-miss cooldown — waiting for the device to
    // publish its struct IS the reason we are here.
    attemptRescan(true);
  }, delayMs);
}

function attemptRescan(armed: boolean): void {
  if (!wanted) return;                     // nobody is listening — stay inert
  if (loopActive) return;
  if (paused) {                            // flash in progress — never scan
    if (armed) armRescan();                // …come back after the flash window
    return;
  }
  if (getDapOwner() === 'blocks') return;  // Blocks runtime: no IoT mailbox there
  if (!armed && Date.now() < scanCooldownUntil) return;
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
export function isIotAvailable(): boolean {
  return available;
}

/**
 * Is an IoT program running on the connected mini? — the MARKER, not the pipe.
 *
 * `isIotAvailable()` answers a transport question: is this channel carrying
 * lines right now. It is false in every case where the mailbox is switched off
 * (which is the default — see campus `USB_MAILBOX_ENABLED`), over BLE, and on a
 * mini 2. So it cannot be used to recognise an IoT device.
 *
 * This can, and it costs nothing. Every RAM sweep matches ALL registered
 * signatures over each block it has already fetched (`ram-scan.ts`), so the
 * Blocks program-type probe that runs on connect flies straight past the IoT
 * mailbox's magic and records having seen it. We only have to ask.
 *
 * What it buys: the host can tell "this mini is running a program with the IoT
 * extension" from the connection alone — before any `IOT1:` line has been
 * heard, with no editor open, and without starting a single poll loop. The host
 * then knows that it is worth asking the device who it is instead of concluding
 * from one unanswered probe that nobody is there.
 *
 * ASYMMETRIC, and that is the whole contract: true is proof, false is only
 * "nothing has swept yet, or the sweep hasn't reached that block". A mini 3
 * whose connect probe was skipped, a mini 2 (no CMSIS-DAP memory port) and
 * every BLE link answer false while running the very program this asks about.
 * So: treat true as a reason to try harder, never false as a reason to stop.
 */
export function isIotProgramDetected(): boolean {
  return wasExchangeSighted('iot');
}

/**
 * Start the exchange: scan RAM for the IoT mailbox and, once found, poll it.
 * Idempotent. A scan that finds nothing is NOT final — the device writes its
 * magic lazily, so this arms a small, bounded series of retries (~20 s) and then
 * goes quiet until something asks again. The channel stays "wanted" throughout,
 * so a post-flash or post-reset rescan can pick it up on its own.
 */
export function startIotExchange(): void {
  wanted = true;
  // Deliberately NOT an unconditional refill: see `scanConcluded`. A consumer
  // that remounts on every reconnect would otherwise restart the series each
  // time, and the scan is what breaks the connection in the first place.
  if (scanConcluded) return;
  rescanBudget = RESCAN_BUDGET;
  if (getDapOwner() === 'blocks') return;
  // `!rescanTimer`: a retry is already scheduled, and it knows better than this
  // call does when the device will be ready. Scanning now would only be an
  // extra attempt against the same not-yet-ready target.
  if (!loopActive && !paused && !rescanTimer && Date.now() >= scanCooldownUntil) void runLoop();
}

/**
 * Send one `IOT1:` line to the device (no trailing newline needed — the slot's
 * length byte is the framing). Lazily starts the exchange loop. Resolves
 * immediately (fire-and-forget into a bounded FIFO); the loop drains it one line
 * per cycle.
 *
 * Returns false when the line was REFUSED rather than queued: empty, or longer
 * than the device's 64-byte slot ({@link IOT_SEND_MAX}), or the Blocks editor
 * owns the bus. A too-long line is never truncated — half an `IOT1:v:` line is
 * a wrong value, not a shorter one — so the caller has to shorten or split it
 * ({@link iotLineFits} checks before composing). True means queued, not
 * delivered: delivery needs the device to free the slot.
 */
export async function sendIotLine(line: string): Promise<boolean> {
  if (typeof line !== 'string') return false;
  const clean = line.replace(/[\r\n]+$/, '');
  if (!clean) return false;
  // The send slot is 64 bytes and cannot grow — a longer line would sit at the
  // head of the queue forever, so refuse it here, loudly.
  if (!iotLineFits(clean)) {
    appendLog({ direction: 'info', text: `IoT-DAP: line too long for the mailbox (${clean.length} > ${IOT_SEND_MAX} bytes) — not sent` });
    return false;
  }
  // The Blocks editor owns the shared DAP bus — stay inert (a codal Blocks
  // program has no IoT mailbox anyway).
  if (getDapOwner() === 'blocks') return false;
  wanted = true;
  outbound.push(clean);
  if (outbound.length > MAX_OUTBOUND) {
    outbound.shift();
    droppedLines++;
    if (droppedLines % 100 === 1) {
      appendLog({ direction: 'info', text: `IoT-DAP: outbound queue full — dropped ${droppedLines} line(s) (loop not draining)` });
    }
  }
  // While paused (flash in progress) only queue — restarting the loop here would
  // run ensureSwd + a full RAM scan concurrently with the flash's SWD traffic and
  // silently corrupt pages (TAR clobber). resumeIotExchange() kicks the drain
  // once the flash window closes.
  if (!loopActive && !paused && Date.now() >= scanCooldownUntil) void runLoop();
}

/**
 * Subscribe to `IOT1:` lines read from the device (terminator already stripped).
 * Returns an unsubscribe. Does not itself start the loop — mirroring
 * `onJacdacFrame` / `onBlocksDapFrame`, so a session that never opts in pays
 * nothing. Call `startIotExchange()` to go live.
 */
export function onIotLine(cb: (line: string) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Stop the loop for real: no consumer wants the channel any more. Idempotent.
 *  Called on program switch, flash teardown, and USB disconnect. */
export function stopIotExchange(): void {
  wanted = false;
  rescanBudget = 0;
  if (rescanTimer) {
    clearTimeout(rescanTimer);
    rescanTimer = null;
  }
  teardown();
}

/** Drop the running loop + queue but keep the channel "wanted" (bus handover,
 *  post-flash restart) so a rescan may bring it back. */
function teardown(): void {
  stopRequested = true;
  available = false;
  outbound = [];
  // Losing the bus may mean a different device arrives next, so the conclusion
  // "this program has no mailbox" does not carry over to it.
  scanConcluded = false;
}

/** Pause the loop for the duration of a flash (quiet bus). */
export function pauseIotExchange(): void {
  paused = true;
}

export function resumeIotExchange(): void {
  paused = false;
  // Drain anything queued while the gate was closed. Without this kick a line
  // sent mid-flash would sit in the FIFO until the NEXT send restarts the loop.
  if (!loopActive && outbound.length > 0 && Date.now() >= scanCooldownUntil) void runLoop();
}

/**
 * Proactively restart the exchange loop (re-scan) WITHOUT waiting for an
 * outbound line — used after a flash / target reset, where nothing else would
 * re-trigger us (a USB flash produces no usbStatus edge, so the host never
 * re-subscribes). Gated so it can never scan mid-flash (the TAR-clobber page
 * corruption guard) or fight the Blocks loop.
 */
export function kickIotRescan(): void {
  attemptRescan(false);
}

/**
 * After a USB flash, force the next IoT scan to rebuild the SWD session, and
 * drop the running loop (it was only paused across the flash, so it would
 * otherwise resume on the pre-flash mailbox address + stale cache). The flashed
 * program is usually a different one, so the mailbox may be somewhere else — or
 * gone. Re-kicks itself once the device has had time to reboot, with a fresh
 * retry budget (the freshly started program publishes its magic lazily, so the
 * first look after the reboot can still be too early), but only while a consumer
 * is attached.
 */
export function reinitIotAfterFlash(): void {
  needsReinit = true;
  available = false;
  outbound = [];
  // A QUIET WINDOW, not an open door. This used to clear the cooldown, and the
  // scheduled first look below was then routinely overtaken: a consumer that
  // remounts right after a flash calls `startIotExchange()`, which scans at
  // once if the cooldown allows it — and the relay's layout effect re-runs
  // milliseconds after the flash finishes.
  //
  // That scan then hit a target still in its reboot, answered "Transfer WAIT
  // (target busy)", and a WAIT inside `reinit()` takes the USB link down with
  // it. The reconnect remounted the relay, which called in here again: a
  // disconnect every few seconds for as long as the tab stayed open.
  //
  // An armed retry ignores this window on purpose (see `attemptRescan`) —
  // waiting for the device to publish its struct is exactly its job.
  scanCooldownUntil = Date.now() + POST_FLASH_QUIET_MS;
  stopRequested = true;
  refillRescanBudget();
  scheduleRescan(POST_FLASH_QUIET_MS);
}

// The Blocks editor taking the bus means a codal Blocks hex is running — no IoT
// mailbox can exist there, and our scan would only steal bus time. Park until
// the bus is handed back.
onDapOwnerChange((o) => {
  if (o === 'blocks') {
    teardown();
  } else if (wanted) {
    // Let the losing loop finish tearing down before we scan.
    scheduleRescan(250);
  }
});

function emit(line: string): void {
  for (const cb of subscribers) {
    try {
      cb(line);
    } catch (err) {
      appendLog({ direction: 'info', text: `IoT-DAP line handler error: ${(err as Error)?.message ?? err}` });
    }
  }
}

async function runLoop(): Promise<void> {
  if (loopActive) return;
  loopActive = true;
  stopRequested = false;
  let mailbox: IotMailbox | null = null;
  try {
    // Hard flash gate: park BEFORE any SWD access. A loop started just as a
    // flash begins must not run ensureSwd + a full RAM scan concurrently with
    // the flash — that is the silent page-corruption vector.
    while (paused && !stopRequested) {
      await delay(20);
    }
    if (stopRequested) return;
    const adi = getArmDebug();
    if (!adi) {
      appendLog({ direction: 'info', text: 'IoT-DAP: USB not connected — exchange not started' });
      return;
    }
    mailbox = new IotMailbox(memIO(adi));
    let found = false;
    try {
      // Bring up SWD before any memory access — a full reinit once after a
      // flash (stale cache), else the idempotent connect.
      await ensureSwd(adi);
      found = await mailbox.scan();
    } catch (err) {
      appendLog({ direction: 'error', text: `IoT-DAP scan failed: ${(err as Error)?.message ?? err}` });
    }
    if (!found) {
      available = false;
      scanCooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
      // NOT proof of absence: the device publishes its magic only when the
      // program first uses the exchange, so a scan can simply be early. Spend
      // one retry if the budget allows, and say which case this is.
      const retrying = rescanBudget > 0;
      armRescan();
      // The series is over: stop looking until a flash, a reset or a lost bus
      // says the device may be running something else now.
      if (!retrying) scanConcluded = true;
      appendLog({
        direction: 'info',
        text: retrying
          ? 'IoT-DAP: exchange buffer not there yet — retrying'
          : 'IoT-DAP: exchange buffer not found (program without the IoT extension?)',
      });
      return;
    }
    available = true;
    // Found it — no more retries pending.
    rescanBudget = 0;
    if (rescanTimer) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
    appendLog({ direction: 'info', text: 'IoT-DAP: exchange ready' });

    while (!stopRequested) {
      const adiNow = getArmDebug();
      if (!adiNow || !adiNow.isOpen) break;
      if (paused) {
        await delay(20);
        continue;
      }
      let didWork = false;
      const inbound = await mailbox.readInbound();
      if (inbound !== null) {
        // A consumed-but-empty slot still counts as work; there is just nothing
        // to hand on.
        if (inbound) {
          pushProxy({ direction: 'rx', transport: 'usb', kind: 'serial', text: inbound });
          emit(inbound);
        }
        didWork = true;
      }
      if (outbound.length) {
        const out = outbound[0];
        const sent = await mailbox.trySendOutbound(out);
        if (sent) {
          outbound.shift();
          pushProxy({ direction: 'tx', transport: 'usb', kind: 'serial', text: out });
          didWork = true;
        }
      }
      await delay(didWork ? 0 : POLL_IDLE_MS);
    }
  } catch (err) {
    appendLog({ direction: 'error', text: `IoT-DAP exchange loop error: ${(err as Error)?.message ?? err}` });
    // A mid-loop SWD fault = the target rebooted — almost always the RESET
    // button or a post-flash reboot. The DP/AP cache is stale afterwards, so
    // force a full reinit on the next scan and re-kick once the device is back
    // (gated in kickIotRescan). Back off first so we don't tight-loop against a
    // still-rebooting target.
    scanCooldownUntil = Date.now() + 1500;
    needsReinit = true;
    // The program restarts from scratch after a reset, so its struct is built
    // (and its magic written) all over again — a fresh retry series, not one
    // shot.
    refillRescanBudget();
    scheduleRescan(2000);
  } finally {
    mailbox?.reset();
    available = false;
    loopActive = false;
  }
}
