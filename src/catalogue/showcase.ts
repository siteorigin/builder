/**
 * The Component showcase starter (#1020): a site holding every component the theme ships, each with its defaults, so
 * all of them can be clicked, edited, switched, previewed and exported in one place. Home places a few of the strongest
 * sections; then one page per kind of component (heroes, features, content and so on) places every component of that
 * kind once, and the shared header and footer link them all. Everything is read from the theme's own list, so a
 * component a theme adds lands on a page of its kind without a change here. The one thing not left at its default is a
 * button with no destination, which goes to one of these pages.
 */
import type { ComponentDefinition, GraphNode, ImageValue, InstanceNode, ListItem, PageDoc, ProjectState, PropSchema } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { POSTS_COLLECTION_ID } from '@shared/collections';
import { pickImagesField } from '@shared/image-lists';
import { newId } from '@shared/ids';
import { installComponent, makeInstance } from '@engine/install';
import { collectionCreate, entryCreate } from '@engine/collections';
import { shownOnceSlots, slotDecl, takesComponent } from '@engine/slots';
import { labelKeyFor } from '@generator/checks';
import { stateActionWorks } from '@generator/index';
import { isEmptyPropValue } from '@shared/required';
import { getTheme } from './index';
import type { StarterAsset } from './starters';

export type ShowcaseKind = 'heroes' | 'features' | 'content' | 'media' | 'proof' | 'pricing' | 'contact' | 'blog' | 'blocks';

/** The kind pages in the order the site lists them, each with its title and address. */
export const SHOWCASE_KINDS: ReadonlyArray<{ kind: ShowcaseKind; title: string; route: string }> = [
  { kind: 'heroes', title: 'Heroes', route: '/heroes/' },
  { kind: 'features', title: 'Features', route: '/features/' },
  { kind: 'content', title: 'Content', route: '/content/' },
  { kind: 'media', title: 'Media', route: '/media/' },
  { kind: 'proof', title: 'Proof', route: '/proof/' },
  { kind: 'pricing', title: 'Pricing', route: '/pricing/' },
  { kind: 'contact', title: 'Contact', route: '/contact/' },
  { kind: 'blog', title: 'Blog', route: '/blog/' },
  { kind: 'blocks', title: 'Blocks', route: '/blocks/' }
];

/** Home's sections, by kind: the one named when the theme ships it, else the first of that kind. */
const HOME: ReadonlyArray<[ShowcaseKind, string]> = [
  ['heroes', 'hero.split'],
  ['features', 'features.grid'],
  ['content', 'content.media'],
  ['proof', 'testimonials.grid'],
  ['contact', 'cta.banner']
];

/** Where the sample posts' own pages live: the Blog page holds `/blog/`, the address a "posts" collection takes by default. */
const POSTS_ROUTE = '/posts/';

const SAMPLE_POSTS = [
  { title: 'Notes from the studio', excerpt: 'A closer look at the materials and small details that shape our work.', publishedAt: '2025-06-12' },
  { title: 'A season of new projects', excerpt: 'What we are building this year, and the people we are building it with.', publishedAt: '2025-05-28' },
  { title: 'How we plan a first visit', excerpt: 'The questions we ask before anything is drawn, and why they matter.', publishedAt: '2025-05-09' }
];

/** The dated pages a news list shows: news lists leave out the page they are on, so these are pages of their own. */
const SAMPLE_NEWS = [
  { title: 'The studio moves to Harbor Lane', route: '/news/harbor-lane/', date: '2025-06-02', excerpt: 'A bigger room, more light and a proper materials library.' },
  { title: 'Open studio weekend', route: '/news/open-studio/', date: '2025-04-18', excerpt: 'Come and see the work in progress, and bring your questions.' }
];

const hasFeed = (def: ComponentDefinition, feed?: string) => Object.values(def.properties).some((p) => p.type === 'list' && !!p.feed && (feed === undefined || p.feed === feed));

/** The page of the showcase a theme component goes on, or null for the shared header and footer. */
export function showcaseKind(def: ComponentDefinition): ShowcaseKind | null {
  const id = def.componentId;
  const tags = new Set(def.tags);
  if (def.category === 'shell') return null;
  // Blocks, and the layouts that hold them.
  if (def.insertAs === 'element') return 'blocks';
  if (def.category === 'layout' && Object.keys(def.slots ?? {}).length) return 'blocks';
  // Sections that list the site's posts or articles, or read their own page as one.
  if (id.startsWith('blog.') || hasFeed(def)) return 'blog';
  if (id.startsWith('pricing.') || tags.has('pricing')) return 'pricing';
  if (id.startsWith('features.') || tags.has('features') || tags.has('steps')) return 'features';
  if (def.category === 'hero') return 'heroes';
  if (def.category === 'media') return 'media';
  if (def.category === 'social-proof') return 'proof';
  if (def.category === 'conversion') return 'contact';
  return 'content';
}

/** The theme's components on each kind page, in the theme's order; a kind with none has no page. */
export function showcasePages(themeId: string): Array<{ kind: ShowcaseKind; title: string; route: string; components: ComponentDefinition[] }> {
  const theme = getTheme(themeId);
  return SHOWCASE_KINDS.map((k) => ({ ...k, components: theme.components.filter((c) => showcaseKind(c) === k.kind) })).filter((p) => p.components.length);
}

/** Home's sections: the component IDs it places, in order. */
export function showcaseHome(themeId: string): string[] {
  const pages = showcasePages(themeId);
  const out: string[] = [];
  for (const [kind, preferred] of HOME) {
    const sections = pages.find((p) => p.kind === kind)?.components.filter((c) => c.insertAs !== 'element') ?? [];
    const pick = sections.find((c) => c.componentId === preferred) ?? sections[0];
    if (pick) out.push(pick.componentId);
  }
  // A theme with none of those kinds still opens on a section of its own.
  const first = pages.flatMap((p) => p.components).find((c) => c.insertAs !== 'element' && !c.slots);
  if (!out.length && first) out.push(first.componentId);
  return out;
}

/**
 * The link fields a design gives to buttons that work the component itself (opening a panel, say), by the field's own
 * name. Such a button needs no destination, and one would turn it into a link away from the page.
 */
function controlLinks(def: ComponentDefinition): Set<string> {
  const out = new Set<string>();
  for (const n of Object.values(def.tree?.nodes ?? {})) {
    if (n.kind !== 'link' || !stateActionWorks(def, n.stateAction, n.id)) continue;
    if ('$item' in n.link) out.add(n.link.$item);
    else if ('$prop' in n.link) out.add(n.link.field ?? n.link.$prop);
  }
  return out;
}

/**
 * Puts sample photos in a placement's empty images, gives an empty gallery, carousel or page list a few rows, and
 * gives each button with words but no destination one of the showcase's pages: the site leaves such a button out.
 */
class Filler {
  private room = 0;
  private person = 0;
  /** The definition of the placement being filled. */
  private def: ComponentDefinition | null = null;
  /** Where an unfinished button on the placement being filled goes. */
  private destination = '';
  constructor(
    private readonly photos: { rooms: StarterAsset[]; people: StarterAsset[] } | null,
    private readonly pageIds: string[],
    /** The pages a button may go to, the most fitting first. */
    private readonly destinations: string[]
  ) {}

  private photo(field: string): ImageValue | null {
    if (!this.photos) return null;
    // A logo is a brand's own mark: a room photo in its place shows nothing a visitor would expect.
    if (/logo/i.test(field)) return null;
    const people = /portrait|avatar/i.test(field) && this.photos.people.length;
    const list = people ? this.photos.people : this.photos.rooms;
    if (!list.length) return null;
    const a = list[(people ? this.person++ : this.room++) % list.length];
    return { assetId: a.id, alt: a.alt };
  }

  private value(field: string, schema: PropSchema, v: unknown): unknown {
    if (schema.type === 'image') {
      const img = v as ImageValue | undefined;
      if (img && typeof img === 'object' && img.assetId) return v;
      const photo = this.photo(field);
      return photo ? { ...(img && typeof img === 'object' ? img : {}), ...photo } : v;
    }
    if (schema.type === 'object' && v && typeof v === 'object') return this.fields(schema.fields, v as Record<string, unknown>);
    if (schema.type === 'list' && !schema.feed) return this.list(field, schema, Array.isArray(v) ? (v as ListItem[]) : []);
    return v;
  }

  private fields(schema: Record<string, PropSchema>, values: Record<string, unknown>): Record<string, unknown> {
    const out = { ...values };
    for (const [k, s] of Object.entries(schema)) {
      if (Object.hasOwn(out, k)) out[k] = this.value(k, s, out[k]);
      // An image a row leaves to its field's default still gets a photo.
      else if (s.type === 'image' && this.photos) {
        const filled = this.value(k, s, structuredClone(s.default));
        if (filled !== s.default && (filled as ImageValue | undefined)?.assetId) out[k] = filled;
      }
    }
    for (const [k, s] of Object.entries(schema)) if (s.type === 'link') this.link(schema, out, k, s);
    return out;
  }

  /** A link whose paired label has words is a button visitors are meant to see: with nowhere to go, it gets a page. */
  private link(schema: Record<string, PropSchema>, out: Record<string, unknown>, key: string, s: PropSchema) {
    if (this.def && controlLinks(this.def).has(key)) return;
    const labelKey = labelKeyFor(key);
    const label = Object.hasOwn(schema, labelKey) ? schema[labelKey] : undefined;
    if (label?.type !== 'string') return;
    const words = Object.hasOwn(out, labelKey) ? out[labelKey] : label.default;
    if (typeof words !== 'string' || !words.trim() || !isEmptyPropValue(s, Object.hasOwn(out, key) ? out[key] : s.default)) return;
    out[key] = { type: 'page', target: this.destination };
  }

  private row(schema: Extract<PropSchema, { type: 'list' }>, values: Record<string, unknown>): ListItem {
    const item: ListItem = { id: newId('i') };
    for (const [k, s] of Object.entries(schema.fields)) item[k] = structuredClone(s.default);
    return { ...item, ...values };
  }

  private list(field: string, schema: Extract<PropSchema, { type: 'list' }>, items: ListItem[]): ListItem[] {
    let rows = items;
    const room = schema.max ?? Infinity;
    if (!rows.length && schema.pageTeaser) {
      // A list of the site's pages: a card for each of the first kind pages, its title left to follow the page's own.
      const t = schema.pageTeaser;
      rows = this.pageIds.slice(0, Math.min(3, room)).map((id) => this.row(schema, { [t.link]: { type: 'page', target: id } }));
    } else if (!rows.length && this.photos && this.def && pickImagesField(this.def, field, schema)) {
      rows = Array.from({ length: Math.min(3, room) }, () => this.row(schema, {}));
    }
    return rows.map((it) => ({ ...this.fields(schema.fields, it), id: it.id }));
  }

  fill(def: ComponentDefinition, node: InstanceNode, pageId: string): InstanceNode {
    this.def = def;
    // Never the page the button is on, while there is another.
    this.destination = this.destinations.find((id) => id !== pageId) ?? pageId;
    node.props = this.fields(def.properties, node.props);
    this.def = null;
    return node;
  }
}

export interface ShowcaseSite {
  homeNodes: GraphNode[];
  pages: PageDoc[];
  /** The pages the shared header and footer link, Home first. */
  nav: Array<{ label: string; pageId: string }>;
}

function sitePage(id: string, title: string, route: string, nodes: GraphNode[], rootIds: string[], extra: Partial<PageDoc> = {}): PageDoc {
  const map: Record<string, GraphNode> = {};
  for (const n of nodes) map[n.id] = n;
  return { schemaVersion: SCHEMA_VERSION, id, title, route, seo: {}, showHeader: true, showFooter: true, rootIds, nodes: map, ...extra };
}

/**
 * Fills a new project's `state` (its theme already set, nothing placed yet) with the showcase's pages, sample posts
 * and articles. Home's page is `homeId`; the caller builds the shared header and footer from `nav`.
 */
export function buildShowcase(state: ProjectState, homeId: string, photos: StarterAsset[] | null): ShowcaseSite {
  const themeId = state.site.themeId;
  const kinds = showcasePages(themeId);
  const ids = new Map(kinds.map((k) => [k.kind, newId('pg')]));
  const people = photos?.filter((a) => /^Portrait/.test(a.name)) ?? [];
  // Buttons ask a visitor to get in touch, so they go to Contact first, then Pricing, then any other page.
  const preferred = (['contact', 'pricing'] as const).flatMap((k) => ids.get(k) ?? []);
  const destinations = [...new Set([...preferred, ...ids.values(), homeId])];
  const filler = new Filler(photos ? { rooms: photos.filter((a) => !people.includes(a)), people } : null, [...ids.values()], destinations);
  const placeOn = (pageId: string) => (componentId: string): InstanceNode => {
    const def = state.components[installComponent(state, componentId)];
    return filler.fill(def, makeInstance(def), pageId);
  };

  const homeNodes = showcaseHome(themeId).map(placeOn(homeId));
  const pages: PageDoc[] = [];
  for (const k of kinds) {
    const id = ids.get(k.kind)!;
    const place = placeOn(id);
    if (k.kind !== 'blocks') {
      const nodes = k.components.map((c) => place(c.componentId));
      // The Article header reads the page it is on as an article: this one, kept out of news lists.
      const article = k.components.some((c) => hasFeed(c, 'currentPage')) ? { article: { date: SAMPLE_POSTS[0].publishedAt, byline: 'By the studio team', excerpt: SAMPLE_POSTS[0].excerpt, hidden: true } } : {};
      pages.push(sitePage(id, k.title, k.route, nodes, nodes.map((n) => n.id), article));
      continue;
    }
    pages.push(blocksPage(state, id, k, place));
  }

  // Entry feeds list a collection's published posts: a few sample ones, at an address of their own.
  if (kinds.some((k) => k.components.some((c) => hasFeed(c, 'entries'))) && !Object.hasOwn(state.collections, POSTS_COLLECTION_ID)) {
    collectionCreate(state, { type: 'collection.create', collectionId: POSTS_COLLECTION_ID, route: POSTS_ROUTE });
    for (const post of SAMPLE_POSTS) entryCreate(state, { type: 'entry.create', collectionId: POSTS_COLLECTION_ID, ...post, author: 'Studio team', draft: false });
  }
  // News lists show the site's dated pages other than their own.
  const news: PageDoc[] = kinds.some((k) => k.components.some((c) => hasFeed(c, 'articles')))
    ? SAMPLE_NEWS.map((n) => sitePage(newId('pg'), n.title, n.route, [], [], { article: { date: n.date, byline: 'Studio team', excerpt: n.excerpt } }))
    : [];

  return {
    homeNodes,
    pages: [...pages, ...news],
    nav: [{ label: 'Home', pageId: homeId }, ...kinds.map((k) => ({ label: k.title, pageId: ids.get(k.kind)! }))]
  };
}

/**
 * The Blocks page: each layout that takes content placed once, and every block inside one of them, shared out in turn
 * between the slots that take it and have room. A block no slot takes goes in a plain section of its own, so none is
 * left out and no layout is placed twice.
 */
function blocksPage(state: ProjectState, id: string, k: { title: string; route: string; components: ComponentDefinition[] }, place: (componentId: string) => InstanceNode): PageDoc {
  const nodes: GraphNode[] = [];
  const roots: string[] = [];
  const hosts: Array<{ node: InstanceNode; slot: string }> = [];
  for (const c of k.components.filter((c) => c.insertAs !== 'element')) {
    const node = place(c.componentId);
    nodes.push(node);
    roots.push(node.id);
    for (const slot of shownOnceSlots(state, node.definitionId)) hosts.push({ node, slot });
  }
  const leftover: string[] = [];
  let turn = 0;
  for (const c of k.components.filter((c) => c.insertAs === 'element')) {
    const block = place(c.componentId);
    const def = state.components[block.definitionId];
    nodes.push(block);
    const open = hosts.filter(({ node, slot }) => {
      const decl = slotDecl(state, node, slot);
      return !!decl && takesComponent(decl, def) && (node.slots?.[slot]?.length ?? 0) < (decl.max ?? Infinity);
    });
    if (!open.length) {
      leftover.push(block.id);
      continue;
    }
    const at = open[turn++ % open.length];
    at.node.slots = { ...at.node.slots, [at.slot]: [...(at.node.slots?.[at.slot] ?? []), block.id] };
  }
  if (leftover.length) {
    const section: GraphNode = { id: newId('n'), kind: 'element', tag: 'section', children: leftover };
    nodes.push(section);
    roots.push(section.id);
  }
  return sitePage(id, k.title, k.route, nodes, roots);
}
