/**
 * Native-mode replacements for the widget's command surface.
 *
 * These are no-ops in web mode — `connect.ts`, `flash.ts`, `serial.ts` and
 * the GATT helpers consult `isNativeMode()` and short-circuit here instead
 * of touching `@microbit/microbit-connection`. The native host pushes state
 * updates back via `installNativeApi()`.
 */

import { sendNative, addNativeGattListener } from './native-bridge';
import { updateState, getState, type CalliopeTransport } from './state';
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
export async function nativeFlash(hex: string, name: string): Promise<void> {
  const s = getState();
  if (s.flashInProgress) {
    appendLog({
      direction: 'info',
      text: `Flash bereits aktiv — zusätzlicher Versuch ignoriert (${name}).`,
    });
    return;
  }
  updateState((st) => ({ ...st, flashInProgress: true, lastFlashName: name }));
  try {
    await sendNative<void>('flash', { hex, name });
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

export async function nativeGattSubscribe(
  serviceId: string | number,
  characteristicId: string | number,
  cb: (data: Uint8Array) => void,
): Promise<() => void> {
  const unsubLocal = addNativeGattListener(serviceId, characteristicId, cb);
  try {
    await sendNative<void>('gattSubscribe', { serviceId, characteristicId });
  } catch (err) {
    unsubLocal();
    throw err;
  }
  return () => {
    unsubLocal();
    void sendNative<void>('gattUnsubscribe', { serviceId, characteristicId }).catch(() => { /* ignore */ });
  };
}
