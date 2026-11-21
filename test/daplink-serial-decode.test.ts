import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlocksFrameParser, buildBlocksFrame, BLOCKS_RES } from '../src/blocks-frame.ts';

// The patched DAPLink serial reader (patches/@microbit__microbit-connection*.patch).
// The package's exports do not reach it, so it is loaded by path.
const { DapLinkSerial } = await import(
  new URL('../node_modules/@microbit/microbit-connection/build/esm/usb/daplink.js', import.meta.url).href
);

/** A DAP whose vendor serial read answers `bytes` once: [cmd, length, ...data]. */
const dapAnswering = (bytes: number[]) => ({
  send: async () => new DataView(new Uint8Array([0x83, bytes.length, ...bytes]).buffer),
});

const read = async (bytes: number[]): Promise<string> =>
  new DapLinkSerial(dapAnswering(bytes), { log() {}, error() {} }).read();

test('DAPLink serial read keeps every byte, 0x80-0x9F included', async () => {
  // TextDecoder('iso-8859-1') is windows-1252 and turned 0x80 into U+20AC.
  const bytes = Array.from({ length: 62 }, (_, i) => (0x80 + i) & 0xff);
  const text = await read(bytes);
  assert.deepEqual(
    Array.from(text, (c) => c.charCodeAt(0)),
    bytes,
  );
});

test('a Blocks frame with bytes in 0x80-0x9F survives the DAPLink read', async () => {
  // An ML data program MOTION frame whose x, sequence and checksum hit that range.
  const frame = buildBlocksFrame(BLOCKS_RES.NOTIFY, 0x0203, new Uint8Array([0x85, 0x00, 0x10, 0x00, 0xf0, 0x03, 0x9a]));
  const text = await read([...frame]);
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
  const [parsed] = new BlocksFrameParser().push(bytes);
  assert.equal(parsed?.channel, 0x0203);
  assert.deepEqual([...parsed.data], [0x85, 0x00, 0x10, 0x00, 0xf0, 0x03, 0x9a]);
});

test('ASCII serial lines read as before', async () => {
  const text = await read([...'IOT1:hello\n'].map((c) => c.charCodeAt(0)));
  assert.equal(text, 'IOT1:hello\n');
});
