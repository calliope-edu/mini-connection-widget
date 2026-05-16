<script lang="ts">
  import { calliopeBlePairingInfo, dismissBlePairingInfo } from '../pairing-info';
  import { calliopeState } from '../state';

  const visible = $derived($calliopeBlePairingInfo);
  const staleBond = $derived($calliopeState.bleStaleBond);

  // Platform-specific deep link into the OS Bluetooth pane.
  //  - Windows: ms-settings: URI handled by the Settings app
  //  - macOS:   x-apple.systempreferences: URI handled by System Settings
  //  - Linux / unknown: no standard scheme, button is hidden
  // Chrome shows a one-time confirmation toast the first time these schemes
  // are opened; Edge typically opens them directly.
  function detectOsBluetoothUrl(): string | null {
    if (typeof navigator === 'undefined') return null;
    const ua = navigator.userAgent;
    if (/Windows/i.test(ua)) return 'ms-settings:bluetooth';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'x-apple.systempreferences:com.apple.preference.Bluetooth';
    return null;
  }
  const osBluetoothUrl = detectOsBluetoothUrl();

  function openOsBluetoothSettings(): void {
    if (!osBluetoothUrl) return;
    // Use an anchor click rather than location.href so failures (unsupported
    // scheme, user dismissed the browser confirmation) don't navigate the
    // page away from the editor.
    const a = document.createElement('a');
    a.href = osBluetoothUrl;
    a.rel = 'noopener';
    a.target = '_self';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
</script>

{#if visible}
  <div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="ble-pair-title">
    <div class="card">
      <div class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 7l10 10-5 5V2l5 5L7 17" />
        </svg>
      </div>
      <h2 id="ble-pair-title">
        {staleBond ? 'Calliope neu koppeln' : 'Calliope am Computer koppeln'}
      </h2>
      {#if staleBond}
        <p>
          Das alte OS-Pairing passt nicht mehr — typischerweise nach einem
          USB-Flash, der die Bond-Whitelist auf dem Calliope löscht. Bitte
          das alte Pairing entfernen und neu koppeln:
        </p>
      {:else}
        <p>
          Im reinen Bluetooth-Modus muss der Calliope einmalig in den
          Bluetooth-Einstellungen deines Computers gekoppelt werden — der Browser
          kann das selbst nicht anstoßen. Ohne diese Kopplung schlägt das
          Übertragen über Bluetooth fehl.
        </p>
      {/if}
      <ol class="steps">
        <li>Öffne die <strong>Bluetooth-Einstellungen</strong> deines Betriebssystems.</li>
        {#if staleBond}
          <li><strong>Bestehende Calliope-Kopplung entfernen</strong> (in der OS-Liste den Calliope auswählen und "Entkoppeln" / "Vergessen").</li>
        {/if}
        <li>Drücke <strong>A + B</strong> auf dem Calliope und halte sie, beim
          mini 3 zusätzlich kurz <strong>Reset</strong> drücken — der Modus zum
          Pairing wird aktiv (Bildschirm zeigt "PAIR").</li>
        <li>Wähle den Calliope in der OS-Liste aus und bestätige die Kopplung
          (in der Regel ohne PIN, "Just Works").</li>
        <li>Komm zurück in den Browser und klicke auf <em>Verbinden</em>.</li>
      </ol>
      <p class="hint">
        Tipp: Du kannst den Calliope alternativ per <strong>USB</strong>
        anschließen — dann brauchst du keine Kopplung. Flashen und Kommunikation
        laufen dann komplett über das Kabel.
      </p>
      <div class="actions">
        {#if osBluetoothUrl}
          <button type="button" class="btn secondary" onclick={openOsBluetoothSettings}>
            Bluetooth-Einstellungen öffnen
          </button>
        {/if}
        <button type="button" class="btn primary" onclick={() => dismissBlePairingInfo()}>
          Verstanden
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
    color: #0ea5b7;
    display: flex;
    justify-content: center;
    margin-bottom: 8px;
  }
  h2 {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 10px;
  }
  p {
    font-size: 14px;
    line-height: 1.5;
    color: #4b5563;
    margin: 0 0 12px;
  }
  .hint {
    background: #f1f5f9;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    color: #334155;
    text-align: left;
  }
  .steps {
    text-align: left;
    margin: 4px 0 14px;
    padding-left: 22px;
    font-size: 13px;
    color: #374151;
    line-height: 1.55;
    li + li { margin-top: 6px; }
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 14px;
  }
  .btn {
    flex: 1;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
    &.primary {
      background: #1b1c1d;
      color: #fff;
      &:hover { background: #333; }
    }
    &.secondary {
      background: #fff;
      color: #1b1c1d;
      border-color: #cbd5e1;
      &:hover { background: #f1f5f9; }
    }
  }
</style>
