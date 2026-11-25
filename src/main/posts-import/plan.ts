/**
 * Plans an import of posts into the open project: where each post goes (its slug, numbered when its address is
 * taken), the categories and tags it brings, which old addresses keep working, and which pictures it shows. The
 * plan is shown to the author before anything changes, and turns into one batch of operations: one change in the
 * project's history, undone in one step.
 */
import type { AssetRecord, CollectionTaxonomy, LinkValue, ProjectState, RichBlock, RichSpan, RichText } from '@shared/types';
import { validateOperation, type EditOperation } from '@shared/ops';
import { POSTS_COLLECTION_ID, archiveRouteOwner, findEntry, hasDetailPages, isTermId, routeOwners, underArchiveFolder } from '@shared/collections';
import { todayArticleDate } from '@shared/articles';
import { addressSlug, numberedSlug, slugify, validateRoute, validateSegment } from '@shared/routes';
import { cleanBlocks, isImageBlock, isListBlock, spanRuns } from '@shared/richtext';
import { newId } from '@shared/ids';
import { TEXT_LIMITS } from '@shared/text-limits';
import { applyOperations } from '@engine/apply';
import { MAX_CAPTION, MAX_ENTRY_BLOCKS, MAX_ENTRY_CHARS } from '@engine/values';
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

/** Plans `source` into `state`'s Posts collection (made when the project has none). Never changes `state`. */
export function planPostImport(state: ProjectState, source: ParsedSource, today = todayArticleDate()): PostImportPlan {
  const problems: string[] = [];
  const existing = Object.hasOwn(state.collections, POSTS_COLLECTION_ID) ? state.collections[POSTS_COLLECTION_ID] : undefined;
  const route = existing?.settings.route ?? PRESET_ROUTE;
  const name = existing?.settings.name ?? 'Posts';
  const owners = routeOwners(state);
  const taken = new Map(owners.map((o) => [lower(o.route), o.label]));
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
  // Every post's text first: one cut to fit arrives as a draft, which the posts linking to it are told.
  const texts = source.posts.map((p) => {
    const notes: string[] = [];
    return { ...planBody(p, media, missing, entryIds, notes), notes };
  });
  const arrivesDraft = new Map(source.posts.map((p, i) => [p.key, p.draft || texts[i].cut]));
  const posts: PlannedPost[] = source.posts.map((p, i) => {
    const notes = [...p.notes];
    // A published post linking to one that arrives as a draft: the website can't be exported until one of them changes.
    if (!arrivesDraft.get(p.key)) {
      const linked = new Set(p.body.flatMap((b) => spanRuns(b).flat()).flatMap((s) => (s.link?.type === 'entry' && s.link.target.startsWith(POST_LINK_PREFIX) ? [s.link.target.slice(POST_LINK_PREFIX.length)] : [])));
      for (const key of linked) {
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
    if (p.oldPath && lower(p.oldPath) !== lower(entryRoute)) {
      const from = p.oldPath;
      const why = draft
        ? null
        : from === '/' || validateRoute(from)
          ? `${validateRoute(from) ?? 'it is the Home page'}`
          : lower(from) === lower(route)
            ? `it is the address of the ${name} collection`
            : taken.has(lower(from))
            ? `it is the address of ${taken.get(lower(from))}`
            : planned.has(lower(from))
              ? 'another imported post has that address'
              : (oldClaims.get(lower(from)) ?? 0) > 1 || redirects.has(lower(from))
                ? 'another imported post had it too'
                : underArchiveFolder(route, from) || archiveRouteOwner(state, from)
                  ? 'it is kept for a collection’s archive pages'
                  : '';
      if (why === '') {
        redirectFrom = from;
        redirects.set(lower(from), p.key);
      } else if (why) notes.push(`Its old address (${from}) can’t keep working: ${why.replace(/\.$/, '')}.`);
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
      draft,
      ...(draftReason ? { draftReason } : {}),
      ...(author ? { author } : {}),
      ...(excerpt ? { excerpt: excerpt.text } : {}),
      terms,
      body,
      linksEntries,
      ...(featured ? { featured } : {}),
      ...(redirectFrom ? { redirectFrom } : {}),
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
    problems
  };
  if (!problems.length) {
    // What the engine would refuse, found now: every picture stands in for a library image.
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
      applyOperations(s, ops);
    } catch (e) {
      problems.push(`The posts can’t be imported: ${(e as Error).message.replace(/^Operation \d+ \([\w.]+\): /, '')}`);
    }
  }
  return plan;
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
 */
export function planOperations(plan: PostImportPlan, assetIds: Map<string, string>, assets: AssetRecord[] = []): EditOperation[] {
  const ops: EditOperation[] = assets.map((asset) => ({ type: 'asset.add', asset }) as EditOperation);
  const c = plan.collection;
  if (c.create) ops.push({ type: 'collection.create', collectionId: c.id, ...(plan.taxonomies ? { taxonomies: plan.taxonomies } : {}) } as EditOperation);
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
  return ops;
}
