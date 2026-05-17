/**
 * Heuristic log-line parser.
 *
 * Inputs are single lines from a serial stream (USB or BLE UART). The parser
 * keeps a running "active header" so a sequence like
 *
 *     Time,Temperature,Light
 *     0.0,22,57
 *     0.2,22,58
 *
 * is recognised as a header followed by aligned data rows, regardless of
 * which separator the user picked. Three shapes are detected:
 *
 *   1. Delimited header: a line of non-numeric tokens separated by comma,
 *      tab or semicolon. e.g. `Time,Temperature,Light`.
 *   2. Delimited row:    numeric tokens with the same separator and column
 *      count as the active header. e.g. `0.2,22,58`.
 *   3. Key=value row:    tokens of `key=value` or `key:value` separated by
 *      space, comma or semicolon. Each row stands alone (no header).
 *
 * MicroBitLog format is covered by #1 and #2 — CODAL emits tab-separated
 * rows starting with a header.
 *
 * Lines that don't match any shape return `null` (treated as prose / REPL
 * output / banner text).
 */

export type ParsedSeparator = ',' | '\t' | ';';

export interface ParsedHeader {
  type: 'header';
  columns: string[];
  separator: ParsedSeparator;
}

export interface ParsedRow {
  type: 'row';
  /** Same length as the active header's `columns`. */
  values: (number | string)[];
  /** Active header columns (or synthetic `col1`, `col2`, ... if no header was seen). */
  columns: string[];
}

export type Parsed = ParsedHeader | ParsedRow;

const SEPARATORS: ParsedSeparator[] = [',', '\t', ';'];

function tryNumber(token: string): number | string {
  const t = token.trim();
  if (t === '') return t;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

/** True when token doesn't parse as a finite number. */
function isNonNumeric(token: string): boolean {
  const t = token.trim();
  if (t === '') return true;
  return !Number.isFinite(Number(t));
}

function bestSeparator(line: string): ParsedSeparator | null {
  let best: ParsedSeparator | null = null;
  let bestCount = 0;
  for (const sep of SEPARATORS) {
    const c = line.split(sep).length - 1;
    if (c >= 1 && c > bestCount) {
      best = sep;
      bestCount = c;
    }
  }
  return best;
}

/** Split on whitespace/comma/semicolon and require every token to look like
 *  `key=value` or `key:value`. Returns the pairs or null. */
function parseKeyValue(line: string): { key: string; value: number | string }[] | null {
  const tokens = line.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length < 1) return null;
  const pairs: { key: string; value: number | string }[] = [];
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    const co = tok.indexOf(':');
    const sep = eq >= 0 ? eq : co;
    if (sep <= 0 || sep === tok.length - 1) return null;
    const key = tok.slice(0, sep).trim();
    const val = tok.slice(sep + 1).trim();
    if (!key || /\s/.test(key)) return null;
    pairs.push({ key, value: tryNumber(val) });
  }
  return pairs.length ? pairs : null;
}

export class LogParser {
  private columns: string[] | null = null;
  private separator: ParsedSeparator | null = null;
  /** True when columns were synthesized from a numeric row without a prior header. */
  private syntheticColumns = false;

  reset(): void {
    this.columns = null;
    this.separator = null;
    this.syntheticColumns = false;
  }

  feed(line: string): Parsed | null {
    if (!line) return null;

    // 1. Key=value: every token must be `k=v`/`k:v`. Stands alone, no header memory.
    const kv = parseKeyValue(line);
    if (kv) {
      return {
        type: 'row',
        columns: kv.map((p) => p.key),
        values: kv.map((p) => p.value),
      };
    }

    // 2. Delimited line: pick the separator with the most splits.
    const sep = bestSeparator(line);
    if (!sep) return null;
    const tokens = line.split(sep).map((t) => t.trim());
    if (tokens.length < 2) return null;

    const nonNumericCount = tokens.filter(isNonNumeric).length;
    const allNumeric = nonNumericCount === 0;
    const allNonNumeric = nonNumericCount === tokens.length;

    // Header: every token non-numeric.
    if (allNonNumeric) {
      this.columns = tokens.filter((t) => t.length > 0);
      this.separator = sep;
      this.syntheticColumns = false;
      return {
        type: 'header',
        columns: this.columns,
        separator: sep,
      };
    }

    // Data row that matches the active header.
    if (
      allNumeric &&
      this.columns &&
      this.separator === sep &&
      tokens.length === this.columns.length
    ) {
      return {
        type: 'row',
        columns: this.columns,
        values: tokens.map(tryNumber),
      };
    }

    // Data row before any header: synthesize one and accept further numeric
    // rows with the same shape.
    if (allNumeric && !this.columns) {
      this.columns = tokens.map((_, i) => `col${i + 1}`);
      this.separator = sep;
      this.syntheticColumns = true;
      return {
        type: 'row',
        columns: this.columns,
        values: tokens.map(tryNumber),
      };
    }

    return null;
  }
}
