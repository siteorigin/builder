import type { ComponentDefinition } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { P } from '../dsl';
import { FOUNDATION } from './pack';

/**
 * Site search: a search box that finds pages of the site by their title and the words they show, and lists them as
 * links with a passage of each page's text. The search code and the index of the pages are generated with the site
 * (src/generator/search.ts) into its runtime folder, so the exported site searches on any static host.
 */
const SEARCH_SOURCE = `<script>
	/**
	 * Site search: visitors search the titles and content of the site's pages and go to the one they want.
	 * Foundation theme code component. Props are edited in SiteOrigin Builder; the pages it finds are the
	 * site's pages that are not hidden from site search, indexed each time the site is generated.
	 */
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { loadPages, searchPages, searchWords } from '../runtime/site-search.js';
	import { fill, fillParts, visitorText } from '../runtime/visitor-text.js';

	let {
		eyebrow = '',
		heading = 'Search this site',
		lead = '',
		label = 'Search for',
		placeholder = '',
		buttonLabel = 'Search',
		emptyMessage = '',
		noResultsMessage = '',
		variant = 'default',
		class: className = ''
	} = $props();

	const uid = $props.id();
	let query = $state('');
	/** idle, empty (searched for nothing), searching, done or failed. */
	let status = $state('idle');
	/** What the last search found: the words searched for, how many pages matched, and the first of them. */
	let found = $state(null);
	// Every search and reset counts up, so a search that finishes after a newer one (or after leaving) is dropped.
	let run = 0;

	function reset() {
		run++;
		status = 'idle';
		found = null;
		remember('');
	}

	// The search sent stays in the address as ?q=, so reloading the page (or sharing it) runs it again.
	function remember(words) {
		// Built from document.URL: this only writes the address; reading it is onMount's, below.
		const url = new URL(document.URL);
		if ((url.searchParams.get('q') ?? '') === words) return;
		if (words) url.searchParams.set('q', words);
		else url.searchParams.delete('q');
		history.replaceState(history.state, '', url);
	}

	function submit(event) {
		event.preventDefault();
		search();
	}

	// Emptying the box, with its clear button or by deleting the words, clears what it found.
	function input() {
		if (!query && status !== 'idle') reset();
	}

	async function search() {
		const words = query.trim();
		const mine = ++run;
		// Nothing to search for: no words, or only marks and spaces that search leaves out.
		if (!searchWords(words).length) {
			found = null;
			status = 'empty';
			remember('');
			return;
		}
		remember(words);
		status = 'searching';
		try {
			const pages = await loadPages();
			if (mine !== run) return;
			found = { words, ...searchPages(pages, words) };
			status = 'done';
		} catch {
			if (mine === run) status = 'failed';
		}
	}

	// Escape clears the search, and the focus stays in the box for the next one.
	function keydown(event) {
		if (event.key !== 'Escape' || (!query && status === 'idle')) return;
		event.preventDefault();
		query = '';
		reset();
	}

	// A search in the header or footer stays on screen from page to page: each page starts it afresh.
	let searchedOn;
	$effect(() => {
		const path = page.url.pathname;
		if (searchedOn !== undefined && path !== searchedOn) {
			query = '';
			reset();
		}
		searchedOn = path;
	});
	onDestroy(() => run++);

	// A search sent before the page's scripts started (or a link to one) arrives in the address as ?q=: run it now.
	onMount(() => {
		const sent = new URLSearchParams(location.search).get('q');
		if (!sent || !sent.trim()) return;
		query = sent;
		search();
	});

	const shown = $derived(found ? found.results.length : 0);
	// What the search says on its own, in the language of the page.
	const text = visitorText();
	// How many pages matched, in pieces: the words searched for are set apart, keeping their own direction.
	const outcome = $derived(
		found ? fillParts(found.total === 0 ? text().searchNone : found.total === 1 ? text().searchOne : found.total > shown ? text().searchLimited : text().searchMany, { count: found.total, query: found.words, shown }) : []
	);
</script>

<section class={['so-search', 'so-search--' + variant, className]}>
	<div class="so-search__inner">
		{#if eyebrow || heading || lead}
			<div class="so-search__intro">
				{#if eyebrow}<p class="so-search__eyebrow">{eyebrow}</p>{/if}
				{#if heading}<h2 class="so-search__heading" id={uid + '-heading'}>{heading}</h2>{/if}
				{#if lead}<p class="so-search__lead">{lead}</p>{/if}
			</div>
		{/if}
		<div class="so-search__body">
			<form class="so-search__form" role="search" aria-labelledby={heading ? uid + '-heading' : undefined} aria-label={heading ? undefined : text().searchLandmark} onsubmit={submit}>
				<label class="so-search__label" for={uid + '-q'}>{label || text().searchLabel}</label>
				<div class="so-search__row">
					<input
						id={uid + '-q'}
						class="so-search__input"
						type="search"
						name="q"
						autocomplete="off"
						enterkeyhint="search"
						placeholder={placeholder || undefined}
						aria-describedby={uid + '-status'}
						bind:value={query}
						oninput={input}
						onkeydown={keydown}
					/>
					<button class="so-btn so-btn--primary so-search__button" type="submit">{buttonLabel || text().searchButton}</button>
				</div>
			</form>
			<p class={['so-search__status', status === 'failed' && 'so-search__status--failed', status === 'done' && 'so-search__status--count']} id={uid + '-status'} role="status">
				{#if status === 'failed'}<svg class="so-search__icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M10 5.75v5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" /><circle cx="10" cy="13.9" r="1.1" fill="currentColor" /></svg>{/if}
				{#if status === 'empty'}{emptyMessage || text().searchEmpty}{:else if status === 'searching'}{text().searchSearching}{:else if status === 'failed'}{text().searchFailed}{:else if status === 'done' && found}{#each outcome as part}{#if part.name === 'query'}<bdi>{part.text}</bdi>{:else}{part.text}{/if}{/each}{#if found.total === 0}{' '}{noResultsMessage || text().searchAdvice}{/if}{/if}
			</p>
			{#if status === 'done' && found && shown}
				<ol class="so-search__results" aria-label={fill(text().searchResults, { query: found.words })}>
					{#each found.results as result (result.route)}
						<li class="so-search__result">
							<a class="so-search__link" href={resolve(result.route)}>
								<!-- One span, so the title's words and its marks flow as one line of text inside the link. -->
								<span>{#each result.title as part}{#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
							</a>
							{#if result.excerpt.length}
								<p class="so-search__excerpt">
									{#each result.excerpt as part}{#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
								</p>
							{/if}
						</li>
					{/each}
				</ol>
			{/if}
		</div>
	</div>
</section>

<style>
	.so-search {
		padding-block: var(--so-space-section);
		padding-inline: var(--so-container-gutter);
		background: var(--so-color-background);
		color: var(--so-color-text);
	}
	/* Searching needs the page's scripts: where none run (<html> never takes so-js), a form that finds nothing is left
	   out. The weight of an id no element has outweighs a placement's own (important) styles. */
	:global(:root:not(.so-js)) .so-search:not(#so-no-js) {
		display: none !important;
	}
	.so-search--muted {
		background: var(--so-color-surface-alt);
	}
	.so-search--inverse {
		background: var(--so-color-inverse);
		color: var(--so-color-on-inverse);
	}
	.so-search__inner {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-xl);
		max-width: var(--so-container-reading);
		margin-inline: auto;
	}
	.so-search__intro {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-md);
	}
	.so-search__eyebrow {
		font-family: var(--so-text-eyebrow-family);
		font-size: var(--so-text-eyebrow-size);
		font-weight: var(--so-text-eyebrow-weight);
		letter-spacing: var(--so-text-eyebrow-tracking);
		line-height: var(--so-text-eyebrow-line-height);
		text-transform: var(--so-text-eyebrow-transform, none);
		color: var(--so-color-brand);
	}
	.so-search--inverse .so-search__eyebrow {
		color: var(--so-color-accent);
	}
	.so-search__heading {
		font-family: var(--so-text-h2-family);
		font-size: var(--so-text-h2-size);
		font-weight: var(--so-text-h2-weight);
		letter-spacing: var(--so-text-h2-tracking);
		line-height: var(--so-text-h2-line-height);
	}
	.so-search__lead {
		font-family: var(--so-text-lead-family);
		font-size: var(--so-text-lead-size);
		font-weight: var(--so-text-lead-weight);
		letter-spacing: var(--so-text-lead-tracking);
		line-height: var(--so-text-lead-line-height);
		color: var(--so-color-muted);
	}
	.so-search--inverse .so-search__lead {
		color: var(--so-color-on-inverse);
		opacity: 0.78;
	}
	.so-search__form {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-xs);
	}
	/* The box's label in the theme's small text, a step bolder, as the contact form's questions are. */
	.so-search__label {
		font-family: var(--so-text-small-family);
		font-size: var(--so-text-small-size);
		line-height: var(--so-text-small-line-height);
		letter-spacing: var(--so-text-small-tracking);
		font-weight: 600;
	}
	.so-search__row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--so-space-sm);
	}
	.so-search__input {
		flex: 1 1 14rem;
		min-width: 0;
		/* The height of the theme's buttons, so the box and its button line up. */
		min-height: 46px;
		padding: 0.65em 0.85em;
		/* Opaque, from the box's own ink, as the contact form's fields are: mixed 80% into the fill it keeps 3:1 there
		   (WCAG 1.4.11) for a grey or darker text on a light fill, down to the lightest readable grey. */
		border: 1px solid color-mix(in srgb, var(--so-color-text) 80%, var(--so-color-surface));
		border-radius: var(--so-radius-sm);
		background: var(--so-color-surface);
		color: var(--so-color-text);
		/* At least 16px, so phones do not zoom in when the box is tapped. */
		font: inherit;
		font-size: max(1rem, 16px);
		transition: border-color 160ms ease;
	}
	.so-search__input:hover:not(:focus) {
		border-color: var(--so-color-text);
	}
	.so-search__input:focus-visible {
		outline: 2px solid var(--so-surface-ink, var(--so-color-focus));
		outline-offset: 1px;
	}
	/* The browser's clear button, drawn in the box's own ink rather than the browser's blue, as a 24px target. */
	.so-search__input::-webkit-search-cancel-button {
		appearance: none;
		width: 24px;
		height: 24px;
		margin-inline-start: 0.5em;
		background: var(--so-color-muted);
		mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M7 7l10 10M17 7 7 17' stroke='black' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") center / 20px no-repeat;
		cursor: pointer;
	}
	.so-search__input::-webkit-search-cancel-button:hover {
		background: var(--so-color-text);
	}
	/* The status stays in the page while it is empty, so screen readers announce what it says next. */
	.so-search__body {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-md);
	}
	.so-search__status {
		margin: 0;
	}
	/* How many pages matched heads the list. */
	.so-search__status--count {
		font-weight: 600;
	}
	/* The search could not run: marked with a symbol and a rule, in the section's own text colour, as the contact
	   form marks a message that could not be sent. */
	.so-search__status--failed {
		display: flex;
		align-items: flex-start;
		gap: 0.6em;
		padding: var(--so-space-sm) var(--so-space-md);
		/* An outline rather than a tint, so the words keep the full contrast of the section's own ground. */
		border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
		border-inline-start: 3px solid currentColor;
		border-radius: var(--so-radius-sm);
		font-weight: 600;
	}
	.so-search__icon {
		flex: none;
		width: 1.25em;
		height: 1.25em;
		margin-top: calc((1lh - 1.25em) / 2);
	}
	.so-search__results {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--so-space-md);
	}
	.so-search__result {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-2xs, 0.25rem);
		padding-block-end: var(--so-space-md);
		border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent);
	}
	.so-search__result:last-child {
		padding-block-end: 0;
		border-bottom: 0;
	}
	.so-search__link {
		align-self: flex-start;
		/* A tap target of at least 44px tall, however short the title. */
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-family: var(--so-text-h3-family);
		font-size: var(--so-text-h3-size);
		font-weight: var(--so-text-h3-weight);
		line-height: var(--so-text-h3-line-height);
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 0.18em;
	}
	.so-search__link:focus-visible {
		outline: 2px solid var(--so-surface-ink, var(--so-color-focus));
		outline-offset: 2px;
	}
	.so-search__excerpt {
		margin: 0;
		color: var(--so-color-muted);
		overflow-wrap: anywhere;
	}
	/* Dimmed by colour rather than opacity, so a match inside keeps its full strength. */
	.so-search--inverse .so-search__excerpt {
		color: color-mix(in srgb, var(--so-color-on-inverse) 85%, var(--so-color-inverse));
	}
	/* A match is told by its weight and an underline in the section's own text colour, on the section's own ground:
	   nothing is laid under the letters, so they keep the contrast of the text around them on any palette. */
	.so-search mark {
		background: none;
		color: var(--so-color-text);
		font-weight: 650;
		text-decoration: underline;
		text-decoration-thickness: 2px;
		text-underline-offset: 0.2em;
	}
	.so-search--inverse mark {
		color: var(--so-color-on-inverse);
	}
	/* A title is bold and underlined already: there the match's underline is three times as heavy. */
	.so-search__link mark {
		font-weight: inherit;
		text-decoration-thickness: 3px;
		/* On the link's own underline, so the two read as one line, heavier under the match. */
		text-underline-offset: 0.18em;
	}
</style>
`;

export const siteSearch: ComponentDefinition = {
  schemaVersion: SCHEMA_VERSION,
  id: FOUNDATION.definitionId('site.search'),
  componentId: 'site.search',
  contractVersion: 1,
  kind: 'code',
  owner: 'theme',
  name: 'Site search',
  description:
    'A search box that finds pages of this site by their title and the words they show, and lists them as links with a passage of each page. Works in the exported website on any static host. Pages set to Hide from site search are never listed.',
  category: 'content',
  tags: ['search', 'site search', 'find', 'search box', 'lookup', 'index', 'portfolio', 'projects', 'directory', 'pages'],
  icon: 'search',
  properties: {
    ...P.group('Text', {
      eyebrow: P.str('Eyebrow', ''),
      heading: P.str('Heading', 'Search this site'),
      lead: P.text('Supporting text', '')
    }),
    ...P.group('Search box', {
      label: P.str('Search box label', 'Search for'),
      placeholder: P.str('Placeholder', ''),
      buttonLabel: P.str('Button label', 'Search')
    }),
    ...P.group('Messages', {
      emptyMessage: { ...P.text('Message for an empty search', ''), description: 'Empty: the empty-search message of the site’s visitor text, in the page’s language.' },
      noResultsMessage: { ...P.text('Advice when nothing matches', ''), description: 'Empty: the no-results advice of the site’s visitor text, in the page’s language.' }
    })
  },
  parts: { root: { nodeId: 'root', label: 'Search section' } },
  variantAxes: {
    tone: { label: 'Tone', prop: 'variant', default: 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background' }, inverse: { label: 'Dark' } } }
  },
  source: SEARCH_SOURCE,
  provenance: FOUNDATION.provenance('site.search'),
  license: FOUNDATION.meta.license
};
