/**
 * Comms stream — a single timeline of everything sent to or received from
 * the connected Calliope mini, across USB and BLE.
 *
 * Three views consume this:
 *   - Stream: raw TX/RX timeline, ordered by time.
 *   - Rows:   detected log rows (CSV / key=value), parsed into columns.
 *   - Graph:  numeric columns of detected log rows, plotted live.
 *
 * The Stream view sees every entry; Rows/Graph only see entries whose
 * `parsed` field is populated by `log-parser.ts`. RX subscribers register
 * themselves via `addCommsRxFeed`; TX is pushed by the serial.ts /
 * bleSerialWrite call sites.
 */
import { writable, type Readable } from './store';
import { LogParser, type Parsed } from './log-parser';

export type CommsDirection = 'tx' | 'rx';
export type CommsTransport = 'usb' | 'ble';

export interface CommsEntry {
  id: number;
  time: number;
  direction: CommsDirection;
  transport: CommsTransport;
  /** Raw text payload. Newline-stripped for line entries, raw for chunk entries. */
  text: string;
  /** Populated when the line was identified as a CSV / key=value row or header. */
  parsed?: Parsed;
}

const COMMS_MAX = 1000;
let entryId = 0;

const _entries = writable<CommsEntry[]>([]);
const _paused = writable<boolean>(false);

/** All TX/RX events in time order. Ring-buffered to {@link COMMS_MAX}. */
export const commsEntries: Readable<CommsEntry[]> = { subscribe: _entries.subscribe };
export const commsPaused: Readable<boolean> = { subscribe: _paused.subscribe };

const parser = new LogParser();

/** Buffer partial RX chunks until we have a newline, then push line-by-line. */
const rxBuffers: Record<CommsTransport, string> = { usb: '', ble: '' };

function isPaused(): boolean {
  let v = false;
  const unsub = _paused.subscribe((p) => (v = p));
  unsub();
  return v;
}

function pushEntry(entry: Omit<CommsEntry, 'id' | 'time'>): void {
  if (isPaused()) return;
  _entries.update((arr) => {
    const next = arr.length >= COMMS_MAX ? arr.slice(arr.length - COMMS_MAX + 1) : arr.slice();
    next.push({ id: ++entryId, time: Date.now(), ...entry });
    return next;
  });
}

/** Record a transmission (campus → mini) on a given transport. */
export function pushTx(transport: CommsTransport, text: string): void {
  if (!text) return;
  pushEntry({ direction: 'tx', transport, text });
}

/** Record a received chunk. Chunks are split into lines and each line is parsed
 *  independently so the graph sees properly-bounded rows. */
export function pushRx(transport: CommsTransport, chunk: string): void {
  if (!chunk) return;
  const combined = rxBuffers[transport] + chunk;
  const parts = combined.split('\n');
  rxBuffers[transport] = parts.pop() ?? '';
  for (const part of parts) {
    const line = part.replace(/\r$/, '');
    if (!line) continue;
    const parsed = parser.feed(line) ?? undefined;
    pushEntry({ direction: 'rx', transport, text: line, parsed });
  }
}

export function clearComms(): void {
  _entries.set([]);
  rxBuffers.usb = '';
  rxBuffers.ble = '';
  parser.reset();
}

export function setCommsPaused(paused: boolean): void {
  _paused.set(paused);
}

/** Reset the parser's header memory — call when the device reboots or a new
 *  flash lands, so a fresh header can be picked up. */
export function resetCommsParser(): void {
  parser.reset();
  rxBuffers.usb = '';
  rxBuffers.ble = '';
}

/**
 * Wire the per-transport RX subscribers so every byte arriving from USB or
 * BLE lands in {@link commsEntries}. Idempotent. Called once from
 * `initializeCalliopeConnection`.
 */
let feedsAttached = false;
export function attachCommsFeeds(
  addBleRaw: (cb: (chunk: string) => void) => () => void,
  getUsb: () => { addEventListener(type: 'serialdata', cb: (ev: { data: string }) => void): void } | null,
): void {
  if (feedsAttached) return;
  feedsAttached = true;

  addBleRaw((chunk) => pushRx('ble', chunk));

  const usbHandler = (ev: { data: string }) => {
    if (ev.data) pushRx('usb', ev.data);
  };
  // USB conn may not exist yet on init — poll until it does, then attach
  // once. Subsequent reconnects reuse the same conn instance.
  const tryAttach = () => {
    const usb = getUsb();
    if (usb) {
      usb.addEventListener('serialdata', usbHandler);
      return;
    }
    setTimeout(tryAttach, 250);
  };
  tryAttach();
}
