<script lang="ts">
  import { mini2SerialOfferRequest } from '../mini2-serial';

  /**
   * "Add the mini 2's serial link?" modal. Driven by `mini2SerialOfferRequest`
   * (mini2-serial.ts raises it when a serial-consuming editor is active while
   * the mini 2 is connected flash-only). Accepting opens the Web Serial picker
   * from this button's click — the user gesture `requestPort` requires.
   */
  const req = $derived($mini2SerialOfferRequest);
  let busy = $state(false);
  async function accept(): Promise<void> {
    if (!req || busy) return;
    busy = true;
    try {
      await req.accept();
    } finally {
      busy = false;
    }
  }
</script>

{#if req}
  <div
    class="backdrop"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="mini2-serial-title"
    onclick={(e) => { if (e.target === e.currentTarget) req.decline(); }}
    onkeydown={(e) => { if (e.key === 'Escape') req.decline(); }}
  >
    <div class="card">
      <div class="card-header">
        <h2 id="mini2-serial-title">Serial verbinden?</h2>
        <button type="button" class="close-btn" aria-label="Schließen" onclick={() => req.decline()}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div class="card-body">
        <p>
          Dieser Editor kann mit dem Calliope mini kommunizieren (Serial). Dein
          Calliope mini 2 ist bisher nur zum Übertragen verbunden — wähle im
          nächsten Dialog „CDC – COM x“, um die Datenverbindung herzustellen.
        </p>
      </div>

      <div class="actions">
        <button type="button" class="btn ghost" onclick={() => req.decline()} disabled={busy}>
          Später
        </button>
        <button type="button" class="btn usb" onclick={accept} disabled={busy}>
          {busy ? 'Verbinde…' : 'Serial verbinden'}
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
  .card-body { padding: 18px 20px; }
  p {
    font-size: 13px;
    line-height: 1.5;
    color: #4b5563;
    margin: 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 20px 18px;
  }
  .btn {
    padding: 8px 16px;
    border-radius: 8px;
    border: 1px solid transparent;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    &.ghost {
      background: transparent;
      border-color: #d1d5db;
      color: #1b1c1d;
      &:hover:not(:disabled) { background: #f3f4f6; }
    }
    // USB = green (transport palette, in sync with banner/panel).
    &.usb {
      background: #98f600;
      color: #1b1c1d;
      &:hover:not(:disabled) { background: #aaff1f; }
    }
    &:disabled { opacity: 0.55; cursor: default; }
  }
</style>
