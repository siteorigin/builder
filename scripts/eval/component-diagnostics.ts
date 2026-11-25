/**
 * The benchmark's stand-in for the editor's component preview, which needs a browser: a component measured from its
 * design alone, for inspect_component and for grading. It measures two things and nothing else: whether an element's
 * width fits the screen, and whether the text that renders has enough contrast with what is behind it, from the
 * site's colors. Anything it cannot work out is counted as unmeasured, never as a pass: a width it cannot resolve, a
 * color it cannot read, text faded by opacity or in a box that can cut it off, and anything under custom CSS, which
 * can change either. Overlaps, cut-off text, tap targets and spacing need a browser, so they are never reported here.
 */
import type { ComponentPreviewResult, ComponentPreviewSpec, ComponentPreviewStep } from '@shared/component-preview';
import { PREVIEW_NODE_ID, previewCtx } from '@shared/component-preview';
import type { ComponentDefinition, GraphNode, NodeTree, ProjectState, StyleProps, TokenDef } from '@shared/types';
import { parseColor, type Rgba } from '@shared/color';
import { compositeOver, contrastBetween, formatRatio, TEXT_CONTRAST } from '@shared/contrast';
import { followToken, scopeForWidth } from '@shared/styles';
import { designStyles } from '@shared/variants';
import { catalogueComponent } from '@catalogue/index';
import { makeInstance } from '@engine/install';
import { childLists } from '@engine/tree';
import { effectiveTokens } from '@generator/index';
import { renderedContent, walkRendered } from '@generator/checks';

/** The page behind a component, as the site's stylesheet paints it. */
const PAGE_TEXT = 'color.text';
const PAGE_BACKGROUND = 'color.background';
const REM_PX = 16;
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

export interface StaticFinding {
  kind: 'element-overflow' | 'low-contrast';
  nodeId: string;
  message: string;
}

export interface StaticMeasurement {
  /** The definition measured: for a theme component, the ID it would have in the project. */
  definitionId: string;
  width: number;
  findings: StaticFinding[];
  /** Elements whose width was measured, and those whose width could not be (a calc(), custom CSS). */
  widths: { checked: number; unmeasured: string[] };
  /** The width each measured element renders at, in pixels, where it is known (not a content-sized one). */
  boxes: Record<string, number>;
  /** Text that renders and is not hidden at this width, by design node, with its ratio when it could be measured. */
  texts: Array<{ nodeId: string; ratio: number | null }>;
}

/** A width in pixels, one that takes the room it is given, one sized by its content, or one that cannot be worked out. */
type Length = { px: number } | 'fill' | 'content' | 'unknown';

const tokenRef = (v: unknown): { token: string; alpha?: number } | null => (v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string' ? (v as { token: string; alpha?: number }) : null);
const isSet = (v: unknown) => v !== undefined && v !== null;

/** A style value as plain CSS text, following token references. */
function cssOf(tokens: TokenDef[], v: unknown): string | null {
  const ref = tokenRef(v);
  if (ref) {
    const t = followToken(tokens, ref.token);
    return typeof t === 'string' ? t : typeof t === 'number' ? String(t) : null;
  }
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

/**
 * A width style value in a container `room` pixels wide on a screen `screen` pixels wide. An em depends on the
 * element's font size, so it is unknown here; a rem is the root's 16px.
 */
function lengthOf(tokens: TokenDef[], v: unknown, room: number, screen: number): Length {
  if (!isSet(v)) return 'fill';
  if (typeof v === 'number') return { px: v };
  const css = cssOf(tokens, v)?.trim().toLowerCase();
  if (!css) return 'unknown';
  if (css === 'fill' || css === 'auto') return 'fill';
  if (['fit', 'fit-content', 'min-content', 'max-content'].includes(css)) return 'content';
  const m = /^(-?\d*\.?\d+)(px|rem|%|vw)?$/.exec(css);
  if (!m) return 'unknown';
  const n = Number(m[1]);
  if (m[2] === '%') return { px: (n / 100) * room };
  if (m[2] === 'vw') return { px: (n / 100) * screen };
  return { px: m[2] === 'rem' ? n * REM_PX : n };
}

/** The smallest width a style lets an element shrink to: nothing below its minimum width, in pixels, or unknown. */
function minWidthOf(tokens: TokenDef[], st: StyleProps, room: number, screen: number): number | 'unknown' {
  if (!isSet(st.minWidth) || ['auto', '0', 'none'].includes(String(st.minWidth))) return 0;
  const min = lengthOf(tokens, st.minWidth, room, screen);
  return min === 'fill' ? room : min === 'content' || min === 'unknown' ? 'unknown' : min.px;
}

/**
 * The width an element renders at in a container `room` pixels wide (a minimum width wins over a maximum, which
 * caps the width), or 'fits' when it is known to fit the room but not at what width (sized by its content, or under a
 * cap that cannot be worked out), or 'unknown'.
 */
function boxWidth(tokens: TokenDef[], st: StyleProps, room: number, screen: number): number | 'fits' | 'unknown' {
  const w = lengthOf(tokens, st.width, room, screen);
  const max = st.maxWidth === 'none' || !isSet(st.maxWidth) ? null : lengthOf(tokens, st.maxWidth, room, screen);
  const floor = minWidthOf(tokens, st, room, screen);
  if (w === 'unknown' || floor === 'unknown') return 'unknown';
  if (w === 'content') return floor > room ? floor : 'fits';
  let px = w === 'fill' ? room : w.px;
  if (max === 'unknown' || max === 'content') {
    // A cap that cannot be worked out holds the width to at most what it was: the width itself is not known.
    if (px > room) return floor > room ? floor : 'unknown';
    return floor > 0 && floor >= px ? floor : 'fits';
  }
  if (max !== null) px = Math.min(px, max === 'fill' ? room : max.px);
  return Math.max(px, floor);
}

/** Whether custom CSS is set on a design node, at any size or state or in any variant option: it can change anything. */
function customCssOn(def: ComponentDefinition, nodeId: string): boolean {
  const sets = (styles: unknown) => Object.values((styles ?? {}) as Record<string, StyleProps | undefined>).some((st) => typeof st?.customCss === 'string' && st.customCss.trim() !== '');
  return sets(def.tree?.nodes[nodeId]?.styles) || Object.values(def.variantAxes ?? {}).some((axis) => Object.values(axis?.options ?? {}).some((o) => sets(o?.styles?.[nodeId])));
}

/** A color style value as opaque sRGB: see-through over `under`, or null when it cannot be known without a browser. */
function paint(tokens: TokenDef[], v: unknown, under: Rgba | null): Rgba | null {
  const css = cssOf(tokens, v);
  const c = css ? parseColor(css) : null;
  if (!c) return null;
  const alpha = tokenRef(v)?.alpha;
  const a = c.a * (typeof alpha === 'number' ? alpha : 1);
  if (a >= 1) return { ...c, a: 1 };
  return under ? compositeOver({ ...c, a }, under) : null;
}

/** The design to measure: a project component, or a theme component as adding it would make it. */
function resolve(state: ProjectState, spec: ComponentPreviewSpec): { state: ProjectState; def: ComponentDefinition } | null {
  if (spec.definitionId) {
    const def = Object.hasOwn(state.components, spec.definitionId) ? state.components[spec.definitionId] : undefined;
    return def ? { state, def } : null;
  }
  if (!spec.componentId) return null;
  const mine = Object.values(state.components).find((d) => d.componentId === spec.componentId);
  if (mine) return { state, def: mine };
  const theirs = catalogueComponent(state.site.themeId, spec.componentId);
  if (!theirs) return null;
  const copy = structuredClone(state);
  copy.components[theirs.id] = structuredClone(theirs);
  return { state: copy, def: copy.components[theirs.id] };
}

/** Whether rendered text shows any words. */
const hasWords = (v: unknown): boolean => (typeof v === 'string' ? v.trim() !== '' : Array.isArray(v) && /"text":"[^"]*\S/.test(JSON.stringify(v)));

/**
 * What one placement of the design renders with these property values, as the generator decides it (conditions,
 * repeats): its nodes, and the nodes whose text shows words.
 */
function rendered(state: ProjectState, def: ComponentDefinition, spec: ComponentPreviewSpec): { nodes: Set<string>; texts: Set<string> } {
  const node = makeInstance(def, spec.props ?? {}, spec.variants);
  const tree: NodeTree = { rootIds: [node.id], nodes: { [node.id]: node } };
  const nodes = new Set<string>();
  walkRendered(state, tree, { node: (n, _scope, _reportId, inDef, owner) => void (inDef && owner?.id === def.id && nodes.add(n.id)) });
  const texts = new Set(renderedContent(state, tree).flatMap((c) => (c.kind === 'text' && c.defNodeId && hasWords(c.value) ? [c.defNodeId] : [])));
  return { nodes, texts };
}

/** One component at one screen width, measured from its design. */
export function measureComponent(state: ProjectState, spec: ComponentPreviewSpec, width: number): StaticMeasurement | { error: string } {
  const found = resolve(state, spec);
  if (!found) return { error: 'There is no such component to measure.' };
  const { def } = found;
  if (def.kind !== 'managed' || !def.tree) return { error: 'A code component can be measured only in a browser.' };
  const tree = def.tree;
  const tokens = effectiveTokens(found.state);
  const size = scopeForWidth(width);
  const shown = rendered(found.state, def, spec);
  const page = paint(tokens, { token: PAGE_BACKGROUND }, WHITE) ?? WHITE;
  const out: StaticMeasurement = { definitionId: def.id, width, findings: [], widths: { checked: 0, unmeasured: [] }, boxes: {}, texts: [] };
  const seen = new Set<string>();

  /** `room`: the width its container gives it. `doubtful`: something around it may change how its text looks. */
  const visit = (id: string, room: number, color: unknown, behind: Rgba | null, doubtful: boolean): void => {
    const n: GraphNode | undefined = tree.nodes[id];
    // A node a condition leaves out of this placement is not on the page at all.
    if (!n || seen.has(id) || !shown.nodes.has(id)) return;
    seen.add(id);
    // A component placed in the design is measured as part of the page it is on, not here.
    if (n.kind === 'instance') return;
    const st: StyleProps = (designStyles(def, id, spec.variants)[size] ?? {}) as StyleProps;
    if (st.hidden === true) return;
    const custom = customCssOn(def, id);
    // An opaque background of its own is known whatever is behind it; a picture, or a see-through one over a picture, is not.
    if (isSet(st.backgroundImage)) behind = null;
    else if (isSet(st.background)) behind = paint(tokens, st.background, behind);
    const fg = isSet(st.color) ? st.color : color;
    const opacity = typeof st.opacity === 'number' ? st.opacity : isSet(st.opacity) ? Number(cssOf(tokens, st.opacity)) : 1;
    const clips = ['hidden', 'clip'].includes(String(st.overflow)) && (isSet(st.height) || isSet(st.maxHeight));
    const unsure = doubtful || !(opacity >= 1) || clips || custom;

    let inner = room;
    if (n.kind !== 'repeat' && n.kind !== 'slot') {
      const box = custom ? 'unknown' : boxWidth(tokens, st, room, width);
      if (box === 'unknown') out.widths.unmeasured.push(id);
      else {
        out.widths.checked++;
        if (typeof box === 'number') {
          out.boxes[id] = box;
          inner = box;
          // Wider than the screen, and than its container: one that only fills a container too wide is that container's overflow.
          if (box > width + 0.5 && box > room + 0.5) out.findings.push({ kind: 'element-overflow', nodeId: id, message: `It is ${Math.round(box)}px wide, wider than the ${width}px screen, so the page scrolls sideways.` });
        }
      }
    }

    if (n.kind === 'text' && shown.texts.has(id)) {
      const text = behind && !unsure ? paint(tokens, fg, behind) : null;
      const ratio = text && behind ? contrastBetween(text, behind) : null;
      out.texts.push({ nodeId: id, ratio });
      if (ratio !== null && ratio < TEXT_CONTRAST)
        out.findings.push({ kind: 'low-contrast', nodeId: id, message: `Its text has a contrast of ${formatRatio(ratio)} against what is behind it, below ${TEXT_CONTRAST}:1.` });
    }
    // Items side by side in a row that does not wrap: their minimum widths together can be more than the row has.
    if (st.layout === 'row' && st.wrap !== true && !custom) {
      const items = childLists(n).flatMap((l) => l.ids).flatMap((c) => (shown.nodes.has(c) && tree.nodes[c]?.kind !== 'repeat' ? [c] : []));
      const need = items.reduce((sum, c) => {
        const own = (designStyles(def, c, spec.variants)[size] ?? {}) as StyleProps;
        const min = own.hidden === true ? 0 : minWidthOf(tokens, own, inner, width);
        return typeof min === 'number' && typeof sum === 'number' ? sum + min : 'unknown';
      }, 0 as number | 'unknown');
      if (typeof need === 'number' && need > inner + 0.5) out.findings.push({ kind: 'element-overflow', nodeId: id, message: `Its items need at least ${Math.round(need)}px side by side, more than the ${Math.round(inner)}px it has, so they spill out.` });
    }
    for (const list of childLists(n)) for (const child of list.ids) visit(child, inner, fg, behind, unsure);
  };
  for (const root of tree.rootIds) visit(root, width, { token: PAGE_TEXT }, page, false);
  return out;
}

/** What the editor's preview would report for one step, from the design alone (see shared/inspection.ts). */
function report(state: ProjectState, step: ComponentPreviewStep): ComponentPreviewResult {
  const m = measureComponent(state, step.spec, step.width);
  if ('error' in m) return { state: 'error', error: m.error, width: step.width };
  // A width that could not be worked out is reported beside what was found, so the step never reads as clean.
  const unmeasured = m.widths.unmeasured.length ? [`The width of ${m.widths.unmeasured.map((id) => `"${id}"`).join(', ')} could not be measured without a browser: give it a length, a percentage, fill or fit, without custom CSS.`] : [];
  const ctx = `${previewCtx(m.definitionId)}|${PREVIEW_NODE_ID}`;
  const unverified = m.texts.filter((t) => t.ratio === null).length;
  return {
    state: 'ready',
    definitionId: m.definitionId,
    width: step.width,
    bounds: null,
    report: {
      viewportWidth: step.width,
      ...(unmeasured.length ? { runtimeErrors: unmeasured } : {}),
      issues: m.findings.map((f) => ({ kind: f.kind, message: f.message, desc: { ctx, node: f.nodeId, items: '' } })),
      checks: {
        overflow: { checked: m.widths.checked, failed: m.findings.filter((f) => f.kind === 'element-overflow').length },
        contrast: { checked: m.texts.length - unverified, failed: m.findings.filter((f) => f.kind === 'low-contrast').length, unverified }
      }
    }
  };
}

/** inspect_component's measurements, read from the project as it is when they are asked for. */
export const staticInspector = (state: () => ProjectState) => async (steps: ComponentPreviewStep[]) => steps.map((s) => report(state(), s));
