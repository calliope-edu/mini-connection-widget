// The serial offer is raised by a `calliopeState` subscription that mini2-serial
// only installs in a browser, so this test runs in its own file with
// browser globals set up first.
import './browser-globals.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'svelte/server';

import { setConnectLabels } from '../src/ui/labels.ts';
import { updateState } from '../src/state.ts';
import { setSerialConsumer } from '../src/mini2-serial.ts';
import Mini2SerialOfferModal from '../src/ui/Mini2SerialOfferModal.svelte';
import { EN_LABELS } from './labels-en.ts';

test('Mini2SerialOfferModal shows the English set', () => {
  setConnectLabels(EN_LABELS);
  // A serial-consuming editor is active and a mini 2 is linked flash-only.
  setSerialConsumer('test-editor', true);
  updateState((s) => ({ ...s, jlinkUsbStatus: 'connected' }));
  const out = render(Mini2SerialOfferModal, { props: {} }).body;
  for (const s of ['Connect serial?', 'This editor can talk to the Calliope mini', 'Later', 'Connect serial']) {
    assert.ok(out.includes(s), `expected "${s}" in:\n${out}`);
  }
  for (const s of ['Serial verbinden', 'Später']) assert.ok(!out.includes(s), `German "${s}" still in:\n${out}`);
});
