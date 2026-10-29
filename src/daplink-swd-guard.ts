/**
 * Don't take the SWD port back from DAPLink while it is flashing a file that
 * was dropped onto the MINI drive.
 *
 * DAPLink programs a drag&drop hex over the same SWD lines our CMSIS-DAP
 * session uses, and it does so without telling the host: `target_flash_init`
 * → `swd_init` → `DAP_Setup()` simply disables the CMSIS-DAP debug port under
 * us. From then on every DAP transfer we send is answered by a dummy handler
 * (no SWD traffic, `DAP_WriteABORT` → "Bad status for 8 -> 255"), so the
 * Blocks/IoT exchange loops see a "mid-loop SWD fault" — the same signature as
 * a RESET-button press.
 *
 * Their recovery used to be an unconditional `adi.reinit()` ~2 s later. That
 * re-sends DAP_Connect, line-resets the SWD bus and re-powers the debug port
 * right in the middle of DAPLink's page programming, and DAPLink aborts with
 * FAIL.TXT ("Failed to download the flash data contents to be programmed", or
 * "The transfer timed out." once the host keeps it busy long enough). Reproduced
 * on a Calliope mini 3 (DAPLink 0258) with the Blocks editor's live comms open.
 *
 * The tell that DAPLink still owns the bus: it holds the core HALTED for the
 * whole programming window (reset-and-halt in `target_flash_init`, then halted
 * at the flash algorithm's breakpoint between pages). A RESET press, by
 * contrast, leaves the core running within milliseconds. So before a
 * fault-triggered reinit we look at DHCSR.S_HALT with the gentlest probe there
 * is — DAP_Connect (re-enables our port, no line reset) plus one memory read
 * with the same CSW/SELECT values DAPLink uses — and keep the bus quiet while
 * the core stays halted. When DAPLink is done it resets the target into the new
 * program (running) and the normal reinit + rescan path takes over.
 */

import { appendLog } from './log';
import { withDapBus } from './dap-arbiter';

const DHCSR = 0xe000edf0;
const S_HALT = 1 << 17;

/** Probe cadence while DAPLink holds the core halted. */
const PROBE_INTERVAL_MS = 1000;
/**
 * Give up waiting after this long and reinit anyway. A full universal hex takes
 * well under a minute on the drive; a core that stays halted much longer is
 * held by something else (a debugger, a crashed flash stub), and live comms
 * should not stay dead forever because of it.
 */
const MAX_WAIT_MS = 120_000;

/** The slice of @microbit/microbit-connection's ArmDebug the probe needs. */
export interface SwdGuardAdi {
  /** The CMSIS-DAP layer; `connect()` sends DAP_Connect only (no SWJ sequence). */
  readonly dap?: { connect(): Promise<void> };
  readMem32?(address: number): Promise<number>;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One probe: is the core halted, i.e. is DAPLink (most likely a drag&drop
 * flash) still driving the target? Any failure answers `false` — we then fall
 * back to the old behaviour (reinit), which is what a dropped or rebooting
 * target needs anyway.
 */
export async function isTargetHeldHalted(adi: SwdGuardAdi): Promise<boolean> {
  const dap = adi.dap;
  const readMem32 = adi.readMem32?.bind(adi);
  if (!dap || typeof dap.connect !== 'function' || !readMem32) return false;
  try {
    return await withDapBus(async () => {
      await dap.connect();
      const dhcsr = await readMem32(DHCSR);
      return (dhcsr & S_HALT) !== 0;
    });
  } catch {
    return false;
  }
}

let waiting: Promise<void> | null = null;

/**
 * Resolve once the target is no longer held halted (or after MAX_WAIT_MS).
 * Single-flight: every exchange loop that faulted at the same moment awaits the
 * same wait, so the bus sees one probe per interval, not one per loop.
 */
export function waitForDaplinkSwdRelease(adi: SwdGuardAdi): Promise<void> {
  if (!waiting) {
    waiting = runWait(adi).finally(() => {
      waiting = null;
    });
  }
  return waiting;
}

async function runWait(adi: SwdGuardAdi): Promise<void> {
  const start = Date.now();
  let held = false;
  while (await isTargetHeldHalted(adi)) {
    if (!held) {
      held = true;
      appendLog({
        direction: 'info',
        text: 'USB: target is halted by DAPLink (file dropped on the MINI drive?) — keeping SWD quiet until it finishes',
      });
    }
    if (Date.now() - start > MAX_WAIT_MS) {
      appendLog({ direction: 'info', text: 'USB: target still halted after 2 min — reconnecting the debug session anyway' });
      return;
    }
    await delay(PROBE_INTERVAL_MS);
  }
  if (held) {
    appendLog({
      direction: 'info',
      text: `USB: DAPLink released the target after ${Math.round((Date.now() - start) / 1000)} s — reconnecting the debug session`,
    });
  }
}
