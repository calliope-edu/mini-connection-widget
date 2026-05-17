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
   */
  import { calliopeState } from '../state';
  import type { CalliopeStatus } from '../state';
  import ConnectionPanel from './ConnectionPanel.svelte';
  import { mergeLabels, type ConnectLabels } from './labels';
  import { onMount } from 'svelte';

  type Props = {
    /** Visual style for the trigger pill — light backgrounds vs dark headers. */
    appearance?: 'dark' | 'light';
    /** Translation overrides; defaults are German. */
    labels?: Partial<ConnectLabels>;
    /** Called when the user clicks the "maximize" button in the embedded
     *  CommsPanel. Hosts wire this to opening a full-size drawer. */
    oncommsexpand?: () => void;
  };

  let { appearance = 'dark', labels: labelsProp, oncommsexpand }: Props = $props();
  const labels = $derived(mergeLabels(labelsProp));

  const s = $derived($calliopeState);

  // ---- Layout state (persisted) ------------------------------------------
  //
  // `pinned` is the user's persistent preference; `open` tracks whether the
  // panel is currently visible. When pinned, the pill click toggles the
  // floating window; when unpinned, it toggles the dropdown popover.

  let open = $state(false);
  let pinned = $state(false);
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
    // Auto-open the floating window if the user previously pinned it.
    if (pinned) open = true;
  });

  function togglePin(): void {
    pinned = !pinned;
    // Stay open across the layout switch — the user just clicked pin/unpin,
    // they don't want the panel to vanish.
    open = true;
    if (pinned) {
      // First pin: drop the panel near the pill so the user doesn't have to
      // hunt for it. Subsequent pins reuse the remembered position.
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored || !JSON.parse(stored).pos) {
          pos = { x: Math.max(16, window.innerWidth - size.w - 16), y: 72 };
        }
      } catch { /* ignore */ }
    }
    persist();
  }

  function closeFloating(): void {
    open = false;
  }

  // ---- Drag (header) -----------------------------------------------------

  let drag = $state<{ dx: number; dy: number; pointerId: number } | null>(null);
  function onDragPointerDown(ev: PointerEvent): void {
    const target = ev.currentTarget as HTMLElement;
    // Buttons inside the header should still receive their own clicks.
    if ((ev.target as HTMLElement)?.closest('button')) return;
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

  function statusLabel(status: CalliopeStatus): string {
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
  <button
    type="button"
    class="conn-pill status-{s.status} appearance-{appearance}"
    class:pinned-indicator={pinned}
    onclick={() => (open = !open)}
    aria-haspopup="true"
    aria-expanded={open}
    title={pinned ? labels.triggerTitle + ' (Fenster offen)' : labels.triggerTitle}
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

  {#if open && !pinned}
    <div class="popover" role="dialog" aria-label={labels.panelTitle}>
      <ConnectionPanel
        labels={labelsProp}
        onaction={() => (open = false)}
        oncommsexpand={oncommsexpand
          ? () => {
              open = false;
              oncommsexpand?.();
            }
          : undefined}
        {pinned}
        onTogglePin={togglePin}
      />
    </div>
    <button class="popover-scrim" type="button" aria-label="close" onclick={() => (open = false)}></button>
  {/if}
</div>

{#if open && pinned}
  <div
    class="floating"
    role="dialog"
    aria-label={labels.panelTitle}
    style="left:{pos.x}px; top:{pos.y}px; width:{size.w}px; height:{size.h}px;"
  >
    <div
      class="floating-drag-handle"
      onpointerdown={onDragPointerDown}
      onpointermove={onDragPointerMove}
      onpointerup={onDragPointerUp}
      onpointercancel={onDragPointerUp}
    ></div>
    <div class="floating-body">
      <ConnectionPanel
        labels={labelsProp}
        {oncommsexpand}
        {pinned}
        onTogglePin={togglePin}
        onClose={closeFloating}
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

  .popover {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 1100;
    width: 340px;
    background: #fff;
    color: #1b1c1d;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.18);
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
    background: #fff;
    color: #1b1c1d;
    border: 1px solid #d1d5db;
    border-radius: 12px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.22);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* No backdrop or scrim - the floating layout is meant to stay open while
       the user does other work in the editor. */
  }
  /* Invisible grab strip across the top of the floating window. Covers the
     panel-header so the user can drag from the title bar without a separate
     visible chrome bar. Buttons inside the header still win the pointer
     because the drag handler early-returns on closest button. */
  .floating-drag-handle {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 48px;
    cursor: move;
    z-index: 2;
    touch-action: none;
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
