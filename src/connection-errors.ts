/**
 * Classify low-level BLE/USB transport errors into actionable categories so
 * the UI shows a guided modal instead of a raw Chromium / WebUSB toast.
 *
 * The classifier is the single source of truth for mapping error strings to
 * a `BleErrorKind` / `UsbErrorKind`. Anywhere we catch a transport-level
 * error in widget code, route the message through here before storing it in
 * `bleErrorMessage` / `usbErrorMessage`.
 *
 * Mapping rationale (matches the iOS / Android Calliope apps' behaviour):
 *
 *  - `pairing-information-lost` / Web Bluetooth "GATT Server is disconnected"
 *    when we already had a bond: the device's whitelist was wiped (typical
 *    after USB full-flash). User must remove the OS bond and re-pair.
 *
 *  - "Connection attempt failed" / generic GATT disconnect when we never had
 *    a bond: the OS pairing prompt was dismissed, or pairing failed at the
 *    OS layer. User must pair via OS Bluetooth settings first.
 *
 *  - "transferOut" / "transferIn" / "transfer error" on USB: a stale WebUSB
 *    endpoint, recoverable by bouncing the connection. Handled in
 *    `usb.ts#runFlashWithTransferRetry` — don't surface as a hard error
 *    unless the retry also fails.
 *
 *  - "Must be connected" on USB flash: upstream lib's contract violation
 *    when `flash()` runs before `connect()` resolved. We retry once with
 *    a status-event wait in `usb.ts`; only surface as a hard error if the
 *    wait times out.
 *
 * Open-mode firmware caveat: when `state.bleSessionKind === 'bond-ok'` the
 * caller passes `authVerified: true`. The classifier then refuses to route
 * any error to the OS-pairing modal — partial-flash + UART being visible
 * means either we have a working bond OR the device runs in
 * `MICROBIT_BLE_OPEN=1` mode (no SMP gate at all), and in both cases pushing
 * the user toward Windows Bluetooth settings would be misleading. The error
 * is downgraded to `gatt-transient` so the UI surfaces it as a generic
 * "verbinden Sie erneut" rather than a pair-me instruction.
 */

import { DeviceError } from '@microbit/microbit-connection';

export type BleErrorKind =
  | 'stale-bond'         // had a bond, GATT now refuses — entkoppeln + neu pairen
  | 'pairing-missing'    // never paired — OS-Bluetooth-Einstellungen koppeln
  | 'gatt-transient'     // device just rebooted; reconnect in flight
  | 'aborted'            // user cancelled the picker
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
  /** Whether the OS-pairing modal should pop up alongside the message. */
  showPairingModal: boolean;
  /** Whether this should set `bleStaleBond` (drives the modal heading). */
  staleBond: boolean;
}

export interface ClassifiedUsbError {
  kind: UsbErrorKind;
  userMessage: string;
}

/**
 * Web Bluetooth's "GATT Server is disconnected" message (and variants) tend
 * to leak through whenever upstream tries to access a service on a stale
 * GATT handle. Match liberally — the text is canonical across Chrome
 * versions but spacing/punctuation may vary.
 */
const GATT_DISCONNECT_RE = /GATT Server is disconnected/i;
const CONNECTION_FAILED_RE = /Connection attempt failed|GATT operation failed|Failed to connect|NetworkError/i;
const SERVICE_NOT_FOUND_RE = /No Services matching UUID|Service is not in the device|getPrimaryService/i;
const SECURITY_ERR_RE = /security|encryption|authentication|insufficient/i;

export function classifyBleError(
  err: unknown,
  hadPaired: boolean,
  authVerified = false,
): ClassifiedBleError {
  // Upstream lib's DeviceError gives us canonical codes — prefer those when
  // present so we don't second-guess the lib's classification.
  if (err instanceof DeviceError) {
    switch (err.code) {
      case 'pairing-information-lost':
        // Open-mode firmware never emits this (there is no bond to lose), so
        // when authVerified is true we treat it as a generic transient instead
        // of pushing the user to OS pairing.
        if (authVerified) {
          return {
            kind: 'gatt-transient',
            userMessage: 'Bluetooth-Verbindung verloren — bitte erneut verbinden.',
            showPairingModal: false,
            staleBond: false,
          };
        }
        return {
          kind: 'stale-bond',
          userMessage: 'OS-Pairing veraltet — Calliope in den OS-Bluetooth-Einstellungen entkoppeln und neu pairen.',
          showPairingModal: true,
          staleBond: true,
        };
      case 'permission-denied':
        if (authVerified) {
          return {
            kind: 'gatt-transient',
            userMessage: 'Bluetooth-Verbindung verloren — bitte erneut verbinden.',
            showPairingModal: false,
            staleBond: false,
          };
        }
        return {
          kind: 'pairing-missing',
          userMessage: 'Bluetooth-Pairing fehlt: Calliope in den OS-Bluetooth-Einstellungen koppeln, oder per USB anschließen.',
          showPairingModal: true,
          staleBond: false,
        };
      case 'no-device-selected':
      case 'aborted':
        return { kind: 'aborted', userMessage: '', showPairingModal: false, staleBond: false };
      case 'unsupported':
        return {
          kind: 'unsupported',
          userMessage: 'Web Bluetooth wird in diesem Browser nicht unterstützt.',
          showPairingModal: false,
          staleBond: false,
        };
    }
  }
  const msg = (err as Error)?.message ?? String(err ?? '');
  // GATT disconnect mid-operation + had a bond before → stale bond. This is
  // the regressed-on-the-17th symptom the user reported: "GATT Server is
  // disconnected" instead of the bond-deletion modal.
  //
  // authVerified short-circuits all the paired-mode routing below: a
  // disconnect on a session we've already classified as bond-ok / open-mode
  // is just a transport hiccup, not a pairing problem.
  if (GATT_DISCONNECT_RE.test(msg) || SERVICE_NOT_FOUND_RE.test(msg)) {
    if (authVerified) {
      return {
        kind: 'gatt-transient',
        userMessage: 'Bluetooth-Verbindung verloren — bitte erneut verbinden.',
        showPairingModal: false,
        staleBond: false,
      };
    }
    if (hadPaired) {
      return {
        kind: 'stale-bond',
        userMessage: 'Bluetooth-Verbindung verloren — vermutlich altes Pairing. Calliope in den OS-Bluetooth-Einstellungen entkoppeln und neu pairen.',
        showPairingModal: true,
        staleBond: true,
      };
    }
    // No prior bond + GATT disconnect during initial setup → user needs to
    // pair via OS first. Same modal, different copy.
    return {
      kind: 'pairing-missing',
      userMessage: 'Bluetooth-Pairing fehlt: Calliope einmal in den OS-Bluetooth-Einstellungen koppeln, oder per USB anschließen.',
      showPairingModal: true,
      staleBond: false,
    };
  }
  // Generic "Connection attempt failed" — same routing as GATT disconnect.
  if (CONNECTION_FAILED_RE.test(msg)) {
    if (authVerified) {
      return {
        kind: 'gatt-transient',
        userMessage: 'Bluetooth-Verbindung fehlgeschlagen — bitte erneut verbinden.',
        showPairingModal: false,
        staleBond: false,
      };
    }
    if (hadPaired) {
      return {
        kind: 'stale-bond',
        userMessage: 'Bluetooth-Verbindung fehlgeschlagen — vermutlich altes Pairing. Calliope in den OS-Bluetooth-Einstellungen entkoppeln und neu pairen.',
        showPairingModal: true,
        staleBond: true,
      };
    }
    return {
      kind: 'pairing-missing',
      userMessage: 'Bluetooth-Verbindung fehlgeschlagen: Calliope einmal in den OS-Bluetooth-Einstellungen koppeln, oder per USB anschließen.',
      showPairingModal: true,
      staleBond: false,
    };
  }
  // Security/encryption errors are unambiguous stale-bond signals when we
  // had paired before. authVerified can't co-exist with a security error
  // (the bond-ok verdict was wrong if it does), so we still route it as
  // stale-bond — better to over-prompt than to silently fail flashing.
  if (SECURITY_ERR_RE.test(msg) && hadPaired) {
    return {
      kind: 'stale-bond',
      userMessage: 'Pairing-Schlüssel passt nicht mehr — Calliope in den OS-Bluetooth-Einstellungen entkoppeln und neu pairen.',
      showPairingModal: true,
      staleBond: true,
    };
  }
  return {
    kind: 'unknown',
    userMessage: msg || 'Unbekannter Bluetooth-Fehler.',
    showPairingModal: false,
    staleBond: false,
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
  // here are a safety net in case the error slipped past enrichment (e.g.
  // a transferOut error reclassified later in the pipeline).
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
      // Shown only if the caller already exhausted automatic retries (the
      // dispatcher in usb.ts) — so the action item is on the user, not "we'll
      // retry". Background-error usages silently log this kind without ever
      // surfacing the message.
      userMessage: 'USB-Übertragung wiederholt fehlgeschlagen — bitte USB-Kabel kurz abziehen und neu einstecken.',
    };
  }
  // adi.disconnect's dap.close racing with the polling loop. Same
  // recovery path as a stale handle — user clicks the modal's Retry
  // (inside a user gesture) and we wipe + reconnect cleanly.
  if (/operation that changes the device state is in progress/i.test(msg)) {
    return {
      kind: 'device-disconnected',
      userMessage: 'USB-Verbindung war kurz unterbrochen — bitte erneut verbinden.',
    };
  }
  // Chrome refuses `requestDevice()` without a user gesture. Happens
  // when an OS-level USB disconnect wiped `usbDevice` and upstream's
  // auto-reconnect fell through to the picker outside of a click
  // handler. Same modal-driven recovery — the Retry button IS a user
  // gesture, so requestDevice works from there.
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
