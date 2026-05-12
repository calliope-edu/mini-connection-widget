/**
 * Detect which kind of program is currently running on the connected
 * Calliope mini.
 *
 * Two probes run in parallel — whichever confirms first wins:
 *
 *   1. BLE: read the MbitMore GATT service (UUID
 *      `0b50f3e4-607f-4151-9091-7d008d6ffc5c`). Service present ⇒ blocks.
 *      Note: the widget's `requestDevice` intercept declares this UUID in
 *      `optionalServices`, so the browser actually exposes it — without
 *      that, this probe would always fail with "Service not found".
 *
 *   2. USB: sniff the serial stream for MbitMore frame headers. Blocks
 *      firmware auto-broadcasts STATE/MOTION every ~40ms as
 *      `[0xFF (SFD), 0x01 (RES_READ), ch_hi, ch_lo, len, ...data, chksum]`.
 *      Seeing a few `0xFF 0x01` pairs within ~1s is a positive match.
 *
 * Returns 'disconnected' when neither transport is connected. Returns
 * 'unknown' if both probes fail to identify blocks within `timeoutMs`.
 *
 * No firmware change required for BLE. USB detection works against the
 * unmodified blocks runtime because it broadcasts continuously.
 */

import { getConnectedBleDevice } from './ble';
import { getUsbConn } from './usb';
import { calliopeState } from './state';

export type CalliopeProgramType = 'blocks' | 'unknown' | 'disconnected';

export interface CalliopeProgramInfo {
  type: CalliopeProgramType;
  /** Which transport confirmed the match. */
  via?: 'usb' | 'ble';
  /** MbitMore protocol version reported by STATE characteristic (BLE only). */
  protocolVersion?: number;
  /** MbitMore hardware version byte (BLE only). */
  hardwareVersion?: number;
}

// ---- BLE constants --------------------------------------------------------

const MBIT_MORE_SERVICE_UUID = '0b50f3e4-607f-4151-9091-7d008d6ffc5c';
const MBIT_MORE_STATE_CHAR_UUID = '0b500101-607f-4151-9091-7d008d6ffc5c';

// ---- USB constants --------------------------------------------------------

const MM_SFD = 0xff;
// MbitMore response types: 0x01 (read), 0x11 (write ack), 0x21 (notify).
// Seeing SFD followed by one of these is a strong signal.
const VALID_RES = new Set([0x01, 0x11, 0x21]);
// Confirm after this many valid frame headers in a row.
const USB_CONFIRM_HITS = 2;

function readState(): { usbOn: boolean; bleOn: boolean } {
  let snap = { usbOn: false, bleOn: false };
  const unsub = calliopeState.subscribe((s) => {
    snap = { usbOn: s.usbStatus === 'connected', bleOn: s.bleStatus === 'connected' };
  });
  unsub();
  return snap;
}

// ---- Probes ---------------------------------------------------------------

async function probeBle(): Promise<CalliopeProgramInfo | null> {
  const device = await getConnectedBleDevice();
  if (!device?.gatt) return null;
  let server: BluetoothRemoteGATTServer;
  try {
    server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  } catch {
    return null;
  }
  try {
    const service = await server.getPrimaryService(MBIT_MORE_SERVICE_UUID);
    let protocolVersion: number | undefined;
    let hardwareVersion: number | undefined;
    try {
      const ch = await service.getCharacteristic(MBIT_MORE_STATE_CHAR_UUID);
      const v = await ch.readValue();
      if (v.byteLength >= 2) {
        hardwareVersion = v.getUint8(0);
        protocolVersion = v.getUint8(1);
      }
    } catch {
      /* STATE read failed — service presence is enough. */
    }
    return { type: 'blocks', via: 'ble', protocolVersion, hardwareVersion };
  } catch {
    return null;
  }
}

function probeUsb(timeoutMs: number): Promise<CalliopeProgramInfo | null> {
  return new Promise((resolve) => {
    // Use the already-initialised connection only — never trigger a
    // requestDevice prompt from a passive program-type probe.
    const conn = getUsbConn();
    if (!conn) { resolve(null); return; }

    let hits = 0;
    let prevByte = -1;
    let settled = false;
    const finish = (val: CalliopeProgramInfo | null) => {
      if (settled) return;
      settled = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (conn as any).removeEventListener?.('serialdata', handler);
      } catch { /* ignore */ }
      clearTimeout(timer);
      resolve(val);
    };
    const handler = (ev: { data: string }) => {
      const s = ev?.data;
      if (!s) return;
      for (let i = 0; i < s.length; i++) {
        const b = s.charCodeAt(i) & 0xff;
        if (prevByte === MM_SFD && VALID_RES.has(b)) {
          hits++;
          if (hits >= USB_CONFIRM_HITS) {
            finish({ type: 'blocks', via: 'usb' });
            return;
          }
        }
        prevByte = b;
      }
    };
    try {
      // The widget's USB connection mirrors EventTarget for `serialdata`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (conn as any).addEventListener('serialdata', handler);
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * Probe BLE and USB in parallel; resolve as soon as either confirms blocks.
 * If neither confirms within `timeoutMs`, return 'unknown' (or
 * 'disconnected' when neither transport is connected).
 *
 * Safe to call repeatedly — never throws.
 */
export async function getRunningProgramType(
  timeoutMs = 1500,
): Promise<CalliopeProgramInfo> {
  const { usbOn, bleOn } = readState();
  if (!usbOn && !bleOn) return { type: 'disconnected' };

  // Kick off whichever probes are available. Skip a probe if its transport
  // isn't connected — saves opening a stray serial subscription.
  const probes: Promise<CalliopeProgramInfo | null>[] = [];
  if (bleOn) probes.push(probeBle());
  if (usbOn) probes.push(probeUsb(timeoutMs));

  // Resolve on first positive hit, else wait for all and report 'unknown'.
  const firstHit = await new Promise<CalliopeProgramInfo | null>((resolve) => {
    let remaining = probes.length;
    if (remaining === 0) { resolve(null); return; }
    for (const p of probes) {
      p.then((res) => {
        if (res?.type === 'blocks') resolve(res);
        else if (--remaining === 0) resolve(null);
      }).catch(() => {
        if (--remaining === 0) resolve(null);
      });
    }
  });

  return firstHit ?? { type: 'unknown' };
}
