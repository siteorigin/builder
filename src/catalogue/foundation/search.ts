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
	}

	function submit(event) {
		event.preventDefault();
		search();
	}

	async function search() {
		const words = query.trim();
		const mine = ++run;
		// Nothing to search for: no words, or only marks and spaces that search leaves out.
		if (!searchWords(words).length) {
			found = null;
			status = 'empty';
			return;
		}
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
						onkeydown={keydown}
					/>
					<button class="so-btn so-btn--primary so-search__button" type="submit">{buttonLabel || text().searchButton}</button>
				</div>
			</form>
			<p class="so-search__status" id={uid + '-status'} role="status">
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
		font-size: var(--so-text-lead-size);
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
	.so-search__label {
		font-size: 0.95rem;
		font-weight: 550;
	}
	.so-search__row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--so-space-sm);
	}
	.so-search__input {
		flex: 1 1 14rem;
		min-width: 0;
		min-height: 48px;
		padding: 0.65em 0.85em;
		/* Field outlines reach 3:1 against the section background (WCAG 1.4.11). */
		border: 1px solid color-mix(in srgb, var(--so-color-text) 55%, transparent);
		border-radius: var(--so-radius-sm);
		background: var(--so-color-surface);
		color: var(--so-color-text);
		/* At least 16px, so phones do not zoom in when the box is tapped. */
		font: inherit;
		font-size: max(1rem, 16px);
	}
	.so-search__input:focus-visible {
		outline: 2px solid var(--so-surface-ink, var(--so-color-focus));
		outline-offset: 1px;
	}
	.so-search__button {
		min-height: 48px;
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
	.so-search--inverse .so-search__excerpt {
		color: var(--so-color-on-inverse);
		opacity: 0.85;
	}
	.so-search mark {
		background: color-mix(in srgb, var(--so-color-accent) 30%, transparent);
		color: inherit;
		border-radius: 2px;
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
    tone: { label: 'Tone', default: 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background' }, inverse: { label: 'Dark' } } }
  },
  source: SEARCH_SOURCE,
  provenance: FOUNDATION.provenance('site.search'),
  license: FOUNDATION.meta.license
};
