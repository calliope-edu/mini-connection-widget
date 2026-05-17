/**
 * Bridge between an embedded scratch-vm (iframe) and the connected Calliope.
 *
 * scratch-vm's CalliopeRemote (src/io/calliopeRemote.js) posts BLE-style
 * read/write/subscribe messages to its parent window. This module listens
 * for those messages and forwards them to whichever transport is live —
 * USB first (lower latency, no GATT MTU dance), BLE GATT otherwise. For
 * USB the writes are wrapped in MbitMore serial frames (see mbitmore.ts);
 * over BLE we pass the bytes straight through to the matching characteristic.
 *
 * Outbound notifications (BLE notifies, USB NOTIFY frames) are posted back
 * to the originating iframe as `calliope.notify` / `calliope.readResult`.
 *
 * Wire protocol is documented at the top of
 * `scratch-vm/src/io/calliopeRemote.js`.
 */

import { ConnectionStatus } from '@microbit/microbit-connection';
import { getConnectedBleDevice } from './ble';
import { getUsbConn } from './usb';
import {
  MBIT_MORE_SERVICE_UUID,
  MM_REQ,
  MM_RES,
  buildMbitMoreFrame,
  channelName,
  characteristicToChannel,
  onMbitMoreFrameFromUsb,
  sendMbitMoreFrameOverUsb,
} from './mbitmore';
import { appendLog } from './log';
import { getState, updateState } from './state';
import { classifyBleError, isExpectedRebootWindow } from './connection-errors';
import { showBlePairingInfo } from './pairing-info';
import { pushProxy } from './comms';

const SCRATCH_VM_SOURCE = 'calliope-scratch-vm';

interface ReplyTarget {
  source: MessageEventSource;
  origin: string;
}

interface ScratchMessageBase {
  source: string;
  type: string;
}

interface WriteMsg extends ScratchMessageBase {
  type: 'calliope.write';
  serviceId: string | number;
  characteristicId: string | number;
  message: string;
  encoding?: string | null;
  withResponse?: boolean | null;
}

interface ReadMsg extends ScratchMessageBase {
  type: 'calliope.read';
  serviceId: string | number;
  characteristicId: string | number;
  reqId: number;
}

interface SubscribeMsg extends ScratchMessageBase {
  type: 'calliope.subscribe';
  serviceId: string | number;
  characteristicId: string | number;
}

interface UnsubscribeMsg extends ScratchMessageBase {
  type: 'calliope.unsubscribe';
  serviceId: string | number;
  characteristicId: string | number;
}

let initialized = false;

// Per-characteristic BLE subscription state, keyed by `${origin}|${charId}`.
const bleSubscriptions = new Map<string, {
  ch: BluetoothRemoteGATTCharacteristic;
  handler: (ev: Event) => void;
  origins: Set<string>;
  targets: Set<ReplyTarget>;
}>();

// USB-side state: one shared frame listener, plus per-channel pending reads
// and subscription targets.
let usbUnsub: (() => void) | null = null;
const usbReadWaiters = new Map<number, ReplyTarget & { reqId: number }>();
const usbSubscribers = new Map<number, Set<ReplyTarget>>();

/**
 * Format an MbitMore characteristic id + payload for a comms-panel entry.
 * Same shape as `mbitmore.ts#formatBytes` but inlined to keep `mbitmore` a
 * leaf module (it can't import from `scratch-bridge` for layering reasons).
 */
function formatBytesShort(u8: Uint8Array, maxBytes = 32): string {
  if (u8.length === 0) return '';
  const slice = u8.subarray(0, maxBytes);
  let out = '';
  for (let i = 0; i < slice.length; i++) {
    if (i > 0) out += ' ';
    out += slice[i].toString(16).padStart(2, '0').toUpperCase();
  }
  if (u8.length > maxBytes) out += ` …(+${u8.length - maxBytes})`;
  return out;
}

function describeChannel(charId: string | number): string {
  const channel = characteristicToChannel(charId);
  return `ch=0x${channel.toString(16).padStart(4, '0')} (${channelName(channel)})`;
}

function uint8ToBase64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

function decodeMessage(message: string, encoding: string | null | undefined): Uint8Array {
  if (encoding && encoding !== 'base64') {
    return new TextEncoder().encode(message);
  }
  const raw = atob(message);
  const u8 = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
  return u8;
}

function postReply(target: ReplyTarget, payload: unknown): void {
  try {
    (target.source as Window).postMessage(payload, target.origin || '*');
  } catch (e) {
    appendLog({ direction: 'info', text: `scratch-bridge postReply failed: ${(e as Error)?.message ?? e}` });
  }
}

function isUsbActive(): boolean {
  const usb = getUsbConn();
  return !!(usb && usb.status === ConnectionStatus.Connected);
}

/**
 * Route a BLE-side GATT failure through the classifier so a stale bond
 * doesn't just silently nuke the Scratch session — the user sees the same
 * pairing-info modal they'd get from any other BLE error path.
 */
function reportScratchBleFailure(e: unknown, where: string): void {
  // Expected churn during a flash-induced reboot — keep quiet.
  if (isExpectedRebootWindow()) {
    appendLog({ direction: 'info', text: `scratch-bridge ${where} (expected reboot): ${(e as Error)?.message ?? e}` });
    return;
  }
  const classified = classifyBleError(e, getState().bleHasPaired);
  if (classified.kind === 'stale-bond' || classified.kind === 'pairing-missing') {
    updateState((s) => ({
      ...s,
      bleStaleBond: classified.staleBond || s.bleStaleBond,
      bleErrorMessage: classified.userMessage,
    }));
    if (classified.showPairingModal) showBlePairingInfo();
  }
  appendLog({ direction: 'info', text: `scratch-bridge ${where}: ${(e as Error)?.message ?? e}` });
}

async function getMbitMoreCharacteristic(
  charId: string | number,
): Promise<BluetoothRemoteGATTCharacteristic | null> {
  const device = await getConnectedBleDevice();
  if (!device?.gatt?.connected) return null;
  try {
    const service = await device.gatt.getPrimaryService(MBIT_MORE_SERVICE_UUID);
    const lookup = typeof charId === 'string' ? charId.toLowerCase() : charId;
    return await service.getCharacteristic(lookup as BluetoothCharacteristicUUID);
  } catch (e) {
    reportScratchBleFailure(e, 'getCharacteristic');
    return null;
  }
}

// ---- USB inbound frame handler --------------------------------------------

function ensureUsbFrameListener(): void {
  if (usbUnsub) return;
  usbUnsub = onMbitMoreFrameFromUsb((frame) => {
    if (frame.type === MM_RES.READ) {
      const waiter = usbReadWaiters.get(frame.channel);
      if (waiter) {
        usbReadWaiters.delete(frame.channel);
        postReply(waiter, {
          type: 'calliope.readResult',
          reqId: waiter.reqId,
          message: uint8ToBase64(frame.data),
          encoding: 'base64',
        });
      }
      return;
    }
    if (frame.type === MM_RES.NOTIFY) {
      const subs = usbSubscribers.get(frame.channel);
      if (!subs) return;
      const b64 = uint8ToBase64(frame.data);
      for (const t of subs) {
        postReply(t, {
          type: 'calliope.notify',
          serviceId: MBIT_MORE_SERVICE_UUID,
          characteristicId: frame.channel,
          message: b64,
          encoding: 'base64',
        });
      }
    }
  });
}

function releaseUsbFrameListenerIfIdle(): void {
  if (usbReadWaiters.size === 0 && usbSubscribers.size === 0 && usbUnsub) {
    usbUnsub();
    usbUnsub = null;
  }
}

// ---- Message handlers ------------------------------------------------------

async function handleWrite(msg: WriteMsg, _target: ReplyTarget): Promise<void> {
  const bytes = decodeMessage(msg.message, msg.encoding ?? 'base64');
  // Iframe-level log: what did the blocks editor *ask* us to do, before any
  // transport-specific wrapping. Mirrors the user's mental model of "I sent
  // this from blocks" → "the device got that".
  const proxyTransport: 'usb' | 'ble' = isUsbActive() ? 'usb' : 'ble';
  pushProxy({
    direction: 'tx',
    transport: proxyTransport,
    kind: 'scratch',
    text: `WRITE ${describeChannel(msg.characteristicId)} bytes=${formatBytesShort(bytes)}${msg.withResponse ? ' withResponse' : ''}`,
  });
  if (isUsbActive()) {
    const channel = characteristicToChannel(msg.characteristicId);
    try {
      await sendMbitMoreFrameOverUsb(buildMbitMoreFrame(MM_REQ.WRITE, channel, bytes));
    } catch (e) {
      appendLog({ direction: 'info', text: `scratch-bridge USB write failed: ${(e as Error)?.message ?? e}` });
    }
    return;
  }
  const ch = await getMbitMoreCharacteristic(msg.characteristicId);
  if (!ch) return;
  try {
    if (msg.withResponse) {
      await ch.writeValueWithResponse(bytes);
    } else if (typeof (ch as { writeValueWithoutResponse?: unknown }).writeValueWithoutResponse === 'function') {
      await (ch as unknown as { writeValueWithoutResponse(b: BufferSource): Promise<void> }).writeValueWithoutResponse(bytes);
    } else {
      await ch.writeValue(bytes);
    }
  } catch (e) {
    reportScratchBleFailure(e, 'BLE write');
  }
}

async function handleRead(msg: ReadMsg, target: ReplyTarget): Promise<void> {
  pushProxy({
    direction: 'tx',
    transport: isUsbActive() ? 'usb' : 'ble',
    kind: 'scratch',
    text: `READ ${describeChannel(msg.characteristicId)} (reqId=${msg.reqId})`,
  });
  if (isUsbActive()) {
    ensureUsbFrameListener();
    const channel = characteristicToChannel(msg.characteristicId);
    usbReadWaiters.set(channel, { ...target, reqId: msg.reqId });
    try {
      await sendMbitMoreFrameOverUsb(buildMbitMoreFrame(MM_REQ.READ, channel));
    } catch (e) {
      usbReadWaiters.delete(channel);
      releaseUsbFrameListenerIfIdle();
      postReply(target, {
        type: 'calliope.readResult',
        reqId: msg.reqId,
        message: '',
        encoding: 'base64',
      });
      appendLog({ direction: 'info', text: `scratch-bridge USB read failed: ${(e as Error)?.message ?? e}` });
    }
    return;
  }
  const ch = await getMbitMoreCharacteristic(msg.characteristicId);
  if (!ch) {
    postReply(target, {
      type: 'calliope.readResult',
      reqId: msg.reqId,
      message: '',
      encoding: 'base64',
    });
    return;
  }
  try {
    const dv = await ch.readValue();
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    pushProxy({
      direction: 'rx',
      transport: 'ble',
      kind: 'gatt',
      text: `READ_RESULT ${describeChannel(msg.characteristicId)} bytes=${formatBytesShort(bytes)}`,
    });
    postReply(target, {
      type: 'calliope.readResult',
      reqId: msg.reqId,
      message: uint8ToBase64(bytes),
      encoding: 'base64',
    });
  } catch (e) {
    postReply(target, {
      type: 'calliope.readResult',
      reqId: msg.reqId,
      message: '',
      encoding: 'base64',
    });
    reportScratchBleFailure(e, 'BLE read');
  }
}

async function handleSubscribe(msg: SubscribeMsg, target: ReplyTarget): Promise<void> {
  pushProxy({
    direction: 'tx',
    transport: isUsbActive() ? 'usb' : 'ble',
    kind: 'scratch',
    text: `SUBSCRIBE ${describeChannel(msg.characteristicId)}`,
  });
  if (isUsbActive()) {
    ensureUsbFrameListener();
    const channel = characteristicToChannel(msg.characteristicId);
    let subs = usbSubscribers.get(channel);
    if (!subs) {
      subs = new Set();
      usbSubscribers.set(channel, subs);
    }
    subs.add(target);
    try {
      await sendMbitMoreFrameOverUsb(buildMbitMoreFrame(MM_REQ.NOTIFY_START, channel));
    } catch (e) {
      appendLog({ direction: 'info', text: `scratch-bridge USB subscribe failed: ${(e as Error)?.message ?? e}` });
    }
    return;
  }
  const key = `${target.origin}|${String(msg.characteristicId).toLowerCase()}`;
  const existing = bleSubscriptions.get(key);
  if (existing) {
    existing.targets.add(target);
    existing.origins.add(target.origin);
    return;
  }
  const ch = await getMbitMoreCharacteristic(msg.characteristicId);
  if (!ch) return;
  const targets = new Set<ReplyTarget>([target]);
  const handler = (ev: Event) => {
    const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!dv) return;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    pushProxy({
      direction: 'rx',
      transport: 'ble',
      kind: 'gatt',
      text: `NOTIFY ${describeChannel(msg.characteristicId)} bytes=${formatBytesShort(bytes)}`,
    });
    const b64 = uint8ToBase64(bytes);
    const entry = bleSubscriptions.get(key);
    if (!entry) return;
    for (const t of entry.targets) {
      postReply(t, {
        type: 'calliope.notify',
        serviceId: MBIT_MORE_SERVICE_UUID,
        characteristicId: msg.characteristicId,
        message: b64,
        encoding: 'base64',
      });
    }
  };
  ch.addEventListener('characteristicvaluechanged', handler);
  try {
    await ch.startNotifications();
  } catch (e) {
    ch.removeEventListener('characteristicvaluechanged', handler);
    reportScratchBleFailure(e, 'BLE subscribe');
    return;
  }
  bleSubscriptions.set(key, {
    ch,
    handler,
    origins: new Set([target.origin]),
    targets,
  });
}

async function handleUnsubscribe(msg: UnsubscribeMsg, target: ReplyTarget): Promise<void> {
  pushProxy({
    direction: 'tx',
    transport: isUsbActive() ? 'usb' : 'ble',
    kind: 'scratch',
    text: `UNSUBSCRIBE ${describeChannel(msg.characteristicId)}`,
  });
  if (isUsbActive()) {
    const channel = characteristicToChannel(msg.characteristicId);
    const subs = usbSubscribers.get(channel);
    if (subs) {
      for (const t of [...subs]) if (t.origin === target.origin) subs.delete(t);
      if (subs.size === 0) {
        usbSubscribers.delete(channel);
        try {
          await sendMbitMoreFrameOverUsb(buildMbitMoreFrame(MM_REQ.NOTIFY_STOP, channel));
        } catch { /* ignore */ }
      }
    }
    releaseUsbFrameListenerIfIdle();
    return;
  }
  const key = `${target.origin}|${String(msg.characteristicId).toLowerCase()}`;
  const entry = bleSubscriptions.get(key);
  if (!entry) return;
  for (const t of [...entry.targets]) if (t.origin === target.origin) entry.targets.delete(t);
  if (entry.targets.size === 0) {
    bleSubscriptions.delete(key);
    try { entry.ch.removeEventListener('characteristicvaluechanged', entry.handler); } catch { /* ignore */ }
    try { await entry.ch.stopNotifications(); } catch { /* ignore */ }
  }
}

// ---- Main dispatcher -------------------------------------------------------

function handleScratchMessage(event: MessageEvent): void {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if ((data as { source?: unknown }).source !== SCRATCH_VM_SOURCE) return;
  const type = (data as { type?: unknown }).type;
  if (typeof type !== 'string' || !type.startsWith('calliope.')) return;
  if (!event.source) return;
  const target: ReplyTarget = { source: event.source, origin: event.origin || '*' };
  void (async () => {
    try {
      switch (type) {
        case 'calliope.write':
          await handleWrite(data as WriteMsg, target);
          break;
        case 'calliope.read':
          await handleRead(data as ReadMsg, target);
          break;
        case 'calliope.subscribe':
          await handleSubscribe(data as SubscribeMsg, target);
          break;
        case 'calliope.unsubscribe':
          await handleUnsubscribe(data as UnsubscribeMsg, target);
          break;
      }
    } catch (e) {
      appendLog({ direction: 'info', text: `scratch-bridge dispatch threw: ${(e as Error)?.message ?? e}` });
    }
  })();
}

/**
 * Initialize the scratch-vm postMessage bridge. Listens on `window` for
 * messages from embedded scratch iframes and forwards each one to the
 * active Calliope transport (USB if connected, BLE GATT otherwise).
 * Idempotent.
 */
export function initScratchBridge(): void {
  if (initialized) return;
  initialized = true;
  if (typeof window === 'undefined') return;
  window.addEventListener('message', handleScratchMessage);
  appendLog({ direction: 'info', text: 'Scratch bridge initialized' });
}
