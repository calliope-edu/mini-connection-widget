import { ConnectionStatus } from '@microbit/microbit-connection';
import { calliopeState, getState, updateState, SUPPORT, type CalliopeTransport } from './state';
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
import { isNativeMode } from './native-bridge';
import { nativeFlash } from './native-mode';

/**
 * If a pending flash sits unfulfilled for longer than this, clear it on the
 * next inspection. Prevents a stale request from a previous session firing
 * unexpectedly when the user finally connects.
 */
const PENDING_FLASH_TTL_MS = 60_000;

/**
 * Top-level flash dispatcher. USB-first routing by default — USB is faster
 * (~5-10 s vs ~115 s for BLE-DFU) and more reliable on Web Bluetooth.
 *
 * Order:
 *  1. **`preferredTransport === 'ble'`** — user explicitly picked BLE at
 *     the connection-choice modal. Honor it: try BLE partial → BLE-DFU,
 *     no automatic USB fallback (the user already saw the USB option and
 *     chose otherwise).
 *  2. **USB connected** → USB flash. Fastest. With open-mode firmware
 *     USB flash no longer breaks any BLE state, so no warning needed.
 *  3. **BLE connected and stuck in DfuTarg** → direct BLE-DFU.
 *  4. **BLE connected and can flash** → BLE partial → BLE-DFU → USB hybrid.
 *  5. **Nothing connected** → connection-choice modal.
 */
export async function flashCalliope(
  hex: string,
  name: string = 'project',
  preferredTransport?: CalliopeTransport,
): Promise<void> {
  if (isNativeMode()) {
    // Native host owns transport choice, partial-vs-DFU routing, and
    // reconnect. `preferredTransport` is currently ignored — there's only
    // one path on mobile (BLE open-mode).
    return nativeFlash(hex, name);
  }
  let s = getState();
  if (s.status === 'flashing' || s.flashInProgress) {
    appendLog({
      direction: 'info',
      text: `Flash bereits aktiv — zusätzlicher Versuch ignoriert (${name}).`,
    });
    return;
  }
  // Raise the outer gate immediately — anything that talks to USB / BLE
  // outside of the flash itself (heartbeats, blocks-runtime probes,
  // sendSerialLine callers) backs off while this is true. The inner
  // pause/resume on the serial-listener registry is still load-bearing
  // for the DAP sendQueue race, but it doesn't catch writes coming from
  // outside the registry.
  updateState((st) => ({ ...st, flashInProgress: true }));
  try {
    await flashDispatch(hex, name, preferredTransport);
  } finally {
    updateState((st) => ({ ...st, flashInProgress: false }));
  }
}

async function flashDispatch(
  hex: string,
  name: string,
  preferredTransport?: CalliopeTransport,
): Promise<void> {
  let s = getState();

  // Classify the hex up front. Used by flashOverBle for diagnostics only;
  // partial flash now supports BOTH MakeCode hexes (MAGIC_MARKER) AND
  // MicroPython hexes (addlayouttable.py layout-table magic) — see
  // parseMicroPythonHex in ble-flash-web.ts.
  const flavor: HexFlavor = inspectHex(hex).flavor;

  // Silent BLE reconnect: if BLE permission exists but BLE is currently
  // down (typical when post-flash auto-reconnect gave up just before the
  // device finished rebooting), try the cached browser permission once
  // before falling through to the connection-choice modal. Only attempt
  // when USB isn't already a better option — USB-first means we never
  // wake BLE just to flash if a USB cable is plugged in.
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
  // automatically after the Calliope reboots into the new program.
  const wasBleConnected = s.bleStatus === 'connected';

  // Either transport is connected? Clear any leftover pending flash —
  // we're about to handle the request live, no need for the auto-resume
  // hook to fire a duplicate.
  if (s.bleStatus === 'connected' || s.usbStatus === 'connected') {
    clearPendingFlash();
  }

  // ---- Explicit BLE choice -------------------------------------------------
  //
  // User picked BLE at the connection-choice modal. Don't second-guess that
  // by routing through USB; do the BLE path even if USB happens to also be
  // up. The fallback chain stays BLE-partial → BLE-DFU. If both fail we
  // surface an error rather than silently switching transports — the user
  // would expect a different UI prompt if we wanted to switch.
  if (preferredTransport === 'ble' && s.bleStatus === 'connected') {
    try {
      return await flashOverBle(hex, name, flavor, s.bleSessionKind);
    } finally {
      if (wasBleConnected) await scheduleBleReconnect();
    }
  }

  // ---- USB-first default --------------------------------------------------

  if (s.usbStatus === 'connected') {
    markExpectedReboot(20_000);
    await flashCalliopeViaUsb(hex, name);
    await primeBlocksRuntimeProbe();
    if (wasBleConnected) await scheduleBleReconnect();
    return;
  }

  // No USB. Try BLE.
  if (s.bleStatus === 'connected') {
    try {
      await flashOverBle(hex, name, flavor, s.bleSessionKind);
      if (wasBleConnected) await scheduleBleReconnect();
      return;
    } catch (err) {
      appendLog({
        direction: 'info',
        text: `BLE flash path exhausted (${(err as Error)?.message ?? err}) — trying USB hybrid.`,
      });
      if (SUPPORT.usb) {
        await flashCalliopeHybrid(hex, name);
        if (wasBleConnected) await scheduleBleReconnect();
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

  // Nothing connected — let the user choose between Bluetooth, USB, and
  // saving the hex to disk.
  let choice: 'ble' | 'usb' | 'download';
  try {
    choice = await awaitConnectionChoice(name);
  } catch {
    appendLog({ direction: 'info', text: `Flash cancelled at connection-choice modal (${name})` });
    return;
  }
  switch (choice) {
    case 'ble': {
      setPendingFlash(hex, name, 'ble');
      appendLog({ direction: 'info', text: `User chose BLE — opening picker, flash will resume after connect` });
      await connectCalliope('ble', true);
      return;
    }
    case 'usb': {
      setPendingFlash(hex, name, 'usb');
      appendLog({ direction: 'info', text: `User chose USB — opening picker, flash will resume after connect` });
      await flashCalliopeHybrid(hex, name);
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

/**
 * Run the full BLE flash sequence. Tries the right transport for the device's
 * current mode:
 *  - DfuTarg → direct BLE-DFU
 *  - Otherwise → partial flash (handles both MakeCode and MicroPython hexes
 *    via ble-flash-web.ts parseHexForPartialFlash), with BLE-DFU as the
 *    fallback on the three "partial flash impossible" errors.
 *
 * Throws when both BLE paths fail; the caller decides whether to fall back
 * to USB or surface the error.
 */
async function flashOverBle(
  hex: string,
  name: string,
  flavor: HexFlavor,
  sessionKind: ReturnType<typeof getState>['bleSessionKind'],
): Promise<void> {
  // Stuck in DfuTarg from a previous interrupted DFU? Skip partial flash
  // (no app to host the partial-flashing service) and go straight to DFU.
  if (sessionKind === 'dfu-bootloader') {
    appendLog({
      direction: 'info',
      text: 'Calliope ist im DFU-Bootloader — direkter BLE-DFU-Flash.',
    });
    markExpectedReboot(45_000);
    await flashCalliopeViaBleDfu(hex, name);
    return;
  }

  // Try partial flash first (fast path). The partial-flash parser now
  // accepts both MakeCode and MicroPython hex formats; MicroPython hexes
  // flash just the 24 KB filesystem region (~3-5 s) instead of the whole
  // ~330 KB app via Nordic DFU (~3 min).
  try {
    markExpectedReboot(30_000);
    await flashCalliopeViaBle(hex, name);
    return;
  } catch (err) {
    // Any partial-flash failure is potentially recoverable by Nordic DFU —
    // not just the three "partial-unusable by design" errors:
    //  - DAL mismatch / service missing / no MakeCode marker → expected;
    //    the runtime on the device doesn't match what partial flashing
    //    needs (e.g. different MicroPython version, post-DFU silent app).
    //  - Transient BLE errors at partial-flash entry → also recoverable;
    //    the DFU path re-establishes its own GATT through the buttonless
    //    DFU service, so a stale partial-flash GATT cache doesn't block
    //    the bootloader handshake. Observed empirically 2026-05-21 with
    //    `Bluetooth-Verbindung fehlgeschlagen` ~6 s after a fresh connect.
    const reason = err instanceof BluetoothPartialFlashDalMismatchError
      ? `DAL mismatch (${flavor === 'micropython' ? 'MicroPython runtime version changed' : 'incompatible runtime'})`
      : err instanceof BluetoothPartialFlashInvalidHexError
      ? 'hex has neither MakeCode nor MicroPython layout-table marker'
      : err instanceof BluetoothPartialFlashServiceMissingError
      ? 'partial-flash service missing'
      : `transient BLE error: ${(err as Error)?.message ?? err}`;
    appendLog({
      direction: 'info',
      text: `BLE partial flash failed (${reason}) — trying full BLE-DFU flash.`,
    });
    markExpectedReboot(45_000);
    await flashCalliopeViaBleDfu(hex, name);
  }
}

// ---- Pending-flash plumbing -----------------------------------------------

function setPendingFlash(hex: string, name: string, preferredTransport?: CalliopeTransport): void {
  updateState((st) => ({
    ...st,
    pendingFlash: { hex, name, createdAt: Date.now(), preferredTransport },
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
  // Honor the user's explicit transport choice if they made one, even when
  // the other transport happens to be available right now. Otherwise the
  // USB-first default takes over.
  appendLog({
    direction: 'info',
    text: `Transport ${bleConnected ? 'BLE' : 'USB'} connected — auto-resuming pending flash "${pending.name}"${pending.preferredTransport ? ` (user picked ${pending.preferredTransport})` : ''}`,
  });
  clearPendingFlash();
  flashCalliope(pending.hex, pending.name, pending.preferredTransport).catch((err) => {
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
 * After a successful flash the Calliope reboots and the BLE GATT drops for
 * a few seconds. Retry with backoff so the user lands back in 'connected'
 * without having to click "Verbinden". Bypasses `connectCalliope` to keep
 * the retry quiet — the reconnect daemon picks up after this tight burst
 * if it doesn't reconnect immediately.
 */
async function scheduleBleReconnect(): Promise<void> {
  if (!SUPPORT.ble) return;
  const delays = [1500, 2500, 3500, 5000, 7000];
  for (const delay of delays) {
    await new Promise((r) => setTimeout(r, delay));
    const s = getState();
    if (s.bleStatus === 'connected') return;
    if (s.userDisconnectedBle) return;       // user clicked Trennen mid-flash
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
  appendLog({ direction: 'info', text: 'Auto-reconnect post-flash burst done — handing off to daemon.' });
  clearExpectedReboot();
}

/**
 * Hybrid path: nothing is connected (or only BLE without flash capability),
 * but USB is supported. Ask the user to plug in a cable, then flash via USB.
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
  void getUsbConn;
  markExpectedReboot(20_000);
  await flashCalliopeViaUsb(hex, name);
  await primeBlocksRuntimeProbe();
}
