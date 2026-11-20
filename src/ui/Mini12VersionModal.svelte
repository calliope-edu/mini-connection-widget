<script lang="ts">
  /**
   * "Which Calliope mini is this — 1 or 2?" modal. Raised by the flash
   * dispatcher's RAM-fit gate before a BLE flash of a 32 KB hex to a device
   * whose version is ambiguous. Same calliope-ui `Dialog` + `ChoiceList` build
   * as `ConnectionChoiceModal`.
   */
  import { Button, ChoiceItem, ChoiceList, Dialog } from '@calliope-edu/ui';
  import { mini12VersionAskRequest } from '../mini12-version-ask';
  import { connectLabels, labelParts } from './labels';
  import LabelText from './LabelText.svelte';

  const req = $derived($mini12VersionAskRequest);
  const labels = $derived($connectLabels);
</script>

{#if req}
  {#key req}
    <Dialog
      open
      size="s"
      title={labels.mini12Title}
      closeLabel={labels.close}
      onOpenChange={(open) => { if (!open) req.choose('cancel'); }}
    >
      <p class="lead">
        <LabelText parts={labelParts(labels.mini12Text, { fileName: req.fileName }, ['fileName'])} />
      </p>
      <ChoiceList>
        <ChoiceItem
          icon="device"
          title="Calliope mini 2"
          detail={labels.mini12Mini2Detail}
          onclick={() => req.choose('V2')}
        />
        <ChoiceItem
          icon="device"
          title="Calliope mini 1"
          detail={labels.mini12Mini1Detail}
          onclick={() => req.choose('V1')}
        />
      </ChoiceList>
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
</style>
