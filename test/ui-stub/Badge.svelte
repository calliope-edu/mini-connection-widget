<script>
  let { children, tone, size, icon, swatch, ...rest } = $props();
</script>
<span {...rest}>{@render children?.()}</span>
