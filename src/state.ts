import type { BoardVersion } from '@microbit/microbit-connection';
import type { CalliopeVersion } from './helpers';
import type { CalliopeProgramType } from './program-type';
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
  /** Browser remembers a previously-permitted BLE device for this origin. */
  bleHasPaired: boolean;
  /** Partial-flashing service exposed by the running hex (BLE flash possible). */
  bleCanFlash: boolean;
  /** UART service exposed (BLE serial communication possible). */
  bleCanCommunicate: boolean;
  /** Connected over BLE to a previously-paired device but authenticated
   *  services are inaccessible — i.e. OS still holds a bond, but the
   *  Calliope has forgotten its whitelist (typical after USB full-flash).
   *  The fix is OS-side: forget + re-pair. */
  bleStaleBond: boolean;

  /** Browser support flags. */
  usbSupported: boolean;
  bleSupported: boolean;

  // ---- Flash state (single op at a time across both transports). ----
  flashTransport?: CalliopeTransport;
  flashProgress?: number;
  flashPhase?: CalliopeFlashPhase;
  flashPartial?: boolean;
  lastFlashName?: string;
  lastFlashAt?: number;

  boardVersion?: BoardVersion;
  calliopeVersion?: CalliopeVersion;
  connectedAt?: number;

  /**
   * Latest result of the program-type probe. `'blocks'` when the running
   * hex is the pxt-blocks / MbitMore runtime (real handlers wired up);
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
  };

  /**
   * Roll-up status — `flashing` if a flash is in flight, else `connected`
   * if either transport is connected, else `connecting`/`error`/`disconnected`.
   * Recomputed by `updateState` after every mutation.
   */
  status: CalliopeStatus;
}

const usbSupported =
  typeof navigator !== 'undefined' && 'usb' in navigator;
const bleSupported =
  typeof navigator !== 'undefined' && 'bluetooth' in navigator;

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
  bleHasPaired: false,
  bleCanFlash: false,
  bleCanCommunicate: false,
  bleStaleBond: false,
  usbSupported,
  bleSupported,
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
