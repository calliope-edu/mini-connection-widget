import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'svelte/server';

import {
  DEFAULT_LABELS,
  connectLabels,
  labelParts,
  mergeLabels,
  setConnectLabels,
  type ConnectLabels,
} from '../src/ui/labels.ts';
import { get } from '../src/store.ts';
import { updateState } from '../src/state.ts';
import { awaitConnectionChoice } from '../src/connection-choice.ts';
import { awaitUsbPlugConfirm } from '../src/usb-plug.ts';
import { awaitMini12VersionAnswer } from '../src/mini12-version-ask.ts';
import { awaitMini2FlashChoice } from '../src/mini2-flash-fallback.ts';
import { showBleOfflineInfo, dismissBleOfflineInfo } from '../src/ble-offline-info.ts';
import { armUsbRecovery, clearUsbRecovery } from '../src/usb-recovery.ts';
import { setConnectionUiActive } from '../src/connection-banner-extra.ts';
import ConnectionBanner from '../src/ui/ConnectionBanner.svelte';
import ConnectionChoiceModal from '../src/ui/ConnectionChoiceModal.svelte';
import UsbPlugRequestModal from '../src/ui/UsbPlugRequestModal.svelte';
import BleOfflineModal from '../src/ui/BleOfflineModal.svelte';
import Mini2FlashFallbackModal from '../src/ui/Mini2FlashFallbackModal.svelte';
import Mini12VersionModal from '../src/ui/Mini12VersionModal.svelte';
import ConnectionPanel from '../src/ui/ConnectionPanel.svelte';
import { EN_LABELS } from './labels-en.ts';

afterEach(() => setConnectLabels());

/** Server-rendered HTML with Svelte's hydration comments and tags removed. */
function text(component: Parameters<typeof render>[0], props: Record<string, unknown> = {}): string {
  const { body } = render(component, { props });
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function html(component: Parameters<typeof render>[0], props: Record<string, unknown> = {}): string {
  return render(component, { props }).body.replace(/<!--[\s\S]*?-->/g, '');
}

/** Assert every string in `english` shows and none of `german` does. */
function shows(out: string, english: string[], german: string[]): void {
  for (const s of english) assert.ok(out.includes(s), `expected "${s}" in:\n${out}`);
  for (const s of german) assert.ok(!out.includes(s), `German "${s}" still in:\n${out}`);
}

const ignore = () => {};

// ---- Registry ---------------------------------------------------------------

test('registry starts German and tells subscribers about every change', () => {
  assert.equal(get(connectLabels), DEFAULT_LABELS);
  const seen: string[] = [];
  const unsub = connectLabels.subscribe((l) => seen.push(l.cancel));
  setConnectLabels(EN_LABELS);
  setConnectLabels();
  unsub();
  assert.deepEqual(seen, ['Abbrechen', 'Cancel', 'Abbrechen']);
});

test('setConnectLabels replaces the previous set instead of merging into it', () => {
  setConnectLabels({ cancel: 'Cancel', close: 'Close' });
  setConnectLabels({ cancel: 'Annuler' });
  const l = get(connectLabels);
  assert.equal(l.cancel, 'Annuler');
  assert.equal(l.close, DEFAULT_LABELS.close, 'a key the new set leaves out falls back to German');
});

test('an undefined override (missing translation) keeps the default', () => {
  setConnectLabels({ cancel: undefined });
  assert.equal(get(connectLabels).cancel, 'Abbrechen');
});

test('mergeLabels: a labels prop wins over the registry', () => {
  setConnectLabels(EN_LABELS);
  const l = mergeLabels({ connect: 'Verknüpfen' }, get(connectLabels));
  assert.equal(l.connect, 'Verknüpfen');
  assert.equal(l.cancel, 'Cancel');
});

test('labelParts marks the placeholder and passes other params through untouched', () => {
  const seen: unknown[] = [];
  const label = (p: { fileName: string; attempts: number }) => {
    seen.push(p.attempts);
    return `${p.fileName} failed (${p.attempts} attempts).`;
  };
  assert.deepEqual(labelParts(label, { fileName: 'blink.hex', attempts: 3 }, ['fileName']), [
    { text: 'blink.hex', param: 'fileName' },
    { text: ' failed (3 attempts).' },
  ]);
  assert.deepEqual(seen, [3], 'a count reaches the label as a number, so it can pluralise');
});

// ---- Modals -----------------------------------------------------------------

test('ConnectionChoiceModal shows the English set, file name bold', () => {
  setConnectLabels(EN_LABELS);
  awaitConnectionChoice('blink.hex', true).catch(ignore);
  const out = text(ConnectionChoiceModal);
  shows(
    out,
    ['Transfer program', 'The Calliope is not connected right now', 'Via Bluetooth', 'Via USB cable', 'Download as a file', 'Cancel'],
    ['Programm übertragen', 'Per Bluetooth', 'Per USB-Kabel', 'Als Datei herunterladen', 'Abbrechen'],
  );
  assert.match(html(ConnectionChoiceModal), /<strong>blink\.hex<\/strong> gets onto the device/);
  assert.match(html(ConnectionChoiceModal), /aria-label="Close"/);
});

test('a file name renders as text, not markup', () => {
  awaitConnectionChoice('<img src=x onerror=alert(1)>.hex', true).catch(ignore);
  assert.ok(!html(ConnectionChoiceModal).includes('<img'));
});

test('UsbPlugRequestModal shows the English set', () => {
  setConnectLabels(EN_LABELS);
  awaitUsbPlugConfirm('blink.hex').catch(ignore);
  shows(
    text(UsbPlugRequestModal),
    ['Connect the Calliope by USB', 'Connect the USB cable to the Calliope.', 'Cancel', 'Transfer'],
    ['anschließen', 'Abbrechen', 'Übertragen'],
  );
});

test('BleOfflineModal shows the English set', () => {
  setConnectLabels(EN_LABELS);
  showBleOfflineInfo();
  try {
    shows(
      text(BleOfflineModal),
      ['Bluetooth is off on your Calliope right now', 'Two ways back:', 'Hold A + B and press Reset', 'Plug in the USB cable', 'Use USB', 'Reconnect', 'Cancel connection', 'Close'],
      ['Bluetooth ist auf deinem Calliope gerade aus', 'Zwei Wege zurück', 'USB nehmen', 'Erneut verbinden', 'Schließen'],
    );
  } finally {
    dismissBleOfflineInfo();
  }
});

test('Mini2FlashFallbackModal shows the English set with file name and attempts', () => {
  setConnectLabels(EN_LABELS);
  void awaitMini2FlashChoice('blink.hex', 2, 'MSD write timed out');
  shows(
    text(Mini2FlashFallbackModal),
    ['USB transfer failed', 'blink.hex could not be transferred to the Calliope mini 2 (2 attempts)', 'Try again', 'Download as a file', 'Details: MSD write timed out', 'Cancel'],
    ['fehlgeschlagen', 'Nochmal versuchen', 'Versuche', 'Abbrechen'],
  );
  assert.match(html(Mini2FlashFallbackModal), /onto the <strong>MINI<\/strong> drive/);
});

test('Mini12VersionModal shows the English set', () => {
  setConnectLabels(EN_LABELS);
  void awaitMini12VersionAnswer('big.hex');
  shows(
    text(Mini12VersionModal),
    ['Which Calliope mini is this?', 'needs 32 KB of RAM', '32 KB RAM — the transfer starts.', 'Cancel'],
    ['Welcher Calliope mini ist das?', 'braucht', 'Abbrechen'],
  );
});

// Mini2SerialOfferModal: see ui-labels-serial.test.ts (needs browser globals).

// ---- Banner -----------------------------------------------------------------

test('ConnectionBanner: unsupported browser, in English', () => {
  setConnectLabels(EN_LABELS);
  setConnectionUiActive(true);
  try {
    // Node has neither navigator.usb nor navigator.bluetooth.
    shows(
      text(ConnectionBanner),
      ['Cannot connect.', 'This browser has neither USB nor Bluetooth.'],
      ['Verbindung nicht möglich', 'In diesem Browser'],
    );
    assert.match(html(ConnectionBanner), /aria-label="Hide"/);
  } finally {
    setConnectionUiActive(false);
  }
});

test('ConnectionBanner: USB recovery, in English', () => {
  setConnectLabels(EN_LABELS);
  armUsbRecovery();
  try {
    shows(text(ConnectionBanner), ['Connecting to the Calliope mini…'], ['Verbinde mit dem Calliope mini']);
  } finally {
    clearUsbRecovery();
  }
});

test('ConnectionBanner: Bluetooth connect in flight, in English', () => {
  setConnectLabels(EN_LABELS);
  updateState((s) => ({ ...s, bleStatus: 'connecting', bleSupported: true }));
  try {
    shows(text(ConnectionBanner), ['Connecting via Bluetooth…', 'Cancel'], ['Verbinde per Bluetooth', 'Abbrechen']);
  } finally {
    updateState((s) => ({ ...s, bleStatus: 'unsupported', bleSupported: false }));
  }
});

test('ConnectionBanner: flashing, in English', () => {
  setConnectLabels(EN_LABELS);
  updateState((s) => ({ ...s, flashTransport: 'usb', flashPhase: 'prepare' }));
  try {
    shows(text(ConnectionBanner), ['Transferring program…', 'Preparing…'], ['Programm wird übertragen', 'Wird vorbereitet']);
  } finally {
    updateState((s) => ({ ...s, flashTransport: undefined, flashPhase: undefined }));
  }
});

test('switching the language re-renders with the new set', () => {
  awaitUsbPlugConfirm('blink.hex').catch(ignore);
  assert.ok(text(UsbPlugRequestModal).includes('Calliope per USB anschließen'));
  setConnectLabels(EN_LABELS);
  assert.ok(text(UsbPlugRequestModal).includes('Connect the Calliope by USB'));
  setConnectLabels({ usbPlugTitle: 'Connecter le Calliope en USB' });
  assert.ok(text(UsbPlugRequestModal).includes('Connecter le Calliope en USB'));
});

// ---- Panel ------------------------------------------------------------------

test('ConnectionPanel: the labels prop wins over the registry', () => {
  setConnectLabels(EN_LABELS);
  updateState((s) => ({ ...s, bleStatus: 'disconnected', bleSupported: true }));
  try {
    const props: { labels: Partial<ConnectLabels> } = { labels: { connect: 'Verknüpfen' } };
    shows(
      text(ConnectionPanel, props),
      ['Calliope mini connection', 'Verknüpfen', 'Draw the pattern your Calliope mini shows.'],
      ['Calliope mini Verbindung', 'Zeichne das Muster'],
    );
    assert.match(html(ConnectionPanel, props), /aria-label="Column 1, height 5"/);
  } finally {
    updateState((s) => ({ ...s, bleStatus: 'unsupported', bleSupported: false }));
  }
});
