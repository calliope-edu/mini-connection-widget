import { ConnectionStatus } from '@microbit/microbit-connection';
import { calliopeState, getState, updateState, SUPPORT } from './state';
import { appendLog } from './log';
import { awaitUsbPlugConfirm } from './usb-plug';
import { awaitConnectionChoice } from './connection-choice';
import { connectCalliope } from './connect';
import {
  flashCalliopeViaBle,
  flashCalliopeViaBleDfu,
  getBleConn,
  getBleConnection,
} from './ble';
import { flashCalliopeViaUsb, getUsbConn, primeBlocksRuntimeProbe } from './usb';
import {
  BluetoothPartialFlashDalMismatchError,
  BluetoothPartialFlashInvalidHexError,
  BluetoothPartialFlashServiceMissingError,
} from './ble-flash-web';
import { BluetoothDfuServiceMissingError } from './ble-dfu-web';
import { inspectHex, type HexFlavor } from './hex-inspect';
import { clearExpectedReboot, markExpectedReboot } from './connection-errors';

/**
 * If a pending flash sits unfulfilled for longer than this, clear it on the
 * next inspection. Prevents a stale request from a previous session firing
 * unexpectedly when the user finally connects.
 */
const PENDING_FLASH_TTL_MS = 60_000;

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
 *  4. **Nothing connected** → show the 3-way connection choice modal
 *     (Bluetooth / USB / Download hex). For 'ble' and 'usb' we set
 *     `pendingFlash` so the auto-resume hook below re-fires the flash once
 *     the user picks a device and the transport flips to connected.
 */
export async function flashCalliope(hex: string, name: string = 'project'): Promise<void> {
  let s = getState();
  if (s.status === 'flashing') {
    appendLog({
      direction: 'info',
      text: `Flash bereits aktiv — zusätzlicher Versuch ignoriert (${name}).`,
    });
    return;
  }

  // Classify the hex up front. MicroPython firmware can't be partial-flashed
  // (no MakeCode marker) — go straight to BLE-DFU or USB so the user doesn't
  // see the partial-flash failure flicker. Mirrors the iOS/Android apps,
  // which check the magic bytes before opening any GATT writes.
  const flavor: HexFlavor = inspectHex(hex).flavor;
  if (flavor === 'micropython') {
    appendLog({
      direction: 'info',
      text: `Hex erkannt als MicroPython — überspringe BLE-Partial-Flash.`,
    });
  }

  // Silent BLE reconnect: if BLE permission exists but BLE is currently
  // down (typical when post-flash auto-reconnect gave up just before the
  // device finished rebooting), try the cached browser permission once
  // before falling through to the connection-choice modal. Direct
  // `c.connect()` (not `connectCalliope`) so a failure stays quiet — if
  // it doesn't come back we just fall through to the regular dispatcher.
  if (
    SUPPORT.ble &&
    s.bleHasPermission &&
    !s.userDisconnectedBle &&
    s.bleStatus !== 'connected' &&
    s.bleStatus !== 'connecting' &&
    s.usbStatus !== 'connected'
  ) {
    appendLog({
      direction: 'info',
      text: `Flash requested but BLE not connected — trying silent reconnect with cached device`,
    });
    try {
      const c = await getBleConnection();
      updateState((st) => ({ ...st, bleStatus: 'connecting', bleErrorMessage: undefined }));
      await c.connect();
      updateState((st) => ({ ...st, bleHasPermission: true }));
      appendLog({ direction: 'info', text: 'Silent BLE reconnect succeeded' });
    } catch (err) {
      updateState((st) => ({ ...st, bleStatus: 'disconnected', bleErrorMessage: undefined }));
      appendLog({
        direction: 'info',
        text: `Silent BLE reconnect failed (${(err as Error)?.message ?? err}) — continuing to dispatcher`,
      });
    }
    s = getState();
  }

  // Remember whether BLE was connected pre-flash so we can re-establish it
  // automatically after the Calliope reboots into the new program. Without
  // this the editor stays disconnected after flashing and the user has to
  // click "Verbinden" again — annoying for the blocks-editor loop especially.
  const wasBleConnected = s.bleStatus === 'connected';

  // Either transport is connected? Clear any leftover pending flash —
  // we're about to handle the request live, no need for the auto-resume
  // hook to fire a duplicate.
  if (s.bleStatus === 'connected' || s.usbStatus === 'connected') {
    clearPendingFlash();
  }

  // Already stuck in DfuTarg from a previous interrupted DFU? Skip the
  // partial-flash attempt (there's no app running to host the CODAL
  // partial-flashing service) and go straight to a full BLE-DFU. The
  // bootloader's still advertising, the Nordic DFU service is up, and
  // a fresh CreateObject(Data) resets the in-progress object's CRC.
  if (s.bleStatus === 'connected' && s.bleSessionKind === 'dfu-bootloader') {
    appendLog({
      direction: 'info',
      text: 'Calliope ist noch im DFU-Bootloader (vorheriger Flash abgebrochen) — direkter Wiederaufnahme-Versuch.',
    });
    try {
      markExpectedReboot(45_000);
      await flashCalliopeViaBleDfu(hex, name);
      await scheduleBleReconnect();
      return;
    } catch (dfuErr) {
      appendLog({
        direction: 'info',
        text: `BLE-DFU-Wiederaufnahme fehlgeschlagen (${(dfuErr as Error)?.message ?? dfuErr}) — fallback auf USB.`,
      });
      // Drop through to USB / hybrid path below.
    }
  }

  // MicroPython firmware: no MakeCode marker → partial flash can't work.
  // Skip directly to BLE-DFU when BLE is connected (the iOS/Android apps
  // also route MicroPython through Nordic DFU), else USB.
  if (flavor === 'micropython' && s.bleStatus === 'connected') {
    try {
      markExpectedReboot(45_000);
      await flashCalliopeViaBleDfu(hex, name);
      await scheduleBleReconnect();
      return;
    } catch (dfuErr) {
      appendLog({
        direction: 'info',
        text: `BLE-DFU für MicroPython fehlgeschlagen (${(dfuErr as Error)?.message ?? dfuErr}) — fallback auf USB.`,
      });
      // Drop through to USB / hybrid path below.
    }
  }

  if (s.bleStatus === 'connected' && s.bleCanFlash && flavor !== 'micropython') {
    try {
      markExpectedReboot(20_000);
      await flashCalliopeViaBle(hex, name);
      await scheduleBleReconnect();
      return;
    } catch (err) {
      const partialUnusable =
        err instanceof BluetoothPartialFlashDalMismatchError ||
        err instanceof BluetoothPartialFlashServiceMissingError ||
        err instanceof BluetoothPartialFlashInvalidHexError;
      if (!partialUnusable) throw err;
      // Partial flash impossible — one of:
      //   - DAL hash mismatch (running runtime doesn't match the hex)
      //   - partial-flashing service isn't there at all (typical after a
      //     previous DFU left the device in a state where the application's
      //     GATT profile changed)
      //   - hex isn't MakeCode-shaped (e.g. MicroPython firmware images
      //     have no MakeCode marker, so partial flash refuses them)
      // Try a full BLE flash via Nordic DFU; iOS/Android do the same via
      // their native DFU lib.
      const reason = err instanceof BluetoothPartialFlashDalMismatchError
        ? 'DAL mismatch'
        : err instanceof BluetoothPartialFlashInvalidHexError
        ? 'no MakeCode marker (non-MakeCode hex)'
        : 'partial-flash service missing';
      appendLog({
        direction: 'info',
        text: `BLE partial flash impossible (${reason}) — trying full BLE-DFU flash.`,
      });
      try {
        markExpectedReboot(45_000);
        await flashCalliopeViaBleDfu(hex, name);
        await scheduleBleReconnect();
        return;
      } catch (dfuErr) {
        if (dfuErr instanceof BluetoothDfuServiceMissingError) {
          appendLog({
            direction: 'info',
            text: 'Calliope is not exposing the Nordic DFU service — falling back to USB.',
          });
        } else {
          appendLog({
            direction: 'info',
            text: `BLE-DFU flash failed (${(dfuErr as Error)?.message ?? dfuErr}) — falling back to USB.`,
          });
        }
        const sNow = getState();
        if (sNow.usbStatus === 'connected') {
          markExpectedReboot(20_000);
          await flashCalliopeViaUsb(hex, name);
          await primeBlocksRuntimeProbe();
          await scheduleBleReconnect();
          return;
        }
        if (SUPPORT.usb) {
          await flashCalliopeHybrid(hex, name);
          await scheduleBleReconnect();
          return;
        }
        updateState((st) => ({
          ...st,
          bleErrorMessage:
            'BLE-Flash fehlgeschlagen und kein USB verfügbar — bitte ein BLE-fähiges Programm aufspielen (A+B halten und Reset drücken, dann erneut versuchen).',
        }));
        return;
      }
    }
  }
  if (s.usbStatus === 'connected') {
    if (s.bleStatus === 'connected') {
      appendLog({
        direction: 'info',
        text: 'USB-Flash überschreibt das BLE-Pairing. Nach dem Flashen bitte erneut über BLE verbinden.',
      });
    }
    markExpectedReboot(20_000);
    await flashCalliopeViaUsb(hex, name);
    await primeBlocksRuntimeProbe();
    if (wasBleConnected) await scheduleBleReconnect();
    return;
  }
  if (s.bleStatus === 'connected' && !s.bleCanFlash) {
    // BLE is up but the partial-flash service isn't reachable (e.g. the
    // current hex is MicroPython firmware that doesn't expose it). The
    // dispatcher above already tried BLE-DFU and USB fallbacks; getting
    // here means none of those panned out.
    updateState((st) => ({
      ...st,
      bleErrorMessage:
        'Flashen über Bluetooth ist gerade nicht möglich — bitte per USB anschließen.',
    }));
    return;
  }
  // Nothing connected — let the user choose between Bluetooth, USB, and
  // saving the hex to disk. The first two set `pendingFlash` so the
  // auto-resume hook re-fires the flash once the transport is ready;
  // 'download' just hands the file to the browser and we're done.
  let choice: 'ble' | 'usb' | 'download';
  try {
    choice = await awaitConnectionChoice(name);
  } catch {
    appendLog({ direction: 'info', text: `Flash cancelled at connection-choice modal (${name})` });
    return;
  }
  switch (choice) {
    case 'ble': {
      setPendingFlash(hex, name);
      appendLog({ direction: 'info', text: `User chose BLE — opening picker, flash will resume after connect` });
      // Run the BLE connect in the user-gesture context that bubbled
      // from the choice click. `forceChooser=true` so the picker always
      // shows — we know nothing is connected here.
      await connectCalliope('ble', true);
      // Auto-resume runs from the state subscription once `bleStatus`
      // flips to 'connected'. If the user cancelled the picker the
      // status goes back to 'disconnected' and the pending flash
      // expires after PENDING_FLASH_TTL_MS.
      return;
    }
    case 'usb': {
      setPendingFlash(hex, name);
      appendLog({ direction: 'info', text: `User chose USB — opening picker, flash will resume after connect` });
      // The hybrid path covers both "USB cable not plugged in" and
      // "user needs to pick the DAPLink device" — same UX as before.
      await flashCalliopeHybrid(hex, name);
      // flashCalliopeHybrid runs the flash inline, so clear pending
      // and we're done. (We still set it above so a mid-flow disconnect
      // recovery — e.g. the user cancels the plug prompt then reconnects
      // USB later — could still resume; but the typical path completes
      // synchronously here.)
      clearPendingFlash();
      if (wasBleConnected) await scheduleBleReconnect();
      return;
    }
    case 'download': {
      appendLog({ direction: 'info', text: `User chose hex download (${name})` });
      downloadHexFile(hex, name);
      return;
    }
  }
}

// ---- Pending-flash plumbing -----------------------------------------------

function setPendingFlash(hex: string, name: string): void {
  updateState((st) => ({
    ...st,
    pendingFlash: { hex, name, createdAt: Date.now() },
  }));
}

function clearPendingFlash(): void {
  updateState((st) => (st.pendingFlash ? { ...st, pendingFlash: undefined } : st));
}

/**
 * Subscribe once at module load to transport-status changes. When a transport
 * flips into `connected` AND we have a fresh `pendingFlash`, re-fire the
 * flash. Prevents the user from having to click Download a second time
 * after the BLE/USB picker dance.
 *
 * Guards:
 *  - Only fires when *currently* not flashing (so an in-flight flash isn't
 *    disrupted by a transient status flicker).
 *  - Expires `pendingFlash` older than `PENDING_FLASH_TTL_MS` to avoid
 *    surprising the user with a request they no longer expect.
 *  - Uses `wasConnected` to fire only on the `disconnected→connected` (or
 *    `connecting→connected`) edge, not on every state mutation.
 */
let prevBleConnected = false;
let prevUsbConnected = false;
calliopeState.subscribe((s) => {
  const bleConnected = s.bleStatus === 'connected';
  const usbConnected = s.usbStatus === 'connected';
  const edge =
    (bleConnected && !prevBleConnected) ||
    (usbConnected && !prevUsbConnected);
  prevBleConnected = bleConnected;
  prevUsbConnected = usbConnected;
  if (!edge) return;
  const pending = s.pendingFlash;
  if (!pending) return;
  if (s.status === 'flashing') return;
  if (Date.now() - pending.createdAt > PENDING_FLASH_TTL_MS) {
    appendLog({
      direction: 'info',
      text: `Pending flash for "${pending.name}" expired — not resuming.`,
    });
    clearPendingFlash();
    return;
  }
  appendLog({
    direction: 'info',
    text: `Transport ${bleConnected ? 'BLE' : 'USB'} connected — auto-resuming pending flash "${pending.name}"`,
  });
  clearPendingFlash();
  // Fire-and-forget: the dispatcher handles its own errors. We don't
  // `await` here because we're inside a store subscription.
  flashCalliope(pending.hex, pending.name).catch((err) => {
    appendLog({
      direction: 'error',
      text: `Auto-resumed flash failed: ${(err as Error)?.message ?? err}`,
    });
  });
});

// ---- Hex download ---------------------------------------------------------

/**
 * Save the hex string to the user's downloads folder. Used by the
 * "Download .hex file" choice in the connection-choice modal — the user
 * then drags the file onto the Calliope's USB mass-storage drive (DAPLink)
 * to flash it manually.
 */
function downloadHexFile(hex: string, name: string): void {
  const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const fileName = safeName.endsWith('.hex') ? safeName : `${safeName}.hex`;
  const blob = new Blob([hex], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/**
 * After a successful flash, the Calliope reboots and the BLE GATT drops for
 * a few seconds. Retry with backoff so the user lands back in 'connected'
 * without having to click "Verbinden". Bypasses `connectCalliope` to avoid
 * triggering the stale-bond modal on transient reboot-window failures —
 * those are expected here and resolve on the next retry.
 *
 * Skipped when BLE has reconnected already (e.g. upstream's auto-reconnect
 * beat us to it during the flash flow).
 */
async function scheduleBleReconnect(): Promise<void> {
  if (!SUPPORT.ble) return;
  // Device reboot after partial flash can take several seconds; bond
  // re-establishment another moment on top. Retry with backoff until the
  // total budget elapses. Only short-circuit on a real `connected` state
  // — if upstream is stuck in `connecting`, our explicit retry is what
  // unsticks it.
  const delays = [1500, 2500, 3500, 5000, 7000];
  for (const delay of delays) {
    await new Promise((r) => setTimeout(r, delay));
    const s = getState();
    if (s.bleStatus === 'connected') return;
    appendLog({ direction: 'info', text: `Auto-reconnecting BLE after flash (delay ${delay}ms, status=${s.bleStatus})` });
    try {
      const c = await getBleConnection();
      await c.connect();
      updateState((st) => ({ ...st, bleHasPermission: true }));
      clearExpectedReboot();
      appendLog({ direction: 'info', text: 'Auto-reconnect succeeded' });
      return;
    } catch (err) {
      appendLog({
        direction: 'info',
        text: `Auto-reconnect attempt failed: ${(err as Error)?.message ?? err}`,
      });
    }
  }
  appendLog({ direction: 'info', text: 'Auto-reconnect gave up after retries' });
  clearExpectedReboot();
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
  markExpectedReboot(20_000);
  await flashCalliopeViaUsb(hex, name);
  await primeBlocksRuntimeProbe();
}
