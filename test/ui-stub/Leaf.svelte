<script>
  // TextField, SegmentedControl, MenuRadioItem: their label or text only.
  let { label, children } = $props();
</script>
{label ?? ''}{@render children?.()}
