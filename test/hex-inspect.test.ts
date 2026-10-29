import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHexRamClass, inspectHex } from '../src/hex-inspect.ts';

// Minimal Intel HEX builder for fixtures. Each line: ":LLAAAATT....CC\n"
// Emits type-04 extended-linear-address records so blocks above 64 KiB
// (e.g. the DAL app vector table at 0x18000) land at the right address.
function buildHex(blocks: { addr: number; bytes: number[] }[]): string {
  const lines: string[] = [];
  const record = (bytes: number[]): string => {
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xff;
    const cc = (0x100 - sum) & 0xff;
    return ':' + bytes.concat([cc]).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  };
  let upper = 0;
  for (const { addr, bytes } of blocks) {
    // Split into 16-byte records so MemoryMap parses happily.
    for (let off = 0; off < bytes.length; off += 16) {
      const chunk = bytes.slice(off, off + 16);
      const full = addr + off;
      const hi = (full >> 16) & 0xffff;
      if (hi !== upper) {
        upper = hi;
        lines.push(record([0x02, 0x00, 0x00, 0x04, (hi >> 8) & 0xff, hi & 0xff]));
      }
      const aaaa = full & 0xffff;
      lines.push(record([chunk.length, (aaaa >> 8) & 0xff, aaaa & 0xff, 0x00, ...chunk]));
    }
  }
  // EOF record
  lines.push(':00000001FF');
  return lines.join('\n') + '\n';
}

const MAKECODE = [
  0x70, 0x8e, 0x3b, 0x92, 0xc6, 0x15, 0xa8, 0x41,
  0xc4, 0x98, 0x66, 0xc9, 0x75, 0xee, 0x51, 0x97,
];
const UPY1 = [0xfe, 0x30, 0x7f, 0x59];
const UPY2 = [0x9d, 0xd7, 0xb1, 0xc1];

test('detects MakeCode magic at 16-byte aligned offset', () => {
  const padding = Array.from({ length: 32 }, () => 0);
  const bytes = padding.concat(MAKECODE).concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const hex = buildHex([{ addr: 0x1000, bytes }]);
  assert.equal(inspectHex(hex).flavor, 'makecode');
});

test('detects MicroPython firmware (MAGIC1 + MAGIC2)', () => {
  // MicroPython embeds MAGIC1 then MAGIC2 16 bytes apart.
  const filler = Array.from({ length: 12 }, () => 0xff);
  const bytes = UPY1.concat(filler).concat(UPY2).concat([0, 0, 0, 0]);
  const hex = buildHex([{ addr: 0x1000, bytes }]);
  assert.equal(inspectHex(hex).flavor, 'micropython');
});

test('arbitrary bytes return unknown', () => {
  const bytes = Array.from({ length: 64 }, (_, i) => (i * 7) & 0xff);
  const hex = buildHex([{ addr: 0x1000, bytes }]);
  assert.equal(inspectHex(hex).flavor, 'unknown');
});

test('empty input returns unknown rather than throwing', () => {
  assert.equal(inspectHex('').flavor, 'unknown');
});

test('malformed hex returns unknown rather than throwing', () => {
  assert.equal(inspectHex('not a hex file at all').flavor, 'unknown');
});

test('MakeCode wins over a coincidental MicroPython byte collision', () => {
  // Put both markers in the same image; MakeCode marker should classify it.
  const filler = Array.from({ length: 12 }, () => 0xff);
  const upy = UPY1.concat(filler).concat(UPY2);
  // MakeCode magic at a 16-byte boundary
  const padding = Array.from({ length: 16 }, () => 0);
  const bytes = padding.concat(MAKECODE).concat(filler).concat(upy);
  const hex = buildHex([{ addr: 0x1000, bytes }]);
  assert.equal(inspectHex(hex).flavor, 'makecode');
});

// ---- detectHexRamClass ------------------------------------------------------

/** Vector table stub: initial MSP (LE u32) + a plausible reset vector. */
function vectorTable(msp: number): number[] {
  return [
    msp & 0xff, (msp >> 8) & 0xff, (msp >> 16) & 0xff, (msp >> 24) & 0xff,
    0xc1, 0x81, 0x01, 0x00,
  ];
}

test('32 KB DAL hex: MSP 0x20008000 at the app vector table (0x18000)', () => {
  const hex = buildHex([{ addr: 0x18000, bytes: vectorTable(0x20008000) }]);
  assert.equal(detectHexRamClass(hex), '32kb');
});

test('16 KB DAL hex: MSP 0x20004000 at the app vector table (0x18000)', () => {
  const hex = buildHex([{ addr: 0x18000, bytes: vectorTable(0x20004000) }]);
  assert.equal(detectHexRamClass(hex), '16kb');
});

test('softdevice-less image: vector table at 0x0 is used as fallback', () => {
  const hex = buildHex([{ addr: 0x0, bytes: vectorTable(0x20004000) }]);
  assert.equal(detectHexRamClass(hex), '16kb');
});

test('the 0x18000 table wins over 0x0 (softdevice MSP is not the app MSP)', () => {
  const hex = buildHex([
    { addr: 0x0, bytes: vectorTable(0x20004000) },
    { addr: 0x18000, bytes: vectorTable(0x20008000) },
  ]);
  assert.equal(detectHexRamClass(hex), '32kb');
});

test('nRF52 (mini 3) MSP outside nRF51 RAM classes returns undefined', () => {
  const hex = buildHex([{ addr: 0x18000, bytes: vectorTable(0x20020000) }]);
  assert.equal(detectHexRamClass(hex), undefined);
});

test('non-RAM MSP (flash address) returns undefined', () => {
  const hex = buildHex([{ addr: 0x18000, bytes: vectorTable(0x00018000) }]);
  assert.equal(detectHexRamClass(hex), undefined);
});

test('malformed input returns undefined rather than throwing', () => {
  assert.equal(detectHexRamClass('not a hex file'), undefined);
  assert.equal(detectHexRamClass(''), undefined);
});
