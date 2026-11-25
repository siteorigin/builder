/**
 * The elements an inspect_layout call can be narrowed to: the references its findings name (see InspectionRef), sent
 * back to measure just those elements and what is inside them. Each is checked against the page here, and passed on
 * to the editor as the element reference its preview frame finds (see the renderer's descOf).
 */
import { z } from 'zod';
import type { ElementRef, ProjectState } from '@shared/types';
import { partsShown } from '@shared/page-shell';
import { placementItems, repeatedPartList } from '@shared/item-styles';
import { findParent } from '@engine/tree';

/** How many elements one call measures at most. */
export const MAX_LAYOUT_TARGETS = 10;

/** A finding's ref as the model sends it back; what it adds to explain a finding (match, definition) is not needed. */
export const LAYOUT_TARGET = z.object({
  // The same shape as every other owner, so a grammar can share it; only a page's own or its header or footer resolves.
  owner: z.object({ kind: z.enum(['page', 'shell', 'component', 'template']), id: z.string() }),
  nodeId: z.string(),
  partId: z.string().optional(),
  itemId: z.string().optional()
});
export type LayoutTarget = z.infer<typeof LAYOUT_TARGET>;

const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined => (map && Object.hasOwn(map, key) ? map[key] : undefined);

/** A reference as it names an element: its address and nothing else, the way results echo it. */
export const targetRef = (t: LayoutTarget): LayoutTarget => ({ owner: { kind: t.owner.kind, id: t.owner.id }, nodeId: t.nodeId, ...(t.partId !== undefined ? { partId: t.partId } : {}), ...(t.itemId !== undefined ? { itemId: t.itemId } : {}) });

/** What a narrowed inspection measured, independent of order or repeats: it says which result stands for which. */
export function layoutScope(targets: unknown): string | undefined {
  if (!Array.isArray(targets)) return undefined;
  const keys = targets.map((t) => {
    const r = (t ?? {}) as Partial<LayoutTarget>;
    return JSON.stringify([r.owner?.kind ?? null, r.owner?.id ?? null, r.nodeId ?? null, r.partId ?? null, r.itemId ?? null]);
  });
  return [...new Set(keys)].sort().join('\n');
}

/** Whether an inspect_layout call, by its raw arguments, asked for chosen elements: passed or failed, it never checked the page. */
export function narrowedInspection(rawArgs: string): boolean {
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown> | null;
    // Any refs given, even ones the tool refuses (null, an empty list), asked for elements and not the page.
    return !!args && typeof args === 'object' && Object.hasOwn(args, 'refs');
  } catch {
    return false;
  }
}

/** Whether a node is in the tree's rendered structure: reached from one of its roots, not left detached. */
function placed(tree: { rootIds: string[]; nodes: Record<string, unknown> }, nodeId: string): boolean {
  if (!own(tree.nodes, nodeId)) return false;
  const seen = new Set<string>();
  for (let id: string | null = nodeId; id !== null; ) {
    if (seen.has(id)) return false;
    seen.add(id);
    const p = findParent(tree as never, id);
    if (!p) return false;
    id = p.parentId;
  }
  return true;
}

/**
 * The element each reference names on `pageId`, in order, or the first one that names nothing there and why. A
 * reference resolves on the page when its owner is the page or a shared part the page shows, its node is placed in
 * that owner's tree, its part is one the placement's component declares, and its item one the part's list holds.
 */
export function resolveLayoutTargets(state: ProjectState, pageId: string, targets: LayoutTarget[]): { ok: true; targets: ElementRef[] } | { ok: false; message: string } {
  const page = own(state.pages, pageId);
  const out: ElementRef[] = [];
  for (const [i, t] of targets.entries()) {
    const fail = (why: string) => ({ ok: false as const, message: `refs[${i}] (${JSON.stringify(targetRef(t))}) ${why}` });
    let tree;
    if (t.owner.kind === 'page') {
      if (t.owner.id !== pageId) return fail(`is on another page, not ${pageId}. Inspect that page instead.`);
      tree = page;
    } else if (t.owner.kind === 'shell') {
      if ((t.owner.id !== 'header' && t.owner.id !== 'footer') || !partsShown(page).includes(t.owner.id)) return fail(`names a shared ${t.owner.id} this page does not show.`);
      tree = state.site.shell[t.owner.id];
    } else return fail(`is not on a page: pass the page placement's ref, not a component design's.`);
    if (!tree || !placed(tree, t.nodeId)) return fail(`names node ${t.nodeId}, which is not on this page.`);
    const node = tree.nodes[t.nodeId];
    if (t.partId === undefined) {
      if (t.itemId !== undefined) return fail('has an itemId without the partId it belongs to.');
      out.push({ owner: t.owner, instancePath: [], nodeId: t.nodeId });
      continue;
    }
    const def = node.kind === 'instance' ? own(state.components, node.definitionId) : undefined;
    if (node.kind !== 'instance' || !def) return fail('has a partId, but its node is not a placed component.');
    const part = own(def.parts, t.partId);
    // The root part of a design (a placement's ref can name it by its declared part) is the placement itself.
    const root = def.kind === 'managed' ? def.tree?.rootIds[0] : undefined;
    // A code component's root is its placement too: its markup has no element of the editor's for it.
    if (def.kind === 'code' && t.partId === 'root' && t.itemId === undefined) {
      out.push({ owner: t.owner, instancePath: [], nodeId: t.nodeId });
      continue;
    }
    if (!part || typeof part.nodeId !== 'string' || (def.kind === 'managed' && !(def.tree && placed(def.tree, part.nodeId)))) {
      if (t.partId === 'root' && t.itemId === undefined) {
        out.push({ owner: t.owner, instancePath: [], nodeId: t.nodeId });
        continue;
      }
      return fail(`names part "${t.partId}", which ${def.name ? `"${def.name}"` : 'its component'} does not declare.`);
    }
    if (t.itemId !== undefined) {
      // An empty item ID would name no item to the preview, and so every item.
      if (!t.itemId) return fail('has an empty itemId.');
      const list = repeatedPartList(def, t.partId);
      if (!list) return fail(`has an itemId, but part "${t.partId}" is not repeated for each item of a list.`);
      if (!placementItems(def, node, list).some((item) => item.id === t.itemId)) return fail(`names item ${t.itemId}, which the "${list}" list no longer has.`);
    }
    if (part.nodeId === root && t.itemId === undefined) {
      out.push({ owner: t.owner, instancePath: [], nodeId: t.nodeId });
      continue;
    }
    out.push({ owner: t.owner, instancePath: [t.nodeId], nodeId: part.nodeId, partId: t.partId, ...(t.itemId !== undefined ? { itemPath: [t.itemId] } : {}) });
  }
  return { ok: true, targets: out };
}
