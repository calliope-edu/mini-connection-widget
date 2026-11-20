import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlocksFrameParser, BlocksUsbProbe, buildBlocksFrame, BLOCKS_RES } from '../src/blocks-frame.ts';
import {
  ML_CHANNEL,
  ML_MAX_REOPENS,
  ML_STALL_MS,
  MlStreamWatch,
  isMlChannel,
  parseMlButton,
  parseMlInfo,
  parseMlMotion,
} from '../src/ml-frame.ts';

const frame = (type: number, ch: number, data: number[] = []) =>
  buildBlocksFrame(type, ch, new Uint8Array(data));

const parse = (bytes: Uint8Array) => new BlocksFrameParser().push(bytes);

// What the ML data program sends (ml-trainer microbit/calliope/source/MlUsb.h).
const INFO = frame(BLOCKS_RES.READ, 0x0200, [2, 0x4d, 1, 1, 20, 2, 0, 3, 0x10, 0x02]);
const motion = (x: number, y: number, z: number, seq: number) => {
  const d = new DataView(new ArrayBuffer(7));
  d.setInt16(0, x, true);
  d.setInt16(2, y, true);
  d.setInt16(4, z, true);
  d.setUint8(6, seq);
  return frame(BLOCKS_RES.NOTIFY, 0x0203, [...new Uint8Array(d.buffer)]);
};

test('ML_INFO identifies the ML data program', () => {
  const [f] = parse(INFO);
  assert.deepEqual(parseMlInfo(f), {
    hardware: 2,
    protocolVersion: 1,
    firmwareBuild: 1,
    samplePeriodMs: 20,
    rangeG: 2,
    resyncs: 0,
    worstLatenessMs: 3,
    uptimeS: 0x0210,
  });
});

test('the Blocks runtime COMMAND reply is not ML_INFO', () => {
  const [f] = parse(frame(BLOCKS_RES.READ, 0x0100, [1, 2, 0, 9]));
  assert.equal(parseMlInfo(f), null);
  // Nor is a 0x0200 reply without the 'M' marker.
  const [g] = parse(frame(BLOCKS_RES.READ, 0x0200, [2, 0x00]));
  assert.equal(parseMlInfo(g), null);
});

test('MOTION decodes signed milli-g and the sequence number', () => {
  const [f] = parse(motion(-1024, 12, 1023, 255));
  assert.deepEqual(parseMlMotion(f), { x: -1024, y: 12, z: 1023, seq: 255 });
  assert.equal(parseMlMotion(parse(INFO)[0]), null);
});

test('MOTION frames whose values contain 0xFF parse back to back', () => {
  // -1 is FF FF: the parser must not resync inside a frame.
  const stream = new Uint8Array([...motion(-1, -1, -1, 1), ...motion(-256, 255, -2, 2)]);
  const frames = parse(stream);
  assert.equal(frames.length, 2);
  assert.deepEqual(parseMlMotion(frames[0]), { x: -1, y: -1, z: -1, seq: 1 });
  assert.deepEqual(parseMlMotion(frames[1]), { x: -256, y: 255, z: -2, seq: 2 });
});

test('BUTTON decodes A/B and the BLE button states', () => {
  assert.deepEqual(parseMlButton(parse(frame(BLOCKS_RES.NOTIFY, 0x0210, [1, 1]))[0]), {
    button: 'A',
    state: 1,
  });
  assert.deepEqual(parseMlButton(parse(frame(BLOCKS_RES.NOTIFY, 0x0210, [2, 2]))[0]), {
    button: 'B',
    state: 2,
  });
  assert.equal(parseMlButton(parse(frame(BLOCKS_RES.NOTIFY, 0x0210, [3, 1]))[0]), null);
});

test('0x02xx is the ML range, 0x01xx is Blocks', () => {
  assert.equal(isMlChannel(ML_CHANNEL.INFO), true);
  assert.equal(isMlChannel(ML_CHANNEL.MOTION), true);
  assert.equal(isMlChannel(ML_CHANNEL.BUTTON), true);
  assert.equal(isMlChannel(0x0100), false);
  assert.equal(isMlChannel(0x0130), false);
});

test('a second of the ML stream would confirm Blocks if 0x02xx frames counted', () => {
  // Why program-type.ts skips 0x02xx frames: the generic Blocks fallback
  // confirms on any two checksum-valid frames.
  assert.equal(new BlocksUsbProbe(2).push([...motion(0, 0, 1000, 0), ...motion(0, 0, 1000, 1)]), true);
});

test('the stall watch arms on ML_INFO only', () => {
  const w = new MlStreamWatch();
  assert.equal(w.noteFrame(parse(motion(0, 0, 0, 0))[0], 0), false);
  assert.equal(w.running, false);
  assert.equal(w.noteFrame(parse(frame(BLOCKS_RES.READ, 0x0100, [1, 2]))[0], 0), false);
  assert.equal(w.noteFrame(parse(INFO)[0], 0), true);
  assert.equal(w.running, true);
  assert.equal(w.latestInfo?.hardware, 2);
  // Already armed: no second "armed" edge.
  assert.equal(w.noteFrame(parse(INFO)[0], 10), false);
});

test('the stall watch reopens after 3 s of silence, then gives the program up', () => {
  const w = new MlStreamWatch();
  w.noteFrame(parse(INFO)[0], 0);
  let last = 0;
  for (let t = 20; t < ML_STALL_MS; t += 20) {
    w.noteFrame(parse(motion(0, 0, 0, t / 20))[0], t);
    assert.equal(w.check(t), null);
    last = t;
  }
  // Silent since `last`.
  assert.equal(w.check(last + ML_STALL_MS - 1), null);
  let t = last + ML_STALL_MS;
  const actions: (string | null)[] = [];
  for (; t <= ML_STALL_MS * (ML_MAX_REOPENS + 3); t += 500) {
    const a = w.check(t);
    if (a) actions.push(a);
  }
  assert.deepEqual(actions, [...Array(ML_MAX_REOPENS).fill('reopen'), 'lost']);
  assert.equal(w.running, false);
  assert.equal(w.check(t + ML_STALL_MS), null);
});

test('a frame after a reopen keeps the program running', () => {
  const w = new MlStreamWatch();
  w.noteFrame(parse(INFO)[0], 0);
  assert.equal(w.check(ML_STALL_MS), 'reopen');
  w.noteFrame(parse(motion(1, 2, 3, 4))[0], ML_STALL_MS + 100);
  assert.equal(w.check(ML_STALL_MS * 2), null);
  // The count of fruitless reopens started over.
  const actions: (string | null)[] = [];
  for (let t = ML_STALL_MS * 2 + 100; t < ML_STALL_MS * 7; t += 500) {
    const a = w.check(t);
    if (a) actions.push(a);
  }
  assert.deepEqual(actions, [...Array(ML_MAX_REOPENS).fill('reopen'), 'lost']);
});
