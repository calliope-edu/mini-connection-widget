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
import { calliopeState, updateState, getState } from './state';
import { buildBlocksFrame, BLOCKS_REQ, BlocksUsbProbe } from './blocks-frame';
import { detectBlocksDap } from './blocks-dap';
import { isNativeMode } from './native-bridge';
import { nativeGattRead, nativeGattWrite } from './native-mode';

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
const BLOCKS_BLE_COMMAND_CHAR_UUID = '0b500100-607f-4151-9091-7d008d6ffc5c';

// COMMAND byte[1] = blocks protocol version. The real runtime stamps this on
// connect (updateVersionData); the CODAL stub that registers the service for
// partial-flash hash alignment leaves it 0. So a single COMMAND read identifies
// the runtime instantly — no waiting for the STATE broadcaster to fill.
const EXPECTED_BLOCKS_PROTOCOL = 2;

/** Interval between STATE samples while waiting for the broadcaster to fill it. */
const BLE_STATE_POLL_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when any non-zero byte is present — the broadcaster filled STATE. */
function hasNonZero(bytes: ArrayLike<number>): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) return true;
  }
  return false;
}

// The USB Blocks-frame matcher (`BlocksUsbProbe`) lives in `blocks-frame.ts`
// so it can be unit-tested without a serial port.

function readState(): { usbOn: boolean; bleOn: boolean } {
  let snap = { usbOn: false, bleOn: false };
  const unsub = calliopeState.subscribe((s) => {
    snap = { usbOn: s.usbStatus === 'connected', bleOn: s.bleStatus === 'connected' };
  });
  unsub();
  return snap;
}

// ---- Probes ---------------------------------------------------------------

async function probeBle(timeoutMs: number): Promise<CalliopeProgramInfo | null> {
  // Don't read GATT while a flash is active — the post-flash window has the
  // device rebooting through the bootloader and the native/DAP queue busy
  // with flash control. See `flashInProgress` in state.ts.
  if (getState().flashInProgress) return null;

  const deadline = Date.now() + timeoutMs;

  if (isNativeMode()) {
    // Native host owns GATT. Same proof-of-life heuristic as web: STATE
    // returns non-zero only when the real Blocks runtime is filling it with
    // sensor data; the CODAL stub leaves it all-zero. Kick the broadcaster
    // (the runtime only fills STATE once it sees a read/notify request),
    // then sample a few times across the probe window. A read error is
    // retryable within the window — only after the deadline is it "no Blocks".
    try {
      await nativeGattWrite(
        BLOCKS_BLE_SERVICE_UUID,
        BLOCKS_BLE_COMMAND_CHAR_UUID,
        buildBlocksFrame(BLOCKS_REQ.READ, 0x0100),
      );
    } catch { /* wake is best-effort */ }
    do {
      try {
        const bytes = await nativeGattRead(BLOCKS_BLE_SERVICE_UUID, BLOCKS_BLE_STATE_CHAR_UUID);
        if (hasNonZero(bytes)) return { type: 'blocks', via: 'ble' };
      } catch { /* retryable within the window */ }
      if (Date.now() + BLE_STATE_POLL_MS >= deadline) break;
      await sleep(BLE_STATE_POLL_MS);
    } while (Date.now() < deadline);
    return null;
  }

  const device = await getConnectedBleDevice();
  if (!device?.gatt) return null;
  let server: BluetoothRemoteGATTServer;
  try {
    server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  } catch {
    return null;
  }
  let service: BluetoothRemoteGATTService;
  let ch: BluetoothRemoteGATTCharacteristic;
  try {
    service = await server.getPrimaryService(BLOCKS_BLE_SERVICE_UUID);
    ch = await service.getCharacteristic(BLOCKS_BLE_COMMAND_CHAR_UUID);
  } catch {
    // Service / characteristic not present → not the Blocks runtime.
    return null;
  }
  // Read COMMAND and check the protocol byte — instant, no waiting for the STATE
  // broadcaster to fill (that polling loop is what made detection slow). The
  // real runtime stamps byte[1] = EXPECTED_BLOCKS_PROTOCOL on connect
  // (updateVersionData); the CODAL stub (registers the service for partial-flash
  // hash alignment) leaves it 0. A read error / not-yet-stamped value is retried
  // within the window rather than treated as an immediate "not blocks".
  do {
    try {
      const v = await ch.readValue();
      const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (b.byteLength >= 2 && b[1] === EXPECTED_BLOCKS_PROTOCOL) {
        return {
          type: 'blocks',
          via: 'ble',
          hardwareVersion: b[0],
          protocolVersion: b[1]
        };
      }
    } catch { /* retryable within the window */ }
    if (Date.now() + BLE_STATE_POLL_MS >= deadline) break;
    await sleep(BLE_STATE_POLL_MS);
  } while (Date.now() < deadline);
  return null;
}

function probeUsb(timeoutMs: number): Promise<CalliopeProgramInfo | null> {
  return new Promise((resolve) => {
    // Don't write serial while a flash is active — the probe would share the
    // DAP `sendQueue` with the flash control commands. See `flashInProgress`
    // in state.ts.
    if (getState().flashInProgress) { resolve(null); return; }
    // Use the already-initialised connection only — never trigger a
    // requestDevice prompt from a passive program-type probe.
    const conn = getUsbConn();
    if (!conn) { resolve(null); return; }

    const probe = new BlocksUsbProbe();
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
      const bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
      if (probe.push(bytes)) finish({ type: 'blocks', via: 'usb' });
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
    // The codal/mini-3 runtime speaks the CMSIS-DAP RAM mailbox, not the UART —
    // so the serial probe above sees nothing. Scan RAM for the mailbox in
    // parallel; finding it confirms a Blocks runtime over USB. Whichever probe
    // (serial frames or DAP scan) confirms first wins.
    void (async () => {
      try {
        if (await detectBlocksDap()) finish({ type: 'blocks', via: 'usb' });
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

  // Never probe during a flash: the post-flash window has serial / GATT busy
  // and the device mid-reboot. The auto-refresh subscription re-probes once
  // `flashInProgress` clears. Report 'unknown' so a stale result isn't latched.
  if (getState().flashInProgress) return { type: 'unknown' };

  // Kick off whichever probes are available. Skip a probe if its transport
  // isn't connected — saves opening a stray serial subscription.
  const probes: Promise<CalliopeProgramInfo | null>[] = [];
  if (bleOn) probes.push(probeBle(timeoutMs));
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
let flashWasInProgress = false;

if (typeof window !== 'undefined') {
  calliopeState.subscribe((s) => {
    const key = `${s.usbStatus === 'connected' ? 'u' : ''}${s.bleStatus === 'connected' ? 'b' : ''}`;
    // Re-probe whenever transports change OR a flash just completed. We detect
    // "flash completed" two ways and take whichever the backend gives us:
    //   - `lastFlashAt` advances (set by the web/native flash dispatchers), or
    //   - `flashInProgress` falls true→false (native `flashDone`, web `finally`).
    // Native flashing in particular drives `programType` updates ONLY through
    // these edges — there's no serial reply to piggyback on — so the falling
    // edge of `flashInProgress` is what re-arms the probe there.
    // Post-flash the device runs a different program → the previous result is
    // stale.
    const flashAtEdge = s.lastFlashAt && s.lastFlashAt !== lastFlashAtSeen;
    const flashDoneEdge = flashWasInProgress && !s.flashInProgress;
    const flashEdge = flashAtEdge || flashDoneEdge;
    flashWasInProgress = s.flashInProgress;
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

    // Defer the probe while a flash is still running. `getRunningProgramType`
    // bails out during `flashInProgress`, and probing the device mid-reboot is
    // pointless — the falling edge of `flashInProgress` re-enters here and
    // schedules the real re-probe once the flash window closes.
    if (s.flashInProgress) return;

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
