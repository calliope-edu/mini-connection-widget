<script lang="ts">
  /**
   * Stream / Rows / Graph view of all serial + BLE traffic to the
   * Calliope mini. Sits beside ConnectionPanel inside host apps.
   *
   * Stream — every TX/RX line in time order, transport-tagged.
   * Rows   — entries the parser identified as a CSV header / data row
   *          or a key=value record, laid out as a table.
   * Graph  — numeric columns of detected data rows, sliding-window line
   *          chart drawn on a single 2D canvas (no external chart dep).
   *
   * calliope-ui `Tabs` switch the views, `IconButton`s pause and clear; every
   * colour (also the canvas strokes) comes from `--cui-*` tokens.
   */
  import { IconButton, Tab, TabList, TabPanel, Tabs } from '@calliope-edu/ui';
  import {
    commsEntries,
    commsPaused,
    clearComms,
    setCommsPaused,
    type CommsEntry,
  } from '../comms';
  import { connectLabels, labelParts, mergeLabels, type ConnectLabels } from './labels';
  import LabelText from './LabelText.svelte';

  type Props = {
    /** Translation overrides, passed down from the panel's `labels` prop. */
    labels?: Partial<ConnectLabels>;
  };
  let { labels: labelsProp }: Props = $props();
  const labels = $derived(mergeLabels(labelsProp, $connectLabels));

  // Code examples in the empty Rows / Graph placeholders.
  const LOG_EXAMPLES = { writeValue: 'serial.writeValue("Licht", x)', print: "print('x,y'); print('1,2')", mirror: 'datalogger.mirrorToSerial(true)' };
  const CODE_PARAMS = ['writeValue', 'print', 'mirror'] as const;

  // The open view: 'stream' | 'live' | 'rows' | 'graph' (a string, as Tabs binds it).
  let tab = $state<string>('stream');

  const entries = $derived($commsEntries);
  const paused = $derived($commsPaused);

  // COMMAND/STATE/MOTION/ANALOG poll + handshake reads are flagged `live` by the
  // blocks codec. They arrive ~every 50ms and drown out the meaningful
  // writes/notifications, so they're kept OUT of the Stream and shown in the
  // dedicated "Live" tab — which holds only the newest entry per channel,
  // updated in place (not a scrolling log).
  const liveEntries = $derived(entries.filter((e) => e.live));
  const streamEntries = $derived(entries.filter((e) => !e.live));
  const latestLive = $derived.by(() => {
    const byKey = new Map<string, CommsEntry>();
    for (const e of entries) {
      if (e.live && e.liveKey) byKey.set(e.liveKey, e); // last write wins
    }
    return Array.from(byKey.values()).sort((a, b) =>
      (a.liveKey ?? '').localeCompare(b.liveKey ?? ''));
  });

  // ---- Stream view ---------------------------------------------------------
  let streamEl: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);
  $effect(() => {
    // Re-run whenever the visible stream grows; honor user's pin-to-bottom toggle.
    streamEntries.length;
    if (autoScroll && streamEl) {
      streamEl.scrollTop = streamEl.scrollHeight;
    }
  });
  function onStreamScroll() {
    if (!streamEl) return;
    // Within 4px of the bottom counts as "still pinned".
    const bottom = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight;
    autoScroll = bottom < 4;
  }

  function fmtTime(t: number): string {
    const d = new Date(t);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  // ---- Rows view -----------------------------------------------------------
  /** Rows view models one logical table per parser-detected header. A new
   *  header starts a new table (so the user sees the column reset). */
  type TableModel = {
    columns: string[];
    rows: { time: number; values: (number | string)[] }[];
  };
  const tables = $derived.by<TableModel[]>(() => {
    const out: TableModel[] = [];
    // CSV/synthetic rows whose columns come from a header (or positional shape)
    // start a fresh table whenever the shape changes — unchanged behaviour.
    let csv: TableModel | null = null;
    // Self-describing labelled rows (key=value / single labelled value, e.g.
    // `Licht Serial:235`) all flow into ONE growing table whose columns are the
    // union of every label seen. Each row fills only the columns it carries;
    // missing cells stay empty. This keeps interleaved named series (USB vs BLE,
    // or several writeValue labels) in a single table that the graph can plot as
    // separate lines, instead of fragmenting into one-row tables.
    let labelled: TableModel | null = null;
    for (const e of entries) {
      if (!e.parsed) continue;
      if (e.parsed.type === 'header') {
        csv = { columns: e.parsed.columns, rows: [] };
        out.push(csv);
        continue;
      }
      // type === 'row' — bind to a local so narrowing survives the map closure.
      const row = e.parsed;
      if (row.labelled) {
        if (!labelled) {
          labelled = { columns: [], rows: [] };
          out.push(labelled);
        }
        // Grow the column union; pad existing rows for any newly-seen label so
        // every row stays aligned to `labelled.columns` (labels only append).
        for (const col of row.columns) {
          if (!labelled.columns.includes(col)) {
            labelled.columns.push(col);
            for (const r of labelled.rows) r.values.push('');
          }
        }
        const values = labelled.columns.map((col) => {
          const i = row.columns.indexOf(col);
          return i >= 0 ? row.values[i] : '';
        });
        labelled.rows.push({ time: e.time, values });
        continue;
      }
      if (!csv || !sameColumns(csv.columns, row.columns)) {
        csv = { columns: row.columns, rows: [] };
        out.push(csv);
      }
      csv.rows.push({ time: e.time, values: row.values });
    }
    return out;
  });
  function sameColumns(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function rowsToCsv(t: TableModel): string {
    const head = t.columns.join(',');
    const body = t.rows.map((r) => r.values.map(fmtCell).join(',')).join('\n');
    return `${head}\n${body}\n`;
  }
  function fmtCell(v: number | string): string {
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    // Quote if contains a comma, quote or newline.
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }
  function downloadCsv(t: TableModel) {
    const blob = new Blob([rowsToCsv(t)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `calliope-log-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Graph view ----------------------------------------------------------
  /**
   * Time-based, smoothie-style scrolling line chart. The x-axis is wall-clock
   * time over a sliding window; each detected numeric column becomes its own
   * series of (time, value) points and is drawn as a continuous line.
   *
   * Going per-series-over-time (rather than the old "one table, x = row index")
   * is what makes interleaved sources work: when `Licht Serial` (USB) and
   * `Licht BLE` (BLE) alternate, each label is a sparse column in one table —
   * by-row-index they never had two adjacent points, so no line ever drew.
   * By time, each series connects its own samples regardless of interleaving.
   */
  let canvas: HTMLCanvasElement | undefined = $state();
  /** calliope-ui's data-series slots; a series uses slot `i % 6 + 1`. */
  const SERIES_SLOTS = 6;
  const seriesVar = (slot: number) => `--cui-data-series-${slot}`;
  /** Width of the visible sliding window, in milliseconds. */
  const WINDOW_MS = 30_000;

  type Series = { name: string; slot: number; points: { t: number; v: number }[] };
  /** Graph follows the table that received the most recent row — i.e. whatever
   *  is actively streaming — so the live series is always what's shown. */
  const activeTable = $derived.by<TableModel | null>(() => {
    let best: TableModel | null = null;
    let bestT = -Infinity;
    for (const t of tables) {
      const last = t.rows[t.rows.length - 1];
      if (last && last.time >= bestT) { best = t; bestT = last.time; }
    }
    return best ?? (tables.length ? tables[tables.length - 1] : null);
  });
  /** One series per numeric column of the active table, as (time, value) points. */
  const series = $derived.by<Series[]>(() => {
    if (!activeTable) return [];
    const out: Series[] = [];
    for (let i = 0; i < activeTable.columns.length; i++) {
      const points: { t: number; v: number }[] = [];
      for (const r of activeTable.rows) {
        const v = r.values[i];
        if (typeof v === 'number' && Number.isFinite(v)) points.push({ t: r.time, v });
      }
      if (points.length) {
        out.push({ name: activeTable.columns[i], slot: (out.length % SERIES_SLOTS) + 1, points });
      }
    }
    return out;
  });
  let hidden = $state<Record<string, true>>({});
  function toggleCol(name: string) {
    hidden = { ...hidden, [name]: hidden[name] ? (undefined as unknown as true) : true };
    if (!hidden[name]) {
      const { [name]: _drop, ...rest } = hidden;
      hidden = rest as Record<string, true>;
    }
  }

  function fmtAxis(v: number): string {
    if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01)) return v.toExponential(1);
    return Number(v.toFixed(2)).toString();
  }

  function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w < 2 || h < 2) return;
    // Size the backing store to the (absolutely-positioned) element so layout
    // can't feed back into size — this is what stopped the panel from growing.
    const bw = Math.floor(w * dpr), bh = Math.floor(h * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Canvas strokes can't take var(); resolve the tokens on the element, so
    // the chart follows the host's light or dark theme like the rest.
    const css = getComputedStyle(canvas);
    const token = (name: string) => css.getPropertyValue(name).trim();
    const frameColor = token('--cui-border-strong');
    const gridColor = token('--cui-border-subtle');
    const textColor = token('--cui-text-muted');
    const font = token('--cui-typography-body-font-family') || 'sans-serif';

    const PADL = 38, PADR = 10, PADT = 8, PADB = 16;
    const innerW = Math.max(1, w - PADL - PADR);
    const innerH = Math.max(1, h - PADT - PADB);

    const tMax = Date.now();
    const tMin = tMax - WINDOW_MS;
    const vis = series.filter((s) => !hidden[s.name]);

    // Y range over visible points still relevant to the window (keep one sample
    // either side so a line entering/leaving the window scales sensibly).
    let yMin = Infinity, yMax = -Infinity;
    for (const s of vis) {
      for (const p of s.points) {
        if (p.t < tMin - WINDOW_MS) continue;
        if (p.v < yMin) yMin = p.v;
        if (p.v > yMax) yMax = p.v;
      }
    }

    // Plot frame.
    ctx.strokeStyle = frameColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(PADL, PADT, innerW, innerH);

    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      ctx.fillStyle = textColor;
      ctx.font = `12px ${font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(labels.commsGraphWaiting, PADL + 8, PADT + 18);
      return;
    }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.08;
    yMin -= pad; yMax += pad;

    const xOf = (t: number) => PADL + (innerW * (t - tMin)) / WINDOW_MS;
    const yOf = (v: number) => PADT + innerH * (1 - (v - yMin) / (yMax - yMin));

    // Horizontal grid + y labels.
    ctx.fillStyle = textColor;
    ctx.font = `10px ${font}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const yPx = PADT + (innerH * i) / 4;
      ctx.fillText(fmtAxis(yMax - ((yMax - yMin) * i) / 4), PADL - 4, yPx);
      if (i > 0 && i < 4) {
        ctx.strokeStyle = gridColor;
        ctx.beginPath();
        ctx.moveTo(PADL, yPx);
        ctx.lineTo(PADL + innerW, yPx);
        ctx.stroke();
      }
    }

    // Vertical grid every 5 s, scrolling with time.
    ctx.strokeStyle = gridColor;
    const STEP = 5000;
    for (let t = Math.ceil(tMin / STEP) * STEP; t <= tMax; t += STEP) {
      const x = xOf(t);
      ctx.beginPath();
      ctx.moveTo(x, PADT);
      ctx.lineTo(x, PADT + innerH);
      ctx.stroke();
    }
    // x-axis hint.
    ctx.fillStyle = textColor;
    ctx.font = `10px ${font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`−${WINDOW_MS / 1000}s`, PADL + 2, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText(labels.commsGraphNow, PADL + innerW, h - 2);

    // Clip to the plot rect so off-window line segments don't spill over axes.
    ctx.save();
    ctx.beginPath();
    ctx.rect(PADL, PADT, innerW, innerH);
    ctx.clip();
    for (const s of vis) {
      const color = token(seriesVar(s.slot));
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      let pen = false;
      for (const p of s.points) {
        if (p.t < tMin - WINDOW_MS) continue;
        const x = xOf(p.t), y = yOf(p.v);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
      // Sample markers — guarantee visibility even for a lone point.
      for (const p of s.points) {
        if (p.t < tMin || p.t > tMax) continue;
        ctx.beginPath();
        ctx.arc(xOf(p.t), yOf(p.v), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // Animate while the Graph tab is open: rAF scrolls the window smoothly and
  // redraws (also picks up resizes, since it reads clientWidth each frame).
  // Reads the latest `series`/`hidden` each frame — no per-data-point effect.
  let raf = 0;
  $effect(() => {
    if (tab !== 'graph' || !canvas) return;
    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  });

  // ---- Top bar -------------------------------------------------------------
  function entryClass(e: CommsEntry): string {
    return `entry entry-${e.direction} entry-${e.transport}`;
  }
  const rowCount = $derived(tables.reduce((n, t) => n + t.rows.length, 0));
</script>

<div class="comms">
  <Tabs bind:value={tab}>
    <div class="tabbar">
      <TabList label={labels.commsViews}>
        <Tab value="stream">{labels.commsStream} <span class="tab-count">{streamEntries.length}</span></Tab>
        <Tab value="rows">{labels.commsRows} <span class="tab-count">{rowCount}</span></Tab>
        <Tab value="graph">{labels.commsGraph}</Tab>
        <Tab value="live">
          <span
            class="live-dot"
            class:flowing={liveEntries.length > 0}
            title={labels.commsLiveTitle}
          ></span>
          {labels.commsLive} <span class="tab-count">{latestLive.length}</span>
        </Tab>
      </TabList>
      <div class="tools">
        <IconButton
          icon={paused ? 'play' : 'pause'}
          label={paused ? labels.commsResume : labels.commsPause}
          size="s"
          onclick={() => setCommsPaused(!paused)}
        />
        <IconButton icon="delete" label={labels.commsClear} size="s" onclick={() => clearComms()} />
      </div>
    </div>

    <TabPanel value="stream">
      {#if tab === 'stream'}
        <div class="stream" bind:this={streamEl} onscroll={onStreamScroll}>
          {#if streamEntries.length === 0}
            <div class="placeholder">
              {entries.length > 0 && liveEntries.length > 0
                ? labels.commsStreamLiveOnly
                : labels.commsStreamEmpty}
            </div>
          {/if}
          {#each streamEntries as e (e.id)}
            <div class={entryClass(e)}>
              <span class="t">{fmtTime(e.time)}</span>
              <span class="dir">{e.direction === 'tx' ? '↑' : '↓'}</span>
              <span class="tp">{e.transport.toUpperCase()}</span>
              <span class="text">
                {#if e.kind && e.kind !== 'serial'}
                  <span class="kind">{e.kind}</span>
                {/if}
                {e.text}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </TabPanel>

    <TabPanel value="live">
      {#if tab === 'live'}
        <div class="live-scroll">
          {#if latestLive.length === 0}
            <div class="placeholder">{labels.commsLiveEmpty}</div>
          {/if}
          {#each latestLive as e (e.liveKey)}
            <div class="live-row entry-{e.direction}">
              <span class="live-key">{e.liveKey}</span>
              <span class="tp">{e.transport.toUpperCase()}</span>
              <span class="t">{fmtTime(e.time)}</span>
              <span class="live-text">{e.text}</span>
            </div>
          {/each}
        </div>
      {/if}
    </TabPanel>

    <TabPanel value="rows">
      {#if tab === 'rows'}
        <div class="rows-scroll">
          {#if tables.length === 0}
            <div class="placeholder"><LabelText parts={labelParts(labels.commsRowsEmpty, LOG_EXAMPLES, CODE_PARAMS)} tag="code" /></div>
          {/if}
          {#each tables as t, ti (ti)}
            <div class="rows-card">
              <div class="rows-card-head">
                <strong>{labels.commsTable({ index: ti + 1 })}</strong>
                <span class="meta">{labels.commsTableSize({ rows: t.rows.length, columns: t.columns.length })}</span>
                <div class="spacer"></div>
                <IconButton
                  icon="download"
                  label={labels.commsCsv}
                  size="s"
                  disabled={t.rows.length === 0}
                  onclick={() => downloadCsv(t)}
                />
              </div>
              <div class="rows-table-wrap">
                <table class="rows-table">
                  <thead>
                    <tr><th class="c-time">{labels.commsTime}</th>{#each t.columns as col}<th>{col}</th>{/each}</tr>
                  </thead>
                  <tbody>
                    {#each t.rows.slice(-100) as r, ri (ri)}
                      <tr>
                        <td class="c-time">{fmtTime(r.time)}</td>
                        {#each r.values as v}
                          {#if v === '' || v === undefined || v === null}
                            <td class="c-val c-empty" title={labels.commsNoValue}>·</td>
                          {:else}
                            <td class="c-val" class:num={typeof v === 'number'}>{v}</td>
                          {/if}
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table>
                {#if t.rows.length > 100}
                  <div class="rows-truncated">{labels.commsTruncated({ shown: 100, total: t.rows.length })}</div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </TabPanel>

    <TabPanel value="graph">
      {#if tab === 'graph'}
        <div class="graph-wrap">
          {#if series.length === 0}
            <div class="placeholder"><LabelText parts={labelParts(labels.commsGraphEmpty, LOG_EXAMPLES, CODE_PARAMS)} tag="code" /></div>
          {:else}
            <div class="legend">
              {#each series as c (c.name)}
                <button
                  type="button"
                  class="legend-item"
                  aria-pressed={!hidden[c.name]}
                  onclick={() => toggleCol(c.name)}
                >
                  <span class="swatch" style:background-color="var({seriesVar(c.slot)})"></span>
                  <span class="name">{c.name}</span>
                </button>
              {/each}
            </div>
            <div class="graph-plot">
              <canvas bind:this={canvas} class="graph-canvas"></canvas>
            </div>
          {/if}
        </div>
      {/if}
    </TabPanel>
  </Tabs>
</div>

<style>
  .comms {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    height: 100%;
    min-height: 240px;
    overflow: hidden;
    border: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
    border-radius: var(--cui-radius-md);
    background-color: var(--cui-surface-default);
    color: var(--cui-text-default);
    font-family: var(--cui-typography-body-font-family);
    font-size: var(--cui-typography-label-font-size);
  }
  /* Tabs root and the active panel fill the box; the views scroll inside. */
  .comms > :global(.cui-tabs) {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .comms :global(.cui-tab-panel[data-state='active']) {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    padding-top: 0;
  }
  .tabbar {
    display: flex;
    align-items: center;
    gap: var(--cui-space-1);
    padding-right: var(--cui-space-1);
    box-shadow: inset 0 calc(-1 * var(--cui-border-width-hairline)) 0 var(--cui-border-subtle);
  }
  .tabbar > :global(.cui-tab-list) {
    flex: 1;
    min-width: 0;
  }
  .tabbar :global(.cui-tab) {
    gap: var(--cui-space-1);
    padding: 0 var(--cui-space-2);
  }
  .tools {
    display: flex;
    flex: none;
    gap: var(--cui-space-0-5);
  }
  .tab-count {
    padding: 0 var(--cui-space-1);
    border-radius: var(--cui-radius-full);
    background-color: var(--cui-surface-subtle);
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-caption-font-size);
    font-variant-numeric: tabular-nums;
  }
  .spacer {
    flex: 1;
  }

  .stream,
  .live-scroll {
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
    padding: var(--cui-space-1);
    font-family: var(--cui-typography-code-font-family);
    font-size: var(--cui-typography-caption-font-size);
    line-height: var(--cui-typography-code-line-height);
  }
  .placeholder {
    padding: var(--cui-space-4);
    color: var(--cui-text-muted);
    font-family: var(--cui-typography-body-font-family);
    font-style: italic;
  }
  .entry {
    display: grid;
    grid-template-columns: 96px 16px 36px 1fr;
    gap: var(--cui-space-1);
    padding: 0 var(--cui-space-1);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .entry:hover {
    background-color: var(--cui-action-hover);
  }
  .t {
    color: var(--cui-text-muted);
  }
  .entry .dir {
    font-weight: var(--cui-font-weight-bold);
    text-align: center;
  }
  /* Received lines in the link colour, sent ones in the body colour: the
     arrow says the direction, the colour only helps the eye. */
  .entry-rx .dir,
  .entry-rx .text,
  .live-row.entry-rx .live-text {
    color: var(--cui-text-link);
  }
  .tp {
    align-self: center;
    height: 1rem;
    border-radius: var(--cui-radius-sm);
    background-color: var(--cui-surface-subtle);
    color: var(--cui-text-muted);
    font-size: 0.625rem;
    line-height: 1rem;
    text-align: center;
  }
  .entry .kind {
    display: inline-block;
    margin-right: var(--cui-space-1);
    padding: 0 var(--cui-space-1);
    border: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
    border-radius: var(--cui-radius-sm);
    color: var(--cui-text-muted);
    font-size: 0.625rem;
    font-weight: var(--cui-font-weight-semibold);
    letter-spacing: var(--cui-font-tracking-caps);
    line-height: 0.875rem;
    text-transform: uppercase;
    vertical-align: 1px;
  }

  /* "Live" tab: a dot that pulses while STATE/MOTION/ANALOG polling flows. */
  .live-dot {
    display: inline-block;
    flex: none;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: var(--cui-radius-full);
    background-color: var(--cui-text-muted);
  }
  .live-dot.flowing {
    background-color: var(--cui-status-success-fill);
    animation: livePulse 1.1s ease-in-out infinite;
  }
  @keyframes livePulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.3; transform: scale(0.72); }
  }
  @media (prefers-reduced-motion: reduce) {
    .live-dot.flowing {
      animation: none;
    }
  }

  /* Live tab: one fixed row per channel, latest value updated in place. */
  .live-row {
    display: grid;
    grid-template-columns: 96px 36px 96px 1fr;
    align-items: baseline;
    gap: var(--cui-space-1);
    padding: var(--cui-space-0-5) var(--cui-space-1);
    border-bottom: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
  }
  .live-key {
    font-weight: var(--cui-font-weight-semibold);
  }
  .live-text {
    word-break: break-all;
  }

  .rows-scroll {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--cui-space-3);
    overflow-y: auto;
    padding: var(--cui-space-2);
  }
  .rows-card {
    overflow: hidden;
    border: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
    border-radius: var(--cui-radius-md);
  }
  .rows-card-head {
    display: flex;
    align-items: center;
    gap: var(--cui-space-2);
    padding: var(--cui-space-1) var(--cui-space-1) var(--cui-space-1) var(--cui-space-3);
    border-bottom: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
    background-color: var(--cui-surface-subtle);
  }
  .rows-card-head .meta {
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-caption-font-size);
  }
  .rows-table-wrap {
    overflow-x: auto;
  }
  /* Content-sized columns (not stretched to 100%) so values sit next to their
     header instead of drifting apart on a wide panel; the wrap scrolls
     horizontally when there are too many columns for the width. Light vertical
     rules + nowrap keep it readable when space is tight. */
  .rows-table {
    width: auto;
    border-collapse: collapse;
    font-size: var(--cui-typography-caption-font-size);
  }
  .rows-table th,
  .rows-table td {
    padding: var(--cui-space-0-5) var(--cui-space-3);
    border-right: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
    border-bottom: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
    text-align: left;
    vertical-align: top;
    white-space: nowrap;
  }
  .rows-table th:last-child,
  .rows-table td:last-child {
    border-right: 0;
  }
  .rows-table th {
    position: sticky;
    top: 0;
    background-color: var(--cui-surface-default);
    color: var(--cui-text-muted);
    font-weight: var(--cui-font-weight-semibold);
  }
  .rows-table td.c-val {
    min-width: 52px;
  }
  .rows-table td.c-val.num {
    font-family: var(--cui-typography-code-font-family);
    text-align: right;
  }
  .rows-table td.c-empty {
    color: var(--cui-text-muted);
    text-align: center;
  }
  .rows-table .c-time {
    color: var(--cui-text-muted);
    font-family: var(--cui-typography-code-font-family);
  }
  .rows-truncated {
    padding: var(--cui-space-1) var(--cui-space-3);
    background-color: var(--cui-surface-subtle);
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-caption-font-size);
  }

  .graph-wrap {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--cui-space-2);
    padding: var(--cui-space-2);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cui-space-1);
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: var(--cui-space-1);
    padding: var(--cui-space-0-5) var(--cui-space-2);
    border: var(--cui-border-width-hairline) solid var(--cui-border-control);
    border-radius: var(--cui-radius-full);
    background-color: var(--cui-surface-default);
    color: var(--cui-text-default);
    font: inherit;
    font-size: var(--cui-typography-caption-font-size);
    cursor: pointer;
  }
  .legend-item:hover {
    background-color: var(--cui-action-hover);
  }
  .legend-item[aria-pressed='false'] {
    opacity: 0.45;
  }
  .swatch {
    display: inline-block;
    width: 0.625rem;
    height: 0.625rem;
    border-radius: var(--cui-radius-sm);
  }
  /* The canvas is absolutely positioned inside a flex-sized box, so reading its
     size while drawing can never feed back into layout (which previously let the
     panel grow and scroll). The box owns the size; the canvas just fills it. */
  .graph-plot {
    position: relative;
    flex: 1;
    min-height: 200px;
  }
  .graph-canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
