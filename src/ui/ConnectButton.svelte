<script lang="ts">
  /**
   * Header pill with a `<ConnectionPanel>` dropdown. The trigger is a
   * compact status indicator; opening it reveals the full panel — same
   * content as `<ConnectionPanel>` rendered standalone, so callers don't
   * have to choose between "small UI" and "full UI".
   */
  import { calliopeState } from '../state';
  import type { CalliopeStatus } from '../state';
  import ConnectionPanel from './ConnectionPanel.svelte';
  import { mergeLabels, type ConnectLabels } from './labels';

  type Props = {
    /** Visual style for the trigger pill — light backgrounds vs dark headers. */
    appearance?: 'dark' | 'light';
    /** Translation overrides; defaults are German. */
    labels?: Partial<ConnectLabels>;
    /** Called when the user clicks the "maximize" button in the embedded
     *  CommsPanel. Hosts wire this to opening a full-size drawer. The
     *  dropdown closes automatically before the callback fires. */
    oncommsexpand?: () => void;
  };

  let { appearance = 'dark', labels: labelsProp, oncommsexpand }: Props = $props();
  const labels = $derived(mergeLabels(labelsProp));

  let open = $state(false);
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
    onclick={() => (open = !open)}
    aria-haspopup="true"
    aria-expanded={open}
    title={labels.triggerTitle}
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

  {#if open}
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
      />
    </div>
    <button class="popover-scrim" type="button" aria-label="close" onclick={() => (open = false)}></button>
  {/if}
</div>

<style lang="scss">
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
</style>
