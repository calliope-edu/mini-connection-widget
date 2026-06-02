import type { BoardVersion } from '@microbit/microbit-connection';
import type { CalliopeVersion } from './helpers';
import type { CalliopeProgramType } from './program-type';
import type { BleSessionKind } from './ble-state';
import { writable, type Readable } from './store';

/** Physical channel carrying serial / flashing. Both can be open at once. */
export type CalliopeTransport = 'usb' | 'ble';

export type CalliopeStatus =
  | 'unknown'
  | 'unsupported'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'flashing'
  | 'error';

/**
 * Pre-flash phase emitted while a flash is in progress. Maps to UI affordances:
 * `check`/`reboot`/`prepare` show an indeterminate spinner with phase text;
 * `flashing` shows a 0–100% bar; `finalising` locks at 100%.
 */
export type CalliopeFlashPhase = 'check' | 'reboot' | 'prepare' | 'flashing' | 'finalising';

export interface CalliopeState {
  // ---- Per-transport state. USB and BLE are tracked independently. ----
  usbStatus: CalliopeStatus;
  usbDeviceName?: string;
  usbErrorMessage?: string;

  bleStatus: CalliopeStatus;
  bleDeviceName?: string;
  bleErrorMessage?: string;
  /** Browser remembers a previously-permitted BLE device for this origin —
   *  i.e. `navigator.bluetooth.getDevices()` would return at least one
   *  Calliope. Refreshed on init and after every successful `connect()`.
   *
   *  Used by the auto-reconnect daemon to decide whether to attempt silent
   *  reconnects on page load / post-disconnect.
   */
  bleHasPermission: boolean;
  /** Partial-flashing service exposed by the running hex (BLE flash possible). */
  bleCanFlash: boolean;
  /** UART service exposed (BLE serial communication possible). */
  bleCanCommunicate: boolean;
  /** Post-connect GATT-database fingerprint — `app-mode` if the device
   *  exposes the regular CODAL service set, `dfu-bootloader` if it's
   *  advertising as DfuTarg with only the Nordic DFU service, `unknown`
   *  otherwise. Drives the dispatcher's "skip partial flash, go straight
   *  to DFU" decision when the device is already in the bootloader. */
  bleSessionKind?: BleSessionKind;
  /** True when the user explicitly clicked "Trennen & vergessen" on BLE.
   *  Set by `disconnectAndForget('ble')`, cleared by `connectCalliope('ble')`.
   *  The reconnect daemon respects this — when the user deliberately
   *  disconnected, we don't fight them by reconnecting. */
  userDisconnectedBle: boolean;
  /** True when the user explicitly clicked "Trennen & vergessen" on USB.
   *  Mirror of `userDisconnectedBle` for the USB reconnect daemon. */
  userDisconnectedUsb: boolean;

  /** Browser support flags. */
  usbSupported: boolean;
  bleSupported: boolean;
  /** True when a native iOS/Android host owns the radio — the widget is
   *  acting as a thin UI on top of a JS bridge instead of WebBluetooth.
   *  Drives UX hints like the "über App" chip. */
  nativeMode: boolean;

  // ---- Flash state (single op at a time across both transports). ----
  flashTransport?: CalliopeTransport;
  flashProgress?: number;
  flashPhase?: CalliopeFlashPhase;
  flashPartial?: boolean;
  lastFlashName?: string;
  lastFlashAt?: number;
  /**
   * True from the moment a flash call enters the flashing dispatcher until
   * the `finally` clears it. Differs from `flashTransport` which marks the
   * data-transfer window only — `flashInProgress` covers the broader window
   * including post-flash reboot + reconnect.
   *
   * Used by USB-writing code paths (heartbeats, blocks-runtime probes,
   * serial-write helpers) to back off so they don't share the DAP `sendQueue`
   * with the flash control commands. See `usb.ts#pauseSerialDataPolling` for
   * the inner mechanism — this flag is the outer guarantee.
   */
  flashInProgress: boolean;

  boardVersion?: BoardVersion;
  calliopeVersion?: CalliopeVersion;
  connectedAt?: number;

  /**
   * Latest result of the program-type probe. `'blocks'` when the running
   * hex is the pxt-blocks runtime (real handlers wired up);
   * `'unknown'` when a non-blocks program is running; `'disconnected'`
   * when no transport is connected. Refreshed automatically whenever a
   * transport flips into/out of `'connected'` — see `program-type.ts`.
   */
  programType?: CalliopeProgramType;

  /**
   * The 5-letter Calliope friendly name (e.g. `tipov`), derived from
   * `FICR.DEVICEID[1]` over USB and from the advertised BLE name when it
   * carries the `[xxxxx]` suffix. Stable per device; once captured by
   * either transport it stays set until the user disconnects-and-forgets.
   */
  friendlyName?: string;

  /**
   * A flash request the dispatcher couldn't fulfil yet — usually because
   * no transport was connected, or BLE went into a re-pair state mid-flow.
   * The auto-resume hook in `flash.ts` watches transport-status changes
   * and re-fires `flashCalliope(hex, name)` once either USB or BLE flips
   * to `connected`, then clears this slot. Auto-expires after 60 s so a
   * stale pending flash from a previous session can't surprise the user.
   */
  pendingFlash?: {
    hex: string;
    name: string;
    createdAt: number;
    /** Transport the user explicitly picked at the connection-choice modal.
     *  When set, the dispatcher honors it instead of defaulting to USB-first
     *  routing. */
    preferredTransport?: CalliopeTransport;
    /** Carried through so the auto-resume preserves it. Without this a
     *  forced-full-DFU flash (e.g. the Blocks runtime) deferred until connect
     *  resumes WITHOUT the flag and can be BLE-partial-flashed → corruption. */
    forceFullDfu?: boolean;
  };

  /**
   * Roll-up status — `flashing` if a flash is in flight, else `connected`
   * if either transport is connected, else `connecting`/`error`/`disconnected`.
   * Recomputed by `updateState` after every mutation.
   */
  status: CalliopeStatus;
}

/**
 * True when a native host (iOS WKScriptMessageHandler / Android
 * addJavascriptInterface) has injected a Calliope bridge. Detected here
 * locally rather than imported from `./native-bridge` to keep this module
 * dependency-free (it sits at the bottom of the import graph).
 */
function hasNativeBridge(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    CalliopeNative?: { postMessage?: unknown };
    webkit?: { messageHandlers?: { calliope?: { postMessage?: unknown } } };
  };
  if (typeof w.CalliopeNative?.postMessage === 'function') return true;
  if (typeof w.webkit?.messageHandlers?.calliope?.postMessage === 'function') return true;
  return false;
}

export const NATIVE_MODE = hasNativeBridge();

// In native mode the host owns the radio. iOS WKWebView has no WebUSB and
// no Web Bluetooth at all; Android WebView has WebUSB only — but the proxy
// is the supported path on both, so present it as "BLE supported" and let
// USB lie dormant. The connection panel uses these to pick which transport
// rows to render.
const usbSupported =
  !NATIVE_MODE && typeof navigator !== 'undefined' && 'usb' in navigator;
const bleSupported =
  NATIVE_MODE || (typeof navigator !== 'undefined' && 'bluetooth' in navigator);

export const SUPPORT = { usb: usbSupported, ble: bleSupported };

function recomputeOverall(s: CalliopeState): CalliopeState {
  let status: CalliopeStatus;
  if (s.flashTransport) status = 'flashing';
  else if (s.usbStatus === 'connected' || s.bleStatus === 'connected') status = 'connected';
  else if (s.usbStatus === 'connecting' || s.bleStatus === 'connecting') status = 'connecting';
  else if (s.usbStatus === 'error' || s.bleStatus === 'error') status = 'error';
  else if (!s.usbSupported && !s.bleSupported) status = 'unsupported';
  else status = 'disconnected';
  return { ...s, status };
}

const initial: CalliopeState = recomputeOverall({
  usbStatus: usbSupported ? 'disconnected' : 'unsupported',
  bleStatus: bleSupported ? 'disconnected' : 'unsupported',
  bleHasPermission: false,
  bleCanFlash: false,
  bleCanCommunicate: false,
  userDisconnectedBle: false,
  userDisconnectedUsb: false,
  flashInProgress: false,
  usbSupported,
  bleSupported,
  nativeMode: NATIVE_MODE,
  status: 'disconnected',
});

const _state = writable<CalliopeState>(initial);
export const calliopeState: Readable<CalliopeState> = { subscribe: _state.subscribe };

/**
 * Mutate state via an updater function. Always re-derives the overall `status`
 * field so external consumers see a consistent view. This is the *only* way
 * the package writes to `calliopeState` — keep all mutations going through
 * here so future native-proxy mode can override it cleanly.
 */
export function updateState(fn: (s: CalliopeState) => CalliopeState): void {
  _state.update((s) => recomputeOverall(fn(s)));
}

/** One-shot read of the current state. */
export function getState(): CalliopeState {
  let v: CalliopeState = initial;
  const unsub = _state.subscribe((x) => { v = x; });
  unsub();
  return v;
}
