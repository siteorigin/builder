/**
 * Plans an import of posts into the open project: where each post goes (its slug, numbered when its address is
 * taken), the categories and tags it brings, which old addresses keep working, and which pictures it shows. The
 * plan is shown to the author before anything changes, and turns into one batch of operations: one change in the
 * project's history, undone in one step.
 */
import type { AssetRecord, CollectionTaxonomy, EntryDoc, LinkValue, ProjectState, RichBlock, RichSpan, RichText } from '@shared/types';
import { validateOperation, type EditOperation } from '@shared/ops';
import { POSTS_COLLECTION_ID, archiveRouteOwner, findEntry, hasArchivePages, hasCategoryArchives, hasDetailPages, isTermId, routeOwners, underArchiveFolder } from '@shared/collections';
import { archiveRoute } from '@shared/archives';
import { hasTerm, publishedEntries } from '@shared/entry-feed';
import { todayArticleDate } from '@shared/articles';
import { addressSlug, normalizeRoute, numberedSlug, slugify, validateRoute, validateSegment } from '@shared/routes';
import { cleanBlocks, isImageBlock, isListBlock, spanRuns } from '@shared/richtext';
import { newId } from '@shared/ids';
import { TEXT_LIMITS } from '@shared/text-limits';
import { applyOperations } from '@engine/apply';
import { MAX_CAPTION, MAX_ENTRY_BLOCKS, MAX_ENTRY_CHARS } from '@engine/values';
import { pageIds } from '@generator/checks';
import { linkNotes, type LinkNotes } from './notes';
import { POST_LINK_PREFIX, type ParsedSource, type SourceMedia, type SourcePost, type SourceTerm } from './source';

/** Groupings an import fills, with the labels a new one gets. */
const TAXONOMIES = { categories: 'Categories', tags: 'Tags' } as const;
type TaxonomyId = keyof typeof TAXONOMIES;
const MAX_TERMS = 200;
const MAX_TAXONOMIES = 10;
const MAX_ASSIGNED = 50;
const PRESET_ROUTE = '/blog/';

export interface PlannedPost {
  key: string;
  from: string;
  entryId: string;
  title: string;
  slug: string;
  route: string;
  /** The slug the source gave, when the post had to take another. */
  wantedSlug?: string;
  date: string;
  /** The source gave no date, so `date` is the day of the import. */
  dateAssigned?: boolean;
  draft: boolean;
  draftReason?: string;
  author?: string;
  excerpt?: string;
  terms: Partial<Record<TaxonomyId, string[]>>;
  /** Pictures carry media keys; links to other imported posts already go to their entries. */
  body: RichText;
  /** Its text links to entries of this import, so it is set once they all exist. */
  linksEntries: boolean;
  featured?: string;
  /** The old address kept working for it. */
  redirectFrom?: string;
  /** The old address it had, when that one can't keep working (its note says why). */
  lostAddress?: string;
  oldPath?: string;
  notes: string[];
}

export interface PostImportPlan {
  source: { kind: ParsedSource['kind']; label: string; site?: string };
  collection: { id: string; name: string; route: string; create: boolean };
  /** The collection's whole set of groupings after the import, when the import changes it. */
  taxonomies: Record<string, CollectionTaxonomy> | null;
  /** Every category's and tag's name by ID, as they will be: what the review shows. */
  termLabels: Record<TaxonomyId, Record<string, string>>;
  newTerms: Record<TaxonomyId, string[]>;
  posts: PlannedPost[];
  /** The pictures the posts show that were found, to import as library images. */
  media: SourceMedia[];
  /** Pictures the posts show that were not found, with why, by post. */
  missing: Array<{ post: string; ref: string; problem: string }>;
  skipped: string[];
  /**
   * The old site's addresses the posts still link to, as they wrote them, each with how many posts link to it, most
   * linked first: links the new site may replace once it is published there. `to` is where an old category archive's
   * address sends visitors once the import keeps it working (archiveRedirects); `pending` while no published post is
   * filed under that category, so its archive is not there yet.
   */
  oldSiteLinks: Array<{ url: string; posts: number; to?: string; pending?: true }>;
  /** The old site's category archive addresses the posts link to, kept working by sending visitors to the new archive. */
  archiveRedirects: Array<{ from: string; to: string }>;
  /** What stops the import. Nothing is imported while there is one. */
  problems: string[];
}

const lower = (s: string) => s.toLowerCase();

/** Text cut to `max` characters at a word, ending in an ellipsis when it was cut. */
function clip(text: string, max: number): { text: string; cut: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, cut: false };
  const at = t.lastIndexOf(' ', max - 1);
  return { text: `${t.slice(0, at > max / 2 ? at : max - 1).trimEnd()}…`, cut: true };
}

/**
 * Plans `source` into `state`'s Posts collection (made when the project has none). Never changes `state`. With
 * `consume`, each post's text as read is let go of once its own is planned (`source` is then the plan's to spend): a
 * read's posts and their plan are never both held whole. With `check: false`, what the engine would refuse is left
 * for checkPlan to find, against the same state.
 */
export function planPostImport(state: ProjectState, source: ParsedSource, today = todayArticleDate(), opts: { consume?: boolean; check?: boolean } = {}): PostImportPlan {
  const problems: string[] = [];
  const existing = Object.hasOwn(state.collections, POSTS_COLLECTION_ID) ? state.collections[POSTS_COLLECTION_ID] : undefined;
  const route = existing?.settings.route ?? PRESET_ROUTE;
  const name = existing?.settings.name ?? 'Posts';
  const owners = routeOwners(state);
  const taken = new Map(owners.map((o) => [lower(o.route), o.label]));
  // A new Posts collection has an archive at its address; an existing one, only when it says so.
  const archived = !existing || hasArchivePages(existing.settings);
  // Imported posts keep their old permalinks working, which needs pages of their own to send visitors to.
  if (existing && !hasDetailPages(existing.settings)) problems.push(`The ${name} collection has no entry pages, so the posts would have no addresses. Turn its entry pages on, then import again.`);
  if (!existing) {
    const holder = taken.get(lower(route)) ?? owners.find((o) => underArchiveFolder(route, o.route))?.label ?? archiveRouteOwner(state, route)?.label;
    if (holder) problems.push(`The posts would go to ${route}, which is the address of ${holder}. Move that first, then import again.`);
    if (Object.keys(state.collections).length >= 20) problems.push('The project already has as many collections as it can, and it has no Posts collection to import into.');
  }

  // Categories and tags: the collection's own, then any the posts bring.
  const taxonomies: Record<string, CollectionTaxonomy> = structuredClone(existing?.settings.taxonomies ?? {});
  const skipped = [...source.skipped];
  let taxChanged = !existing;
  for (const id of Object.keys(TAXONOMIES) as TaxonomyId[]) {
    const wanted = source.posts.some((p) => (id === 'categories' ? p.categories : p.tags).length);
    if (!Object.hasOwn(taxonomies, id) && (wanted || !existing)) {
      if (Object.keys(taxonomies).length >= MAX_TAXONOMIES) {
        if (wanted) skipped.push(`The posts’ ${id}: the ${name} collection has as many groupings as it can, so it has no room for ${TAXONOMIES[id]}.`);
        continue;
      }
      taxonomies[id] = { label: TAXONOMIES[id], terms: {} };
      taxChanged = true;
    }
  }
  const newTerms: Record<TaxonomyId, string[]> = { categories: [], tags: [] };
  // Terms by their name, any case: one lookup each, however many the posts bring.
  const byLabel = new Map(Object.keys(TAXONOMIES).map((tax) => [tax, new Map(Object.entries(taxonomies[tax]?.terms ?? {}).map(([id, v]) => [lower(v.label), id]))]));
  /** New terms past the most a grouping takes: counted for the reason the import stops, never added. */
  const over: Record<TaxonomyId, Set<string>> = { categories: new Set(), tags: new Set() };
  const termId = (tax: TaxonomyId, term: SourceTerm): string | null => {
    const t = taxonomies[tax];
    if (!t) return null;
    // Cut at 80 characters, never at a word: two names that differ before then stay two terms.
    const label = term.label.trim().slice(0, 80).trim();
    const index = byLabel.get(tax)!;
    const found = index.get(lower(label));
    if (found) return found;
    if (index.size >= MAX_TERMS) {
      over[tax].add(lower(label));
      return null;
    }
    const stem = [term.slug && isTermId(lower(term.slug)) ? lower(term.slug) : '', slugify(label).slice(0, 50)].find((s) => s && isTermId(s)) || 'term';
    let id = stem;
    for (let n = 2; Object.hasOwn(t.terms, id) || !isTermId(id); n++) id = `${stem.slice(0, 50)}-${n}`;
    t.terms[id] = { label };
    index.set(lower(label), id);
    newTerms[tax].push(label);
    taxChanged = true;
    return id;
  };

  const media = new Map(source.media.map((m) => [m.key, m]));
  const used = new Set<string>();
  const missing: PostImportPlan['missing'] = [];
  const entryIds = new Map<string, string>();
  const ids = new Set<string>();
  for (const p of source.posts) {
    let id = newId('en', 10);
    while (ids.has(id) || findEntry(state, id)) id = newId('en', 10);
    ids.add(id);
    entryIds.set(p.key, id);
  }

  // Every post's address first, so an old address is never one a later post takes.
  const planned = new Map<string, string>();
  const slugs = source.posts.map((p) => {
    const wanted = addressSlug(p.slug) || addressSlug(p.title) || 'post';
    const stem = validateSegment(wanted) ? 'post' : wanted;
    let slug = stem;
    const free = (s: string) => {
      const r = lower(`${route}${s}/`);
      return !taken.has(r) && !planned.has(r);
    };
    for (let n = 2; !free(slug); n++) slug = numberedSlug(stem, n);
    planned.set(lower(`${route}${slug}/`), p.key);
    return { slug, wanted: slug !== stem ? stem : undefined };
  });
  const redirects = new Map<string, string>();
  const oldClaims = new Map<string, number>();
  for (const p of source.posts) if (p.oldPath && !p.draft) oldClaims.set(lower(p.oldPath), (oldClaims.get(lower(p.oldPath)) ?? 0) + 1);

  const byKey = new Map(source.posts.map((p) => [p.key, p]));
  const noSection = sectionCheck(state);
  // Every post's text first: one cut to fit arrives as a draft, which the posts linking to it are told. The imported
  // posts each one links to, as its text was read, are kept for that.
  const texts = source.posts.map((p) => {
    const notes: string[] = [];
    const planned = { ...planBody(p, media, missing, entryIds, notes, noSection), notes, linked: new Set(p.body.flatMap((b) => spanRuns(b).flat()).flatMap((s) => (s.link?.type === 'entry' && s.link.target.startsWith(POST_LINK_PREFIX) ? [s.link.target.slice(POST_LINK_PREFIX.length)] : []))) };
    if (opts.consume) (p as { body: RichText }).body = [];
    return planned;
  });
  const arrivesDraft = new Map(source.posts.map((p, i) => [p.key, p.draft || texts[i].cut]));
  const posts: PlannedPost[] = source.posts.map((p, i) => {
    const notes = [...p.notes];
    // A published post linking to one that arrives as a draft: the website can't be exported until one of them changes.
    if (!arrivesDraft.get(p.key)) {
      for (const key of texts[i].linked) {
        const target = byKey.get(key);
        if (target && arrivesDraft.get(key)) notes.push(`It links to “${clip(target.title, 200).text}”, which arrives as a draft: publish that post, or change the link, before the website is exported.`);
      }
    }
    const { slug, wanted } = slugs[i];
    const entryRoute = `${route}${slug}/`;
    const title = clip(p.title || 'Untitled post', 200);
    if (title.cut) notes.push('Its title was shortened to 200 characters.');
    const excerpt = p.excerpt ? clip(p.excerpt, 320) : undefined;
    if (excerpt?.cut) notes.push('Its excerpt was shortened to 320 characters.');
    const authorClip = p.author ? clip(p.author, 80) : undefined;
    if (authorClip?.cut) notes.push('Its author’s name was shortened to 80 characters.');
    const author = authorClip?.text;
    const { blocks: body, cut } = texts[i];
    notes.push(...texts[i].notes);
    // Only the pictures the entry shows are imported.
    for (const b of body) if (isImageBlock(b)) used.add(b.assetId);
    // Text that had to be cut is never published unread: the author checks it first.
    const draft = p.draft || cut;
    const draftReason = p.draftReason ?? (cut && !p.draft ? 'its text was longer than a post holds, so it was cut' : undefined);
    if ([...p.categories, ...p.tags].some((t) => t.label.trim().length > 80)) notes.push('A category or tag name was shortened to 80 characters.');
    const linksEntries = body.some((b) => spanRuns(b).some((run) => run.some((s) => s.link?.type === 'entry')));
    let featured: string | undefined;
    if (p.featured) {
      const m = media.get(p.featured);
      if (m?.path) {
        featured = m.key;
        used.add(m.key);
      } else {
        missing.push({ post: p.title, ref: m?.ref ?? p.featured, problem: m?.problem ?? 'it was not found' });
        notes.push(`Its featured picture (${m?.ref ?? p.featured}) was left out: ${m?.problem ?? 'it was not found'}.`);
      }
    }
    const terms: PlannedPost['terms'] = {};
    for (const tax of Object.keys(TAXONOMIES) as TaxonomyId[]) {
      const list = (tax === 'categories' ? p.categories : p.tags).map((t) => termId(tax, t)).filter((x): x is string => !!x);
      const unique = [...new Set(list)];
      if (unique.length > MAX_ASSIGNED) notes.push(`Only its first ${MAX_ASSIGNED} ${tax} were kept.`);
      if (unique.length) terms[tax] = unique.slice(0, MAX_ASSIGNED);
    }
    let redirectFrom: string | undefined;
    let lostAddress: string | undefined;
    if (p.oldPath && lower(p.oldPath) !== lower(entryRoute)) {
      const from = p.oldPath;
      const why = draft
        ? null
        : from === '/' || validateRoute(from)
          ? `${validateRoute(from) ?? 'it is the Home page'}`
          : archived && lower(from) === lower(route)
            ? `it is the address of the ${name} collection`
            : taken.has(lower(from))
            ? `it is the address of ${taken.get(lower(from))}`
            : planned.has(lower(from))
              ? 'another imported post has that address'
              : (oldClaims.get(lower(from)) ?? 0) > 1 || redirects.has(lower(from))
                ? 'another imported post had it too'
                : (archived && underArchiveFolder(route, from)) || archiveRouteOwner(state, from)
                  ? 'it is kept for a collection’s archive pages'
                  : '';
      if (why === '') {
        redirectFrom = from;
        redirects.set(lower(from), p.key);
      } else if (why) {
        lostAddress = from;
        notes.push(`Its old address (${from}) can’t keep working, because ${why.charAt(0).toLowerCase()}${why.slice(1).replace(/\.$/, '')}.`);
      }
    }
    return {
      key: p.key,
      from: p.from,
      entryId: entryIds.get(p.key)!,
      title: title.text,
      slug,
      route: entryRoute,
      ...(wanted ? { wantedSlug: wanted } : {}),
      date: p.date ?? today,
      ...(p.date ? {} : { dateAssigned: true }),
      draft,
      ...(draftReason ? { draftReason } : {}),
      ...(author ? { author } : {}),
      ...(excerpt ? { excerpt: excerpt.text } : {}),
      terms,
      body,
      linksEntries,
      ...(featured ? { featured } : {}),
      ...(redirectFrom ? { redirectFrom } : {}),
      ...(lostAddress ? { lostAddress } : {}),
      ...(p.oldPath ? { oldPath: p.oldPath } : {}),
      notes
    };
  });
  for (const tax of Object.keys(TAXONOMIES) as TaxonomyId[]) {
    if (!over[tax].size) continue;
    const n = Object.keys(taxonomies[tax]?.terms ?? {}).length + over[tax].size;
    problems.push(`The posts bring ${newTerms[tax].length + over[tax].size} new ${tax}, which would give the collection ${n}: it can have at most ${MAX_TERMS}.`);
  }
  if (!source.posts.length) problems.push(`${source.label} has no posts to import.`);

  // The old site's addresses the posts still link to. Its category archives among them, for a category the import
  // brings, are kept working by sending visitors to that category's new archive, as the posts' own old addresses are.
  const oldSiteLinks = source.site ? linksToOldSite(posts, source.site) : [];
  const archiveRedirects: PostImportPlan['archiveRedirects'] = [];
  if (archived && (!existing || hasCategoryArchives(existing.settings))) {
    // A category by its WordPress ID spelled as an address spells it, as the link's path is read.
    const bySlug = new Map<string, SourceTerm>();
    for (const p of source.posts) for (const t of p.categories) if (t.slug) bySlug.set(normalizeRoute(`/${t.slug}/`), t);
    // The categories whose archive the website has once the import is in: one with a published post.
    const listed = new Set(posts.flatMap((p) => (p.draft ? [] : (p.terms.categories ?? []))));
    let filed: EntryDoc[] | undefined;
    const live = (id: string) => listed.has(id) || (!!existing && (filed ??= publishedEntries(state, existing)).some((e) => hasTerm(e, 'categories', id)));
    const kept = new Set((Array.isArray(state.site.redirects) ? state.site.redirects : []).flatMap((r) => (typeof r?.from === 'string' ? [lower(r.from)] : [])));
    const sent = new Map<string, string>();
    for (const row of oldSiteLinks) {
      const old = oldCategoryAddress(row.url);
      const term = old && bySlug.get(`/${old.slug}/`);
      const id = term ? termId('categories', term) : null;
      if (!old || !id) continue;
      const k = lower(old.from);
      if (!sent.has(k)) {
        // Only an address nothing else holds: a page's, a post's (its own or an old one kept), a collection's, or one kept already.
        if (validateRoute(old.from) || taken.has(k) || planned.has(k) || redirects.has(k) || kept.has(k) || underArchiveFolder(route, old.from) || archiveRouteOwner(state, old.from)) continue;
        const to = archiveRoute(route, id, 1);
        sent.set(k, to);
        archiveRedirects.push({ from: old.from, to });
      }
      row.to = sent.get(k);
      if (!live(id)) row.pending = true;
    }
  }
  const plan: PostImportPlan = {
    source: { kind: source.kind, label: source.label, ...(source.site ? { site: source.site } : {}) },
    collection: { id: POSTS_COLLECTION_ID, name, route, create: !existing },
    taxonomies: taxChanged ? taxonomies : null,
    termLabels: Object.fromEntries(Object.keys(TAXONOMIES).map((tax) => [tax, Object.fromEntries(Object.entries(taxonomies[tax]?.terms ?? {}).map(([id, v]) => [id, v.label]))])) as PostImportPlan['termLabels'],
    newTerms,
    posts,
    media: source.media.filter((m) => used.has(m.key)),
    missing,
    skipped,
    oldSiteLinks,
    archiveRedirects,
    problems
  };
  if (opts.check !== false) checkPlan(state, plan);
  return plan;
}

/** The links to `site` the posts' text still has, by address, each counted once per post that has it: most linked first. */
function linksToOldSite(posts: PlannedPost[], site: string): PostImportPlan['oldSiteLinks'] {
  const counts = new Map<string, number>();
  for (const p of posts) {
    const urls = new Set<string>();
    for (const b of p.body)
      for (const s of spanRuns(b).flat()) {
        if (s.link?.type !== 'url') continue;
        try {
          if (new URL(s.link.target).origin === site) urls.add(s.link.target);
        } catch {
          // No address: nothing of the old site's.
        }
      }
    for (const u of urls) counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  return [...counts].map(([url, n]) => ({ url, posts: n })).sort((a, b) => b.posts - a.posts || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/**
 * A WordPress category archive's address (`/category/soil-science/`, or `/category/farming/soil-science/` for a
 * category under another), as a route, with the category's ID there (its last part: WordPress's IDs for categories
 * are unique), or null for any other address. One with a query lists something else (a later page, a search).
 */
function oldCategoryAddress(url: string): { from: string; slug: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.search) return null;
  const from = normalizeRoute(u.pathname);
  // Only an address the link asks for as it is kept: one spelled otherwise would be kept at an address it never asks for.
  let typed = u.pathname;
  try {
    typed = decodeURIComponent(typed);
  } catch {
    return null;
  }
  if (`${typed.replace(/\/+$/, '')}/` !== from) return null;
  const parts = from.slice(1, -1).split('/');
  // A later page of an archive (`/category/news/page/2/`) is no category of its own.
  if (parts.length < 2 || parts[0] !== 'category' || (parts.length >= 4 && parts[parts.length - 2] === 'page' && /^\d+$/.test(parts[parts.length - 1]))) return null;
  return { from, slug: parts[parts.length - 1] };
}

/**
 * What the engine would refuse of `plan`, made against `state`, found before anything changes and added to its
 * problems: every picture stands in for a library image. A plan that already has a problem is not checked. With
 * `spend`, the plan is checked by handing its posts to the engine as they are, without a copy: nothing of it may be
 * read afterwards but its problems.
 */
export function checkPlan(state: ProjectState, plan: PostImportPlan, opts: { spend?: boolean } = {}): void {
  if (plan.problems.length) return;
  const stand = new Map(plan.media.map((m) => [m.key, m.key]));
  const s = { ...state, assets: { ...state.assets, assets: { ...state.assets.assets } } };
  for (const m of plan.media) s.assets.assets[m.key] = { id: m.key, name: m.key, file: `static/assets/${m.key}.png`, mime: 'image/png', bytes: 1, hash: m.key, kind: 'image', createdAt: '' } as AssetRecord;
  try {
    const ops = planOperations(plan, stand);
    // Each operation as the session checks it, then the batch as the engine applies it.
    for (const op of ops) {
      const v = validateOperation(op);
      if (!v.ok) throw new Error(v.message);
    }
    applyOperations(s, ops, { ownOperations: !!opts.spend });
  } catch (e) {
    plan.problems.push(`The posts can’t be imported: ${(e as Error).message.replace(/^Operation \d+ \([\w.]+\): /, '')}`);
  }
}

type SectionCheck = (link: LinkValue, notes: LinkNotes) => void;

/**
 * Names a link to a section the import can't find: a page's that its page doesn't have, and one within the post, whose
 * imported text has no section IDs. Each keeps the section it names.
 */
function sectionCheck(state: ProjectState): SectionCheck {
  const ids = new Map<string, Set<string>>();
  return (link, notes) => {
    if (link.type === 'anchor') notes.add(`#${link.target}`, 'was kept, but an imported post’s text has no section with that ID: check where it goes.');
    if (link.type !== 'page' || !link.anchor || !Object.hasOwn(state.pages, link.target)) return;
    let found = ids.get(link.target);
    if (!found) ids.set(link.target, (found = pageIds(state, link.target)));
    if (!found.has(link.anchor)) notes.add(`${state.pages[link.target].route}#${link.anchor}`, 'was kept, but that page has no section with that ID: check where it goes.');
  };
}

/**
 * A post's text as the entry keeps it: pictures that were not found left out (and named), links to other imported
 * posts pointed at their entries, descriptions and captions kept within their limits, and the whole within what an
 * entry's text holds.
 */
function planBody(p: SourcePost, media: Map<string, SourceMedia>, missing: PostImportPlan['missing'], entryIds: Map<string, string>, notes: string[], noSection: SectionCheck): { blocks: RichText; cut: boolean } {
  const sections = linkNotes();
  const relink = (spans: RichSpan[]): RichSpan[] =>
    spans.map((s) => {
      if (s.link) noSection(s.link, sections);
      const target = s.link?.type === 'entry' && s.link.target.startsWith(POST_LINK_PREFIX) ? entryIds.get(s.link.target.slice(POST_LINK_PREFIX.length)) : undefined;
      if (s.link?.type !== 'entry' || !s.link.target.startsWith(POST_LINK_PREFIX)) return s;
      const { link, ...rest } = s;
      return target ? { ...rest, link: { ...link, target } as LinkValue } : rest;
    });
  let lost = 0;
  let shortened = 0;
  const out: RichBlock[] = [];
  for (const b of p.body) {
    if (isImageBlock(b)) {
      const m = media.get(b.assetId);
      if (!m?.path) {
        lost++;
        missing.push({ post: p.title, ref: m?.ref ?? b.assetId, problem: m?.problem ?? 'it was not found' });
        continue;
      }
      const caption = b.caption ? clip(b.caption, MAX_CAPTION) : undefined;
      const alt = clip(b.alt, TEXT_LIMITS.imageAlt);
      if (caption?.cut || alt.cut) shortened++;
      out.push({ type: 'image', assetId: m.key, alt: alt.text, ...(caption?.text ? { caption: caption.text } : {}) });
    } else if (isListBlock(b)) out.push({ type: b.type, items: b.items.map(relink) });
    else out.push({ type: b.type, spans: relink(b.spans) });
  }
  if (shortened) notes.push(`${shortened === 1 ? 'A picture’s description or caption was' : `${shortened} pictures’ descriptions or captions were`} shortened to ${MAX_CAPTION} characters.`);
  if (lost) notes.push(`${lost === 1 ? 'A picture it shows was' : `${lost} pictures it shows were`} not found in the chosen folder, so ${lost === 1 ? 'it was' : 'they were'} left out.`);
  // An entry's text has room for a long read; anything past that is cut, and said.
  notes.push(...sections.list());
  let blocks = cleanBlocks(out);
  let chars = 0;
  const fits: RichBlock[] = [];
  for (const b of blocks) {
    const n = isImageBlock(b) ? b.alt.length + (b.caption?.length ?? 0) : spanRuns(b).flat().reduce((m, s) => m + s.text.length, 0);
    if (fits.length >= MAX_ENTRY_BLOCKS || chars + n > MAX_ENTRY_CHARS) break;
    chars += n;
    fits.push(b);
  }
  const cut = fits.length < blocks.length;
  if (cut) {
    notes.push(`Its text was longer than a post holds, so it ends after ${fits.length} of its ${blocks.length} paragraphs.`);
    blocks = fits;
  }
  return { blocks, cut };
}

/**
 * The plan as one batch: the new library images first (`assets`, made from the pictures found), the collection and
 * its groupings, every entry (each keeping its old address), then the text of those that link to entries of the
 * import, once they all exist, and last the old category archive addresses kept working. `assetIds` maps each
 * picture's key to its library image; one missing is left out. With `addToNavigation`, a blog the import makes asks
 * for its link in the header menu, as the starter card's does.
 */
export function planOperations(plan: PostImportPlan, assetIds: Map<string, string>, assets: AssetRecord[] = [], { addToNavigation = false }: { addToNavigation?: boolean } = {}): EditOperation[] {
  const ops: EditOperation[] = assets.map((asset) => ({ type: 'asset.add', asset }) as EditOperation);
  const c = plan.collection;
  if (c.create) ops.push({ type: 'collection.create', collectionId: c.id, ...(plan.taxonomies ? { taxonomies: plan.taxonomies } : {}), ...(addToNavigation ? { addToNavigation } : {}) } as EditOperation);
  else if (plan.taxonomies) ops.push({ type: 'collection.update', collectionId: c.id, taxonomies: plan.taxonomies } as EditOperation);
  const body = (p: PlannedPost): RichText =>
    p.body.flatMap((b): RichBlock[] => {
      if (!isImageBlock(b)) return [b];
      const id = assetIds.get(b.assetId);
      return id ? [{ ...b, assetId: id }] : [];
    });
  for (const p of plan.posts) {
    const featured = p.featured ? assetIds.get(p.featured) : undefined;
    ops.push({
      type: 'entry.create',
      collectionId: c.id,
      entryId: p.entryId,
      title: p.title,
      slug: p.slug,
      publishedAt: p.date,
      draft: p.draft,
      ...(p.author ? { author: p.author } : {}),
      ...(p.excerpt ? { excerpt: p.excerpt } : {}),
      ...(featured ? { featuredImage: featured } : {}),
      terms: p.terms,
      ...(p.linksEntries ? {} : { body: body(p) }),
      ...(p.redirectFrom ? { redirectFrom: p.redirectFrom } : {})
    } as EditOperation);
  }
  for (const p of plan.posts) if (p.linksEntries) ops.push({ type: 'entry.update', collectionId: c.id, entryId: p.entryId, body: body(p) } as EditOperation);
  for (const r of plan.archiveRedirects) ops.push({ type: 'redirect.add', from: r.from, to: r.to } as EditOperation);
  return ops;
}
