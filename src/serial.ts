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
import { isJlinkSerialConnected, jlinkSerialWrite, addJlinkRawSubscriber } from './web-serial';
import { pushTx } from './comms';
import { isNativeMode, addNativeSerialListener } from './native-bridge';
import { nativeSerialWrite } from './native-mode';

const HEARTBEAT_MS = 1000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Encode an outgoing serial string as raw bytes using Latin-1/ISO-8859-1
 * (one byte per code unit, masked to 0x00–0xFF). This mirrors the RX decode
 * (`charCodeAt(i) & 0xff`) so TX and RX stay byte-symmetric. Passing the
 * Uint8Array to the widget's patched `serialWrite` preserves bytes ≥ 0x80,
 * whereas a plain string would be UTF-8-encoded and mangle every high byte
 * (e.g. 0xFF → 0xC3 0xBF).
 */
function latin1Bytes(str: string): Uint8Array {
  return Uint8Array.from(str, (c) => c.charCodeAt(0) & 0xff);
}

/**
 * What to hand DAPLink's `serialWrite` for an outgoing payload.
 *
 * Only the widget's patch of `@microbit/microbit-connection` lets that call take
 * raw bytes; the stock library runs its argument through `TextEncoder`, which
 * *stringifies* a Uint8Array: a line goes out as the text `"87,32,49,10"`, its
 * newline turned into digits along with everything else, so no delimiter ever
 * matches on the board. And the patch is a pnpm `patchedDependencies` entry —
 * an npm install (the Cloudflare deploy), or one driven from a workspace root
 * that doesn't re-declare it, silently ships the stock library.
 *
 * So a payload that is pure ASCII — the whole newline-delimited line protocol —
 * goes as a string. UTF-8 and Latin-1 agree below 0x80, the bytes on the wire
 * are identical either way, and the line protocol stops depending on the patch.
 * Only a payload that really carries a byte ≥ 0x80 takes the Uint8Array path:
 * that's the Blocks wire protocol with its 0xFF start-of-frame, which does still
 * need the patch (see blocks-protocol.ts, which writes its frames directly).
 */
function usbPayload(str: string): string {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0x7f) {
      // Cast: the stock type only admits a string, the patched one takes both.
      return latin1Bytes(str) as unknown as string;
    }
  }
  return str;
}

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

// Drive the heartbeat from the overall connection status rather than from
// transport-specific connect handlers. The previous wiring started it from
// the web BLE/USB `status` event listeners, which never run in native mode —
// so the Blocks-runtime broadcaster was never woken there. `status` rolls up
// USB + BLE + native (the native bridge mutates `bleStatus` through the same
// `updateState`), so a single subscription covers all three transports.
// `startHeartbeat`/`stopHeartbeat` are idempotent, so the redundant calls
// still made by the web connect handlers are harmless.
calliopeState.subscribe((s) => {
  if (s.status === 'connected') startHeartbeat();
  else stopHeartbeat();
});

/**
 * Send a newline-terminated line to the board. Routes over USB when
 * connected, else BLE. Suppresses heartbeat 'H' echoes from the log so the
 * communication panel doesn't get spammed.
 */
export async function sendSerialLine(line: string): Promise<void> {
  if (isFlashGated()) return;
  const out = line.endsWith('\n') ? line : line + '\n';
  if (isNativeMode()) {
    await nativeSerialWrite(out);
    if (line.trim() !== 'H') appendLog({ direction: 'tx', text: line.replace(/\n$/, '') });
    return;
  }
  try {
    const usb = getUsbConn();
    let transport: 'usb' | 'ble' | null = null;
    if (usb?.status === ConnectionStatus.Connected) {
      await usb.serialWrite(usbPayload(out));
      transport = 'usb';
    } else if (isJlinkSerialConnected()) {
      // Calliope mini 2 over Web Serial — same transport tag as USB for the
      // comms panel (it's a USB device).
      await jlinkSerialWrite(latin1Bytes(out));
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
  if (isNativeMode()) {
    await nativeSerialWrite(data);
    return;
  }
  try {
    const usb = getUsbConn();
    if (usb?.status === ConnectionStatus.Connected) {
      await usb.serialWrite(usbPayload(data));
      pushTx('usb', data);
      return;
    }
    if (isJlinkSerialConnected()) {
      await jlinkSerialWrite(latin1Bytes(data));
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
  if (isNativeMode()) {
    return addNativeSerialListener(cb);
  }
  const unsubBle = addBleRawSubscriber(cb);
  const unsubUsb = registerSerialDataListener((ev) => {
    if (ev.data) cb(ev.data);
  });
  const unsubJlink = addJlinkRawSubscriber(cb);
  return () => {
    unsubBle();
    unsubUsb();
    unsubJlink();
  };
}

/**
 * Subscribe to line-delimited data from the board. USB serialdata routes
 * through the lib's event; BLE UART routes through our characteristic
 * notification handler (registered in setupBleUart). Both feed callbacks
 * the same way, so the consumer doesn't care which transport is active.
 */
export function onSerialLine(cb: (line: string) => void): () => void {
  if (isNativeMode()) {
    let buf = '';
    return addNativeSerialListener((chunk) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line) cb(line);
      }
    });
  }
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
  // Calliope mini 2 (Web Serial) delivers raw chunks; buffer into lines here,
  // mirroring the USB path above.
  let jlinkBuf = '';
  const unsubJlink = addJlinkRawSubscriber((chunk) => {
    jlinkBuf += chunk;
    let idx: number;
    while ((idx = jlinkBuf.indexOf('\n')) >= 0) {
      const line = jlinkBuf.slice(0, idx).replace(/\r$/, '');
      jlinkBuf = jlinkBuf.slice(idx + 1);
      if (line) cb(line);
    }
  });
  return () => {
    unsubBle();
    unsubUsb();
    unsubJlink();
  };
}
