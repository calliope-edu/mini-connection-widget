/**
 * @calliope-edu/calliope-connection — staged-locally entry point.
 *
 * Vanilla TypeScript wrapper around `@microbit/microbit-connection` that
 * orchestrates the higher-level Calliope lifecycle: simultaneous USB+BLE
 * tracking, smart picker resets, stale-bond detection, automatic flash
 * routing (BLE-paired > USB > USB-plug prompt), and a Svelte-compatible
 * store so any UI framework can subscribe.
 *
 * No framework dependency, no Svelte imports — when this directory moves
 * into its own repo nothing here needs to change.
 *
 * Future native-proxy mode: a wrapping native app (iOS/Android/desktop) will
 * own BLE + USB + flashing, and this package can swap in a thin proxy that
 * mutates the same `calliopeState` and dispatches the same `connectCalliope`/
 * `flashCalliope` actions over a postMessage bridge. The public API surface
 * stays identical so consumers don't need to know which backend is active.
 */

import { connectCalliope } from './connect';
import { getUsbConnection } from './usb';
import { refreshPairedBleStatus } from './ble';
import { appendLog } from './log';

// ---- Public API ------------------------------------------------------------

export type {
  CalliopeState,
  CalliopeStatus,
  CalliopeTransport,
  CalliopeFlashPhase,
} from './state';
export type { CalliopeVersion } from './helpers';
export type { CalliopeLogEntry } from './log';
export type { UsbPlugRequest } from './usb-plug';
export type { Readable, Writable, Subscriber, Unsubscriber } from './store';

export { calliopeState } from './state';
export { calliopeLog, clearCalliopeLog } from './log';
export { calliopeBlePairingInfo, dismissBlePairingInfo, showBlePairingInfo } from './pairing-info';
export { calliopeUsbPlugRequest } from './usb-plug';

export { connectCalliope, disconnectAndForget } from './connect';
export { flashCalliope } from './flash';
export { sendSerialLine, onSerialLine } from './serial';
export { getConnectedBleDevice } from './ble';
export { getRunningProgramType } from './program-type';
export type { CalliopeProgramType, CalliopeProgramInfo } from './program-type';

// ---- Initialization --------------------------------------------------------

/**
 * Wire up module side-effects: silently reconnect to a previously-permitted
 * USB Calliope on app start, and refresh the "browser remembers a paired
 * BLE device" hint. Call once in the host app's bootstrap.
 *
 * Idempotent — calling more than once is a no-op after the first run.
 */
let initialized = false;
export function initializeCalliopeConnection(): void {
  if (initialized) return;
  initialized = true;
  if (typeof window === 'undefined') return;
  // Brief delay so the page has time to settle before we fire WebUSB calls.
  setTimeout(() => {
    void tryAutoReconnect();
    void refreshPairedBleStatus();
  }, 250);
}

/**
 * Silently reconnect to a previously-authorized USB Calliope. Only attempts
 * a real connect when `navigator.usb.getDevices()` already returns an
 * authorized DAPLink — never prompts the user.
 */
async function tryAutoReconnect(): Promise<void> {
  if (typeof navigator === 'undefined' || !('usb' in navigator)) return;
  try {
    const devices = (await (navigator as unknown as {
      usb: { getDevices(): Promise<{ vendorId: number; productId: number }[]> };
    }).usb.getDevices()) as { vendorId: number; productId: number }[];
    const authorized = devices.find(
      (d) => d.vendorId === 0x0d28 && d.productId === 0x0204,
    );
    if (!authorized) return;
    appendLog({ direction: 'info', text: 'Auto-reconnecting to authorized device' });
    const c = await getUsbConnection();
    await c.connect();
  } catch (err) {
    appendLog({
      direction: 'info',
      text: `Auto-reconnect skipped: ${(err as Error)?.message ?? err}`,
    });
  }
}

// Touch the `connectCalliope` import so tree-shakers don't drop it from the
// bundle when only `flashCalliope` is consumed (some internal codepaths in
// `flash.ts` end up calling connect via the lib's reconnect, but nothing
// here calls `connectCalliope` directly).
void connectCalliope;
