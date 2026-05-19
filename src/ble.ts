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
import {
  flashOverNordicDfuWeb,
  BluetoothDfuFailedError,
  BluetoothDfuServiceMissingError,
  type BluetoothDfuPhase,
} from './ble-dfu-web';
import { extractFriendlyName, friendlyNameFromDeviceId } from './friendly-name';
import {
  classifyBleError,
  isExpectedRebootWindow,
} from './connection-errors';
import { classifyBleSessionFromDevice } from './ble-state';

// Standard Bluetooth SIG Device Information Service — every micro:bit /
// Calliope firmware exposes it. The Serial Number string characteristic
// (0x2A25) is the firmware's `getSerial()` output: decimal representation
// of `target_get_serial()` = `((uint64_t)FICR.DEVICEID[1] << 32) |
// FICR.DEVICEID[0]`. Parse it, take the upper 32 bits, run the same
// algorithm the firmware uses (`microbit_friendly_name`).
const BLE_DIS_SERVICE_UUID = 0x180a;
const BLE_DIS_SERIAL_NUMBER_CHAR_UUID = 0x2a25;

/**
 * Derive the 5-letter friendly name from the standard Device Information
 * Service's Serial Number characteristic. Silently returns `undefined`
 * on any failure — falling back to whatever the GAP name regex found.
 */
async function readFriendlyNameViaGatt(c: MicrobitBluetoothConnection): Promise<string | undefined> {
  const device = await getBleDevice(c);
  if (!device?.gatt?.connected) return undefined;
  try {
    const service = await device.gatt.getPrimaryService(BLE_DIS_SERVICE_UUID);
    const char = await service.getCharacteristic(BLE_DIS_SERIAL_NUMBER_CHAR_UUID);
    const v = await char.readValue();
    const serialStr = new TextDecoder().decode(v).trim();
    if (!/^\d+$/.test(serialStr)) return undefined;
    // `target_get_serial()` is 64-bit; only the upper 32 bits
    // (`FICR.DEVICEID[1]`) feed the friendly-name algorithm.
    const serial64 = BigInt(serialStr);
    const deviceId = Number(serial64 >> 32n) >>> 0;
    if (deviceId === 0) return undefined;
    return friendlyNameFromDeviceId(deviceId);
  } catch {
    return undefined;
  }
}

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
 * we add the Calliope-specific Blocks service so the blocks runtime is
 * visible to:
 *   - the campus blocks-editor bridge (see CalliopeRemoteHost)
 *   - the blocks-runtime detector (program-type.ts)
 * without making the embedder re-prompt the user.
 *
 * Keep this list narrow — every entry shows up in the OS-level pairing
 * prompt on some platforms.
 */
const EXTRA_OPTIONAL_SERVICES: BluetoothServiceUUID[] = [
  '0b50f3e4-607f-4151-9091-7d008d6ffc5c', // Blocks service (pxt-blocks runtime)
  0x180a, // Device Information Service — Serial Number → friendly-name derivation
  0xfe59, // Nordic Semiconductor DFU service (buttonless in app + Secure DFU in bootloader)
  // Partial-flash + UART are usually declared by upstream `@microbit/microbit-connection`,
  // but we declare them ourselves too so the post-connect state classifier
  // (see ble-state.ts) can see them via `getPrimaryServices()` regardless of
  // which version of upstream is installed. Web Bluetooth hides services
  // that weren't declared at requestDevice time even if the device advertises
  // them, so omitting these would make the classifier blind.
  'e97dd91d-251d-470a-a062-fa1922dfa9a8', // CODAL partial-flashing service
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART service (CODAL UART)
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
 * directly (e.g. the Blocks service over the same connection used
 * for flashing) without opening a second `requestDevice` prompt.
 */
export async function getConnectedBleDevice(): Promise<BluetoothDevice | null> {
  if (bleConn) {
    const dev = await getBleDevice(bleConn);
    if (dev) return dev;
  }
  return null;
}

export function addBleLineSubscriber(cb: (line: string) => void): () => void {
  bleLineSubs.add(cb);
  return () => { bleLineSubs.delete(cb); };
}

const bleRawSubs = new Set<(chunk: string) => void>();

/**
 * Subscribe to raw decoded UART chunks (no line buffering). For consumers
 * that need character-level data — typically the MicroPython REPL.
 */
export function addBleRawSubscriber(cb: (chunk: string) => void): () => void {
  bleRawSubs.add(cb);
  return () => { bleRawSubs.delete(cb); };
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
      // During an in-flight BLE flash, ignore non-connected transitions so a
      // transient device-side drop doesn't crater state.
      if (getState().flashTransport === 'ble' && mapped !== 'connected') return;
      if (mapped === 'connected') {
        startHeartbeat();
        appendLog({ direction: 'info', text: 'Connected (BLE)' });
        // With open-mode firmware, a successful `gatt.connect()` means we
        // can immediately use every characteristic — there's no SMP gate
        // to wait on. Mark capabilities optimistically; the classifier
        // below will downgrade if the device turns out to be in DfuTarg.
        const name = getBleDeviceName(c);
        let boardVersion: 'V1' | 'V2' | undefined;
        try { boardVersion = c.getBoardVersion(); } catch { /* not ready yet */ }
        // BLE name only carries the friendly suffix when the OS cached
        // it during a prior pairing operation. Often it's just
        // "Calliope mini" — in that case the regex returns undefined and
        // we keep whatever friendlyName USB (or a prior connect) supplied.
        const friendly = extractFriendlyName(name);
        updateState((s) => ({
          ...s,
          bleStatus: 'connected',
          bleErrorMessage: undefined,
          bleDeviceName: name ?? s.bleDeviceName,
          boardVersion: boardVersion ?? s.boardVersion,
          calliopeVersion: boardVersion === 'V2' ? 'V3' : (boardVersion === 'V1' ? 'V1' : s.calliopeVersion),
          friendlyName: friendly ?? s.friendlyName,
          bleCanCommunicate: true,
          bleCanFlash: true,
          bleHasPermission: true,
          userDisconnectedBle: false,
          connectedAt: Date.now(),
        }));
        // Background: query the CODAL DeviceInfo characteristic for the
        // canonical device id. More reliable than the GAP name, which only
        // carries the [tipov] suffix when the OS cached it during pairing
        // mode. Falls through silently on older firmware that doesn't
        // expose DeviceInfo yet — extractFriendlyName has already done
        // what it can with the advertised name.
        void readFriendlyNameViaGatt(c).then((g) => {
          if (g) updateState((s) => ({ ...s, friendlyName: g }));
        });
        // Background: enumerate the GATT services and classify the session.
        // `getPrimaryServices()` is read-only and does NOT trigger SMP, so
        // this is safe to run on every connect (including auto-reconnects
        // after a flash reboot). Result flows into `state.bleSessionKind`
        // and downgrades `bleCanFlash` when we can tell the bond isn't
        // there — without that the UI optimistically claims "ready" until
        // the user's first encrypted op fails.
        void (async () => {
          try {
            const device = await getBleDevice(c);
            if (!device) return;
            // Small delay so the lib's own GATT discovery finishes first.
            // Otherwise getPrimaryServices() can race and return an empty
            // list on slower Windows BT stacks.
            await new Promise((r) => setTimeout(r, 250));
            const result = await classifyBleSessionFromDevice(device);
            const summary = result.services
              .map((u) => u.length === 36 ? u.slice(0, 8) : u)
              .join(', ');
            appendLog({
              direction: 'info',
              text: `BLE state: ${result.kind} — ${result.reason}; services=[${summary}]`,
            });
            updateState((s) => {
              if (s.flashTransport === 'ble') return { ...s, bleSessionKind: result.kind };
              // 'dfu-bootloader' is the one classification that downgrades
              // capabilities: the bootloader doesn't host UART or
              // partial-flash, so neither comms nor partial-flash work
              // until the device reboots back into app mode.
              if (result.kind === 'dfu-bootloader') {
                return {
                  ...s,
                  bleSessionKind: 'dfu-bootloader',
                  bleCanFlash: false,
                  bleCanCommunicate: false,
                  bleErrorMessage:
                    'Calliope ist im DFU-Bootloader. Reset drücken, um zurück in die Anwendung zu kommen.',
                };
              }
              return { ...s, bleSessionKind: result.kind };
            });
          } catch (err) {
            appendLog({
              direction: 'info',
              text: `BLE classify failed: ${(err as Error)?.message ?? err}`,
            });
          }
        })();
      } else {
        updateState((s) => ({
          ...s,
          bleStatus: mapped,
          bleCanCommunicate: false,
          bleCanFlash: false,
          bleSessionKind: undefined,
        }));
        if (getState().usbStatus !== 'connected') stopHeartbeat();
        if (mapped === 'disconnected') appendLog({ direction: 'info', text: 'Disconnected (BLE)' });
      }
    });
    c.addEventListener('backgrounderror', (ev) => {
      const msg = ev.error.message;
      // During an expected device reboot (post-flash, DFU enter) the GATT
      // drops as part of normal operation. Log it as info so power-users
      // still see it in the comms panel, but don't promote it to an error.
      if (isExpectedRebootWindow()) {
        appendLog({ direction: 'info', text: `BLE background (expected reboot): ${msg}` });
        return;
      }
      const classified = classifyBleError(ev.error);
      if (classified.kind === 'aborted') return;
      updateState((s) => ({
        ...s,
        bleStatus: 'error',
        bleErrorMessage: classified.userMessage,
      }));
      appendLog({ direction: 'error', text: msg });
    });
    // UART data — upstream gives us a Uint8Array per notification. Buffer and
    // split into newline-terminated lines, same as USB.
    c.addEventListener('uartdata', (data) => {
      const chunk = new TextDecoder().decode(data.value);
      // Raw subscribers (e.g. MicroPython REPL) want every byte as it arrives,
      // even partial-line chunks.
      bleRawSubs.forEach((cb) => { try { cb(chunk); } catch { /* ignore */ } });
      // Line subscribers and the rx log still split on '\n'.
      bleRxBuffer += chunk;
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
    // Upstream's `BluetoothConnection` wrapper still reports `connected`
    // but we can't resolve the underlying `BluetoothDevice` — usually a
    // stale-tracking situation (HMR wiped our `trackedDevices` map while
    // the upstream wrapper kept a reference to the old `BleDevice`).
    // Throw rather than silently returning so the dispatcher can either
    // try DFU (which will hit the same problem and fall through to USB)
    // or surface the failure to the user with a real action they can take.
    throw new Error('BLE-Gerät nicht zugänglich — bitte erneut verbinden.');
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
    // DAL mismatch is recoverable via USB — propagate so the dispatcher in
    // flash.ts can fall back to USB without showing a hard error. Leave
    // `bleCanFlash` true: a successful USB flash will bring the device's
    // DAL in line with the hex, so the very next BLE flash will probably
    // succeed. Sticky `false` would otherwise force every later flash
    // through USB until the user manually disconnects, plus mis-fire the
    // "needs OS pairing" modal even though pairing is fine.
    if (err instanceof BluetoothPartialFlashDalMismatchError ||
        err instanceof BluetoothPartialFlashServiceMissingError ||
        err instanceof BluetoothPartialFlashInvalidHexError) {
      // All three mean partial flash is impossible, but a full BLE flash
      // via Nordic DFU still works:
      //  - DAL mismatch / service missing: typical after a failed or
      //    interrupted DFU left the device in a non-MakeCode state where
      //    the partial-flashing service isn't advertised.
      //  - Invalid hex: the image isn't MakeCode-shaped (e.g. a
      //    MicroPython firmware build — no end-of-app marker). The iOS
      //    and Android Calliope apps take the same path: Nordic DFU for
      //    anything that isn't a MakeCode partial-flash payload.
      // Reset flash state and let the dispatcher decide whether to try
      // DFU (or USB) next.
      updateState((s) => ({
        ...s,
        flashTransport: undefined,
        flashProgress: undefined,
        flashPhase: undefined,
        flashPartial: undefined,
      }));
      const reason = err instanceof BluetoothPartialFlashDalMismatchError
        ? 'DAL mismatch'
        : err instanceof BluetoothPartialFlashInvalidHexError
        ? 'no MakeCode marker (non-MakeCode hex)'
        : 'partial-flash service missing';
      appendLog({ direction: 'info', text: `BLE partial flash impossible (${reason})` });
      throw err;
    }
    handleBleFlashError(err);
  }
}

/**
 * Full BLE flash via Nordic Secure DFU. Used as a fallback when partial
 * flashing reports a DAL mismatch — the runtime on the device is too
 * different from the hex's expected runtime for partial flashing to work,
 * but a full re-flash via the bootloader still succeeds (this is what the
 * iOS / Android Calliope apps do via the native Nordic DFU library).
 *
 * Returns normally on success — caller is responsible for the post-flash
 * BLE auto-reconnect (the device reboots into the freshly-flashed app and
 * the GATT drops, same as after a partial flash).
 *
 * Throws {@link BluetoothDfuFailedError} on protocol failure or
 * {@link BluetoothDfuServiceMissingError} if the device isn't exposing the
 * Nordic DFU service at all. Both are recoverable by the caller; the
 * dispatcher falls back to USB.
 */
export async function flashCalliopeViaBleDfu(hex: string, name: string): Promise<void> {
  if (!SUPPORT.ble) {
    throw new BluetoothDfuFailedError('Web Bluetooth not supported');
  }
  const c = await getBleConnection();
  const device = await getBleDevice(c);
  if (!device) {
    throw new BluetoothDfuFailedError('BLE device not accessible — please reconnect first.');
  }
  let boardVersion: 'V2' | undefined;
  try {
    const v = c.getBoardVersion();
    if (v === 'V2') boardVersion = 'V2';
  } catch { /* not ready yet */ }
  if (boardVersion !== 'V2') {
    throw new BluetoothDfuFailedError('Full BLE flash is only supported on Calliope mini 3.');
  }
  const cleanHex = stripMakeCodeMetadata(hex);
  appendLog({
    direction: 'info',
    text: `Flashing via BLE-DFU "${name}" (${Math.round(cleanHex.length / 1024)} KB)`,
  });
  updateState((s) => ({
    ...s,
    flashTransport: 'ble',
    flashProgress: undefined,
    flashPhase: 'reboot',
    flashPartial: false,
    bleErrorMessage: undefined,
    lastFlashName: name,
  }));
  try {
    await flashOverNordicDfuWeb({
      device,
      hex: cleanHex,
      boardVersion,
      onPhase: (p: BluetoothDfuPhase) => {
        // Setup phases (everything before firmware streaming) keep
        // `flashProgress: undefined` so the UI shows an indeterminate
        // spinner — the few hundred ms of bootloader-entry + reconnect +
        // init-packet shouldn't be partial-percentages on the same bar
        // that the firmware stream will fill cleanly from 0..100.
        const uiPhase = p === 'flashing' ? 'flashing'
          : p === 'finalising' ? 'finalising'
          : (p === 'sending-init') ? 'check'
          : 'reboot';
        updateState((s) => ({
          ...s,
          flashPhase: uiPhase,
          flashProgress: p === 'finalising' ? 100 : undefined,
        }));
      },
      onProgress: (progress) => {
        // Called only during the firmware-streaming phase, with 0..1
        // mapped to firmware bytes transferred — render as 0..100 % on the
        // bar so the user sees a clean linear advance.
        const intPct = Math.round(progress * 100);
        updateState((s) => ({
          ...s,
          flashPhase: 'flashing',
          flashProgress: intPct,
          flashPartial: false,
        }));
        appendLog({ direction: 'info', text: `Flash: ${intPct}%`, kind: 'flash-progress' });
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
    appendLog({ direction: 'info', text: `BLE-DFU flash finished: ${name}` });
  } catch (err) {
    updateState((s) => ({
      ...s,
      flashTransport: undefined,
      flashProgress: undefined,
      flashPhase: undefined,
      flashPartial: undefined,
    }));
    // Don't promote the error into state.bleErrorMessage here — the caller
    // (flash.ts) decides whether to retry via USB or surface the failure.
    appendLog({ direction: 'info', text: `BLE-DFU flash failed: ${(err as Error)?.message ?? err}` });
    throw err;
  }
}

function handleBleFlashError(err: unknown): void {
  // Local flash-specific error types come first — these carry domain
  // semantics ("DAL mismatch", "service missing") that the generic
  // classifier doesn't see. Everything else routes through the classifier
  // so we get one consistent BLE-error story.
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
  } else if (err instanceof DeviceError && err.code === 'firmware-update-required') {
    userMsg = 'Runtime auf dem Calliope passt nicht zum Programm — bitte einmal per USB voll flashen.';
    updateState((s) => ({ ...s, bleCanFlash: false }));
  } else {
    const classified = classifyBleError(err);
    userMsg = classified.kind === 'aborted' ? 'Flash abgebrochen.' : classified.userMessage;
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
 * before the first connect, and so the reconnect daemon knows whether
 * there's anything to reconnect to.
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
      bleHasPermission: known.length > 0,
      bleDeviceName: s.bleDeviceName ?? first?.name ?? first?.id,
    }));
  } catch {
    /* permissions backend unavailable — leave state alone */
  }
}
