import { getState, updateState, SUPPORT, type CalliopeTransport } from './state';
import { appendLog } from './log';
import {
  forgetAllBleDevices,
  getBleConnection,
  disconnectBle,
} from './ble';
import {
  clearUsbConn,
  clearJlinkUsb,
  connectWithRetry,
  disconnectUsb,
  forgetAllUsbDevices,
  forgetOtherUsbDevices,
  getUsbConnection,
  requestCalliopeUsbDevice,
  isSeggerJLinkDevice,
  setJlinkUsbConnected,
} from './usb';
import { connectJLinkSerial, disconnectJLinkSerial, forgetJLinkSerialPorts } from './web-serial';
import { armUsbRecovery, escalateUsbRecovery } from './usb-recovery';
import { showBleOfflineInfo } from './ble-offline-info';
import { classifyBleError, classifyUsbError } from './connection-errors';
import { isNativeMode } from './native-bridge';
import { nativeConnect, nativeDisconnectAndForget } from './native-mode';

/** Reject with `label` if `p` hasn't settled within `ms`. The underlying
 *  promise keeps running; callers that move on must invalidate its effect
 *  (e.g. clearDevice) so a late resolve can't take hold. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

/**
 * Connect to a Calliope on the chosen transport. Always tries the silent
 * resume path first — for BLE this means upstream's `connect()` re-using a
 * previously-permitted device. If a chooser would be needed, we wipe all
 * per-transport device info first so the popover doesn't lie about a stale
 * "connected" state while the picker is open.
 *
 * `nameFilter` (BLE only) narrows the device chooser to a single Calliope by
 * its 5-letter friendly name — the widget UI derives it from the pairing
 * pattern the user draws, so only the matching `Calliope mini [name]` shows
 * up. Pass `undefined` (the default) to list every Calliope/micro:bit, which
 * is what dev mode does. Re-set on every call so a stale filter from a prior
 * connect never lingers.
 */
export async function connectCalliope(
  transport: CalliopeTransport = 'usb',
  forceChooser = false,
  nameFilter?: string,
): Promise<void> {
  if (isNativeMode()) {
    return nativeConnect(transport);
  }
  try {
    if (transport === 'ble') {
      if (!SUPPORT.ble) return;
      updateState((s) => ({
        ...s,
        bleStatus: 'connecting',
        bleErrorMessage: undefined,
        // User is explicitly asking for BLE — clear the "I disconnected on
        // purpose" flag so the reconnect daemon resumes work if this attempt
        // ever drops.
        userDisconnectedBle: false,
        // Show which mini is being connected (name + LED pattern) in the
        // connecting banner. Only set when a name filter (drawn pattern) is
        // known; cleared on resolve below.
        connectTargetName: nameFilter,
      }));

      const c = await getBleConnection();
      // Aim the chooser at one device by friendly name (from the drawn
      // pattern), or clear any prior filter when none was supplied — the
      // silent-reconnect daemon calls `c.connect()` directly and must not
      // inherit a stale filter. `setNameFilter` only affects the chooser:
      // a still-permitted device that matches is reused without a prompt.
      c.setNameFilter(nameFilter ?? '');
      if (forceChooser) {
        await c.clearDevice();
        updateState((s) => ({
          ...s,
          bleDeviceName: undefined,
          bleHasPermission: false,
          bleCanFlash: false,
          bleCanCommunicate: false,
        }));
      }

      // Fast switch: when reconnecting to a REMEMBERED device (no chooser), give
      // it only a short window. A gone/asleep saved device (the user switched
      // minis) must not block behind the full retry ladder — after the timeout
      // we forget it and reopen the picker, so switching is quick. A genuine
      // transient is caught by the picker-reconnect that follows.
      if (!forceChooser && getState().bleHasPermission) {
        const SAVED_RECONNECT_MS = 2500;
        try {
          await withTimeout(c.connect(), SAVED_RECONNECT_MS, 'ble-saved-reconnect-timeout');
          updateState((s) => ({ ...s, bleHasPermission: true, connectTargetName: undefined }));
          return;
        } catch (err) {
          if (getState().userDisconnectedBle) return; // user cancelled meanwhile
          const classified = classifyBleError(err);
          if (classified.kind === 'aborted') {
            updateState((s) => ({ ...s, bleStatus: 'disconnected', bleErrorMessage: undefined, connectTargetName: undefined }));
            return;
          }
          // Timed out or failed → the saved device isn't answering. Forget it so
          // the picker below lists all minis. clearDevice() also drops any late
          // resolve of the timed-out c.connect() against the now-forgotten
          // device, so we can't end up "connected" to the one we moved on from.
          appendLog({ direction: 'info', text: `Saved BLE device did not answer in ${SAVED_RECONNECT_MS}ms — forgetting and opening picker.` });
          try { await c.clearDevice(); } catch { /* ignore */ }
          await forgetAllBleDevices();
          updateState((s) => ({ ...s, bleDeviceName: undefined, bleHasPermission: false, bleCanFlash: false, bleCanCommunicate: false }));
        }
      }
      // Retry transient connect failures BEFORE surfacing the destructive
      // A+B+Reset offline modal — mirrors the USB connectWithRetry. A momentary
      // RF glitch / Windows-BT hiccup / device-asleep on a BLE-capable device
      // must not tell a child to A+B+Reset (which drops the running program
      // into the bootloader). The chooser (if any) ran inside the first
      // c.connect(); retries reuse the already-picked device — no re-prompt.
      const BLE_TRIES = 3;
      const BLE_BACKOFF_MS = [600, 1400];
      let lastErr: unknown;
      for (let i = 0; i < BLE_TRIES; i++) {
        try {
          await c.connect();
          // `connect()` returning means the browser now remembers the device
          // for this origin. Reflect that so the daemon and UI can decide
          // without re-querying getDevices().
          updateState((s) => ({ ...s, bleHasPermission: true, connectTargetName: undefined }));
          return;
        } catch (err) {
          const classified = classifyBleError(err);
          if (classified.kind === 'aborted') {
            // User cancelled the picker — not an error; don't retry or modal.
            updateState((s) => ({ ...s, bleStatus: 'disconnected', bleErrorMessage: undefined, connectTargetName: undefined }));
            return;
          }
          // User hit "Abbrechen / give up" mid-retry → stop quietly.
          if (getState().userDisconnectedBle) return;
          lastErr = err;
          appendLog({
            direction: 'info',
            text: `BLE connect attempt ${i + 1}/${BLE_TRIES} failed (kind=${classified.kind}): ${(err as Error)?.message ?? err}`,
          });
          if (i < BLE_TRIES - 1) {
            await new Promise((r) => setTimeout(r, BLE_BACKOFF_MS[Math.min(i, BLE_BACKOFF_MS.length - 1)]));
          }
        }
      }
      // Retries exhausted — now surface the error + recovery modal.
      if (getState().userDisconnectedBle) return;
      const classified = classifyBleError(lastErr);
      appendLog({
        direction: 'info',
        text: `BLE connect failed after ${BLE_TRIES} attempts (kind=${classified.kind}): ${(lastErr as Error)?.message ?? lastErr}`,
      });
      updateState((s) => ({ ...s, bleStatus: 'error', bleErrorMessage: classified.userMessage, connectTargetName: undefined }));
      if (classified.kind === 'transient') showBleOfflineInfo();
      return;
    } else {
      if (!SUPPORT.usb) return;

      // User-initiated connect only (silent auto-reconnect uses
      // tryAutoReconnectUsb, not this). Show the combined Calliope USB picker and
      // route by the picked device: a J-Link (Calliope mini 2) connects its CDC
      // serial over Web Serial; a DAPLink (mini 1/3) is left browser-authorized
      // so the CMSIS-DAP connect below reuses it with NO second picker.
      const picked = await requestCalliopeUsbDevice();
      if (picked === null) {
        // Picker dismissed — stay idle; don't fall through to the lib's own picker.
        updateState((s) => ({ ...s, usbStatus: 'disconnected', userDisconnectedUsb: false }));
        return;
      }
      if (isSeggerJLinkDevice(picked)) {
        // Picker 1 granted a J-Link — the mini 2 is flash-capable from THIS
        // moment, independent of the CDC serial below. Record it first so a
        // dismissed second picker still leaves a usable (flash-only)
        // connection instead of silently dropping everything.
        setJlinkUsbConnected();
        const serialOutcome = await connectJLinkSerial();
        if (serialOutcome === 'cancelled' || serialOutcome === 'failed') {
          appendLog({
            direction: 'info',
            text: 'mini 2 connected flash-only (CDC serial not added) — serial can be added later from the connection panel.',
          });
        }
        return;
      }

      // Prune any OTHER authorized Calliope so UseAnyAllowed deterministically
      // connects to the one the user just picked — this is what makes a single
      // "Verbinden" picker both connect AND switch devices (no separate
      // "forget"/"other device" button). The picked device keeps its grant, so
      // no replug is needed.
      await forgetOtherUsbDevices(picked);
      updateState((s) => ({
        ...s,
        usbStatus: 'connecting',
        usbErrorMessage: undefined,
        userDisconnectedUsb: false,
      }));
      // Arm the recovery ladder up front so its "please re-plug the mini" step
      // appears within a few seconds if the connect is slow — rather than the
      // banner sitting on "Verbinde…" for the lib's full ~10s/attempt timeout.
      // No-op if a connection is already fine / the ladder is already running.
      armUsbRecovery();
      const c = await getUsbConnection();
      if (forceChooser) {
        await c.clearDevice();
        updateState((s) => ({ ...s, usbDeviceName: undefined }));
      }
      // A single attempt: the recovery ladder ("Erneut verbinden") and the
      // background daemon ARE the retry mechanism, so we don't grind through
      // three ~10s timeouts before involving the user.
      await connectWithRetry(c, 1);
    }
  } catch (err) {
    if (transport === 'ble') {
      const classified = classifyBleError(err);
      if (classified.kind === 'aborted') {
        updateState((s) => ({ ...s, bleStatus: 'disconnected', bleErrorMessage: undefined, connectTargetName: undefined }));
        return;
      }
      appendLog({
        direction: 'info',
        text: `BLE connect failed (kind=${classified.kind}): ${(err as Error)?.message ?? err}`,
      });
      updateState((s) => ({
        ...s,
        bleStatus: 'error',
        bleErrorMessage: classified.userMessage,
      }));
      // Transient connect failures on a user-initiated attempt usually mean
      // the Calliope is running a non-BLE hex. Surface the offline-info
      // modal so the user gets numbered steps to recover (AB+Reset → DFU,
      // or plug in USB) instead of just a red error chip in the panel.
      if (classified.kind === 'transient') showBleOfflineInfo();
      return;
    }
    const classified = classifyUsbError(err);
    if (classified.kind === 'no-device') {
      updateState((s) => ({ ...s, usbStatus: 'disconnected', usbErrorMessage: undefined }));
      return;
    }
    updateState((s) => ({ ...s, usbStatus: 'error', usbErrorMessage: classified.userMessage }));
    // Raw Chromium messages like "Unable to claim interface" / "The device was
    // disconnected" mean nothing to a kid. Drive the light banner's recovery
    // ladder (Verbinden → USB neu einstecken → Seite neu laden) instead.
    if (classified.kind === 'device-in-use' || classified.kind === 'device-disconnected') {
      escalateUsbRecovery(classified.kind);
    }
  }
}

/**
 * Disconnect the given transport AND forget any browser-remembered device on
 * it. Next connect will always show a fresh picker. This is the unified
 * "Trennen" + "Anderen Calliope verbinden" action.
 *
 * Sets the corresponding `userDisconnectedX` flag so the reconnect daemon
 * stops trying — without this it would immediately reconnect to the device
 * we just forgot.
 */
/**
 * Plain, REVERSIBLE disconnect: close the transport but KEEP the browser's
 * device permission, so the next "Verbinden" re-attaches to the same
 * still-enumerated device from the UI — no picker, no physical replug.
 *
 * This is what the panel's "Trennen" button uses. It deliberately does NOT
 * call forget(): on a mini 3 the DAPLink sits at the micro:bit VID/PID, so
 * `forgetAllUsbDevices()` would revoke the WebUSB grant AND invalidate
 * Chromium's platform handle while the board is still on the bus — the next
 * open() then throws "The device was disconnected" until a hardware replug
 * (the reported bug). Forgetting is reserved for the explicit
 * "Anderen Calliope verbinden" / `disconnectAndForget` path.
 */
export async function disconnectUsbKeepPermission(): Promise<void> {
  if (isNativeMode()) return;
  await disconnectUsb();
  await disconnectJLinkSerial();
  clearUsbConn();
  clearJlinkUsb();
  updateState((s) => ({
    ...s,
    usbStatus: SUPPORT.usb ? 'disconnected' : 'unsupported',
    jlinkUsbStatus: 'disconnected',
    usbErrorMessage: undefined,
    // Stop the reconnect daemon from immediately re-attaching; the next
    // explicit "Verbinden" clears this. The permission is retained, so that
    // reconnect is silent (getDevices) — no picker.
    userDisconnectedUsb: true,
    friendlyName: s.bleStatus === 'connected' ? s.friendlyName : undefined,
  }));
  appendLog({ direction: 'info', text: 'USB disconnected (permission kept — reconnect from the UI).' });
}

export async function disconnectAndForget(transport: CalliopeTransport): Promise<void> {
  if (isNativeMode()) {
    return nativeDisconnectAndForget(transport);
  }
  if (transport === 'usb') {
    await disconnectUsb();
    await disconnectJLinkSerial();
    await forgetAllUsbDevices();
    await forgetJLinkSerialPorts();
    clearUsbConn();
    clearJlinkUsb();
    updateState((s) => ({
      ...s,
      usbStatus: SUPPORT.usb ? 'disconnected' : 'unsupported',
      jlinkUsbStatus: 'disconnected',
      usbDeviceName: undefined,
      usbErrorMessage: undefined,
      userDisconnectedUsb: true,
      // Drop the friendly name if BLE isn't also holding the device.
      friendlyName: s.bleStatus === 'connected' ? s.friendlyName : undefined,
    }));
    appendLog({ direction: 'info', text: 'USB device disconnected and forgotten.' });
    return;
  }
  await disconnectBle();
  await forgetAllBleDevices();
  updateState((s) => ({
    ...s,
    bleStatus: SUPPORT.ble ? 'disconnected' : 'unsupported',
    bleDeviceName: undefined,
    bleErrorMessage: undefined,
    bleHasPermission: false,
    bleCanFlash: false,
    bleCanCommunicate: false,
    userDisconnectedBle: true,
    // Drop the friendly name if USB isn't also holding the device.
    friendlyName: s.usbStatus === 'connected' ? s.friendlyName : undefined,
  }));
  appendLog({ direction: 'info', text: 'BLE device disconnected and forgotten.' });
}
