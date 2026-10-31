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

// Open-mode firmware (MICROBIT_BLE_OPEN=1) removes the OS bond, so BLE errors
// collapse to: user-aborted, unsupported, or transient (the reconnect daemon
// retries). USB errors stay structured because they drive concrete recovery UI.

// ---- BLE -----------------------------------------------------------------

test('user-cancelled picker → aborted, nothing to show', () => {
  const c = classifyBleError(new DeviceError({ code: 'no-device-selected', message: 'cancelled' }));
  assert.equal(c.kind, 'aborted');
  assert.equal(c.error, undefined);
});

test('DeviceError aborted → aborted', () => {
  const c = classifyBleError(new DeviceError({ code: 'aborted', message: 'x' }));
  assert.equal(c.kind, 'aborted');
});

test('DeviceError unsupported → unsupported', () => {
  const c = classifyBleError(new DeviceError({ code: 'unsupported', message: 'x' }));
  assert.equal(c.kind, 'unsupported');
  assert.deepEqual(c.error, { code: 'ble-unsupported' });
});

test('pairing-information-lost → transient (no bond to lose in open mode)', () => {
  const c = classifyBleError(new DeviceError({ code: 'pairing-information-lost', message: 'lost' }));
  assert.equal(c.kind, 'transient');
  assert.deepEqual(c.error, { code: 'ble-failed' });
});

test('permission-denied → transient', () => {
  const c = classifyBleError(new DeviceError({ code: 'permission-denied', message: 'no' }));
  assert.equal(c.kind, 'transient');
});

test('GATT disconnect (plain Error) → transient', () => {
  const c = classifyBleError(new Error('BLE: GATT Server is disconnected. Cannot retrieve services.'));
  assert.equal(c.kind, 'transient');
});

test('"Connection attempt failed" → transient', () => {
  const c = classifyBleError(new Error('Connection attempt failed'));
  assert.equal(c.kind, 'transient');
});

// ---- USB -----------------------------------------------------------------

test('USB transferOut transient error → transfer-transient', () => {
  const err = new Error("Failed to execute 'transferOut' on 'USBDevice': A transfer error has occurred.");
  assert.equal(classifyUsbError(err).kind, 'transfer-transient');
});

test('"Must be connected" → not-connected-yet', () => {
  assert.equal(classifyUsbError(new Error('Must be connected now')).kind, 'not-connected-yet');
});

test('DeviceError device-in-use → device-in-use', () => {
  const c = classifyUsbError(new DeviceError({ code: 'device-in-use', message: 'busy' }));
  assert.equal(c.kind, 'device-in-use');
  assert.deepEqual(c.error, { code: 'usb-device-in-use' });
});

test('DeviceError device-disconnected → device-disconnected', () => {
  assert.equal(
    classifyUsbError(new DeviceError({ code: 'device-disconnected', message: 'gone' })).kind,
    'device-disconnected',
  );
});

test('"Unable to claim interface" → device-in-use', () => {
  assert.equal(classifyUsbError(new Error('Unable to claim interface.')).kind, 'device-in-use');
});

test('USB user-cancelled picker → no-device, nothing to show', () => {
  const c = classifyUsbError(new DeviceError({ code: 'no-device-selected', message: 'x' }));
  assert.equal(c.kind, 'no-device');
  assert.equal(c.error, undefined);
});

test('unrecognised USB error → unknown carries the raw message', () => {
  const c = classifyUsbError(new Error('something weird'));
  assert.equal(c.kind, 'unknown');
  assert.deepEqual(c.error, { code: 'usb-unknown', message: 'something weird' });
});

test('unrecognised USB error without a message → unknown, worded by the label', () => {
  assert.deepEqual(classifyUsbError(new Error('')).error, { code: 'usb-unknown' });
});

test('the two device-disconnected wordings stay apart', () => {
  assert.deepEqual(classifyUsbError(new Error('The device was disconnected.')).error, { code: 'usb-interrupted' });
  assert.deepEqual(
    classifyUsbError(new Error("Failed to execute 'requestDevice': Must be handling a user gesture")).error,
    { code: 'usb-session-lost' },
  );
});

// ---- expected-reboot window ----------------------------------------------

test('expected-reboot window opens and closes on demand', () => {
  clearExpectedReboot();
  assert.equal(isExpectedRebootWindow(), false);
  markExpectedReboot(100);
  assert.equal(isExpectedRebootWindow(), true);
  clearExpectedReboot();
  assert.equal(isExpectedRebootWindow(), false);
});
