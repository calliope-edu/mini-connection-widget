<script lang="ts">
  /**
   * Renders a parameterised label (see `labelParts`): plain text, with each
   * marked placeholder's value wrapped in `tag` — the bold file name in a
   * dialog, a code example in the comms log. No `{@html}`, so a file name
   * can't inject markup.
   */
  import type { LabelPart } from './labels';

  type Props = { parts: LabelPart[]; tag?: 'strong' | 'code' };
  let { parts, tag = 'strong' }: Props = $props();
</script>

{#each parts as part, i (i)}{#if part.param}<svelte:element this={tag}>{part.text}</svelte:element>{:else}{part.text}{/if}{/each}
