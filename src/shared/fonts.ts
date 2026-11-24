/**
 * Web fonts imported into a project. Each imported file is a font asset with a family, weight and style;
 * the generator turns them into @font-face rules, and a font token uses one by naming its family.
 */
import type { AssetRecord, ProjectState } from './types';

/** A family becomes a quoted CSS name, so only plain characters are allowed. */
export const FONT_FAMILY_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u;
export const FONT_WEIGHT_RE = /^([1-9]\d{0,2}|1000)( ([1-9]\d{0,2}|1000))?$/;
const FONT_FILE_RE = /^static\/assets\/[a-z0-9][a-z0-9-]*\.woff2?$/;

/**
 * Is this record safe to emit as a @font-face rule? Checked here as well as in the operation schema, because
 * assets.json can also be edited outside the app.
 */
export function isValidFontAsset(a: AssetRecord): boolean {
  const f = a?.font;
  return !!a && a.kind === 'font' && !!f && typeof f.family === 'string' && FONT_FAMILY_RE.test(f.family) && typeof f.weight === 'string' && FONT_WEIGHT_RE.test(f.weight) && (f.style === 'normal' || f.style === 'italic') && typeof a.file === 'string' && FONT_FILE_RE.test(a.file);
}

export interface ProjectFontFamily {
  family: string;
  faces: AssetRecord[];
}

/** Compared by code unit, never by locale: generated CSS must be byte-identical on every machine. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Families provided by the project's imported fonts, each with its files (faces), sorted by name. */
export function projectFontFamilies(state: ProjectState): ProjectFontFamily[] {
  // CSS family names ignore case, so "Inter" and "inter" are one family, named as its first file names it.
  const byFamily = new Map<string, ProjectFontFamily>();
  for (const a of Object.values(state.assets.assets)) {
    if (!isValidFontAsset(a)) continue;
    const key = a.font!.family.toLowerCase();
    const entry = byFamily.get(key);
    if (entry) entry.faces.push(a);
    else byFamily.set(key, { family: a.font!.family, faces: [a] });
  }
  return [...byFamily.values()].sort((a, b) => byText(a.family, b.family));
}

/** The font stack a token uses for an imported family, with a generic fallback while it loads. */
export function importedFontStack(family: string): string {
  return `'${family}', system-ui, sans-serif`;
}

const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '').trim();
const sameFamily = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Are these two records faces of one family? */
export const sameFontFamily = (a: AssetRecord, b: AssetRecord) => isValidFontAsset(a) && isValidFontAsset(b) && sameFamily(a.font!.family, b.font!.family);

/** Does a font stack name this family, anywhere in the stack? (CSS family names ignore case.) */
export function stackUsesFamily(stack: string, family: string): boolean {
  return stack.split(',').some((part) => sameFamily(unquote(part), family));
}

/**
 * Every place a font family is written: font tokens, text styles, and `fontFamily` styles on elements, overrides
 * and variants. Page titles and other text that merely match a font's name are not font uses.
 */
function fontSlots(state: ProjectState, components: unknown = state.components): Array<{ get: () => string; set: (v: string) => void }> {
  const slots: Array<{ get: () => string; set: (v: string) => void }> = [];
  const add = (holder: Record<string, unknown>, key: string) => {
    if (typeof holder[key] === 'string') slots.push({ get: () => holder[key] as string, set: (v) => (holder[key] = v) });
  };
  const token = (holder: Record<string, unknown>, key: string, isFont: boolean) => {
    const v = holder[key];
    if (typeof v === 'string') {
      if (isFont) add(holder, key);
    } else if (v && typeof v === 'object' && 'family' in v) add(v as Record<string, unknown>, 'family');
  };
  const customGroup = new Map(state.tokens.custom.map((t) => [t.id, t.group]));
  const overrides = state.tokens.overrides as unknown as Record<string, unknown>;
  for (const id of Object.keys(overrides)) token(overrides, id, customGroup.get(id) === 'font' || id.startsWith('font.'));
  for (const t of state.tokens.custom) token(t as unknown as Record<string, unknown>, 'value', t.group === 'font');
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (k === 'fontFamily') add(o, k);
        else walk(o[k]);
      }
    }
  };
  walk(state.pages);
  walk(components);
  walk(state.site.shell);
  return slots;
}

/**
 * Whether the site itself chose this font family: in a site style or text style, as an element's font (on pages,
 * the shared header and footer, or the given components), or in a project code component's source. Text that
 * merely mentions the name, and the theme's own defaults, are not choices.
 */
export function siteChoosesFamily(state: ProjectState, family: string, components = Object.values(state.components).filter((d) => d.owner === 'project')): boolean {
  if (fontSlots(state, components).some((s) => stackUsesFamily(s.get(), family))) return true;
  const name = family.toLowerCase();
  return components.some((d) => d.kind === 'code' && typeof d.source === 'string' && d.source.replace(/\s+/g, ' ').toLowerCase().includes(name));
}

/** Point every use of `from` at `to`, keeping the rest of each stack. */
export function renameFontFamily(state: ProjectState, from: string, to: string) {
  for (const slot of fontSlots(state)) {
    const stack = slot.get();
    if (!stackUsesFamily(stack, from)) continue;
    slot.set(stack.split(',').map((part) => (sameFamily(unquote(part), from) ? `${part.startsWith(' ') ? ' ' : ''}'${to}'` : part)).join(','));
  }
}

/** The public URL of a file under static/. */
const publicUrl = (file: string) => '/' + file.replace(/^static\//, '');

/** @font-face rules for every imported font, in a stable order. */
export function fontFaceCss(state: ProjectState): string {
  const rules: string[] = [];
  for (const { family, faces } of projectFontFamilies(state)) {
    for (const a of [...faces].sort((x, y) => byText(x.file, y.file) || byText(x.id, y.id))) {
      const format = a.file.endsWith('.woff2') ? 'woff2' : 'woff';
      rules.push(
        `@font-face {\n\tfont-family: '${family}';\n\tsrc: url('${publicUrl(a.file)}') format('${format}');\n\tfont-weight: ${a.font!.weight};\n\tfont-style: ${a.font!.style};\n\tfont-display: swap;\n}`
      );
    }
  }
  return rules.length ? `/* Fonts imported into this project. */\n${rules.join('\n')}\n\n` : '';
}

/** How many styles use each imported font family, keyed by asset ID (for usage counts). */
export function fontAssetUsages(state: ProjectState): Record<string, number> {
  const out: Record<string, number> = {};
  const families = projectFontFamilies(state);
  if (!families.length) return out;
  const stacks = fontSlots(state).map((s) => s.get());
  for (const { family, faces } of families) {
    const n = stacks.filter((v) => stackUsesFamily(v, family)).length;
    if (n) for (const a of faces) out[a.id] = n;
  }
  return out;
}
