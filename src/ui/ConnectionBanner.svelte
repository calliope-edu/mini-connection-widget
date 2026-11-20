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
  import { connectLabels } from './labels';

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
   * Look: built from calliope-ui parts and tokens. A heading row holds an
   * optional status icon (a disc in the status colour, a spinner while busy,
   * or the target mini's LED pattern), the headline and the X; the message
   * row below holds the text with its buttons centred on it. No side stripe
   * and no tinted background. The banner keeps its own fixed / portaled
   * positioning.
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
  const labels = $derived($connectLabels);

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
  const connectingLabel = $derived(view.nativeMode ? labels.bannerConnectingApp : labels.bannerConnectingBle);
  // The mini being connected: the drawn-pattern target, else a captured friendly
  // name, else one parsed from the advertised BLE name. Drives the name + LED
  // pattern shown in the connecting banner. MiniNamePattern renders nothing for
  // a non-CVCVC name, so unknown-name connects safely fall back to the spinner.
  const targetName = $derived(s.connectTargetName ?? s.friendlyName ?? extractFriendlyName(s.bleDeviceName));
  const successLabel = $derived(
    view.usb.connected && view.ble.connected ? labels.bannerConnectedBoth
    : view.usb.connected ? labels.bannerConnectedUsb
    : view.ble.connected ? labels.bannerConnectedBle
    : labels.bannerConnectedAny,
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

  // Flash phase → label / progress.
  const flashIndeterminate = $derived(isIndeterminateFlash(s));
  const flashPct = $derived(s.flashProgress ?? 0);
  const flashPhaseLabel = $derived.by<string>(() => {
    switch (s.flashPhase) {
      case 'check': return labels.bannerPhaseCheck;
      case 'reboot': return labels.bannerPhaseReboot;
      case 'prepare': return labels.bannerPhasePrepare;
      case 'finalising': return labels.bannerPhaseFinalising;
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
  // Info needs no icon: the headline says it. Success, warning and error
  // carry their status disc.
  const showToneIcon = $derived(tone !== 'info');
  const illustrated = $derived(kind === 'recovery' && recovery === 'replug');

  const title = $derived.by<string>(() => {
    switch (kind) {
      case 'success': return successLabel;
      case 'flashing': return labels.bannerFlashing;
      case 'recovery':
        if (recovery === 'reconnecting') return labels.bannerReconnecting;
        if (recovery === 'replug') return labels.bannerReplugTitle;
        return labels.bannerReloadTitle;
      case 'jlink-serial-pick': return labels.bannerSerialPickTitle;
      case 'connecting': return connectingLabel;
      case 'no-connection': return labels.bannerNoConnectionTitle;
      case 'unsupported': return labels.bannerUnsupportedTitle;
      case 'extra': return extra?.title ?? '';
      default: return '';
    }
  });
  const detail = $derived.by<string | undefined>(() => {
    switch (kind) {
      case 'recovery':
        if (recovery === 'replug') return labels.bannerReplugText;
        if (recovery === 'reload') return labels.bannerReloadText;
        return undefined;
      case 'jlink-serial-pick': return labels.bannerSerialPickText;
      case 'connecting': return targetName ? `Calliope mini ${targetName}` : undefined;
      case 'no-connection': return labels.bannerNoConnectionText;
      case 'unsupported': return labels.unsupportedHint;
      case 'extra': return extra?.detail;
      default: return undefined;
    }
  });
  const hasActions = $derived(
    (kind === 'recovery' && (recovery === 'replug' || recovery === 'reload'))
    || (kind === 'connecting' && !view.nativeMode)
    || (kind === 'no-connection' && (view.usb.supported || view.ble.supported))
    || (kind === 'extra' && !!(extra?.action || extra?.secondaryAction)),
  );

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
    class:portaled={!!container}
    use:portal={container}
    role="status"
    aria-live="polite"
  >
    <!-- Heading row: an optional status icon, the headline, the X. -->
    <div class="head">
      {#if kind === 'connecting' && targetName}
        <!-- The target mini's LED name-pattern, so the user can confirm which
             device is being connected. -->
        <span class="lead" aria-hidden="true"><MiniNamePattern name={targetName} size={20} /></span>
      {:else if neutral && kind !== 'flashing'}
        <span class="lead" aria-hidden="true"><Spinner size="s" /></span>
      {:else if showToneIcon}
        <span class="lead disc" aria-hidden="true"><Icon name={toneIcon[tone]} size="s" /></span>
      {/if}
      <strong class="title">{title}</strong>
      <span class="close">
        <IconButton icon="close" label={labels.dismiss} size="s" onclick={dismiss} />
      </span>
    </div>

    {#if detail || kind === 'flashing' || hasActions || illustrated}
      <!-- Text row: the message, with its buttons centred on it. -->
      <div class="row">
        {#if illustrated}
          <!-- The unplug/replug motion beside the instruction, so the two read
               as one unit. -->
          <img class="reconnect-gif" src={reconnectGif} alt="" aria-hidden="true" />
        {/if}
        <div class="text">
          {#if kind === 'flashing'}
            <ProgressBar
              label={flashIndeterminate ? flashPhaseLabel : labels.flashing}
              value={flashIndeterminate ? null : flashPct}
            />
          {:else if detail}
            {detail}
          {/if}
        </div>

        {#if hasActions}
          <div class="actions">
            {#if kind === 'recovery'}
              {#if recovery === 'replug'}
                <Button size="s" variant="secondary" icon="retry" onclick={confirmAndRetry} loading={connecting}>
                  {labels.reconnect}
                </Button>
              {:else if recovery === 'reload'}
                <Button size="s" variant="secondary" icon="retry" onclick={reloadForUsbReconnect}>{labels.bannerReloadButton}</Button>
              {/if}
            {:else if kind === 'connecting'}
              <!-- Abort an in-flight BLE connect. Forgets the device so the NEXT
                   "Verbinden" opens a fresh picker (switch minis) instead of silently
                   resuming the same one.
                   Native (app) mode has no such button: the host app owns the
                   connection, so there is nothing here to cancel — only the X to
                   hide the banner. -->
              <Button size="s" variant="secondary" onclick={cancelConnecting}>{labels.cancel}</Button>
            {:else if kind === 'no-connection'}
              {#if view.usb.supported}
                <Button size="s" variant="secondary" icon="usb" onclick={() => connect('usb')} disabled={connecting}>
                  {labels.bannerConnectUsb}
                </Button>
              {/if}
              {#if view.ble.supported}
                <Button size="s" variant="secondary" icon="bluetooth" onclick={() => connect('ble')} disabled={connecting}>
                  {labels.bannerConnectBle}
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
                  {extraBusy ? (extra.action.busyLabel ?? labels.pleaseWait) : extra.action.label}
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
                  {extraSecondaryBusy ? (extra.secondaryAction.busyLabel ?? labels.pleaseWait) : extra.secondaryAction.label}
                </Button>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    {/if}
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
    flex-direction: column;
    gap: var(--cui-space-1);
    width: max-content;
    max-width: min(45rem, calc(100vw - 2 * var(--cui-space-4)));
    padding: var(--cui-space-2) var(--cui-space-2) var(--cui-space-3) var(--cui-space-4);
    border: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
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

  .head {
    display: flex;
    align-items: center;
    gap: var(--cui-space-2);
    min-height: var(--cui-size-control-s);
  }
  .title {
    flex: 1;
    min-width: 0;
    font-weight: var(--cui-font-weight-semibold);
  }
  .lead {
    display: inline-grid;
    flex: none;
    place-items: center;
  }
  /* 20px disc with the paired mark colour: the status lives in the icon, not
     in a stripe or a tinted background. */
  .disc {
    width: var(--cui-size-icon-m);
    height: var(--cui-size-icon-m);
    border-radius: var(--cui-radius-full);
    background-color: var(--_fill);
    color: var(--_on);
  }
  .close {
    flex: none;
  }

  /* The message row sits under the heading; its buttons are centred on the
     message, so they stay clear of the heading row and the X. */
  .row {
    display: flex;
    align-items: center;
    gap: var(--cui-space-3);
    padding-right: var(--cui-space-2);
  }
  .text {
    flex: 1;
    min-width: 0;
    color: var(--cui-text-muted);
  }
  .text :global(.cui-progress-bar) {
    min-width: 18rem;
  }
  /* The source gif is large (≈991×920): a small square keeps the toast
     well-proportioned. No frame: the artwork sits on the banner. */
  .reconnect-gif {
    flex: none;
    width: 6.5rem;
    height: 6.5rem;
    object-fit: contain;
  }
  .actions {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: var(--cui-space-2);
  }

  /* Narrow toast: stack the message and its buttons (and the illustration)
     instead of squeezing them into one row. */
  @media (max-width: 520px) {
    .row {
      flex-direction: column;
      align-items: flex-start;
    }
    .actions {
      align-self: stretch;
    }
    .actions > :global(*) {
      flex: 1;
    }
  }
</style>
