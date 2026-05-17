/**
 * Unit tests for the log-line parser. Run with:
 *
 *     node --experimental-strip-types --test test/log-parser.test.ts
 *
 * (Node 22.6+ — earlier versions need an explicit transpile step.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LogParser, type Parsed } from '../src/log-parser.ts';

function feed(p: LogParser, ...lines: string[]): (Parsed | null)[] {
  return lines.map((l) => p.feed(l));
}

test('CSV header then numeric row', () => {
  const p = new LogParser();
  const [h, r] = feed(p, 'Time,Temperature,Light', '0.5,22,57');
  assert.deepEqual(h, { type: 'header', columns: ['Time', 'Temperature', 'Light'], separator: ',' });
  assert.deepEqual(r, { type: 'row', columns: ['Time', 'Temperature', 'Light'], values: [0.5, 22, 57] });
});

test('TSV (tab-separated) MicroBitLog-style', () => {
  const p = new LogParser();
  const [h, r1, r2] = feed(p, 'Time (s)\tTemp\tLight', '0.0\t22\t57', '0.2\t22\t58');
  assert.equal(h?.type, 'header');
  assert.deepEqual((r1 as { values: unknown[] }).values, [0.0, 22, 57]);
  assert.deepEqual((r2 as { values: unknown[] }).values, [0.2, 22, 58]);
});

test('semicolon separator (German-locale CSV)', () => {
  const p = new LogParser();
  const [h, r] = feed(p, 'x;y;z', '1;2;3');
  assert.deepEqual((h as { separator: string }).separator, ';');
  assert.deepEqual((r as { values: unknown[] }).values, [1, 2, 3]);
});

test('numeric row before any header synthesizes columns', () => {
  const p = new LogParser();
  const [r1, r2] = feed(p, '1,2,3', '4,5,6');
  assert.deepEqual((r1 as { columns: string[]; values: unknown[] }).columns, ['col1', 'col2', 'col3']);
  assert.deepEqual((r1 as { values: unknown[] }).values, [1, 2, 3]);
  assert.deepEqual((r2 as { values: unknown[] }).values, [4, 5, 6]);
});

test('header switch resets columns', () => {
  const p = new LogParser();
  feed(p, 'a,b', '1,2');
  const [h2, r2] = feed(p, 'x,y,z', '7,8,9');
  assert.deepEqual((h2 as { columns: string[] }).columns, ['x', 'y', 'z']);
  assert.deepEqual((r2 as { values: unknown[] }).values, [7, 8, 9]);
});

test('wrong column count is rejected (no false row)', () => {
  const p = new LogParser();
  feed(p, 'a,b,c');
  const [bad] = feed(p, '1,2');
  assert.equal(bad, null);
});

test('different separator after header is rejected', () => {
  const p = new LogParser();
  feed(p, 'a,b,c');
  // 3 numbers with tab — does not match the active comma header.
  const [bad] = feed(p, '1\t2\t3');
  assert.equal(bad, null);
});

test('key=value row stands alone', () => {
  const p = new LogParser();
  const [r] = feed(p, 'temp=22 light=57 x=0.5');
  assert.deepEqual((r as { columns: string[]; values: unknown[] }).columns, ['temp', 'light', 'x']);
  assert.deepEqual((r as { values: unknown[] }).values, [22, 57, 0.5]);
});

test('key:value row also detected', () => {
  const p = new LogParser();
  const [r] = feed(p, 'x:1 y:2');
  assert.deepEqual((r as { values: unknown[] }).values, [1, 2]);
});

test('mixed comma-separated key=value', () => {
  const p = new LogParser();
  const [r] = feed(p, 'a=1, b=2, c=hello');
  assert.deepEqual((r as { columns: string[] }).columns, ['a', 'b', 'c']);
  assert.deepEqual((r as { values: unknown[] }).values, [1, 2, 'hello']);
});

test('prose / REPL banner returns null', () => {
  const p = new LogParser();
  const lines = [
    'MicroPython v1.23.0',
    'Type "help()" for more information.',
    '>>> print("alive")',
    'alive',
    'Traceback (most recent call last):',
  ];
  for (const l of lines) {
    assert.equal(p.feed(l), null, `expected null for: ${l}`);
  }
});

test('empty line and single token return null', () => {
  const p = new LogParser();
  assert.equal(p.feed(''), null);
  assert.equal(p.feed('hello'), null);
  assert.equal(p.feed('42'), null);
});

test('partial-numeric row is not treated as data when no header', () => {
  // We don't try to parse mixed-numeric rows like "label,1,2" as data — too
  // ambiguous. Either a real header sets shape, or all-numeric synthesizes it.
  const p = new LogParser();
  const [r] = feed(p, 'state,1,2');
  assert.equal(r, null);
});

test('reset clears active header', () => {
  const p = new LogParser();
  feed(p, 'a,b,c', '1,2,3');
  p.reset();
  // After reset, a comma row with new shape is treated as the new synthetic shape.
  const [r] = feed(p, '4,5');
  assert.deepEqual((r as { columns: string[] }).columns, ['col1', 'col2']);
});

test('floating-point values', () => {
  const p = new LogParser();
  feed(p, 'a,b');
  const [r] = feed(p, '3.14159,2.71828');
  assert.deepEqual((r as { values: unknown[] }).values, [3.14159, 2.71828]);
});

test('negative numbers', () => {
  const p = new LogParser();
  feed(p, 'x,y');
  const [r] = feed(p, '-10,-3.5');
  assert.deepEqual((r as { values: unknown[] }).values, [-10, -3.5]);
});

test('whitespace around tokens is trimmed', () => {
  const p = new LogParser();
  const [h] = feed(p, ' Time , Temp ');
  assert.deepEqual((h as { columns: string[] }).columns, ['Time', 'Temp']);
});

test('key with whitespace inside is rejected (would be ambiguous)', () => {
  const p = new LogParser();
  // "my key=1" splits on whitespace into ["my", "key=1"] — "my" has no `=`, so
  // the whole line is rejected as not-quite-key=value.
  const [r] = feed(p, 'my key=1');
  assert.equal(r, null);
});
