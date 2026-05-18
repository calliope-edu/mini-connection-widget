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
  import { onDestroy } from 'svelte';
  import {
    commsEntries,
    commsPaused,
    clearComms,
    setCommsPaused,
    type CommsEntry,
  } from '../comms';

  type Tab = 'stream' | 'rows' | 'graph';
  let tab: Tab = $state('stream');

  const entries = $derived($commsEntries);
  const paused = $derived($commsPaused);

  // ---- Stream view ---------------------------------------------------------
  let streamEl: HTMLDivElement | undefined = $state();
  let autoScroll = $state(true);
  $effect(() => {
    // Re-run whenever the entries list grows; honor user's pin-to-bottom toggle.
    entries.length;
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
    let current: TableModel | null = null;
    for (const e of entries) {
      if (!e.parsed) continue;
      if (e.parsed.type === 'header') {
        current = { columns: e.parsed.columns, rows: [] };
        out.push(current);
        continue;
      }
      // type === 'row'
      if (!current || !sameColumns(current.columns, e.parsed.columns)) {
        current = { columns: e.parsed.columns, rows: [] };
        out.push(current);
      }
      current.rows.push({ time: e.time, values: e.parsed.values });
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
  let canvas: HTMLCanvasElement | undefined = $state();
  const PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2'];
  /** Last table is what the graph follows (most recently seen header). */
  const activeTable = $derived(tables.length > 0 ? tables[tables.length - 1] : null);
  /** Indices (within activeTable.columns) of columns that have at least one
   *  numeric value — those are the candidates for plotting. */
  const numericCols = $derived.by<{ index: number; name: string; color: string }[]>(() => {
    if (!activeTable) return [];
    const out: { index: number; name: string; color: string }[] = [];
    for (let i = 0; i < activeTable.columns.length; i++) {
      if (activeTable.rows.some((r) => typeof r.values[i] === 'number')) {
        out.push({ index: i, name: activeTable.columns[i], color: PALETTE[out.length % PALETTE.length] });
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
  $effect(() => {
    drawGraph();
  });
  function drawGraph() {
    if (!canvas || !activeTable) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const PADL = 32, PADR = 8, PADT = 8, PADB = 18;
    const innerW = Math.max(1, w - PADL - PADR);
    const innerH = Math.max(1, h - PADT - PADB);

    // Sliding window: last N rows.
    const N = Math.min(activeTable.rows.length, 200);
    const start = activeTable.rows.length - N;
    const rows = activeTable.rows.slice(start);
    if (rows.length < 2) {
      // Axis frame + placeholder.
      ctx.strokeStyle = '#d0d7de';
      ctx.strokeRect(PADL, PADT, innerW, innerH);
      ctx.fillStyle = '#6e7781';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Brauche mindestens 2 Datenpunkte …', PADL + 8, PADT + 16);
      return;
    }

    // Y range across all visible numeric columns.
    let yMin = Infinity, yMax = -Infinity;
    for (const c of numericCols) {
      if (hidden[c.name]) continue;
      for (const r of rows) {
        const v = r.values[c.index];
        if (typeof v === 'number' && Number.isFinite(v)) {
          if (v < yMin) yMin = v;
          if (v > yMax) yMax = v;
        }
      }
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return;
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.08;
    yMin -= pad; yMax += pad;

    // Axes + grid.
    ctx.strokeStyle = '#d0d7de';
    ctx.lineWidth = 1;
    ctx.strokeRect(PADL, PADT, innerW, innerH);
    ctx.fillStyle = '#6e7781';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const yPx = PADT + (innerH * i) / 4;
      const val = yMax - ((yMax - yMin) * i) / 4;
      ctx.fillText(fmtAxis(val), PADL - 4, yPx);
      ctx.strokeStyle = i === 0 || i === 4 ? '#d0d7de' : '#eaeef2';
      ctx.beginPath();
      ctx.moveTo(PADL, yPx);
      ctx.lineTo(PADL + innerW, yPx);
      ctx.stroke();
    }

    // Lines.
    for (const c of numericCols) {
      if (hidden[c.name]) continue;
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i].values[c.index];
        if (typeof v !== 'number' || !Number.isFinite(v)) { pen = false; continue; }
        const x = PADL + (innerW * i) / Math.max(1, rows.length - 1);
        const y = PADT + innerH * (1 - (v - yMin) / (yMax - yMin));
        if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }
  }
  function fmtAxis(v: number): string {
    if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01)) return v.toExponential(1);
    return Number(v.toFixed(2)).toString();
  }

  // Redraw on resize too.
  let ro: ResizeObserver | undefined;
  $effect(() => {
    if (!canvas) return;
    ro?.disconnect();
    ro = new ResizeObserver(() => drawGraph());
    ro.observe(canvas);
    return () => ro?.disconnect();
  });
  onDestroy(() => ro?.disconnect());

  // ---- Top bar -------------------------------------------------------------
  function entryClass(e: CommsEntry): string {
    return `entry entry-${e.direction} entry-${e.transport}`;
  }
</script>

<div class="comms">
  <div class="tabs">
    <button class="tab" class:active={tab === 'stream'} onclick={() => (tab = 'stream')}>
      Stream
      <span class="tab-count">{entries.length}</span>
    </button>
    <button class="tab" class:active={tab === 'rows'} onclick={() => (tab = 'rows')}>
      Zeilen
      <span class="tab-count">{tables.reduce((n, t) => n + t.rows.length, 0)}</span>
    </button>
    <button class="tab" class:active={tab === 'graph'} onclick={() => (tab = 'graph')}>
      Graph
    </button>
    <div class="spacer"></div>
    <button class="btn-icon" title={paused ? 'Fortsetzen' : 'Pausieren'} onclick={() => setCommsPaused(!paused)}>
      {paused ? '▶' : '❚❚'}
    </button>
    <button class="btn-icon" title="Leeren" onclick={() => clearComms()}>✕</button>
  </div>

  {#if tab === 'stream'}
    <div class="stream" bind:this={streamEl} onscroll={onStreamScroll}>
      {#if entries.length === 0}
        <div class="placeholder">Noch keine Daten gesendet oder empfangen.</div>
      {/if}
      {#each entries as e (e.id)}
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
  {:else if tab === 'rows'}
    <div class="rows-scroll">
      {#if tables.length === 0}
        <div class="placeholder">Noch keine Logzeilen erkannt. Sende z. B. <code>print('x,y'); print('1,2')</code> oder nutze <code>log.add(…)</code>.</div>
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
                    {#each r.values as v}<td class="c-val" class:num={typeof v === 'number'}>{v}</td>{/each}
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
      {#if !activeTable}
        <div class="placeholder">Noch keine Daten zum Plotten. Logge Zahlen mit <code>print('x,y'); print('1,2')</code> oder <code>log.add(…)</code>.</div>
      {:else}
        <div class="legend">
          {#each numericCols as c}
            <button class="legend-item" class:off={hidden[c.name]} onclick={() => toggleCol(c.name)}>
              <span class="swatch" style="background:{c.color}"></span>
              <span class="name">{c.name}</span>
            </button>
          {/each}
        </div>
        <canvas bind:this={canvas} class="graph-canvas"></canvas>
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
  .rows-table { border-collapse: collapse; width: 100%; font-size: 12px; }
  .rows-table th, .rows-table td {
    border-bottom: 1px solid #eaeef2;
    padding: 3px 8px;
    text-align: left;
    vertical-align: top;
  }
  .rows-table th { color: #57606a; font-weight: 600; background: #fafbfc; position: sticky; top: 0; }
  .rows-table td.c-val.num { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; text-align: right; }
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
  .graph-canvas {
    width: 100%;
    flex: 1;
    min-height: 200px;
    display: block;
  }
</style>
