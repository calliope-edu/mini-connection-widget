<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Button, Icon, IconButton, ProgressBar, Spinner, type IconName } from '@calliope-edu/ui';
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
  import { connectCalliope, disconnectAndForget } from '../connect';
  import { deriveConnectionView, isIndeterminateFlash } from '../connection-view';
  import { extractFriendlyName } from '../friendly-name';
  import MiniNamePattern from './MiniNamePattern.svelte';

  // Animated illustration of the unplug → replug action, shown only on the
  // `replug` rung. Resolved via `import.meta.url` so it survives being bundled
  // from node_modules by the host (Vite) — no ambient `.gif` type needed.
  const reconnectGif = new URL('../assets/device-reconnect.gif', import.meta.url).href;

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
   * Look: calliope-ui `Banner` (status colour as a left stripe and an icon
   * disc, never as a tinted background), rebuilt here because the leading
   * slot also shows a spinner, the target mini's LED pattern or the replug
   * illustration, and the banner keeps its own fixed / portaled positioning.
   * Transports carry no colour of their own: green and blue are status
   * colours in calliope-ui, so USB and Bluetooth buttons are neutral with an
   * icon.
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

  // Startup grace: on a page reload the editor flips `uiActive` on before the
  // reconnect daemon has had a chance to re-grab a remembered device, so the
  // proactive "Kein Calliope mini verbunden" prompt would flash for a moment.
  // Suppress ONLY that prompt for ~2s after uiActive first turns on. One-way
  // (never reset), so a genuine mid-session disconnect shows the prompt
  // immediately; reactive states (recovery/connecting/extra) are earlier
  // branches and are never delayed.
  let graceElapsed = $state(false);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    if (uiActive && !graceElapsed && graceTimer === null) {
      graceTimer = setTimeout(() => { graceElapsed = true; }, 2000);
    }
  });
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
  onDestroy(() => {
    if (successTimer) clearTimeout(successTimer);
    if (graceTimer) clearTimeout(graceTimer);
  });

  // Transport-aware copy for the connecting + success states. (The `connecting`
  // kind only fires for BLE or native — USB connects show via the recovery
  // ladder — so this is Bluetooth/native.)
  const connectingLabel = $derived(view.nativeMode ? 'Verbinde über App…' : 'Verbinde per Bluetooth…');
  // The mini being connected: the drawn-pattern target, else a captured friendly
  // name, else one parsed from the advertised BLE name. Drives the name + LED
  // pattern shown in the connecting banner. MiniNamePattern renders nothing for
  // a non-CVCVC name, so unknown-name connects safely fall back to the spinner.
  const targetName = $derived(s.connectTargetName ?? s.friendlyName ?? extractFriendlyName(s.bleDeviceName));
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
        // Startup grace — let the reconnect daemon re-grab a remembered device
        // before we tell the user nothing is connected.
        if (!graceElapsed) return 'hidden';
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

  type Tone = 'info' | 'success' | 'warning' | 'error';
  const tone = $derived.by<Tone>(() => {
    if (kind === 'success') return 'success';
    if (kind === 'unsupported') return 'error';
    if (kind === 'recovery') {
      if (recovery === 'replug') return 'warning';
      if (recovery === 'reload') return 'error';
    }
    return 'info';
  });
  const toneIcon: Record<Tone, IconName> = {
    info: 'info',
    success: 'check',
    warning: 'warning',
    error: 'error',
  };
  // Extra actions name their transport only when the editor says so.
  function actionIcon(variant: 'usb' | 'ble' | undefined): IconName | undefined {
    return variant === 'ble' ? 'bluetooth' : variant === 'usb' ? 'usb' : undefined;
  }

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

  // Give up on an in-flight BLE connect from the banner. Forgetting the device
  // (disconnectAndForget) sets userDisconnectedBle — which stops the retry loop
  // + reconnect daemon — and clears the browser grant, so the NEXT "Verbinden"
  // opens a fresh picker instead of silently resuming the same (wrong) device.
  async function cancelConnecting(): Promise<void> {
    await disconnectAndForget('ble');
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

  let extraSecondaryBusy = $state(false);
  async function runExtraSecondary(): Promise<void> {
    if (!extra?.secondaryAction || extraSecondaryBusy) return;
    extraSecondaryBusy = true;
    try {
      await extra.secondaryAction.run();
    } finally {
      extraSecondaryBusy = false;
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
  <div
    class="banner"
    data-tone={tone}
    class:illustrated={kind === 'recovery' && recovery === 'replug'}
    class:portaled={!!container}
    use:portal={container}
    role="status"
    aria-live="polite"
  >
    <span class="lead" aria-hidden="true">
      {#if kind === 'connecting' && targetName}
        <!-- Show the target mini's LED name-pattern so the user can confirm which
             device is being connected. -->
        <MiniNamePattern name={targetName} size={28} />
      {:else if neutral}
        <Spinner size="m" />
      {:else if kind === 'recovery' && recovery === 'replug'}
        <!-- Show the unplug/replug motion right where the icon would be, so
             the instruction and the illustration read as one unit. -->
        <img class="reconnect-gif" src={reconnectGif} alt="" />
      {:else}
        <span class="disc"><Icon name={toneIcon[tone]} size="s" /></span>
      {/if}
    </span>

    <div class="text">
      {#if kind === 'success'}
        <strong>{successLabel}</strong>
      {:else if kind === 'flashing'}
        <ProgressBar
          label="Programm wird übertragen…"
          value={flashIndeterminate ? null : flashPct}
          hint={flashIndeterminate ? flashPhaseLabel : undefined}
        />
      {:else if kind === 'recovery'}
        {#if recovery === 'reconnecting'}
          <strong>Verbinde mit dem Calliope mini…</strong>
        {:else if recovery === 'replug'}
          <strong>Calliope mini neu verbinden.</strong>
          <span>Zieh den Calliope mini einmal vom USB-Kabel ab und steck ihn wieder ein. Schließe ggf. andere Tabs, die ihn nutzen. Klicke dann auf „Erneut verbinden“.</span>
        {:else}
          <strong>Das hat nicht geholfen.</strong>
          <span>Lade die Seite neu, um die USB-Verbindung zurückzusetzen. Dein Calliope mini bleibt verbunden.</span>
        {/if}
      {:else if kind === 'jlink-serial-pick'}
        <strong>USB verbunden (1/2)</strong>
        <span>Wähle jetzt noch „CDC – COM x“, um die Datenverbindung (Serial) herzustellen. Abbrechen ist okay: Programme übertragen geht auch ohne.</span>
      {:else if kind === 'connecting'}
        <strong>{connectingLabel}</strong>
        {#if targetName}<span>Calliope mini {targetName}</span>{/if}
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

    {#if kind === 'recovery' || (kind === 'connecting' && !view.nativeMode) || kind === 'no-connection' || (kind === 'extra' && (extra?.action || extra?.secondaryAction))}
      <div class="actions">
        {#if kind === 'recovery'}
          {#if recovery === 'replug'}
            <Button size="s" variant="secondary" icon="retry" onclick={confirmAndRetry} loading={connecting}>
              Erneut verbinden
            </Button>
          {:else if recovery === 'reload'}
            <Button size="s" variant="secondary" icon="retry" onclick={reloadForUsbReconnect}>Seite neu laden</Button>
          {/if}
        {:else if kind === 'connecting'}
          <!-- Abort an in-flight BLE connect. Forgets the device so the NEXT
               "Verbinden" opens a fresh picker (switch minis) instead of silently
               resuming the same one.
               Native (app) mode has no such button: the host app owns the
               connection, so there is nothing here to cancel — only the X to
               hide the banner. -->
          <Button size="s" variant="secondary" onclick={cancelConnecting}>Abbrechen</Button>
        {:else if kind === 'no-connection'}
          {#if view.usb.supported}
            <Button size="s" variant="secondary" icon="usb" onclick={() => connect('usb')} disabled={connecting}>
              USB verbinden
            </Button>
          {/if}
          {#if view.ble.supported}
            <Button size="s" variant="secondary" icon="bluetooth" onclick={() => connect('ble')} disabled={connecting}>
              Bluetooth verbinden
            </Button>
          {/if}
        {:else if extra}
          {#if extra.action}
            <Button
              size="s"
              variant="secondary"
              icon={actionIcon(extra.action.variant)}
              onclick={runExtra}
              disabled={extraBusy || extraSecondaryBusy}
            >
              {extraBusy ? (extra.action.busyLabel ?? 'Bitte warten…') : extra.action.label}
            </Button>
          {/if}
          {#if extra.secondaryAction}
            <Button
              size="s"
              variant="secondary"
              icon={actionIcon(extra.secondaryAction.variant)}
              onclick={runExtraSecondary}
              disabled={extraBusy || extraSecondaryBusy}
            >
              {extraSecondaryBusy ? (extra.secondaryAction.busyLabel ?? 'Bitte warten…') : extra.secondaryAction.label}
            </Button>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Always offer a quiet way to hide the banner. -->
    <div class="close">
      <IconButton icon="close" label="Ausblenden" size="s" onclick={dismiss} />
    </div>
  </div>
{/if}

<style>
  .banner {
    --_fill: var(--cui-status-info-fill);
    --_on: var(--cui-status-info-on);

    position: fixed;
    top: var(--cui-space-4);
    left: 50%;
    transform: translateX(-50%);
    /* Over the page and its header, under dialogs and the connection popover. */
    z-index: var(--cui-z-index-overlay);
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: var(--cui-space-3);
    width: max-content;
    max-width: min(45rem, calc(100vw - 2 * var(--cui-space-4)));
    padding: var(--cui-space-3) var(--cui-space-3) var(--cui-space-3) var(--cui-space-4);
    border: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
    border-left: 4px solid var(--_fill);
    border-radius: var(--cui-radius-lg);
    background-color: var(--cui-surface-raised);
    box-shadow: var(--cui-shadow-menu);
    color: var(--cui-text-default);
    font-family: var(--cui-typography-body-font-family);
    font-size: var(--cui-typography-label-font-size);
    line-height: var(--cui-typography-body-line-height);
  }
  /* Portaled into a host element (an editor area): sit inside it near the top
     rather than floating over the whole page. The host element provides the
     positioning context. */
  .banner.portaled {
    position: absolute;
    top: var(--cui-space-3);
  }
  .banner[data-tone='success'] {
    --_fill: var(--cui-status-success-fill);
    --_on: var(--cui-status-success-on);
  }
  .banner[data-tone='warning'] {
    --_fill: var(--cui-status-warning-fill);
    --_on: var(--cui-status-warning-on);
  }
  .banner[data-tone='error'] {
    --_fill: var(--cui-status-error-fill);
    --_on: var(--cui-status-error-on);
  }

  .lead {
    display: inline-grid;
    flex: none;
    place-items: center;
  }
  /* 24px disc with the paired mark colour, as in calliope-ui Banner. */
  .disc {
    display: inline-grid;
    place-items: center;
    width: var(--cui-size-icon-l);
    height: var(--cui-size-icon-l);
    border-radius: var(--cui-radius-full);
    background-color: var(--_fill);
    color: var(--_on);
  }
  /* The replug illustration takes the leading slot. The source gif is large
     (≈991×920), so cap it to a small square box (6.5rem), keeping the toast
     well-proportioned. No frame/background: the artwork sits on the banner. */
  .reconnect-gif {
    width: 6.5rem;
    height: 6.5rem;
    object-fit: contain;
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--cui-space-0-5);
    min-width: 0;
  }
  .text strong {
    font-weight: var(--cui-font-weight-semibold);
  }
  .text span {
    color: var(--cui-text-muted);
  }
  .text :global(.cui-progress-bar) {
    min-width: 18rem;
  }

  .actions {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--cui-space-2);
  }
  .close {
    flex: none;
    align-self: flex-start;
  }

  /* Narrow toast: the illustration + button + text don't fit on one row, so
     stack them (illustration → text → full-width button). Only the
     illustrated (replug) banner is affected; every other state stays a row. */
  @media (max-width: 520px) {
    .banner.illustrated {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--cui-space-2);
    }
    .banner.illustrated .actions {
      align-self: stretch;
    }
    .banner.illustrated .actions > :global(*) {
      flex: 1;
    }
    /* Keep the hide affordance out of the flow so it stays pinned top-right
       instead of dropping to a lonely row of its own. */
    .banner.illustrated .close {
      position: absolute;
      top: var(--cui-space-2);
      right: var(--cui-space-2);
    }
  }
</style>
