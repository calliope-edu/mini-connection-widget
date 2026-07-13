import {
  ConnectionStatus,
  DeviceError,
  ProgressStage,
  type FlashDataSource,
  type ProgressCallback,
} from '@microbit/microbit-connection';
import {
  createUSBConnection,
  DeviceSelectionMode,
  type MicrobitUSBConnection,
} from '@microbit/microbit-connection/usb';
import {
  updateState,
  getState,
  SUPPORT,
  type CalliopeStatus,
} from './state';
import { appendLog } from './log';
import { detectCalliopeVersion, stripMakeCodeMetadata } from './helpers';
import { friendlyNameFromDeviceId } from './friendly-name';
import { startHeartbeat, stopHeartbeat } from './serial';
import { classifyUsbError, isExpectedRebootWindow, SEGGER_JLINK_VENDOR_ID } from './connection-errors';
import { escalateUsbRecovery } from './usb-recovery';
import { pauseJacdacExchange, resumeJacdacExchange, stopJacdacExchange } from './jacdac';
import { pauseBlocksDapExchange, resumeBlocksDapExchange, stopBlocksDapExchange, reinitBlocksDapAfterFlash } from './blocks-dap';

let usbConn: MicrobitUSBConnection | null = null;
let usbInitPromise: Promise<MicrobitUSBConnection> | null = null;
let rxBuffer = '';

/** Internal accessor — used by serial.ts/connect.ts/flash.ts. */
export function getUsbConn(): MicrobitUSBConnection | null { return usbConn; }
export function clearUsbConn(): void {
  usbConn = null;
  usbInitPromise = null;
  // Drop the registry along with the connection — the listeners were
  // attached to that specific MicrobitUSBConnection instance. A fresh
  // getUsbConnection() rebuilds the connection from scratch, and any
  // re-subscribers (comms feeds, scratch bridge) re-register through
  // registerSerialDataListener() on the new instance.
  serialListeners.clear();
  serialPaused = false;
  // The Jacdac + Blocks-DAP exchange loops were bound to that connection's
  // ArmDebug — stop them so a fresh connection re-scans rather than poking a
  // stale handle.
  stopJacdacExchange();
  stopBlocksDapExchange();
}

// ---------------------------------------------------------------------------
// Serial-data listener registry + pause/resume
// ---------------------------------------------------------------------------
//
// Upstream's `MicrobitUSBConnection` auto-starts a polling loop the moment
// it sees a `serialdata` listener (`eventActivated`), and only stops it
// when the last listener is removed (`eventDeactivated`). With a chatty
// Blocks/MbitMore runtime in the picture, that polling shares the DAP
// `sendQueue` with the flash control commands — and `adi.disconnect`'s
// `dap.close()` racing with an in-flight `transferOut(SERIAL_READ)` is
// what produces "operation that changes the device state is in progress"
// / "AbortError: transferOut was cancelled" mid-flash.
//
// To kill the race cleanly we funnel ALL serialdata subscriptions through
// this registry instead of `usb.addEventListener` directly. `pauseSerialDataPolling`
// then removes them all in one shot — upstream sees `hasSerialEventListeners()`
// become false and stops polling. We wait briefly for the in-flight read
// to drain, then run the flash on a quiet `sendQueue`. After the flash
// `resumeSerialDataPolling` re-attaches the registered handlers, which
// triggers `eventActivated` and starts polling again. Net effect: zero
// concurrent USB traffic during the flash window without changing any
// public subscriber APIs.
type SerialDataHandler = (ev: { data: string }) => void;

const serialListeners = new Set<SerialDataHandler>();
let serialPaused = false;

/**
 * Subscribe a serialdata handler. Replaces direct
 * `usbConn.addEventListener('serialdata', handler)` calls so the registry
 * can pause/resume polling at flash boundaries. Returns a teardown
 * function.
 */
export function registerSerialDataListener(handler: SerialDataHandler): () => void {
  serialListeners.add(handler);
  if (!serialPaused && usbConn) {
    usbConn.addEventListener('serialdata', handler);
  }
  return () => {
    serialListeners.delete(handler);
    if (usbConn) {
      try { usbConn.removeEventListener('serialdata', handler); } catch { /* ignore */ }
    }
  };
}

/**
 * Detach every registered serialdata handler from upstream. Upstream's
 * `eventDeactivated` fires when the last listener leaves and calls
 * `stopSerialInternal`, which sets `polling = false`. The currently
 * in-flight read (if any) still has to drain — so we sleep briefly
 * before returning. ~150 ms is comfortably more than the 1 ms
 * `serialDelay` upstream uses + one full DAP round-trip.
 *
 * Calling pause when already paused is a no-op. The waiting sleep still
 * runs so callers can rely on "after pause(), no serial polling is
 * happening for at least settleMs ms".
 */
export async function pauseSerialDataPolling(settleMs = 150): Promise<void> {
  if (!serialPaused) {
    serialPaused = true;
    if (usbConn) {
      for (const h of serialListeners) {
        try { usbConn.removeEventListener('serialdata', h); } catch { /* ignore */ }
      }
    }
  }
  // The Jacdac exchange loop is a separate consumer of the same DAP sendQueue,
  // untouched by detaching serial listeners — pause it too so the flash sees a
  // quiet bus. The loop parks at the top of its next iteration; the settle
  // sleep below covers its (at most one) in-flight op draining.
  pauseJacdacExchange();
  pauseBlocksDapExchange();
  await new Promise((r) => setTimeout(r, settleMs));
}

/**
 * Re-attach every registered serialdata handler. Upstream's
 * `eventActivated` fires when the first listener arrives and starts
 * polling again.
 */
export function resumeSerialDataPolling(): void {
  if (!serialPaused) return;
  serialPaused = false;
  resumeJacdacExchange();
  resumeBlocksDapExchange();
  if (!usbConn) return;
  for (const h of serialListeners) {
    try { usbConn.addEventListener('serialdata', h); } catch { /* ignore */ }
  }
}

/** Map upstream's PascalCase status enum onto our lowercase API. */
function mapStatus(s: ConnectionStatus): CalliopeStatus {
  switch (s) {
    case ConnectionStatus.NoAuthorizedDevice:
    case ConnectionStatus.Disconnected:
      return 'disconnected';
    case ConnectionStatus.Connecting:
      return 'connecting';
    case ConnectionStatus.Connected:
      return 'connected';
    case ConnectionStatus.Paused:
      // Tab-hidden — treat as disconnected from the UI's perspective. The
      // lib auto-reconnects when the tab becomes visible again.
      return 'disconnected';
    default:
      return 'unknown';
  }
}

/**
 * Translate upstream's `ProgressStage` (Initializing/FindingDevice/
 * CheckingBond/ResettingDevice/Connecting/PartialFlashing/FullFlashing) onto
 * our 5-state UI flash phase + 0–100% number.
 */
function applyFlashProgress(stage: ProgressStage, progress: number | undefined): void {
  if (stage === ProgressStage.Initializing || stage === ProgressStage.FindingDevice) {
    updateState((s) => ({ ...s, flashPhase: 'check', flashProgress: undefined }));
    return;
  }
  if (stage === ProgressStage.CheckingBond || stage === ProgressStage.ResettingDevice) {
    updateState((s) => ({ ...s, flashPhase: 'reboot', flashProgress: undefined }));
    return;
  }
  if (stage === ProgressStage.Connecting) {
    updateState((s) => ({ ...s, flashPhase: 'prepare', flashProgress: undefined }));
    return;
  }
  // PartialFlashing / FullFlashing — actual byte transfer with 0..1 progress.
  const intPct = progress === undefined ? undefined : Math.round(progress * 100);
  updateState((s) => ({
    ...s,
    flashPhase: 'flashing',
    flashProgress: intPct,
    flashPartial: stage === ProgressStage.PartialFlashing,
  }));
  if (intPct !== undefined) {
    appendLog({ direction: 'info', text: `Flash: ${intPct}%`, kind: 'flash-progress' });
  }
}

export async function getUsbConnection(): Promise<MicrobitUSBConnection> {
  if (usbConn) return usbConn;
  if (usbInitPromise) return usbInitPromise;
  if (typeof navigator === 'undefined' || !('usb' in navigator)) {
    updateState((s) => ({ ...s, usbStatus: 'unsupported' }));
    throw new DeviceError({ code: 'unsupported', message: 'WebUSB not supported in this browser' });
  }
  usbInitPromise = (async () => {
    const c = createUSBConnection({ deviceSelectionMode: DeviceSelectionMode.UseAnyAllowed });
    await c.initialize();
    // Exclude SEGGER J-Link OB (Calliope Mini 2 interface chip, VID 0x1366)
    // from the WebUSB picker AND the auto-attempt-on-load: the CMSIS-DAP /
    // DAPLink flash path can't drive a J-Link, so offering it here only yields
    // a confusing "Unable to claim interface"-style CMSIS-DAP failure. Mini 2
    // USB flashing goes through the dedicated segger-jlink transport instead.
    // (getFilteredAllowedDevices + chooseDevice both honor exclusionFilters.)
    c.setRequestDeviceExclusionFilters([{ vendorId: 0x1366 }]);
    c.addEventListener('status', (ev) => {
      const mapped = mapStatus(ev.status);
      const dev = c.getDevice();
      const pn = dev?.productName ?? undefined;
      // Hardware version over USB. Unlike BLE — which fingerprints the GATT
      // service set authoritatively (boardVersionFromServices) — the only
      // Calliope-specific signal DAPLink exposes here is the productName; a
      // mini 3 reports "Arm Calliope mini V3 CMSIS-DAP". When the name carries
      // a version digit we trust it (V3 ⇒ mini 3). Otherwise any device that
      // still connects over this CMSIS-DAP path is a legacy Calliope, so once
      // connected we default to V1 — the safe bet: it picks the DAL Blocks
      // runtime and trips the editor's "mini 3 only" gate rather than leaving
      // the version unknown (which BLE never does). A mini 2's SEGGER J-Link
      // interface (VID 0x1366) is excluded from this transport and flashes via
      // segger-jlink.ts, so it can't reach this handler — the vendorId branch
      // only matters if that exclusion is ever lifted.
      let cv = detectCalliopeVersion(pn, undefined);
      if (!cv && mapped === 'connected') {
        cv = dev?.vendorId === SEGGER_JLINK_VENDOR_ID ? 'V2' : 'V1';
      }
      // FICR.DEVICEID[1] from DAPLink — same number the firmware feeds
      // into `microbit_friendly_name`. Throws when not yet connected, so
      // we only attempt it on the connected transition.
      let friendly: string | undefined;
      if (mapped === 'connected') {
        try {
          const id = c.getDeviceId();
          if (typeof id === 'number' && id !== 0) {
            friendly = friendlyNameFromDeviceId(id);
          }
        } catch { /* not-connected race — leave undefined */ }
      }
      updateState((s) => {
        if (s.flashTransport === 'usb' && mapped !== 'connected') return s;
        return {
          ...s,
          usbStatus: mapped,
          usbDeviceName: mapped === 'connected'
            ? (pn ?? s.usbDeviceName ?? 'Calliope mini (USB)')
            : s.usbDeviceName,
          usbErrorMessage: mapped === 'connected' ? undefined : s.usbErrorMessage,
          calliopeVersion: cv ?? s.calliopeVersion,
          friendlyName: friendly ?? s.friendlyName,
          connectedAt: mapped === 'connected' ? Date.now() : s.connectedAt,
        };
      });
      if (mapped === 'connected') {
        startHeartbeat();
        appendLog({ direction: 'info', text: 'Connected (USB)' });
      } else {
        if (getState().bleStatus !== 'connected') stopHeartbeat();
        if (mapped === 'disconnected') appendLog({ direction: 'info', text: 'Disconnected (USB)' });
      }
    });
    c.addEventListener('backgrounderror', (ev) => {
      const msg = ev.error.message;
      // Reboots, pairing-mode entries and DFU triggers all cause expected
      // USB transferOut errors. Log to comms but don't surface a toast —
      // the retry path in `runFlashWithTransferRetry` or the natural
      // reconnect handles recovery.
      if (isExpectedRebootWindow()) {
        appendLog({ direction: 'info', text: `USB background (expected reboot): ${msg}` });
        return;
      }
      const classified = classifyUsbError(ev.error);
      // 'transfer-transient' errors are still in flight for retry in the
      // flash dispatcher — surface as info only.
      if (classified.kind === 'transfer-transient') {
        appendLog({ direction: 'info', text: `USB transient: ${msg}` });
        return;
      }
      updateState((s) => ({
        ...s,
        usbStatus: 'error',
        usbErrorMessage: classified.userMessage,
        flashProgress: s.flashTransport === 'usb' ? undefined : s.flashProgress,
      }));
      appendLog({ direction: 'error', text: msg });
    });
    usbConn = c;
    // Wire the rxBuffer line parser through the registry so it gets
    // detached during flash pause along with every other subscriber.
    // `usbConn` must already be set when registerSerialDataListener
    // tries to attach to the connection.
    registerSerialDataListener((data) => {
      // `SerialData.data` is a string chunk of bytes. Buffer at the emitter
      // and emit whole lines.
      rxBuffer += data.data;
      let idx: number;
      while ((idx = rxBuffer.indexOf('\n')) >= 0) {
        const line = rxBuffer.slice(0, idx).replace(/\r$/, '');
        rxBuffer = rxBuffer.slice(idx + 1);
        if (line) appendLog({ direction: 'rx', text: line });
      }
    });
    return c;
  })();
  return usbInitPromise;
}

export async function connectWithRetry(c: MicrobitUSBConnection, tries = 3): Promise<void> {
  let lastErr: unknown;
  // Settle delays: { 500ms, 1200ms, 2000ms }. The Windows kernel often
  // needs ~1.5 s to fully release the DAPLink endpoint after a previous
  // disconnect; coming back faster than that hits the same stale handle.
  // `device-disconnected` cases get an extra bump (doubles the next wait)
  // because that's the kernel-release race specifically.
  const baseSettleMs = [500, 1200, 2000];
  for (let i = 0; i < tries; i++) {
    try {
      await c.connect();
      return;
    } catch (err) {
      lastErr = err;
      const code = err instanceof DeviceError ? err.code : '';
      if (code === 'no-device-selected' || code === 'aborted' || code === 'unsupported') throw err;
      // Another tab/process holds the DAPLink — retrying immediately would
      // just hit the same lock. Surface the recovery modal and stop.
      if (code === 'device-in-use') throw err;
      appendLog({ direction: 'info', text: `Connect attempt ${i + 1} failed: ${(err as Error).message}` });
      const base = baseSettleMs[Math.min(i, baseSettleMs.length - 1)];
      const settleMs = code === 'device-disconnected' ? base * 2 : base;
      await new Promise((r) => setTimeout(r, settleMs));
    }
  }
  throw lastErr;
}

/**
 * Wait until the USB connection actually reports `Connected`. Upstream
 * `c.connect()` resolves before the status event fires, so calling
 * `c.flash()` immediately after triggers "Must be connected now". Poll the
 * status field with a short interval — once the lib settles into Connected,
 * resolve. If `timeoutMs` elapses, resolve anyway and let the caller try
 * (the lib's own error will surface).
 */
async function waitForUsbConnected(c: MicrobitUSBConnection, timeoutMs = 2_000): Promise<void> {
  const isConnected = (): boolean => (c.status as ConnectionStatus) === ConnectionStatus.Connected;
  if (isConnected()) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (isConnected()) return;
  }
}

export async function flashCalliopeViaUsb(hex: string, name: string): Promise<void> {
  if (!SUPPORT.usb) {
    updateState((s) => ({ ...s, usbStatus: 'error', usbErrorMessage: 'WebUSB not supported — flashing requires USB' }));
    return;
  }
  let c: MicrobitUSBConnection;
  try {
    c = await getUsbConnection();
  } catch (err) {
    updateState((s) => ({ ...s, usbStatus: 'error', usbErrorMessage: (err as Error).message }));
    return;
  }
  if (c.status !== ConnectionStatus.Connected) {
    try {
      await connectWithRetry(c);
    } catch (err) {
      const classified = classifyUsbError(err);
      if (classified.kind === 'no-device') {
        updateState((s) => ({ ...s, usbStatus: 'disconnected' }));
        return;
      }
      updateState((s) => ({ ...s, usbStatus: 'error', usbErrorMessage: classified.userMessage }));
      if (classified.kind === 'device-in-use' || classified.kind === 'device-disconnected') {
        escalateUsbRecovery(classified.kind);
      }
      return;
    }
  }
  // `c.connect()` resolves before the lib's internal status flips to
  // Connected. Calling flash() in that window yields "Must be connected now".
  // Wait for the status to actually settle.
  await waitForUsbConnected(c);

  updateState((s) => ({
    ...s,
    flashTransport: 'usb',
    flashProgress: 0,
    flashPhase: 'check',
    flashPartial: undefined,
    usbErrorMessage: undefined,
    lastFlashName: name,
  }));

  const cleanHex = stripMakeCodeMetadata(hex);
  appendLog({
    direction: 'info',
    text: `Flashing via USB "${name}" (${Math.round(cleanHex.length / 1024)} KB)`,
  });

  // Upstream's `FlashDataSource` is `(boardVersion) => Promise<string|Uint8Array>`.
  // MakeCode's universal hex already targets both V1 and V2, so we ignore
  // boardVersion and always return the same hex.
  const dataSource: FlashDataSource = async () => cleanHex;
  const progress: ProgressCallback = applyFlashProgress;

  // Pull every serialdata subscriber off the connection before flashing.
  // Without this the polling loop keeps the DAP sendQueue busy and races
  // adi.disconnect's dap.close → "operation that changes the device state
  // is in progress" / cancelled-transferOut. The pause sleeps long enough
  // for the in-flight read to finish draining, so flash sees a quiet bus.
  appendLog({ direction: 'info', text: 'Pausing serial polling for flash' });
  await pauseSerialDataPolling();

  try {
    await runFlashWithTransferRetry(c, dataSource, progress);
    updateState((s) => ({
      ...s,
      flashTransport: undefined,
      flashProgress: undefined,
      flashPhase: undefined,
      flashPartial: undefined,
      lastFlashAt: Date.now(),
    }));
    appendLog({ direction: 'info', text: `Flash finished: ${name}` });
    // USB connection persists across flash (the lib reinitialises serial
    // automatically) — no manual reconnect needed.
  } catch (err) {
    const classified = classifyUsbError(err);
    updateState((s) => ({
      ...s,
      flashTransport: undefined,
      usbStatus: 'error',
      usbErrorMessage: classified.userMessage,
      flashProgress: undefined,
      flashPhase: undefined,
    }));
    appendLog({ direction: 'error', text: `Flash failed: ${(err as Error).message}` });
    // Mirror the connect-path routing: drive the banner's recovery ladder. The
    // "Verbinden" rung is a real user gesture, so it can run `requestDevice` if
    // the session was wiped.
    if (classified.kind === 'device-in-use' || classified.kind === 'device-disconnected') {
      escalateUsbRecovery(classified.kind);
    }
  } finally {
    // Re-attach every subscriber. Upstream's eventActivated fires on the
    // first listener and starts polling again. Safe to call even when
    // the connection was wiped — `usbConn` may now be null and resume
    // becomes a no-op; the next getUsbConnection() will replay the
    // subscriptions via registerSerialDataListener.
    resumeSerialDataPolling();
    // The flash reset the target, so ArmDebug's cached SWD state is stale: force
    // the next Blocks-DAP scan to reinit the debug session rather than resume on
    // the pre-flash mailbox / stale cache (else "exchange buffer not found" until
    // a full reconnect).
    reinitBlocksDapAfterFlash();
    appendLog({ direction: 'info', text: 'Serial polling resumed' });
  }
}

/**
 * WebUSB throws several recoverable error variants mid-flash:
 *
 *  - "Failed to execute 'transferOut' on 'USBDevice': A transfer error
 *    has occurred" — stale endpoint state on the host side.
 *  - "Failed to execute 'transferOut' on 'USBDevice': The transfer was
 *    cancelled" (AbortError) — pending USB transfer aborted because the
 *    transport was closed mid-flight by upstream's own
 *    `withEnrichedErrors` disconnect.
 *  - "Failed to execute 'close' on 'USBDevice': An operation that
 *    changes the device state is in progress" — adi.disconnect's
 *    dap.close races with an in-flight transferOut from the polling
 *    loop (the chatty-runtime case).
 *
 * Recovery: up to 3 attempts with backoff (800ms, 1500ms, 2500ms).
 * Windows USB sometimes needs multiple settle windows on back-to-back
 * transients. Bails early when upstream's `usbDevice` is gone — that
 * means the OS fired `usb.disconnect` and any reconnect needs a user
 * gesture, which we don't have inside a flash() callback. The surrounding
 * modal handles that case.
 */
const TRANSFER_RETRY_SETTLE_MS = [800, 1500, 2500];

async function runFlashWithTransferRetry(
  c: MicrobitUSBConnection,
  dataSource: FlashDataSource,
  progress: ProgressCallback,
): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= TRANSFER_RETRY_SETTLE_MS.length; attempt++) {
    try {
      if (attempt > 0) {
        // Reset the UI flash phase between attempts so the progress bar
        // doesn't jump backwards visually.
        updateState((s) => ({ ...s, flashPhase: 'check', flashProgress: undefined }));
      }
      await c.flash(dataSource, { partial: true, progress, minimumProgressIncrement: 0.05 });
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientUsbTransferError(err)) throw err;
      // If upstream's `usb.disconnect` event fired, `getDevice()` returns
      // undefined and a reconnect would need a user gesture. Bail out and
      // let the surrounding modal handle it.
      if (!c.getDevice()) throw err;
      if (attempt >= TRANSFER_RETRY_SETTLE_MS.length) {
        // Exhausted retries — propagate the last error.
        throw err;
      }
      const settleMs = TRANSFER_RETRY_SETTLE_MS[attempt];
      appendLog({
        direction: 'info',
        text: `USB transfer error #${attempt + 1} (${(err as Error).message}) — bouncing connection (settle ${settleMs}ms) and retrying`,
      });
      try {
        await c.disconnect();
      } catch { /* ignore — we're about to reconnect anyway */ }
      await new Promise((r) => setTimeout(r, settleMs));
      try {
        await c.connect();
      } catch (reconnectErr) {
        throw new Error(
          `USB transfer error; reconnect failed: ${(reconnectErr as Error).message}`,
        );
      }
      // `c.connect()` returns before status flips to Connected. Without
      // the wait, flash() throws "Must be connected now".
      await waitForUsbConnected(c);
    }
  }
  throw lastErr ?? new Error('USB flash failed after retries');
}

/**
 * Match the WebUSB transfer errors we know are recoverable by bouncing
 * the connection. Three families:
 *
 *  - "transferOut|transferIn: A transfer error has occurred" — stale
 *    endpoint state.
 *  - "transferOut|transferIn: The transfer was cancelled" (AbortError)
 *    — transport closed mid-flight, typically by upstream's own
 *    `withEnrichedErrors` disconnect after a stale DAP response.
 *  - "close: An operation that changes the device state is in progress"
 *    — adi.disconnect's dap.close races with an in-flight transferOut
 *    from the polling loop while a chatty runtime is streaming serial.
 *
 * Other USB errors (device unplugged, permission revoked, no DAPLink)
 * need user attention and stay non-recoverable.
 */
function isTransientUsbTransferError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  const name = (err as Error)?.name ?? '';
  if (/operation that changes the device state is in progress/i.test(msg)) return true;
  if (!/transferOut|transferIn/i.test(msg)) return false;
  return (
    /transfer error/i.test(msg)
    || /was cancelled|was canceled|aborted/i.test(msg)
    || name === 'AbortError'
  );
}

/**
 * After a USB flash the Calliope reboots into the freshly-flashed app. If
 * that app is the blocks runtime, it auto-broadcasts STATE/MOTION
 * frames every ~40 ms — but only once the runtime's main loop is actually
 * running. Older blocks builds also wait for the first serial-write before
 * powering up notifications.
 *
 * `primeBlocksRuntimeProbe` is a best-effort kick to shorten the time between
 * "flash done" and "blocks runtime detected":
 *
 *  1. Wait briefly for the USB serial endpoint to re-enumerate after reboot.
 *  2. Send a single 'H\n' heartbeat. The blocks runtime intercepts H in its
 *     frame handler; non-blocks programs ignore it.
 *  3. Return — the auto-refresh hook in `program-type.ts` will pick up the
 *     frames from there.
 *
 * Safe to call when USB isn't connected (no-op). Never throws.
 */
export async function primeBlocksRuntimeProbe(): Promise<void> {
  const c = usbConn;
  if (!c) return;
  const isConnected = (): boolean => (c.status as ConnectionStatus) === ConnectionStatus.Connected;
  // Wait up to ~3 s for the post-flash device to come back. Calliope reboots
  // in well under 2 s once the flash completes; the lib's auto-reconnect
  // kicks the status back to Connected.
  const deadline = Date.now() + 3_000;
  while (!isConnected() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!isConnected()) return;
  try {
    await c.serialWrite('H\n');
    appendLog({ direction: 'info', text: 'Blocks-runtime probe primed (H over USB)' });
  } catch {
    /* ignore — best-effort */
  }
}

export async function disconnectUsb(): Promise<void> {
  if (!usbConn) return;
  const t = new Promise<void>((res) => setTimeout(res, 2000));
  try { await Promise.race([usbConn.disconnect(), t]); } catch { /* ignore */ }
}

/**
 * Revoke WebUSB permission for every authorized Calliope DAPLink. Mirrors
 * `forgetAllBleDevices` in ble.ts. Without this, the browser keeps the device
 * permission and `tryAutoReconnectUsb` silently re-connects on the next page
 * load — even after the user explicitly clicked "Trennen & vergessen".
 *
 * Upstream's `MicrobitUSBConnection.clearDevice` only clears its internal
 * cache; it never calls `USBDevice.forget()`, which is what actually revokes
 * the WebUSB permission. We call both: upstream for its bookkeeping, then
 * the per-device `forget()` to clear the browser permission.
 */
export async function forgetAllUsbDevices(): Promise<void> {
  if (usbConn) {
    try { await usbConn.clearDevice(); } catch { /* ignore */ }
  }
  if (typeof navigator === 'undefined' || !('usb' in navigator)) return;
  try {
    const nav = navigator as unknown as {
      usb: { getDevices(): Promise<{ vendorId: number; productId: number; forget?: () => Promise<void> }[]> };
    };
    const devices = await nav.usb.getDevices();
    let forgotAny = false;
    for (const d of devices) {
      // Forget both the standard DAPLink (CMSIS-DAP flash path) AND any SEGGER
      // J-Link OB unit (Calliope Mini 2 interface chip, VID 0x1366). Without
      // the J-Link case a paired Mini 2 keeps getting auto-attempted after the
      // user clicked "Trennen & vergessen". The VID 0x1366 match covers every
      // PID the J-Link picker (SEGGER_USB_FILTERS) can authorize, since they
      // all share that vendor id.
      const isDapLink = d.vendorId === 0x0d28 && d.productId === 0x0204;
      const isJLink = d.vendorId === SEGGER_JLINK_VENDOR_ID;
      if (!isJLink && !isDapLink) continue;
      if (typeof d.forget === 'function') {
        try { await d.forget(); forgotAny = true; } catch { /* ignore */ }
      }
    }
    // On Windows the kernel needs a moment after `forget()` before it
    // accepts a fresh `requestDevice` for the same VID/PID. Without this
    // settle, the next user-initiated Connect can hit a "device not
    // selected" or stale-handle error.
    if (forgotAny) await new Promise((r) => setTimeout(r, 800));
  } catch { /* ignore */ }
}
