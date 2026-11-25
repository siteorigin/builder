/**
 * The SEO view's overview (#707): where every page and collection entry stands in search results and link previews,
 * one row per document the view lists, drafts included. The SEO audit (engine/seo-audit.ts) reports by finding and
 * judges only what the website publishes; the overview gives every document a status of its own, from the same
 * metadata (the resolver) and the same rules (the length ranges and the duplicate key), so where both speak they agree.
 *
 * A published document search engines may list is judged as the audit judges it: its title or description is
 * missing, repeated or the wrong length exactly when the audit says so. Every other document (a draft, one off the
 * website, one hidden from search engines) is judged on its own words as they would read once listed: missing or the
 * wrong length as they stand, and repeated when a listed document already has the same words, which is what it would
 * compete with. Two such documents never count as repeating each other: neither is in search results.
 */
import type { EffectiveSeo, SeoSubject } from '@shared/seo';
import { seoLength, seoText } from '@shared/seo';
import type { ProjectState } from '@shared/types';
import { createSeoResolver } from '@generator/seo-metadata';
import { readableState } from '@engine/seo-audit';
import { SEO_DESCRIPTION_RANGE, SEO_TITLE_RANGE, seoDuplicateKey } from '@engine/seo-rules';
import { seoDocuments } from './seo-view';
import { ownSettings } from './seo-preview';

/** How a title or description measures up: none at all, shorter or longer than reads well, or within the range. */
export type SeoTextStatus = 'missing' | 'short' | 'long' | 'good';

/** A document's sharing image: its own, its featured image (an entry), the site's, none, or one gone from the library. */
export type SeoImageStatus = 'own' | 'featured' | 'site' | 'none' | 'gone';

/** What the overview says of a document's title or description. */
export interface SeoOverviewText {
  /** The words as search results show them, with every fallback applied; empty when there are none. */
  text: string;
  chars: number;
  status: SeoTextStatus;
  /** Whether the words are a fallback (a page's default title, the site's description, an entry's excerpt). */
  fallback: boolean;
  /** How many other documents search engines may list have the same words in the same language. */
  duplicates: number;
}

/** Something that keeps a document from reading well in search results or when shared. */
export type SeoOverviewProblem = 'title-missing' | 'title-duplicate' | 'title-length' | 'description-missing' | 'description-duplicate' | 'description-length' | 'image-missing' | 'home-hidden';

export interface SeoOverviewRow {
  subject: SeoSubject;
  /** Tells rows apart, as the SEO view's list does (seoSubjectKey). */
  key: string;
  /** The document as the author knows it: a page's or entry's own title. */
  name: string;
  /** Where it is published: `/` for Home, else its route. */
  address: string;
  /** The collection an entry belongs to, by name; empty for a page. */
  collection: string;
  home: boolean;
  draft: boolean;
  /** It asks search engines not to list it. */
  noindex: boolean;
  /** It is on the website and search engines may list it: a document the audit judges. */
  listed: boolean;
  title: SeoOverviewText;
  description: SeoOverviewText;
  image: SeoImageStatus;
  problems: SeoOverviewProblem[];
  /** The most its problems ask: `warning` (missing, repeated, no image, Home hidden), `note` (only a length), else `ok`. */
  level: 'warning' | 'note' | 'ok';
}

const WARNINGS: ReadonlySet<SeoOverviewProblem> = new Set(['title-missing', 'title-duplicate', 'description-missing', 'description-duplicate', 'image-missing', 'home-hidden']);
const LEVEL_RANK = { warning: 0, note: 1, ok: 2 } as const;

/** A title's or description's words as search results show them, and how their length measures up. */
export function seoTextStatus(value: string, field: 'title' | 'description'): Pick<SeoOverviewText, 'text' | 'chars' | 'status'> {
  const text = seoText(value);
  const chars = seoLength(text);
  const range = field === 'title' ? SEO_TITLE_RANGE : SEO_DESCRIPTION_RANGE;
  return { text, chars, status: !chars ? 'missing' : chars < range.min ? 'short' : chars > range.max ? 'long' : 'good' };
}

function imageStatus(meta: EffectiveSeo): SeoImageStatus {
  if (meta.imageSource === 'none') return 'none';
  return meta.image ? meta.imageSource : 'gone';
}

/**
 * Every document the SEO view lists with where it stands, the ones with the most to fix first (a warning, then only a
 * note, then nothing), each level in the view's own order: the pages in page order, then each collection's entries.
 * A record too damaged to read (a page with no address, written by hand) is left out, as the audit leaves it out:
 * Project health reports it.
 */
export function seoOverview(project: ProjectState): SeoOverviewRow[] {
  const state = readableState(project);
  const resolver = createSeoResolver(state);
  // A draft the audit never reads may hold a value damaged by hand that the resolver can't read: it is left out, and
  // never takes the rest of the overview with it.
  const resolve = (subject: SeoSubject): EffectiveSeo | null => {
    try {
      return resolver.resolve(subject);
    } catch {
      return null;
    }
  };
  // The documents search engines may list, as the audit's duplicate rule groups them.
  const counts = { title: new Map<string, number>(), description: new Map<string, number>() };
  for (const d of resolver.published())
    if (d.visibility.indexable)
      for (const field of ['title', 'description'] as const) {
        const key = seoDuplicateKey(d, field);
        if (key) counts[field].set(key, (counts[field].get(key) ?? 0) + 1);
      }

  const rows: SeoOverviewRow[] = [];
  const seen = new Set<string>();
  for (const group of seoDocuments(state))
    for (const doc of group.documents) {
      // Once each, however often a hand-edited entry order names it.
      if (seen.has(doc.key)) continue;
      seen.add(doc.key);
      const meta = resolve(doc.subject);
      if (!meta) continue;
      const listed = meta.visibility.website && meta.visibility.indexable;
      const own = ownSettings(state, doc.subject);
      const field = (f: 'title' | 'description'): SeoOverviewText => {
        const key = seoDuplicateKey(meta, f);
        const same = key ? (counts[f].get(key) ?? 0) : 0;
        // A listed document is counted among its own peers; any other is not one of them.
        return { ...seoTextStatus(meta[f], f), fallback: !own[f], duplicates: listed ? Math.max(0, same - 1) : same };
      };
      const title = field('title');
      const description = field('description');
      const image = imageStatus(meta);
      const problems: SeoOverviewProblem[] = [];
      for (const [f, t] of [
        ['title', title],
        ['description', description]
      ] as const) {
        if (t.status === 'missing') {
          problems.push(`${f}-missing`);
          continue;
        }
        if (t.duplicates > 0) problems.push(`${f}-duplicate`);
        if (t.status !== 'good') problems.push(`${f}-length`);
      }
      if (image === 'none' || image === 'gone') problems.push('image-missing');
      if (doc.home && meta.noindex) problems.push('home-hidden');
      rows.push({
        subject: doc.subject,
        key: doc.key,
        name: doc.title,
        address: doc.address,
        collection: group.id === 'pages' ? '' : group.label,
        home: doc.home,
        draft: doc.draft,
        noindex: meta.noindex,
        listed,
        title,
        description,
        image,
        problems,
        level: problems.some((p) => WARNINGS.has(p)) ? 'warning' : problems.length ? 'note' : 'ok'
      });
    }
  // A stable sort: each level keeps the view's order.
  return rows.map((row, i) => ({ row, i })).sort((a, b) => LEVEL_RANK[a.row.level] - LEVEL_RANK[b.row.level] || a.i - b.i).map(({ row }) => row);
}

/** The overview's rows with something to fix, in the same order. */
export const seoOverviewProblems = (rows: readonly SeoOverviewRow[]): SeoOverviewRow[] => rows.filter((r) => r.level !== 'ok');

const overviews = new WeakMap<ProjectState, SeoOverviewRow[]>();

/** The overview of one saved project state, worked out once: a saved state is never changed, only replaced. */
export function seoOverviewOnce(state: ProjectState): SeoOverviewRow[] {
  let rows = overviews.get(state);
  if (!rows) overviews.set(state, (rows = seoOverview(state)));
  return rows;
}
