/**
 * What New code component starts from. It places the classes each placement gives it (`class` on its root, `so_o` on
 * each part it marks), so what the Inspector styles reaches that placement alone.
 */
export const CODE_STARTER = `<script>
	let { heading = 'Hello', text = 'A custom component.', class: className = '', so_o } = $props();
	let count = $state(0);
</script>

<section class={['custom', className]}>
	<h2 class={so_o?.heading} data-so-part="heading">{heading}</h2>
	<p>{text}</p>
	<button type="button" onclick={() => count++}>Clicked {count} times</button>
</section>

<style>
	.custom {
		padding: var(--so-space-section) var(--so-container-gutter);
		max-width: var(--so-container-content);
		margin-inline: auto;
	}
	h2 {
		font-family: var(--so-text-h2-family);
		font-size: var(--so-text-h2-size);
	}
	button {
		margin-top: var(--so-space-md);
	}
</style>
`;

/** The properties the starter source reads; the person edits them in the Properties tab before creating. */
export const CODE_STARTER_PROPERTIES = {
  heading: { type: 'string', label: 'Heading', default: 'Hello' },
  text: { type: 'string', label: 'Text', default: 'A custom component.', multiline: true }
} as const;
