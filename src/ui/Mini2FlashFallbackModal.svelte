<script lang="ts">
  /**
   * "Mini 2 USB flash failed — retry, download, or give up" modal. Driven by
   * `mini2FlashFallbackRequest` (usb.ts raises it after the SEGGER MSD path
   * failed despite an automatic retry). Same calliope-ui `Dialog` +
   * `ChoiceList` build as `ConnectionChoiceModal`.
   */
  import { Button, ChoiceItem, ChoiceList, Dialog } from '@calliope-edu/ui';
  import { mini2FlashFallbackRequest } from '../mini2-flash-fallback';

  const req = $derived($mini2FlashFallbackRequest);
</script>

{#if req}
  {#key req}
    <Dialog
      open
      size="s"
      title="USB-Übertragung fehlgeschlagen"
      description={`„${req.fileName}“ konnte nicht auf den Calliope mini 2 übertragen werden (${req.attempts} Versuche). Du kannst es erneut versuchen oder die .hex-Datei herunterladen und selbst auf das Laufwerk „MINI“ ziehen, das klappt immer.`}
      onOpenChange={(open) => { if (!open) req.choose('cancel'); }}
    >
      <ChoiceList>
        <ChoiceItem
          icon="retry"
          title="Nochmal versuchen"
          detail="Übertragung über USB erneut starten."
          onclick={() => req.choose('retry')}
        />
        <ChoiceItem
          icon="download"
          title="Als Datei herunterladen"
          detail="Im Datei-Explorer auf das Laufwerk „MINI“ ziehen."
          onclick={() => req.choose('download')}
        />
      </ChoiceList>
      {#if req.errorDetail}
        <p class="error-detail" title={req.errorDetail}>Details: {req.errorDetail}</p>
      {/if}
      {#snippet actions()}
        <Button variant="secondary" onclick={() => req.choose('cancel')}>Abbrechen</Button>
      {/snippet}
    </Dialog>
  {/key}
{/if}

<style>
  .error-detail {
    margin: var(--cui-space-3) 0 0;
    color: var(--cui-text-muted);
    font-size: var(--cui-typography-caption-font-size);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
