/**
 * Detect which kind of program is currently running on the connected
 * Calliope mini.
 *
 * Two probes run in parallel — whichever confirms first wins:
 *
 *   1. BLE: read the Blocks GATT service (UUID
 *      `0b50f3e4-607f-4151-9091-7d008d6ffc5c`). Service present ⇒ blocks.
 *      Note: the widget's `requestDevice` intercept declares this UUID in
 *      `optionalServices`, so the browser actually exposes it — without
 *      that, this probe would always fail with "Service not found".
 *
 *   2. USB: send a Blocks `REQ_READ on 0x0100` frame and watch for the
 *      `[0xFF (SFD), 0x01 (RES_READ), …]` reply. The handshake also kicks
 *      the firmware's STATE/MOTION broadcaster, so subsequent block I/O
 *      over USB actually flows. Two SFD+RES pairs within `timeoutMs`
 *      confirm.
 *
 * Returns 'disconnected' when neither transport is connected. Returns
 * 'unknown' if both probes fail to identify blocks within `timeoutMs`.
 */

import { getConnectedBleDevice } from './ble';
import { getUsbConn, registerSerialDataListener } from './usb';
import { calliopeState, updateState } from './state';
import { buildBlocksFrame, BLOCKS_REQ } from './blocks-protocol';
import { isNativeMode } from './native-bridge';
import { nativeGattRead } from './native-mode';

export type CalliopeProgramType = 'blocks' | 'unknown' | 'disconnected';

export interface CalliopeProgramInfo {
  type: CalliopeProgramType;
  /** Which transport confirmed the match. */
  via?: 'usb' | 'ble';
  /** Blocks protocol version reported by STATE characteristic (BLE only). */
  protocolVersion?: number;
  /** Blocks hardware version byte (BLE only). */
  hardwareVersion?: number;
}

// ---- BLE constants --------------------------------------------------------

const BLOCKS_BLE_SERVICE_UUID = '0b50f3e4-607f-4151-9091-7d008d6ffc5c';
const BLOCKS_BLE_STATE_CHAR_UUID = '0b500101-607f-4151-9091-7d008d6ffc5c';

// ---- USB constants --------------------------------------------------------

const BLOCKS_USB_SFD = 0xff;
// Blocks response types: 0x01 (read), 0x11 (write ack), 0x21 (notify).
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
  if (isNativeMode()) {
    // Native host owns GATT. Reuse the same proof-of-life heuristic: STATE
    // returns non-zero only when the real Blocks runtime is filling it
    // with sensor data; the CODAL stub leaves it all-zero. A failed read
    // (bridge replies empty/throws) is treated as "no Blocks" — same
    // semantics as the web path.
    try {
      const bytes = await nativeGattRead(BLOCKS_BLE_SERVICE_UUID, BLOCKS_BLE_STATE_CHAR_UUID);
      if (bytes.length === 0) return null;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 0) return { type: 'blocks', via: 'ble' };
      }
      return null;
    } catch {
      return null;
    }
  }

  const device = await getConnectedBleDevice();
  if (!device?.gatt) return null;
  let server: BluetoothRemoteGATTServer;
  try {
    server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  } catch {
    return null;
  }
  try {
    const service = await server.getPrimaryService(BLOCKS_BLE_SERVICE_UUID);
    // Service presence is no longer enough — the CODAL stub registers it
    // unconditionally so partial-flash DAL hashes line up. Discriminate by
    // reading STATE: real runtime continuously fills it with sensor data
    // (byte 5 = temperature + 128, byte 4 = light level, …); the stub's
    // buffer stays all-zero. Any non-zero byte → real runtime.
    let isReal = false;
    try {
      const ch = await service.getCharacteristic(BLOCKS_BLE_STATE_CHAR_UUID);
      const v = await ch.readValue();
      for (let i = 0; i < v.byteLength; i++) {
        if (v.getUint8(i) !== 0) { isReal = true; break; }
      }
    } catch {
      // STATE read failed — without proof of life, treat as unknown.
      return null;
    }
    if (!isReal) return null;
    return { type: 'blocks', via: 'ble' };
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
    let unsubscribe: (() => void) | null = null;
    const finish = (val: CalliopeProgramInfo | null) => {
      if (settled) return;
      settled = true;
      try { unsubscribe?.(); } catch { /* ignore */ }
      clearTimeout(timer);
      resolve(val);
    };
    unsubscribe = registerSerialDataListener((ev) => {
      const s = ev?.data;
      if (!s) return;
      for (let i = 0; i < s.length; i++) {
        const b = s.charCodeAt(i) & 0xff;
        if (prevByte === BLOCKS_USB_SFD && VALID_RES.has(b)) {
          hits++;
          if (hits >= USB_CONFIRM_HITS) {
            finish({ type: 'blocks', via: 'usb' });
            return;
          }
        }
        prevByte = b;
      }
    });
    // Wake the firmware's serial broadcaster by sending a real Blocks
    // `REQ_READ on ch 0x0100` frame. The pxt-blocks runtime only starts
    // its STATE/MOTION fiber after seeing this exact handshake
    // (BlocksSerial.cpp `startSerialReceiving`) — a plain 'H\n' is ignored.
    // Side-effects we rely on:
    //   1. Device replies with `RES_READ on 0x0100` → the first SFD+0x01
    //      pair the handler sees, so detection is fast.
    //   2. Broadcaster fiber starts, so subsequent block I/O over USB
    //      (subscribes / reads on STATE, MOTION, etc.) actually flows.
    void (async () => {
      try {
        // Pass the Uint8Array straight through — the widget's patched
        // serialWrite preserves bytes ≥ 0x80, which the stock library
        // would UTF-8-encode into multi-byte sequences and silently
        // corrupt the SFD/header.
        await conn.serialWrite(buildBlocksFrame(BLOCKS_REQ.READ, 0x0100));
      } catch { /* ignore */ }
    })();
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

// ---- Auto-refresh -------------------------------------------------------
//
// Keep `calliopeState.programType` in sync with reality: whenever the set of
// connected transports changes, kick off a probe and write the result back
// into the store. Consumers can `$calliopeState.programType` and react
// without ever calling `getRunningProgramType` themselves.

let probeTimer: ReturnType<typeof setTimeout> | null = null;
let lastConnectedKey = '<init>';
let lastFlashAtSeen = 0;

if (typeof window !== 'undefined') {
  calliopeState.subscribe((s) => {
    const key = `${s.usbStatus === 'connected' ? 'u' : ''}${s.bleStatus === 'connected' ? 'b' : ''}`;
    // Re-probe whenever transports change OR a flash just completed
    // (`lastFlashAt` advances). Post-flash the device runs a different
    // program — the previous probe result is stale.
    const flashEdge = s.lastFlashAt && s.lastFlashAt !== lastFlashAtSeen;
    if (key === lastConnectedKey && !flashEdge) return;
    lastConnectedKey = key;
    if (s.lastFlashAt) lastFlashAtSeen = s.lastFlashAt;

    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }

    if (!key) {
      // Neither transport connected — clear the latch.
      updateState((st) => (st.programType === 'disconnected' ? st : { ...st, programType: 'disconnected' }));
      return;
    }

    // Give GATT/service discovery (or the post-flash reboot) a moment to
    // settle, then probe. Post-flash needs longer because the device is
    // still in the bootloader→app handover.
    const settleDelay = flashEdge ? 1_500 : 500;
    probeTimer = setTimeout(() => {
      probeTimer = null;
      void (async () => {
        const info = await getRunningProgramType(2_500);
        updateState((st) => (st.programType === info.type ? st : { ...st, programType: info.type }));
      })();
    }, settleDelay);
  });
}
