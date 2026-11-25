/**
 * The benchmark's stand-in for the editor's component preview, which needs a browser: a component measured from its
 * design alone, for inspect_component and for grading. It measures two things and nothing else: whether an element's
 * fixed width fits the screen, and whether the text that renders has enough contrast with what is behind it, from the
 * site's colors. Anything it cannot work out is counted as unmeasured, never as a pass. Overlaps, cut-off text, tap
 * targets and spacing need a browser, so they are never reported here.
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
import { renderedContent } from '@generator/checks';

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
  /** Elements whose width was measured, and those whose width could not be (a calc(), say). */
  widths: { checked: number; unmeasured: string[] };
  /** Text that renders and is not hidden at this width, by design node, with its ratio when it could be measured. */
  texts: Array<{ nodeId: string; ratio: number | null }>;
}

export type Length = { px: number } | 'fluid' | 'unknown';

const tokenRef = (v: unknown): { token: string; alpha?: number } | null => (v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string' ? (v as { token: string; alpha?: number }) : null);

/** A style value as plain CSS text, following token references. */
function cssOf(tokens: TokenDef[], v: unknown): string | null {
  const ref = tokenRef(v);
  if (ref) {
    const t = followToken(tokens, ref.token);
    return typeof t === 'string' ? t : typeof t === 'number' ? String(t) : null;
  }
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

/** A width as pixels, as something that takes its size from the screen or its container, or as unknown. */
export function lengthOf(tokens: TokenDef[], v: unknown): Length {
  if (v === undefined || v === null) return 'fluid';
  if (typeof v === 'number') return { px: v };
  const css = cssOf(tokens, v)?.trim().toLowerCase();
  if (!css) return 'unknown';
  if (['fill', 'fit', 'auto', 'none', 'fit-content', 'min-content', 'max-content'].includes(css)) return 'fluid';
  const m = /^(-?\d*\.?\d+)(px|rem|em|%|vw)?$/.exec(css);
  if (!m) return 'unknown';
  const n = Number(m[1]);
  if (m[2] === '%' || m[2] === 'vw') return n <= 100 ? 'fluid' : 'unknown';
  return { px: m[2] === 'rem' || m[2] === 'em' ? n * REM_PX : n };
}

/** A color style value as opaque sRGB over `under`, or null when it cannot be known without a browser. */
function colorOf(tokens: TokenDef[], v: unknown, under: Rgba): Rgba | null {
  const css = cssOf(tokens, v);
  const c = css ? parseColor(css) : null;
  if (!c) return null;
  const alpha = tokenRef(v)?.alpha;
  const a = c.a * (typeof alpha === 'number' ? alpha : 1);
  return a >= 1 ? { ...c, a: 1 } : compositeOver({ ...c, a }, under);
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

/** The design nodes whose text renders with these property values (a condition can leave one out). */
function renderedTexts(state: ProjectState, def: ComponentDefinition, spec: ComponentPreviewSpec): Set<string> {
  const node = makeInstance(def, spec.props ?? {}, spec.variants);
  const tree: NodeTree = { rootIds: [node.id], nodes: { [node.id]: node } };
  return new Set(renderedContent(state, tree).flatMap((c) => (c.kind === 'text' && c.defNodeId ? [c.defNodeId] : [])));
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
  const shown = renderedTexts(found.state, def, spec);
  const page = colorOf(tokens, { token: PAGE_BACKGROUND }, WHITE) ?? WHITE;
  const out: StaticMeasurement = { definitionId: def.id, width, findings: [], widths: { checked: 0, unmeasured: [] }, texts: [] };
  const seen = new Set<string>();

  const visit = (id: string, color: unknown, background: Rgba | null) => {
    const n: GraphNode | undefined = tree.nodes[id];
    if (!n || seen.has(id)) return;
    seen.add(id);
    // A component placed in the design is measured as part of the page it is on, not here.
    if (n.kind === 'instance') return;
    const st: StyleProps = (designStyles(def, id, spec.variants)[size] ?? {}) as StyleProps;
    if (st.hidden === true) return;
    let behind = background;
    if (st.backgroundImage !== undefined && st.backgroundImage !== null) behind = null;
    else if (st.background !== undefined && st.background !== null) behind = behind && colorOf(tokens, st.background, behind);
    const fg = st.color !== undefined && st.color !== null ? st.color : color;

    if (n.kind !== 'repeat' && n.kind !== 'slot') {
      const w = lengthOf(tokens, st.width);
      const min = lengthOf(tokens, st.minWidth);
      const max = lengthOf(tokens, st.maxWidth);
      if (w === 'unknown' || min === 'unknown') out.widths.unmeasured.push(id);
      else {
        out.widths.checked++;
        // A minimum width wins over a maximum; a maximum caps a fixed width.
        const capped = max === 'fluid' ? st.maxWidth !== undefined && st.maxWidth !== null && st.maxWidth !== 'none' : typeof max === 'object' && max.px <= width;
        const wide = (typeof min === 'object' && min.px > width) || (typeof w === 'object' && w.px > width && !capped);
        if (wide) {
          const px = Math.max(typeof w === 'object' ? w.px : 0, typeof min === 'object' ? min.px : 0);
          out.findings.push({ kind: 'element-overflow', nodeId: id, message: `It is ${px}px wide, wider than the ${width}px screen, so the page scrolls sideways.` });
        }
      }
    }

    if (n.kind === 'text' && shown.has(id)) {
      const text = colorOf(tokens, fg, behind ?? WHITE);
      const ratio = text && behind ? contrastBetween(text, behind) : null;
      out.texts.push({ nodeId: id, ratio });
      if (ratio !== null && ratio < TEXT_CONTRAST)
        out.findings.push({ kind: 'low-contrast', nodeId: id, message: `Its text has a contrast of ${formatRatio(ratio)} against what is behind it, below ${TEXT_CONTRAST}:1.` });
    }
    for (const list of childLists(n)) for (const child of list.ids) visit(child, fg, behind);
  };
  for (const root of tree.rootIds) visit(root, { token: PAGE_TEXT }, page);
  return out;
}

/** What the editor's preview would report for one step, from the design alone (see shared/inspection.ts). */
function report(state: ProjectState, step: ComponentPreviewStep): ComponentPreviewResult {
  const m = measureComponent(state, step.spec, step.width);
  if ('error' in m) return { state: 'error', error: m.error, width: step.width };
  const ctx = `${previewCtx(m.definitionId)}|${PREVIEW_NODE_ID}`;
  const unverified = m.texts.filter((t) => t.ratio === null).length;
  return {
    state: 'ready',
    definitionId: m.definitionId,
    width: step.width,
    bounds: null,
    report: {
      viewportWidth: step.width,
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
