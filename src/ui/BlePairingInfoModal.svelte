<script lang="ts">
  import { calliopeBlePairingInfo, dismissBlePairingInfo } from '../pairing-info';

  const visible = $derived($calliopeBlePairingInfo);
</script>

{#if visible}
  <div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="ble-pair-title">
    <div class="card">
      <div class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 7l10 10-5 5V2l5 5L7 17" />
        </svg>
      </div>
      <h2 id="ble-pair-title">Calliope am Computer koppeln</h2>
      <p>
        Im reinen Bluetooth-Modus muss der Calliope einmalig in den
        Bluetooth-Einstellungen deines Computers gekoppelt werden — der Browser
        kann das selbst nicht anstoßen. Ohne diese Kopplung schlägt das
        Übertragen über Bluetooth fehl.
      </p>
      <ol class="steps">
        <li>Öffne die <strong>Bluetooth-Einstellungen</strong> deines Betriebssystems.</li>
        <li>Drücke <strong>A + B</strong> auf dem Calliope und halte sie, beim
          mini 3 zusätzlich kurz <strong>Reset</strong> drücken — der Modus zum
          Pairing wird aktiv (Bildschirm zeigt "PAIR").</li>
        <li>Wähle den Calliope in der OS-Liste aus und bestätige die Kopplung
          (in der Regel ohne PIN, "Just Works").</li>
        <li>Komm zurück in den Browser und klicke auf <em>Verbinden</em>.</li>
      </ol>
      <p class="hint">
        Tipp: Wenn du keine Kopplung einrichten möchtest, nutze stattdessen
        den Modus <strong>BLE + USB</strong> — der Calliope wird per USB-Kabel
        beschrieben und sendet danach drahtlos Live-Daten.
      </p>
      <div class="actions">
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
  }
</style>
