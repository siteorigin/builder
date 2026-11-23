import type { ProjectState } from '@shared/types';
import { isBinding } from '@shared/types';
import { validateRoute } from '@shared/routes';
import { allTrees, childLists, displayName } from './tree';

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  owner?: { kind: string; id: string };
  nodeId?: string;
}

/** Schema and reference validation: IDs, references, nesting and routes. */
export function validateState(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  const routes = new Map<string, string>();
  if (!state.pages[state.site.homePageId]) out.push({ severity: 'error', code: 'HOME_MISSING', message: 'The site has no Home page.' });
  for (const id of state.site.pageOrder) {
    const p = state.pages[id];
    if (!p) {
      out.push({ severity: 'error', code: 'PAGE_MISSING', message: `Page order references missing page ${id}.` });
      continue;
    }
    const err = validateRoute(p.route);
    if (err) out.push({ severity: 'error', code: 'ROUTE_INVALID', message: `${p.title}: ${err}`, owner: { kind: 'page', id } });
    const key = p.route.toLowerCase();
    if (routes.has(key)) out.push({ severity: 'error', code: 'ROUTE_DUPLICATE', message: `${p.title} and ${routes.get(key)} share ${p.route}.`, owner: { kind: 'page', id } });
    routes.set(key, p.title);
  }
  for (const id of Object.keys(state.pages)) if (!state.site.pageOrder.includes(id)) out.push({ severity: 'error', code: 'PAGE_ORPHAN', message: `Page ${state.pages[id].title} is not in the page order.` });
  if (new Set(state.site.pageOrder).size !== state.site.pageOrder.length) out.push({ severity: 'error', code: 'PAGE_MISSING', message: 'The page order lists a page twice.' });
  for (const p of Object.values(state.pages)) {
    if ((p.route === '/') !== (p.id === state.site.homePageId))
      out.push({ severity: 'error', code: 'HOME_ROUTE', message: p.route === '/' ? `${p.title} uses "/" but is not the Home page.` : `The Home page (${p.title}) must use "/".`, owner: { kind: 'page', id: p.id } });
  }
  // Component definitions: bindings must resolve in scope, and declared parts must exist.
  for (const def of Object.values(state.components)) {
    if (def.kind !== 'managed' || !def.tree) continue;
    const tree = def.tree;
    const owner = { kind: 'component', id: def.id };
    for (const [pid, part] of Object.entries(def.parts)) {
      if (!tree.nodes[part.nodeId]) out.push({ severity: 'error', code: 'PART_MISSING', message: `${def.name}: part "${pid}" refers to an element that no longer exists.`, owner });
    }
    const visited = new Set<string>();
    const check = (id: string, inRepeat: boolean) => {
      const n = tree.nodes[id];
      if (!n || visited.has(id)) return;
      visited.add(id);
      const bindings: unknown[] = [n.when, n.unless];
      if (n.kind === 'text') bindings.push(n.text);
      if (n.kind === 'image') bindings.push(n.image);
      if (n.kind === 'link') bindings.push(n.link, n.label, n.appearance);
      if (n.kind === 'icon') bindings.push(n.icon);
      if (n.kind === 'repeat') bindings.push(n.list);
      if (n.kind === 'instance') bindings.push(...Object.values(n.props));
      for (const b of bindings) {
        if (!isBinding(b)) continue;
        if ('$prop' in b && !(b.$prop in def.properties))
          out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: an element uses the property "${b.$prop}", which the component does not have.`, owner, nodeId: id });
        if ('$item' in b && !inRepeat)
          out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: an element shows a list item field outside its list.`, owner, nodeId: id });
      }
      for (const cl of childLists(n)) cl.ids.forEach((c) => check(c, inRepeat || n.kind === 'repeat'));
    };
    tree.rootIds.forEach((r) => check(r, false));
  }

  for (const { owner, tree, label } of allTrees(state)) {
    const seen = new Map<string, number>();
    const visit = (ids: string[]) => {
      for (const id of ids) {
        seen.set(id, (seen.get(id) ?? 0) + 1);
        const n = tree.nodes[id];
        if (!n) {
          out.push({ severity: 'error', code: 'NODE_MISSING', message: `${label}: missing node ${id}.`, owner });
          continue;
        }
        if ((seen.get(id) ?? 0) > 1) {
          out.push({ severity: 'error', code: 'NODE_SHARED', message: `${label}: node ${id} appears twice.`, owner, nodeId: id });
          continue;
        }
        for (const cl of childLists(n)) visit(cl.ids);
      }
    };
    visit(tree.rootIds);
    for (const n of Object.values(tree.nodes)) {
      if (n.kind === 'instance') {
        const def = state.components[n.definitionId];
        if (!def) out.push({ severity: 'error', code: 'DEF_MISSING', message: `${label}: ${n.definitionId} is not installed.`, owner, nodeId: n.id });
      }
      if (!seen.has(n.id)) out.push({ severity: 'warning', code: 'NODE_DETACHED', message: `${label}: ${displayName(state, n)} is not attached to the tree.`, owner, nodeId: n.id });
    }
    // References inside literal values
    const walk = (v: unknown, nodeId: string) => {
      if (Array.isArray(v)) return v.forEach((x) => walk(x, nodeId));
      if (!v || typeof v !== 'object' || isBinding(v)) return;
      const o = v as Record<string, unknown>;
      if (o.type === 'page' && typeof o.target === 'string' && !state.pages[o.target])
        out.push({ severity: 'error', code: 'LINK_BROKEN', message: `${label}: a link points to a page that no longer exists.`, owner, nodeId });
      if (typeof o.assetId === 'string' && !state.assets.assets[o.assetId])
        out.push({ severity: 'error', code: 'ASSET_MISSING', message: `${label}: an image references a missing asset.`, owner, nodeId });
      if ('assetId' in o && o.assetId && !o.decorative && !String(o.alt ?? '').trim() && owner.kind !== 'component')
        out.push({ severity: 'warning', code: 'ALT_MISSING', message: `${label}: an image has no alternative text.`, owner, nodeId });
      Object.values(o).forEach((x) => walk(x, nodeId));
    };
    for (const n of Object.values(tree.nodes)) walk(n, n.id);
  }
  for (const a of Object.values(state.assets.assets)) {
    if (a.bytes > 1_500_000) out.push({ severity: 'warning', code: 'ASSET_LARGE', message: `${a.name} is ${(a.bytes / 1e6).toFixed(1)} MB. Consider a smaller image for faster pages.` });
  }
  return out;
}
