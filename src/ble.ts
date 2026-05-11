/// <reference types="web-bluetooth" />
import {
  ConnectionStatus,
  DeviceError,
  ProgressStage,
  type FlashDataSource,
  type ProgressCallback,
} from '@microbit/microbit-connection';
import {
  createBluetoothConnection,
  type MicrobitBluetoothConnection,
} from '@microbit/microbit-connection/bluetooth';
import {
  updateState,
  getState,
  SUPPORT,
  type CalliopeStatus,
} from './state';
import { appendLog } from './log';
import { stripMakeCodeMetadata } from './helpers';
import { startHeartbeat, stopHeartbeat } from './serial';

// ---- Module state -----------------------------------------------------------

let bleConn: MicrobitBluetoothConnection | null = null;
let bleInitPromise: Promise<MicrobitBluetoothConnection> | null = null;
let bleRxBuffer = '';

const bleLineSubs = new Set<(line: string) => void>();

export function getBleConn(): MicrobitBluetoothConnection | null { return bleConn; }
export function clearBleConn(): void {
  bleConn = null;
  bleInitPromise = null;
}
export function addBleLineSubscriber(cb: (line: string) => void): () => void {
  bleLineSubs.add(cb);
  return () => { bleLineSubs.delete(cb); };
}

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
      return 'disconnected';
    default:
      return 'unknown';
  }
}

// ---- BLE serial write -------------------------------------------------------

const textEncoder = new TextEncoder();

export async function bleSerialWrite(line: string): Promise<void> {
  if (!bleConn || bleConn.status !== ConnectionStatus.Connected) return;
  // Upstream `uartWrite` accepts a Uint8Array. The lib chunks for us.
  await bleConn.uartWrite(textEncoder.encode(line));
}

// ---- Connection wrapper -----------------------------------------------------

export async function getBleConnection(): Promise<MicrobitBluetoothConnection> {
  if (bleConn) return bleConn;
  if (bleInitPromise) return bleInitPromise;
  if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) {
    updateState((s) => ({ ...s, bleStatus: 'unsupported' }));
    throw new DeviceError({ code: 'unsupported', message: 'Web Bluetooth not supported in this browser' });
  }
  bleInitPromise = (async () => {
    const c = createBluetoothConnection();
    await c.initialize();
    c.addEventListener('status', (ev) => {
      const mapped = mapStatus(ev.status);
      updateState((s) => {
        if (s.flashTransport === 'ble' && mapped !== 'connected') return s;
        return {
          ...s,
          bleStatus: mapped,
          bleErrorMessage: mapped === 'connected' ? undefined : s.bleErrorMessage,
          bleCanCommunicate: mapped === 'connected' ? s.bleCanCommunicate : false,
          bleCanFlash: mapped === 'connected' ? s.bleCanFlash : false,
          bleStaleBond: mapped === 'connected' ? s.bleStaleBond : false,
          connectedAt: mapped === 'connected' ? Date.now() : s.connectedAt,
        };
      });
      if (mapped === 'connected') {
        startHeartbeat();
        appendLog({ direction: 'info', text: 'Connected (BLE)' });
        // Successful connect means upstream already read the model number
        // (an authenticated characteristic), so OS bonding is fine. Mark
        // capabilities optimistically; the real verdict comes from any
        // actual write/flash that fails, where the error code tells us
        // which mode is broken.
        updateState((s) => ({
          ...s,
          bleCanCommunicate: true,
          bleCanFlash: true,
          bleStaleBond: false,
        }));
      } else {
        if (getState().usbStatus !== 'connected') stopHeartbeat();
        if (mapped === 'disconnected') appendLog({ direction: 'info', text: 'Disconnected (BLE)' });
      }
    });
    c.addEventListener('backgrounderror', (ev) => {
      const msg = ev.error.message;
      updateState((s) => ({ ...s, bleStatus: 'error', bleErrorMessage: msg }));
      appendLog({ direction: 'error', text: msg });
    });
    // UART data — upstream gives us a Uint8Array per notification. Buffer and
    // split into newline-terminated lines, same as USB.
    c.addEventListener('uartdata', (data) => {
      bleRxBuffer += new TextDecoder().decode(data.value);
      let idx: number;
      while ((idx = bleRxBuffer.indexOf('\n')) >= 0) {
        const line = bleRxBuffer.slice(0, idx).replace(/\r$/, '');
        bleRxBuffer = bleRxBuffer.slice(idx + 1);
        if (!line) continue;
        appendLog({ direction: 'rx', text: line });
        bleLineSubs.forEach((cb) => { try { cb(line); } catch { /* ignore */ } });
      }
    });
    bleConn = c;
    return c;
  })();
  return bleInitPromise;
}

// ---- Capability probes ------------------------------------------------------

/**
 * After connect, work out what we can actually do over BLE. Three failure
 * modes to distinguish:
 *
 *  - **Hex without UART** — service legitimately not advertised. We stay
 *    connected; just no data flows.
 *  - **OS-pairing missing** — a never-paired device hides authenticated
 *    services. UART unreachable; partial-flashing service unreachable.
 *    UI shows "OS-Pairing fehlt".
 *  - **OS-pairing stale** — OS still has a bond, but the Calliope has
 *    forgotten its whitelist (typical after USB full-flash). Same symptom
 *    as never-paired but the browser remembers the device. UI shows
 *    "OS-Pairing veraltet" with instructions to entkoppeln + neu pairen.
 *
 * Probe is conservative: try a no-op `uartWrite('')`. If it fails, we have
 * neither communication nor the right pairing state. Then we cross-reference
 * `bleHasPaired` to pick the right message. We optimistically assume
 * `bleCanFlash` is true when connected — the real answer comes when the
 * user actually flashes; if it fails with a relevant error we can flip.
 */
// ---- Flash via BLE ----------------------------------------------------------

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

export async function flashCalliopeViaBle(hex: string, name: string): Promise<void> {
  if (!SUPPORT.ble) {
    updateState((s) => ({ ...s, bleStatus: 'error', bleErrorMessage: 'Web Bluetooth not supported' }));
    return;
  }
  let c: MicrobitBluetoothConnection;
  try {
    c = await getBleConnection();
  } catch (err) {
    updateState((s) => ({ ...s, bleStatus: 'error', bleErrorMessage: (err as Error).message }));
    return;
  }

  updateState((s) => ({
    ...s,
    flashTransport: 'ble',
    flashProgress: undefined,
    flashPhase: 'check',
    flashPartial: true,
    bleErrorMessage: undefined,
    lastFlashName: name,
  }));
  const cleanHex = stripMakeCodeMetadata(hex);
  appendLog({
    direction: 'info',
    text: `Flashing via BLE "${name}" (${Math.round(cleanHex.length / 1024)} KB)`,
  });

  const dataSource: FlashDataSource = async () => cleanHex;
  const progress: ProgressCallback = applyFlashProgress;

  try {
    await c.flash(dataSource, { partial: true, progress, minimumProgressIncrement: 0.05 });
    updateState((s) => ({
      ...s,
      flashTransport: undefined,
      flashProgress: undefined,
      flashPhase: undefined,
      flashPartial: undefined,
      lastFlashAt: Date.now(),
    }));
    appendLog({ direction: 'info', text: `Flash finished: ${name}` });
    // BLE always disconnects after flash (lib semantics). Caller has to
    // reconnect — surface that fact via state so the UI prompts the user.
  } catch (err) {
    handleBleFlashError(err);
  }
}

function handleBleFlashError(err: unknown): void {
  let userMsg: string;
  if (err instanceof DeviceError) {
    switch (err.code) {
      case 'pairing-information-lost':
        userMsg = 'OS-Pairing veraltet — Calliope in den OS-Bluetooth-Einstellungen entkoppeln und neu pairen.';
        updateState((s) => ({ ...s, bleStaleBond: true, bleCanFlash: false }));
        break;
      case 'firmware-update-required':
        userMsg = 'Runtime auf dem Calliope passt nicht zum Programm — bitte einmal per USB voll flashen.';
        updateState((s) => ({ ...s, bleCanFlash: false }));
        break;
      case 'no-device-selected':
      case 'aborted':
        userMsg = 'Flash abgebrochen.';
        break;
      case 'permission-denied':
        userMsg = 'Bluetooth-Pairing fehlt: Calliope einmal in den OS-Bluetooth-Einstellungen koppeln, oder per USB anschließen.';
        updateState((s) => ({ ...s, bleCanFlash: false }));
        break;
      default:
        userMsg = err.message || `BLE flash error: ${err.code}`;
    }
  } else {
    userMsg = (err as Error)?.message ?? String(err);
  }
  updateState((s) => ({
    ...s,
    flashTransport: undefined,
    bleStatus: 'error',
    bleErrorMessage: userMsg,
    flashProgress: undefined,
    flashPhase: undefined,
  }));
  appendLog({ direction: 'error', text: `BLE flash failed: ${userMsg}` });
}

export async function disconnectBle(): Promise<void> {
  if (!bleConn) return;
  const t = new Promise<void>((res) => setTimeout(res, 2000));
  try { await Promise.race([bleConn.disconnect(), t]); } catch { /* ignore */ }
}

// ---- Forget all paired BLE devices ------------------------------------------

/**
 * Tell the lib to forget the currently-cached device so the next connect()
 * shows a fresh picker. Upstream's `clearDevice()` does the work; we also
 * call browser-level forget on any remembered devices so a previously-
 * permitted Calliope re-appears in the chooser.
 */
export async function forgetAllBleDevices(): Promise<void> {
  if (bleConn) {
    try { await bleConn.clearDevice(); } catch { /* ignore */ }
  }
  if (typeof navigator !== 'undefined' && 'bluetooth' in navigator) {
    const bt = (navigator as unknown as {
      bluetooth: { getDevices?: () => Promise<BluetoothDevice[]> };
    }).bluetooth;
    if (bt.getDevices) {
      try {
        const all = await bt.getDevices();
        for (const d of all) {
          const f = d as unknown as { forget?: () => Promise<void> };
          if (f.forget) {
            try { await f.forget(); } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
  }
  clearBleConn();
}

/**
 * Refresh whether the browser remembers a previously-permitted BLE device
 * for this origin. Called on init so the UI can show a remembered name even
 * before the first connect.
 */
export async function refreshPairedBleStatus(): Promise<void> {
  if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) return;
  const bt = (navigator as unknown as {
    bluetooth: { getDevices?: () => Promise<BluetoothDevice[]> };
  }).bluetooth;
  if (!bt.getDevices) return;
  try {
    const known = await bt.getDevices();
    const first = known[0] as unknown as { name?: string; id?: string } | undefined;
    updateState((s) => ({
      ...s,
      bleHasPaired: known.length > 0,
      bleDeviceName: s.bleDeviceName ?? first?.name ?? first?.id,
    }));
  } catch {
    /* permissions backend unavailable — leave state alone */
  }
}
