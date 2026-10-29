import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BlocksMailbox,
  findBlocksExchange,
  BLK_MAGIC0,
  BLK_MAGIC1,
  type BlocksMemIO,
} from '../src/blocks-mailbox.ts';

const XCHG = 0x20006000; // the scan anchor; magic lands here so findBlocksExchange hits first
const NVIC_ISPR0 = 0xe000e200;
const OFF_SEND = 12 + 256; // host→device head
const OFF_SEND_BODY = OFF_SEND + 4;
const OFF_INBOUND_BODY = 16;

/**
 * Byte-addressable fake of the device RAM exposed over CMSIS-DAP, modelling the
 * widget's ArmDebug readBlock/writeBlock as little-endian word access. Records
 * writes into the NVIC ISPR region so tests can assert the IRQ was pended.
 * (Cloned from jacdac-mailbox.test.ts's FakeRam.)
 */
class FakeRam implements BlocksMemIO {
  private bytes = new Map<number, number>();
  irqWrites: { addr: number; value: number }[] = [];

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
      if (a >= NVIC_ISPR0 && a < NVIC_ISPR0 + 0x80) this.irqWrites.push({ addr: a, value: w });
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
}

/** Seed a Blocks exchange header at XCHG with the given IRQ number. */
function seedExchange(ram: FakeRam, irqn: number): void {
  ram.writeWords(XCHG, Uint32Array.of(BLK_MAGIC0, BLK_MAGIC1)); // signature (xchg+0,+4)
  ram.writeWords(XCHG + 8, Uint32Array.of(irqn)); // info byte 8 = irqn
  ram.irqWrites = []; // ignore seeding writes
}

test('findBlocksExchange locates the magic at the scan anchor', async () => {
  const ram = new FakeRam();
  ram.writeWords(XCHG, Uint32Array.of(BLK_MAGIC0, BLK_MAGIC1));
  assert.equal(await findBlocksExchange(ram), XCHG);
});

test('findBlocksExchange returns null when no Blocks-DAP runtime is present', async () => {
  const ram = new FakeRam(); // all zero
  assert.equal(await findBlocksExchange(ram), null);
});

test('scan() locates the mailbox, reads the irqn, and clears any stale inbound frame', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 20);
  ram.writeWords(XCHG + 12, Uint32Array.of(0x00050000)); // stale inbound frame (size 5)
  const mb = new BlocksMailbox(ram);
  assert.equal(await mb.scan(), true);
  assert.equal(mb.available, true);
  assert.equal(ram.word(XCHG + 12), 0, 'stale inbound frame cleared');
});

test('scan() returns false when no exchange is present', async () => {
  const ram = new FakeRam();
  const mb = new BlocksMailbox(ram);
  assert.equal(await mb.scan(), false);
  assert.equal(mb.available, false);
});

test('readInbound returns null on an empty slot', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 20);
  const mb = new BlocksMailbox(ram);
  await mb.scan();
  assert.equal(await mb.readInbound(), null);
});

test('readInbound returns the Blocks frame and clears the slot (IRQ pend off for the polling spike)', async () => {
  const ram = new FakeRam();
  const irqn = 20;
  seedExchange(ram, irqn);
  const mb = new BlocksMailbox(ram);
  await mb.scan();

  // A 6-byte Blocks frame [SFD, type, ch_hi, ch_lo, len, chksum]; size byte = 6.
  const frame = Uint8Array.from([0xff, 0x01, 0x01, 0x00, 0x00, 0x02]);
  ram.writeWords(XCHG + 12, Uint32Array.of((frame.length & 0xff) << 16)); // head: byte2 = 6
  ram.setBytes(XCHG + OFF_INBOUND_BODY, frame);
  ram.irqWrites = [];

  const got = await mb.readInbound();
  assert.deepEqual(got, frame);
  assert.equal(ram.word(XCHG + 12), 0, 'slot cleared after read');
  assert.equal(ram.irqWrites.length, 0, 'no IRQ pended (polling spike)');
});

test('trySendOutbound writes head+body into the free slot (IRQ pend off for the polling spike)', async () => {
  const ram = new FakeRam();
  const irqn = 20;
  seedExchange(ram, irqn);
  const mb = new BlocksMailbox(ram);
  await mb.scan();
  ram.irqWrites = [];

  const frame = Uint8Array.from([0xff, 0x10, 0x01, 0x00, 0x02, 0x41, 0x01, 0x55]); // 8 bytes
  assert.equal(await mb.trySendOutbound(frame), true);

  assert.equal((ram.word(XCHG + OFF_SEND) >>> 16) & 0xff, frame.length, 'send head size = frame len');
  for (let i = 0; i < frame.length; i++) {
    assert.equal(ram.getByte(XCHG + OFF_SEND_BODY + i), frame[i], `send body byte ${i}`);
  }
  assert.equal(ram.irqWrites.length, 0, 'no IRQ pended (polling spike)');
});

test('trySendOutbound is a no-op while the slot is still occupied', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 20);
  const mb = new BlocksMailbox(ram);
  await mb.scan();
  ram.setByte(XCHG + OFF_SEND + 2, 0x05); // send head byte2 != 0 → busy
  ram.irqWrites = [];
  assert.equal(await mb.trySendOutbound(Uint8Array.from([1, 2, 3, 4, 5, 6])), false);
  assert.equal(ram.irqWrites.length, 0, 'no write/IRQ while busy');
});
