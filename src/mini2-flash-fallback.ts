import { writable, type Readable } from './store';

/**
 * "The mini 2 USB flash failed — what now?" modal request.
 *
 * Fires from `flashJLinkDevice` (usb.ts) after the SEGGER MSD path failed
 * despite an automatic retry. The old behaviour buried the download+drag hint
 * as an inline red line in the connection panel (where the state roll-up could
 * even swallow it); this modal makes the fallback explicit and actionable:
 *
 *   - `retry`    — run the J-Link flash again (same device, same hex).
 *   - `download` — save the hex to disk so the user can drag it onto the
 *                  MINI drive themselves (the always-works path).
 *   - `cancel`   — give up; drop the flash intent.
 */
export type Mini2FlashChoice = 'retry' | 'download' | 'cancel';

export interface Mini2FlashFallbackRequest {
  fileName: string;
  /** Technical failure detail (last error message) — shown small, helps support. */
  errorDetail?: string;
  /** How many attempts already failed (≥ 2 — the auto-retry counts). */
  attempts: number;
  choose: (choice: Mini2FlashChoice) => void;
}

const _req = writable<Mini2FlashFallbackRequest | null>(null);
/** Current fallback request, or `null`. Render `Mini2FlashFallbackModal` off this. */
export const mini2FlashFallbackRequest: Readable<Mini2FlashFallbackRequest | null> = {
  subscribe: _req.subscribe,
};

/** Ask the user how to proceed after a failed mini 2 USB flash. */
export function awaitMini2FlashChoice(
  fileName: string,
  attempts: number,
  errorDetail?: string,
): Promise<Mini2FlashChoice> {
  return new Promise((resolve) => {
    _req.set({
      fileName,
      attempts,
      errorDetail,
      choose: (choice) => { _req.set(null); resolve(choice); },
    });
  });
}
