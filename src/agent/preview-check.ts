import type { ChatCheck } from '@shared/api';
import { pageArticle } from '@shared/articles';
import { pageDirection, siteDirection } from '@shared/languages';
import type { EditOperation, OperationType } from '@shared/ops';
import { scopeForWidth } from '@shared/styles';
import type { ProjectState } from '@shared/types';
import { allTrees, placementCounts } from '@engine/tree';
import { named } from './completeness';
import type { Viewport } from './report';

/**
 * The preview check a changed run passes before it may finish (#742). The application, not the model, measures the
 * pages the run changed in the live preview, and sends what the run broke back to the model. Only problems the run
 * brought in count, so each page is also measured as it was before the run first reached it.
 */

/** Most pages a change every page shows is checked on besides the pages the run changed; the card says the rest were not. */
export const MAX_SAMPLED_PAGES = 4;

/**
 * How many page checks run at once. Each loads its page in its own frame, so loads and the preview server's work
 * overlap; past a few they only compete for the editor's and the server's time.
 */
export const MEASURE_AT_ONCE = 3;

/** A gate that lets at most `limit` pieces of work run at once, the rest starting in the order they asked. */
export function slots(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  let free = Math.max(1, limit);
  const waiting: Array<() => void> = [];
  return async (work) => {
    if (free > 0) free--;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else free++;
    }
  };
}

/** `work` on each item, at most `limit` at a time, started in order; the results in the items' order. */
export async function inTurns<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}

const WIDTH_ORDER: Viewport[] = ['phone', 'tablet', 'desktop'];

/**
 * What each operation can change of what a page shows:
 * - none: nothing a page shows (search and sharing details, settings, redirects, names in the editor, the order of
 *   lists in the editor, definitions not placed yet).
 * - owner: the page that owns the node it edits; the shared header or footer, or a placed component's design, reaches
 *   every page, and a collection's layout its posts.
 * - shared: what every page can show (site styles, the theme, a placed component's contract or code, the pages themselves).
 * - lists: what post feeds on pages show: their entries, terms and settings. Earlier page checks stop vouching for the
 *   pages, but nothing is measured for it.
 * - fields: depends on which fields it sets (see fieldsReach).
 * Typed over every operation, so a new operation does not compile until it is classified here.
 */
type Look = 'none' | 'owner' | 'shared' | 'lists' | 'fields';

const LOOK: Record<OperationType, Look> = {
  'page.create': 'fields',
  'page.update': 'fields',
  'page.duplicate': 'fields',
  'page.reorder': 'none',
  // Navigation and page lists elsewhere lose the page, or change where Home's links lead.
  'page.remove': 'shared',
  'page.setHome': 'shared',
  'redirect.add': 'none',
  'redirect.update': 'none',
  'redirect.remove': 'none',
  'node.insert': 'owner',
  'node.remove': 'owner',
  'node.removeKeepContent': 'owner',
  'node.move': 'owner',
  'node.wrap': 'owner',
  'node.unwrap': 'owner',
  'node.duplicate': 'owner',
  'node.copy': 'owner',
  'node.paste': 'owner',
  'node.rename': 'none',
  'node.setStyle': 'owner',
  'node.resetStyles': 'owner',
  'node.setContent': 'owner',
  'node.setBinding': 'owner',
  'node.setStateAction': 'owner',
  'instance.setProp': 'owner',
  'instance.setListSource': 'owner',
  'node.setRepeatSource': 'owner',
  'instance.listInsert': 'owner',
  'instance.listRemove': 'owner',
  'instance.listMove': 'owner',
  'instance.editTable': 'owner',
  'instance.setVariant': 'owner',
  'instance.swapComponent': 'owner',
  'token.set': 'shared',
  'token.setColorScheme': 'shared',
  'token.create': 'shared',
  'token.rename': 'none',
  'token.remove': 'shared',
  'token.replace': 'shared',
  'site.update': 'fields',
  'brief.update': 'none',
  'component.create': 'none',
  'component.upsert': 'shared',
  'component.createFromNode': 'owner',
  'component.makeUnique': 'owner',
  'component.detachInstance': 'owner',
  'component.duplicate': 'none',
  'component.rename': 'none',
  'component.setInsertAs': 'none',
  'component.fork': 'none',
  'component.convertToCode': 'owner',
  'component.createCode': 'none',
  'component.updateSource': 'shared',
  'component.remove': 'none',
  'component.import': 'none',
  'component.setPropSchema': 'shared',
  'component.removePropSchema': 'shared',
  'component.orderProperties': 'none',
  'component.setPropDefault': 'shared',
  'component.setPart': 'shared',
  'component.removePart': 'shared',
  'component.setVariant': 'shared',
  'component.removeVariant': 'shared',
  'component.setSlot': 'shared',
  'component.removeSlot': 'shared',
  // The design's container becomes a slot and every placement gets its children, or loses them.
  'component.containerToSlot': 'shared',
  'component.setState': 'shared',
  'component.removeState': 'shared',
  'theme.apply': 'shared',
  'theme.refresh': 'shared',
  'asset.add': 'none',
  'asset.update': 'fields',
  'asset.remove': 'none',
  'asset.replace': 'shared',
  'asset.relink': 'none',
  'collection.create': 'none',
  'collection.update': 'lists',
  'collection.remove': 'lists',
  'collection.createTerm': 'lists',
  'collection.renameTerm': 'lists',
  'collection.removeTerm': 'lists',
  'entry.create': 'lists',
  'entry.update': 'lists',
  'entry.reorder': 'lists',
  'entry.remove': 'lists',
  // A source's settings change nothing a page shows until a sync writes its entries.
  'source.upsert': 'none',
  'source.remove': 'none'
};

/** page.update fields only search engines, sharing previews and the editor read; a language counts once it turns the text. */
const PAGE_METADATA = new Set(['type', 'pageId', 'seoTitle', 'noindex', 'searchHidden', 'canonical', 'updatedAt', 'structuredData', 'linkTranslationTo', 'language']);
/** page.update fields page lists elsewhere show when a card follows the page (see page-teasers.ts). */
const PAGE_LISTED = new Set(['description', 'socialImage']);
/** page.update fields other pages show too: navigation, links to the page and News lists. */
const PAGE_ELSEWHERE = new Set(['title', 'route', 'navLabel', 'articleDate', 'byline', 'excerpt', 'article', 'newsHidden']);
/** site.update fields every page shows: the site's name, what the site says itself (a language counts once it turns the text) and its own CSS. */
const SITE_SHOWN = new Set(['name', 'visitorText', 'globalCss']);
/** site.update fields of the page shown at an address the site does not have, which no page check reaches. */
const NOT_FOUND = new Set(['notFoundHeading', 'notFoundMessage', 'notFoundLinkLabel']);

/** What a page check cannot measure: a collection's posts, and the not-found page. */
export type Unreachable = 'posts' | 'not-found';

/** What one batch changes of what pages show. */
export interface Reach {
  /** Pages whose own content, styles or settings it changed, including pages it created. */
  pages: Set<string>;
  /** Whether it changed something every page can show: the header or footer, site styles, the theme, a placed component. */
  shared: boolean;
  /** Whether it changed what page lists and post feeds show, on whichever pages have them. */
  lists: boolean;
  /** Whether it set or reset styles for phone screens that show somewhere. */
  phone: boolean;
  /** Placed components whose design, contract or code it changed: where they are placed is where that shows. */
  components: Set<string>;
  /** What it changed that no page check can measure. */
  unreachable: Set<Unreachable>;
}

/** Whether a style change is for phone screens: a scope, or a style map keyed by size ("phone", "phone:hover"). */
function phoneStyles(v: unknown, depth = 0): boolean {
  if (!v || typeof v !== 'object' || depth > 16) return false;
  if (Array.isArray(v)) return v.some((x) => phoneStyles(x, depth + 1));
  for (const [k, x] of Object.entries(v)) {
    if (k === 'phone' || k.startsWith('phone:') || (k === 'scope' && x === 'phone')) return true;
    if (phoneStyles(x, depth + 1)) return true;
  }
  return false;
}

/** A reset without a size resets every size, phone included. */
const isPhoneScoped = (op: EditOperation) =>
  op.type === 'node.setStyle'
    ? op.scope === 'phone'
    : op.type === 'node.resetStyles'
      ? op.scope === 'phone' || op.scope === undefined
      : op.type.startsWith('component.') && LOOK[op.type] !== 'none' && phoneStyles(op);

/**
 * What a batch changes of what pages show, judged against `before`, the project it applies to. With `after`, the
 * state it led to, pages it created count as changed and pages it removed do not.
 */
export function visibleReach(ops: EditOperation[], before: ProjectState, after?: ProjectState): Reach {
  const reach: Reach = { pages: new Set(), shared: false, lists: false, phone: false, components: new Set(), unreachable: new Set() };
  const article = (pageId: string) => !!pageArticle(Object.hasOwn(before.pages, pageId) ? before.pages[pageId] : undefined);
  // A component placed nowhere shows on no page yet: building one costs nothing until it is placed, which is a page edit.
  // Code can be imported by other code rather than placed, so a code component always counts.
  let counts: Record<string, number> | undefined;
  const placed = (definitionId: string) => before.components[definitionId]?.kind === 'code' || ((counts ??= placementCounts(before))[definitionId] ?? 0) > 0;
  for (const op of ops) {
    // Phone styles count wherever they are written: a component styled for phones may be placed later in the run.
    if (isPhoneScoped(op)) reach.phone = true;
    switch (LOOK[op.type] ?? 'shared') {
      case 'none':
        break;
      case 'lists':
        reach.lists = true;
        break;
      case 'shared': {
        // A rebuild without a definition makes a new component; one with a definition reaches its placements.
        const definitionId = 'definitionId' in op ? op.definitionId : undefined;
        if (op.type === 'component.upsert' && definitionId === undefined) break;
        if (typeof definitionId === 'string' && op.type.startsWith('component.')) {
          if (!placed(definitionId)) break;
          reach.components.add(definitionId);
        }
        reach.shared = true;
        break;
      }
      case 'owner': {
        const owner = op.type === 'node.copy' || op.type === 'node.paste' ? op.toOwner : 'owner' in op ? op.owner : undefined;
        if (owner?.kind === 'page') reach.pages.add(owner.id);
        // A collection's entry or index layout shows on no page the preview check measures: it says so, unmeasured.
        else if (owner?.kind === 'template' || owner?.kind === 'archive') reach.unreachable.add('posts');
        else if (owner?.kind !== 'component' || placed(owner.id)) {
          if (owner?.kind === 'component') reach.components.add(owner.id);
          reach.shared = true;
        }
        break;
      }
      case 'fields':
        fieldsReach(op, reach, before, article);
        break;
    }
  }
  if (after) {
    for (const id of Object.keys(after.pages)) if (!Object.hasOwn(before.pages, id)) reach.pages.add(id);
    for (const id of reach.pages) if (!Object.hasOwn(after.pages, id)) reach.pages.delete(id);
  }
  return reach;
}

function fieldsReach(op: EditOperation, reach: Reach, before: ProjectState, article: (pageId: string) => boolean) {
  const set = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k]) => k);
  if (op.type === 'page.create') {
    // The page itself is found from the state it led to; a linked or dated page also shows on the others.
    if (op.addToNavigation || op.starter === 'article' || op.articleDate !== undefined) reach.shared = true;
  } else if (op.type === 'page.duplicate') {
    // A draft copy is listed nowhere.
    if (!op.draft && article(op.pageId)) reach.shared = true;
  } else if (op.type === 'page.update') {
    const page = Object.hasOwn(before.pages, op.pageId) ? before.pages[op.pageId] : undefined;
    // A field written with the value it has changes nothing: a search title sent with the page's own title is search only.
    const same = (k: string) => !!page && Object.hasOwn(page, k) && (page as unknown as Record<string, unknown>)[k] === (op as Record<string, unknown>)[k];
    // A language written the other way round turns the page's text and layout; another code (en-AU) changes no pixel.
    const turned = op.language !== undefined && !!page && pageDirection(before.site, page) !== pageDirection(before.site, { language: op.language });
    const fields = [...set(op).filter((k) => !PAGE_METADATA.has(k) && !same(k)), ...(turned ? ['language'] : [])];
    if (fields.some((k) => PAGE_LISTED.has(k))) reach.lists = true;
    const shown = fields.filter((k) => !PAGE_LISTED.has(k));
    if (!shown.length) return;
    reach.pages.add(op.pageId);
    if (shown.some((k) => PAGE_ELSEWHERE.has(k)) || (shown.includes('draft') && article(op.pageId))) reach.shared = true;
  } else if (op.type === 'site.update') {
    const direction = op.direction === undefined ? before.site.direction : op.direction === 'auto' ? undefined : op.direction;
    const turned = (op.language !== undefined || op.direction !== undefined) && siteDirection(before.site) !== siteDirection({ language: op.language ?? before.site.language, direction });
    if (turned || set(op).some((k) => SITE_SHOWN.has(k))) reach.shared = true;
    if (set(op).some((k) => NOT_FOUND.has(k))) reach.unreachable.add('not-found');
  } else if (op.type === 'asset.update') {
    // A font's files change how its text is drawn everywhere; a name or description shows in the editor only.
    if (op.font !== undefined) reach.shared = true;
  } else reach.shared = true;
}

/** "Phone number" is about contact details, not screens. */
const PHONE_REQUEST = /\b(?:(?:mobile|phone|cell ?phone|smart ?phone)s?(?!\s*(?:numbers?|no\b|calls?|lines?))|iphones?|android|small(?:er)? screens?)\b/i;
const TABLET_REQUEST = /\b(?:tablets?|ipads?)\b/i;
const DESKTOP_REQUEST = /\b(?:desktops?|laptops?|(?:large|larger|big|wide) screens?|widescreens?)\b/i;

/** The widths a request asks about by name: a mention of mobile or phones asks for phone width. */
export function requestedWidths(request: string): Set<Viewport> {
  const out = new Set<Viewport>();
  if (PHONE_REQUEST.test(request)) out.add('phone');
  if (TABLET_REQUEST.test(request)) out.add('tablet');
  if (DESKTOP_REQUEST.test(request)) out.add('desktop');
  return out;
}

/** The pages a request names, by title, the last part of the address, or the whole address, in site order. */
export function namedPages(state: ProjectState, request: string): string[] {
  return state.site.pageOrder.filter((id) => {
    const page = Object.hasOwn(state.pages, id) ? state.pages[id] : undefined;
    return !!page && (named(request, page) || (page.route !== '/' && request.includes(page.route)));
  });
}

/** What one measurement found that a run can bring in: overflow, failed images and script errors. */
export interface Findings {
  wide: boolean;
  documentWidth?: number;
  viewportWidth?: number;
  /** Overflow findings by what they are and where, with how many there are of each. */
  overflow: Map<string, { line: string; n: number }>;
  /** The preview lists at most so many findings: past that, one missing from the list may still be there. */
  saturated: boolean;
  /** The kinds of overflow found: the preview lists at least one of every kind there is, however long the list. */
  kinds: Set<string>;
  /** Failed images by file, with how many failed; `complete` when the report names every failed image. */
  files: Map<string, number>;
  complete: boolean;
  failed: number;
  /** Script errors by message, with how many times each was reported. */
  errors: Map<string, number>;
}

const OVERFLOW_KINDS = new Set(['horizontal-overflow', 'element-overflow', 'text-overflow']);
/** How many findings the preview lists, all kinds together (MAX_ISSUES in bridge.client.js). */
const LISTED_ISSUES = 40;
/** How much of a script error the model is shown. */
const ERROR_CHARS = 300;

interface RawReport {
  documentWidth?: unknown;
  viewportWidth?: unknown;
  issues?: Array<{ kind?: unknown; message?: unknown; ref?: unknown }>;
  omittedIssues?: unknown;
  images?: { failed?: unknown; failedFiles?: unknown };
  runtimeErrors?: unknown;
}

/** Where a finding is, as operations address it (see attributeFindings), without how it was matched. */
function place(ref: unknown): string {
  if (!ref || typeof ref !== 'object') return '';
  const { match: _match, ...at } = ref as Record<string, unknown>;
  return JSON.stringify(at);
}

const count = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);

export function findingsOf(report: unknown): Findings {
  const r = (report && typeof report === 'object' ? report : {}) as RawReport;
  const documentWidth = typeof r.documentWidth === 'number' ? r.documentWidth : undefined;
  const viewportWidth = typeof r.viewportWidth === 'number' ? r.viewportWidth : undefined;
  const issues = Array.isArray(r.issues) ? r.issues.filter((i) => i && typeof i === 'object') : [];
  const overflow = new Map<string, { line: string; n: number }>();
  for (const i of issues) {
    if (typeof i.kind !== 'string' || !OVERFLOW_KINDS.has(i.kind)) continue;
    const at = place(i.ref);
    const message = typeof i.message === 'string' ? i.message.trim() : i.kind;
    const key = `${i.kind}|${at || message}`;
    const seen = overflow.get(key);
    if (seen) seen.n++;
    else overflow.set(key, { line: `${message}${at ? ` (at ${at})` : ''}`, n: 1 });
  }
  const saturated = issues.length >= LISTED_ISSUES || (typeof r.omittedIssues === 'number' && r.omittedIssues > 0);
  const wide = (documentWidth !== undefined && viewportWidth !== undefined && documentWidth > viewportWidth + 1) || issues.some((i) => i.kind === 'horizontal-overflow');
  const files = new Map<string, number>();
  const named = Array.isArray(r.images?.failedFiles) ? (r.images!.failedFiles as unknown[]).filter((f): f is string => typeof f === 'string') : [];
  for (const f of named) count(files, f);
  const failed = typeof r.images?.failed === 'number' ? r.images.failed : issues.filter((i) => i.kind === 'broken-image').length;
  const errors = new Map<string, number>();
  if (Array.isArray(r.runtimeErrors)) for (const e of r.runtimeErrors.map((x) => String(x).trim()).filter(Boolean)) count(errors, e);
  const kinds = new Set(issues.map((i) => i.kind).filter((k): k is string => typeof k === 'string' && OVERFLOW_KINDS.has(k)));
  return { wide, documentWidth, viewportWidth, overflow, saturated, kinds, files, complete: named.length === failed, failed, errors };
}

/**
 * What `after` found that `before` did not, each said so the model can find and fix it; `before` null: nothing was
 * there. Where the reports cannot tell (a full list of findings, images not all named), only counts are compared,
 * so a problem the page already had is never sent back as the run's.
 */
export function introducedProblems(before: Findings | null, after: Findings): string[] {
  const out: string[] = [];
  if (after.wide && !before?.wide)
    out.push(after.documentWidth !== undefined && after.viewportWidth !== undefined ? `The page is ${after.documentWidth}px wide on a ${after.viewportWidth}px screen.` : 'The page is wider than the screen.');
  // Script errors and images before element overflow, so a long list of overflow never hides them.
  for (const [e, n] of after.errors) if (n > (before?.errors.get(e) ?? 0)) out.push(`A script failed: ${e.length > ERROR_CHARS ? `${e.slice(0, ERROR_CHARS - 1)}…` : e}`);
  if (after.complete && (!before || before.complete)) {
    for (const [file, n] of after.files) if (n > (before?.files.get(file) ?? 0)) out.push(`The image ${file} failed to load.`);
  } else if (after.failed > (before?.failed ?? 0)) {
    const more = after.failed - (before?.failed ?? 0);
    out.push(more === 1 ? 'Another image failed to load.' : `${more} more images failed to load.`);
  }
  // A full list can leave out a finding the page already had, so only a kind it had none of counts as new then.
  for (const [key, { line, n }] of after.overflow) {
    if (after.wide && key.startsWith('horizontal-overflow|')) continue;
    const kind = key.slice(0, key.indexOf('|'));
    if (before?.saturated ? !before.kinds.has(kind) : n > (before?.overflow.get(key)?.n ?? 0)) out.push(line);
  }
  return out;
}

/**
 * The pages, in site order, that show any of these components: placed on them, or inside another component that is,
 * however deep. A component in the shared header or footer shows on every page, so Home stands for those.
 */
export function pagesShowing(state: ProjectState, definitionIds: Iterable<string>): string[] {
  const wanted = new Set(definitionIds);
  const pages = new Set<string>();
  let everywhere = false;
  const trees = allTrees(state);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of trees) {
      if (!Object.values(t.tree.nodes).some((n) => n.kind === 'instance' && wanted.has(n.definitionId))) continue;
      if (t.owner.kind === 'page') pages.add(t.owner.id);
      else if (t.owner.kind === 'shell') everywhere = true;
      else if (t.owner.kind === 'component' && !wanted.has(t.owner.id)) {
        wanted.add(t.owner.id);
        grew = true;
      }
    }
  }
  // Pages that place a component come first; Home stands for the header and footer only after them.
  const home = state.site.homePageId;
  return [...state.site.pageOrder.filter((id) => pages.has(id)), ...(everywhere && !pages.has(home) ? [home] : [])];
}

/** A page as it was before the run reached it: measured, empty (the run created it), or not known. */
type Baseline = { findings: Findings } | 'empty' | 'unknown';

/** One measurement of a page at a width: whether it ran, and the report as the preview gave it. */
export interface Measurement {
  ok: boolean;
  report?: unknown;
}

export interface CheckTarget {
  pageId: string;
  viewport: Viewport;
}

const keyOf = (pageId: string, viewport: string) => `${pageId}\n${viewport}`;
/** At most this many problems per page and width go to the model; the rest are counted. */
const PROBLEMS_SHOWN = 6;

/**
 * What one run needs for its preview check: what it changed, and each page as it was before the run first reached it.
 * A page measured only after the run already changed it (directly, or through something every page shows) cannot
 * tell what the run brought in, so its problems are reported but never sent back for repair.
 */
export class PreviewCheck {
  private baselines = new Map<string, Baseline>();
  /** Pages a landed change reached directly, in the order the run first changed them. */
  private edited: string[] = [];
  private shared = false;
  private phone = false;
  /** Placed components the run changed, whose placements show the change. */
  private components = new Set<string>();
  /** Pages sampled for a change every page shows, kept in the sample once picked: they were measured before it. */
  private sampledPages: string[] = [];
  private unreachable = new Set<Unreachable>();
  /** Pages and widths whose problems were sent back for repair: checked again until they are gone. */
  private flagged = new Map<string, CheckTarget>();
  private asked: Set<Viewport>;
  private fallback: Viewport;

  constructor(
    private start: ProjectState,
    private request: string,
    previewWidth?: number
  ) {
    this.asked = requestedWidths(request);
    this.fallback = typeof previewWidth === 'number' && Number.isFinite(previewWidth) && previewWidth > 0 ? scopeForWidth(previewWidth) : 'desktop';
  }

  /** Whether a landed change reached anything a page shows. */
  get changed() {
    return this.shared || this.edited.length > 0;
  }

  /** The widths this run's checks cover: those the request names, else the preview's, and phone once phone styles changed. */
  widths(phone = this.phone): Viewport[] {
    const out = new Set(this.asked);
    if (!out.size) out.add(this.fallback);
    if (phone) out.add('phone');
    return WIDTH_ORDER.filter((w) => out.has(w));
  }

  /**
   * Pages a change every page shows is checked on besides `edited`, the pages the run changed: those the request names,
   * then those a changed component is placed on, else Home.
   */
  private sampled(state: ProjectState, edited: string[], components: Set<string>): string[] {
    const names = namedPages(state, this.request);
    const out = [...new Set([...this.sampledPages, ...names, ...pagesShowing(state, components)])].filter((p) => !edited.includes(p) && Object.hasOwn(state.pages, p));
    if (!edited.length && !out.length) return Object.hasOwn(state.pages, state.site.homePageId) ? [state.site.homePageId] : [];
    return out.slice(0, MAX_SAMPLED_PAGES);
  }

  /**
   * Before a batch lands: measure, as it is now, each page and width the batch will reach that has no measurement
   * from before the run reached it. Phone width is measured too, so phone styles a later step adds have a page to
   * compare with. `seen` gives a measurement the run already has that no change has outdated.
   */
  async beforeApply(ops: EditOperation[], state: ProjectState, measure: (pageId: string, viewport: Viewport) => Promise<Measurement>, seen: (pageId: string, viewport: Viewport) => Measurement | undefined) {
    const reach = visibleReach(ops, state);
    const pages = new Set(reach.pages);
    // The pages the finish will sample, from what this batch changes: the ones it edits directly are checked anyway.
    if (reach.shared) for (const p of this.sampled(state, [...this.edited, ...reach.pages], new Set([...this.components, ...reach.components]))) pages.add(p);
    // Every page at the widths the run needs first, so a slow preview spends the time left on them; phone last.
    const needed = this.widths(this.phone || reach.phone);
    const order = [...needed, ...(needed.includes('phone') ? [] : (['phone'] as const))];
    const todo: CheckTarget[] = [];
    for (const [pageId, viewport] of order.flatMap((w) => [...pages].map((p) => [p, w] as const))) {
      if (!Object.hasOwn(state.pages, pageId)) continue;
      const key = keyOf(pageId, viewport);
      if (this.baselines.has(key)) continue;
      if (!Object.hasOwn(this.start.pages, pageId)) {
        this.baselines.set(key, 'empty');
        continue;
      }
      // The run has already changed what this page shows: a measurement now would count its changes as the page's own.
      if (this.shared || this.edited.includes(pageId)) {
        this.baselines.set(key, 'unknown');
        continue;
      }
      const prior = seen(pageId, viewport);
      if (prior?.ok) this.baselines.set(key, { findings: findingsOf(prior.report) });
      else todo.push({ pageId, viewport });
    }
    // Nothing has changed them yet, so the pages are measured together, in that order, a few at a time.
    const measured = await inTurns(todo, MEASURE_AT_ONCE, (t) => measure(t.pageId, t.viewport));
    todo.forEach((t, i) => this.baselines.set(keyOf(t.pageId, t.viewport), measured[i].ok ? { findings: findingsOf(measured[i].report) } : 'unknown'));
  }

  /**
   * The author saved an edit of their own while the run waited for an answer (#1281), taking the project from `before`
   * to `after`. A page it reaches that was measured before it no longer shows where the run started, so the run is never
   * held to what the author changed there: what it finds is said, not sent back for repair. The run still measures it
   * again before it finishes, as the caller makes every check of it stale.
   */
  authorSaved(ops: EditOperation[], before: ProjectState, after: ProjectState): Reach {
    const reach = visibleReach(ops, before, after);
    for (const key of this.baselines.keys()) if (reach.shared || reach.lists || reach.pages.has(key.slice(0, key.indexOf('\n')))) this.baselines.set(key, 'unknown');
    return reach;
  }

  /** A batch landed, taking the project from `before` to `after`. */
  landed(ops: EditOperation[], before: ProjectState, after: ProjectState): Reach {
    const reach = visibleReach(ops, before, after);
    // The pages sampled for it stay sampled, whatever the run changes next.
    if (reach.shared) for (const p of this.sampled(before, [...this.edited, ...reach.pages], new Set([...this.components, ...reach.components]))) if (!this.sampledPages.includes(p)) this.sampledPages.push(p);
    for (const p of reach.pages) if (!this.edited.includes(p)) this.edited.push(p);
    if (reach.shared) this.shared = true;
    if (reach.phone) this.phone = true;
    for (const d of reach.components) this.components.add(d);
    for (const u of reach.unreachable) this.unreachable.add(u);
    return reach;
  }

  /**
   * The pages and widths to measure before the run finishes, and card rows for what it changed but cannot measure:
   * every page it changed; for a change every page shows, also the pages the request names (else Home); and every
   * page and width whose problems went back for repair.
   */
  plan(state: ProjectState): { targets: CheckTarget[]; unchecked: ChatCheck[] } {
    const live = (id: string) => Object.hasOwn(state.pages, id);
    const edited = this.edited.filter(live);
    const pages = this.shared ? [...edited, ...this.sampled(state, edited, this.components)] : edited;
    const unchecked: ChatCheck[] = [];
    // A change every page shows is checked on a few of them; the rest are said to be unchecked.
    if (this.shared && state.site.pageOrder.some((id) => live(id) && !pages.includes(id))) unchecked.push({ status: 'unverified', text: "Didn't check the other pages that show the changes to what pages share in the preview." });
    if (this.unreachable.has('posts')) unchecked.push({ status: 'unverified', text: "Didn't check the posts that show the changed post layout in the preview." });
    if (this.unreachable.has('not-found')) unchecked.push({ status: 'unverified', text: "Didn't check the page shown for an address the site does not have in the preview." });
    const widths = this.widths();
    const targets = pages.flatMap((pageId) => widths.map((viewport) => ({ pageId, viewport })));
    for (const [key, t] of this.flagged) if (live(t.pageId) && !targets.some((x) => keyOf(x.pageId, x.viewport) === key)) targets.push(t);
    return { targets, unchecked };
  }

  /**
   * The problems the run brought in, from the latest measurement of each page and width, said for the model. A page
   * measured only after the run reached it, or a measurement that could not run, has none: its rows say what it found.
   */
  introduced(state: ProjectState, measured: Array<CheckTarget & { m: Measurement | undefined }>): Array<CheckTarget & { problems: string; card: string }> {
    const out: Array<CheckTarget & { problems: string; card: string }> = [];
    for (const { pageId, viewport, m } of measured) {
      const key = keyOf(pageId, viewport);
      if (!m?.ok) continue;
      const base: Baseline | undefined = Object.hasOwn(this.start.pages, pageId) ? this.baselines.get(key) : 'empty';
      if (!base || base === 'unknown') continue;
      const found = introducedProblems(base === 'empty' ? null : base.findings, findingsOf(m.report));
      if (!found.length) {
        this.flagged.delete(key);
        continue;
      }
      this.flagged.set(key, { pageId, viewport });
      const page = Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
      const where = `${page ? `${page.title} (page ${pageId})` : `Page ${pageId}`} at ${viewport} width`;
      const shown = found.slice(0, PROBLEMS_SHOWN);
      const more = found.length > shown.length ? ` And ${found.length - shown.length} more.` : '';
      // The card says the same for the author, without where each finding is in the project's terms.
      const plain = shown.map((f) => f.replace(/ \(at \{.*\}\)$/, '').replace(/([^.!?…])$/, '$1.'));
      out.push({ pageId, viewport, problems: `${where}: ${shown.join(' ')}${more}`, card: `At ${viewport} width on ${page?.title ?? 'a page'}: ${plain.join(' ')}${more}` });
    }
    return out;
  }

  /**
   * Card rows for pages and widths whose problems went back for repair and that could not be checked again after the
   * run's last change: what was found is not known to be fixed.
   */
  unresolved(state: ProjectState, measured: Array<CheckTarget & { m: Measurement | undefined }>): ChatCheck[] {
    return [...this.flagged.values()].flatMap((t) => {
      if (!Object.hasOwn(state.pages, t.pageId)) return [];
      const m = measured.find((x) => x.pageId === t.pageId && x.viewport === t.viewport)?.m;
      return m?.ok ? [] : [{ status: 'issue' as const, text: `Found problems at ${t.viewport} width on ${state.pages[t.pageId].title} that could not be checked again after the last change.` }];
    });
  }
}
