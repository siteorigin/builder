import type { ProjectState } from '@shared/types';
import { ICONS } from '@catalogue/foundation/icons';

/**
 * Small, ordinary Svelte helpers written into every generated project.
 * They are part of the portable source and contain no editor instrumentation.
 */

export const LINK_SVELTE = `<script>
	/**
	 * Renders a resolved link. Site-relative links go through SvelteKit's resolve(), so the site also
	 * works when it is published under a sub-path. A button without a destination renders as plain,
	 * non-interactive text.
	 */
	import { resolve } from '$app/paths';
	let { link = null, appearance = '', class: className = '', children, ...rest } = $props();
	const href = $derived(link?.href ? (link.href.startsWith('/') && !link.href.startsWith('//') ? resolve(link.href) : link.href) : null);
	const BUTTONS = ['primary', 'secondary', 'text', 'light'];
	const button = $derived(BUTTONS.includes(appearance));
	const kind = $derived(button ? \`so-btn so-btn--\${appearance}\` : appearance === 'plain' ? 'so-plain-link' : 'so-link');
</script>

{#if href}
	<a
		{href}
		class={[kind, className]}
		target={link?.newTab ? '_blank' : undefined}
		rel={link?.newTab ? 'noopener noreferrer' : undefined}
		{...rest}>{@render children?.()}</a
	>
{:else}
	<span class={[button && kind, button && 'so-btn--static', className]} {...rest}>{@render children?.()}</span>
{/if}
`;

export const IMAGE_SVELTE = `<script>
	/**
	 * Renders a resolved image, or a neutral placeholder when no image is chosen.
	 * Images in the first section of a page load eagerly with high priority (they are usually the
	 * largest thing on screen); everything else is lazy.
	 */
	import { asset } from '$app/paths';
	let { image = null, class: className = '', eager = false, sizes = '100vw', ...rest } = $props();
	const url = (path) => (path.startsWith('/') && !path.startsWith('//') ? asset(path.slice(1)) : path);
	const srcset = $derived(
		image?.srcset
			? image.srcset
					.split(', ')
					.map((candidate) => {
						const [path, width] = candidate.split(' ');
						return \`\${url(path)} \${width}\`;
					})
					.join(', ')
			: undefined
	);
</script>

{#if image?.src}
	<img
		src={url(image.src)}
		{srcset}
		sizes={srcset ? sizes : undefined}
		alt={image.decorative ? '' : image.alt || ''}
		width={image.width}
		height={image.height}
		loading={eager ? 'eager' : 'lazy'}
		fetchpriority={eager ? 'high' : undefined}
		decoding={eager ? undefined : 'async'}
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
	const nodes = $derived(ICONS[name] ?? ICONS['sparkles'] ?? []);
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

/** Licence notice carried with the icon data into every project. */
export const ICON_NOTICE = `/*
 * Icon data from Lucide (https://lucide.dev). ISC License. Copyright (c) Lucide Icons and Contributors.
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
 * granted, provided that the above copyright notice and this permission notice appear in all copies.
 * Some icons are derived from Feather (https://feathericons.com). MIT License. Copyright (c) 2013-present Cole Bemis.
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, subject to the condition that
 * the above copyright notice and this permission notice shall be included in all copies or substantial portions.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */`;

/** The icon used when a name is unknown; always included. */
export const FALLBACK_ICON = 'sparkles';

/**
 * Icon names a project can show: any string in its pages, shell and component definitions that names a
 * bundled icon, plus quoted names in code component source. Over-inclusion is harmless; omission is not.
 */
export function usedIcons(state: ProjectState): string[] {
  const found = new Set<string>([FALLBACK_ICON]);
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      if (Object.hasOwn(ICONS, v)) found.add(v);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(state.pages);
  visit(state.site.shell);
  for (const def of Object.values(state.components)) {
    if (def.kind === 'code') {
      for (const m of (def.source ?? '').matchAll(/['"`]([a-z0-9-]+)['"`]/g)) if (Object.hasOwn(ICONS, m[1])) found.add(m[1]);
    }
    visit(def.properties);
    visit(def.tree);
  }
  return Object.keys(ICONS).filter((n) => found.has(n));
}

/** Icon data for the icons the project uses. */
export function iconsJs(state: ProjectState): string {
  const used = Object.fromEntries(usedIcons(state).map((n) => [n, ICONS[n]]));
  return `${ICON_NOTICE}\nexport const ICONS = ${JSON.stringify(used)};\n`;
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
