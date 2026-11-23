import type { ProjectState, ResponsiveStyles } from '@shared/types';
import { ELEMENT_TAGS, TEXT_TAGS, isBinding } from '@shared/types';
import { validateRoute } from '@shared/routes';
import { variantIdsValid, variantOptions } from '@shared/variants';
import { allTrees, childLists, displayName, subtreeIds } from './tree';
import { boundSchema } from './schema';
import { declaredTokens, findTokenCycle } from './tokens';
import { missingSectionLinks, unlinkedButtons } from '@generator/checks';
import { formConnected } from '@catalogue/foundation/form';

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  owner?: { kind: string; id: string };
  nodeId?: string;
}

/**
 * Errors in what the site shows that an edit may still introduce: the author fixes them later (a link to a section
 * that was just deleted, say), so they never stop a change from being saved or a file from being loaded.
 */
const CONTENT_ERRORS = new Set(['LINK_SECTION_MISSING']);

/** Whether a diagnostic leaves the project inconsistent enough that a change introducing it is refused. */
export const blocksSaving = (d: Diagnostic) => d.severity === 'error' && !CONTENT_ERRORS.has(d.code);

/** "Home", "Home and About", "Home, About and Contact". */
const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? ''));

/**
 * Schema and reference validation: IDs, references, nesting and routes, and links to sections that do not exist.
 * Save gates pass `sectionLinks: false`: those findings never block a save, so they need not be worked out.
 */
export function validateState(state: ProjectState, opts: { sectionLinks?: boolean } = {}): Diagnostic[] {
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
        else if ('$item' in b && !boundSchema(def, id, b))
          out.push({ severity: 'error', code: 'BINDING_INVALID', message: `${def.name}: an element shows the item field "${b.$item}", which its list does not have.`, owner, nodeId: id });
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
    if (owner.kind !== 'component')
      for (const b of unlinkedButtons(state, tree))
        out.push({ severity: 'warning', code: 'BUTTON_UNLINKED', message: `${label}: the “${b.label}” button has no link, so it shows as plain text. Choose a destination or clear its label.`, owner, nodeId: b.nodeId });
    if (owner.kind !== 'component')
      for (const n of Object.values(tree.nodes)) {
        const def = n.kind === 'instance' ? state.components[n.definitionId] : undefined;
        if (n.kind !== 'instance' || def?.componentId !== 'contact.form' || def.kind !== 'code') continue;
        const props = Object.fromEntries(Object.entries(def.properties).map(([k, sch]) => [k, k in n.props ? n.props[k] : sch.default]));
        if (!formConnected(props))
          out.push({ severity: 'warning', code: 'FORM_UNCONNECTED', message: `${label}: the contact form is not connected to a form service, so visitors cannot send it. Add an HTTPS form endpoint or a Web3Forms access key, or choose Netlify Forms.`, owner, nodeId: n.id });
      }
  }
  for (const i of opts.sectionLinks === false ? [] : missingSectionLinks(state)) {
    const where = i.owner.kind === 'shell' ? (i.owner.id === 'header' ? 'Header' : 'Footer') : (state.pages[i.owner.id]?.title ?? 'A page');
    const what = i.label ? `the “${i.label}” link${i.inText ? ' in the text' : ''}` : `a link${i.inText ? ' in the text' : ''}`;
    const fix = i.inText ? 'Change the link in the text to a section the page has.' : 'Choose one of the page’s sections in the link’s Section list.';
    const message = i.pageId
      ? `${where}: ${what} goes to #${i.fragment} on ${state.pages[i.pageId].title}, but that page has no section with that ID. ${fix}`
      : `${where}: ${what} goes to #${i.fragment}, but ${listed((i.pages ?? []).map((id) => state.pages[id].title))} ${(i.pages ?? []).length > 1 ? 'have' : 'has'} no section with that ID. ${fix}`;
    out.push({ severity: 'error', code: 'LINK_SECTION_MISSING', message, owner: i.owner, nodeId: i.nodeId });
  }
  out.push(...structureDiagnostics(state));
  for (const a of Object.values(state.assets.assets)) {
    if (a.bytes > 1_500_000) out.push({ severity: 'warning', code: 'ASSET_LARGE', message: `${a.name} is ${(a.bytes / 1e6).toFixed(1)} MB. Consider a smaller image for faster pages.` });
  }
  return out;
}

const ELEMENT_TAG_SET = new Set<string>(ELEMENT_TAGS);
const TEXT_TAG_SET = new Set<string>(TEXT_TAGS);

/**
 * Checks that catch documents edited outside the editor: unknown HTML tags, slots that do not match their
 * definition, definitions that contain themselves, and site styles that loop or point at nothing.
 */
function structureDiagnostics(state: ProjectState): Diagnostic[] {
  const out: Diagnostic[] = [];
  const tokenIds = new Set(declaredTokens(state).map((t) => t.id));
  const groupOf = new Map(declaredTokens(state).map((t) => [t.id, t.group]));
  const checkStyles = (rs: ResponsiveStyles | undefined, label: string, owner: Diagnostic['owner'], nodeId?: string) => {
    for (const scope of Object.values(rs ?? {})) {
      for (const v of Object.values(scope ?? {})) {
        if (v && typeof v === 'object' && typeof (v as { token?: unknown }).token === 'string' && !tokenIds.has((v as { token: string }).token))
          out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `${label}: a style uses the site style "${(v as { token: string }).token}", which does not exist.`, owner, nodeId });
      }
    }
  };
  for (const { owner, tree, label } of allTrees(state)) {
    const def = owner.kind === 'component' ? state.components[owner.id] : undefined;
    // Theme definitions are fixed theme data, checked when the theme is built.
    if (def?.owner === 'theme') continue;
    for (const n of Object.values(tree.nodes)) {
      if (n.kind === 'element' && !ELEMENT_TAG_SET.has(n.tag)) out.push({ severity: 'error', code: 'TAG_INVALID', message: `${label}: "${String(n.tag)}" is not a supported element tag.`, owner, nodeId: n.id });
      if (n.kind === 'text' && !TEXT_TAG_SET.has(n.tag)) out.push({ severity: 'error', code: 'TAG_INVALID', message: `${label}: "${String(n.tag)}" is not a supported text tag.`, owner, nodeId: n.id });
      if (n.kind === 'slot' && !def) out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${label}: slots can only be placed inside a component definition.`, owner, nodeId: n.id });
      else if (n.kind === 'slot' && !Object.hasOwn(def!.slots ?? {}, n.slot))
        out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${label}: the slot "${n.slot}" is not declared by the component.`, owner, nodeId: n.id });
      if (n.kind === 'instance') {
        const target = state.components[n.definitionId];
        for (const s of Object.keys(n.slots ?? {}))
          if (target && !Object.hasOwn(target.slots ?? {}, s))
            out.push({ severity: 'error', code: 'SLOT_INVALID', message: `${label}: content is placed in "${s}", which ${target.name} does not have.`, owner, nodeId: n.id });
        for (const [axis, v] of Object.entries(n.variants ?? {})) {
          if (!target || isBinding(v)) continue;
          const a = target.variantAxes && Object.hasOwn(target.variantAxes, axis) ? target.variantAxes[axis] : undefined;
          if (!a || !Object.hasOwn(a.options, v)) out.push({ severity: 'warning', code: 'VARIANT_UNKNOWN', message: `${label}: ${target.name} has no ${axis} "${String(v)}", so it shows its default.`, owner, nodeId: n.id });
        }
        for (const o of Object.values(n.overrides ?? {})) checkStyles(o, label, owner, n.id);
      }
      checkStyles(n.styles, label, owner, n.id);
    }
    if (def) {
      for (const { option: v } of variantOptions(def)) for (const [nid, st] of Object.entries(v.styles ?? {})) checkStyles(st, label, owner, nid);
      if (!variantIdsValid(def)) out.push({ severity: 'warning', code: 'VARIANT_ID_INVALID', message: `${label}: a variant name uses characters that cannot be generated, so that variant is ignored.`, owner });
      for (const [axis, a] of Object.entries(def.variantAxes ?? {}))
        if (!Object.hasOwn(a.options ?? {}, a.default)) out.push({ severity: 'error', code: 'VARIANT_INVALID', message: `${label}: the default of the "${a.label ?? axis}" variant axis ("${a.default}") is not one of its options.`, owner });
      const reachable = new Set(tree.rootIds.flatMap((r) => subtreeIds(tree, r)));
      if (def.kind === 'managed')
        for (const s of Object.keys(def.slots ?? {}))
          if (!Object.values(tree.nodes).some((n) => n.kind === 'slot' && n.slot === s && reachable.has(n.id)))
            out.push({ severity: 'warning', code: 'SLOT_UNPLACED', message: `${label}: the "${def.slots![s].label}" slot is declared but not placed, so content put there will not show.`, owner });
    }
  }
  for (const [id, v] of [...Object.entries(state.tokens.overrides), ...state.tokens.custom.map((t) => [t.id, t.value] as const)]) {
    const isFamily = !!v && typeof v === 'object' && 'family' in v;
    const r = (isFamily ? (v as { family: unknown }).family : v) as unknown;
    if (!r || typeof r !== 'object' || !('token' in (r as object))) continue;
    const ref = (r as { token: unknown }).token;
    const want = isFamily ? 'font' : groupOf.get(id);
    if (typeof ref !== 'string') out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `The site style "${id}" has a malformed reference.` });
    else if (!tokenIds.has(ref)) out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `The site style "${id}" refers to "${ref}", which does not exist.` });
    else if (want && groupOf.get(ref) !== want) out.push({ severity: 'error', code: 'TOKEN_MISSING', message: `The site style "${id}" refers to "${ref}", which is not a ${want} style.` });
  }
  const cycle = findTokenCycle(state);
  if (cycle) out.push({ severity: 'error', code: 'TOKEN_CYCLE', message: `The site style "${cycle}" refers back to itself through other styles.` });
  // Definitions that place themselves, directly or through others, can never render.
  const deps = (id: string): string[] => {
    const d = state.components[id];
    if (!d) return [];
    // Managed definitions depend on what their tree places; code declares its dependencies.
    const ids = new Set(d.kind === 'code' ? (d.dependencies ?? []) : []);
    for (const n of Object.values(d.tree?.nodes ?? {})) if (n.kind === 'instance') ids.add(n.definitionId);
    return [...ids];
  };
  const state_ = new Map<string, 'open' | 'done'>();
  const visit = (id: string, path: string[]): string[] | null => {
    if (state_.get(id) === 'done') return null;
    if (state_.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    state_.set(id, 'open');
    for (const dep of deps(id)) {
      const c = visit(dep, [...path, id]);
      if (c) return c;
    }
    state_.set(id, 'done');
    return null;
  };
  for (const id of Object.keys(state.components).sort()) {
    const c = visit(id, []);
    if (c) {
      out.push({ severity: 'error', code: 'DEF_CYCLE', message: `${c.map((x) => state.components[x]?.name ?? x).join(' → ')}: a component cannot contain itself.`, owner: { kind: 'component', id: c[0] } });
      break;
    }
  }
  return out;
}
