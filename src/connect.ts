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
import { showBlePairingInfo } from './pairing-info';
import { showUsbErrorInfo } from './usb-error-info';
import { classifyBleError, classifyUsbError } from './connection-errors';

/**
 * Connect to a Calliope on the chosen transport. Always tries the silent
 * resume path first — for BLE this means upstream's `connect()` re-using a
 * previously-permitted device. If a chooser would be needed, we wipe all
 * per-transport device info first so the popover doesn't lie about a stale
 * "paired" state while the picker is open.
 */
export async function connectCalliope(
  transport: CalliopeTransport = 'usb',
  forceChooser = false,
): Promise<void> {
  try {
    if (transport === 'ble') {
      if (!SUPPORT.ble) return;
      updateState((s) => ({ ...s, bleStatus: 'connecting', bleErrorMessage: undefined }));

      const c = await getBleConnection();
      if (forceChooser) {
        await c.clearDevice();
        updateState((s) => ({
          ...s,
          bleDeviceName: undefined,
          bleHasPaired: false,
          bleCanFlash: false,
          bleCanCommunicate: false,
          bleStaleBond: false,
        }));
      }
      // Use bondMode: 'application' so the lib bonds (if needed) and leaves
      // the device in app mode — not pairing mode. Flash() handles its own
      // pairing-mode switch when the time comes. Ignored on web; only the
      // native (Capacitor) path looks at this.
      //
      // On `MICROBIT_BLE_OPEN=1` firmware (rc07 campus-open) no bonding ever
      // happens regardless — every characteristic is SEC_OPEN, so bondMode
      // is effectively a no-op even on native.
      await c.connect({ bondMode: 'application' });
      // Reflect the just-paired state. On web `connect()` succeeds means the
      // browser now remembers the device.
      updateState((s) => ({ ...s, bleHasPaired: true }));
    } else {
      if (!SUPPORT.usb) return;
      updateState((s) => ({ ...s, usbStatus: 'connecting', usbErrorMessage: undefined }));
      const c = await getUsbConnection();
      if (forceChooser) {
        await c.clearDevice();
        updateState((s) => ({ ...s, usbDeviceName: undefined }));
      }
      await connectWithRetry(c);
    }
  } catch (err) {
    if (transport === 'ble') {
      const st = getState();
      const classified = classifyBleError(
        err,
        st.bleHasPaired,
        st.bleSessionKind === 'bond-ok' || st.bleAuthEverVerified,
      );
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
        bleStaleBond: classified.staleBond,
        bleErrorMessage: classified.userMessage,
      }));
      if (classified.showPairingModal) showBlePairingInfo();
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
    bleHasPaired: false,
    // Reset the sticky auth-verified flag — the user explicitly
    // forgetting the device implies they want the fresh-pair flow back.
    bleAuthEverVerified: false,
    bleCanFlash: false,
    bleCanCommunicate: false,
    bleStaleBond: false,
    // Drop the friendly name if USB isn't also holding the device.
    friendlyName: s.usbStatus === 'connected' ? s.friendlyName : undefined,
  }));
  appendLog({ direction: 'info', text: 'BLE device disconnected and forgotten.' });
}
