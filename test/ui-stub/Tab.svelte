<script>
  let { children } = $props();
</script>
<button role="tab">{@render children?.()}</button>
