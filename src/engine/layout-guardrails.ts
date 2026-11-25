import type { DiagnosticFix } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import type { ComponentDefinition, GraphNode, InstanceNode, NodeTree, OwnerRef, ProjectState, ResponsiveScope, ResponsiveStyles, StyleProps } from '@shared/types';
import { isBindingRef } from '@shared/types';
import { cascadeStyles, parseCustomCss, parseGridTemplate, styleToCss, type StyleLayer } from '@shared/styles';
import { axesOf, designLayers } from '@shared/variants';
import { isCarouselTrack } from '@generator/card-links';
import { allTrees, childLists, displayName } from './tree';
import type { Diagnostic } from './validate';

/*
 * Layout guardrails (#668): three CSS combinations that quietly break a layout, said in plain words.
 *
 * - A sticky element inside a container that hides overflow stops sticking: that container becomes what it sticks
 *   to, and it never scrolls. Overflow Clip trims the same way without becoming one.
 * - A grid child that spans more columns than its grid has makes the grid add columns of its own to fit it.
 * - An absolutely positioned element with no positioned container around it is placed against the whole page.
 *
 * Each is a warning: the site still saves and exports, and it goes as soon as the layout is fixed. They read the
 * resting styles each screen size's stylesheet gives the boxes the site renders: a page's own elements, a placed
 * component's root, and the elements its design wraps a slot's content in, with the placement's options and changes.
 * Whatever is not known for certain ends a check with no warning, since a missed problem is better than a wrong one:
 * a code component or a runtime helper's own markup, custom CSS that may decide the same thing, and everything outside
 * a component's design, which may be placed anywhere.
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
  /** An element whose own styles are its only rules, so one change to them changes what shows. */
  own?: { owner: OwnerRef; nodeId: string; styles: ResponsiveStyles };
}

/** A box around an element: one whose rules are known, the page itself, or markup this cannot read. */
type Box = KnownBox | { kind: 'page' } | { kind: 'unknown' };
/** The page's `<main>` and `<body>`, and the header and footer's: nothing positioned, and only the window scrolls. */
const PAGE: Box = { kind: 'page' };
const UNKNOWN: Box = { kind: 'unknown' };

/** A value the stylesheet writes for a property, as text ("sticky", "3"); undefined for one it leaves out. */
function written(props: StyleProps, prop: string): string | undefined {
  const v = props[prop];
  if (v === undefined || v === null || typeof v === 'object') return undefined;
  return styleToCss(prop, v).length ? String(v).trim() : undefined;
}

function boxOf(layers: StyleLayer[], key: string, name: string, own?: KnownBox['own']): KnownBox {
  const won = cascadeStyles(layers);
  const custom = new Set<string>();
  for (const layer of layers)
    for (const scope of RESTING) {
      const css = layer.styles?.[scope]?.customCss;
      if (typeof css === 'string') for (const d of parseCustomCss(css).decls) custom.add(d.slice(0, d.indexOf(':')).trim());
    }
  return { kind: 'box', key, name, at: { phone: won.phone ?? {}, tablet: won.tablet ?? {}, desktop: won.desktop ?? {} }, custom, own };
}

const customSets = (b: KnownBox, re: RegExp) => [...b.custom].some((p) => re.test(p));

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

/** Custom CSS that may make a box what an absolutely positioned element inside it is placed in. */
const CONTAINING_CSS = /^(position|transform|translate|rotate|scale|filter|backdrop-filter|-webkit-backdrop-filter|perspective|contain|container|container-type|will-change|content-visibility)$/;

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

/** The nearest box around an element that hides overflow at a size, before anything else could scroll; null for none. */
function stickyClip(chain: Box[], size: Size): KnownBox | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const b = chain[i];
    if (b.kind !== 'box' || customSets(b, OVERFLOW_CSS)) return null;
    if (written(b.at[size], 'overflow') === 'hidden') return b;
  }
  return null;
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
  /** Sticky only: the box that hides overflow, and the scope each size takes that from. */
  clip?: { box: KnownBox; from: Map<Size, ResponsiveScope> };
}

const FLEX_OR_GRID = new Set(['stack', 'row', 'grid']);

/**
 * Overflow Clip in place of Hidden, in one step, where that is safe: on an element whose own styles are its only
 * rules, at the scopes the hidden overflow comes from, while it lays out its content as a stack or grid at every size
 * those scopes reach. A box laid out as flow would also stop holding its children's margins in, so it gets no fix.
 */
function clipFix(clip: NonNullable<Finding['clip']>): DiagnosticFix | undefined {
  const own = clip.box.own;
  if (!own) return undefined;
  const scopes = [...new Set(clip.from.values())];
  const reach = (scope: ResponsiveScope): Size[] => (scope === 'base' ? SIZES.filter((s) => own.styles[s]?.overflow === undefined) : [scope]);
  if (!scopes.every((scope) => reach(scope).every((s) => FLEX_OR_GRID.has(written(clip.box.at[s], 'layout') ?? '')))) return undefined;
  const operations: EditOperation[] = scopes.map((scope) => ({ type: 'node.setStyle', owner: own.owner, nodeId: own.nodeId, scope, property: 'overflow', value: 'clip' }));
  return { label: 'Set Overflow to Clip', operations };
}

/** The node that names a part of a design, when a part does. */
const partNode = (def: ComponentDefinition, partId: string) => (def.parts && Object.hasOwn(def.parts, partId) ? def.parts[partId]?.nodeId : undefined) ?? (partId === 'root' ? def.tree?.rootIds[0] : undefined);

/**
 * The rules on one of a design's elements in one placement, weakest first, as the stylesheets cascade them (see
 * `designLayers` and detach's `layersFor`): its own styles, the chosen options', then the placement's changes to the
 * part it is. Null when the placement chooses an option that styles it through a property, or styles single items of
 * it, so what shows depends on content.
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

/** Elements the runtime renders inside a helper's own markup (a carousel's frame, a dialog), or may wrap (an action). */
const helped = (n: GraphNode) => n.kind === 'element' && (isCarouselTrack(n) || n.overlay !== undefined);
const acting = (n: GraphNode) => n.kind === 'element' && n.action !== undefined && n.action !== null;

/** Each node's parent in a design, with the slot it fills when that parent is a placement. */
function parentsOf(tree: NodeTree): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of Object.values(tree.nodes)) for (const cl of childLists(n)) for (const c of cl.ids) if (!out.has(c)) out.set(c, n.id);
  return out;
}

/** Diagnostics for every page, header, footer, collection layout and project component. */
export function layoutGuardrailDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  const parents = new Map<string, Map<string, string>>();
  const slotPaths = new Map<string, string[] | null>();
  for (const { owner, tree, label } of allTrees(state)) {
    const def = owner.kind === 'component' ? state.components[owner.id] : undefined;
    // Theme components are fixed theme data; their styles still count where they are placed.
    if (def?.owner === 'theme') continue;
    try {
      out.push(...treeGuardrails(state, owner, tree, label, def, { parents, slotPaths }));
    } catch {
      /* a document damaged by hand: the structural checks say what is wrong with it */
    }
  }
  return out;
}

/** What every tree reads of the designs placed in it, worked out once per validation. */
interface DesignCache {
  /** Each design's parent map. */
  parents: Map<string, Map<string, string>>;
  /** The nodes from a design's root to the one place it renders a slot (`id|slot`), or null for none or several. */
  slotPaths: Map<string, string[] | null>;
}

function treeGuardrails(state: ProjectState, owner: OwnerRef, tree: NodeTree, label: string, def: ComponentDefinition | undefined, { parents, slotPaths }: DesignCache): Diagnostic[] {
  const found = new Map<string, Finding>();
  const record = (key: string, size: Size, make: () => Omit<Finding, 'sizes'>) => {
    const f = found.get(key) ?? found.set(key, { ...make(), sizes: [] }).get(key)!;
    f.sizes.push(size);
    return f;
  };
  const quoted = (n: GraphNode, d?: ComponentDefinition) => `“${displayName(state, n, d)}”`;

  /** Check one box as the element it is, inside the boxes around it (innermost last). */
  const check = (b: KnownBox, chain: Box[], subject: { id: string; name: string }) => {
    const parent = chain[chain.length - 1];
    for (const size of SIZES) {
      // Hidden here, or inside something hidden here: nothing shows to go wrong.
      if (b.at[size].hidden === true || chain.some((c) => c.kind === 'box' && c.at[size].hidden === true)) continue;
      const position = b.custom.has('position') ? undefined : written(b.at[size], 'position');
      if (position === 'sticky') {
        const clip = stickyClip(chain, size);
        if (clip) {
          const f = record(JSON.stringify(['sticky', subject.id, clip.key]), size, () => ({
            code: 'LAYOUT_STICKY_CLIPPED',
            nodeId: subject.id,
            site: JSON.stringify([subject.id, clip.key]),
            clip: { box: clip, from: new Map() },
            message: (where) =>
              `${label}: ${where}${subject.name} is set to stick while the page scrolls, but ${clip.name} around it hides overflow, so it scrolls away with everything else. Set the Overflow of ${clip.name} to Clip: it trims what spills out the same way and lets ${subject.name} stick.`
          }));
          f.clip!.from.set(size, clip.own?.styles[size]?.overflow !== undefined ? size : 'base');
        }
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
      // A grid child in the grid's flow: one placed absolutely makes no columns, and custom CSS may move either.
      if (position === 'absolute' || parent?.kind !== 'box' || customSets(b, /^(display|position|grid)/) || customSets(parent, /^(display|grid)/)) continue;
      const span = spanOf(b.at[size]);
      const columns = explicitColumns(parent.at[size]);
      if (span === undefined || columns === undefined || span <= columns) continue;
      record(JSON.stringify(['span', subject.id, span, columns]), size, () => ({
        code: 'LAYOUT_SPAN_OVERFLOW',
        nodeId: subject.id,
        site: JSON.stringify([subject.id, span, columns]),
        message: (where) =>
          `${label}: ${where}${subject.name} spans ${span} columns, but its grid has only ${columns === 1 ? '1 column' : `${columns} columns`}, so the grid adds ${span - columns === 1 ? 'a column' : `${span - columns} columns`} of its own to fit it, squeezing the others. Lower its Column span to ${columns}, or give the grid more columns.`
      }));
    }
  };

  /** The boxes a design renders around a slot's content in one placement, outermost first, from its root. */
  const slotPath = (inst: InstanceNode, d: ComponentDefinition, slot: string): Box[] => {
    const t = d.tree!;
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
    const cached = `${d.id}|${slot}`;
    if (!slotPaths.has(cached)) {
      const paths = Object.values(t.nodes).flatMap((n) => (n.kind === 'slot' && n.slot === slot ? [reachable(n.id)] : [])).filter((p): p is string[] => p !== null);
      // Content rendered in two places, or nowhere, sits in no one place to read.
      slotPaths.set(cached, paths.length === 1 ? paths[0].slice(0, -1) : null);
    }
    const ids = slotPaths.get(cached);
    if (!ids) return [UNKNOWN];
    const out: Box[] = [];
    for (const id of ids) {
      const n = t.nodes[id];
      if (n.kind === 'repeat') continue;
      if (n.kind !== 'element' || helped(n)) {
        out.push(UNKNOWN);
        continue;
      }
      if (acting(n)) out.push(UNKNOWN);
      out.push(designBox(inst, d, n));
    }
    return out;
  };

  /** One of a design's elements as it renders in a placement. */
  const designBox = (inst: InstanceNode, d: ComponentDefinition, n: GraphNode): Box => {
    const layers = placementLayers(d, inst, n.id);
    if (!layers) return UNKNOWN;
    const part = Object.values(d.parts ?? {}).find((p) => p?.nodeId === n.id && p.nodeId !== d.tree?.rootIds[0]);
    const name = n.id === d.tree?.rootIds[0] ? quoted(inst) : `“${part?.label || displayName(state, n, d)}” in ${quoted(inst)}`;
    return boxOf(layers, `${inst.id}/${n.id}`, name);
  };

  const seen = new Set<string>();
  const visit = (id: string, chain: Box[]) => {
    const n = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
    if (!n || seen.has(id)) return;
    seen.add(id);
    if (n.kind === 'repeat') return n.children.forEach((c) => visit(c, chain));
    if (n.kind === 'element' || (n.kind === 'text' && !n.rich)) {
      const children = n.kind === 'element' ? n.children : [];
      // Inside a carousel's frame or a dialog, the boxes around are the runtime helper's.
      if (helped(n)) return children.forEach((c) => visit(c, [...chain, UNKNOWN]));
      // In a design, what shows is its default look: the options chosen when a placement chooses none.
      const layers = def ? designLayers(def, n.id, undefined) : [{ styles: n.styles, strength: 1 }];
      const own = layers.length === 1 && n.styles && typeof n.styles === 'object' ? { owner, nodeId: n.id, styles: n.styles } : undefined;
      const box = boxOf(layers, n.id, quoted(n, def), own);
      // An action may wrap the element in a link of the runtime's: that link, not the element, sits in its parent.
      const around = acting(n) ? [...chain, UNKNOWN] : chain;
      if (!acting(n)) check(box, around, { id: n.id, name: box.name });
      return children.forEach((c) => visit(c, [...around, box]));
    }
    if (n.kind !== 'instance') return;
    const d = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
    const roots = d?.tree?.rootIds ?? [];
    const root = roots.length === 1 && d?.tree && Object.hasOwn(d.tree.nodes, roots[0]) ? d.tree.nodes[roots[0]] : undefined;
    // A design's own placements are styled from its stylesheet, in an order this does not read; a code component's
    // markup is its own.
    if (def || !d || d.kind !== 'managed' || !root) {
      for (const cl of childLists(n)) cl.ids.forEach((c) => visit(c, [...chain, UNKNOWN]));
      return;
    }
    if ((root.kind === 'element' || (root.kind === 'text' && !root.rich)) && !helped(root) && !acting(root)) {
      const box = designBox(n, d, root);
      if (box.kind === 'box') check(box, chain, { id: n.id, name: box.name });
    }
    for (const cl of childLists(n)) {
      const path = cl.slot === undefined ? [UNKNOWN] : slotPath(n, d, cl.slot);
      cl.ids.forEach((c) => visit(c, [...chain, ...path]));
    }
  };
  const start = def ? UNKNOWN : PAGE;
  tree.rootIds.forEach((id) => visit(id, [start]));

  return [...found.values()].map((f) => {
    const fix = f.clip ? clipFix(f.clip) : undefined;
    return { severity: 'warning' as const, code: f.code, message: f.message(onSizes(f.sizes)), owner, nodeId: f.nodeId, site: f.site, ...(fix ? { fix } : {}) };
  });
}
