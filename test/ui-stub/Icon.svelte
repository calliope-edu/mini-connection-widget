<script>
  let { name, label } = $props();
</script>
{#if label}<span role="img" aria-label={label}></span>{/if}
