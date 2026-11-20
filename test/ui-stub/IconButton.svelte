<script>
  let { label, icon, variant, size, tooltip, loading, pressed, ...rest } = $props();
</script>
<button aria-label={label} {...rest}></button>
