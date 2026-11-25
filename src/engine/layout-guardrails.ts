import type { DiagnosticFix } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import type { ComponentDefinition, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState, ResponsiveScope, ResponsiveStyles, StyleProps } from '@shared/types';
import { isBinding, isBindingRef } from '@shared/types';
import { cascadeStyles, parseCustomCss, parseGridTemplate, styleToCss, type StyleLayer } from '@shared/styles';
import { axesOf, designLayers, selectedVariants } from '@shared/variants';
import { getTheme } from '@catalogue/index';
import { isCarouselTrack } from '@generator/card-links';
import { detachedClasses, nodeAxes, nodeClass, variantClass } from '@generator/index';
import { allTrees, childLists, displayName } from './tree';
import type { Diagnostic } from './validate';

/*
 * Layout guardrails (#668): three CSS combinations that quietly break a layout, said in plain words.
 *
 * - A sticky element inside a container that hides overflow stops sticking: that container becomes what it sticks
 *   to, and it never scrolls. Overflow Clip trims what spills over its edges without becoming one.
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
  /** An authored element whose own styles are its only rules, so one change to them changes what shows. */
  own?: { owner: OwnerRef; nodeId: string; styles: ResponsiveStyles };
}

/**
 * A box around an element: one whose rules are known, the page itself, or markup this cannot read (which still says
 * where its own styles hide it, since nothing inside shows there).
 */
type Box = KnownBox | { kind: 'page' } | { kind: 'unknown'; hidden?: Set<Size> };
/** The page's `<main>` and `<body>`, and the header and footer's: nothing positioned, and only the window scrolls. */
const PAGE: Box = { kind: 'page' };
const UNKNOWN: Box = { kind: 'unknown' };

const hiddenAt = (b: Box, size: Size) => (b.kind === 'box' ? b.at[size].hidden === true : b.kind === 'unknown' && !!b.hidden?.has(size));

/** A value the stylesheet writes for a property, as text ("sticky", "3"); undefined for one it leaves out. */
function written(props: StyleProps, prop: string): string | undefined {
  const v = props[prop];
  if (v === undefined || v === null || typeof v === 'object') return undefined;
  return styleToCss(prop, v).length ? String(v).trim() : undefined;
}

const customSets = (b: KnownBox, re: RegExp) => [...b.custom].some((p) => re.test(p));

/** Tags a browser lays out inline until a layout says otherwise. */
const INLINE_TAGS = new Set(['span', 'small', 'strong', 'cite']);

// ---------------------------------------------------------------------------
// What the theme's own stylesheet may decide
// ---------------------------------------------------------------------------

/** Properties a theme rule can set that decide what these checks read. */
const DECIDING_CSS = /^(position|inset|top|bottom|overflow(-x|-y|-block|-inline)?|display|grid(-[a-z-]+)?|transform|translate|rotate|scale|filter|backdrop-filter|-webkit-backdrop-filter|perspective|contain|container(-type)?|will-change|content-visibility)$/;
/** Custom CSS, or a theme's rule, that may make a box what an absolutely positioned element inside it is placed in. */
const CONTAINING_CSS = /^(position|transform|translate|rotate|scale|filter|backdrop-filter|-webkit-backdrop-filter|perspective|contain|container(-type)?|will-change|content-visibility)$/;

/** Values of those properties that make nothing a box is placed in: Normal position, no transform, content shown. */
const INERT_VALUES = new Set(['static', 'none', 'normal', 'visible', 'auto', 'initial', 'unset']);

/** One theme rule that may decide a layout, by the class tokens its selector names (`[class$='__grid']`, `.so-x__y`). */
interface ThemeRule {
  /** Any one of these on the box (element classes). */
  any: Array<{ op: string; value: string }>;
  /** Every one of these on the box (modifier classes: an option, a tone). */
  all: Array<{ op: string; value: string }>;
}
interface ThemeHooks {
  /** A rule names no class at all (`main`, `body`, `li`) yet may position or transform: what anchors a page is unknown. */
  page: boolean;
  rules: ThemeRule[];
}
const hookCache = new Map<string, ThemeHooks>();

/** A selector without its conditions on other elements (`:has(…)`, `:not(…)`), which never name the box itself. */
function withoutConditions(selector: string): string {
  let out = selector;
  for (let at = out.search(/:(has|not)\(/); at >= 0; at = out.search(/:(has|not)\(/)) {
    let depth = 0;
    let end = out.indexOf('(', at);
    for (; end < out.length; end++) if ((depth += out[end] === '(' ? 1 : out[end] === ')' ? -1 : 0) === 0) break;
    out = out.slice(0, at) + out.slice(end + 1);
  }
  return out;
}

/** Each selector of a list, split at its top-level commas. */
function selectorList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
    if (text[i] === ',' && depth === 0) out.push(text.slice(start, i)), (start = i + 1);
  }
  out.push(text.slice(start));
  return out;
}

/**
 * The rules of a theme's stylesheet that may decide a layout these checks read, by the classes they hook. Read once per
 * stylesheet: a theme's rules can reach a design's elements and their detached copies through class endings.
 */
function themeHooks(css: string): ThemeHooks {
  const cached = hookCache.get(css);
  if (cached) return cached;
  const hooks: ThemeHooks = { page: false, rules: [] };
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const decls = m[2].split(';').flatMap((d) => (d.includes(':') ? [{ prop: d.slice(0, d.indexOf(':')).trim().toLowerCase(), value: d.slice(d.indexOf(':') + 1).trim().toLowerCase() }] : []));
    if (!decls.some((d) => DECIDING_CSS.test(d.prop))) continue;
    // A keyframe of an animation styles nothing at rest.
    if (/^\s*((from|to|[\d.]+%)\s*,?\s*)+$/.test(m[1])) continue;
    for (const selector of selectorList(m[1])) {
      const tokens = [...withoutConditions(selector).matchAll(/\[class\s*([$*^]?)=\s*['"]([^'"]+)['"]\s*\]|\.(-?[_a-zA-Z][\w-]*)/g)].map((t) =>
        t[3] !== undefined ? { op: '.', value: t[3] } : { op: t[1] || '=', value: t[2].trim() }
      );
      if (!tokens.length) {
        if (decls.some((d) => CONTAINING_CSS.test(d.prop) && !INERT_VALUES.has(d.value.replace(/\s*!important$/, '')))) hooks.page = true;
        continue;
      }
      // A modifier (`--layout-sticky-split`) narrows the rule to boxes that carry it; a detached copy's prefix is none.
      const modifier = (t: { value: string }) => t.value.replace(/^so--d-/, '').includes('--');
      hooks.rules.push({ any: tokens.filter((t) => !modifier(t)), all: tokens.filter(modifier) });
    }
  }
  hookCache.set(css, hooks);
  return hooks;
}

function tokenMatches(classes: string[], t: { op: string; value: string }): boolean {
  if (t.op === '^') return classes[0]?.startsWith(t.value) ?? false;
  return classes.some((c) => (t.op === '.' || t.op === '=' ? c === t.value : t.op === '*' ? c.includes(t.value) : c.endsWith(t.value)));
}

/** Whether a rule of the theme's may reach a box with these classes, or the elements inside it. */
const hooked = (hooks: ThemeHooks, classes: string[]) =>
  classes.length > 0 && hooks.rules.some((r) => (r.any.length === 0 || r.any.some((t) => tokenMatches(classes, t))) && r.all.every((t) => tokenMatches(classes, t)));

// ---------------------------------------------------------------------------
// Reading the boxes
// ---------------------------------------------------------------------------

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
  // One value is every side; two are top-and-bottom then the sides; three and four give the bottom third.
  const top = sides[0];
  const bottom = sides.length >= 3 ? sides[2] : sides[0];
  return (top !== undefined && top !== 'auto') || (bottom !== undefined && bottom !== 'auto');
}

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
 * Where in the boxes around an element (innermost last) the nearest one that hides overflow is, at a size, before
 * anything else could scroll; -1 for none. Overflow applies to no inline box, so one is passed over.
 */
function clipAt(chain: Box[], size: Size, from = chain.length - 1): number {
  for (let i = from; i >= 0; i--) {
    const b = chain[i];
    if (b.kind !== 'box' || customSets(b, OVERFLOW_CSS)) return -1;
    if (written(b.at[size], 'overflow') !== 'hidden') continue;
    const laidOut = written(b.at[size], 'layout') !== undefined;
    if (b.inline === true && !laidOut) continue;
    if (b.inline === 'maybe' && !laidOut) return -1;
    return i;
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
  /** Sticky only: the box that hides overflow, what it sits in, and the scope each size takes its overflow from. */
  clip?: { box: KnownBox; parent: Box; from: Map<Size, ResponsiveScope>; further: boolean };
}

const FLEX_OR_GRID = new Set(['stack', 'row', 'grid']);

/**
 * Overflow Clip in place of Hidden, in one step, where that changes nothing but the sticking: on a page's (or the
 * header's, footer's or a collection layout's) own element whose styles are its only rules, at the scopes the hidden
 * overflow comes from, with no other box further out hiding overflow too. At every size those scopes reach, it must lay
 * out its content as a stack or grid (a flow box would stop holding its children's margins in) and sit in flow, or in
 * a stack of no fixed height (in a row or grid, a box that no longer scrolls takes its content's width as its least).
 */
function clipFix(clip: NonNullable<Finding['clip']>): DiagnosticFix | undefined {
  const own = clip.box.own;
  if (!own || own.owner.kind === 'component' || clip.further) return undefined;
  const scopes = [...new Set(clip.from.values())];
  const reach = (scope: ResponsiveScope): Size[] => (scope === 'base' ? SIZES.filter((s) => own.styles[s]?.overflow === undefined) : [scope]);
  const parent = clip.parent;
  const safe = (s: Size) => {
    if (!FLEX_OR_GRID.has(written(clip.box.at[s], 'layout') ?? '')) return false;
    if (parent.kind === 'page') return true;
    if (parent.kind !== 'box') return false;
    const layout = written(parent.at[s], 'layout');
    if (layout === undefined || layout === 'block') return true;
    return layout === 'stack' && written(parent.at[s], 'height') === undefined && written(parent.at[s], 'maxHeight') === undefined;
  };
  if (!scopes.every((scope) => reach(scope).every(safe))) return undefined;
  const operations: EditOperation[] = scopes.map((scope) => ({ type: 'node.setStyle', owner: own.owner, nodeId: own.nodeId, scope, property: 'overflow', value: 'clip' }));
  return { label: 'Set Overflow to Clip', operations };
}

/** The node a declared part names: only a declared part's changes reach the markup (see the generator's classExpr). */
const partNode = (def: ComponentDefinition, partId: string) => (def.parts && Object.hasOwn(def.parts, partId) ? def.parts[partId]?.nodeId : undefined);

/** Whether a source of styles shows something again at some size, which the stylesheet writes a display of its own for. */
const shows = (rs: ResponsiveStyles | undefined) => RESTING.some((scope) => rs?.[scope]?.hidden === false);

/**
 * The rules on one of a design's elements in one placement, weakest first, as the stylesheets cascade them (see
 * `designLayers` and detach's `layersFor`): its own styles, the chosen options', then the placement's changes to the
 * part it is. Null when what shows depends on more than these: an option chosen through a property, styles for single
 * items, or a rule that shows it again (whose display the generator picks from the options in its own order).
 */
function placementLayers(def: ComponentDefinition, inst: InstanceNode, nodeId: string): StyleLayer[] | null {
  for (const [axis, a] of axesOf(def)) if (isBindingRef(inst.variants?.[axis]) && Object.values(a.options ?? {}).some((o) => o?.styles?.[nodeId])) return null;
  if (Object.keys(inst.itemOverrides ?? {}).some((pid) => partNode(def, pid) === nodeId)) return null;
  const layers = designLayers(def, nodeId, inst.variants);
  const designed = layers.map((l) => l.styles);
  for (const pid of Object.keys(inst.overrides ?? {}).sort())
    if (partNode(def, pid) === nodeId) layers.push({ styles: inst.overrides![pid], strength: 3, wideColumns: true, unhides: designed });
  return layers.some((l) => shows(l.styles)) ? null : layers;
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
  hooks: ThemeHooks;
  /** Each design's parent map. */
  parents: Map<string, Map<string, string>>;
  /** The nodes from a design's root to the one place it renders a slot (`id|slot`), or null for none or several. */
  slotPaths: Map<string, string[] | null>;
}

/** Diagnostics for every page, header, footer, collection layout and project component. */
export function layoutGuardrailDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  let css = '';
  try {
    css = getTheme(state.site.themeId).baseCss ?? '';
  } catch {
    /* no theme loaded: nothing of its to read */
  }
  const shared: Shared = { hooks: themeHooks(css), parents: new Map(), slotPaths: new Map() };
  for (const { owner, tree, label } of allTrees(state)) {
    const def = owner.kind === 'component' ? state.components[owner.id] : undefined;
    // Theme components are fixed theme data, though their styles count where they are placed; a code component
    // renders its source, whatever tree it was saved with.
    if (def && (def.owner === 'theme' || def.kind !== 'managed')) continue;
    try {
      out.push(...treeGuardrails(state, owner, tree, label, def, shared));
    } catch {
      /* a document damaged by hand: the structural checks say what is wrong with it */
    }
  }
  return out;
}

function treeGuardrails(state: ProjectState, owner: OwnerRef, tree: NodeTree, label: string, def: ComponentDefinition | undefined, { hooks, parents, slotPaths }: Shared): Diagnostic[] {
  const found = new Map<string, Finding>();
  const record = (key: string, size: Size, make: () => Omit<Finding, 'sizes'>) => {
    const f = found.get(key) ?? found.set(key, { ...make(), sizes: [] }).get(key)!;
    f.sizes.push(size);
    return f;
  };
  const quoted = (n: GraphNode, d?: ComponentDefinition) => `“${displayName(state, n, d)}”`;

  /**
   * A box from layers of rules: known, or unknown when custom CSS may change what it displays as, and `sealed` when a
   * theme rule may reach it or anything inside it.
   */
  const boxOf = (layers: StyleLayer[] | null, n: GraphNode, key: string, name: string, classes: string[], own?: KnownBox['own']): { box: Box; sealed: boolean } => {
    if (!layers) return { box: UNKNOWN, sealed: false };
    const won = cascadeStyles(layers);
    const at = { phone: won.phone ?? {}, tablet: won.tablet ?? {}, desktop: won.desktop ?? {} };
    const hidden = new Set(SIZES.filter((s) => at[s].hidden === true));
    if (hooked(hooks, classes)) return { box: { kind: 'unknown', hidden }, sealed: true };
    const custom = new Set<string>();
    for (const layer of layers)
      for (const scope of RESTING) {
        const css = layer.styles?.[scope]?.customCss;
        if (typeof css === 'string') for (const d of parseCustomCss(css).decls) custom.add(d.slice(0, d.indexOf(':')).trim());
      }
    // A display of its own may give it no box at all (contents, none), or lay it out some other way.
    if (custom.has('display')) return { box: { kind: 'unknown', hidden }, sealed: false };
    const tag = (n as { tag?: unknown }).tag;
    const inline = typeof tag !== 'string' || isBinding(tag) ? 'maybe' : INLINE_TAGS.has(tag);
    return { box: { kind: 'box', key, name, at, custom, inline, tag: typeof tag === 'string' ? tag : undefined, own }, sealed: false };
  };

  /** Check one box as the element it is, inside the boxes around it (innermost last). */
  const check = (b: KnownBox, chain: Box[], subject: { id: string; name: string }) => {
    const parent = chain[chain.length - 1];
    for (const size of SIZES) {
      // Hidden here, or inside something hidden here: nothing shows to go wrong.
      if (b.at[size].hidden === true || chain.some((c) => hiddenAt(c, size))) continue;
      const position = b.custom.has('position') ? undefined : written(b.at[size], 'position');
      const clip = position === 'sticky' && sticksVertically(b.at[size]) ? clipAt(chain, size) : -1;
      if (clip >= 0) {
        const box = chain[clip] as KnownBox;
        const f = record(JSON.stringify(['sticky', subject.id, box.key]), size, () => ({
          code: 'LAYOUT_STICKY_CLIPPED',
          nodeId: subject.id,
          site: JSON.stringify([subject.id, box.key]),
          clip: { box, parent: chain[clip - 1] ?? UNKNOWN, from: new Map(), further: false },
          message: (where) =>
            `${label}: ${where}${subject.name} is set to stick while the page scrolls, but ${box.name} around it hides overflow, so it scrolls away with everything else. Set the Overflow of ${box.name} to Clip: it still trims what spills over its edges, and lets ${subject.name} stick.`
        }));
        f.clip!.from.set(size, box.own?.styles[size]?.overflow !== undefined ? size : 'base');
        // Another box further out that hides overflow would take its place: one step would not make it stick.
        if (clipAt(chain, size, clip - 1) >= 0) f.clip!.further = true;
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
      if (span === undefined || position === 'absolute' || parent?.kind !== 'box' || parent.tag === undefined || parent.tag === 'details') continue;
      if (customSets(b, /^(position|grid)/) || customSets(parent, /^grid/)) continue;
      const columns = explicitColumns(parent.at[size]);
      if (columns === undefined || span <= columns) continue;
      record(JSON.stringify(['span', subject.id, span, columns]), size, () => ({
        code: 'LAYOUT_SPAN_OVERFLOW',
        nodeId: subject.id,
        site: JSON.stringify([subject.id, parent.key]),
        message: (where) =>
          `${label}: ${where}${subject.name} spans ${span} columns, but its grid has only ${columns === 1 ? '1 column' : `${columns} columns`}, so the grid adds ${span - columns === 1 ? 'a column' : `${span - columns} columns`} of its own to fit it, squeezing the others. Lower its Column span to ${columns}, or give the grid more columns.`
      }));
    }
  };

  /** One of a design's elements as it renders in a placement. */
  const designBox = (inst: InstanceNode, d: ComponentDefinition, n: GraphNode) => {
    const part = Object.values(d.parts ?? {}).find((p) => p?.nodeId === n.id && p.nodeId !== d.tree?.rootIds[0]);
    const name = n.id === d.tree?.rootIds[0] ? quoted(inst) : `“${part?.label || displayName(state, n, d)}” in ${quoted(inst)}`;
    return boxOf(placementLayers(d, inst, n.id), n, `${inst.id}/${n.id}`, name, designClasses(d, n, inst.variants));
  };

  /**
   * The boxes a design renders around a slot's content in one placement, outermost first, from its root; null when
   * the content may not render (a condition or a list on the way) or a theme rule may reach it.
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
    if (!ids) return [UNKNOWN];
    if (ids.some((id) => conditional(t.nodes[id]))) return null;
    const out: Box[] = [];
    for (const id of ids.slice(0, -1)) {
      const n = t.nodes[id];
      if (n.kind !== 'element' || helped(n)) {
        out.push(UNKNOWN);
        continue;
      }
      if (acting(n)) out.push(UNKNOWN);
      const { box, sealed } = designBox(inst, d, n);
      if (sealed) return null;
      out.push(box);
    }
    return out;
  };

  const seen = new Set<string>();
  /** Visit a node inside the boxes around it; `foreign` when an enclosing design's rules may reach a design below. */
  const visit = (id: string, chain: Box[], foreign: boolean) => {
    const n = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
    if (!n || seen.has(id)) return;
    seen.add(id);
    if (n.kind === 'repeat') return n.children.forEach((c) => visit(c, chain, foreign));
    if (n.kind === 'element' || (n.kind === 'text' && !n.rich)) {
      const children = n.kind === 'element' ? n.children : [];
      // In a design, what shows is its default look: the options chosen when a placement chooses none.
      const layers = def ? designLayers(def, n.id, undefined) : [{ styles: n.styles, strength: 1 }];
      const own = layers.length === 1 && n.styles && typeof n.styles === 'object' ? { owner, nodeId: n.id, styles: n.styles } : undefined;
      const { box, sealed } = boxOf(layers, n, n.id, quoted(n, def), def ? designClasses(def, n, undefined) : detachedClasses(n), own);
      if (sealed) return;
      // Inside a carousel's frame or a dialog, the boxes around are the runtime helper's.
      if (helped(n)) return children.forEach((c) => visit(c, [...chain, box.kind === 'unknown' ? box : { kind: 'unknown', hidden: new Set(SIZES.filter((s) => hiddenAt(box, s))) }], foreign));
      // An action may wrap the element in a link of the runtime's: that link, not the element, sits in its parent.
      const around = acting(n) ? [...chain, UNKNOWN] : chain;
      if (!acting(n) && box.kind === 'box') check(box, around, { id: n.id, name: box.name });
      return children.forEach((c) => visit(c, [...around, box], foreign));
    }
    if (n.kind !== 'instance') return;
    const d = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
    const roots = d?.tree?.rootIds ?? [];
    const root = roots.length === 1 && d?.tree && Object.hasOwn(d.tree.nodes, roots[0]) ? d.tree.nodes[roots[0]] : undefined;
    // A design's own placements are styled from its stylesheet, in an order this does not read; a code component's
    // markup is its own; and an enclosing design's rules for its placements may reach this one's elements too.
    if (def || foreign || !d || d.kind !== 'managed' || !root) {
      for (const cl of childLists(n)) cl.ids.forEach((c) => visit(c, [...chain, UNKNOWN], true));
      return;
    }
    if ((root.kind === 'element' || (root.kind === 'text' && !root.rich)) && !helped(root) && !acting(root) && !conditional(root)) {
      const { box } = designBox(n, d, root);
      if (box.kind === 'box') check(box, chain, { id: n.id, name: box.name });
    }
    for (const cl of childLists(n)) {
      const path = cl.slot === undefined ? [UNKNOWN] : slotPath(n, d, cl.slot);
      if (!path) continue;
      const opaque = path.some((b) => b.kind === 'unknown');
      cl.ids.forEach((c) => visit(c, [...chain, ...path], opaque));
    }
  };
  // A page's own stylesheet may position the page itself; a design may be placed anywhere.
  const start = def || hooks.page ? UNKNOWN : PAGE;
  tree.rootIds.forEach((id) => visit(id, [start], false));

  return [...found.values()].map((f) => {
    const fix = f.clip ? clipFix(f.clip) : undefined;
    return { severity: 'warning' as const, code: f.code, message: f.message(onSizes(f.sizes)), owner, nodeId: f.nodeId, site: f.site, ...(fix ? { fix } : {}) };
  });
}
