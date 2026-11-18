<script lang="ts">
  /**
   * "Which Calliope mini is this — 1 or 2?" modal. Raised by the flash
   * dispatcher's RAM-fit gate before a BLE flash of a 32 KB hex to a device
   * whose version is ambiguous. Same calliope-ui `Dialog` + `ChoiceList` build
   * as `ConnectionChoiceModal`.
   */
  import { Button, ChoiceItem, ChoiceList, Dialog } from '@calliope-edu/ui';
  import { mini12VersionAskRequest } from '../mini12-version-ask';

  const req = $derived($mini12VersionAskRequest);
</script>

{#if req}
  {#key req}
    <Dialog
      open
      size="s"
      title="Welcher Calliope mini ist das?"
      description={`„${req.fileName}“ braucht 32 KB RAM und läuft nur auf dem Calliope mini 2. Über Bluetooth können wir mini 1 und mini 2 nicht unterscheiden: Die Version steht auf der Rückseite des Boards.`}
      onOpenChange={(open) => { if (!open) req.choose('cancel'); }}
    >
      <ChoiceList>
        <ChoiceItem
          icon="device"
          title="Calliope mini 2"
          detail="32 KB RAM. Die Übertragung startet."
          onclick={() => req.choose('V2')}
        />
        <ChoiceItem
          icon="device"
          title="Calliope mini 1"
          detail="16 KB RAM. Dieses Programm kann darauf nicht laufen."
          onclick={() => req.choose('V1')}
        />
      </ChoiceList>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => req.choose('cancel')}>Abbrechen</Button>
      {/snippet}
    </Dialog>
  {/key}
{/if}
