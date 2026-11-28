/**
 * Visitor browsing of a collection (#1402): controls on the first page of a collection's index that let visitors of the
 * website search its published entries, narrow them by their groupings and fields, and sort them, all in their own
 * browser. The collection names the fields each control uses as queries name them (`terms.<grouping>`,
 * `field.<name>`, `title`, `publishedAt`), and its fields decide what kind of control each is:
 *
 * - a filter over a grouping or a choice field picks any of its terms or options (`choice`);
 * - a filter over a yes/no field picks yes or no (`yesno`);
 * - a filter over a number field takes a minimum and a maximum (`range`);
 * - a sort over the title or a text field goes by letters, over a number by size, over a date by day.
 *
 * A name the collection's fields cannot give a control (a field removed, or one of another kind) gives none: the
 * engine drops it when the fields change, and validation reports one a hand edit left.
 */
import type { CollectionBrowse, CollectionDoc } from './types';

/** How many filters, and how many sorts, a collection's browsing offers at most. */
export const MAX_BROWSE_KEYS = 12;

export type BrowseFilterKind = 'choice' | 'yesno' | 'range';
export type BrowseSortKind = 'text' | 'number' | 'date';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && typeof rec === 'object' && Object.hasOwn(rec, key) ? rec[key] : undefined);

type Shape = Pick<CollectionDoc, 'fields' | 'taxonomies'>;

/** The custom field a `field.<name>` key names, as the collection declares it. */
function customField(settings: Shape, key: string) {
  const f = key.startsWith('field.') ? own(settings.fields, key.slice(6)) : undefined;
  return f && typeof f === 'object' ? f : undefined;
}

/** The kind of filter a key gives on a collection of this shape, or null when it gives none. */
export function browseFilterKind(settings: Shape, key: unknown): BrowseFilterKind | null {
  if (typeof key !== 'string') return null;
  if (key.startsWith('terms.')) {
    const t = own(settings.taxonomies, key.slice(6));
    return t && typeof t === 'object' ? 'choice' : null;
  }
  const f = customField(settings, key);
  if (f?.type === 'enum') return Array.isArray(f.options) ? 'choice' : null;
  if (f?.type === 'boolean') return 'yesno';
  if (f?.type === 'number') return 'range';
  return null;
}

/** The kind of sort a key gives on a collection of this shape, or null when it gives none. */
export function browseSortKind(settings: Shape, key: unknown): BrowseSortKind | null {
  if (key === 'title') return 'text';
  if (key === 'publishedAt') return 'date';
  if (typeof key !== 'string') return null;
  const f = customField(settings, key);
  if (f?.type === 'string') return 'text';
  if (f?.type === 'number') return 'number';
  if (f?.type === 'date') return 'date';
  return null;
}

/** The keys of a list that give a control, each once, in the order given, at most MAX_BROWSE_KEYS. */
function eligible(keys: unknown, fits: (key: unknown) => unknown): string[] {
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.filter((k): k is string => typeof k === 'string' && !!fits(k)))].slice(0, MAX_BROWSE_KEYS);
}

/**
 * What a collection's browsing offers, as its fields allow: the search when it asks for one, and each filter and sort
 * its fields give a control for. Undefined when that is nothing, so the index has no controls.
 */
export function collectionBrowse(settings: Shape & { browse?: unknown }): Required<CollectionBrowse> | undefined {
  const raw = settings.browse;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  const out = { search: b.search === true, filters: eligible(b.filters, (k) => browseFilterKind(settings, k)), sort: eligible(b.sort, (k) => browseSortKind(settings, k)) };
  return out.search || out.filters.length || out.sort.length ? out : undefined;
}

/** A browse setting as stored: only what it offers, with nothing left out: undefined when it offers nothing. */
export function storedBrowse(settings: Shape & { browse?: unknown }): CollectionBrowse | undefined {
  const b = collectionBrowse(settings);
  if (!b) return undefined;
  return { ...(b.search ? { search: true } : {}), ...(b.filters.length ? { filters: b.filters } : {}), ...(b.sort.length ? { sort: b.sort } : {}) };
}

/** What is wrong with a collection's browse setting as a hand edit leaves it, or null. */
export function browseProblem(settings: Shape & { browse?: unknown }, label: (key: string) => string = (k) => k): string | null {
  const raw = settings.browse;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'its visitor browsing is damaged.';
  const b = raw as Record<string, unknown>;
  if (b.search !== undefined && typeof b.search !== 'boolean') return 'whether visitors can search its index is not true or false.';
  for (const [list, fits, what] of [
    [b.filters, (k: unknown) => browseFilterKind(settings, k), 'filter by'],
    [b.sort, (k: unknown) => browseSortKind(settings, k), 'sort by']
  ] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > MAX_BROWSE_KEYS || !list.every((k) => typeof k === 'string')) return `the fields visitors can ${what} are not a list of at most ${MAX_BROWSE_KEYS} field names.`;
    const bad = list.find((k) => !fits(k));
    if (bad !== undefined) return `visitors cannot ${what} ${label(bad as string)}, so its index leaves that out.`;
    if (new Set(list).size !== list.length) return `a field visitors can ${what} is listed twice.`;
  }
  return null;
}
