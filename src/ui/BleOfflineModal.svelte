<script lang="ts">
  import { Button, Dialog } from '@calliope-edu/ui';
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
  // purely a Triple Reset instruction — hide the web-only steps and buttons.
  const native = isNativeMode();

  // "Connection attempt failed" is CoreBluetooth error 6 (CBErrorConnectionFailed),
  // which fires on macOS when the OS has a stale bond for the device. Guide macOS
  // users to remove it from System Settings → Bluetooth so Chrome can connect fresh.
  const isMac =
    typeof navigator !== 'undefined' &&
    /Macintosh|Mac OS X/i.test(navigator.userAgent);

  let retrying = $state(false);

  // Auto-dismiss as soon as either transport becomes connected — the
  // recovery worked (whether via Triple Reset → DfuTarg or via USB cable),
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
  <Dialog
    open
    title={labels.bleOfflineTitle}
    description={`${labels.bleOfflineLead} ${native ? labels.bleOfflineStepsNative : labels.bleOfflineStepsWeb}`}
    closeLabel={labels.close}
    onOpenChange={(open) => { if (!open) dismissBleOfflineInfo(); }}
  >
    <!-- The ways back are alternatives, not a sequence: each is a card of
         its own with its own button, an "oder" between them, no numbers. -->
    <div class="ways">
      <section class="way">
        <h3 class="way-title">{labels.bleOfflineResetTitle}</h3>
        <p class="way-hint">{native ? labels.bleOfflineResetHintNative : labels.bleOfflineResetHint}</p>
        {#if isMac && !native}
          <p class="way-extra">
            <strong>{labels.bleOfflineMacTitle}</strong>
            {labels.bleOfflineMacHint}
          </p>
        {/if}
        {#if !native}
          <div class="way-action">
            <Button icon="bluetooth" onclick={retryBle} loading={retrying}>{labels.reconnect}</Button>
          </div>
        {/if}
      </section>
      {#if !native}
        <div class="or" aria-hidden="true"><span>{labels.bleOfflineOr}</span></div>
        <section class="way">
          <h3 class="way-title">{labels.bleOfflineUsbTitle}</h3>
          <p class="way-hint">{labels.bleOfflineUsbHint}</p>
          <div class="way-action">
            <Button variant="secondary" icon="usb" onclick={useUsbInstead}>{labels.bleOfflineUseUsb}</Button>
          </div>
        </section>
      {/if}
    </div>

    {#snippet actions()}
      {#if !native}
        <Button variant="ghost" onclick={cancelConnection}>{labels.bleOfflineAbort}</Button>
      {:else}
        <Button variant="secondary" onclick={() => dismissBleOfflineInfo()}>{labels.close}</Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .ways {
    display: flex;
    flex-direction: column;
    gap: var(--cui-space-2);
  }
  .way {
    display: flex;
    flex-direction: column;
    gap: var(--cui-space-1);
    padding: var(--cui-space-3) var(--cui-space-4);
    border: var(--cui-border-width-hairline) solid var(--cui-border-control);
    border-radius: var(--cui-radius-lg);
  }
  .way-title {
    margin: 0;
    font-size: var(--cui-typography-body-font-size);
    font-weight: var(--cui-font-weight-bold);
  }
  .way-hint,
  .way-extra {
    margin: 0;
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-label-font-size);
    line-height: var(--cui-typography-prose-line-height);
  }
  .way-extra strong {
    color: var(--cui-text-default);
  }
  .way-action {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--cui-space-2);
  }
  /* "oder" on a hairline between the two ways. */
  .or {
    display: flex;
    align-items: center;
    gap: var(--cui-space-3);
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-caption-font-size);
    font-weight: var(--cui-font-weight-semibold);
    letter-spacing: var(--cui-font-tracking-caps);
    text-transform: uppercase;
  }
  .or::before,
  .or::after {
    content: '';
    flex: 1;
    height: var(--cui-border-width-hairline);
    background-color: var(--cui-border-subtle);
  }
</style>
