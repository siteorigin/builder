/**
 * Checks on what a page will actually show, evaluated with the same rules the generated components use.
 */
import type { Binding, ComponentDefinition, GraphNode, ImageValue, LinkValue, NodeTree, PageDoc, ProjectState, PropSchema } from '@shared/types';
import { isBinding } from '@shared/types';
import { isListBlock, richTextToPlain, toRichText, type RichSpan } from '@shared/richtext';
import type { EditOperation } from '@shared/ops';
import { slugify } from '@shared/routes';
import { anchorCapable, anchorsInUse } from '@engine/tree';
import { resolveLink, takesParagraphs } from './index';

const BUTTONS = new Set(['primary', 'secondary', 'text', 'light']);

interface Scope {
  props: Record<string, unknown>;
  /** The placements this scope sits in, from the page down, to tell their links apart. */
  trail?: string;
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
  if (typeof v === 'string') return v.trim().length > 0;
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
  /** A text node about to render. */
  text?: (n: GraphNode & { kind: 'text' }, scope: Scope, reportId: string) => void;
  /** An `id` attribute the generated markup will carry. */
  id?: (id: string, reportId: string) => void;
  /** A code component placement about to render, with its effective property values. */
  code?: (def: ComponentDefinition, props: Record<string, unknown>, reportId: string, placement: string) => void;
  /** A page-level node (page or shell tree) about to render, before anything inside it. */
  enter?: (n: GraphNode) => void;
  /** After everything inside a page-level node has been visited. */
  leave?: (n: GraphNode) => void;
}

/** Where the walk is: the tree being read and, inside a component, the placement that put it there. */
interface Frame {
  tree: NodeTree;
  /** The definition being walked; none for a page or shell tree. */
  def?: ComponentDefinition;
  scope: Scope;
  /** The id the placement gives the definition's root (`so_id`). */
  soId?: string;
  /** The placement's slot content, rendered where the definition places each slot, in the placement's frame. */
  slots?: { content: Record<string, string[]>; frame: Frame; owner: string };
  /** The page or shell node findings report against. */
  reportId?: string;
  /** Tells frames apart, so the same definition can render inside itself through slot content. */
  n: number;
  /** Definitions being expanded through definition trees on the way here: one that places itself stops. */
  defs: Set<string>;
}

/** Each property's effective value for a placement: its own (evaluated where it is placed) or the default. */
function effectiveProps(def: ComponentDefinition, n: GraphNode & { kind: 'instance' }, scope: Scope): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(def.properties)) props[name] = Object.hasOwn(n.props, name) ? evaluate(n.props[name], scope) : schema.default;
  return props;
}

/**
 * Walk what a page or shell tree renders, the way the generated components render it: page nodes, and inside
 * each managed component the nodes whose conditions hold (once per list item), its nested components with their
 * evaluated properties, and the placement's slot content where the definition places that slot. Callbacks
 * report against the page node (the outermost instance for anything inside a component).
 */
const SO_ID_ATTR = /\bid=\{\s*so_id\b/;

/** Mirrors the generator's render conditions inside a definition: a node's own conditions, a repeat's list, a collapsing element's children. */
function nodeRenders(state: ProjectState, frame: Frame, n: GraphNode, seen: Set<string>): boolean {
  if (n.when && !shown(evaluate(n.when, frame.scope), state)) return false;
  if (n.unless && shown(evaluate(n.unless, frame.scope), state)) return false;
  if (n.kind === 'repeat') return shown(evaluate(n.list, frame.scope), state);
  return n.kind !== 'element' || !n.collapseEmpty || childRenders(state, frame, n, seen);
}

/** A collapsing element renders while any child does; with no children it stays. */
function childRenders(state: ProjectState, frame: Frame, n: GraphNode & { kind: 'element' }, seen: Set<string>): boolean {
  if (seen.has(n.id)) return true;
  seen.add(n.id);
  const kids = n.children.map((id) => frame.tree.nodes[id]).filter((k): k is GraphNode => !!k);
  return !kids.length || kids.some((k) => nodeRenders(state, frame, k, seen));
}

function walkRendered(state: ProjectState, tree: NodeTree, visit: Visit) {
  let frames = 0;
  // A slot a definition renders once per list item shows the same content, in the same frame, each time: it is
  // walked once per frame, which keeps nested placements of such a component from multiplying the walk.
  const slotsWalked = new WeakMap<Frame, Set<string>>();
  const walk = (frame: Frame, id: string, path: Set<string>) => {
    const n = frame.tree.nodes[id];
    const key = `${frame.n}:${id}`;
    if (!n || path.has(key)) return;
    if (frame.def && n.when && !shown(evaluate(n.when, frame.scope), state)) return;
    if (frame.def && n.unless && shown(evaluate(n.unless, frame.scope), state)) return;
    if (frame.def && n.kind === 'element' && n.collapseEmpty && !childRenders(state, frame, n, new Set())) return;
    const inner = new Set(path).add(key);
    const reportId = frame.reportId ?? n.id;
    const page = !frame.def;
    if (page) visit.enter?.(n);
    // A definition's root takes the id its placement gives it first (`so_id ?? anchor`).
    const ownId = frame.def && frame.def.tree?.rootIds[0] === id ? (frame.soId ?? n.anchor) : n.anchor;
    switch (n.kind) {
      case 'link':
        visit.link?.(n, frame.scope, reportId);
        break;
      case 'image':
        visit.image?.(n, frame.scope, reportId);
        break;
      case 'text':
        visit.text?.(n, frame.scope, reportId);
        break;
      case 'element':
        for (const c of n.children) walk(frame, c, inner);
        break;
      case 'repeat': {
        if (!frame.def) break;
        const items = evaluate(n.list, frame.scope);
        const schema = isBinding(n.list) && '$prop' in n.list ? frame.def.properties[n.list.$prop] : undefined;
        const fields = schema?.type === 'list' ? schema.fields : undefined;
        for (const item of Array.isArray(items) ? items : []) for (const c of n.children) walk({ ...frame, scope: { ...frame.scope, item: item as Record<string, unknown>, fields } }, c, inner);
        break;
      }
      case 'slot': {
        const from = frame.slots;
        if (!from) break;
        const k = `${from.owner}:${n.slot}`;
        const walked = slotsWalked.get(from.frame) ?? new Set<string>();
        if (walked.has(k)) break;
        slotsWalked.set(from.frame, walked.add(k));
        for (const c of from.content[n.slot] ?? []) walk(from.frame, c, inner);
        break;
      }
      case 'instance': {
        const def = state.components[n.definitionId];
        if (!def || frame.defs.has(def.id)) break;
        const props = effectiveProps(def, n, frame.scope);
        if (def.kind === 'managed' && def.tree) {
          const trail = `${frame.scope.trail ?? ''}/${n.id}${frame.scope.item ? `[${String(frame.scope.item.id ?? '')}]` : ''}`;
          const child: Frame = { tree: def.tree, def, scope: { props, trail }, soId: ownId, slots: { content: n.slots ?? {}, frame, owner: n.id }, reportId, n: ++frames, defs: new Set(frame.defs).add(def.id) };
          for (const r of def.tree.rootIds) walk(child, r, inner);
        } else {
          visit.code?.(def, props, reportId, `${frame.scope.trail ?? ''}/${n.id}${frame.scope.item ? `[${String(frame.scope.item.id ?? '')}]` : ''}`);
          // Code that places `so_id` as an id (a converted section does, on its root) carries the placement's id.
          if (ownId && SO_ID_ATTR.test(def.source ?? '')) visit.id?.(ownId, reportId);
          // Code places its slot content where its own markup says; count all of it as rendered.
          for (const ids of Object.values(n.slots ?? {})) for (const c of ids) walk(frame, c, inner);
        }
        break;
      }
    }
    // An instance hands its id to the definition's root, which reports it there.
    if (ownId && n.kind !== 'instance' && n.kind !== 'repeat' && n.kind !== 'slot') visit.id?.(ownId, reportId);
    if (page) visit.leave?.(n);
  };
  const top: Frame = { tree, scope: { props: {} }, n: 0, defs: new Set() };
  for (const r of tree.rootIds) walk(top, r, new Set());
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

// ---------------------------------------------------------------------------
// Section links
// ---------------------------------------------------------------------------

/**
 * IDs every page has: the main landmark its layout renders (`<main id="main">`), and `top`, which browsers and the
 * static build both treat as the top of the page.
 */
const LAYOUT_IDS = ['main', 'top'];
const LITERAL_ID = /\sid\s*=\s*(?:"([^"{}\s]+)"|'([^'{}\s]+)')/g;
const codeIdCache = new WeakMap<ComponentDefinition, string[]>();

/** IDs a code component's markup writes out literally (`id="so-site-nav"`). IDs it computes cannot be known here. */
function literalIds(def: ComponentDefinition): string[] {
  let ids = codeIdCache.get(def);
  if (!ids) {
    ids = [...(def.source ?? '').matchAll(LITERAL_ID)].map((m) => m[1] ?? m[2]);
    codeIdCache.set(def, ids);
  }
  return ids;
}

/** Whether a page renders the shared header and footer. */
const hasShell = (page: PageDoc) => page.shell !== 'none';

/** The element IDs a tree renders. Code components add the IDs their markup writes out literally. */
function treeIds(state: ProjectState, trees: NodeTree[], out = new Set<string>()): Set<string> {
  const visit: Visit = { id: (id) => out.add(id), code: (def) => literalIds(def).forEach((id) => out.add(id)) };
  for (const tree of trees) walkRendered(state, tree, visit);
  return out;
}

/** How many elements render each ID on a page: an ID rendered twice cannot tell its sections apart. */
function idCounts(state: ProjectState, pageId: string): Map<string, number> {
  const out = new Map<string, number>();
  const page = state.pages[pageId];
  const visit: Visit = { id: (id) => out.set(id, (out.get(id) ?? 0) + 1) };
  if (page) for (const tree of hasShell(page) ? [state.site.shell.header, page, state.site.shell.footer] : [page]) walkRendered(state, tree, visit);
  return out;
}

/** The IDs the shared header and footer render, on every page that shows them. */
const shellIds = (state: ProjectState) => treeIds(state, [state.site.shell.header, state.site.shell.footer]);

/**
 * The element IDs a page's generated HTML will hold: its layout's, its own sections' and elements', and the shared
 * header and footer's when the page shows them. `shell` passes the header and footer's IDs when already known.
 */
export function pageIds(state: ProjectState, pageId: string, shell?: Set<string>): Set<string> {
  const out = new Set(LAYOUT_IDS);
  const page = state.pages[pageId];
  if (!page) return out;
  if (hasShell(page)) for (const id of shell ?? shellIds(state)) out.add(id);
  return treeIds(state, [page], out);
}

/** The IDs every page that shows the shared header and footer has: where their "on this page" links can go. */
export function sharedPageIds(state: ProjectState): Set<string> {
  const pages = state.site.pageOrder.map((id) => state.pages[id]).filter((p) => p && hasShell(p));
  const shell = shellIds(state);
  const sets = pages.map((p) => pageIds(state, p.id, shell));
  if (!sets.length) return new Set(LAYOUT_IDS);
  return new Set([...sets[0]].filter((id) => sets.every((x) => x.has(id))));
}

/** A link that renders, with what a person would call it. */
interface RenderedLink {
  link: LinkValue;
  label: string;
  reportId: string;
  /** Tells apart links of the same placement: its list item and field, or its position in rich text. */
  key: string;
  /** Inside rich text, where it is changed in the text itself rather than in a link field. */
  inText: boolean;
}

const isLinkValue = (v: unknown): v is LinkValue => !!v && typeof v === 'object' && typeof (v as LinkValue).type === 'string' && 'target' in (v as object);

/** The links in a rich text value, in order. */
function richLinks(value: unknown): RichSpan[] {
  const out: RichSpan[] = [];
  for (const b of toRichText(value)) for (const list of isListBlock(b) ? b.items : [b.spans]) for (const sp of list) if (sp.link) out.push(sp);
  return out;
}

/**
 * The property that names a link and decides whether it shows: `ctaLabel` for `ctaLink`, `linkLabel` for `link`.
 * Code reads it the way the generated components do, so a link whose label is empty does not render.
 */
const labelKeyFor = (key: string) => (key.endsWith('Link') ? `${key.slice(0, -4)}Label` : `${key}Label`);

/**
 * Links a code component receives: its link properties, the link fields of its lists, and the links in its rich
 * text (unless it reads rich text as plain paragraphs). Whether its markup shows each one is up to its code; a
 * link paired with a label property is taken to show only when the label does, as the shipped header does.
 */
function codeLinks(def: ComponentDefinition, props: Record<string, unknown>, reportId: string, placement: string, out: RenderedLink[]) {
  const rich = !takesParagraphs(def);
  const take = (schemas: Record<string, PropSchema>, values: Record<string, unknown>, key: string, fallback: string, at: string) => {
    const v = values[key];
    const schema = schemas[key];
    if (schema?.type === 'richtext' && rich) richLinks(v).forEach((sp, i) => out.push({ link: sp.link!, label: sp.text.trim(), reportId, key: `${at}:${i}`, inText: true }));
    if (schema?.type !== 'link' || !isLinkValue(v)) return;
    const labelKey = labelKeyFor(key);
    const paired = schemas[labelKey]?.type === 'string';
    if (paired && !values[labelKey]) return;
    const label = String((paired ? values[labelKey] : undefined) ?? fallback).trim();
    out.push({ link: v, label, reportId, key: at, inText: false });
  };
  for (const [key, schema] of Object.entries(def.properties)) {
    take(def.properties, props, key, schema.label, `${placement}:${key}`);
    if (schema.type !== 'list' || !Array.isArray(props[key])) continue;
    (props[key] as Array<Record<string, unknown>>).forEach((item, i) => {
      if (!item || typeof item !== 'object') return;
      const title = item[schema.titleField ?? 'label'];
      for (const [f, fs] of Object.entries(schema.fields)) take(schema.fields, item, f, typeof title === 'string' && title.trim() ? title : fs.label, `${placement}:${key}:${String(item.id ?? i)}:${f}`);
    });
  }
}

/** Every link a page or shell tree renders: buttons, links inside rich text, and the links code components receive. */
function renderedLinks(state: ProjectState, tree: NodeTree): RenderedLink[] {
  const out: RenderedLink[] = [];
  const at = (n: GraphNode, scope: Scope) => `${scope.trail ?? ''}:${n.id}:${String(scope.item?.id ?? '')}`;
  walkRendered(state, tree, {
    link: (n, scope, reportId) => {
      const link = evaluate(n.link, scope);
      if (isLinkValue(link)) out.push({ link, label: String(evaluate(n.label, scope) ?? '').trim(), reportId, key: at(n, scope), inText: false });
    },
    text: (n, scope, reportId) => {
      if (n.rich) richLinks(evaluate(n.text, scope)).forEach((sp, i) => out.push({ link: sp.link!, label: sp.text.trim(), reportId, key: `${at(n, scope)}:${i}`, inText: true }));
    },
    code: (def, props, reportId, placement) => codeLinks(def, props, reportId, placement, out)
  });
  return out;
}

/** A link the shared header or footer shows that goes to a page, with the words visitors see on it. */
export type ShellPageLink = { part: 'header' | 'footer'; nodeId: string; label: string; pageId: string; anchor?: string };

/**
 * The header and footer links visitors see that go to any of `pageIds`, in order: menu items, buttons, links in
 * text and the links components inside them render. `nodeId` is the header or footer element that holds each one.
 */
export function shellPageLinks(state: ProjectState, pageIds: string[]): ShellPageLink[] {
  const out: ShellPageLink[] = [];
  for (const part of ['header', 'footer'] as const) {
    for (const r of renderedLinks(state, state.site.shell[part])) {
      if (r.link.type !== 'page' || !pageIds.includes(r.link.target)) continue;
      out.push({ part, nodeId: r.reportId, label: r.label, pageId: r.link.target, ...(r.link.anchor ? { anchor: r.link.anchor } : {}) });
    }
  }
  return out;
}


export interface SectionLinkIssue {
  /** Where the link is: a page or the shared header or footer. */
  owner: { kind: 'page' | 'shell'; id: string };
  /** The page or shell node that holds it (the instance, for links inside a component). */
  nodeId: string;
  /** The link's text, when it has one. */
  label: string;
  /** A link inside rich text, changed in the text rather than in a link field. */
  inText: boolean;
  /** The section ID it jumps to. */
  fragment: string;
  /** The page it goes to, for a link to a section of another page. */
  pageId?: string;
  /** The pages it shows on that lack the section, for a link to a section of the page it is on. */
  pages?: string[];
}

/**
 * Links that jump to a section the destination page will not have: a page link's section, checked on that page,
 * and an "on this page" link, checked on every page that shows it. A static build refuses these links, and a
 * visitor who follows one lands at the top of the page instead of the section.
 */
export function missingSectionLinks(state: ProjectState): SectionLinkIssue[] {
  const pages = state.site.pageOrder.map((id) => state.pages[id]).filter(Boolean);
  const shellPages = pages.filter(hasShell);
  const shell = shellPages.length ? shellIds(state) : new Set<string>();
  const ids = new Map<string, Set<string>>();
  const idsOf = (pageId: string) => {
    if (!ids.has(pageId)) ids.set(pageId, pageIds(state, pageId, shell));
    return ids.get(pageId)!;
  };
  const sources: Array<{ owner: SectionLinkIssue['owner']; tree: NodeTree; on: PageDoc[] }> = [
    ...(shellPages.length
      ? [
          { owner: { kind: 'shell' as const, id: 'header' }, tree: state.site.shell.header, on: shellPages },
          { owner: { kind: 'shell' as const, id: 'footer' }, tree: state.site.shell.footer, on: shellPages }
        ]
      : []),
    ...pages.map((p) => ({ owner: { kind: 'page' as const, id: p.id }, tree: p as NodeTree, on: [p] }))
  ];
  const out: SectionLinkIssue[] = [];
  const seen = new Set<string>();
  for (const src of sources)
    for (const { link, label, reportId, key, inText } of renderedLinks(state, src.tree)) {
      let issue: SectionLinkIssue | null = null;
      if (link.type === 'page' && link.anchor && Object.hasOwn(state.pages, link.target)) {
        if (!idsOf(link.target).has(link.anchor)) issue = { owner: src.owner, nodeId: reportId, label, inText, fragment: link.anchor, pageId: link.target };
      } else if (link.type === 'anchor' && link.target) {
        const fragment = link.target.replace(/^#/, '');
        const missing = src.on.filter((p) => !idsOf(p.id).has(fragment)).map((p) => p.id);
        if (missing.length) issue = { owner: src.owner, nodeId: reportId, label, inText, fragment, pages: missing };
      }
      // A link the walk reaches twice (a repeated slot, say) is reported once.
      const id = JSON.stringify([src.owner, reportId, key]);
      if (!issue || seen.has(id)) continue;
      seen.add(id);
      out.push(issue);
    }
  return out;
}

export interface PageSection {
  /** The page node that is the section (a placed section, a section element or a heading). */
  nodeId: string;
  /** Its visible heading, or a name for it when it has none. */
  label: string;
  /** The ID it already has. Sections without one get one when a link first chooses them. */
  anchor?: string;
  /** Inside another listed section. */
  nested: boolean;
}

const HEADING = /^h[1-6]$/;

/**
 * The ID a page node renders with: its own anchor, or for a placed section without one, the anchor its component's
 * root carries (`so_id ?? anchor`, through components whose root is another component).
 */
function renderedAnchor(state: ProjectState, n: GraphNode, depth = 0): string | undefined {
  if (n.anchor) return n.anchor;
  if (n.kind !== 'instance' || depth > 10) return undefined;
  const def = state.components[n.definitionId];
  const root = def?.kind === 'managed' ? def.tree?.nodes[def.tree.rootIds[0]] : undefined;
  return root ? renderedAnchor(state, root, depth + 1) : undefined;
}

/** A name for a section without a visible heading: its `heading` property, its layer name or its component's. */
function sectionName(state: ProjectState, n: GraphNode): string {
  const def = n.kind === 'instance' ? state.components[n.definitionId] : undefined;
  const heading = def && n.kind === 'instance' ? effectiveProps(def, n, { props: {} }).heading : undefined;
  if (typeof heading === 'string' && heading.trim()) return heading.replace(/\s+/g, ' ').trim();
  return n.name ?? def?.name ?? 'Section';
}

function headingText(n: GraphNode & { kind: 'text' }, scope: Scope): string {
  const v = evaluate(n.text, scope);
  const text = typeof v === 'string' ? v : Array.isArray(v) ? richTextToPlain(toRichText(v)) : '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The sections a link can jump to on a page, in page order, each named by the first heading it shows: placed
 * sections (nested ones too), section elements, headings that stand on their own, and anything with an ID.
 * A wrapper whose only heading belongs to a section inside it is left out; the inner section stands for it.
 */
export function pageSections(state: ProjectState, pageId: string): PageSection[] {
  const page = state.pages[pageId];
  if (!page) return [];
  const isSection = (n: GraphNode) =>
    !!renderedAnchor(state, n) || (n.kind === 'instance' && anchorCapable(state, state.components[n.definitionId])) || (n.kind === 'element' && n.tag === 'section');
  interface Open {
    node: GraphNode;
    label: string;
    children: number;
    index: number;
  }
  const list: Array<PageSection & { keep: boolean; parent?: number }> = [];
  const open: Open[] = [];
  const used = new Set<string>();
  const counts = idCounts(state, pageId);
  /**
   * A section's ID. One it only inherits from its component is not its own when other elements render it too: a
   * link to it would go to whichever comes first, and moving the sections would change which one that is.
   */
  const idOf = (n: GraphNode) => {
    const id = renderedAnchor(state, n);
    if (!id || (!n.anchor && (used.has(id) || (counts.get(id) ?? 0) > 1))) return undefined;
    used.add(id);
    return id;
  };
  walkRendered(state, page, {
    enter: (n) => {
      if (isSection(n)) {
        const parent = open[open.length - 1];
        if (parent) parent.children++;
        open.push({ node: n, label: '', children: 0, index: list.length });
        list.push({ nodeId: n.id, label: '', anchor: idOf(n), nested: false, keep: true, parent: parent?.index });
      } else if (n.kind === 'text' && HEADING.test(n.tag) && !open.length) {
        const label = headingText(n, { props: {} });
        if (label) list.push({ nodeId: n.id, label, anchor: idOf(n), nested: false, keep: true });
      }
    },
    text: (n, scope) => {
      const top = open[open.length - 1];
      if (!top || top.label || !HEADING.test(n.tag)) return;
      // A heading inside a nested section names that section, not the one around it.
      if (top.children) return;
      top.label = headingText(n, scope);
    },
    leave: (n) => {
      const top = open[open.length - 1];
      if (top?.node !== n) return;
      open.pop();
      const entry = list[top.index];
      entry.label = top.label;
      if (!top.label) {
        if (top.children && !entry.anchor) entry.keep = false;
        else entry.label = sectionName(state, n);
      }
    }
  });
  // Nested means inside a section that is still listed.
  const listedAbove = (e: (typeof list)[number]): boolean => e.parent !== undefined && (list[e.parent].keep || listedAbove(list[e.parent]));
  return list.filter((e) => e.keep).map((e) => ({ nodeId: e.nodeId, label: e.label, anchor: e.anchor, nested: listedAbove(e) }));
}

/** A new section ID made from a heading ("Get in touch" → "get-in-touch"), numbered when the page already has it. */
export function sectionAnchorFor(label: string, taken: Set<string>): string {
  const base = slugify(label).replace(/^[^a-z]+/, '').slice(0, 54).replace(/-+$/, '') || 'section';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * What choosing a section in a link picker does: reuse the ID the section already has, or give it one made from
 * its heading. The edit that gives it one goes in the same batch as the link change, so they save and undo together.
 */
export function planSectionPick(state: ProjectState, pageId: string, nodeId: string): { anchor: string; operations: EditOperation[] } | null {
  const node = state.pages[pageId]?.nodes[nodeId];
  if (!node) return null;
  const section = pageSections(state, pageId).find((x) => x.nodeId === nodeId);
  if (!section) return node.anchor ? { anchor: node.anchor, operations: [] } : null;
  // An ID the section already renders with is reused, never replaced: other links may jump to it.
  if (section.anchor) return { anchor: section.anchor, operations: [] };
  const owner = { kind: 'page' as const, id: pageId };
  const anchor = sectionAnchorFor(section.label, new Set([...anchorsInUse(state, owner), ...pageIds(state, pageId)]));
  return { anchor, operations: [{ type: 'node.setContent', owner, nodeId, field: 'anchor', value: anchor }] };
}

