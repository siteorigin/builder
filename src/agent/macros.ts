/**
 * Site-building macro tools. One call describes a whole page; it compiles to one validated EditOperation
 * batch that goes through the same scope checks, validation and undo group as any other edit, so a small
 * model never has to carry page IDs or revisions from one turn to the next.
 */
import { findVariant, variantOptions } from '@shared/variants';
import { z } from 'zod';
import type { ComponentDefinition, InstanceNode, ListItem, LinkValue, PageDoc, ProjectState, PropSchema } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { normalizeRoute, validateRoute } from '@shared/routes';
import { newId } from '@shared/ids';
import { catalogueComponent, catalogueEntries } from '@catalogue/index';
import { applyOperation } from '@engine/apply';
import { normalizeProp, normalizeScalar } from '@engine/values';
import { compactPropsSchema, IMAGE_SCHEMA, type JsonSchema } from './propschema';
import type { ToolHost, ToolOutcome } from './tools';

const MAX_SECTIONS = 16;

export const SECTION_ARGS = z.object({
  componentId: z.string().min(1),
  index: z.number().int().min(0).optional().describe('With repair: the section index the error named.'),
  variant: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional()
});
export type SectionInput = Omit<z.infer<typeof SECTION_ARGS>, 'index'>;

export const UPSERT_ARGS = z.object({
  slug: z.string().min(1).max(120).describe('Page path such as "services" or "/about/team/". "home" or "/" is the home page.'),
  title: z.string().min(1).max(80).optional().describe('Page title. Defaults to one made from the slug for a new page.'),
  navLabel: z.string().max(40).optional(),
  description: z.string().max(320).optional().describe('Search engine description.'),
  addToHeaderNav: z.boolean().optional(),
  addToFooterNav: z.boolean().optional(),
  removeOtherSections: z.boolean().optional(),
  sections: z.array(SECTION_ARGS).min(1).max(MAX_SECTIONS).optional(),
  repair: z.boolean().optional().describe('After an error: sections holds only the failed sections, each with its index.')
});
export type UpsertArgs = z.infer<typeof UPSERT_ARGS>;

export const UPSERT_DESCRIPTION =
  'Create or update a whole page in one call, top to bottom, and wire navigation. No page IDs or revisions needed. On an existing page, a section with the same componentId is updated in place (props you omit keep their value; a list you send sets its items and their order, and an item keeps the fields you omit when it has its id from read_page or the same name or title as before); other existing sections stay unless removeOtherSections is true. Internal links may use the route of a page you have not built yet; they connect when that page is created. If a section is invalid, nothing is applied and the error names the section and field: call again with repair: true and only that section, with its index.';

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
  /** Finished calls by call ID: a replayed call returns its first result and changes nothing. */
  replay: Map<string, { args: string; ok: boolean; content: unknown }>;
}

export const newMacroMemory = (): MacroMemory => ({ drafts: new Map(), pendingLinks: [], replay: new Map() });

export interface FieldIssue {
  field: string;
  message: string;
}

export function fieldError(issues: FieldIssue[], note: string): ToolOutcome {
  return {
    ok: false,
    content: { error: 'VALIDATION_FAILED', message: `${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}. ${note}`, fields: issues }
  };
}

// ---------------------------------------------------------------------------
// Section checks
// ---------------------------------------------------------------------------

/** The definition a section's componentId names: a theme component, or a project component by definition ID. */
function sectionDefinition(state: ProjectState, id: string): { def: ComponentDefinition; ref: { componentId: string } | { definitionId: string } } | null {
  const themed = catalogueComponent(state.site.themeId, id);
  if (themed && themed.category !== 'shell') return { def: Object.hasOwn(state.components, themed.id) ? state.components[themed.id] : themed, ref: { componentId: id } };
  const own = Object.hasOwn(state.components, id) ? state.components[id] : undefined;
  if (own && own.owner === 'project' && own.category !== 'shell') return { def: own, ref: { definitionId: id } };
  return null;
}

const ROUTE_LIKE = /^\/?[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*\/?$/;

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

export interface DeferredLink {
  route: string;
  prop: string;
  itemIndex?: number;
  field?: string;
}

/**
 * Check a section's props with the engine's value normalizers, so every problem is reported with its exact
 * path. Returns the props to send, with routes resolved, and any links waiting for a page.
 */
export function checkProps(def: ComponentDefinition, props: Record<string, unknown>, state: ProjectState, path: string, issues: FieldIssue[]): { props: Record<string, unknown>; deferred: DeferredLink[] } {
  const out: Record<string, unknown> = {};
  const deferred: DeferredLink[] = [];
  for (const [k, v] of Object.entries(props)) {
    const schema: PropSchema | undefined = Object.hasOwn(def.properties, k) ? def.properties[k] : undefined;
    if (!schema) {
      issues.push({ field: `${path}.${k}`, message: `"${def.name}" has no property "${k}". Properties: ${Object.keys(def.properties).join(', ')}` });
      continue;
    }
    if (schema.type === 'link') {
      const r = resolveRouteLink(v, state);
      if (r.pendingRoute) deferred.push({ route: r.pendingRoute, prop: k });
      out[k] = r.value;
      checkValue(() => normalizeScalar(schema, r.value, state, schema.label), `${path}.${k}`, issues);
      continue;
    }
    if (schema.type === 'list' && Array.isArray(v)) {
      const before = issues.length;
      const items = v.map((it, i) => {
        const itemPath = `${path}.${k}[${i}]`;
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
          issues.push({ field: itemPath, message: 'expected an object' });
          return it;
        }
        const copy: Record<string, unknown> = {};
        for (const [f, x] of Object.entries(it)) {
          if (f === 'id') {
            copy.id = x;
            continue;
          }
          const fs = Object.hasOwn(schema.fields, f) ? schema.fields[f] : undefined;
          if (!fs) {
            issues.push({ field: `${itemPath}.${f}`, message: `${schema.itemLabel} has no field "${f}". Fields: ${Object.keys(schema.fields).join(', ')}` });
            continue;
          }
          let value = x;
          if (fs.type === 'link') {
            const r = resolveRouteLink(x, state);
            if (r.pendingRoute) deferred.push({ route: r.pendingRoute, prop: k, itemIndex: i, field: f });
            value = r.value;
          }
          copy[f] = value;
          checkValue(() => normalizeScalar(fs, value, state, fs.label), `${itemPath}.${f}`, issues);
        }
        return copy;
      });
      out[k] = items;
      // List-wide rules (length) are checked once its items are sound.
      if (issues.length === before) checkValue(() => normalizeProp(schema, items, state, schema.label), `${path}.${k}`, issues);
      continue;
    }
    out[k] = v;
    checkValue(() => normalizeProp(schema, v, state, schema.label), `${path}.${k}`, issues);
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
    if (schema?.type === 'list' && schema.fields.label?.type === 'string' && schema.fields.link?.type === 'link')
      return { node: n, max: schema.max, items: (n.props.links as ListItem[] | undefined) ?? [] };
  }
  return null;
}

function navOps(state: ProjectState, shell: 'header' | 'footer', pageId: string, label: string): { ops: EditOperation[]; status: 'added' | 'present' | 'full' | 'unavailable' } {
  const menu = shellLinks(state, shell);
  if (!menu) return { ops: [], status: 'unavailable' };
  if (menu.items.some((i) => (i.link as LinkValue | undefined)?.type === 'page' && (i.link as LinkValue).target === pageId)) return { ops: [], status: 'present' };
  if (menu.max !== undefined && menu.items.length >= menu.max) return { ops: [], status: 'full' };
  return { status: 'added', ops: [{ type: 'instance.listInsert', owner: { kind: 'shell', id: shell }, nodeId: menu.node.id, prop: 'links', item: { label, link: { type: 'page', target: pageId } } }] };
}

// ---------------------------------------------------------------------------
// Links waiting for a page
// ---------------------------------------------------------------------------

/** The value now stored where a pending link waits, or undefined if that place no longer exists. */
function pendingSlot(state: ProjectState, p: PendingLink): { value: unknown } | undefined {
  const node = Object.hasOwn(state.pages, p.pageId) ? state.pages[p.pageId].nodes[p.nodeId] : undefined;
  if (node?.kind !== 'instance') return undefined;
  if (!p.itemId) return { value: node.props[p.prop] };
  const item = ((node.props[p.prop] as ListItem[] | undefined) ?? []).find((i) => i.id === p.itemId);
  return item ? { value: item[p.field!] } : undefined;
}

/** A link is still waiting only while its place exists and holds the empty placeholder: a later edit wins. */
const stillWaiting = (state: ProjectState, p: PendingLink) => {
  const slot = pendingSlot(state, p);
  return !!slot && (slot.value as LinkValue | undefined)?.type === 'none';
};

function pendingLinkOps(state: ProjectState, memory: MacroMemory, route: string, pageId: string): { ops: EditOperation[]; filled: PendingLink[] } {
  const ops: EditOperation[] = [];
  const filled: PendingLink[] = [];
  for (const p of memory.pendingLinks) {
    if (p.route !== route) continue;
    filled.push(p);
    if (!stillWaiting(state, p)) continue;
    ops.push({
      type: 'instance.setProp',
      owner: { kind: 'page', id: p.pageId },
      nodeId: p.nodeId,
      prop: p.prop,
      ...(p.itemId ? { itemId: p.itemId, field: p.field } : {}),
      value: { type: 'page', target: pageId }
    });
  }
  return { ops, filled };
}

/** Connect links whose page now exists, however that page was made. Returns the routes still missing. */
export async function connectPendingLinks(host: ToolHost, memory: MacroMemory, key: string): Promise<{ outcome?: ToolOutcome; missing: string[]; error?: string }> {
  const state = host.state();
  memory.pendingLinks = memory.pendingLinks.filter((p) => stillWaiting(state, p));
  const ops: EditOperation[] = [];
  const filled: PendingLink[] = [];
  for (const route of new Set(memory.pendingLinks.map((p) => p.route))) {
    const page = pageAtRoute(state, route);
    if (!page) continue;
    const r = pendingLinkOps(state, memory, route, page.id);
    ops.push(...r.ops);
    filled.push(...r.filled);
  }
  let outcome: ToolOutcome | undefined;
  if (ops.length) {
    const res = await host.apply(ops, host.revision(), 'Connect page links', key);
    if (!res.ok) return { missing: [...new Set(memory.pendingLinks.map((p) => p.route))], error: res.error?.message ?? 'The links could not be connected.' };
    outcome = { ok: true, mutated: true, ops, results: res.results, content: { ok: true } };
  }
  memory.pendingLinks = memory.pendingLinks.filter((p) => !filled.includes(p));
  return { outcome, missing: [...new Set(memory.pendingLinks.map((p) => p.route))] };
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
 * copy, a custom or code component) the tool lists. Anything else, such as hand-built layout, is never removed by it.
 */
function expressible(state: ProjectState, page: PageDoc, id: string): boolean {
  const n = page.nodes[id];
  if (n?.kind !== 'instance') return false;
  const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
  return def?.owner === 'theme' || (def?.owner === 'project' && def.category !== 'shell');
}

/**
 * A list sent for an existing section sets which items there are and their order, but an item keeps the stored
 * fields it leaves out. It is the stored item with its id or, when it has no id, the one item with the same
 * title (the list's titleField). Never by position: a reordered or replaced list must not move a portrait or
 * link to another item. An unmatched item is new and starts from the field defaults.
 */
function withStoredFields(schema: Extract<PropSchema, { type: 'list' }>, sent: unknown[], stored: ListItem[]): unknown[] {
  const items = stored.filter((i): i is ListItem => !!i && typeof i === 'object' && typeof i.id === 'string');
  const byId = new Map(items.map((i) => [i.id, i]));
  const sentId = (it: unknown) => (it && typeof it === 'object' && typeof (it as ListItem).id === 'string' ? (it as ListItem).id : undefined);
  const used = new Set<string>();
  // Items that name their id claim it first, so a title can never take an item another one asked for.
  const matched = sent.map((it) => {
    const id = sentId(it);
    if (id === undefined || !byId.has(id) || used.has(id)) return undefined;
    used.add(id);
    return byId.get(id);
  });
  const field = schema.titleField;
  if (field) {
    const titleOf = (it: unknown) => {
      const t = it && typeof it === 'object' ? (it as Record<string, unknown>)[field] : undefined;
      return typeof t === 'string' && t.trim() ? t : undefined;
    };
    const count = (list: unknown[], t: string) => list.filter((x) => titleOf(x) === t).length;
    sent.forEach((it, i) => {
      const t = titleOf(it);
      if (matched[i] || sentId(it) !== undefined || t === undefined || count(sent, t) !== 1 || count(items, t) !== 1) return;
      const old = items.find((x) => titleOf(x) === t)!;
      if (used.has(old.id)) return;
      used.add(old.id);
      matched[i] = old;
    });
  }
  return sent.map((it, i) => (matched[i] ? { ...matched[i], ...(it as Record<string, unknown>), id: matched[i]!.id } : it));
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

export async function runUpsert(rawArgs: UpsertArgs, host: ToolHost, callId: string, memory: MacroMemory): Promise<ToolOutcome> {
  const fingerprint = JSON.stringify(rawArgs);
  const prior = memory.replay.get(callId);
  if (prior) {
    if (prior.args === fingerprint) return { ok: prior.ok, content: prior.content };
    return { ok: false, content: { error: 'INVALID_ARGUMENT', message: 'That tool call ID was already used for a different request.' } };
  }
  const outcome = await compileAndApply(rawArgs, host, callId, memory);
  memory.replay.set(callId, { args: fingerprint, ok: outcome.ok, content: outcome.content });
  return outcome;
}

async function compileAndApply(rawArgs: UpsertArgs, host: ToolHost, callId: string, memory: MacroMemory): Promise<ToolOutcome> {
  const state = host.state();
  const found = findPage(state, rawArgs.slug);
  if (found.error) return fieldError([{ field: 'slug', message: found.error }], 'Nothing was applied.');
  const { route, page } = found;

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
  const compiled = sections.map((s, i) => {
    const at = `sections[${i}]`;
    const resolved = sectionDefinition(scratch, s.componentId);
    if (!resolved) {
      const names = catalogueEntries(state.site.themeId).map((e) => e.componentId).join(', ');
      issues.push({ field: `${at}.componentId`, message: `unknown component "${s.componentId}". Components: ${names}` });
      return null;
    }
    const { def, ref } = resolved;
    if (s.variant !== undefined && 'error' in findVariant(def, s.variant))
      issues.push({ field: `${at}.variant`, message: `"${def.name}" has no variant "${s.variant}". Variants: ${[...new Set(variantOptions(def).map((o) => o.id))].join(', ') || 'none'}` });
    const { props, deferred } = checkProps(def, s.props ?? {}, scratch, `${at}.props`, issues);
    // Only a catalogue request may match another definition of the same component; a project one names its own.
    return { def, ref, props, deferred, variant: s.variant, defId: def.id, publicId: 'componentId' in ref ? def.componentId : undefined };
  });
  const repairNote = 'Nothing was applied. Call again with repair: true and only the named sections, each with its index; the other sections are kept.';
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
  if (createOp) push(createOp);
  else if ((args.title && args.title.trim() !== page!.title) || args.navLabel !== undefined || args.description !== undefined) {
    push({
      type: 'page.update',
      pageId,
      ...(args.title && args.title.trim() !== page!.title ? { title: args.title.trim() } : {}),
      ...(args.navLabel !== undefined ? { navLabel: args.navLabel } : {}),
      ...(args.description !== undefined ? { description: args.description } : {})
    });
  }
  if (createOp && (args.navLabel !== undefined || args.description !== undefined))
    push({ type: 'page.update', pageId, ...(args.navLabel !== undefined ? { navLabel: args.navLabel } : {}), ...(args.description !== undefined ? { description: args.description } : {}) });

  const plan = planSections(scratch, page, good, !!args.removeOtherSections && !!args.sections);
  for (const id of plan.removed) push({ type: 'node.remove', owner, nodeId: id });
  const order = (page?.rootIds ?? []).filter((id) => !plan.removed.includes(id));
  const insertAt = new Map<number, number>();
  if (args.sections) {
    plan.slots.forEach((slot, position) => {
      if (slot.kind === 'new') {
        const c = good[slot.section];
        insertAt.set(ops.length, slot.section);
        push({ type: 'node.insert', owner, index: position, ...c.ref, ...(c.variant ? { variant: c.variant } : {}), props: c.props }, slot.section);
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
        const merged = schema?.type === 'list' && Array.isArray(value) && Array.isArray(stored) ? withStoredFields(schema, value, stored as ListItem[]) : value;
        push({ type: 'instance.setProp', owner, nodeId: slot.id, prop, value: merged }, slot.section);
      }
      if (c.variant) push({ type: 'instance.setVariant', owner, nodeId: slot.id, variant: c.variant }, slot.section);
    });
  }

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
    }
  }
  const pending = pendingLinkOps(scratch, memory, route, pageId);
  for (const op of pending.ops) push(op);

  if (!ops.length) return { ok: true, content: { ok: true, pageId, route, created: false, revision: host.revision(), note: 'Nothing needed to change.' } };

  const res = await host.apply(ops, host.revision(), createOp ? `Add page ${title}` : `Update ${title}`, callId);
  if (!res.ok) {
    keepDraft();
    return { ok: false, content: { ok: false, revision: res.revision, error: res.error } };
  }

  // Record where this page's sections landed, and any links waiting for pages not built yet.
  const results = (res.results ?? []) as Array<{ nodeId?: string }>;
  const nodeFor = new Map<number, string>();
  plan.slots.forEach((slot) => {
    if (slot.kind === 'keep' && slot.section !== undefined) nodeFor.set(slot.section, slot.id);
  });
  for (const [opIndex, section] of insertAt) if (results[opIndex]?.nodeId) nodeFor.set(section, results[opIndex].nodeId!);
  const saved = host.state().pages[pageId];
  // A value sent in this call replaces a link still waiting in the same place; an item field left out keeps it.
  const sectionOf = new Map([...nodeFor].map(([section, nodeId]) => [nodeId, section]));
  const superseded = (p: PendingLink) => {
    const section = p.pageId === pageId ? sectionOf.get(p.nodeId) : undefined;
    if (section === undefined || !Object.hasOwn(good[section].props, p.prop)) return false;
    if (!p.itemId) return true;
    const sent = good[section].props[p.prop];
    const at = ((saved?.nodes[p.nodeId] as InstanceNode | undefined)?.props[p.prop] as ListItem[] | undefined)?.findIndex((it) => it.id === p.itemId) ?? -1;
    const row = Array.isArray(sent) && at >= 0 ? sent[at] : undefined;
    return !!row && typeof row === 'object' && Object.hasOwn(row, p.field!);
  };
  memory.pendingLinks = memory.pendingLinks.filter((p) => !pending.filled.includes(p) && !superseded(p));
  good.forEach((c, i) => {
    const nodeId = nodeFor.get(i);
    if (!nodeId) return;
    for (const d of c.deferred) {
      if (d.itemIndex === undefined) {
        memory.pendingLinks.push({ route: d.route, pageId, nodeId, prop: d.prop });
        continue;
      }
      const list = (saved?.nodes[nodeId] as InstanceNode | undefined)?.props[d.prop] as ListItem[] | undefined;
      const itemId = list?.[d.itemIndex]?.id;
      if (itemId) memory.pendingLinks.push({ route: d.route, pageId, nodeId, prop: d.prop, itemId, field: d.field });
    }
  });
  memory.drafts.delete(route);

  const waiting = [...new Set(memory.pendingLinks.map((p) => p.route))];
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

/** Tool schema for one project: each section is typed by its component, with closed props. */
export function upsertToolSchema(state: ProjectState): JsonSchema {
  const defs: ComponentDefinition[] = [
    ...catalogueEntries(state.site.themeId).flatMap((e) => {
      const d = catalogueComponent(state.site.themeId, e.componentId);
      return d ? [d] : [];
    }),
    ...Object.values(state.components).filter((d) => d.owner === 'project' && d.category !== 'shell')
  ];
  const section = {
    oneOf: defs.map((d) => {
      const variants = [...new Set(variantOptions(d).map((o) => o.id))];
      return {
        type: 'object',
        properties: {
          componentId: { type: 'string', enum: [d.owner === 'project' ? d.id : d.componentId] },
          index: { type: 'integer', minimum: 0 },
          ...(variants.length ? { variant: { type: 'string', enum: variants } } : {}),
          props: compactPropsSchema(d)
        },
        required: ['componentId'],
        additionalProperties: false
      };
    })
  };
  return {
    type: 'object',
    $defs: { image: IMAGE_SCHEMA },
    properties: {
      slug: { type: 'string', maxLength: 120, description: 'Page path such as "services". "home" is the home page.' },
      title: { type: 'string', maxLength: 80 },
      navLabel: { type: 'string', maxLength: 40 },
      description: { type: 'string', maxLength: 320, description: 'Search engine description.' },
      addToHeaderNav: { type: 'boolean', description: 'true adds a header link if missing. false or omitted leaves navigation as it is.' },
      addToFooterNav: { type: 'boolean', description: 'true adds a footer link if missing. false or omitted leaves navigation as it is.' },
      removeOtherSections: { type: 'boolean', description: 'Remove existing sections (theme or project components) that are not in this list. Hand-built layout stays.' },
      sections: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_SECTIONS,
        items: section,
        description: 'The page, top to bottom. Link props are strings: a route such as /contact/, an https:// URL, mailto:, tel:, #anchor, or "". Rich text is a string with blank lines between paragraphs.'
      },
      repair: { type: 'boolean', description: 'After an error: sections holds only the failed sections, each with the index the error named.' }
    },
    required: ['slug'],
    additionalProperties: false
  };
}
