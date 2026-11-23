/**
 * Checks on what a page will actually show, evaluated with the same rules the generated components use.
 */
import type { Binding, ComponentDefinition, GraphNode, ImageValue, LinkValue, NodeTree, ProjectState, PropSchema } from '@shared/types';
import { isBinding } from '@shared/types';
import { resolveLink } from './index';

const BUTTONS = new Set(['primary', 'secondary', 'text', 'light']);

interface Scope {
  props: Record<string, unknown>;
  item?: Record<string, unknown>;
  /** Fields of the list the current item comes from, for their defaults. */
  fields?: Record<string, PropSchema>;
}

function evaluate(v: unknown, scope: Scope): unknown {
  if (!isBinding(v)) return v;
  const b = v as Binding;
  if ('$prop' in b) return scope.props[b.$prop];
  const item = scope.item ?? {};
  return Object.hasOwn(item, b.$item) ? item[b.$item] : (scope.fields?.[b.$item] as { default?: unknown } | undefined)?.default;
}

/** Mirrors the generated `has()` helper, on unresolved values. */
function shown(v: unknown, state: ProjectState): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('type' in o && 'target' in o) return !!resolveLink(o as unknown as LinkValue, { state });
    if ('assetId' in o) return !!o.assetId && !!state.assets.assets[String(o.assetId)];
    return true;
  }
  return !!v;
}

interface Visit {
  /** A link node about to render. */
  link?: (n: GraphNode & { kind: 'link' }, scope: Scope, reportId: string) => void;
  /** An image node about to render. */
  image?: (n: GraphNode & { kind: 'image' }, scope: Scope, reportId: string) => void;
}

/**
 * Walk what a page or shell tree renders: its reachable nodes, and inside each managed component the nodes
 * whose conditions hold, once per list item. Callbacks report against the page node (the instance for
 * anything inside a component).
 */
function walkRendered(state: ProjectState, tree: NodeTree, visit: Visit) {
  const walkDef = (def: ComponentDefinition, id: string, scope: Scope, reportId: string, path: Set<string>) => {
    const n = def.tree?.nodes[id];
    if (!n || path.has(id)) return;
    if (n.when && !shown(evaluate(n.when, scope), state)) return;
    if (n.unless && shown(evaluate(n.unless, scope), state)) return;
    const inner = new Set(path).add(id);
    if (n.kind === 'link') visit.link?.(n, scope, reportId);
    if (n.kind === 'image') visit.image?.(n, scope, reportId);
    if (n.kind === 'repeat') {
      const items = evaluate(n.list, scope);
      const schema = isBinding(n.list) && '$prop' in n.list ? def.properties[n.list.$prop] : undefined;
      const fields = schema?.type === 'list' ? schema.fields : undefined;
      for (const item of Array.isArray(items) ? items : []) for (const c of n.children) walkDef(def, c, { ...scope, item: item as Record<string, unknown>, fields }, reportId, inner);
    } else if (n.kind === 'element') for (const c of n.children) walkDef(def, c, scope, reportId, inner);
  };
  const seen = new Set<string>();
  const walkPage = (id: string) => {
    const n = tree.nodes[id];
    if (!n || seen.has(id)) return;
    seen.add(id);
    if (n.kind === 'link') visit.link?.(n, { props: {} }, n.id);
    if (n.kind === 'image') visit.image?.(n, { props: {} }, n.id);
    if (n.kind === 'element') n.children.forEach(walkPage);
    if (n.kind !== 'instance') return;
    Object.values(n.slots ?? {}).forEach((ids) => ids.forEach(walkPage));
    const def = state.components[n.definitionId];
    if (def?.kind !== 'managed' || !def.tree) return;
    const props: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(def.properties)) props[name] = Object.hasOwn(n.props, name) ? n.props[name] : schema.default;
    for (const r of def.tree.rootIds) walkDef(def, r, { props }, n.id, new Set());
  };
  tree.rootIds.forEach(walkPage);
}

export interface UnlinkedButton {
  /** Node in the page or shell tree (the instance, for buttons inside a component). */
  nodeId: string;
  label: string;
}

/**
 * Buttons that will render with a label but no destination. They show as plain text on the site, which is
 * easy to miss in the editor, so they are reported as diagnostics.
 */
export function unlinkedButtons(state: ProjectState, tree: NodeTree): UnlinkedButton[] {
  const out: UnlinkedButton[] = [];
  walkRendered(state, tree, {
    link: (n, scope, reportId) => {
      const appearance = String(evaluate(n.appearance, scope) ?? '');
      const label = String(evaluate(n.label, scope) ?? '').trim();
      const link = evaluate(n.link, scope) as LinkValue | undefined;
      if (BUTTONS.has(appearance) && label && !resolveLink(link, { state })) out.push({ nodeId: reportId, label });
    }
  });
  return out;
}

/** How many images on the site's pages and shell render as placeholders because no image is chosen yet. */
export function placeholderImageCount(state: ProjectState): number {
  let count = 0;
  const pages = state.site.pageOrder.map((id) => state.pages[id]).filter(Boolean);
  // The header and footer only render when at least one page uses them.
  const shell = pages.some((p) => p.shell !== 'none') ? [state.site.shell.header, state.site.shell.footer] : [];
  const trees = [...shell, ...pages];
  for (const tree of trees)
    walkRendered(state, tree, {
      image: (n, scope) => {
        const img = evaluate(n.image, scope) as ImageValue | undefined;
        if (!img?.assetId || !state.assets.assets[img.assetId]) count++;
      }
    });
  return count;
}
