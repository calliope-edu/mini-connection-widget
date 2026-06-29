/**
 * Single-owner arbiter for the shared CMSIS-DAP / ArmDebug bus.
 *
 * The widget holds ONE ArmDebug handle, and its readBlock/writeBlock are NOT
 * atomic across concurrent callers: each transfers a chunk at a time, resetting
 * the AP transfer-address register (TAR) per chunk (see microbit-connection
 * arm-debug.js readBlock/writeBlock). Two exchange loops running at once clobber
 * each other's TAR mid-flight and read arbitrary memory — garbage frames.
 *
 * So only ONE DAP exchange transport may be live at a time:
 *   - 'jacdac' — the MakeCode editor's Jacdac relay (jacdac.ts)
 *   - 'blocks' — the Blocks editor's Blocks-DAP transport (blocks-dap.ts)
 *
 * The host (calliope-campus) sets the owner to match the ACTIVE editor. Each
 * transport listens via `onDapOwnerChange` and tears its loop down the moment it
 * loses the bus, and its send path goes inert until it regains ownership. `null`
 * means no editor owns the bus (neither loop should run).
 */
export type DapOwner = 'jacdac' | 'blocks' | null;

let owner: DapOwner = null;
const listeners = new Set<(o: DapOwner) => void>();

/** The transport that currently owns the DAP bus (or null). */
export function getDapOwner(): DapOwner {
  return owner;
}

/**
 * Hand the DAP bus to one transport (the active editor), or release it (null).
 * Idempotent. Notifies listeners synchronously so the losing transport tears
 * down before the winner's loop runs.
 */
export function setDapOwner(next: DapOwner): void {
  if (next === owner) return;
  owner = next;
  for (const cb of [...listeners]) {
    try {
      cb(next);
    } catch {
      /* one listener throwing must not stop the others */
    }
  }
}

/**
 * React to owner changes — e.g. stop your exchange loop when you no longer own
 * the bus. Returns an unsubscribe.
 */
export function onDapOwnerChange(cb: (o: DapOwner) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
