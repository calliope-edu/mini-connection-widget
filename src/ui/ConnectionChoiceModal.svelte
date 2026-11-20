<script lang="ts">
  /**
   * "How should the program get onto the device?" — shown when a flash is
   * requested while nothing is connected. Driven by
   * `calliopeConnectionChoiceRequest`; built from calliope-ui `Dialog` +
   * `ChoiceList` (the template is the `Rezepte/Verbindungs-Widget` story).
   * Escape, the scrim, the close button and "Abbrechen" all cancel.
   */
  import { Button, ChoiceItem, ChoiceList, Dialog } from '@calliope-edu/ui';
  import { calliopeConnectionChoiceRequest } from '../connection-choice';
  import { connectLabels, labelParts } from './labels';
  import LabelText from './LabelText.svelte';

  const req = $derived($calliopeConnectionChoiceRequest);
  const labels = $derived($connectLabels);
</script>

{#if req}
  {#key req}
    <Dialog
      open
      size="s"
      title={labels.choiceTitle}
      closeLabel={labels.close}
      onOpenChange={(open) => { if (!open) req.cancel(); }}
    >
      <!-- In the body rather than as the Dialog description: the file name
           is bold, and a description is plain text. -->
      <p class="lead">
        <LabelText parts={labelParts(labels.choiceText, { fileName: req.fileName }, ['fileName'])} />
      </p>
      <ChoiceList>
        {#if req.bleEnabled}
          <ChoiceItem
            icon="bluetooth"
            title={labels.choiceBle}
            detail={labels.choiceBleDetail}
            onclick={() => req.choose('ble')}
          />
        {/if}
        <ChoiceItem
          icon="usb"
          title={labels.choiceUsb}
          detail={labels.choiceUsbDetail}
          onclick={() => req.choose('usb')}
        />
        <ChoiceItem
          icon="download"
          title={labels.downloadFile}
          detail={labels.choiceDownloadDetail}
          onclick={() => req.choose('download')}
        />
      </ChoiceList>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => req.cancel()}>{labels.cancel}</Button>
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
</style>
