import { writable, type Readable } from './store';

/**
 * Ring buffer of TX/RX/info/error messages. Repetitive serial traffic (per-frame
 * confidence updates) would scroll legitimate info/error events off the top
 * within a second, so consecutive same-kind tx/rx entries are merged: the row
 * shows the most recent payload prefixed with a `count` that increments each
 * time the same pattern repeats.
 */
export interface CalliopeLogEntry {
  /** Stable id for keyed renders — does not change when a row is merged. */
  id: number;
  /** Wall-clock time of the most recent occurrence in this group. */
  time: number;
  direction: 'tx' | 'rx' | 'info' | 'error';
  /** Most recent payload (for tx/rx) or the message itself (info/error). */
  text: string;
  /** How many same-kind messages have been merged into this row. ≥ 1. */
  count: number;
  /** Optional grouping tag. When set, a new entry with the same `kind`
   *  REPLACES the most recent entry instead of appending — used for streaming
   *  status (e.g. flash progress %) that would otherwise spam the log. */
  kind?: string;
}

const LOG_MAX = 200;
let logIdCounter = 0;
const _log = writable<CalliopeLogEntry[]>([]);
export const calliopeLog: Readable<CalliopeLogEntry[]> = { subscribe: _log.subscribe };

function messageKind(text: string): string {
  // First whitespace-delimited token. For protocol lines like "C 24 57 20"
  // this is just "C"; for "Connected (BLE)" it's "Connected".
  const idx = text.indexOf(' ');
  return idx < 0 ? text : text.slice(0, idx);
}

export function appendLog(entry: Omit<CalliopeLogEntry, 'time' | 'id' | 'count'>): void {
  _log.update((arr) => {
    const last = arr.length > 0 ? arr[arr.length - 1] : undefined;
    if (entry.kind && last && last.kind === entry.kind) {
      const next = arr.slice();
      next[next.length - 1] = {
        ...last,
        time: Date.now(),
        text: entry.text,
        direction: entry.direction,
      };
      return next;
    }
    const mergeable =
      !!last &&
      (entry.direction === 'tx' || entry.direction === 'rx') &&
      last.direction === entry.direction &&
      messageKind(last.text) === messageKind(entry.text);
    if (mergeable && last) {
      const next = arr.slice();
      next[next.length - 1] = {
        ...last,
        time: Date.now(),
        text: entry.text,
        count: last.count + 1,
      };
      return next;
    }
    const next = arr.length >= LOG_MAX ? arr.slice(arr.length - LOG_MAX + 1) : arr.slice();
    next.push({
      id: ++logIdCounter,
      time: Date.now(),
      count: 1,
      ...entry,
    });
    return next;
  });
}

export function clearCalliopeLog(): void {
  _log.set([]);
}
