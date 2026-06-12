/**
 * Ensure the connected Calliope is running the blocks runtime.
 *
 * The blocks-runtime hex is the on-device counterpart of the Blocks editor's
 * wire protocol (the MbitMore-derived GATT/serial service scratch-vm drives),
 * so it is owned and shipped by the EDITOR (calliope-campus), NOT bundled in
 * the widget. That keeps the firmware in lockstep with the editor it talks to
 * and prevents the hex from silently drifting out of sync with the protocol.
 *
 * The host/editor therefore supplies `loadHex(variant)`; this module only
 * decides which variant the connected board needs ('dal' for mini 1/2, 'codal'
 * for mini 3) and drives the flash through whichever transport is active.
 *
 * Call `ensureBlocksRuntime()` from the host when the user opens the blocks
 * editor. If the mini already reports blocks via `getRunningProgramType`, it's
 * a no-op. Otherwise the editor-provided hex is loaded and handed to
 * `flashCalliope`, which routes through whichever transport is active.
 */

import { flashCalliope } from './flash';
import { getRunningProgramType } from './program-type';
import { appendLog } from './log';
import { getState } from './state';
import type { CalliopeVersion } from './helpers';

export type BlocksVariant = 'codal' | 'dal';

export interface EnsureBlocksRuntimeOptions {
  /**
   * Loader for the blocks-runtime hex, supplied by the host/editor (which owns
   * the hex assets). Receives the variant chosen for the connected board and
   * returns the Intel-hex text. Required — the widget no longer bundles the hex.
   */
  loadHex: (variant: BlocksVariant) => Promise<string>;
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
 * Confirm the blocks runtime is on the connected mini; flash the
 * editor-provided hex if not. Throws when no device is connected, if flashing
 * fails, or if `options.loadHex` is not supplied.
 */
export async function ensureBlocksRuntime(
  options: EnsureBlocksRuntimeOptions,
): Promise<EnsureBlocksRuntimeResult> {
  if (!options || typeof options.loadHex !== 'function') {
    throw new Error(
      'ensureBlocksRuntime requires options.loadHex — the blocks hex is owned by the editor, not the widget.',
    );
  }
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
  const hex = await options.loadHex(variant);
  appendLog({
    direction: 'info',
    text: `ensureBlocksRuntime: flashing ${variant} blocks hex (detected: ${info.type})`,
  });
  // Force full DFU: the blocks hex carries no MakeCode/MicroPython partial-flash
  // marker and its DAL hash collides with a pxt-calliope app, so a partial flash
  // would either fail or silently corrupt the runtime.
  await flashCalliope(hex, options.name ?? 'BlocksRuntime', undefined, { forceFullDfu: true });
  return { flashed: true, detected: info.type };
}
