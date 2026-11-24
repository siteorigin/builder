/**
 * Card links: containers that render as one link (`ElementNode.link`). A link inside a link, or any other control
 * inside one, is invalid HTML that browsers repair unpredictably, so nothing interactive may render inside a card.
 * Validation reports each card that breaks this, and the generator renders those cards as their plain container.
 */
import type { ComponentDefinition, ElementNode, GraphNode, LinkValue, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import { isBinding, slotChildren } from '@shared/types';
import { spanRuns, toRichText, type RichSpan } from '@shared/richtext';
import { allTrees } from '@engine/tree';
import { boundSchema } from '@engine/schema';

/** Elements that are controls in their own right. */
const INTERACTIVE_TAGS = new Set(['details', 'summary']);

/** Tags a link cannot wrap: the link would sit between a list or figure and its item or caption, or around a disclosure. */
const UNWRAPPABLE_TAGS = new Set(['li', 'dt', 'dd', 'figcaption', 'details', 'summary']);

/**
 * Whether an element's action can take effect: it has one, and a fixed tag that a link may wrap. Any other element
 * with an action renders as itself, doing nothing when clicked and following no destination it keeps.
 */
export function actionWraps(n: GraphNode): boolean {
  if (n.kind !== 'element' || n.action === undefined || n.action === null) return false;
  return !isBinding(n.tag) && !UNWRAPPABLE_TAGS.has(n.tag);
}

/**
 * Whether an element is a card, one link around its content: it carries a binding or a destination of its own, or
 * an action that may open its image or follow its link. An action fixed at anything else makes no link, whatever
 * destination the element keeps; one fixed at `link` is a card while it has a destination.
 */
export function isCardLink(n: GraphNode): boolean {
  if (n.kind !== 'element') return false;
  if (n.action !== undefined && n.action !== null) {
    if (!actionWraps(n)) return false;
    if (isBinding(n.action) || n.action === 'image') return true;
    if (n.action !== 'link') return false;
  }
  if (n.link === undefined || n.link === null) return false;
  return isBinding(n.link) || ((n.link as LinkValue).type !== undefined && (n.link as LinkValue).type !== 'none');
}

/**
 * Whether an element is a carousel track (`ElementNode.carousel`) that renders with its Previous and Next buttons: a
 * literal list that is not a card. An element marked as one in any other way renders as itself.
 */
export function isCarouselTrack(n: GraphNode): boolean {
  return n.kind === 'element' && n.carousel === true && n.tag === 'ul' && !isCardLink(n);
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

export const cardKey = (c: CardRef) => `${c.owner.kind}:${c.owner.id}:${c.cardId}`;

/** Cards from both lists, each once: forwarding one slot through many placements still names each card once. */
const mergeCards = (a: CardRef[], b: CardRef[]): CardRef[] => {
  if (!b.length) return a;
  const keys = new Set(a.map(cardKey));
  return [...a, ...b.filter((c) => !keys.has(cardKey(c)) && keys.add(cardKey(c)))];
};

function richHasLink(value: unknown): boolean {
  const spans = (s: RichSpan[]) => s.some((x) => !!x.link);
  return toRichText(value).some((b) => spanRuns(b).some(spans));
}

function describe(n: GraphNode, def?: ComponentDefinition): string {
  const name = n.name ? `“${n.name}”` : '';
  switch (n.kind) {
    case 'link':
      return name ? `the ${name} button` : n.stateAction ? 'a button that changes UI state' : 'a button or link';
    case 'element':
      if (name) return `the ${name} element`;
      if (isCardLink(n)) return n.action !== undefined ? 'a container that opens its image or a link' : 'another card link';
      if (isCarouselTrack(n)) return 'a carousel with Previous and Next buttons';
      return isBinding(n.tag) ? 'an element that can render as a details disclosure' : `a ${n.tag} element`;
    case 'text':
      return name ? `the ${name} text` : 'rich text with links';
    case 'instance':
      return def ? `“${def.name}”` : 'a component';
    default:
      return name || `a ${n.kind}`;
  }
}

/** One pass over a project: what each definition renders is worked out once, however often it is placed. */
interface Pass {
  state: ProjectState;
  /** The interactive thing a definition's own content renders (slots aside), or null. */
  intrinsic: Map<string, string | null>;
  /** The slots a definition actually renders. */
  rendered: Map<string, Set<string>>;
  /** For each slot a definition renders inside a card, the cards it renders inside. */
  cardSlots: Map<string, Map<string, CardRef[]>>;
  /** Definitions being worked out: one that contains itself (refused by validation) counts as empty. */
  open: Set<string>;
}

const newPass = (state: ProjectState): Pass => ({ state, intrinsic: new Map(), rendered: new Map(), cardSlots: new Map(), open: new Set() });

/** Memoized per definition, with a definition that contains itself given `empty`. */
function once<T>(pass: Pass, memo: Map<string, T>, key: string, empty: T, work: () => T): T {
  if (memo.has(key)) return memo.get(key)!;
  const guard = `${memo === pass.intrinsic ? 'i' : memo === pass.rendered ? 'r' : 'c'}:${key}`;
  if (pass.open.has(guard)) return empty;
  pass.open.add(guard);
  try {
    const out = work();
    memo.set(key, out);
    return out;
  } finally {
    pass.open.delete(guard);
  }
}

/**
 * The slots a definition renders: the slots its tree places, including those passed on to a nested component's
 * slot that the nested component renders. A code component may render any slot it declares.
 */
function renderedSlots(pass: Pass, def: ComponentDefinition): Set<string> {
  if (def.kind === 'code') return new Set(Object.keys(def.slots ?? {}));
  return once(pass, pass.rendered, def.id, new Set<string>(), () => {
    const out = new Set<string>();
    const tree = def.tree;
    if (!tree) return out;
    const seen = new Set<string>();
    const walk = (ids: string[]) => {
      for (const id of ids) {
        const n = tree.nodes[id];
        if (!n || seen.has(id)) continue;
        seen.add(id);
        if (n.kind === 'slot') out.add(n.slot);
        else if (n.kind === 'element' || n.kind === 'repeat') walk(n.children);
        else if (n.kind === 'instance') {
          const nested = pass.state.components[n.definitionId];
          if (!nested) continue;
          const shown = renderedSlots(pass, nested);
          for (const slot of Object.keys(n.slots ?? {})) if (shown.has(slot)) walk(slotChildren(n, slot));
        }
      }
    };
    walk(tree.rootIds);
    return out;
  });
}

/** Whether an element renders as a disclosure: a literal details or summary tag, or a choice that offers one. */
function interactiveTag(def: ComponentDefinition | undefined, n: ElementNode): boolean {
  if (!isBinding(n.tag)) return INTERACTIVE_TAGS.has(n.tag);
  const schema = def ? boundSchema(def, n.id, n.tag) : undefined;
  return schema?.type === 'enum' && schema.options.some((o) => INTERACTIVE_TAGS.has(o.value));
}

/**
 * The first interactive thing that renders from `ids` in `tree` (owned by `def`, or a page or the shell): a link,
 * another card, a disclosure, rich text that has or may get links, or a code component (which can place any
 * control). A managed component counts by its own content, and by the content its placement gives the slots it
 * renders. A slot of the definition being read is judged where that definition is placed.
 */
function firstInteractive(pass: Pass, def: ComponentDefinition | undefined, tree: NodeTree, ids: string[], path = new Set<string>()): string | null {
  for (const id of ids) {
    const n = tree.nodes[id];
    // A hand-edited tree can list a node under itself: a node already being read further up is skipped.
    if (!n || path.has(id)) continue;
    path.add(id);
    try {
      let inner: string | null = null;
      switch (n.kind) {
        case 'link':
          return describe(n);
        case 'element':
          if (isCardLink(n) || interactiveTag(def, n) || isCarouselTrack(n)) return describe(n);
          inner = firstInteractive(pass, def, tree, n.children, path);
          break;
        case 'repeat':
          inner = firstInteractive(pass, def, tree, n.children, path);
          break;
        case 'text':
          // Bound rich text takes whatever its placement writes, links included.
          if (n.rich && (isBinding(n.text) || richHasLink(n.text))) return n.name ? describe(n) : isBinding(n.text) ? 'rich text, which can hold links' : 'rich text with links';
          break;
        case 'instance': {
          const placed = pass.state.components[n.definitionId];
          if (!placed) break;
          if (placed.kind === 'code') return `${describe(n, placed)}, a code component that can place links and controls`;
          const own = intrinsicInteractive(pass, placed);
          if (own) return `${describe(n, placed)}, which holds ${own}`;
          for (const slot of renderedSlots(pass, placed)) {
            inner = firstInteractive(pass, def, tree, slotChildren(n, slot), path);
            if (inner) break;
          }
          break;
        }
      }
      if (inner) return inner;
    } finally {
      path.delete(id);
    }
  }
  return null;
}

/** What a managed definition's own content makes interactive wherever it is placed, or null. */
function intrinsicInteractive(pass: Pass, def: ComponentDefinition): string | null {
  return once(pass, pass.intrinsic, def.id, null, () => (def.tree ? firstInteractive(pass, def, def.tree, def.tree.rootIds) : null));
}

/**
 * For each slot a definition renders inside a card, the cards it renders inside: a slot placed under one of its
 * own cards, or passed on to a slot that a nested component renders inside a card of its own.
 */
function cardSlots(pass: Pass, def: ComponentDefinition): Map<string, CardRef[]> {
  return once(pass, pass.cardSlots, def.id, new Map<string, CardRef[]>(), () => {
    const out = new Map<string, CardRef[]>();
    const tree = def.tree;
    if (def.kind !== 'managed' || !tree) return out;
    const add = (slot: string, cards: CardRef[]) => out.set(slot, mergeCards(out.get(slot) ?? [], cards));
    const seen = new Set<string>();
    const walk = (ids: string[], cards: CardRef[]) => {
      for (const id of ids) {
        const n = tree.nodes[id];
        if (!n || seen.has(id)) continue;
        seen.add(id);
        if (n.kind === 'slot' && cards.length) add(n.slot, cards);
        if (n.kind === 'element' || n.kind === 'repeat') walk(n.children, isCardLink(n) ? mergeCards(cards, [{ owner: { kind: 'component', id: def.id }, cardId: n.id }]) : cards);
        if (n.kind === 'instance') {
          const nested = pass.state.components[n.definitionId];
          if (!nested) continue;
          const shown = renderedSlots(pass, nested);
          const inner = cardSlots(pass, nested);
          for (const slot of Object.keys(n.slots ?? {})) if (shown.has(slot)) walk(slotChildren(n, slot), mergeCards(cards, inner.get(slot) ?? []));
        }
      }
    };
    walk(tree.rootIds, []);
    return out;
  });
}

/** Every card that has interactive content rendering inside it, from its own tree or from a placement's slot. */
export function cardLinkProblems(state: ProjectState): CardProblem[] {
  const out: CardProblem[] = [];
  const pass = newPass(state);
  for (const { owner, tree, label } of allTrees(state)) {
    const def = owner.kind === 'component' ? state.components[owner.id] : undefined;
    for (const n of Object.values(tree.nodes)) {
      if (n.kind === 'element' && isCardLink(n)) {
        const what = firstInteractive(pass, def, tree, n.children);
        if (what) out.push({ owner, label, nodeId: n.id, cards: [{ owner, cardId: n.id }], what });
      }
      if (n.kind !== 'instance') continue;
      const placed = state.components[n.definitionId];
      if (!placed) continue;
      for (const [slot, cards] of cardSlots(pass, placed)) {
        const what = firstInteractive(pass, def, tree, slotChildren(n, slot));
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

/** The slots of a definition that render inside one of its cards (or a nested component's card). */
export function slotsInsideCards(state: ProjectState, def: ComponentDefinition): string[] {
  return [...cardSlots(newPass(state), def).keys()];
}
