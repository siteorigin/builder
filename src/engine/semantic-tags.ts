/**
 * Semantic tags (#189): which element and text tags a node can take where it sits. A tag is refused when the HTML it
 * renders would break a nesting rule: one the browser repairs (a block inside a paragraph, a list item inside a list
 * item), which breaks hydration, or one a list, description list, figure or disclosure depends on to mean anything.
 * A plain container or paragraph directly in a list is only a warning: it is how a list is built, one edit at a time,
 * since new containers are always plain.
 *
 * A node sits where it renders. Through a repeat it sits in the repeat's parent. Content placed in a component's slot
 * sits where the component's design renders that slot, and a placed component renders as its design's root. Beyond
 * that one step nothing is known and nothing is refused (the outside of a component's design, a slot forwarded again,
 * a code component), except inside a paragraph or span container: there only content that is certainly inline may go.
 */
import type { ComponentDefinition, GraphNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { ELEMENT_TAGS, TEXT_TAGS, isBinding } from '@shared/types';
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

/** What renders around a tree's roots: a page's sections sit in the layout's `<main>`, the header and footer in `<body>`. */
const ROOT_PARENT: Record<OwnerRef['kind'], string | null> = { page: 'main', shell: 'body', component: null };

const sameOwner = (a: OwnerRef, b: OwnerRef) => a.kind === b.kind && a.id === b.id;
const some = (tags: readonly string[] | null | undefined, set: readonly string[]) => !!tags && tags.some((t) => set.includes(t));
const every = (tags: readonly string[] | null | undefined, set: readonly string[]) => !!tags && tags.every((t) => set.includes(t));

/** One tree being read: its nodes, and the parent each child renders under. */
interface TreeCtx {
  owner: OwnerRef;
  tree: NodeTree;
  def?: ComponentDefinition;
  parentOf: Map<string, string>;
}

/** Where a node renders: inside an element of some tree (`id`), or inside the page's own markup (`id` null). */
interface Parent {
  tags: readonly string[];
  ctx: TreeCtx;
  id: string | null;
}

/** What a node renders as, for the rules: its kind and possible tags, or nothing known (a slot, a code component). */
type Rendered = { kind: GraphNode['kind']; tags: readonly string[] | null; rich: boolean } | null;

class Reader {
  private ctxs = new Map<string, TreeCtx>();
  constructor(
    readonly state: ProjectState,
    readonly override?: TagOverride
  ) {}

  ctx(owner: OwnerRef, tree: NodeTree): TreeCtx {
    const key = `${owner.kind}:${owner.id}`;
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
  private defCtx(definitionId: string): TreeCtx | null {
    const def = Object.hasOwn(this.state.components, definitionId) ? this.state.components[definitionId] : undefined;
    return def?.kind === 'managed' && def.tree ? this.ctx({ kind: 'component', id: def.id }, def.tree) : null;
  }

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

  /** What a node renders as. A placed managed component renders as its design's root; anything else placed is unknown. */
  rendered(ctx: TreeCtx, n: GraphNode): Rendered {
    if (n.kind === 'slot') return null;
    if (n.kind === 'instance') {
      const inner = this.defCtx(n.definitionId);
      const rootId = inner?.tree.rootIds.length === 1 ? inner.tree.rootIds[0] : undefined;
      const root = inner && rootId && Object.hasOwn(inner.tree.nodes, rootId) ? inner.tree.nodes[rootId] : undefined;
      if (!inner || !root || root.kind === 'instance' || root.kind === 'slot' || root.kind === 'repeat') return null;
      return { kind: root.kind, tags: this.tags(inner, root), rich: root.kind === 'text' && !!root.rich };
    }
    return { kind: n.kind, tags: this.tags(ctx, n), rich: n.kind === 'text' && !!n.rich };
  }

  /** The element a node renders inside, through repeats, and from a slot into the design that renders it. */
  parent(ctx: TreeCtx, id: string, hop = true): Parent | null {
    const nodes = ctx.tree.nodes;
    let at = ctx.parentOf.get(id);
    let child = id;
    for (let guard = 0; at !== undefined && guard < 500; guard++) {
      const p = Object.hasOwn(nodes, at) ? nodes[at] : undefined;
      if (!p) return null;
      if (p.kind === 'element') return { tags: this.tags(ctx, p) ?? ['div'], ctx, id: p.id };
      if (p.kind === 'instance') return hop ? this.outlet(p.definitionId, p.slots ?? {}, child) : null;
      child = p.id;
      at = ctx.parentOf.get(p.id);
    }
    if (at !== undefined) return null;
    const outer = ROOT_PARENT[ctx.owner.kind];
    return outer ? { tags: [outer], ctx, id: null } : null;
  }

  /** Where a placed component renders the slot holding `child`: the element around that slot in its design. */
  private outlet(definitionId: string, slots: Record<string, string[]>, child: string): Parent | null {
    const inner = this.defCtx(definitionId);
    const slot = Object.entries(slots).find(([, ids]) => (ids ?? []).includes(child))?.[0];
    if (!inner || slot === undefined) return null;
    const outlet = Object.values(inner.tree.nodes).find((n) => n.kind === 'slot' && n.slot === slot);
    // One step only: a slot the design forwards into another placement, or renders at its edge, sits somewhere unknown.
    return outlet ? this.parent(inner, outlet.id, false) : null;
  }

  /** The elements a node renders inside, nearest first, as far as they are known. */
  ancestors(ctx: TreeCtx, id: string): Parent[] {
    const out: Parent[] = [];
    let p = this.parent(ctx, id);
    for (let guard = 0; p && p.id !== null && guard < 500; guard++) {
      out.push(p);
      p = this.parent(p.ctx, p.id);
    }
    return out;
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

/** Every nesting problem in one tree, with `override` standing in for one node's tag. */
function treeProblems(reader: Reader, owner: OwnerRef, tree: NodeTree): NestingProblem[] {
  const ctx = reader.ctx(owner, tree);
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
    const say = (severity: NestingProblem['severity'], rule: string, message: string) => out.push({ severity, nodeId: id, site: `${id}|${rule}`, message: `${subject(n)} ${message}` });
    const r = reader.rendered(ctx, n);
    const tags = r?.tags ?? null;
    const p = reader.parent(ctx, id);
    const anc = reader.ancestors(ctx, id);
    // A block inside a paragraph closes it, so the browser builds a different page from the one the site's code expects.
    if (anc.some((a) => some(a.tags, ['p', 'span'])) && !inline(r)) {
      say('error', 'inline', 'can’t go inside a paragraph or span container, which holds only inline text, buttons, links and icons.');
      continue;
    }
    if (some(tags, ['main'])) {
      say('error', 'main', 'can’t be a main area: every page already has one, around its sections.');
      continue;
    }
    if (some(tags, ['li']) && p && !every(p.tags, ['ul', 'ol'])) {
      say('error', 'li', 'is a list item, so it goes directly inside a list (ul or ol).');
      continue;
    }
    // A term and its description may be grouped in one plain container inside the list.
    const group = p && p.id !== null && every(p.tags, ['div']) ? reader.parent(p.ctx, p.id) : undefined;
    const inGroup = group !== undefined && group !== null && some(group.tags, ['dl']);
    if (some(tags, ['dt', 'dd']) && p && !every(p.tags, ['dl']) && !(group === null || (group && every(group.tags, ['dl'])))) {
      say('error', 'dl-item', 'is a term or description, so it goes inside a description list (dl).');
      continue;
    }
    if (some(tags, ['figcaption']) && p && !every(p.tags, ['figure'])) {
      say('error', 'figcaption', 'is a caption, so it goes directly inside a figure.');
      continue;
    }
    if (some(tags, ['summary']) && p && !every(p.tags, ['details'])) {
      say('error', 'summary', 'is a summary, so it goes directly inside a details element.');
      continue;
    }
    const element = r?.kind === 'element';
    const plainText = r?.kind === 'text' && !r.rich;
    if (r && p && some(p.tags, ['ul', 'ol'])) {
      if (element && every(tags, ['li', 'div']) && !every(tags, ['li'])) say('warning', 'list-item', 'sits directly in a list: make it a list item (li).');
      else if (!(element && every(tags, ['li']))) say('error', 'list-child', 'can’t go directly inside a list: only list items (li) and containers can.');
      continue;
    }
    if (r && p && (some(p.tags, ['dl']) || inGroup)) {
      const fits = (element && every(tags, inGroup ? ['dt', 'dd'] : ['dt', 'dd', 'div'])) || (plainText && every(tags, ['dt', 'dd']));
      const unfinished = (element && every(tags, ['dt', 'dd', 'div'])) || (plainText && every(tags, ['dt', 'dd', 'p']));
      if (!fits && unfinished) say('warning', 'dl-term', 'sits directly in a description list: make it a term (dt) or description (dd).');
      else if (!fits) say('error', 'dl-child', 'can’t go directly inside a description list: only terms (dt), descriptions (dd) and containers grouping them can.');
      continue;
    }
    if (some(tags, LANDMARK_ENDS) && anc.some((a) => some(a.tags, LANDMARK_ENDS))) say('error', 'landmark', 'can’t be a header or footer inside another header or footer.');
  }
  return out;
}

/** Every nesting problem in one tree, with `override` standing in for one node's tag: what the tree would hold with it. */
export function nestingProblems(state: ProjectState, owner: OwnerRef, tree: NodeTree, override?: TagOverride): NestingProblem[] {
  return treeProblems(new Reader(state, override), owner, tree);
}

/**
 * The documents a tag edit in `owner` can change the HTML of: its own, and for a component's design every document
 * placing it (its root and slots render there). Theme designs are fixed theme data, checked when the theme is built.
 */
function reach(state: ProjectState, owners: readonly OwnerRef[]): Array<{ owner: OwnerRef; tree: NodeTree; label: string }> {
  const all = allTrees(state).filter((t) => t.owner.kind !== 'component' || state.components[t.owner.id]?.owner !== 'theme');
  if (owners.some((o) => o.kind === 'component')) return all;
  return all.filter((t) => owners.some((o) => sameOwner(o, t.owner)));
}

const ownerKey = (o: OwnerRef) => `${o.kind}:${o.id}`;

/** The sites of the errors each document `owners` reach has now, by document. */
function errorSites(state: ProjectState, owners: readonly OwnerRef[]): Map<string, Set<string>> {
  const reader = new Reader(state);
  return new Map(reach(state, owners).map((t) => [ownerKey(t.owner), new Set(treeProblems(reader, t.owner, t.tree).filter((p) => p.severity === 'error').map((p) => p.site))]));
}

/** The first error `after` has in the documents `owners` reach that `before` lacks, named by its document when that is another one. */
function firstIntroduced(before: Map<string, Set<string>>, after: ProjectState, owners: readonly OwnerRef[], override?: TagOverride): string | null {
  const now = new Reader(after, override);
  for (const t of reach(after, owners)) {
    const sites = before.get(ownerKey(t.owner));
    const found = treeProblems(now, t.owner, t.tree).find((p) => p.severity === 'error' && !sites?.has(p.site));
    if (found) return owners.some((o) => sameOwner(o, t.owner)) ? found.message : `${t.label}: ${found.message}`;
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
export function batchTagProblem(before: ProjectState, after: ProjectState, owners: readonly OwnerRef[]): string | null {
  return owners.length ? firstIntroduced(errorSites(before, owners), after, owners) : null;
}

/** Why `node` can't take `tag` where it sits, as one edit on its own, or null when it can. */
export function tagProblem(state: ProjectState, owner: OwnerRef, nodeId: string, tag: unknown): string | null {
  const node = getNode(getTree(state, owner), nodeId);
  return tagKindProblem(node, tag) ?? firstIntroduced(errorSites(state, [owner]), state, [owner], { owner, nodeId, tag: tag as string });
}

/** Each tag of a node's kind, with why it can't take it where it sits (null when it can, and for the tag it has). */
export function tagOptions(state: ProjectState, owner: OwnerRef, nodeId: string): Array<{ tag: string; problem: string | null }> {
  const node = getNode(getTree(state, owner), nodeId);
  if (node.kind !== 'element' && node.kind !== 'text') return [];
  const tags: readonly string[] = node.kind === 'text' ? TEXT_TAGS : ELEMENT_TAGS;
  const before = errorSites(state, [owner]);
  return tags.map((tag) => ({ tag, problem: tag === node.tag ? null : (tagKindProblem(node, tag) ?? firstIntroduced(before, state, [owner], { owner, nodeId, tag })) }));
}
