import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JacdacMailbox,
  findExchange,
  JD_MAGIC0,
  JD_MAGIC1,
  type JacdacMemIO,
} from '../src/jacdac-mailbox.ts';

const XCHG = 0x20006000; // the scan anchor; magic lands here so findExchange hits first
const NVIC_ISPR0 = 0xe000e200;

/**
 * Byte-addressable fake of the device RAM exposed over CMSIS-DAP, modelling the
 * widget's ArmDebug readBlock/writeBlock as little-endian word access (ARM is
 * LE, matching how the real ArmDebug reinterprets memory). Records writes into
 * the NVIC ISPR region so tests can assert the IRQ was pended.
 */
class FakeRam implements JacdacMemIO {
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

/** Seed a valid exchange header at XCHG with the given IRQ number. */
function seedExchange(ram: FakeRam, irqn: number): void {
  ram.writeWords(XCHG, Uint32Array.of(JD_MAGIC0, JD_MAGIC1)); // signature (xchg+0, +4)
  ram.writeWords(XCHG + 8, Uint32Array.of(irqn)); // info[8] = irqn
  ram.writeWords(XCHG + 12, Uint32Array.of(0x00ff0000)); // info[14] = 0xff (valid)
  ram.irqWrites = []; // ignore seeding writes
}

test('findExchange locates the magic at the scan anchor', async () => {
  const ram = new FakeRam();
  ram.writeWords(XCHG, Uint32Array.of(JD_MAGIC0, JD_MAGIC1));
  assert.equal(await findExchange(ram), XCHG);
});

test('findExchange returns null when no Jacdac program is present', async () => {
  const ram = new FakeRam(); // all zero
  assert.equal(await findExchange(ram), null);
});

test('scan() locates the mailbox, validates memory, and clears the lock', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 23);
  const mb = new JacdacMailbox(ram);
  assert.equal(await mb.scan(), true);
  assert.equal(mb.available, true);
  // initial lock at xchg+12 cleared to 0 (microbit.ts:569)
  assert.equal(ram.word(XCHG + 12), 0);
});

test('scan() throws JacdacInvalidMemoryError when the validity byte is wrong', async () => {
  const ram = new FakeRam();
  ram.writeWords(XCHG, Uint32Array.of(JD_MAGIC0, JD_MAGIC1));
  ram.writeWords(XCHG + 8, Uint32Array.of(23));
  ram.writeWords(XCHG + 12, Uint32Array.of(0x00aa0000)); // info[14] = 0xaa, not 0xff
  const mb = new JacdacMailbox(ram);
  await assert.rejects(() => mb.scan(), /invalid/i);
});

test('readInbound returns null on an empty slot', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 23);
  const mb = new JacdacMailbox(ram);
  await mb.scan();
  assert.equal(await mb.readInbound(), null);
});

test('readInbound returns the frame, clears the slot, and pends the IRQ', async () => {
  const ram = new FakeRam();
  const irqn = 23;
  seedExchange(ram, irqn);
  const mb = new JacdacMailbox(ram);
  await mb.scan();

  // A 16-byte frame: header(12) + payload, size byte at offset 2 = 4.
  const frame = Uint8Array.from([0xaa, 0xbb, 0x04, 0xcc, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  ram.setBytes(XCHG + 12, frame);
  ram.irqWrites = [];

  const got = await mb.readInbound();
  assert.deepEqual(got, frame);
  assert.equal(ram.word(XCHG + 12), 0, 'slot cleared after read');
  assert.equal(ram.irqWrites.length, 1, 'one IRQ pended');
  assert.equal(ram.irqWrites[0].addr, NVIC_ISPR0 + (irqn >> 5) * 4);
  assert.equal(ram.irqWrites[0].value, (1 << (irqn & 31)) >>> 0);
});

test('trySendOutbound writes head+body into the free slot and pends the IRQ', async () => {
  const ram = new FakeRam();
  const irqn = 5;
  seedExchange(ram, irqn);
  const mb = new JacdacMailbox(ram);
  await mb.scan();
  ram.irqWrites = [];

  const sendBase = XCHG + 12 + 256;
  const frame = Uint8Array.from([10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33]); // 12 bytes
  assert.equal(await mb.trySendOutbound(frame), true);

  // head = bytes 0..3 at sendBase; body = bytes 4.. at sendBase+4
  assert.deepEqual(
    Uint8Array.from([ram.getByte(sendBase), ram.getByte(sendBase + 1), ram.getByte(sendBase + 2), ram.getByte(sendBase + 3)]),
    frame.slice(0, 4),
  );
  for (let i = 0; i < 8; i++) assert.equal(ram.getByte(sendBase + 4 + i), frame[4 + i]);
  assert.equal(ram.irqWrites.length, 1);
});

test('resetTarget writes DEMCR=0 then AIRCR=SYSRESETREQ', async () => {
  const ram = new FakeRam();
  const mb = new JacdacMailbox(ram);
  await mb.resetTarget();
  assert.equal(ram.word(0xe000edfc), 0, 'DEMCR cleared');
  assert.equal(ram.word(0xe000ed0c) >>> 0, (0x05fa0000 | (1 << 2)) >>> 0, 'AIRCR VECTKEY|SYSRESETREQ');
});

test('trySendOutbound is a no-op while the slot is still occupied', async () => {
  const ram = new FakeRam();
  seedExchange(ram, 5);
  const mb = new JacdacMailbox(ram);
  await mb.scan();
  const sendBase = XCHG + 12 + 256;
  ram.setByte(sendBase + 2, 0x05); // send[2] != 0 → busy
  ram.irqWrites = [];
  assert.equal(await mb.trySendOutbound(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), false);
  assert.equal(ram.irqWrites.length, 0, 'no write/IRQ while busy');
});
