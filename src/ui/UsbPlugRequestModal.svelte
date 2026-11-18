<script lang="ts">
  /**
   * "Plug the Calliope in over USB" confirm step. Driven by
   * `calliopeUsbPlugRequest`; a calliope-ui `Dialog` with plain footer
   * buttons, primary last. Escape, the scrim and the close button cancel.
   */
  import { Button, Dialog } from '@calliope-edu/ui';
  import { calliopeUsbPlugRequest } from '../usb-plug';

  const req = $derived($calliopeUsbPlugRequest);
</script>

{#if req}
  {#key req}
    <Dialog
      open
      size="s"
      title="Calliope per USB anschließen"
      onOpenChange={(open) => { if (!open) req.cancel(); }}
    >
      <ol class="steps">
        <li>USB-Kabel mit dem Calliope verbinden.</li>
        <li>Auf „Übertragen“ klicken. Beim allerersten Mal den Calliope im Browser-Dialog auswählen.</li>
      </ol>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => req.cancel()}>Abbrechen</Button>
        <Button icon="usb" onclick={() => req.confirm()}>Übertragen</Button>
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
