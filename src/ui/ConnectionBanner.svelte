<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { CalliopeTransport } from '../state';
  import { calliopeState, getState } from '../state';
  import {
    calliopeUsbRecovery,
    reloadForUsbReconnect,
    consumeUsbReconnectAfterReload,
    armUsbRecovery,
    confirmReplug,
  } from '../usb-recovery';
  import { connectionBannerExtra, connectionUiActive } from '../connection-banner-extra';
  import { connectCalliope } from '../connect';
  import { deriveConnectionView, isIndeterminateFlash } from '../connection-view';

  /**
   * The single, app-wide light connection banner.
   *
   * One priority-ordered state machine so the user NEVER sees two competing
   * banners (this replaces both the old `UsbReconnectBanner` and the campus
   * `BlocksProgramBanner` chrome):
   *
   *   flashing            → hidden (the header badge shows flash progress)
   *   USB recovery active → the click → replug → reload ladder (goal 6)
   *   connecting          → "Verbinde…" spinner
   *   nothing connected   → USB (green) / Bluetooth (blue) choice (goal 4)
   *   connected + extra   → editor-fed content (Blocks flash prompt, etc.)
   *   else                → hidden
   *
   * Once a transport is connected we never nudge for the other one (goal 4):
   * the only thing shown on a healthy connection is editor `extra` content.
   *
   * Transport palette (kept in sync with the panel + choice modal):
   *   USB  = green  #98f600 (dark text)
   *   BLE  = blue   #2f80ed (white text)
   *
   * `container`: optional element to portal the banner into (e.g. an editor's
   * content area). When set, the banner renders INSIDE it, positioned near the
   * top, so it lives within the editor instead of as a page-level toast. The
   * element should establish a positioning context (`position: relative`). When
   * omitted, the banner is a fixed top-centre toast. Lets each host place the
   * one banner wherever fits.
   */

  type Props = { container?: HTMLElement | null };
  let { container = null }: Props = $props();

  const s = $derived($calliopeState);
  const recovery = $derived($calliopeUsbRecovery);
  const view = $derived(deriveConnectionView(s, recovery));
  const extra = $derived($connectionBannerExtra);
  const uiActive = $derived($connectionUiActive);

  let connecting = $state(false);
  let extraBusy = $state(false);
  // Brief green "verbunden ✓" the moment EITHER transport connects — so adding a
  // second transport (e.g. Bluetooth while USB is already up) gives explicit
  // feedback even though the badge was already green. Tracked per-transport so a
  // newly-added transport flashes success, not just the first connection.
  let successActive = $state(false);
  let prevUsbConnected = false;
  let prevBleConnected = false;
  let successTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const usbC = view.usb.connected;
    const bleC = view.ble.connected;
    if ((usbC && !prevUsbConnected) || (bleC && !prevBleConnected)) {
      successActive = true;
      if (successTimer) clearTimeout(successTimer);
      successTimer = setTimeout(() => { successActive = false; }, 1600);
    } else if (!usbC && !bleC) {
      successActive = false;
    }
    prevUsbConnected = usbC;
    prevBleConnected = bleC;
  });
  onDestroy(() => { if (successTimer) clearTimeout(successTimer); });

  // Transport-aware copy for the connecting + success states. (The `connecting`
  // kind only fires for BLE or native — USB connects show via the recovery
  // ladder — so this is Bluetooth/native.)
  const connectingLabel = $derived(view.nativeMode ? 'Verbinde über App…' : 'Verbinde per Bluetooth…');
  const successLabel = $derived(
    view.usb.connected && view.ble.connected ? 'USB + Bluetooth verbunden'
    : view.usb.connected ? 'USB verbunden'
    : view.ble.connected ? 'Bluetooth verbunden'
    : 'Calliope mini verbunden',
  );
  // The exact banner content the user dismissed (a content signature — see
  // `bannerKey`). Cleared whenever the banner would otherwise be hidden, so a
  // genuinely new situation always re-shows.
  let dismissedKey = $state<string | null>(null);

  // Post-reload (the `reload` rung reloaded us): resume the ladder so the
  // reload doesn't feel inert. The daemon silently re-grabs the still-permitted
  // device; if it doesn't land, the ladder steps back up to "Verbinden".
  onMount(() => {
    if (consumeUsbReconnectAfterReload() && getState().usbStatus !== 'connected') {
      armUsbRecovery('reconnecting');
    }
  });

  type BannerKind = 'hidden' | 'flashing' | 'recovery' | 'jlink-serial-pick' | 'connecting' | 'no-connection' | 'unsupported' | 'extra' | 'success';

  // Flash phase → German label / progress.
  const flashIndeterminate = $derived(isIndeterminateFlash(s));
  const flashPct = $derived(s.flashProgress ?? 0);
  const flashPhaseLabel = $derived.by<string>(() => {
    switch (s.flashPhase) {
      case 'check': return 'Wird geprüft…';
      case 'reboot': return 'Neustart…';
      case 'prepare': return 'Wird vorbereitet…';
      case 'finalising': return 'Wird abgeschlossen…';
      default: return `${flashPct}%`;
    }
  });

  const kind = $derived.by<BannerKind>(() => {
    // These follow a real event — flash in progress, a lost/failed session, or a
    // connect in flight — so they show in ANY editor (and on any page), never
    // silently swallowed.
    if (view.flashing) return 'flashing';
    if (view.recovering) return 'recovery';
    // Mini 2, second browser dialog (Web Serial / CDC port) is open — the
    // native picker floats above the page, so say which phase this is and
    // that cancelling is harmless (flash-only still works).
    if (s.jlinkSerialStatus === 'connecting') return 'jlink-serial-pick';
    // A BLE connect in flight — show progress even if USB is already connected
    // (e.g. adding Bluetooth while USB is up). USB connects show progress via the
    // recovery ladder instead (connectCalliope('usb') arms it), so we DON'T key
    // on usb.connecting here — that would surface the daemon's silent USB retry
    // grind as a flickering "Verbinde…" on every page.
    if (view.ble.connecting || (view.nativeMode && !view.anyConnected)) {
      return 'connecting';
    }
    if (!view.anyConnected) {
      // The PROACTIVE "choose a connection" prompt only makes sense where a
      // device is the point — an editor flips on uiActive (Blocks). Elsewhere we
      // stay quiet until something actually happens (the cases above).
      if (uiActive) {
        if (!view.usb.supported && !view.ble.supported) return 'unsupported';
        return 'no-connection';
      }
      return 'hidden';
    }
    // Connected. A follow-up step (Blocks detect / flash prompt) is itself the
    // feedback, so it wins; otherwise flash a brief success so a connect — incl.
    // adding a 2nd transport when the other was already up — is acknowledged
    // instead of the banner just staying hidden.
    if (extra) return 'extra';
    if (successActive) return 'success';
    return 'hidden';
  });

  // A signature of the current content. The X dismisses THIS signature; a
  // different situation (new recovery rung, new extra id, …) has a different
  // signature and re-shows. Ids like `blocks:not-blocks:0` repeat across
  // un-flashed devices, but `dismissedKey` resets whenever the banner goes
  // hidden (e.g. on disconnect), so a dismissal never leaks to the next episode.
  const bannerKey = $derived.by<string>(() => {
    switch (kind) {
      case 'flashing': return 'flashing';
      case 'success': return 'success';
      case 'recovery': return `recovery:${recovery}`;
      case 'jlink-serial-pick': return 'jlink-serial-pick';
      case 'connecting': return 'connecting';
      case 'no-connection': return 'no-connection';
      case 'unsupported': return 'unsupported';
      case 'extra': return extra ? `extra:${extra.id}` : 'extra';
      default: return 'hidden';
    }
  });

  const visible = $derived(kind !== 'hidden' && bannerKey !== dismissedKey);

  // Reappear after a dismissal whenever the connection SITUATION changes — a
  // transport status / recovery rung / flash / editor-content transition means
  // it makes sense to show again (user request). A plain X with no underlying
  // change keeps it hidden. Tracked as a signature so any of those resets it.
  let lastConnSig: string | undefined = undefined;
  $effect(() => {
    const sig = `${s.usbStatus}|${s.jlinkSerialStatus}|${s.jlinkUsbStatus}|${s.bleStatus}|${recovery}|${s.flashTransport ?? ''}|${s.lastFlashAt ?? 0}|${extra?.id ?? ''}`;
    if (sig !== lastConnSig) {
      lastConnSig = sig;
      dismissedKey = null;
    }
  });

  // Loading / neutral tone (spinner, grey) vs an attention tone (accent border).
  const neutral = $derived(
    kind === 'connecting'
    || kind === 'flashing'
    || kind === 'jlink-serial-pick'
    || (kind === 'recovery' && recovery === 'reconnecting')
    || (kind === 'extra' && extra?.tone === 'loading'),
  );

  async function connect(transport: CalliopeTransport): Promise<void> {
    if (connecting) return;
    connecting = true;
    try {
      await connectCalliope(transport);
    } finally {
      connecting = false;
    }
  }

  // The `replug` rung's "Erneut verbinden": confirm the re-plug (→ back to the
  // waiting stage; the flow will offer reload only if THIS retry fails) and fire
  // the actual connect alongside it.
  async function confirmAndRetry(): Promise<void> {
    if (connecting) return;
    confirmReplug();
    await connect('usb');
  }

  async function runExtra(): Promise<void> {
    if (!extra?.action || extraBusy) return;
    extraBusy = true;
    try {
      await extra.action.run();
    } finally {
      extraBusy = false;
    }
  }

  function dismiss(): void {
    dismissedKey = bannerKey;
  }

  // Portal the banner into `container` when provided, else keep it where it is
  // (a fixed top-centre toast). A placeholder comment marks the home position so
  // the node can be restored if the container goes away. No external dependency.
  function portal(node: HTMLElement, target?: HTMLElement | null) {
    const placeholder = document.createComment('connection-banner');
    node.parentNode?.insertBefore(placeholder, node);
    const place = (t?: HTMLElement | null) => {
      if (t) t.appendChild(node);
      else placeholder.parentNode?.insertBefore(node, placeholder.nextSibling);
    };
    place(target);
    return {
      update: (t?: HTMLElement | null) => place(t),
      destroy: () => {
        node.remove();
        placeholder.remove();
      },
    };
  }
</script>

{#if visible}
  <div class="banner" class:neutral class:success={kind === 'success'} class:portaled={!!container} use:portal={container} role="status" aria-live="polite">
    {#if kind === 'success'}
      <span class="icon check" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
    {:else if neutral}
      <span class="spinner" aria-hidden="true"></span>
    {:else}
      <span class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 7V4h6v3" />
          <path d="M8 7h8v6a4 4 0 0 1-8 0V7z" />
          <path d="M12 17v3" />
        </svg>
      </span>
    {/if}

    <div class="text">
      {#if kind === 'success'}
        <strong>{successLabel}</strong>
      {:else if kind === 'flashing'}
        <strong>Programm wird übertragen…</strong>
        <span>{flashPhaseLabel}</span>
      {:else if kind === 'recovery'}
        {#if recovery === 'reconnecting'}
          <strong>Verbinde mit dem Calliope mini…</strong>
        {:else if recovery === 'replug'}
          <strong>Calliope mini neu verbinden.</strong>
          <span>Zieh den Calliope mini einmal vom USB-Kabel ab und steck ihn wieder ein — schließe ggf. andere Tabs, die ihn nutzen. Klicke dann auf „Erneut verbinden“.</span>
        {:else}
          <strong>Das hat nicht geholfen.</strong>
          <span>Lade die Seite neu, um die USB-Verbindung zurückzusetzen. Dein Calliope mini bleibt verbunden.</span>
        {/if}
      {:else if kind === 'jlink-serial-pick'}
        <strong>USB verbunden (1/2)</strong>
        <span>Wähle jetzt noch „CDC – COM x“, um die Datenverbindung (Serial) herzustellen. Abbrechen ist okay: Programme übertragen geht auch ohne.</span>
      {:else if kind === 'connecting'}
        <strong>{connectingLabel}</strong>
      {:else if kind === 'no-connection'}
        <strong>Kein Calliope mini verbunden.</strong>
        <span>Verbinde deinen Calliope mini per USB-Kabel oder Bluetooth, um zu starten.</span>
      {:else if kind === 'unsupported'}
        <strong>Verbindung nicht möglich.</strong>
        <span>In diesem Browser ist weder USB noch Bluetooth verfügbar. Bitte einen Chromium-Browser (Chrome, Edge, Opera, Brave) verwenden.</span>
      {:else if kind === 'extra' && extra}
        <strong>{extra.title}</strong>
        {#if extra.detail}<span>{extra.detail}</span>{/if}
      {/if}
    </div>

    <div class="actions">
      {#if kind === 'recovery'}
        {#if recovery === 'replug'}
          <button type="button" class="btn usb" onclick={confirmAndRetry} disabled={connecting}>
            {connecting ? 'Verbinde…' : 'Erneut verbinden'}
          </button>
        {:else if recovery === 'reload'}
          <button type="button" class="btn usb" onclick={reloadForUsbReconnect}>Seite neu laden</button>
        {/if}
      {:else if kind === 'no-connection'}
        {#if view.usb.supported}
          <button type="button" class="btn usb" onclick={() => connect('usb')} disabled={connecting}>
            {connecting ? 'Verbinde…' : 'USB verbinden'}
          </button>
        {/if}
        {#if view.ble.supported}
          <button type="button" class="btn ble" onclick={() => connect('ble')} disabled={connecting}>
            {connecting ? 'Verbinde…' : 'Bluetooth verbinden'}
          </button>
        {/if}
      {:else if kind === 'extra' && extra}
        {#if extra.action}
          <button
            type="button"
            class="btn"
            class:usb={extra.action.variant !== 'ble'}
            class:ble={extra.action.variant === 'ble'}
            onclick={runExtra}
            disabled={extraBusy}
          >
            {extraBusy ? (extra.action.busyLabel ?? 'Bitte warten…') : extra.action.label}
          </button>
        {/if}
      {/if}
    </div>

    <!-- Always offer a quiet way to hide the banner. -->
    <button type="button" class="close" aria-label="Ausblenden" title="Ausblenden" onclick={dismiss}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>

    {#if kind === 'flashing' && !flashIndeterminate}
      <span class="flash-bar" aria-hidden="true" style="width: {flashPct}%"></span>
    {/if}
  </div>
{/if}

<style lang="scss">
  .banner {
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 8000;
    overflow: hidden; // clip the flash progress bar to the rounded corners
    // Portaled into a host element (an editor area): sit inside it near the top
    // rather than floating over the whole page. The host element provides the
    // positioning context.
    &.portaled {
      position: absolute;
      top: 12px;
    }
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: min(720px, calc(100vw - 32px));
    padding: 12px 14px;
    border-radius: 12px;
    background: #fff;
    color: #1b1c1d;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.18);
    font-size: 13px;
    line-height: 1.35;
    // Success — a brief, fully-green confirmation that we connected.
    &.success {
      background: #2fb344;
      color: #fff;
      .text strong { color: #fff; }
      .icon.check { color: #fff; }
    }
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .text strong { font-weight: 600; }
  .text span { color: #4b5563; }
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
    border: 2px solid rgba(0, 0, 0, 0.18);
    border-top-color: #1b1c1d;
    animation: connbanner-spin 0.8s linear infinite;
  }
  @keyframes connbanner-spin {
    to { transform: rotate(360deg); }
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .btn {
    flex-shrink: 0;
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    white-space: nowrap;
    // USB = green
    &.usb {
      background: #98f600;
      color: #1b1c1d;
      &:hover:not(:disabled) { background: #aaff1f; }
    }
    // BLE = blue
    &.ble {
      background: #2f80ed;
      color: #fff;
      &:hover:not(:disabled) { background: #2670d8; }
    }
    &:disabled { opacity: 0.55; cursor: default; }
  }
  // Flash transfer progress — a thin bar pinned to the banner's bottom edge.
  .flash-bar {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 3px;
    background: #00b8cc;
    transition: width 0.2s linear;
  }
  // Always-present quiet hide affordance.
  .close {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #6b7280;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    &:hover {
      background: rgba(0, 0, 0, 0.06);
      color: #1b1c1d;
    }
  }
</style>
