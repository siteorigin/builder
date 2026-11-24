import type { SiteEntry } from '@shared/collections';

/** More collections than this are totalled ("12 entries from 8 collections") rather than named, so the line stays short. */
const MAX_NAMED_COLLECTIONS = 3;
/** Collection names longer than this in all are totalled too, however few collections there are. */
const MAX_NAME_CHARS = 110;

/** "Posts", "Posts and Case studies", "Posts, News and Case studies". */
const joinAnd = (parts: string[]): string => (parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** How many of the entries are in each collection, by the collection's name (and address, for two that share a name). */
function countByCollection(entries: SiteEntry[]): Array<{ name: string; count: number }> {
  const groups = new Map<string, { name: string; route: string; count: number }>();
  for (const { collection } of entries) {
    const found = groups.get(collection.settings.id);
    if (found) found.count++;
    else groups.set(collection.settings.id, { name: (typeof collection.settings.name === 'string' ? collection.settings.name.trim() : '') || collection.settings.id, route: collection.settings.route, count: 1 });
  }
  const all = [...groups.values()];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return all.map((g) => ({ name: all.some((o) => o !== g && same(o.name, g.name)) ? `${g.name} (${g.route})` : g.name, count: g.count }));
}

/**
 * Collection entries counted by the collection they are in: "3 entries from Posts", "2 entries from Posts and 1 entry
 * from Case studies". Many collections are totalled instead, "12 entries from 8 collections". `kind` says what they
 * are: published entries, or draft entries.
 */
export function entryCounts(entries: SiteEntry[], kind: 'entry' | 'draft entry'): string {
  if (!entries.length) return '';
  const noun = (n: number) => `${n} ${n === 1 ? kind : kind === 'entry' ? 'entries' : 'draft entries'}`;
  const counts = countByCollection(entries);
  const named = counts.length === 1 || (counts.length <= MAX_NAMED_COLLECTIONS && counts.reduce((n, c) => n + c.name.length, 0) <= MAX_NAME_CHARS);
  return named ? joinAnd(counts.map((c) => `${noun(c.count)} from ${c.name}`)) : `${noun(entries.length)} from ${counts.length} collections`;
}

/** What the website publishes besides pages, in the sentence that follows the pages': empty when there are no entries. */
export function publishedEntriesSentence(entries: SiteEntry[]): string {
  return entries.length ? `It also publishes ${entryCounts(entries, 'entry')}.` : '';
}

/** The draft entries the website leaves out; `also` when draft pages are left out in the sentence before it. */
export function draftEntriesSentence(entries: SiteEntry[], also: boolean): string {
  return entries.length ? `${entryCounts(entries, 'draft entry')} ${entries.length === 1 ? 'is' : 'are'} ${also ? 'also ' : ''}left out.` : '';
}
