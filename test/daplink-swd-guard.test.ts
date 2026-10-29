import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTargetHeldHalted, waitForDaplinkSwdRelease } from '../src/daplink-swd-guard.ts';

const DHCSR = 0xe000edf0;
const S_HALT = 1 << 17;

/** Fake ArmDebug whose DHCSR answers come from a script, one per probe. */
function fakeAdi(dhcsrs: (number | Error)[]) {
  const calls: string[] = [];
  return {
    calls,
    dap: {
      async connect() {
        calls.push('connect');
      },
    },
    async readMem32(address: number) {
      calls.push(`read:${address.toString(16)}`);
      const next = dhcsrs.length > 1 ? dhcsrs.shift()! : dhcsrs[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('probe reports a halted core and only uses DAP_Connect + one DHCSR read', async () => {
  const adi = fakeAdi([S_HALT | 1]);
  assert.equal(await isTargetHeldHalted(adi), true);
  assert.deepEqual(adi.calls, ['connect', `read:${DHCSR.toString(16)}`]);
});

test('probe reports a running core as not held', async () => {
  assert.equal(await isTargetHeldHalted(fakeAdi([1])), false);
});

test('a failing probe falls back to "not held" so the old reinit path runs', async () => {
  assert.equal(await isTargetHeldHalted(fakeAdi([new Error('Transfer FAULT')])), false);
});

test('an adi without the probe surface is never treated as held', async () => {
  assert.equal(await isTargetHeldHalted({}), false);
});

test('wait resolves at once when the core runs', async () => {
  const adi = fakeAdi([0]);
  const t0 = Date.now();
  await waitForDaplinkSwdRelease(adi);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(adi.calls.filter((c) => c === 'connect').length, 1);
});

test('wait holds while the core stays halted, then resolves once it runs', async () => {
  const adi = fakeAdi([S_HALT, 0]);
  const t0 = Date.now();
  await waitForDaplinkSwdRelease(adi);
  const waited = Date.now() - t0;
  assert.ok(waited >= 900, `waited only ${waited} ms`);
  assert.equal(adi.calls.filter((c) => c === 'connect').length, 2);
});

test('concurrent waiters share one probe series', async () => {
  const adi = fakeAdi([S_HALT, 0]);
  await Promise.all([waitForDaplinkSwdRelease(adi), waitForDaplinkSwdRelease(adi)]);
  assert.equal(adi.calls.filter((c) => c === 'connect').length, 2);
});
