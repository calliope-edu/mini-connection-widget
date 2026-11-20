<script>
  let { label, value, hint } = $props();
</script>
<div><span>{label}</span>{#if value !== null && value !== undefined}<span>{value}</span>{/if}{#if hint}<span>{hint}</span>{/if}</div>
