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

  const req = $derived($calliopeConnectionChoiceRequest);
</script>

{#if req}
  {#key req}
    <Dialog
      open
      size="s"
      title="Programm übertragen"
      description={`Der Calliope ist gerade nicht verbunden. Wähle, wie „${req.fileName}“ aufs Gerät kommen soll.`}
      onOpenChange={(open) => { if (!open) req.cancel(); }}
    >
      <ChoiceList>
        {#if req.bleEnabled}
          <ChoiceItem
            icon="bluetooth"
            title="Per Bluetooth"
            detail="Drahtlos. Der Calliope muss eingeschaltet und in Reichweite sein."
            onclick={() => req.choose('ble')}
          />
        {/if}
        <ChoiceItem
          icon="usb"
          title="Per USB-Kabel"
          detail="Zuverlässig, funktioniert immer. Kabel an Calliope und Rechner anschließen."
          onclick={() => req.choose('usb')}
        />
        <ChoiceItem
          icon="download"
          title="Als Datei herunterladen"
          detail=".hex-Datei speichern und selbst auf den Calliope kopieren."
          onclick={() => req.choose('download')}
        />
      </ChoiceList>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => req.cancel()}>Abbrechen</Button>
      {/snippet}
    </Dialog>
  {/key}
{/if}
