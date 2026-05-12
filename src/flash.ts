import { ConnectionStatus } from '@microbit/microbit-connection';
import { getState, updateState, SUPPORT } from './state';
import { appendLog } from './log';
import { showBlePairingInfo } from './pairing-info';
import { awaitUsbPlugConfirm } from './usb-plug';
import { flashCalliopeViaBle } from './ble';
import { flashCalliopeViaUsb, getUsbConn } from './usb';
import { getBleConn } from './ble';
import { connectCalliope } from './connect';

/**
 * Top-level flash dispatcher. Auto-routes:
 *
 *  1. **BLE connected & OS-paired** (partial-flashing service reachable) →
 *     flash via BLE. Preferred whenever available because USB flash wipes
 *     the Calliope's bonding whitelist, silently breaking the OS pairing.
 *  2. **USB connected** → flash via USB. Logs a heads-up if BLE is also
 *     connected so the user knows BLE will need re-pairing afterwards.
 *  3. **BLE connected but no pairing** → surface the OS-pairing explainer
 *     plus a hint to plug in USB.
 *  4. **Nothing connected** → prompt for USB plug-in (hybrid path).
 */
export async function flashCalliope(hex: string, name: string = 'project'): Promise<void> {
  const s = getState();
  if (s.status === 'flashing') {
    appendLog({
      direction: 'info',
      text: `Flash bereits aktiv — zusätzlicher Versuch ignoriert (${name}).`,
    });
    return;
  }

  // Remember whether BLE was connected pre-flash so we can re-establish it
  // automatically after the Calliope reboots into the new program. Without
  // this the editor stays disconnected after flashing and the user has to
  // click "Verbinden" again — annoying for the blocks-editor loop especially.
  const wasBleConnected = s.bleStatus === 'connected';

  if (s.bleStatus === 'connected' && s.bleCanFlash) {
    await flashCalliopeViaBle(hex, name);
    await scheduleBleReconnect();
    return;
  }
  if (s.usbStatus === 'connected') {
    if (s.bleStatus === 'connected') {
      appendLog({
        direction: 'info',
        text: 'USB-Flash überschreibt das BLE-Pairing. Nach dem Flashen bitte erneut über BLE verbinden.',
      });
    }
    await flashCalliopeViaUsb(hex, name);
    if (wasBleConnected) await scheduleBleReconnect();
    return;
  }
  if (s.bleStatus === 'connected' && !s.bleCanFlash) {
    showBlePairingInfo();
    updateState((st) => ({
      ...st,
      bleErrorMessage:
        'Zum Flashen über Bluetooth muss der Calliope einmal im Betriebssystem gekoppelt werden — oder schließe ihn per USB an.',
    }));
    return;
  }
  if (SUPPORT.usb) {
    await flashCalliopeHybrid(hex, name);
    if (wasBleConnected) await scheduleBleReconnect();
    return;
  }
  await flashCalliopeViaUsb(hex, name);
  if (wasBleConnected) await scheduleBleReconnect();
}

/**
 * After a successful flash, the Calliope reboots and any BLE GATT it had
 * is gone for a few seconds. Wait briefly then attempt a silent reconnect
 * — same device, no chooser prompt — so the user lands back in a connected
 * state without having to click "Verbinden". Failure is non-fatal; the UI
 * reflects the state via the connect listener either way.
 *
 * Skipped when BLE was already reconnected in the meantime (e.g. the
 * upstream lib auto-reconnected during the flash flow).
 */
async function scheduleBleReconnect(): Promise<void> {
  if (!SUPPORT.ble) return;
  // Settle delay: longer than the typical app-mode reboot but short enough
  // that the user notices the reconnect rather than the gap.
  await new Promise((r) => setTimeout(r, 1200));
  const s = getState();
  if (s.bleStatus === 'connected' || s.bleStatus === 'connecting') return;
  appendLog({ direction: 'info', text: 'Auto-reconnecting BLE after flash' });
  try {
    await connectCalliope('ble');
  } catch (err) {
    appendLog({
      direction: 'info',
      text: `Auto-reconnect failed: ${(err as Error)?.message ?? err}`,
    });
  }
}

/**
 * Hybrid path: nothing is connected (or only BLE without pairing), but USB
 * is supported. Ask the user to plug in a cable, then flash via USB.
 */
async function flashCalliopeHybrid(hex: string, name: string): Promise<void> {
  if (!SUPPORT.usb) {
    updateState((s) => ({ ...s, usbStatus: 'error', usbErrorMessage: 'Hybrid mode needs WebUSB' }));
    return;
  }
  appendLog({ direction: 'info', text: `Hybrid flash: prompting for USB cable` });
  try {
    await awaitUsbPlugConfirm(name);
  } catch {
    appendLog({ direction: 'info', text: 'Hybrid flash cancelled by user' });
    return;
  }
  // If BLE is currently connected, the lib needs DAPLink to take over without
  // contention — drop BLE first so it doesn't fight for the device.
  const ble = getBleConn();
  if (ble?.status === ConnectionStatus.Connected) {
    try { await ble.disconnect(); } catch { /* ignore */ }
  }
  // Touch usb conn ref so the type checker sees we use it (lint-only).
  void getUsbConn;
  await flashCalliopeViaUsb(hex, name);
}
