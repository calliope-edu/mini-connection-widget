import { getState, updateState, SUPPORT, type CalliopeTransport } from './state';
import { appendLog } from './log';
import {
  forgetAllBleDevices,
  getBleConnection,
  disconnectBle,
} from './ble';
import {
  clearUsbConn,
  connectWithRetry,
  disconnectUsb,
  forgetAllUsbDevices,
  getUsbConnection,
} from './usb';
import { showUsbErrorInfo } from './usb-error-info';
import { classifyBleError, classifyUsbError } from './connection-errors';

/**
 * Connect to a Calliope on the chosen transport. Always tries the silent
 * resume path first — for BLE this means upstream's `connect()` re-using a
 * previously-permitted device. If a chooser would be needed, we wipe all
 * per-transport device info first so the popover doesn't lie about a stale
 * "connected" state while the picker is open.
 */
export async function connectCalliope(
  transport: CalliopeTransport = 'usb',
  forceChooser = false,
): Promise<void> {
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
      }));

      const c = await getBleConnection();
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
      // With rc07-open firmware there's no SMP gate to negotiate — the
      // bondMode flag the Capacitor native plugin used to take is now a
      // no-op on every supported transport.
      await c.connect();
      // `connect()` returning means the browser now remembers the device
      // for this origin. Reflect that in state so the daemon and UI can
      // make decisions without re-querying getDevices().
      updateState((s) => ({ ...s, bleHasPermission: true }));
    } else {
      if (!SUPPORT.usb) return;
      updateState((s) => ({
        ...s,
        usbStatus: 'connecting',
        usbErrorMessage: undefined,
        userDisconnectedUsb: false,
      }));
      const c = await getUsbConnection();
      if (forceChooser) {
        await c.clearDevice();
        updateState((s) => ({ ...s, usbDeviceName: undefined }));
      }
      await connectWithRetry(c);
    }
  } catch (err) {
    if (transport === 'ble') {
      const classified = classifyBleError(err);
      if (classified.kind === 'aborted') {
        updateState((s) => ({ ...s, bleStatus: 'disconnected', bleErrorMessage: undefined }));
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
      return;
    }
    const classified = classifyUsbError(err);
    if (classified.kind === 'no-device') {
      updateState((s) => ({ ...s, usbStatus: 'disconnected', usbErrorMessage: undefined }));
      return;
    }
    updateState((s) => ({ ...s, usbStatus: 'error', usbErrorMessage: classified.userMessage }));
    // Raw Chromium messages like "Unable to claim interface" / "The device
    // was disconnected" mean nothing to a kid. Pop the recovery modal so
    // they get numbered steps + a one-click retry instead.
    if (classified.kind === 'device-in-use') {
      showUsbErrorInfo('in-use', (err as Error)?.message ?? String(err ?? ''));
    } else if (classified.kind === 'device-disconnected') {
      showUsbErrorInfo('disconnected', (err as Error)?.message ?? String(err ?? ''));
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
export async function disconnectAndForget(transport: CalliopeTransport): Promise<void> {
  if (transport === 'usb') {
    await disconnectUsb();
    await forgetAllUsbDevices();
    clearUsbConn();
    updateState((s) => ({
      ...s,
      usbStatus: SUPPORT.usb ? 'disconnected' : 'unsupported',
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
