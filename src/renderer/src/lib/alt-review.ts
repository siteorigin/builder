import { allTrees, displayName } from '@engine/tree';
import type { AltReview, GraphNode, OwnerRef, ProjectState } from '@shared/types';

/** A use whose alt text an image replacement left for the author to check, as the Assets panel lists it. */
export interface AltCheck {
  key: string;
  reason: AltReview['reason'];
  /** The alt text it was left with. */
  alt: string;
  icon: 'page' | 'shell' | 'component';
  /** The page, shared part or component it is in. */
  where: string;
  /** The element, and the list row when it is in one. */
  what: string;
  /** The element to show it at: none in a component's design or starting value, which no page shows as such. */
  at?: { owner: OwnerRef; nodeId: string };
}

/** The value a path leads to: through objects by key, and through lists by item ID, or by position (see AltReview). */
export function valueAt(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let v = root;
  for (const step of path) {
    if (Array.isArray(v)) v = typeof step === 'number' ? v[step] : v.find((x) => !!x && typeof x === 'object' && (x as { id?: unknown }).id === step);
    else if (v && typeof v === 'object' && typeof step === 'string' && Object.hasOwn(v, step)) v = (v as Record<string, unknown>)[step];
    else return undefined;
  }
  return v;
}

/** The row of a list property an image is in ("Custom", "Image 3"), from its title field or its position. */
function rowLabel(state: ProjectState, node: GraphNode, path: ReadonlyArray<string | number>): string | undefined {
  if (node.kind !== 'instance' || path[0] !== 'props' || typeof path[1] !== 'string' || path.length < 4) return undefined;
  const schema = state.components[node.definitionId]?.properties[path[1]];
  const items = node.props[path[1]] as unknown;
  if (schema?.type !== 'list' || !Array.isArray(items)) return undefined;
  const rows = items as Array<Record<string, unknown> | null | undefined>;
  const i = typeof path[2] === 'number' ? path[2] : rows.findIndex((x) => x?.id === path[2]);
  if (i < 0 || !rows[i]) return undefined;
  const field = schema.titleField ? rows[i]![schema.titleField] : undefined;
  const title = typeof field === 'string' ? field.trim() : '';
  return title || `${schema.itemLabel} ${i + 1}`;
}

/**
 * The uses still to check after a replacement with `withId`: each still shows that image, is not decorative, and
 * still has the alt text the replacement left it. One removed, given another image or edited since drops out.
 */
export function altChecks(state: ProjectState, withId: string, review: readonly AltReview[]): AltCheck[] {
  const open = (v: unknown, r: AltReview) => {
    const image = v as { assetId?: unknown; alt?: unknown; decorative?: unknown } | undefined;
    return !!image && typeof image === 'object' && image.assetId === withId && !image.decorative && (typeof image.alt === 'string' ? image.alt : '') === r.alt;
  };
  const trees = new Map(allTrees(state).map((t) => [`${t.owner.kind}/${t.owner.id}`, t]));
  const out: AltCheck[] = [];
  for (const r of review) {
    const key = `${'definitionId' in r ? `default/${r.definitionId}` : `${r.owner.kind}/${r.owner.id}/${r.nodeId}`}/${r.path.join('/')}`;
    if ('definitionId' in r) {
      const def = Object.hasOwn(state.components, r.definitionId) ? state.components[r.definitionId] : undefined;
      if (def && open(valueAt(def.properties, r.path), r)) out.push({ key, reason: r.reason, alt: r.alt, icon: 'component', where: `${def.name} default`, what: 'Starting image for new copies' });
      continue;
    }
    const t = trees.get(`${r.owner.kind}/${r.owner.id}`);
    const node = t && Object.hasOwn(t.tree.nodes, r.nodeId) ? t.tree.nodes[r.nodeId] : undefined;
    if (!t || !node || !open(valueAt(node, r.path), r)) continue;
    const row = rowLabel(state, node, r.path);
    const what = row ? `${displayName(state, node)} · ${row}` : displayName(state, node);
    if (t.owner.kind === 'page') out.push({ key, reason: r.reason, alt: r.alt, icon: 'page', where: t.label, what, at: { owner: t.owner, nodeId: node.id } });
    else if (t.owner.kind === 'shell') out.push({ key, reason: r.reason, alt: r.alt, icon: 'shell', where: `Shared ${t.label.toLowerCase()}`, what, at: { owner: t.owner, nodeId: node.id } });
    else out.push({ key, reason: r.reason, alt: r.alt, icon: 'component', where: `${t.label} design`, what });
  }
  return out;
}
