import type { SiteEntry } from '@shared/collections';
import type { PageDoc } from '@shared/types';

/** More pages than this are counted, with the full lists one click away, so they never push the export choices out of view. */
const LONG_PAGE_LIST = 6;
/** Page titles longer than this in all are counted too, however few pages there are. */
const LONG_TITLES = 110;

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
    else groups.set(collection.settings.id, { name: (typeof collection.settings.name === 'string' ? collection.settings.name.trim() : '') || collection.settings.id, route: collection.settings.route ?? '', count: 1 });
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

/** "Home", "Home and About", "Home, About and Contact". Pages that share a title are told apart by their address. */
function listTitles(pages: PageDoc[], all: PageDoc[]): string {
  const key = (p: PageDoc) => p.title.trim().toLowerCase();
  return joinAnd(pages.map((p) => (all.some((o) => o.id !== p.id && key(o) === key(p)) ? `${p.title} (${p.route})` : p.title)));
}

/** A line of the summary: its lead is set in bold, and what follows (a space first, when there is any) is not. */
export interface SummaryLine {
  lead: string;
  rest: string;
}

/** The Export dialog's summary of what the website publishes and leaves out. */
export interface PagesSummaryText {
  /** Pages are counted, not named, and the lists of them are one click away. */
  long: boolean;
  published: SummaryLine;
  /** Null when nothing is left out. */
  drafts: SummaryLine | null;
}

/**
 * The words of the summary: pages named when the list is short and counted when it is long, and collection entries
 * (blog posts, say) counted by their collection after them, so a published post is seen to go out and a draft post to
 * stay behind. A site without entries reads as its pages alone.
 */
export function pagesSummaryText(plan: { published: PageDoc[]; drafts: PageDoc[]; publishedEntries: SiteEntry[]; draftEntries: SiteEntry[] }): PagesSummaryText {
  const { published, drafts, publishedEntries, draftEntries } = plan;
  const all = [...published, ...drafts];
  // Counted, not named, when there are many pages or their titles would run long.
  const long = all.length > LONG_PAGE_LIST || all.reduce((n, p) => n + p.title.length, 0) > LONG_TITLES;
  const alsoPublished = publishedEntriesSentence(publishedEntries);
  const line: SummaryLine = {
    lead: `The website publishes ${published.length === 1 ? '1 page' : `${published.length} pages`}${long ? '.' : ':'}`,
    rest: `${long ? '' : ` ${listTitles(published, all)}.`}${alsoPublished && ` ${alsoPublished}`}`
  };
  if (drafts.length > 0) {
    const alsoLeftOut = draftEntriesSentence(draftEntries, true);
    return {
      long,
      published: line,
      drafts: {
        lead: `${drafts.length === 1 ? '1 draft is' : `${drafts.length} drafts are`} left out${long ? '.' : ':'}`,
        rest: `${long ? '' : ` ${listTitles(drafts, all)}.`}${alsoLeftOut && ` ${alsoLeftOut}`} Drafts stay in the editable project; hiding a page from search engines doesn’t leave it out.`
      }
    };
  }
  // Only entries are left out: there is no page for the search-engine note to be about.
  return { long, published: line, drafts: draftEntries.length > 0 ? { lead: draftEntriesSentence(draftEntries, false), rest: ' Drafts stay in the editable project.' } : null };
}

/** The heading of the Export dialog's review of the starter's sample contact details still on the website. */
export function sampleContactsHeading(count: number): string {
  return count === 1 ? 'A sample contact detail from the starter is still on the website.' : `${count} sample contact details from the starter are still on the website.`;
}

/** The heading of the Export dialog's search and AI preflight, for what keeps the website from being found or shared. */
export function seoPreflightHeading(count: number): string {
  return count === 1 ? 'One thing keeps the website from being found or shared well.' : `${count} things keep the website from being found or shared well.`;
}

/**
 * What the Export dialog still listed to fix when an export started, beside the export's own notes, in the dialog's
 * words: the sample contact details left to review and what keeps the website from being found. An export's result
 * says "Nothing to fix." only when this is empty too.
 */
export function dialogFixes({ samples, seo }: { samples: number; seo: number }): string[] {
  return [...(samples ? [sampleContactsHeading(samples)] : []), ...(seo ? [seoPreflightHeading(seo)] : [])];
}

/** What a website export says it published: "3 pages", "3 pages and 3 entries from Posts", as the dialog counts them. */
export function exportedCounts(pages: number, entries: SiteEntry[]): string {
  return `${pages} page${pages === 1 ? '' : 's'}${entries.length ? ` and ${entryCounts(entries, 'entry')}` : ''}`;
}

/** Whether an export's result may say "Nothing to fix.": it finished with no notes, and the dialog listed nothing to fix. */
export function nothingToFix(result: { ok: boolean; warnings: string[]; fixesListed?: string[] }): boolean {
  return result.ok && !result.warnings.length && !result.fixesListed?.length;
}
