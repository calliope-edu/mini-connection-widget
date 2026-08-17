/**
 * The iframe `src` for an embedded MakeCode editor.
 *
 * Every query param here is load-bearing; the comments say why. Getting
 * `parentOrigin` wrong in particular is the difference between a working
 * simulator-message bridge and one whose frames are silently dropped.
 */
import { createMakeCodeURL } from '@microbit/makecode-embed/vanilla';

export interface MakeCodeIframeUrlOptions {
  /** Editor origin, e.g. 'https://makecode.calliope.cc'. Trailing slash ok. */
  baseUrl: string;
  /** UI language for the editor (`lang=`). */
  lang?: string;
  /**
   * Bumped to force the browser to re-navigate the iframe to a URL it would
   * otherwise consider identical — the editor-reload recovery path.
   */
  retry?: number;
  /**
   * pxt-arcade-style hardware selector (`hw=`). Leave unset for pxt-calliope,
   * where the board revision rides in the project's v1/v2/v3 dependency
   * instead — see `setHardwareVersion`.
   */
  hardwareVariant?: string | null;
  /** Extra params merged last, so a caller can always override. */
  extraParams?: Record<string, string>;
}

export function makeCodeIframeUrl(opts: MakeCodeIframeUrlOptions): string {
  const queryParams: Record<string, string> = {
    hidemenu: '1',
    nocookiebanner: '1',
  };

  if (opts.retry !== undefined) {
    queryParams.retry = String(opts.retry);
  }

  // Declare our origin so the embedded editor whitelists this host in pxt's
  // simulator message allow-list (SimulatorDriver `_allowedOrigins`). Without
  // it, the editor drops the `messagepacket` relays we post from this
  // cross-origin host — e.g. the Jacdac bridge frames. (createMakeCodeURL uses
  // URLSearchParams.set, which URL-encodes the value, so pass the raw origin.)
  //
  // NOTE: pxt forwards this same origin to any simulator-extension iframe as
  // its `parentOrigin`. A simx that validates message origins (the Jacdac
  // dashboard does) only accepts the editor's forwarded frames once pxt hands
  // the simx its *real* parent (the editor) origin instead of this grandparent
  // origin — microsoft/pxt#11446. So this line is the editor-side half; the
  // dashboard stays dead until a pxt carrying that fix is deployed. Do NOT
  // "fix" this by dropping the param: it is also what puts the host in the
  // editor's `_allowedOrigins`, and without it the editor drops our frames.
  if (typeof window !== 'undefined' && window.location?.origin) {
    queryParams.parentOrigin = window.location.origin;
  }

  // Local dev only. pxt derives a simulator extension's URL from the simulator
  // origin (`<sim>/simx/<repo>/-/index.html`), which a locally served editor
  // does not host — so the Jacdac dashboard 404s against `pxt serve`. `simxdev`
  // makes pxt use the extension's `devUrl` from targetconfig.json instead
  // (jacdac.github.io for pxt-jacdac). pxt ignores the flag unless the editor
  // itself is on localhost, so this is inert against the hosted editor.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|\d+\.\d+\.\d+\.\d+)(:|\/|$)/i.test(opts.baseUrl)) {
    queryParams.simxdev = '1';
  }

  // Arcade stores the selected hardware (e.g. the Calliope GameKit shield)
  // in an in-memory module variable *inside* the editor (pxt.setHwVariant),
  // NOT in the project's pxt.json — unlike pxt-calliope, where the board
  // revision rides in the `v1`/`v2`/`v3` dependency. So there is nothing we
  // can bake into the saved project to preselect it, and there is no
  // controller=2 postMessage action for it either. The only host-side hook
  // pxt exposes is the `hw=` URL param, which it reads on boot and feeds to
  // setHwVariant — hence it must be re-applied on every editor load.
  if (opts.hardwareVariant) {
    queryParams.hw = opts.hardwareVariant;
  }

  Object.assign(queryParams, opts.extraParams ?? {});

  // controller=2 lets MakeCode emit onDownload to us instead of writing a file.
  return createMakeCodeURL(
    opts.baseUrl.replace(/\/$/, ''),
    undefined,
    opts.lang,
    2,
    queryParams,
  );
}

/** The origin messages from this editor will arrive on / must be posted to. */
export function makeCodeEditorOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin;
}
