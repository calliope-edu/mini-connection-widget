/**
 * Ensure the connected Calliope is running the blocks (MbitMore) runtime.
 *
 * Call `ensureBlocksRuntime()` from the host when the user opens the blocks
 * editor. If the mini already reports blocks via `getRunningProgramType`,
 * it's a no-op. Otherwise the bundled `assets/blocks.hex` is loaded and
 * handed to `flashCalliope`, which routes through whichever transport is
 * active.
 *
 * The bundled hex tracks `calliope-edu/pxt-blocks` and targets Calliope
 * mini 3 (CODAL). Update by copying a fresh build into `src/assets/`.
 */

import { flashCalliope } from './flash';
import { getRunningProgramType } from './program-type';
import { appendLog } from './log';

let loadPromise: Promise<string> | null = null;

async function loadBundledBlocksHex(): Promise<string> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const url = new URL('./assets/blocks.hex', import.meta.url);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Bundled blocks.hex fetch failed: ${res.status} ${res.statusText}`);
    }
    return res.text();
  })();
  return loadPromise;
}

export interface EnsureBlocksRuntimeOptions {
  /** Re-flash even if the blocks runtime is already detected. */
  force?: boolean;
  /** Project name passed to `flashCalliope`. Defaults to 'BlocksRuntime'. */
  name?: string;
  /** Probe timeout in ms. Defaults to 1500. */
  probeTimeoutMs?: number;
}

export interface EnsureBlocksRuntimeResult {
  /** Whether a flash actually took place. */
  flashed: boolean;
  /** What `getRunningProgramType` reported before any flash. */
  detected: 'blocks' | 'unknown' | 'disconnected';
}

/**
 * Confirm the blocks runtime is on the connected mini; flash the bundled
 * hex if not. Throws when no device is connected, or if flashing fails.
 */
export async function ensureBlocksRuntime(
  options: EnsureBlocksRuntimeOptions = {},
): Promise<EnsureBlocksRuntimeResult> {
  const info = await getRunningProgramType(options.probeTimeoutMs ?? 1500);
  if (info.type === 'disconnected') {
    throw new Error('Kein Calliope verbunden — Blocks-Runtime kann nicht sichergestellt werden.');
  }
  if (info.type === 'blocks' && !options.force) {
    return { flashed: false, detected: 'blocks' };
  }
  const hex = await loadBundledBlocksHex();
  appendLog({
    direction: 'info',
    text: `ensureBlocksRuntime: flashing bundled blocks.hex (detected: ${info.type})`,
  });
  await flashCalliope(hex, options.name ?? 'BlocksRuntime');
  return { flashed: true, detected: info.type };
}
