<script lang="ts">
  import { onMount } from 'svelte';
  import { calliopeState, getState } from '../state';
  import { connectCalliope } from '../connect';
  import { consumeUsbReconnectAfterReload } from '../usb-error-info';

  /**
   * Post-reload USB reconnect affordance. Shown only when the page was
   * reloaded via `reloadForUsbReconnect()` (the "Kabel eingesteckt – neu
   * laden" action in `<UsbErrorModal />`).
   *
   * Flow:
   *  - `reconnecting`: the reconnect daemon silently re-grabs the still-
   *    permitted device via `navigator.usb.getDevices()` — no picker, no
   *    user gesture. We just show "Verbinde wieder…" so the reload doesn't
   *    feel like nothing happened. The instant `usbStatus` flips to
   *    `connected`, this banner disappears for good (one-shot).
   *  - `fallback`: if the daemon hasn't reconnected within the grace window
   *    (cable still unplugged, or permission was lost), we surface a
   *    "Jetzt verbinden" button. WebUSB's `requestDevice()` needs a user
   *    gesture, so the connect must come from this click — it can't be
   *    auto-fired after a reload.
   */

  // Daemon's first USB attempt lands ~1.25s after load, plus connect time.
  // 7s gives a replugged-but-slow device room before we nag with a button.
  const GRACE_MS = 7_000;

  let visible = $state(false);
  let phase = $state<'reconnecting' | 'fallback'>('reconnecting');
  let connecting = $state(false);

  onMount(() => {
    if (!consumeUsbReconnectAfterReload()) return;
    // Already reconnected by the time we mounted? Nothing to show.
    if (getState().usbStatus === 'connected') return;
    visible = true;

    // Latch off the moment USB connects (daemon or our own connect). Only ever
    // sets `false`, so a later mid-session disconnect can't re-pop the banner.
    const unsub = calliopeState.subscribe((s) => {
      if (s.usbStatus === 'connected') visible = false;
    });
    const t = setTimeout(() => {
      if (visible && getState().usbStatus !== 'connected') phase = 'fallback';
    }, GRACE_MS);

    return () => {
      unsub();
      clearTimeout(t);
    };
  });

  async function connectNow(): Promise<void> {
    if (connecting) return;
    connecting = true;
    try {
      // Plain connect: reuses a still-permitted device silently, otherwise the
      // lib opens the picker (allowed — this runs inside a click gesture). On
      // success the subscription above hides the banner.
      await connectCalliope('usb');
    } finally {
      connecting = false;
    }
  }

  function dismiss(): void {
    visible = false;
  }
</script>

{#if visible}
  <div class="banner" class:fallback={phase === 'fallback'} role="status" aria-live="polite">
    {#if phase === 'reconnecting'}
      <span class="spinner" aria-hidden="true"></span>
      <span class="text">Verbinde wieder mit dem Calliope…</span>
    {:else}
      <span class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 7V4h6v3" />
          <path d="M8 7h8v6a4 4 0 0 1-8 0V7z" />
          <path d="M12 17v3" />
        </svg>
      </span>
      <span class="text">Calliope noch nicht gefunden. USB-Kabel eingesteckt?</span>
      <button type="button" class="connect" onclick={connectNow} disabled={connecting}>
        {connecting ? 'Verbinde…' : 'Jetzt verbinden'}
      </button>
    {/if}
    <button type="button" class="close" aria-label="Schließen" onclick={dismiss}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  </div>
{/if}

<style lang="scss">
  .banner {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 8000;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: calc(100vw - 32px);
    padding: 10px 12px 10px 14px;
    border-radius: 10px;
    background: #1b1c1d;
    color: #fff;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
    font-size: 13px;
    line-height: 1.3;
    &.fallback {
      background: #fff;
      color: #1b1c1d;
      border: 1px solid #e5e7eb;
    }
  }
  .text {
    font-weight: 500;
  }
  .icon {
    color: #e53f4b;
    display: flex;
    flex-shrink: 0;
  }
  .spinner {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
    animation: usb-reconnect-spin 0.8s linear infinite;
  }
  @keyframes usb-reconnect-spin {
    to { transform: rotate(360deg); }
  }
  .connect {
    flex-shrink: 0;
    padding: 6px 12px;
    border-radius: 7px;
    border: none;
    background: #00b8cc;
    color: #fff;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
    &:hover:not(:disabled) { background: #00a3b5; }
    &:disabled { opacity: 0.6; cursor: default; }
  }
  .close {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: currentColor;
    opacity: 0.6;
    cursor: pointer;
    &:hover { opacity: 1; }
  }
</style>
