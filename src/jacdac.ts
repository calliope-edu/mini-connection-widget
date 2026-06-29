/**
 * Jacdac frame transport for the connected Calliope mini (Layer 2).
 *
 * The campus MakeCode host relays raw Jacdac frames between the embedded pxt
 * editor's Jacdac simulator and the physical device. The widget owns the
 * DAPLink/CMSIS-DAP session exclusively (controller=2), so the iframe cannot
 * open its own WebUSB Jacdac transport — the widget must move the frames. This
 * module runs the CMSIS-DAP RAM-exchange (see `jacdac-mailbox.ts`) over the
 * widget's already-open `ArmDebug` handle, sharing the same serialized DAP
 * `sendQueue` the serial path uses, so no second WebUSB claim is needed and
 * reads/writes interleave safely with serial polling.
 *
 * Public surface (probed by campus `jacdacTransport.ts`):
 *   sendJacdacFrame(frame) — host → device; starts the exchange loop lazily.
 *   onJacdacFrame(cb)      — device → host; registers a sink (does NOT start
 *                            the loop, so a non-Jacdac session pays nothing).
 *   isJacdacAvailable()    — true once the mailbox is located.
 *   stopJacdacExchange()   — tear down (program switch / disconnect).
 *
 * Inert until a Jacdac-extension program is running: the first `sendJacdacFrame`
 * (which only happens when the editor's Jacdac sim is active) triggers a RAM
 * scan; if no mailbox is found the loop stops quietly until the next send.
 */

import { ConnectionStatus } from '@microbit/microbit-connection';
import { getUsbConn } from './usb';
import { appendLog } from './log';
import { JacdacMailbox, JacdacInvalidMemoryError, type JacdacMemIO } from './jacdac-mailbox';

/** The slice of @microbit/microbit-connection's ArmDebug we use. */
interface ArmDebugLike {
  readonly isOpen: boolean;
  /**
   * Bring up the SWD debug port (JTAG→SWD switch, read ID, power up the debug
   * + system domains). Idempotent — no-op when already connected — and does
   * NOT halt or reset the core, so the running program is undisturbed.
   */
  connect(maxRetries?: number): Promise<void>;
  readBlock(address: number, count: number): Promise<Uint32Array>;
  writeBlock(address: number, values: Uint32Array): Promise<void>;
}

/**
 * Reach the ArmDebug handle on the held USB connection. `device` is a
 * TS-private field on MicrobitUSBConnectionImpl, and `device.adi`
 * (USBDeviceWrapper.adi) is the public ArmDebug — field names confirmed for
 * @microbit/microbit-connection 1.0.0-beta.1. A `getArmDebug()` accessor could
 * be added to the package patch to remove this cast (see the Layer-2 design),
 * but the cast keeps Layer 2 self-contained in the widget.
 */
function getArmDebug(): ArmDebugLike | null {
  const usb = getUsbConn();
  if (!usb || usb.status !== ConnectionStatus.Connected) return null;
  const adi = (usb as unknown as { device?: { adi?: ArmDebugLike } }).device?.adi;
  return adi ?? null;
}

function memIO(adi: ArmDebugLike): JacdacMemIO {
  return {
    readWords: (addr, count) => adi.readBlock(addr, count),
    writeWords: (addr, words) => adi.writeBlock(addr, words),
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Poll cadence: 0ms while frames are flowing (browser throttles a busy loop),
// a small idle gap otherwise so an idle Jacdac session doesn't saturate the DAP
// bus or starve serial. Tunable — confirm on hardware (Layer-2 design §6).
const POLL_IDLE_MS = 4;
/** Bounded outbound FIFO; drop-oldest past this so a stuck device can't leak. */
const MAX_OUTBOUND = 256;
/** Min gap between RAM scans after a "not found", so repeated sends from a
 *  non-Jacdac session don't trigger a scan storm. */
const SCAN_COOLDOWN_MS = 2000;

const subscribers = new Set<(frame: Uint8Array) => void>();
let outbound: Uint8Array[] = [];
let loopActive = false;
let stopRequested = false;
let paused = false;
let available = false;
let scanCooldownUntil = 0;
let droppedFrames = 0;

/** True once the exchange mailbox has been located on the connected device. */
export function isJacdacAvailable(): boolean {
  return available;
}

/**
 * Send one raw Jacdac frame to the device. Lazily starts the exchange loop —
 * the first send means the editor's Jacdac sim is active, i.e. a Jacdac program
 * is running. Resolves immediately (fire-and-forget into a bounded FIFO); the
 * loop drains it one frame per cycle.
 */
export async function sendJacdacFrame(frame: Uint8Array): Promise<void> {
  if (!frame || frame.length === 0) return;
  outbound.push(frame);
  if (outbound.length > MAX_OUTBOUND) {
    outbound.shift();
    droppedFrames++;
    // Throttle: a flood here just means the loop isn't draining yet (scan
    // failing, or device not connected). One line per 100 drops is enough.
    if (droppedFrames % 100 === 1) {
      appendLog({ direction: 'info', text: `Jacdac: outbound queue full — dropped ${droppedFrames} frame(s) so far (loop not draining)` });
    }
  }
  if (!loopActive && Date.now() >= scanCooldownUntil) void runLoop();
}

/**
 * Subscribe to raw Jacdac frames read from the device. Returns an unsubscribe.
 * Does not itself start the exchange loop (only `sendJacdacFrame` does), so a
 * non-Jacdac MakeCode session never triggers a RAM scan.
 */
export function onJacdacFrame(cb: (frame: Uint8Array) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Force-stop the exchange loop and clear queued frames. Idempotent. Called on
 *  program switch, flash teardown, and USB disconnect (clearUsbConn). */
export function stopJacdacExchange(): void {
  stopRequested = true;
  available = false;
  outbound = [];
}

/** Pause the loop for the duration of a flash (quiet bus). Mirrors the serial
 *  pause; the loop parks at the top of its next iteration. */
export function pauseJacdacExchange(): void {
  paused = true;
}

export function resumeJacdacExchange(): void {
  paused = false;
}

function emit(frame: Uint8Array): void {
  for (const cb of subscribers) {
    try {
      cb(frame);
    } catch (err) {
      appendLog({ direction: 'info', text: `Jacdac frame handler error: ${(err as Error)?.message ?? err}` });
    }
  }
}

async function runLoop(): Promise<void> {
  if (loopActive) return;
  loopActive = true;
  stopRequested = false;
  let mailbox: JacdacMailbox | null = null;
  try {
    const adi = getArmDebug();
    if (!adi) {
      appendLog({ direction: 'info', text: 'Jacdac: USB not connected — exchange not started' });
      return;
    }
    mailbox = new JacdacMailbox(memIO(adi));
    let found = false;
    let failCooldown = SCAN_COOLDOWN_MS;
    try {
      // Bring up the SWD debug port before any memory access. The widget keeps
      // the USB transport open but leaves SWD disconnected in serial-only
      // steady state, so readBlock would fault — the device returns a sticky
      // error and even the abort-clear fails ("Bad status for 8" = the
      // DAP_WRITE_ABORT command). connect() is idempotent and does not
      // halt/reset the core.
      await adi.connect();
      try {
        found = await mailbox.scan();
      } catch (err) {
        if (err instanceof JacdacInvalidMemoryError) {
          // The mailbox magic is present but the exchange buffer isn't in its
          // clean post-boot state — we attached to a long-running program. Like
          // jacdac-ts (and MakeCode's own Jacdac connect), soft-reset the core
          // so the firmware re-initialises the exchange, wait for it to come
          // back, then re-scan. Done only when needed (not when the buffer is
          // already clean, e.g. right after a flash), so we avoid an extra
          // reboot in the common case.
          appendLog({ direction: 'info', text: 'Jacdac: re-initialising exchange (soft-resetting the mini)…' });
          await mailbox.resetTarget();
          await delay(1200); // firmware re-init: jacdac-ts notes ~700ms min
          found = await mailbox.scan();
        } else {
          throw err;
        }
      }
    } catch (err) {
      appendLog({ direction: 'error', text: `Jacdac scan failed: ${(err as Error)?.message ?? err}` });
      // We may have just rebooted the device — back off longer so a persistent
      // failure doesn't reboot-storm the mini every couple of seconds.
      failCooldown = 5000;
    }
    if (!found) {
      available = false;
      scanCooldownUntil = Date.now() + failCooldown;
      appendLog({ direction: 'info', text: 'Jacdac: exchange not ready (no Jacdac program, or still re-initialising)' });
      return;
    }
    available = true;
    appendLog({ direction: 'info', text: 'Jacdac: exchange ready' });

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
        emit(inbound);
        didWork = true;
      }
      if (outbound.length) {
        const sent = await mailbox.trySendOutbound(outbound[0]);
        if (sent) {
          outbound.shift();
          didWork = true;
        }
      }
      await delay(didWork ? 0 : POLL_IDLE_MS);
    }
  } catch (err) {
    appendLog({ direction: 'error', text: `Jacdac exchange loop error: ${(err as Error)?.message ?? err}` });
    // A transfer error mid-loop is almost always a device reboot (e.g. just
    // after a flash) tearing down SWD. Back off before allowing a restart so
    // we don't tight-loop adi.connect() against a rebooting device while the
    // widget's own USB reconnect runs; the next sendJacdacFrame after the
    // cooldown re-connects SWD and re-scans cleanly.
    scanCooldownUntil = Date.now() + 1500;
  } finally {
    mailbox?.reset();
    available = false;
    loopActive = false;
  }
}
