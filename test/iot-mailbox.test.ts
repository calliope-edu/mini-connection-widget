import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IotMailbox,
  findIotExchange,
  detectIotScanFloor,
  iotLineFits,
  IOT_MAGIC0,
  IOT_MAGIC1,
  IOT_SEND_MAX,
  IOT_SCAN_FLOOR_BARE,
  IOT_SCAN_FLOOR_SOFTDEVICE,
  type IotMemIO,
} from '../src/iot-mailbox.ts';
import { findBlocksExchange, BLK_MAGIC0, BLK_MAGIC1 } from '../src/blocks-mailbox.ts';

const XCHG = 0x20006000; // the scan anchor; magic lands here so findIotExchange hits first
const OFF_SEND = 12 + 256; // host→device head
const OFF_SEND_BODY = OFF_SEND + 4;
const OFF_INBOUND_BODY = 16;

/**
 * Byte-addressable fake of the device RAM exposed over CMSIS-DAP, modelling the
 * widget's ArmDebug readBlock/writeBlock as little-endian word access. Counts
 * reads so the shared-sweep test can show that a second channel's scan costs
 * (almost) no traffic. (Cloned from blocks-mailbox.test.ts's FakeRam.)
 */
class FakeRam implements IotMemIO {
  private bytes = new Map<number, number>();
  reads = 0;

  getByte(addr: number): number {
    return this.bytes.get(addr) ?? 0;
  }
  setByte(addr: number, v: number): void {
    this.bytes.set(addr, v & 0xff);
  }
  setBytes(addr: number, arr: ArrayLike<number>): void {
    for (let i = 0; i < arr.length; i++) this.setByte(addr + i, arr[i]);
  }

  async readWords(addr: number, count: number): Promise<Uint32Array> {
    this.reads++;
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const a = addr + i * 4;
      out[i] =
        ((this.getByte(a) |
          (this.getByte(a + 1) << 8) |
          (this.getByte(a + 2) << 16) |
          (this.getByte(a + 3) << 24)) >>>
          0);
    }
    return out;
  }

  async writeWords(addr: number, words: Uint32Array): Promise<void> {
    for (let i = 0; i < words.length; i++) {
      const a = addr + i * 4;
      const w = words[i] >>> 0;
      this.setByte(a, w & 0xff);
      this.setByte(a + 1, (w >>> 8) & 0xff);
      this.setByte(a + 2, (w >>> 16) & 0xff);
      this.setByte(a + 3, (w >>> 24) & 0xff);
    }
  }

  word(addr: number): number {
    return (
      (this.getByte(addr) |
        (this.getByte(addr + 1) << 8) |
        (this.getByte(addr + 2) << 16) |
        (this.getByte(addr + 3) << 24)) >>>
      0
    );
  }

  text(addr: number, len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.getByte(addr + i));
    return s;
  }
}

/** Seed an IoT exchange header at `at` with the given IRQ number. */
function seedExchange(ram: FakeRam, irqn: number, at = XCHG): void {
  ram.writeWords(at, Uint32Array.of(IOT_MAGIC0, IOT_MAGIC1)); // signature (xchg+0,+4)
  ram.writeWords(at + 8, Uint32Array.of(irqn)); // info byte 8 = irqn
}

/** Arm the inbound slot with one line, as the device would. */
function seedInbound(ram: FakeRam, line: string, at = XCHG): void {
  const bytes = Uint8Array.from(line, (c) => c.charCodeAt(0) & 0xff);
  ram.writeWords(at + 12, Uint32Array.of((bytes.length & 0xff) << 16)); // head: byte2 = length
  ram.setBytes(at + OFF_INBOUND_BODY, bytes);
}

test('findIotExchange locates the magic at the scan anchor', async () => {
  const ram = new FakeRam();
  ram.writeWords(XCHG, Uint32Array.of(IOT_MAGIC0, IOT_MAGIC1));
  assert.equal(await findIotExchange(ram), XCHG);
});

test('findIotExchange returns null when no IoT program is present', async () => {
  const ram = new FakeRam(); // all zero
  assert.equal(await findIotExchange(ram), null);
});

test('scan() locates the mailbox, reads the irqn, and clears a stale inbound line', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 20);
  seedInbound(ram, 'IOT1:l:stale');
  const mb = new IotMailbox(ram);
  assert.equal(await mb.scan(), true);
  assert.equal(mb.available, true);
  assert.equal(mb.address, XCHG);
  assert.equal(ram.word(XCHG + 12), 0, 'stale inbound line cleared');
});

test('scan() returns false when no exchange is present', async () => {
  const ram = new FakeRam();
  const mb = new IotMailbox(ram);
  assert.equal(await mb.scan(), false);
  assert.equal(mb.available, false);
});

test('readInbound returns null on an empty slot', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 20);
  const mb = new IotMailbox(ram);
  await mb.scan();
  assert.equal(await mb.readInbound(), null);
});

test('readInbound returns one line and clears the slot', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 20);
  const mb = new IotMailbox(ram);
  await mb.scan();
  seedInbound(ram, 'IOT1:d::temperatur:21.5');

  assert.equal(await mb.readInbound(), 'IOT1:d::temperatur:21.5');
  assert.equal(ram.word(XCHG + 12), 0, 'slot cleared after read');
});

test('readInbound strips a terminator the device appended, and keeps high bytes', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 20);
  const mb = new IotMailbox(ram);
  await mb.scan();
  seedInbound(ram, 'IOT1:l:grüß\r\n');
  assert.equal(await mb.readInbound(), 'IOT1:l:grüß');
});

test('trySendOutbound writes length + latin1 body into the free slot', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 20);
  const mb = new IotMailbox(ram);
  await mb.scan();

  const line = 'IOT1:t:1750000000:120';
  assert.equal(await mb.trySendOutbound(line), true);
  assert.equal((ram.word(XCHG + OFF_SEND) >>> 16) & 0xff, line.length, 'send head length = line len');
  assert.equal(ram.text(XCHG + OFF_SEND_BODY, line.length), line);
});

test('trySendOutbound is a no-op while the slot is still occupied', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 20);
  const mb = new IotMailbox(ram);
  await mb.scan();
  ram.setByte(XCHG + OFF_SEND + 2, 0x05); // send head byte2 != 0 → busy
  assert.equal(await mb.trySendOutbound('IOT1:e:busy'), false);
});

test('trySendOutbound drops an empty or oversized line instead of retrying forever', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 20);
  const mb = new IotMailbox(ram);
  await mb.scan();

  assert.equal(await mb.trySendOutbound(''), true);
  assert.equal(ram.word(XCHG + OFF_SEND), 0, 'empty line never arms the slot');

  assert.equal(await mb.trySendOutbound('x'.repeat(IOT_SEND_MAX + 1)), true);
  assert.equal(ram.word(XCHG + OFF_SEND), 0, 'oversized line never arms the slot');
});

test('one sweep serves every channel: a Blocks scan finds the IoT mailbox for free', async () => {
  const ram = new FakeRam();
  const IOT_AT = 0x20009000; // deliberately NOT the anchor — the sweep has to walk there
  ram.writeWords(IOT_AT, Uint32Array.of(IOT_MAGIC0, IOT_MAGIC1));

  // No Blocks runtime here, so this walks the whole window — the expensive case.
  assert.equal(await findBlocksExchange(ram), null);
  const sweepReads = ram.reads;
  assert.ok(sweepReads > 20, `a full sweep should be many reads (was ${sweepReads})`);

  // The IoT magic was matched in the same already-fetched blocks, so this is a
  // single confirmation read rather than a second sweep.
  ram.reads = 0;
  assert.equal(await findIotExchange(ram), IOT_AT);
  assert.ok(ram.reads <= 2, `sighting reuse should cost ~1 read (was ${ram.reads})`);
});

test('the scan floor follows the SoftDevice, not the channel', async () => {
  const withSd = new FakeRam();
  withSd.writeWords(0x00003008, Uint32Array.of(0x51b1e5db)); // SoftDevice info magic
  assert.equal(await detectIotScanFloor(withSd), IOT_SCAN_FLOOR_SOFTDEVICE);

  const bare = new FakeRam(); // no SoftDevice in flash
  assert.equal(await detectIotScanFloor(bare), IOT_SCAN_FLOOR_BARE);

  const unreadable: IotMemIO = {
    readWords: async () => {
      throw new Error('Bad status');
    },
    writeWords: async () => {},
  };
  assert.equal(
    await detectIotScanFloor(unreadable),
    IOT_SCAN_FLOOR_SOFTDEVICE,
    'unknown must stay above the protected region',
  );
});

test('a struct below the shared floor is found only with the bare floor', async () => {
  const ram = new FakeRam();
  const LOW = 0x20001000; // below DEFAULT_MEM_START — no SoftDevice build
  ram.writeWords(LOW, Uint32Array.of(IOT_MAGIC0, IOT_MAGIC1));

  assert.equal(await findIotExchange(ram), null, 'default floor must not read down there');
  assert.equal(await findIotExchange(ram, IOT_SCAN_FLOOR_BARE), LOW);

  // The lower floor is ours alone: Blocks/Jacdac windows are untouched, so a
  // Blocks magic down there stays invisible to them.
  const blocksLow = new FakeRam();
  blocksLow.writeWords(LOW, Uint32Array.of(BLK_MAGIC0, BLK_MAGIC1));
  blocksLow.writeWords(0x20009000, Uint32Array.of(IOT_MAGIC0, IOT_MAGIC1));
  assert.equal(await findIotExchange(blocksLow, IOT_SCAN_FLOOR_BARE), 0x20009000);
  assert.equal(await findBlocksExchange(blocksLow), null, 'no sighting below the Blocks floor');
});

test('iotLineFits guards the 64-byte host→device cap', () => {
  assert.equal(iotLineFits('IOT1:v:0::temperatur:21.5'), true);
  assert.equal(iotLineFits('x'.repeat(IOT_SEND_MAX)), true);
  assert.equal(iotLineFits('x'.repeat(IOT_SEND_MAX + 1)), false);
  assert.equal(iotLineFits(`${'x'.repeat(IOT_SEND_MAX)}\r\n`), true, 'terminator is not payload');
});

test('a remembered sighting is re-verified, never trusted blindly', async () => {
  const ram = new FakeRam();
  const IOT_AT = 0x20009000;
  ram.writeWords(IOT_AT, Uint32Array.of(IOT_MAGIC0, IOT_MAGIC1));
  ram.writeWords(0x2000a000, Uint32Array.of(BLK_MAGIC0, BLK_MAGIC1));
  assert.equal(await findIotExchange(ram), IOT_AT);

  // Same session, different program: the magic is gone from that address. The
  // stale sighting must not be handed out.
  const reflashed = new FakeRam();
  assert.equal(await findIotExchange(reflashed), null);
});
