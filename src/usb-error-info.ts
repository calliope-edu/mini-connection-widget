import { writable, type Readable } from './store';

/**
 * Guided modal for the two USB error states that have a clear physical
 * recovery path:
 *
 *  - `in-use`: another Chrome tab / native helper currently holds the
 *    DAPLink interface. The user has to close the other tool (or replug
 *    the cable to force Windows to re-enumerate). Symptom from Chromium:
 *    `Failed to execute 'claimInterface' on 'USBDevice': Unable to claim
 *    interface`.
 *
 *  - `disconnected`: the cached `USBDevice` handle is stale, typically
 *    right after a Disconnect → Connect cycle where Windows hasn't yet
 *    released the previous kernel-side claim by the time `open()` fires
 *    again. Symptom from Chromium: `Failed to execute 'open' on
 *    'USBDevice': The device was disconnected`.
 *
 * Setting either kind here makes the host app's `<UsbErrorModal />`
 * render a recovery card. The card is two-stage: the FIRST time an error
 * surfaces it offers a quick in-page "Erneut verbinden" (cheap, sometimes
 * works because `connectWithRetry` waits out the kernel-release race). If
 * that retry fails and the SAME error surfaces again, `occurrence` climbs
 * and the card switches to the reliable recovery: replug the cable, then
 * reload the page. A full reload resets the browser's WebUSB state and the
 * reconnect daemon silently re-grabs the (still-permitted) device via
 * `navigator.usb.getDevices()` — no picker, no stale handle.
 *
 * The raw message is kept so power users / log readers can still see what
 * Chromium actually threw.
 */
export type UsbErrorInfoKind = 'in-use' | 'disconnected';

export interface UsbErrorInfo {
  kind: UsbErrorInfoKind;
  rawMessage: string;
  /**
   * How many times this error episode has surfaced without an intervening
   * dismiss/success. `1` = first time (offer quick retry); `>= 2` = the
   * quick retry already failed (guide replug + reload). Same-`kind` re-shows
   * increment; a different kind or a dismiss/success resets to `1`.
   */
  occurrence: number;
}

const _info = writable<UsbErrorInfo | null>(null);
export const calliopeUsbErrorInfo: Readable<UsbErrorInfo | null> = {
  subscribe: _info.subscribe,
};

// Synchronous mirror of the store so `showUsbErrorInfo` can branch on the
// current value (and bump `occurrence`) without an async subscribe dance.
let current: UsbErrorInfo | null = null;

export function showUsbErrorInfo(kind: UsbErrorInfoKind, rawMessage: string): void {
  // A re-show of the same kind while the card is still up means the user's
  // last retry didn't take — escalate to the reload guidance.
  const occurrence = current && current.kind === kind ? current.occurrence + 1 : 1;
  current = { kind, rawMessage, occurrence };
  _info.set(current);
}

export function dismissUsbErrorInfo(): void {
  current = null;
  _info.set(null);
}

// ---- Reload-and-reconnect coordination ------------------------------------

/**
 * sessionStorage flag set right before a reload-to-recover. The host app
 * reads it on the next load (via `<UsbReconnectBanner />`) to show a
 * "reconnecting…" affordance and, if the daemon's silent reconnect doesn't
 * land, a gesture-bound "Jetzt verbinden" fallback. sessionStorage (not
 * localStorage) so it's scoped to this tab and self-clears when the tab closes.
 */
export const USB_RECONNECT_AFTER_RELOAD_KEY = 'calliope:usb-reconnect-after-reload';

/**
 * Stage-2 recovery action: mark "reconnect after reload" and reload the page.
 * Deliberately does NOT forget the device — the WebUSB permission must
 * survive the reload so the reconnect daemon can re-open it silently.
 */
export function reloadForUsbReconnect(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(USB_RECONNECT_AFTER_RELOAD_KEY, '1');
  } catch {
    // Private mode / storage disabled — reload anyway; the daemon still tries.
  }
  dismissUsbErrorInfo();
  window.location.reload();
}

/**
 * Read-and-clear the post-reload flag. Returns true exactly once after a
 * `reloadForUsbReconnect()` call. Idempotent on repeat calls within the load.
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
