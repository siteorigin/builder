import { altStillToCheck, placeRoot } from '@engine/alt-review';
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

/** The row of a list property an image is in ("Image 3: Custom"): its position, and its title when it has one. */
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
  return `${schema.itemLabel} ${i + 1}${title ? `: ${title}` : ''}`;
}

/** The uses still to check after a replacement with `withId` (see altStillToCheck), named as the Assets panel lists them. */
export function altChecks(state: ProjectState, withId: string, review: readonly AltReview[]): AltCheck[] {
  const trees = new Map(allTrees(state).map((t) => [`${t.owner.kind}/${t.owner.id}`, t]));
  return altStillToCheck(state, withId, review).map((r): AltCheck => {
    const key = JSON.stringify(r);
    const base = { key, reason: r.reason, alt: r.alt };
    if ('definitionId' in r) {
      const def = state.components[r.definitionId];
      const label = typeof r.path[0] === 'string' ? def.properties[r.path[0]]?.label : undefined;
      return { ...base, icon: 'component', where: `${def.name} default`, what: label ? `${label}: starting image for new copies` : 'Starting image for new copies' };
    }
    const t = trees.get(`${r.owner.kind}/${r.owner.id}`)!;
    const node = placeRoot(state, r) as GraphNode;
    const row = rowLabel(state, node, r.path);
    const what = row ? `${displayName(state, node)} · ${row}` : displayName(state, node);
    if (t.owner.kind === 'page') return { ...base, icon: 'page', where: t.label, what, at: { owner: t.owner, nodeId: node.id } };
    if (t.owner.kind === 'shell') return { ...base, icon: 'shell', where: `Shared ${t.label.toLowerCase()}`, what, at: { owner: t.owner, nodeId: node.id } };
    return { ...base, icon: 'component', where: `${t.label} design`, what };
  });
}
