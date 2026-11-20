<script>
  let { title, detail, icon, ...rest } = $props();
</script>
<button {...rest}><span>{title}</span>{#if detail}<span>{detail}</span>{/if}</button>
