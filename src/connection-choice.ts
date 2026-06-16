import { writable, type Readable } from './store';

/**
 * "Nothing is connected, what should we do?" prompt.
 *
 * Fires from `flashCalliope` when the user clicked Download but neither USB
 * nor BLE is available. The UI renders three choices:
 *
 *   - `ble`     — open the BLE picker, connect, then auto-resume the flash
 *                 via the pending-flash hook in `flash.ts`.
 *   - `usb`     — run the existing USB hybrid plug-prompt + flash path.
 *   - `download`— save the hex file to disk so the user can drag-and-drop
 *                 it onto the Calliope's USB mass-storage device.
 *
 * The promise resolves with the user's choice, or rejects with
 * `'user-cancelled'` if they close the modal.
 */
export type ConnectionChoice = 'ble' | 'usb' | 'download';

export interface ConnectionChoiceRequest {
  fileName: string;
  /**
   * Whether the Bluetooth choice should be offered. When false (BLE flashing
   * disabled — the default for normal users) the modal shows only USB and
   * hex-download. See `ble-flash-policy.ts`.
   */
  bleEnabled: boolean;
  choose: (choice: ConnectionChoice) => void;
  cancel: () => void;
}

const _req = writable<ConnectionChoiceRequest | null>(null);
export const calliopeConnectionChoiceRequest: Readable<ConnectionChoiceRequest | null> = {
  subscribe: _req.subscribe,
};

export function awaitConnectionChoice(
  fileName: string,
  bleEnabled: boolean,
): Promise<ConnectionChoice> {
  return new Promise((resolve, reject) => {
    _req.set({
      fileName,
      bleEnabled,
      choose: (choice) => { _req.set(null); resolve(choice); },
      cancel: () => { _req.set(null); reject(new Error('user-cancelled')); },
    });
  });
}
