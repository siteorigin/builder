import type { ChoiceOption, ImageValue, LinkRel, LinkValue, ListItem, ProjectState, PropSchema, RichBlock, RichListType, RichSpan, RichText, ScalarPropSchema } from '@shared/types';
import { canonicalRels } from '@shared/link-rel';
import { cleanBlocks, ENTRY_LINK_PREFIX, isImageBlock, isListBlock, isRichBlock, isTelephone, linkFromTarget, mergeLists, parseRichText, spanRuns } from '@shared/richtext';
import { collectionRoutes, findEntry } from '@shared/collections';
import { readablePath } from '@shared/routes';
import { newId } from '@shared/ids';
import { fail } from './tree';
import { ICONS } from '@catalogue/foundation/icons';
import { normalizeTable } from './table';
import { declaredTokens } from './tokens';
import { TEXT_LIMITS, tooLongMessage } from '@shared/text-limits';
import { isEmptyPropValue, requiredMessage } from '@shared/required';

const own = <T>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined);

/**
 * Where a link is stored decides what it may go to. Links to collection entries are kept only in entries' own text
 * (`entries`) until entries are pages of the website: anywhere else nothing could show them yet.
 */
export interface LinkScope {
  entries?: boolean;
}

/** A page link's section, written after its route or ID: empty or not an ID, there is no section to go to. */
function anchorOf(anchor: string, label: string): string {
  if (!/^[A-Za-z][\w-]*$/.test(anchor)) fail(`${label}: "${anchor.slice(0, 40)}" is not a valid anchor.`);
  return anchor;
}

export function normalizeLink(v: unknown, state: ProjectState, label: string, scope: LinkScope = {}): LinkValue {
  if (v === null || v === undefined || v === '') return { type: 'none', target: '' };
  if (typeof v === 'string') {
    // Accept shorthand strings from simpler callers.
    if (/^https?:\/\//i.test(v)) return normalizeLink({ type: 'url', target: v }, state, label);
    if (/^mailto:/i.test(v)) return normalizeLink({ type: 'email', target: v.slice(7) }, state, label);
    if (/^tel:/i.test(v)) return normalizeLink({ type: 'tel', target: v.slice(4) }, state, label);
    if (v.startsWith('#')) return normalizeLink({ type: 'anchor', target: v.slice(1) }, state, label);
    // A page by its ID or route, with an optional #anchor for a section on it, as rich text links take one.
    const hash = v.indexOf('#');
    const path = hash < 0 ? v : v.slice(0, hash);
    const route = readablePath(path);
    const page = Object.hasOwn(state.pages, path) ? path : Object.values(state.pages).find((p) => p.route === route || p.route === `/${route.replace(/^\/|\/$/g, '')}/`)?.id;
    if (page && hash < 0) return { type: 'page', target: page };
    if (page) return normalizeLink({ type: 'page', target: page, anchor: anchorOf(v.slice(hash + 1), label) }, state, label);
    fail(`${label}: "${v}" is not a page ID, route (with an optional #anchor), https URL, mailto:, tel: or #anchor.`);
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
      if (!isTelephone(target)) fail(`${label}: "${target}" is not a valid telephone number.`);
      break;
    case 'anchor':
      if (!/^[A-Za-z][\w-]*$/.test(target.replace(/^#/, ''))) fail(`${label}: "${target}" is not a valid anchor.`);
      break;
    case 'document':
      if (own(state.assets.assets, target)?.kind !== 'document') fail(`${label}: document "${target.slice(0, 60)}" is not in the library.`);
      // A download goes nowhere else: it has no section and opens no tab of its own.
      return { type, target };
    case 'entry': {
      if (!scope.entries) fail(`${label}: links to collection entries can only be made in an entry's text for now.`);
      if (!findEntry(state, target)) fail(`${label}: entry "${target.slice(0, 60)}" does not exist.`);
      // An entry has no sections to jump to yet.
      return l.newTab ? { type, target, newTab: true } : { type, target };
    }
    default:
      fail(`${label}: unknown link type "${type}".`);
  }
  const out: LinkValue = { type, target: type === 'anchor' ? target.replace(/^#/, '') : target };
  if (l.anchor) {
    out.anchor = String(l.anchor).replace(/^#/, '');
    if (!/^[A-Za-z][\w-]*$/.test(out.anchor)) fail(`${label}: "${out.anchor.slice(0, 40)}" is not a valid anchor.`);
  }
  if (l.newTab) out.newTab = true;
  // A relationship describes another site: kept on a web address only, so a change of link type lets it go. Only the
  // three an author declares are stored, as a list; anything else (a new tab's security tokens, the site's to add, or
  // a hand edit) is read for what it can say and never refuses the edit, which may not even be about this link.
  const rels = type === 'url' ? canonicalRels(l.rel) : [];
  if (rels.length) out.rel = rels;
  return out;
}

/** `storedAlt` is the description already saved for this image: one longer than the limit, saved before it had one,
 *  stays while it is not being changed, so toggling Decorative or picking another picture never fails on it. */
export function normalizeImage(v: unknown, state: ProjectState, label: string, storedAlt?: string): ImageValue {
  if (v === null || v === undefined) return { assetId: null, alt: '' };
  // A document or a font in the library is no picture to show.
  const notImage = (id: string) => {
    const a = own(state.assets.assets, id);
    if (!a) fail(`${label}: asset "${id}" does not exist.`);
    if (a!.kind !== 'image') fail(`${label}: "${a!.name}" is not an image.`);
  };
  // Refused whole, like any other text over its limit: a description cut short loses its end without a word.
  const described = (alt: string, from: string) => {
    if (alt.length > TEXT_LIMITS.imageAlt) fail(`${label}: ${from}: ${tooLongMessage(alt.length, TEXT_LIMITS.imageAlt)}`);
    return alt;
  };
  if (typeof v === 'string') {
    notImage(v);
    const a = state.assets.assets[v];
    return { assetId: v, alt: described(a.altSuggestion ?? '', `the suggested alt text of "${a.name}" (shorten it in Assets)`) };
  }
  const i = v as Partial<ImageValue>;
  // An ID is text: anything else would look up a library image without being one (an array reads as its text).
  if (i.assetId !== undefined && i.assetId !== null && typeof i.assetId !== 'string') fail(`${label}: an image's assetId must be an asset ID or null.`);
  if (i.assetId) notImage(i.assetId);
  const alt = String(i.alt ?? '');
  // No image is null, however it was sent.
  const out: ImageValue = { assetId: i.assetId || null, alt: alt === storedAlt ? alt : described(alt, 'image description') };
  if (i.decorative) out.decorative = true;
  return out;
}

export const MAX_RICH_CHARS = 20000;
export const MAX_RICH_BLOCKS = 500;
/** A collection entry's text is a whole article, so it has room for one: a long read with its pictures. */
export const MAX_ENTRY_CHARS = 100000;
export const MAX_ENTRY_BLOCKS = 2000;
/** The longest caption a picture in an article has. */
export const MAX_CAPTION = 300;

/**
 * Rich text in its stored form, from anything callers may send: a string (one block per line, with **bold**, *italic*,
 * [label](/route/), and "- ", "1. ", "- [x] ", "### ", "#### " and "> " line markers), an array of such strings, or
 * structured blocks. Every link is validated, and a link to a page stores the page's ID.
 */
export function normalizeRichText(v: unknown, state: ProjectState, label: string, plainAs?: RichListType, scope: LinkScope = {}): RichText {
  const link = (target: string, newTab: boolean, rel: LinkRel[] = []): LinkValue | null => {
    const t = target.trim();
    // An entry by its ID, refused where entry links are not kept, so it never stays behind as plain text.
    if (t.startsWith(ENTRY_LINK_PREFIX)) return normalizeLink({ type: 'entry', target: t.slice(ENTRY_LINK_PREFIX.length), newTab }, state, label, scope);
    // Or by its address (a path of this site, never a //host one), while no page has it.
    if (scope.entries && /^\/(?!\/)/.test(t)) {
      const route = `/${readablePath(t).replace(/^\/+|\/+$/g, '')}/`;
      const owner = collectionRoutes(state).find((o) => o.kind === 'entry' && o.route === route);
      if (owner?.kind === 'entry') return normalizeLink({ type: 'entry', target: owner.entryId, newTab }, state, label, scope);
    }
    const out = linkFromTarget(target, state.pages, newTab, rel);
    if (!out && target.startsWith('/')) fail(`${label}: no page${scope.entries ? ' or entry' : ''} has the route "${target.slice(0, 60)}".`);
    // A number that dials nothing (one saved before numbers needed three digits) is refused, never kept as its markup.
    if (!out && /^tel:/i.test(t)) fail(`${label}: "${t.slice(4, 44)}" is not a valid telephone number.`);
    return out;
  };
  const fromText = (s: string) => parseRichText(s, { markdown: true, link, plainAs, articles: !!scope.entries });
  const span = (raw: unknown): RichSpan => {
    if (typeof raw === 'string') return { text: raw };
    if (!raw || typeof raw !== 'object' || typeof (raw as RichSpan).text !== 'string') fail(`${label}: a span needs { text, strong?, em?, link? }.`);
    const s = raw as RichSpan;
    const out: RichSpan = { text: s.text };
    if (s.strong) out.strong = true;
    if (s.em) out.em = true;
    if (s.link) {
      const l = normalizeLink(s.link, state, label, scope);
      // Text is edited on the page, where a link is only its address: a download could not survive that edit.
      if (l.type === 'document') fail(`${label}: a link in text cannot go to a document yet. Use a button for the download.`);
      if (l.type !== 'none') out.link = l;
    }
    return out;
  };
  // Section headings and pictures between paragraphs belong to an article: an entry's text has them, and nothing else
  // shows them yet (a component's text sits under headings of its own).
  const article = (type: string) => {
    if (!scope.entries) fail(`${label}: ${type === 'h2' ? 'section headings (h2)' : 'pictures'} can only be placed in a collection entry's text.`);
  };
  const figure = (raw: Record<string, unknown>): RichBlock => {
    article('image');
    const { assetId, alt, caption, decorative } = raw;
    if (typeof assetId !== 'string' || !assetId) fail(`${label}: a picture needs the assetId of a library image.`);
    if (alt !== undefined && typeof alt !== 'string') fail(`${label}: a picture's alt text must be text.`);
    if (caption !== undefined && caption !== null && typeof caption !== 'string') fail(`${label}: a picture's caption must be text.`);
    // The library and the description's length, checked as any other picture's are.
    const img = normalizeImage({ assetId, alt: alt ?? '' }, state, label);
    const text = String(caption ?? '').trim();
    if (text.length > MAX_CAPTION) fail(`${label}: a picture's caption: ${tooLongMessage(text.length, MAX_CAPTION)}`);
    return { type: 'image', assetId: img.assetId!, alt: img.alt, ...(text ? { caption: text } : {}), ...(decorative ? { decorative: true as const } : {}) };
  };
  const block = (raw: RichBlock): RichBlock => {
    if (isImageBlock(raw)) return figure(raw as unknown as Record<string, unknown>);
    if (isListBlock(raw)) return { type: raw.type, items: raw.items.map((it) => (Array.isArray(it) ? it : [it]).map(span)) };
    if (raw.type === 'h2') article('h2');
    return { type: raw.type, spans: raw.spans.map(span) };
  };
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
  // Every character counts, the line breaks inside a block included; the gaps between blocks do not.
  const chars = out.reduce((n, b) => n + (isImageBlock(b) ? b.alt.length + (b.caption?.length ?? 0) : spanRuns(b).flat().reduce((m, sp) => m + sp.text.length, 0)), 0);
  if (out.length > (scope.entries ? MAX_ENTRY_BLOCKS : MAX_RICH_BLOCKS) || chars > (scope.entries ? MAX_ENTRY_CHARS : MAX_RICH_CHARS)) fail(`${label}: text is too long.`);
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

/** The description of an image value already saved, if it is one. */
export const storedAlt = (stored: unknown): string | undefined => (stored && typeof stored === 'object' && typeof (stored as ImageValue).alt === 'string' ? (stored as ImageValue).alt : undefined);

/**
 * `stored` is the value already saved for this field, if any. A value that was valid under older rules is
 * kept when it is not being changed, so editing one field never fails on another.
 */
export function normalizeScalar(schema: ScalarPropSchema, v: unknown, state: ProjectState, label: string, stored?: unknown): unknown {
  // Number(null) and Number("") are 0: clearing a required number is refused, not read as zero.
  if (schema.required && schema.type === 'number' && (v === null || v === undefined || (typeof v === 'string' && !v.trim()))) fail(requiredMessage(schema, label));
  // Checked on the value as it is kept, whichever way it was kept: a value saved under older rules stays only while it
  // is not empty.
  return requireValue(schema, scalarValue(schema, v, state, label, stored), label);
}

/** `v` itself when `schema` is not required or `v` is not empty; otherwise the edit fails with the property's path. */
export function requireValue<T>(schema: PropSchema, v: T, label: string): T {
  if (schema.required && isEmptyPropValue(schema, v)) fail(requiredMessage(schema, label));
  return v;
}

function scalarValue(schema: ScalarPropSchema, v: unknown, state: ProjectState, label: string, stored?: unknown): unknown {
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
      return schema.type === 'link' ? normalizeLink(v, state, label) : normalizeImage(v, state, label, storedAlt(stored));
    case 'icon':
      // An unknown name would silently render a fallback icon, so a new one is refused with the valid names.
      if (typeof v === 'string' && v === stored && /^[a-z0-9-]{1,40}$/.test(v)) return v;
      if (typeof v !== 'string' || !Object.hasOwn(ICONS, v)) fail(`${label}: ${typeof v === 'string' ? `"${v.slice(0, 40)}" is not an available icon` : 'expected an icon name'}. Use one of: ${Object.keys(ICONS).join(', ')}.`);
      return v;
    case 'choices':
      return normalizeChoices(v, label, stored);
    case 'token':
      return normalizeTokenRef(schema.tokenGroup, v, state, label, stored);
  }
}

/**
 * A token property's value: a reference to a declared token of its group, sent as `{ token }` or as the token's ID.
 * A reference saved before its token was lost (a theme switch) stays while it is not being changed.
 */
export function normalizeTokenRef(group: string, v: unknown, state: ProjectState, label: string, stored?: unknown): { token: string } {
  const id = typeof v === 'string' ? v : v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { token?: unknown }).token === 'string' ? (v as { token: string }).token : undefined;
  if (id === undefined) fail(`${label}: expected a ${group} token, such as { "token": "${declaredTokens(state).find((t) => t.group === group)?.id ?? `${group}.name`}" }.`);
  if (stored && typeof stored === 'object' && (stored as { token?: unknown }).token === id) return { token: id };
  const t = declaredTokens(state).find((x) => x.id === id);
  const choices = () => declaredTokens(state).filter((x) => x.group === group).map((x) => x.id).join(', ');
  if (!t) fail(`${label}: there is no token "${id.slice(0, 60)}". Use one of: ${choices()}.`);
  if (t.group !== group) fail(`${label}: "${t.label}" is a ${t.group} token; choose a ${group} token (${choices()}).`);
  return { token: id };
}

/**
 * An object property's value: every field, each checked as its own type. Fields left out keep their stored value
 * (or their default), so one field can be changed alone; a field the object does not have is refused.
 */
export function normalizeObject(schema: Extract<PropSchema, { type: 'object' }>, v: unknown, state: ProjectState, label: string, stored?: unknown): Record<string, unknown> {
  const names = Object.keys(schema.fields);
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${label}: expected an object with the fields ${names.join(', ')}.`);
  const extra = Object.keys(v).find((k) => !Object.hasOwn(schema.fields, k));
  if (extra !== undefined) fail(`${label}: "${extra.slice(0, 40)}" is not one of its fields (${names.join(', ')}).`);
  const before = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : undefined;
  const given = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(schema.fields)) {
    const raw = Object.hasOwn(given, k) ? given[k] : before && Object.hasOwn(before, k) ? before[k] : Object.hasOwn(schema.default ?? {}, k) ? structuredClone(schema.default[k]) : structuredClone(f.default);
    out[k] = normalizeScalar(f, raw, state, `${label} → ${f.label}`, before && Object.hasOwn(before, k) ? before[k] : undefined);
  }
  return out;
}

/** Where one item of a list is, for messages: "Hero → Cards → Card 2". */
export const itemPath = (schema: Extract<PropSchema, { type: 'list' }>, label: string, index: number) => `${label} → ${schema.itemLabel} ${index + 1}`;

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
  if (schema.type === 'table') return requireValue(schema, normalizeTable(v, label), label);
  if (schema.type === 'object') return requireValue(schema, normalizeObject(schema, v, state, label, stored), label);
  if (schema.type === 'list') {
    if (!Array.isArray(v)) fail(`${label}: expected a list.`);
    if (schema.feed) {
      // Its items are the site's pages, worked out where it is placed; there is nothing to store.
      if (v.length)
        fail(
          schema.feed === 'entries'
            ? `${label} fills itself from a collection's published entries; choose which with its collection, category, tag and count instead of items.`
            : `${label} fills itself from the site's ${schema.feed === 'articles' ? 'dated articles' : 'page'}; give its pages article details instead of items.`
        );
      return [];
    }
    if (schema.max !== undefined && v.length > schema.max) fail(`${label}: at most ${schema.max} items.`);
    if (schema.min !== undefined && v.length < schema.min) fail(`${label}: at least ${schema.min} items.`);
    const seen = new Set<string>();
    const before = new Map(Array.isArray(stored) ? (stored as ListItem[]).filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]) : []);
    const items = v.map((it, i) => {
      const base = it && typeof it === 'object' && typeof (it as ListItem).id === 'string' && !seen.has((it as ListItem).id) ? (it as ListItem) : undefined;
      const n = normalizeItem(schema, it as Record<string, unknown>, state, itemPath(schema, label, i), base ? { id: base.id } as ListItem : undefined, base ? before.get(base.id) : undefined);
      seen.add(n.id);
      return n;
    });
    return requireValue(schema, items, label);
  }
  return normalizeScalar(schema, v, state, label, stored);
}
