<script lang="ts">
  import { Button, Dialog } from '@calliope-edu/ui';
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
    description={`Wahrscheinlich läuft ein Programm ohne Bluetooth. ${native ? 'So geht es weiter:' : isMac ? 'Drei mögliche Ursachen:' : 'Zwei Wege zurück:'}`}
    onOpenChange={(open) => { if (!open) dismissBleOfflineInfo(); }}
  >
    <ol class="steps">
      <li>
        <span class="num" aria-hidden="true">1</span>
        <div class="step-body">
          <div class="step-title">A + B halten und Reset drücken</div>
          <div class="step-hint">
            {#if native}
              Der Calliope startet in den Bluetooth-Modus. Wir verbinden uns
              dann automatisch neu und übertragen dein Programm.
            {:else}
              Der Calliope startet in den DFU-Modus
              (Display zeigt z.&nbsp;B. ein Plus „+“). Dann unten auf
              <em>„Erneut verbinden“</em> klicken: Wir übertragen ein
              BLE-fähiges Programm.
            {/if}
          </div>
        </div>
      </li>
      {#if !native}
      <li>
        <span class="num" aria-hidden="true">2</span>
        <div class="step-body">
          <div class="step-title">USB-Kabel anschließen</div>
          <div class="step-hint">
            Funktioniert immer, auch ohne Bluetooth auf dem Calliope,
            und ist deutlich schneller als BLE.
          </div>
        </div>
      </li>
      {/if}
      {#if isMac && !native}
      <li>
        <span class="num" aria-hidden="true">3</span>
        <div class="step-body">
          <div class="step-title">Calliope aus macOS-Bluetooth entfernen</div>
          <div class="step-hint">
            macOS speichert manchmal eine veraltete Bluetooth-Verbindung, die
            den Aufbau blockiert. Öffne
            <em>Systemeinstellungen → Bluetooth</em>, suche „Calliope mini“
            in der Geräteliste, klicke auf das „×“ daneben und verbinde dann
            erneut über diese Seite.
          </div>
        </div>
      </li>
      {/if}
    </ol>

    {#snippet actions()}
      {#if !native}
        <Button variant="ghost" onclick={cancelConnection}>Verbindung abbrechen</Button>
        <Button variant="secondary" onclick={useUsbInstead}>USB nehmen</Button>
        <Button onclick={retryBle} loading={retrying}>Erneut verbinden</Button>
      {:else}
        <Button variant="secondary" onclick={() => dismissBleOfflineInfo()}>Schließen</Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .steps {
    display: flex;
    flex-direction: column;
    gap: var(--cui-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .steps li {
    display: flex;
    align-items: flex-start;
    gap: var(--cui-space-3);
    padding: var(--cui-space-3);
    border-radius: var(--cui-radius-lg);
    /* A tint rather than surface.subtle, which equals the raised dialog
       surface in the dark theme. */
    background-color: var(--cui-action-hover);
  }
  .num {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: var(--cui-size-icon-l);
    height: var(--cui-size-icon-l);
    border-radius: var(--cui-radius-full);
    background-color: var(--cui-surface-inverse);
    color: var(--cui-text-inverse);
    font-size: var(--cui-typography-caption-font-size);
    font-weight: var(--cui-font-weight-bold);
  }
  .step-body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--cui-space-1);
    min-width: 0;
  }
  .step-title {
    font-weight: var(--cui-font-weight-semibold);
  }
  .step-hint {
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-label-font-size);
    line-height: var(--cui-typography-prose-line-height);
  }
  .step-hint em {
    color: var(--cui-text-default);
    font-style: normal;
    font-weight: var(--cui-font-weight-semibold);
  }
</style>
