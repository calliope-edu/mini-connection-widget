<script lang="ts">
  /**
   * Result of MakeCode's `shareProject()` — the public URL plus its QR code.
   * The editor runs with `hidemenu=1` + `controller=2`, so pxt's own share UI is
   * hidden and the host has to present the result itself.
   *
   * Self-contained (no host Modal/Button), matching the widget's other modals.
   */
  import { mergeMakeCodeLabels, type MakeCodeLabels } from './labels';
  import type { ShareResult } from '../driver';

  let {
    open = false,
    loading = false,
    error = null,
    result = null,
    programName = '',
    labels: labelOverrides,
    onClose,
    onCopied,
    onCopyFailed,
  }: {
    open?: boolean;
    loading?: boolean;
    error?: string | null;
    result?: ShareResult | null;
    programName?: string;
    labels?: Partial<MakeCodeLabels>;
    onClose: () => void;
    /** Hosts with a toast system surface the confirmation there. */
    onCopied?: (message: string) => void;
    onCopyFailed?: (message: string) => void;
  } = $props();

  const l = $derived(mergeMakeCodeLabels(labelOverrides));

  let copied = $state(false);
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyUrl(): Promise<void> {
    if (!result?.url) return;
    try {
      await navigator.clipboard.writeText(result.url);
      copied = true;
      onCopied?.(l.shareLinkCopied);
      clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => (copied = false), 2000);
    } catch (err) {
      console.warn('[makecode] clipboard copy failed', err);
      onCopyFailed?.(l.shareCopyFailed);
    }
  }

  function openLink(): void {
    if (result?.url) window.open(result.url, '_blank', 'noopener');
  }

  $effect(() => () => clearTimeout(copyResetTimer));
</script>

{#if open}
  <div
    class="backdrop"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="makecode-share-title"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
    onkeydown={(e) => {
      if (e.key === 'Escape') onClose();
    }}
  >
    <div class="card">
      <div class="card-header">
        <h2 id="makecode-share-title">{l.shareModalTitle}</h2>
        <button type="button" class="close-btn" aria-label={l.shareClose} onclick={onClose}>
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <div class="card-body">
        {#if loading}
          <div class="share-loading">
            <span class="spinner" aria-hidden="true"></span>
            <p>{l.shareCreatingLink}</p>
          </div>
        {:else if error}
          <p class="share-error">{error}</p>
        {:else if result}
          <p class="share-intro">
            {l.shareIntroBefore}<strong>{programName || l.shareThisProgram}</strong>{l.shareIntroAfter}
          </p>

          <div class="share-url-row">
            <input
              class="share-url"
              type="text"
              readonly
              value={result.url}
              onclick={(e) => e.currentTarget.select()}
              aria-label={l.shareLinkAria}
            />
            <button
              class="copy-btn"
              onclick={copyUrl}
              title={l.shareCopyLink}
              aria-label={l.shareCopyLink}
            >
              {#if copied}
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              {:else}
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h8" />
                </svg>
              {/if}
            </button>
          </div>

          {#if result.qr}
            <div class="share-qr">
              <img src={result.qr} alt={l.shareQrAlt} />
            </div>
          {/if}
        {/if}
      </div>

      <div class="actions">
        <button type="button" class="btn ghost" onclick={onClose}>{l.shareClose}</button>
        {#if result?.url}
          <button type="button" class="btn primary" onclick={openLink}>{l.shareOpen}</button>
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
    &:active {
      transform: scale(0.95);
    }
  }
  .card-body {
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .share-intro {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: #4b5563;
  }
  .share-error {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: #c82333;
  }
  .share-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding: 1.5rem 0;
    color: #64748b;

    p {
      margin: 0;
      font-size: 13px;
    }
  }
  .spinner {
    width: 2rem;
    height: 2rem;
    border: 3px solid #e8edeb;
    border-top-color: #1b1c1d;
    border-radius: 50%;
    animation: share-spin 0.8s linear infinite;
  }
  @keyframes share-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .share-url-row {
    display: flex;
    align-items: stretch;
    gap: 0.5rem;
  }
  .share-url {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.6rem 0.75rem;
    font-size: 0.85rem;
    font-family: 'SF Mono', 'Monaco', 'Roboto Mono', monospace;
    color: #1b1c1d;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 8px;

    &:focus {
      outline: 2px solid hsl(181, 57%, 53%);
      outline-offset: 1px;
    }
  }
  .copy-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 2.6rem;
    background: #1b1c1d;
    color: #ffffff;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: background-color 0.15s ease;

    &:hover {
      background: #343537;
    }
  }
  .share-qr {
    display: flex;
    justify-content: center;
    padding: 0.5rem 0;

    img {
      width: 180px;
      height: 180px;
      max-width: 100%;
      image-rendering: pixelated;
      border: 1px solid #e8edeb;
      border-radius: 8px;
      background: #ffffff;
    }
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
      &:hover:not(:disabled) {
        background: #f3f4f6;
      }
    }
    &.primary {
      background: #1b1c1d;
      color: #ffffff;
      &:hover:not(:disabled) {
        background: #343537;
      }
    }
    &:disabled {
      opacity: 0.55;
      cursor: default;
    }
  }
</style>
