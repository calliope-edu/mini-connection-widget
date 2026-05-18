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
import { classifyUsbError, isExpectedRebootWindow } from './connection-errors';
import { showUsbErrorInfo } from './usb-error-info';

let usbConn: MicrobitUSBConnection | null = null;
let usbInitPromise: Promise<MicrobitUSBConnection> | null = null;
let rxBuffer = '';

/** Internal accessor — used by serial.ts/connect.ts/flash.ts. */
export function getUsbConn(): MicrobitUSBConnection | null { return usbConn; }
export function clearUsbConn(): void { usbConn = null; usbInitPromise = null; }

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
    c.addEventListener('status', (ev) => {
      const mapped = mapStatus(ev.status);
      const dev = c.getDevice();
      const pn = dev?.productName ?? undefined;
      const cv = detectCalliopeVersion(pn, undefined);
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
    c.addEventListener('serialdata', (data) => {
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
    usbConn = c;
    return c;
  })();
  return usbInitPromise;
}

export async function connectWithRetry(c: MicrobitUSBConnection, tries = 2): Promise<void> {
  let lastErr: unknown;
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
      // `device-disconnected` from open() is the Windows-side race after a
      // previous disconnect — the kernel hasn't released the interface yet
      // by the time we re-claim it. A longer settle window resolves it
      // most of the time without the user noticing.
      const settleMs = code === 'device-disconnected' ? 900 : 400;
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
      if (classified.kind === 'device-in-use') {
        showUsbErrorInfo('in-use', (err as Error)?.message ?? String(err ?? ''));
      } else if (classified.kind === 'device-disconnected') {
        showUsbErrorInfo('disconnected', (err as Error)?.message ?? String(err ?? ''));
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
  }
}

/**
 * WebUSB throws several recoverable error variants mid-flash:
 *
 *  - "Failed to execute 'transferOut' on 'USBDevice': A transfer error
 *    has occurred" — stale endpoint state after a previous session.
 *  - "Failed to execute 'transferOut' on 'USBDevice': The transfer was
 *    cancelled" (AbortError) — pending USB transfer aborted because the
 *    transport was closed mid-flight by upstream's own
 *    `withEnrichedErrors` disconnect. Hits especially hard with a chatty
 *    runtime (Blocks/MbitMore) where serial frames pile up in DAPLink's
 *    CDC buffer and confuse the DAP transfer state machine on the
 *    pre-flash reconnect.
 *
 * Recovery: bounce the connection (`disconnect` → wait → `connect`) so
 * upstream re-opens the interface fresh, then retry the flash. With a
 * chatty runtime the race can repeat once or twice — give up to 2
 * retries (3 total attempts) before surfacing.
 *
 * Without this the user clicks Übertragen, sees the progress bar twitch,
 * and the flash silently fails — they have to physically unplug and
 * replug to recover.
 */
async function runFlashWithTransferRetry(
  c: MicrobitUSBConnection,
  dataSource: FlashDataSource,
  progress: ProgressCallback,
): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await c.flash(dataSource, { partial: true, progress, minimumProgressIncrement: 0.05 });
      return;
    } catch (err) {
      if (!isTransientUsbTransferError(err) || attempt === maxAttempts) throw err;
      appendLog({
        direction: 'info',
        text: `USB transfer error (${(err as Error).message}) — bouncing connection, retry ${attempt}/${maxAttempts - 1}`,
      });
      try {
        await c.disconnect();
      } catch { /* ignore — we're about to reconnect anyway */ }
      // Longer settle on each retry. The Windows USB stack needs ~800ms
      // to fully release the DAPLink endpoint; jumping back in too fast
      // gives us the same cancelled-transferOut again.
      await new Promise((r) => setTimeout(r, 400 + attempt * 400));
      try {
        await c.connect();
      } catch (reconnectErr) {
        throw new Error(
          `USB transfer error; reconnect failed: ${(reconnectErr as Error).message}`,
        );
      }
      // Same race as in `flashCalliopeViaUsb`: `c.connect()` returns before
      // status flips to Connected. Without the wait, the lib's flash() throws
      // "Must be connected now" and we'd surface that instead of the original
      // transferOut error.
      await waitForUsbConnected(c);
      // Reset the UI flash phase — the lib starts the next attempt from
      // scratch ("FindingDevice" → ...), so the progress bar would jump
      // backwards if we left the previous percentage on screen.
      updateState((s) => ({ ...s, flashPhase: 'check', flashProgress: undefined }));
    }
  }
}

/**
 * Match the WebUSB transfer errors we know are recoverable by bouncing
 * the connection. Two families:
 *
 *  - "A transfer error has occurred" — stale endpoint state.
 *  - "The transfer was cancelled" (AbortError) — transport closed
 *    mid-flight, typically by upstream's own disconnect in
 *    `withEnrichedErrors` after a stale DAP response.
 *
 * Other USB errors (device unplugged, permission revoked, no DAPLink)
 * need user attention and stay non-recoverable.
 */
function isTransientUsbTransferError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  const name = (err as Error)?.name ?? '';
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
    for (const d of devices) {
      if (d.vendorId !== 0x0d28 || d.productId !== 0x0204) continue;
      if (typeof d.forget === 'function') {
        try { await d.forget(); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}
