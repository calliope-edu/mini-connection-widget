/// <reference types="web-bluetooth" />
import {
  ConnectionStatus,
  DeviceError,
  ProgressStage,
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
import {
  flashOverBluetoothWeb,
  BluetoothPartialFlashDalMismatchError,
  BluetoothPartialFlashInvalidHexError,
  BluetoothPartialFlashServiceMissingError,
} from './ble-flash-web';

// ---- Module state -----------------------------------------------------------

let bleConn: MicrobitBluetoothConnection | null = null;
let bleInitPromise: Promise<MicrobitBluetoothConnection> | null = null;
let bleRxBuffer = '';

const bleLineSubs = new Set<(line: string) => void>();

export function getBleConn(): MicrobitBluetoothConnection | null { return bleConn; }

/**
 * Pull the underlying `BluetoothDevice` (web) / `BleDevice` (capacitor
 * native) out of the lib's private state. Upstream doesn't expose the
 * device through its public interface; the field name has been stable
 * across all 1.0.0-beta.* versions so far. If/when upstream adds a public
 * getter, replace this cast with the proper call.
 *
 * We need access to the underlying device to run our own BLE flash
 * implementation (see ble-flash-web.ts) — upstream's `connection.flash()`
 * doesn't work reliably on Web Bluetooth, but our port of the fork's
 * `flashOverBluetooth` does.
 */
type AnyBleDevice = { name?: string; deviceId?: string } & Partial<BluetoothDevice>;
function getRawBleDevice(c: MicrobitBluetoothConnection): AnyBleDevice | undefined {
  const wrapper = (c as unknown as {
    device?: { bleDevice?: AnyBleDevice };
    bleDevice?: AnyBleDevice;
  });
  return wrapper.bleDevice ?? wrapper.device?.bleDevice;
}
function getBleDeviceName(c: MicrobitBluetoothConnection): string | undefined {
  const dev = getRawBleDevice(c);
  return dev?.name ?? dev?.deviceId;
}

// ---- BluetoothDevice tracking ----------------------------------------------
//
// Capacitor's BleClient stores the real `BluetoothDevice` in a private
// `deviceMap` keyed by `device.id`, and only exposes a `BleDevice` wrapper
// publicly. Our flash code needs the real `BluetoothDevice` to drive GATT
// directly. On Chrome variants where `navigator.bluetooth.getDevices()` is
// available we can look it up by id; in older/restricted builds it isn't.
//
// To always have access, we transparently intercept
// `navigator.bluetooth.requestDevice` on module load and keep our own
// `Map<id, BluetoothDevice>`. Same id semantics Capacitor uses internally,
// so a `BleDevice.deviceId` always finds its `BluetoothDevice`.
const trackedDevices = new Map<string, BluetoothDevice>();

/**
 * Extra GATT services we declare on every requestDevice call so the
 * browser exposes them after pairing.
 *
 * Web Bluetooth hides services not listed in `optionalServices`/`filters`
 * at request time — even if the device advertises them. Upstream
 * `@microbit/microbit-connection` lists the standard micro:bit profile;
 * we add the Calliope-specific MbitMore service so the blocks runtime is
 * visible to:
 *   - Scratch's BLE bridge (see WidgetScratchLinkSocket)
 *   - the blocks-runtime detector (program-type.ts)
 * without making the embedder re-prompt the user.
 *
 * Keep this list narrow — every entry shows up in the OS-level pairing
 * prompt on some platforms.
 */
const EXTRA_OPTIONAL_SERVICES: BluetoothServiceUUID[] = [
  '0b50f3e4-607f-4151-9091-7d008d6ffc5c', // MbitMore (pxt-scratch blocks runtime)
];

function augmentRequestDeviceOptions(opts: unknown): unknown {
  if (!opts || typeof opts !== 'object') return opts;
  const o = opts as { optionalServices?: BluetoothServiceUUID[] } & Record<string, unknown>;
  const existing = Array.isArray(o.optionalServices) ? o.optionalServices : [];
  const known = new Set<string>(existing.map((s) => String(s).toLowerCase()));
  const merged = [...existing];
  for (const s of EXTRA_OPTIONAL_SERVICES) {
    if (!known.has(String(s).toLowerCase())) {
      merged.push(s);
      known.add(String(s).toLowerCase());
    }
  }
  return { ...o, optionalServices: merged };
}

let requestDeviceInterceptInstalled = false;
function installRequestDeviceIntercept(): void {
  if (requestDeviceInterceptInstalled) return;
  if (typeof navigator === 'undefined' || !navigator.bluetooth) return;
  requestDeviceInterceptInstalled = true;
  const bt = navigator.bluetooth as unknown as {
    requestDevice: (opts: unknown) => Promise<BluetoothDevice>;
  };
  const orig = bt.requestDevice.bind(navigator.bluetooth);
  bt.requestDevice = async (opts: unknown) => {
    const augmented = augmentRequestDeviceOptions(opts);
    const d = await orig(augmented);
    if (d && d.id) trackedDevices.set(d.id, d);
    return d;
  };
}
// Install eagerly so the first connect()'s requestDevice call gets captured.
installRequestDeviceIntercept();
/**
 * Locate the real `BluetoothDevice` upstream is using. Upstream stores a
 * Capacitor `BleDevice` (a plain `{deviceId, name}` wrapper) on the
 * connection, not the underlying `BluetoothDevice` — the real one lives
 * inside Capacitor's plugin's internal `deviceMap`. We look it up via
 * `navigator.bluetooth.getDevices()`, which lists every already-permitted
 * `BluetoothDevice` for this origin, then match by id.
 */
async function getBleDevice(
  c: MicrobitBluetoothConnection,
): Promise<BluetoothDevice | undefined> {
  const dev = getRawBleDevice(c);
  if (!dev) return undefined;
  // Defensive: if upstream ever changes to store the raw BluetoothDevice
  // directly, take the fast path.
  if ('gatt' in dev) return dev as BluetoothDevice;
  const deviceId = (dev as { deviceId?: string }).deviceId;
  if (!deviceId) return undefined;
  // Primary path: our own requestDevice intercept tracks every device the
  // lib has connected to in this session.
  const tracked = trackedDevices.get(deviceId);
  if (tracked) return tracked;
  // Fallback: try navigator.bluetooth.getDevices() if Chrome exposes it
  // (Chrome flag `enable-experimental-web-platform-features` in some
  // builds). Without it, the intercept is the only path.
  const bt = navigator.bluetooth as unknown as {
    getDevices?: () => Promise<BluetoothDevice[]>;
  };
  if (bt.getDevices) {
    try {
      const all = await bt.getDevices();
      const found = all.find((d) => (d as unknown as { id?: string }).id === deviceId);
      if (found) {
        trackedDevices.set(deviceId, found);
        return found;
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

export function clearBleConn(): void {
  bleConn = null;
  bleInitPromise = null;
}

/**
 * Return the raw `BluetoothDevice` for the currently-connected Calliope, or
 * null if BLE isn't connected. Exposed so embedders can drive GATT services
 * directly (e.g. Scratch's MbitMore service over the same connection used
 * for flashing) without opening a second `requestDevice` prompt.
 *
 * Also resolves the blocks-only fallback device when upstream's full
 * connection isn't available (stale-bond case).
 */
export async function getConnectedBleDevice(): Promise<BluetoothDevice | null> {
  if (bleConn) {
    const dev = await getBleDevice(bleConn);
    if (dev) return dev;
  }
  if (blocksOnlyDevice && blocksOnlyDevice.gatt?.connected) return blocksOnlyDevice;
  return null;
}

// ---- Blocks-only (bare-GATT, no bond) connection ---------------------------
//
// When upstream's bonded connect path fails — typically because the OS bond
// became stale after a USB reflash on the Calliope — we can still talk to
// any unauthenticated GATT services. The blocks runtime (MbitMore) doesn't
// need a bond, so Scratch-style block communication keeps working even when
// UART and partial-flashing are unreachable. This is the "communication-only"
// mode the iOS app falls back to (full DFU runs without bond too).
//
// We track the device separately from `bleConn` because upstream's
// `MicrobitBluetoothConnection` is tightly coupled to authenticated
// characteristics; we just need the raw BluetoothDevice.

const MBIT_MORE_SERVICE_UUID = '0b50f3e4-607f-4151-9091-7d008d6ffc5c';

let blocksOnlyDevice: BluetoothDevice | null = null;

function setupBlocksOnlyDisconnectListener(dev: BluetoothDevice): void {
  // Reflect device-side disconnects back into the state machine. Web
  // Bluetooth fires `gattserverdisconnected` whenever the link drops.
  const onDisconnected = () => {
    updateState((s) => ({
      ...s,
      bleStatus: s.bleStatus === 'connected' && s.bleCanBlocks ? 'disconnected' : s.bleStatus,
      bleCanBlocks: false,
    }));
    appendLog({ direction: 'info', text: 'Disconnected (BLE blocks-only)' });
  };
  try {
    dev.addEventListener('gattserverdisconnected', onDisconnected, { once: true } as AddEventListenerOptions);
  } catch { /* ignore */ }
}

/**
 * Open a bare-GATT connection scoped to the MbitMore service — no UART,
 * no partial-flashing. Returns true on success and updates state to
 * `connected` + `bleCanBlocks: true`. Returns false if the device doesn't
 * expose MbitMore (i.e. it's not running the blocks runtime).
 *
 * Idempotent — calling again when already connected just confirms.
 */
export async function tryConnectBlocksOnly(): Promise<boolean> {
  if (blocksOnlyDevice && blocksOnlyDevice.gatt?.connected) return true;
  // Reuse any already-known device (from a prior failed full connect, or
  // from our requestDevice intercept). If none is around, this path can't
  // run silently — the caller should fall back to a normal `connectCalliope`.
  let device: BluetoothDevice | undefined;
  if (bleConn) device = await getBleDevice(bleConn);
  if (!device) {
    for (const d of trackedDevices.values()) { device = d; break; }
  }
  if (!device?.gatt) return false;

  try {
    const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
    // Probe MbitMore — if it's not there, this Calliope isn't running the
    // blocks runtime and there's nothing for us to do in blocks-only mode.
    try {
      await server.getPrimaryService(MBIT_MORE_SERVICE_UUID);
    } catch {
      try { device.gatt.disconnect(); } catch { /* ignore */ }
      return false;
    }
    blocksOnlyDevice = device;
    setupBlocksOnlyDisconnectListener(device);
    updateState((s) => ({
      ...s,
      bleStatus: 'connected',
      bleErrorMessage: undefined,
      bleDeviceName: device.name ?? s.bleDeviceName,
      bleCanBlocks: true,
      // Keep these false — we *know* they're unreachable in blocks-only mode.
      bleCanCommunicate: false,
      bleCanFlash: false,
      bleHasPaired: true,
      connectedAt: s.connectedAt ?? Date.now(),
    }));
    appendLog({ direction: 'info', text: 'Connected (BLE blocks-only)' });
    return true;
  } catch (err) {
    appendLog({
      direction: 'info',
      text: `Blocks-only connect failed: ${(err as Error)?.message ?? err}`,
    });
    return false;
  }
}

export function clearBlocksOnlyDevice(): void {
  if (blocksOnlyDevice) {
    try { blocksOnlyDevice.gatt?.disconnect(); } catch { /* ignore */ }
  }
  blocksOnlyDevice = null;
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
          bleCanBlocks: mapped === 'connected' ? s.bleCanBlocks : false,
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
        const name = getBleDeviceName(c);
        let boardVersion: 'V1' | 'V2' | undefined;
        try { boardVersion = c.getBoardVersion(); } catch { /* not ready yet */ }
        updateState((s) => ({
          ...s,
          bleDeviceName: name ?? s.bleDeviceName,
          boardVersion: boardVersion ?? s.boardVersion,
          calliopeVersion: boardVersion === 'V2' ? 'V3' : (boardVersion === 'V1' ? 'V1' : s.calliopeVersion),
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
  const device = await getBleDevice(c);
  if (!device) {
    updateState((s) => ({
      ...s,
      bleStatus: 'error',
      bleErrorMessage: 'BLE-Gerät nicht zugänglich — bitte erneut verbinden.',
    }));
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

  try {
    await flashOverBluetoothWeb({
      device,
      hex: cleanHex,
      onPhase: (phase) => {
        // Map the port's phases onto our 5-state UI flash phase. The phase
        // names are the fork's; the right-hand side matches what our UI
        // already knows how to render.
        const uiPhase = phase === 'flashing' ? 'flashing'
          : phase === 'finalising' ? 'finalising'
          : phase === 'reconnecting' ? 'prepare'
          : (phase === 'pairing-mode-switch' || phase === 'refreshing') ? 'reboot'
          : 'check';
        updateState((s) => ({ ...s, flashPhase: uiPhase }));
      },
      onProgress: (p) => {
        // The port emits combined 0..1 progress across all phases. Only
        // surface a percentage once we're actually flashing — let the
        // pre-flash UI use its indeterminate spinner instead.
        applyFlashProgress(ProgressStage.PartialFlashing, p);
      },
    });
    updateState((s) => ({
      ...s,
      flashTransport: undefined,
      flashProgress: undefined,
      flashPhase: undefined,
      flashPartial: undefined,
      lastFlashAt: Date.now(),
    }));
    appendLog({ direction: 'info', text: `Flash finished: ${name}` });
    // The Calliope rebooted into application mode and dropped the GATT —
    // upstream's connection wrapper will see Disconnected. The status
    // listener handles that.
  } catch (err) {
    handleBleFlashError(err);
  }
}

function handleBleFlashError(err: unknown): void {
  let userMsg: string;
  if (err instanceof BluetoothPartialFlashDalMismatchError) {
    userMsg = 'Runtime auf dem Calliope passt nicht zum Programm — bitte einmal per USB voll flashen.';
    updateState((s) => ({ ...s, bleCanFlash: false }));
  } else if (err instanceof BluetoothPartialFlashServiceMissingError) {
    userMsg = 'Calliope läuft gerade ohne Partial-Flashing-Service — einmal per USB ein MakeCode-Programm aufspielen.';
    updateState((s) => ({ ...s, bleCanFlash: false }));
  } else if (err instanceof BluetoothPartialFlashInvalidHexError) {
    userMsg = 'Dieses Programm kann nicht über BLE geflasht werden (kein MakeCode-Marker).';
  } else if (err instanceof DOMException && err.name === 'AbortError') {
    userMsg = 'Flash abgebrochen.';
  } else if (err instanceof DeviceError) {
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
