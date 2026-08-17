<script module lang="ts">
  /**
   * Close callbacks of the currently-open popovers, so opening one closes the
   * others. calliope-campus got that mutual exclusion from its app-level
   * Dropdown's global registry; keeping a registry here preserves the behaviour
   * without depending on a host component.
   *
   * A plain Set on purpose — it is never read from markup, so making it reactive
   * would only add a dependency no one observes.
   */
  const openPopovers = new Set<() => void>();

  export function closeAllPopovers(): void {
    for (const close of [...openPopovers]) close();
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Minimal bottom-end anchored popover. Deliberately dependency-free — the
   * toolbar only ever needs a panel hanging off the right edge of its trigger,
   * so a floating-ui integration would be dead weight.
   *
   * The trigger snippet receives the open state and is expected to render the
   * real interactive control (a `<button>`); this component only delegates its
   * click. That keeps the accessible button the caller's, rather than nesting it
   * inside a second fake one.
   */
  let {
    minWidth = '240px',
    trigger,
    children,
  }: {
    minWidth?: string;
    trigger: Snippet<[boolean]>;
    children: Snippet;
  } = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  const close = () => {
    open = false;
    openPopovers.delete(close);
  };

  function toggle() {
    if (open) {
      close();
      return;
    }
    // Close siblings first so only one panel is ever on screen.
    closeAllPopovers();
    open = true;
    openPopovers.add(close);
  }

  $effect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    // Capture phase: a click inside the panel that removes its own row (the
    // extension remove button) detaches the target before a bubbling listener
    // would run, which would then read as "outside" and close the panel.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  });

  // A popover unmounted while open would otherwise leak its close callback into
  // the registry and swallow the next closeAllPopovers().
  $effect(() => () => {
    openPopovers.delete(close);
  });
</script>

<div class="popover-root" bind:this={root}>
  <!-- The trigger snippet renders the button; this wrapper only catches its
       click (which a keyboard Enter/Space on that button also produces). -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="popover-trigger" onclick={toggle}>
    {@render trigger(open)}
  </div>

  {#if open}
    <div class="popover-panel" style:min-width={minWidth}>
      {@render children()}
    </div>
  {/if}
</div>

<style lang="scss">
  .popover-root {
    position: relative;
    display: inline-flex;
  }
  .popover-trigger {
    display: inline-flex;
  }
  .popover-panel {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 60;
    background: var(--mkc-panel-bg, #ffffff);
    color: var(--mkc-panel-fg, #333333);
    border: 1px solid var(--mkc-panel-border, rgba(0, 0, 0, 0.12));
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    overflow: hidden;
  }
</style>
