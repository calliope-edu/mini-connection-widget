<script lang="ts">
  /**
   * Header pill that opens a `<ConnectionPanel>`. Two layouts:
   *
   *   - **Dropdown** (default): the panel appears in a calliope-ui `Popover`
   *     anchored to the trigger, like a typical browser-extension menu.
   *     Escape and a click outside close it.
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
   *
   * In native (app) mode the whole trigger renders nothing: the host app owns
   * the connection, so there is nothing for the user to connect / disconnect /
   * inspect here. The `<ConnectionBanner>` remains as the only surface, showing
   * what the app is doing.
   */
  import { Button, Popover, Spinner, StatusDot, type Status } from '@calliope-edu/ui';
  import { calliopeState } from '../state';
  import { calliopeUsbRecovery } from '../usb-recovery';
  import { deriveConnectionView, statusLabel } from '../connection-view';
  import ConnectionPanel from './ConnectionPanel.svelte';
  import { mergeLabels, type ConnectLabels } from './labels';
  import { onMount } from 'svelte';

  import { calliopeMiniMark as calliopeMark } from '../assets/calliope-mini';

  type Props = {
    /**
     * Visual style for the trigger:
     *   - `dark` / `light` — the labelled status pill (StatusDot + word in a
     *     calliope-ui `Button`), for dark headers vs light backgrounds.
     *   - `icon` — a compact circle showing the Calliope mini mark, filled
     *     in the calliope-ui status colour (success = connected, info =
     *     transferring, error = error, outlined otherwise). It morphs into a
     *     short pill while flashing (mark hidden, `%` for a determinate
     *     transfer or a spinner for an indeterminate phase).
     */
    appearance?: 'dark' | 'light' | 'icon';
    /**
     * Which calliope-ui theme the trigger is drawn in (`data-theme`). Defaults
     * to `light` for `appearance="light"` and `dark` otherwise (the pill and
     * icon triggers sit in dark headers); `inherit` follows the surrounding
     * `data-theme`. The dropdown panel follows the page, not the trigger.
     */
    theme?: 'light' | 'dark' | 'inherit';
    /** Translation overrides; defaults are German. */
    labels?: Partial<ConnectLabels>;
    /** Expose the pin / drag floating window + comms log (off by default). */
    advanced?: boolean;
  };

  let { appearance = 'dark', theme, labels: labelsProp, advanced = false }: Props = $props();
  const labels = $derived(mergeLabels(labelsProp));
  const dataTheme = $derived.by(() => {
    const t = theme ?? (appearance === 'light' ? 'light' : 'dark');
    return t === 'inherit' ? undefined : t;
  });

  const s = $derived($calliopeState);
  const recovery = $derived($calliopeUsbRecovery);
  const view = $derived(deriveConnectionView(s, recovery));
  // Fold the USB recovery ladder into the pill so the badge matches the global
  // connection banner: a dropped / not-yet-found USB reads as connecting
  // (reconnecting) or error, not a neutral "disconnected" grey.
  const displayStatus = $derived(
    view.recovering && !view.anyConnected
      ? (recovery === 'reconnecting' ? 'connecting' : 'error')
      : s.status,
  );
  const badgeLabel = $derived(
    view.recovering && !view.anyConnected
      ? (recovery === 'reconnecting' ? labels.connecting : labels.error)
      : statusLabel(s, labels),
  );

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
  const dotStatus = $derived.by<Status>(() => {
    switch (displayStatus) {
      case 'connected': return 'success';
      case 'flashing':
      case 'connecting': return 'info';
      case 'error': return 'error';
      default: return 'neutral';
    }
  });
  const pillTitle = $derived(
    effectivePinned ? labels.triggerTitle + ' (Fenster offen)' : labels.triggerTitle,
  );

  // Native (app) mode: the host app owns the connection, so the trigger — and
  // with it the whole panel / floating window — has nothing to offer. Render
  // nothing at all rather than an inert pill; the banner carries the status.
  const appMode = $derived(s.nativeMode);
</script>

{#snippet triggerButton(props: Record<string, unknown>)}
  {#if isIcon}
    <button
      type="button"
      {...props}
      class="conn-icon"
      data-status={displayStatus}
      class:flashing={isFlashing}
      title={badgeLabel}
      aria-label={badgeLabel}
    >
      {#if isFlashing}
        {#if isIndeterminate}
          <Spinner size="s" />
        {:else}
          <span class="pct">{s.flashProgress ?? 0}%</span>
          <span class="progress" style:width="{s.flashProgress ?? 0}%"></span>
        {/if}
      {:else if displayStatus === 'connecting'}
        <Spinner size="m" />
      {:else}
        <span class="calliope-mark" style:--mark={`url("${calliopeMark}")`} aria-hidden="true"></span>
      {/if}
    </button>
  {:else}
    <Button {...props} variant="secondary" size="s" title={pillTitle}>
      {#if isIndeterminate || displayStatus === 'connecting'}
        <span class="pill-busy"><Spinner size="s" />{badgeLabel}</span>
      {:else}
        <StatusDot status={dotStatus} label={badgeLabel} />
      {/if}
    </Button>
  {/if}
{/snippet}

{#if !appMode}
<div class="connect-wrap" data-theme={dataTheme} class:pinned-indicator={effectivePinned}>
  {#if effectivePinned}
    {@render triggerButton({
      onclick: () => (open = !open),
      'aria-haspopup': 'dialog',
      'aria-expanded': open,
    })}
  {:else}
    <Popover bind:open side="bottom" align="end" size={advanced ? 'l' : 'm'}>
      {#snippet trigger({ props })}
        {@render triggerButton(props)}
      {/snippet}
      <ConnectionPanel
        labels={labelsProp}
        embedded
        onaction={() => (open = false)}
        pinned={effectivePinned}
        onTogglePin={advanced ? togglePin : undefined}
        {advanced}
      />
    </Popover>
  {/if}
</div>

{#if open && effectivePinned}
  <div
    class="floating"
    role="dialog"
    aria-label={labels.panelTitle}
    style:left="{pos.x}px"
    style:top="{pos.y}px"
    style:width="{size.w}px"
    style:height="{size.h}px"
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
    ></div>
  </div>
{/if}
{/if}

<style>
  .connect-wrap {
    position: relative;
    display: inline-flex;
    border-radius: var(--cui-radius-full);
    /* calliope-ui's base layer paints every [data-theme] subtree with the page
       colour; the trigger sits on the host's own header instead. */
    background: none;
  }
  /* A brand-coloured ring so the user can tell their floating window is up
     even when it's behind another tab or scrolled away. */
  .connect-wrap.pinned-indicator {
    outline: var(--cui-border-width-accent) solid var(--cui-brand-default);
    outline-offset: var(--cui-border-width-hairline);
  }

  .pill-busy {
    display: inline-flex;
    align-items: center;
    gap: var(--cui-space-2);
  }

  /* ---- Icon trigger (appearance="icon") ---------------------------------- */

  .conn-icon {
    --_fill: transparent;
    --_on: var(--cui-text-default);
    --_border: var(--cui-border-control);

    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: var(--cui-size-control-m);
    height: var(--cui-size-control-m);
    padding: 0;
    overflow: hidden;
    border: var(--cui-border-width-hairline) solid var(--_border);
    border-radius: var(--cui-radius-full);
    background-color: var(--_fill);
    color: var(--_on);
    white-space: nowrap;
    cursor: pointer;
    transition:
      width var(--cui-duration-base) var(--cui-easing-standard),
      background-color var(--cui-duration-fast) var(--cui-easing-standard),
      color var(--cui-duration-fast) var(--cui-easing-standard);
  }
  .conn-icon:hover {
    background-image: linear-gradient(var(--cui-action-hover), var(--cui-action-hover));
  }

  /* Status fills with their paired mark colour (calliope-ui status roles). */
  .conn-icon[data-status='connected'] {
    --_fill: var(--cui-status-success-fill);
    --_on: var(--cui-status-success-on);
    --_border: var(--cui-status-success-fill);
  }
  .conn-icon[data-status='error'] {
    --_fill: var(--cui-status-error-fill);
    --_on: var(--cui-status-error-on);
    --_border: var(--cui-status-error-fill);
  }
  .conn-icon[data-status='flashing'] {
    --_fill: var(--cui-status-info-fill);
    --_on: var(--cui-status-info-on);
    --_border: var(--cui-status-info-fill);
  }

  .calliope-mark {
    width: 1.625rem;
    height: 1.625rem;
    background-color: currentColor;
    -webkit-mask: var(--mark) center / contain no-repeat;
    mask: var(--mark) center / contain no-repeat;
  }

  /* Transferring: the circle stretches into a short pill that shows the
     progress percentage (or a spinner during indeterminate phases). */
  .conn-icon.flashing {
    width: auto;
    min-width: 3.375rem;
    gap: var(--cui-space-1);
    padding: 0 var(--cui-space-3);
  }
  .pct {
    font-family: var(--cui-typography-label-font-family);
    font-size: var(--cui-typography-caption-font-size);
    font-weight: var(--cui-font-weight-semibold);
    font-variant-numeric: tabular-nums;
  }
  .progress {
    position: absolute;
    bottom: 0;
    left: 0;
    height: var(--cui-border-width-accent);
    background-color: currentColor;
    transition: width var(--cui-duration-base) var(--cui-easing-linear);
  }

  /* ---- Floating window ---------------------------------------------------- */

  .floating {
    position: fixed;
    z-index: var(--cui-z-index-overlay);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    min-width: 300px;
    min-height: 320px;
    overflow: hidden;
    border: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
    border-radius: var(--cui-radius-xl);
    background-color: var(--cui-surface-raised);
    box-shadow: var(--cui-shadow-dialog);
    color: var(--cui-text-default);
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
  /* Resize grip in the bottom-right corner: three diagonal strokes. */
  .floating-resize {
    position: absolute;
    right: var(--cui-space-0-5);
    bottom: var(--cui-space-0-5);
    z-index: 3;
    width: var(--cui-size-icon-s);
    height: var(--cui-size-icon-s);
    color: var(--cui-text-muted);
    background-image: linear-gradient(
      135deg,
      transparent 0 45%,
      currentColor 45% 52%,
      transparent 52% 64%,
      currentColor 64% 71%,
      transparent 71% 83%,
      currentColor 83% 90%,
      transparent 90%
    );
    cursor: nwse-resize;
    touch-action: none;
  }
  .floating-resize:hover {
    color: var(--cui-text-default);
  }
</style>
