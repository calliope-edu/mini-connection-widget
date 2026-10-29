import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlocksFrame,
  BlocksFrameParser,
  BLOCKS_SFD,
  BLOCKS_RES,
  characteristicToChannel,
} from '../src/blocks-frame.ts';

// chksum8 mirror (sum of preceding bytes mod 0xFF) for assertions.
function chk(bytes: number[]): number {
  let s = 0;
  for (const b of bytes) s = (s + b) % 0xff;
  return s;
}

test('buildBlocksFrame lays out [SFD, type, ch_hi, ch_lo, len, ...data, chk]', () => {
  const f = buildBlocksFrame(BLOCKS_RES.NOTIFY, 0x0101, new Uint8Array([0x05, 0xff]));
  assert.equal(f[0], BLOCKS_SFD);
  assert.equal(f[1], 0x21);
  assert.equal(f[2], 0x01);
  assert.equal(f[3], 0x01);
  assert.equal(f[4], 2);
  assert.equal(f[5], 0x05);
  assert.equal(f[6], 0xff);
  assert.equal(f[7], chk([...f.slice(0, 7)]));
});

test('parser round-trips a built frame, preserving bytes ≥ 0x80', () => {
  const data = new Uint8Array([0x00, 0x80, 0xff, 0x7f]);
  const f = buildBlocksFrame(BLOCKS_RES.READ, 0x0130, data);
  const frames = new BlocksFrameParser().push(f);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, BLOCKS_RES.READ);
  assert.equal(frames[0].channel, 0x0130);
  assert.deepEqual([...frames[0].data], [...data]);
});

test('parser resyncs past leading garbage', () => {
  const f = buildBlocksFrame(BLOCKS_RES.NOTIFY, 0x0102, new Uint8Array([0x01]));
  const stream = new Uint8Array([0x00, 0x12, 0x34, ...f]);
  const frames = new BlocksFrameParser().push(stream);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].channel, 0x0102);
});

test('parser reassembles a frame split across chunks', () => {
  const f = buildBlocksFrame(BLOCKS_RES.WRITE_RESPONSE, 0x0100, new Uint8Array([0xaa, 0xbb]));
  const p = new BlocksFrameParser();
  assert.equal(p.push(f.slice(0, 3)).length, 0);
  const frames = p.push(f.slice(3));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0].data], [0xaa, 0xbb]);
});

test('parser drops a frame with a bad checksum', () => {
  const f = buildBlocksFrame(BLOCKS_RES.READ, 0x0101, new Uint8Array([0x01]));
  f[f.length - 1] ^= 0xff; // corrupt the checksum
  assert.equal(new BlocksFrameParser().push(f).length, 0);
});

test('characteristicToChannel resolves numbers, known UUIDs, and the fallback', () => {
  assert.equal(characteristicToChannel(0x0101), 0x0101);
  assert.equal(characteristicToChannel('0b500130-607f-4151-9091-7d008d6ffc5c'), 0x0130);
  // unknown 0b50XXXX UUID → extract the middle 16 bits
  assert.equal(characteristicToChannel('0b500199-607f-4151-9091-7d008d6ffc5c'), 0x0199);
});
