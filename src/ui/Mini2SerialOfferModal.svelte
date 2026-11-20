<script lang="ts">
  /**
   * "Add the mini 2's serial link?" modal. Driven by `mini2SerialOfferRequest`
   * (mini2-serial.ts raises it when a serial-consuming editor is active while
   * the mini 2 is connected flash-only). Accepting opens the Web Serial picker
   * from this button's click — the user gesture `requestPort` requires.
   */
  import { Button, Dialog } from '@calliope-edu/ui';
  import { mini2SerialOfferRequest } from '../mini2-serial';
  import { connectLabels } from './labels';

  const req = $derived($mini2SerialOfferRequest);
  const labels = $derived($connectLabels);
  let busy = $state(false);
  async function accept(): Promise<void> {
    if (!req || busy) return;
    busy = true;
    try {
      await req.accept();
    } finally {
      busy = false;
    }
  }
</script>

{#if req}
  {#key req}
    <Dialog
      open
      size="s"
      title={labels.mini2SerialTitle}
      closeLabel={labels.close}
      onOpenChange={(open) => { if (!open) req.decline(); }}
    >
      <p>{labels.mini2SerialText}</p>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => req.decline()} disabled={busy}>{labels.later}</Button>
        <Button icon="usb" onclick={accept} loading={busy}>{labels.serialConnect}</Button>
      {/snippet}
    </Dialog>
  {/key}
{/if}

<style>
  p {
    margin: 0;
    line-height: var(--cui-typography-prose-line-height);
  }
</style>
