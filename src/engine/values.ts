import type { ImageValue, LinkValue, ListItem, ProjectState, PropSchema, RichBlock, RichListType, RichSpan, RichText, ScalarPropSchema } from '@shared/types';
import { cleanBlocks, isListBlock, isRichBlock, linkFromTarget, mergeLists, parseRichText, richTextToPlain } from '@shared/richtext';
import { newId } from '@shared/ids';
import { fail } from './tree';
import { ICONS } from '@catalogue/foundation/icons';

export function normalizeLink(v: unknown, state: ProjectState, label: string): LinkValue {
  if (v === null || v === undefined || v === '') return { type: 'none', target: '' };
  if (typeof v === 'string') {
    // Accept shorthand strings from simpler callers.
    if (/^https?:\/\//i.test(v)) return normalizeLink({ type: 'url', target: v }, state, label);
    if (/^mailto:/i.test(v)) return normalizeLink({ type: 'email', target: v.slice(7) }, state, label);
    if (/^tel:/i.test(v)) return normalizeLink({ type: 'tel', target: v.slice(4) }, state, label);
    if (v.startsWith('#')) return normalizeLink({ type: 'anchor', target: v.slice(1) }, state, label);
    if (Object.hasOwn(state.pages, v)) return { type: 'page', target: v };
    const byRoute = Object.values(state.pages).find((p) => p.route === v || p.route === `/${v.replace(/^\/|\/$/g, '')}/`);
    if (byRoute) return { type: 'page', target: byRoute.id };
    fail(`${label}: "${v}" is not a page ID, route, https URL, mailto:, tel: or #anchor.`);
  }
  if (typeof v !== 'object') fail(`${label}: expected a link object.`);
  const l = v as Partial<LinkValue>;
  const type = l.type ?? 'none';
  const target = String(l.target ?? '').trim();
  switch (type) {
    case 'none':
      return { type: 'none', target: '' };
    case 'page':
      if (!Object.hasOwn(state.pages, target)) fail(`${label}: page "${target}" does not exist.`);
      break;
    case 'url':
      if (!/^https?:\/\/[^\s<>"]+$/i.test(target)) fail(`${label}: external links must be full http(s) URLs.`);
      break;
    case 'email':
      if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(target)) fail(`${label}: "${target}" is not a valid email address.`);
      break;
    case 'tel':
      if (!/^[+0-9 ().-]{3,30}$/.test(target)) fail(`${label}: "${target}" is not a valid telephone number.`);
      break;
    case 'anchor':
      if (!/^[A-Za-z][\w-]*$/.test(target.replace(/^#/, ''))) fail(`${label}: "${target}" is not a valid anchor.`);
      break;
    default:
      fail(`${label}: unknown link type "${type}".`);
  }
  const out: LinkValue = { type, target: type === 'anchor' ? target.replace(/^#/, '') : target };
  if (l.anchor) {
    out.anchor = String(l.anchor).replace(/^#/, '');
    if (!/^[A-Za-z][\w-]*$/.test(out.anchor)) fail(`${label}: "${out.anchor.slice(0, 40)}" is not a valid anchor.`);
  }
  if (l.newTab) out.newTab = true;
  return out;
}

export function normalizeImage(v: unknown, state: ProjectState, label: string): ImageValue {
  if (v === null || v === undefined) return { assetId: null, alt: '' };
  if (typeof v === 'string') {
    if (!state.assets.assets[v]) fail(`${label}: asset "${v}" does not exist.`);
    return { assetId: v, alt: state.assets.assets[v].altSuggestion ?? '' };
  }
  const i = v as Partial<ImageValue>;
  if (i.assetId && !state.assets.assets[i.assetId]) fail(`${label}: asset "${i.assetId}" does not exist.`);
  const out: ImageValue = { assetId: i.assetId ?? null, alt: String(i.alt ?? '').slice(0, 300) };
  if (i.decorative) out.decorative = true;
  return out;
}

const MAX_RICH_CHARS = 20000;
const MAX_RICH_BLOCKS = 500;

/**
 * Rich text in its stored form, from anything callers may send: a string (one block per line, with **bold**, *italic*,
 * [label](/route/), and "- ", "1. ", "- [x] ", "### ", "#### " and "> " line markers), an array of such strings, or
 * structured blocks. Every link is validated, and a link to a page stores the page's ID.
 */
export function normalizeRichText(v: unknown, state: ProjectState, label: string, plainAs?: RichListType): RichText {
  const link = (target: string, newTab: boolean) => {
    const out = linkFromTarget(target, state.pages, newTab);
    if (!out && target.startsWith('/')) fail(`${label}: no page has the route "${target.slice(0, 60)}".`);
    return out;
  };
  const fromText = (s: string) => parseRichText(s, { markdown: true, link, plainAs });
  const span = (raw: unknown): RichSpan => {
    if (typeof raw === 'string') return { text: raw };
    if (!raw || typeof raw !== 'object' || typeof (raw as RichSpan).text !== 'string') fail(`${label}: a span needs { text, strong?, em?, link? }.`);
    const s = raw as RichSpan;
    const out: RichSpan = { text: s.text };
    if (s.strong) out.strong = true;
    if (s.em) out.em = true;
    if (s.link) {
      const l = normalizeLink(s.link, state, label);
      if (l.type !== 'none') out.link = l;
    }
    return out;
  };
  const block = (raw: RichBlock): RichBlock => (isListBlock(raw) ? { type: raw.type, items: raw.items.map((it) => (Array.isArray(it) ? it : [it]).map(span)) } : { type: raw.type, spans: raw.spans.map(span) });
  let blocks: RichBlock[];
  if (typeof v === 'string') blocks = fromText(v);
  else if (Array.isArray(v))
    blocks = v.flatMap((x) => {
      if (typeof x === 'string' || typeof x === 'number') return fromText(String(x));
      if (isRichBlock(x)) return [block(x)];
      return fail(`${label}: expected text or blocks such as { type: "p", spans: [{ text }] } or { type: "ul", items: [[{ text }]] }.`);
    });
  else fail(`${label}: expected text, paragraphs or rich text blocks.`);
  const out = mergeLists(cleanBlocks(blocks!));
  if (out.length > MAX_RICH_BLOCKS || richTextToPlain(out).replace(/\n/g, '').length > MAX_RICH_CHARS) fail(`${label}: text is too long.`);
  return out;
}

/**
 * `stored` is the value already saved for this field, if any. A value that was valid under older rules is
 * kept when it is not being changed, so editing one field never fails on another.
 */
export function normalizeScalar(schema: ScalarPropSchema, v: unknown, state: ProjectState, label: string, stored?: unknown): unknown {
  switch (schema.type) {
    case 'string': {
      if (typeof v !== 'string' && typeof v !== 'number') fail(`${label}: expected text.`);
      const s = String(v);
      const max = schema.maxLength ?? 2000;
      if (s.length > max) fail(`${label}: text is longer than ${max} characters.`);
      return schema.multiline ? s : s.replace(/\s*\n\s*/g, ' ');
    }
    case 'richtext':
      // Content saved under older limits stays valid while it is not being changed.
      if (stored !== undefined && JSON.stringify(v) === JSON.stringify(stored)) return v;
      return normalizeRichText(v, state, label, schema.plainAs);
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) fail(`${label}: expected a number.`);
      if (schema.min !== undefined && n < schema.min) fail(`${label}: must be at least ${schema.min}.`);
      if (schema.max !== undefined && n > schema.max) fail(`${label}: must be at most ${schema.max}.`);
      return n;
    }
    case 'boolean':
      if (typeof v !== 'boolean') fail(`${label}: expected true or false.`);
      return v;
    case 'enum':
      if (!schema.options.some((o) => o.value === v)) fail(`${label}: must be one of ${schema.options.map((o) => o.value).join(', ')}.`);
      return v;
    case 'link':
      return normalizeLink(v, state, label);
    case 'image':
      return normalizeImage(v, state, label);
    case 'icon':
      // An unknown name would silently render a fallback icon, so a new one is refused with the valid names.
      if (typeof v === 'string' && v === stored && /^[a-z0-9-]{1,40}$/.test(v)) return v;
      if (typeof v !== 'string' || !Object.hasOwn(ICONS, v)) fail(`${label}: ${typeof v === 'string' ? `"${v.slice(0, 40)}" is not an available icon` : 'expected an icon name'}. Use one of: ${Object.keys(ICONS).join(', ')}.`);
      return v;
  }
}

export function normalizeItem(schema: Extract<PropSchema, { type: 'list' }>, item: Record<string, unknown> | undefined, state: ProjectState, label: string, base?: ListItem, stored?: Record<string, unknown>): ListItem {
  const out: ListItem = { id: base?.id ?? newId('i') };
  for (const [k, f] of Object.entries(schema.fields)) {
    const raw = item && k in item ? item[k] : base && k in base ? base[k] : structuredClone(f.default);
    out[k] = normalizeScalar(f, raw, state, `${label} → ${f.label}`, stored?.[k]);
  }
  return out;
}

/** `stored` is the property's current value, so unchanged legacy values inside it stay accepted. */
export function normalizeProp(schema: PropSchema, v: unknown, state: ProjectState, label: string, stored?: unknown): unknown {
  if (schema.type === 'list') {
    if (!Array.isArray(v)) fail(`${label}: expected a list.`);
    if (schema.max !== undefined && v.length > schema.max) fail(`${label}: at most ${schema.max} items.`);
    if (schema.min !== undefined && v.length < schema.min) fail(`${label}: at least ${schema.min} items.`);
    const seen = new Set<string>();
    const before = new Map(Array.isArray(stored) ? (stored as ListItem[]).filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]) : []);
    return v.map((it) => {
      const base = it && typeof it === 'object' && typeof (it as ListItem).id === 'string' && !seen.has((it as ListItem).id) ? (it as ListItem) : undefined;
      const n = normalizeItem(schema, it as Record<string, unknown>, state, label, base ? { id: base.id } as ListItem : undefined, base ? before.get(base.id) : undefined);
      seen.add(n.id);
      return n;
    });
  }
  return normalizeScalar(schema, v, state, label, stored);
}
