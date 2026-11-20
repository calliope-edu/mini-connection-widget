<script lang="ts">
  /**
   * Result of MakeCode's `shareProject()` — the public URL plus its QR code.
   * The editor runs with `hidemenu=1` + `controller=2`, so pxt's own share UI is
   * hidden and the host has to present the result itself.
   *
   * Built from calliope-ui `Dialog`, `TextField` and `Button`, like the
   * widget's other modals (focus trap, Escape and the scrim close it).
   */
  import { Button, Dialog, IconButton, Spinner, TextField } from '@calliope-edu/ui';
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
  <Dialog
    open
    size="s"
    title={l.shareModalTitle}
    closeLabel={l.shareClose}
    onOpenChange={(o) => { if (!o) onClose(); }}
  >
    {#if loading}
      <Spinner label={l.shareCreatingLink} />
    {:else if error}
      <p class="share-error">{error}</p>
    {:else if result}
      <p class="share-intro">
        {l.shareIntroBefore}<strong>{programName || l.shareThisProgram}</strong>{l.shareIntroAfter}
      </p>

      <TextField
        label={l.shareLinkAria}
        value={result.url}
        readonly
        onclick={(e) => e.currentTarget.select()}
      >
        {#snippet end()}
          <IconButton
            icon={copied ? 'check' : 'copy'}
            label={l.shareCopyLink}
            size="s"
            onclick={copyUrl}
          />
        {/snippet}
      </TextField>

      {#if result.qr}
        <div class="share-qr">
          <img src={result.qr} alt={l.shareQrAlt} />
        </div>
      {/if}
    {/if}

    {#snippet actions()}
      <Button variant="secondary" onclick={onClose}>{l.shareClose}</Button>
      {#if result?.url}
        <Button icon="external-link" onclick={openLink}>{l.shareOpen}</Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .share-intro,
  .share-error {
    margin: 0 0 var(--cui-space-3);
    line-height: var(--cui-typography-prose-line-height);
  }
  .share-error {
    padding-left: var(--cui-space-3);
    border-left: 4px solid var(--cui-status-error-fill);
    color: var(--cui-text-error);
  }
  .share-qr {
    display: flex;
    justify-content: center;
    margin-top: var(--cui-space-4);
  }
  /* The QR image is dark on white by itself; a white frame keeps it
     scannable on the dark theme too. */
  .share-qr img {
    width: 10rem;
    height: 10rem;
    padding: var(--cui-space-2);
    border: var(--cui-border-width-hairline) solid var(--cui-border-subtle);
    border-radius: var(--cui-radius-lg);
    background-color: var(--cui-palette-white);
    image-rendering: pixelated;
  }
</style>
