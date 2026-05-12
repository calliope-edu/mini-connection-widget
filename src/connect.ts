import { DeviceError } from '@microbit/microbit-connection';
import { updateState, SUPPORT, type CalliopeTransport } from './state';
import { appendLog } from './log';
import {
  forgetAllBleDevices,
  getBleConnection,
  disconnectBle,
  tryConnectBlocksOnly,
  clearBlocksOnlyDevice,
} from './ble';
import {
  clearUsbConn,
  connectWithRetry,
  disconnectUsb,
  getUsbConnection,
} from './usb';

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
    if (code === 'pairing-information-lost' && transport === 'ble') {
      // OS bond is stale. Authenticated services (UART, partial-flashing)
      // are unreachable, but the unauthenticated MbitMore service often
      // still works. Try a bare-GATT blocks-only fallback before giving
      // up — this is what the iOS app does (it can still do Nordic DFU
      // and unauthenticated comms in the same situation).
      appendLog({
        direction: 'info',
        text: 'OS-Pairing stale, attempting blocks-only fallback',
      });
      const ok = await tryConnectBlocksOnly();
      if (ok) return;
      updateState((s) => ({
        ...s,
        bleStatus: 'error',
        bleStaleBond: true,
        bleErrorMessage: 'OS-Pairing veraltet — Calliope in den OS-Bluetooth-Einstellungen entkoppeln und neu pairen.',
      }));
      return;
    }
    // Unknown failure mode — but if the device looks reachable, blocks-only
    // may still work (e.g. some Calliopes refuse the upstream connect probe
    // even though their MbitMore service is up). Treat blocks-only as the
    // graceful degradation path for any BLE connect error.
    if (transport === 'ble') {
      const ok = await tryConnectBlocksOnly();
      if (ok) return;
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
    clearUsbConn();
    updateState((s) => ({
      ...s,
      usbStatus: SUPPORT.usb ? 'disconnected' : 'unsupported',
      usbDeviceName: undefined,
      usbErrorMessage: undefined,
    }));
    return;
  }
  await disconnectBle();
  clearBlocksOnlyDevice();
  await forgetAllBleDevices();
  updateState((s) => ({
    ...s,
    bleStatus: SUPPORT.ble ? 'disconnected' : 'unsupported',
    bleDeviceName: undefined,
    bleErrorMessage: undefined,
    bleHasPaired: false,
    bleCanFlash: false,
    bleCanCommunicate: false,
    bleCanBlocks: false,
    bleStaleBond: false,
  }));
  appendLog({ direction: 'info', text: 'BLE device disconnected and forgotten.' });
}
