<script lang="ts">
  import { calliopeBleOfflineInfo, dismissBleOfflineInfo } from '../ble-offline-info';
  import { calliopeState } from '../state';
  import { connectCalliope, disconnectAndForget } from '../connect';
  import { isNativeMode } from '../native-bridge';
  import { connectLabels } from './labels';

  const visible = $derived($calliopeBleOfflineInfo);
  const labels = $derived($connectLabels);

  // In native (iOS/Android bridge) mode the host owns the radio: it auto-
  // reconnects and flashes once the mini is back in Bluetooth mode, and the
  // USB / "retry BLE" web actions don't map to anything there. So the modal is
  // purely an A+B+Reset instruction — hide the web-only steps and buttons.
  const native = isNativeMode();

  // "Connection attempt failed" is CoreBluetooth error 6 (CBErrorConnectionFailed),
  // which fires on macOS when the OS has a stale bond for the device. Guide macOS
  // users to remove it from System Settings → Bluetooth so Chrome can connect fresh.
  const isMac =
    typeof navigator !== 'undefined' &&
    /Macintosh|Mac OS X/i.test(navigator.userAgent);

  let retrying = $state(false);

  // Auto-dismiss as soon as either transport becomes connected — the
  // recovery worked (whether via AB+Reset → DfuTarg or via USB cable),
  // there's nothing more to do.
  $effect(() => {
    if (!visible) return;
    const s = $calliopeState;
    if (s.bleStatus === 'connected' || s.usbStatus === 'connected') {
      dismissBleOfflineInfo();
    }
  });

  async function retryBle(): Promise<void> {
    if (retrying) return;
    retrying = true;
    try {
      await connectCalliope('ble', false);
    } finally {
      retrying = false;
    }
  }

  function useUsbInstead(): void {
    dismissBleOfflineInfo();
    void connectCalliope('usb');
  }

  // Give up entirely: stop the reconnect daemon (disconnectAndForget sets
  // userDisconnectedBle) and forget the device so the next "Verbinden" opens a
  // fresh picker. Without this the daemon keeps retrying after the modal is
  // closed, and the user has to reload the page to connect a different mini.
  function cancelConnection(): void {
    dismissBleOfflineInfo();
    void disconnectAndForget('ble');
  }
</script>

{#if visible}
  <div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="ble-offline-title">
    <div class="card">
      <div class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 7l10 10-5 5V2l5 5L7 17" />
          <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" stroke-width="2" />
        </svg>
      </div>
      <h2 id="ble-offline-title">{labels.bleOfflineTitle}</h2>
      <p class="lead">
        {labels.bleOfflineLead}
        {native ? labels.bleOfflineStepsNative : labels.bleOfflineStepsWeb}
      </p>

      <!-- The ways back are alternatives, not a sequence: no numbers, an
           "oder" divider between them. The macOS stale-bond tip belongs to
           the Bluetooth way (it only matters when reconnecting over BLE). -->
      <div class="ways">
        <div class="way">
          <div class="way-title">{labels.bleOfflineResetTitle}</div>
          <div class="way-hint">
            {native ? labels.bleOfflineResetHintNative : labels.bleOfflineResetHint}
          </div>
          {#if isMac && !native}
            <div class="way-extra">
              <strong>{labels.bleOfflineMacTitle}</strong>
              {labels.bleOfflineMacHint}
            </div>
          {/if}
        </div>
        {#if !native}
          <div class="or"><span>{labels.bleOfflineOr}</span></div>
          <div class="way">
            <div class="way-title">{labels.bleOfflineUsbTitle}</div>
            <div class="way-hint">{labels.bleOfflineUsbHint}</div>
          </div>
        {/if}
      </div>

      {#if !native}
      <div class="actions">
        <button type="button" class="btn secondary" onclick={useUsbInstead}>
          {labels.bleOfflineUseUsb}
        </button>
        <button type="button" class="btn primary" onclick={retryBle} disabled={retrying}>
          {retrying ? labels.connecting : labels.reconnect}
        </button>
      </div>
      {/if}
      <div class="dismiss-row">
        {#if !native}
        <button type="button" class="link-btn" onclick={cancelConnection}>
          {labels.bleOfflineAbort}
        </button>
        {/if}
        <button type="button" class="link-btn" onclick={() => dismissBleOfflineInfo()}>
          {labels.close}
        </button>
      </div>
    </div>
  </div>
{/if}

<style lang="scss">
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9000;
    padding: 16px;
  }
  .card {
    width: 100%;
    max-width: 460px;
    background: #fff;
    border-radius: 14px;
    padding: 24px 22px 20px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
    text-align: center;
    color: #1b1c1d;
  }
  .icon {
    color: #6b7280;
    display: flex;
    justify-content: center;
    margin-bottom: 8px;
  }
  h2 {
    font-size: 19px;
    font-weight: 700;
    margin: 0 0 6px;
  }
  .lead {
    font-size: 14px;
    line-height: 1.5;
    color: #4b5563;
    margin: 0 0 16px;
  }
  .ways {
    text-align: left;
    margin: 0 0 14px;
    display: flex;
    flex-direction: column;
  }
  .way {
    background: #f8fafc;
    border-radius: 10px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .way-title {
    font-weight: 600;
    font-size: 14px;
    color: #1b1c1d;
  }
  .way-hint,
  .way-extra {
    font-size: 12.5px;
    color: #4b5563;
    line-height: 1.45;
  }
  .way-extra {
    margin-top: 4px;
    padding-top: 8px;
    border-top: 1px solid #e2e8f0;
    strong { font-weight: 600; color: #1b1c1d; }
  }
  .or {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 0;
    color: #6b7280;
    font-size: 12.5px;
    font-weight: 600;
    &::before,
    &::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #cbd5e1;
    }
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 4px;
  }
  .btn {
    flex: 1;
    padding: 11px 14px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    &[disabled] { opacity: 0.6; cursor: progress; }
    &.primary {
      background: #1b1c1d;
      color: #fff;
      &:hover:not([disabled]) { background: #333; }
    }
    &.secondary {
      background: #fff;
      color: #1b1c1d;
      border-color: #cbd5e1;
      &:hover { background: #f1f5f9; }
    }
  }
  .dismiss-row {
    margin-top: 10px;
    text-align: center;
  }
  .link-btn {
    background: none;
    border: none;
    padding: 4px 8px;
    color: #6b7280;
    text-decoration: underline;
    font-size: 12px;
    cursor: pointer;
    &:hover { color: #1b1c1d; }
  }
</style>
