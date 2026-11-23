import { ICONS } from '@catalogue/foundation/icons';

/**
 * Small, ordinary Svelte helpers written into every generated project.
 * They are part of the portable source and contain no editor instrumentation.
 */

export const LINK_SVELTE = `<script>
	/** Renders a resolved link. Buttons without a destination render as plain text. */
	let { link = null, appearance = '', class: className = '', children, ...rest } = $props();
	const href = $derived(link?.href || null);
	const BUTTONS = ['primary', 'secondary', 'text', 'light'];
	const classes = $derived([
		BUTTONS.includes(appearance) ? \`so-btn so-btn--\${appearance}\` : appearance === 'plain' ? 'so-plain-link' : 'so-link',
		className
	]);
</script>

{#if href}
	<a
		{href}
		class={classes}
		target={link?.newTab ? '_blank' : undefined}
		rel={link?.newTab ? 'noopener noreferrer' : undefined}
		{...rest}>{@render children?.()}</a
	>
{:else}
	<span class={[BUTTONS.includes(appearance) && classes, className]} {...rest}>{@render children?.()}</span>
{/if}
`;

export const IMAGE_SVELTE = `<script>
	/** Renders a resolved image, or a neutral placeholder when no image is chosen. */
	let { image = null, class: className = '', eager = false, sizes = '(min-width: 1280px) 1200px, 100vw', ...rest } = $props();
</script>

{#if image?.src}
	<img
		src={image.src}
		srcset={image.srcset || undefined}
		sizes={image.srcset ? sizes : undefined}
		alt={image.decorative ? '' : image.alt || ''}
		width={image.width}
		height={image.height}
		loading={eager ? 'eager' : 'lazy'}
		decoding="async"
		class={['so-img', className]}
		{...rest}
	/>
{:else}
	<div
		class={['so-img', 'so-img--placeholder', className]}
		role={image?.alt && !image?.decorative ? 'img' : undefined}
		aria-label={image?.alt && !image?.decorative ? image.alt : undefined}
		aria-hidden={image?.alt && !image?.decorative ? undefined : 'true'}
		{...rest}
	>
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<circle cx="9" cy="9" r="2" />
			<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
		</svg>
	</div>
{/if}
`;

export const RICHTEXT_SVELTE = `<script>
	/**
	 * Renders structured rich text: an array of paragraphs with inline **strong** and *emphasis*.
	 * Text is always escaped; HTML is never interpreted.
	 */
	let { paragraphs = [], list = '', class: className = '', ...rest } = $props();

	function segments(text) {
		const out = [];
		const re = /(\\*\\*[^*]+\\*\\*|\\*[^*]+\\*)/g;
		let last = 0;
		let m;
		while ((m = re.exec(text))) {
			if (m.index > last) out.push({ text: text.slice(last, m.index) });
			const token = m[0];
			if (token.startsWith('**')) out.push({ text: token.slice(2, -2), strong: true });
			else out.push({ text: token.slice(1, -1), em: true });
			last = m.index + token.length;
		}
		if (last < text.length) out.push({ text: text.slice(last) });
		return out;
	}
	const items = $derived(Array.isArray(paragraphs) ? paragraphs : [String(paragraphs ?? '')]);
</script>

{#if list}
	<ul class={['so-rich', "so-rich--" + list, className]} {...rest}>
		{#each items as paragraph, i (i)}
			<li>
				{#each segments(paragraph) as seg, j (j)}{#if seg.strong}<strong>{seg.text}</strong>{:else if seg.em}<em>{seg.text}</em>{:else}{seg.text}{/if}{/each}
			</li>
		{/each}
	</ul>
{:else}
	<div class={['so-rich', className]} {...rest}>
		{#each items as paragraph, i (i)}
			<p>
				{#each segments(paragraph) as seg, j (j)}{#if seg.strong}<strong>{seg.text}</strong>{:else if seg.em}<em>{seg.text}</em>{:else}{seg.text}{/if}{/each}
			</p>
		{/each}
	</div>
{/if}
`;

export function iconSvelte(): string {
  return `<script>
	import { ICONS } from './icons.js';
	/** Inline SVG icon from the bundled icon set. */
	let { name = '', class: className = '', label = '', ...rest } = $props();
	const nodes = $derived(ICONS[name] ?? ICONS['sparkles']);
</script>

<svg
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.75"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={['so-icon', className]}
	role={label ? 'img' : undefined}
	aria-label={label || undefined}
	aria-hidden={label ? undefined : 'true'}
	{...rest}
>
	{#each nodes as [tag, attrs], i (i)}
		{#if tag === 'path'}<path {...attrs} />{:else if tag === 'circle'}<circle {...attrs} />{:else if tag === 'rect'}<rect
				{...attrs}
			/>{:else if tag === 'line'}<line {...attrs} />{:else if tag === 'polyline'}<polyline
				{...attrs}
			/>{:else if tag === 'ellipse'}<ellipse {...attrs} />{/if}
	{/each}
</svg>
`;
}

export function iconsJs(): string {
  return `/* Icon data from Lucide (https://lucide.dev), ISC licence. Copyright (c) Lucide contributors. */\nexport const ICONS = ${JSON.stringify(ICONS)};\n`;
}

export const UTIL_JS = `/** Returns whether a resolved value should be shown. */
export function has(value) {
	if (Array.isArray(value)) return value.length > 0;
	if (value && typeof value === 'object') {
		if ('href' in value) return !!value.href;
		if ('src' in value) return !!value.src;
		return true;
	}
	return !!value;
}
`;
