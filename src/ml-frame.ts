/**
 * Pure codec and stall watch for the ml-trainer's ML data program
 * (calliope-edu/ml-trainer `microbit/calliope/`) over USB serial — no transport
 * imports, so it loads under the Node test runner.
 *
 * The program streams in the Blocks runtime's serial framing (`blocks-frame.ts`
 * parses it unchanged), on channels of its own in the 0x02xx range:
 *
 *   0x0200 ML_INFO  RES_READ (0x01): reply to `FF 01 02 00` and announced
 *                   unprompted once per second.
 *                   [0] hardware (1 = mini 1/2, 2 = mini 3)  [1] 0x4D ('M')
 *                   [2] protocol version  [3] firmware build  [4] sample period ms
 *                   [5] range g  [6] motion resyncs since boot (wraps)
 *                   [7] worst motion lateness ms since the last ML_INFO
 *                   [8..9] uptime s, uint16 LE
 *   0x0203 MOTION   NOTIFY (0x21) every 20 ms: X, Y, Z int16 LE in milli-g (the
 *                   values the BLE accelerometer service sends), uint8 sequence.
 *   0x0210 BUTTON   NOTIFY (0x21) on each change: [button (1 = A, 2 = B),
 *                   state (0 = released, 1 = pressed, 2 = long press)].
 *
 * None of these frames is Blocks traffic: detection must not count them towards
 * the Blocks runtime's "N valid frames" fallback.
 */

import { BLOCKS_RES, type BlocksFrame } from './blocks-frame';

export const ML_CHANNEL = {
  INFO: 0x0200,
  MOTION: 0x0203,
  BUTTON: 0x0210,
} as const;

/** ML_INFO byte[1]: identifies the ML data program. */
export const ML_PROGRAM_ID = 0x4d;

/** True for the ML data program's channel range (0x02xx). */
export function isMlChannel(channel: number): boolean {
  return (channel & 0xff00) === 0x0200;
}

export interface MlDataInfo {
  /** 1 = mini 1/2 (DAL), 2 = mini 3 (CODAL). */
  hardware: number;
  protocolVersion?: number;
  firmwareBuild?: number;
  samplePeriodMs?: number;
  rangeG?: number;
  /** Motion loop resyncs since boot (wraps at 256). */
  resyncs?: number;
  /** Worst motion lateness in ms since the previous ML_INFO. */
  worstLatenessMs?: number;
  uptimeS?: number;
}

export interface MlMotion {
  /** milli-g, micro:bit orientation (as the BLE accelerometer service). */
  x: number;
  y: number;
  z: number;
  /** Sequence number, wraps at 256; a gap means a lost sample. */
  seq?: number;
}

export interface MlButton {
  button: 'A' | 'B';
  /** 0 = released, 1 = pressed, 2 = long press (as the BLE button service). */
  state: 0 | 1 | 2;
}

/** The ML data program's ML_INFO frame, or null for anything else. */
export function parseMlInfo(frame: BlocksFrame): MlDataInfo | null {
  const d = frame.data;
  if (frame.type !== BLOCKS_RES.READ || frame.channel !== ML_CHANNEL.INFO) return null;
  if (d.length < 2 || d[1] !== ML_PROGRAM_ID) return null;
  return {
    hardware: d[0],
    protocolVersion: d.length > 2 ? d[2] : undefined,
    firmwareBuild: d.length > 3 ? d[3] : undefined,
    samplePeriodMs: d.length > 4 ? d[4] : undefined,
    rangeG: d.length > 5 ? d[5] : undefined,
    resyncs: d.length > 6 ? d[6] : undefined,
    worstLatenessMs: d.length > 7 ? d[7] : undefined,
    uptimeS: d.length > 9 ? d[8] | (d[9] << 8) : undefined,
  };
}

function int16le(d: Uint8Array, i: number): number {
  const v = d[i] | (d[i + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

/** A MOTION sample, or null for anything else. */
export function parseMlMotion(frame: BlocksFrame): MlMotion | null {
  const d = frame.data;
  if (frame.type !== BLOCKS_RES.NOTIFY || frame.channel !== ML_CHANNEL.MOTION || d.length < 6) {
    return null;
  }
  return {
    x: int16le(d, 0),
    y: int16le(d, 2),
    z: int16le(d, 4),
    seq: d.length > 6 ? d[6] : undefined,
  };
}

/** A BUTTON change, or null for anything else. */
export function parseMlButton(frame: BlocksFrame): MlButton | null {
  const d = frame.data;
  if (frame.type !== BLOCKS_RES.NOTIFY || frame.channel !== ML_CHANNEL.BUTTON || d.length < 2) {
    return null;
  }
  if (d[0] !== 1 && d[0] !== 2) return null;
  if (d[1] > 2) return null;
  return { button: d[0] === 1 ? 'A' : 'B', state: d[1] as 0 | 1 | 2 };
}

// ---- Stall watch ------------------------------------------------------------

/** Silence on a transport that carried the ML stream before it is reopened. */
export const ML_STALL_MS = 3_000;
/** Reopens in a row without a frame before the program counts as gone. */
export const ML_MAX_REOPENS = 3;

export type MlWatchAction = 'reopen' | 'lost';

/**
 * Decides when a USB link that carried the ML data program needs its port
 * reopened. The mini 2's J-Link CDC bridge now and then stops delivering on the
 * PC side while the mini keeps sending; closing and reopening the port brings
 * the stream back at once (ml-trainer W1). Time is passed in, so it tests
 * without timers.
 *
 * Armed by the first ML_INFO on the link. After `ML_STALL_MS` without any ML
 * frame it asks for a reopen, again every `ML_STALL_MS` while silence lasts,
 * and after `ML_MAX_REOPENS` fruitless reopens it reports the program `lost`
 * (flashed over, or unplugged without the link noticing) and disarms, so a
 * different program on the mini is not disturbed by reopens forever.
 */
export class MlStreamWatch {
  private armed = false;
  private lastFrameAt = 0;
  private lastReopenAt = 0;
  private reopens = 0;
  private info: MlDataInfo | null = null;

  /** Note one checksum-valid frame from this link. Returns true when it armed the watch. */
  noteFrame(frame: BlocksFrame, now: number): boolean {
    if (!isMlChannel(frame.channel)) return false;
    const info = parseMlInfo(frame);
    if (info) this.info = info;
    if (!this.armed && !info) return false;
    const armedNow = !this.armed;
    this.armed = true;
    this.lastFrameAt = now;
    this.reopens = 0;
    return armedNow;
  }

  /** What to do now: nothing, reopen the port, or give the program up. */
  check(now: number): MlWatchAction | null {
    if (!this.armed) return null;
    if (now - this.lastFrameAt < ML_STALL_MS) return null;
    if (now - this.lastReopenAt < ML_STALL_MS) return null;
    if (this.reopens >= ML_MAX_REOPENS) {
      this.reset();
      return 'lost';
    }
    this.reopens++;
    this.lastReopenAt = now;
    return 'reopen';
  }

  /** Forget the link (it dropped, or a flash replaces the program). */
  reset(): void {
    this.armed = false;
    this.lastFrameAt = 0;
    this.lastReopenAt = 0;
    this.reopens = 0;
    this.info = null;
  }

  /** True while the ML data program streams (or is being reopened) on this link. */
  get running(): boolean {
    return this.armed;
  }

  /** The latest ML_INFO seen on this link. */
  get latestInfo(): MlDataInfo | null {
    return this.info;
  }
}
