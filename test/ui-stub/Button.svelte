<script>
  let { children, icon, iconEnd, variant, tone, size, loading, fullWidth, ...rest } = $props();
</script>
<button {...rest}>{@render children?.()}</button>
