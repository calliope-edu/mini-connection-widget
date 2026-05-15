import { DeviceError } from '@microbit/microbit-connection';
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
    const code = err instanceof DeviceError ? err.code : '';
    if (code === 'no-device-selected' || code === 'aborted') {
      updateState((s) => transport === 'ble'
        ? { ...s, bleStatus: 'disconnected', bleErrorMessage: undefined }
        : { ...s, usbStatus: 'disconnected', usbErrorMessage: undefined });
      return;
    }
    if (transport === 'ble') {
      // Stale-bond heuristic: upstream only emits `pairing-information-lost`
      // on the native (Capacitor) path. On web, BLE connect failures after
      // the device-side whitelist was wiped (typical: a USB flash since
      // the last pairing) just surface as generic `connection-error` /
      // "Connection attempt failed" / "GATT Server is disconnected". If
      // the user has paired before, treat any non-user-abort connect
      // failure as a stale bond and walk them through re-pairing.
      const wasPaired = getState().bleHasPaired || code === 'pairing-information-lost';
      if (wasPaired) {
        appendLog({
          direction: 'info',
          text: `BLE connect failed after previous pairing — assuming stale bond (code=${code || 'none'}).`,
        });
        updateState((s) => ({
          ...s,
          bleStatus: 'error',
          bleStaleBond: true,
          bleErrorMessage: 'OS-Pairing veraltet — Calliope in den OS-Bluetooth-Einstellungen entkoppeln und neu pairen.',
        }));
        showBlePairingInfo();
        return;
      }
    }
    const message = (err as Error)?.message ?? String(err);
    updateState((s) => transport === 'ble'
      ? { ...s, bleStatus: 'error', bleErrorMessage: message }
      : { ...s, usbStatus: 'error', usbErrorMessage: message });
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
    bleCanFlash: false,
    bleCanCommunicate: false,
    bleStaleBond: false,
    // Drop the friendly name if USB isn't also holding the device.
    friendlyName: s.usbStatus === 'connected' ? s.friendlyName : undefined,
  }));
  appendLog({ direction: 'info', text: 'BLE device disconnected and forgotten.' });
}
