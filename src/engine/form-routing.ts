/**
 * What the assistant never does without the user's say (#1128): change where a contact form sends visitors' messages.
 * Checked at commit (main/project/session.ts), against the project as an AI batch would leave it, so it holds however
 * the batch gets there: a placement's own settings, a design's defaults, a design that passes a setting on (and what
 * it passes), a copy, a layout, or code that places a form. Only the project as it was before the batch is trusted,
 * and the designs the app ships as it ships them. The user allows exactly the changes they were shown (FormRoutingGrant).
 */
import type { ComponentDefinition, GraphNode, NodeTree, ProjectState } from '@shared/types';
import { listThemes } from '@catalogue/index';
import { codeImports } from './code-imports';
import { EMPTY_ROUTING, formDestinationProps, propDefault, routingText } from './form-destinations';
import { allTrees, findParent } from './tree';

type Instance = Extract<GraphNode, { kind: 'instance' }>;

/**
 * One way a batch changes where a form sends: a placement's `setting`, a design's `default` (which new placements
 * start with), a placement swapped into or out of a `design` that decides it, or the `code` of one that does.
 */
export interface FormRoutingChange {
  kind: 'setting' | 'default' | 'design' | 'code';
  /** The design the setting, default or code belongs to, and its name. */
  definitionId: string;
  name: string;
  /** Where the placement is, in the user's words ("on “Home”"); absent for a design's own default or code. */
  where?: string;
  /** The setting, as its design labels it, and what it would be: the placement's own value or its design's default. */
  prop?: string;
  label?: string;
  value?: unknown;
  /** The change itself, as a grant names it: the same change made again (new IDs and all) has the same key. */
  key: string;
}

/**
 * What the user allowed when the app asked them (agent/orchestrator.ts): exactly the batch they were asked about,
 * as session.apply fingerprints it, making exactly those changes. Only the main process gives one.
 */
export interface FormRoutingGrant {
  operations: string;
  changes: string[];
}

/** What a batch refused for its form changes asks the user about: the batch, as session.apply fingerprints it, and its changes. */
export interface FormRoutingReview {
  operations: string;
  changes: FormRoutingChange[];
}

/** The review a refusal carries (session.apply's SCOPE_MISMATCH for a form's changes), or null for any other refusal. */
export function formRoutingReview(error: { code?: string; details?: unknown } | undefined): FormRoutingReview | null {
  const r = error?.code === 'SCOPE_MISMATCH' && error.details && typeof error.details === 'object' ? (error.details as { formRouting?: unknown }).formRouting : undefined;
  if (!r || typeof r !== 'object') return null;
  const { operations, changes } = r as Partial<FormRoutingReview>;
  return typeof operations === 'string' && Array.isArray(changes) && changes.length > 0 ? { operations, changes } : null;
}

/** What allowing the changes a review names grants: that batch, making exactly those changes. */
export const formRoutingGrant = (review: FormRoutingReview): FormRoutingGrant => ({ operations: review.operations, changes: review.changes.map((c) => c.key) });

/** Whether `changes` are all ones `grant` allows, for the batch `operations` fingerprints. */
export function formRoutingGranted(changes: readonly FormRoutingChange[], operations: string, grant: FormRoutingGrant | undefined): boolean {
  if (!changes.length) return true;
  if (!grant || grant.operations !== operations) return false;
  const allowed = new Set(grant.changes);
  return changes.every((c) => allowed.has(c.key));
}

/**
 * Whether a design is one the app ships, exactly as it ships it: a theme's own contact form, say, installed with its
 * first placement. Its defaults and code are the app's, not the batch's. An installed pack's are not.
 */
function shipped(def: ComponentDefinition): boolean {
  if (def.owner !== 'theme') return false;
  const props = JSON.stringify(def.properties);
  return listThemes().some((t) => t.source !== 'user' && t.components.some((c) => c.id === def.id && c.kind === def.kind && c.source === def.source && JSON.stringify(c.properties) === props));
}

/**
 * The list a node's `$item` bindings read: its nearest repeat's. The same binding inside another repeat of the same
 * design reads another list's items, so moving a form between two repeats changes where it sends.
 */
function repeatAround(tree: NodeTree, nodeId: string): string {
  let id = findParent(tree, nodeId)?.parentId;
  for (let guard = Object.keys(tree.nodes).length; id && guard >= 0; guard--) {
    const n = tree.nodes[id];
    if (n?.kind === 'repeat') return JSON.stringify(n.list ?? null);
    id = findParent(tree, id)?.parentId;
  }
  return '';
}

/**
 * A placement's setting as text to compare: its own value or its design's default, where an item's field is read
 * from, and the collection a list is connected to, whose entries then stand in for its items.
 */
function valueOf(state: ProjectState, tree: NodeTree, n: Instance, prop: string): string {
  const own = n.props && Object.hasOwn(n.props, prop) ? n.props[prop] : undefined;
  const value = own ?? propDefault(Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined, prop);
  const text = routingText(value);
  const read = text.includes('"$item"') ? `${text}\u0000${repeatAround(tree, n.id)}` : text;
  const source = n.listSources && Object.hasOwn(n.listSources, prop) ? n.listSources[prop] : undefined;
  return source === undefined ? read : `${read}\u0000${JSON.stringify(source)}`;
}

const resolved = (state: ProjectState, n: Instance, prop: string): unknown => (n.props && Object.hasOwn(n.props, prop) ? n.props[prop] : undefined) ?? propDefault(state.components[n.definitionId], prop);

/** The designs that place a contact form, however deep: a form, a design with one in it, and code that imports one. */
function formBearing(state: ProjectState, protectedProps: Map<string, Set<string>>): Set<string> {
  const out = new Set(protectedProps.keys());
  const defs = Object.values(state.components);
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of defs) {
      if (out.has(d.id)) continue;
      const places = d.kind === 'code' ? [...out].some((id) => codeImports(state, d, id)) : Object.values(d.tree?.nodes ?? {}).some((n) => n.kind === 'instance' && out.has(n.definitionId));
      if (!places) continue;
      out.add(d.id);
      changed = true;
    }
  }
  return out;
}

const codeOf = (d: ComponentDefinition | undefined) => (d?.kind === 'code' ? `${d.source ?? ''}\u0000${JSON.stringify(d.dependencies ?? [])}` : null);

/**
 * Every way `after` changes where a contact form sends its messages, compared with `before`, for a batch the
 * assistant made. A placement that was there before keeps each setting that decides it (a binding read in the same
 * place), and is never swapped into or out of a design that has such settings. A new one (inserted, copied, built
 * into a new design or a layout) starts as a fresh form does, with nothing set beyond its design's defaults, or as a
 * copy of one placement of the same design before, every setting as that one had it: settings are never mixed from
 * different placements. A design's defaults for those settings stay as they were, and a new design has none. Code
 * that places a form, or is one, is never written. Removing a form changes where nothing sends.
 */
export function formRoutingChanges(before: ProjectState, after: ProjectState): FormRoutingChange[] {
  const was = formDestinationProps(before);
  const is = formDestinationProps(after);
  if (!was.size && !is.size) return [];
  const out: FormRoutingChange[] = [];
  const seen = new Set<string>();
  const add = (c: Omit<FormRoutingChange, 'key'>, value: string) => {
    const key = [c.kind, c.definitionId, c.prop ?? '', value].join('\u0000');
    if (seen.has(`${key}\u0000${c.where ?? ''}`)) return;
    seen.add(`${key}\u0000${c.where ?? ''}`);
    out.push({ ...c, key });
  };
  const nameOf = (state: ProjectState, id: string) => (Object.hasOwn(state.components, id) ? state.components[id].name : 'a contact form');
  const labelOf = (id: string, prop: string) => {
    const schema = Object.hasOwn(after.components, id) ? after.components[id].properties[prop] : undefined;
    return typeof schema?.label === 'string' && schema.label ? schema.label : prop;
  };
  const props = (id: string) => [...(is.get(id) ?? [])].sort();
  const trusted = new Map<string, boolean>();
  const isShipped = (d: ComponentDefinition) => trusted.get(d.id) ?? (trusted.set(d.id, shipped(d)), trusted.get(d.id)!);

  // Code decides in its source what it sends where: code that places a form, or is one, before or after, is never
  // written, apart from the code the app ships.
  const rewritten = Object.values(after.components).filter((d) => codeOf(d) !== null && codeOf(d) !== codeOf(before.components[d.id]) && !isShipped(d));
  if (rewritten.length) {
    const bears = formBearing(after, is);
    const bore = formBearing(before, was);
    for (const d of rewritten) if (bears.has(d.id) || bore.has(d.id)) add({ kind: 'code', definitionId: d.id, name: d.name }, codeOf(d)!);
  }

  // What a new placement may start as, by design: a copy of one placement before, setting for setting, or its
  // design's defaults (as they were, or as the app ships them) with any setting left empty.
  const copies = new Map<string, Set<string>>();
  const defaults = new Map<string, Map<string, Set<string>>>();
  const placed = new Map<string, { n: Instance; tree: NodeTree }>();
  for (const { owner, tree } of allTrees(before)) {
    for (const n of Object.values(tree.nodes)) {
      if (n.kind !== 'instance') continue;
      placed.set(`${owner.kind}:${owner.id}:${n.id}`, { n, tree });
      const ps = props(n.definitionId);
      if (!ps.length) continue;
      const set = copies.get(n.definitionId) ?? new Set<string>();
      copies.set(n.definitionId, set.add(ps.map((p) => valueOf(before, tree, n, p)).join('\u0001')));
    }
  }
  for (const [id] of is) {
    const by = new Map<string, Set<string>>();
    for (const p of props(id)) {
      const ok = new Set<string>();
      if (Object.hasOwn(before.components, id)) ok.add(routingText(propDefault(before.components[id], p)));
      if (isShipped(after.components[id])) ok.add(routingText(propDefault(after.components[id], p)));
      by.set(p, ok);
    }
    defaults.set(id, by);
  }

  for (const { owner, tree, label } of allTrees(after)) {
    const where = owner.kind === 'page' ? `on “${label}”` : owner.kind === 'shell' ? `in the ${label.toLowerCase()}` : owner.kind === 'component' ? `in the “${label}” design` : `in “${label}”`;
    for (const n of Object.values(tree.nodes)) {
      if (n.kind !== 'instance') continue;
      const had = placed.get(`${owner.kind}:${owner.id}:${n.id}`);
      const prior = had?.n;
      const name = nameOf(after, n.definitionId);
      // Swapped for another design, into or out of one that decides where a form sends: what the new design does with
      // what carries over is its own. Only the app's own form taking another's place (switching themes swaps the
      // theme's form for the new theme's) keeps where it sends, as long as every setting reads as it did.
      if (prior && prior.definitionId !== n.definitionId) {
        if (!was.has(prior.definitionId) && !is.has(n.definitionId)) continue;
        const swapped = Object.hasOwn(after.components, n.definitionId) ? after.components[n.definitionId] : undefined;
        const settings = new Set([...(was.get(prior.definitionId) ?? []), ...(is.get(n.definitionId) ?? [])]);
        const carried = !!swapped && isShipped(swapped) && [...settings].every((p) => valueOf(after, tree, n, p) === valueOf(before, had!.tree, prior, p));
        if (!carried) add({ kind: 'design', definitionId: n.definitionId, name, where, value: nameOf(before, prior.definitionId) }, prior.definitionId);
        continue;
      }
      const ps = props(n.definitionId);
      if (!ps.length) continue;
      const now = ps.map((p) => valueOf(after, tree, n, p));
      const report = (p: string) => add({ kind: 'setting', definitionId: n.definitionId, name, where, prop: p, label: labelOf(n.definitionId, p), value: resolved(after, n, p) }, valueOf(after, tree, n, p));
      if (prior) {
        ps.forEach((p, i) => now[i] !== valueOf(before, had!.tree, prior, p) && report(p));
        continue;
      }
      if (copies.get(n.definitionId)?.has(now.join('\u0001'))) continue;
      const fresh = defaults.get(n.definitionId);
      const off = ps.filter((p, i) => !EMPTY_ROUTING.has(now[i]) && !fresh?.get(p)?.has(now[i]));
      off.forEach(report);
    }
  }

  // A design's defaults, which every placement without its own value sends with, and every new one starts with.
  for (const [id, set] of is) {
    const def = after.components[id];
    if (isShipped(def)) continue;
    const prev = Object.hasOwn(before.components, id) ? before.components[id] : undefined;
    for (const p of new Set([...set, ...(was.get(id) ?? [])])) {
      const value = propDefault(def, p);
      const text = routingText(value);
      if (prev ? text === routingText(propDefault(prev, p)) : EMPTY_ROUTING.has(text)) continue;
      add({ kind: 'default', definitionId: id, name: def.name, prop: p, label: labelOf(id, p), value }, text);
    }
  }

  return out;
}

const shown = (value: unknown): string => {
  if (EMPTY_ROUTING.has(routingText(value))) return 'is cleared';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `becomes ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`;
};

/** One change, in the user's words. */
function describe(c: FormRoutingChange): string {
  if (c.kind === 'setting') return `“${c.name}” ${c.where}: its ${c.label} ${shown(c.value)}.`;
  if (c.kind === 'default') return `The “${c.name}” design: the ${c.label} new placements start with ${shown(c.value)}.`;
  if (c.kind === 'design') return `“${c.value as string}” ${c.where} becomes “${c.name}”, a design that decides where it sends.`;
  return `The code of “${c.name}”, which places a contact form, changes.`;
}

/** How many changes the question lists one by one; the rest are counted. */
const LISTED = 4;

/**
 * The question the app asks before an AI batch changes where a form sends (agent/orchestrator.ts): in the app's own
 * words, naming every change, never the model's. `allow` is the answer that allows it.
 */
export function formRoutingQuestion(changes: readonly FormRoutingChange[]): { text: string; choices: [keep: string, allow: string]; allow: string } {
  const many = changes.length > 1;
  const listed = changes.slice(0, LISTED).map(describe);
  const more = changes.length > LISTED ? ` And ${changes.length - LISTED} more.` : '';
  const allow = many ? 'Allow these changes' : 'Allow this change';
  return { text: `Let the assistant change where your contact ${many ? 'forms send' : 'form sends'} visitors’ messages? ${listed.join(' ')}${more}`, choices: ['Keep it as it is', allow], allow };
}

/** What a batch refused for its form changes tells the assistant. */
export function formRoutingRefusal(changes: readonly FormRoutingChange[]): string {
  return `Only the user can allow a change to where a contact form sends visitors’ messages. ${describe(changes[0])}${changes.length > 1 ? ` And ${changes.length - 1} more.` : ''} Nothing in this batch was applied.`;
}
