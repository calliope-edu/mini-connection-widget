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
import { showBleOfflineInfo } from './ble-offline-info';
import { isNativeMode } from './native-bridge';
import { nativeFlash } from './native-mode';

/**
 * Flash-dispatcher log. Routes through appendLog, which mirrors info/error to
 * the browser console in dev (see log.ts setLogConsoleMirror) — so the
 * dispatcher's routing + post-flash reconnect decisions are visible in DevTools
 * (they were previously panel-only, making "no autoreconnect" hard to diagnose).
 */
function flashLog(text: string): void {
  appendLog({ direction: 'info', text: `flash: ${text}` });
}

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
export interface FlashOptions {
  /**
   * Skip partial flash and go straight to full Nordic DFU. Set when flashing
   * the Blocks runtime, whose DAL hash collides with a pxt-calliope app so a
   * partial flash would corrupt it. Honored on both the web and native paths.
   */
  forceFullDfu?: boolean;
}

export async function flashCalliope(
  hex: string,
  name: string = 'project',
  preferredTransport?: CalliopeTransport,
  opts: FlashOptions = {},
): Promise<void> {
  if (isNativeMode()) {
    // Native host owns transport choice and reconnect, but we still tell it
    // when to force full DFU. `preferredTransport` is ignored — there's only
    // one path on mobile (BLE open-mode).
    return nativeFlash(hex, name, opts.forceFullDfu ?? false);
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
    await flashDispatch(hex, name, preferredTransport, opts);
  } finally {
    updateState((st) => ({ ...st, flashInProgress: false }));
  }
}

async function flashDispatch(
  hex: string,
  name: string,
  preferredTransport?: CalliopeTransport,
  opts: FlashOptions = {},
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
      return await flashOverBle(hex, name, flavor, s.bleSessionKind, opts.forceFullDfu);
    } finally {
      if (wasBleConnected) await scheduleBleReconnect();
    }
  }

  // ---- USB-first default --------------------------------------------------

  if (s.usbStatus === 'connected') {
    await flashCalliopeViaUsb(hex, name);
    // Mark the expected reboot AFTER the transfer completes, not before: the
    // device reboots once flashing finishes, and a large universal hex over a
    // slow DAPLink can take >20 s. Setting a fixed window at flash *start*
    // could expire mid-transfer, so the post-flash reboot disconnect would be
    // classified+surfaced as a spurious USB error toast. Anchoring the window
    // here covers the reboot regardless of how long the transfer took.
    markExpectedReboot(30_000);
    await primeBlocksRuntimeProbe();
    if (wasBleConnected) await scheduleBleReconnect();
    return;
  }

  // No USB. Try BLE.
  if (s.bleStatus === 'connected') {
    try {
      await flashOverBle(hex, name, flavor, s.bleSessionKind, opts.forceFullDfu);
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
      setPendingFlash(hex, name, 'ble', opts);
      appendLog({ direction: 'info', text: `User chose BLE — opening picker, flash will resume after connect` });
      await connectCalliope('ble', true);
      // Picker aborted / connect failed? `connectCalliope` returns without
      // leaving bleStatus in 'connecting'/'connected' (it sets 'disconnected'
      // on abort, 'error' on failure). Drop the pending flash we just set so
      // the auto-resume hook doesn't silently fire it on a later connect.
      const after = getState();
      if (after.bleStatus !== 'connecting' && after.bleStatus !== 'connected') {
        clearPendingFlash();
      }
      return;
    }
    case 'usb': {
      setPendingFlash(hex, name, 'usb', opts);
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
 * A BLE-DFU failure that happened *after* the device entered the bootloader
 * (i.e. it's parked in DfuTarg, "+" on the LED matrix) is resumable: the
 * Nordic bootloader keeps the in-progress object and a fresh Select/Create
 * resets its offset/CRC, so we can reconnect and resume on the same device
 * handle. We recognise these by the messages `ble-dfu-web` throws once it's
 * past `entering-bootloader` — a mid-stream GATT drop or a reconnect that
 * exhausted its backoff. A `BluetoothDfuServiceMissingError`, by contrast,
 * means the device never exposed a DFU service at all (never entered the
 * bootloader) — NOT resumable, let it escape so the dispatcher can fall back
 * to USB.
 */
function isResumableDfuError(err: unknown): boolean {
  if (err instanceof BluetoothDfuServiceMissingError) return false;
  const msg = (err as Error)?.message ?? '';
  return (
    /GATT disconnected mid-DFU/i.test(msg) ||
    /reconnect.*bootloader/i.test(msg) ||
    /bootloader.*reconnect/i.test(msg)
  );
}

/**
 * Flash via Nordic Secure DFU with a bounded resume-on-disconnect retry.
 *
 * The bare `flashCalliopeViaBleDfu` throws on any failure, and the dispatcher's
 * BLE-connected catch treats *every* throw as "BLE exhausted → open the USB
 * plug modal" (flashDispatch line ~187). That turned a recoverable mid-transfer
 * hiccup — the device sitting happily in DfuTarg, ready to resume — into a
 * dead-end USB dialog (reported symptoms #5 Blocks-DFU and #7 MicroPython-DFU:
 * "device enters DFU, first bytes transfer, then the USB modal appears").
 *
 * Here we keep the failure inside the BLE-DFU world: on a *resumable* error
 * (device still in the bootloader) we reconnect and resume via
 * `sessionKind: 'bootloader'`, up to `DFU_RESUME_ATTEMPTS` times, before the
 * error is allowed to escape to the dispatcher's USB fallback. The USB modal
 * becomes a genuine last resort, not the first reaction to a dropped link.
 */
const DFU_RESUME_ATTEMPTS = 2;

async function flashViaBleDfuWithResume(hex: string, name: string): Promise<void> {
  // First attempt: let the DFU path auto-detect whether the device is in the
  // app (buttonless-enter) or already in the bootloader.
  try {
    await flashCalliopeViaBleDfu(hex, name);
    return;
  } catch (err) {
    if (!isResumableDfuError(err)) throw err;
    appendLog({
      direction: 'info',
      text: `BLE-DFU interrupted (${(err as Error)?.message ?? err}) — device is in DFU mode, attempting to resume.`,
    });
  }

  // Retry: the device is parked in the bootloader. Skip the buttonless-enter
  // dance and resume the stream on the (reconnected) bootloader link.
  for (let attempt = 1; attempt <= DFU_RESUME_ATTEMPTS; attempt++) {
    markExpectedReboot(45_000);
    try {
      await flashCalliopeViaBleDfu(hex, name, 'bootloader');
      appendLog({ direction: 'info', text: `BLE-DFU resume succeeded (attempt ${attempt}).` });
      return;
    } catch (err) {
      const last = attempt === DFU_RESUME_ATTEMPTS;
      appendLog({
        direction: 'info',
        text: `BLE-DFU resume attempt ${attempt}/${DFU_RESUME_ATTEMPTS} failed (${(err as Error)?.message ?? err})${last || !isResumableDfuError(err) ? '' : ' — retrying'}.`,
      });
      // Stop early if the error is no longer a resumable in-bootloader drop
      // (e.g. the device left DFU mode), or we've used our attempts. The throw
      // propagates to the dispatcher, which then offers USB as a last resort.
      if (last || !isResumableDfuError(err)) throw err;
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
  forceFullDfu = false,
): Promise<void> {
  // Stuck in DfuTarg from a previous interrupted DFU? Skip partial flash
  // (no app to host the partial-flashing service) and go straight to DFU.
  if (sessionKind === 'dfu-bootloader') {
    appendLog({
      direction: 'info',
      text: 'Calliope ist im DFU-Bootloader — direkter BLE-DFU-Flash.',
    });
    markExpectedReboot(45_000);
    await flashViaBleDfuWithResume(hex, name);
    return;
  }

  // Caller demands full DFU (e.g. the Blocks runtime, whose DAL hash collides
  // with a pxt-calliope app so partial flash would corrupt it). Skip the
  // partial attempt entirely instead of relying on it to fail.
  if (forceFullDfu) {
    appendLog({ direction: 'info', text: 'Voll-DFU erzwungen — Partial-Flash übersprungen.' });
    markExpectedReboot(45_000);
    await flashViaBleDfuWithResume(hex, name);
    return;
  }

  // Device is currently running the Blocks/MbitMore runtime → force full DFU.
  //
  // Blocks, pxt-calliope (MakeCode) and codal-MicroPython are all built on the
  // same codal base, so they share the same DAL-region hash. The partial-flash
  // DAL check (`ble-flash-web` line ~611) therefore PASSES when flashing a
  // MakeCode/MicroPython hex onto a Blocks-running device even though the app
  // layout is incompatible. The partial flash then switches the device into
  // pairing mode and fails mid-stream; by that point the device sits in the
  // partial-flash bootloader where the Nordic-DFU fallback can't reach it, so
  // the flow dead-ends at the USB-plug modal (observed e2e 2026-06-02, Blocks→
  // MakeCode on Mini 3). A runtime change away from Blocks always needs a full
  // DFU — mirroring `forceFullDfu`, which already covers the reverse direction
  // (flashing *into* Blocks). `programType` is kept fresh by the probe in
  // program-type.ts and only ever reads 'blocks' for the Blocks runtime
  // (MakeCode/MicroPython read as 'unknown'), so MakeCode→MakeCode and
  // MicroPython→MicroPython partial flashes are unaffected.
  if (getState().programType === 'blocks') {
    appendLog({
      direction: 'info',
      text: 'Gerät läuft Blocks-Runtime — Laufzeitwechsel erfordert Voll-DFU (Partial-Flash übersprungen).',
    });
    markExpectedReboot(45_000);
    await flashViaBleDfuWithResume(hex, name);
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
    await flashViaBleDfuWithResume(hex, name);
  }
}

// ---- Pending-flash plumbing -----------------------------------------------

function setPendingFlash(
  hex: string,
  name: string,
  preferredTransport?: CalliopeTransport,
  opts: FlashOptions = {},
): void {
  updateState((st) => ({
    ...st,
    pendingFlash: { hex, name, createdAt: Date.now(), preferredTransport, forceFullDfu: opts.forceFullDfu },
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
  flashCalliope(pending.hex, pending.name, pending.preferredTransport, {
    forceFullDfu: pending.forceFullDfu,
  }).catch((err) => {
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
  flashLog(`Post-flash BLE auto-reconnect: ${delays.length}-attempt burst starting`);
  for (const delay of delays) {
    await new Promise((r) => setTimeout(r, delay));
    const s = getState();
    if (s.bleStatus === 'connected') { flashLog('Post-flash BLE already connected — reconnect burst done'); return; }
    if (s.userDisconnectedBle) return;       // user clicked Trennen mid-flash
    flashLog(`Auto-reconnecting BLE after flash (delay ${delay}ms, status=${s.bleStatus})`);
    try {
      const c = await getBleConnection();
      await c.connect();
      updateState((st) => ({ ...st, bleHasPermission: true }));
      clearExpectedReboot();
      flashLog('Auto-reconnect succeeded');
      return;
    } catch (err) {
      flashLog(`Auto-reconnect attempt failed: ${(err as Error)?.message ?? err}`);
    }
  }
  // The burst exhausted without reconnecting. BLE was up before the flash but
  // didn't come back — the freshly-flashed program almost certainly ships
  // without BLE (accepted limitations a/b/c: MakeCode on Mini 1, any Radio
  // program, or MicroPython on Mini 1/2). Tell the user how to get it back
  // instead of silently retrying forever in the background.
  const s = getState();
  if (s.bleStatus !== 'connected' && !s.userDisconnectedBle) {
    appendLog({
      direction: 'info',
      text: 'BLE did not return after flash — likely a program without BLE; prompting A+B+Reset.',
    });
    updateState((st) => ({
      ...st,
      bleErrorMessage:
        'Nach dem Flashen ist keine Bluetooth-Verbindung zurückgekommen. Wenn dein Programm kein Bluetooth einschaltet '
        + '(z. B. MakeCode auf Mini 1, ein Radio-Programm, oder MicroPython auf Mini 1/2), halte A+B gedrückt und drücke Reset, '
        + 'um Bluetooth wieder zu starten.',
    }));
    showBleOfflineInfo();
  } else {
    appendLog({ direction: 'info', text: 'Auto-reconnect post-flash burst done — handing off to daemon.' });
  }
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
  await flashCalliopeViaUsb(hex, name);
  // Anchor the reboot window after the transfer (see the USB-first branch):
  // a long flash must not let the window expire before the device reboots.
  markExpectedReboot(30_000);
  await primeBlocksRuntimeProbe();
}
