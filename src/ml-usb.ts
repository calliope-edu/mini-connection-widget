/**
 * The ml-trainer's ML data program over USB serial: recognise it, hand its
 * frames to consumers, and keep the link alive.
 *
 * Both USB serial transports feed in here — DAPLink (mini 1/3, WebUSB serial
 * polling in usb.ts) and the mini 2's J-Link CDC port (Web Serial,
 * web-serial.ts). Each has its own frame parser and stall watch
 * (`MlStreamWatch`, ml-frame.ts). The first ML_INFO on a link marks the program
 * as running (`programType` 'ml-data'); every 0x02xx frame then goes to
 * `onMlDataFrame` subscribers one by one, as it is parsed: nothing here batches,
 * throttles or drops MOTION (50 per second) or BUTTON frames.
 *
 * When a link that carried the stream stays silent for `ML_STALL_MS`, its port
 * is reopened (the J-Link bridge stalls on the PC side now and then while the
 * mini keeps sending). After `ML_MAX_REOPENS` fruitless reopens the program is
 * given up and `programType` falls back to 'unknown'.
 *
 * The transports register how to reopen themselves (`setMlUsbReopener`), so
 * this module imports neither usb.ts nor web-serial.ts.
 */

import { BlocksFrameParser, type BlocksFrame } from './blocks-frame';
import {
  ML_CHANNEL,
  MlStreamWatch,
  isMlChannel,
  parseMlButton,
  parseMlInfo,
  parseMlMotion,
  type MlDataInfo,
} from './ml-frame';
import { calliopeState, getState, updateState } from './state';
import { appendLog } from './log';
import { pushProxy, setBlocksFramingUsbActive } from './comms';

/** The USB serial transport a chunk came in on. */
export type MlUsbLink = 'daplink' | 'jlink';

interface LinkState {
  parser: BlocksFrameParser;
  watch: MlStreamWatch;
  reopen: (() => Promise<boolean>) | null;
  reopening: boolean;
}

const links: Record<MlUsbLink, LinkState> = {
  daplink: { parser: new BlocksFrameParser(), watch: new MlStreamWatch(), reopen: null, reopening: false },
  jlink: { parser: new BlocksFrameParser(), watch: new MlStreamWatch(), reopen: null, reopening: false },
};

const subscribers = new Set<(frame: BlocksFrame) => void>();

/**
 * Subscribe to the ML data program's USB frames (channels 0x02xx: ML_INFO,
 * MOTION, BUTTON), each as it arrives. Decode them with `parseMlMotion`,
 * `parseMlButton` and `parseMlInfo`. Returns the unsubscribe.
 */
export function onMlDataFrame(cb: (frame: BlocksFrame) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** True while the ML data program streams over a USB link (or that link is being reopened). */
export function isMlDataRunning(): boolean {
  return links.daplink.watch.running || links.jlink.watch.running;
}

/** The latest ML_INFO of the running ML data program, or null. */
export function getMlDataInfo(): MlDataInfo | null {
  return links.jlink.watch.latestInfo ?? links.daplink.watch.latestInfo;
}

/** A transport says how to close and reopen its port. Resolves true when it is open again. */
export function setMlUsbReopener(link: MlUsbLink, reopen: () => Promise<boolean>): void {
  links[link].reopen = reopen;
}

function toBytes(chunk: Uint8Array | string): Uint8Array {
  if (typeof chunk !== 'string') return chunk;
  const bytes = new Uint8Array(chunk.length);
  for (let i = 0; i < chunk.length; i++) bytes[i] = chunk.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Feed raw serial bytes from a USB link. Called by the transports for every
 * chunk they receive, whatever program runs: only checksum-valid 0x02xx frames
 * have any effect.
 */
export function feedMlUsb(link: MlUsbLink, chunk: Uint8Array | string): void {
  if (!chunk || chunk.length === 0) return;
  const l = links[link];
  const now = Date.now();
  for (const frame of l.parser.push(toBytes(chunk))) {
    if (!isMlChannel(frame.channel)) continue;
    if (l.watch.noteFrame(frame, now)) onArmed(link);
    for (const cb of subscribers) {
      try { cb(frame); } catch { /* a consumer's error is its own */ }
    }
    logFrame(frame, now);
  }
}

// ---- Program state ----------------------------------------------------------

let framingSuppressed = false;
let timer: ReturnType<typeof setInterval> | null = null;

function onArmed(link: MlUsbLink): void {
  const info = links[link].watch.latestInfo;
  appendLog({
    direction: 'info',
    text: `ML data program over USB (${link === 'jlink' ? 'mini 2 serial' : 'DAPLink'}): hw=${info?.hardware ?? '?'} protocol=${info?.protocolVersion ?? '?'} build=${info?.firmwareBuild ?? '?'}`,
  });
  // Its binary frames would show as mojibake in the raw serial tap; the decoded
  // frames go to the comms panel instead (logFrame).
  if (!framingSuppressed) {
    framingSuppressed = true;
    setBlocksFramingUsbActive(true);
  }
  if (!getState().flashInProgress) {
    updateState((s) => (s.programType === 'ml-data' ? s : { ...s, programType: 'ml-data' }));
  }
  if (!timer) timer = setInterval(checkLinks, 1_000);
}

function onStopped(): void {
  if (isMlDataRunning()) return;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (framingSuppressed) {
    framingSuppressed = false;
    setBlocksFramingUsbActive(false);
  }
}

function checkLinks(): void {
  const s = getState();
  if (s.flashInProgress) return;
  const now = Date.now();
  for (const link of ['daplink', 'jlink'] as const) {
    const l = links[link];
    if (l.reopening) continue;
    const action = l.watch.check(now);
    if (action === 'reopen' && l.reopen) {
      appendLog({ direction: 'info', text: `ML data program: no frame over USB (${link}) for 3 s, reopening the port` });
      l.reopening = true;
      l.parser = new BlocksFrameParser();
      void l.reopen()
        .catch(() => false)
        .finally(() => { l.reopening = false; });
    } else if (action === 'lost') {
      appendLog({ direction: 'info', text: `ML data program: USB (${link}) stayed silent after reopening, no longer running` });
      onStopped();
      if (!isMlDataRunning()) {
        updateState((st) => (st.programType === 'ml-data' ? { ...st, programType: 'unknown' } : st));
      }
    }
  }
}

function resetLink(link: MlUsbLink): void {
  const l = links[link];
  if (!l.watch.running) return;
  l.watch.reset();
  l.parser = new BlocksFrameParser();
  onStopped();
}

// A dropped link or a flash ends what the watch knew: the next program (or
// device) announces itself afresh. programType itself is left to the probe in
// program-type.ts, which re-runs on exactly these edges.
if (typeof window !== 'undefined') {
  calliopeState.subscribe((s) => {
    if (s.flashInProgress) {
      resetLink('daplink');
      resetLink('jlink');
      return;
    }
    if (s.usbStatus !== 'connected') resetLink('daplink');
    if (s.jlinkSerialStatus !== 'connected') resetLink('jlink');
  });
}

// ---- Comms panel ------------------------------------------------------------

let lastMotionLogAt = 0;

function logFrame(frame: BlocksFrame, now: number): void {
  const ch = `ch=0x${frame.channel.toString(16).padStart(4, '0')}`;
  if (frame.channel === ML_CHANNEL.MOTION) {
    // Live tab only, and a few times a second: it shows the latest value.
    if (now - lastMotionLogAt < 200) return;
    lastMotionLogAt = now;
    const m = parseMlMotion(frame);
    if (!m) return;
    pushProxy({
      direction: 'rx', transport: 'usb', kind: 'blocks', live: true, liveKey: 'ML_MOTION',
      text: `NOTIFY ${ch} (ML_MOTION) x=${m.x} y=${m.y} z=${m.z} seq=${m.seq ?? '?'}`,
    });
    return;
  }
  if (frame.channel === ML_CHANNEL.BUTTON) {
    const b = parseMlButton(frame);
    if (!b) return;
    pushProxy({
      direction: 'rx', transport: 'usb', kind: 'blocks',
      text: `NOTIFY ${ch} (ML_BUTTON) ${b.button}=${b.state}`,
    });
    return;
  }
  const info = parseMlInfo(frame);
  if (info) {
    pushProxy({
      direction: 'rx', transport: 'usb', kind: 'blocks', live: true, liveKey: 'ML_INFO',
      text: `READ ${ch} (ML_INFO) hw=${info.hardware} protocol=${info.protocolVersion ?? '?'} period=${info.samplePeriodMs ?? '?'}ms range=${info.rangeG ?? '?'}g resyncs=${info.resyncs ?? '?'} late=${info.worstLatenessMs ?? '?'}ms up=${info.uptimeS ?? '?'}s`,
    });
  }
}
