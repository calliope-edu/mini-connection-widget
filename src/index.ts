/**
 * @calliope-edu/calliope-connection — staged-locally entry point.
 *
 * Vanilla TypeScript wrapper around `@microbit/microbit-connection` that
 * orchestrates the higher-level Calliope lifecycle: simultaneous USB+BLE
 * tracking, smart picker resets, USB-first flash routing (USB > BLE > USB-
 * plug prompt), forever-running reconnect daemon, and a Svelte-compatible
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
import { registerSerialDataListener } from './usb';
import { addBleRawSubscriber, refreshPairedBleStatus } from './ble';
import { attachCommsFeeds } from './comms';
import { installReconnectDaemon, triggerReconnectEvaluation } from './reconnect-daemon';
import { isNativeMode, installNativeApi } from './native-bridge';

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
export { calliopeUsbPlugRequest } from './usb-plug';
export { calliopeUsbErrorInfo, dismissUsbErrorInfo } from './usb-error-info';
export { calliopeBleOfflineInfo, dismissBleOfflineInfo, showBleOfflineInfo } from './ble-offline-info';
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
  BLOCKS_SFD,
  BLOCKS_REQ,
  BLOCKS_RES,
  BLOCKS_SERVICE_UUID,
  BlocksFrameParser,
  buildBlocksFrame,
  characteristicToChannel,
  sendBlocksFrameOverUsb,
  onBlocksFrameFromUsb,
} from './blocks-protocol';
export type { BlocksFrame } from './blocks-protocol';
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
export { default as BleOfflineModal } from './ui/BleOfflineModal.svelte';
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

// ---- Native-proxy bridge --------------------------------------------------
// Detection + GATT/serial proxy helpers for iOS/Android hosts that inject
// a JS bridge. In web mode `isNativeMode()` is `false` and the helpers
// reject — consumers should branch on `isNativeMode()` themselves.
export { isNativeMode } from './native-bridge';
export {
  nativeGattRead,
  nativeGattWrite,
  nativeGattSubscribe,
} from './native-mode';

// ---- Initialization --------------------------------------------------------

/**
 * Wire up module side-effects: refresh the "browser remembers a permitted
 * BLE device" hint and arm the reconnect daemon that will keep both
 * transports alive throughout the session. Call once in the host app's
 * bootstrap.
 *
 * Idempotent — calling more than once is a no-op after the first run.
 */
let initialized = false;
export function initializeCalliopeConnection(): void {
  if (initialized) return;
  initialized = true;
  if (typeof window === 'undefined') return;
  if (isNativeMode()) {
    // Native host owns scanning, bonding, USB enumeration, and reconnect.
    // We only install the inbound event surface so the host can push
    // state/log/gatt/serial events back. No daemon, no Web Bluetooth /
    // WebUSB calls — those APIs don't exist in iOS WKWebView anyway.
    installNativeApi();
    return;
  }
  attachCommsFeeds(addBleRawSubscriber, registerSerialDataListener);
  installReconnectDaemon();
  // Brief delay so the page has time to settle before we fire WebUSB calls.
  setTimeout(async () => {
    // Refresh the BLE permission flag first — the daemon's BLE side checks
    // `bleHasPermission` before doing anything.
    await refreshPairedBleStatus();
    // Now kick the daemon. It will try both transports on its own schedule.
    triggerReconnectEvaluation();
  }, 250);
}

// Touch the `connectCalliope` import so tree-shakers don't drop it from the
// bundle when only `flashCalliope` is consumed.
void connectCalliope;
