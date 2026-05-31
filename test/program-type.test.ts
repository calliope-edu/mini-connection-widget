import { test } from 'node:test';
import assert from 'node:assert/strict';
// BlocksUsbProbe drives program-type.ts's USB Blocks detection; it lives in the
// dependency-free leaf so it (and this test) load under the Node test runner.
import { BlocksUsbProbe, buildBlocksFrame, BLOCKS_RES } from '../src/blocks-frame.ts';

const frame = (type: number, ch: number, data: number[] = []) =>
  buildBlocksFrame(type, ch, new Uint8Array(data));

test('two checksum-valid frames confirm Blocks', () => {
  const p = new BlocksUsbProbe(2);
  assert.equal(p.push(frame(BLOCKS_RES.READ, 0x0100, [0x01])), false);
  assert.equal(p.push(frame(BLOCKS_RES.NOTIFY, 0x0101, [0x02, 0x03])), true);
});

test('a single valid frame does not confirm (needs two)', () => {
  assert.equal(new BlocksUsbProbe(2).push(frame(BLOCKS_RES.READ, 0x0100, [0x01])), false);
});

test('a bare SFD + response byte (no valid frame) does NOT false-positive', () => {
  // The pre-hardening heuristic confirmed on this; the checksum-validated probe
  // must not — there is no complete frame with a matching checksum here.
  const p = new BlocksUsbProbe(2);
  assert.equal(p.push([0xff, 0x01, 0xff, 0x21]), false);
});

test('a frame with a corrupted checksum does not count', () => {
  const f = frame(BLOCKS_RES.READ, 0x0100, [0x01]);
  f[f.length - 1] ^= 0xff;
  assert.equal(new BlocksUsbProbe(1).push(f), false);
});

test('state carries across chunk boundaries (frame split mid-stream)', () => {
  const f = frame(BLOCKS_RES.WRITE_RESPONSE, 0x0100, [0xaa, 0xbb]);
  const p = new BlocksUsbProbe(1);
  assert.equal(p.push(f.slice(0, 3)), false);
  assert.equal(p.push(f.slice(3)), true);
});

test('arbitrary serial without valid frames does not confirm', () => {
  assert.equal(new BlocksUsbProbe(1).push([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x0a]), false); // "Hello\n"
});

test('confirmHits=1 confirms on the first valid frame', () => {
  assert.equal(new BlocksUsbProbe(1).push(frame(BLOCKS_RES.NOTIFY, 0x0130, [0x05])), true);
});
