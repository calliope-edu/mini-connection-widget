import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBleSession, boardVersionFromServices, SERVICE_UUIDS } from '../src/ble-state.ts';

// Open-mode firmware (MICROBIT_BLE_OPEN=1) has no SMP gate, so the classifier
// only distinguishes a running application from the Nordic DFU bootloader.
// Any device exposing services that isn't the bootloader is 'app-mode'.

test('full CODAL service set → app-mode', () => {
  const r = classifyBleSession({
    services: [
      SERVICE_UUIDS.deviceInfo,
      SERVICE_UUIDS.uart,
      SERVICE_UUIDS.partialFlash,
      SERVICE_UUIDS.nordicDfu,
      SERVICE_UUIDS.blocks,
    ],
    deviceName: 'Calliope mini [tipov]',
    connected: true,
  });
  assert.equal(r.kind, 'app-mode');
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

test('only DIS visible → app-mode (services enumerated)', () => {
  const r = classifyBleSession({
    services: [SERVICE_UUIDS.deviceInfo],
    deviceName: 'Calliope mini [tipov]',
    connected: true,
  });
  assert.equal(r.kind, 'app-mode');
});

test('partial-flash visible but UART missing → app-mode', () => {
  const r = classifyBleSession({
    services: [SERVICE_UUIDS.deviceInfo, SERVICE_UUIDS.partialFlash],
    deviceName: 'Calliope mini [tipov]',
    connected: true,
  });
  assert.equal(r.kind, 'app-mode');
});

test('partial-flash + DFU + UART (mini1/2 app advertising both) → app-mode', () => {
  // A V1-class app can expose the legacy DFU-control service alongside the
  // app services; presence of partial-flash/UART means it's an app, not a
  // bootloader.
  const r = classifyBleSession({
    services: [SERVICE_UUIDS.legacyDfuControl, SERVICE_UUIDS.partialFlash, SERVICE_UUIDS.uart],
    deviceName: 'Calliope mini [tipov]',
    connected: true,
  });
  assert.equal(r.kind, 'app-mode');
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
  assert.equal(r.kind, 'app-mode');
});

// ---- boardVersionFromServices (DFU service fingerprint) ------------------

test('legacy DFU-Control present → V1 (V1-class Mini 1/2), even with partial-flash', () => {
  assert.equal(
    boardVersionFromServices([SERVICE_UUIDS.legacyDfuControl, SERVICE_UUIDS.partialFlash, SERVICE_UUIDS.uart]),
    'V1',
  );
});

test('Nordic Secure DFU present (no legacy) → V2 (Mini 3)', () => {
  assert.equal(
    boardVersionFromServices([SERVICE_UUIDS.nordicDfu, SERVICE_UUIDS.partialFlash, SERVICE_UUIDS.uart]),
    'V2',
  );
});

test('partial-flash only, no DFU service → V2 (Mini 3 app mode)', () => {
  assert.equal(boardVersionFromServices([SERVICE_UUIDS.partialFlash, SERVICE_UUIDS.uart]), 'V2');
});

test('no fingerprint signal → undefined (UNIDENTIFIED, do not guess V2)', () => {
  assert.equal(boardVersionFromServices([SERVICE_UUIDS.deviceInfo]), undefined);
  assert.equal(boardVersionFromServices([]), undefined);
});

test('fingerprint is case-insensitive', () => {
  assert.equal(boardVersionFromServices([SERVICE_UUIDS.legacyDfuControl.toUpperCase()]), 'V1');
});

test('reason field is populated for every kind', () => {
  for (const services of [
    [SERVICE_UUIDS.partialFlash, SERVICE_UUIDS.uart], // app-mode
    [SERVICE_UUIDS.nordicDfu], // dfu-bootloader
    [SERVICE_UUIDS.deviceInfo], // app-mode
    [], // unknown
  ]) {
    const r = classifyBleSession({ services, connected: true });
    assert.ok(r.reason.length > 0, `reason missing for ${r.kind}`);
  }
});
