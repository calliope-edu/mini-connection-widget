/**
 * USB recovery ladder — the fast, light "what should I do now?" escalation
 * shown in the global connection banner when a USB connection is lost or a
 * connect attempt fails.
 *
 * Replaces the old occurrence-counted `<UsbErrorModal />`. Instead of a heavy
 * modal that only escalated after repeated *user* re-clicks, this is a
 * TIME-DRIVEN ladder that surfaces help fast and steps up on its own:
 *
 *   reconnecting → click → replug → reload
 *
 *  - `reconnecting`: the reconnect daemon is silently re-grabbing the still-
 *    permitted device via `navigator.usb.getDevices()`. Just a spinner; if the
 *    daemon wins, the ladder auto-clears.
 *  - `click`: ask the user to click "Verbinden". A user gesture lets WebUSB run
 *    `requestDevice()` if the permission was lost — the one thing a background
 *    timer can't do. Armed immediately (no `reconnecting` grace) when we already
 *    know a gesture is required (permission gone / "Must be handling a user
 *    gesture").
 *  - `replug`: a fresh connect didn't help → tell them to unplug/replug the USB
 *    cable (also covers "another tab holds the device"). Armed here directly for
 *    `device-in-use`, where clicking Verbinden would just hit the same lock.
 *  - `reload`: last resort → reload the page. A reload resets WebUSB state and
 *    the daemon silently re-grabs the (still-permitted) device on the next load.
 *
 * Timings are deliberately snappy (see `DWELL_MS`): lost → ~1s → click →
 * ~4s → replug → ~9s → reload.
 *
 * No framework dependency — a plain store any UI can subscribe to.
 */

import { writable, type Readable } from './store';
import { calliopeState, getState, type CalliopeState } from './state';
import { appendLog } from './log';

export type UsbRecoveryRung = 'none' | 'reconnecting' | 'replug' | 'reload';

/**
 * How long to dwell at each rung before auto-advancing to the next. We try a
 * silent reconnect first (`reconnecting`, ~2s); if that doesn't land we go
 * STRAIGHT to asking the user to re-plug the Calliope — there is NO intermediate
 * "just click connect" rung. `replug` then has no dwell: we wait for the user to
 * physically unplug/replug and press "Erneut verbinden" (at their own pace). The
 * step to `reload` only happens if that retry fails (see `escalateUsbRecovery`).
 * `reload` is terminal too.
 */
// The first waiting stage auto-advances to "please re-plug" after this; the
// post-confirm waiting stage falls back to "reload" after a (longer) backstop —
// but normally the connect attempt's own failure gets there first. NOTHING
// auto-advances past `replug`: that step waits for the user (they need time to
// physically re-plug at their own pace).
const RECONNECTING_DWELL_MS = 3_000;
const POST_CONFIRM_DWELL_MS = 8_000;

const _recovery = writable<UsbRecoveryRung>('none');
/** Current rung of the USB recovery ladder. `none` when nothing is wrong. */
export const calliopeUsbRecovery: Readable<UsbRecoveryRung> = { subscribe: _recovery.subscribe };

// Synchronous mirror so the logic can branch without a subscribe dance.
let currentRung: UsbRecoveryRung = 'none';
let timer: ReturnType<typeof setTimeout> | null = null;
// Bumped on every state change so a stale advance-timer callback no-ops.
let generation = 0;
// Which waiting stage we're in: 0 = first try (→ ask to re-plug), 1 = the retry
// after the user confirmed the re-plug (→ offer reload if it still fails).
let pass = 0;

function setRung(rung: UsbRecoveryRung): void {
  currentRung = rung;
  _recovery.set(rung);
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// The ONLY automatic step is the `reconnecting` waiting stage timing out. First
// pass → "please re-plug"; second pass (after the user confirmed) → "reload" as
// a backstop. `replug` waits for the user's confirm; `reload` is terminal.
function scheduleAdvance(): void {
  clearTimer();
  if (currentRung !== 'reconnecting') return;
  const myGen = generation;
  const dwell = pass === 0 ? RECONNECTING_DWELL_MS : POST_CONFIRM_DWELL_MS;
  const next: UsbRecoveryRung = pass === 0 ? 'replug' : 'reload';
  timer = setTimeout(() => {
    if (myGen !== generation) return;
    setRung(next);
    appendLog({ direction: 'info', text: `USB recovery → ${next}` });
  }, dwell);
}

// The ladder is moot the moment a connection is fine (or the user bailed): USB
// back, the user explicitly disconnected/forgot USB, or BLE is connected (it's
// fine to have just one transport — don't nag about USB; goal 4). Arming and the
// auto-clear watcher both consult this so they never disagree (a watcher only
// runs on a `calliopeState` change, so without this an arm fired while BLE is
// already connected would show a stale banner until the next unrelated tick).
function recoveryMoot(s: CalliopeState): boolean {
  return s.usbStatus === 'connected' || s.userDisconnectedUsb || s.bleStatus === 'connected';
}

/**
 * Start the recovery flow at the first waiting stage. No-op if a connection is
 * already fine (`recoveryMoot`) or if the ladder is already running (a re-arm
 * mustn't restart it or reset the pass). Called on an unexpected drop and on a
 * fresh connect failure (via `escalateUsbRecovery`).
 */
export function armUsbRecovery(startRung: Exclude<UsbRecoveryRung, 'none'> = 'reconnecting'): void {
  void startRung; // the flow always starts at the first waiting stage now
  if (recoveryMoot(getState())) return;
  if (currentRung !== 'none') return;
  pass = 0;
  generation += 1;
  setRung('reconnecting');
  scheduleAdvance();
  appendLog({ direction: 'info', text: 'USB recovery armed (reconnecting)' });
}

/**
 * React to a USB connect/flash failure. If the user's post-re-plug retry just
 * failed (pass ≥ 1) → go to `reload`. A fresh failure with nothing running →
 * start the flow (first waiting stage; the dwell then asks to re-plug). While
 * the first pass is already running we leave it: the dwell drives reconnecting→
 * replug, and `replug` waits for the user's confirm.
 */
export function escalateUsbRecovery(kind: 'device-in-use' | 'device-disconnected'): void {
  void kind; // both kinds drive the same flow now
  if (recoveryMoot(getState())) return;
  if (pass >= 1 && currentRung !== 'none') {
    generation += 1;
    clearTimer();
    setRung('reload');
    appendLog({ direction: 'info', text: 'USB recovery → reload' });
    return;
  }
  if (currentRung === 'none') armUsbRecovery();
}

/**
 * The user confirmed they re-plugged the Calliope (the `replug` rung's "Erneut
 * verbinden"). Drop back to the waiting stage for a moment — the UI fires a
 * fresh connect alongside this. If it lands, the auto-clear watcher tears the
 * ladder down; if it fails, the connect's `escalateUsbRecovery` (pass ≥ 1) moves
 * to `reload`, with the post-confirm dwell as a backstop. Crucially there is NO
 * timer that advances PAST `replug` without this explicit confirm.
 */
export function confirmReplug(): void {
  if (currentRung !== 'replug') return;
  pass = 1;
  generation += 1;
  setRung('reconnecting');
  scheduleAdvance();
  appendLog({ direction: 'info', text: 'USB recovery: re-plug confirmed → retry' });
}

/** Tear the ladder down (USB reconnected, or the user gave up on USB). */
export function clearUsbRecovery(): void {
  if (currentRung === 'none' && timer === null) return;
  generation += 1;
  pass = 0;
  clearTimer();
  setRung('none');
}

// Auto-clear the instant the ladder becomes moot. Installed once at import — the
// check is a cheap early-out while idle.
calliopeState.subscribe((s) => {
  if (currentRung === 'none') return;
  if (recoveryMoot(s)) clearUsbRecovery();
});

// ---- Reload-and-reconnect coordination ------------------------------------

/**
 * sessionStorage flag set right before a reload-to-recover (the `reload` rung).
 * The banner reads it on the next load to resume the ladder in `reconnecting`
 * so the reload doesn't feel like nothing happened. sessionStorage (not local)
 * so it's tab-scoped and self-clears when the tab closes.
 */
export const USB_RECONNECT_AFTER_RELOAD_KEY = 'calliope:usb-reconnect-after-reload';

/**
 * `reload` rung action: mark "reconnect after reload" and reload the page.
 * Deliberately does NOT forget the device — the WebUSB permission must survive
 * the reload so the daemon can silently re-open it via `getDevices()`.
 */
export function reloadForUsbReconnect(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(USB_RECONNECT_AFTER_RELOAD_KEY, '1');
  } catch {
    // Private mode / storage disabled — reload anyway; the daemon still tries.
  }
  clearUsbRecovery();
  window.location.reload();
}

/**
 * Read-and-clear the post-reload flag. Returns true exactly once after a
 * `reloadForUsbReconnect()` call.
 */
export function consumeUsbReconnectAfterReload(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const had = window.sessionStorage.getItem(USB_RECONNECT_AFTER_RELOAD_KEY) === '1';
    if (had) window.sessionStorage.removeItem(USB_RECONNECT_AFTER_RELOAD_KEY);
    return had;
  } catch {
    return false;
  }
}
