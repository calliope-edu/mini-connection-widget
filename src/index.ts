/**
 * @calliope-edu/calliope-connection — staged-locally entry point.
 *
 * Vanilla TypeScript wrapper around `@microbit/microbit-connection` that
 * orchestrates the higher-level Calliope lifecycle: simultaneous USB+BLE
 * tracking, smart picker resets, stale-bond detection, automatic flash
 * routing (BLE-paired > USB > USB-plug prompt), and a Svelte-compatible
 * store so any UI framework can subscribe.
 *
 * No framework dependency, no Svelte imports — when this directory moves
 * into its own repo nothing here needs to change.
 *
 * Future native-proxy mode: a wrapping native app (iOS/Android/desktop) will
 * own BLE + USB + flashing, and this package can swap in a thin proxy that
 * mutates the same `calliopeState` and dispatches the same `connectCalliope`/
 * `flashCalliope` actions over a postMessage bridge. The public API surface
 * stays identical so consumers don't need to know which backend is active.
 */

import { connectCalliope } from './connect';
import { getUsbConn, getUsbConnection } from './usb';
import { addBleRawSubscriber, getBleConnection, refreshPairedBleStatus } from './ble';
import { updateState } from './state';
import { appendLog } from './log';
import { initScratchBridge } from './scratch-bridge';
import { attachCommsFeeds } from './comms';

// ---- Public API ------------------------------------------------------------

export type {
  CalliopeState,
  CalliopeStatus,
  CalliopeTransport,
  CalliopeFlashPhase,
} from './state';
export type { CalliopeVersion } from './helpers';
export type { CalliopeLogEntry } from './log';
export type { UsbPlugRequest } from './usb-plug';
export type { UsbErrorInfo, UsbErrorInfoKind } from './usb-error-info';
export type { ConnectionChoice, ConnectionChoiceRequest } from './connection-choice';
export type { Readable, Writable, Subscriber, Unsubscriber } from './store';

export { calliopeState } from './state';
export { calliopeLog, clearCalliopeLog } from './log';
export { calliopeBlePairingInfo, dismissBlePairingInfo, showBlePairingInfo } from './pairing-info';
export { calliopeUsbPlugRequest } from './usb-plug';
export { calliopeUsbErrorInfo, dismissUsbErrorInfo } from './usb-error-info';
export { calliopeConnectionChoiceRequest } from './connection-choice';

export { connectCalliope, disconnectAndForget } from './connect';
export { flashCalliope } from './flash';
export {
  sendSerialLine,
  onSerialLine,
  sendSerialData,
  onSerialData,
} from './serial';
export { getConnectedBleDevice } from './ble';
export { getRunningProgramType } from './program-type';
export type { CalliopeProgramType, CalliopeProgramInfo } from './program-type';
export { inspectHex } from './hex-inspect';
export type { HexFlavor, HexInspection } from './hex-inspect';
export {
  classifyBleSession,
  classifyBleSessionFromDevice,
  SERVICE_UUIDS,
} from './ble-state';
export type { BleSessionKind, BleSessionClassification } from './ble-state';
export {
  MM_SFD,
  MM_REQ,
  MM_RES,
  MBIT_MORE_SERVICE_UUID,
  MbitMoreFrameParser,
  buildMbitMoreFrame,
  characteristicToChannel,
  sendMbitMoreFrameOverUsb,
  onMbitMoreFrameFromUsb,
} from './mbitmore';
export type { MbitMoreFrame } from './mbitmore';
export { initScratchBridge } from './scratch-bridge';
export { ensureBlocksRuntime } from './blocks-runtime';
export type {
  EnsureBlocksRuntimeOptions,
  EnsureBlocksRuntimeResult,
} from './blocks-runtime';

// ---- UI (Svelte 5) --------------------------------------------------------
// Components are framework-coupled; consumers need Svelte 5. Apps that don't
// use Svelte just don't import from `./ui` and stay vanilla-only.

export { default as ConnectButton } from './ui/ConnectButton.svelte';
export { default as ConnectionPanel } from './ui/ConnectionPanel.svelte';
export { default as CommsPanel } from './ui/CommsPanel.svelte';
export { default as UsbPlugRequestModal } from './ui/UsbPlugRequestModal.svelte';
export { default as UsbErrorModal } from './ui/UsbErrorModal.svelte';
export { default as ConnectionChoiceModal } from './ui/ConnectionChoiceModal.svelte';
export { default as BlePairingInfoModal } from './ui/BlePairingInfoModal.svelte';
export { default as MiniNamePattern } from './ui/MiniNamePattern.svelte';

export {
  commsEntries,
  commsPaused,
  clearComms,
  setCommsPaused,
  resetCommsParser,
} from './comms';
export type { CommsEntry, CommsDirection, CommsTransport } from './comms';
export { LogParser } from './log-parser';
export type { Parsed, ParsedHeader, ParsedRow, ParsedSeparator } from './log-parser';
export { extractFriendlyName, friendlyNameToPattern, friendlyNameFromDeviceId } from './friendly-name';
export { DEFAULT_LABELS, mergeLabels } from './ui/labels';
export type { ConnectLabels } from './ui/labels';

// ---- Initialization --------------------------------------------------------

/**
 * Wire up module side-effects: silently reconnect to a previously-permitted
 * USB Calliope on app start, and refresh the "browser remembers a paired
 * BLE device" hint. Call once in the host app's bootstrap.
 *
 * Idempotent — calling more than once is a no-op after the first run.
 */
let initialized = false;
export function initializeCalliopeConnection(): void {
  if (initialized) return;
  initialized = true;
  if (typeof window === 'undefined') return;
  attachCommsFeeds(addBleRawSubscriber, getUsbConn);
  initScratchBridge();
  // Brief delay so the page has time to settle before we fire WebUSB calls.
  setTimeout(() => {
    void tryAutoReconnectUsb();
    void tryAutoReconnectBle();
    void refreshPairedBleStatus();
  }, 250);
}

/**
 * Silently reconnect to a previously-authorized USB Calliope. Only attempts
 * a real connect when `navigator.usb.getDevices()` already returns an
 * authorized DAPLink — never prompts the user.
 */
async function tryAutoReconnectUsb(): Promise<void> {
  if (typeof navigator === 'undefined' || !('usb' in navigator)) return;
  try {
    const devices = (await (navigator as unknown as {
      usb: { getDevices(): Promise<{ vendorId: number; productId: number }[]> };
    }).usb.getDevices()) as { vendorId: number; productId: number }[];
    const authorized = devices.find(
      (d) => d.vendorId === 0x0d28 && d.productId === 0x0204,
    );
    if (!authorized) return;
    appendLog({ direction: 'info', text: 'Auto-reconnecting to authorized USB device' });
    const c = await getUsbConnection();
    await c.connect();
  } catch (err) {
    appendLog({
      direction: 'info',
      text: `USB auto-reconnect skipped: ${(err as Error)?.message ?? err}`,
    });
  }
}

/**
 * Silently reconnect to a previously-paired BLE Calliope on page load. Uses
 * `navigator.bluetooth.getDevices()` to find already-permitted devices and
 * attempts a silent connect. Bypasses `connectCalliope` so a transient
 * failure doesn't pop the stale-bond modal — if the bond really is stale
 * the user will discover that when they click "Verbinden" themselves.
 *
 * Requires the experimental WebBluetooth `getDevices()` API. Browsers that
 * don't support it just skip the auto-reconnect.
 */
async function tryAutoReconnectBle(): Promise<void> {
  if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) return;
  const bt = (navigator as { bluetooth?: { getDevices?: () => Promise<unknown[]> } }).bluetooth;
  if (!bt?.getDevices) return;
  try {
    const devices = await bt.getDevices();
    if (!devices || devices.length === 0) return;
    appendLog({ direction: 'info', text: 'Auto-reconnecting to previously-paired BLE device' });
    const c = await getBleConnection();
    await c.connect({ bondMode: 'application' });
    updateState((s) => ({ ...s, bleHasPaired: true }));
  } catch (err) {
    appendLog({
      direction: 'info',
      text: `BLE auto-reconnect skipped: ${(err as Error)?.message ?? err}`,
    });
  }
}

// Touch the `connectCalliope` import so tree-shakers don't drop it from the
// bundle when only `flashCalliope` is consumed (some internal codepaths in
// `flash.ts` end up calling connect via the lib's reconnect, but nothing
// here calls `connectCalliope` directly).
void connectCalliope;
