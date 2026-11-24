/**
 * Semantic tags (#189): which element and text tags a node can take where it sits. A tag is refused when the HTML it
 * renders would break a nesting rule: one the browser repairs (a block inside a paragraph, a list item inside a list
 * item), which breaks hydration, or one a list, description list, figure or disclosure depends on to mean anything.
 * Content a list or description list is still being built from (a plain container or paragraph directly in it) is
 * only a warning, since new containers are always plain and new text a heading or paragraph.
 *
 * A node sits where it renders. Through a repeat it sits in the repeat's parent. Content placed in a component's slot
 * sits wherever the component's design renders that slot (following a slot it forwards into another component), and a
 * placed managed component renders as its design's root. The outside of a component's design is unknown, as is a code
 * component's markup: nothing is refused there, except inside a paragraph or span container, where only content that
 * is certainly inline may go.
 */
import type { ComponentDefinition, GraphNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { ELEMENT_TAGS, TEXT_TAGS, isBinding } from '@shared/types';
import { isCardLink } from '@generator/card-links';
import { boundSchema } from './schema';
import { allTrees, getNode, getTree } from './tree';

export interface NestingProblem {
  severity: 'error' | 'warning';
  nodeId: string;
  /** The node and the rule it breaks: stays the same while the problem does, whatever the wording. */
  site: string;
  message: string;
}

/** One node's tag as an edit would set it, in the document it belongs to. */
export interface TagOverride {
  owner: OwnerRef;
  nodeId: string;
  tag: string;
}

const ELEMENT_TAG_SET = new Set<string>(ELEMENT_TAGS);
const TEXT_TAG_SET = new Set<string>(TEXT_TAGS);
/** Text tags that are inline (phrasing) content. */
const INLINE_TEXT = ['span', 'small', 'strong', 'cite'];
const LANDMARK_ENDS = ['header', 'footer'];
/** Tags a container that is one link can't keep: the link renders in its place, between a list and its items, say. */
const CARD_BREAKS = ['ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figcaption', 'details', 'summary'];

/** What renders around a tree's roots: a page's sections sit in the layout's `<main>`, the header and footer in `<body>`. */
const ROOT_PARENT: Record<OwnerRef['kind'], string | null> = { page: 'main', shell: 'body', component: null };

const ownerKey = (o: OwnerRef) => `${o.kind}:${o.id}`;
const sameOwner = (a: OwnerRef, b: OwnerRef) => a.kind === b.kind && a.id === b.id;
const some = (tags: readonly string[] | null | undefined, set: readonly string[]) => !!tags && tags.some((t) => set.includes(t));
const every = (tags: readonly string[] | null | undefined, set: readonly string[]) => !!tags && tags.every((t) => set.includes(t));

/** One document being read: its nodes, and the parent each child is held by. */
interface TreeCtx {
  owner: OwnerRef;
  tree: NodeTree;
  def?: ComponentDefinition;
  parentOf: Map<string, string>;
}

/** An element a node renders inside: one in some document, or the page's own markup around a document's roots. */
type Around = { ctx: TreeCtx; id: string } | { outer: string };

/**
 * Where a node renders: the nearest element on each way up (each place a component renders the slot holding it, say),
 * and `open` when some way leads somewhere unknown first. A slot a design never renders leaves its content nowhere.
 */
interface Up {
  parents: Around[];
  open: boolean;
}

const OPEN: Up = { parents: [], open: true };
const aroundKey = (a: Around) => ('outer' in a ? `outer:${a.outer}` : `${ownerKey(a.ctx.owner)}|${a.id}`);

/** How a project's documents hold each other: the same whatever tag an edit would set, so shared between candidates. */
class Structure {
  private ctxs = new Map<string, TreeCtx>();
  private ups = new Map<string, Up>();
  private alls = new Map<string, Around[]>();
  private visiting = new Set<string>();
  constructor(readonly state: ProjectState) {}

  ctx(owner: OwnerRef, tree: NodeTree): TreeCtx {
    const key = ownerKey(owner);
    let c = this.ctxs.get(key);
    if (!c) {
      const parentOf = new Map<string, string>();
      for (const n of Object.values(tree.nodes)) {
        if (n.kind === 'element' || n.kind === 'repeat') for (const ch of n.children ?? []) parentOf.set(ch, n.id);
        else if (n.kind === 'instance') for (const ids of Object.values(n.slots ?? {})) for (const ch of ids ?? []) parentOf.set(ch, n.id);
      }
      const def = owner.kind === 'component' && Object.hasOwn(this.state.components, owner.id) ? this.state.components[owner.id] : undefined;
      c = { owner, tree, def, parentOf };
      this.ctxs.set(key, c);
    }
    return c;
  }

  /** A managed definition's tree, read as its own document. */
  defCtx(definitionId: string): TreeCtx | null {
    const def = Object.hasOwn(this.state.components, definitionId) ? this.state.components[definitionId] : undefined;
    return def?.kind === 'managed' && def.tree ? this.ctx({ kind: 'component', id: def.id }, def.tree) : null;
  }

  /** Where a node renders, through repeats and into each place a placed component renders the slot holding it. */
  up(ctx: TreeCtx, id: string): Up {
    const key = `up|${ownerKey(ctx.owner)}|${id}`;
    const known = this.ups.get(key);
    if (known) return known;
    // A document that holds itself (edited by hand) renders nowhere certain.
    if (this.visiting.has(key)) return OPEN;
    this.visiting.add(key);
    const out = this.climb(ctx, id);
    this.visiting.delete(key);
    this.ups.set(key, out);
    return out;
  }

  private climb(ctx: TreeCtx, id: string): Up {
    const at = ctx.parentOf.get(id);
    if (at === undefined) {
      const outer = ROOT_PARENT[ctx.owner.kind];
      return outer && ctx.tree.rootIds.includes(id) ? { parents: [{ outer }], open: false } : OPEN;
    }
    const p = Object.hasOwn(ctx.tree.nodes, at) ? ctx.tree.nodes[at] : undefined;
    if (!p) return OPEN;
    if (p.kind === 'repeat') return this.up(ctx, p.id);
    if (p.kind === 'element') return { parents: [{ ctx, id: p.id }], open: false };
    if (p.kind !== 'instance') return OPEN;
    const slot = Object.entries(p.slots ?? {}).find(([, ids]) => (ids ?? []).includes(id))?.[0];
    const inner = this.defCtx(p.definitionId);
    if (!inner || slot === undefined) return OPEN;
    const parents = new Map<string, Around>();
    let open = false;
    for (const outlet of Object.values(inner.tree.nodes)) {
      if (outlet.kind !== 'slot' || outlet.slot !== slot) continue;
      const u = this.up(inner, outlet.id);
      open ||= u.open;
      for (const a of u.parents) parents.set(aroundKey(a), a);
    }
    return { parents: [...parents.values()], open };
  }

  /** Every element a node renders inside, on any way up, each once. */
  ancestors(ctx: TreeCtx, id: string): Around[] {
    const key = `all|${ownerKey(ctx.owner)}|${id}`;
    const known = this.alls.get(key);
    if (known) return known;
    if (this.visiting.has(key)) return [];
    this.visiting.add(key);
    const out = new Map<string, Around>();
    for (const a of this.up(ctx, id).parents) {
      out.set(aroundKey(a), a);
      if (!('outer' in a)) for (const b of this.ancestors(a.ctx, a.id)) out.set(aroundKey(b), b);
    }
    this.visiting.delete(key);
    const list = [...out.values()];
    this.alls.set(key, list);
    return list;
  }
}

/** What a node renders as, for the rules: its kind and possible tags, or nothing known (a slot, a code component). */
type Rendered = { node: GraphNode; kind: GraphNode['kind']; tags: readonly string[] | null; rich: boolean } | null;

/** The project read with one node's tag as an edit would set it. */
class Reader {
  constructor(
    readonly structure: Structure,
    readonly override?: TagOverride
  ) {}

  /** The tags a node can render: its literal tag (its kind's plain tag for one that is not supported), or each option of a bound choice. */
  tags(ctx: TreeCtx, n: GraphNode): readonly string[] | null {
    if (n.kind !== 'element' && n.kind !== 'text') return null;
    const allowed = n.kind === 'text' ? TEXT_TAG_SET : ELEMENT_TAG_SET;
    const plain = n.kind === 'text' ? 'p' : 'div';
    const o = this.override;
    const tag: unknown = o && o.nodeId === n.id && sameOwner(o.owner, ctx.owner) ? o.tag : n.tag;
    if (!isBinding(tag)) return [typeof tag === 'string' && allowed.has(tag) ? tag : plain];
    // As the generator renders it (`tagChoices`): the choice's options that are tags of this kind, and its fallback.
    const schema = ctx.def ? boundSchema(ctx.def, n.id, tag) : undefined;
    const options = schema?.type === 'enum' ? schema.options.map((x) => x.value).filter((x) => allowed.has(x)) : [];
    const fallback = schema?.type === 'enum' && options.includes(schema.default) ? schema.default : (options[0] ?? plain);
    return [...new Set([...options, fallback])];
  }

  around(a: Around): { tags: readonly string[]; node?: GraphNode } {
    if ('outer' in a) return { tags: [a.outer] };
    const node = a.ctx.tree.nodes[a.id];
    return { tags: this.tags(a.ctx, node) ?? ['div'], node };
  }

  /** What a node renders as. A placed managed component renders as its design's root, through any it places there. */
  rendered(ctx: TreeCtx, n: GraphNode): Rendered {
    let at: { ctx: TreeCtx; node: GraphNode } = { ctx, node: n };
    const seen = new Set<string>();
    while (at.node.kind === 'instance') {
      const inner = this.structure.defCtx(at.node.definitionId);
      const rootId = inner?.tree.rootIds.length === 1 ? inner.tree.rootIds[0] : undefined;
      const root = inner && rootId && Object.hasOwn(inner.tree.nodes, rootId) ? inner.tree.nodes[rootId] : undefined;
      if (!inner || !root || seen.has(ownerKey(inner.owner))) return null;
      seen.add(ownerKey(inner.owner));
      at = { ctx: inner, node: root };
    }
    const r = at.node;
    if (r.kind === 'slot' || r.kind === 'repeat') return null;
    return { node: r, kind: r.kind, tags: this.tags(at.ctx, r), rich: r.kind === 'text' && !!r.rich };
  }
}

/** How to name a node at the start of a sentence. */
function subject(n: GraphNode): string {
  if (n.name) return `“${n.name}”`;
  switch (n.kind) {
    case 'text':
      return n.rich ? 'Rich text' : typeof n.tag === 'string' && /^h[1-6]$/.test(n.tag) ? 'A heading' : n.tag === 'p' ? 'A paragraph' : 'Text';
    case 'element':
      return 'A container';
    case 'link':
      return 'A button';
    case 'image':
      return 'An image';
    case 'icon':
      return 'An icon';
    case 'divider':
      return 'A divider';
    case 'instance':
      return 'A component';
    case 'slot':
      return 'A slot';
    default:
      return 'This element';
  }
}

/** Whether what a node renders is certainly inline. */
function inline(r: Rendered): boolean {
  if (!r) return false;
  if (r.kind === 'link' || r.kind === 'icon') return true;
  if (r.kind === 'element') return every(r.tags, ['span']);
  return r.kind === 'text' && !r.rich && every(r.tags, INLINE_TEXT);
}

/** A container that renders as one link in place of its own tag: a card with a destination and no click action. */
const linkCard = (n: GraphNode) => n.kind === 'element' && isCardLink(n) && (n.action === undefined || n.action === null);

/** Every nesting problem in one document, as `reader` reads the project. */
function treeProblems(reader: Reader, owner: OwnerRef, tree: NodeTree): NestingProblem[] {
  const ctx = reader.structure.ctx(owner, tree);
  const nodes = tree.nodes;
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id) || !Object.hasOwn(nodes, id)) return;
    reachable.add(id);
    const n = nodes[id];
    if (n.kind === 'element' || n.kind === 'repeat') (n.children ?? []).forEach(visit);
    else if (n.kind === 'instance') Object.values(n.slots ?? {}).forEach((ids) => (ids ?? []).forEach(visit));
  };
  tree.rootIds.forEach(visit);

  const out: NestingProblem[] = [];
  for (const id of reachable) {
    const n = nodes[id];
    if (n.kind === 'repeat') continue;
    const said = new Set<string>();
    const say = (severity: NestingProblem['severity'], rule: string, message: string) => {
      if (said.has(rule)) return;
      said.add(rule);
      out.push({ severity, nodeId: id, site: `${id}|${rule}`, message: `${subject(n)} ${message}` });
    };
    const r = reader.rendered(ctx, n);
    const tags = r?.tags ?? null;
    const element = r?.kind === 'element';
    const plainText = r?.kind === 'text' && !r.rich;
    if (some(tags, ['main'])) say('error', 'main', 'can’t be a main area: every page already has one, around its sections.');
    if (linkCard(n) && some(reader.tags(ctx, n), CARD_BREAKS))
      say('error', 'card', 'is one link, which renders in place of its tag, so it can’t be a list, list item, term, caption or disclosure. Link a container inside it instead.');

    const structure = reader.structure;
    const above = structure.ancestors(ctx, id).map((a) => reader.around(a));
    // A block inside a paragraph closes it, so the browser builds a different page from the one the site's code expects.
    if (!inline(r)) {
      if (above.some((a) => some(a.tags, ['p']))) say('error', 'in-paragraph', 'can’t go inside a paragraph container, which holds only inline text, buttons, links and icons.');
      else if (above.some((a) => some(a.tags, ['span']))) say('error', 'in-span', 'can’t go inside a span container, which holds only inline text, buttons, links and icons.');
    }
    if (some(tags, LANDMARK_ENDS) && above.some((a) => some(a.tags, LANDMARK_ENDS))) say('error', 'landmark', 'can’t be a header or footer inside another header or footer.');
    for (const at of structure.up(ctx, id).parents) {
      const p = reader.around(at);
      // A term and its description may be grouped in one plain container inside the list: the container's own parents.
      const group = !('outer' in at) && p.node?.kind === 'element' && every(p.tags, ['div']) ? structure.up(at.ctx, at.id).parents.map((g) => reader.around(g)) : null;
      if (some(tags, ['li']) && !every(p.tags, ['ul', 'ol'])) say('error', 'li', 'is a list item, so it goes directly inside a list (ul or ol).');
      if (some(tags, ['dt', 'dd']) && !every(p.tags, ['dl']) && !(group && group.every((g) => every(g.tags, ['dl']))))
        say('error', 'dl-item', 'is a term or description, so it goes inside a description list (dl).');
      if (some(tags, ['figcaption']) && !every(p.tags, ['figure'])) say('error', 'figcaption', 'is a caption, so it goes directly inside a figure.');
      if (some(tags, ['summary']) && !every(p.tags, ['details'])) say('error', 'summary', 'is a summary, so it goes directly inside a details element.');
      if (!r) continue;
      if (some(p.tags, ['ul', 'ol'])) {
        if (element && every(tags, ['li', 'div']) && !every(tags, ['li'])) say('warning', 'list-item', 'sits directly in a list: make it a list item (li).');
        else if (!(element && every(tags, ['li']))) say('error', 'list-child', 'can’t go directly inside a list: only list items (li) and containers can.');
      } else if (some(p.tags, ['dl'])) {
        const fits = (element && every(tags, ['dt', 'dd', 'div'])) || (plainText && every(tags, ['dt', 'dd']));
        if (!fits && plainText && every(tags, ['dt', 'dd', 'p'])) say('warning', 'dl-term', 'sits directly in a description list: make it a term (dt) or description (dd).');
        else if (!fits) say('error', 'dl-child', 'can’t go directly inside a description list: only terms (dt), descriptions (dd) and containers grouping them can.');
      } else if (group?.some((g) => some(g.tags, ['dl']))) {
        // In a group, anything else is only waiting to become a term or description, or to move out.
        if (!((element || plainText) && every(tags, ['dt', 'dd']))) say('warning', 'dl-group', 'sits in a description list’s group: make it a term (dt) or description (dd).');
      }
    }
  }
  return out;
}

/** Every nesting problem in one tree, with `override` standing in for one node's tag: what the tree would hold with it. */
export function nestingProblems(state: ProjectState, owner: OwnerRef, tree: NodeTree, override?: TagOverride): NestingProblem[] {
  return treeProblems(new Reader(new Structure(state), override), owner, tree);
}

type Doc = { owner: OwnerRef; tree: NodeTree; label: string };

/**
 * The documents a tag edit in `owners` can change the HTML of: each one itself, and for a component's design every
 * document placing it, directly or through components placing it (its root and slots render there). Theme designs
 * are fixed theme data, checked when the theme is built.
 */
function reach(state: ProjectState, owners: readonly OwnerRef[]): Doc[] {
  const trees = allTrees(state);
  const reached = new Set(owners.map(ownerKey));
  const defs = new Set(owners.filter((o) => o.kind === 'component').map((o) => o.id));
  for (let grew = defs.size > 0; grew; ) {
    grew = false;
    for (const t of trees) {
      if (reached.has(ownerKey(t.owner)) || !Object.values(t.tree.nodes).some((n) => n.kind === 'instance' && defs.has(n.definitionId))) continue;
      reached.add(ownerKey(t.owner));
      if (t.owner.kind === 'component') defs.add(t.owner.id);
      grew = true;
    }
  }
  return trees.filter((t) => reached.has(ownerKey(t.owner)) && (t.owner.kind !== 'component' || state.components[t.owner.id]?.owner !== 'theme'));
}

/** The sites of the errors each document `docs` lists has, by document. */
function errorSites(reader: Reader, docs: readonly Doc[]): Map<string, Set<string>> {
  return new Map(docs.map((t) => [ownerKey(t.owner), new Set(treeProblems(reader, t.owner, t.tree).filter((p) => p.severity === 'error').map((p) => p.site))]));
}

/** An error an edit brings in: its message (named by its document when that is another one), and where it is. */
export interface IntroducedProblem {
  message: string;
  owner: OwnerRef;
  nodeId: string;
}

/** The first error `reader` finds in `docs` that `before` lacks. */
function firstIntroduced(before: Map<string, Set<string>>, reader: Reader, docs: readonly Doc[], owners: readonly OwnerRef[]): IntroducedProblem | null {
  for (const t of docs) {
    const sites = before.get(ownerKey(t.owner));
    const found = treeProblems(reader, t.owner, t.tree).find((p) => p.severity === 'error' && !sites?.has(p.site));
    if (found) return { message: owners.some((o) => sameOwner(o, t.owner)) ? found.message : `${t.label}: ${found.message}`, owner: t.owner, nodeId: found.nodeId };
  }
  return null;
}

/** The kind's own refusal of a tag, before where the node sits is considered. */
export function tagKindProblem(node: GraphNode, tag: unknown): string | null {
  if (node.kind !== 'element' && node.kind !== 'text') return 'Only text and containers have a tag.';
  if (node.kind === 'text') {
    if (node.rich) return 'Rich text keeps its paragraph structure.';
    if (typeof tag !== 'string' || !TEXT_TAG_SET.has(tag)) return `Text’s tag must be one of ${TEXT_TAGS.join(', ')}.`;
  } else if (typeof tag !== 'string' || !ELEMENT_TAG_SET.has(tag)) return `A container’s tag must be one of ${ELEMENT_TAGS.join(', ')}.`;
  return null;
}

/**
 * The nesting error a batch that retagged nodes in `owners` brings in, or null. Only what the batch brings in counts,
 * so a document with an older problem can still be repaired one edit at a time, and the batch is judged as a whole:
 * a list and its items can change together.
 */
export function batchTagProblem(before: ProjectState, after: ProjectState, owners: readonly OwnerRef[]): IntroducedProblem | null {
  if (!owners.length) return null;
  const was = reach(before, owners);
  return firstIntroduced(errorSites(new Reader(new Structure(before)), was), new Reader(new Structure(after)), reach(after, owners), owners);
}

/** Disclosures are controls: a linked card around one would put a control inside a link. */
function cardProblem(structure: Structure, owner: OwnerRef, nodeId: string, tag: string): string | null {
  if (tag !== 'details' && tag !== 'summary') return null;
  const ctx = structure.ctx(owner, getTree(structure.state, owner));
  const inCard = structure.ancestors(ctx, nodeId).some((a) => !('outer' in a) && isCardLink(a.ctx.tree.nodes[a.id]));
  return inCard ? 'A disclosure can’t go inside a linked card, which can hold nothing interactive.' : null;
}

/** A checker for one node's candidate tags, sharing what doesn't depend on the tag. */
function candidates(state: ProjectState, owner: OwnerRef, nodeId: string): (tag: unknown) => string | null {
  const node = getNode(getTree(state, owner), nodeId);
  const structure = new Structure(state);
  const docs = reach(state, [owner]);
  let before: Map<string, Set<string>> | undefined;
  return (tag) => {
    const kind = tagKindProblem(node, tag);
    if (kind) return kind;
    before ??= errorSites(new Reader(structure), docs);
    return cardProblem(structure, owner, nodeId, tag as string) ?? firstIntroduced(before, new Reader(structure, { owner, nodeId, tag: tag as string }), docs, [owner])?.message ?? null;
  };
}

/** Why `node` can't take `tag` where it sits, as one edit on its own, or null when it can. */
export function tagProblem(state: ProjectState, owner: OwnerRef, nodeId: string, tag: unknown): string | null {
  return candidates(state, owner, nodeId)(tag);
}

/** Each tag of a node's kind, with why it can't take it where it sits (null when it can, and for the tag it has). */
export function tagOptions(state: ProjectState, owner: OwnerRef, nodeId: string): Array<{ tag: string; problem: string | null }> {
  const node = getNode(getTree(state, owner), nodeId);
  if (node.kind !== 'element' && node.kind !== 'text') return [];
  const tags: readonly string[] = node.kind === 'text' ? TEXT_TAGS : ELEMENT_TAGS;
  const check = candidates(state, owner, nodeId);
  return tags.map((tag) => ({ tag, problem: tag === node.tag ? null : check(tag) }));
}
