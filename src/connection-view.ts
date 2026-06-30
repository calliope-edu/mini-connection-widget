/**
 * Single source of truth for "what is the connection doing right now?",
 * shared by the badge (`ConnectButton`), the panel (`ConnectionPanel`) and the
 * global `ConnectionBanner` so all three never disagree.
 *
 * Before this module the badge projected the roll-up `state.status` while the
 * panel projected per-transport `usbStatus`/`bleStatus`, and each re-derived
 * its own labels — so the pill could read "USB" while the panel still showed a
 * "Verbinden" button on a transport that was mid-connect. Everything that maps
 * `CalliopeState` (+ the USB recovery rung) into UI now goes through here.
 *
 * Pure functions only (no stores) — Svelte components call `deriveConnectionView`
 * inside a `$derived` over `$calliopeState` + `$calliopeUsbRecovery`, so the
 * view stays reactive without needing a `derived` store primitive.
 */

import type { CalliopeState, CalliopeStatus, CalliopeTransport } from './state';
import type { UsbRecoveryRung } from './usb-recovery';
import type { ConnectLabels } from './ui/labels';

/** Per-transport projection — what a transport card / choice button needs. */
export interface TransportView {
  supported: boolean;
  status: CalliopeStatus;
  connected: boolean;
  connecting: boolean;
  /** A flash is currently transferring over THIS transport. */
  flashingThis: boolean;
  /** Connecting or flashing on this transport — disable connect/forget. */
  busy: boolean;
  error: boolean;
  errorMessage?: string;
  deviceName?: string;
}

export interface ConnectionView {
  /** Roll-up status (same value as `state.status`). */
  overall: CalliopeStatus;
  usb: TransportView;
  ble: TransportView;
  anyConnected: boolean;
  bothConnected: boolean;
  /**
   * The transport to treat as "the connection" when exactly one is up — drives
   * "once connected on one, don't ask for the other". `undefined` when neither
   * (or, harmlessly, when both) are connected.
   */
  connectedTransport?: CalliopeTransport;
  flashing: boolean;
  /** Current USB recovery rung; `recovering` is the convenience boolean. */
  recovery: UsbRecoveryRung;
  recovering: boolean;
  nativeMode: boolean;
}

function transportView(
  supported: boolean,
  status: CalliopeStatus,
  flashTransport: CalliopeTransport | undefined,
  mine: CalliopeTransport,
  errorMessage: string | undefined,
  deviceName: string | undefined,
): TransportView {
  const connected = status === 'connected';
  const connecting = status === 'connecting';
  const flashingThis = flashTransport === mine;
  return {
    supported,
    status,
    connected,
    connecting,
    flashingThis,
    busy: connecting || flashingThis,
    error: status === 'error',
    errorMessage,
    deviceName,
  };
}

/** Map the raw state (+ recovery rung) into the shared UI view-model. */
export function deriveConnectionView(s: CalliopeState, recovery: UsbRecoveryRung): ConnectionView {
  const usb = transportView(s.usbSupported, s.usbStatus, s.flashTransport, 'usb', s.usbErrorMessage, s.usbDeviceName);
  const ble = transportView(s.bleSupported, s.bleStatus, s.flashTransport, 'ble', s.bleErrorMessage, s.bleDeviceName);
  const anyConnected = usb.connected || ble.connected;
  const bothConnected = usb.connected && ble.connected;
  // Prefer USB as the "primary" when exactly one is connected; undefined when
  // both or neither, so callers don't suppress one arbitrarily.
  let connectedTransport: CalliopeTransport | undefined;
  if (usb.connected && !ble.connected) connectedTransport = 'usb';
  else if (ble.connected && !usb.connected) connectedTransport = 'ble';
  return {
    overall: s.status,
    usb,
    ble,
    anyConnected,
    bothConnected,
    connectedTransport,
    flashing: s.status === 'flashing',
    recovery,
    recovering: recovery !== 'none',
    nativeMode: s.nativeMode,
  };
}

/**
 * The one canonical status label, shared by the badge pill and the panel
 * subtitle so they never drift. Was duplicated verbatim in both components.
 */
export function statusLabel(s: CalliopeState, labels: ConnectLabels): string {
  // Native-proxy mode (iOS/Android app): surface the app-mode framing in every
  // state — "Nicht verbunden" misleads when the host app owns the radio.
  if (s.nativeMode) {
    switch (s.status) {
      case 'connected': return labels.appModeConnected;
      case 'connecting': return labels.appModeConnecting;
      case 'flashing': return flashLabel(s, labels);
      case 'error': return labels.error;
      default: return labels.appModeWaiting;
    }
  }
  switch (s.status) {
    case 'connected':
      if (s.usbStatus === 'connected' && s.bleStatus === 'connected') return `${labels.usb} + ${labels.ble}`;
      if (s.usbStatus === 'connected') return labels.usb;
      return labels.ble;
    case 'flashing': return flashLabel(s, labels);
    case 'connecting': return labels.connecting;
    case 'error': return labels.error;
    case 'unsupported': return labels.unsupported;
    case 'disconnected':
    case 'unknown':
    default: return labels.notConnected;
  }
}

function flashLabel(s: CalliopeState, labels: ConnectLabels): string {
  switch (s.flashPhase) {
    case 'check': return labels.phaseCheck;
    case 'reboot': return labels.phaseReboot;
    case 'prepare': return labels.phasePrepare;
    case 'finalising': return labels.phaseFinalising;
    default: return `${labels.flashing} ${s.flashProgress ?? 0}%`;
  }
}

/** True while the indeterminate (non-percentage) flash phases are showing. */
export function isIndeterminateFlash(s: CalliopeState): boolean {
  return s.status === 'flashing'
    && (s.flashPhase === 'check' || s.flashPhase === 'reboot' || s.flashPhase === 'prepare');
}
