import type { ComponentDefinition, ProjectState } from '@shared/types';
import { ofFrozen } from '@engine/draft';
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
	let caption = $state();
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

	// Each photo starts with its own caption at the top, however far the visitor read the last one: the caption stays
	// the same element as the photo changes (and keeps focus), so its scroll would otherwise carry over.
	$effect(() => {
		if (current && caption) caption.scrollTop = 0;
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
				{#if current.caption}<figcaption bind:this={caption} class="so-viewer__caption">{current.caption}</figcaption>{/if}
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
  const add = (names: readonly string[]) => {
    for (const n of names) found.add(n);
  };
  // Each document's names on their own: one frozen through is looked through once, for as long as it is that object.
  const names = (v: unknown) => (v && typeof v === 'object' ? ofFrozen(iconsIn, v, iconNames) : iconNames(v));
  for (const page of Object.values(state.pages)) add(names(page));
  add(names(state.site.shell));
  // Each collection's layout shows on every entry's page.
  for (const c of Object.values(state.collections ?? {})) add(names(c?.settings?.template));
  for (const c of Object.values(state.collections ?? {})) add(names(c?.settings?.archiveTemplate));
  for (const def of Object.values(state.components)) add(ofFrozen(iconsOfDefinition, def, definitionIconNames));
  return Object.keys(ICONS).filter((n) => found.has(n));
}

/** The bundled icons any string in `v` names, at any depth. */
function iconNames(v: unknown): string[] {
  const found = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      if (Object.hasOwn(ICONS, v)) found.add(v);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(v);
  return [...found];
}

/** The icons a component definition names: in its properties and design, and quoted in a code component's source. */
function definitionIconNames(def: ComponentDefinition): string[] {
  const found = new Set<string>();
  if (def.kind === 'code') {
    for (const m of (def.source ?? '').matchAll(/['"`]([a-z0-9-]+)['"`]/g)) if (Object.hasOwn(ICONS, m[1])) found.add(m[1]);
  }
  for (const n of iconNames(def.properties)) found.add(n);
  for (const n of iconNames(def.tree)) found.add(n);
  return [...found];
}

const iconsIn = new WeakMap<object, string[]>();
const iconsOfDefinition = new WeakMap<ComponentDefinition, string[]>();

/**
 * Icon data for the icons the project uses, and any named in `alsoShown` (values shown outside the project's
 * documents, such as an isolated preview's sample properties).
 */
export function iconsJs(state: ProjectState, alsoShown?: unknown): string {
  // Any string in any document may name an icon: a file that depends on the answer, not on every document.
  // Its reads are every document whole, so it is looked for every state (each frozen document once, usedIcons).
  let names = derived(state, 'icons', usedIcons, { opaque: true });
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
 * A message stays the visitor's until its form resets to say it went, and a form still does that after it has left
 * the page. A visitor who follows a link while their message is sending therefore finds it again with Back unless
 * it went, and the entry says which, in a note after the form: that it was sent (the form is empty), or that it may
 * not have been (the answers are back). A form that has left the page cannot say that its send failed, so the note
 * says only what is known. It is the one thing drawn here, in the wording the layout passes in; site.css styles it
 * with rules a theme's own outweigh.
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
// The message each form holds, as an opaque id, until the form resets to say it went. Every copy of a message, in
// every entry, carries its id, so one that went never comes back.
const messages = new WeakMap();
// Messages on their way, by the form sending them. One that is no longer busy without the reset was not sent.
const sending = new WeakMap();
// Forms listened to for that reset on the form itself: once a form has left the page, it no longer reaches the document.
const heard = new WeakSet();
// Forms given back a message that left while it was sending, with the answers that message holds. A copy is that
// message only while the form shows exactly those: changed, it is a message of its own, which nothing retires.
const returned = new WeakMap();
// The note after a form that says how the message it was given back went.
const notes = new WeakMap();
// Forms whose note says the message went, with its id: the next Back to the entry says so again, though the form is
// empty. Only the id is kept, never the answers.
const receipts = new WeakMap();
const sent = new Set();
// What the site says, in the language of the page (visitor-text.js).
let wording = () => ({});
// One polite live region for the whole site, there from the start so that what a note says is announced when it is
// set; the note itself is plain text beside the form. It reads out the notes on the page, and is empty once the page goes.
let announcer = null;
// What each form's note says, in the order they were given: a page can give more than one form back at once.
const spoken = new Map();
let speaking = false;

// The theme's marks for a sent message and for one that did not go: a tick, and a circle with an exclamation mark.
const MARKS = {
	sent: '<path d="M13.25 4.75 6.5 11.5 2.75 7.75"/>',
	unconfirmed: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v3.75"/><circle cx="8" cy="11.1" r="0.9" fill="currentColor" stroke="none"/>'
};

// A field can shadow a form's own methods (one named "matches"), so the DOM's are called directly.
function call(node, method, ...args) {
	return (node instanceof Document ? Document : Element).prototype[method].call(node, ...args);
}

function newMessage() {
	return Date.now().toString(36) + Math.random().toString(36).slice(2);
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

function markSent(id) {
	sent.add(id);
	try {
		sessionStorage.setItem(SENT, JSON.stringify([...sentBefore().filter((other) => other !== id), id]));
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

const valuesOf = (form) => JSON.stringify(answered(form).map((a) => [a.field, a.value]));

// Whether a form given back a message still shows exactly that message.
function unchanged(form) {
	const given = returned.get(form);
	return !!given && valuesOf(form) === given.values;
}

// A form given back a message whose answers have since changed holds a message of its own.
function moveOn(form) {
	if (!returned.has(form)) return;
	if (!unchanged(form)) messages.set(form, newMessage());
	returned.delete(form);
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

// The name a form goes by (its heading, as aria-labelledby gives it, or its aria-label), to tell two notes apart.
function nameOf(form) {
	const ids = (call(form, 'getAttribute', 'aria-labelledby') ?? '').split(/\\s+/).filter(Boolean);
	const named = ids.map((id) => document.getElementById(id)?.textContent.trim() ?? '').filter(Boolean).join(' ');
	return named || (call(form, 'getAttribute', 'aria-label') ?? '').trim();
}

// Reads out the notes given in this frame together: emptied first and filled a frame later, so the same words said
// again are announced again, and notes ended or left behind before then are never said.
function announce() {
	if (!announcer || speaking) return;
	speaking = true;
	announcer.textContent = '';
	requestAnimationFrame(() => {
		speaking = false;
		if (!announcer) return;
		const all = [...spoken];
		announcer.textContent = all.map(([form, words]) => (all.length > 1 && nameOf(form) ? nameOf(form) + ': ' + words : words)).join(' ');
	});
}

// Says after the form, outside it (it is busy while it sends), how the message it was given back went, and has it
// announced. Politely: the visitor has just arrived, and the page's own announcement comes first.
function note(form, kind, message) {
	unnote(form);
	const words = kind === 'sent' ? wording().formSent : wording().formUnconfirmed;
	if (!words) return;
	const line = document.createElement('p');
	line.className = 'so-draft-note so-draft-note--' + kind;
	line.innerHTML = '<svg class="so-draft-note__mark" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + MARKS[kind] + '</svg>';
	line.appendChild(document.createElement('span')).textContent = words;
	call(form, 'after', line);
	notes.set(form, line);
	if (kind === 'sent') receipts.set(form, message);
	spoken.set(form, words);
	announce();
}

// The note describes what happened before the visitor did anything more; sending or changing an answer ends it, as
// the form's own outcome does.
function unnote(form) {
	if (!notes.has(form)) return;
	notes.get(form).remove();
	notes.delete(form);
	receipts.delete(form);
	// Quietly: what the other notes said still stands.
	spoken.delete(form);
	if (!spoken.size && announcer && !speaking) announcer.textContent = '';
}

// The form says its message went. A copy of it given back to a form on the page since is emptied, and the form says
// it went; one the visitor has changed is a message of its own, and is left as it is.
function delivered(form) {
	const message = sending.get(form);
	if (!message) return;
	sending.delete(form);
	messages.delete(form);
	markSent(message);
	for (const { form: other } of forms()) {
		if (returned.get(other)?.message !== message) continue;
		if (!unchanged(other)) {
			moveOn(other);
			continue;
		}
		returned.delete(other);
		messages.delete(other);
		// The prototype method, in case a field is named "reset".
		HTMLFormElement.prototype.reset.call(other);
		note(other, 'sent', message);
	}
}

function capture() {
	// What the notes said belongs to the page being left.
	spoken.clear();
	if (announcer) announcer.textContent = '';
	const drafts = [];
	for (const { form, key, n } of forms()) {
		const busy = call(form, 'getAttribute', 'aria-busy') === 'true';
		// Done without the reset that says it went: it was not sent, and is a draft again.
		if (!busy) sending.delete(form);
		if (!unchanged(form)) moveOn(form);
		const values = answered(form).map((a) => [a.field, a.value]);
		if (!values.some(([, value]) => value)) {
			// An empty form that says its message went: the entry keeps saying so, and holds no answers.
			if (receipts.has(form)) drafts.push({ key, n, message: receipts.get(form), values: [], sending: true, receipt: true });
			continue;
		}
		let message = messages.get(form);
		if (!message) messages.set(form, (message = newMessage()));
		// A message on its way, or given back since and still not known to have gone, is kept too: Back says how it went.
		drafts.push(busy || returned.has(form) ? { key, n, message, values, sending: true } : { key, n, message, values });
	}
	// The page the drafts were typed on: an entry SvelteKit reuses for another page never hands them over.
	return drafts.length ? { path: pagePath(), drafts } : null;
}

function restore(kept) {
	if (!kept || kept.path !== pagePath() || !Array.isArray(kept.drafts)) return;
	for (const { form, key, n } of forms()) {
		const draft = kept.drafts.find((d) => d?.key === key && d.n === n);
		if (!draft || settled.has(form)) continue;
		const left = draft.sending === true;
		if (wasSent(draft.message)) {
			// The visitor left before it went: the empty form is the message gone, and the note says so.
			if (left) {
				settled.add(form);
				note(form, 'sent', draft.message);
			}
			continue;
		}
		// A receipt for a message this tab no longer knows went (its storage was cleared) has nothing to give back.
		if (draft.receipt === true) continue;
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
		if (left) {
			// An answer the form already had, kept over the message's, makes what it shows a message of its own.
			const values = JSON.stringify(draft.values);
			if (valuesOf(form) === values) returned.set(form, { message: draft.message, values });
			else messages.set(form, newMessage());
			note(form, 'unconfirmed');
		}
	}
}

/** Called once, from the root layout, with the wording of the page the visitor is on (visitor-text.js). */
export function keepDrafts(text) {
	wording = text;
	snapshot({ id: 'siteorigin-drafts', capture, restore });
	onMount(() => {
		const draftForm = (event) => (event.target instanceof Element ? call(event.target, 'closest', FORMS) : null);
		const typed = (event) => {
			const form = draftForm(event);
			if (!form) return;
			settled.add(form);
			unnote(form);
		};
		const submitted = (event) => {
			const form = draftForm(event);
			if (!form) return;
			settled.add(form);
			unnote(form);
			// Sending again a message given back, unchanged, keeps its id: whichever send goes, every copy is retired.
			moveOn(form);
			let message = messages.get(form);
			if (!message) messages.set(form, (message = newMessage()));
			sending.set(form, message);
			if (heard.has(form)) return;
			heard.add(form);
			// After the form's own handlers, which it has from before any submit; on the page, the document hears it.
			call(form, 'addEventListener', 'reset', (event) => {
				if (!event.defaultPrevented && call(form, 'getRootNode') !== document) delivered(form);
			});
		};
		// Heard once the form's own handlers have run, so a reset they cancel changes nothing.
		const reset = (event) => {
			const form = event.defaultPrevented ? null : draftForm(event);
			if (form) delivered(form);
		};
		document.addEventListener('input', typed, true);
		document.addEventListener('submit', submitted, true);
		document.addEventListener('reset', reset);
		announcer = document.createElement('p');
		announcer.className = 'so-draft-announce';
		announcer.setAttribute('role', 'status');
		document.body.append(announcer);
		return () => {
			announcer.remove();
			announcer = null;
			document.removeEventListener('input', typed, true);
			document.removeEventListener('submit', submitted, true);
			document.removeEventListener('reset', reset);
		};
	});
}
`;

/**
 * Puts the page back where the visitor left it at once on Back and Forward (#1542). The root layout calls it once.
 */
export const HISTORY_SCROLL_JS = `/**
 * Back and Forward put the page back where the visitor left it at once, as the browser does with JavaScript off.
 * SvelteKit takes over the browser's scroll restoration and puts each history entry's position back with
 * scrollTo(x, y), which a theme's smooth scrolling (html { scroll-behavior: smooth }, there for jumps to a section)
 * turns into a long glide: moments after Back the page would still be at the section the visitor jumped to. While
 * SvelteKit restores a position, the page scrolls instantly; jumps from links stay smooth.
 *
 * A Back or Forward within the page (between a section's address and the page's) restores in the same task as the
 * browser's popstate, heard here before SvelteKit hears it: a window's listeners hear an event in the order they were
 * added, and SvelteKit adds its own once the page has hydrated, after the layout has mounted. One to another page
 * restores as that page is put in place, after onNavigate. A page brought back from the browser's back/forward cache
 * restores as it shows again.
 *
 * A jump still scrolling when the visitor goes Back stops, or it would carry the page on past the position put back;
 * Chromium still takes the jump's last step in the next frame, so that frame puts the position back again.
 */
import { onMount } from 'svelte';
import { onNavigate } from '$app/navigation';

const holds = new Set();
// The page root's own scroll-behavior from before the first hold, and its priority, put back after the last.
let kept = ['', ''];
// The window's own scrollTo, from before anything here stood in for it.
let native = null;
// A scroll is under way (a smooth jump): one was heard and has not ended since.
let moving = false;
// Whether this hold stopped a jump, which takes one more step after it stops.
let stopped = false;
// The frame that puts the page back after a stopped jump's last step, while one is to come.
let correction = 0;

function cancelCorrection() {
	cancelAnimationFrame(correction);
	correction = 0;
}

/** The window's own scrollTo back in its place, once nothing holds and no correction is to come. */
function putBack() {
	if (!holds.size && !correction && window.scrollTo === restore) window.scrollTo = native;
}

/**
 * The window's scrollTo while held. SvelteKit's scrollTo(x, y) is instant. After a stopped jump, where the last
 * instant scroll put the page is put back in the frame after, once the jump has taken its last step; this stays in
 * the window's place until then, so a scroll asked for in the meantime, held or not, is the one kept (a smooth one
 * goes its own way). Every other call is the window's own, as is every call once nothing holds and no frame is to
 * come (from code that kept this function).
 */
function restore(...args) {
	const pending = correction !== 0;
	cancelCorrection();
	const held = holds.size > 0;
	if (!held && !pending) {
		putBack();
		return native.apply(window, args);
	}
	const left0 = args.length >= 2 ? Number(args[0]) : NaN;
	const top0 = args.length >= 2 ? Number(args[1]) : NaN;
	const numeric = Number.isFinite(left0) && Number.isFinite(top0);
	const behavior = !numeric && typeof args[0] === 'object' ? args[0]?.behavior : undefined;
	if (held && numeric) native.call(window, { left: left0, top: top0, behavior: 'instant' });
	else native.apply(window, args);
	// Held, only a smooth scroll asked for is smooth; after the holds, only an instant one is instant.
	const instant = held ? behavior !== 'smooth' : behavior === 'instant';
	if (!stopped || !instant) return putBack();
	const left = scrollX;
	const top = scrollY;
	correction = requestAnimationFrame(() => {
		correction = 0;
		if (scrollX !== left || scrollY !== top) native.call(window, { left, top, behavior: 'instant' });
		putBack();
	});
}

/** Makes the page scroll instantly until the returned function is called, and every other hold has ended too. */
function hold() {
	if (!holds.size) {
		const style = document.documentElement.style;
		kept = [style.getPropertyValue('scroll-behavior'), style.getPropertyPriority('scroll-behavior')];
		style.setProperty('scroll-behavior', 'auto', 'important');
		// Only in place of the window's own: a stand-in some other code has put there is left as it is.
		if (window.scrollTo === native) window.scrollTo = restore;
		stopped = moving;
		if (stopped) native.call(window, { left: scrollX, top: scrollY, behavior: 'instant' });
	}
	const key = {};
	holds.add(key);
	return () => {
		if (holds.delete(key) && !holds.size) unhold();
	};
}

function unhold() {
	holds.clear();
	putBack();
	const style = document.documentElement.style;
	if (kept[0]) style.setProperty('scroll-behavior', kept[0], kept[1]);
	else style.removeProperty('scroll-behavior');
}

/** Holds for the rest of this task: SvelteKit's own listener restores in it, after this one. */
function briefly() {
	setTimeout(hold(), 0);
}

export function keepHistoryScroll() {
	// To another page: held from just before the page is put in place until the navigation has settled, or until
	// the next navigation or Back or Forward (one another onNavigate callback ended early never settles).
	let navigating = null;
	const settle = () => {
		navigating?.();
		navigating = null;
	};
	onNavigate((navigation) => {
		settle();
		if (navigation?.type !== 'popstate' || !navigation.complete) return;
		const release = hold();
		const done = () => {
			release();
			if (navigating === done) navigating = null;
		};
		navigating = done;
		navigation.complete.then(done, done);
	});
	onMount(() => {
		native = window.scrollTo;
		// Only an entry SvelteKit keeps a position for: following a link to a section is the browser's own popstate,
		// whose jump stays smooth.
		const popped = (event) => {
			if (!event.state?.['sveltekit:metadata']?.historyIndex) return;
			settle();
			briefly();
		};
		const shown = (event) => {
			if (event.persisted) briefly();
		};
		// A browser that cannot say when a scroll ends counts every scroll as under way.
		const ends = 'onscrollend' in window;
		const scrolled = () => (moving = true);
		const ended = () => (moving = !ends);
		window.addEventListener('popstate', popped);
		window.addEventListener('pageshow', shown);
		window.addEventListener('scroll', scrolled, { passive: true });
		window.addEventListener('scrollend', ended);
		return () => {
			window.removeEventListener('popstate', popped);
			window.removeEventListener('pageshow', shown);
			window.removeEventListener('scroll', scrolled);
			window.removeEventListener('scrollend', ended);
			cancelCorrection();
			settle();
			if (holds.size) unhold();
			else putBack();
		};
	});
}
`;

/**
 * The note the draft keeper puts after a form whose message it gave back (DRAFTS_JS), in site.css: the size and ink
 * of the text around it, with the weight of an outcome and a mark one line tall, a step below the form. Its class
 * adds no weight (:where), so a theme's own rules for it win; as a paragraph it still outweighs a theme's reset of
 * every paragraph's margin, which site.css comes after.
 */
export const DRAFT_NOTE_CSS = `/* The note after a form whose message came back with Back, saying whether it went (runtime/drafts.js). */
p:where(.so-draft-note) { display: flex; align-items: flex-start; gap: var(--so-space-xs, 0.5rem); max-width: 38em; margin: var(--so-space-md, 1rem) 0 0; font-weight: 550; color: inherit; }
:where(.so-draft-note__mark) { flex: none; width: 1.05em; height: 1.05em; margin-block-start: calc((1lh - 1.05em) / 2); }
/* The live region that reads the note out: on the page for screen readers only. */
.so-draft-announce { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
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
