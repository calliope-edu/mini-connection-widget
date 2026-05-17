import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBleSession, SERVICE_UUIDS } from '../src/ble-state.ts';

test('full CODAL service set → bond-ok', () => {
  const r = classifyBleSession({
    services: [
      SERVICE_UUIDS.deviceInfo,
      SERVICE_UUIDS.uart,
      SERVICE_UUIDS.partialFlash,
      SERVICE_UUIDS.nordicDfu,
      SERVICE_UUIDS.mbitMore,
    ],
    deviceName: 'Calliope mini [tipov]',
    connected: true,
  });
  assert.equal(r.kind, 'bond-ok');
});

test('Nordic DFU bootloader (name=DfuTarg, only DFU service) → dfu-bootloader', () => {
  const r = classifyBleSession({
    services: [SERVICE_UUIDS.nordicDfu],
    deviceName: 'DfuTarg',
    connected: true,
  });
  assert.equal(r.kind, 'dfu-bootloader');
});

test('Nordic DFU + DIS but no app services → dfu-bootloader (name-blind path)', () => {
  const r = classifyBleSession({
    services: [SERVICE_UUIDS.nordicDfu, SERVICE_UUIDS.deviceInfo],
    deviceName: undefined,
    connected: true,
  });
  assert.equal(r.kind, 'dfu-bootloader');
});

test('only DIS visible → partial (encrypted-services hidden)', () => {
  const r = classifyBleSession({
    services: [SERVICE_UUIDS.deviceInfo],
    deviceName: 'Calliope mini [tipov]',
    connected: true,
  });
  assert.equal(r.kind, 'partial');
});

test('partial-flash visible but UART missing → partial (encryption not yet up)', () => {
  const r = classifyBleSession({
    services: [SERVICE_UUIDS.deviceInfo, SERVICE_UUIDS.partialFlash],
    deviceName: 'Calliope mini [tipov]',
    connected: true,
  });
  assert.equal(r.kind, 'partial');
});

test('empty service list → unknown', () => {
  const r = classifyBleSession({ services: [], connected: true });
  assert.equal(r.kind, 'unknown');
});

test('not connected → unknown regardless of services', () => {
  const r = classifyBleSession({
    services: [SERVICE_UUIDS.partialFlash, SERVICE_UUIDS.uart],
    connected: false,
  });
  assert.equal(r.kind, 'unknown');
});

test('UUIDs are case-insensitive', () => {
  const r = classifyBleSession({
    services: [
      SERVICE_UUIDS.partialFlash.toUpperCase(),
      SERVICE_UUIDS.uart.toUpperCase(),
    ],
    connected: true,
  });
  assert.equal(r.kind, 'bond-ok');
});

test('reason field is populated for every kind', () => {
  for (const services of [
    [SERVICE_UUIDS.partialFlash, SERVICE_UUIDS.uart], // bond-ok
    [SERVICE_UUIDS.nordicDfu], // dfu-bootloader
    [SERVICE_UUIDS.deviceInfo], // partial
    [], // unknown
  ]) {
    const r = classifyBleSession({ services, connected: true });
    assert.ok(r.reason.length > 0, `reason missing for ${r.kind}`);
  }
});
