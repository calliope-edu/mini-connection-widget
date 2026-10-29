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
   */
  import {
    commsEntries,
    commsPaused,
    clearComms,
    setCommsPaused,
    type CommsEntry,
  } from '../comms';

  type Tab = 'stream' | 'live' | 'rows' | 'graph';
  let tab: Tab = $state('stream');

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
  const PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2'];
  /** Width of the visible sliding window, in milliseconds. */
  const WINDOW_MS = 30_000;

  type Series = { name: string; color: string; points: { t: number; v: number }[] };
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
        out.push({ name: activeTable.columns[i], color: PALETTE[out.length % PALETTE.length], points });
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
    ctx.strokeStyle = '#d0d7de';
    ctx.lineWidth = 1;
    ctx.strokeRect(PADL, PADT, innerW, innerH);

    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      ctx.fillStyle = '#6e7781';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('Warte auf Datenpunkte …', PADL + 8, PADT + 18);
      return;
    }
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.08;
    yMin -= pad; yMax += pad;

    const xOf = (t: number) => PADL + (innerW * (t - tMin)) / WINDOW_MS;
    const yOf = (v: number) => PADT + innerH * (1 - (v - yMin) / (yMax - yMin));

    // Horizontal grid + y labels.
    ctx.fillStyle = '#6e7781';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const yPx = PADT + (innerH * i) / 4;
      ctx.fillText(fmtAxis(yMax - ((yMax - yMin) * i) / 4), PADL - 4, yPx);
      if (i > 0 && i < 4) {
        ctx.strokeStyle = '#eaeef2';
        ctx.beginPath();
        ctx.moveTo(PADL, yPx);
        ctx.lineTo(PADL + innerW, yPx);
        ctx.stroke();
      }
    }

    // Vertical grid every 5 s, scrolling with time.
    ctx.strokeStyle = '#f0f3f6';
    const STEP = 5000;
    for (let t = Math.ceil(tMin / STEP) * STEP; t <= tMax; t += STEP) {
      const x = xOf(t);
      ctx.beginPath();
      ctx.moveTo(x, PADT);
      ctx.lineTo(x, PADT + innerH);
      ctx.stroke();
    }
    // x-axis hint.
    ctx.fillStyle = '#8c959f';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`−${WINDOW_MS / 1000}s`, PADL + 2, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText('jetzt', PADL + innerW, h - 2);

    // Clip to the plot rect so off-window line segments don't spill over axes.
    ctx.save();
    ctx.beginPath();
    ctx.rect(PADL, PADT, innerW, innerH);
    ctx.clip();
    for (const s of vis) {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
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
</script>

<div class="comms">
  <div class="tabs">
    <button class="tab" class:active={tab === 'stream'} onclick={() => (tab = 'stream')}>
      Stream
      <span class="tab-count">{streamEntries.length}</span>
    </button>
    <button class="tab" class:active={tab === 'rows'} onclick={() => (tab = 'rows')}>
      Zeilen
      <span class="tab-count">{tables.reduce((n, t) => n + t.rows.length, 0)}</span>
    </button>
    <button class="tab" class:active={tab === 'graph'} onclick={() => (tab = 'graph')}>
      Graph
    </button>
    <button
      class="tab live-toggle"
      class:active={tab === 'live'}
      title="Live-Sensordaten (COMMAND/STATE/MOTION/ANALOG) — je Typ der neueste Wert"
      onclick={() => (tab = 'live')}
    >
      <span class="live-dot" class:flowing={liveEntries.length > 0}></span>
      Live <span class="tab-count">{latestLive.length}</span>
    </button>
    <div class="spacer"></div>
    <button class="btn-icon" title={paused ? 'Fortsetzen' : 'Pausieren'} onclick={() => setCommsPaused(!paused)}>
      {paused ? '▶' : '❚❚'}
    </button>
    <button class="btn-icon" title="Leeren" onclick={() => clearComms()}>✕</button>
  </div>

  {#if tab === 'stream'}
    <div class="stream" bind:this={streamEl} onscroll={onStreamScroll}>
      {#if streamEntries.length === 0}
        <div class="placeholder">
          {entries.length > 0 && liveEntries.length > 0
            ? 'Nur Live-Polling aktiv — relevante Ereignisse (Befehle, Tastendrücke) erscheinen hier.'
            : 'Noch keine Daten gesendet oder empfangen.'}
        </div>
      {/if}
      {#each streamEntries as e (e.id)}
        <div class={entryClass(e)}>
          <span class="t">{fmtTime(e.time)}</span>
          <span class="dir">{e.direction === 'tx' ? '↑' : '↓'}</span>
          <span class="tp">{e.transport.toUpperCase()}</span>
          <span class="text">
            {#if e.kind && e.kind !== 'serial'}
              <span class="kind kind-{e.kind}">{e.kind}</span>
            {/if}
            {e.text}
          </span>
        </div>
      {/each}
    </div>
  {:else if tab === 'live'}
    <div class="live-scroll">
      {#if latestLive.length === 0}
        <div class="placeholder">
          Noch keine Live-Daten. Sensor-Polling (STATE/MOTION/ANALOG) und der
          Handshake (COMMAND) erscheinen hier — je Typ nur der neueste Wert.
        </div>
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
  {:else if tab === 'rows'}
    <div class="rows-scroll">
      {#if tables.length === 0}
        <div class="placeholder">Noch keine Logzeilen erkannt. Sende z. B. <code>serial.writeValue("Licht", x)</code>, <code>print('x,y'); print('1,2')</code> oder nutze <code>datalogger.mirrorToSerial(true)</code>.</div>
      {/if}
      {#each tables as t, ti (ti)}
        <div class="rows-card">
          <div class="rows-card-head">
            <strong>Tabelle {ti + 1}</strong>
            <span class="meta">{t.rows.length} Zeilen, {t.columns.length} Spalten</span>
            <div class="spacer"></div>
            <button class="btn-text" disabled={t.rows.length === 0} onclick={() => downloadCsv(t)}>CSV laden</button>
          </div>
          <div class="rows-table-wrap">
            <table class="rows-table">
              <thead>
                <tr><th class="c-time">Zeit</th>{#each t.columns as col}<th>{col}</th>{/each}</tr>
              </thead>
              <tbody>
                {#each t.rows.slice(-100) as r, ri (ri)}
                  <tr>
                    <td class="c-time">{fmtTime(r.time)}</td>
                    {#each r.values as v}
                      {#if v === '' || v === undefined || v === null}
                        <td class="c-val c-empty" title="kein Wert">·</td>
                      {:else}
                        <td class="c-val" class:num={typeof v === 'number'}>{v}</td>
                      {/if}
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
            {#if t.rows.length > 100}
              <div class="rows-truncated">Zeige die letzten 100 von {t.rows.length} Zeilen.</div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="graph-wrap">
      {#if series.length === 0}
        <div class="placeholder">Noch keine Daten zum Plotten. Logge Zahlen mit <code>serial.writeValue("Licht", x)</code>, <code>print('x,y'); print('1,2')</code> oder <code>datalogger.mirrorToSerial(true)</code>.</div>
      {:else}
        <div class="legend">
          {#each series as c (c.name)}
            <button class="legend-item" class:off={hidden[c.name]} onclick={() => toggleCol(c.name)}>
              <span class="swatch" style="background:{c.color}"></span>
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
</div>

<style>
  .comms {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 240px;
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 13px;
    background: #fff;
    color: #24292f;
    border: 1px solid #d0d7de;
    border-radius: 6px;
  }
  .tabs {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 4px 4px 0 4px;
    border-bottom: 1px solid #d0d7de;
    background: #f6f8fa;
    border-top-left-radius: 6px;
    border-top-right-radius: 6px;
  }
  .tab {
    border: 0;
    background: transparent;
    padding: 6px 12px;
    cursor: pointer;
    color: #57606a;
    border-bottom: 2px solid transparent;
    font-size: 13px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .tab:hover { color: #24292f; }
  .tab.active { color: #24292f; border-bottom-color: #0969da; }
  .tab-count {
    font-size: 11px;
    color: #6e7781;
    background: #eaeef2;
    border-radius: 9px;
    padding: 1px 6px;
  }
  .tab.active .tab-count { background: #ddf4ff; color: #0969da; }
  .spacer { flex: 1; }
  .btn-icon {
    border: 0;
    background: transparent;
    cursor: pointer;
    padding: 4px 8px;
    color: #57606a;
    font-size: 13px;
  }
  .btn-icon:hover { color: #24292f; background: #eaeef2; border-radius: 4px; }
  .btn-text {
    border: 1px solid #d0d7de;
    background: #fff;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 12px;
    border-radius: 4px;
  }
  .btn-text:hover:not(:disabled) { background: #f6f8fa; }
  .btn-text:disabled { color: #8c959f; cursor: default; }

  .stream {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
  }
  .placeholder {
    padding: 16px;
    color: #6e7781;
    font-style: italic;
  }
  .entry {
    display: grid;
    grid-template-columns: 96px 16px 36px 1fr;
    gap: 6px;
    padding: 0 4px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .entry:hover { background: #f6f8fa; }
  .entry .t { color: #6e7781; }
  .entry .dir { text-align: center; font-weight: 700; }
  .entry-tx .dir { color: #0969da; }
  .entry-rx .dir { color: #1a7f37; }
  .entry .tp {
    font-size: 10px;
    color: #57606a;
    background: #eaeef2;
    border-radius: 3px;
    text-align: center;
    align-self: center;
    line-height: 16px;
    height: 16px;
  }
  .entry-ble .tp { background: #ddf4ff; color: #0969da; }
  .entry .text { color: #24292f; }
  .entry-rx .text { color: #1a7f37; }
  .entry .kind {
    display: inline-block;
    font-size: 10px;
    padding: 0 5px;
    margin-right: 6px;
    border-radius: 3px;
    line-height: 14px;
    vertical-align: 1px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    font-weight: 600;
  }
  .kind-blocks { background: #e7e0ff; color: rgb(65, 200, 200); }
  .kind-gatt { background: #d6f1ff; color: #056399; }
  .kind-jacdac { background: #ffe9d6; color: #9a4a00; }

  /* "Live" badge: pulsing dot while STATE/MOTION/ANALOG polling flows, with a
     count. Clicking the badge toggles whether that poll traffic is shown in
     the Stream (hidden by default). */
  .live-toggle { display: inline-flex; align-items: center; gap: 5px; }
  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #9aa3ad;
    display: inline-block;
    flex: 0 0 auto;
  }
  .live-dot.flowing {
    background: #22c55e;
    animation: livePulse 1.1s ease-in-out infinite;
  }
  @keyframes livePulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.3; transform: scale(0.72); }
  }

  /* Live tab: one fixed row per channel, latest value updated in place. */
  .live-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 6px 4px;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
  }
  .live-row {
    display: grid;
    grid-template-columns: 96px 36px 96px 1fr;
    gap: 6px;
    align-items: baseline;
    padding: 2px 4px;
    border-bottom: 1px solid #eaeef2;
  }
  .live-row .live-key { font-weight: 600; color: #6f42c1; }
  .live-row .t { color: #6e7781; }
  .live-row .live-text { color: #24292f; word-break: break-all; }
  .live-row.entry-rx .live-text { color: #1a7f37; }

  .rows-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .rows-card {
    border: 1px solid #d0d7de;
    border-radius: 6px;
    overflow: hidden;
  }
  .rows-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: #f6f8fa;
    border-bottom: 1px solid #d0d7de;
  }
  .rows-card-head .meta { color: #6e7781; font-size: 12px; }
  .rows-table-wrap { overflow-x: auto; }
  /* Content-sized columns (not stretched to 100%) so values sit next to their
     header instead of drifting apart on a wide panel; the wrap scrolls
     horizontally when there are too many columns for the width. Light vertical
     rules + nowrap keep it readable when space is tight. */
  .rows-table { border-collapse: collapse; width: auto; font-size: 12px; }
  .rows-table th, .rows-table td {
    border-bottom: 1px solid #eaeef2;
    border-right: 1px solid #f0f3f6;
    padding: 3px 10px;
    text-align: left;
    vertical-align: top;
    white-space: nowrap;
  }
  .rows-table th:last-child, .rows-table td:last-child { border-right: 0; }
  .rows-table th { color: #57606a; font-weight: 600; background: #fafbfc; position: sticky; top: 0; }
  .rows-table td.c-val { min-width: 52px; }
  .rows-table td.c-val.num { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; text-align: right; }
  .rows-table td.c-empty { color: #c4cdd5; text-align: center; }
  .rows-table td.c-time, .rows-table th.c-time { color: #6e7781; font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; white-space: nowrap; }
  .rows-truncated { padding: 6px 10px; color: #6e7781; font-size: 11px; background: #fafbfc; }

  .graph-wrap {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 8px;
    gap: 8px;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 12px;
    cursor: pointer;
    font-size: 12px;
  }
  .legend-item:hover { background: #eaeef2; }
  .legend-item.off { opacity: 0.45; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
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
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
