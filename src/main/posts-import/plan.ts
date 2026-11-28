/**
 * Plans an import of posts into the open project: where each post goes (its slug, numbered when its address is
 * taken), the categories and tags it brings, which old addresses keep working, and which pictures it shows. The
 * plan is shown to the author before anything changes, and turns into one batch of operations: one change in the
 * project's history, undone in one step.
 */
import type { AssetRecord, CollectionTaxonomy, EntryDoc, LinkValue, ProjectState, RichBlock, RichSpan, RichText } from '@shared/types';
import { validateOperation, type EditOperation } from '@shared/ops';
import { POSTS_COLLECTION_ID, archiveRouteOwner, findEntry, hasArchivePages, hasDetailPages, isTermId, routeOwners, underArchiveFolder, type RouteOwner } from '@shared/collections';
import { isArticleDate, todayArticleDate } from '@shared/articles';
import { addressSlug, numberedSlug, slugify, validateRoute, validateSegment } from '@shared/routes';
import { cleanBlocks, isImageBlock, isListBlock, spanRuns } from '@shared/richtext';
import { newId } from '@shared/ids';
import { TEXT_LIMITS } from '@shared/text-limits';
import { applyOperations } from '@engine/apply';
import { MAX_CAPTION, MAX_ENTRY_BLOCKS, MAX_ENTRY_CHARS } from '@engine/values';
import { POST_LINK_PREFIX, type KnownPosts, type ParsedSource, type SourceMedia, type SourcePost, type SourceTerm } from './source';
import { redirectRecords } from '@shared/redirects';

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
  /** Its ID on the WordPress site, which its new entry keeps. */
  postId?: string;
  /**
   * The entry it was imported as before (#1519), which `entryId`, `slug` and `route` are: skipped, or updated in place
   * (see selectPlan). `draft` is the entry's own, or the source's when that one arrives as a draft. `unread`: its text
   * could not be read this time, so it is never put over the entry.
   */
  existing?: { draft: boolean; unread?: true };
  /** Its featured picture was not found: an update leaves the entry's own as it is. */
  keepFeatured?: true;
  notes: string[];
}

/** What importing does with the posts already in the project: leaves them as they are, or puts each one's source over it. */
export type ExistingPosts = 'skip' | 'update';

export interface PostImportPlan {
  source: { kind: ParsedSource['kind']; label: string; site?: string; siteKey?: string };
  collection: { id: string; name: string; route: string; create: boolean };
  /** The collection's whole set of groupings after the import, when the import changes it. */
  taxonomies: Record<string, CollectionTaxonomy> | null;
  /** Every category's and tag's name by ID, as they will be: what the review shows. */
  termLabels: Record<TaxonomyId, Record<string, string>>;
  newTerms: Record<TaxonomyId, string[]>;
  /** The IDs `newTerms` are given, in the same order. */
  newTermIds: Record<TaxonomyId, string[]>;
  /** The groupings the import adds to a collection that is already there. */
  addedTaxonomies: TaxonomyId[];
  posts: PlannedPost[];
  /** The pictures the posts show that were found, to import as library images. */
  media: SourceMedia[];
  /** Pictures the posts show that were not found, with why, by post (and its key). */
  missing: Array<{ post: string; key?: string; ref: string; problem: string }>;
  skipped: string[];
  /** What stops the import. Nothing is imported while there is one. */
  problems: string[];
  /** What stops only updating the posts already in the project. */
  updateProblems: string[];
}

const lower = (s: string) => s.toLowerCase();

/** Text cut to `max` characters at a word, ending in an ellipsis when it was cut. */
function clip(text: string, max: number): { text: string; cut: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, cut: false };
  const at = t.lastIndexOf(' ', max - 1);
  return { text: `${t.slice(0, at > max / 2 ? at : max - 1).trimEnd()}…`, cut: true };
}

/** Why an old address something already holds can't keep working for an imported post. */
function heldBy(o: RouteOwner): string {
  return o.kind === 'redirect' ? `it is already ${o.label}` : `it is the address of ${o.label}`;
}

/**
 * The entries of the Posts collection that `source`'s posts were imported as before (#1519), by post key: one keeping
 * the WordPress post's ID on the same site, else one at the post's old address (its own, or one kept for it) that came
 * from no other site and no other post of it. Each entry is one post's at most. A Markdown folder names no site, so its
 * posts are always new.
 */
function alreadyImported(state: ProjectState, source: ParsedSource, route: string): Map<string, EntryDoc> {
  const out = new Map<string, EntryDoc>();
  const c = Object.hasOwn(state.collections, POSTS_COLLECTION_ID) ? state.collections[POSTS_COLLECTION_ID] : undefined;
  if (!c || source.kind !== 'wordpress') return out;
  const site = source.siteKey;
  const byPost = new Map<string, EntryDoc>();
  const byAddress = new Map<string, EntryDoc>();
  // Only an entry imported from the same site is known again, by its post's ID, else by its address or an old address
  // kept for it: a post written in the project, or an old address an author pointed at one, says nothing of where it
  // came from.
  const same = (e: EntryDoc | undefined): e is EntryDoc => !!site && e?.imported?.site === site;
  for (const e of Object.values(c.entries)) {
    if (!same(e)) continue;
    byPost.set(e.imported!.postId, e);
    if (hasDetailPages(c.settings)) byAddress.set(lower(`${route}${e.slug}/`), e);
  }
  for (const r of redirectRecords(state)) {
    const e = r.entryId !== undefined && Object.hasOwn(c.entries, r.entryId) ? c.entries[r.entryId] : undefined;
    if (same(e)) byAddress.set(lower(r.from), e);
  }
  const claimed = new Set<string>();
  const claim = (key: string, e: EntryDoc | undefined) => {
    if (!e || claimed.has(e.id)) return;
    claimed.add(e.id);
    out.set(key, e);
  };
  // Every post known by its ID first, so a post known only by an address never takes the entry of one known by its ID.
  if (site) for (const p of source.posts) if (p.postId) claim(p.key, byPost.get(p.postId));
  for (const p of source.posts) {
    if (out.has(p.key) || !p.oldPath) continue;
    // An address another post of the site, known by its ID, had before is no sign of this one.
    if (!p.postId) claim(p.key, byAddress.get(lower(p.oldPath)));
  }
  return out;
}

/** The posts of `state` imported before, for the reader to link to (see KnownPosts). */
export function knownPosts(state: ProjectState): KnownPosts {
  const out: KnownPosts = { ids: {}, paths: {} };
  const c = Object.hasOwn(state.collections, POSTS_COLLECTION_ID) ? state.collections[POSTS_COLLECTION_ID] : undefined;
  if (!c) return out;
  const origin = (e: EntryDoc | undefined) => (e?.imported && typeof e.imported.site === 'string' && typeof e.imported.postId === 'string' ? e.imported : undefined);
  for (const e of Object.values(c.entries)) {
    const from = origin(e);
    if (!from) continue;
    const ids = Object.hasOwn(out.ids, from.site) ? out.ids[from.site] : (out.ids[from.site] = {});
    ids[from.postId] = e.id;
  }
  for (const r of redirectRecords(state)) {
    const from = r.entryId !== undefined && Object.hasOwn(c.entries, r.entryId) ? origin(c.entries[r.entryId]) : undefined;
    if (from) out.paths[lower(r.from)] = { entryId: r.entryId!, site: from.site };
  }
  return out;
}

/**
 * The part of `plan` that importing with `existing` brings: every new post, and with `update` the posts already in the
 * project too (but one whose text could not be read). Skipping them leaves out the pictures, categories, tags and
 * missing pictures only they would have brought. A plan with no post already here is returned as it is.
 */
export function selectPlan(plan: PostImportPlan, existing: ExistingPosts): PostImportPlan {
  if (!plan.posts.some((p) => p.existing)) return plan;
  const posts = plan.posts.filter((p) => !p.existing || (existing === 'update' && !p.existing.unread));
  const keys = new Set(posts.map((p) => p.key));
  const used = new Set<string>();
  for (const p of posts) {
    if (p.featured) used.add(p.featured);
    for (const b of p.body) if (isImageBlock(b)) used.add(b.assetId);
  }
  let { taxonomies, newTerms, newTermIds } = plan;
  if (taxonomies && plan.posts.some((p) => !keys.has(p.key))) {
    const assigned = new Set(posts.flatMap((p) => Object.entries(p.terms).flatMap(([tax, ids]) => (ids ?? []).map((id) => `${tax}:${id}`))));
    const kept = structuredClone(taxonomies);
    newTerms = { categories: [], tags: [] };
    newTermIds = { categories: [], tags: [] };
    for (const tax of Object.keys(TAXONOMIES) as TaxonomyId[]) {
      plan.newTermIds[tax].forEach((id, i) => {
        if (assigned.has(`${tax}:${id}`)) {
          newTerms[tax].push(plan.newTerms[tax][i]);
          newTermIds[tax].push(id);
        } else if (kept[tax]) delete kept[tax].terms[id];
      });
    }
    const added = plan.addedTaxonomies.filter((tax) => kept[tax] && Object.keys(kept[tax].terms).length);
    for (const tax of plan.addedTaxonomies) if (!added.includes(tax)) delete kept[tax];
    taxonomies = plan.collection.create || added.length || newTerms.categories.length || newTerms.tags.length ? kept : null;
  }
  return {
    ...plan,
    taxonomies,
    newTerms,
    newTermIds,
    posts,
    media: plan.media.filter((m) => used.has(m.key)),
    missing: plan.missing.filter((m) => m.key === undefined || keys.has(m.key)),
    problems: existing === 'update' ? [...plan.problems, ...plan.updateProblems] : [...plan.problems],
    updateProblems: []
  };
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
  const taken = new Map(owners.map((o) => [lower(o.route), o]));
  // A new Posts collection has an archive at its address; an existing one, only when it says so.
  const archived = !existing || hasArchivePages(existing.settings);
  // Imported posts keep their old permalinks working, which needs pages of their own to send visitors to.
  if (existing && !hasDetailPages(existing.settings)) problems.push(`The ${name} collection has no entry pages, so the posts would have no addresses. Turn its entry pages on, then import again.`);
  if (!existing) {
    const holder = taken.get(lower(route))?.label ?? owners.find((o) => underArchiveFolder(route, o.route))?.label ?? archiveRouteOwner(state, route)?.label;
    if (holder) problems.push(`The posts would go to ${route}, which is the address of ${holder}. Move that first, then import again.`);
    if (Object.keys(state.collections).length >= 20) problems.push('The project already has as many collections as it can, and it has no Posts collection to import into.');
  }

  // Categories and tags: the collection's own, then any the posts bring.
  const taxonomies: Record<string, CollectionTaxonomy> = structuredClone(existing?.settings.taxonomies ?? {});
  const already = alreadyImported(state, source, route);
  const skipped = [...source.skipped];
  const addedTaxonomies: TaxonomyId[] = [];
  let taxChanged = !existing;
  // Room for a grouping goes to one the new posts bring before one only a post already here would.
  const wants = (id: TaxonomyId, fresh: boolean) => source.posts.some((p) => already.has(p.key) !== fresh && (id === 'categories' ? p.categories : p.tags).length);
  const grouping = (Object.keys(TAXONOMIES) as TaxonomyId[]).sort((a, b) => (already.size ? Number(!wants(a, true)) - Number(!wants(b, true)) : 0));
  for (const id of grouping) {
    const wanted = wants(id, true) || wants(id, false);
    if (!Object.hasOwn(taxonomies, id) && (wanted || !existing)) {
      if (Object.keys(taxonomies).length >= MAX_TAXONOMIES) {
        if (wanted) skipped.push(`The posts’ ${id}: the ${name} collection has as many groupings as it can, so it has no room for ${TAXONOMIES[id]}.`);
        continue;
      }
      taxonomies[id] = { label: TAXONOMIES[id], terms: {} };
      if (existing) addedTaxonomies.push(id);
      taxChanged = true;
    }
  }
  const newTerms: Record<TaxonomyId, string[]> = { categories: [], tags: [] };
  const newTermIds: Record<TaxonomyId, string[]> = { categories: [], tags: [] };
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
    newTermIds[tax].push(id);
    taxChanged = true;
    return id;
  };

  const media = new Map(source.media.map((m) => [m.key, m]));
  const used = new Set<string>();
  const missing: PostImportPlan['missing'] = [];
  const entryIds = new Map<string, string>();
  const ids = new Set<string>();
  for (const p of source.posts) {
    const e = already.get(p.key);
    if (e) {
      entryIds.set(p.key, e.id);
      continue;
    }
    let id = newId('en', 10);
    while (ids.has(id) || findEntry(state, id)) id = newId('en', 10);
    ids.add(id);
    entryIds.set(p.key, id);
  }

  // Every post's address first, so an old address is never one a later post takes.
  const planned = new Map<string, string>();
  const slugs = source.posts.map((p) => {
    const e = already.get(p.key);
    if (e) return { slug: e.slug, wanted: undefined };
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
  for (const p of source.posts) if (p.oldPath && !p.draft && !already.has(p.key)) oldClaims.set(lower(p.oldPath), (oldClaims.get(lower(p.oldPath)) ?? 0) + 1);

  const byKey = new Map(source.posts.map((p) => [p.key, p]));
  // Every post's text first: one cut to fit arrives as a draft, which the posts linking to it are told. The imported
  // posts each one links to, as its text was read, are kept for that.
  const texts = source.posts.map((p) => {
    const notes: string[] = [];
    const links = p.body.flatMap((b) => spanRuns(b).flat()).flatMap((s) => (s.link?.type === 'entry' ? [s.link.target] : []));
    // The imported posts it links to, by key, and the entries already in the project it links to (read so).
    const linked = new Set(links.flatMap((t) => (t.startsWith(POST_LINK_PREFIX) ? [t.slice(POST_LINK_PREFIX.length)] : [])));
    const linkedEntries = new Set(links.filter((t) => !t.startsWith(POST_LINK_PREFIX)));
    const planned = { ...planBody(p, media, missing, entryIds, notes), notes, linked, linkedEntries };
    if (opts.consume) (p as { body: RichText }).body = [];
    return planned;
  });
  // A post already here is as the project has it, which it stays when it is skipped.
  const arrivesDraft = new Map(source.posts.map((p, i) => [p.key, already.has(p.key) ? !!already.get(p.key)!.draft : p.draft || texts[i].cut]));
  // A post already here, published, that updating makes a draft: the source has it as one, or its text was cut.
  const updateDrafts = new Set(source.posts.flatMap((p, i) => (already.has(p.key) && !already.get(p.key)!.draft && !p.unread && (p.draft || texts[i].cut) ? [p.key] : [])));
  // Every post's categories and tags, those of the posts that are new first: room for a term goes to them before any
  // brought only by updating a post already here, which alone never stops importing the new ones.
  const order = source.posts.map((_, i) => i).sort((a, b) => Number(already.has(source.posts[a].key)) - Number(already.has(source.posts[b].key)));
  const termsOf: Array<{ terms: PlannedPost['terms']; notes: string[] }> = [];
  const overNew: Record<TaxonomyId, number> = { categories: 0, tags: 0 };
  for (const i of order) {
    const p = source.posts[i];
    const e = already.get(p.key);
    const notes: string[] = [];
    const terms: PlannedPost['terms'] = {};
    for (const tax of Object.keys(TAXONOMIES) as TaxonomyId[]) {
      const list = (tax === 'categories' ? p.categories : p.tags).map((t) => termId(tax, t)).filter((x): x is string => !!x);
      const unique = [...new Set(list)];
      if (unique.length > MAX_ASSIGNED) notes.push(`Only its first ${MAX_ASSIGNED} ${tax} were kept.`);
      if (unique.length) terms[tax] = unique.slice(0, MAX_ASSIGNED);
      // An update gives the post exactly the source's categories and tags, none where it has none.
      else if (e && taxonomies[tax]) terms[tax] = [];
    }
    termsOf[i] = { terms, notes };
    if (!e) for (const tax of Object.keys(TAXONOMIES) as TaxonomyId[]) overNew[tax] = over[tax].size;
  }
  const posts: PlannedPost[] = source.posts.map((p, i) => {
    const notes = [...p.notes];
    // A published post linking to one that arrives as a draft: the website can't be exported until one of them changes.
    if (!arrivesDraft.get(p.key)) {
      for (const key of texts[i].linked) {
        const target = byKey.get(key);
        if (!target) continue;
        if (arrivesDraft.get(key)) notes.push(`It links to “${clip(target.title, 200).text}”, which ${already.has(key) ? 'is a draft' : 'arrives as a draft'}: publish that post, or change the link, before the website is exported.`);
        else if (updateDrafts.has(key)) notes.push(`It links to “${clip(target.title, 200).text}”, which updating the posts already here makes a draft: publish that post, or change the link, before the website is exported.`);
      }
      for (const id of texts[i].linkedEntries) {
        const e = findEntry(state, id)?.entry;
        if (e?.draft) notes.push(`It links to “${clip(e.title, 200).text}”, which is a draft: publish that post, or change the link, before the website is exported.`);
      }
    }
    const { slug, wanted } = slugs[i];
    const entryRoute = `${route}${slug}/`;
    const was = already.get(p.key);
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
    // Text that had to be cut is never published unread: the author checks it first. A post already here stays a draft.
    const draft = !!was?.draft || p.draft || cut;
    const draftReason = p.draftReason ?? (cut && !p.draft ? 'its text was longer than a post holds, so it was cut' : undefined);
    if ([...p.categories, ...p.tags].some((t) => t.label.trim().length > 80)) notes.push('A category or tag name was shortened to 80 characters.');
    const linksEntries = body.some((b) => spanRuns(b).some((run) => run.some((s) => s.link?.type === 'entry')));
    let featured: string | undefined;
    // A featured picture the export does not include leaves the one a post already here has.
    let keepFeatured = !!p.featuredLost;
    if (p.featured) {
      const m = media.get(p.featured);
      if (m?.path) {
        featured = m.key;
        used.add(m.key);
      } else {
        missing.push({ post: p.title, key: p.key, ref: m?.ref ?? p.featured, problem: m?.problem ?? 'it was not found' });
        notes.push(`Its featured picture (${m?.ref ?? p.featured}) was left out: ${m?.problem ?? 'it was not found'}.`);
        keepFeatured = true;
      }
    }
    const { terms } = termsOf[i];
    notes.push(...termsOf[i].notes);
    if (was && p.unread) notes.push('Its text could not be read this time, so updating leaves the post already here as it is.');
    let redirectFrom: string | undefined;
    let lostAddress: string | undefined;
    // A post already here keeps its own address and old addresses.
    if (!was && p.oldPath && lower(p.oldPath) !== lower(entryRoute)) {
      const from = p.oldPath;
      const why = draft
        ? null
        : from === '/' || validateRoute(from)
          ? `${validateRoute(from) ?? 'it is the Home page'}`
          : archived && lower(from) === lower(route)
            ? `it is the address of the ${name} collection`
            : taken.has(lower(from))
            ? heldBy(taken.get(lower(from))!)
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
      // A post already here keeps its own date when the source has none.
      date: p.date ?? (isArticleDate(was?.publishedAt) ? was.publishedAt : today),
      ...(p.date || isArticleDate(was?.publishedAt) ? {} : { dateAssigned: true }),
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
      ...(!was && p.postId && source.kind === 'wordpress' && source.siteKey ? { postId: p.postId } : {}),
      ...(was ? { existing: { draft: was.draft, ...(p.unread ? { unread: true as const } : {}) } } : {}),
      ...(keepFeatured ? { keepFeatured: true as const } : {}),
      notes
    };
  });
  const updateProblems: string[] = [];
  for (const tax of Object.keys(TAXONOMIES) as TaxonomyId[]) {
    if (!over[tax].size) continue;
    const n = Object.keys(taxonomies[tax]?.terms ?? {}).length + over[tax].size;
    (overNew[tax] ? problems : updateProblems).push(`The posts bring ${newTerms[tax].length + over[tax].size} new ${tax}, which would give the collection ${n}: it can have at most ${MAX_TERMS}.`);
  }
  if (!source.posts.length) problems.push(`${source.label} has no posts to import.`);
  const plan: PostImportPlan = {
    source: { kind: source.kind, label: source.label, ...(source.site ? { site: source.site } : {}), ...(source.siteKey ? { siteKey: source.siteKey } : {}) },
    collection: { id: POSTS_COLLECTION_ID, name, route, create: !existing },
    taxonomies: taxChanged ? taxonomies : null,
    termLabels: Object.fromEntries(Object.keys(TAXONOMIES).map((tax) => [tax, Object.fromEntries(Object.entries(taxonomies[tax]?.terms ?? {}).map(([id, v]) => [id, v.label]))])) as PostImportPlan['termLabels'],
    newTerms,
    newTermIds,
    addedTaxonomies,
    posts,
    media: source.media.filter((m) => used.has(m.key)),
    missing,
    skipped,
    problems,
    updateProblems
  };
  if (opts.check !== false) checkPlan(state, plan);
  return plan;
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

/**
 * A post's text as the entry keeps it: pictures that were not found left out (and named), links to other imported
 * posts pointed at their entries, descriptions and captions kept within their limits, and the whole within what an
 * entry's text holds.
 */
function planBody(p: SourcePost, media: Map<string, SourceMedia>, missing: PostImportPlan['missing'], entryIds: Map<string, string>, notes: string[]): { blocks: RichText; cut: boolean } {
  const relink = (spans: RichSpan[]): RichSpan[] =>
    spans.map((s) => {
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
        missing.push({ post: p.title, key: p.key, ref: m?.ref ?? b.assetId, problem: m?.problem ?? 'it was not found' });
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
 * import, once they all exist. `assetIds` maps each picture's key to its library image; one missing is left out.
 * With `addToNavigation`, a blog the import makes asks for its link in the header menu, as the starter card's does.
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
    if (p.existing) continue;
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
      ...(p.redirectFrom ? { redirectFrom: p.redirectFrom } : {}),
      ...(p.postId && plan.source.siteKey ? { imported: { site: plan.source.siteKey, postId: p.postId } } : {})
    } as EditOperation);
  }
  for (const p of plan.posts) {
    if (p.existing) {
      // A post already here takes the source's details over its own, once every new entry it may link to exists. Its
      // address, old addresses, search settings and own fields stay; it never becomes published by it.
      const featured = p.featured ? assetIds.get(p.featured) : undefined;
      ops.push({
        type: 'entry.update',
        collectionId: c.id,
        entryId: p.entryId,
        title: p.title,
        ...(p.dateAssigned ? {} : { publishedAt: p.date }),
        ...(p.draft && !p.existing.draft ? { draft: true } : {}),
        author: p.author ?? null,
        excerpt: p.excerpt ?? null,
        ...(featured ? { featuredImage: featured } : p.featured || p.keepFeatured ? {} : { featuredImage: null }),
        terms: p.terms,
        body: body(p)
      } as EditOperation);
    } else if (p.linksEntries) ops.push({ type: 'entry.update', collectionId: c.id, entryId: p.entryId, body: body(p) } as EditOperation);
  }
  return ops;
}
