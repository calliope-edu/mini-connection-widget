/**
 * Hard guard for the native device chooser
 * (`navigator.bluetooth.requestDevice` / `navigator.usb.requestDevice`).
 *
 * The reconnect daemon (reconnect-daemon.ts) and every other silent/background
 * reconnect path is meant to NEVER open a chooser — it reconnects only to
 * already-permitted devices. That guarantee used to rest on the browser
 * rejecting `requestDevice` with "must be handling a user gesture" when called
 * from a timer. That assumption is unsafe: transient user activation is a
 * ~5-second WINDOW on the window object, not something bound to the
 * originating click's synchronous call stack. So a backoff tick that fires
 * shortly after ANY click — the click that navigated the user to another page,
 * or a click on the page they are now on — still has transient activation, and
 * `requestDevice` then SUCCEEDS, popping the OS pairing dialog on whatever page
 * is showing. (Observed: a Bluetooth "Koppeln"/pairing dialog appearing by
 * itself on the /create page after leaving a room where a device had been
 * connected.)
 *
 * Rather than trust the gesture check, we wrap the silent reconnect calls in
 * `withChooserBlocked()` and have the `requestDevice` intercepts refuse while
 * the gate is closed. The gate DEFAULTS OPEN, so explicit, user-initiated
 * connect/flash flows are entirely unaffected; the only behavioural change is
 * that a background reconnect can no longer surface a chooser.
 */

let blockedDepth = 0;

/** True while a silent/background reconnect is holding the chooser closed. */
export function isChooserBlocked(): boolean {
  return blockedDepth > 0;
}

/**
 * Run `fn` with the native device chooser blocked. Any
 * `navigator.{bluetooth,usb}.requestDevice` call made while this is active is
 * rejected with a "user gesture" error — the same shape the silent-reconnect
 * callers already classify as "no reconnectable device" — so a stray transient
 * activation can never turn a background reconnect into a pairing prompt.
 * Re-entrant and exception-safe.
 */
export async function withChooserBlocked<T>(fn: () => Promise<T>): Promise<T> {
  blockedDepth += 1;
  try {
    return await fn();
  } finally {
    blockedDepth -= 1;
  }
}

/**
 * The rejection thrown by the `requestDevice` intercepts while the chooser is
 * blocked. The phrasing deliberately mirrors the browser's own gesture-less
 * rejection AND contains "user gesture", so the existing `/user gesture/i`
 * checks on the silent-reconnect paths treat it as "no device available"
 * rather than a hard error.
 */
export function chooserBlockedError(): Error {
  return new DOMException(
    'Must be handling a user gesture to show a permission request. ' +
      '(blocked by mini-connection-widget chooser gate during a silent reconnect)',
    'NotAllowedError',
  );
}

// ---- WebUSB chooser guard --------------------------------------------------
//
// The BLE path already wraps `navigator.bluetooth.requestDevice` in ble.ts
// (for optionalServices augmentation + device tracking); that wrapper consults
// `isChooserBlocked()`. WebUSB has no such existing wrapper — the upstream
// `@microbit/microbit-connection` calls `navigator.usb.requestDevice` directly
// inside its `chooseDevice()` — so install a thin guard here. It is a
// transparent passthrough except while the gate is closed.
let usbChooserGuardInstalled = false;
function installUsbChooserGuard(): void {
  if (usbChooserGuardInstalled) return;
  if (typeof navigator === 'undefined' || !('usb' in navigator) || !navigator.usb) return;
  usbChooserGuardInstalled = true;
  const usb = navigator.usb as unknown as {
    requestDevice: (opts?: unknown) => Promise<unknown>;
  };
  const orig = usb.requestDevice.bind(navigator.usb);
  usb.requestDevice = async (opts?: unknown) => {
    if (isChooserBlocked()) throw chooserBlockedError();
    return orig(opts);
  };
}
// Install eagerly so a background USB reconnect can never reach a real chooser.
installUsbChooserGuard();
