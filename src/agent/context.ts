import { axesOf, selectedVariants } from '@shared/variants';
import type { ComponentDefinition, ElementRef, GraphNode, NodeTree, OwnerRef, ProjectState, PropSchema } from '@shared/types';
import { isBinding } from '@shared/types';
import { isRichBlock, richTextToMarkdown, type RichPages } from '@shared/richtext';
import { displayName } from '@engine/tree';
import { effectiveTokens, isDraftPage } from '@generator/index';
import { catalogueEntries, getTheme } from '@catalogue/index';
import { teaserFields } from '@shared/page-teasers';

const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function summarizeValue(v: unknown, pages: RichPages, depth = 0): unknown {
  if (typeof v === 'string') return clip(v, 220);
  if (Array.isArray(v)) {
    // Rich text reads as the same short text form the tools accept.
    if (v.length && v.every(isRichBlock)) {
      const text = richTextToMarkdown(v, pages);
      // Never a shortened string that could be written back as the whole value.
      return text.length <= 1200 ? text : { truncated: true, chars: text.length, preview: clip(text, 400) };
    }
    if (depth > 2) return `[${v.length} items]`;
    return v.slice(0, 12).map((x) => summarizeValue(x, pages, depth + 1));
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = summarizeValue(x, pages, depth + 1);
    return out;
  }
  return v;
}

export function projectSummary(state: ProjectState, revision: number) {
  const theme = getTheme(state.site.themeId);
  return {
    revision,
    site: { name: state.site.name, description: state.site.description, language: state.site.language, baseUrl: state.site.baseUrl ?? null },
    theme: { id: theme.id, name: theme.name },
    homePageId: state.site.homePageId,
    pages: state.site.pageOrder.map((id) => {
      const p = state.pages[id];
      return { id, title: p.title, route: p.route, sections: p.rootIds.length, shell: p.shell, ...(isDraftPage(state, p) ? { draft: true } : {}) };
    }),
    shell: {
      header: state.site.shell.header.rootIds.map((id) => compactNode(state, state.site.shell.header, id)),
      footer: state.site.shell.footer.rootIds.map((id) => compactNode(state, state.site.shell.footer, id))
    },
    projectComponents: Object.values(state.components)
      .filter((d) => d.owner === 'project')
      .map((d) => ({ definitionId: d.id, name: d.name, kind: d.kind, description: d.description })),
    assets: Object.keys(state.assets.assets).length
  };
}

/** For a selection edit: what the run needs to know about the site, without the header and footer trees. */
export function compactProjectSummary(state: ProjectState, revision: number) {
  return {
    revision,
    site: { name: state.site.name },
    pages: state.site.pageOrder.map((id) => ({ id, title: state.pages[id].title, route: state.pages[id].route, ...(isDraftPage(state, state.pages[id]) ? { draft: true } : {}) }))
  };
}

export function compactNode(state: ProjectState, tree: NodeTree, id: string, depth = 0): Record<string, unknown> {
  const n = tree.nodes[id];
  if (!n) return { id, missing: true };
  const base: Record<string, unknown> = { id: n.id, name: displayName(state, n) };
  switch (n.kind) {
    case 'instance': {
      const def = state.components[n.definitionId];
      base.kind = 'instance';
      base.component = def?.name;
      base.componentId = def?.componentId;
      base.definitionId = n.definitionId;
      if (def?.owner === 'project') base.projectOwned = true;
      if (def?.variantAxes) base.variants = selectedVariants(def, n.variants);
      base.props = summarizeValue(n.props, state.pages);
      if (n.overrides) base.styleOverrides = n.overrides;
      if (n.slots && depth < 4) base.slots = Object.fromEntries(Object.entries(n.slots).map(([k, ids]) => [k, ids.map((c) => compactNode(state, tree, c, depth + 1))]));
      break;
    }
    case 'element':
      base.kind = 'element';
      base.tag = n.tag;
      if (n.styles) base.styles = n.styles;
      if (depth < 5) base.children = n.children.map((c) => compactNode(state, tree, c, depth + 1));
      break;
    case 'text':
      base.kind = 'text';
      base.tag = n.tag;
      base.text = isBinding(n.text) ? n.text : summarizeValue(n.text, state.pages);
      if (n.styles) base.styles = n.styles;
      break;
    case 'image':
      base.kind = 'image';
      base.image = n.image;
      if (n.styles) base.styles = n.styles;
      break;
    case 'link':
      base.kind = 'button';
      base.label = n.label;
      base.link = n.link;
      base.appearance = n.appearance;
      break;
    default:
      base.kind = n.kind;
  }
  return base;
}

export function pageDetail(state: ProjectState, pageId: string) {
  const p = state.pages[pageId];
  if (!p) return null;
  return {
    id: p.id,
    title: p.title,
    route: p.route,
    seo: p.seo,
    shell: p.shell,
    ...(isDraftPage(state, p) ? { draft: true } : {}),
    owner: { kind: 'page', id: p.id },
    sections: p.rootIds.map((id) => compactNode(state, p, id))
  };
}

export function propSchemaSummary(schema: Record<string, PropSchema>) {
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(schema)) {
    if (s.type === 'list')
      out[k] = {
        type: 'list',
        label: s.label,
        itemFields: Object.fromEntries(Object.entries(s.fields).map(([f, fs]) => [f, fs.type === 'enum' ? { type: 'enum', options: fs.options.map((o) => o.value) } : fs.type])),
        max: s.max,
        // A page list: these fields, left empty, show the linked page's own values and follow its later edits.
        ...(s.pageTeaser ? { fromLinkedPage: { link: s.pageTeaser.link, ...Object.fromEntries(teaserFields(s.pageTeaser).map(([f, what]) => [f, `page ${what} when empty`])) } } : {})
      };
    else if (s.type === 'enum') out[k] = { type: 'enum', label: s.label, options: s.options.map((o) => o.value) };
    else out[k] = { type: s.type, label: s.label };
  }
  return out;
}

export function componentDetail(def: ComponentDefinition) {
  return {
    definitionId: def.id,
    componentId: def.componentId,
    name: def.name,
    description: def.description,
    kind: def.kind,
    owner: def.owner,
    properties: propSchemaSummary(def.properties),
    parts: Object.fromEntries(Object.entries(def.parts).map(([k, p]) => [k, { label: p.label, styleControls: p.styleControls ?? [] }])),
    variantAxes: Object.fromEntries(axesOf(def).map(([axis, a]) => [axis, { label: a.label, default: a.default, options: Object.fromEntries(Object.entries(a.options).map(([k, v]) => [k, v.label])) }])),
    slots: def.slots ?? {},
    examples: def.examples ?? []
  };
}

/** One property as a short type signature: "string", "link", "enum(a|b)", "list<title:string, icon:icon>". */
function propSignature(s: PropSchema): string {
  if (s.type === 'enum') return `enum(${s.options.map((o) => o.value).join('|')})`;
  if (s.type === 'list') return `list<${Object.entries(s.fields).map(([f, fs]) => `${f}:${propSignature(fs)}`).join(', ')}>${s.max ? ` max ${s.max}` : ''}`;
  return s.type;
}

/**
 * The theme catalogue with compact property signatures, style parts and variants, so the model can plan a
 * whole page from one read instead of calling read_component for every component.
 */
export function catalogueIndex(themeId: string) {
  const defs = new Map(getTheme(themeId).components.map((c) => [c.componentId, c]));
  return catalogueEntries(themeId).map((e) => {
    const def = defs.get(e.componentId);
    return {
      componentId: e.componentId,
      name: e.name,
      category: e.category,
      variants: e.axes,
      props: def ? Object.fromEntries(Object.entries(def.properties).map(([k, s]) => [k, propSignature(s)])) : {},
      parts: def ? Object.keys(def.parts) : [],
      ...(def?.slots && Object.keys(def.slots).length ? { slots: Object.keys(def.slots) } : {})
    };
  });
}

export function tokensSummary(state: ProjectState) {
  return effectiveTokens(state).map((t) => ({ id: t.id, label: t.label, value: t.value, overridden: t.id in state.tokens.overrides }));
}

/** The selected element's own content, in full unless it is very large: this is what the edit works from. */
function selectedProps(props: Record<string, unknown>, pages: RichPages): unknown {
  return JSON.stringify(props).length <= 6000 ? props : summarizeValue(props, pages);
}

export function describeSelection(state: ProjectState, ref: ElementRef | null): Record<string, unknown> | null {
  if (!ref) return null;
  const tree: NodeTree | undefined =
    ref.owner.kind === 'page' ? state.pages[ref.owner.id] : ref.owner.kind === 'shell' ? state.site.shell[ref.owner.id as 'header' | 'footer'] : state.components[ref.owner.id]?.tree;
  if (!tree) return null;
  if (!ref.instancePath.length) {
    const node = compactNode(state, tree, ref.nodeId);
    const selected = tree.nodes[ref.nodeId];
    if (selected?.kind === 'instance') node.props = selectedProps(selected.props, state.pages);
    return { owner: ref.owner, nodeId: ref.nodeId, node };
  }
  const instId = ref.instancePath[0];
  const inst = tree.nodes[instId];
  const def = inst?.kind === 'instance' ? state.components[inst.definitionId] : undefined;
  const defNode: GraphNode | undefined = def?.tree?.nodes[ref.nodeId];
  let binding: unknown = null;
  if (defNode) {
    if (defNode.kind === 'text') binding = defNode.text;
    else if (defNode.kind === 'image') binding = defNode.image;
    else if (defNode.kind === 'link') binding = { link: defNode.link, label: defNode.label };
  }
  return {
    owner: ref.owner,
    instanceNodeId: instId,
    component: def?.name,
    definitionId: def?.id,
    partId: ref.partId ?? null,
    innerNodeId: ref.nodeId,
    itemId: ref.itemPath?.[ref.itemPath.length - 1] ?? null,
    boundTo: binding,
    ...(inst?.kind === 'instance' ? { currentProps: selectedProps(inst.props, state.pages) } : {}),
    note: 'Edit bound content with instance.setProp on the instance (use itemId and field for repeated items). Style the part with node.setStyle using partId.'
  };
}

export function ownerLabel(state: ProjectState, owner: OwnerRef): string {
  if (owner.kind === 'page') return state.pages[owner.id]?.title ?? 'Page';
  if (owner.kind === 'shell') return owner.id === 'header' ? 'Header' : 'Footer';
  return state.components[owner.id]?.name ?? 'Component';
}
