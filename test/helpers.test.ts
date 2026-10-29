import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCalliopeVersion, stripMakeCodeMetadata } from '../src/helpers.ts';

// micro:bit V2 == Mini 3 (V2-class); micro:bit V1 ≈ Mini 1 & Mini 2 (V1-class).

test('USB productName "Calliope mini V3" → V3', () => {
  assert.equal(detectCalliopeVersion('Arm Calliope mini V3 CMSIS-DAP', undefined), 'V3');
});

test('USB productName "Calliope mini V1" → V1', () => {
  assert.equal(detectCalliopeVersion('Calliope mini V1', undefined), 'V1');
});

test('USB productName "Calliope mini V2" → V2', () => {
  assert.equal(detectCalliopeVersion('Calliope mini V2', undefined), 'V2');
});

test('no productName, boardVersion V2 → V3 (mini 3 is V2-class silicon)', () => {
  assert.equal(detectCalliopeVersion(undefined, 'V2'), 'V3');
});

test('no productName, boardVersion V1 → V1', () => {
  assert.equal(detectCalliopeVersion(undefined, 'V1'), 'V1');
});

test('productName without a version falls back to boardVersion', () => {
  assert.equal(detectCalliopeVersion('BBC micro:bit', 'V2'), 'V3');
});

test('nothing to go on → undefined', () => {
  assert.equal(detectCalliopeVersion(undefined, undefined), undefined);
});

test('stripMakeCodeMetadata keeps the EOF line and drops trailing metadata', () => {
  const hex = ':10000000ABCD\n:00000001FF\nMETADATA-junk-after-eof\nmore';
  const out = stripMakeCodeMetadata(hex);
  assert.ok(out.includes(':00000001FF'));
  assert.ok(!out.includes('METADATA-junk-after-eof'));
});

test('stripMakeCodeMetadata leaves a hex without EOF untouched', () => {
  const hex = ':10000000ABCD\n:10001000EF01';
  assert.equal(stripMakeCodeMetadata(hex), hex);
});
