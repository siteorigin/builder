import type { ProjectState } from '@shared/types';
import { ICONS } from '@shared/icons';
import { derived } from './cache';

/**
 * Small, ordinary Svelte helpers written into every generated project.
 * They are part of the portable source and contain no editor instrumentation.
 */

/**
 * The Link helper. Visitors never see a button without a destination: it would look clickable and do nothing.
 * Only its anchor ID stays, so links to it still land. The editor's preview variant (`instrument`) shows such a
 * button instead, marked for the bridge to flag in Edit and hide in Preview. That includes a button a code
 * component places, which a click selects through its placement.
 */
export function linkSvelte(instrument = false): string {
  const unlinked = instrument
    ? `<span class={[kind, className]} data-so-unlinked="" title="No link yet. Visitors won’t see this button until it goes somewhere." {...rest}>{@render children?.()}</span>`
    : '{#if rest.id}<span id={rest.id}></span>{/if}';
  return `<script>
	/**
	 * Renders a resolved link. Site-relative links go through SvelteKit's resolve(), so the site also
	 * works when it is published under a sub-path. A button without a destination but with a click handler
	 * (from your own code) is a real button, and so is a \`so_control\` (one that changes what its component shows),
	 * whatever it looks like; a button with neither is left out (keeping only its id, so links to it still land).
	 * Other links without a destination render as their text. With \`card\` (a tag), the link is a
	 * whole container: an anchor around everything inside it, or that tag when there is nowhere to go. A link to one
	 * of the site's documents downloads it under its own file name.
	 */
	import { resolve } from '$app/paths';
	let { link = null, appearance = '', card = '', so_control = false, class: className = '', children, ...rest } = $props();
	const safe = $derived(typeof link?.href === 'string' && /^(https?:|mailto:|tel:|#|\\/)/i.test(link.href) ? link.href : null);
	const href = $derived(safe ? (safe.startsWith('/') && !safe.startsWith('//') ? resolve(safe) : safe) : null);
	// A new tab's security tokens, then what the author said about the site, each once: a link given a new tab by
	// code ({ ...link, newTab: true }) still gets them.
	const rel = $derived([...new Set([...(link?.newTab ? ['noopener', 'noreferrer'] : []), ...(typeof link?.rel === 'string' ? link.rel.split(/\\s+/) : [])].filter(Boolean))].join(' ') || undefined);
	const download = $derived(href && safe.startsWith('/') && typeof link?.download === 'string' && link.download ? link.download : undefined);
	const BUTTONS = ['primary', 'secondary', 'text', 'light'];
	const button = $derived(BUTTONS.includes(appearance));
	const kind = $derived(button ? \`so-btn so-btn--\${appearance}\` : appearance === 'plain' ? 'so-plain-link' : 'so-link');
</script>

{#if card}
	{#if href}
		<a
			{href}
			{download}
			class={['so-card-link', className]}
			target={link?.newTab ? '_blank' : undefined}
			{rel}
			{...rest}>{@render children?.()}</a
		>
	{:else}
		<svelte:element this={card} class={className} {...rest}>{@render children?.()}</svelte:element>
	{/if}
{:else if href}
	<a
		{href}
		{download}
		class={[kind, className]}
		target={link?.newTab ? '_blank' : undefined}
		{rel}
		{...rest}>{@render children?.()}</a
	>
{:else if (button || so_control) && typeof rest.onclick === 'function'}
	<button class={[kind, className]} {...rest} type={['submit', 'reset'].includes(String(rest.type ?? '').toLowerCase()) ? rest.type : 'button'}>{@render children?.()}</button>
{:else if button}
	${unlinked}
{:else}
	<span class={className} {...rest}>{@render children?.()}</span>
{/if}
`;
}

/** The Link helper as visitors get it. */
export const LINK_SVELTE = linkSvelte();

export const IMAGE_SVELTE = `<script>
	/**
	 * Renders a resolved image, or a neutral placeholder when no image is chosen.
	 * Images in the first section of a page load eagerly with high priority (they are usually the
	 * largest thing on screen); everything else is lazy. \`fallbackAlt\` names what the image stands for when it
	 * has no alternative text of its own; a decorative image keeps an empty alt and says it as hidden text.
	 * An image with WebP or AVIF copies (\`sources\`) is a <picture>: the browser takes the first set it can show,
	 * at the width \`sizes\` says, and falls back to the image's own format. The <picture> lays out no box of its
	 * own, so the <img> sits in the layout, with its classes and attributes, as it does without one.
	 */
	import { asset } from '$app/paths';
	let { image = null, class: className = '', eager = false, sizes = '100vw', fallbackAlt = '', ...rest } = $props();
	const fallback = $derived(String(fallbackAlt ?? '').trim());
	const label = $derived(image?.decorative ? '' : String(image?.alt ?? '').trim() || fallback);
	const url = (path) => (path.startsWith('/') && !path.startsWith('//') ? asset(path.slice(1)) : path);
	const local = (set) =>
		set
			.split(', ')
			.map((candidate) => {
				const [path, width] = candidate.split(' ');
				return \`\${url(path)} \${width}\`;
			})
			.join(', ');
	const srcset = $derived(typeof image?.srcset === 'string' && image.srcset ? local(image.srcset) : undefined);
	const sources = $derived(
		Array.isArray(image?.sources)
			? image.sources.filter((s) => typeof s?.type === 'string' && typeof s?.srcset === 'string' && s.srcset).map((s) => ({ type: s.type, srcset: local(s.srcset) }))
			: []
	);
</script>

{#snippet picture()}
	<img
		src={url(image.src)}
		{srcset}
		sizes={srcset ? sizes : undefined}
		alt={label}
		width={image.width}
		height={image.height}
		loading={eager ? 'eager' : 'lazy'}
		fetchpriority={eager ? 'high' : undefined}
		decoding={eager ? undefined : 'async'}
		class={['so-img', className]}
		{...rest}
	/>
{/snippet}

{#if image?.src}
	{#if sources.length}
		<picture>
			{#each sources as source (source.type)}
				<source type={source.type} srcset={source.srcset} {sizes} />
			{/each}
			{@render picture()}
		</picture>
	{:else}
		{@render picture()}
	{/if}
	{#if image.decorative && fallback}<span class="so-visually-hidden">{fallback}</span>{/if}
{:else}
	<div
		class={['so-img', 'so-img--placeholder', className]}
		role={label ? 'img' : undefined}
		aria-label={label || undefined}
		aria-hidden={label ? undefined : 'true'}
		{...rest}
	>
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<circle cx="9" cy="9" r="2" />
			<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
		</svg>
	</div>
	{#if image?.decorative && fallback}<span class="so-visually-hidden">{fallback}</span>{/if}
{/if}

<style>
	picture {
		display: contents;
	}
	/* With the <picture> laid out as its contents, its <source> elements would each be an item of a flex or grid
	   parent, taking a gap of their own above the picture. They are never drawn, so they take no place either. */
	source {
		display: none;
	}
</style>
`;

/**
 * The Action helper: what clicking a container does (`ElementNode.action`). One link wraps the whole container, which
 * keeps its own tag, so a gallery's figure keeps its caption. The full-size image opens in a native modal dialog.
 */
export const ACTION_SVELTE = `<script>
	/**
	 * What clicking a container does (\`mode\`): follow its link ("link"), or open its image full size ("image").
	 * One link wraps the whole container, which keeps its own tag; with nowhere to go it renders alone.
	 *
	 * The full-size image opens in a modal viewer that loads the file only then. It shows the image's alternative
	 * text and the container's caption, and closes with Escape, its Close button or a click beside the image, giving
	 * focus back to the link that opened it. The arrow keys, or its Previous and Next buttons, move through the images
	 * of the same \`group\` (one gallery) in page order. Without JavaScript the link opens the full-size file itself.
	 */
	import { asset, resolve } from '$app/paths';
	import { beforeNavigate } from '$app/navigation';
	import { fill, visitorText } from './visitor-text.js';
	let { mode = 'none', link = null, image = null, group = '', children } = $props();
	// The viewer's own words, in the language of the page.
	const text = visitorText();
	const local = (path) => (path.startsWith('/') && !path.startsWith('//') ? asset(path.slice(1)) : path);
	const safe = $derived(typeof link?.href === 'string' && /^(https?:|mailto:|tel:|#|\\/)/i.test(link.href) ? link.href : null);
	const href = $derived(mode === 'link' && safe ? (safe.startsWith('/') && !safe.startsWith('//') ? resolve(safe) : safe) : null);
	// A new tab's security tokens, then what the author said about the site, each once: a link given a new tab by
	// code ({ ...link, newTab: true }) still gets them.
	const rel = $derived([...new Set([...(link?.newTab ? ['noopener', 'noreferrer'] : []), ...(typeof link?.rel === 'string' ? link.rel.split(/\\s+/) : [])].filter(Boolean))].join(' ') || undefined);
	const full = $derived(mode === 'image' && typeof image?.src === 'string' && image.src ? local(image.src) : null);
	// The words the opened image is known by, as its thumbnail says them: none for a decorative one.
	const alt = $derived(image?.decorative ? '' : String(image?.alt ?? '').trim() || String(image?.fallbackAlt ?? '').trim());
	// The images that move together (one gallery), by what the generator names them with.
	const key = $derived(typeof group === 'string' ? group : JSON.stringify(group ?? []));

	let anchor = $state();
	let dialog = $state();
	let slides = $state([]);
	let index = $state(0);
	// The link that opened the viewer, which gets focus back however far the visitor moves through the group.
	let opener = null;
	const current = $derived(slides[index]);

	/** What the viewer shows for one image link: its full-size file, the image's alternative text and the caption. */
	function slide(a) {
		const caption = a.querySelector('figcaption');
		return {
			src: a.getAttribute('href'),
			alt: a.dataset.alt ?? '',
			caption: caption?.textContent?.trim() ?? '',
			width: Number(a.dataset.width) || undefined,
			height: Number(a.dataset.height) || undefined
		};
	}

	function open(event) {
		// A click something else has handled (the editor selecting it), or one asking for a new tab or window, is left alone.
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		opener = anchor;
		const links = [...document.querySelectorAll('a[data-viewer-group]')].filter((a) => a.dataset.viewerGroup === key && (a === anchor || a.getClientRects().length > 0));
		slides = links.map(slide);
		index = Math.max(0, links.indexOf(anchor));
	}

	$effect(() => {
		if (!dialog || dialog.open) return;
		dialog.showModal();
		dialog.querySelector('.so-viewer__close')?.focus();
	});

	// A viewer whose photo stops showing (a gallery hidden at the new screen width) would be an invisible modal: it closes.
	$effect(() => {
		if (!current) return;
		const check = () => {
			if (opener && !opener.getClientRects().length) close(false);
		};
		window.addEventListener('resize', check);
		return () => window.removeEventListener('resize', check);
	});

	function close(restore = true) {
		if (!slides.length) return;
		const back = opener;
		opener = null;
		slides = [];
		if (dialog?.open) dialog.close();
		// Focus goes back only while the visitor is on this page, never pulled from wherever they went.
		if (restore && back?.isConnected && document.hasFocus()) back.focus();
	}

	function go(step) {
		index = (index + step + slides.length) % slides.length;
	}

	function keydown(event) {
		if (slides.length < 2 || event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
		event.preventDefault();
		// The arrow pointing back the way the text runs goes back: the right arrow on a right-to-left page.
		const back = getComputedStyle(dialog).direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
		go(event.key === back ? -1 : 1);
	}

	function backdrop(event) {
		if (!(event.target instanceof Element) || !event.target.closest('img, figcaption, button')) close();
	}

	// Leaving the page (or the header or footer staying while the page changes) closes the viewer, without taking focus back.
	beforeNavigate(() => close(false));
</script>

{#if full}
	<a
		bind:this={anchor}
		href={full}
		class="so-card-link so-action so-action--image"
		aria-haspopup="dialog"
		data-viewer-group={key}
		data-alt={alt}
		data-width={image?.width}
		data-height={image?.height}
		data-sveltekit-reload
		onclick={open}>{@render children?.()}<span class="so-visually-hidden">{text().imageOpen}</span></a
	>
	{#if current}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<dialog
			bind:this={dialog}
			class="so-viewer"
			aria-label={current.caption || current.alt || text().imageDialog}
			onclose={() => close()}
			onkeydown={keydown}
			onclick={backdrop}
		>
			<button type="button" class="so-viewer__close" onclick={() => close()}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
				<span class="so-visually-hidden">{text().imageClose}</span>
			</button>
			<figure class="so-viewer__figure">
				<img class="so-viewer__img" src={current.src} alt={current.alt} width={current.width} height={current.height} decoding="async" />
				{#if current.caption}<figcaption class="so-viewer__caption">{current.caption}</figcaption>{/if}
			</figure>
			{#if slides.length > 1}
				<div class="so-viewer__nav">
					<button type="button" class="so-viewer__step" onclick={() => go(-1)}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
						<span class="so-visually-hidden">{text().imagePrevious}</span>
					</button>
					<p class="so-viewer__count" aria-live="polite">{fill(text().imageCount, { index: index + 1, count: slides.length })}</p>
					<button type="button" class="so-viewer__step" onclick={() => go(1)}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
						<span class="so-visually-hidden">{text().imageNext}</span>
					</button>
				</div>
			{/if}
		</dialog>
	{/if}
{:else if href}
	<a
		{href}
		class="so-card-link so-action"
		target={link?.newTab ? '_blank' : undefined}
		{rel}>{@render children?.()}</a
	>
{:else}
	{@render children?.()}
{/if}
`;

export const RICHTEXT_SVELTE = `<script>
	/**
	 * Renders structured rich text as plain semantic HTML: paragraphs, headings, quotes and lists of text spans, and in
	 * an article, pictures with their captions.
	 * Text is always escaped; HTML is never interpreted, and a line feed in a span is a line break (<br>) inside its
	 * block. A block ending with a break gets one more <br>, as a browser needs to show the empty line after it. \`paragraphs\` and \`list\` are the older form, which code components written against it still pass:
	 * strings with inline **strong** and *emphasis*. With \`list\` the root is the list itself, as it always was, so
	 * their selectors (\`.x > li\`) keep matching.
	 */
	import SoLink from './Link.svelte';
	import SoImage from './Image.svelte';
	let { value = undefined, paragraphs = undefined, list = '', class: className = '', ...rest } = $props();

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
	const entries = (input) => (Array.isArray(input) ? input : input == null ? [] : [String(input)]);
	function toBlocks(input) {
		return entries(input).map((entry) => (typeof entry === 'string' ? { type: 'p', spans: segments(entry) } : entry));
	}
	/**
	 * The older list form's items: one per paragraph, and the items of a list of the same kind. Null when the text
	 * holds anything else (a heading, a quote, another kind of list), which then shows as written.
	 */
	function toItems(input, kind) {
		const out = [];
		for (const entry of entries(input)) {
			if (typeof entry === 'string') out.push(segments(entry));
			else if (entry?.type === 'p' && Array.isArray(entry.spans)) out.push(entry.spans);
			else if (entry?.type === kind && Array.isArray(entry.items)) out.push(...entry.items);
			else return null;
		}
		return out;
	}
	const items = $derived(list ? toItems(value ?? paragraphs, list === 'check' ? 'check' : 'ul') : null);
	const blocks = $derived(items ? [] : toBlocks(value ?? paragraphs));
	const LIST_CLASS = { ul: 'so-rich--bullet', check: 'so-rich--check', ol: 'so-rich--number' };
</script>

{#snippet lines(text)}{#each String(text ?? '').split('\\n') as line, k (k)}{#if k}<br />{/if}{line}{/each}{/snippet}
{#snippet marked(s)}{#if s.strong && s.em}<strong><em>{@render lines(s.text)}</em></strong>{:else if s.strong}<strong>{@render lines(s.text)}</strong>{:else if s.em}<em>{@render lines(s.text)}</em>{:else}{@render lines(s.text)}{/if}{/snippet}
{#snippet inline(spans)}{#each spans as s, i (i)}{#if s.link}<SoLink link={s.link} appearance="link">{@render marked(s)}</SoLink>{:else}{@render marked(s)}{/if}{/each}{#if String(spans?.at(-1)?.text ?? '').endsWith('\\n')}<br />{/if}{/snippet}

{#if items}
	<ul class={['so-rich', 'so-rich--' + list, className]} {...rest}>
		{#each items as item, i (i)}<li>{@render inline(item)}</li>{/each}
	</ul>
{:else}
	<div class={['so-rich', className]} {...rest}>
		{#each blocks as block, i (i)}
			{#if block.type === 'ol'}
				<ol class={LIST_CLASS.ol}>{#each block.items as item, j (j)}<li>{@render inline(item)}</li>{/each}</ol>
			{:else if block.items}
				<ul class={LIST_CLASS[block.type]}>{#each block.items as item, j (j)}<li>{@render inline(item)}</li>{/each}</ul>
			{:else if block.type === 'image'}
				<figure class="so-rich__figure">
					<SoImage image={block.image} sizes="(min-width: 48rem) 42rem, 100vw" />
					{#if block.caption}<figcaption>{block.caption}</figcaption>{/if}
				</figure>
			{:else if block.type === 'h2'}
				<h2>{@render inline(block.spans)}</h2>
			{:else if block.type === 'h3'}
				<h3>{@render inline(block.spans)}</h3>
			{:else if block.type === 'h4'}
				<h4>{@render inline(block.spans)}</h4>
			{:else if block.type === 'blockquote'}
				<blockquote>{@render inline(block.spans)}</blockquote>
			{:else}
				<p>{@render inline(block.spans)}</p>
			{/if}
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
 * Icon names a project can show: any string in its pages, shell, collection layouts and component definitions that
 * names a bundled icon, plus quoted names in code component source. Over-inclusion is harmless; omission is not.
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
  // Each collection's layout shows on every entry's page.
  for (const c of Object.values(state.collections ?? {})) visit(c?.settings?.template);
  for (const c of Object.values(state.collections ?? {})) visit(c?.settings?.archiveTemplate);
  for (const def of Object.values(state.components)) {
    if (def.kind === 'code') {
      for (const m of (def.source ?? '').matchAll(/['"`]([a-z0-9-]+)['"`]/g)) if (Object.hasOwn(ICONS, m[1])) found.add(m[1]);
    }
    visit(def.properties);
    visit(def.tree);
  }
  return Object.keys(ICONS).filter((n) => found.has(n));
}

/**
 * Icon data for the icons the project uses, and any named in `alsoShown` (values shown outside the project's
 * documents, such as an isolated preview's sample properties).
 */
export function iconsJs(state: ProjectState, alsoShown?: unknown): string {
  // Any string in any document may name an icon: a file that depends on the answer, not on every document.
  let names = derived(state, 'icons', usedIcons);
  if (alsoShown !== undefined) {
    const more = new Set(names);
    const visit = (v: unknown) => {
      if (typeof v === 'string') {
        if (Object.hasOwn(ICONS, v)) more.add(v);
      } else if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') Object.values(v).forEach(visit);
    };
    visit(alsoShown);
    names = Object.keys(ICONS).filter((n) => more.has(n));
  }
  const used = Object.fromEntries(names.map((n) => [n, ICONS[n]]));
  return `${ICON_NOTICE}\nexport const ICONS = ${JSON.stringify(used)};\n`;
}

export const UTIL_JS = `/** Returns whether a resolved value should be shown. Text of only spaces counts as empty. */
/** Whether a value is a calendar date written YYYY-MM-DD, as a <time> element's datetime states one. */
export function isDate(value) {
	if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
	const [y, m, d] = value.split('-').map(Number);
	const t = new Date(0);
	t.setUTCFullYear(y, m - 1, d);
	return y > 0 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function has(value) {
	if (typeof value === 'string') return value.trim().length > 0;
	if (Array.isArray(value)) return value.length > 0;
	if (value && typeof value === 'object') {
		if ('href' in value) return !!value.href;
		if ('src' in value) return !!value.src;
		return true;
	}
	return !!value;
}

/**
 * An image shown as a thumbnail that opens full size: only its smaller copies, in each of its formats, so the
 * full-size file loads when it is opened. An image without smaller copies in its own format is its own thumbnail.
 */
export function thumbnail(image) {
	if (!image?.src || !image.srcset) return image;
	// Candidates narrower than the full-size picture; the original, and a WebP or AVIF copy at its width, are left out.
	const smaller = (set) =>
		set
			.split(', ')
			.map((candidate) => candidate.split(' '))
			.filter(([path, width]) => path !== image.src && !(parseInt(width, 10) >= image.width));
	const own = smaller(image.srcset);
	if (!own.length) return image;
	const largest = own.reduce((a, b) => (parseInt(b[1], 10) > parseInt(a[1], 10) ? b : a));
	const thumb = { ...image, src: largest[0], srcset: own.map((c) => c.join(' ')).join(', ') };
	if (Array.isArray(image.sources)) {
		const sources = image.sources
			.map((s) => ({ ...s, srcset: typeof s?.srcset === 'string' ? smaller(s.srcset).map((c) => c.join(' ')).join(', ') : '' }))
			.filter((s) => s.srcset);
		if (sources.length) thumb.sources = sources;
		else delete thumb.sources;
	}
	return thumb;
}

/**
 * The option a step button moves a choice to: the next (\`by\` 1) or previous (-1) of \`options\`, staying at the last or
 * first unless \`wrap\` goes round to the other end. A value that is none of them starts again at the first.
 */
export function stepState(options, value, by, wrap) {
	const at = options.indexOf(value);
	if (at < 0) return options[0];
	const to = at + by;
	return options[wrap ? (to + options.length) % options.length : Math.min(Math.max(to, 0), options.length - 1)];
}

/**
 * A list item's ID as part of an element ID: letters, digits and hyphens as they are, every other UTF-16 unit as \`_\`
 * and four hex digits, so two items never share one, none holds a space, and no ID (a lone surrogate) can throw.
 */
export function itemKey(id) {
	return String(id).replace(/[^A-Za-z0-9-]/g, (c) => '_' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * The ID of a list's active item (a component's item state): the one a visitor \`chosen\` while the list still has it,
 * else the one at position \`start\` (the last when the list is shorter), or null for an empty list. A chosen item
 * stays active while others are added, moved or removed around it.
 */
export function activeItem(items, chosen, start) {
	const list = Array.isArray(items) ? items : [];
	if (chosen != null && list.some((item) => item?.id === chosen)) return chosen;
	return list.length ? (list[Math.min(start, list.length - 1)]?.id ?? null) : null;
}

/**
 * The ID of the item a step button makes active: the next (\`by\` 1) or previous (-1) after \`active\`, staying at the last
 * or first unless \`wrap\` goes round to the other end. An item the list does not have starts again at the first.
 */
export function stepItem(items, active, by, wrap) {
	const list = Array.isArray(items) ? items : [];
	if (!list.length) return null;
	const at = list.findIndex((item) => item?.id === active);
	if (at < 0) return list[0]?.id ?? null;
	const to = at + by;
	return list[wrap ? (to + list.length) % list.length : Math.min(Math.max(to, 0), list.length - 1)]?.id ?? null;
}

/**
 * Moves through a tab list from the keyboard, as a tab's keydown handler: Left and Right go to the previous and next
 * tab (the other way round in right-to-left text), round from one end to the other, and Home and End to the first and
 * last. The tab moved to takes the focus and is chosen, as clicking it would choose it. Other keys are left alone.
 */
export function tabKey(event) {
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	const tab = event.currentTarget;
	// A tab the layout hides (at this screen size) is passed over.
	const tabs = Array.from(tab.parentElement?.children ?? []).filter((t) => t.getAttribute('role') === 'tab' && t.getClientRects().length > 0);
	const at = tabs.indexOf(tab);
	const back = getComputedStyle(tab).direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
	const forward = back === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
	const to = { Home: 0, End: tabs.length - 1, [back]: at - 1, [forward]: at + 1 }[event.key];
	if (at < 0 || to === undefined) return;
	event.preventDefault();
	const next = tabs[(to + tabs.length) % tabs.length];
	next.focus();
	next.click();
}

/**
 * Opens a component's dialog or drawer (a native <dialog> its UI state opens) as a modal while \`open\`, which makes the
 * rest of the page inert and keeps the focus inside it, and closes it otherwise. A modal nobody can see would leave the
 * page unusable: one whose placement is not on screen (inside a tab panel not chosen) opens once it shows, and one that
 * cannot be seen (its own styles hide it, or make it transparent, at this screen width) closes, which its close
 * handler turns into the state closing. Printing hides it on purpose and changes neither. It opens once per call, so a close of its own (a form
 * that closes it) is never undone. Returns what stops the watching, for the effect that calls it.
 */
export function overlayOpen(dialog, open) {
	if (!dialog?.isConnected) return;
	if (!open) {
		if (dialog.open) dialog.close();
		return;
	}
	const print = matchMedia('print');
	// Already open (the state changed and changed back): this call watches it, and has nothing to open.
	let opened = dialog.open;
	let place = null;
	const watch = new ResizeObserver(() => check());
	if (opened) watch.observe(dialog);
	const check = () => {
		if (!dialog.isConnected || print.matches) return;
		// The box the placement is in, found again each time: a parent shown as its contents alone, or inline, has none
		// to watch. Its parent is watched too, which changes size when it starts to show.
		let box = dialog.parentElement;
		while (box && ['contents', 'inline'].includes(getComputedStyle(box).display)) box = box.parentElement;
		if (box !== place) {
			watch.disconnect();
			if (dialog.open) watch.observe(dialog);
			for (const el of [box, box?.parentElement]) if (el) watch.observe(el);
			place = box;
		}
		if (!opened && !dialog.open && (!box || box.getClientRects().length > 0)) {
			opened = true;
			watch.observe(dialog);
			dialog.showModal();
		}
		if (opened && dialog.open && !overlayShows(dialog)) dialog.close();
	};
	check();
	addEventListener('resize', check);
	print.addEventListener('change', check);
	return () => {
		watch.disconnect();
		removeEventListener('resize', check);
		print.removeEventListener('change', check);
	};
}

/**
 * Whether an open dialog can be seen: it has a box, and its own styles neither hide it nor make it fully transparent,
 * other than on its way in (a fade from nothing). Its own only: in the top layer, the opacity of the elements around it
 * does not reach it (a section still to enter).
 */
function overlayShows(dialog) {
	const style = getComputedStyle(dialog);
	if (!dialog.getClientRects().length || style.visibility !== 'visible') return false;
	return parseFloat(style.opacity) > 0 || dialog.getAnimations().some((a) => a.playState === 'running');
}

/**
 * What a click on an open dialog or drawer does to it: 'backdrop' for one beside it (on its backdrop), 'link' for one
 * following a link to somewhere else on this page (a menu's jump to a section, or to the top), which leaves it, or
 * null. Either closes it. A click inside it (its padding included), or on a link to a place inside it, leaves it open;
 * a link to another page closes it as the page changes.
 */
export function overlayDismissal(event) {
	const dialog = event.currentTarget;
	if (!dialog.open) return null;
	if (event.target === dialog) {
		const box = dialog.getBoundingClientRect();
		return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom ? 'backdrop' : null;
	}
	const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
	if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || (link.target && link.target !== '_self')) return null;
	try {
		const url = new URL(link.href, location.href);
		const at = url.href.indexOf('#');
		if (at < 0 || url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) return null;
		const fragment = decodeURIComponent(url.href.slice(at + 1));
		// An empty fragment, or "top" naming no element, jumps to the top of the page.
		const place = document.getElementById(fragment) ?? (fragment === '' || fragment.toLowerCase() === 'top' ? document.documentElement : null);
		return place && !dialog.contains(place) ? 'link' : null;
	} catch {
		return null;
	}
}

/**
 * Gives the focus back to the button that opened a dialog or drawer once it has closed, while the visitor is still on
 * this page, and returns null: the next opening names its own button. One opened with the page has none.
 */
export function overlayClosed(opener) {
	if (opener?.isConnected && document.hasFocus()) opener.focus();
	return null;
}

/**
 * The category an item names for a list's category filter (RepeatNode.filter), as the key its pill goes by: a choice
 * field's value while it is one of \`options\`, or text by its trimmed, lower-case words, so "Commercial" and
 * " commercial" are one category. '' when it names none.
 */
export function filterKey(value, options) {
	if (options) return typeof value === 'string' && options.some((o) => o.value === value) ? value : '';
	return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * The categories a list's items name, each once, as { key, label } for its pills: a choice field's in the order of its
 * \`options\` (those no item names left out), text in the order items first name it, spelt as it is there.
 */
export function filterCategories(rows, field, options) {
	const found = new Map();
	for (const row of rows) {
		const value = row?.[field];
		const key = filterKey(value, options);
		if (key && !found.has(key)) found.set(key, String(value).trim());
	}
	// A value two options share (a hand edit) is one pill, under its first option's label.
	if (options) return options.filter((o, i) => found.has(o.value) && options.findIndex((x) => x.value === o.value) === i).map((o) => ({ key: o.value, label: o.label }));
	return [...found].map(([key, label]) => ({ key, label }));
}

/** Rich text blocks as paragraph strings, for code components written against that older form. */
/**
 * Rich text shown as one list of \`kind\`, for a design that lists a value it shares with places showing it as
 * paragraphs: paragraphs and items of that kind of list become its items. Anything else shows as written.
 */
export function richList(value, kind) {
	if (!Array.isArray(value)) return value;
	const items = [];
	for (const b of value) {
		if (b && b.type === 'p' && Array.isArray(b.spans)) items.push(b.spans);
		else if (b && b.type === kind && Array.isArray(b.items)) items.push(...b.items);
		else return value;
	}
	return items.length ? [{ type: kind, items }] : value;
}

/**
 * Rich text for code that reads paragraph strings: one string per paragraph or list item, with **bold** and *italic*.
 * Given \`fields\`, the value is a list and only those fields of its items are converted; without them, every field
 * of a list's items is, as code generated before rich text forms were declared expects.
 */
export function richParagraphs(value, fields) {
	if (!Array.isArray(value)) return value;
	const isBlock = (b) => !!b && typeof b === 'object' && (Array.isArray(b.spans) || Array.isArray(b.items) || b.type === 'image');
	const line = (spans) => spans.map((s) => (s.strong ? '**' + s.text + '**' : s.em ? '*' + s.text + '*' : s.text)).join('');
	const item = (it) => !!it && typeof it === 'object' && !Array.isArray(it);
	if (Array.isArray(fields)) return value.map((it) => (item(it) ? { ...it, ...Object.fromEntries(fields.filter((f) => Object.hasOwn(it, f)).map((f) => [f, richParagraphs(it[f])])) } : it));
	// A picture between paragraphs (an article's) has no paragraph string of its own.
	if (value.length && value.every(isBlock)) return value.flatMap((b) => (b.items ? b.items.map(line) : b.spans ? [line(b.spans)] : []));
	return value.map((it) => (item(it) ? Object.fromEntries(Object.entries(it).map(([k, v]) => [k, richParagraphs(v)])) : it));
}
`;

/**
 * Keeps an unsent message with the history entry it was typed in. The root layout registers it once, so a form's
 * draft is found again by the form's fields and its place on the page, however Svelte orders mounts.
 */
export const DRAFTS_JS = `/**
 * Keeps a message the visitor typed into a form and has not sent with its place in the tab's history, as the
 * browser keeps a form when JavaScript is off: Back brings it back, a new visit to the page starts empty, and a
 * message that was sent never comes back. A form takes part with data-keep-draft on the <form>, data-draft-field
 * naming each answer's control (every radio button of one question, or a checkbox, carries its question's name, and
 * a radio button may name its choice with data-draft-choice), aria-busy="true" from the moment it submits (before
 * anything in its submit handler waits) until the reply, and a reset once the message has been sent.
 *
 * SvelteKit's snapshot() holds the drafts, in memory and in the tab's session storage, never in the address or in
 * anything sent to a server. Besides them, the tab keeps only an opaque id for each message it has sent.
 */
import { onMount } from 'svelte';
import { snapshot } from '$app/navigation';
import { page } from '$app/state';

const FORMS = 'form[data-keep-draft]';
const SENT = 'siteorigin-drafts-sent';
// Forms that show the visitor's latest answers since they appeared: typed in, sent from, or given a draft back.
// An older draft never replaces those, so Back between two entries of one page cannot undo typing.
const settled = new WeakSet();
// The message each form holds, as an opaque id. Sending retires the id, so no copy of that message comes back.
const messages = new WeakMap();
// Messages on their way. The form resets once one is sent; if it keeps its answers instead, the send failed or was
// refused, and the message is a draft again.
const sending = new WeakMap();
const sent = new Set();

// A field can shadow a form's own methods (one named "matches"), so the DOM's are called directly.
function call(node, method, ...args) {
	return (node instanceof Document ? Document : Element).prototype[method].call(node, ...args);
}

function sentBefore() {
	try {
		const ids = JSON.parse(sessionStorage.getItem(SENT) ?? '[]');
		return Array.isArray(ids) ? ids : [];
	} catch {
		return [];
	}
}

function wasSent(id) {
	return sent.has(id) || sentBefore().includes(id);
}

function markSent(id, isSent) {
	if (isSent) sent.add(id);
	else sent.delete(id);
	try {
		const ids = sentBefore().filter((other) => other !== id);
		sessionStorage.setItem(SENT, JSON.stringify(isSent ? [...ids, id] : ids));
	} catch {}
}

// The page a snapshot belongs to, the same however the address spells its trailing slash.
function pagePath() {
	return page.url.pathname.replace(/\\/+$/, '') || '/';
}

function answers(form) {
	return [...call(form, 'querySelectorAll', '[data-draft-field]')];
}

// A radio button or checkbox holds its answer in whether it is ticked; its value is fixed by the page.
function checkable(control) {
	return control instanceof HTMLInputElement && (control.type === 'radio' || control.type === 'checkbox');
}

// What a ticked control stands for: its choice, which another choice given the same value later is not.
function choiceOf(control) {
	return control.dataset.draftChoice || control.value;
}

// Each answer once, in page order: its name, the kind of control that takes it ('' for text), and the answer, which
// is the text typed in or the choice ticked ('' when none is).
function answered(form) {
	const out = new Map();
	for (const control of answers(form)) {
		const field = control.dataset.draftField;
		if (!out.has(field)) out.set(field, { field, kind: checkable(control) ? control.type : '', value: '' });
		if (!checkable(control)) out.get(field).value = control.value;
		else if (control.checked) out.get(field).value = choiceOf(control);
	}
	return [...out.values()];
}

// Every form on the page, known by where it is (the page itself or the header and footer around it), its fields,
// and its place among forms with the same fields there.
function forms() {
	const seen = new Map();
	return [...call(document, 'querySelectorAll', FORMS)].map((form) => {
		// A question that became a checkbox or radio buttons is another form: a typed answer never ticks anything.
		const key = (call(form, 'closest', 'main') ? 'page ' : 'shell ') + answered(form).map((a) => (a.kind ? a.field + ':' + a.kind : a.field)).join(' ');
		const n = seen.get(key) ?? 0;
		seen.set(key, n + 1);
		return { form, key, n };
	});
}

function capture() {
	const drafts = [];
	for (const { form, key, n } of forms()) {
		// A message on its way is no longer a draft, whatever the reply.
		if (call(form, 'getAttribute', 'aria-busy') === 'true') continue;
		const pending = sending.get(form);
		if (pending) {
			sending.delete(form);
			markSent(pending, false);
			messages.set(form, pending);
		}
		const values = answered(form).map((a) => [a.field, a.value]);
		if (!values.some(([, value]) => value)) continue;
		let message = messages.get(form);
		if (!message) messages.set(form, (message = Date.now().toString(36) + Math.random().toString(36).slice(2)));
		drafts.push({ key, n, message, values });
	}
	// The page the drafts were typed on: an entry SvelteKit reuses for another page never hands them over.
	return drafts.length ? { path: pagePath(), drafts } : null;
}

function restore(kept) {
	if (!kept || kept.path !== pagePath() || !Array.isArray(kept.drafts)) return;
	for (const { form, key, n } of forms()) {
		const draft = kept.drafts.find((d) => d?.key === key && d.n === n);
		if (!draft || settled.has(form) || wasSent(draft.message)) continue;
		settled.add(form);
		messages.set(form, draft.message);
		const controls = answers(form);
		for (const [field, value] of Array.isArray(draft.values) ? draft.values : []) {
			if (typeof value !== 'string') continue;
			const group = controls.filter((a) => a.dataset.draftField === field);
			// An answer already there, filled in or ticked by the browser or before the page was ready, stays.
			if (!group.length || !checkable(group[0])) {
				if (group[0] && !group[0].value) group[0].value = value;
			} else if (value && !group.some((a) => a.checked)) {
				const choice = group.find((a) => choiceOf(a) === value);
				if (choice) choice.checked = true;
			}
		}
	}
}

/** Called once, from the root layout. */
export function keepDrafts() {
	snapshot({ id: 'siteorigin-drafts', capture, restore });
	onMount(() => {
		const draftForm = (event) => (event.target instanceof Element ? call(event.target, 'closest', FORMS) : null);
		const typed = (event) => {
			const form = draftForm(event);
			if (form) settled.add(form);
		};
		// Retired as the message leaves, so a reply that comes after the visitor has moved on still counts.
		const submitted = (event) => {
			const form = draftForm(event);
			if (!form) return;
			settled.add(form);
			const message = messages.get(form);
			messages.delete(form);
			if (!message) return;
			sending.set(form, message);
			markSent(message, true);
		};
		// Heard once the form's own handlers have run, so a reset they cancel changes nothing.
		const reset = (event) => {
			const form = event.defaultPrevented ? null : draftForm(event);
			if (form) sending.delete(form);
		};
		document.addEventListener('input', typed, true);
		document.addEventListener('submit', submitted, true);
		document.addEventListener('reset', reset);
		return () => {
			document.removeEventListener('input', typed, true);
			document.removeEventListener('submit', submitted, true);
			document.removeEventListener('reset', reset);
		};
	});
}
`;

/**
 * Rewrites the built not-found page so it works at any address (see generateServerHook). Plain JavaScript, written
 * with String.raw so its regular expressions keep their backslashes.
 */
export const NOT_FOUND_JS = String.raw`/**
 * Makes the not-found page work at any address. It is built at the root of the website, so the addresses in it that
 * are relative ("./about/", "./_app/…": its links, styles, scripts and images) are relative to the root, but a host
 * serves it at whatever address was missing, however deep, where they would lead nowhere. Each becomes an address
 * from the root, under the sub-path the site is built for, and SvelteKit starts from there rather than from the
 * address the browser shows. Links to sections the page does not have ("#pricing", in the shared header or footer)
 * go to the page that has the section. src/hooks.server.js calls this while the site is built.
 */

/** Scripts and styles whole, or a start tag as Svelte writes one: values in double quotes, quotes inside them escaped. */
const PARTS = /<script(?=[\s/>])[^>]*>[\s\S]*?<\/script\s*>|<style(?=[\s/>])[^>]*>[\s\S]*?<\/style\s*>|<[a-zA-Z][^\s/>]*(?:\s+[^\s"'=<>/]+(?:="[^"]*")?)*\s*\/?>/gi;
const ATTRIBUTE = /(\s)([^\s"'=<>/]+)="([^"]*)"/g;
const URL_ATTRIBUTES = ['href', 'xlink:href', 'src', 'action', 'formaction', 'poster'];
const SRCSET_ATTRIBUTES = ['srcset', 'imagesrcset'];
/** Not relative to the page: with a scheme ("https:", "mailto:"), from the root or another host, a query or a fragment. */
const NOT_RELATIVE = /^(?:[a-z][a-z\d+.-]*:|[/#?])/i;
/** HTML's whitespace, which separates srcset candidates (a no-break space does not). */
const SPACE = /[\t\n\f\r ]/;

/** "./about/" as "/my-site/about/"; an address that is not relative to the page, or leads off the site, stays. */
function fromRoot(url, base) {
	if (!url || NOT_RELATIVE.test(url)) return url;
	const to = new URL(url, 'http://site' + base + '/');
	// " https://example.org/" (browsers drop the spaces) or "\\example.org" is another site.
	if (to.origin !== 'http://site') return url;
	return to.pathname + to.search + to.hash;
}

/** Each candidate in a srcset, read as browsers read it: its address runs to the next space, and commas end it. */
function srcsetFromRoot(value, base) {
	let out = '';
	let i = 0;
	while (i < value.length) {
		let j = i;
		while (j < value.length && (SPACE.test(value[j]) || value[j] === ',')) j++;
		out += value.slice(i, j);
		i = j;
		if (i >= value.length) break;
		while (j < value.length && !SPACE.test(value[j])) j++;
		const word = value.slice(i, j);
		const url = word.replace(/,+$/, '');
		out += fromRoot(url, base) + word.slice(url.length);
		i = j;
		if (word.length > url.length) continue;
		// Its descriptors ("640w", "2x") run to the next comma outside brackets.
		for (let depth = 0; j < value.length; j++) {
			const c = value[j];
			if (c === '(') depth++;
			else if (c === ')') depth = Math.max(0, depth - 1);
			else if (c === ',' && !depth) break;
		}
		out += value.slice(i, j);
		i = j;
	}
	return out;
}

/** The url() addresses in a style attribute, whose quotes Svelte writes as &quot;: quoted, they may hold anything. */
const STYLE_URL = /url\(\s*(?:(&quot;|&#39;|')(.*?)\1|([^\s)'"&][^\s)'"]*))\s*\)/gi;
function styleFromRoot(value, base) {
	return value.replace(STYLE_URL, (match, quote, quoted, bare) => {
		const url = quote ? quoted : bare;
		const to = fromRoot(url, base);
		return to === url ? match : 'url(' + (quote || '') + to + (quote || '') + ')';
	});
}

/**
 * A link to a section ("#pricing") the page does not have goes to the page that has it. One with nowhere known to go
 * is listed in missing, for the page to get an empty target: a static build refuses a link to a section its page lacks.
 */
/** Whether SvelteKit's build can read an ID as an address fragment ("100%" it cannot). */
function decodes(id) {
	try {
		return decodeURIComponent(id) !== undefined;
	} catch {
		return false;
	}
}

function sectionFromRoot(value, base, sections, ids, missing) {
	const id = value.slice(1);
	if (Object.hasOwn(sections, id)) return base + sections[id] + value;
	// "#" and "#top" go to the top of any page.
	if (/^\S+$/.test(id) && id.toLowerCase() !== 'top' && !ids.has(id) && decodes(id)) missing.add(id);
	return value;
}

function tagFromRoot(tag, base, sections, ids, missing) {
	return tag.replace(ATTRIBUTE, (attribute, space, name, value) => {
		const key = name.toLowerCase();
		let to = value;
		if (URL_ATTRIBUTES.includes(key)) to = value[0] === '#' ? sectionFromRoot(value, base, sections, ids, missing) : fromRoot(value, base);
		else if (SRCSET_ATTRIBUTES.includes(key)) to = srcsetFromRoot(value, base);
		else if (key === 'style') to = styleFromRoot(value, base);
		return to === value ? attribute : space + name + '="' + to + '"';
	});
}

/** SvelteKit's start script works out the site's root from the address shown unless told, and loads the app from it. */
function startFromRoot(script, base) {
	if (!script.includes('__sveltekit_')) return script;
	return script
		.replace(/new URL\((["'])\.\.?(?:\/\.\.)*\1, location\)\.pathname\.slice\(0, -1\)/g, JSON.stringify(base))
		.replace(/import\((["'])([^"'\s]*)\1\)/g, (match, quote, url) => {
			const to = fromRoot(url, base);
			return to === url ? match : 'import(' + JSON.stringify(to) + ')';
		});
}

/**
 * The page's HTML with every address relative to the page made an address from the root, under base ("" or
 * "/my-site"), and links to the sections listed ({ pricing: "/" }) sent to the page that has each.
 */
export function publishNotFound(html, base, sections) {
	// The sub-path as vite.config.js and SiteOrigin Builder accept it; anything else is the root.
	const root = typeof base === 'string' && /^(\/[\w.-]+)*$/.test(base) && !base.split('/').some((s) => s === '.' || s === '..') ? base : '';
	const jumps = sections && typeof sections === 'object' ? sections : {};
	// The sections the page has: the IDs its start tags carry.
	const ids = new Set();
	for (const [part] of html.matchAll(PARTS)) if (!/^<(script|style)(?=[\s/>])/i.test(part)) for (const [, , name, value] of part.matchAll(ATTRIBUTE)) if (name.toLowerCase() === 'id') ids.add(value);
	const missing = new Set();
	const out = html.replace(PARTS, (part) => {
		if (/^<style(?=[\s/>])/i.test(part)) return part;
		if (!/^<script(?=[\s/>])/i.test(part)) return tagFromRoot(part, root, jumps, ids, missing);
		const open = /^<script[^>]*>/i.exec(part)[0];
		return tagFromRoot(open, root, jumps, ids, missing) + startFromRoot(part.slice(open.length), root);
	});
	if (!missing.size) return out;
	// Outside the part of the page SvelteKit hydrates, so the page starts as it was rendered.
	const targets = [...missing].map((id) => '<span id="' + id + '"></span>').join('');
	const end = out.toLowerCase().lastIndexOf('</body>');
	return end < 0 ? out + targets : out.slice(0, end) + targets + out.slice(end);
}
`;
