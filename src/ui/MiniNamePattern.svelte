<script lang="ts">
  import { friendlyNameToPattern } from '../friendly-name';

  interface Props {
    /** 5-letter Calliope/micro:bit friendly name (CVCVC). */
    name: string | undefined;
    /** Pixel size of the rendered grid; the 5×5 fills `size`×`size`. */
    size?: number;
    /** Pixel color when lit. */
    color?: string;
    /** Pixel color when off. */
    offColor?: string;
  }

  let { name, size = 36, color = '#ff4e00', offColor = 'rgba(0,0,0,0.08)' }: Props = $props();

  const grid = $derived(friendlyNameToPattern(name));
  const cell = $derived(size / 5);
</script>

{#if grid}
  <svg
    class="pattern"
    viewBox={`0 0 ${size} ${size}`}
    width={size}
    height={size}
    role="img"
    aria-label={`Calliope-Muster ${name}`}
  >
    {#each grid as row, r}
      {#each row as on, c}
        <rect
          x={c * cell + cell * 0.1}
          y={r * cell + cell * 0.1}
          width={cell * 0.8}
          height={cell * 0.8}
          rx={cell * 0.15}
          fill={on ? color : offColor}
        />
      {/each}
    {/each}
  </svg>
{/if}

<style>
  .pattern {
    flex-shrink: 0;
    display: block;
  }
</style>
