<script lang="ts">
  import { calliopeUsbPlugRequest } from '../usb-plug';

  const req = $derived($calliopeUsbPlugRequest);
</script>

{#if req}
  <div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="usb-plug-title">
    <div class="card">
      <div class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 7V4h6v3" />
          <path d="M8 7h8v6a4 4 0 0 1-8 0V7z" />
          <path d="M12 17v3" />
        </svg>
      </div>
      <h2 id="usb-plug-title">Calliope per USB anschließen</h2>
      <p>
        <strong>{req.fileName}</strong> lässt sich gerade nicht über
        Bluetooth übertragen. Mit dem USB-Kabel klappt es trotzdem in
        wenigen Sekunden.
      </p>
      <ol class="steps">
        <li>USB-Kabel mit dem Calliope verbinden.</li>
        <li>Auf <em>"Übertragen"</em> klicken — beim allerersten Mal Browser-Dialog mit dem Calliope auswählen.</li>
      </ol>
      <div class="actions">
        <button type="button" class="btn ghost" onclick={() => req.cancel()}>
          Abbrechen
        </button>
        <button type="button" class="btn primary" onclick={() => req.confirm()}>
          Übertragen
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
    max-width: 420px;
    background: #fff;
    border-radius: 14px;
    padding: 24px 22px 20px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
    text-align: center;
    color: #1b1c1d;
  }
  .icon {
    color: #00b8cc;
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
    margin: 0 0 14px;
  }
  .steps {
    text-align: left;
    margin: 0 0 14px;
    padding-left: 22px;
    font-size: 13px;
    color: #374151;
    line-height: 1.55;
    li + li { margin-top: 4px; }
  }
  .hint {
    background: #f1f5f9;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 12px;
    color: #334155;
    text-align: left;
    line-height: 1.5;
    margin: 0 0 14px;
  }
  .actions {
    display: flex;
    gap: 10px;
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
    &.ghost {
      background: transparent;
      border-color: #d1d5db;
      color: #1b1c1d;
      &:hover { background: #f3f4f6; }
    }
  }
</style>
