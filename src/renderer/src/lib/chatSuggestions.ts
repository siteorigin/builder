import type { AssetRecord, ElementRef, ImageValue, NodeTree, PageDoc, ProjectState, PropSchema } from '@shared/types';
import { isBinding } from '@shared/types';
import { isRichBlock, richTextToPlain } from '@shared/richtext';
import { childLists, headerMenu } from '@engine/tree';
import { refLabel, resolveRef } from './model';

/**
 * The starters offered in an empty AI conversation. Each is chosen from what the project holds right now (the page
 * being edited, the selection, the pages that exist, the images available), so none names a page, an image or an
 * element that is not there. The text is both what the button says and what goes into the composer, so a starter
 * keeps its target, and its page, once it is edited, sent or restored from a draft.
 */
export type SuggestionKind = 'page' | 'cross-page' | 'create-page' | 'selection' | 'site';

export interface ChatSuggestion {
  kind: SuggestionKind;
  text: string;
}

export interface SuggestionInput {
  state: ProjectState;
  /** How many places use each asset, project-wide (the snapshot's `assetUsage`). */
  assetUsage: Record<string, number>;
  /** The page being viewed. */
  pageId: string | null;
  selection: ElementRef | null;
  /** What the next message is scoped to; the same switches the message is sent with. */
  context: { page: boolean; selection: boolean };
}

/** A page with this little of its own copy is mostly empty: a title and a line or two. */
const SPARSE_UNITS = 3;
const SPARSE_CHARS = 200;

const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

/** A title as a prompt names it: one line, curly-quoted, with no quote of its own to end it early. */
function quoted(text: string): string {
  const one = text.replace(/\s+/g, ' ').replace(/["“”]/g, "'").trim();
  return `“${one.length > 60 ? `${one.slice(0, 59).trimEnd()}…` : one}”`;
}

/** How a page is named in a prompt: by its title, with its address when another page has the same title. */
function pageName(state: ProjectState, page: PageDoc): string {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  const twin = Object.values(state.pages).some((p) => p.id !== page.id && norm(p.title) === norm(page.title));
  return twin ? `${quoted(page.title)} (${page.route})` : quoted(page.title);
}

// ---------------------------------------------------------------------------
// What a page, or part of one, holds
// ---------------------------------------------------------------------------

interface ImageSlot {
  /** The placed image, or null for an image field that has none (or one that no longer exists). */
  asset: AssetRecord | null;
  alt: string;
  decorative: boolean;
}

interface Content {
  /** Pieces of copy: a text, a button label, a string or rich text property, a list item's field. */
  units: number;
  chars: number;
  images: ImageSlot[];
}

function plainOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length && v.every(isRichBlock)) return richTextToPlain(v);
  return '';
}

function slotOf(state: ProjectState, v: unknown): ImageSlot | null {
  if (!v || typeof v !== 'object' || isBinding(v)) return null;
  const image = v as Partial<ImageValue>;
  const asset = typeof image.assetId === 'string' ? own(state.assets.assets, image.assetId) : undefined;
  return { asset: asset?.kind === 'image' ? asset : null, alt: typeof image.alt === 'string' ? image.alt : '', decorative: image.decorative === true };
}

/** What the nodes under these IDs hold. Bound values count as copy: they are read from the component's own properties. */
function contentOf(state: ProjectState, tree: NodeTree, rootIds: string[]): Content {
  const out: Content = { units: 0, chars: 0, images: [] };
  const seen = new Set<string>();
  const copy = (v: unknown) => {
    if (isBinding(v)) {
      out.units++;
      return;
    }
    const text = plainOf(v).trim();
    if (text) {
      out.units++;
      out.chars += text.length;
    }
  };
  const field = (schema: PropSchema, v: unknown) => {
    if (schema.type === 'string' || schema.type === 'richtext') copy(v);
    else if (schema.type === 'image') {
      const slot = slotOf(state, v);
      if (slot) out.images.push(slot);
    } else if (schema.type === 'list' && Array.isArray(v)) {
      for (const item of v) if (item && typeof item === 'object') for (const [k, f] of Object.entries(schema.fields)) field(f, (item as Record<string, unknown>)[k]);
    }
  };
  const visit = (id: string) => {
    const n = own(tree.nodes, id);
    if (!n || seen.has(id)) return;
    seen.add(id);
    if (n.kind === 'text') copy(n.text);
    else if (n.kind === 'link') copy(n.label);
    else if (n.kind === 'image') {
      const slot = slotOf(state, n.image);
      if (slot) out.images.push(slot);
    } else if (n.kind === 'instance') {
      // The properties as the page shows them: what is set, else the component's own default.
      const def = own(state.components, n.definitionId);
      for (const [key, schema] of Object.entries(def?.properties ?? {})) field(schema, Object.hasOwn(n.props, key) ? n.props[key] : schema.default);
    }
    for (const list of childLists(n)) list.ids.forEach(visit);
  };
  rootIds.forEach(visit);
  return out;
}

const pageContent = (state: ProjectState, page: PageDoc): Content => contentOf(state, page, page.rootIds);
const isSparse = (c: Content) => c.units <= SPARSE_UNITS && c.chars < SPARSE_CHARS;

const imageAssets = (state: ProjectState) => Object.values(state.assets.assets).filter((a) => a.kind === 'image');
/** Newest first; the ID breaks a tie so the same project always offers the same image. */
const newestFirst = (a: AssetRecord, b: AssetRecord) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

// ---------------------------------------------------------------------------
// Starters for the page being edited, and the pages around it
// ---------------------------------------------------------------------------

/** The one starter about the page's pictures: the first of an image to describe, an empty image to fill, a new image to place. */
function imageStarter(state: ProjectState, usage: Record<string, number>, page: PageDoc, content: Content): string | null {
  const on = pageName(state, page);
  const undescribed = content.images.find((s) => s.asset && !s.decorative && !s.alt.trim());
  if (undescribed?.asset) return `Write alt text for the ${quoted(undescribed.asset.name)} image on the ${on} page`;
  const library = imageAssets(state).sort(newestFirst);
  const unused = library.filter((a) => !(usage[a.id] > 0));
  if (content.images.some((s) => !s.asset)) {
    const pick = unused[0] ?? library[0];
    return pick ? `Place the ${quoted(pick.name)} image in the empty image on the ${on} page` : `Suggest what kind of photo suits the empty image on the ${on} page`;
  }
  if (unused[0]) return `Place the ${quoted(unused[0].name)} image on the ${on} page, where it fits best`;
  const placed = content.images.flatMap((s) => (s.asset && !s.decorative ? [s.asset] : [])).sort(newestFirst)[0];
  return placed ? `Improve how the ${quoted(placed.name)} image looks and reads on the ${on} page` : null;
}

/** The one starter about the page's own copy. */
function contentStarter(state: ProjectState, page: PageDoc, content: Content): string {
  const on = pageName(state, page);
  if (!page.rootIds.length) return `Start the ${on} page: add an introduction and the sections it needs`;
  if (isSparse(content)) return `Build out the ${on} page: it is mostly empty, so add the sections and content it needs`;
  return `Rewrite the opening of the ${on} page to sound warmer and more confident`;
}

/** What to do on a page that is not the one being edited, marked as such so it cannot be taken for the open page. */
function otherPageStarter(state: ProjectState, page: PageDoc): string {
  const on = pageName(state, page);
  if (!page.rootIds.length) return `On another page, ${on}: add an introduction and the sections it needs`;
  if (isSparse(pageContent(state, page))) return `On another page, ${on}: build out its content, it is mostly empty`;
  return `On another page, ${on}: rewrite the opening section to sound warmer and more confident`;
}

// ---------------------------------------------------------------------------
// Pages that are missing
// ---------------------------------------------------------------------------

/** The pages a small site usually wants, in the order they are offered, with the names such a page goes by. */
const DESTINATIONS: Array<{ name: string; about: string; aliases: string[] }> = [
  { name: 'Contact', about: 'a short note, how to get in touch and a simple way to send a message', aliases: ['contact', 'contact us', 'get in touch', 'reach us', 'enquiries', 'enquiry', 'inquiry', 'inquiries', 'お問い合わせ', 'お問合せ', 'お問合わせ', '問い合わせ', 'コンタクト', 'contacto', 'kontakt', 'contatto', 'contato', 'contactez nous', '联系我们', '문의'] },
  { name: 'About', about: 'who is behind the site, what it stands for and a call to action', aliases: ['about', 'about us', 'our story', 'who we are', 'about me', '会社概要', '私たちについて', '概要', '会社情報', 'acerca de', 'sobre nosotros', 'sobre', 'uber uns', 'über uns', 'a propos', 'à propos', '关于我们', '소개'] },
  { name: 'Services', about: 'three or four services as cards, each with a short description', aliases: ['services', 'service', 'what we do', 'our services', 'offerings', 'サービス', '事業内容', 'servicios', 'dienstleistungen', 'leistungen', '服务', '서비스'] },
  { name: 'FAQ', about: 'the questions people ask most, with short answers', aliases: ['faq', 'faqs', 'questions', 'frequently asked questions', 'よくある質問', 'preguntas frecuentes', 'häufige fragen', '常见问题'] }
];

const isCjk = (s: string) => /[　-鿿가-힯＀-￯]/.test(s);
/** Lower case, with every run of punctuation and symbols read as a space. */
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Whether a name (a title, a menu label, an address segment) is one of the names a destination goes by. */
function goesBy(name: string, aliases: string[]): boolean {
  const w = words(name);
  if (!w) return false;
  return aliases.some((a) => {
    const alias = words(a);
    return isCjk(alias) ? w.includes(alias) : ` ${w} `.includes(` ${alias} `);
  });
}

/** Every name a live page answers to: its title, menu label, address, and the old addresses that lead to it. */
function namesOf(state: ProjectState, page: PageDoc): string[] {
  const old = (state.site.redirects ?? []).filter((r) => r.pageId === page.id).map((r) => r.from);
  return [page.title, page.navLabel ?? '', ...[page.route, ...old].flatMap((r) => decodeSegments(r))];
}

function decodeSegments(route: string): string[] {
  return route.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

/** Whether the shared header's menu has room for one more link. */
function menuHasRoom(state: ProjectState): boolean {
  const menu = headerMenu(state);
  if (!menu) return false;
  const links = menu.node.props.links;
  const count = Array.isArray(links) ? links.length : Array.isArray(menu.schema.default) ? menu.schema.default.length : 0;
  return menu.schema.max === undefined || count < menu.schema.max;
}

/** The first page this site is missing, as an explicit request to create it. A page that goes by the name already (in any title, menu label or address) is never asked for again. */
function createPageStarter(state: ProjectState): string | null {
  const pages = state.site.pageOrder.map((id) => own(state.pages, id)).filter((p): p is PageDoc => !!p);
  const missing = DESTINATIONS.find((d) => !pages.some((p) => namesOf(state, p).some((n) => goesBy(n, d.aliases))));
  if (!missing) return null;
  return `Create a new ${missing.name} page with ${missing.about}${menuHasRoom(state) ? ', and link it from the header menu' : ''}`;
}

// ---------------------------------------------------------------------------
// Starters for a selection
// ---------------------------------------------------------------------------

/** A value a node takes from its component's properties, read where it is placed; unknown for a repeated item's field. */
function resolved<T>(r: ReturnType<typeof resolveRef>, v: T | { $prop: string } | { $item: string }): { known: true; value: T } | { known: false } {
  if (!isBinding(v)) return { known: true, value: v as T };
  if (!('$prop' in v) || !r.instance || !r.def) return { known: false };
  const schema = own(r.def.properties, v.$prop);
  return { known: true, value: (Object.hasOwn(r.instance.props, v.$prop) ? r.instance.props[v.$prop] : schema?.default) as T };
}

function selectionStarters(input: SuggestionInput, ref: ElementRef): ChatSuggestion[] | null {
  const { state } = input;
  let r: ReturnType<typeof resolveRef>;
  try {
    r = resolveRef(state, ref);
  } catch {
    return null;
  }
  const n = r.node;
  // A selection that no longer exists has nothing to start from; it goes once it is cleared.
  if (!n) return null;
  const label = refLabel(state, ref);
  const the = `the ${label}`;
  const where = ref.owner.kind === 'shell' ? ` in the site ${ref.owner.id}` : ref.owner.kind === 'component' ? ' wherever it is used' : '';
  const out: string[] = [];

  if (n.kind === 'text') {
    const t = resolved(r, n.text);
    if (t.known && !plainOf(t.value).trim()) out.push(`Write the text for ${the}${where}`, `Suggest three ways to write ${the}${where}`);
    else out.push(`Rewrite ${the}${where} to sound warmer and more confident`, `Make ${the}${where} shorter and easier to scan`, `Suggest three other ways to write ${the}${where}`);
  } else if (n.kind === 'link') {
    const link = resolved(r, n.link);
    const target = link.known && link.value && typeof link.value === 'object' ? (link.value as { type?: string; target?: string }) : null;
    const dest = target?.type === 'page' && target.target ? own(state.pages, target.target) : undefined;
    const other = state.site.pageOrder.map((id) => own(state.pages, id)).find((p): p is PageDoc => !!p && p.id !== (ref.owner.kind === 'page' ? ref.owner.id : ''));
    if (dest) out.push(`Reword ${the}${where} so it clearly leads to the ${pageName(state, dest)} page`);
    else if (target && (target.type === 'none' || !target.target) && other) out.push(`Link ${the}${where} to the ${pageName(state, other)} page and word it to match`);
    out.push(`Rewrite ${the}${where} to sound warmer and more confident`, `Make ${the}${where} shorter and easier to scan`);
  } else if (n.kind === 'image') {
    const v = resolved(r, n.image);
    const slot = v.known ? slotOf(state, v.value) : null;
    const current = slot?.asset?.id;
    const others = imageAssets(state).filter((a) => a.id !== current);
    if (v.known && !slot?.asset) out.push(others.length ? `Choose an image for ${the}${where} from my images` : `Suggest what kind of photo suits ${the}${where}`);
    else {
      if (!slot?.decorative) out.push(`Write better alt text for ${the}${where}`);
      if (others.length) out.push(`Find a better image for ${the}${where} from my images`);
    }
  } else {
    const holds = n.kind === 'instance' || n.kind === 'element' || n.kind === 'repeat' ? contentOf(state, r.tree ?? { rootIds: [], nodes: {} }, [n.id]) : null;
    if (holds && !holds.units && !holds.images.length) out.push(`Add a heading, some text and a button to ${the}${where}`, `Suggest a better layout for ${the}${where}`);
    else out.push(`Make ${the}${where} more polished and easier to scan`, `Rewrite the text in ${the}${where} to sound warmer`, `Suggest a better layout for ${the}${where}`);
  }
  // Something is always worth asking about a selected element.
  if (!out.length) out.push(`Suggest a better layout for ${the}${where}`);
  return out.slice(0, 3).map((text) => ({ kind: 'selection', text }));
}

// ---------------------------------------------------------------------------

/** The starters to offer, best first: a scoped selection's own, else the page's pictures and copy, another page, and a missing page. */
export function chatSuggestions(input: SuggestionInput): ChatSuggestion[] {
  const { state, context } = input;
  if (context.selection && input.selection) {
    const picked = selectionStarters(input, input.selection);
    return picked ?? [];
  }
  const home = own(state.pages, state.site.homePageId);
  // Where a message goes without a selection: the page being viewed, or Home when the page is left out of it.
  const page = (context.page && input.pageId ? own(state.pages, input.pageId) : undefined) ?? home;
  const out: ChatSuggestion[] = [];
  if (page) {
    const content = pageContent(state, page);
    const image = imageStarter(state, input.assetUsage, page, content);
    if (image) out.push({ kind: 'page', text: image });
    out.push({ kind: 'page', text: contentStarter(state, page, content) });
    // Another page only when the open page is in play: with it left out, nothing says which page "this" is.
    if (context.page) {
      const others = state.site.pageOrder.map((id) => own(state.pages, id)).filter((p): p is PageDoc => !!p && p.id !== page.id);
      const other = others.find((p) => p.id !== state.site.homePageId) ?? others[0];
      if (other) out.push({ kind: 'cross-page', text: otherPageStarter(state, other) });
    }
  }
  const create = createPageStarter(state);
  if (create) out.push({ kind: 'create-page', text: create });
  // A small site with little to point at still gets something to try that does not depend on any page.
  if (out.length < 3) out.push({ kind: 'site', text: 'Make the brand color a deep navy blue across the whole site' });
  return out;
}
