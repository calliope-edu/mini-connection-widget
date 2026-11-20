<script lang="ts">
  /**
   * "Mini 2 USB flash failed — retry, download, or give up" modal. Driven by
   * `mini2FlashFallbackRequest` (usb.ts raises it after the SEGGER MSD path
   * failed despite an automatic retry). Same calliope-ui `Dialog` +
   * `ChoiceList` build as `ConnectionChoiceModal`.
   */
  import { Button, ChoiceItem, ChoiceList, Dialog } from '@calliope-edu/ui';
  import { mini2FlashFallbackRequest } from '../mini2-flash-fallback';
  import { connectLabels, labelParts } from './labels';
  import LabelText from './LabelText.svelte';

  const req = $derived($mini2FlashFallbackRequest);
  const labels = $derived($connectLabels);
</script>

{#if req}
  {#key req}
    <Dialog
      open
      size="s"
      title={labels.mini2FallbackTitle}
      closeLabel={labels.close}
      onOpenChange={(open) => { if (!open) req.choose('cancel'); }}
    >
      <p class="lead">
        <LabelText
          parts={labelParts(
            labels.mini2FallbackText,
            { fileName: req.fileName, attempts: req.attempts, drive: 'MINI' },
            ['fileName', 'drive'],
          )}
        />
      </p>
      <ChoiceList>
        <ChoiceItem
          icon="retry"
          title={labels.mini2FallbackRetry}
          detail={labels.mini2FallbackRetryDetail}
          onclick={() => req.choose('retry')}
        />
        <ChoiceItem
          icon="download"
          title={labels.downloadFile}
          detail={labels.mini2FallbackDownloadDetail}
          onclick={() => req.choose('download')}
        />
      </ChoiceList>
      {#if req.errorDetail}
        <p class="error-detail" title={req.errorDetail}>{labels.details}: {req.errorDetail}</p>
      {/if}
      {#snippet actions()}
        <Button variant="secondary" onclick={() => req.choose('cancel')}>{labels.cancel}</Button>
      {/snippet}
    </Dialog>
  {/key}
{/if}

<style>
  .lead {
    margin: 0 0 var(--cui-space-4);
    color: var(--cui-text-muted);
    line-height: var(--cui-typography-prose-line-height);
  }
  .lead :global(strong) {
    color: var(--cui-text-default);
  }
  .error-detail {
    margin: var(--cui-space-3) 0 0;
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-caption-font-size);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
