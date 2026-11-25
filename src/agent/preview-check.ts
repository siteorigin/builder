import type { ChatCheck } from '@shared/api';
import { pageArticle } from '@shared/articles';
import type { EditOperation, OperationType } from '@shared/ops';
import { scopeForWidth } from '@shared/styles';
import type { ProjectState } from '@shared/types';
import { named } from './completeness';
import { joinWords, type Viewport } from './report';

/**
 * The preview check a changed run passes before it may finish (#742). The application, not the model, measures the
 * pages the run changed in the live preview, and sends what the run broke back to the model. Only problems the run
 * brought in count, so each page is also measured as it was before the run first reached it.
 */

/** Most pages one run's check measures; the card names the changed pages left out. */
export const MAX_CHECKED_PAGES = 4;

const WIDTH_ORDER: Viewport[] = ['phone', 'tablet', 'desktop'];

/**
 * What each operation can change of what a page shows:
 * - none: nothing a page shows (search and sharing details, settings, redirects, names in the editor, the order of
 *   lists in the editor, definitions not placed yet, collections and posts, which no page check can reach).
 * - owner: the page that owns the node it edits; the shared header or footer, or a component's design, reaches every page.
 * - shared: what every page shows (site styles, the theme, a component's contract or code, the pages themselves).
 * - fields: depends on which fields it sets (see fieldsReach).
 * Typed over every operation, so a new operation does not compile until it is classified here.
 */
type Look = 'none' | 'owner' | 'shared' | 'fields';

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
  'collection.update': 'none',
  'collection.remove': 'none',
  'collection.createTerm': 'none',
  'collection.renameTerm': 'none',
  'collection.removeTerm': 'none',
  'entry.create': 'none',
  'entry.update': 'none',
  'entry.reorder': 'none',
  'entry.remove': 'none'
};

/** page.update fields only search engines, sharing previews and the editor read. */
const PAGE_METADATA = new Set(['type', 'pageId', 'seoTitle', 'description', 'noindex', 'searchHidden', 'socialImage', 'canonical', 'updatedAt', 'structuredData', 'linkTranslationTo']);
/** page.update fields other pages show too: navigation, links to the page and News lists. */
const PAGE_ELSEWHERE = new Set(['title', 'route', 'navLabel', 'articleDate', 'byline', 'excerpt', 'article', 'newsHidden']);
/** site.update fields every page shows: the site's name, its language and direction, and what the site says itself. */
const SITE_SHOWN = new Set(['name', 'language', 'direction', 'visitorText']);

/** What one batch changes of what pages show. */
export interface Reach {
  /** Pages whose own content, styles or settings it changed, including pages it created. */
  pages: Set<string>;
  /** Whether it changed something every page can show: the header or footer, site styles, the theme, a component. */
  shared: boolean;
  /** Whether it set or reset styles for phone screens. */
  phone: boolean;
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

const isPhoneScoped = (op: EditOperation) =>
  op.type === 'node.setStyle' || op.type === 'node.resetStyles' ? op.scope === 'phone' : op.type.startsWith('component.') && LOOK[op.type] !== 'none' && phoneStyles(op);

/**
 * What a batch changes of what pages show. With `after`, the state it led to, pages it created count as changed and
 * pages it removed do not.
 */
export function visibleReach(ops: EditOperation[], before: ProjectState, after?: ProjectState): Reach {
  const reach: Reach = { pages: new Set(), shared: false, phone: false };
  const article = (pageId: string) => !!pageArticle(Object.hasOwn(before.pages, pageId) ? before.pages[pageId] : undefined);
  for (const op of ops) {
    if (isPhoneScoped(op)) reach.phone = true;
    switch (LOOK[op.type] ?? 'shared') {
      case 'none':
        break;
      case 'shared':
        reach.shared = true;
        break;
      case 'owner': {
        const owner = op.type === 'node.copy' || op.type === 'node.paste' ? op.toOwner : 'owner' in op ? op.owner : undefined;
        if (owner?.kind === 'page') reach.pages.add(owner.id);
        // A collection's layout shows only on its posts, which no page check reaches.
        else if (owner?.kind !== 'template') reach.shared = true;
        break;
      }
      case 'fields':
        fieldsReach(op, reach, article);
        break;
    }
  }
  if (after) {
    for (const id of Object.keys(after.pages)) if (!Object.hasOwn(before.pages, id)) reach.pages.add(id);
    for (const id of reach.pages) if (!Object.hasOwn(after.pages, id)) reach.pages.delete(id);
  }
  return reach;
}

function fieldsReach(op: EditOperation, reach: Reach, article: (pageId: string) => boolean) {
  const set = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k]) => k);
  if (op.type === 'page.create') {
    // The page itself is found from the state it led to; a linked or dated page also shows on the others.
    if (op.addToNavigation || op.starter === 'article' || op.articleDate !== undefined) reach.shared = true;
  } else if (op.type === 'page.duplicate') {
    if (article(op.pageId)) reach.shared = true;
  } else if (op.type === 'page.update') {
    const fields = set(op).filter((k) => !PAGE_METADATA.has(k));
    if (!fields.length) return;
    reach.pages.add(op.pageId);
    if (fields.some((k) => PAGE_ELSEWHERE.has(k)) || (fields.includes('draft') && article(op.pageId))) reach.shared = true;
  } else if (op.type === 'site.update') {
    if (set(op).some((k) => SITE_SHOWN.has(k))) reach.shared = true;
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
interface Findings {
  wide: boolean;
  documentWidth?: number;
  viewportWidth?: number;
  /** Overflow findings by what they are and where. */
  overflow: Map<string, string>;
  /** Failed images by file, with how many times each failed; `failed` when the report names no files. */
  images: Map<string, number>;
  failed: number;
  errors: Set<string>;
}

const OVERFLOW_KINDS = new Set(['horizontal-overflow', 'element-overflow', 'text-overflow']);
/** Script errors are compared as the model is shown them: a long message is cut there. */
const ERROR_CHARS = 300;

interface RawReport {
  documentWidth?: unknown;
  viewportWidth?: unknown;
  issues?: Array<{ kind?: unknown; message?: unknown; ref?: unknown }>;
  images?: { failed?: unknown; failedFiles?: unknown };
  runtimeErrors?: unknown;
}

/** Where a finding is, as operations address it (see attributeFindings), without how it was matched. */
function place(ref: unknown): string {
  if (!ref || typeof ref !== 'object') return '';
  const { match: _match, ...at } = ref as Record<string, unknown>;
  return JSON.stringify(at);
}

export function findingsOf(report: unknown): Findings {
  const r = (report && typeof report === 'object' ? report : {}) as RawReport;
  const documentWidth = typeof r.documentWidth === 'number' ? r.documentWidth : undefined;
  const viewportWidth = typeof r.viewportWidth === 'number' ? r.viewportWidth : undefined;
  const issues = Array.isArray(r.issues) ? r.issues.filter((i) => i && typeof i === 'object') : [];
  const overflow = new Map<string, string>();
  for (const i of issues) {
    if (typeof i.kind !== 'string' || !OVERFLOW_KINDS.has(i.kind)) continue;
    const at = place(i.ref);
    const message = typeof i.message === 'string' ? i.message.trim() : i.kind;
    overflow.set(`${i.kind}|${at || message}`, `${message}${at ? ` (at ${at})` : ''}`);
  }
  const wide = (documentWidth !== undefined && viewportWidth !== undefined && documentWidth > viewportWidth + 1) || issues.some((i) => i.kind === 'horizontal-overflow');
  const images = new Map<string, number>();
  const files = Array.isArray(r.images?.failedFiles) ? (r.images!.failedFiles as unknown[]).filter((f): f is string => typeof f === 'string') : [];
  for (const f of files) images.set(f, (images.get(f) ?? 0) + 1);
  const failed = typeof r.images?.failed === 'number' ? r.images.failed : issues.filter((i) => i.kind === 'broken-image').length;
  const errors = new Set(Array.isArray(r.runtimeErrors) ? r.runtimeErrors.map((e) => String(e).trim().slice(0, ERROR_CHARS)).filter(Boolean) : []);
  return { wide, documentWidth, viewportWidth, overflow, images, failed, errors };
}

/** What `after` found that `before` did not, each said so the model can find and fix it; `before` null: nothing was there. */
export function introducedProblems(before: Findings | null, after: Findings): string[] {
  const out: string[] = [];
  if (after.wide && !before?.wide)
    out.push(after.documentWidth !== undefined && after.viewportWidth !== undefined ? `The page is ${after.documentWidth}px wide on a ${after.viewportWidth}px screen.` : 'The page is wider than the screen.');
  for (const [key, line] of after.overflow) if (!before?.overflow.has(key) && !(after.wide && key.startsWith('horizontal-overflow|'))) out.push(line);
  for (const [file, n] of after.images) if (n > (before?.images.get(file) ?? 0)) out.push(`The image ${file} failed to load.`);
  if (!after.images.size && after.failed > (before?.failed ?? 0)) out.push(`${after.failed - (before?.failed ?? 0) === 1 ? 'An image' : `${after.failed - (before?.failed ?? 0)} images`} failed to load.`);
  for (const e of after.errors) if (!before?.errors.has(e)) out.push(`A script failed: ${e}`);
  return out;
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
 * A page measured only after the run already changed it (directly, or through something every page shares) cannot
 * tell what the run brought in, so its problems are reported but never sent back for repair.
 */
export class PreviewCheck {
  private baselines = new Map<string, Baseline>();
  /** Pages a landed change reached directly, in the order the run first changed them. */
  private edited: string[] = [];
  private shared = false;
  private phone = false;
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
   * The pages a change every page shows is checked on: the pages the run changed and the request names first, then the
   * other changed pages, then the other named pages; Home when there are none.
   */
  private sample(state: ProjectState): string[] {
    const live = (id: string) => Object.hasOwn(state.pages, id);
    const edited = this.edited.filter(live);
    const names = namedPages(state, this.request);
    const order = [...new Set([...edited.filter((p) => names.includes(p)), ...edited, ...names])];
    if (!order.length && live(state.site.homePageId)) order.push(state.site.homePageId);
    return order.slice(0, MAX_CHECKED_PAGES);
  }

  /**
   * Before a batch lands: measure, as it is now, each page and width the batch will reach that has no measurement
   * from before the run reached it. `seen` gives a measurement the run already has that no change has outdated.
   */
  async beforeApply(ops: EditOperation[], state: ProjectState, measure: (pageId: string, viewport: Viewport) => Promise<Measurement>, seen: (pageId: string, viewport: Viewport) => Measurement | undefined) {
    const reach = visibleReach(ops, state);
    const pages = new Set(reach.pages);
    if (reach.shared && !this.shared) for (const p of this.sample(state)) pages.add(p);
    for (const pageId of pages) {
      if (!Object.hasOwn(state.pages, pageId)) continue;
      for (const viewport of this.widths(this.phone || reach.phone)) {
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
        const m = prior?.ok ? prior : await measure(pageId, viewport);
        this.baselines.set(key, m.ok ? { findings: findingsOf(m.report) } : 'unknown');
      }
    }
  }

  /** A batch landed, taking the project from `before` to `after`. */
  landed(ops: EditOperation[], before: ProjectState, after: ProjectState): Reach {
    const reach = visibleReach(ops, before, after);
    for (const p of reach.pages) if (!this.edited.includes(p)) this.edited.push(p);
    if (reach.shared) this.shared = true;
    if (reach.phone) this.phone = true;
    return reach;
  }

  /** The pages and widths to measure before the run finishes, and a card row for changed pages left unchecked. */
  plan(state: ProjectState): { targets: CheckTarget[]; unchecked: ChatCheck[] } {
    if (!this.changed) return { targets: [], unchecked: [] };
    const live = (id: string) => Object.hasOwn(state.pages, id);
    const edited = this.edited.filter(live);
    const pages = this.shared ? this.sample(state) : edited.slice(0, MAX_CHECKED_PAGES);
    const left = edited.filter((p) => !pages.includes(p));
    const unchecked: ChatCheck[] = [];
    const title = (id: string) => state.pages[id].title;
    if (left.length) {
      const names = left.length > 3 ? [...left.slice(0, 2).map(title), `${left.length - 2} more`] : left.map(title);
      unchecked.push({ status: 'unverified', text: `Didn't check the changes to ${joinWords(names)} in the preview.` });
    }
    // A change every page shows is checked on a few of them; the rest are said to be unchecked.
    if (this.shared && state.site.pageOrder.some((id) => live(id) && !pages.includes(id) && !left.includes(id)))
      unchecked.push({ status: 'unverified', text: `Didn't check the other pages that show the changes to what pages share in the preview.` });
    const widths = this.widths();
    return { targets: pages.flatMap((pageId) => widths.map((viewport) => ({ pageId, viewport }))), unchecked };
  }

  /**
   * The problems the run brought in, from the latest measurement of each target, said for the model. A target whose
   * page was measured only after the run reached it, or could not be measured, has none: its rows say what it found.
   */
  introduced(state: ProjectState, measured: Array<CheckTarget & { m: Measurement | undefined }>): string[] {
    const out: string[] = [];
    for (const { pageId, viewport, m } of measured) {
      if (!m?.ok) continue;
      const base: Baseline | undefined = Object.hasOwn(this.start.pages, pageId) ? this.baselines.get(keyOf(pageId, viewport)) : 'empty';
      if (!base || base === 'unknown') continue;
      const found = introducedProblems(base === 'empty' ? null : base.findings, findingsOf(m.report));
      if (!found.length) continue;
      const page = Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined;
      const where = `${page ? `${page.title} (page ${pageId})` : `Page ${pageId}`} at ${viewport} width`;
      const shown = found.slice(0, PROBLEMS_SHOWN);
      out.push(`${where}: ${shown.join(' ')}${found.length > shown.length ? ` And ${found.length - shown.length} more.` : ''}`);
    }
    return out;
  }
}
