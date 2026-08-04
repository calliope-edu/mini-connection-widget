/**
 * Native-mode replacements for the widget's command surface.
 *
 * These are no-ops in web mode — `connect.ts`, `flash.ts`, `serial.ts` and
 * the GATT helpers consult `isNativeMode()` and short-circuit here instead
 * of touching `@microbit/microbit-connection`. The native host pushes state
 * updates back via `installNativeApi()`.
 */

import { sendNative, addNativeGattListener } from './native-bridge';
import { calliopeState, updateState, getState, type CalliopeTransport } from './state';
import { appendLog } from './log';
import { pushTx } from './comms';

// ---- Connect / disconnect --------------------------------------------------

export async function nativeConnect(transport: CalliopeTransport): Promise<void> {
  updateState((s) =>
    transport === 'ble'
      ? { ...s, bleStatus: 'connecting', bleErrorMessage: undefined, userDisconnectedBle: false }
      : { ...s, usbStatus: 'connecting', usbErrorMessage: undefined, userDisconnectedUsb: false },
  );
  try {
    await sendNative<void>('connect', { transport });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    appendLog({ direction: 'error', text: `native connect ${transport} failed: ${msg}` });
    updateState((s) =>
      transport === 'ble'
        ? { ...s, bleStatus: 'error', bleErrorMessage: msg }
        : { ...s, usbStatus: 'error', usbErrorMessage: msg },
    );
  }
}

export async function nativeDisconnectAndForget(transport: CalliopeTransport): Promise<void> {
  try {
    await sendNative<void>('disconnect', { transport, forget: true });
  } catch (err) {
    appendLog({
      direction: 'error',
      text: `native disconnect ${transport} failed: ${(err as Error)?.message ?? err}`,
    });
  }
  updateState((s) => {
    if (transport === 'usb') {
      return {
        ...s,
        usbStatus: 'disconnected',
        usbDeviceName: undefined,
        usbErrorMessage: undefined,
        userDisconnectedUsb: true,
        friendlyName: s.bleStatus === 'connected' ? s.friendlyName : undefined,
      };
    }
    return {
      ...s,
      bleStatus: 'disconnected',
      bleDeviceName: undefined,
      bleErrorMessage: undefined,
      bleHasPermission: false,
      bleCanFlash: false,
      bleCanCommunicate: false,
      userDisconnectedBle: true,
      friendlyName: s.usbStatus === 'connected' ? s.friendlyName : undefined,
    };
  });
}

// ---- Flash -----------------------------------------------------------------

/**
 * Hand the whole hex to the native host and let it pick partial-vs-full DFU.
 * Native pushes `flashProgress` and a terminating `flashDone` event back
 * through the bridge; on success we just await the reply. On failure the
 * promise rejects with the native message.
 */
export async function nativeFlash(hex: string, name: string, forceFullDfu = false, programHasBle?: boolean): Promise<void> {
  const s = getState();
  if (s.flashInProgress) {
    appendLog({
      direction: 'info',
      text: `Übertragung bereits aktiv — zusätzlicher Versuch ignoriert (${name}).`,
    });
    return;
  }
  updateState((st) => ({ ...st, flashInProgress: true, lastFlashName: name }));
  try {
    // `forceFullDfu` tells the host to skip partial flash and go straight to
    // Nordic DFU — required for the Blocks runtime, whose DAL hash matches a
    // pxt-calliope app so a partial flash would silently corrupt it. Both the
    // Android and iOS proxies read this flag.
    //
    // `programHasBle: false` tells the host the new program turns BLE off
    // (MicroPython, MakeCode-with-radio), so its reconnect-before-flash prompts
    // for A+B+Reset sooner. Omitted ⇒ unknown; `JSON.stringify` drops it.
    await sendNative<void>('flash', { hex, name, forceFullDfu, programHasBle });
    updateState((st) => ({ ...st, lastFlashAt: Date.now() }));
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    appendLog({ direction: 'error', text: `native flash failed: ${msg}` });
    throw err;
  } finally {
    updateState((st) => ({
      ...st,
      flashInProgress: false,
      flashTransport: undefined,
      flashPhase: undefined,
      flashProgress: undefined,
    }));
  }
}

// ---- Serial ----------------------------------------------------------------

function stringToBase64(s: string): string {
  // Latin-1 round-trip matches the widget's USB serial encoding so binary
  // Blocks frames survive the bridge intact.
  let bin = '';
  for (let i = 0; i < s.length; i++) bin += String.fromCharCode(s.charCodeAt(i) & 0xff);
  return btoa(bin);
}

export async function nativeSerialWrite(data: string): Promise<void> {
  if (!data) return;
  try {
    await sendNative<void>('serialWrite', { data: stringToBase64(data) });
    pushTx('ble', data);
  } catch (err) {
    appendLog({
      direction: 'error',
      text: `native serial write failed: ${(err as Error)?.message ?? err}`,
    });
  }
}

// ---- GATT (Blocks editor / direct-GATT consumers) -------------------------

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export async function nativeGattRead(
  serviceId: string | number,
  characteristicId: string | number,
): Promise<Uint8Array> {
  const reply = await sendNative<{ data: string }>('gattRead', { serviceId, characteristicId });
  if (!reply?.data) return new Uint8Array(0);
  const raw = atob(reply.data);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function nativeGattWrite(
  serviceId: string | number,
  characteristicId: string | number,
  data: Uint8Array,
  withResponse = false,
): Promise<void> {
  await sendNative<void>('gattWrite', {
    serviceId,
    characteristicId,
    data: bytesToBase64(data),
    withResponse,
  });
}

// Host-subscribe refcount per characteristic. We send the host a single
// `gattSubscribe` on the 0->1 transition and a single `gattUnsubscribe` on the
// 1->0 transition — mirroring `addNativeGattListener`'s Set-size check on the
// bridge side. Without this, re-subscribing the same characteristic only ever
// sends one host subscribe while unsubscribing one of several listeners would
// tear down the host notification for the others.
const hostSubscribeCounts = new Map<string, number>();

function hostSubscribeKey(serviceId: string | number, characteristicId: string | number): string {
  return `${String(serviceId).toLowerCase()}|${String(characteristicId).toLowerCase()}`;
}

export async function nativeGattSubscribe(
  serviceId: string | number,
  characteristicId: string | number,
  cb: (data: Uint8Array) => void,
): Promise<() => void> {
  // Attach the local listener immediately so notifications that arrive before
  // the host's subscribe reply (and any added while a sibling subscribe is
  // still pending) are delivered rather than dropped.
  const unsubLocal = addNativeGattListener(serviceId, characteristicId, cb);
  const key = hostSubscribeKey(serviceId, characteristicId);
  const prevCount = hostSubscribeCounts.get(key) ?? 0;
  hostSubscribeCounts.set(key, prevCount + 1);
  if (prevCount === 0) {
    // 0->1 transition: this is the first listener for the characteristic, so
    // ask the host to start delivering notifications.
    try {
      await sendNative<void>('gattSubscribe', { serviceId, characteristicId });
    } catch (err) {
      unsubLocal();
      const count = hostSubscribeCounts.get(key) ?? 0;
      if (count <= 1) hostSubscribeCounts.delete(key);
      else hostSubscribeCounts.set(key, count - 1);
      throw err;
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unsubLocal();
    const count = hostSubscribeCounts.get(key) ?? 0;
    if (count <= 1) {
      // 1->0 transition: last listener gone, tell the host to stop.
      hostSubscribeCounts.delete(key);
      void sendNative<void>('gattUnsubscribe', { serviceId, characteristicId }).catch(() => { /* ignore */ });
    } else {
      hostSubscribeCounts.set(key, count - 1);
    }
  };
}

// ---- Auto-reconnect daemon -------------------------------------------------
//
// The native host (Android BridgeBleSession / future iOS counterpart) emits
// a `state, status: 'disconnected'` event when the BLE GATT drops — typical
// causes: mini restart, brief out-of-range, post-flash reboot. Without an
// auto-retry the widget would stick at "über App – warte auf Calliope"
// until the user manually clicked Verbinden, even though the host app is
// often already showing the device as available again. This daemon does
// the equivalent of `reconnect-daemon.ts` for the native-proxy backend.
//
// Differences from the web daemon:
//   - no `bleHasPermission` gate — the host owns the pairing record
//   - BLE only; native proxy never uses USB
//   - first-boot connect failures (no device paired yet) are NOT retried;
//     we only re-arm after a session that was previously up.

const RECONNECT_BACKOFF_MS = [3_000, 5_000, 10_000, 20_000, 30_000];
const RECONNECT_STEADY_MS = 30_000;

let reconnectInstalled = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let reconnectGeneration = 0;
let prevBleStatus = 'unknown';
let hadConnected = false;

function stopReconnect(reason: string): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  reconnectGeneration += 1;
  if (reason) appendLog({ direction: 'info', text: `native reconnect daemon stopped: ${reason}` });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = reconnectAttempt < RECONNECT_BACKOFF_MS.length
    ? RECONNECT_BACKOFF_MS[reconnectAttempt]
    : RECONNECT_STEADY_MS;
  const myGen = reconnectGeneration;
  appendLog({
    direction: 'info',
    text: `native reconnect attempt #${reconnectAttempt + 1} in ${delay}ms`,
  });
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (myGen !== reconnectGeneration) return;
    const s = getState();
    if (s.userDisconnectedBle) {
      stopReconnect('user disconnected');
      return;
    }
    if (s.bleStatus === 'connected' || s.bleStatus === 'connecting') return;
    try {
      await nativeConnect('ble');
    } catch { /* surfaced via state */ }
    if (myGen !== reconnectGeneration) return;
    // If we're still not connected, queue the next backoff step.
    const after = getState();
    if (after.bleStatus !== 'connected' && !after.userDisconnectedBle) {
      reconnectAttempt += 1;
      scheduleReconnect();
    }
  }, delay);
}

/**
 * Arm the auto-reconnect listener. Idempotent — call from
 * `initializeCalliopeConnection` after the bridge has been detected.
 */
export function installNativeReconnectDaemon(): void {
  if (reconnectInstalled) return;
  reconnectInstalled = true;
  calliopeState.subscribe((s) => {
    // Edge: previously-connected session just dropped. The host will
    // bring it back when the mini re-advertises; we keep retrying so the
    // widget catches up.
    if (
      prevBleStatus === 'connected' &&
      s.bleStatus !== 'connected' &&
      s.bleStatus !== 'connecting'
    ) {
      hadConnected = true;
    }
    // First-ever connect: mark steady so future drops trigger retries.
    if (s.bleStatus === 'connected') hadConnected = true;

    if (hadConnected && s.bleStatus !== 'connected' && s.bleStatus !== 'connecting' && !s.userDisconnectedBle) {
      scheduleReconnect();
    }
    if (s.bleStatus === 'connected') stopReconnect('connected');
    if (s.userDisconnectedBle) stopReconnect('user disconnected');
    prevBleStatus = s.bleStatus;
  });
}
