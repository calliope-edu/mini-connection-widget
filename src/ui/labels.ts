/**
 * UI labels for every component in `src/ui` — German by default.
 *
 * Two ways for an app to plug in its own i18n system:
 *
 *  - `setConnectLabels(partial)` — the module-wide registry. Reaches every
 *    component, including the singletons the host mounts once (the banner and
 *    the modals). Reactive: call it again after a locale switch and every
 *    mounted component re-renders with the new strings.
 *  - the `labels` prop on `<ConnectButton>` / `<ConnectionPanel>` — a per-
 *    instance override that wins over the registry.
 *
 * Keys are flat and short on purpose — easier to override than nested
 * objects. Keys that carry a placeholder (a file name, a count) are functions
 * taking one params object, the shape Paraglide messages have, so a host can
 * pass `m.some_message` straight through.
 */

import { writable, type Readable } from '../store';

export interface ConnectLabels {
  // ---- Shared ------------------------------------------------------------
  /** Close a dialog (✕ button, scrim). */
  close: string;
  /** Hide the banner (✕ button). */
  dismiss: string;
  /** Re-run a failed connect (banner replug rung, BLE-offline modal). */
  reconnect: string;
  /** Mini 2: open the Web Serial picker for the CDC port. */
  serialConnect: string;
  /** Default busy label for host-fed banner actions. */
  pleaseWait: string;
  /** Choice tile: save the .hex instead of transferring it. */
  downloadFile: string;

  // ---- Trigger pill (ConnectButton) --------------------------------------
  triggerTitle: string;
  /** Appended in brackets to `triggerTitle` while the panel floats. */
  triggerPinned: string;
  /** Resize handle of the floating window. */
  resize: string;
  notConnected: string;
  connecting: string;
  connected: string;
  flashing: string;
  error: string;
  unsupported: string;
  phaseCheck: string;
  phaseReboot: string;
  phasePrepare: string;
  phaseFinalising: string;

  // ---- Panel (ConnectionPanel) --------------------------------------------
  panelTitle: string;
  pin: string;
  unpin: string;

  // Transports
  usb: string;
  ble: string;
  usbConnected: string;
  bleConnectedFull: string;
  bleConnectedCommOnly: string;
  notSupportedUsb: string;
  notSupportedBle: string;
  unsupportedHint: string;

  // Actions
  connect: string;
  disconnect: string;
  forget: string;
  /** Stop an in-flight / retrying connection attempt and free the picker. */
  cancel: string;

  // Mini 2 serial (CDC) link
  /** While the Web Serial picker for the CDC port is open. */
  serialPickHint: string;
  /** Linked flash-only; the serial link is still missing. */
  serialMissing: string;

  // BLE
  bootloader: string;
  bootloaderTitle: string;
  /** Under the name-pattern pad. */
  patternHint: string;

  // Editor-fed actions (labels the host doesn't set itself)
  transferProgram: string;
  transferring: string;
  rearmInputs: string;
  rearmingInputs: string;

  // Flash block
  flashVia: (transport: 'usb' | 'ble') => string;
  partialFlash: string;
  fullFlash: string;
  lastFlash: string;

  // Device card
  version: string;
  connectedSince: string;
  program: string;
  programBlocks: string;
  runtimeVersion: string;
  outdated: string;

  // Native-proxy mode (iOS/Android app hosting the campus). Empty/undefined
  // overrides leave the chip out entirely.
  appModeChip: string;
  /** Status string while waiting for the native host to connect a device.
   *  Replaces the standard "Nicht verbunden" so the user knows the radio
   *  is being driven through the app rather than the browser. */
  appModeWaiting: string;
  /** Status string while the native host's BLE connect is in flight. */
  appModeConnecting: string;
  /** Status string when the native host's BLE session is connected. */
  appModeConnected: string;

  // ---- Name pattern (MiniNamePattern, PatternPad) -------------------------
  namePattern: (p: { name: string }) => string;
  patternCell: (p: { column: number; height: number }) => string;

  // ---- Banner (ConnectionBanner) ------------------------------------------
  bannerConnectingBle: string;
  bannerConnectingApp: string;
  bannerConnectedBoth: string;
  bannerConnectedUsb: string;
  bannerConnectedBle: string;
  bannerConnectedAny: string;
  bannerFlashing: string;
  bannerPhaseCheck: string;
  bannerPhaseReboot: string;
  bannerPhasePrepare: string;
  bannerPhaseFinalising: string;
  bannerReconnecting: string;
  bannerReplugTitle: string;
  bannerReplugText: string;
  bannerReloadTitle: string;
  bannerReloadText: string;
  bannerReloadButton: string;
  bannerSerialPickTitle: string;
  bannerSerialPickText: string;
  bannerNoConnectionTitle: string;
  bannerNoConnectionText: string;
  bannerUnsupportedTitle: string;
  bannerConnectUsb: string;
  bannerConnectBle: string;

  // ---- "Programm übertragen" choice (ConnectionChoiceModal) ---------------
  choiceTitle: string;
  /** `fileName` renders bold. */
  choiceText: (p: { fileName: string }) => string;
  choiceBle: string;
  choiceBleDetail: string;
  choiceUsb: string;
  choiceUsbDetail: string;
  choiceDownloadDetail: string;

  // ---- Plug in the cable (UsbPlugRequestModal) ----------------------------
  usbPlugTitle: string;
  usbPlugStep1: string;
  usbPlugStep2: string;
  usbPlugConfirm: string;

  // ---- Bluetooth is off (BleOfflineModal) ---------------------------------
  bleOfflineTitle: string;
  bleOfflineLead: string;
  /** Lead-in to the ways back: native app (one way) / browser (two). */
  bleOfflineStepsNative: string;
  bleOfflineStepsWeb: string;
  bleOfflineResetTitle: string;
  bleOfflineResetHint: string;
  bleOfflineResetHintNative: string;
  /** Divider between the two ways back. */
  bleOfflineOr: string;
  bleOfflineUsbTitle: string;
  bleOfflineUsbHint: string;
  /** macOS stale-bond tip under the Bluetooth way; the title renders bold. */
  bleOfflineMacTitle: string;
  bleOfflineMacHint: string;
  bleOfflineUseUsb: string;
  bleOfflineAbort: string;

  // ---- Mini 2 USB transfer failed (Mini2FlashFallbackModal) ---------------
  mini2FallbackTitle: string;
  /** `fileName` and `drive` (the "MINI" drive) render bold. */
  mini2FallbackText: (p: { fileName: string; attempts: number; drive: string }) => string;
  mini2FallbackRetry: string;
  mini2FallbackRetryDetail: string;
  mini2FallbackDownloadDetail: string;
  /** Prefix of the technical error line. */
  details: string;

  // ---- Mini 2 serial offer (Mini2SerialOfferModal) ------------------------
  mini2SerialTitle: string;
  mini2SerialText: string;
  later: string;

  // ---- Mini 1 or 2? (Mini12VersionModal) ----------------------------------
  mini12Title: string;
  /** `fileName` renders bold. */
  mini12Text: (p: { fileName: string }) => string;
  mini12Mini2Detail: string;
  mini12Mini1Detail: string;

  // ---- Comms log (CommsPanel, advanced mode) ------------------------------
  commsStream: string;
  commsRows: string;
  commsGraph: string;
  commsLive: string;
  commsLiveTitle: string;
  commsPause: string;
  commsResume: string;
  commsClear: string;
  commsStreamLiveOnly: string;
  commsStreamEmpty: string;
  commsLiveEmpty: string;
  /** `writeValue`, `print` and `mirror` are code examples (render as code). */
  commsRowsEmpty: (p: { writeValue: string; print: string; mirror: string }) => string;
  commsTable: (p: { index: number }) => string;
  commsTableSize: (p: { rows: number; columns: number }) => string;
  commsCsv: string;
  commsTime: string;
  commsNoValue: string;
  commsTruncated: (p: { shown: number; total: number }) => string;
  /** Code examples as in `commsRowsEmpty`. */
  commsGraphEmpty: (p: { writeValue: string; print: string; mirror: string }) => string;
  commsGraphWaiting: string;
  commsGraphNow: string;
}

export const DEFAULT_LABELS: ConnectLabels = {
  close: 'Schließen',
  dismiss: 'Ausblenden',
  reconnect: 'Erneut verbinden',
  serialConnect: 'Serial verbinden',
  pleaseWait: 'Bitte warten…',
  downloadFile: 'Als Datei herunterladen',

  triggerTitle: 'Calliope mini Verbindung',
  triggerPinned: 'Fenster offen',
  resize: 'Größe ändern',
  notConnected: 'Nicht verbunden',
  connecting: 'Verbinde…',
  connected: 'Verbunden',
  flashing: 'Übertrage',
  error: 'Fehler',
  unsupported: 'Nicht unterstuetzt',
  phaseCheck: 'Pruefen…',
  phaseReboot: 'Neustart…',
  phasePrepare: 'Vorbereiten…',
  phaseFinalising: 'Abschluss…',

  panelTitle: 'Calliope mini Verbindung',
  pin: 'Als Fenster anheften',
  unpin: 'Wieder anhängen',

  usb: 'USB',
  ble: 'Bluetooth',
  usbConnected: 'Übertragen & Kommunikation',
  bleConnectedFull: 'Übertragen & Kommunikation',
  bleConnectedCommOnly: 'Nur Kommunikation',
  notSupportedUsb: 'USB nicht verfügbar',
  notSupportedBle: 'Bluetooth nicht verfügbar',
  unsupportedHint:
    'In diesem Browser ist weder USB noch Bluetooth verfügbar. ' +
    'Bitte einen Chromium-Browser (Chrome, Edge, Opera, Brave) verwenden.',

  connect: 'Verbinden',
  disconnect: 'Trennen',
  forget: 'Trennen & vergessen',
  cancel: 'Abbrechen',

  serialPickHint:
    'USB 1/2 verbunden — wähle jetzt noch „CDC – COM x“, um die ' +
    'Datenverbindung (Serial) herzustellen. Abbrechen ist okay: ' +
    'Programme übertragen geht auch ohne.',
  serialMissing: 'Übertragen bereit — Serial (Datenverbindung) fehlt noch.',

  bootloader: 'Bootloader',
  bootloaderTitle: 'Nordic DFU bootloader erkannt',
  patternHint: 'Zeichne das Muster, das dein Calliope mini anzeigt.',

  transferProgram: 'Programm übertragen',
  transferring: 'Übertrage…',
  rearmInputs: 'Eingänge neu verbinden',
  rearmingInputs: 'Verbinde Eingänge neu…',

  flashVia: (t) => `Übertragung via ${t === 'ble' ? 'Bluetooth' : 'USB'}`,
  partialFlash: 'Schnelle Übertragung',
  fullFlash: 'Vollständige Übertragung',
  lastFlash: 'Zuletzt übertragen',

  version: 'Version',
  connectedSince: 'Verbunden seit',
  program: 'Programm',
  programBlocks: 'Blocks-Runtime',
  runtimeVersion: 'Blocks-Version',
  outdated: 'veraltet',

  appModeChip: 'über App',
  appModeWaiting: 'über App – warte auf Calliope',
  appModeConnecting: 'über App – verbinde…',
  appModeConnected: 'über App – verbunden',

  namePattern: ({ name }) => `Calliope-Muster ${name}`,
  patternCell: ({ column, height }) => `Spalte ${column}, Höhe ${height}`,

  bannerConnectingBle: 'Verbinde per Bluetooth…',
  bannerConnectingApp: 'Verbinde über App…',
  bannerConnectedBoth: 'USB + Bluetooth verbunden',
  bannerConnectedUsb: 'USB verbunden',
  bannerConnectedBle: 'Bluetooth verbunden',
  bannerConnectedAny: 'Calliope mini verbunden',
  bannerFlashing: 'Programm wird übertragen…',
  bannerPhaseCheck: 'Wird geprüft…',
  bannerPhaseReboot: 'Neustart…',
  bannerPhasePrepare: 'Wird vorbereitet…',
  bannerPhaseFinalising: 'Wird abgeschlossen…',
  bannerReconnecting: 'Verbinde mit dem Calliope mini…',
  bannerReplugTitle: 'Calliope mini neu verbinden.',
  bannerReplugText:
    'Zieh den Calliope mini einmal vom USB-Kabel ab und steck ihn wieder ein — ' +
    'schließe ggf. andere Tabs, die ihn nutzen. Klicke dann auf „Erneut verbinden“.',
  bannerReloadTitle: 'Das hat nicht geholfen.',
  bannerReloadText:
    'Lade die Seite neu, um die USB-Verbindung zurückzusetzen. Dein Calliope mini bleibt verbunden.',
  bannerReloadButton: 'Seite neu laden',
  bannerSerialPickTitle: 'USB verbunden (1/2)',
  bannerSerialPickText:
    'Wähle jetzt noch „CDC – COM x“, um die Datenverbindung (Serial) herzustellen. ' +
    'Abbrechen ist okay: Programme übertragen geht auch ohne.',
  bannerNoConnectionTitle: 'Kein Calliope mini verbunden.',
  bannerNoConnectionText: 'Verbinde deinen Calliope mini per USB-Kabel oder Bluetooth, um zu starten.',
  bannerUnsupportedTitle: 'Verbindung nicht möglich.',
  bannerConnectUsb: 'USB verbinden',
  bannerConnectBle: 'Bluetooth verbinden',

  choiceTitle: 'Programm übertragen',
  choiceText: ({ fileName }) =>
    `Der Calliope ist gerade nicht verbunden. Wähle, wie ${fileName} aufs Gerät kommen soll.`,
  choiceBle: 'Per Bluetooth',
  choiceBleDetail: 'Drahtlos — Calliope muss eingeschaltet und in Reichweite sein.',
  choiceUsb: 'Per USB-Kabel',
  choiceUsbDetail: 'Zuverlässig, funktioniert immer. Kabel an Calliope und Rechner anschließen.',
  choiceDownloadDetail: '.hex-Datei speichern und manuell auf den Calliope kopieren.',

  usbPlugTitle: 'Calliope per USB anschließen',
  usbPlugStep1: 'USB-Kabel mit dem Calliope verbinden.',
  usbPlugStep2: 'Auf „Übertragen“ klicken — beim allerersten Mal Browser-Dialog mit dem Calliope auswählen.',
  usbPlugConfirm: 'Übertragen',

  bleOfflineTitle: 'Bluetooth ist auf deinem Calliope gerade aus',
  bleOfflineLead: 'Wahrscheinlich läuft ein Programm ohne Bluetooth.',
  bleOfflineStepsNative: 'So geht es weiter:',
  bleOfflineStepsWeb: 'Zwei Wege zurück:',
  bleOfflineResetTitle: 'A + B halten und Reset drücken',
  bleOfflineResetHint:
    'Der Calliope startet in den DFU-Modus (Display zeigt z. B. ein Plus „+“). ' +
    'Dann unten auf „Erneut verbinden“ klicken — wir übertragen ein BLE-fähiges Programm.',
  bleOfflineResetHintNative:
    'Der Calliope startet in den Bluetooth-Modus. Wir verbinden uns dann automatisch neu ' +
    'und übertragen dein Programm.',
  bleOfflineOr: 'oder',
  bleOfflineUsbTitle: 'USB-Kabel anschließen',
  bleOfflineUsbHint:
    'Funktioniert immer, auch ohne Bluetooth auf dem Calliope — und ist deutlich schneller als BLE.',
  bleOfflineMacTitle: 'Klappt es auf dem Mac trotzdem nicht?',
  bleOfflineMacHint:
    'macOS speichert manchmal eine veraltete Bluetooth-Verbindung. Öffne Systemeinstellungen → ' +
    'Bluetooth, klicke bei „Calliope mini“ auf das „×“ und verbinde dann erneut.',
  bleOfflineUseUsb: 'USB nehmen',
  bleOfflineAbort: 'Verbindung abbrechen',

  mini2FallbackTitle: 'USB-Übertragung fehlgeschlagen',
  mini2FallbackText: ({ fileName, attempts, drive }) =>
    `${fileName} konnte nicht auf den Calliope mini 2 übertragen werden (${attempts} Versuche). ` +
    `Du kannst es erneut versuchen — oder die .hex-Datei herunterladen und selbst auf das ` +
    `Laufwerk ${drive} ziehen, das klappt immer.`,
  mini2FallbackRetry: 'Nochmal versuchen',
  mini2FallbackRetryDetail: 'Übertragung über USB erneut starten.',
  mini2FallbackDownloadDetail: '.hex-Datei speichern und im Datei-Explorer auf das Laufwerk „MINI“ ziehen.',
  details: 'Details',

  mini2SerialTitle: 'Serial verbinden?',
  mini2SerialText:
    'Dieser Editor kann mit dem Calliope mini kommunizieren (Serial). Dein Calliope mini 2 ' +
    'ist bisher nur zum Übertragen verbunden — wähle im nächsten Dialog „CDC – COM x“, ' +
    'um die Datenverbindung herzustellen.',
  later: 'Später',

  mini12Title: 'Welcher Calliope mini ist das?',
  mini12Text: ({ fileName }) =>
    `${fileName} braucht 32 KB RAM und läuft nur auf dem Calliope mini 2. ` +
    `Über Bluetooth können wir mini 1 und mini 2 nicht unterscheiden — ` +
    `die Version steht auf der Rückseite des Boards.`,
  mini12Mini2Detail: '32 KB RAM — Übertragung startet.',
  mini12Mini1Detail: '16 KB RAM — dieses Programm kann darauf nicht laufen.',

  commsStream: 'Stream',
  commsRows: 'Zeilen',
  commsGraph: 'Graph',
  commsLive: 'Live',
  commsLiveTitle: 'Live-Sensordaten (COMMAND/STATE/MOTION/ANALOG) — je Typ der neueste Wert',
  commsPause: 'Pausieren',
  commsResume: 'Fortsetzen',
  commsClear: 'Leeren',
  commsStreamLiveOnly: 'Nur Live-Polling aktiv — relevante Ereignisse (Befehle, Tastendrücke) erscheinen hier.',
  commsStreamEmpty: 'Noch keine Daten gesendet oder empfangen.',
  commsLiveEmpty:
    'Noch keine Live-Daten. Sensor-Polling (STATE/MOTION/ANALOG) und der Handshake (COMMAND) ' +
    'erscheinen hier — je Typ nur der neueste Wert.',
  commsRowsEmpty: ({ writeValue, print, mirror }) =>
    `Noch keine Logzeilen erkannt. Sende z. B. ${writeValue}, ${print} oder nutze ${mirror}.`,
  commsTable: ({ index }) => `Tabelle ${index}`,
  commsTableSize: ({ rows, columns }) => `${rows} Zeilen, ${columns} Spalten`,
  commsCsv: 'CSV laden',
  commsTime: 'Zeit',
  commsNoValue: 'kein Wert',
  commsTruncated: ({ shown, total }) => `Zeige die letzten ${shown} von ${total} Zeilen.`,
  commsGraphEmpty: ({ writeValue, print, mirror }) =>
    `Noch keine Daten zum Plotten. Logge Zahlen mit ${writeValue}, ${print} oder ${mirror}.`,
  commsGraphWaiting: 'Warte auf Datenpunkte …',
  commsGraphNow: 'jetzt',
};

const _registry = writable<ConnectLabels>(DEFAULT_LABELS);

/**
 * The labels every component renders with: `DEFAULT_LABELS` plus whatever the
 * host last passed to `setConnectLabels`. Svelte components read it as
 * `$connectLabels`; other frameworks subscribe.
 */
export const connectLabels: Readable<ConnectLabels> = { subscribe: _registry.subscribe };

/**
 * Set the module-wide labels. `overrides` REPLACES the previous call's — it is
 * not merged into it — so switching language is one call with the new set,
 * and a key the new set leaves out falls back to German rather than keeping
 * the previous language. Pass nothing to go back to the defaults.
 *
 * Mounted components update at once. Keys that take parameters are called at
 * render time; when they read the current locale themselves (Paraglide), call
 * `setConnectLabels` again after switching it so the components re-render.
 */
export function setConnectLabels(overrides?: Partial<ConnectLabels>): void {
  _registry.set(mergeLabels(overrides));
}

/**
 * `base` (the German defaults unless given) with `overrides` on top. The
 * components pass the registry as `base`, so a `labels` prop wins over it.
 */
export function mergeLabels(
  overrides?: Partial<ConnectLabels>,
  base: ConnectLabels = DEFAULT_LABELS,
): ConnectLabels {
  if (!overrides) return base;
  return { ...base, ...withoutUndefined(overrides) };
}

// A `{ key: undefined }` override (e.g. a missing translation) must not blank
// the label out.
function withoutUndefined(o: Partial<ConnectLabels>): Partial<ConnectLabels> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<ConnectLabels>;
}

/** A run of a label's text; `param` names the placeholder it was filled from. */
export interface LabelPart {
  text: string;
  param?: string;
}

/**
 * Split a parameterised label at the placeholders in `marked`, so the template
 * can wrap their values (bold file name, code examples) without `{@html}`.
 *
 * The marked params are passed to `label` as sentinel strings and swapped back
 * afterwards; the others are passed as-is, so a translation that formats or
 * pluralises a count still sees the number.
 */
export function labelParts<P extends object>(
  label: (params: P) => string,
  params: P,
  marked: readonly (keyof P & string)[],
): LabelPart[] {
  const values = params as Record<string, unknown>;
  const withSentinels: Record<string, unknown> = { ...values };
  for (const key of marked) withSentinels[key] = `\u0000${key}\u0000`;
  const pieces = label(withSentinels as P).split('\u0000');
  const parts: LabelPart[] = [];
  pieces.forEach((piece, i) => {
    // Odd pieces sit between two sentinels: a placeholder's name.
    if (i % 2 === 1 && (marked as readonly string[]).includes(piece)) {
      parts.push({ text: String(values[piece]), param: piece });
    } else if (piece) {
      parts.push({ text: piece });
    }
  });
  return parts;
}
