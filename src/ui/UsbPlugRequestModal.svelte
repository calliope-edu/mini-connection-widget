<script lang="ts">
  /**
   * "Plug the Calliope in over USB" confirm step. Driven by
   * `calliopeUsbPlugRequest`; a calliope-ui `Dialog` with plain footer
   * buttons, primary last. Escape, the scrim and the close button cancel.
   */
  import { Button, Dialog } from '@calliope-edu/ui';
  import { calliopeUsbPlugRequest } from '../usb-plug';
  import { connectLabels } from './labels';

  const req = $derived($calliopeUsbPlugRequest);
  const labels = $derived($connectLabels);
</script>

{#if req}
  {#key req}
    <Dialog
      open
      size="s"
      title={labels.usbPlugTitle}
      closeLabel={labels.close}
      onOpenChange={(open) => { if (!open) req.cancel(); }}
    >
      <ol class="steps">
        <li>{labels.usbPlugStep1}</li>
        <li>{labels.usbPlugStep2}</li>
      </ol>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => req.cancel()}>{labels.cancel}</Button>
        <Button icon="usb" onclick={() => req.confirm()}>{labels.usbPlugConfirm}</Button>
      {/snippet}
    </Dialog>
  {/key}
{/if}

<style>
  .steps {
    margin: 0;
    padding-left: var(--cui-space-5);
    line-height: var(--cui-typography-prose-line-height);
  }
  .steps li + li {
    margin-top: var(--cui-space-2);
  }
</style>
