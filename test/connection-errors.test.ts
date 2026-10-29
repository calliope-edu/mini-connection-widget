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

test('user-cancelled picker → aborted with empty message', () => {
  const c = classifyBleError(new DeviceError({ code: 'no-device-selected', message: 'cancelled' }));
  assert.equal(c.kind, 'aborted');
  assert.equal(c.userMessage, '');
});

test('DeviceError aborted → aborted', () => {
  const c = classifyBleError(new DeviceError({ code: 'aborted', message: 'x' }));
  assert.equal(c.kind, 'aborted');
});

test('DeviceError unsupported → unsupported', () => {
  const c = classifyBleError(new DeviceError({ code: 'unsupported', message: 'x' }));
  assert.equal(c.kind, 'unsupported');
  assert.ok(c.userMessage.length > 0);
});

test('pairing-information-lost → transient (no bond to lose in open mode)', () => {
  const c = classifyBleError(new DeviceError({ code: 'pairing-information-lost', message: 'lost' }));
  assert.equal(c.kind, 'transient');
  assert.ok(c.userMessage.length > 0);
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
  assert.ok(c.userMessage.length > 0);
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

test('USB user-cancelled picker → no-device with empty message', () => {
  const c = classifyUsbError(new DeviceError({ code: 'no-device-selected', message: 'x' }));
  assert.equal(c.kind, 'no-device');
  assert.equal(c.userMessage, '');
});

test('unrecognised USB error → unknown carries the raw message', () => {
  const c = classifyUsbError(new Error('something weird'));
  assert.equal(c.kind, 'unknown');
  assert.equal(c.userMessage, 'something weird');
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
