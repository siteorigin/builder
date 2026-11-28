import type { SiteEntry } from '@shared/collections';
import type { SeoFinding } from '@shared/seo';
import type { Diagnostic } from '@shared/api';
import type { PageDoc } from '@shared/types';
import { diagnosticKey } from '@engine/validate';

/** More pages than this are counted, with the full lists one click away, so they never push the export choices out of view. */
const LONG_PAGE_LIST = 6;
/** Pages whose names (titles, and the addresses that tell alike titles apart) run longer than this in all are counted too, however few there are. */
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
  // Counted, not named, when there are many pages or their names, as the summary would write them, would run long: the
  // website card it is written on stays in view in the dialog's footer.
  const long = all.length > LONG_PAGE_LIST || listTitles(published, all).length + listTitles(drafts, all).length > LONG_TITLES;
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

/** Sample details named longer than this in all are counted instead, so their line stays one line. */
const MAX_SAMPLE_CHARS = 72;

/**
 * The line the Export dialog's "Visitors can't reach you yet" box gives the starter's sample contact details still on
 * the website: named while they are few and short ("hello@example.com and +1 555 0134 are sample details from the
 * starter."), counted otherwise.
 */
export function sampleContactsLine(values: string[]): string {
  if (values.length === 1) return `${values[0]} is a sample detail from the starter.`;
  if (values.length <= 3 && values.reduce((n, v) => n + v.length, 0) <= MAX_SAMPLE_CHARS) return `${joinAnd(values)} are sample details from the starter.`;
  return `${values.length} sample contact details from the starter are on the website.`;
}

/** The same form problem, however its message names the form's page. */
const formKey = (d: Diagnostic) => `${d.code}|${d.owner?.kind ?? ''}:${d.owner?.id ?? ''}|${d.nodeId ?? ''}`;

/** What the Export dialog's one line counts of what Project health lists, beside the forms and sample details it shows itself. */
export interface HealthNotes {
  /** The search and sharing findings that keep the website from being found or shared (problems and warnings). */
  seo: number;
  /** Everything else Project health lists: the search audit's suggestions and the project's own diagnostics. */
  other: number;
  /** The project's own problems and warnings among `other`: worth checking before publishing, unlike a suggestion. */
  otherDue: number;
  /**
   * Project health opens at Search & AI readiness: it holds what the line leads with, or all there is. A problem of the
   * project's own comes first, in the summary above it.
   */
  atSeo: boolean;
}

/**
 * Count what Project health lists for the Export dialog's line, each once: a diagnostic that is also a search finding
 * is counted with the search findings, a form the dialog already names (`shown`) is not counted again, and conflicts
 * and links to drafts (which stop the export, and the dialog lists) are left out.
 */
export function healthNotes({ seo, diagnostics, shown }: { seo: readonly SeoFinding[]; diagnostics: readonly Diagnostic[]; shown: readonly Diagnostic[] }): HealthNotes {
  const seoKeys = new Set(seo.map(diagnosticKey));
  const shownKeys = new Set(shown.map(formKey));
  // Links to drafts the dialog lists itself, above the export they stop.
  const rest = diagnostics.filter((d) => d.code !== 'CONFLICT' && d.code !== 'LINK_TO_DRAFT' && !seoKeys.has(diagnosticKey(d)) && !shownKeys.has(formKey(d)));
  const due = seo.filter((f) => f.severity !== 'info').length;
  const restDue = rest.filter((d) => d.severity !== 'info');
  return { seo: due, other: seo.length - due + rest.length, otherDue: restDue.length, atSeo: !restDue.some((d) => d.severity === 'error') && (due > 0 || rest.length === 0) };
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "2 search and sharing suggestions and 3 more notes.", or whichever of them there are; empty when there are none. */
export function healthNotesText({ seo, other }: Pick<HealthNotes, 'seo' | 'other'>): string {
  const lead = seo ? count(seo, 'search and sharing suggestion') : '';
  const rest = other ? `${other} ${seo ? 'more ' : ''}${other === 1 ? 'note' : 'notes'}` : '';
  return lead || rest ? `${joinAnd([lead, rest].filter(Boolean))}.` : '';
}

/**
 * What the Export dialog still listed to fix when an export started, beside the export's own notes, in the dialog's
 * words: the sample contact details left to review, and the search and sharing findings and the project's own problems
 * and warnings in Project health. Suggestions are not something to fix, so an export's result says "Nothing to fix."
 * over them, and only when this is empty.
 */
export function dialogFixes({ samples, seo, other = 0 }: { samples: string[]; seo: number; other?: number }): string[] {
  const inHealth = (n: number) => (n === 1 ? 'is' : 'are') + ' in Project health.';
  return [...(samples.length ? [sampleContactsLine(samples)] : []), ...(seo ? [`${count(seo, 'search and sharing suggestion')} ${inHealth(seo)}`] : []), ...(other ? [`${count(other, 'note')} to check ${inHealth(other)}`] : [])];
}

/** What a website export says it published: "3 pages", "3 pages and 3 entries from Posts", as the dialog counts them. */
export function exportedCounts(pages: number, entries: SiteEntry[]): string {
  return `${pages} page${pages === 1 ? '' : 's'}${entries.length ? ` and ${entryCounts(entries, 'entry')}` : ''}`;
}

/** Whether an export's result may say "Nothing to fix.": it finished with no notes, and the dialog listed nothing to fix. */
export function nothingToFix(result: { ok: boolean; warnings: string[]; fixesListed?: string[] }): boolean {
  return result.ok && !result.warnings.length && !result.fixesListed?.length;
}
