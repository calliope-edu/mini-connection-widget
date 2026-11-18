<script lang="ts">
  import { Button, ChoiceItem, ChoiceList, Dialog } from '@calliope-edu/ui';
  import { calliopeBleOfflineInfo, dismissBleOfflineInfo } from '../ble-offline-info';
  import { calliopeState } from '../state';
  import { connectCalliope, disconnectAndForget } from '../connect';
  import { isNativeMode } from '../native-bridge';

  const visible = $derived($calliopeBleOfflineInfo);

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
  <Dialog
    open
    title="Bluetooth ist auf deinem Calliope gerade aus"
    description={native
      ? 'Wahrscheinlich läuft ein Programm ohne Bluetooth. So geht es weiter:'
      : 'Wahrscheinlich läuft ein Programm ohne Bluetooth. Wähle einen der beiden Wege zurück:'}
    onOpenChange={(open) => { if (!open) dismissBleOfflineInfo(); }}
  >
    {#if native}
      <!-- The host app owns the radio: nothing to choose, one instruction. -->
      <p class="instruction">
        <strong>A + B halten und Reset drücken.</strong>
        Der Calliope startet in den Bluetooth-Modus. Wir verbinden uns dann
        automatisch neu und übertragen dein Programm.
      </p>
    {:else}
      <!-- Two alternatives, not steps: a click on either is the choice. -->
      <ChoiceList>
        <ChoiceItem
          icon="bluetooth"
          title="Erneut per Bluetooth verbinden"
          detail="Vorher A + B halten und Reset drücken: Der Calliope startet in den DFU-Modus (Display zeigt z. B. ein Plus „+“). Wir übertragen dann ein BLE-fähiges Programm."
          disabled={retrying}
          onclick={retryBle}
        />
        <ChoiceItem
          icon="usb"
          title="USB-Kabel nehmen"
          detail="Funktioniert immer, auch ohne Bluetooth auf dem Calliope, und ist deutlich schneller als BLE."
          onclick={useUsbInstead}
        />
      </ChoiceList>
      {#if isMac}
        <p class="mac-hint">
          <strong>Klappt beides nicht?</strong> macOS speichert manchmal eine veraltete
          Bluetooth-Verbindung, die den Aufbau blockiert. Öffne
          <em>Systemeinstellungen → Bluetooth</em>, suche „Calliope mini“ in der
          Geräteliste, klicke auf das „×“ daneben und verbinde dann erneut über
          diese Seite.
        </p>
      {/if}
    {/if}

    {#snippet actions()}
      {#if !native}
        <Button variant="secondary" onclick={cancelConnection}>Verbindung abbrechen</Button>
      {:else}
        <Button variant="secondary" onclick={() => dismissBleOfflineInfo()}>Schließen</Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .instruction,
  .mac-hint {
    margin: 0;
    line-height: var(--cui-typography-prose-line-height);
  }
  .mac-hint {
    margin-top: var(--cui-space-3);
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-label-font-size);
  }
  .mac-hint strong,
  .mac-hint em {
    color: var(--cui-text-default);
    font-style: normal;
  }
</style>
