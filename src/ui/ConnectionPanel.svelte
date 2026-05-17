<script lang="ts">
  /**
   * Rich connection panel — used as the dropdown contents inside
   * `<ConnectButton>`, and also stand-alone in places that already have
   * their own surface (e.g. a side panel). Shared canonical content
   * lives here; the trigger pill lives in `ConnectButton.svelte`.
   */
  import { calliopeState } from '../state';
  import { connectCalliope, disconnectAndForget } from '../connect';
  import { showBlePairingInfo } from '../pairing-info';
  import type { CalliopeStatus, CalliopeTransport } from '../state';
  import { mergeLabels, type ConnectLabels } from './labels';
  import { extractFriendlyName } from '../friendly-name';
  import MiniNamePattern from './MiniNamePattern.svelte';
  import CommsPanel from './CommsPanel.svelte';

  type Props = {
    labels?: Partial<ConnectLabels>;
    /** Called after the user clicks an action — useful to close a parent dropdown. */
    onaction?: () => void;
    /** Called when the user clicks "maximize" on the embedded CommsPanel.
     *  When omitted, the maximize button is hidden. */
    oncommsexpand?: () => void;
    /** When set, renders a pin / unpin toggle in the header. The host owns
     *  the pinned state (so it can switch between dropdown and floating
     *  layouts); the panel just reflects the current value via the icon. */
    pinned?: boolean;
    onTogglePin?: () => void;
    /** Optional close button shown next to the pin toggle. Used by the
     *  floating-window layout — dropdown mode hides this and relies on its
     *  scrim instead. */
    onClose?: () => void;
  };
  let {
    labels: labelsProp,
    onaction,
    oncommsexpand,
    pinned = false,
    onTogglePin,
    onClose,
  }: Props = $props();

  const labels = $derived(mergeLabels(labelsProp));
  const s = $derived($calliopeState);

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
      case 'connecting':
        return labels.connecting;
      case 'error':
        return labels.error;
      case 'unsupported':
        return labels.unsupported;
      case 'disconnected':
      case 'unknown':
      default:
        return labels.notConnected;
    }
  }

  function capabilityText(transport: CalliopeTransport): string {
    if (transport === 'usb') {
      if (s.usbStatus === 'connected') return labels.usbConnected;
      if (s.usbStatus === 'connecting') return labels.connecting;
      if (s.usbStatus === 'error') return s.usbErrorMessage ?? labels.error;
      if (!s.usbSupported) return labels.notSupportedUsb;
      return labels.notConnected;
    }
    if (s.bleStatus === 'connected') {
      if (s.bleCanFlash && s.bleCanCommunicate) return labels.bleConnectedFull;
      if (s.bleCanCommunicate) return labels.bleConnectedCommOnly;
      if (s.bleStaleBond) return labels.bleConnectedStaleBond;
      return labels.bleConnectedNeedsPairing;
    }
    if (s.bleStatus === 'connecting') return labels.connecting;
    if (s.bleStatus === 'error') return s.bleErrorMessage ?? labels.error;
    if (!s.bleSupported) return labels.notSupportedBle;
    return labels.notConnected;
  }

  let nowTick = $state(Date.now());
  $effect(() => {
    if (s.status !== 'connected') return;
    const id = setInterval(() => { nowTick = Date.now(); }, 1000);
    return () => clearInterval(id);
  });
  function formatSince(ts: number | undefined, _now: number): string {
    if (!ts) return '';
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  }
  const sinceLabel = $derived(formatSince(s.connectedAt, nowTick));

  function fire() { onaction?.(); }
  function doConnectUsb() { fire(); void connectCalliope('usb'); }
  function doConnectBle() { fire(); void connectCalliope('ble'); }
  function doForgetUsb() { fire(); void disconnectAndForget('usb'); }
  function doForgetBle() { fire(); void disconnectAndForget('ble'); }
  function doShowPairingInfo() { fire(); showBlePairingInfo(); }
</script>

<div class="panel">
  <div class="panel-header">
    <span class="dot-lg status-{s.status}"></span>
    <div class="panel-header-text">
      <div class="title">{labels.panelTitle}</div>
      <div class="subtitle">{statusLabel(s.status)}</div>
    </div>
    {#if onTogglePin}
      <button
        type="button"
        class="header-btn"
        class:active={pinned}
        title={pinned ? 'Wieder anhängen' : 'Als Fenster anheften'}
        aria-label={pinned ? 'Wieder anhängen' : 'Als Fenster anheften'}
        onclick={onTogglePin}
      >
        <!-- Pin icon: filled when pinned, outline when not. -->
        {#if pinned}
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M14 4l6 6-4 1-1 4-3-3-5 5-1-1 5-5-3-3 4-1z"/>
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 4l6 6-4 1-1 4-3-3-5 5-1-1 5-5-3-3 4-1z"/>
          </svg>
        {/if}
      </button>
    {/if}
    {#if onClose}
      <button
        type="button"
        class="header-btn"
        title="Schließen"
        aria-label="Schließen"
        onclick={onClose}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18"/>
        </svg>
      </button>
    {/if}
  </div>

  {#if s.calliopeVersion || s.boardVersion || s.usbDeviceName || s.bleDeviceName}
    {@const friendly = s.friendlyName ?? extractFriendlyName(s.bleDeviceName ?? s.usbDeviceName)}
    <div class="device-card">
      <div class="device-card-head">
        {#if friendly}
          <MiniNamePattern name={friendly} size={32} />
        {:else}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <circle cx="8" cy="12" r="1" />
            <circle cx="16" cy="12" r="1" />
          </svg>
        {/if}
        <div class="device-card-name-stack">
          <span class="device-card-name">
            {s.usbDeviceName ?? s.bleDeviceName ?? 'Calliope mini'}
          </span>
          {#if friendly}
            <span class="device-card-friendly">{friendly}</span>
          {/if}
        </div>
      </div>
      <div class="device-card-rows">
        {#if s.calliopeVersion || s.boardVersion}
          <div class="meta-row">
            <span class="meta-key">{labels.version}</span>
            <span class="meta-val">{s.calliopeVersion ?? s.boardVersion}</span>
          </div>
        {/if}
        {#if s.programType === 'blocks'}
          <div class="meta-row">
            <span class="meta-key">{labels.program}</span>
            <span class="meta-val">{labels.programBlocks}</span>
          </div>
        {/if}
        {#if s.status === 'connected' && s.connectedAt}
          <div class="meta-row">
            <span class="meta-key">{labels.connectedSince}</span>
            <span class="meta-val">{sinceLabel}</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <div class="transports">
    {#if s.usbSupported}
      {@const usbBusy = s.usbStatus === 'connecting' || s.flashTransport === 'usb'}
      {@const usbConnected = s.usbStatus === 'connected'}
      <div class="transport-row" class:connected={usbConnected} class:err={s.usbStatus === 'error'}>
        <div class="transport-row-head">
          <span class="transport-name">{labels.usb}</span>
          <span class="transport-status">{capabilityText('usb')}</span>
        </div>
        <div class="transport-row-actions">
          {#if usbConnected}
            <button type="button" class="row-btn ghost" onclick={doForgetUsb} disabled={usbBusy}>
              {labels.disconnect}
            </button>
          {:else}
            <button type="button" class="row-btn primary" onclick={doConnectUsb} disabled={usbBusy}>
              {usbBusy ? labels.connecting : labels.connect}
            </button>
          {/if}
        </div>
      </div>
    {/if}

    {#if s.bleSupported}
      {@const bleBusy = s.bleStatus === 'connecting' || s.flashTransport === 'ble'}
      {@const bleConnected = s.bleStatus === 'connected'}
      {@const needsPairing = bleConnected && !s.bleCanCommunicate}
      <div class="transport-row" class:connected={bleConnected} class:err={s.bleStatus === 'error'} class:warn={needsPairing}>
        <div class="transport-row-head">
          <span class="transport-name">{labels.ble}</span>
          <span class="transport-status">{capabilityText('ble')}</span>
        </div>
        {#if needsPairing}
          <div class="transport-hint">
            {s.bleStaleBond ? labels.staleBondHint : labels.pairingHint}
            <button type="button" class="link-btn" onclick={doShowPairingInfo}>
              {labels.howToPair}
            </button>
          </div>
        {/if}
        <div class="transport-row-actions">
          {#if bleConnected}
            <button type="button" class="row-btn ghost" onclick={doForgetBle} disabled={bleBusy}>
              {labels.forget}
            </button>
          {:else}
            <button type="button" class="row-btn primary" onclick={doConnectBle} disabled={bleBusy}>
              {bleBusy ? labels.connecting : labels.connect}
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  {#if s.status === 'flashing'}
    {@const via = s.flashTransport ?? 'usb'}
    <div class="flash-block">
      <div class="flash-via">{labels.flashVia(via)}</div>
      {#if isIndeterminate}
        <div class="flash-line indeterminate">
          <span class="spinner-inline"></span>
          {statusLabel(s.status)}
        </div>
        <div class="flash-bar">
          <div class="flash-bar-indeterminate"></div>
        </div>
      {:else}
        <div class="flash-line">
          {s.flashPartial ? labels.partialFlash : labels.fullFlash}
          · {s.flashProgress ?? 0}%
        </div>
        <div class="flash-bar">
          <div class="flash-bar-fill" style="width: {s.flashProgress ?? 0}%"></div>
        </div>
      {/if}
    </div>
  {/if}

  {#if s.usbErrorMessage}
    <div class="error">USB: {s.usbErrorMessage}</div>
  {/if}
  {#if s.bleErrorMessage}
    <div class="error">BLE: {s.bleErrorMessage}</div>
  {/if}

  {#if !s.usbSupported && !s.bleSupported}
    <div class="hint">{labels.unsupportedHint}</div>
  {/if}

  {#if s.lastFlashAt}
    <div class="meta-row muted">
      <span class="meta-key">{labels.lastFlash}</span>
      <span class="meta-val">
        {new Date(s.lastFlashAt).toLocaleTimeString()}
        {#if s.lastFlashName}· {s.lastFlashName}{/if}
      </span>
    </div>
  {/if}

  {#if s.status === 'connected' || s.status === 'flashing'}
    <div class="comms-embed">
      <CommsPanel onexpand={oncommsexpand} />
    </div>
  {/if}
</div>

<style lang="scss">
  .panel {
    padding: 14px;
    color: #1b1c1d;
  }
  .comms-embed {
    margin-top: 14px;
    height: 280px;
    display: flex;
  }
  .comms-embed > :global(.comms) {
    width: 100%;
  }
  .panel-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .dot-lg {
    width: 12px; height: 12px; border-radius: 50%; background: #9ca3af; flex-shrink: 0;
    &.status-connected { background: #22c55e; }
    &.status-flashing { background: #00b8cc; }
    &.status-connecting { background: #facc15; }
    &.status-error { background: #ef4444; }
  }
  .panel-header-text { flex: 1; min-width: 0; }
  .panel-header-text .title { font-weight: 600; font-size: 14px; }
  .panel-header-text .subtitle { font-size: 12px; color: #666; }
  .header-btn {
    border: 0;
    background: transparent;
    color: #6b7280;
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;
    line-height: 0;
    flex-shrink: 0;
    &:hover { background: #f3f4f6; color: #1b1c1d; }
    &.active { color: #0ea5b7; }
  }

  .device-card {
    background: #f8fafc;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 10px;
  }
  .device-card-head {
    display: flex; align-items: center; gap: 10px;
    color: #111; font-weight: 600; font-size: 13px; margin-bottom: 4px;
    svg { color: #6b7280; flex-shrink: 0; }
  }
  .device-card-name-stack {
    display: flex; flex-direction: column; min-width: 0;
  }
  .device-card-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .device-card-friendly {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-weight: 500;
    font-size: 11px;
    color: #6b7280;
    letter-spacing: 0.05em;
    text-transform: lowercase;
  }

  .transports { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 4px; }
  .transport-row {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 8px 10px;
    background: #fff;
    transition: border-color 0.15s, background 0.15s;
    &.connected { border-color: #bbf7d0; background: #f0fdf4; }
    &.warn { border-color: #fde68a; background: #fffbeb; }
    &.err { border-color: #fecaca; background: #fef2f2; }
  }
  .transport-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .transport-name { font-size: 13px; font-weight: 600; color: #111; }
  .transport-status { font-size: 11px; color: #6b7280; text-align: right; }
  .transport-row.connected .transport-status { color: #166534; }
  .transport-row.warn .transport-status { color: #92400e; }
  .transport-row.err .transport-status { color: #991b1b; }
  .transport-hint { font-size: 11px; color: #6b7280; line-height: 1.35; margin-top: 4px; }
  .transport-row-actions { margin-top: 6px; display: flex; gap: 6px; }
  .row-btn {
    flex: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid transparent;
    font-size: 12px; font-weight: 600; cursor: pointer;
    transition: background 0.15s, color 0.15s;
    &.primary {
      background: #1b1c1d; color: #fff;
      &:hover:not(:disabled) { background: #333; }
      &:disabled { opacity: 0.5; cursor: default; }
    }
    &.ghost {
      background: transparent; border-color: #d1d5db; color: #1b1c1d;
      &:hover:not(:disabled) { background: #f3f4f6; }
      &:disabled { opacity: 0.5; cursor: default; }
    }
  }
  .link-btn {
    background: none; border: none; padding: 0; margin-left: 4px;
    color: #0ea5b7; text-decoration: underline; font-size: inherit; cursor: pointer;
    &:hover { color: #0891a8; }
  }
  .meta-row { display: flex; justify-content: space-between; font-size: 12px; padding: 4px 0; }
  .meta-row.muted { color: #666; margin-top: 6px; }
  .meta-key { color: #666; }

  .flash-block { margin: 10px 0; }
  .flash-via { font-size: 12px; font-weight: 600; color: #111; margin-bottom: 4px; }
  .flash-line {
    font-size: 12px; color: #555; margin-bottom: 6px;
    &.indeterminate { display: flex; align-items: center; gap: 6px; }
  }
  .spinner-inline {
    display: inline-block; width: 10px; height: 10px; border-radius: 50%;
    border: 2px solid rgba(0, 184, 204, 0.25); border-top-color: #00b8cc;
    animation: spin 0.7s linear infinite; flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes indeterminate {
    0% { left: -40%; width: 40%; }
    60% { left: 100%; width: 40%; }
    100% { left: 100%; width: 40%; }
  }
  .flash-bar { height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; position: relative; }
  .flash-bar-fill { height: 100%; background: #00b8cc; transition: width 0.15s; }
  .flash-bar-indeterminate {
    position: absolute; height: 100%; background: #00b8cc; border-radius: 3px;
    animation: indeterminate 1.4s ease-in-out infinite;
  }

  .error {
    margin-top: 8px; padding: 8px 10px;
    background: #fee2e2; color: #991b1b; border-radius: 6px;
    font-size: 12px; word-break: break-word;
  }
  .hint { font-size: 12px; color: #666; line-height: 1.4; }
</style>
