/**
 * Blocks-over-CMSIS-DAP transport driver (the codal/mini-3 USB transport).
 *
 * Sibling of `jacdac.ts`: it runs the `BlocksMailbox` RAM-exchange (see
 * `blocks-mailbox.ts`) over the widget's already-open `ArmDebug` handle, sharing
 * the same serialized DAP queue the serial + Jacdac paths use, so no second
 * WebUSB claim is needed and reads/writes interleave safely. It bypasses the
 * nRF↔interface UART entirely — fast and reliable (USB CRC + retransmit), no
 * 115200 bottleneck — replacing the legacy serial Blocks transport on mini 3.
 *
 * Public surface (consumed by campus `calliopeRemoteHost.ts`):
 *   sendBlocksDapFrame(frame) — host → device; starts the exchange loop lazily.
 *   onBlocksDapFrame(cb)      — device → host; receives parsed BlocksFrame
 *                               objects (same shape as `onBlocksFrameFromUsb`).
 *   isBlocksDapAvailable()    — true once the mailbox is located.
 *   stopBlocksDapExchange()   — tear down (program switch / disconnect).
 *   pause/resumeBlocksDapExchange() — quiet the bus during a flash.
 *
 * Inert until used: the first `sendBlocksDapFrame` triggers a RAM scan; if no
 * Blocks-DAP runtime is present (e.g. a J-Link mini, or a non-Blocks program)
 * the loop stops quietly until the next send.
 */

import { ConnectionStatus } from '@microbit/microbit-connection';
import { getUsbConn } from './usb';
import { appendLog } from './log';
import { BlocksMailbox, findBlocksExchange, type BlocksMemIO } from './blocks-mailbox';
import { BlocksFrameParser, type BlocksFrame } from './blocks-frame';
import { getDapOwner, onDapOwnerChange } from './dap-arbiter';

/** The slice of @microbit/microbit-connection's ArmDebug we use (same as jacdac.ts). */
interface ArmDebugLike {
  readonly isOpen: boolean;
  /** Bring up the SWD debug port. Idempotent; does NOT halt or reset the core. */
  connect(maxRetries?: number): Promise<void>;
  readBlock(address: number, count: number): Promise<Uint32Array>;
  writeBlock(address: number, values: Uint32Array): Promise<void>;
}

/** Reach the ArmDebug handle on the held USB connection (see jacdac.ts:getArmDebug). */
function getArmDebug(): ArmDebugLike | null {
  const usb = getUsbConn();
  if (!usb || usb.status !== ConnectionStatus.Connected) return null;
  const adi = (usb as unknown as { device?: { adi?: ArmDebugLike } }).device?.adi;
  return adi ?? null;
}

function memIO(adi: ArmDebugLike): BlocksMemIO {
  return {
    readWords: (addr, count) => adi.readBlock(addr, count),
    writeWords: (addr, words) => adi.writeBlock(addr, words),
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 0ms while frames are flowing; a small idle gap otherwise so an idle session
// doesn't saturate the DAP bus or starve other DAP users. (Mirror jacdac.ts.)
const POLL_IDLE_MS = 4;
/** Bounded outbound FIFO; drop-oldest past this so a stuck device can't leak. */
const MAX_OUTBOUND = 256;
/** Min gap between RAM scans after a "not found", so repeated sends don't scan-storm. */
const SCAN_COOLDOWN_MS = 2000;

const subscribers = new Set<(frame: BlocksFrame) => void>();
let outbound: Uint8Array[] = [];
let loopActive = false;
let stopRequested = false;
let paused = false;
let available = false;
let scanCooldownUntil = 0;
let droppedFrames = 0;

/** True once the exchange mailbox has been located on the connected device. */
export function isBlocksDapAvailable(): boolean {
  return available;
}

/**
 * One-shot detection for program-type probing: bring up SWD (idempotent, no
 * halt) and scan RAM for the Blocks-DAP mailbox. Returns true if a Blocks-DAP
 * runtime is present. Does NOT start the exchange loop — cheap (a few RAM
 * reads), safe to call repeatedly. This is how the codal/mini-3 USB transport
 * is detected, since it emits nothing on the UART for the serial probe to see.
 */
export async function detectBlocksDap(): Promise<boolean> {
  // Bus owned by Jacdac (MakeCode editor) — don't probe over a contended bus.
  if (getDapOwner() === 'jacdac') return false;
  // If the live exchange loop is already running it has already located the
  // mailbox; return that instead of issuing a CONCURRENT scan. ArmDebug
  // readBlock isn't atomic across callers, so a second reader here would corrupt
  // the loop's in-flight reads (and its own) — exactly the contention we avoid.
  if (loopActive) return available;
  const adi = getArmDebug();
  if (!adi) return false;
  try {
    await adi.connect();
    const xchg = await findBlocksExchange(memIO(adi));
    return xchg !== null;
  } catch {
    return false;
  }
}

/**
 * Send one raw Blocks wire frame (built by buildBlocksFrame) to the device.
 * Lazily starts the exchange loop. Resolves immediately (fire-and-forget into a
 * bounded FIFO); the loop drains it one frame per cycle.
 */
export async function sendBlocksDapFrame(frame: Uint8Array): Promise<void> {
  if (!frame || frame.length === 0) return;
  // Jacdac (MakeCode editor) owns the shared DAP bus — stay inert so two
  // exchange loops never run at once (concurrent ArmDebug reads cross + corrupt).
  if (getDapOwner() === 'jacdac') return;
  outbound.push(frame);
  if (outbound.length > MAX_OUTBOUND) {
    outbound.shift();
    droppedFrames++;
    if (droppedFrames % 100 === 1) {
      appendLog({ direction: 'info', text: `Blocks-DAP: outbound queue full — dropped ${droppedFrames} frame(s) (loop not draining)` });
    }
  }
  if (!loopActive && Date.now() >= scanCooldownUntil) void runLoop();
}

/**
 * Subscribe to parsed Blocks frames read from the device. Returns an unsubscribe.
 * Does not itself start the loop (only sendBlocksDapFrame does).
 */
export function onBlocksDapFrame(cb: (frame: BlocksFrame) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Force-stop the exchange loop and clear queued frames. Idempotent. */
export function stopBlocksDapExchange(): void {
  stopRequested = true;
  available = false;
  outbound = [];
}

/** Pause the loop for the duration of a flash (quiet bus). */
export function pauseBlocksDapExchange(): void {
  paused = true;
}

export function resumeBlocksDapExchange(): void {
  paused = false;
}

// Lose the bus → tear down immediately. Jacdac (or "no editor") taking ownership
// must stop this loop before its reads can collide with ours.
onDapOwnerChange((o) => {
  if (o !== 'blocks') stopBlocksDapExchange();
});

function emit(frame: BlocksFrame): void {
  for (const cb of subscribers) {
    try {
      cb(frame);
    } catch (err) {
      appendLog({ direction: 'info', text: `Blocks-DAP frame handler error: ${(err as Error)?.message ?? err}` });
    }
  }
}

async function runLoop(): Promise<void> {
  if (loopActive) return;
  loopActive = true;
  stopRequested = false;
  let mailbox: BlocksMailbox | null = null;
  // Each inbound slot read is one complete Blocks frame, but feed it through the
  // streaming parser so framing/checksum validation is shared with the serial path.
  const parser = new BlocksFrameParser();
  try {
    const adi = getArmDebug();
    if (!adi) {
      appendLog({ direction: 'info', text: 'Blocks-DAP: USB not connected — exchange not started' });
      return;
    }
    mailbox = new BlocksMailbox(memIO(adi));
    let found = false;
    try {
      // Bring up SWD before any memory access (idempotent, no halt/reset).
      await adi.connect();
      found = await mailbox.scan();
    } catch (err) {
      appendLog({ direction: 'error', text: `Blocks-DAP scan failed: ${(err as Error)?.message ?? err}` });
    }
    if (!found) {
      available = false;
      scanCooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
      appendLog({ direction: 'info', text: 'Blocks-DAP: exchange buffer not found (no Blocks-DAP runtime / J-Link mini?)' });
      return;
    }
    available = true;
    appendLog({ direction: 'info', text: 'Blocks-DAP: exchange ready' });

    // Spike diagnostic counters (remove once the transport is proven).
    let dbgCyc = 0;
    let dbgSends = 0;
    let dbgRecvs = 0;
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
        dbgRecvs++;
        for (const f of parser.push(inbound)) emit(f);
        didWork = true;
      }
      if (outbound.length) {
        const sent = await mailbox.trySendOutbound(outbound[0]);
        if (sent) {
          outbound.shift();
          dbgSends++;
          didWork = true;
        }
      }
      // Every ~100 cycles, surface the raw slot heads so we can see whether the
      // device is consuming sends (send → 0) and producing inbound (inbound ≠ 0).
      if (++dbgCyc % 100 === 0) {
        try {
          const h = await mailbox.debugHeads();
          if (h)
            appendLog({
              direction: 'info',
              text: `Blocks-DAP dbg: inbound=0x${h.inbound.toString(16)} send=0x${h.send.toString(16)} outQ=${outbound.length} sends=${dbgSends} recvs=${dbgRecvs}`,
            });
        } catch {
          /* ignore */
        }
      }
      await delay(didWork ? 0 : POLL_IDLE_MS);
    }
  } catch (err) {
    appendLog({ direction: 'error', text: `Blocks-DAP exchange loop error: ${(err as Error)?.message ?? err}` });
    // A transfer error mid-loop is usually a device reboot (e.g. after a flash)
    // tearing down SWD. Back off before a restart so we don't tight-loop
    // adi.connect() against a rebooting device.
    scanCooldownUntil = Date.now() + 1500;
  } finally {
    mailbox?.reset();
    available = false;
    loopActive = false;
  }
}
