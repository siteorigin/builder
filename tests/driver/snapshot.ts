/**
 * UI observations for the test driver (issue #492): the pure half. The session takes one Playwright accessibility
 * snapshot of the editor's whole document per observation (`ariaSnapshotJSON({ mode: 'ai', boxes: true })`, which
 * enters the live preview's iframe too) and hands the raw tree here to be redacted, shaped, bounded and given refs.
 * Nothing here touches the app, so every rule is unit-tested on its own.
 *
 * - **Redaction** happens on the raw tree, before anything is shaped, returned or logged: Playwright reports an
 *   input's value as its text, password fields included. Values of fields classified as secret (and of any field that
 *   could not be classified) are removed, and the secrets' exact strings are scrubbed from every other string.
 * - **Shaping** drops what assistive technology does not see (aria-hidden), folds away the editor's unnamed wrappers, turns text
 *   fragments into `text` nodes, reports an editable field's text as its value, and records each node's regions.
 * - **Bounding** fills a node budget breadth-first, so an outline shows the top of the tree first; a node whose
 *   children were left out says how many and how to continue (`within` its ref, from `offset`).
 * - **Refs** are opaque tokens minted per session. Each is bound to the window generation, the project opening, the
 *   document it was seen in and Playwright's own ref for the element; the session checks every binding on use and
 *   answers anything that no longer holds with STALE_REF.
 */
import { randomBytes } from 'node:crypto';

export type Scope = 'editor' | 'preview';

/** A node of Playwright's JSON aria snapshot. */
export interface RawNode {
  role: string;
  name?: string;
  text?: string;
  ref?: string;
  box?: Box;
  children?: (RawNode | string)[];
  level?: number;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  pressed?: boolean | 'mixed';
  selected?: boolean;
  active?: boolean;
  invalid?: boolean | string;
  url?: string;
  placeholder?: string;
  ariaHidden?: boolean;
  [key: string]: unknown;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The preview's established element ids (`data-so-ctx`, `data-so-node`, `data-so-items`). */
export interface Semantic {
  ctx: string;
  node: string;
  items?: string;
}

/** What the page says about one element beyond its accessibility node. */
export interface ElementFacts {
  /** A field whose value is a credential: never returned. */
  secret: boolean;
  /** The element sits under an inert ancestor (a modal dialog covers it). */
  blocked: boolean;
  /** A scrolling ancestor clips it entirely out of view. */
  clipped: boolean;
  semantic: Semantic | null;
  /** Its place in a set the page may not have mounted in full (aria-setsize, aria-posinset). */
  setsize?: number;
  posinset?: number;
}

/** A shaped node, before bounding: internal to the driver. */
export interface Shaped {
  scope: Scope;
  role: string;
  name?: string;
  text?: string;
  value?: string;
  redacted?: true;
  pwRef?: string;
  box?: Box;
  level?: number;
  checked?: boolean | 'mixed';
  disabled?: true;
  expanded?: boolean;
  pressed?: boolean | 'mixed';
  selected?: true;
  focused?: true;
  invalid?: true | string;
  url?: string;
  placeholder?: string;
  /** The named regions it sits in, outermost first: `toolbar "Panels"`, `navigation "Main"`, `contentinfo`. */
  regions: string[];
  children: Shaped[];
  /** Every node under it. */
  size: number;
}

/** A node as a client sees it. */
export interface UiNode {
  ref?: string;
  role: string;
  name?: string;
  text?: string;
  value?: string;
  /** The value is a credential, left out. */
  redacted?: true;
  level?: number;
  checked?: boolean | 'mixed';
  disabled?: true;
  expanded?: boolean;
  pressed?: boolean | 'mixed';
  selected?: true;
  /** It has the keyboard focus in its document. */
  focused?: true;
  invalid?: true | string;
  url?: string;
  placeholder?: string;
  /** In its own document's viewport, in CSS pixels (the preview's are the site's, before the canvas zoom). */
  box?: Box;
  /** Mounted but out of view: outside its document's viewport, or scrolled away inside a panel. */
  offscreen?: true;
  /** Its place in a set that may hold more than is mounted (a virtualized list says so with these). */
  setsize?: number;
  posinset?: number;
  /** Covered by a modal dialog: a person cannot reach it until the dialog closes. */
  blocked?: true;
  semantic?: Semantic;
  children?: UiNode[];
  /** Children left out by the bounds: how many, how many nodes in all, and how to see them. */
  more?: { children: number; nodes: number; continue?: Continuation };
}

/**
 * How to see what the bounds left out: observe `within` the parent (or in the scope, at the top level), after the
 * last child shown. `after` is that child's ref: siblings added or removed meanwhile do not shift where it resumes, and
 * a child that is gone answers STALE_REF. `offset` is where it was, for a last child that has no ref.
 */
export interface Continuation {
  within?: string;
  scope?: Scope;
  after?: string;
  offset: number;
}

export const LIMITS = {
  /** Nodes in one observation when none is asked for, shared between the editor and the preview. */
  defaultNodes: 200,
  maxNodes: 1000,
  maxDepth: 50,
  name: 200,
  text: 300,
  value: 1000,
  url: 300,
  /** Candidates listed with an ambiguous target. */
  candidates: 10,
  /** Refs a session remembers; the oldest are forgotten past this, and answered as stale. */
  refs: 20_000
};

/** Roles whose text is the value a person typed or chose. */
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox', 'slider']);

/** Roles that make a region a person can name: landmarks and named containers. */
const LANDMARKS = new Set(['banner', 'main', 'contentinfo', 'navigation', 'complementary', 'region', 'search', 'form', 'dialog', 'alertdialog']);
const CONTAINERS = new Set(['toolbar', 'group', 'tabpanel', 'tablist', 'menu', 'menubar', 'listbox', 'tree', 'treegrid', 'grid', 'table', 'list', 'radiogroup', 'article']);

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function norm(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** How a node names itself in a region path. */
export function regionLabel(node: { role: string; name?: string }): string | null {
  const name = norm(node.name);
  if (LANDMARKS.has(node.role)) return name ? `${node.role} "${name}"` : node.role;
  if (CONTAINERS.has(node.role) && name) return `${node.role} "${name}"`;
  return null;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Every node of a raw tree, depth first. */
export function* rawNodes(nodes: (RawNode | string)[] | undefined): Generator<RawNode> {
  for (const n of nodes ?? []) {
    if (typeof n === 'string') continue;
    yield n;
    yield* rawNodes(n.children);
  }
}

/** Whether a raw node carries a value a person typed (its text, or text fragments under it). */
export function holdsValue(node: RawNode): boolean {
  return VALUE_ROLES.has(node.role) && (!!node.text || (node.children ?? []).some((c) => typeof c === 'string' || c.role === 'text'));
}

/** A value-bearing node's value: its text and the text fragments under it. */
function valueOf(n: RawNode): string {
  return [n.text ?? '', ...(n.children ?? []).map((c) => (typeof c === 'string' ? c : c.role === 'text' ? (c.text ?? '') : ''))].join('');
}

/** The refs of nodes whose values must be classified before anything is returned. */
export function valueRefs(nodes: (RawNode | string)[]): string[] {
  const out: string[] = [];
  for (const n of rawNodes(nodes)) if (n.ref && holdsValue(n)) out.push(n.ref);
  return out;
}

export interface Redaction {
  /** Refs of fields that hold a credential. */
  secretRefs: Set<string>;
  /** Refs whose element could not be read: their values are treated as credentials too. */
  unknownRefs: Set<string>;
  /** Credential values read from the page, scrubbed wherever they appear. */
  secrets: string[];
}

export interface Redacted {
  nodes: (RawNode | string)[];
  /** Every credential string known to this observation: what any reply built from it is scrubbed of. */
  secrets: string[];
  /** Strings other than a credential field's own value that held a credential (so it shows on screen elsewhere). */
  echoes: number;
}

export const REDACTED = '[redacted]';

/** Keys whose values the driver makes itself (refs, its own file paths), never page content: never scrubbed. */
const DRIVER_KEYS = new Set(['ref', 'refs', 'within', 'after', 'token', 'pwRef', 'screenshots']);

/**
 * A function that replaces every known secret in a string. A secret of two or more characters goes wherever it
 * appears; a one-character one only where it is the whole string, or it would take every such letter with it.
 */
export function scrubber(secrets: string[]): (s: string) => string {
  const list = [...new Set(secrets.filter((x) => !!x))].sort((a, b) => b.length - a.length);
  return (s: string) => {
    if (!list.length) return s;
    if (list.includes(s)) return REDACTED;
    let out = s;
    for (const secret of list) if (secret.length >= 2 && out.includes(secret)) out = out.split(secret).join(REDACTED);
    return out;
  };
}

/** A copy of any JSON value with every known secret scrubbed from its strings (the driver's own keys are kept). */
export function scrubDeep<T>(value: T, secrets: string[]): T {
  const scrub = scrubber(secrets);
  if (!secrets.some((x) => !!x)) return value;
  const visit = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key && DRIVER_KEYS.has(key) ? v : scrub(v);
    if (key && DRIVER_KEYS.has(key)) return v;
    if (Array.isArray(v)) return v.map((x) => visit(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, k)]));
    return v;
  };
  return visit(value) as T;
}

/**
 * Remove credential values from a raw tree, in place. A value-bearing node without a ref, or whose ref is secret or
 * unknown, loses its value, and what it held is scrubbed from every other string: what such a field held at the
 * moment of the snapshot is what any echo in the same snapshot shows, even if the field changed between the page
 * reads either side of it.
 */
export function redact(nodes: (RawNode | string)[], r: Redaction): Redacted {
  const captured: string[] = [];
  for (const n of rawNodes(nodes)) {
    if (!holdsValue(n) || (n.ref && !r.secretRefs.has(n.ref) && !r.unknownRefs.has(n.ref))) continue;
    // The value as a whole, and each piece Playwright gave it in (its text, and fragments under it).
    captured.push(valueOf(n), n.text ?? '', ...(n.children ?? []).map((c) => (typeof c === 'string' ? c : c.role === 'text' ? (c.text ?? '') : '')));
  }
  const secrets = [...new Set([...r.secrets, ...captured].filter((x) => !!x))];
  const scrub = scrubber(secrets);
  let echoes = 0;
  const clean = (v: string) => {
    const out = scrub(v);
    if (out !== v) echoes++;
    return out;
  };
  const visit = (list: (RawNode | string)[] | undefined): (RawNode | string)[] | undefined => {
    if (!list) return list;
    return list.map((n) => {
      if (typeof n === 'string') return clean(n);
      if (holdsValue(n) && (!n.ref || r.secretRefs.has(n.ref) || r.unknownRefs.has(n.ref))) {
        delete n.text;
        n.children = (n.children ?? []).filter((c) => typeof c !== 'string' && c.role !== 'text');
        n.redacted = true;
      }
      for (const key of Object.keys(n)) {
        const v = n[key];
        if (typeof v === 'string' && key !== 'role' && key !== 'ref') n[key] = clean(v);
      }
      n.children = visit(n.children);
      return n;
    });
  };
  return { nodes: visit(nodes) ?? [], secrets, echoes };
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/**
 * Shape a raw tree. An iframe becomes a leaf: its document is observed as a scope of its own. In the editor, unnamed
 * `generic` wrappers with no text of their own are folded into their parent; aria-hidden nodes are left out.
 */
export function shape(nodes: (RawNode | string)[] | undefined, scope: Scope, regions: string[] = []): Shaped[] {
  const out: Shaped[] = [];
  for (const n of nodes ?? []) {
    if (typeof n === 'string') {
      const text = norm(n);
      if (text) out.push({ scope, role: 'text', text: clip(text, LIMITS.text), regions, children: [], size: 0 });
      continue;
    }
    if (n.ariaHidden) continue;
    if (n.role === 'text') {
      const text = norm(n.text);
      if (text) out.push({ scope, role: 'text', text: clip(text, LIMITS.text), regions, children: [], size: 0 });
      continue;
    }
    const isValue = VALUE_ROLES.has(n.role);
    // The editor's unnamed wrappers are layout only. The site's are its structure (a section is often a plain element
    // that carries the page's own ids), so the preview keeps them.
    // A focused one too: focus on a plain wrapper (the page's body, with nothing else focused) says nothing.
    if (scope === 'editor' && n.role === 'generic' && !norm(n.name) && !norm(n.text)) {
      out.push(...shape(n.children, scope, regions));
      continue;
    }
    const label = regionLabel(n);
    const inner = label ? [...regions, label] : regions;
    const node: Shaped = { scope, role: n.role, regions, children: [], size: 0 };
    if (norm(n.name)) node.name = clip(norm(n.name), LIMITS.name);
    if (n.ref) node.pwRef = n.ref;
    if (n.box) node.box = n.box;
    if (n.level !== undefined) node.level = n.level;
    if (n.checked !== undefined) node.checked = n.checked;
    if (n.disabled) node.disabled = true;
    if (n.expanded !== undefined) node.expanded = n.expanded;
    if (n.pressed !== undefined) node.pressed = n.pressed;
    if (n.selected) node.selected = true;
    if (n.active) node.focused = true;
    if (n.invalid) node.invalid = n.invalid === true ? true : String(n.invalid);
    if (typeof n.url === 'string') node.url = clip(n.url, LIMITS.url);
    if (typeof n.placeholder === 'string') node.placeholder = clip(n.placeholder, LIMITS.name);
    if (n.redacted) node.redacted = true;
    let children = n.children;
    if (isValue) {
      // A field's own text is its value; options under a combobox stay children.
      const value = valueOf(n);
      if (value && !node.redacted) node.value = clip(value, LIMITS.value);
      children = (children ?? []).filter((c) => typeof c !== 'string' && c.role !== 'text');
    } else if (norm(n.text)) node.text = clip(norm(n.text), LIMITS.text);
    if (n.role !== 'iframe') node.children = shape(children, scope, inner);
    node.size = node.children.reduce((s, c) => s + 1 + c.size, 0);
    out.push(node);
  }
  return out;
}

/** Every shaped node, depth first. */
export function* walk(nodes: Shaped[]): Generator<Shaped> {
  for (const n of nodes) {
    yield n;
    yield* walk(n.children);
  }
}

export function findByPwRef(nodes: Shaped[], pwRef: string): Shaped | null {
  for (const n of walk(nodes)) if (n.pwRef === pwRef) return n;
  return null;
}

// ---------------------------------------------------------------------------
// Bounding
// ---------------------------------------------------------------------------

export interface Bounds {
  maxNodes: number;
  /** Levels below the roots; unbounded when absent. */
  depth?: number;
}

/**
 * Choose which nodes to show: breadth first from the roots until the budget is spent or the depth is reached. A
 * node's shown children are always a prefix of its children, so what was left out continues from an offset.
 */
export function choose(roots: Shaped[], bounds: Bounds): Set<Shaped> {
  const shown = new Set<Shaped>();
  let level: Shaped[] = roots;
  let depth = 0;
  while (level.length && shown.size < bounds.maxNodes) {
    const next: Shaped[] = [];
    for (const n of level) {
      if (shown.size >= bounds.maxNodes) break;
      shown.add(n);
      if (bounds.depth === undefined || depth < bounds.depth) next.push(...n.children);
    }
    // Only children of shown parents are candidates, which keeps each parent's shown children a prefix.
    level = next;
    depth++;
  }
  return shown;
}

export interface RenderOptions {
  shown: Set<Shaped>;
  /** The public ref for a node, or null when it may not have one. */
  refFor: (n: Shaped) => string | null;
  facts: Map<Shaped, ElementFacts>;
  /** The viewport of each scope's document, for `offscreen`. */
  viewports: Partial<Record<Scope, { width: number; height: number }>>;
}

/** The client's view of one node. */
export function describe(n: Shaped, o: Pick<RenderOptions, 'refFor' | 'facts' | 'viewports'>): UiNode {
  const out: UiNode = { role: n.role };
  const ref = n.pwRef ? o.refFor(n) : null;
  if (ref) out.ref = ref;
  for (const key of ['name', 'text', 'value', 'redacted', 'level', 'checked', 'disabled', 'expanded', 'pressed', 'selected', 'focused', 'invalid', 'url', 'placeholder'] as const) {
    if (n[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = n[key];
  }
  if (n.box) {
    out.box = { x: Math.round(n.box.x), y: Math.round(n.box.y), width: Math.round(n.box.width), height: Math.round(n.box.height) };
    const vp = o.viewports[n.scope];
    if (vp && (n.box.width > 0 || n.box.height > 0) && offscreen(n.box, vp)) out.offscreen = true;
  }
  const f = o.facts.get(n);
  if (f?.clipped) out.offscreen = true;
  if (f?.blocked) out.blocked = true;
  if (f?.semantic) out.semantic = f.semantic;
  if (f?.setsize !== undefined) out.setsize = f.setsize;
  if (f?.posinset !== undefined) out.posinset = f.posinset;
  return out;
}

export function offscreen(box: Box, vp: { width: number; height: number }): boolean {
  return box.x + box.width <= 0 || box.y + box.height <= 0 || box.x >= vp.width || box.y >= vp.height;
}

/** Render the shown part of a tree; `offset` is where the roots' own list starts (for a continuation). */
export function render(roots: Shaped[], o: RenderOptions): UiNode[] {
  const out: UiNode[] = [];
  for (const n of roots) {
    if (!o.shown.has(n)) continue;
    const node = describe(n, o);
    const kids = n.children.filter((c) => o.shown.has(c));
    if (kids.length) node.children = render(kids, o);
    if (kids.length < n.children.length) {
      const left = n.children.slice(kids.length);
      const ref = node.ref;
      const last = node.children?.[node.children.length - 1]?.ref;
      node.more = { children: left.length, nodes: left.reduce((s, c) => s + 1 + c.size, 0), ...(ref ? { continue: { within: ref, ...(last ? { after: last } : {}), offset: kids.length } } : {}) };
    }
    out.push(node);
  }
  return out;
}

/** What the roots of a scope left out entirely (only when the budget ran out at the top level). */
export function rootsLeft(roots: Shaped[], shown: Set<Shaped>): { children: number; nodes: number } | null {
  const left = roots.filter((r) => !shown.has(r));
  return left.length ? { children: left.length, nodes: left.reduce((s, c) => s + 1 + c.size, 0) } : null;
}

// ---------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------

export interface Query {
  role?: string;
  name?: string;
  /** Name matching: exact after whitespace is collapsed (default), or a case-insensitive substring. */
  exact?: boolean;
  /** A region the target sits in, by role, name or `role "name"` (case-insensitive). */
  region?: string;
}

export function regionMatches(regions: string[], filter: string): boolean {
  const f = norm(filter).toLowerCase();
  return regions.some((r) => {
    const m = /^([a-z]+)(?: "(.*)")?$/.exec(r);
    const role = m?.[1] ?? r;
    const name = (m?.[2] ?? '').toLowerCase();
    return r.toLowerCase() === f || role === f || (!!name && name === f);
  });
}

export function matches(n: Shaped, q: Query): boolean {
  if (q.role && n.role !== q.role) return false;
  if (q.name !== undefined) {
    const name = norm(n.name);
    if (q.exact === false ? !name.toLowerCase().includes(norm(q.name).toLowerCase()) : name !== norm(q.name)) return false;
  }
  if (q.region && !regionMatches(n.regions, q.region)) return false;
  return true;
}

export function find(roots: Shaped[], q: Query): Shaped[] {
  const out: Shaped[] = [];
  for (const n of walk(roots)) if (n.pwRef && matches(n, q)) out.push(n);
  return out;
}

/** The nodes that are themselves a region matching `filter`, outermost only (a match inside one is searched anyway). */
export function regionNodes(roots: Shaped[], filter: string): Shaped[] {
  const out: Shaped[] = [];
  const visit = (nodes: Shaped[]) => {
    for (const n of nodes) {
      const label = regionLabel(n);
      if (label && n.pwRef && regionMatches([label], filter)) out.push(n);
      else visit(n.children);
    }
  };
  visit(roots);
  return out;
}

// ---------------------------------------------------------------------------
// Context read from the tree
// ---------------------------------------------------------------------------

/** The editor's mode from its Mode group: the pressed button, `edit` or `preview`; null without one. */
export function modeFrom(editor: Shaped[]): 'edit' | 'preview' | null {
  for (const n of walk(editor)) {
    if (n.role !== 'group' || norm(n.name) !== 'Mode') continue;
    const on = [...walk(n.children)].find((c) => c.role === 'button' && c.pressed === true);
    const name = norm(on?.name).toLowerCase();
    return name === 'edit' || name === 'preview' ? name : null;
  }
  return null;
}

/** The topmost open dialog: the last one in document order (dialogs are rendered after what they cover). */
export function dialogFrom(nodes: Shaped[]): Shaped | null {
  let last: Shaped | null = null;
  for (const n of walk(nodes)) if (n.role === 'dialog' || n.role === 'alertdialog') last = n;
  return last;
}

/** The focused node: the deepest one marked focused. */
export function focusFrom(nodes: Shaped[]): Shaped | null {
  let last: Shaped | null = null;
  for (const n of walk(nodes)) if (n.focused) last = n;
  return last;
}

/** The canvas toolbar that acts on the selection ("Split hero actions"), if one is drawn. */
export function selectionToolbar(editor: Shaped[]): Shaped | null {
  for (const n of walk(editor)) if (n.role === 'toolbar' && n.regions.includes('main "Website preview"') && / actions$/.test(norm(n.name))) return n;
  return null;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/** Everything a public ref stands for. */
export interface Binding {
  token: string;
  generation: number;
  scope: Scope;
  /** The project opening it was seen in ('' at Welcome). */
  opening: string;
  /** The document it was seen in. */
  doc: string;
  pwRef: string;
  role: string;
  name: string;
  /** The element's preview ids when it was seen, as JSON; null when it had none. */
  semantic: string | null;
}

export type StaleReason = 'unknown' | 'window' | 'project' | 'document' | 'loading' | 'gone' | 'changed';

export const REFRESH_HINT = 'Take a new ui.snapshot (or ui.locate by role and name) and use the refs it returns.';

/** The tags of every registry in this process, so two sessions never share one. */
const tags = new Set<string>();

function newTag(): string {
  for (;;) {
    const tag = randomBytes(3).toString('hex');
    if (!tags.has(tag)) {
      tags.add(tag);
      return tag;
    }
  }
}

/** Mints and remembers refs for one session. The same element in the same document keeps the same ref. */
export class RefRegistry {
  private readonly tag = newTag();
  private next = 0;
  private readonly byToken = new Map<string, Binding>();
  private readonly byKey = new Map<string, string>();
  readonly limit: number;

  constructor(limit = LIMITS.refs) {
    this.limit = limit;
  }

  get size(): number {
    return this.byToken.size;
  }

  mint(b: Omit<Binding, 'token'>): string {
    const key = JSON.stringify([b.generation, b.scope, b.opening, b.doc, b.pwRef, b.role, b.name, b.semantic]);
    const known = this.byKey.get(key);
    if (known && this.byToken.has(known)) return known;
    const token = `${this.tag}:${++this.next}`;
    this.byToken.set(token, { ...b, token });
    this.byKey.set(key, token);
    while (this.byToken.size > this.limit) {
      const oldest = this.byToken.keys().next().value as string;
      this.byToken.delete(oldest);
    }
    if (this.byKey.size > this.limit * 2) for (const [k, t] of this.byKey) if (!this.byToken.has(t)) this.byKey.delete(k);
    return token;
  }

  get(token: string): Binding | null {
    return this.byToken.get(token) ?? null;
  }

  clear() {
    this.byToken.clear();
    this.byKey.clear();
  }
}

/** Whether a string could be a ref this module minted (any session's). */
export function looksLikeRef(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{6}:\d+$/.test(s);
}
