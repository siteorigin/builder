import { listThemes } from '@catalogue/index';
import { cardKey, cardLinkChecker, cardLinkProblems, type CardProblem } from '@generator/card-links';
import { sameValue } from '@shared/same';
import type { NodeTree, OwnerRef, PageDoc, ProjectState } from '@shared/types';
import { allTrees } from './tree';

/** One document's tree as validation checks it (see allTrees). */
export interface CheckedTree {
  owner: OwnerRef;
  tree: NodeTree;
  label: string;
}

/**
 * How one validation of a state works out its parts: each afresh, or kept from an earlier state's (ValidationCache).
 * `shared` is a part that reads no page's tree; `tree` is one document's part, which reads that tree and what a shared
 * part may read, and is not kept when `keeps` says its value read more; `cards` are the state's card link problems.
 */
export interface Keeper {
  shared<T>(key: string, compute: () => T): T;
  tree<T>(t: CheckedTree, key: string, compute: () => T, keeps?: (value: T) => boolean): T;
  readonly cards: CardProblem[];
}

/** A keeper that keeps nothing: every part worked out from the state, as a validation of a state on its own is. */
export function freshKeeper(state: ProjectState): Keeper {
  let cards: CardProblem[] | undefined;
  return {
    shared: (_key, compute) => compute(),
    tree: (_t, _key, compute) => compute(),
    get cards() {
      return (cards ??= cardLinkProblems(state));
    }
  };
}

/** What a state's checks read beyond the pages' trees: one object for states that read the same, holding the parts kept for it. */
interface Context {
  kept: Map<string, unknown>;
}

const TREE_FIELDS = new Set(['nodes', 'rootIds']);

/** Whether two pages are the same in every field but their tree: an edit of a page's content copies the page whole. */
function samePageFields(a: PageDoc, b: PageDoc): boolean {
  const ka = Object.keys(a).filter((k) => !TREE_FIELDS.has(k));
  const kb = Object.keys(b).filter((k) => !TREE_FIELDS.has(k));
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i] || !sameValue((a as unknown as Record<string, unknown>)[ka[i]], (b as unknown as Record<string, unknown>)[kb[i]])) return false;
  return true;
}

const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * Whether two states give every check the same context: each part of the project but its pages the very same object
 * (the site with its shared header and footer, the components, collections, library, site styles and the rest), the
 * same pages in the same order, and each page that is not the same object the same in every field but its tree.
 */
function sameContext(a: ProjectState, b: ProjectState): boolean {
  const ka = Object.keys(a);
  if (!sameKeys(ka, Object.keys(b))) return false;
  for (const k of ka) if (k !== 'pages' && (a as unknown as Record<string, unknown>)[k] !== (b as unknown as Record<string, unknown>)[k]) return false;
  if (a.pages === b.pages) return true;
  const ids = Object.keys(a.pages);
  if (!sameKeys(ids, Object.keys(b.pages))) return false;
  for (const id of ids) if (a.pages[id] !== b.pages[id] && !samePageFields(a.pages[id], b.pages[id])) return false;
  return true;
}

/**
 * What a session keeps of validation from one state to the next, so an edit checks again only the documents it changed
 * (#966). A kept part is used again only for the very same document object, under the same owner and name, while the
 * state's context is the one it was worked out in: every part of the project but the pages' trees the same
 * (sameContext), the same theme packs loaded, and the same cards rendering as their plain containers (a placement on
 * one page can break the card of a design other pages show). A collection's layout is never kept: the generator marks a
 * stored layout as it reads it, so a later check of one may read it otherwise. Only states that are never changed after
 * they are made come here, as the session's are.
 */
export class ValidationCache {
  private keepers = new WeakMap<ProjectState, { keeper: Keeper; themes: unknown }>();
  private last?: { state: ProjectState; themes: unknown; cards: string; context: Context };
  private trees = new WeakMap<NodeTree, { context: Context; kept: Map<string, unknown> }>();
  /** Each tree's card link problems, which read only that tree and the components. */
  private cardTrees = new WeakMap<NodeTree, { components: ProjectState['components']; key: string; problems: CardProblem[] }>();

  /** The keeper for `state`, the same for each of its validations while the same theme packs are loaded. */
  keeper(state: ProjectState): Keeper {
    const themes = listThemes();
    const known = this.keepers.get(state);
    if (known?.themes === themes) return known.keeper;
    const cards = this.cardProblems(state);
    const broken = JSON.stringify([...new Set(cards.flatMap((p) => p.cards.map(cardKey)))].sort());
    const last = this.last;
    const context: Context = last && last.themes === themes && last.cards === broken && sameContext(last.state, state) ? last.context : { kept: new Map() };
    this.last = { state, themes, cards: broken, context };
    const keeper: Keeper = {
      cards,
      shared: (key, compute) => kept(context.kept, key, compute),
      tree: (t, key, compute, keeps) => {
        if (t.owner.kind === 'template' || t.owner.kind === 'archive') return compute();
        let entry = this.trees.get(t.tree);
        if (!entry || entry.context !== context) this.trees.set(t.tree, (entry = { context, kept: new Map() }));
        return kept(entry.kept, `${key}|${t.owner.kind}:${t.owner.id}|${t.label}`, compute, keeps);
      }
    };
    this.keepers.set(state, { keeper, themes });
    return keeper;
  }

  /**
   * The state's card link problems (cardLinkProblems), each tree's kept while it and the components are the same
   * objects. A pass that meets a definition containing itself reads each tree after the ones before it, so then every
   * tree is read again, in turn, and nothing is kept.
   */
  private cardProblems(state: ProjectState): CardProblem[] {
    const checker = cardLinkChecker(state);
    const trees = allTrees(state);
    const found = trees.map((t) => {
      const key = `${t.owner.kind}:${t.owner.id}|${t.label}`;
      const kept = this.cardTrees.get(t.tree);
      if (kept && kept.components === state.components && kept.key === key) return kept.problems;
      const problems = checker.check(t);
      if (!checker.cycles()) this.cardTrees.set(t.tree, { components: state.components, key, problems });
      return problems;
    });
    return checker.cycles() ? cardLinkProblems(state) : found.flat();
  }
}

/** The value kept under `key`, else worked out and kept (unless `keeps` says otherwise). */
function kept<T>(map: Map<string, unknown>, key: string, compute: () => T, keeps?: (value: T) => boolean): T {
  if (map.has(key)) return map.get(key) as T;
  const value = compute();
  if (!keeps || keeps(value)) map.set(key, value);
  return value;
}
