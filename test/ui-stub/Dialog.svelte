<script>
  // Inline stand-in for calliope-ui's Dialog (whose portal renders nothing on the server).
  let { title, description, closeLabel = 'Schließen', children, actions } = $props();
</script>
<div role="dialog"><h2>{title}</h2>{#if description}<p>{description}</p>{/if}<button aria-label={closeLabel}></button>{@render children?.()}{@render actions?.()}</div>
