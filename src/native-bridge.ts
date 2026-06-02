/**
 * Native-proxy bridge.
 *
 * When the widget is loaded inside an iOS (WKWebView) or Android (System
 * WebView) host that injects a JS bridge, this module owns the boundary:
 * detection, JSON envelope, request-id routing, and incoming-event dispatch
 * back into the widget's existing stores via `updateState()` / `appendLog()`.
 *
 * The widget's public API (`connectCalliope`, `flashCalliope`, …) stays
 * unchanged — callers in `connect.ts`, `flash.ts`, `serial.ts`, plus the
 * native-GATT helpers, short-circuit to `sendNative(...)` whenever
 * `isNativeMode()` returns true. Web mode is the default and matches the
 * existing behavior bit-for-bit.
 *
 * Protocol — identical on both platforms:
 *
 *   Web → Native:  { id, op, args }
 *   Native → Web:  { id?, type: 'reply' | 'event', kind, data }
 *
 *   - replies match a pending `id`; resolve/reject the corresponding promise.
 *   - events have no `id`; dispatched by `kind`:
 *       state         → partial CalliopeState patch
 *       flashProgress → { transport, phase, progress }
 *       gattNotify    → { serviceId, characteristicId, data (base64) }
 *       serialData    → { data (base64) }
 *       log           → { direction, text }
 *       error         → { message, op? }
 *
 * Binary data (hex, gatt payloads, serial) crosses the bridge as base64.
 */

import { updateState, NATIVE_MODE, type CalliopeState, type CalliopeFlashPhase, type CalliopeTransport } from './state';
import { appendLog } from './log';

// ---- Detection -------------------------------------------------------------

interface AndroidBridge {
  /** Single entrypoint: native side receives a JSON envelope as a string. */
  postMessage(envelope: string): void;
}

interface IosBridgeHandler {
  postMessage(envelope: unknown): void;
}

interface BridgeWindow {
  CalliopeNative?: AndroidBridge;
  webkit?: { messageHandlers?: { calliope?: IosBridgeHandler } };
  __calliopeNative?: NativeApi;
}

function getBridge(): AndroidBridge | IosBridgeHandler | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as BridgeWindow;
  if (w.CalliopeNative && typeof w.CalliopeNative.postMessage === 'function') {
    return w.CalliopeNative;
  }
  const ios = w.webkit?.messageHandlers?.calliope;
  if (ios && typeof ios.postMessage === 'function') return ios;
  return null;
}

// Resolve the bridge handle eagerly. The detection result is captured once
// at module load by `state.ts` (NATIVE_MODE) — re-running detection here
// would risk drift if the host injects the bridge later.
const bridgeRef: AndroidBridge | IosBridgeHandler | null = NATIVE_MODE ? getBridge() : null;

export function isNativeMode(): boolean {
  return bridgeRef !== null;
}

// ---- Request / reply plumbing ---------------------------------------------

interface PendingReply {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  /** Per-request timeout so a dropped/forgotten host reply can't hang forever. */
  timer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingReply>();
let nextId = 0;

function makeId(): string {
  nextId = (nextId + 1) >>> 0;
  return `c${nextId}_${Date.now().toString(36)}`;
}

/**
 * Send a command to the native host. Resolves with the host's reply data,
 * or rejects on `error`. Falls back to a rejected promise if no bridge is
 * attached so callers can detect "wrong mode" rather than hang.
 */
export function sendNative<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isNativeMode() || !bridgeRef) {
    return Promise.reject(new Error(`native bridge not attached (op=${op})`));
  }
  const id = makeId();
  const envelope = JSON.stringify({ id, op, args });
  // Without a timeout a dropped/forgotten host reply hangs the caller forever:
  // nativeConnect stuck 'connecting' (daemon never re-arms), nativeFlash stuck
  // flashInProgress (gates serial + all future flashes), nativeGattRead/
  // Subscribe never settling. On iOS postMessage returns void and never throws,
  // so the catch below cannot cover a silently-dropped message. DFU is slow, so
  // give 'flash' a longer budget.
  const timeoutMs = op === 'flash' ? 180_000 : 30_000;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error(`native ${op} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
    try {
      // Android wants a string; iOS WKScriptMessageHandler accepts JSON-typed
      // objects but the string form works for both and keeps the envelope
      // identical.
      (bridgeRef as AndroidBridge).postMessage(envelope);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---- Incoming dispatch -----------------------------------------------------

type GattListener = (data: Uint8Array) => void;
const gattListeners = new Map<string, Set<GattListener>>();

function gattKey(serviceId: string | number, characteristicId: string | number): string {
  return `${String(serviceId).toLowerCase()}|${String(characteristicId).toLowerCase()}`;
}

export function addNativeGattListener(
  serviceId: string | number,
  characteristicId: string | number,
  cb: GattListener,
): () => void {
  const key = gattKey(serviceId, characteristicId);
  let set = gattListeners.get(key);
  if (!set) { set = new Set(); gattListeners.set(key, set); }
  set.add(cb);
  return () => {
    const cur = gattListeners.get(key);
    if (!cur) return;
    cur.delete(cb);
    if (cur.size === 0) gattListeners.delete(key);
  };
}

type SerialListener = (chunk: string) => void;
const serialListeners = new Set<SerialListener>();

export function addNativeSerialListener(cb: SerialListener): () => void {
  serialListeners.add(cb);
  return () => { serialListeners.delete(cb); };
}

function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function base64ToString(b64: string): string {
  const bytes = base64ToBytes(b64);
  // Latin-1 decode matches the widget's USB serial path so binary frames
  // (Blocks 0xFF SFD) survive intact.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

interface StateEventData {
  transport?: CalliopeTransport;
  status?: CalliopeState['usbStatus'];
  deviceName?: string;
  errorMessage?: string;
  friendlyName?: string;
  boardVersion?: CalliopeState['boardVersion'];
  calliopeVersion?: CalliopeState['calliopeVersion'];
  bleCanFlash?: boolean;
  bleCanCommunicate?: boolean;
  bleHasPermission?: boolean;
}

interface FlashProgressEventData {
  transport?: CalliopeTransport;
  phase?: CalliopeFlashPhase;
  progress?: number;
  partial?: boolean;
}

interface GattNotifyEventData {
  serviceId: string | number;
  characteristicId: string | number;
  data: string;
}

interface SerialDataEventData {
  data: string;
}

interface LogEventData {
  direction?: 'tx' | 'rx' | 'info' | 'error';
  text: string;
}

interface ErrorEventData {
  message: string;
  op?: string;
}

interface NativeMessage {
  id?: string;
  type: 'reply' | 'event';
  kind?: string;
  data?: unknown;
  error?: string;
}

interface NativeApi {
  onMessage: (envelope: string | NativeMessage) => void;
}

function applyStateEvent(d: StateEventData): void {
  updateState((s) => {
    const next = { ...s };
    if (d.transport === 'usb') {
      if (d.status !== undefined) next.usbStatus = d.status;
      if (d.deviceName !== undefined) next.usbDeviceName = d.deviceName;
      if (d.errorMessage !== undefined) next.usbErrorMessage = d.errorMessage || undefined;
      if (d.status === 'connected') next.userDisconnectedUsb = false;
    } else if (d.transport === 'ble') {
      if (d.status !== undefined) next.bleStatus = d.status;
      if (d.deviceName !== undefined) next.bleDeviceName = d.deviceName;
      if (d.errorMessage !== undefined) next.bleErrorMessage = d.errorMessage || undefined;
      if (d.bleCanFlash !== undefined) next.bleCanFlash = d.bleCanFlash;
      if (d.bleCanCommunicate !== undefined) next.bleCanCommunicate = d.bleCanCommunicate;
      if (d.bleHasPermission !== undefined) next.bleHasPermission = d.bleHasPermission;
      if (d.status === 'connected') next.userDisconnectedBle = false;
    }
    if (d.friendlyName !== undefined) next.friendlyName = d.friendlyName || undefined;
    if (d.boardVersion !== undefined) next.boardVersion = d.boardVersion;
    if (d.calliopeVersion !== undefined) next.calliopeVersion = d.calliopeVersion;
    return next;
  });
}

function applyFlashProgressEvent(d: FlashProgressEventData): void {
  updateState((s) => ({
    ...s,
    flashTransport: d.transport ?? s.flashTransport,
    flashPhase: d.phase ?? s.flashPhase,
    flashProgress: d.progress ?? s.flashProgress,
    flashPartial: d.partial ?? s.flashPartial,
  }));
}

function clearFlashState(): void {
  updateState((s) => ({
    ...s,
    flashTransport: undefined,
    flashPhase: undefined,
    flashProgress: undefined,
    // Bump `lastFlashAt` so the program-type auto-refresh re-probes the
    // freshly-flashed program. `nativeFlash` only sets this when its reply
    // resolves; the `flashDone` event can arrive first (or the reply can be
    // lost), so anchoring the re-probe on flash completion here makes the
    // program-type subscription independent of reply timing. Also clear
    // `flashInProgress` — its true→false edge is the re-probe trigger.
    flashInProgress: false,
    lastFlashAt: Date.now(),
  }));
}

function dispatchEvent(kind: string, data: unknown): void {
  switch (kind) {
    case 'state':
      applyStateEvent((data ?? {}) as StateEventData);
      return;
    case 'flashProgress':
      applyFlashProgressEvent((data ?? {}) as FlashProgressEventData);
      return;
    case 'flashDone':
      clearFlashState();
      return;
    case 'gattNotify': {
      const d = data as GattNotifyEventData;
      if (!d) return;
      const subs = gattListeners.get(gattKey(d.serviceId, d.characteristicId));
      if (!subs || subs.size === 0) return;
      const bytes = base64ToBytes(d.data || '');
      for (const cb of subs) {
        try { cb(bytes); } catch { /* ignore listener error */ }
      }
      return;
    }
    case 'serialData': {
      const d = data as SerialDataEventData;
      if (!d?.data) return;
      const chunk = base64ToString(d.data);
      for (const cb of serialListeners) {
        try { cb(chunk); } catch { /* ignore */ }
      }
      return;
    }
    case 'log': {
      const d = data as LogEventData;
      if (!d?.text) return;
      appendLog({ direction: d.direction ?? 'info', text: d.text });
      return;
    }
    case 'error': {
      const d = data as ErrorEventData;
      if (d?.message) appendLog({ direction: 'error', text: `[native] ${d.message}` });
      return;
    }
    default:
      // Unknown event kinds are ignored so the bridge protocol can evolve
      // without breaking older widgets.
      return;
  }
}

function handleMessage(envelope: string | NativeMessage): void {
  let msg: NativeMessage;
  try {
    msg = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  } catch (err) {
    appendLog({ direction: 'error', text: `native bridge: malformed envelope (${(err as Error)?.message ?? err})` });
    return;
  }
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'reply') {
    if (!msg.id) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (slot.timer) clearTimeout(slot.timer);
    if (msg.error) slot.reject(new Error(msg.error));
    else slot.resolve(msg.data);
    return;
  }
  if (msg.type === 'event' && msg.kind) {
    dispatchEvent(msg.kind, msg.data);
  }
}

/**
 * Install `window.__calliopeNative` so the native host can deliver events
 * via a single `evaluateJavaScript("window.__calliopeNative.onMessage(...)")`
 * call. Idempotent — calling more than once leaves the original installed.
 */
export function installNativeApi(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as BridgeWindow;
  if (w.__calliopeNative) return;
  w.__calliopeNative = { onMessage: handleMessage };
}
