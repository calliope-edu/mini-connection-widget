<script lang="ts">
  /**
   * Rich connection panel — the dropdown contents inside `<ConnectButton>`,
   * also usable stand-alone.
   *
   * Regular users get a minimal panel: the »Calliope mini Verbindung«
   * headline, a USB card, and a Bluetooth card whose "Verbinden" button is
   * gated behind drawing the device's 5×5 name pattern. The drawn pattern
   * also filters the BLE chooser to that one `Calliope mini [name]`. When USB
   * is connected the pad is pre-filled with the connected device's pattern,
   * so a follow-up BLE connect is already aimed at the same Calliope.
   *
   * `advanced` (dev mode) reveals the device-info block + comms log and drops
   * the pattern filter, so any Calliope can be picked and BLE connects without
   * needing a pattern.
   *
   * Built from calliope-ui parts (Button, IconButton, StatusDot with a word
   * per transport, ProgressBar while flashing) and coloured only through
   * `--cui-*` tokens, so it follows the host's light or dark theme.
   */
  import { untrack } from 'svelte';
  import { Badge, Button, Icon, IconButton, ProgressBar, StatusDot, type Status } from '@calliope-edu/ui';
  import { calliopeState, type CalliopeStatus } from '../state';
  import { connectCalliope, disconnectAndForget, disconnectUsbKeepPermission } from '../connect';
  import { connectJLinkSerial } from '../web-serial';
  import { statusLabel } from '../connection-view';
  import { connectionTransferProgram, connectionRearmInputs } from '../connection-banner-extra';
  import { connectLabels, connectionErrorText, mergeLabels, type ConnectLabels } from './labels';
  import { extractFriendlyName, friendlyNameToPattern, patternToFriendlyName } from '../friendly-name';
  import MiniNamePattern from './MiniNamePattern.svelte';
  import PatternPad from './PatternPad.svelte';
  import CommsPanel from './CommsPanel.svelte';

  type Props = {
    labels?: Partial<ConnectLabels>;
    /** Set by `<ConnectButton>`: the panel covers its Popover's own surface
     *  (so the panel's theme shows edge to edge) and scrolls when too tall. */
    embedded?: boolean;
    /** calliope-ui theme of the panel (`data-theme`). Dark by default, the
     *  look the panel has always had in Campus and Teachable; `inherit`
     *  follows the surrounding theme. */
    theme?: 'light' | 'dark' | 'inherit';
    /** Called after the user clicks an action — useful to close a parent dropdown. */
    onaction?: () => void;
    /** When set, renders a pin / unpin toggle in the header. The host owns
     *  the pinned state (so it can switch between dropdown and floating
     *  layouts); the panel just reflects the current value via the icon. */
    pinned?: boolean;
    onTogglePin?: () => void;
    /** Dev / power-user mode. Shows the device-info block + comms log, and
     *  drops the BLE name-pattern filter (any Calliope may be picked, and
     *  "Verbinden" no longer waits for a pattern). Off for regular users. */
    advanced?: boolean;
    /** When provided, the panel header becomes the drag handle for the
     *  floating-window layout. Buttons inside the header (pin toggle) keep
     *  receiving their own clicks because the handler early-returns on
     *  closest button. */
    onHeaderPointerDown?: (ev: PointerEvent) => void;
    onHeaderPointerMove?: (ev: PointerEvent) => void;
    onHeaderPointerUp?: (ev: PointerEvent) => void;
  };
  let {
    labels: labelsProp,
    embedded = false,
    theme = 'dark',
    onaction,
    pinned = false,
    onTogglePin,
    advanced = false,
    onHeaderPointerDown,
    onHeaderPointerMove,
    onHeaderPointerUp,
  }: Props = $props();

  const labels = $derived(mergeLabels(labelsProp, $connectLabels));
  const dataTheme = $derived(theme === 'inherit' ? undefined : theme);
  const s = $derived($calliopeState);

  const isIndeterminate = $derived(
    s.status === 'flashing' &&
      (s.flashPhase === 'check' || s.flashPhase === 'reboot' || s.flashPhase === 'prepare')
  );

  // Both transports' cards are always shown (each with its own connect / cancel /
  // disconnect / retry buttons), so the user always sees the full state of both
  // — we don't collapse or nudge.
  // Mini 2 presents as USB: jlinkSerialStatus = CDC serial (Web Serial),
  // jlinkUsbStatus = J-Link flash link (WebUSB) — flash-only when serial is off.
  const usbConnected = $derived(
    s.usbStatus === 'connected' || s.jlinkSerialStatus === 'connected' || s.jlinkUsbStatus === 'connected',
  );
  // Mini 2 connected for flashing but without its CDC serial — offer to add
  // it. Only where Web Serial exists at all (Android Chrome has WebUSB but no
  // navigator.serial — there the flash-only link is simply all there is).
  const webSerialSupported = typeof navigator !== 'undefined' && 'serial' in navigator;
  const mini2SerialMissing = $derived(
    webSerialSupported
    && s.jlinkUsbStatus === 'connected'
    && s.jlinkSerialStatus !== 'connected'
    && s.jlinkSerialStatus !== 'connecting',
  );
  let addingSerial = $state(false);
  async function doAddSerial(): Promise<void> {
    if (addingSerial) return;
    addingSerial = true;
    try {
      await connectJLinkSerial();
    } finally {
      addingSerial = false;
    }
  }
  const bleConnected = $derived(s.bleStatus === 'connected');
  const anyConnected = $derived(usbConnected || bleConnected);

  // "Programm übertragen" — the active editor registers how to flash its current
  // program; the button shows whenever a transport is connected (and not already
  // flashing).
  const transfer = $derived($connectionTransferProgram);
  let transferring = $state(false);
  async function runTransfer(): Promise<void> {
    if (!transfer || transferring) return;
    transferring = true;
    try {
      await transfer.run();
    } finally {
      transferring = false;
    }
  }

  // "Re-arm inputs" — a DEV-ONLY safety net (gated on `advanced` below). The
  // active editor (Blocks) registers it; it re-arms the running program's touch
  // pads / pin events without a full reconnect, for the rare case an input gets
  // stuck unarmed. Hidden for regular users.
  const rearm = $derived($connectionRearmInputs);
  let rearming = $state(false);
  async function runRearm(): Promise<void> {
    if (!rearm || rearming) return;
    rearming = true;
    try {
      await rearm.run();
    } finally {
      rearming = false;
    }
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

  // ---- BLE name pattern --------------------------------------------------
  //
  // The pad encodes a 5-letter friendly name as bottom-anchored column bars,
  // exactly like the histogram the Calliope shows in pairing mode. Drawing it
  // both names the device for the chooser filter and gates "Verbinden".

  function emptyPattern(): boolean[][] {
    return Array.from({ length: 5 }, () => Array<boolean>(5).fill(false));
  }
  let pattern = $state<boolean[][]>(emptyPattern());
  const patternName = $derived(patternToFriendlyName(pattern));
  const patternComplete = $derived(patternName !== null);

  // Pre-fill the pad from the connected device's friendly name (captured over
  // USB) so a follow-up BLE connect is pre-aimed at the same Calliope. Only
  // re-fires when the name itself changes, so manual edits aren't clobbered.
  let lastPrefill: string | undefined = undefined;
  $effect(() => {
    // Track only the connection signals; the prefill bookkeeping (reading the
    // last-applied name + writing the pad) is done untracked so it can't loop
    // and stays out of the reactive graph — manual pad edits aren't undone.
    const fn = s.friendlyName;
    const usbConnected = s.usbStatus === 'connected';
    untrack(() => {
      if (usbConnected && fn && fn !== lastPrefill) {
        const g = friendlyNameToPattern(fn);
        if (g) {
          pattern = g;
          lastPrefill = fn;
        }
      }
    });
  });

  // The pad only makes sense in web mode: in native mode the host app owns
  // scanning, so a `requestDevice` name filter does nothing.
  const showPattern = $derived(!s.nativeMode);
  // Verbinden is allowed once we have a name to filter by — or always in dev /
  // native mode, where no pattern filter is applied.
  const bleConnectEnabled = $derived(advanced || s.nativeMode || patternComplete);

  function fire() { onaction?.(); }
  function doConnectUsb() { fire(); void connectCalliope('usb'); }
  function doConnectBle() {
    fire();
    // Dev mode and native mode connect unfiltered; otherwise the drawn
    // pattern names the single device to surface in the BLE chooser.
    const nameFilter = advanced || s.nativeMode ? undefined : (patternName ?? undefined);
    void connectCalliope('ble', false, nameFilter);
  }
  // Plain "Trennen": reversible from the UI — keeps the WebUSB permission so
  // the next "Verbinden" re-attaches silently (no picker, no cable replug).
  // Forgetting is the separate "Anderen Calliope verbinden" path.
  function doDisconnectUsb() { fire(); void disconnectUsbKeepPermission(); }
  function doForgetBle() { fire(); void disconnectAndForget('ble'); }
  // Give up on an in-flight / retrying BLE attempt: disconnectAndForget sets
  // userDisconnectedBle (which stops the reconnect daemon) and forgets the
  // device, so the next "Verbinden" opens a fresh picker — no page reload.
  function doCancelBle() { fire(); void disconnectAndForget('ble'); }
  function doCancelUsb() { fire(); void disconnectAndForget('usb'); }

  // One StatusDot + word per transport card.
  function transportStatus(connected: boolean, status: CalliopeStatus): Status {
    if (connected) return 'success';
    if (status === 'connecting') return 'info';
    if (status === 'error') return 'error';
    return 'neutral';
  }
  function transportWord(connected: boolean, status: CalliopeStatus): string {
    if (connected) return labels.connected;
    if (status === 'connecting') return labels.connecting;
    if (status === 'error') return labels.error;
    return labels.notConnected;
  }

</script>

<div class="panel" class:embedded data-theme={dataTheme}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="panel-header"
    class:draggable={onHeaderPointerDown}
    onpointerdown={onHeaderPointerDown}
    onpointermove={onHeaderPointerMove}
    onpointerup={onHeaderPointerUp}
    onpointercancel={onHeaderPointerUp}
  >
    <div class="panel-header-text">
      <h2 class="title">{labels.panelTitle}</h2>
      {#if advanced}
        <div class="subtitle">{statusLabel(s, labels)}</div>
      {/if}
    </div>
    {#if onTogglePin}
      <IconButton
        icon={pinned ? 'collapse' : 'expand'}
        label={pinned ? labels.unpin : labels.pin}
        size="s"
        tooltip={false}
        pressed={pinned}
        onclick={onTogglePin}
      />
    {/if}
  </div>

  <!-- Connection info (device card) — dev mode only. -->
  {#if advanced && (s.calliopeVersion || s.boardVersion || s.usbDeviceName || s.bleDeviceName)}
    {@const friendly = s.friendlyName ?? extractFriendlyName(s.bleDeviceName ?? s.usbDeviceName)}
    <div class="device-card">
      <div class="device-card-head">
        {#if friendly}
          <MiniNamePattern name={friendly} size={32} labels={labelsProp} />
        {:else}
          <span class="device-card-icon"><Icon name="device" /></span>
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
            <!-- Over BLE a mini 1 and a mini 2 look the same — show the
                 ambiguity rather than a false certainty. -->
            <span class="meta-val">{s.versionAmbiguous ? 'V1/V2' : (s.calliopeVersion ?? s.boardVersion)}</span>
          </div>
        {/if}
        {#if s.programType === 'ml-data'}
          <div class="meta-row">
            <span class="meta-key">{labels.program}</span>
            <span class="meta-val">{labels.programMlData}</span>
          </div>
        {/if}
        {#if s.programType === 'blocks'}
          <div class="meta-row">
            <span class="meta-key">{labels.program}</span>
            <span class="meta-val">{labels.programBlocks}</span>
          </div>
          {#if s.runtimeVersion != null}
            <div class="meta-row">
              <span class="meta-key">{labels.runtimeVersion}</span>
              <span class="meta-val" class:meta-warn={s.runtimeOutdated}>
                {#if s.runtimeOutdated}<Icon name="warning" size="s" />{/if}
                v{s.runtimeVersion}{#if s.runtimeOutdated} · {labels.outdated}{/if}
              </span>
            </div>
          {/if}
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
      <div class="badge">
        <div class="badge-head">
          <span class="transport-name">
            <Icon name="usb" size="s" />
            {labels.usb}
          </span>
          <StatusDot status={transportStatus(usbConnected, s.usbStatus)} label={transportWord(usbConnected, s.usbStatus)} size="s" />
          <span class="badge-action">
            {#if usbConnected}
              <Button size="s" variant="secondary" onclick={doDisconnectUsb} disabled={usbBusy}>
                {labels.disconnect}
              </Button>
            {:else if s.usbStatus === 'connecting' || s.usbStatus === 'error'}
              <!-- While trying to connect, or after a failed attempt, the only
                   action is cancel: it frees the picker and brings back
                   Verbinden, to retry manually. -->
              <Button size="s" variant="secondary" onclick={doCancelUsb}>
                {labels.cancel}
              </Button>
            {:else}
              <Button size="s" tone="positive" onclick={doConnectUsb} disabled={usbBusy}>
                {labels.connect}
              </Button>
            {/if}
          </span>
        </div>

        {#if s.jlinkSerialStatus === 'connecting'}
          <!-- The native Web Serial picker floats above this panel — tell the
               user what phase they're in and that cancelling is harmless. -->
          <p class="hint">{labels.serialPickHint}</p>
        {:else if mini2SerialMissing}
          <div class="usb-serial-add">
            <span class="hint">{labels.serialMissing}</span>
            <Button size="s" variant="secondary" onclick={doAddSerial} loading={addingSerial} disabled={s.status === 'flashing'}>
              {labels.serialConnect}
            </Button>
          </div>
        {/if}
      </div>
    {/if}

    {#if s.bleSupported}
      {@const bleBusy = s.bleStatus === 'connecting' || s.flashTransport === 'ble'}
      <div class="badge">
        <div class="badge-head">
          <span class="transport-name">
            <Icon name="bluetooth" size="s" />
            {labels.ble}
          </span>
          <StatusDot status={transportStatus(bleConnected, s.bleStatus)} label={transportWord(bleConnected, s.bleStatus)} size="s" />
          {#if bleConnected && s.bleSessionKind === 'dfu-bootloader'}
            <Badge size="s" tone="info" title={labels.bootloaderTitle}>{labels.bootloader}</Badge>
          {/if}
          {#if bleConnected}
            <!-- Just "Trennen": for BLE this forgets the device (harmless — no
                 stale-handle issue as on USB), so the next "Verbinden" opens the
                 picker and can switch minis. Two buttons only: Verbinden / Trennen. -->
            <span class="badge-action">
              <Button size="s" variant="secondary" onclick={doForgetBle} disabled={bleBusy}>
                {labels.disconnect}
              </Button>
            </span>
          {/if}
        </div>

        {#if showPattern}
          {#if bleConnected}
            <!-- Connected: show the device's own pattern, read-only. -->
            {@const connectedName = s.friendlyName ?? extractFriendlyName(s.bleDeviceName)}
            {#if connectedName}
              <div class="pattern-wrap">
                <PatternPad value={friendlyNameToPattern(connectedName) ?? emptyPattern()} size={132} disabled labels={labelsProp} />
              </div>
            {/if}
          {:else}
            <div class="pattern-wrap">
              <PatternPad value={pattern} onchange={(g) => (pattern = g)} size={132} disabled={bleBusy} labels={labelsProp} />
              {#if !advanced}
                <p class="hint pattern-hint">{labels.patternHint}</p>
              {/if}
            </div>
          {/if}
        {/if}

        {#if !bleConnected}
          <div class="badge-foot">
            {#if s.bleStatus === 'connecting' || s.bleStatus === 'error'}
              <Button size="s" variant="secondary" onclick={doCancelBle}>
                {labels.cancel}
              </Button>
            {:else}
              <Button size="s" tone="positive" onclick={doConnectBle} disabled={bleBusy || !bleConnectEnabled}>
                {labels.connect}
              </Button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if anyConnected && transfer && s.status !== 'flashing'}
    <div class="wide-action">
      <Button fullWidth icon="upload" onclick={runTransfer} loading={transferring}>
        {transfer.label ?? labels.transferProgram}
      </Button>
    </div>
  {/if}

  <!-- Dev-only "Re-arm inputs" escape hatch — not shown for regular users. -->
  {#if advanced && anyConnected && rearm && s.status !== 'flashing'}
    <div class="wide-action">
      <Button fullWidth variant="secondary" size="s" icon="retry" onclick={runRearm} loading={rearming}>
        {rearm.label ?? labels.rearmInputs}
      </Button>
    </div>
  {/if}

  {#if s.status === 'flashing'}
    {@const via = s.flashTransport ?? 'usb'}
    <div class="flash-block">
      <ProgressBar
        label={labels.flashVia(via)}
        value={isIndeterminate ? null : (s.flashProgress ?? 0)}
        hint={isIndeterminate ? statusLabel(s, labels) : (s.flashPartial ? labels.partialFlash : labels.fullFlash)}
      />
    </div>
  {/if}

  {#if s.usbError}
    <p class="error"><span class="error-disc"><Icon name="error" size="s" /></span>USB: {connectionErrorText(labels, s.usbError)}</p>
  {/if}
  {#if s.bleError}
    <p class="error"><span class="error-disc"><Icon name="error" size="s" /></span>BLE: {connectionErrorText(labels, s.bleError)}</p>
  {/if}

  {#if !s.usbSupported && !s.bleSupported}
    <p class="hint">{labels.unsupportedHint}</p>
  {/if}

  {#if advanced && s.lastFlashAt}
    <div class="meta-row muted">
      <span class="meta-key">{labels.lastFlash}</span>
      <span class="meta-val">
        {new Date(s.lastFlashAt).toLocaleTimeString()}
        {#if s.lastFlashName}· {s.lastFlashName}{/if}
      </span>
    </div>
  {/if}

  {#if advanced && (s.status === 'connected' || s.status === 'flashing')}
    <div class="comms-embed">
      <CommsPanel labels={labelsProp} />
    </div>
  {/if}
</div>

<style>
  .panel {
    padding: var(--cui-space-4);
    border-radius: var(--cui-radius-xl);
    background-color: var(--cui-surface-default);
    color: var(--cui-text-default);
    font-family: var(--cui-typography-body-font-family);
    font-size: var(--cui-typography-label-font-size);
    line-height: var(--cui-typography-body-line-height);
  }
  /* Inside the trigger's Popover: cover its padding and surface, so the
     panel's own theme fills the popover to its rounded edge. The popover does
     not scroll itself; with the comms log the panel can be taller than the
     window. */
  .panel.embedded {
    max-height: calc(100dvh - 6rem);
    overflow-y: auto;
    margin: calc(-1 * var(--cui-space-4));
    border-radius: var(--cui-radius-lg);
  }
  .comms-embed {
    display: flex;
    height: 280px;
    margin-top: var(--cui-space-4);
  }
  .comms-embed > :global(.comms) {
    width: 100%;
  }
  .panel-header {
    display: flex;
    align-items: center;
    gap: var(--cui-space-2);
    margin-bottom: var(--cui-space-3);
  }
  .panel-header.draggable {
    cursor: move;
    touch-action: none;
    user-select: none;
  }
  .panel-header-text {
    flex: 1;
    min-width: 0;
  }
  .title {
    margin: 0;
    font-size: var(--cui-typography-body-font-size);
    font-weight: var(--cui-font-weight-bold);
    line-height: var(--cui-font-line-height-tight);
  }
  .subtitle {
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-caption-font-size);
  }

  /* ---- dev-only device card --------------------------------------------- */
  .device-card {
    margin-bottom: var(--cui-space-3);
    padding: var(--cui-space-2) var(--cui-space-3);
    border-radius: var(--cui-radius-lg);
    background-color: var(--cui-surface-subtle);
  }
  .device-card-head {
    display: flex;
    align-items: center;
    gap: var(--cui-space-3);
    margin-bottom: var(--cui-space-1);
    font-weight: var(--cui-font-weight-semibold);
  }
  .device-card-icon {
    display: inline-grid;
    color: var(--cui-text-muted);
  }
  .device-card-name-stack {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .device-card-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .device-card-friendly {
    color: var(--cui-text-muted);
    font-family: var(--cui-typography-code-font-family);
    font-size: var(--cui-typography-caption-font-size);
    font-weight: var(--cui-font-weight-medium);
    letter-spacing: var(--cui-font-tracking-caps);
    text-transform: lowercase;
  }

  /* ---- transport badges ------------------------------------------------- */
  .transports {
    display: flex;
    flex-direction: column;
    gap: var(--cui-space-3);
  }
  /* Filled cards as in Campus (graphite on ink in the dark theme, mist on
     white in the light one). Neutral for every card: the state lives in the
     StatusDot and the button, not in a tinted background. */
  .badge {
    padding: var(--cui-space-3);
    border-radius: var(--cui-radius-lg);
    background-color: var(--cui-surface-subtle);
  }
  .badge-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cui-space-2);
  }
  .transport-name {
    display: inline-flex;
    align-items: center;
    gap: var(--cui-space-1);
    font-weight: var(--cui-font-weight-semibold);
  }
  .badge-action {
    margin-left: auto;
  }

  .pattern-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--cui-space-2);
    margin: var(--cui-space-3) 0 var(--cui-space-1);
  }
  .badge-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--cui-space-2);
    margin-top: var(--cui-space-3);
  }

  .hint {
    margin: var(--cui-space-3) 0 0;
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-caption-font-size);
    line-height: var(--cui-typography-prose-line-height);
  }
  .pattern-hint {
    margin: 0;
    text-align: center;
  }
  /* Mini 2: "add serial" affordance inside the USB badge. */
  .usb-serial-add {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cui-space-3);
    margin-top: var(--cui-space-3);
  }
  .usb-serial-add .hint {
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  .wide-action {
    margin-top: var(--cui-space-3);
  }

  .meta-row {
    display: flex;
    justify-content: space-between;
    gap: var(--cui-space-3);
    padding: var(--cui-space-1) 0;
    font-size: var(--cui-typography-caption-font-size);
  }
  .meta-row.muted {
    margin-top: var(--cui-space-2);
  }
  .meta-key {
    color: var(--cui-text-muted);
  }
  .meta-val {
    display: inline-flex;
    align-items: center;
    gap: var(--cui-space-1);
  }
  .meta-warn {
    font-weight: var(--cui-font-weight-semibold);
  }

  .flash-block {
    margin: var(--cui-space-4) 0 var(--cui-space-1);
  }

  /* Errors: the red goes to the icon disc, the text stays in the error text
     colour (calliope-ui's rule for red on light surfaces). */
  .error {
    display: flex;
    align-items: flex-start;
    gap: var(--cui-space-2);
    margin: var(--cui-space-3) 0 0;
    padding: var(--cui-space-2) var(--cui-space-3);
    border-left: 4px solid var(--cui-status-error-fill);
    border-radius: var(--cui-radius-md);
    background-color: var(--cui-action-hover);
    color: var(--cui-text-error);
    font-size: var(--cui-typography-caption-font-size);
    overflow-wrap: anywhere;
  }
  .error-disc {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: var(--cui-size-icon-m);
    height: var(--cui-size-icon-m);
    border-radius: var(--cui-radius-full);
    background-color: var(--cui-status-error-fill);
    color: var(--cui-status-error-on);
  }
</style>
