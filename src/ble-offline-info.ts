import { writable, type Readable } from './store';

/**
 * Visible signal that the UI should pop up the "BLE is off on your Calliope"
 * explainer. Triggered from the BLE connect-error path when the connect
 * attempt failed with a generic transient (timeout, picker-empty, GATT
 * disconnect) — typically because the device is currently running a hex
 * without BLE enabled.
 *
 * Recovery paths from the modal:
 *  1. User presses A+B+Reset on the Calliope → device enters DfuTarg → user
 *     clicks Verbinden again → reconnect daemon picks up the DFU device →
 *     dispatcher routes any pending flash via BLE-DFU.
 *  2. User plugs in USB → connection-choice modal or direct USB flow.
 */
const _visible = writable<boolean>(false);
export const calliopeBleOfflineInfo: Readable<boolean> = { subscribe: _visible.subscribe };

export function dismissBleOfflineInfo(): void {
  _visible.set(false);
}
export function showBleOfflineInfo(): void {
  _visible.set(true);
}
