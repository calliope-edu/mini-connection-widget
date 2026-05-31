import { test } from 'node:test';
import assert from 'node:assert/strict';
// BlocksUsbProbe drives program-type.ts's USB Blocks detection; it lives in the
// dependency-free leaf so it (and this test) load under the Node test runner.
import { BlocksUsbProbe } from '../src/blocks-frame.ts';

const SFD = 0xff;

test('two SFD + valid-response-type pairs confirm Blocks', () => {
  const p = new BlocksUsbProbe(2);
  assert.equal(p.push([SFD, 0x01, SFD, 0x21]), true);
});

test('a single pair does not confirm (needs two)', () => {
  const p = new BlocksUsbProbe(2);
  assert.equal(p.push([SFD, 0x01]), false);
});

test('state carries across chunk boundaries', () => {
  const p = new BlocksUsbProbe(2);
  assert.equal(p.push([SFD]), false);      // SFD at end of chunk
  assert.equal(p.push([0x11]), false);     // valid RES → 1 hit
  assert.equal(p.push([SFD, 0x21]), true); // second pair → confirm
});

test('SFD followed by a non-response byte is not a hit', () => {
  const p = new BlocksUsbProbe(2);
  // 0x05 is not a Blocks response type (0x01/0x11/0x21)
  assert.equal(p.push([SFD, 0x05, SFD, 0x06]), false);
});

test('arbitrary serial without the SFD+RES shape does not confirm', () => {
  const p = new BlocksUsbProbe(2);
  assert.equal(p.push([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x0a]), false); // "Hello\n"
});

test('confirmHits=1 confirms on the first pair', () => {
  assert.equal(new BlocksUsbProbe(1).push([SFD, 0x11]), true);
});
