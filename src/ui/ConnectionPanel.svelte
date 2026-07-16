<script lang="ts">
  /**
   * Rich connection panel — the dropdown contents inside `<ConnectButton>`,
   * also usable stand-alone.
   *
   * Regular users get a minimal dark panel: the »Calliope mini Verbindung«
   * headline, a USB badge, and a Bluetooth badge whose "Verbinden" button is
   * gated behind drawing the device's 5×5 name pattern. The drawn pattern
   * also filters the BLE chooser to that one `Calliope mini [name]`. When USB
   * is connected the pad is pre-filled with the connected device's pattern,
   * so a follow-up BLE connect is already aimed at the same Calliope.
   *
   * `advanced` (dev mode) reveals the device-info block + comms log and drops
   * the pattern filter, so any Calliope can be picked and BLE connects without
   * needing a pattern.
   */
  import { untrack } from 'svelte';
  import { calliopeState } from '../state';
  import { connectCalliope, disconnectAndForget } from '../connect';
  import { connectJLinkSerial } from '../web-serial';
  import { statusLabel } from '../connection-view';
  import { connectionTransferProgram, connectionRearmInputs } from '../connection-banner-extra';
  import { mergeLabels, type ConnectLabels } from './labels';
  import { extractFriendlyName, friendlyNameToPattern, patternToFriendlyName } from '../friendly-name';
  import MiniNamePattern from './MiniNamePattern.svelte';
  import PatternPad from './PatternPad.svelte';
  import CommsPanel from './CommsPanel.svelte';

  type Props = {
    labels?: Partial<ConnectLabels>;
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
    onaction,
    pinned = false,
    onTogglePin,
    advanced = false,
    onHeaderPointerDown,
    onHeaderPointerMove,
    onHeaderPointerUp,
  }: Props = $props();

  const labels = $derived(mergeLabels(labelsProp));
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
  // Mini 2 connected for flashing but without its CDC serial — offer to add it.
  const mini2SerialMissing = $derived(
    s.jlinkUsbStatus === 'connected'
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
  function doForgetUsb() { fire(); void disconnectAndForget('usb'); }
  function doForgetBle() { fire(); void disconnectAndForget('ble'); }
  // Give up on an in-flight / retrying BLE attempt: disconnectAndForget sets
  // userDisconnectedBle (which stops the reconnect daemon) and forgets the
  // device, so the next "Verbinden" opens a fresh picker — no page reload.
  function doCancelBle() { fire(); void disconnectAndForget('ble'); }
  function doCancelUsb() { fire(); void disconnectAndForget('usb'); }

  const PATTERN_HINT = 'Zeichne das Muster, das dein Calliope mini anzeigt.';
</script>

<div class="panel">
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
      <div class="title">{labels.panelTitle}</div>
      {#if advanced}
        <div class="subtitle">{statusLabel(s, labels)}</div>
      {/if}
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
  </div>

  <!-- Connection info (device card) — dev mode only. -->
  {#if advanced && (s.calliopeVersion || s.boardVersion || s.usbDeviceName || s.bleDeviceName)}
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
            <!-- Over BLE, Mini 1 und Mini 2 sind nicht unterscheidbar — zeige
                 die Unschärfe statt einer falschen Gewissheit. -->
            <span class="meta-val">{s.versionAmbiguous ? 'V1/V2' : (s.calliopeVersion ?? s.boardVersion)}</span>
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
          <span class="transport-name">{labels.usb}</span>
          {#if usbConnected}
            <button type="button" class="row-btn ghost" onclick={doForgetUsb} disabled={usbBusy}>
              {labels.disconnect}
            </button>
          {:else if s.usbStatus === 'connecting'}
            <!-- While trying to connect, the only action is cancel (cancel, then
                 Verbinden re-appears, to retry manually). -->
            <button type="button" class="row-btn ghost" onclick={doCancelUsb}>
              {labels.cancel}
            </button>
          {:else if s.usbStatus === 'error'}
            <!-- Failed: red cancel only (no retry button). Cancelling frees the
                 picker and brings back the green Verbinden. -->
            <button type="button" class="row-btn danger" onclick={doCancelUsb}>
              {labels.cancel}
            </button>
          {:else}
            <button type="button" class="row-btn connect" onclick={doConnectUsb} disabled={usbBusy}>
              {labels.connect}
            </button>
          {/if}
        </div>

        {#if s.jlinkSerialStatus === 'connecting'}
          <!-- The native Web Serial picker floats above this panel — tell the
               user what phase they're in and that cancelling is harmless. -->
          <p class="usb-hint">
            USB 1/2 verbunden — wähle jetzt noch „CDC – COM x“, um die
            Datenverbindung (Serial) herzustellen. Abbrechen ist okay:
            Programme übertragen geht auch ohne.
          </p>
        {:else if mini2SerialMissing}
          <div class="usb-serial-add">
            <span class="usb-hint">Übertragen bereit — Serial (Datenverbindung) fehlt noch.</span>
            <button type="button" class="row-btn connect" onclick={doAddSerial} disabled={addingSerial || s.status === 'flashing'}>
              {addingSerial ? 'Verbinde…' : 'Serial verbinden'}
            </button>
          </div>
        {/if}
      </div>
    {/if}

    {#if s.bleSupported}
      {@const bleBusy = s.bleStatus === 'connecting' || s.flashTransport === 'ble'}
      <div class="badge">
        <div class="badge-head">
          <span class="transport-name">
            {labels.ble}
            {#if bleConnected && s.bleSessionKind === 'dfu-bootloader'}
              <span class="session-chip session-dfu-bootloader" title="Nordic DFU bootloader erkannt">
                Bootloader
              </span>
            {/if}
          </span>
          {#if bleConnected}
            <button type="button" class="row-btn ghost" onclick={doForgetBle} disabled={bleBusy}>
              {labels.forget}
            </button>
          {/if}
        </div>

        {#if showPattern}
          {#if bleConnected}
            <!-- Connected: show the device's own pattern, read-only. -->
            {@const connectedName = s.friendlyName ?? extractFriendlyName(s.bleDeviceName)}
            {#if connectedName}
              <div class="pattern-wrap">
                <PatternPad value={friendlyNameToPattern(connectedName) ?? emptyPattern()} size={132} disabled />
              </div>
            {/if}
          {:else}
            <div class="pattern-wrap">
              <PatternPad value={pattern} onchange={(g) => (pattern = g)} size={132} disabled={bleBusy} />
              {#if !advanced}
                <p class="pattern-hint">{PATTERN_HINT}</p>
              {/if}
            </div>
          {/if}
        {/if}

        {#if !bleConnected}
          <div class="badge-foot">
            {#if s.bleStatus === 'connecting'}
              <button type="button" class="row-btn ghost" onclick={doCancelBle}>
                {labels.cancel}
              </button>
            {:else if s.bleStatus === 'error'}
              <button type="button" class="row-btn danger" onclick={doCancelBle}>
                {labels.cancel}
              </button>
            {:else}
              <button
                type="button"
                class="row-btn connect"
                onclick={doConnectBle}
                disabled={bleBusy || !bleConnectEnabled}
              >
                {labels.connect}
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if anyConnected && transfer && s.status !== 'flashing'}
    <button type="button" class="transfer-btn" onclick={runTransfer} disabled={transferring}>
      {transferring ? 'Übertrage…' : (transfer.label ?? 'Programm übertragen')}
    </button>
  {/if}

  <!-- Dev-only "Re-arm inputs" escape hatch — not shown for regular users. -->
  {#if advanced && anyConnected && rearm && s.status !== 'flashing'}
    <button type="button" class="rearm-btn" onclick={runRearm} disabled={rearming}>
      {rearming ? 'Verbinde Eingänge neu…' : (rearm.label ?? 'Eingänge neu verbinden')}
    </button>
  {/if}

  {#if s.status === 'flashing'}
    {@const via = s.flashTransport ?? 'usb'}
    <div class="flash-block">
      <div class="flash-via">{labels.flashVia(via)}</div>
      {#if isIndeterminate}
        <div class="flash-line indeterminate">
          <span class="spinner-inline"></span>
          {statusLabel(s, labels)}
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
      <CommsPanel />
    </div>
  {/if}
</div>

<style lang="scss">
  .panel {
    padding: 16px;
    background: #1f2023;
    color: #f3f4f6;
    border-radius: 12px;
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
    margin-bottom: 14px;
    &.draggable {
      cursor: move;
      touch-action: none;
      user-select: none;
    }
  }
  .panel-header-text { flex: 1; min-width: 0; }
  .panel-header-text .title { font-weight: 700; font-size: 15px; color: #fff; }
  .panel-header-text .subtitle { font-size: 12px; color: #9ca3af; }
  .header-btn {
    border: 0;
    background: transparent;
    color: #9ca3af;
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;
    line-height: 0;
    flex-shrink: 0;
    &:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
    &.active { color: #38bdf8; }
  }

  /* ---- dev-only device card --------------------------------------------- */
  .device-card {
    background: #2a2b2e;
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 12px;
  }
  .device-card-head {
    display: flex; align-items: center; gap: 10px;
    color: #fff; font-weight: 600; font-size: 13px; margin-bottom: 4px;
    svg { color: #9ca3af; flex-shrink: 0; }
  }
  .device-card-name-stack { display: flex; flex-direction: column; min-width: 0; }
  .device-card-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .device-card-friendly {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-weight: 500; font-size: 11px; color: #9ca3af;
    letter-spacing: 0.05em; text-transform: lowercase;
  }

  /* ---- transport badges ------------------------------------------------- */
  .transports { display: flex; flex-direction: column; gap: 10px; }
  // Neutral grey for every card — the state lives in the button, not the
  // background tint (no green/blue/red card highlight).
  .badge {
    border-radius: 10px;
    padding: 12px;
    background: #2a2b2e;
  }
  .badge-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .transport-name {
    font-size: 14px; font-weight: 600; color: #fff;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .session-chip {
    font-size: 10px; font-weight: 600; text-transform: none;
    padding: 1px 6px; border-radius: 10px;
    background: #0b3a52; color: #7dd3fc;
    letter-spacing: 0.01em; vertical-align: 1px;
  }

  .pattern-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    margin: 12px 0 4px;
  }
  .pattern-hint {
    margin: 0;
    font-size: 11.5px;
    color: #9ca3af;
    text-align: center;
    line-height: 1.4;
  }

  .badge-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }

  // Mini 2: CDC-picker phase hint + "add serial" affordance inside the USB badge.
  .usb-hint {
    margin: 10px 0 0;
    font-size: 11.5px;
    color: #9ca3af;
    line-height: 1.4;
  }
  .usb-serial-add {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 10px;
    .usb-hint { margin: 0; flex: 1; min-width: 0; }
  }

  // "Verbinden" / "Erneut verbinden" are always green; cancel / disconnect are a
  // decent (ghost) outline. State is conveyed by which buttons show + the error
  // text, not by tinting the button red.
  .row-btn {
    padding: 7px 16px; border-radius: 8px; border: 1px solid transparent;
    font-size: 13px; font-weight: 600; cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s, opacity 0.15s;
    &.connect {
      background: #98f600; color: #1b1c1d;
      &:hover:not(:disabled) { background: #aaff1f; }
      &:disabled { opacity: 0.4; cursor: default; }
    }
    // Cancel in the error state — red, to signal something went wrong.
    &.danger {
      background: #e53f4b; color: #fff;
      &:hover:not(:disabled) { background: #cf3742; }
      &:disabled { opacity: 0.4; cursor: default; }
    }
    &.ghost {
      background: transparent; border-color: rgba(255, 255, 255, 0.22); color: #e5e7eb;
      &:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); }
      &:disabled { opacity: 0.4; cursor: default; }
    }
  }

  // "Programm übertragen" — full-width, in the flash/transfer accent (cyan),
  // matching the flash progress shown while it runs.
  .transfer-btn {
    width: 100%;
    margin-top: 12px;
    padding: 10px 16px;
    border: 0;
    border-radius: 8px;
    background: #00b8cc;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    &:hover:not(:disabled) { background: #00a3b5; }
    &:disabled { opacity: 0.5; cursor: default; }
  }

  // Dev-only "Re-arm inputs" — secondary ghost button so it reads as a tool,
  // not a primary action.
  .rearm-btn {
    width: 100%;
    margin-top: 8px;
    padding: 8px 16px;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 8px;
    background: transparent;
    color: #e5e7eb;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    &:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); }
    &:disabled { opacity: 0.5; cursor: default; }
  }

  .meta-row { display: flex; justify-content: space-between; font-size: 12px; padding: 4px 0; }
  .meta-row.muted { color: #9ca3af; margin-top: 6px; }
  .meta-key { color: #9ca3af; }
  .meta-val { color: #e5e7eb; }
  .meta-warn { color: #fbbf24; font-weight: 600; }

  .flash-block { margin: 14px 0 4px; }
  .flash-via { font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 4px; }
  .flash-line {
    font-size: 12px; color: #cbd5e1; margin-bottom: 6px;
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
  .flash-bar { height: 6px; background: rgba(255, 255, 255, 0.12); border-radius: 3px; overflow: hidden; position: relative; }
  .flash-bar-fill { height: 100%; background: #00b8cc; transition: width 0.15s; }
  .flash-bar-indeterminate {
    position: absolute; height: 100%; background: #00b8cc; border-radius: 3px;
    animation: indeterminate 1.4s ease-in-out infinite;
  }

  .error {
    margin-top: 10px; padding: 8px 10px;
    background: #3a2526; color: #fca5a5; border-radius: 6px;
    font-size: 12px; word-break: break-word;
  }
  .hint { font-size: 12px; color: #9ca3af; line-height: 1.4; }
</style>
