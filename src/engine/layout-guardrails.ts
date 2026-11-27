import type { ComponentDefinition, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState, ResponsiveStyles, StyleProps } from '@shared/types';
import { isBinding, isBindingRef } from '@shared/types';
import { cascadeStyles, parseCustomCss, parseGridTemplate, styleToCss, type StyleLayer } from '@shared/styles';
import { axesOf, designLayers, selectedVariants } from '@shared/variants';
import { getTheme } from '@catalogue/index';
import { isCarouselTrack } from '@generator/card-links';
import { detachedClasses, nodeAxes, nodeClass, pageNodeClass, variantClass } from '@generator/index';
import { allTrees, childLists, displayName } from './tree';
import { themeLayoutRules, type ThemeLayoutRules } from './theme-layout-rules';
import type { Diagnostic } from './validate';

/*
 * Layout guardrails (#668): three CSS combinations that quietly break a layout, said in plain words.
 *
 * - A sticky element inside a container that hides overflow stops sticking: that container becomes what it sticks
 *   to, and it never scrolls. Overflow Clip trims what spills over its edges without becoming one, which the warning
 *   suggests; it offers no one-step change, since Clip also differs in ways a check cannot see (a box that no longer
 *   scrolls may take its content's size as its least, and a link to something clipped no longer scrolls it into view).
 * - A grid child that spans more columns than its grid has makes the grid add columns of its own to fit it.
 * - An absolutely positioned element with no positioned container around it is placed against the whole page.
 *
 * Each is a warning: the site still saves and exports, and it goes as soon as the layout is fixed. They read the
 * resting styles each screen size's stylesheet gives the boxes the site renders: a page's own elements, a placed
 * component's root, and the elements its design wraps a slot's content in, with the placement's options and changes.
 * Whatever is not known for certain ends a check with no warning, since a missed problem is better than a wrong one:
 * a code component or a runtime helper's own markup, custom CSS or a theme rule that may decide the same thing,
 * content that may not render, and everything outside a component's design, which may be placed anywhere.
 */

type Size = 'phone' | 'tablet' | 'desktop';
const SIZES: readonly Size[] = ['phone', 'tablet', 'desktop'];
/** The keys of resting rules: what shows before any hover, focus or press. */
const RESTING = ['base', 'phone', 'tablet', 'desktop'] as const;

/** A rendered box whose rules are known. */
interface KnownBox {
  kind: 'box';
  /** Which box it is, for telling findings apart. */
  key: string;
  /** How messages name it, quoted. */
  name: string;
  /** The resting style that wins at each size. */
  at: Record<Size, StyleProps>;
  /** The CSS properties its custom CSS sets at any size, which this reading cannot place in the cascade. */
  custom: Set<string>;
  /** Whether its tag is inline (true), may be (a tag a property chooses), or is not: overflow applies to no inline box. */
  inline: boolean | 'maybe';
  /** Its tag, when fixed. */
  tag?: string;
}

/**
 * A box around an element: one whose rules are known, the page itself, or markup this cannot read, which still says
 * the sizes its own styles hide it at (nothing inside shows there).
 */
type Box = KnownBox | { kind: 'page' } | { kind: 'unknown'; hidden: Set<Size> };
/** The page's `<main>` and `<body>`, and the header and footer's: nothing positioned, and only the window scrolls. */
const PAGE: Box = { kind: 'page' };
/** Markup that hides nothing of its own: a runtime link around an element, or wherever a design is placed. */
const OPEN: Box = { kind: 'unknown', hidden: new Set() };

const hiddenAt = (b: Box, size: Size) => (b.kind === 'box' ? b.at[size].hidden === true : b.kind === 'unknown' && b.hidden.has(size));

/** A value the stylesheet writes for a property, as text ("sticky", "3"); undefined for one it leaves out. */
function written(props: StyleProps, prop: string): string | undefined {
  const v = props[prop];
  if (v === undefined || v === null || typeof v === 'object') return undefined;
  return styleToCss(prop, v).length ? String(v).trim() : undefined;
}

const customSets = (b: KnownBox, re: RegExp) => [...b.custom].some((p) => re.test(p));

/** Tags a browser lays out inline until a layout says otherwise. */
const INLINE_TAGS = new Set(['span', 'small', 'strong', 'cite']);
const FLEX_OR_GRID = new Set(['stack', 'row', 'grid']);

/** How many columns a grid lays out at a size: its count, or its column sizes; undefined for none, or as many as fit. */
function explicitColumns(props: StyleProps): number | undefined {
  if (written(props, 'layout') !== 'grid') return undefined;
  // The cascade has already chosen between a count and column sizes: they write the same CSS property.
  if (props.gridTemplate !== undefined) {
    const template = written(props, 'gridTemplate');
    const parsed = template === undefined ? template : parseGridTemplate(template);
    return parsed && typeof parsed !== 'string' && parsed.fr.length ? parsed.fr.length : undefined;
  }
  const n = Number(written(props, 'columns'));
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** The columns a grid child spans at a size, when more than one ("full" spans exactly the grid's own). */
function spanOf(props: StyleProps): number | undefined {
  const raw = written(props, 'columnSpan');
  const n = raw === undefined || raw === 'full' ? NaN : Number(raw);
  return Number.isInteger(n) && n > 1 ? n : undefined;
}

/** The column line a grid child starts on at a size, when it names one; Full width always starts on line 1. */
function startOf(props: StyleProps): number | undefined {
  if (written(props, 'columnSpan') === 'full') return undefined;
  const n = Number(written(props, 'columnStart'));
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** An offset a browser surely keeps: zero, a length or a percentage (math is not read, since it may not type-check). */
const LENGTH = /^(0|-?(\d+(\.\d+)?|\.\d+)(px|r?em|%|ch|ex|vh|vw|vmin|vmax|[sld]vh|[sld]vw))$/;

/** Whether a sticky box has an offset from the top or bottom, without which it never sticks as the page scrolls. */
function sticksVertically(props: StyleProps): boolean {
  const inset = written(props, 'inset');
  if (inset === undefined) return false;
  const sides: string[] = [];
  let depth = 0;
  let word = '';
  for (const ch of `${inset} `) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (/\s/.test(ch) && depth === 0) {
      if (word) sides.push(word);
      word = '';
    } else word += ch;
  }
  // The browser drops the whole shorthand for one side it cannot read.
  if (sides.length < 1 || sides.length > 4 || !sides.every((side) => side === 'auto' || LENGTH.test(side))) return false;
  // One value is every side; two are top-and-bottom then the sides; three and four give the bottom third.
  return sides[0] !== 'auto' || (sides.length >= 3 ? sides[2] : sides[0]) !== 'auto';
}

/** Custom CSS that may make a box what an absolutely positioned element inside it is placed in. */
const CONTAINING_CSS = /^(position|transform|translate|rotate|scale|filter|backdrop-filter|-webkit-backdrop-filter|perspective|contain|container(-type)?|will-change|content-visibility)$/;

/** Whether a box is (or may be) what absolutely positioned elements inside it are placed in, at a size. */
function contains(b: KnownBox, size: Size): boolean {
  const at = b.at[size];
  const position = written(at, 'position');
  if (position === 'relative' || position === 'sticky' || position === 'absolute' || position === 'fixed') return true;
  // Any shift, scale or turn does, even one that moves nothing; so does a blur behind it.
  if (['translateX', 'translateY', 'scale', 'rotate'].some((p) => written(at, p) !== undefined)) return true;
  const blur = written(at, 'backdropBlur');
  if (blur !== undefined && Number.parseFloat(blur) !== 0) return true;
  return customSets(b, CONTAINING_CSS);
}

/** Custom CSS that decides overflow (not `overflow-wrap`, which only breaks words). */
const OVERFLOW_CSS = /^overflow(-x|-y|-block|-inline)?$/;

/**
 * Whether overflow applies to a box at a size: not to an inline one, unless a layout of its own or its parent's (whose
 * children are blocks), or absolute positioning, makes it a block. Null when that is not known.
 */
function blockAt(chain: Box[], i: number, size: Size): boolean | null {
  const b = chain[i] as KnownBox;
  if (b.custom.has('position')) return null;
  // Placed absolutely, it is a block too.
  const position = written(b.at[size], 'position');
  if (b.inline === false || written(b.at[size], 'layout') !== undefined || position === 'absolute' || position === 'fixed') return true;
  const parent = chain[i - 1];
  if (parent?.kind === 'box' && FLEX_OR_GRID.has(written(parent.at[size], 'layout') ?? '')) return true;
  return b.inline === true && parent?.kind !== 'unknown' ? false : null;
}

/**
 * Where in the boxes around an element (innermost last) the nearest one that hides overflow is, at a size, before
 * anything else could scroll; -1 for none, or for something on the way this cannot read.
 */
function clipAt(chain: Box[], size: Size, from = chain.length - 1): number {
  for (let i = from; i >= 0; i--) {
    const b = chain[i];
    if (b.kind !== 'box' || customSets(b, OVERFLOW_CSS)) return -1;
    if (written(b.at[size], 'overflow') !== 'hidden') continue;
    const block = blockAt(chain, i, size);
    if (block === null) return -1;
    if (block) return i;
  }
  return -1;
}

/** Whether nothing around an element is positioned at a size, all the way out to the page. */
function unanchored(chain: Box[], size: Size): boolean {
  for (let i = chain.length - 1; i >= 0; i--) {
    const b = chain[i];
    if (b.kind !== 'box') return b.kind === 'page';
    if (contains(b, size)) return false;
  }
  return false;
}

const SIZE_WORDS: Record<Size, string> = { phone: 'phones', tablet: 'tablets', desktop: 'desktops' };
/** "on tablets, ", "on tablets and desktops, ", or nothing at every size. */
const onSizes = (sizes: Size[]) => (sizes.length === SIZES.length ? '' : `on ${sizes.map((s) => SIZE_WORDS[s]).join(' and ')}, `);

interface Finding {
  code: string;
  nodeId: string;
  site: string;
  sizes: Size[];
  message: (where: string) => string;
}

/** The node a declared part names: only a declared part's changes reach the markup (see the generator's classExpr). */
const partNode = (def: ComponentDefinition, partId: string) => (def.parts && Object.hasOwn(def.parts, partId) ? def.parts[partId]?.nodeId : undefined);

/** Whether a source of styles shows something again at some size, which the stylesheet writes a display of its own for. */
const showsAgain = (rs: ResponsiveStyles | undefined) => RESTING.some((scope) => rs?.[scope]?.hidden === false);

/**
 * The rules on one of a design's elements in one placement, weakest first, as the stylesheets cascade them (see
 * `designLayers` and detach's `layersFor`): its own styles, the chosen options', then the placement's changes to the
 * part it is. Null when they do not say what shows: an option chosen through a property, or styles for single items.
 */
function placementLayers(def: ComponentDefinition, inst: InstanceNode, nodeId: string): StyleLayer[] | null {
  for (const [axis, a] of axesOf(def)) if (isBindingRef(inst.variants?.[axis]) && Object.values(a.options ?? {}).some((o) => o?.styles?.[nodeId])) return null;
  if (Object.keys(inst.itemOverrides ?? {}).some((pid) => partNode(def, pid) === nodeId)) return null;
  const layers = designLayers(def, nodeId, inst.variants);
  const designed = layers.map((l) => l.styles);
  for (const pid of Object.keys(inst.overrides ?? {}).sort())
    if (partNode(def, pid) === nodeId) layers.push({ styles: inst.overrides![pid], strength: 3, wideColumns: true, unhides: designed });
  return layers;
}

/** The classes a design's element carries in a placement, which a theme's rules can hook. */
function designClasses(def: ComponentDefinition, n: GraphNode, chosen: InstanceNode['variants']): string[] {
  const selected = selectedVariants(def, chosen);
  const axes = n.id === def.tree?.rootIds[0] ? axesOf(def).map(([axis]) => axis) : nodeAxes(def, n.id);
  return [nodeClass(def, n.id), ...detachedClasses(n), ...axes.flatMap((axis) => (typeof selected[axis] === 'string' ? [variantClass(def, axis, selected[axis] as string)] : []))];
}

/** Elements the runtime renders inside a helper's own markup (a carousel's frame, a dialog), or may wrap (an action). */
const helped = (n: GraphNode) => n.kind === 'element' && (isCarouselTrack(n) || n.overlay !== undefined);
const acting = (n: GraphNode) => n.kind === 'element' && n.action !== undefined && n.action !== null;
/** Whether a node renders only under a condition, or once per item of a list (none for an empty one). */
const conditional = (n: GraphNode) => n.kind === 'repeat' || (n as { when?: unknown }).when !== undefined || (n as { unless?: unknown }).unless !== undefined;

/** Each node's parent in a design. */
function parentsOf(tree: NodeTree): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of Object.values(tree.nodes)) for (const cl of childLists(n)) for (const c of cl.ids) if (!out.has(c)) out.set(c, n.id);
  return out;
}

/** What every tree reads of the designs placed in it and of the theme, worked out once per validation. */
interface Shared {
  theme: ThemeLayoutRules;
  /** Each design's parent map. */
  parents: Map<string, Map<string, string>>;
  /** The nodes from a design's root to the one place it renders a slot (`id|slot`), or null for none or several. */
  slotPaths: Map<string, string[] | null>;
}

/**
 * Diagnostics for every page, header, footer, collection layout and project component, read against the project
 * theme's stylesheet (or `themeCss`).
 */
export function layoutGuardrailDiagnostics(state: ProjectState, themeCss?: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let theme: ThemeLayoutRules;
  try {
    theme = themeLayoutRules(themeCss ?? getTheme(state.site.themeId).baseCss ?? '');
  } catch {
    // A stylesheet this cannot read may position anything: say nothing about what is placed against the page.
    theme = { page: true, reaches: () => true };
  }
  const shared: Shared = { theme, parents: new Map(), slotPaths: new Map() };
  for (const { owner, tree, label } of allTrees(state)) {
    const def = owner.kind === 'component' ? state.components[owner.id] : undefined;
    // Theme components are fixed theme data, though their styles count where they are placed; a code component
    // renders its source, whatever tree it was saved with.
    if (def && (def.owner === 'theme' || def.kind !== 'managed')) continue;
    try {
      for (const d of treeGuardrails(state, owner, tree, label, def, shared)) out.push(d);
    } catch {
      /* a document damaged by hand: the structural checks say what is wrong with it */
    }
  }
  return out;
}

function treeGuardrails(state: ProjectState, owner: OwnerRef, tree: NodeTree, label: string, def: ComponentDefinition | undefined, { theme, parents, slotPaths }: Shared): Diagnostic[] {
  const found = new Map<string, Finding>();
  const record = (key: string, size: Size, make: () => Omit<Finding, 'sizes'>) => {
    const f = found.get(key) ?? found.set(key, { ...make(), sizes: [] }).get(key)!;
    f.sizes.push(size);
    return f;
  };
  const quoted = (n: GraphNode, d?: ComponentDefinition) => `“${displayName(state, n, d)}”`;

  /**
   * A box from layers of rules. Null when nothing inside it can be read: its rules depend on content, a theme rule may
   * reach it or what it holds, or custom CSS may change what it displays as (none, contents). Unknown, with the sizes
   * it hides at, when the generator writes a display of its own for it (a rule that shows it again).
   */
  const boxOf = (layers: StyleLayer[] | null, n: GraphNode, key: string, name: string, classes: string[]): Box | null => {
    const tag = (n as { tag?: unknown }).tag;
    // A card renders as a link while its destination resolves; a tag a property chooses may be any.
    const renders = typeof tag === 'string' && !isBinding(tag) ? [tag, ...((n as { link?: unknown }).link !== undefined ? ['a'] : [])] : undefined;
    if (!layers || theme.reaches(classes, renders)) return null;
    const custom = new Set<string>();
    for (const layer of layers)
      for (const scope of RESTING) {
        const css = layer.styles?.[scope]?.customCss;
        if (typeof css === 'string') for (const d of parseCustomCss(css).decls) custom.add(d.slice(0, d.indexOf(':')).trim());
      }
    if (custom.has('display')) return null;
    const won = cascadeStyles(layers);
    const at = { phone: won.phone ?? {}, tablet: won.tablet ?? {}, desktop: won.desktop ?? {} };
    if (layers.length > 1 && layers.some((l) => showsAgain(l.styles))) return { kind: 'unknown', hidden: new Set(SIZES.filter((s) => at[s].hidden === true)) };
    const inline = typeof tag !== 'string' || isBinding(tag) ? 'maybe' : INLINE_TAGS.has(tag);
    return { kind: 'box', key, name, at, custom, inline, tag: typeof tag === 'string' ? tag : undefined };
  };
  /** A box read as a runtime helper's markup: unknown, though still hidden where its own styles hide it. */
  const asHelper = (b: Box): Box => ({ kind: 'unknown', hidden: new Set(SIZES.filter((s) => hiddenAt(b, s))) });

  /** Check one box as the element it is, inside the boxes around it (innermost last). */
  const check = (b: KnownBox, chain: Box[], subject: { id: string; name: string }) => {
    const parent = chain[chain.length - 1];
    for (const size of SIZES) {
      // Hidden here, or inside something hidden here: nothing shows to go wrong.
      if (b.at[size].hidden === true || chain.some((c) => hiddenAt(c, size))) continue;
      const position = b.custom.has('position') ? undefined : written(b.at[size], 'position');
      // Inside a pinned box, it stays in view with that box whatever it sticks to.
      const pinned = chain.some((c) => c.kind === 'box' && written(c.at[size], 'position') === 'sticky');
      const clip = position === 'sticky' && !pinned && sticksVertically(b.at[size]) ? clipAt(chain, size) : -1;
      if (clip >= 0) {
        const box = chain[clip] as KnownBox;
        record(JSON.stringify(['sticky', subject.id, box.key]), size, () => ({
          code: 'LAYOUT_STICKY_CLIPPED',
          nodeId: subject.id,
          site: JSON.stringify([subject.id, box.key]),
          message: (where) =>
            `${label}: ${where}${subject.name} is set to stick while the page scrolls, but ${box.name} around it hides overflow, so it scrolls away with everything else. Set the Overflow of ${box.name} to Clip: it still trims what spills over its edges, and lets ${subject.name} stick.`
        }));
      }
      if (position === 'absolute' && unanchored(chain, size))
        record(JSON.stringify(['absolute', subject.id]), size, () => ({
          code: 'LAYOUT_ABSOLUTE_UNANCHORED',
          nodeId: subject.id,
          site: JSON.stringify([subject.id]),
          message: (where) =>
            parent.kind === 'box'
              ? `${label}: ${where}${subject.name} is positioned absolutely, but no container around it is Relative, Sticky or Absolute, so it is placed against the whole page instead of inside ${parent.name}. Set the Position of ${parent.name} to Relative.`
              : `${label}: ${where}${subject.name} is positioned absolutely with no container around it, so it is placed against the whole page. Put it inside a container, and set that container’s Position to Relative.`
        }));
      // A grid child in the grid's flow: one placed absolutely makes no columns, custom CSS may move either, and a
      // disclosure lays out its content in a box of its own.
      const span = spanOf(b.at[size]);
      const start = startOf(b.at[size]);
      if ((span === undefined && start === undefined) || position === 'absolute' || parent?.kind !== 'box' || parent.tag === undefined || parent.tag === 'details') continue;
      if (customSets(b, /^(position|grid)/) || customSets(parent, /^grid/)) continue;
      const columns = explicitColumns(parent.at[size]);
      // The last column it covers; with no start of its own, the earliest it could be.
      const last = (start ?? 1) + (span ?? 1) - 1;
      if (columns === undefined || last <= columns) continue;
      const count = (n: number) => (n === 1 ? '1 column' : `${n} columns`);
      const added = last - columns === 1 ? 'a column' : `${last - columns} columns`;
      record(JSON.stringify(['span', subject.id, start ?? null, span ?? 1, columns]), size, () => ({
        code: 'LAYOUT_SPAN_OVERFLOW',
        nodeId: subject.id,
        site: JSON.stringify([subject.id, parent.key]),
        message: (where) =>
          start === undefined
            ? `${label}: ${where}${subject.name} spans ${span} columns, but its grid has only ${count(columns)}, so the grid adds ${added} of its own to fit it, squeezing the others. Lower its Column span to ${columns}, or give the grid more columns.`
            : `${label}: ${where}${subject.name} starts on line ${start} and spans ${count(span ?? 1)}, but its grid has only ${count(columns)}, so the grid adds ${added} of its own to fit it, squeezing the others. Lower its Column start or Column span, or give the grid more columns.`
      }));
    }
  };

  /** One of a design's elements as it renders in a placement: its root also carries the placement's detached classes. */
  const designBox = (inst: InstanceNode, d: ComponentDefinition, n: GraphNode): Box | null => {
    const root = n.id === d.tree?.rootIds[0];
    const part = Object.values(d.parts ?? {}).find((p) => p?.nodeId === n.id && !root);
    const name = root ? quoted(inst) : `“${part?.label || displayName(state, n, d)}” in ${quoted(inst)}`;
    return boxOf(placementLayers(d, inst, n.id), n, `${inst.id}/${n.id}`, name, [...designClasses(d, n, inst.variants), ...(root ? detachedClasses(inst) : [])]);
  };

  /**
   * The boxes a design renders around a slot's content in one placement, outermost first, from its root; null when
   * they cannot be read, or the content may not render (a condition or a list on the way).
   */
  const slotPath = (inst: InstanceNode, d: ComponentDefinition, slot: string): Box[] | null => {
    const t = d.tree!;
    const cached = `${d.id}|${slot}`;
    if (!slotPaths.has(cached)) {
      const map = parents.get(d.id) ?? parents.set(d.id, parentsOf(t)).get(d.id)!;
      const reachable = (id: string) => {
        const seen = new Set<string>();
        for (let at: string | undefined = id; at !== undefined; at = map.get(at)) {
          if (seen.has(at)) return null;
          seen.add(at);
          if (!map.has(at)) return t.rootIds.includes(at) ? [...seen].reverse() : null;
        }
        return null;
      };
      const paths = Object.values(t.nodes).flatMap((n) => (n.kind === 'slot' && n.slot === slot ? [reachable(n.id)] : [])).filter((p): p is string[] => p !== null);
      // Content rendered in two places, or nowhere, sits in no one place to read.
      slotPaths.set(cached, paths.length === 1 ? paths[0] : null);
    }
    const ids = slotPaths.get(cached);
    if (!ids || ids.some((id) => conditional(t.nodes[id]))) return null;
    const out: Box[] = [];
    for (const id of ids.slice(0, -1)) {
      const n = t.nodes[id];
      // A placement inside the design wraps the slot in markup of its own.
      if (n.kind !== 'element') return null;
      const box = designBox(inst, d, n);
      if (!box) return null;
      if (helped(n)) out.push(asHelper(box));
      else out.push(...(acting(n) ? [OPEN, box] : [box]));
    }
    return out;
  };

  const seen = new Set<string>();
  /** Visit a node inside the boxes around it. */
  const visit = (id: string, chain: Box[]) => {
    const n = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
    if (!n || seen.has(id)) return;
    seen.add(id);
    if (n.kind === 'repeat') return n.children.forEach((c) => visit(c, chain));
    if (n.kind === 'element' || (n.kind === 'text' && !n.rich)) {
      const children = n.kind === 'element' ? n.children : [];
      // In a design, what shows is its default look: the options chosen when a placement chooses none.
      const layers = def ? designLayers(def, n.id, undefined) : [{ styles: n.styles, strength: 1 }];
      const box = boxOf(layers, n, n.id, quoted(n, def), def ? designClasses(def, n, undefined) : [pageNodeClass(n.id), ...detachedClasses(n)]);
      if (!box) return;
      // Inside a carousel's frame or a dialog, the boxes around are the runtime helper's.
      if (helped(n)) return children.forEach((c) => visit(c, [...chain, asHelper(box)]));
      // An action may wrap the element in a link of the runtime's: that link, not the element, sits in its parent.
      const around = acting(n) ? [...chain, OPEN] : chain;
      if (!acting(n) && box.kind === 'box') check(box, around, { id: n.id, name: box.name });
      return children.forEach((c) => visit(c, [...around, box]));
    }
    if (n.kind !== 'instance') return;
    const d = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
    const roots = d?.tree?.rootIds ?? [];
    const root = roots.length === 1 && d?.tree && Object.hasOwn(d.tree.nodes, roots[0]) ? d.tree.nodes[roots[0]] : undefined;
    // What is placed inside is read only through a design this can read: a design's own placements are styled from
    // its stylesheet in an order this does not read, and a code component's markup is its own. (Content a design
    // passes on into a placement of its own is not read either, since that design's rules for it may reach in.)
    if (def || !d || d.kind !== 'managed' || !root || root.kind !== 'element' || conditional(root)) return;
    const rootBox = designBox(n, d, root);
    if (rootBox?.kind === 'box' && !helped(root) && !acting(root)) check(rootBox, chain, { id: n.id, name: rootBox.name });
    for (const cl of childLists(n)) {
      const path = cl.slot === undefined ? null : slotPath(n, d, cl.slot);
      if (path) cl.ids.forEach((c) => visit(c, [...chain, ...path]));
    }
  };
  // A page's own stylesheet may position the page itself; a design may be placed anywhere.
  const start = def || theme.page ? OPEN : PAGE;
  tree.rootIds.forEach((id) => visit(id, [start]));

  const out: Diagnostic[] = [];
  for (const f of found.values()) out.push({ severity: 'warning', code: f.code, message: f.message(onSizes(f.sizes)), owner, nodeId: f.nodeId, site: f.site });
  return out;
}
