/**
 * Classify low-level BLE/USB transport errors into actionable categories so
 * the UI shows a guided modal instead of a raw Chromium / WebUSB toast.
 *
 * With rc07-open firmware (`MICROBIT_BLE_OPEN=1`) there is no SMP / OS bond
 * to maintain — the classifier no longer needs to disambiguate "stale bond"
 * from "never paired" from "pair mode". Every BLE connect failure that
 * isn't an explicit user abort is now treated as transient: the reconnect
 * daemon picks it up and keeps trying.
 *
 * USB errors stay structured because they drive concrete recovery actions:
 *  - `device-in-use` (another tab holding the DAPLink) needs the user to
 *    close the other tab / replug — the banner's recovery ladder (`usb-recovery`)
 *    starts at the `replug` rung for it.
 *  - `device-disconnected` (USBDevice handle stale) needs a fresh
 *    `requestDevice()` from a user gesture — the ladder's `click` rung.
 *  - `transfer-transient` is recoverable by bouncing the connection and is
 *    handled by `usb.ts#runFlashWithTransferRetry` before bubbling up here.
 */

import { DeviceError } from '@microbit/microbit-connection';

export type BleErrorKind =
  | 'aborted'            // user cancelled the picker
  | 'transient'          // connect failed; daemon will retry
  | 'unsupported'        // no Web Bluetooth in this browser
  | 'unknown';           // surface raw message

export type UsbErrorKind =
  | 'transfer-transient' // bounce-and-retry territory
  | 'not-connected-yet'  // race: flash() before connect() resolved
  | 'device-in-use'      // another tab/process is holding the DAPLink
  | 'device-disconnected'// USBDevice handle is stale (post-disconnect race or unplug)
  | 'no-device'          // user dismissed the picker
  | 'unsupported'        // no WebUSB
  | 'unknown';

export interface ClassifiedBleError {
  kind: BleErrorKind;
  /** German user-facing message — what to show as `bleErrorMessage`. */
  userMessage: string;
}

export interface ClassifiedUsbError {
  kind: UsbErrorKind;
  userMessage: string;
}

export function classifyBleError(err: unknown): ClassifiedBleError {
  // Upstream lib's DeviceError gives us canonical codes — prefer those when
  // present so we don't second-guess the lib's classification.
  if (err instanceof DeviceError) {
    switch (err.code) {
      case 'no-device-selected':
      case 'aborted':
        return { kind: 'aborted', userMessage: '' };
      case 'unsupported':
        return {
          kind: 'unsupported',
          userMessage: 'Web Bluetooth wird in diesem Browser nicht unterstützt.',
        };
      // Everything else (including 'pairing-information-lost' and
      // 'permission-denied' which the lib used to emit on paired-mode
      // failures) is now a transient — the device is probably running a
      // hex without BLE, or just out of range. Daemon keeps trying.
    }
  }
  return {
    kind: 'transient',
    userMessage: 'Bluetooth-Verbindung fehlgeschlagen — wir versuchen es weiter.',
  };
}

export function classifyUsbError(err: unknown): ClassifiedUsbError {
  if (err instanceof DeviceError) {
    switch (err.code) {
      case 'no-device-selected':
      case 'aborted':
        return { kind: 'no-device', userMessage: '' };
      case 'unsupported':
        return { kind: 'unsupported', userMessage: 'WebUSB wird in diesem Browser nicht unterstützt.' };
      case 'device-in-use':
        return {
          kind: 'device-in-use',
          userMessage: 'Calliope wird gerade von einem anderen Tab oder Programm benutzt.',
        };
      case 'device-disconnected':
        return {
          kind: 'device-disconnected',
          userMessage: 'USB-Verbindung war kurz unterbrochen — bitte erneut verbinden.',
        };
    }
  }
  const msg = (err as Error)?.message ?? String(err ?? '');
  // Upstream's enrichedError sets DeviceError.code; the raw-string branches
  // here are a safety net in case the error slipped past enrichment.
  if (/Unable to claim interface/i.test(msg)) {
    return {
      kind: 'device-in-use',
      userMessage: 'Calliope wird gerade von einem anderen Tab oder Programm benutzt.',
    };
  }
  if (/device was disconnected/i.test(msg)) {
    return {
      kind: 'device-disconnected',
      userMessage: 'USB-Verbindung war kurz unterbrochen — bitte erneut verbinden.',
    };
  }
  if (
    /transferOut|transferIn/i.test(msg)
    && (/transfer error/i.test(msg) || /was cancelled|was canceled|aborted/i.test(msg))
  ) {
    return {
      kind: 'transfer-transient',
      userMessage: 'USB-Übertragung wiederholt fehlgeschlagen — bitte USB-Kabel kurz abziehen und neu einstecken.',
    };
  }
  // adi.disconnect's dap.close racing with the polling loop. Same recovery
  // path as a stale handle.
  if (/operation that changes the device state is in progress/i.test(msg)) {
    return {
      kind: 'device-disconnected',
      userMessage: 'USB-Verbindung war kurz unterbrochen — bitte erneut verbinden.',
    };
  }
  // Chrome refuses `requestDevice()` without a user gesture. Happens when an
  // OS-level USB disconnect wiped `usbDevice` and the daemon fell through to
  // the picker outside of a click handler.
  if (/Must be handling a user gesture/i.test(msg)) {
    return {
      kind: 'device-disconnected',
      userMessage: 'USB-Sitzung verloren — bitte erneut verbinden.',
    };
  }
  if (/Must be connected/i.test(msg) || /not connected/i.test(msg)) {
    return {
      kind: 'not-connected-yet',
      userMessage: 'USB-Verbindung noch nicht bereit — bitte einen Moment warten und erneut probieren.',
    };
  }
  return {
    kind: 'unknown',
    userMessage: msg || 'Unbekannter USB-Fehler.',
  };
}

/**
 * Heuristic: are we currently expecting the device to reboot (post-flash,
 * pairing-mode switch, DFU enter)? Used by transport status listeners to
 * decide whether a disconnect/transfer error should be surfaced as an
 * error or swallowed as expected churn.
 *
 * Callers set the flag via `markExpectedReboot()` before triggering the
 * device-side action, and the flag clears itself after `windowMs`.
 */
let expectedRebootUntil = 0;

export function markExpectedReboot(windowMs = 15_000): void {
  expectedRebootUntil = Date.now() + windowMs;
}

export function isExpectedRebootWindow(): boolean {
  return Date.now() < expectedRebootUntil;
}

export function clearExpectedReboot(): void {
  expectedRebootUntil = 0;
}

// ---- Mini 2 (J-Link) USB guidance -----------------------------------------

/** SEGGER J-Link OB vendor id — the interface chip on Calliope Mini 2 units
 *  that don't ship DAPLink. The standard CMSIS-DAP USB flash path (VID 0x0d28)
 *  can't drive it; the dedicated WebUSB transport lives in `segger-jlink.ts`
 *  and is not auto-routed (and is itself blocked on older J-Link OB firmware). */
export const SEGGER_JLINK_VENDOR_ID = 0x1366;

/** Shown when a Mini 2 J-Link device is the only thing present: rather than a
 *  raw CMSIS-DAP failure, point the user at the reliable download+drag route. */
export const MINI2_JLINK_USB_HINT =
  'Auf den Calliope mini 2 (J-Link) kann über den Standard-USB-Weg nicht übertragen werden. '
  + 'Bitte die .hex-Datei herunterladen und auf das Calliope-Laufwerk ziehen.';

/** Returns the Mini 2 J-Link hint for a 0x1366 device, else undefined. Hosts
 *  that learn the connected device's USB vendor id can use this to swap a
 *  confusing DAP error for actionable guidance. */
export function usbHintForVendorId(vendorId: number | undefined): string | undefined {
  return vendorId === SEGGER_JLINK_VENDOR_ID ? MINI2_JLINK_USB_HINT : undefined;
}
