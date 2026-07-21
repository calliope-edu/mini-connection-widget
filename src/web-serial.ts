/**
 * Web Serial transport for the Calliope mini 2.
 *
 * Mini 2's interface chip is a SEGGER J-Link OB, which the CMSIS-DAP path in
 * usb.ts can't drive. Its target UART is bridged to a USB CDC serial port
 * (VID 0x1366), reachable only via the Web Serial API — a permission + picker
 * separate from WebUSB. This module opens that port and feeds the SAME serial
 * subscribers the rest of the app already consumes (onSerialLine/onSerialData
 * via serial.ts, and the comms panel via pushRx), so a connected mini 2 behaves
 * like any other serial device for comms.
 *
 * Scope: comms only. Flashing a mini 2 still goes through the SEGGER MSD path in
 * usb.ts (`pickAndMaybeFlashJLink`). This connection carries no CMSIS-DAP, so
 * Blocks live-DAP features don't apply (mini 2 doesn't run the Blocks runtime
 * anyway).
 *
 * Web Serial globals aren't reliably typed across consumers' tsconfigs (same
 * story as WebUSB in usb.ts), so `navigator.serial` and the port/reader/writer
 * are accessed through `any`.
 */
import { updateState, getState } from './state';
import { appendLog } from './log';
import { pushRx } from './comms';
import { SEGGER_JLINK_VENDOR_ID } from './connection-errors';
import { BlocksFrameParser } from './blocks-frame';
import { noteBlocksFrame } from './blocks-liveness';

/** Calliope's serial runs at 115200 (same as the CODAL/DAL default). */
const JLINK_BAUD_RATE = 115200;

let port: any = null;
let reader: any = null;
let writer: any = null;
let readLoopAbort = false;
let readLoopDone: Promise<void> | null = null;

const rawSubs = new Set<(chunk: string) => void>();

// Continuous Blocks liveness tap on the mini 2 CDC stream. The runtime
// announces its RES_READ 0x0100 version frame ~once/second (BlocksProbe);
// parsing every chunk into the liveness latch here — not only during an
// active probe — means detection confirms passively the moment an announce
// arrives, even after a page reload or reconnect where the device's UART
// receive path has gone deaf and never hears the host's REQ_READ.
const livenessParser = new BlocksFrameParser();

/**
 * Subscribe to raw decoded chunks from the mini 2 serial port (no line
 * buffering). serial.ts wires `onSerialData`/`onSerialLine` through this so
 * consumers don't care which transport is active.
 */
export function addJlinkRawSubscriber(cb: (chunk: string) => void): () => void {
  rawSubs.add(cb);
  return () => { rawSubs.delete(cb); };
}

export function isJlinkSerialConnected(): boolean {
  return getState().jlinkSerialStatus === 'connected';
}

/** Decode incoming bytes 1:1 as Latin-1, mirroring the USB/BLE RX decode so the
 *  whole app stays byte-symmetric (see serial.ts `latin1Bytes`). */
function decodeLatin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** How a `connectJLinkSerial` attempt ended. `cancelled` = the user dismissed
 *  the port picker — NOT an error; the mini 2 stays usable flash-only via its
 *  J-Link WebUSB grant (`jlinkUsbStatus`). */
export type JlinkSerialOutcome = 'connected' | 'cancelled' | 'failed' | 'unsupported';

/**
 * Prompt for the mini 2's CDC serial port (Web Serial) and open it. This is the
 * second browser dialog after the WebUSB identify picker in connect.ts — Web
 * Serial grants are independent of WebUSB, so it can't be avoided. Callers must
 * invoke this from a user gesture (`requestPort` requires one).
 *
 * A silent resume is tried first: if the browser already remembers a granted
 * J-Link CDC port (`getPorts()`), it is reused with NO picker.
 *
 * Single-flight: concurrent calls (page-load silent resume racing a panel
 * click, offer-modal accept, connect flow) join the in-flight attempt instead
 * of double-opening / double-locking the module-level port.
 */
let connectInFlight: Promise<JlinkSerialOutcome> | null = null;
export function connectJLinkSerial(
  opts: { silentOnly?: boolean } = {},
): Promise<JlinkSerialOutcome> {
  if (connectInFlight) return connectInFlight;
  connectInFlight = doConnectJLinkSerial(opts).finally(() => { connectInFlight = null; });
  return connectInFlight;
}

async function doConnectJLinkSerial(
  opts: { silentOnly?: boolean } = {},
): Promise<JlinkSerialOutcome> {
  const nav = navigator as any;
  if (!nav.serial) {
    if (opts.silentOnly) return 'unsupported';
    updateState((s) => ({
      ...s,
      jlinkSerialStatus: 'error',
      usbErrorMessage: 'Web Serial wird in diesem Browser nicht unterstützt (für Calliope mini 2 nötig).',
    }));
    return 'unsupported';
  }
  if (getState().jlinkSerialStatus === 'connected') return 'connected';
  updateState((s) => ({ ...s, usbErrorMessage: undefined }));
  try {
    // Silent resume: a previously-granted port needs no picker (and no user
    // gesture) — this is what re-links serial after a re-plug or page reload.
    // Deliberately NOT surfaced as 'connecting': that status drives the
    // "wähle CDC – COM x" phase hint in panel/banner, which must only show
    // while the native picker is actually on screen.
    try {
      const ports: any[] = await nav.serial.getPorts();
      const prior = ports.find((p) => p?.getInfo?.()?.usbVendorId === SEGGER_JLINK_VENDOR_ID) ?? null;
      if (prior) {
        await prior.open({ baudRate: JLINK_BAUD_RATE });
        port = prior;
      }
    } catch { /* fall through to the picker */ }
    if (!port && opts.silentOnly) {
      // No grant to resume and no gesture to open a picker with — stay quiet.
      return 'cancelled';
    }
    if (!port) {
      // 'connecting' = the CDC picker is open — panel/banner show the
      // "USB 1/2 verbunden, wähle CDC – COM x" phase hint on this status.
      updateState((s) => ({ ...s, jlinkSerialStatus: 'connecting' }));
      port = await nav.serial.requestPort({ filters: [{ usbVendorId: SEGGER_JLINK_VENDOR_ID }] });
      await port.open({ baudRate: JLINK_BAUD_RATE });
    }
  } catch (err) {
    port = null;
    updateState((s) => ({ ...s, jlinkSerialStatus: 'disconnected' }));
    // Distinguish "user dismissed the picker" (NotFoundError) from a real open
    // failure — the caller keeps the flash-only connection either way, but a
    // failure is worth logging as such.
    const cancelled = (err as DOMException)?.name === 'NotFoundError';
    appendLog({
      direction: 'info',
      text: `mini 2 serial connect ${cancelled ? 'cancelled' : 'failed'}: ${(err as Error)?.message ?? err}`,
    });
    return cancelled ? 'cancelled' : 'failed';
  }
  try { writer = port.writable ? port.writable.getWriter() : null; } catch { writer = null; }
  updateState((s) => ({
    ...s,
    jlinkSerialStatus: 'connected',
    usbDeviceName: 'Calliope mini 2 (USB)',
    calliopeVersion: 'V2',
    versionAmbiguous: false,
    connectedAt: Date.now(),
  }));
  appendLog({ direction: 'info', text: 'Connected (Calliope mini 2 serial / Web Serial)' });
  readLoopDone = startReadLoop();
  return 'connected';
}

async function startReadLoop(): Promise<void> {
  readLoopAbort = false;
  if (!port || !port.readable) return;
  reader = port.readable.getReader();
  try {
    while (!readLoopAbort) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        const chunk = decodeLatin1(value as Uint8Array);
        for (const cb of rawSubs) { try { cb(chunk); } catch { /* ignore */ } }
        // Feed the passive liveness latch (version + "blocks is alive").
        for (const f of livenessParser.push(value as Uint8Array)) noteBlocksFrame(f);
        pushRx('usb', chunk);
      }
    }
  } catch (err) {
    appendLog({ direction: 'info', text: `mini 2 serial read ended: ${(err as Error)?.message ?? err}` });
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
    reader = null;
    // Reader ended on its own (device unplugged / stream error) rather than via
    // an explicit disconnect → reflect the drop, then try to resume silently:
    // the common cause is the TARGET rebooting after an MSD flash, which
    // glitches the CDC stream for a moment while the J-Link OB (and the
    // browser's port grant) stay alive. Without the resume, the serial link —
    // and with it the Blocks detection probe — stayed dead until a manual
    // reconnect (observed: probe confirms once right after a flash, then
    // every later probe reports 'unknown').
    if (!readLoopAbort) {
      void disconnectJLinkSerial().then(() => { void attemptSilentJlinkResume(); });
    }
  }
}

/**
 * Bounded silent-reconnect burst after an unexpected read-loop end. Uses the
 * gesture-free `getPorts()` resume only — never opens a picker. Ends quietly
 * when the port is really gone (unplugged / permission revoked).
 */
let resumeBurstActive = false;
async function attemptSilentJlinkResume(): Promise<void> {
  if (resumeBurstActive) return;
  resumeBurstActive = true;
  try {
    const delays = [1200, 1500, 2000, 3000];
    for (const d of delays) {
      await new Promise((r) => setTimeout(r, d));
      if (getState().jlinkSerialStatus === 'connected') return;
      const outcome = await connectJLinkSerial({ silentOnly: true });
      if (outcome === 'connected') {
        appendLog({ direction: 'info', text: 'mini 2 serial resumed after reboot' });
        return;
      }
    }
    appendLog({ direction: 'info', text: 'mini 2 serial did not come back after the drop — reconnect manually if needed' });
  } finally {
    resumeBurstActive = false;
  }
}

/** Write raw bytes to the mini 2. Accepts the same Latin-1 Uint8Array the USB
 *  path uses, so serial.ts can route to either transport identically. */
export async function jlinkSerialWrite(data: Uint8Array): Promise<void> {
  if (!writer) return;
  try { await writer.write(data); } catch { /* ignore — callers may be in a tight loop */ }
}

/**
 * Revoke every granted J-Link CDC Web Serial port. Companion to
 * `forgetAllUsbDevices` for the "Trennen & vergessen" action — without this the
 * silent-resume in `connectJLinkSerial` would quietly re-open the old port on
 * the next connect even though the user explicitly forgot the device.
 */
export async function forgetJLinkSerialPorts(): Promise<void> {
  const nav = navigator as any;
  if (!nav.serial?.getPorts) return;
  try {
    const ports: any[] = await nav.serial.getPorts();
    for (const p of ports) {
      if (p?.getInfo?.()?.usbVendorId !== SEGGER_JLINK_VENDOR_ID) continue;
      try { await p.forget?.(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export async function disconnectJLinkSerial(): Promise<void> {
  if (!port && getState().jlinkSerialStatus !== 'connected') {
    updateState((s) => ({ ...s, jlinkSerialStatus: 'disconnected' }));
    return;
  }
  readLoopAbort = true;
  try { await reader?.cancel(); } catch { /* ignore */ }
  // Wait for the read loop to release its lock before closing the port,
  // otherwise `port.close()` rejects with "port is already locked".
  try { await readLoopDone; } catch { /* ignore */ }
  readLoopDone = null;
  try { writer?.releaseLock(); } catch { /* ignore */ }
  writer = null;
  try { await port?.close(); } catch { /* ignore */ }
  port = null;
  updateState((s) => ({ ...s, jlinkSerialStatus: 'disconnected' }));
  appendLog({ direction: 'info', text: 'Disconnected (Calliope mini 2 serial)' });
}
