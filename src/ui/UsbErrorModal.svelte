<script lang="ts">
  import {
    calliopeUsbErrorInfo,
    dismissUsbErrorInfo,
    reloadForUsbReconnect,
  } from '../usb-error-info';
  import { connectCalliope } from '../connect';
  import { getState } from '../state';

  const info = $derived($calliopeUsbErrorInfo);

  // Two-stage card. First time an error surfaces (`occurrence === 1`) we offer
  // a quick in-page retry. If that retry fails and the same error comes back
  // (`occurrence >= 2`), we switch to the reliable physical recovery: replug
  // the cable, then reload. `'retry'` vs `'reload'` drives copy + buttons.
  const stage = $derived(info && info.occurrence >= 2 ? 'reload' : 'retry');

  let retrying = $state(false);

  /**
   * Quick in-page retry. Deliberately NON-destructive: a plain
   * `connectCalliope('usb')` reuses the still-permitted device and lets
   * `connectWithRetry` wait out the Windows kernel-release race. We do NOT
   * forget the device (the old behaviour) — forgetting revokes the WebUSB
   * permission, which is exactly what the reload-recovery path needs to keep
   * so the daemon can re-open the device silently after a reload.
   *
   * The card stays up during the attempt (spinner on the button). On success
   * we dismiss; on a repeat failure `connectCalliope` re-fires
   * `showUsbErrorInfo`, which bumps `occurrence` and flips us to stage 2.
   */
  async function retry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    try {
      await connectCalliope('usb');
      if (getState().usbStatus === 'connected') dismissUsbErrorInfo();
    } finally {
      retrying = false;
    }
  }
</script>

{#if info}
  <div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="usb-err-title">
    <div class="card">
      <div class="icon" aria-hidden="true">
        {#if info.kind === 'in-use'}
          <!-- Lock-with-USB-cable: another holder owns the port. -->
          <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="10" width="16" height="10" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            <circle cx="12" cy="15" r="1" />
          </svg>
        {:else}
          <!-- USB-plug-with-warning: cable was logically detached mid-use. -->
          <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 7V4h6v3" />
            <path d="M8 7h8v6a4 4 0 0 1-8 0V7z" />
            <path d="M12 17v3" />
            <path d="M19 5l-2 2" />
            <path d="M5 5l2 2" />
          </svg>
        {/if}
      </div>

      {#if info.kind === 'in-use'}
        {#if stage === 'retry'}
          <h2 id="usb-err-title">Calliope ist gerade belegt</h2>
          <p>
            Ein anderer Browser-Tab oder ein Programm hält den Calliope
            aktuell fest. Solange das so ist, kann dieses Fenster die
            USB-Verbindung nicht übernehmen.
          </p>
          <ol class="steps">
            <li>
              Andere offene Calliope-Tabs schließen
              (z.&nbsp;B. MakeCode-Editor, Mini-Editor, alte Calliope-Seiten)
              oder das Programm beenden, das den Calliope benutzt.
            </li>
            <li>
              Dann unten auf <em>"Erneut verbinden"</em> tippen.
            </li>
          </ol>
        {:else}
          <h2 id="usb-err-title">Calliope ist immer noch belegt</h2>
          <p>
            Der Calliope wird weiterhin festgehalten. Am zuverlässigsten
            hilft jetzt: einmal sauber neu einstecken und neu laden.
          </p>
          <ol class="steps">
            <li>Alle anderen Calliope-Tabs und Programme schließen.</li>
            <li>USB-Kabel kurz abziehen und wieder einstecken.</li>
            <li>
              Dann unten auf <em>"Neu laden"</em> tippen — die Seite startet
              neu und verbindet sich von selbst.
            </li>
          </ol>
        {/if}
      {:else if stage === 'retry'}
        <h2 id="usb-err-title">USB-Verbindung kurz unterbrochen</h2>
        <p>
          Das passiert beim Übertragen manchmal. Meistens reicht ein
          erneuter Versuch — wir starten die Verbindung sauber neu.
        </p>
      {:else}
        <h2 id="usb-err-title">USB-Kabel neu einstecken</h2>
        <p>
          Der erneute Versuch hat noch nicht geklappt. Das hier hilft
          fast immer:
        </p>
        <ol class="steps">
          <li>USB-Kabel kurz abziehen und wieder einstecken.</li>
          <li>
            Dann unten auf <em>"Neu laden"</em> tippen — die Seite startet
            neu und verbindet sich von selbst mit dem Calliope.
          </li>
        </ol>
      {/if}

      <details class="raw">
        <summary>Technische Details</summary>
        <code>{info.rawMessage}</code>
      </details>

      <div class="actions">
        <button type="button" class="btn ghost" onclick={dismissUsbErrorInfo} disabled={retrying}>
          Schließen
        </button>
        {#if stage === 'retry'}
          <button type="button" class="btn primary" onclick={retry} disabled={retrying}>
            {retrying ? 'Verbinde…' : 'Erneut verbinden'}
          </button>
        {:else}
          <button type="button" class="btn primary" onclick={reloadForUsbReconnect} disabled={retrying}>
            Kabel eingesteckt – neu laden
          </button>
        {/if}
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
    max-width: 440px;
    background: #fff;
    border-radius: 14px;
    padding: 24px 22px 20px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
    text-align: center;
    color: #1b1c1d;
  }
  .icon {
    color: #e53f4b;
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
    li + li { margin-top: 6px; }
    em { font-style: normal; font-weight: 600; color: #111; }
  }
  .raw {
    text-align: left;
    font-size: 12px;
    color: #6b7280;
    background: #f8fafc;
    border-radius: 8px;
    padding: 8px 10px;
    margin: 0 0 14px;
    summary {
      cursor: pointer;
      user-select: none;
      font-weight: 500;
      &::marker { color: #9ca3af; }
    }
    code {
      display: block;
      margin-top: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      color: #475569;
      word-break: break-word;
      white-space: pre-wrap;
    }
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
      &:hover:not(:disabled) { background: #333; }
      &:disabled { opacity: 0.6; cursor: default; }
    }
    &.ghost {
      background: transparent;
      border-color: #d1d5db;
      color: #1b1c1d;
      &:hover:not(:disabled) { background: #f3f4f6; }
      &:disabled { opacity: 0.6; cursor: default; }
    }
  }
</style>
