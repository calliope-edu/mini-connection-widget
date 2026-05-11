import { writable, type Readable } from './store';

/**
 * The hybrid flash path needs UI cooperation: when MakeCode hands us a hex
 * but only BLE is open, we have to ask the user to plug in USB. The store
 * exposes `usbPlugRequest` for the UI to render a modal; the modal calls
 * `confirm()` once the user has plugged in, or `cancel()` to abort the flash.
 */
export interface UsbPlugRequest {
  reason: 'hybrid-flash';
  fileName: string;
  confirm: () => void;
  cancel: () => void;
}

const _req = writable<UsbPlugRequest | null>(null);
export const calliopeUsbPlugRequest: Readable<UsbPlugRequest | null> = {
  subscribe: _req.subscribe,
};

export function awaitUsbPlugConfirm(fileName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    _req.set({
      reason: 'hybrid-flash',
      fileName,
      confirm: () => { _req.set(null); resolve(); },
      cancel: () => { _req.set(null); reject(new Error('user-cancelled')); },
    });
  });
}
