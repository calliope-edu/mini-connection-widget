<script>
  // Tabs, TabList, TabPanel, Menu, MenuRadioGroup: render what they wrap.
  let { children, trigger, label } = $props();
</script>
{@render trigger?.({ props: {} })}{@render children?.()}
