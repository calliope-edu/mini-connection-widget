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

/**
 * Every error the widget itself puts on screen, by what went wrong rather
 * than as a finished sentence: the UI turns `code` into text through the
 * `ConnectLabels` key `CONNECTION_ERROR_LABELS[code]` (German by default), so
 * a host's translation reaches these messages too.
 *
 * Codes are per transport (`calliopeState.usbError` / `bleError`) and finer
 * than the classifier's `kind` — `device-disconnected` alone has two wordings.
 */
export type ConnectionErrorCode =
  // ---- Bluetooth ----
  | 'ble-unsupported'            // no Web Bluetooth in this browser
  | 'ble-failed'                 // connect failed; the daemon keeps trying
  | 'ble-dfu-bootloader'         // device sits in the DFU bootloader
  | 'ble-runtime-mismatch'       // partial flash: runtime doesn't match the program
  | 'ble-no-partial-flashing'    // partial-flashing service missing
  | 'ble-hex-not-flashable'      // hex has no MakeCode marker
  | 'ble-flash-aborted'          // transfer cancelled
  | 'ble-flash-failed-no-usb'    // BLE flash failed, no WebUSB to fall back to
  | 'ble-needs-mini2'            // 32 KB hex refused for a mini 1
  | 'ble-not-back-after-flash'   // BLE didn't return after flashing
  | 'ble-unknown'                // raw error in `message`
  // ---- USB (DAPLink, mini 2 J-Link, mini 2 Web Serial) ----
  | 'usb-unsupported'            // no WebUSB in this browser
  | 'usb-device-in-use'          // another tab/process holds the DAPLink
  | 'usb-interrupted'            // stale USBDevice handle — reconnect
  | 'usb-session-lost'           // picker refused outside a user gesture
  | 'usb-transfer-failed'        // repeated transfer errors — replug
  | 'usb-not-ready'              // flash() before connect() resolved
  | 'usb-mini2-jlink'            // mini 2 J-Link: download + drag instead
  | 'usb-serial-unsupported'     // no Web Serial (mini 2 comms)
  | 'usb-unknown';               // raw error in `message`

export interface ConnectionError {
  code: ConnectionErrorCode;
  /** Text that arrives ready-made — a raw browser error the classifier
   *  doesn't recognise, or a native host's own (already localised) message.
   *  Shown verbatim instead of the code's label. */
  message?: string;
}

export interface ClassifiedBleError {
  kind: BleErrorKind;
  /** What to put into `calliopeState.bleError`; absent for `aborted`. */
  error?: ConnectionError;
}

export interface ClassifiedUsbError {
  kind: UsbErrorKind;
  /** What to put into `calliopeState.usbError`; absent for `no-device`. */
  error?: ConnectionError;
}

/** A widget-raised error: just the code, worded by the UI. */
export function connectionError(code: ConnectionErrorCode): ConnectionError {
  return { code };
}

/** A raw/native message on `transport`, shown as-is. Empty → `undefined`. */
export function connectionErrorMessage(
  transport: 'usb' | 'ble',
  message: string | undefined,
): ConnectionError | undefined {
  return message ? { code: transport === 'usb' ? 'usb-unknown' : 'ble-unknown', message } : undefined;
}

export function classifyBleError(err: unknown): ClassifiedBleError {
  // Upstream lib's DeviceError gives us canonical codes — prefer those when
  // present so we don't second-guess the lib's classification.
  if (err instanceof DeviceError) {
    switch (err.code) {
      case 'no-device-selected':
      case 'aborted':
        return { kind: 'aborted' };
      case 'unsupported':
        return { kind: 'unsupported', error: connectionError('ble-unsupported') };
      // Everything else (including 'pairing-information-lost' and
      // 'permission-denied' which the lib used to emit on paired-mode
      // failures) is now a transient — the device is probably running a
      // hex without BLE, or just out of range. Daemon keeps trying.
    }
  }
  return { kind: 'transient', error: connectionError('ble-failed') };
}

export function classifyUsbError(err: unknown): ClassifiedUsbError {
  if (err instanceof DeviceError) {
    switch (err.code) {
      case 'no-device-selected':
      case 'aborted':
        return { kind: 'no-device' };
      case 'unsupported':
        return { kind: 'unsupported', error: connectionError('usb-unsupported') };
      case 'device-in-use':
        return { kind: 'device-in-use', error: connectionError('usb-device-in-use') };
      case 'device-disconnected':
        return { kind: 'device-disconnected', error: connectionError('usb-interrupted') };
    }
  }
  const msg = (err as Error)?.message ?? String(err ?? '');
  // Upstream's enrichedError sets DeviceError.code; the raw-string branches
  // here are a safety net in case the error slipped past enrichment.
  if (/Unable to claim interface/i.test(msg)) {
    return { kind: 'device-in-use', error: connectionError('usb-device-in-use') };
  }
  if (/device was disconnected/i.test(msg)) {
    return { kind: 'device-disconnected', error: connectionError('usb-interrupted') };
  }
  if (
    /transferOut|transferIn/i.test(msg)
    && (/transfer error/i.test(msg) || /was cancelled|was canceled|aborted/i.test(msg))
  ) {
    return { kind: 'transfer-transient', error: connectionError('usb-transfer-failed') };
  }
  // adi.disconnect's dap.close racing with the polling loop. Same recovery
  // path as a stale handle.
  if (/operation that changes the device state is in progress/i.test(msg)) {
    return { kind: 'device-disconnected', error: connectionError('usb-interrupted') };
  }
  // Chrome refuses `requestDevice()` without a user gesture. Happens when an
  // OS-level USB disconnect wiped `usbDevice` and a connect outside of a click
  // handler fell through to the picker — and always in that case for the
  // DAPLink connection, whose own chooser is disabled (chooser-gate.ts).
  if (/Must be handling a user gesture/i.test(msg)) {
    return { kind: 'device-disconnected', error: connectionError('usb-session-lost') };
  }
  if (/Must be connected/i.test(msg) || /not connected/i.test(msg)) {
    return { kind: 'not-connected-yet', error: connectionError('usb-not-ready') };
  }
  // A raw browser message is all we have — shown as-is; without one, the
  // label's generic "unknown USB error".
  return { kind: 'unknown', error: connectionErrorMessage('usb', msg) ?? connectionError('usb-unknown') };
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

/** Returns the Mini 2 J-Link guidance (download + drag the .hex) for a 0x1366
 *  device, else undefined. Hosts that learn the connected device's USB vendor
 *  id can use this to swap a confusing DAP error for actionable guidance; the
 *  text is the `ConnectLabels` key for `usb-mini2-jlink`. */
export function usbHintForVendorId(vendorId: number | undefined): ConnectionError | undefined {
  return vendorId === SEGGER_JLINK_VENDOR_ID ? connectionError('usb-mini2-jlink') : undefined;
}
