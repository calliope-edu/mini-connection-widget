/**
 * Jacdac frame transport for the connected Calliope mini (Layer 2).
 *
 * The campus MakeCode host relays raw Jacdac frames between the embedded pxt
 * editor's Jacdac simulator and the physical device. The widget owns the
 * DAPLink/CMSIS-DAP session exclusively (controller=2), so the iframe cannot
 * open its own WebUSB Jacdac transport — the widget must move the frames. This
 * module runs the CMSIS-DAP RAM-exchange (see `jacdac-mailbox.ts`) over the
 * widget's already-open `ArmDebug` handle, sharing the same serialized DAP
 * `sendQueue` the serial path uses, so no second WebUSB claim is needed and
 * reads/writes interleave safely with serial polling.
 *
 * Public surface (probed by campus `jacdacTransport.ts`):
 *   sendJacdacFrame(frame) — host → device; starts the exchange loop lazily.
 *   onJacdacFrame(cb)      — device → host; registers a sink (does NOT start
 *                            the loop, so a non-Jacdac session pays nothing).
 *   isJacdacAvailable()    — true once the mailbox is located.
 *   stopJacdacExchange()   — tear down (program switch / disconnect).
 *
 * Inert until a Jacdac-extension program is running: the first `sendJacdacFrame`
 * (which only happens when the editor's Jacdac sim is active) triggers a RAM
 * scan; if no mailbox is found the loop stops quietly until the next send.
 */

import { ConnectionStatus } from '@microbit/microbit-connection';
import { getUsbConn } from './usb';
import { appendLog } from './log';
import { pushProxy } from './comms';
import { JacdacMailbox, JacdacInvalidMemoryError, type JacdacMemIO } from './jacdac-mailbox';
import { getDapOwner, setDapOwner, onDapOwnerChange, withDapBus } from './dap-arbiter';

/** The slice of @microbit/microbit-connection's ArmDebug we use. */
interface ArmDebugLike {
  readonly isOpen: boolean;
  /**
   * Bring up the SWD debug port (JTAG→SWD switch, read ID, power up the debug
   * + system domains). Idempotent — no-op when already connected — and does
   * NOT halt or reset the core, so the running program is undisturbed.
   */
  connect(maxRetries?: number): Promise<void>;
  readBlock(address: number, count: number): Promise<Uint32Array>;
  writeBlock(address: number, values: Uint32Array): Promise<void>;
}

/**
 * Reach the ArmDebug handle on the held USB connection. `device` is a
 * TS-private field on MicrobitUSBConnectionImpl, and `device.adi`
 * (USBDeviceWrapper.adi) is the public ArmDebug — field names confirmed for
 * @microbit/microbit-connection 1.0.0-beta.1. A `getArmDebug()` accessor could
 * be added to the package patch to remove this cast (see the Layer-2 design),
 * but the cast keeps Layer 2 self-contained in the widget.
 */
function getArmDebug(): ArmDebugLike | null {
  const usb = getUsbConn();
  if (!usb || usb.status !== ConnectionStatus.Connected) return null;
  const adi = (usb as unknown as { device?: { adi?: ArmDebugLike } }).device?.adi;
  return adi ?? null;
}

function memIO(adi: ArmDebugLike): JacdacMemIO {
  return {
    readWords: (addr, count) => withDapBus(() => adi.readBlock(addr, count)),
    writeWords: (addr, words) => withDapBus(() => adi.writeBlock(addr, words)),
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hexBytes(data: Uint8Array, max = 16): string {
  let s = '';
  for (let i = 0; i < Math.min(data.length, max); i++) s += (i ? ' ' : '') + data[i].toString(16).padStart(2, '0').toUpperCase();
  if (data.length > max) s += ` …(+${data.length - max})`;
  return s;
}

/** Sender device id from a JD frame (bytes [4-11], big-endian hex). '' if short. */
function jacdacDeviceId(frame: Uint8Array): string {
  if (frame.length < 12) return '';
  let dev = '';
  for (let i = 11; i >= 4; i--) dev += frame[i].toString(16).padStart(2, '0');
  return dev;
}

// Jacdac command encoding (jacdac-ts src/jdom/constants.ts).
const JD_CMD_GET_REG = 0x1000;
const JD_CMD_SET_REG = 0x2000;
const JD_CMD_TOP_MASK = 0xf000;
const JD_CMD_REG_MASK = 0x0fff;
const JD_CMD_EVENT_MASK = 0x8000;
const JD_SERVICE_INDEX_MASK = 0x3f;

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** Human label for a service_command: register get/set, event, or raw command. */
function describeJacdacCommand(cmd: number): string {
  if (cmd & JD_CMD_EVENT_MASK) return `evt 0x${(cmd & 0xff).toString(16)}`;
  const top = cmd & JD_CMD_TOP_MASK;
  if (top === JD_CMD_GET_REG) return `get reg 0x${(cmd & JD_CMD_REG_MASK).toString(16)}`;
  if (top === JD_CMD_SET_REG) return `set reg 0x${(cmd & JD_CMD_REG_MASK).toString(16)}`;
  if (cmd === 0) return 'announce';
  return `cmd 0x${cmd.toString(16)}`;
}

/** Payload as a small LE int (register scalars) or hex for larger buffers. */
function describeJacdacPayload(p: Uint8Array): string {
  if (p.length === 0) return '';
  if (p.length <= 4) {
    let v = 0;
    for (let i = p.length - 1; i >= 0; i--) v = v * 256 + p[i];
    return `=${v} [${hexBytes(p, 4)}]`;
  }
  return `[${hexBytes(p, 32)}]`;
}

/**
 * Decode a Jacdac frame into a readable comms-panel line. JD frame layout:
 * [0-1]=CRC, [2]=size, [3]=flags, [4-11]=sender device id, then one or more
 * packets — each [service_size(1), service_index(1), service_command(2 LE),
 * payload…] padded to 4 bytes (matches jacdac-ts Packet.fromFrame). For each
 * packet we show the service index, the decoded command (get/set reg, event,
 * announce, or raw), and the value/payload. The control announce (service 0,
 * cmd 0) lists the device's advertised service classes (u32s from payload
 * offset 4 — jacdac-ts serviceClassAt), so you can tell what the module is.
 */
function formatJacdacFrame(frame: Uint8Array): string {
  const dev = jacdacDeviceId(frame) || '????';
  if (frame.length < 12) return `JD ${frame.length}B dev=${dev} [${hexBytes(frame, 64)}]`;
  const parts: string[] = [];
  let o = 12;
  while (o + 4 <= frame.length) {
    const size = frame[o];
    const srv = frame[o + 1] & JD_SERVICE_INDEX_MASK;
    const cmd = frame[o + 2] | (frame[o + 3] << 8);
    const payload = frame.slice(o + 4, o + 4 + size);
    if (srv === 0 && cmd === 0) {
      const classes: string[] = [];
      for (let i = 4; i + 4 <= payload.length; i += 4) {
        classes.push('0x' + u32le(payload, i).toString(16).padStart(8, '0'));
      }
      parts.push(classes.length ? `announce services=[${classes.join(', ')}]` : 'announce');
    } else {
      const d = describeJacdacPayload(payload);
      parts.push(`s${srv} ${describeJacdacCommand(cmd)}${d ? ` ${d}` : ''}`);
    }
    o += (4 + size + 3) & ~3;
  }
  const body = parts.length ? parts.join(' | ') : `[${hexBytes(frame.slice(12), 64)}]`;
  return `JD ${frame.length}B dev=${dev} · ${body}`;
}

// Poll cadence: 0ms while frames are flowing (browser throttles a busy loop),
// a small idle gap otherwise so an idle Jacdac session doesn't saturate the DAP
// bus or starve serial. Tunable — confirm on hardware (Layer-2 design §6).
const POLL_IDLE_MS = 4;
/** Bounded outbound FIFO; drop-oldest past this so a stuck device can't leak. */
const MAX_OUTBOUND = 256;
/** Min gap between RAM scans after a "not found", so repeated sends from a
 *  non-Jacdac session don't trigger a scan storm. */
const SCAN_COOLDOWN_MS = 2000;

const subscribers = new Set<(frame: Uint8Array) => void>();
let outbound: Uint8Array[] = [];
let loopActive = false;
let stopRequested = false;
let paused = false;
let available = false;
let scanCooldownUntil = 0;
let droppedFrames = 0;

/** True once the exchange mailbox has been located on the connected device. */
export function isJacdacAvailable(): boolean {
  return available;
}

/**
 * Send one raw Jacdac frame to the device. Lazily starts the exchange loop —
 * the first send means the editor's Jacdac sim is active, i.e. a Jacdac program
 * is running. Resolves immediately (fire-and-forget into a bounded FIFO); the
 * loop drains it one frame per cycle.
 */
export async function sendJacdacFrame(frame: Uint8Array): Promise<void> {
  if (!frame || frame.length === 0) return;
  // The Blocks editor owns the shared DAP bus — stay inert so two exchange loops
  // never run at once (concurrent ArmDebug reads cross + corrupt, see dap-arbiter).
  if (getDapOwner() === 'blocks') return;
  outbound.push(frame);
  if (outbound.length > MAX_OUTBOUND) {
    outbound.shift();
    droppedFrames++;
    // Throttle: a flood here just means the loop isn't draining yet (scan
    // failing, or device not connected). One line per 100 drops is enough.
    if (droppedFrames % 100 === 1) {
      appendLog({ direction: 'info', text: `Jacdac: outbound queue full — dropped ${droppedFrames} frame(s) so far (loop not draining)` });
    }
  }
  // While paused (flash in progress) only queue — a lazy restart here would
  // run adi.connect + a RAM scan (and possibly a target soft-reset!) on the
  // same DAP bus the flash is using, silently corrupting written pages.
  if (!loopActive && !paused && Date.now() >= scanCooldownUntil) void runLoop();
}

/**
 * Proactively start the exchange loop (scan + poll) WITHOUT an outbound frame —
 * a dev/debug "sniffer" entry point so the device's Jacdac traffic appears in
 * the comms panel (and reaches subscribers) even when the editor isn't driving
 * the bridge. It's ONE scan per call: if no mailbox is found the loop stops (no
 * scan-storm) until the next call/send. Inert while the Blocks editor owns the
 * DAP bus. The campus host calls this on connect in dev mode.
 */
export function startJacdacExchange(): void {
  if (getDapOwner() === 'blocks') return;
  if (!loopActive && !paused && Date.now() >= scanCooldownUntil) void runLoop();
}

/**
 * Subscribe to raw Jacdac frames read from the device. Returns an unsubscribe.
 * Does not itself start the exchange loop (only `sendJacdacFrame` /
 * `startJacdacExchange` do), so a non-Jacdac MakeCode session never triggers a
 * RAM scan.
 */
export function onJacdacFrame(cb: (frame: Uint8Array) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Force-stop the exchange loop and clear queued frames. Idempotent. Called on
 *  program switch, flash teardown, and USB disconnect (clearUsbConn). */
export function stopJacdacExchange(): void {
  stopRequested = true;
  available = false;
  outbound = [];
}

/** Pause the loop for the duration of a flash (quiet bus). Mirrors the serial
 *  pause; the loop parks at the top of its next iteration. */
export function pauseJacdacExchange(): void {
  paused = true;
}

export function resumeJacdacExchange(): void {
  paused = false;
  // Drain anything queued while the gate was closed.
  if (!loopActive && outbound.length > 0 && Date.now() >= scanCooldownUntil) void runLoop();
}

// Lose the bus → tear down immediately. The Blocks editor (or "no editor")
// taking ownership must stop this loop before its reads can collide with ours.
onDapOwnerChange((o) => {
  if (o !== 'jacdac') stopJacdacExchange();
});

function emit(frame: Uint8Array): void {
  for (const cb of subscribers) {
    try {
      cb(frame);
    } catch (err) {
      appendLog({ direction: 'info', text: `Jacdac frame handler error: ${(err as Error)?.message ?? err}` });
    }
  }
}

async function runLoop(): Promise<void> {
  if (loopActive) return;
  loopActive = true;
  stopRequested = false;
  let mailbox: JacdacMailbox | null = null;
  try {
    // Hard flash gate: park BEFORE any SWD access (connect/scan/resetTarget).
    // The paused check inside the while loop below only covers the steady
    // state — a loop started as a flash begins must not touch the bus at all.
    while (paused && !stopRequested) {
      await delay(20);
    }
    if (stopRequested) return;
    const adi = getArmDebug();
    if (!adi) {
      appendLog({ direction: 'info', text: 'Jacdac: USB not connected — exchange not started' });
      return;
    }
    mailbox = new JacdacMailbox(memIO(adi));
    let found = false;
    let failCooldown = SCAN_COOLDOWN_MS;
    try {
      // Bring up the SWD debug port before any memory access. The widget keeps
      // the USB transport open but leaves SWD disconnected in serial-only
      // steady state, so readBlock would fault — the device returns a sticky
      // error and even the abort-clear fails ("Bad status for 8" = the
      // DAP_WRITE_ABORT command). connect() is idempotent and does not
      // halt/reset the core.
      await adi.connect();
      try {
        found = await mailbox.scan();
      } catch (err) {
        if (err instanceof JacdacInvalidMemoryError) {
          // The mailbox magic is present but the exchange buffer isn't in its
          // clean post-boot state — we attached to a long-running program. Like
          // jacdac-ts (and MakeCode's own Jacdac connect), soft-reset the core
          // so the firmware re-initialises the exchange, wait for it to come
          // back, then re-scan. Done only when needed (not when the buffer is
          // already clean, e.g. right after a flash), so we avoid an extra
          // reboot in the common case.
          appendLog({ direction: 'info', text: 'Jacdac: re-initialising exchange (soft-resetting the mini)…' });
          await mailbox.resetTarget();
          await delay(1200); // firmware re-init: jacdac-ts notes ~700ms min
          found = await mailbox.scan();
        } else {
          throw err;
        }
      }
    } catch (err) {
      appendLog({ direction: 'error', text: `Jacdac scan failed: ${(err as Error)?.message ?? err}` });
      // We may have just rebooted the device — back off longer so a persistent
      // failure doesn't reboot-storm the mini every couple of seconds.
      failCooldown = 5000;
    }
    if (!found) {
      available = false;
      scanCooldownUntil = Date.now() + failCooldown;
      appendLog({ direction: 'info', text: 'Jacdac: exchange not ready (no Jacdac program, or still re-initialising)' });
      return;
    }
    available = true;
    // We found the Jacdac mailbox → this device runs a Jacdac program, so claim
    // the bus. Stops any Blocks-DAP loop (device-truth, not editor-guess).
    setDapOwner('jacdac');
    appendLog({ direction: 'info', text: 'Jacdac: exchange ready' });

    while (!stopRequested) {
      const adiNow = getArmDebug();
      if (!adiNow || !adiNow.isOpen) break;
      if (paused) {
        await delay(20);
        continue;
      }
      let didWork = false;
      const inbound = await mailbox.readInbound();
      if (inbound) {
        // Live tab: one row per sender device id, updating in place — a live
        // view of the Jacdac devices on the bus (mirrors how Blocks-DAP live
        // reads land in the Live tab).
        pushProxy({ direction: 'rx', transport: 'usb', kind: 'jacdac', live: true, liveKey: `JD ${jacdacDeviceId(inbound) || '????'}`, text: formatJacdacFrame(inbound) });
        emit(inbound);
        didWork = true;
      }
      if (outbound.length) {
        const out = outbound[0];
        const sent = await mailbox.trySendOutbound(out);
        if (sent) {
          pushProxy({ direction: 'tx', transport: 'usb', kind: 'jacdac', live: true, liveKey: `JD ${jacdacDeviceId(out) || 'sim'} TX`, text: formatJacdacFrame(out) });
          outbound.shift();
          didWork = true;
        }
      }
      await delay(didWork ? 0 : POLL_IDLE_MS);
    }
  } catch (err) {
    appendLog({ direction: 'error', text: `Jacdac exchange loop error: ${(err as Error)?.message ?? err}` });
    // A transfer error mid-loop is almost always a device reboot (e.g. just
    // after a flash) tearing down SWD. Back off before allowing a restart so
    // we don't tight-loop adi.connect() against a rebooting device while the
    // widget's own USB reconnect runs; the next sendJacdacFrame after the
    // cooldown re-connects SWD and re-scans cleanly.
    scanCooldownUntil = Date.now() + 1500;
  } finally {
    mailbox?.reset();
    available = false;
    loopActive = false;
  }
}
