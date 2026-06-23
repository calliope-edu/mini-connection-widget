<script lang="ts">
  import { calliopeConnectionChoiceRequest } from '../connection-choice';

  const req = $derived($calliopeConnectionChoiceRequest);
</script>

{#if req}
  <div
    class="backdrop"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="conn-choice-title"
    onclick={(e) => { if (e.target === e.currentTarget) req.cancel(); }}
    onkeydown={(e) => { if (e.key === 'Escape') req.cancel(); }}
  >
    <div class="card">
      <div class="card-header">
        <h2 id="conn-choice-title">Programm übertragen</h2>
        <button type="button" class="close-btn" aria-label="Schließen" onclick={() => req.cancel()}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div class="card-body">
        <p>
          Der Calliope ist gerade nicht verbunden. Wähle, wie <strong>{req.fileName}</strong> aufs Gerät kommen soll.
        </p>

        <div class="choices">
          {#if req.bleEnabled}
            <button type="button" class="choice" onclick={() => req.choose('ble')}>
              <span class="choice-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6.5 6.5 17.5 17.5 12 22V2l5.5 4.5L6.5 17.5" />
                </svg>
              </span>
              <span class="choice-body">
                <span class="choice-title">Per Bluetooth</span>
                <span class="choice-detail">Drahtlos — Calliope muss eingeschaltet und in Reichweite sein.</span>
              </span>
            </button>
          {/if}
          <button type="button" class="choice" onclick={() => req.choose('usb')}>
            <span class="choice-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 7V4h6v3" />
                <path d="M8 7h8v6a4 4 0 0 1-8 0V7z" />
                <path d="M12 17v3" />
              </svg>
            </span>
            <span class="choice-body">
              <span class="choice-title">Per USB-Kabel</span>
              <span class="choice-detail">Zuverlässig, funktioniert immer. Kabel an Calliope und Rechner anschließen.</span>
            </span>
          </button>
          <button type="button" class="choice" onclick={() => req.choose('download')}>
            <span class="choice-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3v12" />
                <path d="m7 10 5 5 5-5" />
                <path d="M5 21h14" />
              </svg>
            </span>
            <span class="choice-body">
              <span class="choice-title">Als Datei herunterladen</span>
              <span class="choice-detail">.hex-Datei speichern und manuell auf den Calliope kopieren.</span>
            </span>
          </button>
        </div>
      </div>

      <div class="actions">
        <button type="button" class="btn ghost" onclick={() => req.cancel()}>
          Abbrechen
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
    border-radius: 16px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
    color: #1b1c1d;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 16px 20px;
    border-bottom: 1px solid #e8edeb;
  }
  h2 {
    font-size: 17px;
    font-weight: 600;
    margin: 0;
    text-align: left;
    line-height: 1.3;
  }
  .close-btn {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 50%;
    background: rgba(27, 28, 29, 0.06);
    color: #4b5563;
    cursor: pointer;
    transition: background 0.2s, transform 0.2s, color 0.2s;
    &:hover {
      background: rgba(27, 28, 29, 0.12);
      color: #1b1c1d;
      transform: scale(1.08);
    }
    &:active { transform: scale(0.95); }
  }
  .card-body {
    padding: 18px 20px;
  }
  p {
    font-size: 13px;
    line-height: 1.5;
    color: #4b5563;
    margin: 0 0 14px;
  }
  .choices {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    border: 1px solid #d1d5db;
    border-radius: 10px;
    background: #fff;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    &:hover {
      background: #f9fafb;
      border-color: #00b8cc;
    }
  }
  .choice-icon {
    color: #00b8cc;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .choice-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .choice-title {
    font-weight: 600;
    font-size: 14px;
    color: #1b1c1d;
  }
  .choice-detail {
    font-size: 12px;
    color: #6b7280;
    line-height: 1.4;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    padding: 0 20px 18px;
  }
  .btn {
    padding: 8px 16px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
    &.ghost {
      background: transparent;
      border-color: #d1d5db;
      color: #1b1c1d;
      &:hover { background: #f3f4f6; }
    }
  }
</style>
