import { writable, type Readable } from './store';
import { calliopeState, getState } from './state';
import { connectJLinkSerial } from './web-serial';

/**
 * Mini 2 "add the serial link?" offer.
 *
 * A mini 2 can be connected flash-only (`jlinkUsbStatus` connected, CDC serial
 * not) — e.g. because the user dismissed the second (Web Serial) picker during
 * connect. Flashing works fine in that state; serial comms don't. Most editors
 * only ever flash over USB, so we don't nag. But when an editor that actually
 * consumes serial (MakeCode's monitor, MicroPython's REPL) is active, offer to
 * complete the link via a modal — once per connection, dismissible.
 *
 * The host declares the active editor's serial interest via
 * `setSerialConsumer(owner, wantsSerial)` (owner-gated exactly like
 * `setTransferProgram`). The watcher below turns
 * "serial-consuming editor active + mini 2 flash-only" into an offer request;
 * the host renders `Mini2SerialOfferModal` off `mini2SerialOfferRequest`.
 * Accepting runs `connectJLinkSerial()` from the modal's button click — a
 * user gesture, as `requestPort` requires.
 */

// ---- Host-declared serial interest -----------------------------------------

const _consumer = writable<string | null>(null);
/** Id of the active serial-consuming editor, or `null` when none. */
export const serialConsumer: Readable<string | null> = { subscribe: _consumer.subscribe };

let consumerOwner: string | null = null;
/**
 * Declare (or retract, with `false`) that the active editor consumes device
 * serial. Owner-gated: an editor's `false` on unmount is a no-op if another
 * editor has since taken over, so editor switches are race-free.
 */
export function setSerialConsumer(owner: string, wantsSerial: boolean): void {
  if (wantsSerial) {
    consumerOwner = owner;
    _consumer.set(owner);
  } else if (consumerOwner === owner) {
    consumerOwner = null;
    _consumer.set(null);
  }
}

// ---- Offer request ----------------------------------------------------------

export interface Mini2SerialOfferRequest {
  /** Connect the CDC serial port. Runs inside the modal's click handler. */
  accept: () => Promise<void>;
  /** Dismiss — don't ask again for this connection/editor combination. */
  decline: () => void;
}

const _offer = writable<Mini2SerialOfferRequest | null>(null);
/** Current offer, or `null`. Render `Mini2SerialOfferModal` off this. */
export const mini2SerialOfferRequest: Readable<Mini2SerialOfferRequest | null> = {
  subscribe: _offer.subscribe,
};

// Ask at most once per (connection, editor): declining latches until the mini 2
// disconnects or a different serial-consuming editor becomes active.
let declinedFor: string | null = null;

function maybeOffer(): void {
  const s = getState();
  let consumer: string | null = null;
  const unsub = _consumer.subscribe((v) => { consumer = v; });
  unsub();

  const flashOnly =
    s.jlinkUsbStatus === 'connected'
    && s.jlinkSerialStatus !== 'connected'
    && s.jlinkSerialStatus !== 'connecting'
    && !s.flashInProgress;

  if (!consumer || !flashOnly) {
    // Situation resolved (serial up, device gone, editor left) — retract a
    // stale offer so the modal never outlives its reason.
    _offer.set(null);
    // A fresh connection deserves a fresh ask.
    if (s.jlinkUsbStatus !== 'connected') declinedFor = null;
    return;
  }
  if (declinedFor === consumer) return;

  let current: Mini2SerialOfferRequest | null = null;
  const unsubOffer = _offer.subscribe((v) => { current = v; });
  unsubOffer();
  if (current) return; // already showing

  const consumerAtOffer = consumer;
  _offer.set({
    accept: async () => {
      _offer.set(null);
      await connectJLinkSerial();
    },
    decline: () => {
      declinedFor = consumerAtOffer;
      _offer.set(null);
    },
  });
}

if (typeof window !== 'undefined') {
  calliopeState.subscribe(() => maybeOffer());
  _consumer.subscribe(() => maybeOffer());
}
