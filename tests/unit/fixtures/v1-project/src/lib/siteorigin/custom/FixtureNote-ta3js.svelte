<script>
	let { text = "Note", class: className = "" } = $props();
</script>

<p class={className}>{text}</p>
