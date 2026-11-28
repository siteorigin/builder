/**
 * Visitor browsing of a collection's index (#1402, see shared/collection-browse.ts), as the exported website runs it.
 * The first page of the index is written as ever, every card and page link in it, and above them the controls the
 * collection offers: a search box, a group of checkboxes per grouping or choice field, a yes/no choice per yes/no
 * field, a minimum and a maximum per number field, and a sort list. The first time a visitor uses one, the page loads
 * the collection's browse index (`collections/<ID>.js` in the runtime folder), every published entry with what its
 * card shows and the values the controls read, and lists the entries that match, in the order chosen, a page size at
 * a time. Clearing every control shows the page as it was written.
 *
 * Three plain files do it, written only while a collection browses: the matching code (`collection-browse.js`), the
 * component holding the controls (`CollectionBrowse.svelte`) and each browsing collection's index. Nothing in them
 * comes from the Builder: the site needs nothing else to run them.
 */
import type { ProjectState } from '@shared/types';
import { archiveTerms } from '@shared/archives';
import { browseFilterKind, browseSortKind, collectionBrowse, type BrowseFilterKind, type BrowseSortKind } from '@shared/collection-browse';
import { hasArchivePages } from '@shared/collections';
import { entryFieldLabel, entryFieldValue, type EntryReadContext } from '@shared/entry-fields';
import { entryRow, publishedEntries } from '@shared/entry-feed';
import { hasArchiveLayout, siteArchives } from './archive';
import { entrySearchHidden, FOLD_JS } from './search';
import { resolveImage } from './index';

/** The matching code, imported by the browse component. */
export const BROWSE_HELPER_FILE = 'collection-browse.js';
/** The component holding a collection index's controls. */
export const BROWSE_COMPONENT_FILE = 'CollectionBrowse.svelte';
/** The folder of the runtime folder holding each browsing collection's index. */
export const BROWSE_INDEX_DIR = 'collections';
/** A browsing collection's index, under the runtime folder: loaded the first time a visitor uses a control. */
export const browseIndexFile = (collectionId: string): string => `${BROWSE_INDEX_DIR}/${collectionId}.js`;

/** One control as the page gives it to the browse component: what it reads, what kind it is, and what it is called. */
export type BrowseFilter = { key: string; kind: 'choice'; label: string; options: Array<{ value: string; label: string }> } | { key: string; kind: Exclude<BrowseFilterKind, 'choice'>; label: string };
/** One sort: what it reads, how it compares, and its name (none for the title and date, which the site's wording names). */
export interface BrowseSort {
  key: string;
  kind: BrowseSortKind;
  label?: string;
}
export interface BrowseControls {
  search: boolean;
  filters: BrowseFilter[];
  sorts: BrowseSort[];
}

/** One published entry as the browse index has it: its card, the words a search finds it by, and the values the controls read. */
export interface BrowseEntry {
  id: string;
  route: string;
  title: string;
  excerpt: string;
  date: string;
  dateLabel: string;
  byline: string;
  image: Record<string, unknown> | null;
  categories: Array<{ label: string; route: string | null }>;
  /** Absent for an entry the author hides from search, which a search never finds. */
  text?: string;
  values: Record<string, string | number | boolean | string[] | null>;
}

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && typeof rec === 'object' && Object.hasOwn(rec, key) ? rec[key] : undefined);

/**
 * Whether a collection's index gives visitors controls: it has an index, shown with the ready-made cards (a design of
 * its own lists its entries its own way), and its browsing offers something its fields allow.
 */
export function browsesIndex(state: ProjectState, collectionId: string): boolean {
  const c = own(state.collections, collectionId);
  const s = c?.settings;
  return !!s && hasArchivePages(s) && !hasArchiveLayout(s) && !!collectionBrowse(s);
}

/** The collections whose index gives visitors controls, by ID. */
export function browsingCollections(state: ProjectState): string[] {
  return Object.keys(state.collections ?? {})
    .sort()
    .filter((id) => browsesIndex(state, id));
}

/** Whether the site has browsing anywhere, so its runtime holds the browse code. */
export function usesBrowse(state: ProjectState): boolean {
  return browsingCollections(state).length > 0;
}

/** The value one control reads for an entry, in the form the matching code compares. */
function controlValue(ctx: EntryReadContext, key: string, kind: BrowseFilterKind | BrowseSortKind): string | number | boolean | string[] | null {
  if (key.startsWith('terms.')) {
    const terms = own(ctx.collection.settings.taxonomies, key.slice(6))?.terms;
    const ids = own(ctx.entry.terms, key.slice(6));
    return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && !!own(terms, id)))] : [];
  }
  const raw = entryFieldValue(ctx, key, 'raw');
  if (kind === 'choice') return typeof raw === 'string' ? [raw] : [];
  if (kind === 'yesno') return raw === true;
  if (kind === 'range' || kind === 'number') return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  return typeof raw === 'string' ? raw : '';
}

/** The labels of a choice control's options, by value. */
function choiceOptions(state: ProjectState, collectionId: string, key: string): Array<{ value: string; label: string }> {
  const settings = state.collections[collectionId].settings;
  if (key.startsWith('terms.')) {
    const terms = own(settings.taxonomies, key.slice(6))?.terms ?? {};
    return Object.keys(terms).map((id) => ({ value: id, label: typeof terms[id]?.label === 'string' && terms[id].label.trim() ? terms[id].label.trim() : id }));
  }
  const f = own(settings.fields, key.slice(6));
  const options = f?.type === 'enum' && Array.isArray(f.options) ? f.options : [];
  return options.filter((o) => typeof o?.value === 'string').map((o) => ({ value: o.value, label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : o.value }));
}

/**
 * The controls a collection's index shows, from its browse setting and its published entries: a choice offers only
 * the options an entry has, and a filter no entry has anything for (a choice with no option left, a range with no
 * number) is left out, so no control does nothing.
 */
export function browseControls(state: ProjectState, collectionId: string): BrowseControls {
  const collection = state.collections[collectionId];
  const settings = collection.settings;
  const b = collectionBrowse(settings);
  if (!b) return { search: false, filters: [], sorts: [] };
  const entries = publishedEntries(state, collection);
  const ctx = (entry: (typeof entries)[number]): EntryReadContext => ({ state, collection, entry, neighbours: {} });
  const filters: BrowseFilter[] = [];
  for (const key of b.filters) {
    const kind = browseFilterKind(settings, key)!;
    const label = entryFieldLabel(collection, key);
    const values = entries.map((e) => controlValue(ctx(e), key, kind));
    if (kind === 'choice') {
      const held = new Set(values.flatMap((v) => (Array.isArray(v) ? v : [])));
      const options = choiceOptions(state, collectionId, key).filter((o) => held.has(o.value));
      if (options.length) filters.push({ key, kind, label, options });
    } else if (kind === 'range') {
      if (values.some((v) => typeof v === 'number')) filters.push({ key, kind, label });
    } else filters.push({ key, kind, label });
  }
  const sorts = b.sort.map((key): BrowseSort => {
    const kind = browseSortKind(settings, key)!;
    return key === 'title' || key === 'publishedAt' ? { key, kind } : { key, kind, label: entryFieldLabel(collection, key) };
  });
  return { search: b.search, filters, sorts };
}

/**
 * Every published entry of a browsing collection, in the order its index lists them, with its card (as the
 * ready-made cards show it, its categories linking to their archives while they have them), the words a search finds
 * it by (its title and excerpt, and the labels of its categories and of the options its choice filters show: nothing
 * the site does not show of it), and the value each control reads.
 */
export function buildBrowseIndex(state: ProjectState, collectionId: string): BrowseEntry[] {
  const collection = state.collections[collectionId];
  const settings = collection.settings;
  const controls = browseControls(state, collectionId);
  const archives = new Map(
    siteArchives(state)
      .filter((p) => p.collectionId === collectionId && p.term?.taxonomy === 'categories' && p.page === 1)
      .map((p) => [p.term!.id, p.route])
  );
  const terms = new Map(archiveTerms(collection, 'categories').map((t) => [t.id, t.label]));
  const keys = [...new Set([...controls.filters.map((f) => f.key), ...controls.sorts.map((s) => s.key)])];
  const kinds = new Map<string, BrowseFilterKind | BrowseSortKind>([...controls.sorts.map((s) => [s.key, s.kind] as const), ...controls.filters.map((f) => [f.key, f.kind] as const)]);
  const choices = controls.filters.filter((f): f is Extract<BrowseFilter, { kind: 'choice' }> => f.kind === 'choice');
  return publishedEntries(state, collection).map((entry) => {
    const row = entryRow(state, collection, entry);
    const ctx: EntryReadContext = { state, collection, entry, neighbours: {} };
    const ids = Array.isArray(entry.terms?.categories) ? entry.terms.categories.filter((t) => terms.has(t)) : [];
    const categories = ids.map((t) => ({ label: terms.get(t)!, route: archives.get(t) ?? null }));
    const values: BrowseEntry['values'] = {};
    for (const key of keys) values[key] = controlValue(ctx, key, kinds.get(key)!);
    const out: BrowseEntry = {
      id: entry.id,
      route: `${settings.route}${entry.slug}/`,
      title: row.title,
      excerpt: row.excerpt,
      date: row.date,
      dateLabel: row.dateLabel,
      byline: row.byline,
      image: row.image?.assetId ? resolveImage(row.image, { state }) : null,
      categories,
      values
    };
    if (controls.search && !entrySearchHidden(entry)) {
      const labels = choices.flatMap((f) => {
        const v = values[f.key];
        return Array.isArray(v) ? f.options.filter((o) => v.includes(o.value)).map((o) => o.label) : [];
      });
      out.text = [...new Set([row.title, row.excerpt, ...categories.map((c) => c.label), ...labels].map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))].join('\n');
    }
    return out;
  });
}

/** A browsing collection's index as the file the website loads. */
export function generateBrowseIndex(state: ProjectState, collectionId: string): string {
  const rows = buildBrowseIndex(state, collectionId);
  return `// Generated by SiteOrigin Builder. Every published entry of this collection, for its index's search, filters and sorting.\nexport default [\n${rows.map((r) => `\t${JSON.stringify(r)}`).join(',\n')}\n];\n`;
}

/**
 * The matching code as the website runs it: plain JavaScript with no dependencies. An entry matches when every word
 * searched for is in its words (ignoring case and accents, as site search does), it has one of the options picked in
 * every choice filter, it is (or is not) what each yes/no filter asks, and its number is within each range given.
 * Sorting by a field puts entries without a value last either way; entries that tie keep the index's order.
 */
export function browseJs(): string {
  return `// Generated by SiteOrigin Builder. Search, filters and sorting for a collection's index.

${FOLD_JS}
/** The words searched for, folded. */
export function searchWords(query) {
	return fold(String(query ?? '')).split(/\\s+/).filter(Boolean);
}

/** A number typed into a range, or null when there is none. */
export function bound(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	const s = String(v ?? '').trim();
	if (!s) return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

/** Whether anything is searched for, filtered or sorted. */
export function isActive(criteria) {
	if (searchWords(criteria.query).length || criteria.sort) return true;
	if (Object.values(criteria.choices).some((v) => v && v.length)) return true;
	if (Object.values(criteria.yesno).some((v) => v === 'yes' || v === 'no')) return true;
	return [...Object.values(criteria.min), ...Object.values(criteria.max)].some((v) => bound(v) !== null);
}

/** The sort choices: the index's own order, then each sort both ways, named with the site's words. */
export function sortChoices(controls, text, fill) {
	const names = { text: [text.browseAscending, text.browseDescending], number: [text.browseLowest, text.browseHighest], date: [text.browseOldest, text.browseNewest] };
	const out = [];
	for (const s of controls.sorts) {
		const field = s.label ?? (s.key === 'title' ? text.browseTitle : text.browseDate);
		const [up, down] = names[s.kind] ?? names.text;
		out.push({ value: s.key + ':asc', label: fill(text.browseSortOption, { field, order: up }) });
		out.push({ value: s.key + ':desc', label: fill(text.browseSortOption, { field, order: down }) });
	}
	return out;
}

// Each entry's words are folded once, the first time it is searched.
const folded = new WeakMap();
function wordsOf(entry) {
	let f = folded.get(entry);
	if (f === undefined) {
		f = typeof entry.text === 'string' ? fold(entry.text) : null;
		folded.set(entry, f);
	}
	return f;
}

/** How text sorts in the page's language, or in the browser's own when it does not know that one. */
function textCollator(locale) {
	const options = { numeric: true, sensitivity: 'base' };
	try {
		return new Intl.Collator(locale || undefined, options);
	} catch {
		return new Intl.Collator(undefined, options);
	}
}

/** The entries that match, in the order chosen. \`locale\` is the page's language, which text sorts by. */
export function browse(entries, controls, criteria, locale) {
	const words = [...new Set(searchWords(criteria.query))];
	const tests = [];
	if (words.length) tests.push((e) => {
		const t = wordsOf(e);
		return t !== null && words.every((w) => t.includes(w));
	});
	for (const f of controls.filters) {
		const v = (e) => (e.values ? e.values[f.key] : undefined);
		if (f.kind === 'choice') {
			const picked = criteria.choices[f.key] ?? [];
			if (picked.length) tests.push((e) => Array.isArray(v(e)) && v(e).some((x) => picked.includes(x)));
		} else if (f.kind === 'yesno') {
			const want = criteria.yesno[f.key];
			if (want === 'yes') tests.push((e) => v(e) === true);
			else if (want === 'no') tests.push((e) => v(e) !== true);
		} else {
			const lo = bound(criteria.min[f.key]);
			const hi = bound(criteria.max[f.key]);
			if (lo !== null) tests.push((e) => typeof v(e) === 'number' && v(e) >= lo);
			if (hi !== null) tests.push((e) => typeof v(e) === 'number' && v(e) <= hi);
		}
	}
	const found = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object' && tests.every((t) => t(e)));
	const [key, dir] = String(criteria.sort ?? '').split(':');
	const sort = controls.sorts.find((s) => s.key === key);
	if (!sort) return found;
	const collator = sort.kind === 'text' ? textCollator(locale) : null;
	// Blank text is no value, however many spaces it holds.
	const missing = (x) => x === null || x === undefined || (typeof x === 'string' && !x.trim());
	const order = new Map(found.map((e, i) => [e, i]));
	const sign = dir === 'desc' ? -1 : 1;
	return found.sort((a, b) => {
		const x = a.values ? a.values[key] : undefined;
		const y = b.values ? b.values[key] : undefined;
		if (missing(x) || missing(y)) return missing(x) === missing(y) ? order.get(a) - order.get(b) : missing(x) ? 1 : -1;
		const c = sort.kind === 'number' ? x - y : sort.kind === 'date' ? (x < y ? -1 : x > y ? 1 : 0) : collator.compare(String(x).trim(), String(y).trim());
		return c * sign || order.get(a) - order.get(b);
	});
}
`;
}

/**
 * The component holding a collection index's controls. The page gives it the controls, how to load the index, how
 * many entries it lists at a time, the collection's name, a snippet listing the entries that match (\`results\`) and
 * its own content, which shows until a control is used, while the index loads, and if it cannot load. The controls
 * work once the page's script runs (until then they are disabled, and on a page whose scripts never run they are left
 * out, as site search is); printed, they are left out.
 */
export const BROWSE_SVELTE = String.raw`<script>
	/**
	 * Search, filters and sorting for a collection's index (generated by SiteOrigin Builder). What it says is in the
	 * language of the page; the fields' names are the author's.
	 */
	import { tick } from 'svelte';
	import { browse, isActive, sortChoices } from './collection-browse.js';
	import { fill, visitorText } from './visitor-text.js';

	let { controls, load, size = 10, name = '', results, children } = $props();
	const text = visitorText();
	let query = $state('');
	let choices = $state({});
	let yesno = $state({});
	let min = $state({});
	let max = $state({});
	let sort = $state('');
	// How many pages of matches show beyond the first.
	let more_pages = $state(0);
	let entries = $state(null);
	let loading = $state(false);
	let failed = $state(false);
	let ready = $state(false);
	let form = $state();
	let list = $state();
	// Whether the component is still on the page, so an index that loads after the visitor has left changes nothing.
	let alive = true;

	const shown = $derived(size * (1 + more_pages));
	const criteria = $derived({ query, choices, yesno, min, max, sort });
	const active = $derived(isActive(criteria));
	const locale = $derived(ready ? document.documentElement.lang : '');
	const found = $derived(active && entries ? browse(entries, controls, criteria, locale) : null);
	const sorts = $derived(sortChoices(controls, text(), fill));
	const status = $derived(
		!active ? '' : failed ? text().browseFailed : !found ? text().browseLoading : !found.length ? text().browseNone : fill(found.length === 1 ? text().browseOne : text().browseMany, { count: found.length })
	);

	$effect(() => {
		ready = true;
		return () => {
			alive = false;
		};
	});

	// The index loads the first time a control is used. A load that failed is tried again by Try again, or once every
	// control is cleared, by the next one used.
	$effect(() => {
		// Read either way, so a load that fails once every control is cleared is forgotten too.
		if (!active) {
			if (failed) failed = false;
		} else if (!entries && !loading && !failed) fetchEntries();
	});

	function fetchEntries() {
		loading = true;
		failed = false;
		Promise.resolve()
			.then(load)
			.then(
				(m) => {
					if (alive) entries = Array.isArray(m?.default) ? m.default : [];
				},
				() => {
					if (alive) failed = true;
				}
			)
			.finally(() => {
				if (alive) loading = false;
			});
	}

	/** Any change of what is asked for lists the matches from the first again. */
	function changed() {
		more_pages = 0;
	}

	function pick(key, value, on) {
		const now = choices[key] ?? [];
		choices[key] = on ? [...now, value] : now.filter((v) => v !== value);
		changed();
	}

	async function clear() {
		query = '';
		choices = {};
		yesno = {};
		min = {};
		max = {};
		sort = '';
		changed();
		await tick();
		form?.querySelector('input, select')?.focus();
	}

	/** The next matches, and focus on the first of them, so a keyboard goes on from there. */
	async function more() {
		const before = shown;
		more_pages += 1;
		await tick();
		const card = list?.querySelectorAll('li')[before];
		// Its title's link, which opens it, rather than a category's before it.
		(card?.querySelector(':is(h2, h3, h4) a') ?? card?.querySelector('a'))?.focus();
	}
</script>

<form class="so-browse" role="search" aria-label={fill(text().browseLabel, { collection: name })} bind:this={form} onsubmit={(e) => e.preventDefault()}>
	<fieldset class="so-browse__controls" disabled={!ready}>
		{#if controls.search}
			<label class="so-browse__field so-browse__field--search">
				<span class="so-browse__label">{text().browseSearch}</span>
				<input class="so-browse__input" type="search" bind:value={query} oninput={changed} />
			</label>
		{/if}
		{#each controls.filters as f (f.key)}
			{#if f.kind === 'choice'}
				<fieldset class="so-browse__group">
					<legend class="so-browse__label">{f.label}</legend>
					{#each f.options as o (o.value)}
						<label class="so-browse__option">
							<input type="checkbox" checked={(choices[f.key] ?? []).includes(o.value)} onchange={(e) => pick(f.key, o.value, e.currentTarget.checked)} />
							<span>{o.label}</span>
						</label>
					{/each}
				</fieldset>
			{:else if f.kind === 'yesno'}
				<label class="so-browse__field">
					<span class="so-browse__label">{f.label}</span>
					<select
						class="so-browse__input"
						value={yesno[f.key] ?? ''}
						onchange={(e) => {
							yesno[f.key] = e.currentTarget.value;
							changed();
						}}
					>
						<option value="">{text().browseAny}</option>
						<option value="yes">{text().browseYes}</option>
						<option value="no">{text().browseNo}</option>
					</select>
				</label>
			{:else}
				<fieldset class="so-browse__group so-browse__group--range">
					<legend class="so-browse__label">{f.label}</legend>
					<label class="so-browse__bound">
						<span>{text().browseMin}</span>
						<input
							class="so-browse__input"
							type="number"
							step="any"
							inputmode="decimal"
							value={min[f.key] ?? ''}
							oninput={(e) => {
								min[f.key] = e.currentTarget.value;
								changed();
							}}
						/>
					</label>
					<label class="so-browse__bound">
						<span>{text().browseMax}</span>
						<input
							class="so-browse__input"
							type="number"
							step="any"
							inputmode="decimal"
							value={max[f.key] ?? ''}
							oninput={(e) => {
								max[f.key] = e.currentTarget.value;
								changed();
							}}
						/>
					</label>
				</fieldset>
			{/if}
		{/each}
		{#if sorts.length}
			<label class="so-browse__field">
				<span class="so-browse__label">{text().browseSort}</span>
				<select class="so-browse__input" bind:value={sort} onchange={changed}>
					<option value="">{text().browseSortDefault}</option>
					{#each sorts as s (s.value)}
						<option value={s.value}>{s.label}</option>
					{/each}
				</select>
			</label>
		{/if}
		<button type="button" class="so-browse__button" disabled={!active} onclick={clear}>{text().browseClear}</button>
	</fieldset>
	<div class="so-browse__status">
		<p role="status">{status}</p>
		{#if active && failed}
			<button type="button" class="so-browse__button" onclick={fetchEntries}>{text().browseRetry}</button>
		{/if}
	</div>
</form>
{#if found}
	<div class="so-browse__results" bind:this={list}>
		{#if found.length}
			{@render results?.(found.slice(0, shown))}
		{/if}
		{#if found.length > shown}
			<button type="button" class="so-browse__button so-browse__more" onclick={more}>{text().browseMore}</button>
		{/if}
	</div>
{:else}
	{@render children?.()}
{/if}

<style>
	.so-browse {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-sm, 0.75rem);
	}
	.so-browse__controls {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--so-space-md, 1rem) var(--so-space-lg, 1.5rem);
		margin: 0;
		padding: 0;
		border: 0;
		min-inline-size: 0;
	}
	.so-browse__field,
	.so-browse__bound {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-2xs, 0.25rem);
	}
	.so-browse__field--search {
		flex: 1 1 16rem;
	}
	.so-browse__group {
		display: flex;
		flex-wrap: wrap;
		gap: var(--so-space-xs, 0.5rem) var(--so-space-md, 1rem);
		margin: 0;
		padding: 0;
		border: 0;
		min-inline-size: 0;
	}
	.so-browse__group > legend {
		float: left;
		inline-size: 100%;
		margin-block-end: var(--so-space-2xs, 0.25rem);
		padding: 0;
	}
	.so-browse__label {
		font-family: var(--so-text-small-family, inherit);
		font-size: var(--so-text-small-size, 0.875rem);
		font-weight: 600;
	}
	.so-browse__bound span {
		font-family: var(--so-text-small-family, inherit);
		font-size: var(--so-text-small-size, 0.875rem);
	}
	.so-browse__option {
		display: inline-flex;
		align-items: center;
		gap: var(--so-space-xs, 0.5rem);
		min-block-size: 24px;
	}
	.so-browse__input {
		min-block-size: 2.75rem;
		padding-inline: var(--so-space-sm, 0.75rem);
		border: var(--so-border-default, 1px solid currentColor);
		border-radius: var(--so-radius-md, 6px);
		background: var(--so-color-background, transparent);
		color: inherit;
		font: inherit;
	}
	.so-browse__group--range .so-browse__input {
		inline-size: 8rem;
	}
	.so-browse__button {
		min-block-size: 2.75rem;
		padding-inline: var(--so-space-md, 1rem);
		border: var(--so-border-default, 1px solid currentColor);
		border-radius: var(--so-radius-md, 6px);
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.so-browse__button:disabled {
		cursor: default;
		opacity: 0.6;
	}
	.so-browse__input:focus-visible,
	.so-browse__button:focus-visible {
		outline: 2px solid var(--so-surface-ink, var(--so-color-focus, currentColor));
		outline-offset: 2px;
	}
	.so-browse__status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--so-space-md, 1rem);
		color: var(--so-color-muted, inherit);
	}
	.so-browse__status p {
		margin: 0;
	}
	.so-browse__results {
		display: flex;
		flex-direction: column;
		gap: var(--so-space-xl, 2rem);
	}
	.so-browse__more {
		align-self: center;
	}
	/* Without the page's script nothing would work them, and printed they do nothing. */
	:global(html:not(.so-js)) .so-browse {
		display: none;
	}
	@media print {
		.so-browse,
		.so-browse__more {
			display: none;
		}
	}
</style>
`;
