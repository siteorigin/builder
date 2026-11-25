/**
 * Site-building macro tools. One call describes a whole page; it compiles to one validated EditOperation
 * batch that goes through the same scope checks, validation and undo group as any other edit, so a small
 * model never has to carry page IDs or revisions from one turn to the next.
 */
import { axesOf, findVariant, variantOptions } from '@shared/variants';
import { propBindingValue } from '@shared/bindings';
import { z } from 'zod';
import type { ComponentDefinition, Condition, ImageValue, InstanceNode, ListItem, LinkValue, PageDoc, ProjectState, PropSchema, ScalarPropSchema, VariantAxis } from '@shared/types';
import { conditionHolds, conditionRef, stateInitial } from '@shared/types';
import { effectiveItem, followsPage, teaserFields } from '@shared/page-teasers';
import type { EditOperation } from '@shared/ops';
import { normalizeRoute, validateRoute } from '@shared/routes';
import { newId } from '@shared/ids';
import { isLanguageCode } from '@shared/languages';
import { TEXT_LIMITS } from '@shared/text-limits';
import { CANONICAL_URL_MAX } from '@shared/seo';
import { catalogueComponent, catalogueEntries } from '@catalogue/index';
import { hasCollections, listsEntries } from '@shared/entry-feed';
import { applyOperation } from '@engine/apply';
import { headerMenuSlot, itemLinkPairs } from '@engine/tree';
import { followText, joinedLines } from '@shared/contact-links';
import { normalizeProp, normalizeScalar } from '@engine/values';
import { compactPropsSchema, IMAGE_SCHEMA, REQUIRED_IMAGE_SCHEMA, type JsonSchema } from './propschema';
import type { ToolHost, ToolOutcome } from './tools';
import { applyFailure, replayed, stamp, toolError, type ResultOutcome, type ToolResult } from './result';

const MAX_SECTIONS = 16;

export const SECTION_ARGS = z.object({
  componentId: z.string().min(1),
  index: z.number().int().min(0).optional().describe('With repair: the section index the error named.'),
  variant: z.string().optional(),
  variants: z.record(z.string(), z.string()).optional().describe('Options by axis, such as { "tone": "muted", "layout": "two-columns" }. Axes left out keep their choice.'),
  props: z.record(z.string(), z.unknown()).optional()
});
export type SectionInput = Omit<z.infer<typeof SECTION_ARGS>, 'index'>;

const DRAFT_DESCRIPTION = 'true keeps the page as a draft: editable and previewed, but left out of the exported website. false publishes it. Omit to leave it as it is. The home page is never a draft.';
const LANGUAGE_DESCRIPTION = 'Language code such as "fr", when not the site language. "" uses the site language. Omit to leave it.';
const TRANSLATION_DESCRIPTION = 'Slug of the page this one translates, such as "about": links them, joining any versions it has. Each version needs its own language; a page without one uses the site language. "" unlinks. Omit to leave it.';

const SEO_TITLE_DESCRIPTION = 'Search result title, about 50 to 60 characters. "" uses the page title.';
const SOCIAL_IMAGE_DESCRIPTION = 'Link preview image assetId. "" uses the site\'s.';
const NOINDEX_DESCRIPTION = 'true keeps the page out of search engines and AI answers.';
const CANONICAL_DESCRIPTION = 'The original https:// address, when published elsewhere first. "" uses its own.';

const ARTICLE_DATE_DESCRIPTION = 'YYYY-MM-DD: makes a dated article, shown in News lists.';
/** Placed first on a new article unless the call places a header of its own: it shows the page's title and details. */
const ARTICLE_HEADER = 'content.article';
const ARTICLE_KEYS = ['articleDate', 'byline', 'excerpt', 'newsHidden'] as const;
/** Whether a section is an Article header: the theme's, a copy of it, or a design that places one. */
export function isArticleHeader(state: ProjectState, def: ComponentDefinition, props: Record<string, unknown> = {}, seen: Set<string> = new Set()): boolean {
  if (def.componentId === ARTICLE_HEADER || def.provenance?.componentId === ARTICLE_HEADER) return true;
  if (seen.has(def.id)) return false;
  seen.add(def.id);
  // A header placed under a condition counts while that condition holds for the props sent (or their defaults).
  const value = (k: string) => {
    const d = (def.properties[k] as { default?: unknown } | undefined)?.default;
    if (!Object.hasOwn(props, k)) return d;
    // An object sent in part keeps its default for the fields left out, as placing it does.
    const v = props[k];
    return def.properties[k]?.type === 'object' && v && typeof v === 'object' && !Array.isArray(v) && d && typeof d === 'object' ? { ...d, ...v } : v;
  };
  const present = (v: unknown) => (typeof v === 'string' ? !!v.trim() : Array.isArray(v) ? v.length > 0 : !!v);
  const holds = (c: Condition | undefined, want: boolean) => {
    const ref = c === undefined ? undefined : conditionRef(c);
    // UI state reads as the value every placement starts with.
    if (ref && '$state' in ref) return conditionHolds(c!, stateInitial(def, ref.$state), present) === want;
    return !ref || !('$prop' in ref) || conditionHolds(c!, propBindingValue(value(ref.$prop), ref), present) === want;
  };
  return Object.values(def.tree?.nodes ?? {}).some(
    (n) => n.kind === 'instance' && holds(n.when, true) && holds(n.unless, false) && Object.hasOwn(state.components, n.definitionId) && isArticleHeader(state, state.components[n.definitionId], n.props, seen)
  );
}

/** Long enough for any valid route, also escaped as a browser copies it: four segments of up to 120 bytes, each
 *  escaped as three characters, and their slashes. */
const SLUG_CHARS = 1500;

export const UPSERT_ARGS = z.object({
  slug: z.string().min(1).max(SLUG_CHARS).describe('Page path such as "services" or "/about/team/". "home" or "/" is the home page.'),
  title: z.string().min(1).max(80).optional().describe('Page title. Defaults to one made from the slug for a new page.'),
  navLabel: z.string().max(40).optional(),
  description: z.string().max(320).optional().describe('Search engine description.'),
  seoTitle: z.string().max(TEXT_LIMITS.seoTitle).optional().describe(SEO_TITLE_DESCRIPTION),
  socialImage: z.string().max(200).optional().describe(SOCIAL_IMAGE_DESCRIPTION),
  noindex: z.boolean().optional().describe(NOINDEX_DESCRIPTION),
  canonical: z.string().max(CANONICAL_URL_MAX).optional().describe(CANONICAL_DESCRIPTION),
  draft: z.boolean().optional().describe(DRAFT_DESCRIPTION),
  language: z.string().max(20).optional().describe(LANGUAGE_DESCRIPTION),
  translationOf: z.string().max(120).optional().describe(TRANSLATION_DESCRIPTION),
  articleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(ARTICLE_DATE_DESCRIPTION),
  byline: z.string().max(80).optional().describe('Article byline.'),
  excerpt: z.string().max(320).optional().describe('Article summary.'),
  newsHidden: z.boolean().optional().describe('Article only: true leaves it out of News lists.'),
  addToHeaderNav: z.boolean().optional(),
  addToFooterNav: z.boolean().optional(),
  removeOtherSections: z.boolean().optional(),
  sections: z.array(SECTION_ARGS).min(1).max(MAX_SECTIONS).optional(),
  repair: z.boolean().optional().describe('After an error: sections holds only the failed sections, each with its index.')
});
export type UpsertArgs = z.infer<typeof UPSERT_ARGS>;

export const UPSERT_DESCRIPTION =
  'Create or update a whole page in one call, top to bottom, and wire navigation. No page IDs or revisions needed. From copy or notes the user supplies, put every block of it, in reading order, in the section that fits it, keeping its wording, figures, lists, quotes and links, add nothing the copy does not call for, and set or clear each sample text the section shows so only the supplied copy remains. On an existing page, a section with the same componentId is updated in place (props you omit keep their value; a list you send sets its items and their order, and an item keeps the fields you omit when it has its id from read_page, or no id and the same name or title as exactly one existing item); other existing sections stay unless removeOtherSections is true. Pass it when a draft of the whole page replaces a title-only introduction or starter sample sections, or when the user asks to replace the page; never to add to a page, and keep sections the author wrote otherwise. Internal links may use the route of a page you have not built yet; they connect when that page is created. If a section is invalid, nothing is applied and the error names the section and field: call again with repair: true and only that section, with its index.';

export const UPSERT_BRIEF =
  'Create or update a whole page with all its sections, and wire navigation; no page IDs or revisions. Supplied copy: each block in order in a fitting section, kept word for word unless asked to edit, nothing added, sample text cleared. On an existing page a section with the same componentId is updated in place: omitted props keep their value, a list you send sets its items and their order, and an item keeps omitted fields when it has its id from read_page, or no id and the same name or title as exactly one existing item. Other sections stay unless removeOtherSections is true: for a whole-page draft over a title-only introduction or starter samples, never to add to a page or over the author\'s own unless asked. Links may use routes of pages not built yet. If a section is invalid nothing is applied: call again with repair: true and only that section, with its index.';

/** A link whose page does not exist yet. It connects as soon as a page takes that route. */
export interface PendingLink {
  route: string;
  pageId: string;
  nodeId: string;
  prop: string;
  itemId?: string;
  field?: string;
}

/** What the macro tools remember during one run. */
export interface MacroMemory {
  /** The last rejected page per route, so one section can be repaired without resending the page. */
  drafts: Map<string, Omit<UpsertArgs, 'repair' | 'sections'> & { sections: SectionInput[]; pageId: string | null }>;
  pendingLinks: PendingLink[];
  /**
   * upsert_managed_component calls that did not apply, as sent, by the component they are about (see draftKey), so the
   * next can repair only what it names. `target`: the rebuilt component as it was, so a repair never applies a
   * description made before that component changed.
   */
  componentDrafts?: Map<string, { args: Record<string, unknown>; target: string | null }>;
  /** Finished calls by call ID: a replayed call returns its first result and changes nothing. */
  replay: Map<string, { args: string; result: ToolResult }>;
}

export const newMacroMemory = (): MacroMemory => ({ drafts: new Map(), pendingLinks: [], replay: new Map() });

export interface FieldIssue {
  field: string;
  message: string;
}

/** A call refused for problems in its fields, each named by its path (in details.fields) and in the message. */
export function fieldError(issues: FieldIssue[], note: string): ToolOutcome {
  return toolError('VALIDATION_FAILED', `${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}. ${note}`, { details: { fields: issues } });
}

/**
 * The variant options a call picks, by axis: `variant` names one option on whichever axis has it, `variants` names
 * one per axis, so tone and layout can be set together. Returns undefined when nothing is picked. `at` prefixes the
 * field names of any problems (for example "sections[2].").
 */
export function chooseVariants(def: ComponentDefinition, variant: string | undefined, variants: Record<string, string> | undefined, at: string, issues: FieldIssue[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const options = () => [...new Set(variantOptions(def).map((o) => o.id))].join(', ') || 'none';
  if (variant !== undefined) {
    const found = findVariant(def, variant);
    if ('error' in found) issues.push({ field: `${at}variant`, message: `"${def.name}" has no variant "${variant}". Variants: ${options()}` });
    else out[found.axis] = found.id;
  }
  for (const [axis, id] of Object.entries(variants ?? {})) {
    const found = findVariant(def, id, axis);
    if ('error' in found) {
      issues.push({ field: `${at}variants.${axis}`, message: found.error });
      continue;
    }
    if (Object.hasOwn(out, axis) && out[axis] !== found.id) {
      issues.push({ field: `${at}variants.${axis}`, message: `conflicts with variant "${variant}", which is a ${axis} option. Send one choice per axis.` });
      continue;
    }
    out[axis] = found.id;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A closed object with one optional choice per variant axis, or null for a component with fewer than two axes, where
 * `variant` already names any choice. `describe` adds the axis labels; the page tool leaves them out, as it repeats
 * this for every component and a small model's window has room for little else.
 */
export function variantsJsonSchema(def: ComponentDefinition, describe = false): JsonSchema | null {
  const axes = axesOf(def);
  if (axes.length < 2) return null;
  return {
    type: 'object',
    properties: Object.fromEntries(axes.map(([axis, a]) => [axis, { type: 'string', enum: Object.keys(a.options), ...(describe && a.label ? { description: a.label } : {}) }])),
    additionalProperties: false,
    ...(describe ? { description: 'One option per axis, such as tone and layout together. Axes left out keep their choice.' } : {})
  };
}

// ---------------------------------------------------------------------------
// Section checks
// ---------------------------------------------------------------------------

/** Whether a theme component is a block (a feature card, a stat card), which goes inside a layout rather than among a page's sections. */
const isThemeBlock = (def: ComponentDefinition | undefined): boolean => def?.owner === 'theme' && def.insertAs === 'element';

/**
 * The theme's design of `componentId` as the project has it: its installed copy, else the theme's own. Whether it is a
 * block is read from this one definition when the tool lists it, takes it and leaves it on a page, so a newer release
 * that changes the role cannot have one call refuse what another removes.
 */
function themeDesign(state: ProjectState, componentId: string): ComponentDefinition | undefined {
  const themed = catalogueComponent(state.site.themeId, componentId);
  return themed && Object.hasOwn(state.components, themed.id) ? state.components[themed.id] : themed;
}

/** The definition a section's componentId names: a theme section, or a project component by definition ID. */
function sectionDefinition(state: ProjectState, id: string): { def: ComponentDefinition; ref: { componentId: string } | { definitionId: string } } | null {
  const themed = themeDesign(state, id);
  if (themed && themed.category !== 'shell' && !isThemeBlock(themed)) return { def: themed, ref: { componentId: id } };
  const own = Object.hasOwn(state.components, id) ? state.components[id] : undefined;
  if (own && own.owner === 'project' && own.category !== 'shell') return { def: own, ref: { definitionId: id } };
  return null;
}

/** A lowercase address, in any script ("/about/", "/お問い合わせ/"); a capitalised word is a label, not an address. */
const ROUTE_LIKE = /^\/?[\p{Ll}\p{Lo}\p{Lm}\p{Nd}][\p{Ll}\p{Lo}\p{Lm}\p{M}\p{Nd}-]*(\/[\p{Ll}\p{Lo}\p{Lm}\p{Nd}][\p{Ll}\p{Lo}\p{Lm}\p{M}\p{Nd}-]*)*\/?$/u;

const pageAtRoute = (state: ProjectState, route: string): PageDoc | undefined => Object.values(state.pages).find((p) => p.route === route);

/**
 * An internal link written as a route. Returns the link to store, and the route when its page does not
 * exist yet. Anything that is not a route is left for the value normalizer.
 */
function resolveRouteLink(v: unknown, state: ProjectState): { value: unknown; pendingRoute?: string } {
  const raw = typeof v === 'string' ? v : v && typeof v === 'object' && (v as LinkValue).type === 'page' ? String((v as LinkValue).target ?? '') : null;
  if (raw === null || !raw || Object.hasOwn(state.pages, raw) || raw === '/') {
    if (raw === '/') return { value: { type: 'page', target: state.site.homePageId } };
    return { value: v };
  }
  if (!ROUTE_LIKE.test(raw)) return { value: v };
  const route = normalizeRoute(raw);
  if (validateRoute(route)) return { value: v };
  const page = pageAtRoute(state, route);
  if (page) {
    const { anchor, newTab } = (v && typeof v === 'object' ? v : {}) as Partial<LinkValue>;
    return { value: { type: 'page', target: page.id, ...(anchor ? { anchor } : {}), ...(newTab ? { newTab } : {}) } };
  }
  return { value: { type: 'none', target: '' }, pendingRoute: route };
}

/** A required link can never wait for its page: an empty link is no value for it. */
const waitingRequired = (schema: ScalarPropSchema, route: string) =>
  `no page uses the route ${route} yet, and “${schema.label}” is required, so it cannot wait for one: create that page first, then set this link`;

export interface DeferredLink {
  route: string;
  prop: string;
  itemIndex?: number;
  field?: string;
}

const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
const isRow = (it: unknown): it is Record<string, unknown> => !!it && typeof it === 'object' && !Array.isArray(it);

/**
 * The stored value a sent one stands for when it is that value as it was read, or undefined. Besides an exact copy, a
 * link to a page that has since gone may come back as the page ID a string-typed tool field takes, and an image whose
 * file has gone as its assetId and alt text without its other settings.
 */
function storedIfUnchanged(schema: PropSchema, sent: unknown, stored: unknown, state: ProjectState): unknown {
  if (stored === undefined) return undefined;
  if (same(sent, stored)) return stored;
  const was = stored as Partial<LinkValue & ImageValue> | null;
  if (!was || typeof was !== 'object') return undefined;
  if (schema.type === 'link' && typeof sent === 'string' && was.type === 'page' && was.target === sent && !Object.hasOwn(state.pages, sent)) return stored;
  // Only the settings it leaves out come from the stored image: one it sends is the one it means.
  if (
    schema.type === 'image' &&
    isRow(sent) &&
    typeof was.assetId === 'string' &&
    sent.assetId === was.assetId &&
    String(sent.alt ?? '') === String(was.alt ?? '') &&
    Object.keys(sent).every((k) => k === 'assetId' || k === 'alt' || same(sent[k], (was as Record<string, unknown>)[k])) &&
    !Object.hasOwn(state.assets.assets, was.assetId)
  )
    return stored;
  return undefined;
}

/**
 * Check a section's props with the engine's value normalizers, so every problem is reported with its exact
 * path. Returns the props to send, with routes resolved, and any links waiting for a page. `stored` is the
 * placement's own props when the section already exists: a value sent back unchanged is checked against it, as the
 * engine checks it, so one saved under older rules (a link to a page since removed, an icon since retired) never
 * blocks the rest of the update. A list item is the stored item it is merged with: by its id, or as `itemIds` matches it.
 */
export function checkProps(
  def: ComponentDefinition,
  props: Record<string, unknown>,
  state: ProjectState,
  path: string,
  issues: FieldIssue[],
  stored?: Record<string, unknown>,
  /** The stored item id each sent item of a list stands for, as the write matches them (by id, else by title or page). */
  itemIds?: (prop: string, sent: unknown[]) => Array<string | undefined>
): { props: Record<string, unknown>; deferred: DeferredLink[] } {
  const out: Record<string, unknown> = {};
  const deferred: DeferredLink[] = [];
  const storedProp = (k: string) => (stored && Object.hasOwn(stored, k) ? stored[k] : undefined);
  for (const [k, v] of Object.entries(props)) {
    const schema: PropSchema | undefined = Object.hasOwn(def.properties, k) ? def.properties[k] : undefined;
    if (!schema) {
      issues.push({ field: `${path}.${k}`, message: `"${def.name}" has no property "${k}". Properties: ${Object.keys(def.properties).join(', ')}` });
      continue;
    }
    if (schema.type === 'list' && schema.feed) {
      // Filled from the site's pages: an empty list is what it stores anyway, and items are never kept.
      if (Array.isArray(v) && !v.length) continue;
      issues.push({
        field: `${path}.${k}`,
        message:
          schema.feed === 'entries'
            ? `"${k}" fills itself from a collection's published entries. Leave it out; choose which with collection, category, tag and count instead.`
            : `"${k}" fills itself from the site's ${schema.feed === 'articles' ? 'dated articles' : 'page'}. Leave it out; set articleDate, byline and excerpt on the article pages instead.`
      });
      continue;
    }
    if (schema.type === 'link') {
      // A stored link sent back as it was read stays as it is, even when its page has gone.
      const kept = storedIfUnchanged(schema, v, storedProp(k), state);
      const r = kept !== undefined ? { value: kept } : resolveRouteLink(v, state);
      if (r.pendingRoute && schema.required) {
        issues.push({ field: `${path}.${k}`, message: waitingRequired(schema, r.pendingRoute) });
        continue;
      }
      if (r.pendingRoute) deferred.push({ route: r.pendingRoute, prop: k });
      out[k] = r.value;
      checkValue(() => normalizeScalar(schema, r.value, state, schema.label, storedProp(k)), `${path}.${k}`, issues);
      continue;
    }
    if (schema.type === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
      // An object's link to a page made later in the run waits for it, as a list item's does.
      const copy: Record<string, unknown> = { ...(v as Record<string, unknown>) };
      let waiting = false;
      for (const [f, fs] of Object.entries(schema.fields)) {
        if (fs.type !== 'link' || !Object.hasOwn(copy, f)) continue;
        const r = resolveRouteLink(copy[f], state);
        if (r.pendingRoute && fs.required) {
          issues.push({ field: `${path}.${k}.${f}`, message: waitingRequired(fs, r.pendingRoute) });
          waiting = true;
          continue;
        }
        if (r.pendingRoute) deferred.push({ route: r.pendingRoute, prop: k, field: f });
        copy[f] = r.value;
      }
      out[k] = copy;
      // Checked as the engine merges it: fields left out keep the placement's own values.
      if (!waiting) checkValue(() => normalizeProp(schema, copy, state, schema.label, storedProp(k)), `${path}.${k}`, issues);
      continue;
    }
    if (schema.type === 'list' && Array.isArray(v)) {
      const before = issues.length;
      const kept = storedProp(k);
      const storedItems = Array.isArray(kept) ? (kept as unknown[]).filter((x): x is ListItem => isRow(x) && typeof x.id === 'string') : [];
      // An id two stored items share names neither of them.
      const storedItem = (id: unknown) => (typeof id === 'string' && storedItems.filter((x) => x.id === id).length === 1 ? storedItems.find((x) => x.id === id) : undefined);
      // Links written as routes resolve first, so items are matched to stored ones as the write matches them.
      const waiting = new Set<string>();
      const rows = v.map((it, i) => {
        if (!isRow(it)) return it;
        const copy: Record<string, unknown> = {};
        for (const [f, x] of Object.entries(it)) {
          const fs = f !== 'id' && Object.hasOwn(schema.fields, f) ? schema.fields[f] : undefined;
          if (fs?.type !== 'link') {
            copy[f] = x;
            continue;
          }
          const r = resolveRouteLink(x, state);
          if (r.pendingRoute && fs.required) {
            issues.push({ field: `${path}.${k}[${i}].${f}`, message: waitingRequired(fs, r.pendingRoute) });
            waiting.add(`${i}|${f}`);
          } else if (r.pendingRoute) deferred.push({ route: r.pendingRoute, prop: k, itemIndex: i, field: f });
          copy[f] = r.value;
        }
        return copy;
      });
      const matched = storedItems.length && itemIds ? itemIds(k, rows) : undefined;
      // Without a matcher, an id stands for its stored item once: a second item sending it again is a new item.
      const claimed = new Set<string>();
      const items = rows.map((row, i) => {
        const itemPath = `${path}.${k}[${i}]`;
        if (!isRow(row)) {
          issues.push({ field: itemPath, message: 'expected an object' });
          return row;
        }
        const ownId = typeof row.id === 'string' && !claimed.has(row.id) ? row.id : undefined;
        if (ownId !== undefined) claimed.add(ownId);
        const was = storedItem(matched ? matched[i] : ownId);
        const copy: Record<string, unknown> = {};
        for (const [f, x] of Object.entries(row)) {
          if (f === 'id') {
            copy.id = x;
            continue;
          }
          const fs = Object.hasOwn(schema.fields, f) ? schema.fields[f] : undefined;
          if (!fs) {
            issues.push({ field: `${itemPath}.${f}`, message: `${schema.itemLabel} has no field "${f}". Fields: ${Object.keys(schema.fields).join(', ')}` });
            continue;
          }
          if (waiting.has(`${i}|${f}`)) continue;
          const keptValue = storedIfUnchanged(fs, (v[i] as Record<string, unknown>)[f], was?.[f], state);
          const value = keptValue !== undefined ? keptValue : x;
          copy[f] = value;
          checkValue(() => normalizeScalar(fs, value, state, fs.label, was?.[f]), `${itemPath}.${f}`, issues);
        }
        return copy;
      });
      out[k] = items;
      // List-wide rules (length) are checked once its items are sound, each as the stored item it will be merged with.
      const asStored = items.map((it, i) => (matched?.[i] && isRow(it) && it.id === undefined ? { ...it, id: matched[i] } : it));
      if (issues.length === before) checkValue(() => normalizeProp(schema, asStored, state, schema.label, kept), `${path}.${k}`, issues);
      continue;
    }
    const keptValue = storedIfUnchanged(schema, v, storedProp(k), state);
    out[k] = keptValue !== undefined ? keptValue : v;
    checkValue(() => normalizeProp(schema, out[k], state, schema.label, storedProp(k)), `${path}.${k}`, issues);
  }
  return { props: out, deferred };
}

function checkValue(run: () => unknown, field: string, issues: FieldIssue[]) {
  try {
    run();
  } catch (e) {
    issues.push({ field, message: (e as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function shellLinks(state: ProjectState, shell: 'header' | 'footer'): { node: InstanceNode; max?: number; items: ListItem[] } | null {
  const tree = state.site.shell[shell];
  for (const id of tree.rootIds) {
    const n = tree.nodes[id];
    if (n?.kind !== 'instance') continue;
    const schema = state.components[n.definitionId]?.properties.links;
    // A computed list fills itself from the site's pages: a link stored in it would never show.
    if (schema?.type === 'list' && !schema.feed && schema.fields.label?.type === 'string' && schema.fields.link?.type === 'link')
      // An unset list shows its default items, and an insertion starts from them.
      return { node: n, max: schema.max, items: (n.props.links as ListItem[] | undefined) ?? (schema.default as ListItem[] | undefined) ?? [] };
  }
  return null;
}

function navOps(state: ProjectState, shell: 'header' | 'footer', pageId: string, label: string): { ops: EditOperation[]; status: 'added' | 'present' | 'full' | 'unavailable' } {
  const menu = shellLinks(state, shell);
  if (!menu) return { ops: [], status: 'unavailable' };
  if (menu.items.some((i) => (i.link as LinkValue | undefined)?.type === 'page' && (i.link as LinkValue).target === pageId)) return { ops: [], status: 'present' };
  if (menu.max !== undefined && menu.items.length >= menu.max) return { ops: [], status: 'full' };
  // In the header, a page inside another goes under that page's link, as Add page puts it (see headerMenuSlot).
  const slot = shell === 'header' ? headerMenuSlot(state, menu.items, pageId) : { index: menu.items.length, sub: false };
  const item = { label, link: { type: 'page', target: pageId }, ...(slot.sub ? { sub: true } : {}) };
  const at = slot.index < menu.items.length ? { index: slot.index } : {};
  return { status: 'added', ops: [{ type: 'instance.listInsert', owner: { kind: 'shell', id: shell }, nodeId: menu.node.id, prop: 'links', ...at, item }] };
}

// ---------------------------------------------------------------------------
// Links waiting for a page
// ---------------------------------------------------------------------------

/** The value now stored where a pending link waits, or undefined if that place no longer exists. */
function pendingSlot(state: ProjectState, p: PendingLink): { value: unknown } | undefined {
  const node = Object.hasOwn(state.pages, p.pageId) ? state.pages[p.pageId].nodes[p.nodeId] : undefined;
  if (node?.kind !== 'instance') return undefined;
  // One field of an object property, or the whole property.
  if (!p.itemId) return { value: p.field !== undefined ? propBindingValue(node.props[p.prop], { field: p.field }) : node.props[p.prop] };
  const list = node.props[p.prop];
  const item = Array.isArray(list) ? (list as ListItem[]).find((i) => i?.id === p.itemId) : undefined;
  return item ? { value: item[p.field!] } : undefined;
}

/** A link is still waiting only while its place exists and holds the empty placeholder: a later edit wins. */
const stillWaiting = (state: ProjectState, p: PendingLink) => {
  const slot = pendingSlot(state, p);
  return !!slot && (slot.value as LinkValue | undefined)?.type === 'none';
};

/**
 * `skip` names links this call replaces with a value of its own: they are neither filled nor kept. A run limited to one
 * page (`limit`) fills only links on that page: one waiting on another page keeps waiting.
 */
function pendingLinkOps(state: ProjectState, memory: MacroMemory, route: string, pageId: string, skip?: (p: PendingLink) => boolean, limit?: string | null): { ops: EditOperation[]; filled: PendingLink[] } {
  const ops: EditOperation[] = [];
  const filled: PendingLink[] = [];
  for (const p of memory.pendingLinks) {
    if (p.route !== route || skip?.(p) || (limit && p.pageId !== limit)) continue;
    filled.push(p);
    if (!stillWaiting(state, p)) continue;
    ops.push({
      type: 'instance.setProp',
      owner: { kind: 'page', id: p.pageId },
      nodeId: p.nodeId,
      prop: p.prop,
      ...(p.itemId ? { itemId: p.itemId, field: p.field } : p.field !== undefined ? { field: p.field } : {}),
      value: { type: 'page', target: pageId }
    });
  }
  return { ops, filled };
}

/** Connect links whose page now exists, however that page was made. Returns the routes still missing. */
/**
 * `deferred`: routes that exist, whose links wait on pages a run limited to one page may not change; a run that may
 * change those pages connects them.
 */
export async function connectPendingLinks(host: ToolHost, memory: MacroMemory, key: string): Promise<{ outcome?: Extract<ToolOutcome, { ok: true }>; missing: string[]; deferred: string[]; error?: string }> {
  const state = host.state();
  memory.pendingLinks = memory.pendingLinks.filter((p) => stillWaiting(state, p));
  const ops: EditOperation[] = [];
  const filled: PendingLink[] = [];
  const limit = host.pageLimit?.()?.pageId ?? null;
  for (const route of new Set(memory.pendingLinks.map((p) => p.route))) {
    const page = pageAtRoute(state, route);
    if (!page) continue;
    const r = pendingLinkOps(state, memory, route, page.id, undefined, limit);
    ops.push(...r.ops);
    filled.push(...r.filled);
  }
  let outcome: Extract<ToolOutcome, { ok: true }> | undefined;
  if (ops.length) {
    const res = await host.apply(ops, host.revision(), 'Connect page links', key);
    if (!res.ok) return { missing: [...new Set(memory.pendingLinks.map((p) => p.route))], deferred: [], error: res.error?.message ?? 'The links could not be connected.' };
    outcome = { ok: true, mutated: true, ops, results: res.results, content: { revision: res.revision } };
  }
  memory.pendingLinks = memory.pendingLinks.filter((p) => !filled.includes(p));
  // Only a route no page has is missing: a link on another page that a run limited to one page leaves waiting is not.
  const routes = [...new Set(memory.pendingLinks.map((p) => p.route))];
  return { outcome, missing: routes.filter((r) => !pageAtRoute(state, r)), deferred: limit ? routes.filter((r) => pageAtRoute(state, r)) : [] };
}

// ---------------------------------------------------------------------------
// Compiling a page
// ---------------------------------------------------------------------------

function titleFromRoute(route: string): string {
  const last = route.split('/').filter(Boolean).at(-1) ?? 'Home';
  return last
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function findPage(state: ProjectState, slug: string): { route: string; page?: PageDoc; error?: string } {
  if (!slug.trim()) return { route: '', error: 'the slug is empty' };
  // Bare "home" is always the current Home page; an explicit "/home/" is a route like any other.
  if (slug.trim().toLowerCase() === 'home') {
    const home = state.pages[state.site.homePageId];
    if (home) return { route: home.route, page: home };
  }
  const route = normalizeRoute(slug);
  const err = validateRoute(route);
  if (err) return { route, error: err };
  return { route, page: pageAtRoute(state, route) };
}

/**
 * Whether a root is a section the macro could place: a theme section, or a project section (a fork, a unique
 * copy, a custom or code component) the tool lists. Anything else, such as hand-built layout or a theme's block
 * placed there by hand, is never removed by it.
 */
function expressible(state: ProjectState, page: PageDoc, id: string): boolean {
  const n = page.nodes[id];
  if (n?.kind !== 'instance') return false;
  const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
  return (def?.owner === 'theme' && !isThemeBlock(def)) || (def?.owner === 'project' && def.category !== 'shell');
}

/**
 * A list sent for an existing section sets which items there are and their order, but an item keeps the stored
 * fields it leaves out. It is the stored item with its id or, when it has no id, the one item with the same
 * title (the list's titleField). Never by position: a reordered or replaced list must not move a portrait or
 * link to another item. An unmatched item is new: it starts from the field defaults with a fresh id, so it never
 * takes over a removed item's id or a link still waiting there. Returns the stored id each item kept, if any.
 */
/**
 * Move the email or phone links of a stored item to the visible text a sent copy of it changes, when the link
 * opened the old text and the sent copy leaves the link out (see followText). Returns the link fields it moved.
 */
export function followStoredLinks(def: ComponentDefinition | undefined, prop: string, stored: ListItem | undefined, sent: unknown, merged: unknown): string[] {
  if (!def || !stored || !sent || typeof sent !== 'object' || !merged || typeof merged !== 'object') return [];
  const row = sent as Record<string, unknown>;
  const out = merged as Record<string, unknown>;
  const pairs = itemLinkPairs(def, prop);
  if (!pairs.length) return [];
  // Pairs exist only on a list property.
  const fields = (def.properties[prop] as Extract<PropSchema, { type: 'list' }>).fields;
  const moved: string[] = [];
  for (const { text, link } of pairs) {
    if (!Object.hasOwn(row, text) || Object.hasOwn(row, link)) continue;
    // Compare the text as it will be stored: a one-line field joins its lines.
    const field = fields[text];
    const shown = field.type === 'string' && !field.multiline ? joinedLines(row[text]) : row[text];
    const to = followText(stored[text], shown, stored[link]);
    if (!to) continue;
    out[link] = to;
    moved.push(link);
  }
  return moved;
}

/**
 * Merge sent list items with the stored ones they stand for, so fields the sender left out keep their values. `shown`
 * gives a stored item as it shows (a page list's empty fields filled from their pages), which is what the sender saw.
 */
export function withStoredFields(schema: Extract<PropSchema, { type: 'list' }>, sent: unknown[], stored: unknown[], shown: (item: ListItem) => Record<string, unknown> = (item) => item): { items: unknown[]; ids: Array<string | undefined> } {
  const all = stored.filter((i): i is ListItem => !!i && typeof i === 'object' && typeof (i as ListItem).id === 'string');
  // An id two stored items share names neither of them.
  const items = all.filter((i) => all.filter((x) => x.id === i.id).length === 1);
  const byId = new Map(items.map((i) => [i.id, i]));
  const isRow = (it: unknown): it is Record<string, unknown> => !!it && typeof it === 'object' && !Array.isArray(it);
  const used = new Set<string>();
  // Items that name their id claim it first, so a title can never take an item another one asked for.
  const matched = sent.map((it) => {
    const id = isRow(it) && typeof it.id === 'string' ? it.id : undefined;
    if (id === undefined || !byId.has(id) || used.has(id)) return undefined;
    used.add(id);
    return byId.get(id);
  });
  /**
   * Match each item without an id to the one stored item with the same key, when only one sent item has that key
   * (with `unclaimed`, only one of those an id has not already matched).
   */
  const matchBy = (keyOf: (it: unknown) => string | undefined, eligible: (it: Record<string, unknown>) => boolean = () => true, storedKey: (it: ListItem) => string | undefined = keyOf, unclaimed = false) => {
    const count = (k: string) => sent.filter((x, j) => keyOf(x) === k && !(unclaimed && matched[j])).length;
    const countStored = (k: string) => all.filter((x) => storedKey(x) === k).length;
    sent.forEach((it, i) => {
      if (matched[i] || !isRow(it) || typeof it.id === 'string' || !eligible(it)) return;
      const k = keyOf(it);
      if (k === undefined || count(k) !== 1 || countStored(k) !== 1) return;
      const old = items.find((x) => storedKey(x) === k);
      if (!old || used.has(old.id)) return;
      used.add(old.id);
      matched[i] = old;
    });
  };
  const teaser = schema.pageTeaser;
  // A page list's cards are told apart by the page they stand for: a card sent for another page is a new card, even
  // under the same title. Only one sent without a page is matched by its title, so it keeps the page it had.
  // A page link, or a page's ID sent as it is (which the engine also takes).
  const pageOf = (it: unknown) => {
    const l = teaser && isRow(it) ? (it[teaser.link] as Partial<LinkValue> | string | undefined) : undefined;
    if (typeof l === 'string') return l && !/[/:#@]/.test(l) ? l : undefined;
    return l && typeof l === 'object' && l.type === 'page' && typeof l.target === 'string' && l.target ? l.target : undefined;
  };
  // A card an id already claimed is that card, wherever it now points: it leaves the page it names to the others.
  if (teaser) matchBy(pageOf, undefined, undefined, true);
  const field = schema.titleField;
  if (field) {
    const titleOf = (it: unknown) => {
      const t = isRow(it) ? it[field] : undefined;
      return typeof t === 'string' && t.trim() ? t : undefined;
    };
    // A card is known by the title it shows, its page's own while it has none.
    matchBy(titleOf, (it) => !teaser || it[teaser.link] === undefined, (it) => titleOf(teaser ? shown(it) : it));
  }
  // A card's field sent back as the page shows it stays empty, so it keeps following the page: only while the card
  // still stands for that page (a card pointed elsewhere keeps the text it was sent).
  const follows = teaser ? teaserFields(teaser).map(([f]) => f) : [];
  const unchanged = (old: ListItem, f: string, v: unknown) => {
    if (!followsPage(old[f])) return false;
    const now = shown(old)[f];
    if (typeof v === 'string') return typeof now === 'string' && v.trim() === now.trim();
    const img = v as Partial<ImageValue> | null;
    const was = now as Partial<ImageValue> | undefined;
    return !!img && typeof img === 'object' && !!was && typeof was === 'object' && !!img.assetId && img.assetId === was.assetId && String(img.alt ?? '').trim() === String(was.alt ?? '').trim() && !img.decorative;
  };
  return {
    items: sent.map((it, i) => {
      if (!isRow(it)) return it;
      const { id: _id, ...fields } = it;
      const old = matched[i];
      if (!old) return fields;
      const samePage = !teaser || !Object.hasOwn(fields, teaser.link) || (pageOf(fields) !== undefined && pageOf(fields) === pageOf(old));
      if (samePage) for (const f of follows) if (Object.hasOwn(fields, f) && unchanged(old, f, fields[f])) delete fields[f];
      return { ...structuredClone(old), ...fields, id: old.id };
    }),
    ids: matched.map((m) => m?.id)
  };
}

type Slot = { kind: 'keep'; id: string; section?: number } | { kind: 'new'; section: number };

/**
 * Decide the page's new section order: requested sections, with anything not requested left where it was.
 * A section is matched to an existing instance of its exact definition first; only a catalogue request (with a
 * publicId) then falls back to any instance of that component, such as a fork made by Edit everywhere.
 */
function planSections(state: ProjectState, page: PageDoc | undefined, sections: Array<{ defId: string; publicId?: string }>, removeOthers: boolean): { slots: Slot[]; removed: string[]; kept: string[] } {
  const roots = page?.rootIds ?? [];
  const used = new Set<string>();
  const claim = (test: (n: InstanceNode) => boolean) => {
    const id = roots.find((r) => {
      const n = page!.nodes[r];
      return !used.has(r) && n?.kind === 'instance' && test(n);
    });
    if (id) used.add(id);
    return id;
  };
  const matches = sections.map((s) => claim((n) => n.definitionId === s.defId));
  sections.forEach((s, i) => {
    if (!matches[i] && s.publicId) matches[i] = claim((n) => state.components[n.definitionId]?.componentId === s.publicId);
  });
  const wanted: Slot[] = matches.map((id, i) => (id ? { kind: 'keep', id, section: i } : { kind: 'new', section: i }));
  const others = roots.filter((id) => !used.has(id));
  const removed = removeOthers ? others.filter((id) => expressible(state, page!, id)) : [];
  const kept = others.filter((id) => !removed.includes(id));
  const slots = [...wanted];
  for (const id of kept) slots.splice(Math.min(roots.indexOf(id), slots.length), 0, { kind: 'keep', id });
  return { slots, removed, kept };
}

export async function runUpsert(rawArgs: UpsertArgs, host: ToolHost, callId: string, memory: MacroMemory): Promise<ToolOutcome | ResultOutcome> {
  const fingerprint = JSON.stringify(rawArgs);
  const revision = host.revision();
  const prior = memory.replay.get(callId);
  if (prior) {
    if (prior.args === fingerprint) return replayed(prior.result);
    return toolError('INVALID_ARGUMENT', 'That tool call ID was already used for a different request.');
  }
  // Kept whole, with the revision it was made at, so a replay says exactly what the call said the first time.
  const outcome = stamp(await compileAndApply(rawArgs, host, callId, memory), revision);
  memory.replay.set(callId, { args: fingerprint, result: outcome.content });
  return outcome;
}

async function compileAndApply(rawArgs: UpsertArgs, host: ToolHost, callId: string, memory: MacroMemory): Promise<ToolOutcome> {
  const state = host.state();
  const found = findPage(state, rawArgs.slug);
  if (found.error) return fieldError([{ field: 'slug', message: found.error }], 'Nothing was applied.');
  const { route, page } = found;
  // A run limited to one page builds only that page: never another one, nor a new one.
  const limit = host.pageLimit?.() ?? null;
  if (limit && page?.id !== limit.pageId) {
    const own = Object.hasOwn(state.pages, limit.pageId) ? state.pages[limit.pageId].route : null;
    const message = own
      ? `This request is limited to ${limit.label} (${own}), so upsert_page_with_sections can only build that page, not ${route}. Nothing was applied. Use slug "${own}", or ask the user with request_clarification (widenScope: true) before changing other pages.`
      : `${limit.label} is no longer in the site. Nothing was applied.`;
    return toolError('SCOPE_MISMATCH', message);
  }

  // Repairing: the rejected page is still held, so only the named sections come back.
  let args: UpsertArgs = rawArgs;
  if (rawArgs.repair) {
    const draft = memory.drafts.get(route);
    if (!draft) return fieldError([{ field: 'repair', message: `there is no rejected draft of ${route}` }], 'Send the whole page in sections, without repair.');
    if (draft.pageId !== (page?.id ?? null)) {
      memory.drafts.delete(route);
      return fieldError([{ field: 'repair', message: `${route} changed since that draft was rejected` }], 'Send the whole page in sections, without repair.');
    }
    const merged = [...draft.sections];
    const issues: FieldIssue[] = [];
    if (!rawArgs.sections?.length) issues.push({ field: 'sections', message: 'send the sections to repair, each with its index' });
    (rawArgs.sections ?? []).forEach(({ index, ...section }, n) => {
      if (index === undefined) issues.push({ field: `sections[${n}].index`, message: 'required with repair' });
      else if (index >= merged.length) issues.push({ field: `sections[${n}].index`, message: `the draft has sections 0 to ${merged.length - 1}` });
      else merged[index] = section;
    });
    if (issues.length) return fieldError(issues, 'Nothing was applied.');
    const { repair: _r, sections: _s, ...meta } = rawArgs;
    const { pageId: _p, ...held } = draft;
    args = { ...held, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)), sections: merged };
  }
  if (!args.sections && !page) return fieldError([{ field: 'sections', message: 'a new page needs at least one section' }], 'Nothing was applied.');
  if (args.language?.trim() && !isLanguageCode(args.language.trim())) return fieldError([{ field: 'language', message: 'use a language code such as "fr" or "en-GB"' }], 'Nothing was applied.');
  const image = args.socialImage?.trim();
  if (image && !(Object.hasOwn(state.assets.assets, image) && state.assets.assets[image].kind === 'image'))
    return fieldError([{ field: 'socialImage', message: `no library image has the assetId "${image}". Use an assetId search_assets returns, or "" for the site's image` }], 'Nothing was applied.');
  let linkTranslationTo: string | null | undefined;
  if (args.translationOf !== undefined) {
    const other = args.translationOf.trim() ? findPage(state, args.translationOf) : null;
    if (other && (other.error || !other.page)) return fieldError([{ field: 'translationOf', message: other.error ?? `there is no page at ${other.route}` }], 'Nothing was applied.');
    linkTranslationTo = other ? other.page!.id : null;
  }
  const sections = args.sections ?? [];
  const keepDraft = () => {
    const { repair: _r, sections: _s, ...meta } = args;
    if (sections.length) memory.drafts.set(route, { ...meta, pageId: page?.id ?? null, sections: sections.map(({ index: _i, ...section }) => section) });
  };

  // Check against the project as it will be once the page exists, so a page can link to itself.
  const pageId = page?.id ?? newId('pg');
  const title = (args.title ?? page?.title ?? titleFromRoute(route)).trim();
  if (!title) return fieldError([{ field: 'title', message: 'the title is empty' }], 'Nothing was applied.');
  const createOp: EditOperation | null = page ? null : { type: 'page.create', pageId, title, route };
  const scratch = structuredClone(state);
  if (createOp) {
    try {
      applyOperation(scratch, createOp);
    } catch (e) {
      return fieldError([{ field: 'slug', message: (e as Error).message }], 'Nothing was applied.');
    }
  }

  const issues: FieldIssue[] = [];
  const resolved = sections.map((s) => sectionDefinition(scratch, s.componentId));
  // Only a catalogue request may match another definition of the same component; a project one names its own.
  const publicIdOf = (r: NonNullable<(typeof resolved)[number]>) => ('componentId' in r.ref ? r.def.componentId : undefined);
  // Where each section lands decides what its values are checked against: a placement it updates is checked
  // against its own stored values, as the engine checks them, so a value sent back unchanged is never refused.
  // A section that names no component matches nothing.
  const plan = planSections(scratch, page, resolved.map((r) => (r ? { defId: r.def.id, publicId: publicIdOf(r) } : { defId: '' })), !!args.removeOtherSections && !!args.sections);
  const updates = new Map<number, InstanceNode>();
  for (const slot of plan.slots) if (slot.kind === 'keep' && slot.section !== undefined) updates.set(slot.section, page!.nodes[slot.id] as InstanceNode);
  const compiled = sections.map((s, i) => {
    const at = `sections[${i}]`;
    const r = resolved[i];
    if (!r) {
      if (isThemeBlock(themeDesign(scratch, s.componentId))) {
        issues.push({ field: `${at}.componentId`, message: `"${s.componentId}" is a block, not a section: it goes inside a section, a column or a component's slot. Send the page's sections again without it (not as a repair), then place it with apply_operations node.insert (into a Section's "content" slot, or a column).` });
        return null;
      }
      const names = catalogueEntries(state.site.themeId).filter((e) => !e.block).map((e) => e.componentId).join(', ');
      issues.push({ field: `${at}.componentId`, message: `unknown component "${s.componentId}". Components: ${names}` });
      return null;
    }
    const { def, ref } = r;
    const node = updates.get(i);
    // The options of the definition the section writes to: an existing fork of a catalogue component may differ.
    const placed = node && Object.hasOwn(scratch.components, node.definitionId) ? scratch.components[node.definitionId] : def;
    const variants = chooseVariants(placed, s.variant, s.variants, `${at}.`, issues);
    const nodeProps = node ? (scratch.components[node.definitionId]?.properties ?? {}) : {};
    // A list's items stand for the stored items they are merged with below, by id or else by title.
    const itemIds = (prop: string, sent: unknown[]) => {
      const schema = Object.hasOwn(nodeProps, prop) ? nodeProps[prop] : undefined;
      const list = node?.props[prop];
      return schema?.type === 'list' && Array.isArray(list) ? withStoredFields(schema, sent, list, (item) => effectiveItem(scratch, schema, item)).ids : [];
    };
    const { props, deferred } = checkProps(def, s.props ?? {}, scratch, `${at}.props`, issues, node?.props, itemIds);
    return { def, ref, props, deferred, variants, defId: def.id, publicId: publicIdOf(r) };
  });
  // A block sent as a section cannot be repaired away (a repair replaces an index, never removes one): the page is sent again.
  const repairNote = compiled.some((c, i) => !c && isThemeBlock(themeDesign(scratch, sections[i].componentId)))
    ? 'Nothing was applied. Call again without repair, with the page’s sections and no block among them.'
    : 'Nothing was applied. Call again with repair: true and only the named sections, each with its index; the other sections are kept.';
  if (issues.length) {
    keepDraft();
    return fieldError(issues, repairNote);
  }
  const good = compiled as Array<NonNullable<(typeof compiled)[number]>>;

  // Compile: page, removals, sections in their final order, navigation, then links waiting for this page.
  const owner = { kind: 'page' as const, id: pageId };
  const ops: EditOperation[] = [];
  const opSection: Array<number | null> = [];
  const push = (op: EditOperation, section: number | null = null) => {
    ops.push(op);
    opSection.push(section);
  };
  // A language and a translation are set together, so a new version can join its translations in its own language.
  // A dated article's details go as page.update takes them.
  const article = Object.fromEntries(ARTICLE_KEYS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
  const settings = {
    ...(!createOp && args.title && args.title.trim() !== page!.title ? { title: args.title.trim() } : {}),
    ...(args.navLabel !== undefined ? { navLabel: args.navLabel } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
    ...(args.seoTitle !== undefined ? { seoTitle: args.seoTitle } : {}),
    ...(args.socialImage !== undefined ? { socialImage: image || null } : {}),
    ...(args.noindex !== undefined ? { noindex: args.noindex } : {}),
    ...(args.canonical !== undefined ? { canonical: args.canonical } : {}),
    ...(args.draft !== undefined ? { draft: args.draft } : {}),
    ...(args.language !== undefined ? { language: args.language.trim() } : {}),
    ...(linkTranslationTo !== undefined ? { linkTranslationTo } : {}),
    ...article
  };
  if (createOp) push(createOp);
  if (Object.keys(settings).length) push({ type: 'page.update', pageId, ...settings });

  for (const id of plan.removed) push({ type: 'node.remove', owner, nodeId: id });
  const order = (page?.rootIds ?? []).filter((id) => !plan.removed.includes(id));
  // Places this call gives a value of its own. A link still waiting there is replaced by that value, never
  // filled later; an item field left out keeps its waiting link.
  const written = new Set<string>();
  const slotKey = (nodeId: string, prop: string, itemId = '', field = '') => JSON.stringify([nodeId, prop, itemId, field]);
  const superseded = (p: PendingLink) => p.pageId === pageId && written.has(slotKey(p.nodeId, p.prop, p.itemId, p.field));
  const insertAt = new Map<number, number>();
  if (args.sections) {
    plan.slots.forEach((slot, position) => {
      if (slot.kind === 'new') {
        const c = good[slot.section];
        insertAt.set(ops.length, slot.section);
        push({ type: 'node.insert', owner, index: position, ...c.ref, ...(c.variants ? { variants: c.variants } : {}), props: c.props }, slot.section);
        order.splice(position, 0, `new:${slot.section}`);
        return;
      }
      if (order[position] !== slot.id) {
        order.splice(order.indexOf(slot.id), 1);
        order.splice(position, 0, slot.id);
        push({ type: 'node.move', owner, nodeId: slot.id, parentId: null, index: position }, slot.section ?? null);
      }
      if (slot.section === undefined) return;
      const c = good[slot.section];
      const node = page!.nodes[slot.id] as InstanceNode;
      const props = scratch.components[node.definitionId]?.properties ?? {};
      for (const [prop, value] of Object.entries(c.props)) {
        const schema = Object.hasOwn(props, prop) ? props[prop] : undefined;
        const stored = node.props[prop];
        if (schema?.type === 'list' && Array.isArray(value) && Array.isArray(stored)) {
          const merged = withStoredFields(schema, value, stored, (item) => effectiveItem(scratch, schema, item));
          const def = scratch.components[node.definitionId];
          merged.ids.forEach((id, i) => {
            if (!id) return;
            for (const f of Object.keys(value[i] as object)) if (f !== 'id') written.add(slotKey(slot.id, prop, id, f));
            // An item whose visible email or phone changes carries the link that opened it, as an edit to it would.
            for (const link of followStoredLinks(def, prop, (stored as ListItem[]).find((x) => x.id === id), value[i], merged.items[i])) written.add(slotKey(slot.id, prop, id, link));
          });
          push({ type: 'instance.setProp', owner, nodeId: slot.id, prop, value: merged.items }, slot.section);
          continue;
        }
        // An object merges what is sent over what it holds: only the fields sent are written.
        if (schema?.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) for (const f of Object.keys(value)) written.add(slotKey(slot.id, prop, '', f));
        else written.add(slotKey(slot.id, prop));
        push({ type: 'instance.setProp', owner, nodeId: slot.id, prop, value }, slot.section);
      }
      // One choice per axis, so tone and layout set together each keep the other.
      for (const [axis, variant] of Object.entries(c.variants ?? {})) push({ type: 'instance.setVariant', owner, nodeId: slot.id, variant, axis }, slot.section);
    });
  }

  // A new article opens with its header, which shows the page's title, date, byline and excerpt, unless the call
  // places one (the theme's or a copy of it) itself.
  if (createOp && args.articleDate !== undefined && catalogueComponent(scratch.site.themeId, ARTICLE_HEADER) && !good.some((c) => isArticleHeader(scratch, c.def, c.props))) push({ type: 'node.insert', owner, index: 0, componentId: ARTICLE_HEADER });

  // Everything compiled so far, on a draft: an engine error is reported against its section.
  for (const [i, op] of ops.entries()) {
    if (op === createOp) continue;
    try {
      applyOperation(scratch, op);
    } catch (e) {
      const section = opSection[i];
      keepDraft();
      return fieldError([{ field: section === null ? 'page' : `sections[${section}]`, message: (e as Error).message }], section === null ? 'Nothing was applied.' : repairNote);
    }
  }
  const label = args.navLabel || page?.navLabel || title;
  const nav: Record<string, string> = {};
  /** The menu links this call asked for: a run limited to the page may add these to the shared menus, and no more. */
  const navigation: EditOperation[] = [];
  for (const [shell, wanted] of [['header', args.addToHeaderNav], ['footer', args.addToFooterNav]] as const) {
    if (!wanted) continue;
    const r = navOps(scratch, shell, pageId, label);
    nav[shell] = r.status;
    for (const op of r.ops) {
      try {
        applyOperation(scratch, op);
      } catch (e) {
        keepDraft();
        return fieldError([{ field: shell === 'header' ? 'addToHeaderNav' : 'addToFooterNav', message: (e as Error).message }], 'Nothing was applied. Use a shorter navLabel, or leave this page out of that menu.');
      }
      push(op);
      navigation.push(op);
    }
  }
  const pending = pendingLinkOps(scratch, memory, route, pageId, superseded, limit?.pageId);
  for (const op of pending.ops) push(op);

  if (!ops.length) return { ok: true, content: { ok: true, pageId, route, created: false, revision: host.revision(), note: 'Nothing needed to change.' } };

  const res = await host.apply(ops, host.revision(), createOp ? `Add page ${title}` : `Update ${title}`, callId, { navigation });
  if (!res.ok) {
    keepDraft();
    return applyFailure(res);
  }

  // Record where this page's sections landed, and any links waiting for pages not built yet.
  const results = (res.results ?? []) as Array<{ nodeId?: string }>;
  const nodeFor = new Map<number, string>();
  plan.slots.forEach((slot) => {
    if (slot.kind === 'keep' && slot.section !== undefined) nodeFor.set(slot.section, slot.id);
  });
  for (const [opIndex, section] of insertAt) if (results[opIndex]?.nodeId) nodeFor.set(section, results[opIndex].nodeId!);
  const after = host.state();
  const saved = after.pages[pageId];
  // Links this call replaced, and any on this page whose place is gone or holds a value now, wait no longer.
  memory.pendingLinks = memory.pendingLinks.filter((p) => !pending.filled.includes(p) && !superseded(p) && (p.pageId !== pageId || stillWaiting(after, p)));
  good.forEach((c, i) => {
    const nodeId = nodeFor.get(i);
    if (!nodeId) return;
    for (const d of c.deferred) {
      if (d.itemIndex === undefined) {
        memory.pendingLinks.push({ route: d.route, pageId, nodeId, prop: d.prop, ...(d.field !== undefined ? { field: d.field } : {}) });
        continue;
      }
      const list = (saved?.nodes[nodeId] as InstanceNode | undefined)?.props[d.prop] as ListItem[] | undefined;
      const itemId = list?.[d.itemIndex]?.id;
      if (itemId) memory.pendingLinks.push({ route: d.route, pageId, nodeId, prop: d.prop, itemId, field: d.field });
    }
  });
  memory.drafts.delete(route);

  const waiting = [...new Set(memory.pendingLinks.map((p) => p.route))].filter((r) => !pageAtRoute(after, r));
  const fullNav = Object.entries(nav).filter(([, s]) => s === 'full').map(([k]) => k);
  const content = {
    ok: true,
    pageId,
    route,
    created: !page,
    revision: res.revision,
    sections: good.map((c, i) => ({ index: i, nodeId: nodeFor.get(i), componentId: c.def.componentId ?? c.def.id })),
    ...(Object.keys(nav).length ? { navigation: nav } : {}),
    ...(plan.kept.length ? { keptSections: plan.kept } : {}),
    ...(waiting.length ? { linksWaitingForPages: waiting } : {}),
    ...(fullNav.length ? { warnings: [`The ${fullNav.join(' and ')} navigation is full, so no link was added.`] } : {})
  };
  return { ok: true, mutated: true, ops, results: res.results, content };
}

/**
 * A section as a small model's page tool offers it, or null when it is left out: the catalogue sections marked
 * `fullListingOnly` wait until the project has them installed, and the options marked so leave their axes (never an
 * axis default, which a placement may already show). `def` is the definition the tool would type the section by.
 */
export function focusedListing(state: ProjectState, def: ComponentDefinition): ComponentDefinition | null {
  if (def.fullListingOnly && def.owner === 'theme' && !Object.hasOwn(state.components, def.id)) return null;
  const axes = def.variantAxes;
  const dropped = (a: VariantAxis, id: string) => !!a.options[id]?.fullListingOnly && id !== a.default;
  if (!axes || !Object.values(axes).some((a) => a && Object.keys(a.options ?? {}).some((id) => dropped(a, id)))) return def;
  return { ...def, variantAxes: Object.fromEntries(Object.entries(axes).map(([axis, a]) => [axis, { ...a, options: Object.fromEntries(Object.entries(a.options).filter(([id]) => !dropped(a, id))) }])) };
}

/** Tool schema for one project: each section is typed by its component, with closed props. */
/** `only`: the route of the one page a run may build; the call then cannot link the page to a translation either. */
/** `focused`: a small model's run, whose tool lists only what focusedListing keeps. */
export function upsertToolSchema(state: ProjectState, only?: string, focused = false): JsonSchema {
  // A section that lists a collection's posts shows nothing until the project has a collection: it is offered from then.
  const offered = (d: ComponentDefinition) => hasCollections(state) || !listsEntries(d);
  const listed = (d: ComponentDefinition): ComponentDefinition[] => {
    const kept = focused ? focusedListing(state, d) : d;
    return kept ? [kept] : [];
  };
  const defs: ComponentDefinition[] = [
    // A theme component already in the project is typed as installed, as the section check reads it: a newer
    // theme's properties (a heading level, say) are not there until Project health updates it.
    ...catalogueEntries(state.site.themeId).flatMap((e) => {
      const d = themeDesign(state, e.componentId);
      // A block goes inside a section, not among the page's sections.
      return d && offered(d) && !isThemeBlock(d) ? listed(d) : [];
    }),
    ...Object.values(state.components).filter((d) => d.owner === 'project' && d.category !== 'shell').flatMap(listed)
  ];
  const section = {
    oneOf: defs.map((d) => {
      const variants = [...new Set(variantOptions(d).map((o) => o.id))];
      const byAxis = variantsJsonSchema(d);
      return {
        type: 'object',
        properties: {
          componentId: { type: 'string', enum: [d.owner === 'project' ? d.id : d.componentId] },
          index: { type: 'integer', minimum: 0 },
          ...(variants.length ? { variant: { type: 'string', enum: variants } } : {}),
          ...(byAxis ? { variants: byAxis } : {}),
          props: compactPropsSchema(d)
        },
        required: ['componentId'],
        additionalProperties: false
      };
    })
  };
  // Defined only where a required image refers to it: every byte here is sent with each constrained request.
  const requiredImage = JSON.stringify(section).includes('"#/$defs/requiredImage"');
  return {
    type: 'object',
    $defs: { image: IMAGE_SCHEMA, ...(requiredImage ? { requiredImage: REQUIRED_IMAGE_SCHEMA } : {}) },
    properties: {
      slug: { type: 'string', maxLength: SLUG_CHARS, description: only ? `This request may build only the page at ${only}: use "${only}".` : 'Page path such as "services". "home" is the home page.' },
      title: { type: 'string', maxLength: 80 },
      navLabel: { type: 'string', maxLength: 40 },
      description: { type: 'string', maxLength: 320, description: 'Search engine description.' },
      seoTitle: { type: 'string', maxLength: TEXT_LIMITS.seoTitle, description: SEO_TITLE_DESCRIPTION },
      socialImage: { type: 'string', maxLength: 200, description: SOCIAL_IMAGE_DESCRIPTION },
      noindex: { type: 'boolean', description: NOINDEX_DESCRIPTION },
      canonical: { type: 'string', maxLength: CANONICAL_URL_MAX, description: CANONICAL_DESCRIPTION },
      draft: { type: 'boolean', description: DRAFT_DESCRIPTION },
      language: { type: 'string', maxLength: 20, description: LANGUAGE_DESCRIPTION },
      ...(only ? {} : { translationOf: { type: 'string', maxLength: 120, description: TRANSLATION_DESCRIPTION } }),
      articleDate: { type: 'string', description: ARTICLE_DATE_DESCRIPTION },
      byline: { type: 'string', maxLength: 80 },
      excerpt: { type: 'string', maxLength: 320 },
      newsHidden: { type: 'boolean' },
      addToHeaderNav: { type: 'boolean', description: 'true adds a header link if missing (a child page\'s goes under its parent\'s). false or omitted leaves navigation as it is.' },
      addToFooterNav: { type: 'boolean', description: 'true adds a footer link if missing. false or omitted leaves navigation as it is.' },
      removeOtherSections: { type: 'boolean', description: 'Remove existing sections (theme or project components) that are not in this list. Use it when a draft of the whole page replaces a title-only introduction or starter sample sections, or the user asks to replace the page; omit it to add to a page or to keep sections the author wrote. Hand-built layout stays.' },
      sections: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_SECTIONS,
        items: section,
        description:
          'The page, top to bottom. variant picks one option; variants picks one per axis, such as { "tone": "muted", "layout": "two-columns" }, and axes left out keep their choice. Link props are strings: a route such as /contact/, an https:// URL, mailto:, tel:, #anchor, or "". Rich text is a string with blank lines between paragraphs.'
      },
      repair: { type: 'boolean', description: 'After an error: sections holds only the failed sections, each with the index the error named.' }
    },
    required: ['slug'],
    additionalProperties: false
  };
}
