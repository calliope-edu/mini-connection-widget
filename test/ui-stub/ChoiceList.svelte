<script>
  let { children, label } = $props();
</script>
<div role="group" aria-label={label}>{@render children?.()}</div>
