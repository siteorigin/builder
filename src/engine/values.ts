import type { ImageValue, LinkValue, ListItem, ProjectState, PropSchema, ScalarPropSchema } from '@shared/types';
import { newId } from '@shared/ids';
import { fail } from './tree';

export function normalizeLink(v: unknown, state: ProjectState, label: string): LinkValue {
  if (v === null || v === undefined || v === '') return { type: 'none', target: '' };
  if (typeof v === 'string') {
    // Accept shorthand strings from simpler callers.
    if (/^https?:\/\//i.test(v)) return { type: 'url', target: v };
    if (/^mailto:/i.test(v)) return { type: 'email', target: v.slice(7) };
    if (/^tel:/i.test(v)) return { type: 'tel', target: v.slice(4) };
    if (v.startsWith('#')) return { type: 'anchor', target: v.slice(1) };
    if (state.pages[v]) return { type: 'page', target: v };
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
      if (!state.pages[target]) fail(`${label}: page "${target}" does not exist.`);
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
  if (l.anchor) out.anchor = String(l.anchor).replace(/^#/, '');
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

export function normalizeScalar(schema: ScalarPropSchema, v: unknown, state: ProjectState, label: string): unknown {
  switch (schema.type) {
    case 'string': {
      if (typeof v !== 'string' && typeof v !== 'number') fail(`${label}: expected text.`);
      const s = String(v);
      const max = schema.maxLength ?? 2000;
      if (s.length > max) fail(`${label}: text is longer than ${max} characters.`);
      return schema.multiline ? s : s.replace(/\s*\n\s*/g, ' ');
    }
    case 'richtext': {
      const arr = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/\n{2,}|\n/) : fail(`${label}: expected paragraphs.`);
      const cleaned = arr.map((p) => p.trim()).filter((p) => p.length);
      if (cleaned.join('').length > 20000) fail(`${label}: text is too long.`);
      return cleaned;
    }
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
      if (typeof v !== 'string' || !/^[a-z0-9-]{1,40}$/.test(v)) fail(`${label}: expected an icon name.`);
      return v;
  }
}

export function normalizeItem(schema: Extract<PropSchema, { type: 'list' }>, item: Record<string, unknown> | undefined, state: ProjectState, label: string, base?: ListItem): ListItem {
  const out: ListItem = { id: base?.id ?? newId('i') };
  for (const [k, f] of Object.entries(schema.fields)) {
    const raw = item && k in item ? item[k] : base && k in base ? base[k] : structuredClone(f.default);
    out[k] = normalizeScalar(f, raw, state, `${label} → ${f.label}`);
  }
  return out;
}

export function normalizeProp(schema: PropSchema, v: unknown, state: ProjectState, label: string): unknown {
  if (schema.type === 'list') {
    if (!Array.isArray(v)) fail(`${label}: expected a list.`);
    if (schema.max !== undefined && v.length > schema.max) fail(`${label}: at most ${schema.max} items.`);
    if (schema.min !== undefined && v.length < schema.min) fail(`${label}: at least ${schema.min} items.`);
    const seen = new Set<string>();
    return v.map((it) => {
      const base = it && typeof it === 'object' && typeof (it as ListItem).id === 'string' && !seen.has((it as ListItem).id) ? (it as ListItem) : undefined;
      const n = normalizeItem(schema, it as Record<string, unknown>, state, label, base ? { id: base.id } as ListItem : undefined);
      seen.add(n.id);
      return n;
    });
  }
  return normalizeScalar(schema, v, state, label);
}
