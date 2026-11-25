/**
 * Deterministic generator: canonical project documents in, SvelteKit source files out.
 *
 * The same inputs and generator version always produce the same bytes. When `instrument`
 * is set the output additionally carries editor identity attributes; those variants are only
 * ever served in memory to the editor's development server and never written into the
 * portable project source.
 */
import type {
  AppearPreset,
  AssetRecord,
  Binding,
  Collection,
  ComponentDefinition,
  ElementNode,
  EntryDoc,
  GraphNode,
  ImageValue,
  InstanceNode,
  LinkValue,
  ListFeed,
  LinkNode,
  ListProp,
  NodeTree,
  OverlayMode,
  OwnerRef,
  PageDoc,
  ProjectState,
  PropSchema,
  RepeatNode,
  ResponsiveScope,
  StyleState,
  ResponsiveStyles,
  SiteRedirect,
  SlotDef,
  TextStyleValue,
  StateAction,
  TokenDef,
  TokenValue,
  UiStateSchema
} from '@shared/types';
import { ELEMENT_TAGS, GENERATOR_VERSION, LIST_FEEDS, RESPONSIVE_SCOPES, STYLE_STATES, TEXT_TAGS, conditionRef, isAppearPreset, isBinding, isBindingRef, isComparison, isStateRef, slotChildren, stateInitial, styleScopeKey, type Condition } from '@shared/types';
import {
  MEDIA_QUERIES,
  REDUCED_MOTION_QUERY,
  TRANSLATE_DECL,
  gridTemplateShares,
  hasStateStyles,
  isSafeCssValue,
  isStateStyleProp,
  isValidGradient,
  linkOf,
  resolveVisibility,
  styleDeclOrder,
  styleFallbackCss,
  styleReducedMotionCss,
  styleToCss,
  textLinkLeadsToText,
  textStyleValue,
  tokenVar,
  validateStyleValue,
  wideOnlyStyle,
  withColumnSizes
} from '@shared/styles';
import { getTheme } from '@catalogue/index';
import { usedPackFonts } from '@catalogue/fonts';
import { ACTION_SVELTE, DRAFTS_JS, IMAGE_SVELTE, NOT_FOUND_JS, RICHTEXT_SVELTE, UTIL_JS, iconSvelte, iconsJs, linkSvelte } from './runtime-files';
import { routeDir, routeUrl, validateRoute, validateSegment } from '@shared/routes';
import { sha256Hex } from '@shared/sha256';
import { NOT_FOUND_ROUTE, notFoundCopy } from '@shared/not-found';
import { pickImagesField } from '@shared/image-lists';
import { HTML_ATTR, HTML_START, pageDirection, pageLanguage, sameLanguage, siteDirection, siteLanguage, translationGroup, translationMembers } from '@shared/languages';
import { publicUrl } from '@shared/public-url';
import { siteVisitorText, visitorTextFor, visitorTextLanguage } from '@shared/visitor-text';
import { stableHash } from '@shared/ids';
import { fontFaceCss } from '@shared/fonts';
import { colorSchemeMode, darkValue, withDarkPalette, type PaletteScheme } from '@shared/color-scheme';
import { asParagraphList, isImageBlock, isListBlock, isTelephone, richTextToParagraphs, richTextToPlain, toRichText, type RichListType, type RichSpan, type RichText } from '@shared/richtext';
import { linkRels, relAttribute } from '@shared/link-rel';
import { axesOf, selectedVariants, selectedVariantStyles } from '@shared/variants';
import { itemOverrideClass, liveItemStyles, repeatedPartList } from '@shared/item-styles';
import { effectiveItem } from '@shared/page-teasers';
import { propBindingSchema } from '@shared/bindings';
import { feedLimit, isArticleDate, pageArticle } from '@shared/articles';
import { NO_QUERY, codeEntryQueries, entryQuery, entryQueryKey, feedRowFields, feedRows, type EntryQuery } from '@shared/entry-feed';
import { entryRoute, findEntry, isDraftEntry, isEntryPath, orderedEntries, siteEntries, type SiteEntry } from '@shared/collections';
import { entryNeighbours, materializeTemplate } from './entry-template';
import { archiveFile, generateArchive, siteArchives } from './archive';
import { archivePages } from '@shared/archives';
import { actionWraps, brokenCardKeys, cardKey, isCardLink, isCarouselTrack } from './card-links';
import { booleanStateGuard, declaredState, overlayProblem, repeatFilterProblem, stateActionProblem } from '@engine/schema';
import { CAROUSEL_JS, CAROUSEL_SVELTE } from './carousel';
import { showsPart, type ShellPart } from '@shared/page-shell';
import { SEARCH_HELPER_FILE, SEARCH_INDEX_FILE, SEARCH_JS, generateSearchIndex, usesSiteSearch } from './search';
import { addDiscoveryFiles, hasMarkdownMirror } from './llms';
import { MARKDOWN_MIRROR_FILE } from '@shared/llms';
import { crawlerRules, NOAI_META, siteMount, siteRobotsTxt } from '@shared/crawler-policy';
import { derived, isTracked, type GenerationCache } from './cache';
import { createSeoResolver, entryMetadata, pageMetadata, type SeoMetadata } from './seo-metadata';
import { ogLocale, twitterHandle, type EffectiveSeo } from '@shared/seo';
import { VIDEO_HELPER_FILE, VIDEO_JS, VIDEO_PLAYER_FILE, usesVideo, videoPlayerSvelte } from './video';
import { APPEAR_CSS, APPEAR_FILE, appearJs, usesAppear } from './appear';
import { THEME_TOGGLE_CSS, THEME_TOGGLE_FILE, themeBootstrap, themeStorageKey, themeToggleJs, usesThemeToggle } from './color-scheme';
import { generateWebManifest, siteColors, siteIconLinks, themeColorMeta } from './site-icons';
import { WEB_MANIFEST } from '@shared/site-icons';
import { elementKind, isEmptyLayout } from '@engine/tree';
// checks imports this module too: only its functions are used here, at generation time, never while loading.
import { notFoundSectionRoutes } from './checks';
import { graphScript, inGenerationRun } from './structured-data';
import { RSS_PATH, feedLink, generateRssFeed } from './rss';
import { siteTwitterHandle } from '@shared/site-identity';

export interface GenerateOptions {
  instrument?: boolean;
  /**
   * The editor's isolated component preview only (Component Studio, with `instrument`): the definition whose UI state
   * the studio previews. Its dialogs and drawers whose state is at the open value show in place while editing, as one
   * the author shows does, so they are on the canvas to select and style. Every other design (a component placed
   * inside it, a page's placements) keeps the author's own Show to edit.
   */
  previewOpen?: string;
}

export type FileMap = Map<string, string>;

export const GEN_ROOT = 'src/lib/siteorigin';
export const GENERATED_DIR = `${GEN_ROOT}/generated`;
export const RUNTIME_DIR = `${GEN_ROOT}/runtime`;
export const STYLES_DIR = `${GEN_ROOT}/styles`;
export const CUSTOM_DIR = `${GEN_ROOT}/custom`;
/** The theme's font files, copied from its pack, and their licences. */
export const FONTS_DIR = `${GEN_ROOT}/fonts`;

/**
 * A page's or entry's link to its Markdown copy, which sits beside its index.html: relative, so it holds under any
 * sub-path and in the editor's preview, wherever the public URL points.
 */
const MARKDOWN_ALTERNATE = `\t<link rel="alternate" type="text/markdown" href="./${MARKDOWN_MIRROR_FILE}" />`;

export const HEADER_NOTE = (source: string) =>
  `<!-- Generated by SiteOrigin Builder from ${source}. Changes made here are detected and preserved, but are not read back into the editor. -->\n`;

export function defKey(defId: string): string {
  return defId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}
export function defFile(def: ComponentDefinition): string {
  if (def.kind === 'code' && def.sourcePath) return def.sourcePath;
  return `${GENERATED_DIR}/${defKey(def.id)}.svelte`;
}
/** Import identifiers come from the definition ID, so they are always valid whatever the display name is. */
function importName(def: ComponentDefinition): string {
  return `C_${defKey(def.id).replace(/[^a-zA-Z0-9]/g, '_')}_${stableHash(def.id)}`;
}
export function relImport(fromFile: string, toFile: string): string {
  const from = fromFile.split('/').slice(0, -1);
  const to = toFile.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.length - i;
  const rel = [...Array(up).fill('..'), ...to.slice(i)].join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}
/**
 * A JavaScript literal for generated Svelte. `<` is escaped so that text such as "</script>" can never end
 * the surrounding <script> element early.
 */
export const js = (v: unknown) => JSON.stringify(v ?? null).replace(/</g, '\\u003c');
const attrJs = (v: unknown) => `{${js(v)}}`;

const RESERVED_WORDS = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in ' +
    'instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface ' +
    'package private protected public await async of arguments eval undefined NaN Infinity'
  ).split(' ')
);
/** Names a generated managed component declares itself. Properties never use them as local variables. */
const INTERNAL_LOCALS = new Set(['variant', 'className', 'so_o', 'so_oi', 'so_id', 'so_appear', 'so_stagger', 'so_eager', 'so_pages', 'so_editing', 'globalThis', '__so', '__so_at', 'has', 'isDate', 'uid', 'children', 'SoImage', 'SoLink', 'SoRichText', 'SoIcon', 'SoAction', 'SoCarousel', 'richParagraphs', 'richList', 'thumbnail', 'stepState', 'tabKey', 'filterKey', 'filterCategories', 'so_text', 'so_fill', 'so_visitorText', 'overlayOpen', 'overlayDismissal', 'overlayClosed', 'beforeNavigate', 'so_previewing']);
/**
 * Svelte's runes, by the name a local would hide them under: a property local named `state` would make `$state(...)`
 * read it as a store, so properties never take these names as locals either.
 */
const RUNE_NAMES = new Set(['state', 'derived', 'effect', 'props', 'bindable', 'inspect', 'host']);
/** Prop keys a generated managed component already receives; a property with one of these names is renamed. */
const INTERNAL_KEYS = new Set(['class', 'variant', 'so_o', 'so_oi', 'so_id', 'so_appear', 'so_stagger', 'so_eager', 'so_pages', '__so', '__so_at', 'children']);

/**
 * The key a managed component's property is passed under (instance attribute and `$props()` key). Names the
 * component already uses for itself are renamed, avoiding the names of the definition's other properties.
 */
export function propKey(def: ComponentDefinition, name: string): string {
  if (def.kind !== 'managed' || !(INTERNAL_KEYS.has(name) || name.startsWith('slot_') || name.startsWith('variant_'))) return name;
  let key = `prop_${name}`;
  while (Object.hasOwn(def.properties, key)) key = `prop_${key}`;
  return key;
}

/** Local variable names for a managed component's properties: valid, not reserved, unique and collision-free. */
export function propLocals(def: ComponentDefinition): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const name of Object.keys(def.properties).sort()) {
    let local = /^[a-zA-Z_$][\w$]*$/.test(name) ? name : `_${name.replace(/[^\w$]/g, '_')}`;
    if (RESERVED_WORDS.has(local) || INTERNAL_LOCALS.has(local) || RUNE_NAMES.has(local) || /^(\$|slot_|variant_|so_children_|so_state_|so_filter_|so_dialog_|so_opener_|so_overlay_|C_|item\d*$)/.test(local)) local = `prop_${local.replace(/^\$/, '_')}`;
    let unique = local;
    for (let i = 2; taken.has(unique); i++) unique = `${local}_${i}`;
    taken.add(unique);
    out.set(name, unique);
  }
  return out;
}

/** A Svelte attribute for a component prop; names that cannot be written as attributes are spread. */
function propAttr(key: string, expr: string): string {
  return /^[a-zA-Z_$][\w$-]*$/.test(key) ? `${key}={${expr}}` : `{...{ ${js(key)}: ${expr} }}`;
}

/** Property access on a repeated item. */
function itemField(itemVar: string, field: string): string {
  return /^[a-zA-Z_$][\w$]*$/.test(field) ? `${itemVar}.${field}` : `${itemVar}[${js(field)}]`;
}

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

export interface ResolveContext {
  state: ProjectState;
  /** The value goes to a code component, which takes each rich text property in the form it declares. */
  forCode?: boolean;
  /**
   * The page whose own content is being written, which computed lists (news, an article's header) are worked out
   * for. Absent in the shared header and footer and inside component designs, which every page shares: a design
   * gets its page's rows handed down as `so_pages` instead.
   */
  pageId?: string;
  /** The collection entry whose page is being written: an entry feed there defaults to its collection and leaves it out. */
  entry?: { collectionId: string; entryId: string };
}

/**
 * The rows a computed list holds where it is placed (see shared/entry-feed.ts), `query` being what an entry feed's
 * placement chose. In a cached run an entry feed's rows are worked out once per state, so a page depends on the rows
 * it lists and not on every entry of the project.
 */
function placedRows(ctx: ResolveContext, schema: Pick<ListProp, 'feed' | 'max'>, query?: EntryQuery): Array<Record<string, unknown>> {
  if (schema.feed !== 'entries') return feedRows(ctx.state, schema, { pageId: ctx.pageId });
  const q = query ?? NO_QUERY;
  const limit = feedLimit(schema);
  const max = Number.isFinite(limit) ? limit : undefined;
  const entry = ctx.entry;
  const key = `entryRows:${entryQueryKey(q, max)}:${entry ? `${entry.collectionId}/${entry.entryId}` : ''}`;
  return derived(ctx.state, key, (s) => feedRows(s, { feed: 'entries', ...(max !== undefined ? { max } : {}) }, { entry, query: q }));
}

/**
 * An email target as a valid mailto: URL. Addresses are percent-encoded (keeping "@", "+" and the commas between
 * recipients readable); an optional ?subject=… keeps its existing escapes and gains the ones it is missing.
 */
export function encodeMailto(target: string): string {
  const q = target.indexOf('?');
  const address = (q < 0 ? target : target.slice(0, q)).trim();
  const encoded = encodeURIComponent(address).replace(/%40/g, '@').replace(/%2B/g, '+').replace(/%2C/g, ',');
  if (q < 0) return encoded;
  const query = target.slice(q + 1).replace(/%(?![0-9a-f]{2})/gi, '%25').replace(/[\s"<>#]/g, (c) => encodeURIComponent(c));
  return `${encoded}?${query}`;
}

/**
 * A link as the site's components take it: where it goes, whether it opens a new tab, a document's download name,
 * and `rel` (the whole attribute, security tokens first) only when the author declared a relationship, so a link
 * without one is the object it always was and each component adds `noopener noreferrer` for a new tab itself.
 */
export function resolveLink(link: LinkValue | null | undefined, ctx: ResolveContext): { href: string; newTab?: boolean; rel?: string; download?: string } | null {
  // A destination that is not text (a hand edit, a theme pack's layout) goes nowhere rather than failing the build.
  if (!link || link.type === 'none' || !link.target || typeof link.target !== 'string') return null;
  let href = '';
  switch (link.type) {
    case 'document': {
      // The file itself, from the site's own folder, saved under the name it was imported with.
      const doc = Object.hasOwn(ctx.state.assets.assets, link.target) ? ctx.state.assets.assets[link.target] : undefined;
      if (doc?.kind !== 'document' || typeof doc.file !== 'string' || !doc.file.startsWith('static/')) return null;
      return { href: '/' + doc.file.slice('static/'.length), download: downloadName(doc) };
    }
    case 'page': {
      const page = ctx.state.pages[link.target];
      if (!page) return null;
      href = page.route + (link.anchor ? `#${link.anchor}` : '');
      break;
    }
    case 'url':
      if (!/^https?:\/\//i.test(link.target)) return null;
      href = link.target;
      break;
    case 'email':
      href = `mailto:${encodeMailto(link.target)}`;
      break;
    case 'tel':
      // A number saved before numbers needed three digits dials nothing: it shows its words alone.
      if (!isTelephone(link.target)) return null;
      href = `tel:${link.target.replace(/[^+0-9]/g, '')}`;
      break;
    case 'anchor':
      href = `#${link.target.replace(/^#/, '')}`;
      break;
    case 'entry': {
      // An entry's page, at its current address: a link to an entry the site does not publish shows its words alone.
      const found = findEntry(ctx.state, link.target);
      if (!found || !isEntryPath(found.collection, found.entry)) return null;
      href = entryRoute(found.collection, found.entry);
      break;
    }
  }
  const rels = linkRels(link);
  const out: { href: string; newTab?: boolean; rel?: string } = link.newTab ? { href, newTab: true } : { href };
  if (rels.length) out.rel = relAttribute(link.newTab, rels);
  return out;
}

/**
 * The name a visitor's download is saved under: the file the document was imported from, else its library name, with
 * the stored file's extension. Characters file systems refuse are left out.
 */
export function downloadName(doc: AssetRecord): string {
  const ext = /\.[a-z0-9]+$/i.exec(doc.file)?.[0] ?? '';
  const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim() : '');
  let base = clean(doc.originalName).replace(/\.[a-z0-9]+$/i, '') || clean(doc.name) || 'document';
  // A name shaped like a stored file's ("guide-1a2b3c4d") would make the website build keep that file for it.
  if (/^[a-z0-9-]*-[a-f0-9]{8}$/i.test(base)) base = base.replace(/-/g, ' ');
  return `${base.slice(0, 120).replace(/[. ]+$/, '') || 'document'}${ext.toLowerCase()}`;
}

export function resolveImage(img: ImageValue | null | undefined, ctx: ResolveContext) {
  if (!img) return null;
  const asset = img.assetId ? ctx.state.assets.assets[img.assetId] : undefined;
  const out: Record<string, unknown> = { src: asset ? '/' + asset.file.replace(/^static\//, '') : null, alt: img.alt ?? '' };
  if (asset?.width) out.width = asset.width;
  if (asset?.height) out.height = asset.height;
  if (asset?.variants?.length && asset.width)
    out.srcset = [...asset.variants.map((v) => `/${v.file.replace(/^static\//, '')} ${v.width}w`), `/${asset.file.replace(/^static\//, '')} ${asset.width}w`].join(', ');
  if (img.decorative) out.decorative = true;
  return out;
}

/**
 * Rich text ready to render: page links become their current routes, and a link that cannot resolve is plain text.
 * A picture in an article becomes the image to show (a placeholder when it is no longer a library image) and its caption.
 */
export function resolveRichText(value: unknown, ctx: ResolveContext, plainAs?: RichListType) {
  const spans = (list: RichSpan[]) =>
    list.map(({ link, ...s }) => {
      const resolved = link ? resolveLink(link, ctx) : null;
      return resolved ? { ...s, link: resolved } : s;
    });
  return toRichText(value, plainAs).map((b) => {
    if (isListBlock(b)) return { type: b.type, items: b.items.map(spans) };
    if (isImageBlock(b)) {
      const asset = Object.hasOwn(ctx.state.assets.assets, b.assetId) ? ctx.state.assets.assets[b.assetId] : undefined;
      const image = resolveImage({ assetId: asset?.kind === 'image' ? b.assetId : null, alt: b.alt, ...(b.decorative ? { decorative: true } : {}) }, ctx);
      return { type: b.type, image, ...(b.caption ? { caption: b.caption } : {}) };
    }
    return { type: b.type, spans: spans(b.spans) };
  });
}

/**
 * Whether a code component receives a rich text property or list field as blocks, declared with `codeForm`, for its
 * RichText helper to render with links, lists and headings. Otherwise it gets the paragraph strings code components
 * have always been given.
 */
export const codeTakesBlocks = (schema: PropSchema | undefined): boolean => schema?.type === 'richtext' && schema.codeForm === 'blocks';

/** The rich text fields of a list a code component takes as paragraph strings. */
const paragraphFields = (schema: PropSchema): string[] => (schema.type === 'list' || schema.type === 'object' ? Object.entries(schema.fields).filter(([, f]) => f.type === 'richtext' && !codeTakesBlocks(f)).map(([k]) => k) : []);

export function resolveValue(schema: PropSchema | undefined, value: unknown, ctx: ResolveContext, query?: EntryQuery): unknown {
  if (!schema) return value;
  switch (schema.type) {
    case 'link':
      return resolveLink((value as LinkValue) ?? schema.default, ctx);
    case 'image':
      return resolveImage((value as ImageValue) ?? schema.default, ctx);
    case 'richtext':
      return ctx.forCode && !codeTakesBlocks(schema)
        ? richTextToParagraphs(toRichText(value ?? schema.default, schema.plainAs))
        : resolveRichText(value ?? schema.default, ctx, schema.plainAs);
    case 'list': {
      // A computed list holds what the site's pages (or a collection's entries) give it where it is placed, whatever
      // is stored; an entry feed, what its placement's `query` chose.
      const items: Array<Record<string, unknown>> = schema.feed
        ? placedRows(ctx, schema, query)
        : Array.isArray(value)
          ? value
          : schema.default;
      return items.map((raw: Record<string, unknown>) => {
        // A page list's empty fields show the linked page's own values, as they are when the site is generated.
        const it = effectiveItem(ctx.state, schema, raw);
        const out: Record<string, unknown> = { id: it.id };
        for (const [k, f] of Object.entries(schema.fields)) out[k] = resolveValue(f, it[k] ?? f.default, ctx);
        return out;
      });
    }
    case 'number':
      return typeof value === 'number' ? value : Number(value ?? schema.default);
    case 'boolean':
      return typeof value === 'boolean' ? value : schema.default;
    case 'object': {
      // Each field as a property of its type shows it: a page link as its address, rich text as its blocks.
      const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : schema.default;
      const out: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(schema.fields)) out[k] = resolveValue(f, Object.hasOwn(v, k) ? v[k] : Object.hasOwn(schema.default, k) ? schema.default[k] : f.default, ctx);
      return out;
    }
    case 'token': {
      // A token choice is the token's CSS variable, so a placement follows later edits to the token itself.
      const ref = value && typeof value === 'object' && typeof (value as { token?: unknown }).token === 'string' ? (value as { token: string }).token : schema.default.token;
      return `var(${tokenVar(ref)})`;
    }
    default:
      return value ?? schema.default;
  }
}

export function resolveInstanceProps(def: ComponentDefinition, node: InstanceNode, ctx: ResolveContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rctx = def.kind === 'code' ? { ...ctx, forCode: true } : ctx;
  const query = entryQuery(def.properties, node.props);
  for (const [name, schema] of Object.entries(def.properties)) {
    const raw = Object.hasOwn(node.props, name) ? node.props[name] : schema.default;
    out[name] = resolveValue(schema, raw, rctx, query);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * The site's tokens: the theme's and the project's own, with the project's values. The dark palette (see
 * shared/color-scheme.ts) lays its own colours over them, whether or not visitors can see it.
 */
export function effectiveTokens(state: ProjectState, scheme: PaletteScheme = 'light'): TokenDef[] {
  const theme = getTheme(state.site.themeId);
  const list: TokenDef[] = [...theme.tokens, ...state.tokens.custom];
  const light = list.map((t) => (t.id in state.tokens.overrides ? { ...t, value: state.tokens.overrides[t.id] } : t));
  return scheme === 'dark' ? withDarkPalette(light, state.tokens.darkOverrides) : light;
}

function tokenCssValue(v: TokenValue | unknown): string {
  if (v && typeof v === 'object' && 'token' in (v as object)) return `var(${tokenVar((v as { token: string }).token)})`;
  return String(v);
}

/** Text placed inside a CSS comment, which must not be able to end it. */
const inComment = (text: string) => text.replace(/\*\//g, '* /');

/** The theme fonts this site uses, which the editor copies into the project from the theme's pack. */
function usedFonts(state: ProjectState) {
  // Any string in any document may name a font: a file that depends on the answer, not on every document.
  return derived(state, 'fonts', (s) => usedPackFonts(s, effectiveTokens(s).map((t) => t.value)));
}

/** The pack files a site needs beside its generated source: project path → the file inside the theme's pack. */
export interface PackFileCopy {
  path: string;
  pack: string;
  file: string;
}

/**
 * Binary files the generated source refers to: the faces of every theme font the site uses. They come byte for
 * byte from the theme's pack, so the editor copies them rather than generating them.
 */
export function packFileCopies(state: ProjectState): PackFileCopy[] {
  const pack = getTheme(state.site.themeId).id;
  return usedFonts(state).flatMap((f) => f.faces.map((face) => ({ path: `${FONTS_DIR}/${face.file.slice('fonts/'.length)}`, pack, file: face.file })));
}

/** @font-face rules for the theme fonts the site uses, served from the copies under FONTS_DIR. */
function packFontFaceCss(state: ProjectState): string {
  const fonts = usedFonts(state);
  if (!fonts.length) return '';
  const rules = fonts.flatMap((f) =>
    f.faces.map(
      (face) =>
        `@font-face {\n\tfont-family: '${f.family}';\n\tfont-style: ${face.style};\n\tfont-display: swap;\n\tfont-weight: ${face.weight};\n\tsrc: url('../fonts/${face.file.slice('fonts/'.length)}') format('${face.format}');${face.unicodeRange ? `\n\tunicode-range: ${face.unicodeRange};` : ''}\n}`
    )
  );
  return `/* Fonts from the ${inComment(getTheme(state.site.themeId).name)} theme. Licences: ../fonts/NOTICE.txt */\n${rules.join('\n')}\n\n`;
}

/** The licence notices of the theme fonts the site ships. */
function generateFontNotice(state: ProjectState): string | null {
  const fonts = usedFonts(state);
  if (!fonts.length) return null;
  return `Fonts in this folder come with the ${getTheme(state.site.themeId).name} theme.\n\n${fonts.map((f) => `${f.name} (${f.license})\n${'-'.repeat(f.name.length + f.license.length + 3)}\n\n${f.notice.trim()}\n`).join('\n')}`;
}

export function generateTokensCss(state: ProjectState): string {
  // Web fonts come first, so the tokens below can name their families: the theme's, then the project's own.
  const lines: string[] = [packFontFaceCss(state) + fontFaceCss(state) + '/* Site tokens. Generated from the theme defaults and siteorigin/tokens.json. */', ':root {'];
  const tokens = effectiveTokens(state);
  const theme = getTheme(state.site.themeId);
  for (const t of tokens) {
    const name = tokenVar(t.id);
    let value = t.value;
    let link = t.group === 'text' ? linkOf(value, 'text') : null;
    // A text style linked to another (by hand, or by an older version) that leads nowhere keeps the theme's metrics.
    if (link && !textLinkLeadsToText(tokens, t.id)) {
      const own = textStyleValue(tokens, t.id, theme.tokens.find((x) => x.id === t.id)?.value);
      if (!own) continue;
      (value = own as unknown as TokenValue), (link = null);
    }
    if (link) {
      // Text styles are read metric by metric, so one that follows another follows each metric.
      for (const k of ['family', 'size', 'line-height', 'weight', 'tracking', 'transform']) lines.push(`\t${name}-${k}: var(${tokenVar(link)}-${k});`);
    } else if (t.group === 'text' && value && typeof value === 'object') {
      // A stray `token` beside the metrics (written by an older version) is ignored: the metrics are the style.
      const ts = value as TextStyleValue;
      lines.push(`\t${name}-family: ${tokenCssValue(ts.family)};`);
      lines.push(`\t${name}-size: ${ts.size};`);
      lines.push(`\t${name}-line-height: ${ts.lineHeight};`);
      lines.push(`\t${name}-weight: ${ts.weight};`);
      lines.push(`\t${name}-tracking: ${ts.tracking};`);
      lines.push(`\t${name}-transform: ${ts.transform ?? 'none'};`);
    } else {
      lines.push(`\t${name}: ${tokenCssValue(t.value)};`);
    }
  }
  // A site with a dark palette says which palette each rule paints, so the browser's own controls and scrollbars match.
  const mode = colorSchemeMode(state.tokens);
  if (mode !== 'single') lines.push('\tcolor-scheme: light;');
  lines.push('}', '');
  // Values come from validated documents, but a hand-edited document must still not break out of :root.
  const css = lines.filter((l) => !l.startsWith('\t--') || safeDecl(l.slice(1, -1))).join('\n');
  return mode === 'single' ? css : css + darkPaletteCss(state, mode, tokens);
}

/**
 * The dark palette's rules: its colours on screen while the visitor's device asks for dark (`system`), or while it
 * does and the visitor has not switched to light, and whenever they have switched to dark (`toggle`, from the
 * `data-so-theme` attribute the header's switch sets). Print always takes the light palette, which every theme
 * prints in; a dark section keeps its own colours there as it always has.
 */
function darkPaletteCss(state: ProjectState, mode: 'system' | 'toggle', light: TokenDef[]): string {
  const dark = state.tokens.darkOverrides ?? {};
  const decls = ['\t\tcolor-scheme: dark;'];
  for (const t of light) {
    if (t.group !== 'color' || !Object.hasOwn(dark, t.id)) continue;
    const v = darkValue(dark[t.id]);
    // A link must name a colour token, as the light palette's do; anything else (a hand edit) is left out.
    const target = v && typeof v === 'object' ? light.find((x) => x.id === v.token) : null;
    if (v === null || (typeof v === 'object' && target?.group !== 'color') || (typeof v === 'string' && validateStyleValue('color', v))) continue;
    const decl = `${tokenVar(t.id)}: ${tokenCssValue(v)}`;
    if (safeDecl(decl)) decls.push(`\t\t${decl};`);
  }
  const block = decls.join('\n');
  const rules =
    mode === 'system'
      ? ['@media screen and (prefers-color-scheme: dark) {', '\t:root {', block, '\t}', '}']
      : ['@media screen and (prefers-color-scheme: dark) {', '\t:root:not([data-so-theme="light"]) {', block, '\t}', '}', '@media screen {', '\t:root[data-so-theme="dark"] {', block, '\t}', '}'];
  const print = ['@media print {', '\t:root {', '\t\tcolor-scheme: light;', '\t}', ...(mode === 'toggle' ? ['\t.so-theme-toggle {', '\t\tdisplay: none !important;', '\t}'] : []), '}'];
  return `/* The dark palette, from siteorigin/tokens.json. Print always uses the palette above. */\n${[...rules, ...print].join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Style rules
// ---------------------------------------------------------------------------

/**
 * `wide` holds rules for tablet and desktop together (everything above phone width); `reduced`, the rules for
 * visitors who ask for reduced motion; `states`, the rules for each interactive state at each size.
 */
type RuleSet = { base: string[]; wide: string[]; phone: string[]; tablet: string[]; desktop: string[]; reduced: string[]; states: Record<StyleState, Record<ResponsiveScope, string[]>> };
const sizeLists = (): Record<ResponsiveScope, string[]> => ({ base: [], phone: [], tablet: [], desktop: [] });
const newRules = (): RuleSet => ({ base: [], wide: [], phone: [], tablet: [], desktop: [], reduced: [], states: { hover: sizeLists(), focus: sizeLists(), active: sizeLists() } });
const WIDE_QUERY = '(min-width: 768px)';
/**
 * Where each interactive state applies. `:where()` adds no weight, so a state rule is exactly as strong as the rule it
 * changes, and wins by coming after every resting rule. Focus is the keyboard's (`:focus-visible`), not a click's. A
 * card with an action is wrapped in the runtime's link (`.so-action`), which is what takes focus and is pressed with the
 * keyboard, so the card it wraps (its one child) shows those states with it. A card that is a link itself takes them
 * on its own element.
 */
const STATE_PSEUDO: Record<StyleState, string> = { hover: ':hover', focus: ':focus-visible, .so-action:focus-visible > *', active: ':active, .so-action:active > *' };
/** Hover rules apply only where a pointer can hover, so a tap on a touch screen never leaves one stuck on. */
const HOVER_QUERY = '(hover: hover)';

/** Declarations that could escape their rule or load remote content are never written. */
function safeDecl(decl: string): boolean {
  const i = decl.indexOf(':');
  return i > 0 && isSafeCssValue(decl.slice(i + 1).trim());
}

interface RuleOpts {
  /** Link nodes: colours also set --so-btn-bg / --so-btn-fg so button hover states follow them. */
  link?: boolean;
  /**
   * Variants and instance overrides: a multi-column value set for all sizes applies from tablet up, so the
   * component's own phone layout (usually one column) still applies unless a phone value is set explicitly.
   */
  wideColumns?: boolean;
  /** Variants and instance overrides: the display value that shows a part a weaker layer hides, for `hidden: false`. */
  unhide?: (scope: ResponsiveScope) => string | null;
  /** Finishes each selector written (a component's own <style> block makes them `:global()`). */
  wrap?: (sel: string) => string;
  /** Converted code's own stylesheet: the marker each hide is gated on (see `shownGate`). */
  gateHides?: string;
  /**
   * Overrides of what a code component renders: its own scoped styles can be more specific than any number of
   * classes (an id, a long descendant chain), so every declaration is important. Only its own important ones win.
   */
  important?: boolean;
  /**
   * The selector interactive state rules are written for, when not the resting rules' own: one that names only the
   * styled element, where the resting selector reaches it through an ancestor (and so could also reach a copy of it
   * nested inside). `null` writes no state rules.
   */
  stateSelector?: string | null;
}

/** A declaration made important, unless it already is (custom CSS may say so itself). */
const important = (decl: string) => (/!\s*important\s*$/i.test(decl) ? decl : `${decl} !important`);

function nodeDisplay(layout: unknown): string | null {
  return layout === 'stack' || layout === 'row' ? 'flex' : layout === 'grid' ? 'grid' : layout === 'block' ? 'block' : null;
}

/**
 * The display that shows a design's node again where nothing else sets one: what the theme gives this kind of
 * element (a bound appearance counts as a button); `revert` would fall back to the browser's default instead.
 */
export function naturalDisplay(node: GraphNode | undefined): string {
  return node?.kind === 'image' || node?.kind === 'icon' ? 'block' : node?.kind === 'link' ? (node.appearance === 'link' || node.appearance === 'plain' ? 'inline' : 'inline-flex') : 'revert';
}

/**
 * For a part shown again by an instance (`hidden: false`), the display value that undoes the definition's or
 * variant's `display: none` at that scope, or null when nothing hides it there.
 */
function unhider(def: ComponentDefinition, nodeId: string, variants: InstanceNode['variants'] | null, override: ResponsiveStyles, earlier: ResponsiveStyles[] = [], later: ResponsiveStyles[] = []) {
  const natural = naturalDisplay(def.tree?.nodes[nodeId]);
  const layers = [def.tree?.nodes[nodeId]?.styles, ...earlier, ...(variants === null ? [] : selectedVariantStyles(def, variants, nodeId)), ...later].filter(Boolean) as ResponsiveStyles[];
  return (scope: ResponsiveScope): string | null => {
    const scopes: ResponsiveScope[] = scope === 'base' ? ['base', 'phone', 'tablet', 'desktop'] : ['base', scope];
    if (!layers.some((l) => scopes.some((s) => l[s]?.hidden === true))) return null;
    let layout: unknown;
    for (const l of [...layers, override]) for (const s of ['base', scope] as const) if (l[s]?.layout !== undefined) layout = l[s]!.layout;
    return nodeDisplay(layout) ?? natural;
  };
}

/** The marker a placement of converted code `def` sets where it shows a part again (see `shownGate`). */
const shownMark = (def: Pick<ComponentDefinition, 'id'>) => `so-shown--${defKey(def.id)}`;

/**
 * Classes a placement of converted code takes on a part it shows again (`hidden: false`), at all sizes or one. Only
 * code whose stylesheet gates its hides on them gets any, so other code keeps one class per part.
 */
function shownClasses(def: ComponentDefinition, override: ResponsiveStyles | undefined): string {
  const mark = shownMark(def);
  if (!override || def.kind !== 'code' || !def.source?.includes(mark)) return '';
  const out = override.base?.hidden === false ? [` ${mark}`] : [];
  for (const size of ['phone', 'tablet', 'desktop'] as const) if (override[size]?.hidden === false) out.push(` ${mark}-${size}`);
  return out.join('');
}

/**
 * Code made from a managed design keeps that design's hides in its own stylesheet, where a placement's overrides can
 * no longer see them. Each hide is written for an element not marked shown at that size by a placement of this very
 * component (its marker for every size, or for that size): `:where()` adds no weight, so the hide keeps its place in
 * the cascade, and a marked element simply takes whatever display its other rules give it. A nested component's
 * marker names that component, so it never lifts a hide its container sets on the same element.
 */
const shownGate = (raw: string, size: 'phone' | 'tablet' | 'desktop', mark: string) => `${raw}:not(:where(.${mark}, .${mark}-${size}))`;

/**
 * Declaration order inside a rule. Composite values come first so the specific ones win (`gap` before `columnGap`,
 * which would otherwise sort ahead of it); custom CSS follows the named properties and visibility has the last word.
 */
const ORDER = styleDeclOrder;


/** Each declaration once, at its last place in the rule: for the generated declarations the builder writes itself. */
const lastCopies = (decls: string[]) => decls.filter((d, i) => decls.lastIndexOf(d) === i);
/** Both shift axes write the same translate: once is enough. Nothing else is touched, so no value can shift onto another. */
const oneTranslate = (decls: string[]) => decls.filter((d, i) => d !== TRANSLATE_DECL || decls.lastIndexOf(d) === i);

function addRules(rules: RuleSet, raw: string, input: ResponsiveStyles | undefined, opts: RuleOpts = {}) {
  if (!input) return;
  const wrap = opts.wrap ?? ((sel: string) => sel);
  const selector = wrap(raw);
  // Starting values for the element itself at zero specificity, which every rule naming it overrides.
  const quiet = wrap(`:where(${raw})`);
  const styles = resolveVisibility(withColumnSizes(input));
  const rule = (decls: string[]) => `${selector} {\n${decls.map((d) => `\t${opts.important ? important(d) : d};`).join('\n')}\n}`;
  for (const scope of ['base', 'phone', 'tablet', 'desktop'] as const) {
    // Showing a part a weaker layer hides needs an explicit display value, decided before visibility folding, and
    // only in the ranges where it is hidden: anywhere else the weaker layer's own layout must keep applying.
    const shown = scope !== 'base' && input[scope]?.hidden === false && opts.unhide ? opts.unhide(scope) : null;
    const props = styles[scope] ?? (shown ? {} : undefined);
    if (!props) continue;
    const decls: string[] = shown ? [`display: ${shown}`] : [];
    const wide: string[] = [];
    const fallback: string[] = [];
    const reduced: string[] = [];
    // Composite text styles first so explicit typography wins; visibility last so it can override display.
    const keys = Object.keys(props).sort((a, b) => ORDER(a) - ORDER(b) || a.localeCompare(b));
    const gated = !!opts.gateHides && props.hidden === true;
    for (const k of keys) {
      if (gated && k === 'hidden') continue;
      const out = styleToCss(k, props[k]);
      // Links and buttons paint from --so-btn-bg / --so-btn-fg, so a styled button keeps its hover state
      // whatever the specificity of the rule that styles it.
      // A gradient cannot go through the hover state's color-mix(), so it stays as it is on hover.
      if (opts.link && k === 'background' && out.length) {
        const v = props[k];
        out.splice(0, out.length, ...out.map((d) => d.replace(/^background:/, '--so-btn-bg:')), `--so-btn-bg-hover: ${typeof v === 'string' && isValidGradient(v) ? v.trim() : 'initial'}`);
      }
      if (opts.link && k === 'color') out.push(...out.map((d) => d.replace(/^color:/, '--so-btn-fg:')));
      const target = scope === 'base' && wideOnlyStyle(k, props[k], opts.wideColumns) ? wide : decls;
      target.push(...out.filter(safeDecl));
      fallback.push(...styleFallbackCss(k, props[k]).filter(safeDecl));
      reduced.push(...styleReducedMotionCss(k, props[k]).filter(safeDecl));
    }
    if (fallback.length) rules[scope].push(`${quiet} {\n${lastCopies(fallback).map((d) => `\t${d};`).join('\n')}\n}`);
    if (decls.length) rules[scope].push(rule(oneTranslate(decls)));
    // The hide right after the rule it came from, per size, so it keeps its place in the cascade.
    if (gated && scope === 'base') for (const size of ['phone', 'tablet', 'desktop'] as const) rules.base.push(`@media ${MEDIA_QUERIES[size]} {\n\t${wrap(shownGate(raw, size, opts.gateHides!))} {\n\t\tdisplay: none;\n\t}\n}`);
    else if (gated && scope !== 'base') rules[scope].push(`${wrap(shownGate(raw, scope, opts.gateHides!))} {\n\tdisplay: none;\n}`);
    // At every size: a transition set for one size is turned off wherever the element is. Against important styles
    // (a code component's placement) it takes their own selector, and wins by coming last.
    if (reduced.length) rules.reduced.push(`${opts.important ? selector : quiet} {\n${lastCopies(reduced).map((d) => `\t${d};`).join('\n')}\n}`);
    // Shown at all sizes: each range where it is hidden gets the display its own layout gives it.
    if (scope === 'base' && input.base?.hidden === false && opts.unhide)
      for (const r of ['phone', 'tablet', 'desktop'] as const) {
        const d = input[r]?.hidden === undefined ? opts.unhide(r) : null;
        if (d) rules[r].push(rule([`display: ${d}`]));
      }
    // Custom CSS has the last word in the wide range too, where these values land after the base rule.
    if (wide.length && props.customCss !== undefined) wide.push(...styleToCss('customCss', props.customCss).filter(safeDecl));
    if (wide.length) rules.wide.push(rule(wide));
  }
  addStateRules(rules, raw, input, opts);
}

/**
 * The rules for each interactive state at each size, on the element itself. Only appearance properties are written
 * (validation reports any other). A link's or button's background also goes through its own variables, so the theme's
 * hover rule for a button, which is stronger, paints the same colour.
 */
function addStateRules(rules: RuleSet, raw: string, input: ResponsiveStyles, opts: RuleOpts) {
  if (opts.stateSelector === null) return;
  const wrap = opts.wrap ?? ((sel: string) => sel);
  const base = opts.stateSelector ?? raw;
  for (const state of STYLE_STATES)
    for (const scope of RESPONSIVE_SCOPES) {
      const props = input[styleScopeKey(scope, state)];
      if (!props || typeof props !== 'object') continue;
      const decls: string[] = [];
      for (const k of Object.keys(props).sort((a, b) => ORDER(a) - ORDER(b) || a.localeCompare(b))) {
        if (!isStateStyleProp(k)) continue;
        const out = styleToCss(k, props[k]);
        // It paints through the variable too, so a stronger layer's resting colour (which sets only the variable)
        // still wins, as it does over every other state value; a text button paints no background of its own.
        if (opts.link && k === 'background')
          out.splice(0, out.length, ...out.flatMap((d) => (d.startsWith('background:') ? [d.replace(/^background:/, '--so-btn-bg:'), d.replace(/^background:/, '--so-btn-bg-hover:'), 'background: var(--so-btn-bg)'] : [d])));
        if (opts.link && k === 'color') out.push(...out.map((d) => d.replace(/^color:/, '--so-btn-fg:')));
        decls.push(...out.filter(safeDecl));
      }
      if (!decls.length) continue;
      const selector = wrap(`${base}:where(${STATE_PSEUDO[state]})`);
      rules.states[state][scope].push(`${selector} {\n${lastCopies(decls).map((d) => `\t${opts.important ? important(d) : d};`).join('\n')}\n}`);
    }
}

function emitRules(rules: RuleSet): string {
  const out: string[] = [...rules.base];
  const block = (query: string, list: string[]) => `@media ${query} {\n${list.map((r) => r.replace(/^/gm, '\t')).join('\n')}\n}`;
  if (rules.wide.length) out.push(block(WIDE_QUERY, rules.wide));
  for (const scope of ['phone', 'tablet', 'desktop'] as const) {
    if (!rules[scope].length) continue;
    out.push(block(MEDIA_QUERIES[scope], rules[scope]));
  }
  // Every state after every resting rule, so a state beats the resting style at every size, as hand-written `:hover`
  // does; within a state, a size's own rule after the rule for all sizes; and active after focus after hover, so the
  // state a visitor is in last wins while several hold.
  for (const state of STYLE_STATES)
    for (const scope of RESPONSIVE_SCOPES) {
      const list = rules.states[state][scope];
      if (!list.length) continue;
      const query = [scope === 'base' ? null : MEDIA_QUERIES[scope], state === 'hover' ? HOVER_QUERY : null].filter(Boolean).join(' and ');
      if (query) out.push(block(query, list));
      else out.push(...list);
    }
  // Last, and with !important as the theme's own rule has, so no duration set for any size outlasts it.
  if (rules.reduced.length) out.push(block(REDUCED_MOTION_QUERY, [...new Set(rules.reduced)]));
  return out.join('\n');
}

export function nodeClass(def: ComponentDefinition, nodeId: string): string {
  return `so-${defKey(def.id)}__${nodeId}`;
}
/** The class a definition's root carries for one option of a variant axis. */
export function variantClass(def: ComponentDefinition, axis: string, option: string): string {
  return `so-${defKey(def.id)}--${axis}-${option}`;
}
/**
 * The axes with an option that styles a node other than the root, in axis order. Such a node carries the root's
 * class for that axis's selected option too, and variant rules match the two classes on the node itself, never through
 * the root above it: a placement of the same component inside this one (in a slot) has roots of its own between, and
 * must keep its own options.
 */
export function nodeAxes(def: ComponentDefinition, nodeId: string): string[] {
  if (nodeId === def.tree?.rootIds[0]) return [];
  return axesOf(def).flatMap(([axis, a]) => (Object.values(a.options).some((o) => !!o.styles && Object.hasOwn(o.styles, nodeId)) ? [axis] : []));
}
/**
 * Code converted before conversions carried their own CSS still uses the definition's one-class-per-variant names.
 * In a cached run it is worked out once for the project's own definitions, so editing a code component reaches only
 * the definitions whose answer changes; otherwise, and for a definition made from outside the project (a converted
 * copy), each definition is looked up on its own.
 */
function usesLegacyVariantClass(state: ProjectState, def: ComponentDefinition): boolean {
  if (isTracked(state) && state.components[def.id] === def) return derived(state, 'legacyVariantClass', legacyVariantClassUsers).includes(def.id);
  return legacyVariantClassUser(state, def);
}
const legacyVariantClassUsers = (state: ProjectState) => sortedDefs(state).flatMap((def) => (legacyVariantClassUser(state, def) ? [def.id] : []));
function legacyVariantClassUser(state: ProjectState, def: ComponentDefinition): boolean {
  const prefix = `so-${defKey(def.id)}--`;
  return Object.values(state.components).some((d) => d.id !== def.id && d.kind === 'code' && !!d.source?.includes(prefix));
}
/** Code converted in the first format still places this component with a single `variant` attribute. */
function hasLegacyVariantCaller(state: ProjectState, def: ComponentDefinition): boolean {
  if (isTracked(state) && state.components[def.id] === def) return derived(state, 'legacyVariantCaller', legacyVariantCallees).includes(def.id);
  return legacyVariantCallee(state, def);
}
const legacyVariantCallees = (state: ProjectState) => sortedDefs(state).flatMap((def) => (legacyVariantCallee(state, def) ? [def.id] : []));
function legacyVariantCallee(state: ProjectState, def: ComponentDefinition): boolean {
  const file = `/${defFile(def).split('/').pop()}`;
  return Object.values(state.components).some((d) => d.id !== def.id && d.kind === 'code' && !!d.source?.includes(file) && /\bvariant=/.test(d.source));
}
/** The prop a component receives an axis's selected option through. */
const variantProp = (axis: string) => `variant_${safeIdent(axis)}`;
export function overrideClass(instanceId: string, partId: string): string {
  return `so-o-${instanceId}-${partId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}
/**
 * The class an inner part of a code component placed in a design takes (through `so_o`) for that design's override:
 * node IDs recur across designs (a copy keeps them), so the design names it too.
 */
/**
 * The class an inner part of a managed component placed in a design takes (through `so_o`) for that design's state
 * rules on it (see nestedStateMarker). Hashed, so no two placements' parts share one however their IDs run together.
 */
export function nestedStateClass(owner: ComponentDefinition, instanceId: string, partId: string): string {
  return `so-os-${sha256Hex(JSON.stringify([owner.id, instanceId, partId])).slice(0, 16)}`;
}
export function nestedOverrideClass(owner: ComponentDefinition, instanceId: string, partId: string): string {
  return `so-o-${defKey(owner.id)}--${instanceId}-${partId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}
export function pageNodeClass(nodeId: string): string {
  return `so-n-${nodeId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * A managed definition's node, nested-override and variant rules. `standalone` emits them for a component's own
 * <style> block: selectors are global (the class prefix already makes them unique, and parts rendered by child
 * components must match). Specificity matches components.css, so variant rules still beat node rules at every
 * range; site.css gives code-component overrides one more class so they win wherever this stylesheet lands.
 */
function definitionRules(state: ProjectState, def: ComponentDefinition, standalone = false): RuleSet {
  const rules = newRules();
  if (!def.tree) return rules;
  const wrap = (sel: string) => (standalone ? `:global(${sel})` : sel);
  for (const id of Object.keys(def.tree.nodes).sort()) {
    const n = def.tree.nodes[id];
    addRules(rules, `.${nodeClass(def, id)}`, n.styles, { link: n.kind === 'link', wrap, gateHides: standalone ? shownMark(def) : undefined });
    if (n.kind === 'instance' && n.overrides) addOverrideRules(rules, state, def, n, `.${nodeClass(def, id)}`, wrap);
  }
  const axes = axesOf(def);
  const legacy = usesLegacyVariantClass(state, def);
  axes.forEach(([axis, a], index) => {
    for (const vid of Object.keys(a.options).sort()) {
      const v = a.options[vid];
      const vc = legacy ? `:is(.${variantClass(def, axis, vid)}, .so-${defKey(def.id)}--${vid})` : `.${variantClass(def, axis, vid)}`;
      for (const nid of Object.keys(v.styles ?? {}).sort()) {
        // Styles for a node the tree no longer has match nothing, and a stray key must never reach a selector.
        if (!Object.hasOwn(def.tree!.nodes, nid)) continue;
        const rootId = def.tree!.rootIds[0];
        // The option's class and the node's, on the node itself: variant rules beat node rules and lose to overrides.
        // First-format code's one-class names are only ever on a root.
        const sel = nid === rootId ? `${vc}.${nodeClass(def, nid)}` : `.${variantClass(def, axis, vid)}.${nodeClass(def, nid)}`;
        // An axis earlier in the cascade may be what hides this node, so showing it again has to undo that too.
        const earlier = axes.slice(0, index).flatMap(([, x]) => Object.values(x.options).flatMap((o) => (o.styles?.[nid] ? [o.styles[nid]] : [])));
        const opts = { link: def.tree!.nodes[nid]?.kind === 'link', wideColumns: true, unhide: unhider(def, nid, null, v.styles![nid], earlier), wrap, gateHides: standalone ? shownMark(def) : undefined };
        addRules(rules, sel, v.styles![nid], opts);
        // First-format converted code marks only its root with the option, so its nodes are still matched through
        // the root, except a node that carries option classes of its own: one of a placement inside it.
        // Its state rules stay on the node's own classes: through the root they would also reach a copy nested inside.
        if (legacy && nid !== rootId) {
          const own = Object.keys(a.options).sort().map((o) => `.${variantClass(def, axis, o)}`).join(', ');
          addRules(rules, `${vc} .${nodeClass(def, nid)}:not(:where(${own}))`, v.styles![nid], { ...opts, stateSelector: null });
        }
      }
    }
  });
  return rules;
}

/** The class a panel kept in the page takes while its component's state hides it (see stateWidgets). */
export const STATE_OFF_CLASS = 'so-state-off';
/** The class an item of a list takes while its category filter hides it (see FilterGen). */
export const FILTER_OFF_CLASS = 'so-filter-off';

/**
 * The screen-only hiding and print rules of category filters (see FilterGen), as generated CSS: the items a filter
 * hides, its buttons, which print leaves out, and its status, read out but not shown, whatever the theme's own CSS has.
 * `global` for a component's own <style> block, where an item a helper renders (a card's link) is outside its scope.
 */
function filterCss(global = false): string {
  const g = (sel: string) => (global ? `:global(${sel})` : sel);
  return [
    `/* Items a list's category filter hides on screen, its buttons, which print leaves out, and its status, read out only. */`,
    `@media not print {\n\t${g(`.${FILTER_OFF_CLASS}:not(#so-print)`)} { display: none !important; }\n}`,
    `@media print {\n\t${g('.so-filter:not(#so-print)')} { display: none !important; }\n}`,
    `${g('.so-filter__status')} { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }`
  ].join('\n');
}

/** Whether a design has a dialog or drawer that works (see stateWidgets). */
function hasOverlays(def: ComponentDefinition): boolean {
  return def.kind === 'managed' && !!def.tree && Object.values(def.tree.nodes).some((n) => n?.kind === 'element' && n.overlay !== undefined && !overlayProblem(def, n));
}

/**
 * Components' dialogs and drawers (see emitOverlay), whatever the theme's own CSS has: hidden while closed, whatever
 * display their own styles give them; the page behind an open one held still, its scrollbar's room kept so nothing
 * moves; each one along its edge or in the middle (start and end follow the text's direction), scrolling inside
 * itself; and none printed, open or closed, nor the backdrop. Placed sizes stay the design's own (zero specificity).
 */
const OVERLAY_CSS = `/* Components' dialogs and drawers. */
@media not print {
\tdialog.so-overlay:not([open]):not(#so-print) { display: none !important; }
\thtml:has(dialog.so-overlay) { scrollbar-gutter: stable; }
\thtml:has(dialog.so-overlay:modal) { overflow: hidden; }
}
:where(dialog.so-overlay:modal) { box-sizing: border-box; max-width: calc(100vw - 2rem); max-height: calc(100vh - 2rem); max-height: calc(100dvh - 2rem); overflow: auto; overscroll-behavior: contain; }
:where(dialog.so-overlay--drawer-start:modal, dialog.so-overlay--drawer-end:modal) { width: min(26rem, 100vw - 3rem); max-width: none; height: 100vh; height: 100dvh; max-height: none; margin-block: 0; }
:where(dialog.so-overlay--drawer-start:modal) { margin-inline: 0 auto; }
:where(dialog.so-overlay--drawer-end:modal) { margin-inline: auto 0; }
:where(dialog.so-overlay--drawer-bottom:modal) { width: 100%; max-width: none; max-height: 85vh; max-height: 85dvh; margin: auto 0 0; }
@media print {
\tdialog.so-overlay:not(#so-print), dialog.so-overlay:not(#so-print)::backdrop { display: none !important; }
}`;

export function generateComponentsCss(state: ProjectState): string {
  const parts: string[] = ['/* Component definition styles. Generated from siteorigin/components. */'];
  // A tab's panel while another tab is chosen, or a closed disclosure's content, stays in the page hidden on screen
  // only, so printing shows it with its own layout. An id no element has (#so-print) outweighs a placement's styles.
  if (sortedDefs(state).some((def) => def.kind === 'managed' && stateLocals(def).size))
    parts.push(`/* Content a component's state hides on screen. */\n@media not print {\n\t.${STATE_OFF_CLASS}:not(#so-print) { display: none !important; }\n}`);
  if (sortedDefs(state).some(hasOverlays)) parts.push(OVERLAY_CSS);
  // Items a list's category filter hides stay in the page, hidden on screen only, so printing shows them all; the
  // row of category buttons is left out of print.
  if (sortedDefs(state).some((def) => def.kind === 'managed' && repeatFilters(def).length)) parts.push(filterCss());
  for (const def of sortedDefs(state)) {
    if (def.kind !== 'managed' || !def.tree) continue;
    const css = emitRules(definitionRules(state, def));
    if (css) parts.push(`/* ${inComment(def.name)} (${inComment(def.id)}) */\n${css}`);
  }
  return parts.join('\n\n') + '\n';
}

/**
 * Overrides set on an instance that sits inside a definition (`owner`) use descendant selectors from the nested
 * instance root; a code component's inner parts take classes of the design's own instead.
 */
function addOverrideRules(rules: RuleSet, state: ProjectState, owner: ComponentDefinition, inst: InstanceNode, rootSelector: string, wrap = (sel: string) => sel) {
  const def = state.components[inst.definitionId];
  if (!def) return;
  for (const partId of Object.keys(inst.overrides ?? {}).sort()) {
    const part = def.parts[partId];
    // An override for a part the definition no longer declares styles nothing.
    if (partId !== 'root' && !part) continue;
    // A code component's own styles are scoped, so its inner parts are reached only by the classes it is given.
    if (def.kind === 'code' && partId !== 'root') {
      const cls = nestedOverrideClass(owner, inst.id, partId);
      addRules(rules, `.${cls}.${cls}.${cls}`, inst.overrides![partId], { ...overrideOpts(state, def, inst, partId), wrap });
      continue;
    }
    // Doubled root selector: nested overrides must beat the nested definition's variant rules.
    const isRoot = partId === 'root' || !part || part.nodeId === def.tree?.rootIds[0];
    const sel = isRoot ? `${rootSelector}${rootSelector}${rootSelector}` : `${rootSelector}${rootSelector} .${nodeClass(def, part.nodeId)}`;
    // An inner part is reached through the placement's root, which also reaches that part in a copy of the component
    // placed inside this one (in its slot). Its state rules name the class the part takes for this override instead,
    // as strong as the resting rule.
    const marker = nestedStateMarker(owner, def, inst, partId);
    addRules(rules, sel, inst.overrides![partId], { ...overrideOpts(state, def, inst, partId), wrap, ...(marker ? { stateSelector: `.${marker}`.repeat(3) } : {}) });
  }
}

/**
 * The class an inner part of a managed component placed in a design takes (through `so_o`) for the design's state
 * rules on it: none for its root, which the design's own class reaches directly, or a part with no state rules.
 */
function nestedStateMarker(owner: ComponentDefinition, def: ComponentDefinition, inst: InstanceNode, partId: string): string | undefined {
  if (def.kind !== 'managed' || partId === 'root' || !Object.hasOwn(def.parts, partId) || def.parts[partId].nodeId === def.tree?.rootIds[0]) return undefined;
  return hasStateStyles(inst.overrides?.[partId]) ? nestedStateClass(owner, inst.id, partId) : undefined;
}

/**
 * Whether a placement's part is something a code component renders: its own part, or a code component placed as it,
 * directly or as the root of the designs placed there.
 */
function stylesCode(state: ProjectState, def: ComponentDefinition, partId: string): boolean {
  if (def.kind === 'code') return true;
  let target = def.tree?.nodes[def.parts[partId]?.nodeId ?? def.tree.rootIds[0]];
  for (const seen = new Set<string>(); target?.kind === 'instance' && !seen.has(target.definitionId); ) {
    seen.add(target.definitionId);
    const inner = state.components[target.definitionId];
    if (inner?.kind === 'code') return true;
    target = inner?.tree?.nodes[inner.tree.rootIds[0]];
  }
  return false;
}

function overrideOpts(state: ProjectState, def: ComponentDefinition, inst: InstanceNode, partId: string): RuleOpts {
  const nodeId = def.parts[partId]?.nodeId ?? def.tree?.rootIds[0] ?? '';
  return {
    link: def.tree?.nodes[nodeId]?.kind === 'link',
    wideColumns: true,
    unhide: unhider(def, nodeId, inst.variants, inst.overrides?.[partId] ?? {}),
    important: stylesCode(state, def, partId)
  };
}

/**
 * An item's own rule is stronger than the part's design and shared rules, so a display it sets (its layout) would
 * also show it where those hide every item. In each size range where a weaker layer hides the part and the item says
 * nothing about its own visibility, the item stays hidden too.
 */
export function keepWeakerHides(def: ComponentDefinition, inst: InstanceNode, partId: string, own: ResponsiveStyles): ResponsiveStyles {
  const nodeId = def.parts[partId].nodeId;
  const layers = [def.tree?.nodes[nodeId]?.styles, ...selectedVariantStyles(def, inst.variants, nodeId), inst.overrides?.[partId]].filter(Boolean) as ResponsiveStyles[];
  // What the weaker rules end on in a range, in cascade order: a hide, or a display that shows the part. Hides are
  // read folded, as the stylesheet writes them (see resolveVisibility); an explicit show writes a display of its own
  // (see unhider), and so does a layout. Within one rule visibility has the last word.
  const hiddenAt = (range: Exclude<ResponsiveScope, 'base'>) => {
    let hidden = false;
    for (const raw of layers) {
      const folded = resolveVisibility(raw);
      for (const s of ['base', range] as const) {
        if (folded[s]?.hidden === true) hidden = true;
        else if (raw[s]?.hidden === false || raw[s]?.layout !== undefined) hidden = false;
      }
    }
    return hidden;
  };
  let out = own;
  for (const range of ['phone', 'tablet', 'desktop'] as const) {
    if (!hiddenAt(range) || own.base?.hidden !== undefined || own[range]?.hidden !== undefined) continue;
    if (out === own) out = structuredClone(own);
    out[range] = { ...(out[range] ?? {}), hidden: true };
  }
  return out;
}

/**
 * Rule options for one item's styles: what it shows again undoes the definition, variants and shared override. A part
 * that is a code component placed in the design takes them as important, as its shared override does.
 */
function itemOverrideOpts(state: ProjectState, def: ComponentDefinition, inst: InstanceNode, partId: string, own: ResponsiveStyles): RuleOpts {
  const nodeId = def.parts[partId].nodeId;
  return {
    link: def.tree?.nodes[nodeId]?.kind === 'link',
    wideColumns: true,
    unhide: unhider(def, nodeId, inst.variants, own, [], inst.overrides?.[partId] ? [inst.overrides[partId]] : []),
    important: stylesCode(state, def, partId)
  };
}

function treeOwners(state: ProjectState): Array<{ owner: OwnerRef; tree: NodeTree }> {
  const out: Array<{ owner: OwnerRef; tree: NodeTree }> = [
    { owner: { kind: 'shell', id: 'header' }, tree: state.site.shell.header },
    { owner: { kind: 'shell', id: 'footer' }, tree: state.site.shell.footer }
  ];
  for (const id of state.site.pageOrder) if (state.pages[id]) out.push({ owner: { kind: 'page', id }, tree: state.pages[id] });
  // Each collection's layout, whose elements style every entry's page; its node IDs are its own (see themeArticleTemplate).
  for (const id of Object.keys(state.collections ?? {}).sort()) {
    const t = state.collections[id]?.settings?.template;
    if (t?.nodes && typeof t.nodes === 'object') out.push({ owner: { kind: 'template', id }, tree: t });
  }
  return out;
}

export function generateSiteCss(state: ProjectState): string {
  const rules = newRules();
  for (const { tree } of treeOwners(state)) {
    for (const id of Object.keys(tree.nodes).sort()) {
      const n = tree.nodes[id];
      if (n.kind === 'instance') {
        const def = state.components[n.definitionId];
        for (const partId of Object.keys(n.overrides ?? {}).sort()) {
          if (!def) continue;
          const cls = overrideClass(n.id, partId);
          // A code component's own styles are scoped (one class plus Svelte's hash class), so its overrides
          // take one more class to win whatever order the stylesheets load in.
          // A part that is itself a nested instance also carries its definition's three-class override rule.
          const target = def.tree?.nodes[def.parts[partId]?.nodeId ?? def.tree.rootIds[0]];
          const sel = target?.kind === 'instance' ? `.${cls}.${cls}.${cls}.${cls}` : def.kind === 'code' ? `.${cls}.${cls}.${cls}` : `.${cls}.${cls}`;
          addRules(rules, sel, n.overrides![partId], overrideOpts(state, def, n, partId));
        }
        for (const partId of Object.keys(n.itemOverrides ?? {}).sort()) {
          const entry = liveItemStyles(def, n, partId);
          if (!entry) continue;
          const target = def!.tree!.nodes[def!.parts[partId].nodeId];
          // One class more than the part's shared override, so an item's own value wins over it at every size.
          const times = target?.kind === 'instance' ? 5 : 3;
          for (const itemId of Object.keys(entry.items).sort()) {
            const cls = itemOverrideClass(n.id, partId, itemId);
            const own = entry.items[itemId];
            // A hand-edited record that holds no styles writes nothing (validation reports it).
            if (!own || typeof own !== 'object') continue;
            addRules(rules, `.${cls}`.repeat(times), keepWeakerHides(def!, n, partId, own), itemOverrideOpts(state, def!, n, partId, own));
          }
        }
      } else {
        addRules(rules, `.${pageNodeClass(id)}`, n.styles, { link: n.kind === 'link' });
      }
    }
  }
  // The entrance rules, while the site has entrances: they only ever animate what the entrance observer arms.
  const appear = derived(state, 'usesAppear', usesAppear) ? `\n${APPEAR_CSS}` : '';
  // The visitor's Light/Dark switch, while the site has one.
  const toggle = usesThemeToggle(state) ? `\n${THEME_TOGGLE_CSS}` : '';
  return `/* Page content styles and instance overrides. Generated from siteorigin/pages and siteorigin/site.json. */\n${emitRules(rules)}\n${appear}${toggle}`;
}

/** The cards that must render as their plain container, in a stable order so an unchanged answer compares equal. */
export const sortedBrokenCards = (state: ProjectState) => [...brokenCardKeys(state)].sort();

function sortedDefs(state: ProjectState): ComponentDefinition[] {
  return Object.values(state.components).sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Markup emission
// ---------------------------------------------------------------------------

interface EmitCtx {
  state: ProjectState;
  file: string;
  imports: Map<string, string>; // import name -> path
  instrument: boolean;
  /** Definition being emitted, or null for page/shell trees. */
  def: ComponentDefinition | null;
  tree: NodeTree;
  /** Expression (definitions) or literal (pages) giving the identity context. */
  ctxExpr: string;
  /** Names of repeat item variables currently in scope (outermost first). */
  items: string[];
  rctx: ResolveContext;
  indent: number;
  /** Property name -> local variable (definitions only). */
  locals: Map<string, string>;
  /** Page-level: the root currently emitted is the first section of the page. */
  firstSection?: boolean;
  /** Set when the markup refers to the per-instance `uid` from `$props.id()`. */
  usesUid?: boolean;
  /** Editor variants: set when the markup shows something only while editing (`so_editing`, see `editingState`). */
  usesEditing?: boolean;
  /** The isolated preview's editor variant: dialogs and drawers open in their state show in place (GenerateOptions.previewOpen). */
  previewOpen?: boolean;
  /** The list properties of the repeats currently open (outermost first), for the schema of an item field. */
  lists?: PropSchema[];
  /** Cards that render as their plain container because something interactive renders inside them. */
  brokenCards?: Set<string>;
  /** Snippets this file declares, for unique names. */
  snippets?: number;
  /** Parent maps of the trees images are sized through, built once per emit. */
  sizingParents?: Map<NodeTree, Map<string, { id: string; slot?: string }>>;
  /** The repeats currently open (outermost first), by node ID, beside `items`. */
  repeats?: string[];
  /** Whether the tree has an element with an action, and each node's parent, worked out once per file. */
  actions?: boolean;
  parents?: Map<string, string>;
  /** The direct children of the repeat being emitted, while it staggers its items' entrances (`appearStagger`). */
  staggered?: Set<string>;
  /**
   * A design written as a code component of its own (generateStandaloneComponent): its root shows the entrance its one
   * placement chose (`appear`, or the design's own while that is unset), written in, since code takes none.
   */
  standalone?: { appear?: AppearPreset | 'none' };
  /** The definition's UI state, by name, with the `$state` local each one lives in (definitions only). */
  states?: Map<string, UiStateLocal>;
  /** The tab lists, disclosures and choice buttons the design's state makes (see stateWidgets). */
  widgets?: StateWidgets;
  /** The design's working category filters (see repeatFilters). */
  filters?: FilterGen[];
}

/** One UI state variable of the definition being emitted: the local holding it and its well-formed declaration. */
interface UiStateLocal {
  local: string;
  schema: UiStateSchema;
  /** An enum's values in order, which `next` and `prev` step through; empty for a yes/no state. */
  values: string[];
}

/**
 * A definition's UI state the generated component can hold, by name: each well-formed declaration (as validation
 * judges it), in a `$state` local of its own (`so_state_<name>`, a prefix no property's local takes). A declaration a
 * hand edit damaged is left out, and reads of it show the value it starts at, as validation reports it.
 */
function stateLocals(def: ComponentDefinition): Map<string, UiStateLocal> {
  const out = new Map<string, UiStateLocal>();
  if (def.kind !== 'managed' || !def.state || typeof def.state !== 'object' || Array.isArray(def.state)) return out;
  for (const name of Object.keys(def.state).sort()) {
    const schema = declaredState(def, name);
    if (schema) out.set(name, { local: `so_state_${name}`, schema, values: schema.type === 'enum' ? schema.options.map((o) => o.value) : [] });
  }
  return out;
}

/**
 * What a button's click does to the state, as an event handler, or null when the action names state the design
 * cannot hold or a change that state cannot make (validation reports both). A button that opens a dialog or drawer
 * also notes itself as the one to give the focus back to when it closes.
 */
function stateActionHandler(ctx: EmitCtx, action: StateAction | undefined, opens?: OverlayGen): string | null {
  const s = ctx.def ? actionState(ctx.def, ctx.states, action) : null;
  if (!action || !s) return null;
  let change: string;
  switch (action.op) {
    case 'toggle':
      change = `${s.local} = !${s.local}`;
      break;
    case 'set':
      change = `${s.local} = ${js(action.value)}`;
      break;
    default:
      useImport(ctx, '{ stepState }', `${RUNTIME_DIR}/util.js`);
      change = `${s.local} = stepState(${js(s.values)}, ${s.local}, ${action.op === 'next' ? 1 : -1}, ${action.wrap === true})`;
  }
  return opens ? `(event) => {\n${pad(ctx)}\t${opens.opener} = event.currentTarget;\n${pad(ctx)}\t${change};\n${pad(ctx)}}` : `() => (${change})`;
}

/**
 * The state a button's action changes, when the design holds that state and validation accepts the action (an action
 * a hand edit damaged does nothing, as validation reports it).
 */
function actionState(def: ComponentDefinition, states: Map<string, UiStateLocal> | undefined, action: unknown): UiStateLocal | null {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const name = (action as { state?: unknown }).state;
  const s = typeof name === 'string' ? states?.get(name) : undefined;
  return s && !stateActionProblem(def, action) ? s : null;
}

/**
 * Whether a button's state action works in the generated site: the design holds the state and the action is one it can
 * make. Such a button renders even with nowhere to go, as a real button (the checks use this to tell).
 */
export function stateActionWorks(def: ComponentDefinition | null | undefined, action: unknown): boolean {
  return !!def && action !== undefined && !!actionState(def, stateLocals(def), action);
}

/** A panel kept in the page while its state hides it: the state and the value it shows for, and its tab in a tab list. */
interface StatePanel {
  state: string;
  shows: boolean | string;
  tab?: string;
}
/** What a button that changes state, and goes nowhere, tells assistive technology about what it does. */
type StateButton =
  | { role: 'tab'; state: string; value: string; panel: string }
  | { role: 'disclosure'; state: string; open: boolean; panels: string[] }
  | { role: 'pressed'; state: string; value: boolean | string }
  | { role: 'dialog'; state: string; overlay: string };
/**
 * A container shown over the page as a dialog or drawer (ElementNode.overlay): the yes/no state that opens it and the
 * value it is open at, how it shows, and the locals holding its <dialog>, the button that last opened it and (in the
 * editor's variant) its content, rendered in one of two places.
 */
interface OverlayGen {
  state: string;
  shows: boolean;
  mode: OverlayMode;
  dialog: string;
  opener: string;
  snippet: string;
}
interface StateWidgets {
  panels: Map<string, StatePanel>;
  /** Tab lists, by node ID: the state their tabs choose. */
  lists: Map<string, string>;
  buttons: Map<string, StateButton>;
  /** Dialogs and drawers, by node ID. */
  overlays: Map<string, OverlayGen>;
}

/**
 * The accessible patterns a design's state makes, worked out once per definition from the shape of its tree:
 *
 * - A tab list: a plain \`div\` whose children are exactly one "set" button for each option of a choice, with a plain
 *   \`div\` for each option elsewhere that shows only while that option is chosen (its one condition). The panels stay in
 *   the page, hidden on screen while another tab is chosen, so every tab's \`aria-controls\` finds its panel and printing
 *   shows them all.
 * - A disclosure: a button that toggles a yes/no state, and the elements that show only while it is on (or, failing
 *   those, only while it is off). They stay in the page the same way, and the button says whether they are expanded.
 * - A dialog or drawer: a plain \`div\` shown by a yes/no state that works as one (see overlayProblem). It stays in the
 *   page, closed, so its buttons always find it and what is inside it is rendered once too. A button outside it that
 *   toggles the state, or sets it to the value that shows it, opens it and says so; one inside it (a close button) is a
 *   command.
 * - Anything else that sets a state to one value says whether it is pressed (the state has that value), and a toggle
 *   with nothing to disclose likewise; next and previous buttons are commands.
 *
 * Only buttons that go nowhere take part (a link that also changes state stays a link), and only content rendered once
 * per placement: not inside a list or in content handed to a nested component's slot, which may show it more than once,
 * where one ID could not name it. Such content keeps its condition, so it is simply shown and hidden.
 */
function stateWidgets(ctx: EmitCtx): StateWidgets {
  const out: StateWidgets = { panels: new Map(), lists: new Map(), buttons: new Map(), overlays: new Map() };
  const def = ctx.def;
  const tree = def?.tree;
  if (!def || !tree || !ctx.states?.size) return out;
  const roots = new Set(tree.rootIds);
  // Rendered once per placement and whenever the placement is: reached from a root through elements alone, none of
  // them (below the root) shown only on a condition or rendered by a runtime helper. Content under a condition could
  // be missing while its tab or button is there, leaving a reference to nothing.
  const once = new Set<string>();
  const parent = new Map<string, string>();
  const reach = (id: string) => {
    const n = tree.nodes[id];
    if (!n || once.has(id)) return;
    once.add(id);
    if (n.kind !== 'element' || (!roots.has(id) && (n.when || n.unless)) || rendersAsCard(ctx, n) || isCarouselTrack(n)) return;
    for (const c of n.children) {
      if (!parent.has(c)) parent.set(c, id);
      reach(c);
    }
  };
  tree.rootIds.forEach(reach);
  // A dialog or drawer is always in the page, once (overlayProblem rules out every way it could not be), and so is what
  // is inside it.
  const hosts = Object.values(tree.nodes)
    .filter((n): n is GraphNode & { kind: 'element'; overlay: OverlayMode } => !!n && typeof n === 'object' && n.kind === 'element' && n.overlay !== undefined && once.has(n.id) && !overlayProblem(def, n))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  hosts.forEach((n, i) => {
    const g = booleanStateGuard(def, n)!;
    out.overlays.set(n.id, { state: g.state, shows: g.shows, mode: n.overlay, dialog: `so_dialog_${i + 1}`, opener: `so_opener_${i + 1}`, snippet: `so_overlay_${i + 1}` });
    for (const c of n.children) {
      if (!parent.has(c)) parent.set(c, n.id);
      reach(c);
    }
  });
  /** What a node's one condition shows it for: a yes/no state's value or one option of a choice; null for anything else. */
  const guard = (n: GraphNode): { state: string; shows: boolean | string } | null => {
    if (!n.when === !n.unless) return null;
    const c = (n.when ?? n.unless) as Condition;
    const negate = !n.when;
    const ref = conditionRef(c);
    const state = isStateRef(ref) ? ref.$state : '';
    const s = ctx.states!.get(state);
    if (!s) return null;
    if (isComparison(c)) {
      const equal = 'eq' in c !== negate;
      const value = 'eq' in c ? c.eq : c.ne;
      if (s.schema.type === 'boolean') return typeof value === 'boolean' ? { state, shows: equal ? value : !value } : null;
      return equal && typeof value === 'string' && s.values.includes(value) ? { state, shows: value } : null;
    }
    return s.schema.type === 'boolean' ? { state, shows: !negate } : null;
  };
  /**
   * Content that can stay in the page hidden: rendered once, always in the page itself (not collapsing), and not a
   * runtime helper's host. A tab list and its panels are plain elements of \`tag\` without an anchor of their own
   * (which two placements would share, where a tab and its panel must name each other); a disclosure's content may
   * also be plain text, and keeps an anchor, though its button names only the content without one.
   */
  const panelHost = (n: GraphNode | undefined, tag?: string): n is GraphNode & { kind: 'element' | 'text' } => {
    // One marked as a dialog or drawer that cannot be one stays an ordinary container with its condition: in the page
    // only while it shows (a kept panel would print what it holds).
    if (!n || !once.has(n.id) || roots.has(n.id) || (tag && n.anchor) || (n as { overlay?: unknown }).overlay !== undefined) return false;
    if (n.kind === 'text') return !tag && !n.rich;
    return n.kind === 'element' && !n.collapseEmpty && !rendersAsCard(ctx, n) && !isCarouselTrack(n) && (tag ? isBareTag(ctx, n, tag) : true);
  };
  /** A button that changes state and goes nowhere: always a real button. */
  const stateButton = (n: GraphNode): n is GraphNode & { kind: 'link'; stateAction: StateAction } =>
    n.kind === 'link' && !!actionState(def, ctx.states, n.stateAction) && !isBinding(n.link) && !resolveLink(n.link as LinkValue, ctx.rctx);
  const nodes = Object.values(tree.nodes).filter((n): n is GraphNode => !!n && typeof n === 'object');
  const guarded = nodes.map((n) => ({ n, g: guard(n) })).filter((x): x is { n: GraphNode; g: { state: string; shows: boolean | string } } => !!x.g);
  const insidePanel = (id: string, panels: Set<string>) => {
    for (let at = parent.get(id), seen = 0; at && seen < 1000; at = parent.get(at), seen++) if (panels.has(at)) return true;
    return false;
  };
  // Every node's container, slot content included, to tell a button inside a dialog from one outside it.
  const within = new Map<string, string>();
  for (const n of nodes) {
    const lists = n.kind === 'element' || n.kind === 'repeat' ? [n.children] : n.kind === 'instance' ? Object.values(n.slots ?? {}) : [];
    for (const list of lists) if (Array.isArray(list)) for (const c of list) within.set(c, n.id);
  }
  const inside = (id: string, host: string) => {
    for (let at = within.get(id), seen = 0; at && seen < 1000; at = within.get(at), seen++) if (at === host) return true;
    return false;
  };
  for (const [name, s] of [...ctx.states].sort(([a], [b]) => a.localeCompare(b))) {
    const buttons = nodes.filter((n) => stateButton(n) && n.stateAction.state === name) as Array<GraphNode & { kind: 'link'; stateAction: StateAction }>;
    const overlay = [...out.overlays].find(([, o]) => o.state === name);
    if (overlay) {
      const [host, o] = overlay;
      for (const b of buttons) {
        const a = b.stateAction;
        if (!inside(b.id, host) && (a.op === 'toggle' || (a.op === 'set' && a.value === o.shows))) out.buttons.set(b.id, { role: 'dialog', state: name, overlay: host });
      }
      continue;
    }
    if (s.schema.type === 'enum') {
      // One list whose children are exactly one unconditional "set" button per option, all rendered once.
      const setters = buttons.filter((b) => b.stateAction.op === 'set' && once.has(b.id) && !b.when && !b.unless && !b.anchor);
      const lists = [...new Set(setters.map((b) => parent.get(b.id)).filter((p): p is string => !!p))].filter((id) => {
        const list = tree.nodes[id];
        if (!panelHost(list, 'div') || list.kind !== 'element' || list.when || list.unless || list.children.length !== s.values.length) return false;
        const values = list.children.map((c) => setters.find((b) => b.id === c)?.stateAction).map((a) => (a?.op === 'set' ? a.value : undefined));
        return s.values.every((v) => values.includes(v));
      });
      const list = lists.length === 1 ? (tree.nodes[lists[0]] as GraphNode & { kind: 'element' }) : null;
      const panels = list ? s.values.map((v) => guarded.filter(({ n, g }) => g.state === name && g.shows === v && panelHost(n, 'div')).map(({ n }) => n.id)) : [];
      const ids = new Set(panels.flat());
      if (list && panels.every((p) => p.length === 1) && !insidePanel(list.id, ids)) {
        out.lists.set(list.id, name);
        for (const c of list.children) {
          const value = (tree.nodes[c] as LinkNode).stateAction!.op === 'set' ? ((tree.nodes[c] as LinkNode).stateAction as { value: string }).value : '';
          const panel = panels[s.values.indexOf(value)][0];
          out.buttons.set(c, { role: 'tab', state: name, value, panel });
          out.panels.set(panel, { state: name, shows: value, tab: c });
        }
      }
      for (const b of buttons) if (b.stateAction.op === 'set' && !out.buttons.has(b.id)) out.buttons.set(b.id, { role: 'pressed', state: name, value: (b.stateAction as { value: string }).value });
      continue;
    }
    const toggles = buttons.filter((b) => b.stateAction.op === 'toggle');
    if (!toggles.length) continue;
    const hosts = (open: boolean) => guarded.filter(({ n, g }) => g.state === name && g.shows === open && panelHost(n)).map(({ n }) => n.id);
    const open = hosts(true).length ? true : hosts(false).length ? false : null;
    const panels = open === null ? [] : hosts(open);
    for (const p of panels) out.panels.set(p, { state: name, shows: open! });
    // All of the content stays in the page together, so a jump from one part to another works once it shows.
    const named = panels.filter((p) => !tree.nodes[p]?.anchor);
    for (const b of toggles) out.buttons.set(b.id, open === null ? { role: 'pressed', state: name, value: true } : { role: 'disclosure', state: name, open, panels: named });
  }
  return out;
}

/**
 * The nodes of a design kept in the page while its UI state hides them (see stateWidgets), closed dialogs and drawers
 * included: markup the page holds besides what the state shows at first, for the checks that read what a page ships.
 */
export function keptPanels(state: ProjectState, def: ComponentDefinition, memo: { brokenCards?: Set<string> } = {}): ReadonlySet<string> {
  const states = def.kind === 'managed' && def.tree ? stateLocals(def) : new Map<string, UiStateLocal>();
  if (!states.size) return new Set();
  // \`memo\` carries the site's card analysis from one definition to the next within a check.
  const ctx: EmitCtx = { state, file: defFile(def), imports: new Map(), instrument: false, def, tree: def.tree!, ctxExpr: '', items: [], rctx: { state }, indent: 0, locals: propLocals(def), states, brokenCards: memo.brokenCards };
  const widgets = stateWidgets(ctx);
  memo.brokenCards = ctx.brokenCards;
  return new Set([...widgets.panels.keys(), ...widgets.overlays.keys()]);
}

/** Whether an element always renders as \`tag\` (no property chooses its tag). */
function isBareTag(ctx: EmitCtx, node: GraphNode & { kind: 'element' }, tag: string): boolean {
  const { tags } = tagChoices(ctx, node);
  return tags.length === 1 && tags[0] === tag;
}

/**
 * The ID a tab or panel is named by, unique to the placement from \`$props.id()\`. The dots keep it apart from the
 * IDs a placement's headings take (\`uid-node\`).
 */
function widgetId(ctx: EmitCtx, nodeId: string, role: 'tab' | 'panel' | 'dialog'): string {
  ctx.usesUid = true;
  return `\`\${uid}.${role}.${nodeId.replace(/[^A-Za-z0-9_-]/g, '_')}\``;
}

/** A state's local compared with a value, as an expression. */
function stateIs(ctx: EmitCtx, state: string, value: boolean | string): string {
  const local = ctx.states!.get(state)!.local;
  return value === true ? local : value === false ? `!${local}` : `${local} === ${js(value)}`;
}

/** The ARIA a button that changes state takes, from its part in the design (see stateWidgets). */
function stateButtonAttrs(ctx: EmitCtx, node: GraphNode & { kind: 'link' }): string {
  const role = ctx.widgets?.buttons.get(node.id);
  if (!role) return '';
  switch (role.role) {
    case 'tab': {
      useImport(ctx, '{ tabKey }', `${RUNTIME_DIR}/util.js`);
      const chosen = stateIs(ctx, role.state, role.value);
      const id = ` id={${widgetId(ctx, node.id, 'tab')}}`;
      return ` role="tab"${id} aria-selected={${chosen}} aria-controls={${widgetId(ctx, role.panel, 'panel')}} tabindex={${chosen} ? 0 : -1} onkeydown={tabKey}`;
    }
    case 'disclosure': {
      const ids = role.panels.map((p) => widgetId(ctx, p, 'panel'));
      const controls = !ids.length ? '' : ` aria-controls={${ids.length === 1 ? ids[0] : `[${ids.join(', ')}].join(' ')`}}`;
      return ` aria-expanded={${stateIs(ctx, role.state, role.open)}}${controls}`;
    }
    case 'pressed':
      return ` aria-pressed={${stateIs(ctx, role.state, role.value)}}`;
    case 'dialog': {
      const o = ctx.widgets!.overlays.get(role.overlay)!;
      return ` aria-haspopup="dialog" aria-expanded={${stateIs(ctx, role.state, o.shows)}} aria-controls={${widgetId(ctx, role.overlay, 'dialog')}}`;
    }
  }
}

/**
 * The ARIA of content that is a tab list or kept in the page (see stateWidgets). A tab list is named by its own label,
 * or the state's while that is blank; a tab's panel by its tab, unless it has a label of its own. (A tab list's own
 * label is written here, in place of elementLabelAttrs.)
 */
function stateElementAttrs(ctx: EmitCtx, node: GraphNode & { kind: 'element' | 'text' }): string {
  const own = node.kind === 'element' ? node.ariaLabel : undefined;
  const ownBlank = own === undefined || (!isBinding(own) && !String(own).trim());
  const list = ctx.widgets?.lists.get(node.id);
  if (list) {
    const fallback = js(ctx.states!.get(list)!.schema.label);
    if (ownBlank) return ` role="tablist" aria-label={${fallback}}`;
    if (!isBinding(own)) return ` role="tablist" aria-label=${attrJs(String(own).trim())}`;
    useImport(ctx, '{ has }', `${RUNTIME_DIR}/util.js`);
    const value = bindExpr(ctx, own);
    return ` role="tablist" aria-label={has(${value}) ? ${value} : ${fallback}}`;
  }
  const panel = ctx.widgets?.panels.get(node.id);
  if (!panel) return '';
  // Content with an anchor keeps it as its id (anchorAttr), and no button names it.
  const id = node.anchor ? '' : ` id={${widgetId(ctx, node.id, 'panel')}}`;
  if (!panel.tab) return id;
  const by = widgetId(ctx, panel.tab, 'tab');
  let labelledBy = ` aria-labelledby={${by}}`;
  if (!ownBlank && !isBinding(own)) labelledBy = '';
  else if (!ownBlank) {
    useImport(ctx, '{ has }', `${RUNTIME_DIR}/util.js`);
    labelledBy = ` aria-labelledby={has(${bindExpr(ctx, own)}) ? undefined : ${by}}`;
  }
  // Printed, every panel shows at once, under its tab's label (the tab list itself is left out).
  const tab = ctx.tree.nodes[panel.tab] as LinkNode;
  return `${id} role="tabpanel"${labelledBy} tabindex="0" data-tab-label={${bindExpr(ctx, tab.label)}}`;
}

/**
 * A list's category filter (RepeatNode.filter) as a generated component runs it. Each placement holds the category
 * chosen (`local`, null for All) and works out from its list the items that render, the categories they name, whether
 * the pills show, the category in effect and how many items show, in locals named after it.
 */
interface FilterGen {
  /** The repeat. */
  repeat: RepeatNode;
  /** The element holding the repeat alone, which the pills go just above. */
  host: string;
  local: string;
  field: string;
  /** A choice field's options, as the generated helpers take them; undefined for a text field. */
  options?: Array<{ value: string; label: string }>;
}

/**
 * The design's working category filters, in the order of their repeats' IDs. A filter validation reports
 * (repeatFilterProblem) is left out, so its items render as a plain list, every one showing.
 */
function repeatFilters(def: ComponentDefinition): FilterGen[] {
  // Any design with a tree: a copy being converted to code is generated from its design before it is stored.
  const tree = def.tree;
  if (!tree) return [];
  const out: FilterGen[] = [];
  const parents = parentMap(tree);
  for (const id of Object.keys(tree.nodes).sort()) {
    const n = tree.nodes[id];
    if (n?.kind !== 'repeat' || n.filter === undefined || repeatFilterProblem(def, n)) continue;
    const list = def.properties[n.list.$prop] as ListProp;
    const field = list.fields[n.filter.field];
    out.push({ repeat: n, host: parents.get(n.id)!, local: `so_filter_${out.length}`, field: n.filter.field, options: field.type === 'enum' ? field.options.map((o) => ({ value: o.value, label: o.label })) : undefined });
  }
  return out;
}

/** The helpers' arguments after an item's category: a choice field's options, or none for text. */
const filterOptionsArg = (f: FilterGen) => (f.options ? `, ${js(f.options)}` : '');

/**
 * The script of a design's category filters: per filter, the category chosen (null, All, at first) and what follows
 * from it. Only items that render count: a page list's card whose page has gone names no category and is not counted.
 * The pills show while the filter is on, the repeat renders and its items name two categories or more; otherwise
 * every item shows. A category chosen that no item names any more shows every item, until it is named again.
 */
function filterScript(ctx: EmitCtx): string {
  if (!ctx.filters?.length) return '';
  useImport(ctx, '{ filterCategories }', `${RUNTIME_DIR}/util.js`);
  useImport(ctx, '{ filterKey }', `${RUNTIME_DIR}/util.js`);
  const lines: string[] = [];
  for (const f of ctx.filters) {
    const r = f.repeat;
    const shown = renderCondition(ctx, r, new Set());
    // The items' own conditions, read for each item as the list renders it.
    const listSchema = bindingSchema(ctx, r.list);
    ctx.items.push('item');
    ctx.repeats = [...(ctx.repeats ?? []), r.id];
    ctx.lists = [...(ctx.lists ?? []), ...(listSchema ? [listSchema] : [])];
    const conds = r.children.map((c) => (ctx.tree.nodes[c] ? renderCondition(ctx, ctx.tree.nodes[c], new Set()) : 'false'));
    ctx.items.pop();
    ctx.repeats = ctx.repeats.slice(0, -1);
    if (listSchema) ctx.lists = ctx.lists.slice(0, -1);
    const renders = conds.some((c) => c === null) ? null : conds.join(' || ');
    const rows = `(${bindExpr(ctx, r.list)} ?? [])${renders ? `.filter((item) => ${renders})` : ''}`;
    const on = [r.filter!.when ? conditionExpr(ctx, r.filter!.when, false) : null, `${f.local}_options.length > 1`].filter(Boolean).join(' && ');
    const key = `filterKey(${itemField('item', f.field)}${filterOptionsArg(f)})`;
    lines.push(
      `\tlet ${f.local} = $state(null);`,
      `\tconst ${f.local}_rows = $derived(${shown ? `${shown} ? ${rows} : []` : rows});`,
      `\tconst ${f.local}_options = $derived(filterCategories(${f.local}_rows, ${js(f.field)}${filterOptionsArg(f)}));`,
      `\tconst ${f.local}_on = $derived(${on});`,
      `\tconst ${f.local}_active = $derived(${f.local}_on && ${f.local}_options.some((o) => o.key === ${f.local}) ? ${f.local} : null);`,
      `\tconst ${f.local}_count = $derived(${f.local}_active === null ? ${f.local}_rows.length : ${f.local}_rows.filter((item) => ${key} === ${f.local}_active).length);`
    );
  }
  useImport(ctx, '{ visitorText as so_visitorText }', `${RUNTIME_DIR}/${VISITOR_TEXT_FILE}`);
  // The pills work once the page's script runs: before that (and without it) every item shows and they are disabled.
  lines.push(`\tconst so_text = so_visitorText();`, `\tlet so_filter_ready = $state(false);`, `\t$effect(() => {`, `\t\tso_filter_ready = true;`, `\t});`);
  return lines.join('\n') + '\n';
}

/**
 * The row of category pills a filter shows just above the element holding its repeat: All, then each category its
 * items name, as buttons that say whether they are pressed, and a status saying how many items show, which screen
 * readers announce when it changes. Printed, the row is left out (see generateComponentsCss). In the editor the row
 * also takes the bridge's request to show every item again, so an item the filter hides can be revealed.
 */
function filterBar(ctx: EmitCtx, f: FilterGen, hidden: string | null): string {
  const p = pad(ctx);
  useImport(ctx, '{ fill as so_fill }', `${RUNTIME_DIR}/${VISITOR_TEXT_FILE}`);
  const cls = hidden ? `{['so-filter', ${hidden}]}` : '"so-filter"';
  const editor = ctx.instrument ? ` data-so-filter onsofilterreset={() => (${f.local} = null)}` : '';
  const pill = (pressed: string, set: string, label: string) =>
    `<button type="button" class="so-filter__pill" aria-pressed={${pressed}} disabled={!so_filter_ready} onclick={() => (${f.local} = ${set})}>{${label}}</button>`;
  const option = `${f.local}_option`;
  return [
    `${p}{#if ${f.local}_on}`,
    `${p}\t<div class=${cls} role="group" aria-label={so_text().filterLabel}${editor}>`,
    `${p}\t\t${pill(`${f.local}_active === null`, 'null', 'so_text().filterAll')}`,
    `${p}\t\t{#each ${f.local}_options as ${option} (${option}.key)}`,
    `${p}\t\t\t${pill(`${f.local}_active === ${option}.key`, `${option}.key`, `${option}.label`)}`,
    `${p}\t\t{/each}`,
    `${p}\t\t<p class="so-filter__status so-visually-hidden" role="status">{so_fill(${f.local}_count === 1 ? so_text().filterOne : so_text().filterMany, { count: ${f.local}_count })}</p>`,
    `${p}\t</div>`,
    `${p}{/if}`
  ].join('\n');
}

/** The class an item of a filtered list takes while the category chosen is not its own (see FilterGen). */
function filterItemClass(ctx: EmitCtx, node: GraphNode): string | null {
  const f = ctx.items.length === 1 ? ctx.filters?.find((x) => x.repeat.children.includes(node.id) && ctx.repeats?.at(-1) === x.repeat.id) : undefined;
  if (!f) return null;
  const item = ctx.items[0];
  return `${f.local}_active !== null && filterKey(${itemField(item, f.field)}${filterOptionsArg(f)}) !== ${f.local}_active && ${js(FILTER_OFF_CLASS)}`;
}

/**
 * The condition under which an element shows on screen while it stays in the page: a panel's own condition, or for a
 * collapsing element, its children showing when only kept panels would keep it there. Null when nothing hides it.
 */
function screenShown(ctx: EmitCtx, node: GraphNode): string | null {
  if (!ctx.widgets?.panels.size) return null;
  if (ctx.widgets.panels.has(node.id)) return conditionExpr(ctx, (node.when ?? node.unless) as Condition, !node.when);
  if (node.kind !== 'element' || !node.collapseEmpty) return null;
  const shown = childrenCondition(ctx, node, new Set());
  return shown !== childrenCondition(ctx, node, new Set(), true) ? shown : null;
}

function useImport(ctx: EmitCtx, name: string, path: string) {
  ctx.imports.set(name, relImport(ctx.file, path));
}

function bindExpr(ctx: EmitCtx, v: unknown, schema?: PropSchema): string {
  // UI state reads the placement's own `$state` local, so what reads it follows the design's buttons. State the design
  // cannot hold (a damaged declaration) shows the value it starts at.
  if (isStateRef(v)) return ctx.states?.get(v.$state)?.local ?? js(stateInitial(ctx.def ?? undefined, v.$state) ?? null);
  if (isBinding(v)) {
    if ('$prop' in v) {
      const local = ctx.locals.get(v.$prop);
      if (!local) return 'undefined';
      // One field of an object property; a name the object lacks reads as nothing (validation reports it).
      return v.field === undefined ? local : `${local}?.[${js(v.field)}]`;
    }
    // An entry's field is read before a layout is written (see ./entry-template); anywhere else it reads nothing.
    if (!('$item' in v)) return 'undefined';
    // Outside every list there is no item to read (validation reports it), so the field is empty.
    const itemVar = ctx.items[ctx.items.length - 1];
    return itemVar ? itemField(itemVar, v.$item) : 'undefined';
  }
  return js(schema ? resolveValue(schema, v, ctx.rctx) : v);
}

/** Identifier suffix for slot snippet names (always prefixed, so reserved words are safe). */
function safeIdent(name: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) ? name : `_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/** The identifier a slot's snippet is generated under. */
export const slotIdent = (slot: string) => `slot_${safeIdent(slot)}`;

function idAttrs(ctx: EmitCtx, nodeId: string): string {
  if (!ctx.instrument) return '';
  const c = ctx.def ? `data-so-ctx={__so}` : `data-so-ctx=${attrJs(ctx.ctxExpr)}`;
  return ` ${c} data-so-node="${nodeId}"${itemsAttr(ctx, nodeId)}`;
}

/**
 * Editor variants: the repeated items a node is rendered for, as the expression of their IDs joined by commas, or
 * null outside every repeat. A definition's root is never inside a repeat of its own: it is rendered for the items
 * its placement sits in, in the design around it (`__so_at`), so selecting a placement in the second item of a list
 * finds only that one.
 */
function itemsExpr(ctx: EmitCtx, nodeId: string): string | null {
  // Each item ID escapes "%" and ",", so an ID with a comma still reads back as one item (see model.ts itemPathOf).
  // Plain string methods: no global a property's name could hide, and nothing that can throw on odd characters.
  if (ctx.items.length) return `[${ctx.items.map((i) => `(${i}.id + '').replaceAll('%', '%25').replaceAll(',', '%2C')`).join(', ')}].join(',')`;
  return ctx.def && nodeId === ctx.def.tree?.rootIds[0] ? '__so_at' : null;
}
function itemsAttr(ctx: EmitCtx, nodeId: string): string {
  const items = itemsExpr(ctx, nodeId);
  return items === null ? '' : items === '__so_at' ? ' data-so-items={__so_at || undefined}' : ` data-so-items={${items}}`;
}

/** Names safe to write into a class: what `defKey`, node IDs and variant IDs are made of. */
const CLASS_PART = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Inert copies of the classes a detached node had in its design (`so--d-…`). No definition's class can start that
 * way (`defKey` trims leading punctuation), so no component rule matches them, while the theme's hooks on class
 * endings (a dark section's colours, print rules) read them as before.
 */
export function detachedClasses(node: Pick<GraphNode, 'detachedFrom'>): string[] {
  const d = node.detachedFrom;
  if (!d || typeof d !== 'object' || !CLASS_PART.test(String(d.component)) || !CLASS_PART.test(String(d.node))) return [];
  const out = [`so--d-${d.component}__${d.node}`];
  const options = d.options && typeof d.options === 'object' ? d.options : {};
  for (const axis of Object.keys(options).sort()) if (CLASS_PART.test(axis) && CLASS_PART.test(String(options[axis]))) out.push(`so--d-${d.component}--${axis}-${options[axis]}`);
  return out;
}

function classExpr(ctx: EmitCtx, node: GraphNode, extra: string[] = []): string {
  const detached = detachedClasses(node).map(js);
  if (ctx.def) {
    const parts = [js(nodeClass(ctx.def, node.id)), ...detached, ...extra];
    for (const [pid, p] of Object.entries(ctx.def.parts)) {
      if (p.nodeId !== node.id) continue;
      parts.push(`so_o?.[${js(pid)}]`);
      // A part shown once per list item also takes the class of its own item's styles.
      if (ctx.items.length && repeatedPartList(ctx.def, pid)) parts.push(`so_oi?.[${ctx.items[ctx.items.length - 1]}.id]?.[${js(pid)}]`);
    }
    const root = node.id === ctx.def.tree?.rootIds[0];
    for (const [axis] of root ? axesOf(ctx.def) : nodeAxes(ctx.def, node.id).map((a) => [a])) parts.push(`\`so-${defKey(ctx.def.id)}--${axis}-\${${variantProp(axis)}}\``);
    if (root) parts.push('className');
    // Kept in the page while its state hides it: hidden on screen, shown in print (see stateWidgets).
    const shown = screenShown(ctx, node);
    if (shown) parts.push(`!(${shown}) && ${js(STATE_OFF_CLASS)}`);
    // An item whose category is not the one chosen, likewise (see FilterGen).
    const filtered = filterItemClass(ctx, node);
    if (filtered) parts.push(filtered);
    return `{[${parts.join(', ')}]}`;
  }
  const parts = [js(pageNodeClass(node.id)), ...detached, ...extra];
  return `{[${parts.join(', ')}]}`;
}

/** True for the root node of the definition being emitted. */
function isDefRoot(ctx: EmitCtx, node: GraphNode): boolean {
  return !!ctx.def && node.id === ctx.def.tree?.rootIds[0];
}

/** The anchor as an id. A definition's root takes the anchor its placement gives it (`so_id`) first. */
function anchorAttr(ctx: EmitCtx, node: GraphNode): string {
  if (isDefRoot(ctx, node)) return node.anchor ? ` id={so_id ?? ${js(node.anchor)}}` : ' id={so_id}';
  return node.anchor ? ` id=${attrJs(node.anchor)}` : '';
}

/**
 * Whether the site has entrances (see generator/appear.ts). Only then do designs take one from their placements
 * (`so_appear`) and an item's place in a staggered list (`so_stagger`), so a site without them is generated as
 * before.
 */
function appearPlumbing(state: ProjectState): boolean {
  return derived(state, 'usesAppear', usesAppear);
}

/**
 * The entrance as data attributes (see generator/appear.ts): the container's own preset, and, for an item of a
 * staggered list, the item it belongs to. A definition's root takes what its placement gives it first; `none` there
 * turns the design's own entrance off.
 */
function appearAttrs(ctx: EmitCtx, node: GraphNode): string {
  // A site no visitor can meet an entrance on (a design's only placement turned it off, nothing places it) shows none.
  if (!ctx.standalone && !appearPlumbing(ctx.state)) return '';
  const own = node.kind === 'element' && isAppearPreset(node.appear) ? node.appear : undefined;
  let out = '';
  if (isDefRoot(ctx, node) && ctx.standalone) {
    const chosen = ctx.standalone.appear === 'none' ? undefined : isAppearPreset(ctx.standalone.appear) ? ctx.standalone.appear : own;
    if (chosen) out = ` data-appear=${js(chosen)}`;
  } else if (isDefRoot(ctx, node)) {
    out = ` data-appear={so_appear === 'none' ? undefined : so_appear${own ? ` ?? ${js(own)}` : ''}} data-appear-stagger={so_stagger}`;
  } else if (own) out = ` data-appear=${js(own)}`;
  if (own && ctx.staggered?.has(node.id)) out += ` data-appear-stagger={${ctx.items[ctx.items.length - 1]}.id}`;
  return out;
}

function pad(ctx: EmitCtx): string {
  return '\t'.repeat(ctx.indent);
}

function emitNodes(ctx: EmitCtx, ids: string[]): string {
  return ids.map((id) => emitNode(ctx, id)).filter(Boolean).join('\n');
}

function propSchemaFor(ctx: EmitCtx, v: unknown): PropSchema | undefined {
  if (!ctx.def || !isBinding(v) || !('$prop' in v)) return undefined;
  return propBindingSchema(ctx.def.properties, v);
}

function emitNode(ctx: EmitCtx, id: string): string {
  const node = ctx.tree.nodes[id];
  if (!node) return '';
  const p = pad(ctx);
  let out = emitNodeInner(ctx, node);
  // A list's category pills go just above the element holding it, shown and hidden with it.
  const filter = ctx.filters?.find((f) => f.host === node.id);
  if (filter) {
    const shown = screenShown(ctx, node);
    out = `${filterBar(ctx, filter, shown ? `!(${shown}) && ${js(STATE_OFF_CLASS)}` : null)}\n${out}`;
  }
  // A collapsing element stays while any child is in the page: a hidden panel inside keeps it, hidden too (screenShown).
  const children = node.kind === 'element' && node.collapseEmpty && ctx.def ? childrenCondition(ctx, node, new Set(), true) : null;
  if (children) {
    useImport(ctx, '{ has }', `${RUNTIME_DIR}/util.js`);
    // An empty list of images (a Gallery's, a Carousel's) shows the author where they will go, only while editing.
    const marker = node.kind === 'element' ? emptyImageListMarker(ctx, node) : '';
    if (marker) ctx.usesEditing = true;
    out = `${p}{#if ${children}}\n${indentBlock(out)}\n${p}${marker ? `{:else if so_editing}\n${p}\t${marker}\n${p}` : ''}{/if}`;
  }
  // A panel kept in the page shows and hides by its condition through a class instead, and a dialog or drawer opens
  // and closes by it (see stateWidgets).
  if (ctx.widgets?.panels.has(node.id) || ctx.widgets?.overlays.has(node.id)) return out;
  if (node.when && ctx.def) out = `${p}{#if ${conditionExpr(ctx, node.when, false)}}\n${indentBlock(out)}\n${p}{/if}`;
  if (node.unless && ctx.def) out = `${p}{#if ${conditionExpr(ctx, node.unless, true)}}\n${indentBlock(out)}\n${p}{/if}`;
  return out;
}

/**
 * A condition as a Svelte expression: `has(value)` for a plain binding (negated for `unless`), or a strict
 * comparison with the literal, so a property set to `"video"` or an item whose `featured` is `true` decides it.
 */
function conditionExpr(ctx: EmitCtx, c: Condition, negate: boolean): string {
  if (isComparison(c)) {
    const equal = 'eq' in c;
    const value = equal ? c.eq : c.ne;
    return `${bindExpr(ctx, c.ref)} ${equal !== negate ? '===' : '!=='} ${js(value)}`;
  }
  useImport(ctx, '{ has }', `${RUNTIME_DIR}/util.js`);
  return `${negate ? '!' : ''}has(${bindExpr(ctx, c)})`;
}

function indentBlock(s: string): string {
  return s.replace(/^/gm, '\t');
}

/**
 * The condition under which a node renders, from its own `when`/`unless`, a repeat's list and a collapsing
 * element's children; null when it always renders. Definitions only, in the scope the node is emitted in. With
 * `present`, whether it is in the page at all: a panel kept there while its state hides it always is.
 */
function renderCondition(ctx: EmitCtx, node: GraphNode, seen: Set<string>, present = false): string | null {
  const parts: string[] = [];
  const kept = present && (!!ctx.widgets?.panels.has(node.id) || !!ctx.widgets?.overlays.has(node.id));
  if (node.when && !kept) parts.push(conditionExpr(ctx, node.when, false));
  if (node.unless && !kept) parts.push(conditionExpr(ctx, node.unless, true));
  if (node.kind === 'repeat') {
    useImport(ctx, '{ has }', `${RUNTIME_DIR}/util.js`);
    parts.push(`has(${bindExpr(ctx, node.list)})`);
  }
  const inner = node.kind === 'element' && node.collapseEmpty ? childrenCondition(ctx, node, seen, present) : null;
  if (inner) parts.push(`(${inner})`);
  return parts.length ? parts.join(' && ') : null;
}

/** A collapsing element renders while any child does; a child that always renders (or no children) keeps it. */
function childrenCondition(ctx: EmitCtx, node: GraphNode & { kind: 'element' }, seen: Set<string>, present = false): string | null {
  if (seen.has(node.id)) return null;
  seen.add(node.id);
  const conds: string[] = [];
  for (const id of node.children) {
    const child = ctx.tree.nodes[id];
    if (!child) continue;
    const cond = renderCondition(ctx, child, seen, present);
    if (cond === null) return null;
    conds.push(cond);
  }
  return conds.length ? conds.join(' || ') : null;
}

/**
 * A navigation landmark whose first child is a heading is labelled by that heading, so screen readers can
 * tell several navigation regions apart. Only outside repeats, where the generated ID stays unique. A heading
 * shown only while its own text is set still labels the landmark whenever it is there.
 */
function labellingHeading(ctx: EmitCtx, node: GraphNode): (GraphNode & { kind: 'text' }) | null {
  const overlay = !!ctx.widgets?.overlays.has(node.id);
  if (!ctx.def || ctx.items.length || node.kind !== 'element' || (node.tag !== 'nav' && !overlay)) return null;
  const first = ctx.tree.nodes[node.children[0]];
  // A heading whose level a property chooses still labels the landmark, whichever level it renders at.
  if (first?.kind !== 'text' || first.rich || !tagChoices(ctx, first).tags.every((t) => /^h[1-6]$/.test(t) && (overlay || t !== 'h1')) || first.unless) return null;
  // A dialog is named by a heading that is always there, or by its own name (see overlayLabelAttrs).
  return !first.when || (!overlay && headingGuardedByOwnText(first)) ? first : null;
}

/** A heading whose condition is its own bound text: it renders exactly when that text is set. */
function headingGuardedByOwnText(heading: GraphNode & { kind: 'text' }): boolean {
  return !!heading.when && isBinding(heading.text) && JSON.stringify(heading.when) === JSON.stringify(heading.text);
}

/**
 * The landmark's name: its heading, and while a conditional heading is not shown, the heading property's
 * default text (so several landmarks stay distinguishable), or no name when that default is blank.
 */
function landmarkLabelAttrs(ctx: EmitCtx, heading: GraphNode & { kind: 'text' }): string {
  const { by, label } = landmarkLabel(ctx, heading);
  return ` aria-labelledby={${by}}${label ? ` aria-label={${label}}` : ''}`;
}

/** The landmark's heading reference and, while a conditional heading is hidden, its fallback name, as expressions. */
function landmarkLabel(ctx: EmitCtx, heading: GraphNode & { kind: 'text' }): { by: string; label?: string } {
  const ref = headingIdExpr(ctx, heading);
  if (!heading.when) return { by: ref };
  useImport(ctx, '{ has }', `${RUNTIME_DIR}/util.js`);
  const shown = `has(${bindExpr(ctx, heading.when as Binding)})`;
  const def = propSchemaFor(ctx, heading.text)?.default;
  return { by: `${shown} ? ${ref} : undefined`, label: typeof def === 'string' && def.trim() ? `${shown} ? undefined : ${js(def.trim())}` : undefined };
}

/**
 * An element's accessible name. An explicit name wins; a bound one left blank falls back to the navigation
 * heading that would otherwise name the landmark, so clearing it never leaves the region unnamed.
 */
function elementLabelAttrs(ctx: EmitCtx, node: GraphNode & { kind: 'element' }): string {
  const heading = labellingHeading(ctx, node);
  const own = node.ariaLabel;
  if (own === undefined || (!isBinding(own) && !String(own).trim())) return heading ? landmarkLabelAttrs(ctx, heading) : '';
  if (!isBinding(own)) return ` aria-label=${attrJs(String(own).trim())}`;
  useImport(ctx, '{ has }', `${RUNTIME_DIR}/util.js`);
  const value = bindExpr(ctx, own);
  if (!heading) return ` aria-label={has(${value}) ? ${value} : undefined}`;
  const { by, label } = landmarkLabel(ctx, heading);
  return ` aria-label={has(${value}) ? ${value} : ${label ?? 'undefined'}} aria-labelledby={has(${value}) ? undefined : ${by}}`;
}

/** An accessible name passed straight to a runtime helper (`label` on icons, `aria-label` on links). */
function nameAttr(ctx: EmitCtx, attr: string, v: unknown): string {
  if (v === undefined) return '';
  if (!isBinding(v)) return String(v).trim() ? ` ${attr}=${attrJs(String(v).trim())}` : '';
  useImport(ctx, '{ has }', `${RUNTIME_DIR}/util.js`);
  const value = bindExpr(ctx, v);
  return ` ${attr}={has(${value}) ? ${value} : undefined}`;
}

/** The schema a binding reads in this scope: a property of the definition, or a field of the innermost list. */
function bindingSchema(ctx: EmitCtx, b: Binding): PropSchema | undefined {
  if (!ctx.def) return undefined;
  if ('$prop' in b) return propBindingSchema(ctx.def.properties, b);
  if (!('$item' in b)) return undefined;
  const list = ctx.lists?.at(-1);
  return list?.type === 'list' && Object.hasOwn(list.fields, b.$item) ? list.fields[b.$item] : undefined;
}

const TEXT_TAG_SET = new Set<string>(TEXT_TAGS);
const ELEMENT_TAG_SET = new Set<string>(ELEMENT_TAGS);

/**
 * The tags a node can render: its literal tag, or for a bound tag the choice's options that are tags of its kind,
 * with the one shown for any other value last (the choice's default, or the kind's plain tag when nothing fits).
 */
function tagChoices(ctx: EmitCtx, node: GraphNode & { kind: 'text' | 'element' }): { value?: string; tags: string[] } {
  const allowed = node.kind === 'text' ? TEXT_TAG_SET : ELEMENT_TAG_SET;
  const plain = node.kind === 'text' ? 'p' : 'div';
  if (!isBinding(node.tag)) return { tags: [allowed.has(node.tag) ? node.tag : plain] };
  const schema = bindingSchema(ctx, node.tag);
  const options = schema?.type === 'enum' ? schema.options.map((o) => o.value).filter((o) => allowed.has(o)) : [];
  const fallback = schema?.type === 'enum' && options.includes(schema.default) ? schema.default : (options[0] ?? plain);
  return { value: bindExpr(ctx, node.tag), tags: [...options.filter((o) => o !== fallback), fallback] };
}

/** Markup for each tag a node can render, chosen at runtime when the tag is bound. */
function perTag(ctx: EmitCtx, choices: { value?: string; tags: string[] }, render: (tag: string) => string): string {
  const p = pad(ctx);
  if (choices.tags.length === 1) return render(choices.tags[0]);
  ctx.indent++;
  const branches = choices.tags.map((tag) => render(tag));
  ctx.indent--;
  const last = choices.tags.length - 1;
  return choices.tags
    .map((tag, i) => (i === 0 ? `${p}{#if ${choices.value} === ${js(tag)}}` : i === last ? `${p}{:else}` : `${p}{:else if ${choices.value} === ${js(tag)}}`) + `\n${branches[i]}`)
    .join('\n') + `\n${p}{/if}`;
}

/** Whether an element renders as a card link: it has a destination and nothing interactive renders inside it. */
function rendersAsCard(ctx: EmitCtx, node: GraphNode): boolean {
  if (!isCardLink(node)) return false;
  ctx.brokenCards ??= new Set(derived(ctx.state, 'brokenCards', sortedBrokenCards));
  const owner = ctx.def ? { kind: 'component' as const, id: ctx.def.id } : { kind: ctx.ctxExpr.split(':')[0] as 'page' | 'shell', id: ctx.ctxExpr.split(':').slice(1).join(':') };
  return !ctx.brokenCards.has(cardKey({ owner, cardId: node.id }));
}

/** Whether an element carries an action (`ElementNode.action`), whatever it is set to. */
function hasAction(node: GraphNode): node is GraphNode & { kind: 'element'; action: NonNullable<ElementNode['action']> } {
  return node.kind === 'element' && node.action !== undefined && node.action !== null;
}

function actionExpr(ctx: EmitCtx, node: ElementNode): string {
  return isBinding(node.action) ? bindExpr(ctx, node.action) : js(node.action ?? 'none');
}

/**
 * The images an action element opens, in document order, each with the elements between them: its image descendants
 * in the same scope (not inside a list or another component).
 */
function actionImages(ctx: EmitCtx, node: ElementNode): Array<{ image: GraphNode & { kind: 'image' }; between: GraphNode[] }> {
  const out: Array<{ image: GraphNode & { kind: 'image' }; between: GraphNode[] }> = [];
  // A hand-edited tree can list a node twice; each is walked once.
  const seen = new Set<string>([node.id]);
  const walk = (ids: string[], between: GraphNode[]) => {
    for (const id of ids) {
      const n = ctx.tree.nodes[id];
      if (!n || seen.has(id)) continue;
      seen.add(id);
      if (n.kind === 'image') out.push({ image: n, between });
      else if (n.kind === 'element') walk(n.children, [...between, n]);
    }
  };
  walk(node.children, []);
  return out;
}

/**
 * The image an action element opens full size: the first of its images that shows a picture where it renders (its
 * own conditions and those of the elements around it holding), with the words it is known by as `label`.
 */
function actionImage(ctx: EmitCtx, node: ElementNode): string {
  const exprs = actionImages(ctx, node).map(({ image, between }) => {
    let val = isBinding(image.image) ? bindExpr(ctx, image.image) : js(resolveImage(image.image, ctx.rctx));
    // What the image stands for when it has no words of its own, as its thumbnail says.
    if (image.fallbackAlt !== undefined) val = `(${val} ? { ...${val}, fallbackAlt: ${bindExpr(ctx, image.fallbackAlt)} } : null)`;
    const conds = ctx.def ? [...between, image].map((n) => renderCondition(ctx, n, new Set())).filter((c): c is string => !!c) : [];
    return conds.length ? `(${conds.join(' && ')} ? ${val} : null)` : val;
  });
  if (!exprs.length) return 'null';
  return exprs.length === 1 ? exprs[0] : `[${exprs.join(', ')}].find((i) => i?.src) ?? null`;
}

/** The nearest element above an image (see `actionImages`) whose action may open it, or null. */
function actionOwner(ctx: EmitCtx, nodeId: string): ElementNode | null {
  ctx.actions ??= Object.values(ctx.tree.nodes).some(hasAction);
  if (!ctx.actions) return null;
  const parents = (ctx.parents ??= parentMap(ctx.tree));
  const seen = new Set<string>([nodeId]);
  for (let id = parents.get(nodeId); id && !seen.has(id); id = parents.get(id)) {
    seen.add(id);
    const n = ctx.tree.nodes[id];
    if (!n || n.kind !== 'element') return null;
    if (hasAction(n) && actionWraps(n) && (isBinding(n.action) || n.action === 'image')) return n;
  }
  return null;
}

/**
 * Which images the viewer moves through together: one list's items in one placement (a gallery), or the element
 * alone outside a list. Items of an outer list each make their own group.
 */
function actionGroup(ctx: EmitCtx, node: GraphNode): string {
  // A detached gallery's items keep moving through the viewer together, as they did in the component.
  if (!ctx.def) return js([ctx.ctxExpr, typeof node.detachedFrom?.group === 'string' ? node.detachedFrom.group : node.id]);
  ctx.usesUid = true;
  const repeat = ctx.repeats?.at(-1);
  const parts = repeat ? [js(repeat), ...ctx.items.slice(0, -1).map((v) => `${v}.id`)] : [js(node.id)];
  return `[uid, ${parts.join(', ')}]`;
}

function headingIdExpr(ctx: EmitCtx, heading: GraphNode): string {
  if (heading.anchor) return js(heading.anchor);
  ctx.usesUid = true;
  return `\`\${uid}-${heading.id}\``;
}

function parentMap(tree: NodeTree): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of Object.values(tree.nodes)) {
    const kids = n.kind === 'element' || n.kind === 'repeat' ? n.children : [];
    for (const c of kids) out.set(c, n.id);
  }
  return out;
}

type SizeRange = 'phone' | 'tablet' | 'desktop';
/**
 * The widest viewport each range covers, rounded up past the fractional edges of MEDIA_QUERIES, and the narrowest
 * (for phones, the narrowest in common use).
 */
const RANGE_MAX: Record<SizeRange, number> = { phone: 768, tablet: 1024, desktop: Infinity };
const RANGE_MIN: Record<SizeRange, number> = { phone: 280, tablet: 768, desktop: 1024 };

/**
 * One style layer of a rendered element. `tier` is how strongly its rules bind in the generated CSS: the element's
 * own styles (0), the selected variant options of the placement it belongs to (1), that placement's overrides (2).
 */
interface SizingLayer {
  styles: ResponsiveStyles;
  tier: number;
}
type SizingBox = SizingLayer[];

/**
 * The value a box takes for one style property in one range, as the generated CSS settles it: a stronger tier
 * wins; within a tier a value for the range beats a tablet-up base value, which beats a base value (the order of
 * the media blocks), and a later layer beats an earlier one.
 */
function boxStyle(box: SizingBox, prop: string, range: SizeRange): unknown {
  let best: unknown;
  let rank = -1;
  box.forEach(({ styles: own, tier }, order) => {
    // A column count its own column sizes override is never written.
    const styles = withColumnSizes(own);
    let block = -1;
    let value: unknown;
    if (styles[range]?.[prop] !== undefined) {
      block = 2;
      value = styles[range]![prop];
    } else if (styles.base?.[prop] !== undefined) {
      value = styles.base[prop];
      block = wideOnlyStyle(prop, value, tier > 0) ? (range === 'phone' ? -1 : 1) : 0;
    }
    const r = block < 0 ? -1 : (tier * 3 + block) * 1000 + order;
    if (r > rank) [rank, best] = [r, value];
  });
  return best;
}

/** Each node's parent in a tree, and the slot it fills when that parent is a component placement. */
function slotParentMap(tree: NodeTree): Map<string, { id: string; slot?: string }> {
  const out = new Map<string, { id: string; slot?: string }>();
  for (const n of Object.values(tree.nodes)) {
    if (n.kind === 'element' || n.kind === 'repeat') for (const c of n.children) out.set(c, { id: n.id });
    else if (n.kind === 'instance') for (const slot of Object.keys(n.slots ?? {})) for (const c of slotChildren(n, slot)) out.set(c, { id: n.id, slot });
  }
  return out;
}

interface SizingWalk {
  state: ProjectState;
  parents: Map<NodeTree, Map<string, { id: string; slot?: string }>>;
  seen: Set<string>;
  /** Set when something on the way decides the width in a way this estimate cannot read. */
  unknown: boolean;
}

/**
 * The rendered elements around a node, innermost first, up to its tree's root. Content placed in a slot continues
 * through the elements the placement's definition wraps that slot in, with the placement's own variant styles and
 * overrides, and then outside the placement. Repeats and slots render no element of their own. A code component's
 * slots, a slot rendered in two places and an option chosen by a bound property are unknown.
 */
function sizingBoxes(walk: SizingWalk, tree: NodeTree, nodeId: string, placement: InstanceNode | null, path: string, out: SizingBox[]): void {
  const def = placement ? walk.state.components[placement.definitionId] : undefined;
  const layers = (id: string, n: GraphNode): SizingBox => {
    const box: SizingBox = [{ styles: n.styles ?? {}, tier: 0 }];
    if (!placement || !def) return box;
    for (const [axis, a] of axesOf(def)) if (isBindingRef(placement.variants?.[axis]) && Object.values(a.options).some((o) => o.styles?.[id])) walk.unknown = true;
    for (const styles of selectedVariantStyles(def, placement.variants, id)) box.push({ styles, tier: 1 });
    const rootId = def.tree?.rootIds[0];
    for (const partId of Object.keys(placement.overrides ?? {}).sort()) {
      const target = partId === 'root' ? rootId : def.parts[partId]?.nodeId;
      if (target === id) box.push({ styles: placement.overrides![partId], tier: 2 });
    }
    return box;
  };
  let parents = walk.parents.get(tree);
  if (!parents) walk.parents.set(tree, (parents = slotParentMap(tree)));
  for (let at = parents.get(nodeId); at; at = parents.get(at.id)) {
    // Node IDs repeat across definitions, so each is told apart by the placements walked through to reach it.
    const key = `${path}|${at.id}`;
    const n = tree.nodes[at.id];
    if (walk.seen.has(key) || !n) return void (walk.unknown = true);
    walk.seen.add(key);
    if (n.kind === 'element') out.push(layers(at.id, n));
    if (n.kind !== 'instance' || at.slot === undefined) continue;
    const inner = walk.state.components[n.definitionId];
    const slots = inner?.kind === 'managed' && inner.tree ? Object.values(inner.tree.nodes).filter((x) => x.kind === 'slot' && x.slot === at.slot) : [];
    if (slots.length !== 1 || path.split('/').length > 16) return void (walk.unknown = true);
    sizingBoxes(walk, inner!.tree!, slots[0].id, n, `${path}/${n.id}`, out);
    // What this tree gives the placement (its class, variant styles and overrides) lands on the definition's root,
    // competing with that definition's own rules from another stylesheet: sizing styles there are not read.
    if (layers(at.id, n).some((l) => Object.values(l.styles).some((st) => st && SIZING_PROPS.some((k) => st[k] !== undefined)))) return void (walk.unknown = true);
  }
}

/**
 * The fraction of a grid's content width one of its items takes in a range: an equal share for each column it
 * spans, or for uneven columns the widest run it could sit in. Columns that fit as many as they can, or that mix fr
 * shares with fixed or content widths, stay whole, since how wide each one is is unknown here (columns wider than
 * the grid overflow the page, which no estimate covers). With both columns and column sizes set, the wider reading wins: a stronger rule this walk cannot see (a
 * placement's, an item's) may decide which one applies.
 */
function trackShare(grid: SizingBox, item: SizingBox | undefined, range: SizeRange): number {
  const raw = item ? boxStyle(item, 'columnSpan', range) : undefined;
  const spanValue = typeof raw === 'string' ? raw.trim() : raw;
  const span = (tracks: number[]): number => {
    // Shares are read against their own total, even below one: gaps and implicit columns other items add can
    // widen a share past its part of the whole, so this stays the upper estimate.
    const total = tracks.reduce((a, b) => a + b, 0);
    if (!(total > 0) || spanValue === 'full') return 1;
    const count = typeof spanValue === 'number' || typeof spanValue === 'string' ? Number(spanValue) : NaN;
    const k = Math.max(1, Math.floor(count) || 1);
    // Spanning past the last column adds implicit ones, which can stretch into whatever the shares leave.
    if (k >= tracks.length) return 1;
    let widest = 0;
    for (let i = 0; i + k <= tracks.length; i++) widest = Math.max(widest, tracks.slice(i, i + k).reduce((a, b) => a + b, 0));
    return widest / total;
  };
  const shares: number[] = [];
  const columns = boxStyle(grid, 'columns', range);
  // A column count that is not a whole number makes no columns in CSS: one implicit column holds everything.
  if (typeof columns === 'number' && columns >= 1) shares.push(Number.isInteger(columns) ? span(Array.from({ length: columns }, () => 1)) : 1);
  const template = boxStyle(grid, 'gridTemplate', range);
  if (typeof template === 'string') {
    // Only fr shares divide the grid in known parts; with a column of fixed or content width, any may be the widest.
    const fr = gridTemplateShares(template);
    shares.push(fr ? span(fr) : 1);
  }
  return shares.length ? Math.max(...shares) : 1;
}

/** Custom CSS properties that only paint: they never change how wide anything is laid out. */
const PAINT_ONLY_CSS = /^(filter|backdrop-filter|opacity|color|background(-[a-z]+)*|border(-[a-z]+)*|box-shadow|outline(-[a-z]+)*|mix-blend-mode|isolation|transition(-[a-z]+)*|cursor|text-[a-z-]+|font(-[a-z]+)*|letter-spacing|word-spacing|line-height|object-position|image-rendering|pointer-events|user-select|visibility|z-index|caret-color|accent-color|clip-path)$/;
/** The styles that decide how wide an element, or the elements inside it, can be. */
const SIZING_PROPS = ['layout', 'columns', 'gridTemplate', 'columnSpan', 'width', 'minWidth', 'maxWidth', 'flexGrow', 'position', 'inset', 'marginInlineStart', 'marginInlineEnd', 'customCss'];

/**
 * A realistic `sizes` hint for an image: in each range, its share of the grids around it (through the
 * placements whose slots hold it), capped by the narrowest fixed width or container among them, and widened for a
 * cropped picture. Each value is an upper estimate, so the browser never picks a copy smaller than the image shows;
 * gaps and padding are left out. It reads only plain layouts: anything else on the way (a minimum width, a
 * percentage, positioning, custom CSS that lays out) leaves the runtime default (100vw), as does null.
 * An image in a definition stops at the definition's root: a placement can widen any container there, so only a
 * grid's share or the image's own width counts.
 */
function imageSizes(ctx: EmitCtx, node: GraphNode): string | null {
  const tokens = effectiveTokens(ctx.state);
  /** A length as a number and unit (px, vw or %); a token resolves to its value; 0 is 0px. */
  const length = (v: unknown): { n: number; unit: string } | null => {
    const raw = v && typeof v === 'object' && 'token' in v ? tokens.find((t) => t.id === (v as { token: string }).token)?.value : v;
    if (raw === 0 || raw === '0') return { n: 0, unit: 'px' };
    const m = typeof raw === 'string' ? raw.trim().match(/^(\d+(?:\.\d+)?)(px|vw|%)$/) : null;
    return m ? { n: Number(m[1]), unit: m[2] } : null;
  };
  const px = (v: unknown) => (length(v)?.unit === 'px' ? length(v)!.n : null);
  const walk: SizingWalk = { state: ctx.state, parents: (ctx.sizingParents ??= new Map()), seen: new Set(), unknown: false };
  const boxes: SizingBox[] = [[{ styles: node.styles ?? {}, tier: 0 }]];
  sizingBoxes(walk, ctx.tree, node.id, null, '', boxes);
  if (walk.unknown) return null;
  // A cropped picture (cover) fills its box both ways, so it can need more width than the box has.
  const asset = node.kind === 'image' && !isBinding(node.image) && node.image?.assetId ? ctx.state.assets.assets[node.image.assetId] : undefined;
  const aspect = asset?.width && asset.height ? asset.width / asset.height : null;
  let gridded = false;
  let ownBound = false;
  const at = (['desktop', 'tablet', 'phone'] as const).map((range): string | null => {
    // `share` of the viewport the image can take and `cap` the most it can take in pixels; `frozen` once a box's
    // own width decides it, after which outer boxes are only checked.
    let share = 1;
    let cap = Infinity;
    let frozen = false;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const get = (prop: string) => boxStyle(box, prop, range);
      if (!['static', 'relative', 'sticky', undefined].includes(get('position') as string | undefined)) return null;
      for (const l of box)
        for (const css of [l.styles.base?.customCss, l.styles[range]?.customCss])
          if (typeof css === 'string' && css.split(';').some((d) => d.trim() && !PAINT_ONLY_CSS.test(d.split(':')[0].trim().toLowerCase()))) return null;
      for (const side of ['marginInlineStart', 'marginInlineEnd']) if (get(side) !== undefined && get(side) !== 'auto' && px(get(side)) === null) return null;
      const minWidth = get('minWidth');
      if (minWidth !== undefined && minWidth !== 'auto' && px(minWidth) !== 0) return null;
      const rawWidth = get('width');
      const width = length(rawWidth);
      const maxPx = px(get('maxWidth'));
      const parentLayout = boxes[i + 1] ? boxStyle(boxes[i + 1], 'layout', range) : undefined;
      const sized = rawWidth === undefined || rawWidth === 'fill' || (width?.unit === '%' && width.n === 100);
      // Growing in a row or stack, a declared width is only where the box starts.
      if (!sized && (parentLayout === 'row' || parentLayout === 'stack') && Number(get('flexGrow')) > 0) return null;
      // An image sized by its own picture stays inside its parent only through the theme's max-width: 100%, which a
      // max width of its own replaces.
      const intrinsic = i === 0 && (rawWidth === 'auto' || rawWidth === 'fit');
      if (!sized && !intrinsic && width?.unit !== 'px' && width?.unit !== 'vw' && !(i > 0 && (rawWidth === 'auto' || rawWidth === 'fit'))) return null;
      if (intrinsic && get('maxWidth') !== undefined && maxPx === null && !(length(get('maxWidth'))?.unit === '%' && length(get('maxWidth'))!.n <= 100)) return null;
      if (frozen) continue;
      if (i > 0 && get('layout') === 'grid') {
        const t = trackShare(box, boxes[i - 1], range);
        if (t < 1) gridded = true;
        share *= t;
      }
      if (i === 0 && (width?.unit === 'px' || width?.unit === 'vw' || maxPx !== null)) ownBound = true;
      if (maxPx !== null) cap = Math.min(cap, share * maxPx);
      if (width?.unit === 'px') {
        // A fixed width holds whatever its parent's track is (it can overflow it).
        cap = Math.min(cap, share * width.n);
        share = Infinity;
        frozen = true;
      } else if (width?.unit === 'vw') {
        // A viewport width is measured from the screen, not the parent.
        share *= width.n / 100;
        frozen = true;
      } else if (intrinsic && maxPx !== null) {
        share = Infinity;
        frozen = true;
      }
      // In a row, an element is at least as wide as its content needs (a wide sibling of the image can hold it open),
      // so nothing further out bounds it: only a cap from inside it does. The image itself needs nothing of its own.
      if (!frozen && i > 0 && parentLayout === 'row') {
        share = Infinity;
        frozen = true;
      }
    }
    // A cropped picture: a fixed height needs the width that height gives the picture; otherwise the aspect ratio
    // its box is cut to does.
    let floor = 0;
    const fit = boxStyle(boxes[0], 'objectFit', range) ?? 'cover';
    const height = boxStyle(boxes[0], 'height', range) === 'auto' ? undefined : boxStyle(boxes[0], 'height', range);
    const minHeight = boxStyle(boxes[0], 'minHeight', range);
    if (fit === 'cover' && aspect) {
      // In a row the image stretches to the row's height, which is not known here.
      if (height === undefined && boxes[1] && boxStyle(boxes[1], 'layout', range) === 'row') return null;
      for (const h of [height, minHeight]) {
        if (h === undefined || h === 'auto' || px(h) === 0) continue;
        if (px(h) === null) return null;
        floor = Math.max(floor, aspect * px(h)!);
      }
      const ratio = String(boxStyle(boxes[0], 'aspectRatio', range) ?? '').match(/^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/);
      if (ratio && height === undefined) {
        const crop = Math.max(1, aspect / (Number(ratio[1]) / Number(ratio[2] ?? 1)));
        [share, cap] = [share * crop, cap * crop];
      }
    }
    // Both are upper estimates; a fixed cap is the closer one when it is narrower than the range's widest screen.
    // A floor wider than the share on the range's narrowest screen is covered by the share on its widest, or on
    // desktops (which have no widest) by a larger share. Rounded up, never down, past float noise.
    const toPx = (v: number) => `${Math.ceil(v - 1e-6)}px`;
    if (cap < Infinity && cap <= share * RANGE_MAX[range]) return toPx(Math.max(cap, floor));
    if (!Number.isFinite(share)) return null;
    if (floor > share * RANGE_MIN[range] && RANGE_MAX[range] < Infinity) return toPx(Math.max(floor, Math.min(cap, share * RANGE_MAX[range])));
    return `${Math.ceil(Math.max(share, floor / RANGE_MIN[range]) * 10000 - 1e-6) / 100}vw`;
  });
  if (at.includes(null) || (ctx.def && !gridded && !ownBound)) return null;
  const [desktop, tablet, phone] = at;
  if (desktop === tablet && tablet === phone) return phone === '100vw' ? null : phone;
  return `(min-width: 1024px) ${desktop}, (min-width: 768px) ${tablet}, ${phone}`;
}

/** Part IDs the editor's preview can name in a class (see the part marks given to a code placement). */
const PART_CLASS_ID = /^[A-Za-z][A-Za-z0-9_-]{0,80}$/;

function emitNodeInner(ctx: EmitCtx, node: GraphNode): string {
  const p = pad(ctx);
  const ids = appearAttrs(ctx, node) + idAttrs(ctx, node.id);
  switch (node.kind) {
    case 'element': {
      const overlay = ctx.widgets?.overlays.get(node.id);
      if (overlay) return emitOverlay(ctx, node, overlay);
      const card = rendersAsCard(ctx, node);
      // A working action wraps the element, which keeps its own tag, in the runtime helper's one link.
      const acting = card && hasAction(node);
      if (acting) ctx.indent++;
      const q = pad(ctx);
      ctx.indent++;
      const children = emitNodes(ctx, node.children);
      ctx.indent--;
      const list = !!ctx.widgets?.lists.has(node.id);
      const label = list ? '' : elementLabelAttrs(ctx, node);
      const choices = tagChoices(ctx, node);
      const attrs = `class=${classExpr(ctx, node, list ? [js('so-tablist')] : [])}${anchorAttr(ctx, node)}${label}${stateElementAttrs(ctx, node)}${ids}${emptyFrameAttr(ctx, node)}`;
      let markup: string;
      if (card && !acting) {
        // One link around the whole card; the runtime helper renders the container's own tag without a destination.
        useImport(ctx, 'SoLink', `${RUNTIME_DIR}/Link.svelte`);
        const link = isBinding(node.link) ? bindExpr(ctx, node.link) : js(resolveLink(node.link as LinkValue, ctx.rctx));
        const fallback = choices.tags[choices.tags.length - 1];
        const tag = choices.tags.length === 1 ? js(fallback) : `${js(choices.tags.slice(0, -1))}.includes(${choices.value}) ? ${choices.value} : ${js(fallback)}`;
        return `${p}<SoLink link={${link}} card={${tag}} ${attrs}>${children ? `\n${children}\n${p}` : ''}</SoLink>`;
      }
      // A carousel's list is rendered by the runtime helper, which puts its buttons beside it.
      if (!card && isCarouselTrack(node)) {
        useImport(ctx, 'SoCarousel', `${RUNTIME_DIR}/Carousel.svelte`);
        return `${p}<SoCarousel ${attrs}>${children ? `\n${children}\n${p}` : ''}</SoCarousel>`;
      }
      if (choices.tags.length === 1) markup = `${q}<${choices.tags[0]} ${attrs}>${children ? `\n${children}\n${q}` : ''}</${choices.tags[0]}>`;
      else {
        // A bound tag renders the children once, from a snippet each possible tag renders.
        ctx.snippets = (ctx.snippets ?? 0) + 1;
        const snippet = `so_children_${ctx.snippets}`;
        const body = children ? `${q}{#snippet ${snippet}()}\n${children}\n${q}{/snippet}\n` : '';
        markup = body + perTag(ctx, choices, (tag) => `${pad(ctx)}<${tag} ${attrs}>${children ? `{@render ${snippet}()}` : ''}</${tag}>`);
      }
      if (!acting) return markup;
      ctx.indent--;
      useImport(ctx, 'SoAction', `${RUNTIME_DIR}/Action.svelte`);
      const link = node.link === undefined || node.link === null ? 'null' : isBinding(node.link) ? bindExpr(ctx, node.link) : js(resolveLink(node.link as LinkValue, ctx.rctx));
      return `${p}<SoAction mode={${actionExpr(ctx, node)}} link={${link}} image={${actionImage(ctx, node)}} group={${actionGroup(ctx, node)}}>\n${markup}\n${p}</SoAction>`;
    }
    case 'text': {
      if (node.rich) {
        useImport(ctx, 'SoRichText', `${RUNTIME_DIR}/RichText.svelte`);
        const listed = node.paragraphList === 'check' || node.paragraphList === 'ul' ? node.paragraphList : undefined;
        let val = isBinding(node.text) ? bindExpr(ctx, node.text) : js(listed ? asParagraphList(resolveRichText(node.text, ctx.rctx) as unknown as RichText, listed) : resolveRichText(node.text, ctx.rctx));
        if (listed && isBinding(node.text)) {
          useImport(ctx, '{ richList }', `${RUNTIME_DIR}/util.js`);
          val = `richList(${val}, ${js(listed)})`;
        }
        return `${p}<SoRichText value={${val}} class=${classExpr(ctx, node)}${anchorAttr(ctx, node)}${ids} />`;
      }
      const val = isBinding(node.text) ? bindExpr(ctx, node.text) : js(Array.isArray(node.text) ? richTextToPlain(toRichText(node.text)) : node.text);
      const parentId = parentMap(ctx.tree).get(node.id);
      const parent = parentId ? ctx.tree.nodes[parentId] : undefined;
      const labels = !node.anchor && parent && labellingHeading(ctx, parent)?.id === node.id;
      const idAttr = labels ? ` id={${headingIdExpr(ctx, node)}}` : anchorAttr(ctx, node);
      const attrs = `class=${classExpr(ctx, node)}${idAttr}${stateElementAttrs(ctx, node)}${ids}`;
      const content = timeContent(ctx, node, val);
      return perTag(ctx, tagChoices(ctx, node), (tag) => `${pad(ctx)}<${tag} ${attrs}>${content}</${tag}>`);
    }
    case 'image': {
      useImport(ctx, 'SoImage', `${RUNTIME_DIR}/Image.svelte`);
      let val = isBinding(node.image) ? bindExpr(ctx, node.image) : js(resolveImage(node.image, ctx.rctx));
      // A thumbnail that opens full size shows only the smaller copies, so the full-size file loads when it opens.
      const owner = actionOwner(ctx, node.id);
      if (owner && rendersAsCard(ctx, owner) && (isBinding(owner.action) || owner.action === 'image')) {
        useImport(ctx, '{ thumbnail }', `${RUNTIME_DIR}/util.js`);
        // Only the picture the viewer opens: beside others, the one that shows first (see `actionImage`).
        const tests = [
          ...(isBinding(owner.action) ? [`${actionExpr(ctx, owner)} === 'image'`] : []),
          ...(actionImages(ctx, owner).length > 1 ? [`(${actionImage(ctx, owner)})?.src === (${val})?.src`] : [])
        ];
        val = tests.length ? `${tests.join(' && ')} ? thumbnail(${val}) : ${val}` : `thumbnail(${val})`;
      }
      // The first section's images (outside lists) are usually the largest content: load them eagerly.
      const eager = ctx.def ? (ctx.items.length ? '' : ' eager={so_eager}') : ctx.firstSection ? ' eager' : '';
      const sizes = imageSizes(ctx, node);
      const fallback = node.fallbackAlt !== undefined ? ` fallbackAlt={${bindExpr(ctx, node.fallbackAlt)}}` : '';
      return `${p}<SoImage image={${val}}${eager}${sizes ? ` sizes=${js(sizes)}` : ''}${fallback} class=${classExpr(ctx, node)}${anchorAttr(ctx, node)}${ids} />`;
    }
    case 'link': {
      useImport(ctx, 'SoLink', `${RUNTIME_DIR}/Link.svelte`);
      const link = isBinding(node.link) ? bindExpr(ctx, node.link) : js(resolveLink(node.link as LinkValue, ctx.rctx));
      const label = bindExpr(ctx, node.label);
      const appearance = bindExpr(ctx, node.appearance);
      const name = nameAttr(ctx, 'aria-label', node.ariaLabel);
      // A button that changes UI state is a real button wherever it has nowhere to go (see the Link helper).
      const role = ctx.widgets?.buttons.get(node.id);
      const handler = ctx.def ? stateActionHandler(ctx, node.stateAction, role?.role === 'dialog' ? ctx.widgets!.overlays.get(role.overlay) : undefined) : null;
      const click = handler ? ` so_control onclick={${handler}}${stateButtonAttrs(ctx, node)}` : '';
      return `${p}<SoLink link={${link}} appearance={${appearance}} class=${classExpr(ctx, node)}${anchorAttr(ctx, node)}${name}${click}${ids}>${linkContent(ctx, node, label)}</SoLink>`;
    }
    case 'icon': {
      useImport(ctx, 'SoIcon', `${RUNTIME_DIR}/Icon.svelte`);
      return `${p}<SoIcon name={${bindExpr(ctx, node.icon)}}${nameAttr(ctx, 'label', node.ariaLabel)} class=${classExpr(ctx, node)}${anchorAttr(ctx, node)}${ids} />`;
    }
    case 'divider':
      return `${p}<hr class=${classExpr(ctx, node, [js('so-divider')])}${anchorAttr(ctx, node)}${ids} />`;
    case 'repeat': {
      const v = `item${ctx.items.length ? ctx.items.length + 1 : ''}`;
      const list = bindExpr(ctx, node.list);
      const listSchema = bindingSchema(ctx, node.list);
      ctx.items.push(v);
      ctx.repeats = [...(ctx.repeats ?? []), node.id];
      ctx.lists = [...(ctx.lists ?? []), ...(listSchema ? [listSchema] : [])];
      const outer = ctx.staggered;
      ctx.staggered = node.appearStagger === true ? new Set(node.children) : undefined;
      ctx.indent++;
      const children = emitNodes(ctx, node.children);
      ctx.indent--;
      ctx.staggered = outer;
      ctx.items.pop();
      ctx.repeats = ctx.repeats.slice(0, -1);
      if (listSchema) ctx.lists = ctx.lists.slice(0, -1);
      return `${p}{#each ${list} ?? [] as ${v} (${v}.id)}\n${children}\n${p}{/each}`;
    }
    case 'slot':
      return `${p}{@render slot_${safeIdent(node.slot)}?.()}`;
    case 'instance':
      return emitInstance(ctx, node);
  }
}

/**
 * A dialog or drawer (see stateWidgets): a native <dialog>, closed in the page's own markup, which its state opens as a
 * modal (overlayScript). Escape, a click on its backdrop, or a close of its own sets the state to closed, and the
 * button that opened it gets the focus back; a jump from a link inside it to somewhere else on the page closes it too,
 * leaving the focus where the jump puts it. A close event from a copy since replaced, or one the dialog has since
 * reopened from, changes nothing. In the editor's variant, while editing, its content renders in a plain
 * container in its place instead, hidden until the author shows it with a button of the editor's own beside it (the
 * preview bridge keeps which ones are shown, through hot updates), so what is inside can be selected and edited there.
 */
function emitOverlay(ctx: EmitCtx, node: GraphNode & { kind: 'element' }, o: OverlayGen): string {
  const p = pad(ctx);
  const util = `${RUNTIME_DIR}/util.js`;
  useImport(ctx, '{ overlayDismissal }', util);
  useImport(ctx, '{ overlayClosed }', util);
  const id = widgetId(ctx, node.id, 'dialog');
  const cls = classExpr(ctx, node, [js('so-overlay'), js(`so-overlay--${o.mode}`)]);
  const ids = idAttrs(ctx, node.id);
  const closed = `${ctx.states!.get(o.state)!.local} = ${js(!o.shows)}`;
  const dialog = (q: string, inner: string) =>
    [
      `${q}<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->`,
      `${q}<dialog`,
      `${q}\tbind:this={${o.dialog}}`,
      `${q}\tid={${id}}`,
      `${q}\tclass=${cls}${overlayLabelAttrs(ctx, node, o)}${ids}`,
      `${q}\toncancel={(event) => {`,
      `${q}\t\tevent.preventDefault();`,
      `${q}\t\t${closed};`,
      `${q}\t}}`,
      `${q}\tonclose={(event) => {`,
      `${q}\t\tif (event.currentTarget !== ${o.dialog} || event.currentTarget.open) return;`,
      `${q}\t\t${closed};`,
      `${q}\t\t${o.opener} = overlayClosed(${o.opener});`,
      `${q}\t}}`,
      `${q}\tonclick={(event) => {`,
      `${q}\t\tconst away = overlayDismissal(event);`,
      `${q}\t\tif (away === 'link') ${o.opener} = null;`,
      `${q}\t\tif (away) ${closed};`,
      `${q}\t}}`,
      `${q}>${inner}</dialog>`
    ].join('\n');
  ctx.indent++;
  const children = emitNodes(ctx, node.children);
  ctx.indent--;
  if (!ctx.instrument) return dialog(p, children ? `\n${children}\n${p}` : '');
  ctx.usesEditing = true;
  const name = overlayName(ctx, o);
  const peekButton = (q: string) => `${q}<button type="button" class="so-overlay-peek" data-so-editor-only="" data-so-overlay-peek="" aria-controls={${id}} aria-expanded="false">{${js(`${o.mode === 'dialog' ? 'Dialog' : 'Drawer'}: ${name}`)}}</button>`;
  const render = `\n${p}\t\t{@render ${o.snippet}()}\n${p}\t`;
  // In Component Studio a state previewed open shows the content in place (data-so-overlay-open, which the bridge's
  // styles show), with no button of the editor's own beside it: it closes as the studio previews it closed.
  const open = ctx.previewOpen ? stateIs(ctx, o.state, o.shows) : null;
  const peek = open ? [`${p}\t{#if !(${open})}`, peekButton(`${p}\t\t`), `${p}\t{/if}`].join('\n') : peekButton(`${p}\t`);
  const opened = open ? ` data-so-overlay-open={${open} ? '' : undefined}` : '';
  return [
    `${p}{#snippet ${o.snippet}()}`,
    ...(children ? [children] : []),
    `${p}{/snippet}`,
    `${p}{#if so_editing}`,
    peek,
    `${p}\t<div id={${id}} class=${cls} data-so-overlay=${js(o.mode)}${opened}${ids}${emptyFrameAttr(ctx, node)}>${render}</div>`,
    `${p}{:else}`,
    dialog(`${p}\t`, render),
    `${p}{/if}`
  ].join('\n');
}

/** What a dialog or drawer is called when nothing else names it: the label of the state that opens it. */
function overlayName(ctx: EmitCtx, o: OverlayGen): string {
  return ctx.states!.get(o.state)!.schema.label.trim() || o.state;
}

/**
 * A dialog's accessible name: its own name while it has one, else the heading it starts with (one that is always
 * there) while it has words (a placement can leave a bound one empty), else the label of the state that opens it, so
 * it is never left unnamed.
 */
function overlayLabelAttrs(ctx: EmitCtx, node: GraphNode & { kind: 'element' }, o: OverlayGen): string {
  let heading = labellingHeading(ctx, node);
  // A heading left without words names nothing.
  if (heading && !isBinding(heading.text) && !(Array.isArray(heading.text) ? richTextToPlain(toRichText(heading.text)) : String(heading.text ?? '')).trim()) heading = null;
  const fallback = js(overlayName(ctx, o));
  const own = node.ariaLabel;
  if (own !== undefined && !isBinding(own) && String(own).trim()) return ` aria-label=${attrJs(String(own).trim())}`;
  const has = (v: unknown) => {
    useImport(ctx, '{ has }', `${RUNTIME_DIR}/util.js`);
    return `has(${bindExpr(ctx, v)})`;
  };
  const value = isBinding(own) ? bindExpr(ctx, own) : null;
  const named = value ? has(own) : null;
  if (!heading) return ` aria-label={${named ? `${named} ? ${value} : ${fallback}` : fallback}}`;
  const by = headingIdExpr(ctx, heading);
  const worded = isBinding(heading.text) ? has(heading.text) : null;
  if (!named && !worded) return ` aria-labelledby={${by}}`;
  const label = named ? `${named} ? ${value} : ${worded ? `${worded} ? undefined : ${fallback}` : 'undefined'}` : `${worded} ? undefined : ${fallback}`;
  return ` aria-label={${label}} aria-labelledby={${[named && `!${named}`, worded].filter(Boolean).join(' && ')} ? ${by} : undefined}`;
}

/**
 * The script of a design's dialogs and drawers (see emitOverlay): each one's <dialog> and the button that last opened
 * it, and an effect opening it as a modal while its state says so. Leaving the page closes them, without taking the
 * focus back: a header or footer stays while the page changes. In the editor's variant one opens only while the page
 * is previewed as visitors see it (the bridge marks <html> with `data-so-bridge="preview"`), never while it is edited
 * or before the editor has said which.
 */
function overlayScript(ctx: EmitCtx): string {
  const overlays = [...(ctx.widgets?.overlays.values() ?? [])];
  if (!overlays.length) return '';
  useImport(ctx, '{ overlayOpen }', `${RUNTIME_DIR}/util.js`);
  ctx.imports.set('{ beforeNavigate }', '$app/navigation');
  const lines: string[] = [];
  if (ctx.instrument)
    lines.push(
      `\tlet so_previewing = $state(false);`,
      `\t$effect(() => {`,
      `\t\tconst html = globalThis.document.documentElement;`,
      `\t\tconst sync = () => (so_previewing = html.getAttribute('data-so-bridge') === 'preview');`,
      `\t\tsync();`,
      `\t\tconst watch = new globalThis.MutationObserver(sync);`,
      `\t\twatch.observe(html, { attributes: true, attributeFilter: ['data-so-bridge'] });`,
      `\t\treturn () => watch.disconnect();`,
      `\t});`
    );
  for (const o of overlays) {
    const open = stateIs(ctx, o.state, o.shows);
    lines.push(`\tlet ${o.dialog} = $state();`, `\tlet ${o.opener} = null;`, `\t$effect(() => overlayOpen(${o.dialog}, ${ctx.instrument ? `so_previewing && ${open}` : open}));`);
  }
  lines.push(`\tbeforeNavigate(() => {`);
  for (const o of overlays) lines.push(`\t\t${o.opener} = null;`, `\t\t${ctx.states!.get(o.state)!.local} = ${js(!o.shows)};`);
  lines.push(`\t});`);
  return lines.join('\n') + '\n';
}

/**
 * A plain text's words, inside a `<time>` element while it states a date: its `datetime` (a YYYY-MM-DD date, bound
 * or literal) is the machine-readable form of the words. A date that is empty or not a calendar day leaves the words
 * as they are.
 */
function timeContent(ctx: EmitCtx, node: GraphNode & { kind: 'text' }, val: string): string {
  const dt = node.datetime;
  if (dt === undefined || node.rich) return `{${val}}`;
  if (!isBinding(dt)) return typeof dt === 'string' && isArticleDate(dt.trim()) ? `<time datetime={${js(dt.trim())}}>{${val}}</time>` : `{${val}}`;
  // A bound value is only a date when it is one: a placement's text that is not leaves the words plain.
  useImport(ctx, '{ isDate }', `${RUNTIME_DIR}/util.js`);
  const expr = bindExpr(ctx, dt);
  return `{#if isDate(${expr})}<time datetime={${expr}}>{${val}}</time>{:else}{${val}}{/if}`;
}

/**
 * What a link shows: its label, and its icon (decorative, since the label names the link) on the chosen side.
 * A bound icon shows only while it is set, and a bound side is read at runtime.
 */
function linkContent(ctx: EmitCtx, node: GraphNode & { kind: 'link' }, label: string): string {
  const icon = node.icon;
  if (icon === undefined || (!isBinding(icon) && !String(icon).trim())) return `{${label}}`;
  useImport(ctx, 'SoIcon', `${RUNTIME_DIR}/Icon.svelte`);
  const name = isBinding(icon) ? bindExpr(ctx, icon) : js(String(icon));
  const mark = (side: string) => {
    const svg = `<SoIcon name={${name}} class=${js(`so-link__icon so-link__icon--${side}`)} />`;
    if (!isBinding(icon)) return svg;
    useImport(ctx, '{ has }', `${RUNTIME_DIR}/util.js`);
    return `{#if has(${name})}${svg}{/if}`;
  };
  const at = (side: string) => (side === 'end' ? `{${label}}${mark('end')}` : `${mark('start')}{${label}}`);
  const position = node.iconPosition;
  if (!isBinding(position)) return at(position === 'end' ? 'end' : 'start');
  return `{#if ${bindExpr(ctx, position)} === 'end'}${at('end')}{:else}${at('start')}{/if}`;
}

function emitInstance(ctx: EmitCtx, node: InstanceNode): string {
  const p = pad(ctx);
  const def = ctx.state.components[node.definitionId];
  if (!def) return `${p}<!-- Missing component definition ${node.definitionId} -->`;
  const name = importName(def);
  useImport(ctx, name, defFile(def));
  const attrs: string[] = [];
  // Class: definitions pass their node class; pages pass nothing (overrides use so_o). A code placement inside a
  // definition shows its root again through the same markers a page's code placement takes (see shownClasses).
  const rootShown = shownClasses(def, node.overrides?.root).trim();
  if (ctx.def) attrs.push(`class=${classExpr(ctx, node, rootShown ? [js(rootShown)] : [])}`);
  // A page placement kept from a detached design still hands its root the inert classes it had there, for the theme
  // (with a code component's root override class, below). A code component with a property of that name takes none.
  const pageClasses = ctx.def || (def.kind === 'code' && Object.hasOwn(def.properties, 'class')) ? [] : detachedClasses(node);
  for (const [propName, schema] of Object.entries(def.properties).sort(([a], [b]) => a.localeCompare(b))) {
    const raw = Object.hasOwn(node.props, propName) ? node.props[propName] : schema.default;
    const code = def.kind === 'code';
    const rctx = code ? { ...ctx.rctx, forCode: true } : ctx.rctx;
    // A computed list is never bound or stored: on a page it is worked out for that page, and inside a design (which
    // every page shares) it takes the rows the page handed down (`so_pages`).
    const feed = schema.type === 'list' && schema.feed;
    let expr = feed
      ? ctx.def
        ? designRowsExpr(schema, rctx, entryQuery(def.properties, node.props))
        : js(resolveValue(schema, [], rctx, entryQuery(def.properties, node.props)))
      : isBinding(raw)
        ? bindExpr(ctx, raw)
        : js(resolveValue(schema, raw, rctx));
    // A value bound from the design arrives as blocks; each field the code takes as paragraph strings is converted.
    const fields = code && isBinding(raw) ? paragraphFields(schema) : [];
    if (code && isBinding(raw) && ((schema.type === 'richtext' && !codeTakesBlocks(schema)) || fields.length)) {
      useImport(ctx, '{ richParagraphs }', `${RUNTIME_DIR}/util.js`);
      // An object is converted as the one item of a list.
      expr = schema.type === 'richtext' ? `richParagraphs(${expr})` : schema.type === 'object' ? `richParagraphs([${expr}], ${js(fields)})[0]` : `richParagraphs(${expr}, ${js(fields)})`;
    }
    attrs.push(propAttr(propKey(def, propName), expr));
  }
  const chosen = Object.entries(selectedVariants(def, node.variants));
  const axes = new Map(axesOf(def));
  // A bound axis shows its default for any value that is not one of its options.
  const variantExpr = (v: unknown, axis: string) => {
    if (!isBindingRef(v)) return js(v);
    const a = axes.get(axis)!;
    const value = bindExpr(ctx, v);
    return `{${js(Object.keys(a.options))}.includes(${value}) ? ${value} : ${js(a.default)}}`;
  };
  // A code placement whose own choice names none of the options is given nothing on that axis, so the code's own
  // fallback shows, as it did before axes (a first-format value naming no variant passed no `variant`).
  const stale = (axis: string) => {
    const own = def.kind === 'code' && node.variants && Object.hasOwn(node.variants, axis) ? node.variants[axis] : undefined;
    return typeof own === 'string' && !Object.hasOwn(axes.get(axis)!.options, own);
  };
  for (const [axis, value] of chosen) {
    // A code component gets an axis prop only if its source reads it; anything else would land in its rest props.
    if (def.kind === 'code' && (Object.hasOwn(def.properties, variantProp(axis)) || !def.source?.includes(variantProp(axis)) || stale(axis))) continue;
    attrs.push(`${variantProp(axis)}=${variantExpr(value, axis)}`);
  }
  // Code components read the first axis as `variant`, the contract they have always had.
  if (def.kind === 'code' && chosen.length && !Object.hasOwn(def.properties, 'variant') && !stale(chosen[0][0])) attrs.push(`variant=${variantExpr(chosen[0][1], chosen[0][0])}`);
  // A section's anchor lands on its component's root element.
  if (isDefRoot(ctx, node)) attrs.push(node.anchor ? `so_id={so_id ?? ${js(node.anchor)}}` : 'so_id={so_id}');
  else if (node.anchor) attrs.push(`so_id=${attrJs(node.anchor)}`);
  // So does its entrance, and its place in a staggered list, when the site has entrances.
  const ownAppear = node.appear === 'none' || isAppearPreset(node.appear) ? node.appear : undefined;
  if (def.kind === 'managed' && isDefRoot(ctx, node) && ctx.standalone) {
    // Written in: the code copy passes its one placement's choice (or its root's own) straight to the design inside.
    const chosen = ctx.standalone.appear ?? ownAppear;
    if (chosen) attrs.push(`so_appear=${attrJs(chosen)}`);
  } else if (def.kind === 'managed' && (ctx.standalone || appearPlumbing(ctx.state))) {
    // A code copy writes in what every placement inside it chose, whatever the site uses today.
    const own = ownAppear;
    if (isDefRoot(ctx, node)) attrs.push(own ? `so_appear={so_appear ?? ${js(own)}}` : 'so_appear={so_appear}', 'so_stagger={so_stagger}');
    else {
      if (own) attrs.push(`so_appear=${attrJs(own)}`);
      if (ctx.staggered?.has(node.id)) attrs.push(`so_stagger={${ctx.items[ctx.items.length - 1]}.id}`);
    }
  }
  // A design with a computed list somewhere inside gets the page's rows: worked out here for a page (or, in the
  // shared header and footer, for none), and passed on unchanged by every design in between.
  const needs = pageRowNeeds(ctx.state, def);
  if (needs) attrs.push(ctx.def ? 'so_pages={so_pages}' : `so_pages={${js(pageRows(ctx.rctx, needs))}}`);
  // The first section's images load eagerly through every definition between the page and the image.
  if (takesEager(ctx.state, def)) {
    if (!ctx.items.length && (ctx.def || ctx.firstSection)) attrs.push(ctx.def ? 'so_eager={so_eager}' : 'so_eager={true}');
  }
  // Instance overrides at page level are applied through generated override classes. Code components get the
  // same map, and their root override also through `class`, which every code component places on its root.
  // The editor's preview finds each declared part of a code placement by a class of its own (`so-part--total`), given
  // through the same hook its styles take, so a part is picked on the canvas without the code carrying any marker.
  const partMarks = ctx.instrument && !ctx.def && def.kind === 'code' ? Object.keys(def.parts).filter((pid) => pid !== 'root' && PART_CLASS_ID.test(pid)).sort() : [];
  if (!ctx.def && ((node.overrides && Object.keys(node.overrides).length) || partMarks.length)) {
    const map: Record<string, string> = {};
    // A code placement shows a part its code hides through classes, since its stylesheet cannot see those hides.
    for (const partId of Object.keys(node.overrides ?? {}).sort()) map[partId] = overrideClass(node.id, partId) + shownClasses(def, node.overrides![partId]);
    for (const pid of partMarks) map[pid] = Object.hasOwn(map, pid) ? `${map[pid]} so-part--${pid}` : `so-part--${pid}`;
    attrs.push(`so_o={${js(Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]])))}}`);
    if (def.kind === 'code' && map.root && !Object.hasOwn(def.properties, 'class')) pageClasses.unshift(map.root);
  }
  if (pageClasses.length) attrs.push(`class=${attrJs(pageClasses.join(' '))}`);
  // Styles of single list items: each item's parts get a class of their own, looked up by the item's ID.
  if (!ctx.def && node.itemOverrides) {
    const byItem: Record<string, Record<string, string>> = {};
    for (const partId of Object.keys(node.itemOverrides).sort()) {
      const entry = liveItemStyles(def, node, partId);
      for (const itemId of Object.keys(entry?.items ?? {}).sort()) {
        if (!entry!.items[itemId] || typeof entry!.items[itemId] !== 'object') continue;
        // Own keys only: an item ID can be any word, "toString" included.
        if (!Object.hasOwn(byItem, itemId)) byItem[itemId] = {};
        byItem[itemId][partId] = itemOverrideClass(node.id, partId, itemId);
      }
    }
    if (Object.keys(byItem).length) attrs.push(`so_oi={${js(byItem)}}`);
  }
  // Inside a design, a code component's inner parts take the design's override classes the same way; its root is
  // reached through the node class `class` already passes.
  if (ctx.def && def.kind === 'code') {
    const map: Record<string, string> = {};
    // A part its code hides is shown again through the same marker classes a page's placement passes.
    for (const partId of Object.keys(node.overrides ?? {}).sort()) if (partId !== 'root' && Object.hasOwn(def.parts, partId)) map[partId] = nestedOverrideClass(ctx.def, node.id, partId) + shownClasses(def, node.overrides![partId]);
    if (Object.keys(map).length) attrs.push(`so_o={${js(map)}}`);
  }
  // A managed component's inner parts take a class of the design's only for its state rules (see nestedStateMarker).
  if (ctx.def && def.kind === 'managed') {
    const map: Record<string, string> = {};
    for (const partId of Object.keys(node.overrides ?? {}).sort()) {
      const marker = nestedStateMarker(ctx.def, def, node, partId);
      if (marker) map[partId] = marker;
    }
    if (Object.keys(map).length) attrs.push(`so_o={${js(map)}}`);
  }
  if (ctx.instrument && def.kind === 'managed') {
    const childCtx = ctx.def ? `__so + ${js('|' + node.id)}` : js(`${ctx.ctxExpr}|${node.id}`);
    attrs.push(`__so={${childCtx}}`);
    const at = itemsExpr(ctx, node.id);
    if (at) attrs.push(`__so_at={${at}}`);
  }
  // Slots
  let slotContent = '';
  /** Snippets declared beside the placement rather than given to it, each passed only while editing. */
  const beside: string[] = [];
  if (def.slots) {
    const snippets: string[] = [];
    for (const slotName of Object.keys(def.slots).sort()) {
      // A list damaged by hand is no content (validation reports it).
      const placed = node.slots?.[slotName];
      const childIds = Array.isArray(placed) ? placed : [];
      if (!childIds.length) {
        // The editor's preview marks an empty slot where content can go. Visitors, and every export, see nothing.
        const marker = ctx.instrument ? emptySlotMarker(def.slots[slotName], slotName) : '';
        if (!marker) continue;
        // Only while editing: Preview, as visitors see the page, has nothing in the slot at all.
        ctx.usesEditing = true;
        if (def.kind === 'code') {
          // A code component may show something of its own while a slot is not given ({#if slot_x}…{:else}…): it
          // is given the placeholder only while editing, so Preview shows what visitors see.
          ctx.snippets = (ctx.snippets ?? 0) + 1;
          const snippet = `so_slot_empty_${ctx.snippets}`;
          beside.push(`${p}{#snippet ${snippet}()}\n${p}\t${marker}\n${p}{/snippet}`);
          attrs.push(`slot_${safeIdent(slotName)}={so_editing ? ${snippet} : undefined}`);
          continue;
        }
        snippets.push(`${p}\t{#snippet slot_${safeIdent(slotName)}()}\n${p}\t\t{#if so_editing}\n${p}\t\t\t${marker}\n${p}\t\t{/if}\n${p}\t{/snippet}`);
        continue;
      }
      ctx.indent += 2;
      const inner = emitNodes(ctx, childIds);
      ctx.indent -= 2;
      snippets.push(`${p}\t{#snippet slot_${safeIdent(slotName)}()}\n${inner}\n${p}\t{/snippet}`);
    }
    slotContent = snippets.join('\n');
  }
  const open = `${p}<${name}\n${attrs.map((a) => `${p}\t${a}`).join('\n')}\n${p}`;
  let markup = [...beside, slotContent ? `${open}>\n${slotContent}\n${p}</${name}>` : `${open}/>`].join('\n');
  if (ctx.instrument && def.kind === 'code') {
    const c = ctx.def ? '{__so}' : attrJs(ctx.ctxExpr);
    markup = `${p}<div style="display: contents" data-so-ctx=${c} data-so-node="${node.id}"${itemsAttr(ctx, node.id)} data-so-code="true">\n${indentBlock(markup)}\n${p}</div>`;
  }
  return markup;
}

/**
 * The placeholder an empty slot shows in the editor: its label, and what belongs there. Editor-only (rendered only
 * while editing, and styled by the bridge), and never written into a clean file. A slot closed to content (max 0)
 * shows none.
 */
function emptySlotMarker(decl: SlotDef | undefined, slotName: string): string {
  if (!decl || decl.max === 0) return '';
  const label = typeof decl.label === 'string' && decl.label.trim() ? decl.label.trim() : slotName;
  const description = typeof decl.description === 'string' ? decl.description.trim() : '';
  // Phrasing content only, so it is valid wherever the slot sits (a paragraph included); the bridge lays it out as a box.
  return `<span class="so-slot-empty" data-so-editor-only="" data-so-slot-empty={${js(slotName)}}><strong>{${js(label)}}</strong>${description ? `<span>{${js(description)}}</span>` : ''}</span>`;
}

/** The tags a hiding list may have for its placeholder to stand in its place: block content, valid where a list is. */
const LIST_PLACEHOLDER_TAGS = new Set(['ul', 'ol', 'div']);

/**
 * The placeholder that stands in for a hiding element (`collapseEmpty`) while its list of images is empty: a Gallery's
 * grid, a Carousel's track. It names the list, says where its images come from and that visitors never see it. Only
 * for a list that takes several images from Assets (see pickImagesField) and is not filled by a feed, repeated as the element's one child with no
 * condition of its own, so the element hides exactly while the list is empty. Editor variants only (rendered only
 * while editing, styled by the bridge); a clean file never has one.
 */
function emptyImageListMarker(ctx: EmitCtx, node: GraphNode & { kind: 'element' }): string {
  if (!ctx.instrument || !ctx.def || typeof node.tag !== 'string' || !LIST_PLACEHOLDER_TAGS.has(node.tag) || node.children.length !== 1) return '';
  const child = ctx.tree.nodes[node.children[0]];
  if (child?.kind !== 'repeat' || child.when || child.unless) return '';
  const schema = propSchemaFor(ctx, child.list);
  // A list a feed fills has no images to choose: the Inspector shows its entries instead.
  if (schema?.type !== 'list' || schema.feed || !pickImagesField(ctx.def, child.list.$prop, schema)) return '';
  // A definition saved by hand may have lost its label.
  const label = ((typeof schema.label === 'string' && schema.label.trim()) || 'Images').toLowerCase();
  return `<div class="so-list-empty" data-so-editor-only="" data-so-list-empty={${js(child.list.$prop)}}><strong>{${js(`No ${label} yet`)}}</strong><span>{${js('Choose images from Assets in the inspector. Visitors won’t see this box.')}}</span></div>`;
}

/**
 * Editor variants: an empty container (see isEmptyLayout) names its kind for the frame the bridge draws while
 * editing, with a grid's columns ruled in its gaps. Only an attribute: the page has no element more, and Preview,
 * which the bridge leaves unstyled, shows the container exactly as visitors get it. A carousel's track is left to
 * its own helper.
 */
function emptyFrameAttr(ctx: EmitCtx, node: GraphNode & { kind: 'element' }): string {
  if (!ctx.instrument || !isEmptyLayout(node) || isCarouselTrack(node)) return '';
  return ` data-so-empty-layout="${elementKind(node)}"`;
}

/**
 * Editor variants: `so_editing`, whether the editor shows the page in Edit (the bridge marks <html> with
 * `data-so-editing`), for what the markup shows only then. False until mounted, so the server's render and the
 * first paint have none of it, as Preview has none. The page's globals are reached through `globalThis`, which no
 * property's local takes (see INTERNAL_LOCALS): a component's own property may be called `document`.
 */
function editingState(ctx: EmitCtx): string {
  if (!ctx.usesEditing) return '';
  return [
    `\tlet so_editing = $state(false);`,
    `\t$effect(() => {`,
    `\t\tconst html = globalThis.document.documentElement;`,
    `\t\tconst sync = () => (so_editing = html.hasAttribute('data-so-editing'));`,
    `\t\tsync();`,
    `\t\tconst watch = new globalThis.MutationObserver(sync);`,
    `\t\twatch.observe(html, { attributes: true, attributeFilter: ['data-so-editing'] });`,
    `\t\treturn () => watch.disconnect();`,
    `\t});`
  ].join('\n') + '\n';
}

/**
 * Markup of an editor variant, between boundary comments of its own. The preview swaps a changed file in place,
 * and Svelte removes the old copy by walking from the first DOM node it recorded for it. Hydrated markup that
 * starts with another component (or a block or snippet holding one) records that component's first element,
 * which a hot update of the component alone replaces; the next update of this file then removes nothing and
 * the old copy stays above the new one (#14). A constant key block renders its contents once and adds an empty
 * comment before and after them. One native element already starts and ends on nodes of its own, so it is left
 * as it is. Editor variants only: the exported site is never hot-updated and stays free of it.
 */
function hotBoundary(markup: string, roots: number): string {
  if (roots === 1 && /^<[a-z][a-z0-9-]*[\s/>]/.test(markup.trimStart())) return markup;
  return `{#key 'siteorigin'}\n${markup}\n{/key}`;
}

function renderImports(imports: Map<string, string>): string {
  return [...imports.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, path]) => `\timport ${name} from ${js(path)};`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Component files
// ---------------------------------------------------------------------------

function propDefaultExpr(schema: PropSchema, ctx: ResolveContext): string {
  // A computed list is filled by each placement, for its page; the component's own file never holds articles.
  if (schema.type === 'list' && schema.feed) return '[]';
  return js(resolveValue(schema, schema.default, ctx));
}

/** Whether a node sits inside a list, where items are repeated and never take the page's `so_eager` flag. */
function insideRepeat(def: ComponentDefinition, parents: Map<string, string>, nodeId: string): boolean {
  const seen = new Set<string>();
  for (let id = parents.get(nodeId); id && !seen.has(id); id = parents.get(id)) {
    seen.add(id);
    if (def.tree!.nodes[id]?.kind === 'repeat') return true;
  }
  return false;
}

/**
 * Whether a definition takes the page's `so_eager` flag: code components whose source mentions it, such as
 * a copy converted to code, and managed ones with images (or with instances that take the flag themselves)
 * outside lists. A code component that declares the property itself owns it and is never handed the flag.
 */
function takesEager(state: ProjectState, def: ComponentDefinition, memo: Map<string, boolean> = new Map()): boolean {
  // A plain token test: linear in the source, and blind to how the author writes the destructuring.
  if (def.kind === 'code') return !Object.hasOwn(def.properties, 'so_eager') && /\bso_eager\b/.test(def.source ?? '');
  return treeTakesEager(state, def, memo, new Set());
}

/**
 * Whether a definition's tree has an image, or an instance that takes the flag, outside every list. Each
 * definition is judged once (`memo`) however many times it is placed; `path` only cuts a definition that contains
 * itself, which validation rejects.
 */
function treeTakesEager(state: ProjectState, def: ComponentDefinition, memo: Map<string, boolean>, path: Set<string>): boolean {
  if (!def.tree || path.has(def.id)) return false;
  const known = memo.get(def.id);
  if (known !== undefined) return known;
  path.add(def.id);
  const parents = parentMap(def.tree);
  const found = Object.values(def.tree.nodes).some((n) => {
    if (n.kind !== 'image' && n.kind !== 'instance') return false;
    if (insideRepeat(def, parents, n.id)) return false;
    if (n.kind === 'image') return true;
    const child = state.components[n.definitionId];
    return !!child && (child.kind === 'code' ? takesEager(state, child, memo) : treeTakesEager(state, child, memo, path));
  });
  path.delete(def.id);
  memo.set(def.id, found);
  return found;
}

/**
 * What a design needs of its page's rows: how many of the newest articles (Infinity: all, 0: none), the page itself,
 * and each entry feed inside it, by the key of what its placement chose (see shared/entry-feed.ts).
 */
interface RowNeeds {
  articles: number;
  currentPage: boolean;
  entries: Map<string, { query: EntryQuery; max?: number }>;
}

/**
 * What of its page's rows a definition needs handed down (`so_pages`), or null for none: the computed lists placed
 * anywhere in its tree (a News list or Article header inside a group made into a component), and what any design or
 * converted code inside it needs in turn. Code that reads `so_pages` gets every article and the page, since its source
 * decides; entry feeds are chosen by a placement's properties, which code does not have, so it gets none.
 */
function pageRowNeeds(state: ProjectState, def: ComponentDefinition, memo: Map<string, RowNeeds | null> = new Map(), path: Set<string> = new Set()): RowNeeds | null {
  if (def.kind === 'code') {
    const source = def.source ?? '';
    if (Object.hasOwn(def.properties, 'so_pages') || !/\bso_pages\b/.test(source) || path.has(def.id)) return null;
    // Worked out once per definition, however many components place it.
    if (memo.has(def.id)) return memo.get(def.id)!;
    const entries = codeEntryNeeds(source);
    // And what the components it places need in turn: code converted from a design imports the designs (or code made
    // from them) inside it, by their files' names.
    path.add(def.id);
    for (const d of Object.values(state.components)) {
      if (d.id === def.id || !source.includes(`/${defFile(d).split('/').pop()}`)) continue;
      for (const [k, q] of pageRowNeeds(state, d, memo, path)?.entries ?? []) entries.set(k, q);
    }
    path.delete(def.id);
    const needs = { articles: Infinity, currentPage: true, entries };
    memo.set(def.id, needs);
    return needs;
  }
  return treeRowNeeds(state, def, memo, path);
}

/**
 * The entry feeds code reads from `so_pages`, by the keys its source names: code converted from a design keeps the
 * reads its design's feeds were written with (`so_pages?.entries?.["…"]`), each naming what its placement chose.
 */
function codeEntryNeeds(source: string): RowNeeds['entries'] {
  return new Map(codeEntryQueries(source).map(({ key, query, max }) => [key, { query, ...(max !== undefined ? { max } : {}) }]));
}

/** What a definition's tree needs of its page's rows, whatever kind the definition is (a copy being converted to code is written from its tree). */
function treeRowNeeds(state: ProjectState, def: ComponentDefinition, memo: Map<string, RowNeeds | null> = new Map(), path: Set<string> = new Set()): RowNeeds | null {
  if (!def.tree || path.has(def.id)) return null;
  if (memo.has(def.id)) return memo.get(def.id)!;
  path.add(def.id);
  const out: RowNeeds = { articles: 0, currentPage: false, entries: new Map() };
  const add = (n: RowNeeds | null) => {
    if (!n) return;
    out.articles = Math.max(out.articles, n.articles);
    out.currentPage ||= n.currentPage;
    for (const [key, q] of n.entries) out.entries.set(key, q);
  };
  for (const n of Object.values(def.tree.nodes)) {
    if (n.kind !== 'instance') continue;
    const child = state.components[n.definitionId];
    if (!child) continue;
    for (const p of Object.values(child.properties)) {
      if (p.type !== 'list' || !p.feed) continue;
      if (feedLimit(p) === 0) continue;
      if (p.feed === 'currentPage') out.currentPage = true;
      else if (p.feed === 'articles') out.articles = Math.max(out.articles, feedLimit(p));
      else if (p.feed === 'entries') {
        // What the placement inside the design chose: its own values, the same on every page that places the design.
        const query = entryQuery(child.properties, n.props);
        const max = Number.isFinite(feedLimit(p)) ? feedLimit(p) : undefined;
        out.entries.set(entryQueryKey(query, max), { query, ...(max !== undefined ? { max } : {}) });
      }
    }
    add(pageRowNeeds(state, child, memo, path));
  }
  path.delete(def.id);
  const found = out.articles > 0 || out.currentPage || out.entries.size ? out : null;
  memo.set(def.id, found);
  return found;
}

/**
 * The rows a page hands to a design, resolved as list items are (a page or entry link becomes its address, a picture
 * the files to show), and no more than it needs: entry feeds' rows by the key of each query.
 */
function pageRows(rctx: ResolveContext, needs: RowNeeds): Record<string, unknown> {
  const resolve = (feed: 'articles' | 'currentPage', max?: number) => placedRows(rctx, { feed, ...(max !== undefined ? { max } : {}) }).map((r) => ({ ...r, pageLink: resolveLink(r.pageLink as LinkValue, rctx) }));
  const entries = [...needs.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    ...(needs.articles > 0 ? { articles: resolve('articles', Number.isFinite(needs.articles) ? needs.articles : undefined) } : {}),
    ...(needs.currentPage ? { currentPage: resolve('currentPage') } : {}),
    ...(entries.length
      ? {
          entries: Object.fromEntries(
            entries.map(([key, { query, max }]) => [
              key,
              placedRows(rctx, { feed: 'entries', ...(max !== undefined ? { max } : {}) }, query).map((r) => ({ ...r, pageLink: resolveLink(r.pageLink as LinkValue, rctx), image: resolveImage(r.image as ImageValue, rctx) }))
            ])
          )
        }
      : {})
  };
}

/**
 * A computed list inside a design: the rows its page handed down (for an entry feed, those of what this placement
 * chose), cut to its own limit and shaped as a directly placed list's items (its declared fields only, a field rows
 * do not fill set to its default).
 */
function designRowsExpr(schema: ListProp, rctx: ResolveContext, query: EntryQuery): string {
  const feed = (LIST_FEEDS as readonly string[]).includes(schema.feed as string) ? (schema.feed as ListFeed) : null;
  const limit = feedLimit(schema);
  // Nothing to show needs nothing handed down (and reads no `so_pages`, which the design then does not declare).
  if (!feed || limit === 0) return '[]';
  // Each row as a directly placed list's item: its ID and the list's own fields, a row's value or the field's default.
  const filled = feedRowFields(feed);
  const fields = Object.entries(schema.fields).filter(([k]) => k !== 'id').map(([k, f]) => `${js(k)}: ${Object.hasOwn(filled, k) ? `row[${js(k)}]` : js(resolveValue(f, f.default, rctx))}`);
  let expr = feed === 'entries' ? `(so_pages?.entries?.[${js(entryQueryKey(query, Number.isFinite(limit) ? limit : undefined))}] ?? [])` : `(so_pages?.[${js(feed)}] ?? [])`;
  if (Number.isFinite(limit)) expr += `.slice(0, ${limit})`;
  return `${expr}.map((row) => ({ id: row.id${fields.map((f) => `, ${f}`).join('')} }))`;
}

export function generateManagedComponent(state: ProjectState, def: ComponentDefinition, opts: GenerateOptions, standalone?: EmitCtx['standalone']): string {
  const file = defFile(def);
  const tree = def.tree!;
  const locals = propLocals(def);
  const ctx: EmitCtx = {
    state,
    file,
    imports: new Map(),
    instrument: !!opts.instrument,
    def,
    tree,
    ctxExpr: '',
    items: [],
    rctx: { state },
    indent: 0,
    locals,
    standalone,
    states: stateLocals(def),
    previewOpen: !!opts.instrument && opts.previewOpen === def.id
  };
  ctx.widgets = stateWidgets(ctx);
  ctx.filters = repeatFilters(def);
  const markup = emitNodes(ctx, tree.rootIds);
  const filters = filterScript(ctx);
  const propDecls = Object.entries(def.properties)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, schema]) => {
      const key = propKey(def, name);
      const local = locals.get(name)!;
      const head = key === local ? local : `${/^[a-zA-Z_$][\w$]*$/.test(key) ? key : js(key)}: ${local}`;
      return `\t\t${head} = ${propDefaultExpr(schema, ctx.rctx)},`;
    });
  const legacyCaller = hasLegacyVariantCaller(state, def);
  if (legacyCaller) propDecls.push(`\t\tvariant = undefined,`);
  for (const [axis, a] of axesOf(def)) {
    // A single first-format value selects its own axis and the plain option of the others.
    const plain = Object.hasOwn(a.options, 'default') ? 'default' : a.default;
    const fallback = legacyCaller ? `${js(Object.keys(a.options))}.includes(variant) ? variant : variant === undefined ? ${js(a.default)} : ${js(plain)}` : js(a.default);
    propDecls.push(`\t\t${variantProp(axis)} = ${fallback},`);
  }
  for (const slotName of Object.keys(def.slots ?? {}).sort()) propDecls.push(`\t\tslot_${safeIdent(slotName)} = undefined,`);
  propDecls.push(`\t\tso_o = undefined,`);
  if (Object.keys(def.parts).some((pid) => repeatedPartList(def, pid))) propDecls.push(`\t\tso_oi = undefined,`);
  propDecls.push(`\t\tso_id = undefined,`);
  if (appearPlumbing(state) && !standalone) propDecls.push(`\t\tso_appear = undefined,`, `\t\tso_stagger = undefined,`);
  // A converted copy is generated before its source exists, so its markup decides, not the source.
  if (treeTakesEager(state, def, new Map(), new Set())) propDecls.push(`\t\tso_eager = false,`);
  // A converted copy is generated before its source exists, so its tree decides, as for `so_eager`.
  if (treeRowNeeds(state, def)) propDecls.push(`\t\tso_pages = undefined,`);
  if (opts.instrument) propDecls.push(`\t\t__so = '',`, `\t\t__so_at = '',`);
  propDecls.push(`\t\tclass: className = ''`);
  const overlays = overlayScript(ctx);
  const imports = renderImports(ctx.imports);
  const uid = ctx.usesUid ? `\tconst uid = $props.id();\n` : '';
  // Each placement holds its own UI state, starting where the design says.
  const states = [...ctx.states!.values()].map((s) => `\tlet ${s.local} = $state(${js(s.schema.initial)});\n`).join('');
  return (
    HEADER_NOTE(`siteorigin/components/${def.id}/component.json`) +
    `<script>\n${imports ? imports + '\n\n' : ''}\tlet {\n${propDecls.join('\n')}\n\t} = $props();\n${uid}${states}${filters}${editingState(ctx)}${overlays}</script>\n\n${opts.instrument ? hotBoundary(markup, tree.rootIds.length) : markup}\n`
  );
}

/**
 * A managed definition as one self-contained Svelte file: its markup plus a <style> block with every node,
 * responsive, nested-override and variant rule, under the definition's own class names. Used to convert a copy
 * to code, so the result keeps its appearance without the original definition's stylesheet. `appear` is the entrance
 * the placement being converted chose for the root (see EmitCtx.standalone), since a code component takes none.
 */
export function generateStandaloneComponent(state: ProjectState, def: ComponentDefinition, appear?: AppearPreset | 'none'): string {
  const body = generateManagedComponent(state, def, { instrument: false }, { appear });
  // A category filter's hiding and print rules come along, as the site's own stylesheet has them only for designs.
  const css = [emitRules(definitionRules(state, def, true)), repeatFilters(def).length ? filterCss(true) : ''].filter(Boolean).join('\n');
  return css ? `${body}\n<style>\n${indentBlock(css)}\n</style>\n` : body;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function pageFile(page: PageDoc): string {
  const dir = routeDir(page.route);
  return `src/routes/${dir ? dir + '/' : ''}+page.svelte`;
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * The search and sharing tags of a page's or an entry's `<head>`, from its metadata (see ./seo-metadata): its title
 * and description, what Open Graph, an article and an X (Twitter) card say of it, its canonical address and whether
 * search engines may list it. Each tag is left out when it has nothing to say. `alternates` are the languages of the
 * page's other versions (its own among them). User text is emitted as Svelte string literals, never as template
 * text, so "{" cannot become code.
 */
function seoHead(state: ProjectState, meta: SeoMetadata, opts: { article: boolean; alternates: readonly string[] }): string[] {
  const head: string[] = [`\t<title>{${js(meta.title)}}</title>`];
  if (meta.description) head.push(`\t<meta name="description" content={${js(meta.description)}} />`);
  head.push(`\t<meta property="og:type" content="${opts.article ? 'article' : 'website'}" />`);
  if (opts.article) {
    if (meta.published) head.push(`\t<meta property="article:published_time" content={${js(meta.published)}} />`);
    if (meta.modified) head.push(`\t<meta property="article:modified_time" content={${js(meta.modified)}} />`);
    if (meta.author) head.push(`\t<meta property="article:author" content={${js(meta.author)}} />`);
    if (meta.section) head.push(`\t<meta property="article:section" content={${js(meta.section)}} />`);
    for (const tag of meta.tags) head.push(`\t<meta property="article:tag" content={${js(tag)}} />`);
  }
  head.push(`\t<meta property="og:title" content={${js(meta.socialTitle)}} />`);
  if (meta.description) head.push(`\t<meta property="og:description" content={${js(meta.description)}} />`);
  // The language as Open Graph writes it ("fr_FR"), and those of the page's other versions.
  const locale = ogLocale(meta.language);
  if (locale) head.push(`\t<meta property="og:locale" content=${js(locale)} />`);
  const others = new Set(opts.alternates.map(ogLocale).filter((l): l is string => !!l && l !== locale));
  for (const l of others) head.push(`\t<meta property="og:locale:alternate" content=${js(l)} />`);
  if (meta.canonical) {
    head.push(`\t<link rel="canonical" href={${js(meta.canonical)}} />`);
    head.push(`\t<meta property="og:url" content={${js(meta.canonical)}} />`);
  }
  const image = meta.imageUrl ? meta.image : undefined;
  if (meta.imageUrl && image) {
    head.push(`\t<meta property="og:image" content={${js(meta.imageUrl)}} />`);
    if (image.width && image.height) {
      head.push(`\t<meta property="og:image:width" content=${js(String(image.width))} />`);
      head.push(`\t<meta property="og:image:height" content=${js(String(image.height))} />`);
    }
    if (meta.imageAlt) head.push(`\t<meta property="og:image:alt" content={${js(meta.imageAlt)}} />`);
  }
  head.push(`\t<meta name="twitter:card" content=${js(image ? 'summary_large_image' : 'summary')} />`);
  // Who publishes the site names its account; a handle stored on the site itself is the fallback.
  const handle = derived(state, 'twitterSite', (s) => siteTwitterHandle(s.site) ?? twitterHandle(s.site.twitterSite));
  if (handle) head.push(`\t<meta name="twitter:site" content=${js(handle)} />`);
  head.push(`\t<meta name="twitter:title" content={${js(meta.socialTitle)}} />`);
  if (meta.description) head.push(`\t<meta name="twitter:description" content={${js(meta.description)}} />`);
  if (meta.imageUrl && image) {
    head.push(`\t<meta name="twitter:image" content={${js(meta.imageUrl)}} />`);
    if (meta.imageAlt) head.push(`\t<meta name="twitter:image:alt" content={${js(meta.imageAlt)}} />`);
  }
  if (meta.noindex) head.push(`\t<meta name="robots" content="noindex" />`);
  return head;
}

export function generatePage(state: ProjectState, page: PageDoc, opts: GenerateOptions): string {
  const file = pageFile(page);
  const ctx: EmitCtx = {
    state,
    file,
    imports: new Map(),
    instrument: !!opts.instrument,
    def: null,
    tree: page,
    ctxExpr: `page:${page.id}`,
    items: [],
    rctx: { state, pageId: page.id },
    indent: 0,
    locals: new Map()
  };
  // The first section is usually what fills the first screen; its images load eagerly.
  const markup = page.rootIds
    .map((id, i) => {
      ctx.firstSection = i === 0;
      return emitNode(ctx, id);
    })
    .filter(Boolean)
    .join('\n');
  ctx.firstSection = false;
  const site = state.site;
  // What the page says about itself when its link is shared, as the SEO audit and the editor's preview read it.
  const meta = pageMetadata(state, page)!;
  // A dated article says so, with its publication date in a form other sites and readers can use.
  const article = pageArticle(page);
  const base = publicUrl(site);
  const alternates = pageAlternates(state, page);
  const head = seoHead(state, meta, { article: !!article, alternates: alternates.map((a) => a.language) });
  // The page's Markdown copy beside it, for AI agents, while the site writes one (see generator/llms.ts).
  if (hasMarkdownMirror(state, { kind: 'page', pageId: page.id })) head.push(MARKDOWN_ALTERNATE);
  // The same page in other languages, and this one among them: each version lists the same set.
  // Without a public address they are site paths, resolved as authored links are, so they hold under any sub-path.
  for (const alt of alternates) head.push(`\t<link rel="alternate" hreflang=${js(alt.language)} href={${base ? js(base + routeUrl(alt.route)) : `resolve(${js(alt.route)})`}} />`);
  // Structured data: one connected graph of who publishes the site, the website, this page and its trail from Home,
  // its FAQ and contact sections. A page search engines are asked not to list, or one with no public URL, has none.
  const graph = graphScript(state, { kind: 'page', pageId: page.id });
  if (graph) head.push(`\t{@html ${js(graph)}}`);
  const imports = [renderImports(ctx.imports), alternates.length && !base ? `\timport { resolve } from '$app/paths';` : ''].filter(Boolean).join('\n');
  const script = [imports, editingState(ctx).trimEnd()].filter(Boolean).join('\n\n');
  return (
    HEADER_NOTE(`siteorigin/pages/${page.id}.json`) +
    (script ? `<script>\n${script}\n</script>\n\n` : '') +
    `<svelte:head>\n${head.join('\n')}\n</svelte:head>\n\n${opts.instrument ? hotBoundary(markup, page.rootIds.length) : markup}\n`
  );
}

/**
 * One instance on its own, as the editor's isolated preview shows it: a Svelte module at `file` that renders the
 * instance inside a <main> of its own, as a page renders its first section, with no header or footer. Its props,
 * variants and identity attributes are emitted as a page placement's are, under the identity context `ctx`.
 * Editor-only: generateProject never makes one.
 */
export function generateIsolatedInstance(state: ProjectState, file: string, node: InstanceNode, ctx: string): string {
  const ectx: EmitCtx = {
    state,
    file,
    imports: new Map(),
    instrument: true,
    def: null,
    tree: { rootIds: [node.id], nodes: { [node.id]: node } },
    ctxExpr: ctx,
    items: [],
    rctx: { state },
    indent: 1,
    locals: new Map(),
    firstSection: true
  };
  const markup = emitNode(ectx, node.id);
  const imports = renderImports(ectx.imports);
  return `<!-- SiteOrigin Builder's isolated preview of one component. Editor-only: never part of the website. -->\n<script>\n${imports}\n${editingState(ectx)}</script>\n\n<main id="main">\n${markup}\n</main>\n`;
}

export function generateLayout(state: ProjectState, opts: GenerateOptions): string {
  const file = 'src/routes/+layout.svelte';
  const mk = (tree: NodeTree, part: 'header' | 'footer'): EmitCtx => ({
    state,
    file,
    imports: new Map(),
    instrument: !!opts.instrument,
    def: null,
    tree,
    ctxExpr: `shell:${part}`,
    items: [],
    rctx: { state },
    indent: 1,
    locals: new Map()
  });
  const hctx = mk(state.site.shell.header, 'header');
  const header = emitNodes(hctx, state.site.shell.header.rootIds);
  const fctx = mk(state.site.shell.footer, 'footer');
  fctx.imports = hctx.imports;
  const footer = emitNodes(fctx, state.site.shell.footer.rootIds);
  const imports = renderImports(hctx.imports);
  // The header's and footer's empty slots share one `so_editing`.
  hctx.usesEditing ||= fctx.usesEditing;
  const editing = editingState(hctx);
  // An old address only sends visitors on: it shows no header or footer while it does. Worked out once per state in a
  // cached run, so the layout follows the list of old addresses, not every entry's details that decide it.
  const redirects = derived(state, 'redirectRouteIds', (s) => liveRedirects(s).map((r) => routeId(r.from)));
  // Every page asks AI services not to train on it while the crawler policy says so (shared/crawler-policy.ts).
  const noAi = crawlerRules(state.site).noAiMeta ? `\n\t${NOAI_META}` : '';
  // Every page names the site's RSS feed, while it has one, so a feed reader finds it from any address on the site.
  const feed = feedLink(state);
  const feedTag = feed ? `\n\t<link rel="alternate" type="application/rss+xml" title={${js(feed.title)}} href={${js(feed.url)}} />` : '';
  // An archive page shows both parts, even at the address of a draft made before archive pages.
  const archived = archiveRouteIds(state);
  const without = (part: ShellPart) => {
    const hidden = state.site.pageOrder
      .filter((id) => Object.hasOwn(state.pages, id) && !showsPart(state.pages[id], part))
      .map((id) => routeId(state.pages[id].route))
      .concat(redirects)
      .filter((id) => !archived.has(id));
    // The not-found page shows the part when a page does. Served at a missing address, it starts with no route at all.
    const shown = state.site.pageOrder.some((id) => Object.hasOwn(state.pages, id) && showsPart(state.pages[id], part));
    return (shown ? hidden : hidden.concat(routeId(NOT_FOUND_ROUTE), '')).sort();
  };
  const favicon = state.site.favicon && state.assets.assets[state.site.favicon];
  const iconHref = favicon ? favicon.file.replace(/^static\//, '') : DEFAULT_FAVICON;
  const iconType = favicon ? favicon.mime : 'image/svg+xml';
  // A site in more than one language keeps <html lang> and dir right as visitors move between its pages, and what
  // the site says on its own in the language of the page they are on.
  const languages = languagesByRoute(state).length
    ? `\n\tconst pageLanguages = ${routeLanguagesJs(state, '\t')};\n\tconst pageDirections = ${routeDirectionsJs(state, '\t')};\n\tconst language = $derived(page.route.id && Object.hasOwn(pageLanguages, page.route.id) ? pageLanguages[page.route.id] : ${js(siteLanguage(state.site))});\n\tspeak(() => language);\n\t$effect(() => {\n\t\tconst id = page.route.id;\n\t\tdocument.documentElement.lang = language;\n\t\tdocument.documentElement.dir = id && Object.hasOwn(pageDirections, id) ? pageDirections[id] : ${js(siteDirection(state.site))};\n\t});`
    : '';
  // Until the bridge is running, no form on the page can be sent: the editor never sends a message from the site on
  // the author's behalf (issue #193). The hold is in place before any form's own code, and the bridge removes it.
  // Sections and containers with an entrance come in as they first scroll into view (see generator/appear.ts). The
  // editor's layout already imports onMount for its bridge.
  const appear = derived(state, 'usesAppear', usesAppear);
  const appearImport = appear ? `${opts.instrument ? '' : `\n\timport { onMount } from 'svelte';`}\n\timport { observeAppear } from '../lib/siteorigin/runtime/${APPEAR_FILE}';` : '';
  const appearStart = appear ? `\n\t// Sections and containers with an entrance fade or lift in as they first scroll into view.\n\tonMount(observeAppear);` : '';
  // The visitor's Light/Dark switch goes in the shared header while the page shows it (see generator/color-scheme.ts).
  // The website also applies a remembered choice before anything is drawn; the editor's preview remembers none.
  const toggle = usesThemeToggle(state);
  const toggleImport = toggle ? `\n\timport { startThemeToggle } from '../lib/siteorigin/runtime/${THEME_TOGGLE_FILE}';` : '';
  // The browser's own colour (theme-color) follows the visitor's choice too, on every page, header or not.
  const toggleStart = toggle
    ? `\n\t// The visitor's Light/Dark switch, in the shared header while the page shows it.\n\t$effect(() => {\n\t\tif (!showHeader) return;\n\t\treturn startThemeToggle(() => text().themeToggle);\n\t});\n\t// The colour the browser shows around the page follows the visitor's choice, not only the device's setting.\n\tlet chosenScheme = $state(null);\n\t$effect(() => {\n\t\tconst root = document.documentElement;\n\t\tconst read = () => (chosenScheme = root.dataset.soTheme ?? null);\n\t\tread();\n\t\tconst watch = new MutationObserver(read);\n\t\twatch.observe(root, { attributes: true, attributeFilter: ['data-so-theme'] });\n\t\treturn () => watch.disconnect();\n\t});`
    : '';
  const bootstrap = toggle && !opts.instrument ? `\n\t${themeBootstrap(themeStorageKey(state))}` : '';
  const devBridge = opts.instrument
    ? `\n\timport { onMount } from 'svelte';\n\timport { afterNavigate } from '$app/navigation';\n\tif (typeof window !== 'undefined' && !window.__siteoriginBridge && !window.__siteoriginHold) {\n\t\twindow.__siteoriginHold = (e) => (e.preventDefault(), e.stopImmediatePropagation());\n\t\tdocument.addEventListener('submit', window.__siteoriginHold, true);\n\t}\n\tonMount(() => {\n\t\timport('virtual:siteorigin-bridge');\n\t});\n\tafterNavigate(() => window.dispatchEvent(new CustomEvent('siteorigin:navigated')));`
    : '';
  return (
    HEADER_NOTE('siteorigin/site.json') +
    `<script>
	import '../lib/siteorigin/styles/tokens.css';
	import '../lib/siteorigin/styles/theme.css';
	import '../lib/siteorigin/styles/components.css';
	import '../lib/siteorigin/styles/site.css';
	import { page } from '$app/state';
	import { asset } from '$app/paths';
	import { keepDrafts } from '../lib/siteorigin/runtime/drafts.js';${appearImport}${toggleImport}
	import { ${languages ? 'speak, ' : ''}visitorText } from '../lib/siteorigin/runtime/visitor-text.js';
${imports}${languages}${devBridge}

	let { children } = $props();
	const text = visitorText();
	// A message typed into a form and not sent comes back when the visitor returns with Back.
	keepDrafts();${appearStart}
	// Each page chooses the shared header and footer on its own.
	const pagesWithoutHeader = new Set(${js(without('header'))});
	const pagesWithoutFooter = new Set(${js(without('footer'))});
	const showHeader = $derived(!pagesWithoutHeader.has(page.route.id ?? ''));
	const showFooter = $derived(!pagesWithoutFooter.has(page.route.id ?? ''));${toggleStart}
${editing}</script>

<svelte:head>${bootstrap}
	<link rel="icon" href={asset(${js(iconHref)})} type=${js(iconType)} />
	${siteIconLinks()}
	${themeColorMeta(state, toggle ? 'chosenScheme' : undefined)}
	<meta property="og:site_name" content={${js(state.site.name)}} />${feedTag}${noAi}
</svelte:head>

<a class="so-skip-link" href="#main">{text().skipLink}</a>
{#if showHeader}
${header}
{/if}
<main id="main">
	{@render children()}
</main>
{#if showFooter}
${footer}
{/if}
`
  );
}

export const LAYOUT_TS = `// Generated by SiteOrigin Builder. Every page is prerendered to static HTML.
export const prerender = true;
export const trailingSlash = 'always';
`;

export function generateAppHtml(state: ProjectState): string {
  const lang = siteLanguage(state.site);
  return `<!doctype html>
<html lang="${lang}" dir="${siteDirection(state.site)}">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		%sveltekit.head%
	</head>
	<body data-sveltekit-preload-data="hover">
		<div style="display: contents">%sveltekit.body%</div>
	</body>
</html>
`;
}

/**
 * Route IDs of the pages written in another language than the site's, with that language, sorted by route. Empty
 * for a site in one language: it then has no page-language files at all.
 */
export function routeLanguages(state: ProjectState): Array<[string, string]> {
  const site = siteLanguage(state.site);
  const out: Array<[string, string]> = [];
  const archived = archiveRouteIds(state);
  for (const id of state.site.pageOrder) {
    const page = state.pages[id];
    // A draft whose address an archive page has is not what shows there.
    if (!page || archived.has(routeId(page.route))) continue;
    const language = pageLanguage(state.site, page);
    if (!sameLanguage(language, site)) out.push([routeId(page.route), language]);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The languages of pages in another language than the site's, by route ID, as a script expression. */
function routeLanguagesJs(state: ProjectState, indent = ''): string {
  return JSON.stringify(Object.fromEntries(languagesByRoute(state)), null, '\t').replace(/\n/g, '\n' + indent);
}

/** The route IDs of the site's archive pages (see shared/archives.ts), worked out once per state in a cached run. */
const archiveRouteIds = (state: ProjectState): ReadonlySet<string> => new Set(derived(state, 'archiveRouteIds', (s) => archivePages(s).map((p) => routeId(p.route))));

/** routeLanguages as a file depends on it: on the list alone, not on every page that goes into it. */
const languagesByRoute = (state: ProjectState) => derived(state, 'routeLanguages', routeLanguages);

/**
 * Route IDs of the pages whose text runs the other way from the site's, with their direction, sorted by route: pages
 * in a language written the other way. Each is also a page in another language than the site's (routeLanguages).
 */
export function routeDirections(state: ProjectState): Array<[string, string]> {
  const site = siteDirection(state.site);
  const out: Array<[string, string]> = [];
  const archived = archiveRouteIds(state);
  for (const id of state.site.pageOrder) {
    const page = state.pages[id];
    if (!page || archived.has(routeId(page.route))) continue;
    const dir = pageDirection(state.site, page);
    if (dir !== site) out.push([routeId(page.route), dir]);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The directions of pages whose text runs the other way from the site's, by route ID, as a script expression. */
function routeDirectionsJs(state: ProjectState, indent = ''): string {
  return JSON.stringify(Object.fromEntries(derived(state, 'routeDirections', routeDirections)), null, '\t').replace(/\n/g, '\n' + indent);
}

/** The file of what the site says on its own (generateVisitorTextJs). */
export const VISITOR_TEXT_FILE = 'visitor-text.js';

/**
 * What the site says on its own (the skip link, the menu button, a form's progress) in every language its pages are
 * in, with the way components get the wording for the page they are on. The site's layout tells the components
 * below it which language that is (speak); a component shown without the layout, as in the editor's preview of one
 * component, speaks the site's language.
 */
const withoutKeys = <T extends object>(o: T, keys: string[]): Partial<T> => (keys.length ? (Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) as Partial<T>) : o);

export function generateVisitorTextJs(state: ProjectState): string {
  const site = siteLanguage(state.site);
  const codes = [...new Set([site, ...languagesByRoute(state).map(([, language]) => language)].map(visitorTextLanguage))].sort();
  // The Light/Dark switch's name goes only to a site that has the switch.
  const toggle = usesThemeToggle(state);
  const text = Object.fromEntries(codes.map((code) => [code, withoutKeys(visitorTextFor(state.site, code), toggle ? [] : ['themeToggle'])]));
  return `// Generated by SiteOrigin Builder from siteorigin/site.json and siteorigin/pages/*.json. What the site says on its
// own, around its content, in each language its pages are in. Site styles > Visitor text changes the wording.
import { getContext, setContext } from 'svelte';

/** The site's language, which pages without a language of their own are in. */
const SITE = ${js(visitorTextLanguage(site))};

/** The wording in each language, by lower-case language code. */
const TEXT = ${JSON.stringify(text, null, '\t')};

const LANGUAGE = 'siteorigin:visitor-language';

/** Makes the components below the caller speak the language \`language()\` gives. The site's layout calls it. */
export function speak(language) {
	setContext(LANGUAGE, language);
}

/**
 * The wording for the page a component is on, as a function to call wherever the wording is used, so it follows the
 * visitor from page to page. Like getContext, visitorText() itself is called while the component starts.
 */
export function visitorText() {
	const language = getContext(LANGUAGE);
	return () => {
		const code = String(language?.() ?? SITE).toLowerCase();
		return Object.hasOwn(TEXT, code) ? TEXT[code] : TEXT[SITE];
	};
}

/** Wording with each {name} in it replaced by that value. What goes in is never read for names itself. */
export function fill(text, values) {
	return text.replace(/\\{(\\w+)\\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
}

/**
 * Wording filled in as fill() does, in pieces: its own words, and each value with the name it filled, so markup can
 * set a value apart (in a <bdi>, to keep its own direction).
 */
export function fillParts(text, values) {
	const parts = [];
	let at = 0;
	for (const match of text.matchAll(/\\{(\\w+)\\}/g)) {
		if (!Object.hasOwn(values, match[1])) continue;
		if (match.index > at) parts.push({ text: text.slice(at, match.index) });
		parts.push({ text: String(values[match[1]]), name: match[1] });
		at = match.index + match[0].length;
	}
	if (at < text.length) parts.push({ text: text.slice(at) });
	return parts;
}
`;
}

/**
 * The versions of a published page in each language it has, itself among them, in page order: what its
 * alternate-language links name. None for a draft, for a page without translations, and for a set whose pages
 * clash on language (which the editor never lets happen).
 */
export function pageAlternates(state: ProjectState, page: PageDoc): Array<{ language: string; route: string; pageId: string }> {
  const group = translationGroup(page);
  if (!group || isDraftPage(state, page)) return [];
  const members = translationMembers(state, group)
    .filter((p) => state.site.pageOrder.includes(p.id) && !isDraftPage(state, p))
    .map((p) => ({ language: pageLanguage(state.site, p), route: p.route, pageId: p.id }));
  const languages = new Set(members.map((m) => m.language.toLowerCase()));
  return members.length < 2 || languages.size < members.length ? [] : members;
}

/** An old address kept working, with where it sends visitors: a page, or a collection entry the site has a page for. */
export type LiveRedirect = { from: string; to: string; title: string } & ({ page: PageDoc; entry?: undefined } | { entry: SiteEntry; page?: undefined });

/**
 * Old addresses kept working, each with the page or entry it sends visitors to, in the order they were kept. One
 * that a page or an entry uses now, that is not a valid route, or whose page or entry is gone (or has no page on the
 * site) is left out: a page or entry always wins its route.
 */
export function liveRedirects(state: ProjectState): LiveRedirect[] {
  const list: unknown[] = Array.isArray(state.site.redirects) ? state.site.redirects : [];
  if (!list.length) return [];
  const entries = siteEntries(state);
  const byId = new Map(entries.map((e) => [e.entry.id, e]));
  const used = new Set([...Object.values(state.pages).map((p) => p.route.toLowerCase()), ...entries.map((e) => e.route.toLowerCase())]);
  const out: LiveRedirect[] = [];
  for (const item of list) {
    const r = (item && typeof item === 'object' ? item : {}) as { from?: unknown; pageId?: unknown; entryId?: unknown };
    if (typeof r.from !== 'string' || r.from === '/' || validateRoute(r.from) || used.has(r.from.toLowerCase())) continue;
    const page = typeof r.pageId === 'string' && Object.hasOwn(state.pages, r.pageId) ? state.pages[r.pageId] : undefined;
    const entry = !page && typeof r.entryId === 'string' ? byId.get(r.entryId) : undefined;
    if (page) out.push({ from: r.from, to: page.route, title: page.title, page });
    else if (entry) out.push({ from: r.from, to: entry.route, title: entry.entry.title, entry });
    else continue;
    used.add(r.from.toLowerCase());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collection entries
// ---------------------------------------------------------------------------

export { isDraftEntry, siteEntries, type SiteEntry } from '@shared/collections';

/** The route file of an entry's page. */
export function entryFile(route: string): string {
  return `src/routes/${routeDir(route)}/+page.svelte`;
}

/**
 * An entry's page: its collection's layout template read for the entry (see ./entry-template), inside the site's
 * own header and footer. Its head carries what a page's does, and says it is a dated article. Only what the entry,
 * its collection (with its template), the entries listed beside it and the site settings say is read, so a change to
 * one post makes its page again, and a change to the template makes every entry's.
 */
export function generateEntry(state: ProjectState, collectionId: string, entryId: string, opts: GenerateOptions = {}): string {
  const collection = state.collections[collectionId];
  const entry = collection.entries[entryId];
  const route = entryRoute(collection, entry);
  const file = entryFile(route);
  const tree = materializeTemplate(state, collection, entry, entryNeighbours(state, collectionId, entryId));
  const ctx: EmitCtx = {
    state,
    file,
    imports: new Map(),
    instrument: !!opts.instrument,
    def: null,
    tree,
    ctxExpr: `template:${collectionId}`,
    items: [],
    rctx: { state, entry: { collectionId, entryId } },
    indent: 0,
    locals: new Map()
  };
  // The first section is usually what fills the first screen; its images load eagerly.
  const markup = tree.rootIds
    .map((id, i) => {
      ctx.firstSection = i === 0;
      return emitNode(ctx, id);
    })
    .filter(Boolean)
    .join('\n');
  ctx.firstSection = false;
  // What the entry says about itself to search engines and link previews: its own search settings, else its title,
  // excerpt and featured image, as the SEO audit reads them.
  const head = seoHead(state, entryMetadata(state, collectionId, entryId, route)!, { article: true, alternates: [] });
  // The same connected graph as a page's: who publishes the site, the website, this entry and its trail from Home.
  const graph = graphScript(state, { kind: 'entry', collectionId, entryId });
  if (graph) head.push(`\t{@html ${js(graph)}}`);
  if (hasMarkdownMirror(state, { kind: 'entry', collectionId, entryId })) head.push(MARKDOWN_ALTERNATE);
  const imports = renderImports(ctx.imports);
  const script = [imports, editingState(ctx).trimEnd()].filter(Boolean).join('\n\n');
  // Section headings and pictures in the entry's text get the article's rules.
  const article = toRichText(entry.body).some((b) => b.type === 'h2' || isImageBlock(b));
  return (
    HEADER_NOTE(`siteorigin/collections/${collection.settings.id}/entries/${entry.id}.json`) +
    (script ? `<script>\n${script}\n</script>\n\n` : '') +
    `<svelte:head>\n${head.join('\n')}\n</svelte:head>\n\n${opts.instrument ? hotBoundary(markup, tree.rootIds.length) : markup}\n` +
    (article ? `\n${ARTICLE_STYLE}` : '')
  );
}

/**
 * How an entry's section headings and pictures with a caption look: only an entry's text can hold them, so the rules
 * reach every rich text without touching any other page's.
 */
const ARTICLE_STYLE = `<style>
	:global(.so-rich h2) {
		margin-top: 1.5em;
		font-family: var(--so-text-h2-family, inherit);
		font-size: var(--so-text-h2-size, 2rem);
		line-height: var(--so-text-h2-line-height, 1.2);
		font-weight: var(--so-text-h2-weight, 600);
		letter-spacing: var(--so-text-h2-tracking, normal);
	}
	:global(.so-rich__figure) {
		margin-block: 1.5em;
	}
	:global(.so-rich__figure img) {
		display: block;
		width: 100%;
		height: auto;
		border-radius: var(--so-radius-md, 0);
	}
	:global(.so-rich__figure figcaption) {
		margin-top: 0.5em;
		font-size: 0.9em;
		color: var(--so-color-muted, inherit);
	}
</style>
`;

/** Is the page a draft, left out of the website? The Home page never is, whatever its document says. */
export function isDraftPage(state: ProjectState, page: PageDoc): boolean {
  return page.draft === true && page.id !== state.site.homePageId;
}

/**
 * The site as visitors get it: every draft page and draft entry left out, with the old addresses that lead to one.
 * The old addresses are chosen on the whole site first, so a draft's route never frees an address another redirect
 * could then take. Links to a draft resolve as links to a missing page. A site without drafts is returned as it is.
 */
export function publishedState(state: ProjectState): ProjectState {
  const drafts = new Set(Object.values(state.pages).filter((p) => isDraftPage(state, p)).map((p) => p.id));
  // A damaged entry is never published either.
  const unpublished = (e: EntryDoc | undefined) => !e || typeof e !== 'object' || isDraftEntry(e);
  const entriesOf = (c: Collection | undefined) => (c?.entries && typeof c.entries === 'object' ? c.entries : {});
  const draftEntries = Object.values(state.collections ?? {}).some((c) => Object.values(entriesOf(c)).some(unpublished));
  if (!drafts.size && !draftEntries) return state;
  const redirects = liveRedirects(state).flatMap((r): SiteRedirect[] =>
    r.page ? (drafts.has(r.page.id) ? [] : [{ from: r.from, pageId: r.page.id }]) : unpublished(r.entry.entry) ? [] : [{ from: r.from, entryId: r.entry.entry.id }]
  );
  const site = { ...state.site, pageOrder: state.site.pageOrder.filter((id) => !drafts.has(id)) };
  if (redirects.length) site.redirects = redirects;
  else delete site.redirects;
  const collections = !draftEntries
    ? state.collections
    : Object.fromEntries(
        Object.entries(state.collections).map(([id, c]) => {
          const entries = Object.fromEntries(Object.entries(entriesOf(c)).filter(([, e]) => !unpublished(e)));
          const order = c?.settings?.entryOrder;
          const settings = Array.isArray(order) ? { ...c.settings, entryOrder: order.filter((e) => Object.hasOwn(entries, e)) } : c?.settings;
          return [id, { ...c, settings, entries }];
        })
      );
  return { ...state, site, collections, pages: Object.fromEntries(Object.entries(state.pages).filter(([id]) => !drafts.has(id))) };
}

/**
 * Managed components that only drafts place, directly or inside another component. The published site never imports
 * them, so what their files name (a default image, say) is nothing visitors are shown. A site without drafts has none.
 */
export function draftOnlyComponents(state: ProjectState): ComponentDefinition[] {
  const live = publishedState(state);
  if (live === state) return [];
  const placed = (s: ProjectState) => {
    const seen = new Set<string>();
    const walk = (tree: NodeTree) => {
      for (const n of Object.values(tree.nodes)) {
        if (n.kind !== 'instance' || seen.has(n.definitionId)) continue;
        seen.add(n.definitionId);
        const def = s.components[n.definitionId];
        if (def?.kind === 'managed' && def.tree) walk(def.tree);
      }
    };
    for (const id of s.site.pageOrder) if (s.pages[id]) walk(s.pages[id]);
    walk(s.site.shell.header);
    walk(s.site.shell.footer);
    // A collection's layout is part of the site while it has an entry the site shows.
    for (const c of Object.values(s.collections ?? {})) if (c?.settings?.template?.nodes && Object.keys(c.entries ?? {}).length) walk(c.settings.template);
    return seen;
  };
  const published = placed(live);
  return [...placed(state)].filter((id) => !published.has(id)).map((id) => state.components[id]).filter((d) => d?.kind === 'managed');
}

export function redirectFile(from: string): string {
  return `src/routes/${routeDir(from)}/+page.svelte`;
}

/**
 * The page at an old address: it sends visitors on to the page's current address. It is written where a page
 * at that address would be, so a page given the address back simply replaces it. Read with scripts on, it goes
 * at once and keeps the query and the section the old link asked for; without them, a meta refresh goes to the
 * page. Either way it works from the prerendered HTML alone, on any static host.
 */
export function generateRedirect(state: ProjectState, from: string, page: Pick<PageDoc, 'route'>): string {
  const base = publicUrl(state.site);
  const canonical = base ? `\n\t<link rel="canonical" href={${js(base + routeUrl(page.route))}} />` : '';
  return (
    HEADER_NOTE('siteorigin/site.json') +
    `<script>
	// ${from} is an old address of a page, kept working for old links and bookmarks.
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';

	const to = resolve(${js(page.route)});
	// Runs while the HTML is read, before anything renders.
	const go = '<' + 'script>location.replace(' + JSON.stringify(to).replace(/</g, '\\\\u003c') + ' + location.search + location.hash);</' + 'script>';
	// Reached by a link inside the running site instead, the script above never runs: go from here.
	onMount(() => location.replace(to + location.search + location.hash));
</script>

<svelte:head>
	{@html go}
	<meta http-equiv="refresh" content={'0; url=' + to} />
	<meta name="robots" content="noindex" />${canonical}
</svelte:head>

<p><a href={to}>{${js(siteVisitorText(state.site).redirect)}}</a></p>
`
  );
}

/** SvelteKit route ID for a page route: "/about/" -> "/about". */
export function routeId(route: string): string {
  return '/' + routeDir(route);
}

/**
 * The site's robots.txt, from its crawler policy (shared/crawler-policy.ts): the crawlers it keeps out and the paths
 * the author closed. Hidden pages are never disallowed here: they carry a noindex meta tag and are left out of the
 * sitemap, and disallowing them would stop crawlers from ever reading that tag. Drafts are not pages of the website at all.
 */
export function generateRobots(state: ProjectState): string {
  return siteRobotsTxt(state.site);
}

export function generateSitemap(state: ProjectState): string | null {
  const base = publicUrl(state.site);
  if (!base) return null;
  // The pages and entries the sitemap lists by the shared visibility rule: published, not hidden from search engines,
  // and their own canonical address. Pages come first in site order, then entries. Each says the day it last changed when that is known: its
  // revision date, or else the day it was published (an entry's, or a dated article's).
  const listed = createSeoResolver(state)
    .published()
    .filter((meta): meta is EffectiveSeo & { url: string } => meta.visibility.sitemap && !!meta.url);
  const alternates = sitemapAlternates(state, listed);
  const urls: string[] = [];
  for (const meta of listed) {
    const changed = meta.modified ?? meta.published;
    const links = (meta.subject.kind === 'page' && alternates.get(meta.subject.pageId)) || [];
    const inner = [`<loc>${escapeHtmlAttr(meta.url)}</loc>`, changed ? `<lastmod>${changed}</lastmod>` : '', ...links.map((l) => `\n\t\t<xhtml:link rel="alternate" hreflang="${escapeHtmlAttr(l.language)}" href="${escapeHtmlAttr(l.url)}"/>`)];
    urls.push(`\t<url>${inner.join('')}${links.length ? '\n\t' : ''}</url>`);
  }
  // Then each collection's index and category archives, every page of each.
  for (const { route } of siteArchives(state)) urls.push(`\t<url><loc>${escapeHtmlAttr(base + routeUrl(route))}</loc></url>`);
  const xhtml = alternates.size ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xhtml}>\n${urls.join('\n')}\n</urlset>\n`;
}

/**
 * The alternate-language links each listed page carries in the sitemap, by page ID: every version of a translation
 * set that the sitemap lists itself, each naming the same set (its own address among them, as search engines ask),
 * then `x-default` naming the version in the site's language when that one is listed. A version the sitemap leaves out
 * (a draft, one hidden from search engines, a copy of another address) is named by none, so a set left with one
 * version has no links, and a set whose listed versions clash on language has none either.
 */
function sitemapAlternates(state: ProjectState, listed: Array<EffectiveSeo & { url: string }>): Map<string, Array<{ language: string; url: string }>> {
  const groups = new Map<string, Array<{ pageId: string; language: string; url: string }>>();
  for (const meta of listed) {
    if (meta.subject.kind !== 'page') continue;
    const group = translationGroup(state.pages[meta.subject.pageId]);
    if (!group) continue;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ pageId: meta.subject.pageId, language: meta.language, url: meta.url });
  }
  const out = new Map<string, Array<{ language: string; url: string }>>();
  for (const members of groups.values()) {
    const languages = new Set(members.map((m) => m.language.toLowerCase()));
    if (members.length < 2 || languages.size < members.length) continue;
    const fallback = members.find((m) => sameLanguage(m.language, siteLanguage(state.site)));
    const links = [...members.map(({ language, url }) => ({ language, url })), ...(fallback ? [{ language: 'x-default', url: fallback.url }] : [])];
    for (const m of members) out.set(m.pageId, links);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Not-found page
// ---------------------------------------------------------------------------

/** Where the not-found page sends section links, worked out once per state in a cached run (see notFoundSectionRoutes). */
const notFoundSections = (state: ProjectState) => derived(state, 'notFoundSections', notFoundSectionRoutes);

/** The route folder of the not-found page. */
export const NOT_FOUND_DIR = `src/routes/${routeDir(NOT_FOUND_ROUTE)}`;

/**
 * The page visitors see at an address the site does not have: the author's heading and message inside the site's
 * own header and footer, then a link to the Home page that is always there, whatever the wording. It is built to
 * 404.html at the root of the website, the file static hosts serve for a missing address. Search engines are asked
 * not to list it.
 */
export function generateNotFound(state: ProjectState): string {
  const { heading, message, linkLabel } = notFoundCopy(state.site);
  const title = `${heading} · ${state.site.name}`;
  // The sections the header and footer link to "on this page": the build sends those links to the page that has
  // each (see generateServerHook), and these targets keep the page buildable for a project with a hook of its own.
  const targets = Object.keys(notFoundSections(state))
    .map((id) => `\n\t\t<span id=${attrJs(id)}></span>`)
    .join('');
  return (
    HEADER_NOTE('siteorigin/site.json') +
    `<script>
	import { resolve } from '$app/paths';
</script>

<svelte:head>
	<title>{${js(title)}}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<section class="so-not-found">
	<div class="so-container so-not-found__inner">${targets}
		<h1 class="so-not-found__heading">{${js(heading)}}</h1>
		<p class="so-not-found__message">{${js(message)}}</p>
		<a class="so-btn so-btn--primary" href={resolve('/')}>{${js(linkLabel)}}</a>
	</div>
</section>

<style>
	.so-not-found {
		padding-block: var(--so-space-section, 5rem);
	}
	.so-not-found__inner {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--so-space-md, 1rem);
		max-width: calc(var(--so-container-reading, 42rem) + 2 * var(--so-container-gutter, 1.5rem));
	}
	.so-not-found__heading {
		font-family: var(--so-text-h1-family, inherit);
		font-size: var(--so-text-h1-size, 2.5rem);
		line-height: var(--so-text-h1-line-height, 1.1);
		font-weight: var(--so-text-h1-weight, 600);
		letter-spacing: var(--so-text-h1-tracking, normal);
		text-transform: var(--so-text-h1-transform, none);
	}
	.so-not-found__message {
		margin-block-end: var(--so-space-sm, 0.5rem);
		font-family: var(--so-text-lead-family, inherit);
		font-size: var(--so-text-lead-size, 1.25rem);
		line-height: var(--so-text-lead-line-height, 1.5);
		font-weight: var(--so-text-lead-weight, 400);
		letter-spacing: var(--so-text-lead-tracking, normal);
		text-transform: var(--so-text-lead-transform, none);
	}
</style>
`
  );
}

/** Builds the not-found page as 404.html rather than 404.html/index.html. */
export const NOT_FOUND_PAGE_JS = `// Generated by SiteOrigin Builder. The page static hosts show at an address the site does not have,
// built as 404.html at the root of the website.
export const trailingSlash = 'never';
`;

/** The project file of the generated server hook. SvelteKit runs one: a project's own takes its place. */
export const SERVER_HOOK_FILE = 'src/hooks.server.js';

/**
 * The site's server hook. Hosts serve 404.html at whatever address was missing, however deep, where addresses
 * relative to the page lead nowhere. While the site is built, this makes every address in the not-found page start
 * from the site's root, under the sub-path SvelteKit builds it for: the page is built at that sub-path's /404.html.
 * The shared header and footer's links to sections the page does not have go to a page that has them. That part
 * only runs during a build: the dev server serves the page where it was built.
 *
 * On a site in more than one language it also gives each page, prerendered or previewed, the language it is written
 * in: app.html names the site's, and the opening <html> tag of a page in another language gets that page's lang
 * instead, and its dir when that language runs the other way from the site's. The hook carries its own list of languages, so it never depends on another generated file for them. A
 * site in one language has the not-found part alone.
 */
export function generateServerHook(state: ProjectState): string {
  const sections = `/** Sections the shared header and footer link to "on this page", with the page that has each. */
const SECTIONS = ${js(notFoundSections(state))};
`;
  const imports = `import { building } from '$app/env';
import { publishNotFound } from './lib/siteorigin/runtime/not-found.js';
`;
  if (!languagesByRoute(state).length)
    return `// Generated by SiteOrigin Builder. Makes 404.html, the not-found page, work at any missing address.
${imports}
${sections}
export function handle({ event, resolve }) {
	if (!building || event.route.id !== ${js(NOT_FOUND_ROUTE)}) return resolve(event);
	const path = event.url.pathname;
	const base = path.endsWith(${js(NOT_FOUND_ROUTE)}) ? path.slice(0, -${NOT_FOUND_ROUTE.length}) : '';
	return resolve(event, { transformPageChunk: ({ html }) => publishNotFound(html, base, SECTIONS) });
}
`;
  return `// Generated by SiteOrigin Builder from siteorigin/site.json and siteorigin/pages/*.json. Makes 404.html, the
// not-found page, work at any missing address, and gives each page's <html lang> the language the page is written
// in, and its dir the way that language runs: pages not listed in LANGUAGES are in the site's language, and pages not
// listed in DIRECTIONS run the site's way, both of which src/app.html names.
${imports}
${sections}
/** Pages written in another language than the site's, by route, with that language. */
const LANGUAGES = ${routeLanguagesJs(state)};

/** Pages whose text runs the other way from the site's (each also in LANGUAGES), by route, with their direction. */
const DIRECTIONS = ${routeDirectionsJs(state)};

// The document's opening <html> tag, after any doctype and comments, and each of its attributes.
const START = new RegExp(${js(HTML_START.source)}, 'i');
const ATTR = new RegExp(${js(HTML_ATTR.source)}, 'g');

/** The start of a page with these attributes of its opening <html> tag replaced, or added where it has none. */
function withLanguage(html, values) {
	// Only the start of the document is read, however long the page.
	const start = html.slice(0, 65536).replace(START, (_, before, tag, attrs, end) => {
		const found = new Set();
		const own = attrs.replace(ATTR, (attr, space, name) => {
			const key = name.toLowerCase();
			if (!Object.hasOwn(values, key)) return attr;
			found.add(key);
			return \`\${space}\${key}="\${values[key]}"\`;
		});
		const added = Object.keys(values)
			.filter((key) => !found.has(key))
			.map((key) => \` \${key}="\${values[key]}"\`)
			.join('');
		return \`\${before}<\${tag}\${own}\${added}\${end}\`;
	});
	return start + html.slice(65536);
}

export function handle({ event, resolve }) {
	const id = event.route.id;
	const notFound = building && id === ${js(NOT_FOUND_ROUTE)};
	const lang = id && Object.hasOwn(LANGUAGES, id) ? LANGUAGES[id] : null;
	if (!notFound && !lang) return resolve(event);
	const root = lang ? (Object.hasOwn(DIRECTIONS, id) ? { lang, dir: DIRECTIONS[id] } : { lang }) : null;
	const path = notFound ? event.url.pathname : '';
	const base = path.endsWith(${js(NOT_FOUND_ROUTE)}) ? path.slice(0, -${NOT_FOUND_ROUTE.length}) : '';
	let first = true;
	return resolve(event, {
		transformPageChunk: ({ html }) => {
			// The opening <html> tag comes first: only the first chunk can hold it.
			const page = root && first ? withLanguage(html, root) : html;
			first = false;
			return notFound ? publishNotFound(page, base, SECTIONS) : page;
		}
	});
}
`;
}

/** Served path of the generated favicon used until a favicon image is chosen. */
export const DEFAULT_FAVICON = 'favicon.svg';

/**
 * A simple monogram favicon in the site's brand colours, so browsers never request a missing /favicon.ico. `square`
 * leaves its corners square, for the home-screen icons made from it (see site-icons.ts), which home screens round.
 */
export function generateFaviconSvg(state: ProjectState, opts: { square?: boolean } = {}): string {
  const { brand, onBrand } = siteColors(effectiveTokens(state));
  // The documents can be edited by hand: a name that is not text gives the default letter.
  const letter = ([...(typeof state.site.name === 'string' ? state.site.name.trim() : '')][0] ?? 'S').toUpperCase();
  const esc = letter.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64"${opts.square ? '' : ' rx="14"'} fill="${brand}"/><text x="32" y="43" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="34" font-weight="600" fill="${onBrand}">${esc}</text></svg>\n`;
}

/** Sub-path the site is published under, from the public URL ("https://example.com/my-site" -> "/my-site"). */
export function basePath(state: ProjectState): string {
  // A public URL is only used once checked, and its path then has segments SvelteKit takes as they are.
  return siteMount(state.site);
}

/** Read by vite.config.js: SvelteKit's paths.base for production builds. */
export function generatePathsJson(state: ProjectState): string {
  return JSON.stringify({ base: basePath(state) }, null, '\t') + '\n';
}

// ---------------------------------------------------------------------------
// Whole project
// ---------------------------------------------------------------------------

/** Makes a state-dependent file under a cache key, or gives back the copy an earlier run made from the same inputs. */
type FileMaker = (key: string, make: (state: ProjectState) => string) => string;

/**
 * The library every page reads, under src/lib/siteorigin: the runtime helpers, the styles and a file for every
 * component definition, whether a page places it or not.
 */
function addLibrary(state: ProjectState, opts: GenerateOptions, files: FileMap, file: FileMaker): void {
  const theme = getTheme(state.site.themeId);
  const mode = opts.instrument ? '#dev' : '#clean';
  // What the site says on its own, ahead of every helper and component that imports it.
  files.set(`${RUNTIME_DIR}/${VISITOR_TEXT_FILE}`, file('visitor-text.js', generateVisitorTextJs));
  files.set(`${RUNTIME_DIR}/Link.svelte`, linkSvelte(!!opts.instrument));
  files.set(`${RUNTIME_DIR}/Image.svelte`, IMAGE_SVELTE);
  files.set(`${RUNTIME_DIR}/Action.svelte`, ACTION_SVELTE);
  files.set(`${RUNTIME_DIR}/Carousel.svelte`, CAROUSEL_SVELTE);
  files.set(`${RUNTIME_DIR}/carousel.js`, CAROUSEL_JS);
  files.set(`${RUNTIME_DIR}/RichText.svelte`, RICHTEXT_SVELTE);
  files.set(`${RUNTIME_DIR}/Icon.svelte`, iconSvelte());
  files.set(`${RUNTIME_DIR}/icons.js`, file('icons.js', iconsJs));
  files.set(`${RUNTIME_DIR}/util.js`, UTIL_JS);
  files.set(`${RUNTIME_DIR}/drafts.js`, DRAFTS_JS);
  // Site search and the pages it finds, while a component of the site searches. Written before the components and
  // pages that import them, so a preview never loads a component whose search code is not there yet. Whether the
  // site searches decides only which files exist, so it is asked of the plain state, as for redirects and the favicon.
  if (usesSiteSearch(state)) {
    files.set(`${RUNTIME_DIR}/${SEARCH_HELPER_FILE}`, SEARCH_JS);
    files.set(`${RUNTIME_DIR}/${SEARCH_INDEX_FILE}`, file('search-index.js', generateSearchIndex));
  }
  // The video player, while a component of the site shows a video; also written ahead of what imports it. Like
  // search, whether the site shows one decides only which files exist, and the files themselves read nothing else.
  if (usesVideo(state)) {
    files.set(`${RUNTIME_DIR}/${VIDEO_HELPER_FILE}`, VIDEO_JS);
    files.set(`${RUNTIME_DIR}/${VIDEO_PLAYER_FILE}`, videoPlayerSvelte(!!opts.instrument));
  }
  // The entrance observer, while a page of the site can show an entrance (see generator/appear.ts); the layout that
  // starts it is written after it. Like search, asked of the plain state: it decides only whether the file exists.
  if (usesAppear(state)) files.set(`${RUNTIME_DIR}/${APPEAR_FILE}`, appearJs(!!opts.instrument));
  // The visitor's Light/Dark switch, while the site's palettes have one; the layout that starts it is written after it.
  if (usesThemeToggle(state)) files.set(`${RUNTIME_DIR}/${THEME_TOGGLE_FILE}`, themeToggleJs(themeStorageKey(state), !!opts.instrument));
  files.set(`${RUNTIME_DIR}/not-found.js`, NOT_FOUND_JS);
  files.set(`${STYLES_DIR}/tokens.css`, file('tokens.css', generateTokensCss));
  const fontNotice = file('fonts/NOTICE.txt', (s) => generateFontNotice(s) ?? '');
  if (fontNotice) files.set(`${FONTS_DIR}/NOTICE.txt`, fontNotice);
  files.set(`${STYLES_DIR}/theme.css`, theme.baseCss);
  files.set(`${STYLES_DIR}/components.css`, file('components.css', generateComponentsCss));
  files.set(`${STYLES_DIR}/site.css`, file('site.css', generateSiteCss));
  for (const def of sortedDefs(state)) {
    if (def.kind === 'managed' && def.tree) files.set(defFile(def), file(`component:${def.id}${mode}`, (s) => generateManagedComponent(s, s.components[def.id], opts)));
    else if (def.kind === 'code' && def.source) files.set(defFile(def), def.source);
  }
}

/** The library alone (see addLibrary), as generateProject makes it, without the routes that use it. */
export function generateLibrary(state: ProjectState, opts: GenerateOptions = {}): FileMap {
  const files: FileMap = new Map();
  addLibrary(state, opts, files, (_key, make) => make(state));
  return files;
}

/**
 * Generate every derived file. Paths are project-relative with forward slashes. With a `cache` from earlier runs on
 * this project, a file whose inputs are unchanged since then is given back instead of being made again; the result
 * is the same bytes either way.
 */
export function generateProject(state: ProjectState, opts: GenerateOptions = {}, cache?: GenerationCache): FileMap {
  // The project brief (#518) is the author's own: nothing that makes the website is ever handed it.
  const site = state.brief ? withoutBrief(state) : state;
  // Every page's and entry's structured data reads the same documents: the run works them out once (structured-data.ts).
  return inGenerationRun(() => generateFiles(site, opts, cache));
}

function withoutBrief(state: ProjectState): ProjectState {
  const { brief: _brief, ...rest } = state;
  return rest;
}

function generateFiles(state: ProjectState, opts: GenerateOptions, cache?: GenerationCache): FileMap {
  const files: FileMap = new Map();
  const run = cache?.run(state, !!opts.instrument);
  // Content that differs between the clean and instrumented output is kept apart by its key; the rest is shared.
  const mode = opts.instrument ? '#dev' : '#clean';
  const file = (key: string, make: (state: ProjectState) => string): string => (run ? run.file(key, make) : make(state));
  addLibrary(state, opts, files, file);
  files.set('src/routes/+layout.svelte', file(`layout${mode}`, (s) => generateLayout(s, opts)));
  files.set('src/routes/+layout.js', LAYOUT_TS);
  files.set('src/app.html', file('app.html', generateAppHtml));
  for (const id of state.site.pageOrder) {
    const page = state.pages[id];
    if (page) files.set(pageFile(page), file(`page:${id}${mode}`, (s) => generatePage(s, s.pages[id], opts)));
  }
  // Each entry's page reads that entry, its collection's settings (its layout among them), the entries listed beside
  // it and the site's, so one post's change makes its own file and its neighbours' again, and no other.
  for (const { collection, entry, route } of siteEntries(state)) {
    const cid = collection.settings.id;
    files.set(entryFile(route), file(`entry:${cid}:${entry.id}${mode}`, (s) => generateEntry(s, cid, entry.id, opts)));
  }
  for (const { from, page, entry } of liveRedirects(state)) {
    if (page) files.set(redirectFile(from), file(`redirect:${page.id}:${from}`, (s) => generateRedirect(s, from, s.pages[page.id])));
    else {
      const cid = entry.collection.settings.id;
      const eid = entry.entry.id;
      // The entry's address is read from the tracked state, so a later rename of the entry makes this file again.
      files.set(redirectFile(from), file(`redirect:${cid}:${eid}:${from}`, (s) => generateRedirect(s, from, { route: entryRoute(s.collections[cid], s.collections[cid].entries[eid]) })));
    }
  }
  // Each collection's index and category archives. A page of one reads its series (which entries it lists, and the
  // pages before and after it) and those entries, so a post published, backdated or turned back into a draft makes
  // again only the pages it moves across. Written after everything else: where a draft made before archive pages sits
  // at one's address, the archive page is what the website has there, in the preview too.
  for (const { collectionId, route } of archivePages(state)) files.set(archiveFile(route), file(`archive:${collectionId}:${route}`, (s) => generateArchive(s, collectionId, route)));
  // The not-found page and the hook that makes it work at any address both read the whole site's sections; the hook
  // also gives each page in another language than the site's its own <html lang>.
  files.set(`${NOT_FOUND_DIR}/+page.svelte`, file('not-found', generateNotFound));
  files.set(`${NOT_FOUND_DIR}/+page.js`, NOT_FOUND_PAGE_JS);
  files.set(SERVER_HOOK_FILE, file('hooks.server.js', generateServerHook));
  files.set(`${GEN_ROOT}/paths.json`, file('paths.json', generatePathsJson));
  if (!state.site.favicon || !state.assets.assets[state.site.favicon]) files.set(`static/${DEFAULT_FAVICON}`, file('favicon', (s) => generateFaviconSvg(s)));
  // The web app manifest; the PNG icons it names are pictures the editor renders (siteIconSet).
  files.set(`static/${WEB_MANIFEST}`, file('manifest.webmanifest', generateWebManifest));
  files.set('static/robots.txt', file('robots.txt', generateRobots));
  const sitemap = file('sitemap.xml', (s) => generateSitemap(s) ?? '');
  if (sitemap) files.set('static/sitemap.xml', sitemap);
  // The RSS feed of the published posts, once the site has a public URL to give their full addresses (see ./rss).
  const rss = file('rss.xml', (s) => generateRssFeed(s) ?? '');
  if (rss) files.set(RSS_PATH, rss);
  // What the site tells AI agents: llms.txt, and the Markdown of its pages and entries when the author asks for it.
  addDiscoveryFiles(state, files, file);
  run?.finish();
  return files;
}

export { GENERATOR_VERSION };
