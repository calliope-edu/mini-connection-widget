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
import { addJlinkRawSubscriber, jlinkSerialWrite } from './web-serial';
import { calliopeState, updateState, getState } from './state';
import {
  buildBlocksFrame,
  BLOCKS_REQ,
  BLOCKS_RES,
  BLOCKS_USB_CONFIRM_HITS,
  BlocksFrameParser,
} from './blocks-frame';
import { detectBlocksDap } from './blocks-dap';
import { isNativeMode } from './native-bridge';
import { nativeGattRead, nativeGattWrite } from './native-mode';

export type CalliopeProgramType = 'blocks' | 'unknown' | 'disconnected';

export interface CalliopeProgramInfo {
  type: CalliopeProgramType;
  /** Which transport confirmed the match. */
  via?: 'usb' | 'ble';
  /** Blocks protocol version — COMMAND payload byte[1] (BLE read, or the
   *  RES_READ 0x0100 reply over the mini 2's CDC serial). */
  protocolVersion?: number;
  /** Blocks hardware version byte — COMMAND payload byte[0]. */
  hardwareVersion?: number;
  /** Blocks runtime (hex) version — COMMAND payload byte[3]. Lets hosts run
   *  their outdated-check without a live editor connection. */
  runtimeVersion?: number;
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

// The USB Blocks-frame parsing (`BlocksFrameParser`) lives in `blocks-frame.ts`
// so it can be unit-tested without a serial port.

function readState(): { usbOn: boolean; bleOn: boolean; jlinkSerialOn: boolean; jlinkUsbOn: boolean } {
  let snap = { usbOn: false, bleOn: false, jlinkSerialOn: false, jlinkUsbOn: false };
  const unsub = calliopeState.subscribe((s) => {
    snap = {
      usbOn: s.usbStatus === 'connected',
      bleOn: s.bleStatus === 'connected',
      // Mini 2: CDC serial (probe-able) vs J-Link flash-only (connected, but
      // nothing to probe over).
      jlinkSerialOn: s.jlinkSerialStatus === 'connected',
      jlinkUsbOn: s.jlinkUsbStatus === 'connected',
    };
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
          protocolVersion: b[1],
          runtimeVersion: b.byteLength >= 4 ? b[3] : undefined
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

    // Mirror `probeJlinkSerial`: count checksum-valid frames AND capture the
    // RES_READ 0x0100 reply — its payload mirrors the BLE COMMAND
    // characteristic (hardware / protocol / runtime version bytes), so the
    // DAPLink CDC path reports the runtime version just like the mini 2
    // path (used by the campus banner's outdated-firmware offer).
    const parser = new BlocksFrameParser();
    let validFrames = 0;
    let versionInfo: Pick<CalliopeProgramInfo, 'hardwareVersion' | 'protocolVersion' | 'runtimeVersion'> = {};
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
      for (const f of parser.push(bytes)) {
        validFrames++;
        if (f.type === BLOCKS_RES.READ && f.channel === 0x0100 && f.data.length >= 2) {
          versionInfo = {
            hardwareVersion: f.data[0],
            protocolVersion: f.data[1],
            runtimeVersion: f.data.length >= 4 ? f.data[3] : undefined,
          };
        }
      }
      if (validFrames >= BLOCKS_USB_CONFIRM_HITS) {
        finish({ type: 'blocks', via: 'usb', ...versionInfo });
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
 * Probe the Blocks serial handshake over the mini 2's CDC port (Web Serial).
 * Same REQ_READ wake as `probeUsb`, but routed through the J-Link serial
 * transport — the DAL Blocks runtime speaks the identical framed protocol
 * over its UART, which the J-Link OB bridges to CDC.
 *
 * Confirms on `BLOCKS_USB_CONFIRM_HITS` checksum-valid frames (same bar as
 * `BlocksUsbProbe`), and additionally captures the RES_READ reply on channel
 * 0x0100 — its payload mirrors the BLE COMMAND characteristic (hardware /
 * protocol / runtime version bytes), so hosts get version info over USB too.
 */
function probeJlinkSerial(timeoutMs: number): Promise<CalliopeProgramInfo | null> {
  return new Promise((resolve) => {
    if (getState().flashInProgress) { resolve(null); return; }
    const parser = new BlocksFrameParser();
    let validFrames = 0;
    let versionInfo: Pick<CalliopeProgramInfo, 'hardwareVersion' | 'protocolVersion' | 'runtimeVersion'> = {};
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (val: CalliopeProgramInfo | null) => {
      if (settled) return;
      settled = true;
      try { unsubscribe?.(); } catch { /* ignore */ }
      clearTimeout(timer);
      resolve(val);
    };
    unsubscribe = addJlinkRawSubscriber((chunk) => {
      if (!chunk) return;
      const bytes = new Uint8Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) bytes[i] = chunk.charCodeAt(i) & 0xff;
      for (const f of parser.push(bytes)) {
        validFrames++;
        // The direct answer to our REQ_READ — usually the first frame.
        if (f.type === BLOCKS_RES.READ && f.channel === 0x0100 && f.data.length >= 2) {
          versionInfo = {
            hardwareVersion: f.data[0],
            protocolVersion: f.data[1],
            runtimeVersion: f.data.length >= 4 ? f.data[3] : undefined,
          };
        }
      }
      if (validFrames >= BLOCKS_USB_CONFIRM_HITS) {
        finish({ type: 'blocks', via: 'usb', ...versionInfo });
      }
    });
    void jlinkSerialWrite(buildBlocksFrame(BLOCKS_REQ.READ, 0x0100)).catch(() => { /* ignore */ });
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
  const { usbOn, bleOn, jlinkSerialOn, jlinkUsbOn } = readState();
  if (!usbOn && !bleOn && !jlinkSerialOn && !jlinkUsbOn) return { type: 'disconnected' };

  // Never probe during a flash: the post-flash window has serial / GATT busy
  // and the device mid-reboot. The auto-refresh subscription re-probes once
  // `flashInProgress` clears. Report 'unknown' so a stale result isn't latched.
  if (getState().flashInProgress) return { type: 'unknown' };

  // Kick off whichever probes are available. Skip a probe if its transport
  // isn't connected — saves opening a stray serial subscription. A flash-only
  // mini 2 (`jlinkUsbOn` without CDC serial) has nothing to probe over and
  // falls through to 'unknown' — connected, program unconfirmed.
  const probes: Promise<CalliopeProgramInfo | null>[] = [];
  if (bleOn) probes.push(probeBle(timeoutMs));
  if (usbOn) probes.push(probeUsb(timeoutMs));
  if (jlinkSerialOn) probes.push(probeJlinkSerial(timeoutMs));

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
    const key =
      `${s.usbStatus === 'connected' ? 'u' : ''}${s.bleStatus === 'connected' ? 'b' : ''}` +
      `${s.jlinkSerialStatus === 'connected' ? 'j' : ''}${s.jlinkUsbStatus === 'connected' ? 'J' : ''}`;
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
