/**
 * Editor-fed content slot for the global `<ConnectionBanner />`.
 *
 * The banner owns CONNECTION states (no device → USB/BLE choice, connecting,
 * the USB recovery ladder). But some banner messages are editor-specific and
 * only the host knows them — e.g. the Blocks editor's "this Calliope isn't
 * running a Blocks program, flash it" / "Blocks firmware is outdated" /
 * "inputs are warming up" prompts, which depend on a probe + version handshake
 * the widget doesn't run.
 *
 * Rather than give those their own (second) banner, the host pushes them here
 * and the ONE banner renders them — but only when nothing more urgent (a
 * connection problem) is happening. So the user never sees two banners at once.
 *
 * Set `null` to clear (e.g. on disconnect or once the program is up to date).
 */

import { writable, type Readable } from './store';

export interface BannerExtraAction {
  label: string;
  /** Label while the action's promise is in flight (e.g. "Lade…"). */
  busyLabel?: string;
  /** Button color, following the transport palette: 'usb' = green (default),
   *  'ble' = blue. Use 'ble' for actions that open the Bluetooth chooser. */
  variant?: 'usb' | 'ble';
  run: () => void | Promise<void>;
}

export interface BannerExtra {
  /**
   * Stable identity for this piece of content. A changed `id` re-shows the
   * banner even if the user had dismissed the previous one; the same `id`
   * keeps a dismissal sticky. Use it to encode "what this is about" (e.g.
   * `blocks:not-blocks`, `blocks:outdated`).
   */
  id: string;
  /**
   * Visual weight:
   *  - `action`  — the user should do something (orange accent + primary button)
   *  - `loading` — transient, neutral (spinner, no action)
   *  - `info`    — neutral note
   */
  tone: 'action' | 'loading' | 'info';
  title: string;
  detail?: string;
  action?: BannerExtraAction;
  /** Show an "Ausblenden" affordance. */
  dismissible?: boolean;
}

const _extra = writable<BannerExtra | null>(null);
/** Current editor-fed banner content, or `null`. */
export const connectionBannerExtra: Readable<BannerExtra | null> = { subscribe: _extra.subscribe };

/** Replace (or clear, with `null`) the editor-fed banner content. */
export function setBannerExtra(extra: BannerExtra | null): void {
  _extra.set(extra);
}

// ---- Connection-prompt context -------------------------------------------
//
// The banner is mounted app-wide, but a *proactive* "no device → connect"
// prompt only makes sense where a device is relevant (an editor). Without this
// the choice banner would sit on the dashboard / room list too. Editors flip
// this on while they're the visible context; the banner only shows the
// no-connection / connecting choice when it's true. Reactive states that follow
// a real event — the USB recovery ladder, an in-flight connect — show
// regardless, so a dropped session is never silently swallowed.

const _uiActive = writable<boolean>(false);
/** True while an editor wants the user to (be able to) connect a device. */
export const connectionUiActive: Readable<boolean> = { subscribe: _uiActive.subscribe };

/** Editors set this true while visible/active, false on hide/unmount. */
export function setConnectionUiActive(active: boolean): void {
  _uiActive.set(active);
}

// ---- Banner placement -----------------------------------------------------
//
// The single banner is mounted once, app-wide, but a host can ask for it to be
// portaled into a specific element (e.g. an editor's content area) so it lives
// inside that editor instead of floating over the whole page. The consumer
// passes this to `<ConnectionBanner container={...} />`; `null` = the default
// fixed top-centre toast. An editor sets it to its content element while active
// and clears it (null) on hide/unmount.

const _container = writable<HTMLElement | null>(null);
/** Host element to portal the banner into, or `null` for the page-level toast. */
export const connectionBannerContainer: Readable<HTMLElement | null> = { subscribe: _container.subscribe };

/** Set (or clear, with `null`) the element the banner should be portaled into. */
export function setBannerContainer(el: HTMLElement | null): void {
  _container.set(el);
}

// ---- "Transfer current program" action ------------------------------------
//
// A persistent "Programm übertragen" button shown in the connection panel while
// a transport is connected. What it does is editor-specific (Blocks flashes its
// runtime hex; MakeCode/Python ask their editor for the compiled hex), so the
// active editor registers the action and the panel just renders the button.

export interface TransferProgram {
  /** Flash the active editor's current program to the connected Calliope. */
  run: () => void | Promise<void>;
  /** Optional button label; defaults to "Programm übertragen". */
  label?: string;
}

const _transfer = writable<TransferProgram | null>(null);
/** The active editor's "transfer current program" action, or `null`. */
export const connectionTransferProgram: Readable<TransferProgram | null> = { subscribe: _transfer.subscribe };

// Owner-gated: the active editor registers `(its-id, action)`; on deactivate /
// unmount it clears with its id, which is a no-op if another editor has since
// taken over. This keeps an editor switch race-free (the two editors' effects
// fire in arbitrary order) and stops a stale registration leaking into an editor
// that has no transfer action of its own.
let transferOwner: string | null = null;
/** Editors register (`t`) or clear (`null`) how to flash their current program. */
export function setTransferProgram(owner: string, t: TransferProgram | null): void {
  if (t) {
    transferOwner = owner;
    _transfer.set(t);
  } else if (transferOwner === owner) {
    transferOwner = null;
    _transfer.set(null);
  }
}

// ---- "Re-arm inputs" action (dev-only) ------------------------------------
//
// A safety-net action for the Blocks editor: re-arm the running program's touch
// pads / pin events without a full reconnect. It exists because arming can
// occasionally fail to complete in the editor's VM (a pad armed on-device but
// not recorded), leaving an input that never fires. The real fix lives in the
// VM (the arming reconcile); this button is the manual escape hatch, so the
// panel only shows it in dev mode (`advanced`). The active editor registers how
// to run it (Blocks posts a re-arm message to its iframe); the panel renders the
// button. Owner-gated exactly like setTransferProgram.

export interface RearmInputs {
  /** Re-arm the active editor's program inputs on the connected Calliope. */
  run: () => void | Promise<void>;
  /** Optional button label; defaults to "Eingänge neu verbinden". */
  label?: string;
}

const _rearm = writable<RearmInputs | null>(null);
/** The active editor's "re-arm inputs" action, or `null`. */
export const connectionRearmInputs: Readable<RearmInputs | null> = { subscribe: _rearm.subscribe };

let rearmOwner: string | null = null;
/** Editors register (`r`) or clear (`null`) how to re-arm their program inputs. */
export function setRearmInputs(owner: string, r: RearmInputs | null): void {
  if (r) {
    rearmOwner = owner;
    _rearm.set(r);
  } else if (rearmOwner === owner) {
    rearmOwner = null;
    _rearm.set(null);
  }
}
