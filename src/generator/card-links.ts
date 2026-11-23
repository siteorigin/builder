/**
 * Card links: containers that render as one link (`ElementNode.link`). A link inside a link, or any other control
 * inside one, is invalid HTML that browsers repair unpredictably, so nothing interactive may render inside a card.
 * Validation reports each card that breaks this, and the generator renders those cards as their plain container.
 */
import type { ComponentDefinition, ElementNode, GraphNode, LinkValue, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { isBinding } from '@shared/types';
import { isListBlock, toRichText, type RichSpan } from '@shared/richtext';
import { allTrees } from '@engine/tree';

/** Elements that are controls in their own right. */
const INTERACTIVE_TAGS = new Set(['details', 'summary']);

/** Whether an element is a card: it carries a binding or a destination of its own. */
export function isCardLink(n: GraphNode): n is ElementNode & { link: NonNullable<ElementNode['link']> } {
  if (n.kind !== 'element' || n.link === undefined || n.link === null) return false;
  return isBinding(n.link) || ((n.link as LinkValue).type !== undefined && (n.link as LinkValue).type !== 'none');
}

/** Where a card is: the tree that owns it (a page, the shell or a definition) and its node. */
export interface CardRef {
  owner: OwnerRef;
  cardId: string;
}

export interface CardProblem {
  /** The tree the problem is reported in, and the node to select there. */
  owner: OwnerRef;
  label: string;
  nodeId: string;
  /** The cards the offending content renders inside. */
  cards: CardRef[];
  /** What renders inside the card, as a reader would name it. */
  what: string;
}

const cardKey = (c: CardRef) => `${c.owner.kind}:${c.owner.id}:${c.cardId}`;

function richHasLink(value: unknown): boolean {
  const spans = (s: RichSpan[]) => s.some((x) => !!x.link);
  return toRichText(value).some((b) => (isListBlock(b) ? b.items.some(spans) : spans(b.spans)));
}

function describe(n: GraphNode, def?: ComponentDefinition): string {
  const name = n.name ? `“${n.name}”` : '';
  switch (n.kind) {
    case 'link':
      return name ? `the ${name} button` : 'a button or link';
    case 'element':
      return name ? `the ${name} element` : isCardLink(n) ? 'another card link' : `a ${String(n.tag)} element`;
    case 'text':
      return name ? `the ${name} text` : 'rich text with links';
    case 'instance':
      return def ? `“${def.name}”` : 'a component';
    default:
      return name || `a ${n.kind}`;
  }
}

/** Slot content placed by an instance, read in the tree (and slot context) that placed it. */
interface SlotScope {
  content: Record<string, string[]>;
  tree: NodeTree;
  parent: SlotScope | null;
}

/**
 * The first interactive thing that renders from `ids` (in `tree`): a link, another card, a details element, rich
 * text that has or may get links, or a code component (which can place any control). Managed components are
 * followed into their definitions, and their slots into the content the placement gives them; a slot of the
 * definition being checked (`scope` null) is judged where that definition is placed instead.
 */
function firstInteractive(state: ProjectState, tree: NodeTree, ids: string[], scope: SlotScope | null, defs: string[], top: GraphNode | null, path = new Set<GraphNode>()): string | null {
  // A hand-edited tree can list a node under itself: a node already being read further up is skipped.
  const inside = (n: GraphNode, read: () => string | null) => {
    path.add(n);
    try {
      return read();
    } finally {
      path.delete(n);
    }
  };
  for (const id of ids) {
    const n = tree.nodes[id];
    if (!n || path.has(n)) continue;
    // Report against the node the author placed in the tree being checked, not one deep inside a definition.
    const shown = (what: string) => (top && top !== n ? `${describe(top, top.kind === 'instance' ? state.components[top.definitionId] : undefined)}, which holds ${what}` : what);
    let inner: string | null = null;
    switch (n.kind) {
      case 'link':
        return shown(describe(n));
      case 'element':
        if (isCardLink(n) || (!isBinding(n.tag) && INTERACTIVE_TAGS.has(n.tag))) return shown(describe(n));
        inner = inside(n, () => firstInteractive(state, tree, n.children, scope, defs, top ?? n, path));
        break;
      case 'repeat':
        inner = inside(n, () => firstInteractive(state, tree, n.children, scope, defs, top ?? n, path));
        break;
      case 'text':
        // Bound rich text takes whatever its placement writes, links included.
        if (n.rich && (isBinding(n.text) || richHasLink(n.text))) return shown(n.name ? describe(n) : isBinding(n.text) ? 'rich text, which can hold links' : 'rich text with links');
        break;
      case 'slot':
        if (scope) inner = inside(n, () => firstInteractive(state, scope.tree, scope.content[n.slot] ?? [], scope.parent, defs, top, path));
        break;
      case 'instance': {
        const def = state.components[n.definitionId];
        if (!def) break;
        if (def.kind === 'code') return shown(`${describe(n, def)}, a code component that can place links and controls`);
        if (!def.tree || defs.includes(def.id)) break;
        const placed = def.tree;
        inner = inside(n, () => firstInteractive(state, placed, placed.rootIds, { content: n.slots ?? {}, tree, parent: scope }, [...defs, def.id], top ?? n, path));
        break;
      }
    }
    if (inner) return inner;
  }
  return null;
}

/**
 * For each slot a definition renders inside a card, the cards it renders inside: a slot placed under one of its
 * own cards, or passed on to a nested component's slot that renders inside a card there.
 */
function cardSlots(state: ProjectState, def: ComponentDefinition, memo: Map<string, Map<string, CardRef[]>>, path: string[] = []): Map<string, CardRef[]> {
  const known = memo.get(def.id);
  if (known) return known;
  const out = new Map<string, CardRef[]>();
  if (!def.tree || path.includes(def.id)) return out;
  const tree = def.tree;
  const add = (slot: string, cards: CardRef[]) => out.set(slot, [...(out.get(slot) ?? []), ...cards]);
  const seen = new Set<string>();
  const walk = (ids: string[], cards: CardRef[]) => {
    for (const id of ids) {
      const n = tree.nodes[id];
      if (!n || seen.has(id)) continue;
      seen.add(id);
      if (n.kind === 'slot' && cards.length) add(n.slot, cards);
      if (n.kind === 'element' || n.kind === 'repeat') walk(n.children, isCardLink(n) ? [...cards, { owner: { kind: 'component', id: def.id }, cardId: n.id }] : cards);
      if (n.kind === 'instance') {
        const nested = state.components[n.definitionId];
        const inner = nested?.kind === 'managed' ? cardSlots(state, nested, memo, [...path, def.id]) : new Map<string, CardRef[]>();
        for (const [slot, ids2] of Object.entries(n.slots ?? {})) walk(ids2, [...cards, ...(inner.get(slot) ?? [])]);
      }
    }
  };
  walk(tree.rootIds, []);
  memo.set(def.id, out);
  return out;
}

/** Every card that has interactive content rendering inside it, from its own tree or from a placement's slot. */
export function cardLinkProblems(state: ProjectState): CardProblem[] {
  const out: CardProblem[] = [];
  const memo = new Map<string, Map<string, CardRef[]>>();
  for (const { owner, tree, label } of allTrees(state)) {
    const ownDefs = owner.kind === 'component' ? [owner.id] : [];
    for (const n of Object.values(tree.nodes)) {
      if (isCardLink(n)) {
        const what = firstInteractive(state, tree, n.children, null, ownDefs, null);
        if (what) out.push({ owner, label, nodeId: n.id, cards: [{ owner, cardId: n.id }], what });
      }
      if (n.kind !== 'instance') continue;
      const def = state.components[n.definitionId];
      if (def?.kind !== 'managed') continue;
      for (const [slot, cards] of cardSlots(state, def, memo)) {
        const what = firstInteractive(state, tree, n.slots?.[slot] ?? [], null, ownDefs, null);
        if (what) out.push({ owner, label, nodeId: n.id, cards, what });
      }
    }
  }
  return out;
}

/** Keys of the cards that must render as their plain container (`owner kind:owner id:node id`). */
export function brokenCardKeys(state: ProjectState): Set<string> {
  return new Set(cardLinkProblems(state).flatMap((p) => p.cards.map(cardKey)));
}

export { cardKey };
