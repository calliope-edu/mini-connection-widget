/**
 * Passive Blocks-runtime liveness: a tap on the frame streams that ALREADY
 * flow through the widget (the Blocks-DAP exchange loop on mini 3, the serial
 * probes, BLE COMMAND reads). Every checksum-valid Blocks frame proves the
 * runtime is alive — so program-type detection can answer instantly from the
 * live traffic instead of racing its own probe against a busy transport
 * (which sat "wird überprüft…" while STATE/MOTION/button events streamed by).
 *
 * Version bytes are captured whenever a COMMAND (0x0100) read response passes
 * through: [0]=hardware, [1]=protocol, [3]=runtime — the same payload the
 * probes and the editor handshake read.
 */

import type { BlocksFrame } from './blocks-frame';
import { BLOCKS_RES } from './blocks-frame';

export interface BlocksLiveness {
  /** Timestamp (ms) of the last checksum-valid Blocks frame seen anywhere. */
  lastFrameAt: number;
  hardwareVersion?: number;
  protocolVersion?: number;
  runtimeVersion?: number;
}

let lastFrameAt = 0;
let hardwareVersion: number | undefined;
let protocolVersion: number | undefined;
let runtimeVersion: number | undefined;

/** How fresh a frame must be for detection to trust it (ms). STATE/MOTION
 *  broadcast every ~50ms and the editor polls continuously, so anything
 *  older than this means live comms stopped. */
export const BLOCKS_LIVENESS_FRESH_MS = 5_000;

/** Feed one parsed, checksum-valid Blocks frame into the liveness latch. */
export function noteBlocksFrame(frame: BlocksFrame): void {
  lastFrameAt = Date.now();
  if (frame.type === BLOCKS_RES.READ && frame.channel === 0x0100 && frame.data.length >= 2) {
    hardwareVersion = frame.data[0];
    protocolVersion = frame.data[1];
    if (frame.data.length >= 4) runtimeVersion = frame.data[3];
  }
}

/** Version info learned out-of-band (e.g. a BLE COMMAND characteristic read). */
export function noteBlocksVersion(info: {
  hardwareVersion?: number;
  protocolVersion?: number;
  runtimeVersion?: number;
}): void {
  lastFrameAt = Date.now();
  if (info.hardwareVersion !== undefined) hardwareVersion = info.hardwareVersion;
  if (info.protocolVersion !== undefined) protocolVersion = info.protocolVersion;
  if (info.runtimeVersion !== undefined) runtimeVersion = info.runtimeVersion;
}

/** Drop the latch — the program may have changed (flash) or the device left. */
export function resetBlocksLiveness(): void {
  lastFrameAt = 0;
  hardwareVersion = undefined;
  protocolVersion = undefined;
  runtimeVersion = undefined;
}

/** Snapshot; `lastFrameAt === 0` means nothing seen since the last reset. */
export function getBlocksLiveness(): BlocksLiveness {
  return { lastFrameAt, hardwareVersion, protocolVersion, runtimeVersion };
}

/** True when live Blocks traffic was seen within the freshness window. */
export function isBlocksAlive(freshMs: number = BLOCKS_LIVENESS_FRESH_MS): boolean {
  return lastFrameAt !== 0 && Date.now() - lastFrameAt < freshMs;
}
