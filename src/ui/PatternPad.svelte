<script lang="ts">
  /**
   * Interactive 5×5 "name histogram" pad — the same image the Calliope draws
   * on its LED matrix in pairing mode. Each column is a bottom-anchored bar;
   * clicking a cell sets that column's height so the bar reaches that cell
   * (rows below included, rows above cleared). The resulting grid decodes to a
   * 5-letter friendly name via `patternToFriendlyName`, which the BLE chooser
   * uses to filter to a single device.
   *
   * Stateless: the parent owns `value` and gets a fresh grid through
   * `onchange`. Bottom-anchored editing guarantees every column stays a valid
   * histogram bar, so the decoded name is always well-formed.
   */
  interface Props {
    /** 5×5 lit grid; `value[row][col]`, row 0 is the top. */
    value: boolean[][];
    /** Receives a brand-new grid when the user edits a column. */
    onchange?: (grid: boolean[][]) => void;
    /** Pixel size of the square pad. */
    size?: number;
    /** Lit-pixel color. */
    color?: string;
    /** Unlit-pixel color. */
    offColor?: string;
    /** Read-only display (no pointer/keyboard editing). */
    disabled?: boolean;
  }
  let {
    value,
    onchange,
    size = 150,
    color = '#ff4e00',
    offColor = 'rgba(255,255,255,0.12)',
    disabled = false,
  }: Props = $props();

  const rows = [0, 1, 2, 3, 4];
  const cols = [0, 1, 2, 3, 4];

  function lit(r: number, c: number): boolean {
    return Boolean(value?.[r]?.[c]);
  }

  function setColumn(col: number, topRow: number): void {
    if (disabled) return;
    const grid = rows.map((r) => cols.map((c) => (c === col ? r >= topRow : lit(r, c))));
    onchange?.(grid);
  }
</script>

<div class="pad" class:disabled style="--size:{size}px; --on:{color}; --off:{offColor}">
  {#each rows as r (r)}
    {#each cols as c (c)}
      <button
        type="button"
        class="cell"
        class:on={lit(r, c)}
        aria-label={`Spalte ${c + 1}, Höhe ${5 - r}`}
        aria-pressed={lit(r, c)}
        {disabled}
        onclick={() => setColumn(c, r)}
      ></button>
    {/each}
  {/each}
</div>

<style>
  .pad {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    grid-template-rows: repeat(5, 1fr);
    gap: 6px;
    width: var(--size);
    height: var(--size);
  }
  .cell {
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: var(--off);
    cursor: pointer;
    transition: background 0.12s ease, transform 0.08s ease;
  }
  .cell.on {
    background: var(--on);
  }
  .cell:not(:disabled):hover {
    transform: scale(1.06);
  }
  .cell:not(:disabled):focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  .cell:disabled {
    cursor: default;
  }
  .pad.disabled .cell {
    cursor: default;
  }
</style>
