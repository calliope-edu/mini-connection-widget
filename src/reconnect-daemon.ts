/**
 * Forever-running reconnect daemon for both transports.
 *
 * Watches `calliopeState` and, whenever a transport drops from connected to
 * disconnected without the user explicitly asking for it, starts trying to
 * reconnect on a capped exponential backoff. Stops when:
 *
 *   - the transport is back in `connected`,
 *   - the user clicks "Trennen & vergessen" (sets `userDisconnectedX`),
 *   - the document becomes hidden (visibilitychange listener pauses the
 *     daemon to conserve radio / battery; resumes on visible again).
 *
 * BLE side: only reconnects when the browser still remembers the device
 * (`bleHasPermission` true), since `connect()` against an unpermitted
 * device would need a user gesture and we don't have one.
 *
 * USB side: only reconnects to already-authorized devices via
 * `getDevices()`; `requestDevice()` also needs a user gesture and is left
 * to the explicit Connect button.
 *
 * Backoff: 1s, 2s, 4s, 8s, 15s, 30s, then 30s forever. The cap is
 * intentional — at long idle we want to know within 30s when the device
 * reappears, but we don't want to burn CPU more often than that.
 */

import { calliopeState, getState, updateState, SUPPORT } from './state';
import { appendLog } from './log';
import { getBleConnection } from './ble';
import { getUsbConnection } from './usb';

const BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const STEADY_DELAY_MS = 30_000;

interface DaemonState {
  /** True while the daemon is in its retry loop. */
  running: boolean;
  /** Current backoff index (0-based into BACKOFF_DELAYS_MS, clamped to its length). */
  attempt: number;
  /** Active setTimeout handle so we can cancel on suspension / stop. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Generation counter — incremented on every start so stale callbacks no-op. */
  generation: number;
}

const ble: DaemonState = { running: false, attempt: 0, timer: null, generation: 0 };
const usb: DaemonState = { running: false, attempt: 0, timer: null, generation: 0 };

let visibilityHidden =
  typeof document !== 'undefined' ? document.visibilityState === 'hidden' : false;

function delayFor(attempt: number): number {
  return attempt < BACKOFF_DELAYS_MS.length
    ? BACKOFF_DELAYS_MS[attempt]
    : STEADY_DELAY_MS;
}

function clearTimer(d: DaemonState): void {
  if (d.timer) {
    clearTimeout(d.timer);
    d.timer = null;
  }
}

function stopDaemon(d: DaemonState, reason: string, transport: 'BLE' | 'USB'): void {
  if (!d.running) return;
  d.running = false;
  d.attempt = 0;
  clearTimer(d);
  appendLog({ direction: 'info', text: `${transport} reconnect daemon stopped: ${reason}` });
}

function shouldRunBle(): boolean {
  if (!SUPPORT.ble) return false;
  const s = getState();
  if (s.bleStatus === 'connected' || s.bleStatus === 'connecting') return false;
  if (s.userDisconnectedBle) return false;
  if (!s.bleHasPermission) return false;
  if (s.flashTransport === 'usb') return false;     // don't fight an active USB flash
  return true;
}

function shouldRunUsb(): boolean {
  if (!SUPPORT.usb) return false;
  const s = getState();
  if (s.usbStatus === 'connected' || s.usbStatus === 'connecting') return false;
  if (s.userDisconnectedUsb) return false;
  if (s.flashTransport === 'ble') return false;
  return true;
}

async function tryReconnectBle(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) return false;
  const bt = (navigator as { bluetooth?: { getDevices?: () => Promise<unknown[]> } }).bluetooth;
  if (!bt?.getDevices) return false;
  const devices = await bt.getDevices();
  if (!devices || devices.length === 0) return false;
  const c = await getBleConnection();
  await c.connect();
  updateState((st) => ({ ...st, bleHasPermission: true }));
  return true;
}

async function tryReconnectUsb(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('usb' in navigator)) return false;
  const devices = await (navigator as unknown as {
    usb: { getDevices(): Promise<{ vendorId: number; productId: number }[]> };
  }).usb.getDevices();
  const authorized = devices.find(
    (d) => d.vendorId === 0x0d28 && d.productId === 0x0204,
  );
  if (!authorized) return false;
  const c = await getUsbConnection();
  await c.connect();
  return true;
}

function scheduleNext(
  d: DaemonState,
  transport: 'BLE' | 'USB',
  shouldRun: () => boolean,
  attempt: () => Promise<boolean>,
): void {
  if (!d.running) return;
  if (visibilityHidden) {
    // Paused — leave d.running true so we resume on visibility change.
    return;
  }
  const myGen = d.generation;
  const delay = delayFor(d.attempt);
  clearTimer(d);
  d.timer = setTimeout(async () => {
    if (d.generation !== myGen) return;
    if (!shouldRun()) {
      stopDaemon(d, 'condition no longer holds', transport);
      return;
    }
    appendLog({
      direction: 'info',
      text: `${transport} reconnect attempt #${d.attempt + 1} (after ${delay}ms)`,
    });
    try {
      const ok = await attempt();
      if (d.generation !== myGen) return;
      if (ok) {
        stopDaemon(d, 'connected', transport);
        return;
      }
      // No authorized device right now (e.g. user revoked permission via
      // browser UI). Don't keep spinning — stop and wait for a fresh
      // user-initiated connect to start things up again.
      stopDaemon(d, 'no authorized device', transport);
      return;
    } catch (err) {
      appendLog({
        direction: 'info',
        text: `${transport} reconnect attempt failed: ${(err as Error)?.message ?? err}`,
      });
      if (d.generation !== myGen) return;
      d.attempt += 1;
      scheduleNext(d, transport, shouldRun, attempt);
    }
  }, delay);
}

function startDaemon(
  d: DaemonState,
  transport: 'BLE' | 'USB',
  shouldRun: () => boolean,
  attempt: () => Promise<boolean>,
): void {
  if (d.running) return;
  if (!shouldRun()) return;
  d.running = true;
  d.attempt = 0;
  d.generation += 1;
  appendLog({ direction: 'info', text: `${transport} reconnect daemon armed` });
  scheduleNext(d, transport, shouldRun, attempt);
}

function startBleIfNeeded(): void {
  startDaemon(ble, 'BLE', shouldRunBle, tryReconnectBle);
}
function startUsbIfNeeded(): void {
  startDaemon(usb, 'USB', shouldRunUsb, tryReconnectUsb);
}

// ---- Visibility handling ---------------------------------------------------

function handleVisibilityChange(): void {
  if (typeof document === 'undefined') return;
  const nowHidden = document.visibilityState === 'hidden';
  if (nowHidden === visibilityHidden) return;
  visibilityHidden = nowHidden;
  if (nowHidden) {
    // Pause both daemons. Don't `stopDaemon` because we want to resume
    // automatically — just kill the pending timers; running stays true.
    clearTimer(ble);
    clearTimer(usb);
    appendLog({ direction: 'info', text: 'Tab hidden — pausing reconnect daemons.' });
  } else {
    appendLog({ direction: 'info', text: 'Tab visible — resuming reconnect daemons.' });
    if (ble.running) scheduleNext(ble, 'BLE', shouldRunBle, tryReconnectBle);
    if (usb.running) scheduleNext(usb, 'USB', shouldRunUsb, tryReconnectUsb);
    // Also (re)evaluate — visibility regain is a great moment to start one.
    startBleIfNeeded();
    startUsbIfNeeded();
  }
}

// ---- Wiring ----------------------------------------------------------------

let installed = false;

/**
 * Wire the daemon up once at app startup. Idempotent — calling more than
 * once is a no-op. Call from `initializeCalliopeConnection`.
 */
export function installReconnectDaemon(): void {
  if (installed) return;
  installed = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  // React to state changes: a `connected → disconnected` edge arms the
  // daemon for that transport. A new `bleHasPermission` (from a successful
  // connect) is also a trigger if the daemon wasn't running and the user
  // hasn't explicitly disconnected.
  let prevBle = 'unknown';
  let prevUsb = 'unknown';
  calliopeState.subscribe((s) => {
    if (prevBle === 'connected' && s.bleStatus !== 'connected' && s.bleStatus !== 'connecting') {
      startBleIfNeeded();
    }
    if (prevUsb === 'connected' && s.usbStatus !== 'connected' && s.usbStatus !== 'connecting') {
      startUsbIfNeeded();
    }
    // If userDisconnectedX was just set, halt the corresponding daemon.
    if (s.userDisconnectedBle && ble.running) {
      stopDaemon(ble, 'user disconnected', 'BLE');
    }
    if (s.userDisconnectedUsb && usb.running) {
      stopDaemon(usb, 'user disconnected', 'USB');
    }
    prevBle = s.bleStatus;
    prevUsb = s.usbStatus;
  });
}

/**
 * Kick the daemon to evaluate now (instead of waiting for the next state
 * change). Called from `initializeCalliopeConnection` after the initial
 * permission refresh so we start reconnecting on page load when there's a
 * remembered device.
 */
export function triggerReconnectEvaluation(): void {
  startBleIfNeeded();
  startUsbIfNeeded();
}
