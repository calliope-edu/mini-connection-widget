<script lang="ts">
  /**
   * Header pill that opens a `<ConnectionPanel>`. Two layouts:
   *
   *   - **Dropdown** (default): the panel appears as a popover anchored to
   *     the pill, like a typical browser-extension menu. A scrim closes on
   *     outside click.
   *   - **Floating** (user-pinned): the panel detaches into a draggable,
   *     resizable window rendered at `position: fixed`. Survives pill clicks
   *     and editor navigation; position + size + the pinned preference are
   *     persisted to localStorage so the floating window comes back where
   *     the user left it on the next page load.
   *
   * The pin / unpin toggle lives in the panel header — clicking it flips
   * between the two layouts without losing scroll / comms-log state, since
   * we render the same `<ConnectionPanel>` instance under either layout
   * wrapper.
   *
   * `advanced` gates the still-rough power-user affordances — the pin /
   * drag floating window and the embedded comms log. With it off (the
   * default) the panel is a plain dropdown popover, which is what regular
   * users see; hosts opt in (e.g. from a dev-mode flag) to expose them.
   */
  import { calliopeState } from '../state';
  import type { CalliopeStatus } from '../state';
  import ConnectionPanel from './ConnectionPanel.svelte';
  import { mergeLabels, type ConnectLabels } from './labels';
  import { onMount } from 'svelte';

  type Props = {
    /**
     * Visual style for the trigger:
     *   - `dark` / `light` — the labelled status pill (dot + text), tuned for
     *     dark headers vs light backgrounds.
     *   - `icon` — a compact, status-coloured circle showing the Calliope
     *     logo. It morphs into a short pill while flashing (logo hidden,
     *     `%` for a determinate transfer or a spinner for an indeterminate
     *     phase). Background: green=connected, blue=transferring, red=error,
     *     neutral otherwise.
     */
    appearance?: 'dark' | 'light' | 'icon';
    /** Translation overrides; defaults are German. */
    labels?: Partial<ConnectLabels>;
    /** Expose the pin / drag floating window + comms log (off by default). */
    advanced?: boolean;
  };

  let { appearance = 'dark', labels: labelsProp, advanced = false }: Props = $props();
  const labels = $derived(mergeLabels(labelsProp));

  const s = $derived($calliopeState);

  // ---- Layout state (persisted) ------------------------------------------
  //
  // `pinned` is the user's persistent preference; `open` tracks whether the
  // panel is currently visible. When pinned, the pill click toggles the
  // floating window; when unpinned, it toggles the dropdown popover.

  let open = $state(false);
  let pinned = $state(false);
  // The floating window only exists in advanced mode — when `advanced` is
  // off we always fall back to the dropdown, regardless of the persisted
  // `pinned` preference (so toggling dev mode off live collapses it).
  const effectivePinned = $derived(advanced && pinned);
  // Default position: top-right with some inset. Replaced from localStorage on mount.
  let pos = $state({ x: -1, y: 80 });
  let size = $state({ w: 360, h: 540 });

  const STORAGE_KEY = 'calliope:connect-panel';

  function persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ pinned, pos, size }));
    } catch { /* SSR / private mode / quota — best effort */ }
  }

  onMount(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const v = JSON.parse(raw) as Partial<{
          pinned: boolean;
          pos: { x: number; y: number };
          size: { w: number; h: number };
        }>;
        if (typeof v.pinned === 'boolean') pinned = v.pinned;
        if (v.pos && typeof v.pos.x === 'number' && typeof v.pos.y === 'number') pos = v.pos;
        if (v.size && typeof v.size.w === 'number' && typeof v.size.h === 'number') size = v.size;
      }
    } catch { /* ignore */ }
    // Default x: right edge minus width minus 16px inset.
    if (pos.x < 0) {
      pos = { x: Math.max(16, window.innerWidth - size.w - 16), y: pos.y };
    }
    // Auto-open the floating window if the user previously pinned it — but
    // only when advanced affordances are on, otherwise the pref is dormant.
    if (pinned && advanced) open = true;
  });

  function togglePin(): void {
    const willPin = !pinned;
    pinned = willPin;
    if (willPin) {
      // First pin: drop the panel near the pill so the user doesn't have to
      // hunt for it. Subsequent pins reuse the remembered position.
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored || !JSON.parse(stored).pos) {
          pos = { x: Math.max(16, window.innerWidth - size.w - 16), y: 72 };
        }
      } catch { /* ignore */ }
      open = true;
    } else {
      // Unpinning closes the floating window — same auto-close behavior as
      // the dropdown's scrim, so the only thing left on screen is the pill.
      open = false;
    }
    persist();
  }

  // ---- Drag (header) -----------------------------------------------------

  let drag = $state<{ dx: number; dy: number; pointerId: number } | null>(null);
  function onDragPointerDown(ev: PointerEvent): void {
    // Buttons inside the header (the pin toggle) must keep receiving their
    // own clicks — only the bare title area should initiate a drag.
    if ((ev.target as HTMLElement)?.closest('button')) return;
    const target = ev.currentTarget as HTMLElement;
    drag = { dx: ev.clientX - pos.x, dy: ev.clientY - pos.y, pointerId: ev.pointerId };
    target.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  }
  function onDragPointerMove(ev: PointerEvent): void {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const maxX = window.innerWidth - 80;     // keep at least header chunk visible
    const maxY = window.innerHeight - 40;
    pos = {
      x: Math.max(0, Math.min(ev.clientX - drag.dx, maxX)),
      y: Math.max(0, Math.min(ev.clientY - drag.dy, maxY)),
    };
  }
  function onDragPointerUp(ev: PointerEvent): void {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    try { (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    drag = null;
    persist();
  }

  // ---- Resize (bottom-right corner) --------------------------------------

  let resize = $state<{ x0: number; y0: number; w0: number; h0: number; pointerId: number } | null>(null);
  function onResizePointerDown(ev: PointerEvent): void {
    resize = { x0: ev.clientX, y0: ev.clientY, w0: size.w, h0: size.h, pointerId: ev.pointerId };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    ev.preventDefault();
  }
  function onResizePointerMove(ev: PointerEvent): void {
    if (!resize || ev.pointerId !== resize.pointerId) return;
    const minW = 300, minH = 320;
    const maxW = Math.max(minW, window.innerWidth - pos.x - 8);
    const maxH = Math.max(minH, window.innerHeight - pos.y - 8);
    size = {
      w: Math.max(minW, Math.min(maxW, resize.w0 + ev.clientX - resize.x0)),
      h: Math.max(minH, Math.min(maxH, resize.h0 + ev.clientY - resize.y0)),
    };
  }
  function onResizePointerUp(ev: PointerEvent): void {
    if (!resize || ev.pointerId !== resize.pointerId) return;
    try { (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    resize = null;
    persist();
  }

  // ---- Status label ------------------------------------------------------

  const isIndeterminate = $derived(
    s.status === 'flashing' &&
      (s.flashPhase === 'check' || s.flashPhase === 'reboot' || s.flashPhase === 'prepare')
  );

  const isIcon = $derived(appearance === 'icon');
  const isFlashing = $derived(s.status === 'flashing');

  function statusLabel(status: CalliopeStatus): string {
    // In native-proxy mode (hosted in iOS/Android app), surface the
    // app-mode framing in every state — "Nicht verbunden" misleads when
    // the radio is being managed by the host app, not by the browser.
    if (s.nativeMode) {
      switch (status) {
        case 'connected': return labels.appModeConnected;
        case 'connecting': return labels.appModeConnecting;
        case 'flashing': {
          const phase = s.flashPhase;
          if (phase === 'check') return labels.phaseCheck;
          if (phase === 'reboot') return labels.phaseReboot;
          if (phase === 'prepare') return labels.phasePrepare;
          if (phase === 'finalising') return labels.phaseFinalising;
          return `${labels.flashing} ${s.flashProgress ?? 0}%`;
        }
        case 'error': return labels.error;
        default: return labels.appModeWaiting;
      }
    }
    switch (status) {
      case 'connected':
        if (s.usbStatus === 'connected' && s.bleStatus === 'connected') return 'USB + BLE';
        if (s.usbStatus === 'connected') return labels.usb;
        return labels.ble;
      case 'flashing': {
        const phase = s.flashPhase;
        if (phase === 'check') return labels.phaseCheck;
        if (phase === 'reboot') return labels.phaseReboot;
        if (phase === 'prepare') return labels.phasePrepare;
        if (phase === 'finalising') return labels.phaseFinalising;
        return `${labels.flashing} ${s.flashProgress ?? 0}%`;
      }
      case 'connecting': return labels.connecting;
      case 'error': return labels.error;
      case 'unsupported': return labels.unsupported;
      case 'disconnected':
      case 'unknown':
      default: return labels.notConnected;
    }
  }
</script>

<div class="connect-wrap">
  {#if isIcon}
    <button
      type="button"
      class="conn-icon status-{s.status}"
      class:flashing={isFlashing}
      class:pinned-indicator={effectivePinned}
      onclick={() => (open = !open)}
      aria-haspopup="true"
      aria-expanded={open}
      title={statusLabel(s.status)}
      aria-label={statusLabel(s.status)}
    >
      {#if isFlashing}
        {#if isIndeterminate}
          <span class="spinner" aria-hidden="true"></span>
        {:else}
          <span class="pct">{s.flashProgress ?? 0}%</span>
          <span class="progress" style="width: {s.flashProgress ?? 0}%"></span>
        {/if}
      {:else if s.status === 'connecting'}
        <span class="spinner" aria-hidden="true"></span>
      {:else}
        <span class="calliope-icon" aria-hidden="true">
          <!-- Calliope mini hardware icon (board outline + LED matrix), from the
               native apps' ic_device_24dp. Single-colour so it inherits the
               status fill via currentColor. -->
          <svg viewBox="0 0 47.384 47.384" width="19" height="19" fill="currentColor">
            <g transform="translate(0 1.6)">
              <path d="M12.727,3.678C12.385,3.932 12.338,4.548 12.403,4.998 12.591,6.338 12.996,11.021 10.252,15.02 8.401,17.718 5.566,19.49 3.511,20.501 2.474,21.012 2.391,21.623 2.455,22.207 2.552,23.075 3.481,23.403 3.587,23.437 5.083,23.927 6.854,24.837 9.657,28.147 12.946,32.032 12.591,37.149 12.404,38.625 12.343,39.105 12.337,39.986 12.978,40.486c0.366,0.286 1.265,0.181 1.78,-0.203 1.273,-0.954 2.28,-1.581 3.264,-2.032 1.212,-0.553 2.496,-0.929 3.436,-1.007 0.014,-0.001 0.029,-0.003 0.041,-0.004 0.385,-0.969 1.186,-1.542 2.174,-1.542 1.006,-0 1.806,0.566 2.204,1.556 0.773,0.083 1.866,0.393 3.25,0.922 1.2,0.459 2.128,1.09 2.873,1.596 0.159,0.107 0.311,0.212 0.458,0.308 1.069,0.701 1.693,0.463 2.067,0.224 0.294,-0.188 0.453,-0.54 0.404,-0.895 -0.232,-1.682 -0.513,-6.031 1.87,-10.103 1.868,-3.189 4.665,-4.81 6.893,-5.866 0.597,-0.283 1.299,-0.777 1.248,-1.526 -0.035,-0.514 -0.367,-0.95 -0.845,-1.114 -1.585,-0.537 -4.062,-1.945 -6.86,-5.596 -2.569,-3.353 -2.469,-7.436 -2.171,-10.216 0.071,-0.663 -0.322,-1.284 -0.956,-1.508l-0.09,-0.032c-0.422,-0.15 -0.891,-0.085 -1.255,0.17 -1.784,1.253 -5.337,3.356 -9.088,3.356 -3.367,-0 -6.764,-1.818 -9.021,-3.343 -0.584,-0.395 -1.357,-0.375 -1.926,0.046M13.594,42.767C12.908,42.767 12.229,42.584 11.679,42.156 10.606,41.32 10.105,39.936 10.306,38.358 10.465,37.099 10.774,32.74 8.042,29.513 5.58,26.606 4.13,25.84 2.928,25.447 1.805,25.08 0.537,24.097 0.353,22.441c-0.132,-1.186 0.146,-2.815 2.224,-3.837 1.827,-0.9 4.339,-2.461 5.93,-4.78 2.313,-3.371 1.963,-7.381 1.801,-8.53 -0.197,-1.39 0.236,-2.63 1.159,-3.314 1.29,-0.956 3.045,-0.997 4.37,-0.1 1.648,1.112 4.856,2.98 7.836,2.98 3.17,-0 6.293,-1.862 7.872,-2.971 0.924,-0.65 2.112,-0.81 3.179,-0.434l0.09,0.032c1.56,0.553 2.528,2.086 2.352,3.728 -0.26,2.419 -0.361,5.953 1.747,8.703 2.476,3.229 4.554,4.437 5.862,4.881 1.289,0.438 2.182,1.605 2.275,2.972 0.101,1.489 -0.792,2.795 -2.452,3.582 -1.954,0.926 -4.399,2.333 -5.974,5.024C36.576,33.876 36.824,37.657 37.026,39.12 37.187,40.293 36.652,41.458 35.662,42.09 34.904,42.572 33.332,43.181 31.301,41.85c-0.157,-0.102 -0.318,-0.212 -0.488,-0.327 -0.69,-0.468 -1.47,-0.998 -2.441,-1.37 -1.645,-0.63 -2.441,-0.772 -2.769,-0.8 -0.751,-0.066 -1.41,-0.57 -1.68,-1.284 -0.096,-0.255 -0.168,-0.255 -0.25,-0.255 -0.073,-0 -0.141,-0 -0.229,0.265C23.33,38.426 22.925,39.246 21.633,39.353 21.11,39.396 20.081,39.637 18.901,40.176 18.061,40.561 17.174,41.115 16.027,41.975 15.38,42.459 14.482,42.767 13.594,42.767"/>
              {#each [16.829, 21.381, 25.933, 30.486] as cx (cx)}
                {#each [15.17, 19.623, 24.076, 28.53] as cy (cy)}
                  <circle {cx} {cy} r="1.41" />
                {/each}
              {/each}
            </g>
          </svg>
        </span>
      {/if}
    </button>
  {:else}
    <button
      type="button"
      class="conn-pill status-{s.status} appearance-{appearance}"
      class:pinned-indicator={effectivePinned}
      onclick={() => (open = !open)}
      aria-haspopup="true"
      aria-expanded={open}
      title={effectivePinned ? labels.triggerTitle + ' (Fenster offen)' : labels.triggerTitle}
    >
      {#if isIndeterminate}
        <span class="spinner" aria-hidden="true"></span>
      {:else}
        <span class="dot" aria-hidden="true"></span>
      {/if}
      <span class="label">{statusLabel(s.status)}</span>
      {#if s.status === 'flashing' && s.flashProgress != null && !isIndeterminate}
        <span class="progress" style="width: {s.flashProgress}%"></span>
      {/if}
    </button>
  {/if}

  {#if open && !effectivePinned}
    <div class="popover" role="dialog" aria-label={labels.panelTitle}>
      <ConnectionPanel
        labels={labelsProp}
        onaction={() => (open = false)}
        pinned={effectivePinned}
        onTogglePin={advanced ? togglePin : undefined}
        {advanced}
      />
    </div>
    <button class="popover-scrim" type="button" aria-label="close" onclick={() => (open = false)}></button>
  {/if}
</div>

{#if open && effectivePinned}
  <div
    class="floating"
    role="dialog"
    aria-label={labels.panelTitle}
    style="left:{pos.x}px; top:{pos.y}px; width:{size.w}px; height:{size.h}px;"
  >
    <div class="floating-body">
      <ConnectionPanel
        labels={labelsProp}
        pinned={effectivePinned}
        onTogglePin={togglePin}
        {advanced}
        onHeaderPointerDown={onDragPointerDown}
        onHeaderPointerMove={onDragPointerMove}
        onHeaderPointerUp={onDragPointerUp}
      />
    </div>
    <div
      class="floating-resize"
      role="presentation"
      title="Größe ändern"
      onpointerdown={onResizePointerDown}
      onpointermove={onResizePointerMove}
      onpointerup={onResizePointerUp}
      onpointercancel={onResizePointerUp}
    >
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path d="M11 1L1 11M11 5L5 11M11 9L9 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/>
      </svg>
    </div>
  </div>
{/if}

<style>
  .connect-wrap { position: relative; display: inline-flex; }

  .conn-pill {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    overflow: hidden;
    white-space: nowrap;
    border: 1px solid transparent;

    &.appearance-dark {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.92);
      &:hover { background: rgba(255, 255, 255, 0.14); }
    }
    &.appearance-light {
      background: #fff;
      border-color: #d1d5db;
      color: #1b1c1d;
      &:hover { background: #f3f4f6; }
    }
    /* Subtle teal outline so the user can tell their floating window is up
       even when it's behind another tab or minimised offscreen. */
    &.pinned-indicator { outline: 1.5px solid #0ea5b7; outline-offset: 1px; }

    .dot { width: 8px; height: 8px; border-radius: 50%; background: #e53f4b; }
    .spinner {
      width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid currentColor; border-top-color: transparent;
      animation: spin 0.9s linear infinite;
    }
    .progress {
      position: absolute; left: 0; bottom: 0; height: 2px;
      background: #98f600; transition: width 0.2s linear;
    }
    &.status-connected .dot { background: #98f600; }
    &.status-connecting .dot { background: #ff4e00; }
    &.status-flashing .dot { background: #00b8cc; }
    &.status-error .dot { background: #e53f4b; }
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ---- Icon trigger (appearance="icon") ---------------------------------- */

  .conn-icon {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.92);
    cursor: pointer;
    overflow: hidden;
    white-space: nowrap;
    transition: width 0.25s ease, border-radius 0.25s ease, background 0.15s, color 0.15s;

    &:hover { filter: brightness(1.1); }
    &.pinned-indicator { outline: 1.5px solid #0ea5b7; outline-offset: 1px; }

    .calliope-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 0;
    }

    .spinner {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid currentColor; border-top-color: transparent;
      animation: spin 0.9s linear infinite;
    }

    /* Status fills. White logo on the darker error/flash fills; a dark logo on
       the bright lime "connected" fill so it stays legible. */
    &.status-connected { background: #98f600; border-color: #98f600; color: #1b1c1d; }
    &.status-error     { background: #e53f4b; border-color: #e53f4b; color: #fff; }
    &.status-flashing  { background: #00b8cc; border-color: #00b8cc; color: #fff; }

    /* Transferring: the circle stretches into a short pill that shows the
       progress percentage (or a spinner during indeterminate phases). */
    &.flashing {
      width: auto;
      min-width: 54px;
      padding: 0 12px;
      gap: 6px;
      border-radius: 14px;
    }

    .pct {
      font-size: 12px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.01em;
    }

    .progress {
      position: absolute; left: 0; bottom: 0; height: 2px;
      background: rgba(255, 255, 255, 0.85);
      transition: width 0.2s linear;
    }
  }

  .popover {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 1100;
    width: 340px;
    background: #1f2023;
    color: #f3f4f6;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
  }
  .popover-scrim {
    position: fixed;
    inset: 0;
    background: transparent;
    border: 0;
    cursor: default;
    z-index: 1099;
  }

  /* ---- Floating window ---------------------------------------------------- */

  .floating {
    position: fixed;
    z-index: 1200;
    min-width: 300px;
    min-height: 320px;
    background: #1f2023;
    color: #f3f4f6;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 12px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* No backdrop or scrim - the floating layout is meant to stay open while
       the user does other work in the editor. */
  }
  .floating-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    /* Let CommsPanel fill the resizable container instead of capping at its
       built-in 280px height. */
    :global(.panel) {
      height: 100%;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
    }
    :global(.panel .comms-embed) {
      flex: 1;
      min-height: 200px;
      height: auto !important;
    }
  }
  .floating-resize {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    color: #9ca3af;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3;
    touch-action: none;
    &:hover { color: #6b7280; }
  }
</style>
