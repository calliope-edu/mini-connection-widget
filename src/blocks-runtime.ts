/**
 * Ensure the connected Calliope is running the blocks runtime.
 *
 * Call `ensureBlocksRuntime()` from the host when the user opens the blocks
 * editor. If the mini already reports blocks via `getRunningProgramType`,
 * it's a no-op. Otherwise the bundled `assets/blocks.hex` is loaded and
 * handed to `flashCalliope`, which routes through whichever transport is
 * active.
 *
 * Two runtime builds are bundled and chosen by detected board version:
 * `assets/blocks.hex` (CODAL, Calliope mini 3 / `V3`) and `assets/blocks-dal.hex`
 * (DAL / MbitMore, Calliope mini 1 & 2 / `V1`). Update by copying a fresh build
 * into `src/assets/`.
 */

import { flashCalliope } from './flash';
import { getRunningProgramType } from './program-type';
import { appendLog } from './log';
import { getState } from './state';
import type { CalliopeVersion } from './helpers';

type BlocksVariant = 'codal' | 'dal';

const loadPromises: Partial<Record<BlocksVariant, Promise<string>>> = {};

async function loadBundledBlocksHex(variant: BlocksVariant): Promise<string> {
  const cached = loadPromises[variant];
  if (cached) return cached;
  const promise = (async () => {
    // Vite requires a static string literal inside `new URL(..., import.meta.url)`,
    // so branch on two separate literals rather than building the path from a variable.
    const url =
      variant === 'dal'
        ? new URL('./assets/blocks-dal.hex', import.meta.url)
        : new URL('./assets/blocks.hex', import.meta.url);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Bundled ${variant} blocks hex fetch failed: ${res.status} ${res.statusText}`);
    }
    return res.text();
  })();
  loadPromises[variant] = promise;
  return promise;
}

export interface EnsureBlocksRuntimeOptions {
  /** Re-flash even if the blocks runtime is already detected. */
  force?: boolean;
  /** Project name passed to `flashCalliope`. Defaults to 'BlocksRuntime'. */
  name?: string;
  /** Probe timeout in ms. Defaults to 1500. */
  probeTimeoutMs?: number;
  /**
   * Override the board version used to pick the runtime build. Falls back to
   * the widget-detected `calliopeVersion`. `V1` → DAL (mini 1/2), else CODAL.
   */
  version?: CalliopeVersion;
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
  // Calliope mini 1 & 2 (DAL, calliopeVersion 'V1') need the MbitMore DAL
  // runtime; mini 3 (CODAL, 'V3') and the unknown/default case use the CODAL
  // build. There is no 'V2' in practice — mini 2 fingerprints as 'V1'.
  const variant: BlocksVariant =
    (options.version ?? getState().calliopeVersion) === 'V1' ? 'dal' : 'codal';
  const hex = await loadBundledBlocksHex(variant);
  appendLog({
    direction: 'info',
    text: `ensureBlocksRuntime: flashing bundled ${variant} blocks hex (detected: ${info.type})`,
  });
  // Force full DFU: the bundled blocks.hex carries no MakeCode/MicroPython
  // partial-flash marker and its DAL hash collides with a pxt-calliope app, so
  // a partial flash would either fail or silently corrupt the runtime.
  await flashCalliope(hex, options.name ?? 'BlocksRuntime', undefined, { forceFullDfu: true });
  return { flashed: true, detected: info.type };
}
