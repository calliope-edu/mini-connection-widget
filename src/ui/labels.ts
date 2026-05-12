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
  bleConnectedBlocksOnly: string;
  bleConnectedStaleBond: string;
  bleConnectedNeedsPairing: string;
  notSupportedUsb: string;
  notSupportedBle: string;
  unsupportedHint: string;

  // Actions
  connect: string;
  disconnect: string;
  forget: string;
  howToPair: string;
  pairingHint: string;
  staleBondHint: string;

  // Flash block
  flashVia: (transport: 'usb' | 'ble') => string;
  partialFlash: string;
  fullFlash: string;
  lastFlash: string;

  // Device card
  version: string;
  connectedSince: string;
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
  bleConnectedBlocksOnly: 'Nur Blocks (ohne Pairing)',
  bleConnectedStaleBond: 'Verbunden — OS-Pairing veraltet',
  bleConnectedNeedsPairing: 'Verbunden — OS-Pairing fehlt',
  notSupportedUsb: 'WebUSB nicht verfuegbar',
  notSupportedBle: 'Web Bluetooth nicht verfuegbar',
  unsupportedHint:
    'In diesem Browser ist weder WebUSB noch Web Bluetooth verfuegbar. ' +
    'Bitte Chrome, Edge oder Opera benutzen.',

  connect: 'Verbinden',
  disconnect: 'Trennen',
  forget: 'Trennen & vergessen',
  howToPair: 'Wie pairen?',
  pairingHint:
    'Calliope einmal in den OS-Bluetooth-Einstellungen koppeln.',
  staleBondHint:
    'Calliope in den OS-Bluetooth-Einstellungen entkoppeln und neu pairen ' +
    '(das Pairing wurde nach einem USB-Flash auf dem Calliope verworfen).',

  flashVia: (t) => `Flashen via ${t === 'ble' ? 'Bluetooth' : 'USB'}`,
  partialFlash: 'Schnelles Flashen',
  fullFlash: 'Vollstaendiges Flashen',
  lastFlash: 'Zuletzt geflasht',

  version: 'Version',
  connectedSince: 'Verbunden seit',
};

export function mergeLabels(overrides?: Partial<ConnectLabels>): ConnectLabels {
  if (!overrides) return DEFAULT_LABELS;
  return { ...DEFAULT_LABELS, ...overrides };
}
