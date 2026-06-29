import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDapOwner, setDapOwner, onDapOwnerChange } from '../src/dap-arbiter.ts';

// The arbiter is a module singleton; reset to null at the start of each test so
// ordering can't leak state between them.
function reset() {
  setDapOwner(null);
}

test('owner defaults to null and round-trips through set/get', () => {
  reset();
  assert.equal(getDapOwner(), null);
  setDapOwner('blocks');
  assert.equal(getDapOwner(), 'blocks');
  setDapOwner('jacdac');
  assert.equal(getDapOwner(), 'jacdac');
});

test('listeners fire with the new owner on every change', () => {
  reset();
  const seen: (string | null)[] = [];
  const off = onDapOwnerChange((o) => seen.push(o));
  setDapOwner('blocks');
  setDapOwner('jacdac');
  setDapOwner(null);
  off();
  assert.deepEqual(seen, ['blocks', 'jacdac', null]);
});

test('setting the same owner is idempotent (no notification)', () => {
  reset();
  let calls = 0;
  const off = onDapOwnerChange(() => calls++);
  setDapOwner('blocks');
  setDapOwner('blocks');
  setDapOwner('blocks');
  off();
  assert.equal(calls, 1, 'only the real transition notifies');
});

test('unsubscribe stops further notifications', () => {
  reset();
  let calls = 0;
  const off = onDapOwnerChange(() => calls++);
  setDapOwner('blocks');
  off();
  setDapOwner('jacdac');
  assert.equal(calls, 1);
});

test('a throwing listener does not block the others', () => {
  reset();
  let reached = false;
  const off1 = onDapOwnerChange(() => {
    throw new Error('boom');
  });
  const off2 = onDapOwnerChange(() => {
    reached = true;
  });
  setDapOwner('blocks');
  off1();
  off2();
  assert.equal(reached, true);
});

test('exclusion intent: only the owning side is permitted at a time', () => {
  // Mirrors the send-guard checks in jacdac.ts / blocks-dap.ts.
  reset();
  const jacdacAllowed = () => getDapOwner() !== 'blocks';
  const blocksAllowed = () => getDapOwner() !== 'jacdac';

  setDapOwner('blocks');
  assert.equal(jacdacAllowed(), false, 'jacdac inert while Blocks owns the bus');
  assert.equal(blocksAllowed(), true);

  setDapOwner('jacdac');
  assert.equal(blocksAllowed(), false, 'blocks inert while Jacdac owns the bus');
  assert.equal(jacdacAllowed(), true);

  setDapOwner(null);
  assert.equal(jacdacAllowed(), true, 'no owner ⇒ neither is force-blocked');
  assert.equal(blocksAllowed(), true);
});
