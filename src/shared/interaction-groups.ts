/**
 * Interaction groups (`ElementNode.interactionGroup`): a container, usually a card, whose hover or focus shows the
 * `groupHover` and `groupFocus` styles of the elements inside it. Pure helpers shared by the engine, the generator,
 * the editor and the agent, so all of them agree on which styles a group can reach.
 *
 * A group state's rule applies only to an element some group encloses in its own document: its page, the shared header
 * or footer, a collection's layout, or the component design it belongs to. Which group shows it is decided where it
 * renders, by the nearest group around it: a card inside a card is a boundary, so what is in the inner one follows the
 * inner one alone.
 */
import type { ComponentDefinition, GraphNode, NodeTree, ResponsiveStyles } from './types';
import { isGroupStyleState, parseStyleScopeKey } from './types';

/** The class a group's element carries in the generated markup, which every group state selector names. */
export const INTERACTION_GROUP_CLASS = 'so-group';

/** Whether a node is a group: a container marked as one. */
export const isInteractionGroup = (node: GraphNode | undefined | null): boolean => !!node && node.kind === 'element' && (node as { interactionGroup?: unknown }).interactionGroup === true;

/**
 * Each node's parent in a tree: children of containers and repeats, and content placed in a placement's slots, which
 * renders inside that placement.
 */
function parentsOf(tree: NodeTree): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of Object.values(tree.nodes ?? {})) {
    if (!n || typeof n !== 'object') continue;
    const lists = n.kind === 'element' || n.kind === 'repeat' ? [n.children] : n.kind === 'instance' ? Object.values(n.slots ?? {}) : [];
    for (const list of lists) if (Array.isArray(list)) for (const c of list) if (typeof c === 'string' && !out.has(c)) out.set(c, n.id);
  }
  return out;
}

/**
 * A lookup of the nearest group strictly around each node of a tree (null for none), never the node itself: a group is
 * not its own. Trees change in place as they are edited, so the lookup reads the tree as it is when it is made: make
 * one per pass.
 */
export function groupLookup(tree: NodeTree | undefined | null): (nodeId: string) => string | null {
  if (!tree?.nodes || typeof tree.nodes !== 'object') return () => null;
  const parents = parentsOf(tree);
  const memo = new Map<string, string | null>();
  return (nodeId) => {
    if (memo.has(nodeId)) return memo.get(nodeId)!;
    // Every container passed on the way up shares the answer: the first group above it, or what one already asked
    // for answers. A loop in a damaged tree ends the walk with none.
    let found: string | null = null;
    const path = [nodeId];
    const seen = new Set<string>(path);
    for (let at = parents.get(nodeId); at !== undefined && !seen.has(at); at = parents.get(at)) {
      if (isInteractionGroup(Object.hasOwn(tree.nodes, at) ? tree.nodes[at] : undefined)) {
        found = at;
        break;
      }
      if (memo.has(at)) {
        found = memo.get(at)!;
        break;
      }
      seen.add(at);
      path.push(at);
    }
    for (const id of path) memo.set(id, found);
    return found;
  };
}

/** The nearest group strictly around a node in its tree, or null. */
export const enclosingGroup = (tree: NodeTree | undefined | null, nodeId: string): string | null => groupLookup(tree)(nodeId);

/** A code component's markup that renders an interaction group (the class written as a class name of its own). */
const CODE_GROUP = new RegExp(`(^|[^\\w-])${INTERACTION_GROUP_CLASS}(?![\\w-])`);

/**
 * Whether a group can reach a part of a placement: one around the placement itself in the document it sits in
 * (`placed`, whether a group encloses the placement there), or one enclosing that part in its component's design. A
 * placement's root has no group of its own design around it, so only the first can reach it. A code component's
 * markup is its source, which no tree describes: one that renders a group (a managed design converted to code keeps
 * its groups) lets its parts follow it, and the rule itself still needs that group around the part to apply. `lookups`
 * keeps one lookup per design across a pass.
 */
export function partInInteractionGroup(def: ComponentDefinition | undefined, partId: string, placed: boolean, lookups?: Map<string, (nodeId: string) => string | null>): boolean {
  if (placed) return true;
  if (def?.kind === 'code') return typeof def.source === 'string' && CODE_GROUP.test(def.source);
  if (!def || def.kind !== 'managed' || !def.tree) return false;
  const nodeId = partId === 'root' || !Object.hasOwn(def.parts ?? {}, partId) ? def.tree.rootIds[0] : def.parts[partId]?.nodeId;
  if (!nodeId) return false;
  let find = lookups?.get(def.id);
  if (!find) {
    find = groupLookup(def.tree);
    lookups?.set(def.id, find);
  }
  return find(nodeId) !== null;
}

/** A set of styles without its group state rules (those no group can show stay unshown when copied elsewhere). */
export function withoutGroupStates(styles: ResponsiveStyles | undefined): ResponsiveStyles | undefined {
  if (!styles || typeof styles !== 'object' || !Object.keys(styles).some((k) => isGroupStyleState(parseStyleScopeKey(k)?.state))) return styles;
  return Object.fromEntries(Object.entries(styles).filter(([k]) => !isGroupStyleState(parseStyleScopeKey(k)?.state))) as ResponsiveStyles;
}

/** Whether a set of styles holds any group state rule. */
export const hasGroupStyles = (styles: ResponsiveStyles | undefined | null): boolean =>
  !!styles && typeof styles === 'object' && Object.entries(styles).some(([k, v]) => isGroupStyleState(parseStyleScopeKey(k)?.state) && !!v && typeof v === 'object' && Object.keys(v).length > 0);
