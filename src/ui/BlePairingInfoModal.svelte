<script lang="ts">
  import { calliopeBlePairingInfo, dismissBlePairingInfo } from '../pairing-info';
  import { calliopeState, updateState } from '../state';
  import { connectCalliope } from '../connect';
  import { disconnectBle } from '../ble';
  import { appendLog } from '../log';

  const visible = $derived($calliopeBlePairingInfo);
  const staleBond = $derived($calliopeState.bleStaleBond);
  let retrying = $state(false);
  /** Tick-counter for the auto-reconnect poll, shown to the user so they
   *  can see the widget is actively trying. Resets on every modal open. */
  let pollAttempts = $state(0);

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

  // ---- Auto-reconnect poll ----------------------------------------------
  //
  // After the user does OS-side pairing, the bond exists in Windows but
  // the widget has no event to subscribe to — Web Bluetooth doesn't emit
  // anything when the OS bond store changes. So while the modal is open,
  // we periodically attempt a silent reconnect. The first one that
  // succeeds and lands on `bond-ok` auto-dismisses the modal — the user
  // never has to click "Erneut verbinden" if the OS pairing just worked.
  //
  // The Calliope's display tends to stick on the ✓ checkmark after a
  // successful bond, in pair-mode, until the user presses Reset. So we
  // also keep polling across that window: the moment the user presses
  // Reset, the device reboots into application mode, advertises with
  // its whitelist (now matching the OS bond), and our next poll
  // re-establishes the encrypted link.
  //
  // Manual "Erneut verbinden" button is preserved as a fallback for when
  // the user wants to force a retry immediately.
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollGen = 0; // increments per modal-open cycle, so stale timers no-op
  $effect(() => {
    if (!visible) {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      pollAttempts = 0;
      return;
    }
    pollGen += 1;
    pollAttempts = 0;
    const myGen = pollGen;
    // Initial delay long enough for the user to start interacting with the
    // OS dialog. We don't want our poll racing the OS pairing wizard.
    const start = 6_000;
    const interval = 3_500;
    // Total polling budget ~3 minutes — plenty of time to walk through
    // Settings → Add device → press Reset → wait for reboot.
    const giveUpAfter = 180_000;
    const deadline = Date.now() + giveUpAfter;
    const tick = async () => {
      if (myGen !== pollGen) return;       // modal was reopened, stale loop
      if (Date.now() > deadline) {
        appendLog({ direction: 'info', text: 'Pairing auto-poll giving up — user can still click Erneut verbinden.' });
        return;
      }
      pollAttempts += 1;
      try {
        // Silent attempt: forceChooser=false so we never re-prompt the
        // picker. If the user hasn't paired yet this fails harmlessly
        // and we try again on the next tick.
        await connectCalliope('ble', false);
        // Check the post-connect classifier result. The status listener
        // in ble.ts runs the classifier ~250ms after status flips, so
        // we wait a beat before deciding.
        await new Promise((r) => setTimeout(r, 500));
        let s: typeof $calliopeState | null = null;
        const unsub = calliopeState.subscribe((v) => { s = v; });
        unsub();
        if (s && (s as any).bleStatus === 'connected' && (s as any).bleSessionKind === 'bond-ok') {
          appendLog({ direction: 'info', text: 'Pairing detected via auto-poll — dismissing modal.' });
          dismissBlePairingInfo();
          return;
        }
      } catch { /* best effort */ }
      if (myGen === pollGen) {
        pollTimer = setTimeout(tick, interval);
      }
    };
    pollTimer = setTimeout(tick, start);
    return () => {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    };
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
            <div class="step-title">Reset drücken, sobald das ✓ erscheint</div>
            <div class="step-hint">
              Nach erfolgreicher Kopplung zeigt der Calliope ein Häkchen, bleibt aber im Pairing-Modus.
              Kurz <strong>Reset</strong> drücken — der Calliope startet neu, und das Häkchen verschwindet.
              Das Widget verbindet sich danach automatisch neu.
            </div>
          </div>
        </li>
      </ol>

      <div class="auto-poll-hint">
        <span class="auto-poll-spinner" aria-hidden="true"></span>
        <span>
          Widget prüft alle paar Sekunden, ob die Kopplung steht
          {#if pollAttempts > 0}({pollAttempts} ×){/if}.
          Sobald sie funktioniert, schließt sich dieses Fenster automatisch.
        </span>
      </div>

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
  .auto-poll-hint {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    margin: 8px 0 0;
    background: #ecfeff;
    border: 1px solid #a5f3fc;
    border-radius: 8px;
    color: #075985;
    font-size: 12px;
    text-align: left;
    line-height: 1.4;
  }
  .auto-poll-spinner {
    flex: 0 0 12px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid rgba(14, 165, 183, 0.25);
    border-top-color: #0ea5b7;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
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
