import type { ProjectState } from '@shared/types';
import { ICONS } from '@catalogue/foundation/icons';

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
	 * (from your own code) is a real button; one with neither is left out (keeping only its id, so links to
	 * it still land). Other links without a destination render as their text. With \`card\` (a tag), the link is a
	 * whole container: an anchor around everything inside it, or that tag when there is nowhere to go. A link to one
	 * of the site's documents downloads it under its own file name.
	 */
	import { resolve } from '$app/paths';
	let { link = null, appearance = '', card = '', class: className = '', children, ...rest } = $props();
	const safe = $derived(typeof link?.href === 'string' && /^(https?:|mailto:|tel:|#|\\/)/i.test(link.href) ? link.href : null);
	const href = $derived(safe ? (safe.startsWith('/') && !safe.startsWith('//') ? resolve(safe) : safe) : null);
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
			rel={link?.newTab ? 'noopener noreferrer' : undefined}
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
		rel={link?.newTab ? 'noopener noreferrer' : undefined}
		{...rest}>{@render children?.()}</a
	>
{:else if button && typeof rest.onclick === 'function'}
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
