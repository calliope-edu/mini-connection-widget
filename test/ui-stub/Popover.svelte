<script>
  let { trigger, children, title } = $props();
</script>
{@render trigger?.({ props: {} })}<div role="dialog">{#if title}<h2>{title}</h2>{/if}{@render children?.()}</div>
