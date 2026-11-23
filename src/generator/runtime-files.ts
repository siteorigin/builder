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
	const safe = $derived(typeof link?.href === 'string' && /^(https?:|mailto:|tel:|#|\\/)/i.test(link.href) ? link.href : null);
	const href = $derived(safe ? (safe.startsWith('/') && !safe.startsWith('//') ? resolve(safe) : safe) : null);
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
	 * largest thing on screen); everything else is lazy. \`fallbackAlt\` names what the image stands for when it
	 * has no alternative text of its own; a decorative image keeps an empty alt and says it as hidden text.
	 */
	import { asset } from '$app/paths';
	let { image = null, class: className = '', eager = false, sizes = '100vw', fallbackAlt = '', ...rest } = $props();
	const fallback = $derived(String(fallbackAlt ?? '').trim());
	const label = $derived(image?.decorative ? '' : String(image?.alt ?? '').trim() || fallback);
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
		alt={label}
		width={image.width}
		height={image.height}
		loading={eager ? 'eager' : 'lazy'}
		fetchpriority={eager ? 'high' : undefined}
		decoding={eager ? undefined : 'async'}
		class={['so-img', className]}
		{...rest}
	/>
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
{/if}
`;

export const RICHTEXT_SVELTE = `<script>
	/**
	 * Renders structured rich text as plain semantic HTML: paragraphs, headings, quotes and lists of text spans.
	 * Text is always escaped; HTML is never interpreted. \`paragraphs\` and \`list\` are the older form, which code
	 * components written against it still pass: strings with inline **strong** and *emphasis*.
	 */
	import SoLink from './Link.svelte';
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
	function toBlocks(input, kind) {
		const out = [];
		for (const entry of Array.isArray(input) ? input : input == null ? [] : [String(input)]) {
			if (typeof entry !== 'string') out.push(entry);
			else if (!kind) out.push({ type: 'p', spans: segments(entry) });
			else if (out.at(-1)?.type === kind) out.at(-1).items.push(segments(entry));
			else out.push({ type: kind, items: [segments(entry)] });
		}
		return out;
	}
	const blocks = $derived(toBlocks(value ?? paragraphs, list === 'check' ? 'check' : list ? 'ul' : ''));
	const LIST_CLASS = { ul: 'so-rich--bullet', check: 'so-rich--check', ol: 'so-rich--number' };
</script>

{#snippet marked(s)}{#if s.strong && s.em}<strong><em>{s.text}</em></strong>{:else if s.strong}<strong>{s.text}</strong>{:else if s.em}<em>{s.text}</em>{:else}{s.text}{/if}{/snippet}
{#snippet inline(spans)}{#each spans as s, i (i)}{#if s.link}<SoLink link={s.link} appearance="link">{@render marked(s)}</SoLink>{:else}{@render marked(s)}{/if}{/each}{/snippet}

<div class={['so-rich', className]} {...rest}>
	{#each blocks as block, i (i)}
		{#if block.type === 'ol'}
			<ol class={LIST_CLASS.ol}>{#each block.items as item, j (j)}<li>{@render inline(item)}</li>{/each}</ol>
		{:else if block.items}
			<ul class={LIST_CLASS[block.type]}>{#each block.items as item, j (j)}<li>{@render inline(item)}</li>{/each}</ul>
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

export const UTIL_JS = `/** Returns whether a resolved value should be shown. Text of only spaces counts as empty. */
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

/** Rich text blocks as paragraph strings, for code components written against that older form. */
export function richParagraphs(value) {
	if (!Array.isArray(value)) return value;
	const isBlock = (b) => !!b && typeof b === 'object' && (Array.isArray(b.spans) || Array.isArray(b.items));
	const line = (spans) => spans.map((s) => (s.strong ? '**' + s.text + '**' : s.em ? '*' + s.text + '*' : s.text)).join('');
	if (value.length && value.every(isBlock)) return value.flatMap((b) => (b.items ? b.items.map(line) : [line(b.spans)]));
	return value.map((it) => (it && typeof it === 'object' && !Array.isArray(it) ? Object.fromEntries(Object.entries(it).map(([k, v]) => [k, richParagraphs(v)])) : it));
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
 * naming each answer's control, and aria-busy="true" while it sends.
 *
 * SvelteKit's snapshot() holds the drafts, in memory and in the tab's session storage, never in the address or in
 * anything sent to a server. Besides them, the tab keeps only an opaque id for each message it has sent.
 */
import { onMount } from 'svelte';
import { snapshot } from '$app/navigation';

const FORMS = 'form[data-keep-draft]';
const SENT = 'siteorigin-drafts-sent';
// Forms that show the visitor's latest answers since they appeared: typed in, sent from, or given a draft back.
// An older draft never replaces those, so Back between two entries of one page cannot undo typing.
const settled = new WeakSet();
// The message each form holds, as an opaque id. Sending retires the id, so no copy of that message comes back.
const messages = new WeakMap();
const sent = new Set();

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
		sessionStorage.setItem(SENT, JSON.stringify([...sentBefore(), id]));
	} catch {}
}

function answers(form) {
	return [...form.querySelectorAll('[data-draft-field]')];
}

// Every form on the page, known by its fields and then by its place among forms with the same fields.
function forms() {
	const seen = new Map();
	return [...document.querySelectorAll(FORMS)].map((form) => {
		const key = answers(form).map((a) => a.dataset.draftField).join(' ');
		const n = seen.get(key) ?? 0;
		seen.set(key, n + 1);
		return { form, key, n };
	});
}

function capture() {
	const drafts = [];
	for (const { form, key, n } of forms()) {
		// A message on its way is no longer a draft, whatever the reply.
		if (form.getAttribute('aria-busy') === 'true') continue;
		const values = answers(form).map((a) => [a.dataset.draftField, a.value]);
		if (!values.some(([, value]) => value)) continue;
		let message = messages.get(form);
		if (!message) messages.set(form, (message = Date.now().toString(36) + Math.random().toString(36).slice(2)));
		drafts.push({ key, n, message, values });
	}
	return drafts.length ? drafts : null;
}

function restore(drafts) {
	if (!Array.isArray(drafts)) return;
	for (const { form, key, n } of forms()) {
		const draft = drafts.find((d) => d?.key === key && d.n === n);
		const controls = answers(form);
		if (!draft || settled.has(form) || controls.some((a) => a.value) || wasSent(draft.message)) continue;
		settled.add(form);
		messages.set(form, draft.message);
		for (const [field, value] of Array.isArray(draft.values) ? draft.values : []) {
			const control = controls.find((a) => a.dataset.draftField === field);
			if (control && typeof value === 'string') control.value = value;
		}
	}
}

/** Called once, from the root layout. */
export function keepDrafts() {
	snapshot({ id: 'siteorigin-drafts', capture, restore });
	onMount(() => {
		const typed = (event) => {
			const form = event.target instanceof Element ? event.target.closest(FORMS) : null;
			if (form) settled.add(form);
		};
		// Retired as the message leaves, so a reply that comes after the visitor has moved on still counts.
		const sending = (event) => {
			const form = event.target;
			if (!(form instanceof HTMLFormElement) || !form.matches(FORMS)) return;
			settled.add(form);
			const message = messages.get(form);
			messages.delete(form);
			if (message) markSent(message);
		};
		document.addEventListener('input', typed, true);
		document.addEventListener('submit', sending, true);
		return () => {
			document.removeEventListener('input', typed, true);
			document.removeEventListener('submit', sending, true);
		};
	});
}
`;
