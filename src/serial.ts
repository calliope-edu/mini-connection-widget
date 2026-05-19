import { ConnectionStatus } from '@microbit/microbit-connection';
import { appendLog } from './log';
import { getUsbConn, registerSerialDataListener } from './usb';
import {
  addBleLineSubscriber,
  addBleRawSubscriber,
  bleSerialWrite,
  getBleConn,
} from './ble';
import { calliopeState, getState } from './state';
import { pushTx } from './comms';

const HEARTBEAT_MS = 1000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function isFlashGated(): boolean {
  return getState().flashInProgress;
}

export function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    // Only send for the MakeCode/blocks runtime, which intercepts the 'H'
    // in its frame handler. MicroPython's REPL would echo every byte back
    // and flood the user's serial terminal.
    let programType: string | undefined;
    let flashInProgress = false;
    const unsub = calliopeState.subscribe((s) => {
      programType = s.programType;
      flashInProgress = s.flashInProgress;
    });
    unsub();
    if (programType !== 'blocks') return;
    // Don't share the DAP `sendQueue` with a flash in progress — even with
    // the listener-registry pause active, a heartbeat write here would
    // hit the same race that breaks the flash.
    if (flashInProgress) return;
    // Send over whichever transport is connected. Prefer USB when both are
    // up — DAPLink's serial is more reliable than BLE UART.
    const usb = getUsbConn();
    if (usb?.status === ConnectionStatus.Connected) {
      void usb.serialWrite('H\n').catch(() => {});
      return;
    }
    const ble = getBleConn();
    if (ble?.status === ConnectionStatus.Connected) {
      void bleSerialWrite('H\n').catch(() => {});
    }
  }, HEARTBEAT_MS);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Send a newline-terminated line to the board. Routes over USB when
 * connected, else BLE. Suppresses heartbeat 'H' echoes from the log so the
 * communication panel doesn't get spammed.
 */
export async function sendSerialLine(line: string): Promise<void> {
  if (isFlashGated()) return;
  const out = line.endsWith('\n') ? line : line + '\n';
  try {
    const usb = getUsbConn();
    let transport: 'usb' | 'ble' | null = null;
    if (usb?.status === ConnectionStatus.Connected) {
      await usb.serialWrite(out);
      transport = 'usb';
    } else {
      const ble = getBleConn();
      if (ble?.status !== ConnectionStatus.Connected) return;
      await bleSerialWrite(out);
      transport = 'ble';
    }
    if (line.trim() !== 'H') {
      appendLog({ direction: 'tx', text: line.replace(/\n$/, '') });
      if (transport) pushTx(transport, line.replace(/\n$/, ''));
    }
  } catch {
    /* ignore — caller may be in a tight loop */
  }
}

/**
 * Send raw data to the board without forcing a trailing newline. Use this
 * for character-level transports — typically the MicroPython REPL, where
 * every keystroke goes to the device as it's typed.
 */
export async function sendSerialData(data: string): Promise<void> {
  if (!data) return;
  if (isFlashGated()) return;
  try {
    const usb = getUsbConn();
    if (usb?.status === ConnectionStatus.Connected) {
      await usb.serialWrite(data);
      pushTx('usb', data);
      return;
    }
    const ble = getBleConn();
    if (ble?.status !== ConnectionStatus.Connected) return;
    await bleSerialWrite(data);
    pushTx('ble', data);
  } catch {
    /* ignore — caller may be in a tight loop */
  }
}

/**
 * Subscribe to raw decoded chunks from the board (no line buffering, no
 * filtering, partial lines welcome). The complement of `sendSerialData`,
 * for consumers that need char-level data — typically the MicroPython
 * REPL.
 */
export function onSerialData(cb: (chunk: string) => void): () => void {
  const unsubBle = addBleRawSubscriber(cb);
  const unsubUsb = registerSerialDataListener((ev) => {
    if (ev.data) cb(ev.data);
  });
  return () => {
    unsubBle();
    unsubUsb();
  };
}

/**
 * Subscribe to line-delimited data from the board. USB serialdata routes
 * through the lib's event; BLE UART routes through our characteristic
 * notification handler (registered in setupBleUart). Both feed callbacks
 * the same way, so the consumer doesn't care which transport is active.
 */
export function onSerialLine(cb: (line: string) => void): () => void {
  let usbBuf = '';
  const unsubBle = addBleLineSubscriber(cb);
  const unsubUsb = registerSerialDataListener((ev) => {
    usbBuf += ev.data;
    let idx: number;
    while ((idx = usbBuf.indexOf('\n')) >= 0) {
      const line = usbBuf.slice(0, idx).replace(/\r$/, '');
      usbBuf = usbBuf.slice(idx + 1);
      if (line) cb(line);
    }
  });
  return () => {
    unsubBle();
    unsubUsb();
  };
}
