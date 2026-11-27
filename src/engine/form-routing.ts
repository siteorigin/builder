/**
 * What the assistant never does without the user's say (#1128): change where a contact form sends visitors' messages.
 * Checked at commit (main/project/session.ts), against the project as an AI batch would leave it, so it holds however
 * the batch gets there: a placement's own settings, a design's defaults, a design that passes a setting on (and what
 * it passes), a copy, a layout, or code that places a form. Only the project as it was before the batch is trusted,
 * and the designs the app ships as it ships them. The user allows exactly the changes they were shown (FormRoutingGrant).
 */
import type { FormRoutingPrompt } from '@shared/api';
import type { ComponentDefinition, GraphNode, NodeTree, ProjectState } from '@shared/types';
import { listThemes } from '@catalogue/index';
import { FORM_DESTINATIONS, FORM_PROVIDERS, FORM_SERVICES, sendsFormMessages } from '@shared/form-contract';
import { codeImports } from './code-imports';
import { EMPTY_ROUTING, formDestinationProps, propDefault, routingText } from './form-destinations';
import { allTrees, childLists } from './tree';

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
  /**
   * What it was before the batch, for the user to compare: the placement's own value or its design's default then, or
   * the design's default then. Absent where there was nothing before: a placement or design the batch makes, a setting
   * the earlier design did not have.
   */
  was?: unknown;
  /** The placement or design the batch makes, which sent nowhere before it. */
  added?: boolean;
  /**
   * The placement it reaches, as `key` names it, so every change to one form is shown together; absent for a design's
   * own default or code.
   */
  placement?: string;
  /**
   * Where the placement (or, for a default, a fresh placement of the design) sends on each side, whichever setting the
   * batch changes: each form it is or holds, with the service it uses and that service's setting, so the user sees the
   * address a changed service now reads, or a swapped design sends to. `was` is absent where there was nothing before.
   */
  sends?: { was?: FormSends[]; is?: FormSends[] };
  /**
   * The change itself, as a grant names it: the placement it reaches (its page, layout or design, and the node when it
   * was there before), and the value whole. The same change made again (new IDs and all) has the same key.
   */
  key: string;
}

/**
 * Where one of the app's forms sends: its service, and that service's setting (as the form's design labels it) with
 * its value. `prop` names that setting when the placement is the form itself, rather than a design that holds one.
 */
export interface FormSends {
  service: string;
  prop?: string;
  setting?: string;
  value?: unknown;
  /** Why no address can be shown: its code decides it, or the form is set too deep inside designs to follow. */
  unknown?: string;
}

/**
 * What the user allowed when the app asked them (agent/orchestrator.ts): a token the main process made up for the one
 * review they were shown (main/project/form-routing-grants.ts), good once, for exactly that batch at the revision it was
 * refused at. Nothing in it says what it allows, so nothing outside the session can write one that does.
 */
export interface FormRoutingGrant {
  token: string;
}

/**
 * What a batch refused for its form changes asks the user about: the review the session filed (`id`), the batch as
 * session.apply fingerprints it, and its changes.
 */
export interface FormRoutingReview {
  id: string;
  operations: string;
  changes: FormRoutingChange[];
}

/** The review a refusal carries (session.apply's SCOPE_MISMATCH for a form's changes), or null for any other refusal. */
export function formRoutingReview(error: { code?: string; details?: unknown } | undefined): FormRoutingReview | null {
  const r = error?.code === 'SCOPE_MISMATCH' && error.details && typeof error.details === 'object' ? (error.details as { formRouting?: unknown }).formRouting : undefined;
  if (!r || typeof r !== 'object') return null;
  const { id, operations, changes } = r as Partial<FormRoutingReview>;
  return typeof id === 'string' && typeof operations === 'string' && Array.isArray(changes) && changes.length > 0 ? { id, operations, changes } : null;
}

/**
 * Whether a design is one the app ships, exactly as it ships it: a theme's own contact form, say, installed with its
 * first placement. Its defaults and code are the app's, not the batch's. An installed pack's are not.
 */
function shipped(def: ComponentDefinition): boolean {
  if (def.owner !== 'theme') return false;
  const props = JSON.stringify(def.properties);
  const tree = JSON.stringify(def.tree ?? null);
  return listThemes().some(
    (t) => t.source !== 'user' && t.components.some((c) => c.id === def.id && c.kind === def.kind && c.source === def.source && JSON.stringify(c.properties) === props && JSON.stringify(c.tree ?? null) === tree)
  );
}

/** Each node's parent in a tree (null at its roots), worked out once for every walk up it. */
const parentsOf = (() => {
  const known = new WeakMap<NodeTree, Map<string, string>>();
  return (tree: NodeTree) => {
    let parents = known.get(tree);
    if (parents) return parents;
    parents = new Map();
    for (const n of Object.values(tree.nodes)) for (const cl of childLists(n)) for (const id of cl.ids) parents.set(id, n.id);
    known.set(tree, parents);
    return parents;
  };
})();

/**
 * The list a node's `$item` bindings read: its nearest repeat's. The same binding inside another repeat of the same
 * design reads another list's items, so moving a form between two repeats changes where it sends.
 */
function repeatAround(tree: NodeTree, nodeId: string): string {
  const parents = parentsOf(tree);
  let id = parents.get(nodeId);
  for (let guard = parents.size; id && guard >= 0; guard--) {
    const n = tree.nodes[id];
    if (n?.kind === 'repeat') return JSON.stringify(n.list ?? null);
    id = parents.get(id);
  }
  return '';
}

/** A value that reads a design's own setting, or one field of it: `{ $prop }` or `{ $prop, field }`. */
function propBinding(v: unknown): { $prop: string; field?: string } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as { $prop?: unknown; field?: unknown };
  if (typeof b.$prop !== 'string' || Object.keys(b).some((k) => k !== '$prop' && k !== 'field') || (b.field !== undefined && typeof b.field !== 'string')) return null;
  return b as { $prop: string; field?: string };
}

/** An `$item` binding with the list it repeats in (`$list`, as repeatAround gives it), so the dialog can name it. */
function withList(value: unknown, tree: NodeTree | undefined, nodeId: string): unknown {
  if (!tree || !reads(value, '$item')) return value;
  const list = repeatAround(tree, nodeId);
  return list && value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { $item?: unknown }).$item === 'string' ? { ...value, $list: list } : value;
}

/** A placement's variant choices, compared as one more setting of code that places a form: its code may route by them. */
const VARIANTS = '\u0001variants';
/** The option of each of a design's variants a placement is given: its own choice, or the design's default. */
const variantsOf = (d: ComponentDefinition | undefined, own?: Record<string, string>) => Object.fromEntries(Object.entries(d?.variantAxes ?? {}).map(([axis, a]) => [axis, own?.[axis] ?? a.default]));
/** A design's default for a setting (its variant defaults, for VARIANTS), as what a fresh placement is given. */
const defaultOf = (d: ComponentDefinition | undefined, prop: string): unknown => (prop === VARIANTS ? variantsOf(d) : propDefault(d, prop));

/** Whether a value reads a property or an item's field (`key`), anywhere in it: a whole binding, a list item's, a field's. */
function reads(value: unknown, key: '$prop' | '$item'): boolean {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && Object.hasOwn(value, key)) return true;
  return Object.values(value).some((v) => reads(v, key));
}

/** A list's items without their IDs, which a copy makes anew: a copy of the same items in the same order is the same list. */
const unlisted = (value: unknown): unknown =>
  Array.isArray(value) ? value.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'id')) : item)) : value;

/**
 * A placement's setting as text to compare: its own value or its design's default; for a binding, the design (or
 * page) it is read in, whose own property or item it reads, and for an item's field the list it repeats in; and the
 * collection a list is connected to, whose entries then stand in for its items. A `copy` is compared without its
 * list items' IDs, which copying makes anew; a placement that stays keeps them, as code may read them.
 */
function valueOf(state: ProjectState, tree: NodeTree, scope: string, n: Instance, prop: string, copy = false): string {
  if (prop === VARIANTS) return routingText(variantsOf(state.components[n.definitionId], n.variants as Record<string, string> | undefined));
  const own = n.props && Object.hasOwn(n.props, prop) ? n.props[prop] : undefined;
  const value = own ?? propDefault(Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined, prop);
  const text = routingText(copy ? unlisted(value) : value);
  const item = reads(value, '$item');
  const bound = item || reads(value, '$prop') ? `${text}\u0000${scope}` : text;
  const read = item ? `${bound}\u0000${repeatAround(tree, n.id)}` : bound;
  const source = n.listSources && Object.hasOwn(n.listSources, prop) ? n.listSources[prop] : undefined;
  return source === undefined ? read : `${read}\u0000${JSON.stringify(source)}`;
}

const resolved = (state: ProjectState, n: Instance, prop: string): unknown => (prop === VARIANTS ? variantsOf(state.components[n.definitionId], n.variants as Record<string, string> | undefined) : undefined) ?? (n.props && Object.hasOwn(n.props, prop) ? n.props[prop] : undefined) ?? propDefault(state.components[n.definitionId], prop);

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
  // A design the batch makes (a copy made unique, say) has a new ID each time the batch is made: it is named by what
  // it is called instead, so the same batch sent again once allowed makes the same changes.
  const known = (id: string) => (Object.hasOwn(before.components, id) ? id : `\u0001new\u0000${after.components[id]?.name ?? ''}`);
  const add = (c: Omit<FormRoutingChange, 'key'>, value: string, placement = '') => {
    const key = JSON.stringify([c.kind, known(c.definitionId), placement, c.prop ?? '', value]);
    if (seen.has(`${key}\u0000${c.where ?? ''}`)) return;
    seen.add(`${key}\u0000${c.where ?? ''}`);
    out.push({ ...c, key });
  };
  const nameOf = (state: ProjectState, id: string) => (Object.hasOwn(state.components, id) ? state.components[id].name : 'a contact form');
  const labelOf = (id: string, prop: string) => {
    if (prop === VARIANTS) return 'style variant';
    const schema = Object.hasOwn(after.components, id) ? after.components[id].properties[prop] : undefined;
    return typeof schema?.label === 'string' && schema.label ? schema.label : prop;
  };
  const trusted = new WeakMap<ComponentDefinition, boolean>();
  const isShipped = (d: ComponentDefinition | undefined) => !!d && (trusted.get(d) ?? (trusted.set(d, shipped(d)), trusted.get(d)!));
  const def = (state: ProjectState, id: string) => (Object.hasOwn(state.components, id) ? state.components[id] : undefined);
  /**
   * Where a placement sends, as the dialog shows it: the form it is, with its service and the one setting that service
   * reads, or each form inside the design it is (a setting the design passes on read from the placement), or that its
   * code decides. `read` resolves a value bound to the design the placement is inside; `tree` holds the placement.
   */
  const sendsOf = (state: ProjectState, n: Instance, tree?: NodeTree): FormSends[] => {
    // A walk of a few dozen placements at most, each form listed once: a design placed many times inside another
    // never holds the question up.
    const budget = { left: 48 };
    const seen = new Set<string>();
    return walk(state, n, tree, (v) => v, 0, budget).filter((f) => !seen.has(JSON.stringify(f)) && !!seen.add(JSON.stringify(f)));
  };
  const walk = (state: ProjectState, n: Instance, tree: NodeTree | undefined, read: (v: unknown) => unknown, depth: number, budget: { left: number }): FormSends[] => {
    const d = def(state, n.definitionId);
    // Only a form, or a design that places one, is followed: the rest send nothing.
    if (!d || !(sendsFormMessages(d) || bears().before.has(d.id) || bears().after.has(d.id))) return [];
    if (depth > 4 || budget.left-- <= 0) return [{ service: 'Set deep inside its design', unknown: 'Set deep inside its design' }];
    const value = (p: string) => withList(read(resolved(state, n, p)), tree, n.id);
    if (sendsFormMessages(d)) {
      const provider = value('provider') ?? 'endpoint';
      // A service read from somewhere else (a setting of the design around it) is shown as that.
      if (typeof provider !== 'string') return [{ service: display(provider) }];
      const options = (d.properties.provider as { options?: Array<{ value: string; label: string }> }).options ?? [];
      const service = FORM_PROVIDERS.find(([v]) => v === provider)?.[1] ?? options.find((o) => o.value === provider)?.label ?? provider;
      const prop = Object.hasOwn(FORM_SERVICES, provider) ? FORM_SERVICES[provider].prop : undefined;
      // A service the form has no way to send with: it sends nothing.
      if (!prop) return [{ service, unknown: 'Nowhere' }];
      const label = (d.properties[prop] as { label?: unknown } | undefined)?.label;
      return [{ service, ...(depth ? {} : { prop }), setting: typeof label === 'string' && label ? label : prop, value: value(prop) }];
    }
    if (d.kind === 'code') return [{ service: 'Decided by its code', unknown: 'Decided by its code' }];
    // A design's own setting (or one field of it), bound inside it, reads the placement's value for it.
    const inner = (v: unknown) => {
      const b = propBinding(v);
      if (!b) return v;
      const whole = read(resolved(state, n, b.$prop));
      if (b.field === undefined) return whole;
      // Still a binding (to the design around this one): it reads that field there.
      if (propBinding(whole)) return { ...(whole as object), field: b.field };
      return whole && typeof whole === 'object' && !Array.isArray(whole) ? (whole as Record<string, unknown>)[b.field] : undefined;
    };
    return Object.values(d.tree?.nodes ?? {}).flatMap((m) => (m.kind === 'instance' ? walk(state, m, d.tree, inner, depth + 1, budget) : []));
  };
  // The designs that place a form at all, a setting of their own or not, worked out only if something needs them.
  let bearing: { before: Set<string>; after: Set<string> } | undefined;
  const bears = () => (bearing ??= { before: formBearing(before, was), after: formBearing(after, is) });
  // Code that places a form, however deep (through code of its own with no settings, say), and is not a form: what
  // it passes on, and how, is in its source, so every setting of it and its variant choices decide where it sends.
  const wraps = (id: string) => {
    const d = def(after, id) ?? def(before, id);
    if (d?.kind !== 'code' || sendsFormMessages(d) || FORM_DESTINATIONS.some((k) => Object.hasOwn(d.properties, k))) return false;
    return bears().after.has(id) || bears().before.has(id);
  };
  // A setting that decided where a form sent before is compared even once nothing reads it as one: a design that lost
  // its form's settings may still send, with whatever its code falls back on.
  const listed = new Map<string, string[]>();
  const props = (id: string) => {
    const known = listed.get(id);
    if (known) return known;
    const all = new Set([...(is.get(id) ?? []), ...(was.get(id) ?? [])]);
    if (wraps(id)) for (const d of [def(before, id), def(after, id)]) for (const p of [...Object.keys(d?.properties ?? {}), VARIANTS]) all.add(p);
    const out = [...all].sort();
    listed.set(id, out);
    return out;
  };

  // Code decides in its source what it sends where: code that places a form, or is one, before or after, is never
  // written, apart from the code the app ships.
  const rewritten = Object.values(after.components).filter((d) => codeOf(d) !== null && codeOf(d) !== codeOf(def(before, d.id)) && !isShipped(d));
  for (const d of rewritten) if (bears().after.has(d.id) || bears().before.has(d.id)) add({ kind: 'code', definitionId: d.id, name: d.name }, codeOf(d)!);

  // What a new placement may start as, by design: a copy of one placement before, setting for setting, on the same
  // page or in the same design (or anywhere, for a page or design the batch makes: a duplicated page), or its design's
  // defaults (as they were, or as the app ships them) with any setting left empty. A form removed and another put in
  // its place sends only where one there already did.
  const copies = new Map<string, Map<string, Set<string>>>();
  const defaults = new Map<string, Map<string, Set<string>>>();
  const placed = new Map<string, { n: Instance; tree: NodeTree }>();
  for (const { owner, tree } of allTrees(before)) {
    const scope = `${owner.kind}:${owner.id}`;
    for (const n of Object.values(tree.nodes)) {
      if (n.kind !== 'instance') continue;
      placed.set(`${scope}:${n.id}`, { n, tree });
      const ps = props(n.definitionId);
      if (!ps.length) continue;
      const tuples = copies.get(n.definitionId) ?? new Map<string, Set<string>>();
      const tuple = ps.map((p) => valueOf(before, tree, scope, n, p, !wraps(n.definitionId))).join('\u0001');
      tuples.set(tuple, (tuples.get(tuple) ?? new Set<string>()).add(scope));
      copies.set(n.definitionId, tuples);
    }
  }
  const wrappers = Object.keys(after.components).filter((id) => after.components[id].kind === 'code' && wraps(id));
  for (const id of new Set([...is.keys(), ...wrappers])) {
    const by = new Map<string, Set<string>>();
    for (const p of props(id)) {
      const ok = new Set<string>();
      if (def(before, id)) ok.add(routingText(unlisted(defaultOf(def(before, id), p))));
      if (isShipped(def(after, id))) ok.add(routingText(unlisted(defaultOf(def(after, id), p))));
      by.set(p, ok);
    }
    defaults.set(id, by);
  }

  // The same goes for where a binding is read: a page or design the batch makes is named by what it is called.
  // Two made with the same name (a page duplicated twice) are told apart by the order they come in, which the same
  // batch made again keeps.
  const owners = new Set(allTrees(before).map(({ owner }) => `${owner.kind}:${owner.id}`));
  const named = new Map<string, number>();
  for (const { owner, tree, label } of allTrees(after)) {
    const made = !owners.has(`${owner.kind}:${owner.id}`);
    const nth = made ? (named.get(`${owner.kind}:${label}`) ?? 0) : 0;
    if (made) named.set(`${owner.kind}:${label}`, nth + 1);
    const scope = made ? `${owner.kind}:\u0001new\u0000${nth ? JSON.stringify([label, nth]) : label}` : `${owner.kind}:${owner.id}`;
    const where = owner.kind === 'page' ? `on “${label}”` : owner.kind === 'shell' ? `in the ${label.toLowerCase()}` : owner.kind === 'component' ? `in the “${label}” design` : `in “${label}”`;
    // New placements are counted in the order the tree holds them, which the same batch made again keeps.
    let added = 0;
    for (const n of Object.values(tree.nodes)) {
      if (n.kind !== 'instance') continue;
      const had = placed.get(`${scope}:${n.id}`);
      const prior = had?.n;
      const name = nameOf(after, n.definitionId);
      // Swapped for another design, into or out of one that places a form (with settings of its own or with its form's
      // set inside it): what the new design does with what carries over is its own. Only one of the app's own designs
      // taking another's place, as switching themes swaps the theme's form for the new theme's, keeps where it sends,
      // as long as every setting reads as it did.
      const ps = props(n.definitionId);
      // A placement that was there before is named by its node; a new one, whose ID is new each time the batch is made,
      // by where it is.
      const placement = prior ? `${scope}:${n.id}` : `${scope}:\u0001new:${added++}`;
      // Named, for a grant, without its list items' IDs: the batch sent again gives new items new IDs.
      // Where the placement sends on each side, as the dialog shows it: worked out only for a placement that changes.
      // Worked out once for the placement, however many of its settings change.
      let where_: { sends?: { was?: FormSends[]; is?: FormSends[] } } | undefined;
      const sends = () => {
        if (where_) return where_;
        const was = prior ? sendsOf(before, prior, had!.tree) : [];
        const is = sendsOf(after, n, tree);
        return (where_ = was.length || is.length ? { sends: { ...(was.length ? { was } : {}), ...(is.length ? { is } : {}) } } : {});
      };
      const report = (p: string) => {
        // What it sent with before: the placement's value then, where it was there and its design had the setting.
        const then = prior && (p === VARIANTS || Object.hasOwn(def(before, prior.definitionId)?.properties ?? {}, p)) ? { was: withList(resolved(before, prior, p), had!.tree, prior.id) } : {};
        add({ kind: 'setting', definitionId: n.definitionId, name, where, prop: p, label: labelOf(n.definitionId, p), value: withList(resolved(after, n, p), tree, n.id), ...then, ...(prior ? {} : { added: true }), placement, ...sends() }, valueOf(after, tree, scope, n, p, true), placement);
      };
      if (prior && prior.definitionId !== n.definitionId) {
        if (!bears().before.has(prior.definitionId) && !bears().after.has(n.definitionId)) continue;
        const had_ = (p: string) => valueOf(before, had!.tree, scope, prior, p);
        const settings = new Set([...(was.get(prior.definitionId) ?? []), ...(is.get(n.definitionId) ?? [])]);
        const carried = isShipped(def(before, prior.definitionId)) && isShipped(def(after, n.definitionId)) && [...settings].every((p) => valueOf(after, tree, scope, n, p) === had_(p));
        if (carried) continue;
        add({ kind: 'design', definitionId: n.definitionId, name, where, value: nameOf(before, prior.definitionId), placement, ...sends() }, prior.definitionId, placement);
        // And what it sends with, where that is not what the placement had: the user sees every address it would use.
        for (const p of ps) if (!EMPTY_ROUTING.has(valueOf(after, tree, scope, n, p)) && valueOf(after, tree, scope, n, p) !== had_(p)) report(p);
        continue;
      }
      if (!ps.length) continue;
      if (prior) {
        for (const p of ps) if (valueOf(after, tree, scope, n, p) !== valueOf(before, had!.tree, scope, prior, p)) report(p);
        continue;
      }
      // Code may pick an item by its ID, so a copy of a placement of it is the same only with the same IDs.
      const loose = !wraps(n.definitionId);
      const now = ps.map((p) => valueOf(after, tree, scope, n, p, loose));
      const copied = copies.get(n.definitionId)?.get(now.join('\u0001'));
      if (copied && (made || copied.has(scope))) continue;
      const fresh = defaults.get(n.definitionId);
      const off = ps.filter((p, i) => !EMPTY_ROUTING.has(now[i]) && !fresh?.get(p)?.has(now[i]));
      off.forEach(report);
    }
  }

  // A design's defaults, which every placement without its own value sends with, and every new one starts with.
  for (const id of new Set([...is.keys(), ...was.keys(), ...wrappers])) {
    const now = def(after, id);
    if (!now || isShipped(now)) continue;
    const prev = def(before, id);
    // Where a fresh placement of the design would send, before and after, worked out once if a default changes.
    let fresh: { sends?: { was?: FormSends[]; is?: FormSends[] } } | undefined;
    const freshSends = () => {
      if (fresh) return fresh;
      const placed = { kind: 'instance', id: '', definitionId: id, props: {} } as unknown as Instance;
      const then = prev ? sendsOf(before, placed) : [];
      const now_ = sendsOf(after, placed);
      return (fresh = then.length || now_.length ? { sends: { ...(then.length ? { was: then } : {}), ...(now_.length ? { is: now_ } : {}) } } : {});
    };
    for (const p of props(id)) {
      const value = defaultOf(now, p);
      const text = routingText(unlisted(value));
      if (prev ? text === routingText(unlisted(defaultOf(prev, p))) : EMPTY_ROUTING.has(text) || p === VARIANTS) continue;
      add({ kind: 'default', definitionId: id, name: now.name, prop: p, label: labelOf(id, p), value, ...(prev ? { was: defaultOf(prev, p) } : { added: true }), ...freshSends() }, text);
    }
  }

  return out;
}

/** A setting's new value, whole: what the user allows is what they read. */
const shown = (value: unknown): string => (EMPTY_ROUTING.has(routingText(value)) ? 'is cleared' : `becomes ${typeof value === 'string' ? value : JSON.stringify(value)}`);

/** One change, in the user's words. */
function describe(c: FormRoutingChange): string {
  if (c.kind === 'setting') return `“${c.name}” ${c.where}: its ${c.label} ${shown(c.value)}.`;
  if (c.kind === 'default') return `The “${c.name}” design: the ${c.label} new placements start with ${shown(c.value)}.`;
  if (c.kind === 'design') return `“${c.value as string}” ${c.where} becomes “${c.name}”, a design that decides where it sends.`;
  return `The code of “${c.name}”, which places a contact form, changes.`;
}

/**
 * The question the app asks before an AI batch changes where a form sends (agent/orchestrator.ts): in the app's own
 * words, naming every change, never the model's. `allow` is the answer that allows it.
 */
export function formRoutingQuestion(changes: readonly FormRoutingChange[]): { text: string; choices: [keep: string, allow: string]; allow: string } {
  // Every change is named, each once, with how many forms it reaches: Allow allows exactly what the question says.
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(describe(c), (counts.get(describe(c)) ?? 0) + 1);
  const listed = [...counts].map(([text, n]) => (n > 1 ? `${text.slice(0, -1)}, on ${n} forms.` : text));
  const many = listed.length > 1 || [...counts.values()].some((n) => n > 1);
  const allow = many ? 'Allow these changes' : 'Allow this change';
  return { text: `Let the assistant change where your contact ${many ? 'forms send' : 'form sends'} visitors’ messages? ${listed.join(' ')}`, choices: ['Keep it as it is', allow], allow };
}

/** What a batch refused for its form changes tells the assistant. */
export function formRoutingRefusal(changes: readonly FormRoutingChange[]): string {
  return `Only the user can allow a change to where a contact form sends visitors’ messages. ${describe(changes[0])}${changes.length > 1 ? ` And ${changes.length - 1} more.` : ''} Nothing in this batch was applied.`;
}

/** The list a repeat reads (repeatAround's text), named for the dialog: its design's setting, or the list itself. */
function listName(list: string): string {
  try {
    const v = JSON.parse(list) as { $prop?: unknown } | null;
    return v && typeof v === 'object' && typeof v.$prop === 'string' ? `“${v.$prop}”` : list;
  } catch {
    return list;
  }
}

/** A setting's value as the dialog shows it: the text itself, what a binding reads, or that nothing is set. */
function display(value: unknown): string {
  if (EMPTY_ROUTING.has(routingText(value))) return 'Not set';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as { $prop?: unknown; $item?: unknown; $list?: unknown };
    const b = propBinding(value);
    if (b) return `Its design’s “${b.$prop}” setting${b.field === undefined ? '' : `, its “${b.field}” field`}`;
    if (typeof v.$item === 'string' && Object.keys(v).length <= 2) return `Each item’s “${v.$item}”${typeof v.$list === 'string' ? ` in the ${listName(v.$list)} list` : ''}`;
  }
  return JSON.stringify(value);
}

/**
 * What the app's dialog shows before an AI batch changes where contact forms send (agent/orchestrator.ts asks it, the
 * renderer's ConfirmDialog draws it): each form the batch reaches, by where it is, with the service it uses and where
 * that sends before and after, and every other setting the batch changes that decides it; a design's defaults; and
 * code, which decides in its source where it sends. Only what the session's review found is shown, in the app's
 * words: nothing in it comes from the model.
 */
export function formRoutingPrompt(changes: readonly FormRoutingChange[]): FormRoutingPrompt {
  const groups = new Map<string, FormRoutingChange[]>();
  for (const c of changes) {
    const at = c.kind === 'setting' || c.kind === 'design' ? `p\u0000${c.placement ?? c.where ?? ''}\u0000${c.definitionId}` : `${c.kind}\u0000${c.definitionId}`;
    groups.set(at, [...(groups.get(at) ?? []), c]);
  }
  type Row = FormRoutingPrompt['forms'][number]['rows'][number];
  const service = (s: FormSends[] | undefined) => (s?.length ? [...new Set(s.map((f) => f.service))].join('; ') : 'Not a contact form');
  const to = (s: FormSends[] | undefined) => (s?.length ? s.map((f) => (f.setting ? `${display(f.value)} (${f.setting})` : (f.unknown ?? 'Depends on its service'))).join('; ') : 'Not a contact form');
  const forms: FormRoutingPrompt['forms'] = [];
  for (const cs of groups.values()) {
    const first = cs[0];
    if (first.kind === 'code') {
      forms.push({ title: `The code of “${first.name}”`, rows: [], note: 'This design places a contact form, and its code decides where the form sends. The AI changes that code, so the app can’t show the address it will use.' });
      continue;
    }
    const isDefault = first.kind === 'default';
    // New: nothing sent from here before the batch.
    const added = cs.every((c) => c.added);
    const fresh = isDefault ? 'New design' : 'New form';
    const rows: Row[] = [];
    const swap = cs.find((c) => c.kind === 'design');
    if (swap) rows.push({ label: 'Design', before: String(swap.value), after: swap.name });
    const sends = cs.find((c) => c.sends)?.sends;
    if (sends) {
      rows.push({ label: 'Form service', before: added ? fresh : service(sends.was), after: service(sends.is) });
      rows.push({ label: 'Sends to', before: added ? fresh : to(sends.was), after: to(sends.is) });
    }
    // A change the rows above already show as it ends up: the service, or the one setting it reads, of the form the
    // placement is. Any other (a setting the new service does not read, one a design passes on) has its own row.
    const direct = sends?.is?.length === 1 ? sends.is[0].prop : undefined;
    for (const c of cs) {
      if (c.kind === 'design' || (direct && (c.prop === 'provider' || c.prop === direct))) continue;
      const row = { label: direct ? `${c.label}, a setting this service doesn’t use` : (c.label ?? c.prop ?? ''), before: added ? fresh : Object.hasOwn(c, 'was') ? display(c.was) : 'Not set', after: display(c.value) };
      // A change is never shown as staying the same: what reads alike reads from somewhere else now.
      rows.push(row.before === row.after ? { ...row, after: `${row.after}, read from a different place` } : row);
    }
    const title = isDefault ? `The “${first.name}” design: what new placements start with` : `“${first.name}” ${first.where ?? ''}`.trim();
    // Another design's code now does the sending: what its settings say is all the app can show.
    forms.push({ title, rows, ...(swap ? { note: `“${first.name}” takes the place of “${String(swap.value)}”, and its own code decides how the form sends. The addresses above are what its settings say.` } : {}) });
  }
  // Forms with the same name in the same place are told apart by their order there.
  const titles = new Map<string, number>();
  for (const f of forms) titles.set(f.title, (titles.get(f.title) ?? 0) + 1);
  const nth = new Map<string, number>();
  for (const f of forms) {
    const n = titles.get(f.title)!;
    if (n < 2) continue;
    const i = (nth.get(f.title) ?? 0) + 1;
    nth.set(f.title, i);
    f.title = `${f.title} (${i} of ${n})`;
  }
  return { forms };
}
