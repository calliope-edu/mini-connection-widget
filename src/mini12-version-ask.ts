import { writable, type Readable } from './store';

/**
 * "Which Calliope mini is this — 1 or 2?" modal request.
 *
 * Over BLE, mini 1 and mini 2 are indistinguishable (identical DAL service
 * set → `versionAmbiguous` in state.ts). That only ever matters when a flash
 * would go wrong on one of them: a 32 KB-RAM hex (see
 * `detectHexRamClass` in hex-inspect.ts) runs only on the mini 2. Before a
 * BLE flash of such a hex to an ambiguous device, the dispatcher raises this
 * request and the user settles it. USB connections never need to ask — the
 * interface chip (DAPLink vs J-Link) is definitive.
 */
export type Mini12VersionAnswer = 'V1' | 'V2' | 'cancel';

export interface Mini12VersionAskRequest {
  /** Name of the program whose flash is waiting on the answer. */
  fileName: string;
  choose: (answer: Mini12VersionAnswer) => void;
}

const _req = writable<Mini12VersionAskRequest | null>(null);
/** Current ask, or `null`. Render `Mini12VersionModal` off this. */
export const mini12VersionAskRequest: Readable<Mini12VersionAskRequest | null> = {
  subscribe: _req.subscribe,
};

/** Ask the user which mini 1/2 hardware is connected. */
export function awaitMini12VersionAnswer(fileName: string): Promise<Mini12VersionAnswer> {
  return new Promise((resolve) => {
    _req.set({
      fileName,
      choose: (answer) => { _req.set(null); resolve(answer); },
    });
  });
}
