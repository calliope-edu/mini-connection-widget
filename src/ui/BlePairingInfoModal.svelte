<script lang="ts">
  import { calliopeBlePairingInfo, dismissBlePairingInfo } from '../pairing-info';
  import { calliopeState, updateState } from '../state';
  import { connectCalliope } from '../connect';
  import { disconnectBle } from '../ble';
  import { appendLog } from '../log';

  const visible = $derived($calliopeBlePairingInfo);
  const staleBond = $derived($calliopeState.bleStaleBond);
  let retrying = $state(false);

  // ---- Release the Chrome BLE link as soon as the modal opens -----------
  //
  // On Windows, Chrome's Web Bluetooth implementation does NOT write the
  // long-term key into the OS bond database when it negotiates a just-works
  // session. The only path to a real OS bond is letting Windows do the
  // pairing itself — and that requires Chrome to release the GATT link
  // first, because Windows' "Add a Bluetooth device" inquiry can't find a
  // pairable advertisement while the device is still connected to Chrome.
  //
  // The classifier in `connection-errors.ts` decides this modal should pop;
  // here we make sure the link is gone by the time the user reads step 1.
  let releasedFor = $state(false);
  $effect(() => {
    if (!visible || releasedFor) return;
    releasedFor = true;
    void (async () => {
      try {
        await disconnectBle();
        // Reset transport state so the UI reflects "disconnected" right away
        // — without this, the connection panel still shows "connected" while
        // the modal is up, which is confusing.
        updateState((s) => ({
          ...s,
          bleStatus: 'disconnected',
          bleCanFlash: false,
          bleCanCommunicate: false,
        }));
        appendLog({
          direction: 'info',
          text: 'BLE link released for OS pairing — Chrome was holding the connection.',
        });
      } catch { /* best effort */ }
    })();
  });
  // When the modal closes, allow re-arming on the next open.
  $effect(() => {
    if (!visible) releasedFor = false;
  });

  // Platform-specific deep link into the OS Bluetooth pane.
  //  - Windows: ms-settings: URI handled by the Settings app
  //  - macOS:   x-apple.systempreferences: URI handled by System Settings
  //  - Linux / unknown: no standard scheme, fall back to a manual hint
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
    // Anchor click (not location.href) so a blocked scheme doesn't navigate
    // the editor away.
    const a = document.createElement('a');
    a.href = osBluetoothUrl;
    a.rel = 'noopener';
    a.target = '_self';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function retryConnect(): Promise<void> {
    if (retrying) return;
    retrying = true;
    try {
      // forceChooser=false: the browser's per-origin permission is still
      // valid (the user already accepted the picker the first time). What
      // changed is the OS-level bond, and `c.connect()` will pick that up
      // transparently. Re-prompting the picker here would be wasted clicks
      // and would invalidate the picker's "remembered device" cache.
      await connectCalliope('ble', false);
      // Don't auto-dismiss — the connect status listener does that when
      // bleCanFlash flips to true. If pairing didn't actually take, the
      // user sees the same modal again with the next encrypted operation.
    } finally {
      retrying = false;
    }
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
        {staleBond ? 'Calliope neu koppeln' : 'Calliope koppeln'}
      </h2>
      <p class="lead">
        {#if staleBond}
          Das alte Pairing passt nicht mehr. So geht's:
        {:else}
          Damit Windows den Calliope koppeln kann, muss der Calliope im Pairing-Modus sein
          — sonst meldet Windows „Später nochmal versuchen".
        {/if}
      </p>

      <ol class="steps">
        {#if staleBond}
          <li>
            <span class="num">1</span>
            <div class="step-body">
              <div class="step-title">Alten Calliope entkoppeln</div>
              <div class="step-hint">
                In den Bluetooth-Einstellungen den alten Calliope antippen → „Gerät entfernen" / „Vergessen".
              </div>
              {#if osBluetoothUrl}
                <button type="button" class="step-btn" onclick={openOsBluetoothSettings}>
                  Bluetooth-Einstellungen öffnen
                </button>
              {/if}
            </div>
          </li>
        {/if}

        <li>
          <span class="num">{staleBond ? 2 : 1}</span>
          <div class="step-body">
            <div class="step-title">Calliope in den Pairing-Modus bringen</div>
            <div class="step-hint">
              A + B gedrückt halten und kurz Reset drücken. Das Display zeigt <code>PAIR</code> und
              ein scrollendes Symbol-Muster. Erst jetzt nimmt der Calliope eine neue Kopplung an.
            </div>
          </div>
        </li>

        <li>
          <span class="num">{staleBond ? 3 : 2}</span>
          <div class="step-body">
            <div class="step-title">In den Bluetooth-Einstellungen hinzufügen</div>
            <div class="step-hint">
              „Bluetooth-Gerät hinzufügen" → <strong>Calliope mini [xxxxx]</strong> auswählen → bestätigen
              (kein PIN nötig). Wenn Windows „Später nochmal versuchen" sagt: nochmal A + B + Reset drücken,
              der Calliope war nicht mehr im Pairing-Modus.
            </div>
            {#if osBluetoothUrl && !staleBond}
              <button type="button" class="step-btn" onclick={openOsBluetoothSettings}>
                Bluetooth-Einstellungen öffnen
              </button>
            {/if}
          </div>
        </li>

        <li>
          <span class="num">{staleBond ? 4 : 3}</span>
          <div class="step-body">
            <div class="step-title">Hier zurückkommen und „Erneut verbinden"</div>
            <div class="step-hint">
              Sobald Windows die Kopplung bestätigt hat, unten auf <em>Fertig — erneut verbinden</em> klicken.
            </div>
          </div>
        </li>
      </ol>

      <p class="hint">
        Tipp: Mit dem <strong>USB-Kabel</strong> brauchst du keine Kopplung.
      </p>

      <div class="actions">
        <button type="button" class="btn secondary" onclick={() => dismissBlePairingInfo()}>
          Schließen
        </button>
        <button type="button" class="btn primary" onclick={retryConnect} disabled={retrying}>
          {retrying ? 'Verbinde…' : 'Fertig — erneut verbinden'}
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
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 6px;
  }
  .lead {
    font-size: 14px;
    line-height: 1.5;
    color: #4b5563;
    margin: 0 0 16px;
  }
  .hint {
    background: #f1f5f9;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    color: #334155;
    text-align: left;
    margin: 0 0 4px;
  }
  .steps {
    list-style: none;
    text-align: left;
    margin: 0 0 14px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .steps li {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    background: #f8fafc;
    border-radius: 10px;
    padding: 10px 12px;
  }
  .num {
    flex: 0 0 28px;
    height: 28px;
    border-radius: 50%;
    background: #0ea5b7;
    color: #fff;
    font-weight: 700;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .step-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .step-title {
    font-weight: 600;
    font-size: 14px;
    color: #1b1c1d;
  }
  .step-hint {
    font-size: 12.5px;
    color: #4b5563;
    line-height: 1.45;
    code {
      background: #e2e8f0;
      padding: 1px 5px;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
  }
  .step-btn {
    align-self: flex-start;
    background: #0ea5b7;
    color: #fff;
    border: none;
    padding: 6px 12px;
    border-radius: 6px;
    font-weight: 600;
    font-size: 12.5px;
    cursor: pointer;
    transition: background 0.15s;
    margin-top: 2px;
    &:hover { background: #0891a4; }
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 14px;
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
</style>
