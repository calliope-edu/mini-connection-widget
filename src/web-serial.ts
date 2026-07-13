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

/** Calliope's serial runs at 115200 (same as the CODAL/DAL default). */
const JLINK_BAUD_RATE = 115200;

let port: any = null;
let reader: any = null;
let writer: any = null;
let readLoopAbort = false;
let readLoopDone: Promise<void> | null = null;

const rawSubs = new Set<(chunk: string) => void>();

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

/**
 * Prompt for the mini 2's CDC serial port (Web Serial) and open it. This is the
 * second browser dialog after the WebUSB identify picker in connect.ts — Web
 * Serial grants are independent of WebUSB, so it can't be avoided.
 */
export async function connectJLinkSerial(): Promise<void> {
  const nav = navigator as any;
  if (!nav.serial) {
    updateState((s) => ({
      ...s,
      jlinkSerialStatus: 'error',
      usbErrorMessage: 'Web Serial wird in diesem Browser nicht unterstützt (für Calliope mini 2 nötig).',
    }));
    return;
  }
  updateState((s) => ({ ...s, jlinkSerialStatus: 'connecting', usbErrorMessage: undefined }));
  try {
    port = await nav.serial.requestPort({ filters: [{ usbVendorId: SEGGER_JLINK_VENDOR_ID }] });
    await port.open({ baudRate: JLINK_BAUD_RATE });
  } catch (err) {
    // Picker dismissed / nothing selected / open failed — treat as a cancel.
    port = null;
    updateState((s) => ({ ...s, jlinkSerialStatus: 'disconnected' }));
    appendLog({ direction: 'info', text: `mini 2 serial connect cancelled/failed: ${(err as Error)?.message ?? err}` });
    return;
  }
  try { writer = port.writable ? port.writable.getWriter() : null; } catch { writer = null; }
  updateState((s) => ({
    ...s,
    jlinkSerialStatus: 'connected',
    usbDeviceName: 'Calliope mini 2 (USB)',
    calliopeVersion: 'V2',
    connectedAt: Date.now(),
  }));
  appendLog({ direction: 'info', text: 'Connected (Calliope mini 2 serial / Web Serial)' });
  readLoopDone = startReadLoop();
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
        pushRx('usb', chunk);
      }
    }
  } catch (err) {
    appendLog({ direction: 'info', text: `mini 2 serial read ended: ${(err as Error)?.message ?? err}` });
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
    reader = null;
    // Reader ended on its own (device unplugged / stream error) rather than via
    // an explicit disconnect → reflect the drop.
    if (!readLoopAbort) void disconnectJLinkSerial();
  }
}

/** Write raw bytes to the mini 2. Accepts the same Latin-1 Uint8Array the USB
 *  path uses, so serial.ts can route to either transport identically. */
export async function jlinkSerialWrite(data: Uint8Array): Promise<void> {
  if (!writer) return;
  try { await writer.write(data); } catch { /* ignore — callers may be in a tight loop */ }
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
