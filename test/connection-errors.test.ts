import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceError } from '@microbit/microbit-connection';
import {
  classifyBleError,
  classifyUsbError,
  markExpectedReboot,
  isExpectedRebootWindow,
  clearExpectedReboot,
} from '../src/connection-errors.ts';

test('GATT disconnect with prior pairing → stale-bond', () => {
  const err = new Error('BLE: GATT Server is disconnected. Cannot retrieve services.');
  const c = classifyBleError(err, /*hadPaired*/ true);
  assert.equal(c.kind, 'stale-bond');
  assert.equal(c.staleBond, true);
  assert.equal(c.showPairingModal, true);
  assert.ok(c.userMessage.length > 0);
});

test('GATT disconnect with no prior pairing → pairing-missing', () => {
  const err = new Error('GATT Server is disconnected.');
  const c = classifyBleError(err, /*hadPaired*/ false);
  assert.equal(c.kind, 'pairing-missing');
  assert.equal(c.staleBond, false);
  assert.equal(c.showPairingModal, true);
});

test('"Connection attempt failed" with prior pairing → stale-bond', () => {
  const err = new Error('Connection attempt failed');
  const c = classifyBleError(err, /*hadPaired*/ true);
  assert.equal(c.kind, 'stale-bond');
  assert.equal(c.showPairingModal, true);
});

test('"Connection attempt failed" without prior pairing → pairing-missing', () => {
  const err = new Error('Connection attempt failed');
  const c = classifyBleError(err, /*hadPaired*/ false);
  assert.equal(c.kind, 'pairing-missing');
  assert.equal(c.showPairingModal, true);
});

test('DeviceError pairing-information-lost → stale-bond', () => {
  const err = new DeviceError({ code: 'pairing-information-lost', message: 'lost' });
  const c = classifyBleError(err, /*hadPaired*/ true);
  assert.equal(c.kind, 'stale-bond');
});

test('DeviceError permission-denied → pairing-missing', () => {
  const err = new DeviceError({ code: 'permission-denied', message: 'no' });
  const c = classifyBleError(err, /*hadPaired*/ false);
  assert.equal(c.kind, 'pairing-missing');
});

test('user-cancelled picker is not an error to surface', () => {
  const err = new DeviceError({ code: 'no-device-selected', message: 'cancelled' });
  const c = classifyBleError(err, false);
  assert.equal(c.kind, 'aborted');
  assert.equal(c.userMessage, '');
});

test('USB transferOut transient error is recognized', () => {
  const err = new Error("Failed to execute 'transferOut' on 'USBDevice': A transfer error has occurred.");
  const c = classifyUsbError(err);
  assert.equal(c.kind, 'transfer-transient');
});

test('"Must be connected" maps to not-connected-yet', () => {
  const err = new Error('Must be connected now');
  const c = classifyUsbError(err);
  assert.equal(c.kind, 'not-connected-yet');
});

test('expected-reboot window opens and closes on demand', () => {
  clearExpectedReboot();
  assert.equal(isExpectedRebootWindow(), false);
  markExpectedReboot(100);
  assert.equal(isExpectedRebootWindow(), true);
  clearExpectedReboot();
  assert.equal(isExpectedRebootWindow(), false);
});

// ---- authVerified gate (rc07 campus-open / MICROBIT_BLE_OPEN=1 firmware) ----

test('authVerified suppresses GATT-disconnect → pairing-modal', () => {
  const err = new Error('GATT Server is disconnected.');
  const c = classifyBleError(err, /*hadPaired*/ true, /*authVerified*/ true);
  assert.equal(c.kind, 'gatt-transient');
  assert.equal(c.showPairingModal, false);
  assert.equal(c.staleBond, false);
});

test('authVerified downgrades pairing-information-lost to transient', () => {
  const err = new DeviceError({ code: 'pairing-information-lost', message: 'lost' });
  const c = classifyBleError(err, /*hadPaired*/ true, /*authVerified*/ true);
  assert.equal(c.kind, 'gatt-transient');
  assert.equal(c.showPairingModal, false);
});

test('authVerified downgrades permission-denied to transient', () => {
  const err = new DeviceError({ code: 'permission-denied', message: 'no' });
  const c = classifyBleError(err, /*hadPaired*/ false, /*authVerified*/ true);
  assert.equal(c.kind, 'gatt-transient');
  assert.equal(c.showPairingModal, false);
});

test('authVerified downgrades "Connection attempt failed" to transient', () => {
  const err = new Error('Connection attempt failed');
  const c = classifyBleError(err, /*hadPaired*/ true, /*authVerified*/ true);
  assert.equal(c.kind, 'gatt-transient');
  assert.equal(c.showPairingModal, false);
});

test('authVerified does NOT mask aborted', () => {
  const err = new DeviceError({ code: 'aborted', message: 'cancel' });
  const c = classifyBleError(err, false, /*authVerified*/ true);
  assert.equal(c.kind, 'aborted');
});
