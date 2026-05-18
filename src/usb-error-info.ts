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
 * render a recovery card with numbered steps and a "Erneut verbinden"
 * button. The raw message is kept so power users / log readers can still
 * see what Chromium actually threw.
 */
export type UsbErrorInfoKind = 'in-use' | 'disconnected';

export interface UsbErrorInfo {
  kind: UsbErrorInfoKind;
  rawMessage: string;
}

const _info = writable<UsbErrorInfo | null>(null);
export const calliopeUsbErrorInfo: Readable<UsbErrorInfo | null> = {
  subscribe: _info.subscribe,
};

export function showUsbErrorInfo(kind: UsbErrorInfoKind, rawMessage: string): void {
  _info.set({ kind, rawMessage });
}

export function dismissUsbErrorInfo(): void {
  _info.set(null);
}
