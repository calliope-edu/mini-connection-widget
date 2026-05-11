import { writable, type Readable } from './store';

/**
 * Visible signal that the UI should pop up the OS-pairing explainer. Shown
 * on demand when the user clicks the "Wie pairen?" link in the BLE row.
 * UI consumers subscribe and call `dismissBlePairingInfo()` when the modal
 * is closed.
 */
const _visible = writable<boolean>(false);
export const calliopeBlePairingInfo: Readable<boolean> = { subscribe: _visible.subscribe };

export function dismissBlePairingInfo(): void {
  _visible.set(false);
}
export function showBlePairingInfo(): void {
  _visible.set(true);
}
