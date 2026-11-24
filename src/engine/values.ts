import type { ChoiceOption, ImageValue, LinkValue, ListItem, ProjectState, PropSchema, RichBlock, RichListType, RichSpan, RichText, ScalarPropSchema } from '@shared/types';
import { cleanBlocks, isListBlock, isRichBlock, linkFromTarget, mergeLists, parseRichText, richTextToPlain } from '@shared/richtext';
import { newId } from '@shared/ids';
import { fail } from './tree';
import { ICONS } from '@catalogue/foundation/icons';
import { normalizeTable } from './table';

const own = <T>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

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
    case 'document':
      if (own(state.assets.assets, target)?.kind !== 'document') fail(`${label}: document "${target.slice(0, 60)}" is not in the library.`);
      // A download goes nowhere else: it has no section and opens no tab of its own.
      return { type, target };
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
  // A document or a font in the library is no picture to show.
  const notImage = (id: string) => {
    const a = own(state.assets.assets, id);
    if (!a) fail(`${label}: asset "${id}" does not exist.`);
    if (a!.kind !== 'image') fail(`${label}: "${a!.name}" is not an image.`);
  };
  if (typeof v === 'string') {
    notImage(v);
    return { assetId: v, alt: state.assets.assets[v].altSuggestion ?? '' };
  }
  const i = v as Partial<ImageValue>;
  if (i.assetId) notImage(i.assetId);
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
      // Text is edited on the page, where a link is only its address: a download could not survive that edit.
      if (l.type === 'document') fail(`${label}: a link in text cannot go to a document yet. Use a button for the download.`);
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

/** The most answers one set of choices offers, and the longest label one of them has. */
export const MAX_CHOICES = 24;
const MAX_CHOICE_TEXT = 200;

function isChoice(o: unknown): o is ChoiceOption {
  const c = o as ChoiceOption;
  return !!c && typeof c === 'object' && typeof c.id === 'string' && typeof c.label === 'string' && typeof c.value === 'string';
}

/** The first `length` UTF-16 units of `text`, never half of a character that takes two. */
const cut = (text: string, length: number) => (/[\uD800-\uDBFF]/.test(text.charAt(length - 1)) ? text.slice(0, length - 1) : text.slice(0, length));

/** Two labels or values a visitor (or whoever reads the answers) would take for the same one. */
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A set of choices as stored: `{ id, label, value }` in the order shown. `stored` is the set saved before this edit.
 * A choice keeps the value it is sent as for as long as it keeps its id, whatever its label becomes. A choice sent
 * without a saved id is the saved one with that label, if there is one; otherwise it is new and is sent as its label,
 * numbered past the values the set already sends. A plain string is a choice's label.
 */
export function normalizeChoices(v: unknown, label: string, stored?: unknown): ChoiceOption[] {
  // A set saved under older rules stays while it is not being changed.
  if (Array.isArray(v) && Array.isArray(stored) && JSON.stringify(v) === JSON.stringify(stored)) return v as ChoiceOption[];
  if (!Array.isArray(v)) fail(`${label}: expected a list of choices, such as ["Kitchen", "Lighting"].`);
  if (v.length > MAX_CHOICES) fail(`${label}: at most ${MAX_CHOICES} choices.`);
  const saved = (Array.isArray(stored) ? stored : []).filter(isChoice);
  const byId = new Map(saved.map((o) => [o.id, o]));
  const rows = v.map((raw, i) => {
    const o = (typeof raw === 'string' || typeof raw === 'number' ? { label: raw } : raw) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || Array.isArray(o)) fail(`${label}: choice ${i + 1} should be its label, or { id, label }.`);
    const text = typeof o.label === 'string' || typeof o.label === 'number' ? String(o.label).replace(/\s+/g, ' ').trim() : '';
    if (!text) fail(`${label}: choice ${i + 1} needs a label.`);
    if (text.length > MAX_CHOICE_TEXT) fail(`${label}: “${text.slice(0, 40)}…” is longer than ${MAX_CHOICE_TEXT} characters.`);
    const value = o.value === undefined || o.value === null ? undefined : typeof o.value === 'string' || typeof o.value === 'number' ? String(o.value).replace(/\s+/g, ' ').trim() : fail(`${label}: “${text}” has a value that is not text.`);
    return { id: typeof o.id === 'string' && o.id ? o.id : undefined, label: text, value: value || undefined, was: undefined as ChoiceOption | undefined };
  });
  rows.forEach((r, i) => {
    const twin = rows.findIndex((x, j) => j < i && same(x.label, r.label));
    if (twin >= 0) fail(`${label}: “${r.label}” is offered twice. Give each choice its own label.`);
    if (r.id && rows.some((x, j) => j < i && x.id === r.id)) fail(`${label}: two choices share the id "${r.id}".`);
  });
  // A saved id is that choice. Its value is what earlier answers to it were sent as, so it never changes.
  for (const r of rows) {
    const was = r.id ? byId.get(r.id) : undefined;
    if (!was) continue;
    if (r.value !== undefined && r.value !== was.value) fail(`${label}: “${was.label}” is sent as “${was.value}”, which cannot change. Add a new choice to send something else.`);
    r.was = was;
  }
  const claimed = () => new Set(rows.flatMap((r) => (r.was ? [r.was.id] : [])));
  // Otherwise a choice still offered under its label is that choice: rewriting a set as labels keeps every value.
  for (const r of rows) {
    if (r.was) continue;
    const taken = claimed();
    r.was = saved.find((o) => !taken.has(o.id) && same(o.label, r.label));
    if (r.was && r.value !== undefined && r.value !== r.was.value) fail(`${label}: “${r.was.label}” is sent as “${r.was.value}”, which cannot change. Add a new choice to send something else.`);
  }
  const gone = saved.filter((o) => !claimed().has(o.id));
  const added = rows.filter((r) => !r.was);
  // A new label where a saved one went missing may be a rename, which only the choice's id can say.
  if (gone.length && added.length)
    fail(`${label}: “${added[0].label}” is new and “${gone[0].label}” is no longer offered. To rename a choice, send it with its id, so it keeps the value its answers are sent as. To replace it, remove it in one edit and add the new choice in another.`);
  // So may a removal among choices known only by label: of "Starter" and "Basic", ["Basic"] may keep either one.
  const byLabel = rows.find((r) => r.was && r.id !== r.was.id);
  if (gone.length && byLabel)
    fail(`${label}: “${gone[0].label}” is no longer offered and “${byLabel.label}” was sent without its id. To remove a choice, send the ones you keep with their ids, so each keeps the value its answers are sent as.`);
  // A value given for a new choice is checked like a label; a saved one stays as it is.
  for (const r of added) if (r.value !== undefined && r.value.length > MAX_CHOICE_TEXT) fail(`${label}: “${r.label}” has a value longer than ${MAX_CHOICE_TEXT} characters.`);
  const used = rows.flatMap((r) => (r.was ? [r.was.value] : []));
  const ids = new Set([...rows.flatMap((r) => (r.was ? [r.was.id] : [])), ...saved.map((o) => o.id)]);
  return rows.map((r) => {
    if (r.was) return { id: r.was.id, label: r.label, value: r.was.value };
    const base = r.value ?? r.label;
    let value = base;
    // Numbered within the length a value may have, so the choice can always be sent back as it is.
    for (let n = 2; used.some((u) => same(u, value)); n++) value = `${cut(base, MAX_CHOICE_TEXT - ` (${n})`.length).trimEnd()} (${n})`;
    used.push(value);
    // A new choice keeps an id it brings (a copied set), unless another choice already has it.
    const id = r.id && /^[\w-]{1,64}$/.test(r.id) && !ids.has(r.id) ? r.id : newId('c');
    ids.add(id);
    return { id, label: r.label, value };
  });
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
    case 'image':
      // A link or image whose page or asset has gone missing stays while it is not being changed, so editing
      // another field of the same item never fails on it.
      if (stored !== undefined && v && typeof v === 'object' && JSON.stringify(v) === JSON.stringify(stored)) return v;
      return schema.type === 'link' ? normalizeLink(v, state, label) : normalizeImage(v, state, label);
    case 'icon':
      // An unknown name would silently render a fallback icon, so a new one is refused with the valid names.
      if (typeof v === 'string' && v === stored && /^[a-z0-9-]{1,40}$/.test(v)) return v;
      if (typeof v !== 'string' || !Object.hasOwn(ICONS, v)) fail(`${label}: ${typeof v === 'string' ? `"${v.slice(0, 40)}" is not an available icon` : 'expected an icon name'}. Use one of: ${Object.keys(ICONS).join(', ')}.`);
      return v;
    case 'choices':
      return normalizeChoices(v, label, stored);
  }
}

export function normalizeItem(schema: Extract<PropSchema, { type: 'list' }>, item: Record<string, unknown> | undefined, state: ProjectState, label: string, base?: ListItem, stored?: Record<string, unknown>): ListItem {
  const out: ListItem = { id: base?.id ?? newId('i') };
  for (const [k, f] of Object.entries(schema.fields)) {
    // Choices left out of an edited item stay as saved: their values cannot be made again from their labels.
    const raw = item && k in item ? item[k] : base && k in base ? base[k] : f.type === 'choices' && stored && Object.hasOwn(stored, k) ? stored[k] : structuredClone(f.default);
    out[k] = normalizeScalar(f, raw, state, `${label} → ${f.label}`, stored?.[k]);
  }
  return out;
}

/** `stored` is the property's current value, so unchanged legacy values inside it stay accepted. */
export function normalizeProp(schema: PropSchema, v: unknown, state: ProjectState, label: string, stored?: unknown): unknown {
  if (schema.type === 'table') return normalizeTable(v, label);
  if (schema.type === 'list') {
    if (!Array.isArray(v)) fail(`${label}: expected a list.`);
    if (schema.feed) {
      // Its items are the site's pages, worked out where it is placed; there is nothing to store.
      if (v.length) fail(`${label} fills itself from the site's ${schema.feed === 'articles' ? 'dated articles' : 'page'}; give its pages article details instead of items.`);
      return [];
    }
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
