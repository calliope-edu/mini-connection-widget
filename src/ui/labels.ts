/**
 * Default UI labels (German). Apps can override any subset via the
 * `labels` prop on `<ConnectButton>` to plug in their own i18n system.
 *
 * Keys are flat and short on purpose — easier to override than nested
 * objects, and the surface area is small.
 */
export interface ConnectLabels {
  // Trigger pill
  triggerTitle: string;
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

  // Panel header
  panelTitle: string;

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
}

export const DEFAULT_LABELS: ConnectLabels = {
  triggerTitle: 'Calliope mini Verbindung',
  notConnected: 'Nicht verbunden',
  connecting: 'Verbinde…',
  connected: 'Verbunden',
  flashing: 'Flashen',
  error: 'Fehler',
  unsupported: 'Nicht unterstuetzt',
  phaseCheck: 'Pruefen…',
  phaseReboot: 'Neustart…',
  phasePrepare: 'Vorbereiten…',
  phaseFinalising: 'Abschluss…',

  panelTitle: 'Calliope mini Verbindung',

  usb: 'USB',
  ble: 'Bluetooth',
  usbConnected: 'Flashen & Kommunikation',
  bleConnectedFull: 'Flashen & Kommunikation',
  bleConnectedCommOnly: 'Nur Kommunikation',
  notSupportedUsb: 'WebUSB nicht verfuegbar',
  notSupportedBle: 'Web Bluetooth nicht verfuegbar',
  unsupportedHint:
    'In diesem Browser ist weder WebUSB noch Web Bluetooth verfuegbar. ' +
    'Bitte Chrome, Edge oder Opera benutzen.',

  connect: 'Verbinden',
  disconnect: 'Trennen',
  forget: 'Trennen & vergessen',
  cancel: 'Abbrechen',

  flashVia: (t) => `Flashen via ${t === 'ble' ? 'Bluetooth' : 'USB'}`,
  partialFlash: 'Schnelles Flashen',
  fullFlash: 'Vollstaendiges Flashen',
  lastFlash: 'Zuletzt geflasht',

  version: 'Version',
  connectedSince: 'Verbunden seit',
  program: 'Programm',
  programBlocks: 'Blocks-Runtime',

  appModeChip: 'über App',
  appModeWaiting: 'über App – warte auf Calliope',
  appModeConnecting: 'über App – verbinde…',
  appModeConnected: 'über App – verbunden',
};

export function mergeLabels(overrides?: Partial<ConnectLabels>): ConnectLabels {
  if (!overrides) return DEFAULT_LABELS;
  return { ...DEFAULT_LABELS, ...overrides };
}
