/**
 * Web fonts imported into a project. Each imported file is a font asset with a family, weight and style;
 * the generator turns them into @font-face rules, and a font token uses one by naming its family.
 */
import type { AssetRecord, FontCategory, OwnerRef, ProjectState } from './types';

/** A family becomes a quoted CSS name, so only plain characters are allowed. */
export const FONT_FAMILY_RE = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u;
export const FONT_WEIGHT_RE = /^([1-9]\d{0,2}|1000)( ([1-9]\d{0,2}|1000))?$/;
/** Where a font's file may be: a name the importer could have given it, in static/assets/. */
export const FONT_FILE_RE = /^static\/assets\/[a-z0-9][a-z0-9-]*\.woff2?$/;

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
  /** The kind of face the family is, when its files that say agree on it; absent when none says, or they differ. */
  category?: FontCategory;
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
  for (const entry of byFamily.values()) {
    const category = familyCategory(entry.faces);
    if (category) entry.category = category;
  }
  return [...byFamily.values()].sort((a, b) => byText(a.family, b.family));
}

/**
 * What a stack ends in after an imported family, by the kind of face it is: a fallback of the same kind shows while
 * the file loads and for any character it lacks. The serif and monospace ones are the built-in fonts' own.
 */
export const FALLBACK_STACKS: Readonly<Record<FontCategory, string>> = {
  'sans-serif': 'system-ui, sans-serif',
  serif: "Georgia, 'Times New Roman', serif",
  monospace: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
};

const FONT_CATEGORIES: readonly FontCategory[] = ['sans-serif', 'serif', 'monospace'];
/** Is this one of the kinds of face (a hand-edited assets.json can hold anything)? */
export const isFontCategory = (v: unknown): v is FontCategory => typeof v === 'string' && (FONT_CATEGORIES as readonly string[]).includes(v);

/**
 * The kind of face a family's files are: the one kind those that say agree on, so an italic that says nothing takes
 * its upright's, while files that disagree leave it unknown, in whatever order they are listed.
 */
export function familyCategory(faces: readonly AssetRecord[]): FontCategory | undefined {
  const kinds = new Set(faces.map((a) => a.font?.category).filter(isFontCategory));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

/**
 * Which standard fallback a stack ends in after its first family: a kind of face, `null` for a tail of its own
 * ("'Acme', Arial, serif"), or undefined for a stack with nothing after its first family.
 */
export function stackFallback(stack: string): FontCategory | null | undefined {
  const at = stack.indexOf(',');
  if (at < 0) return undefined;
  const tail = stack
    .slice(at + 1)
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').replace(/"/g, "'").trim())
    .join(', ');
  return FONT_CATEGORIES.find((c) => FALLBACK_STACKS[c] === tail) ?? null;
}

/** A stack's first family followed by the standard fallback of a kind of face, in place of whatever followed it. */
export function withFallback(stack: string, category: FontCategory): string {
  return `${stack.split(',')[0].trim()}, ${FALLBACK_STACKS[category]}`;
}

/** The font stack a token uses for an imported family, ending in a fallback of its kind (sans-serif when unknown). */
export function importedFontStack(family: string, category: FontCategory = 'sans-serif'): string {
  return `'${family}', ${FALLBACK_STACKS[isFontCategory(category) ? category : 'sans-serif']}`;
}

/** The stack for a project's imported family, by its name (any case): its own fallback, or sans-serif when it has no files. */
export function projectFontStack(state: ProjectState, family: string): string {
  const own = projectFontFamilies(state).find((f) => f.family.toLowerCase() === family.toLowerCase());
  return importedFontStack(own?.family ?? family, own?.category);
}

const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '').trim();
const sameFamily = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Words that name no family when written bare, so a font of the same name is not what they mean. */
export const FAMILY_KEYWORDS: ReadonlySet<string> = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default']);
/** Source text as it is searched for a family name: runs of whitespace as one space, case folded. */
const searchText = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
/** The family a stack entry names, as CSS reads it: a run of spaces in a name is one, and a bare keyword names none. */
function entryName(part: string): string | undefined {
  const bare = !/^\s*['"]/.test(part);
  const name = searchText(unquote(part));
  return bare && FAMILY_KEYWORDS.has(name) ? undefined : name;
}
/** Are these two records faces of one family? */
export const sameFontFamily = (a: AssetRecord, b: AssetRecord) => isValidFontAsset(a) && isValidFontAsset(b) && sameFamily(a.font!.family, b.font!.family);

/** Does a font stack name this family, anywhere in the stack? (CSS family names ignore case.) */
export function stackUsesFamily(stack: string, family: string): boolean {
  const name = searchText(unquote(family));
  return stack.split(',').some((part) => entryName(part) === name);
}

/**
 * One place the site uses a font family: a site style (a font token, or a text style naming it directly), the font
 * of elements on a page, the shared header or footer or a component, or a project code component whose source
 * names it.
 */
export type FontUse = { kind: 'token'; tokenId: string } | { kind: 'element'; owner: OwnerRef } | { kind: 'code'; componentId: string };

interface FontSlot {
  get: () => string;
  set: (v: string) => void;
  use: FontUse;
}

/**
 * Every place a font family is written: font tokens, text styles, and `fontFamily` styles on elements, overrides
 * and variants. Page titles and other text that merely match a font's name are not font uses.
 */
function fontSlots(state: ProjectState, components: unknown = state.components, fontTokens: ReadonlySet<string> = new Set()): FontSlot[] {
  const slots: FontSlot[] = [];
  const add = (holder: Record<string, unknown>, key: string, use: FontUse) => {
    if (typeof holder[key] === 'string') slots.push({ get: () => holder[key] as string, set: (v) => (holder[key] = v), use });
  };
  const token = (holder: Record<string, unknown>, key: string, tokenId: string, isFont: boolean) => {
    const v = holder[key];
    const use: FontUse = { kind: 'token', tokenId };
    if (typeof v === 'string') {
      if (isFont) add(holder, key, use);
    } else if (v && typeof v === 'object' && 'family' in v) add(v as Record<string, unknown>, 'family', use);
  };
  const customGroup = new Map(state.tokens.custom.map((t) => [t.id, t.group]));
  const overrides = state.tokens.overrides as unknown as Record<string, unknown>;
  for (const id of Object.keys(overrides)) token(overrides, id, id, customGroup.get(id) === 'font' || id.startsWith('font.') || fontTokens.has(id));
  for (const t of state.tokens.custom) token(t as unknown as Record<string, unknown>, 'value', t.id, t.group === 'font');
  const walk = (v: unknown, use: FontUse) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, use));
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        // Only a string is a family: item styles are keyed by item ID, which can be any word, even this one.
        if (k === 'fontFamily' && typeof o[k] === 'string') add(o, k, use);
        else walk(o[k], use);
      }
    }
  };
  const element = (kind: OwnerRef['kind'], id: string): FontUse => ({ kind: 'element', owner: { kind, id } });
  for (const [id, page] of Object.entries(state.pages ?? {})) walk(page, element('page', (page as { id?: string })?.id ?? id));
  for (const [id, def] of Object.entries((components ?? {}) as Record<string, unknown>)) walk(def, element('component', (def as { id?: string })?.id ?? id));
  for (const [part, tree] of Object.entries(state.site.shell ?? {})) walk(tree, element('shell', part));
  // Each collection's layout, which every entry's page is shown with.
  for (const [id, c] of Object.entries(state.collections ?? {})) walk((c as { settings?: { template?: unknown } })?.settings?.template, element('template', id));
  for (const [id, c] of Object.entries(state.collections ?? {})) walk((c as { settings?: { archiveTemplate?: unknown } })?.settings?.archiveTemplate, element('archive', id));
  return slots;
}

/**
 * A test for a family name written anywhere in text that went through `searchText`, but not as the start or end of a
 * longer name (`Sans` is not in `sans-serif`, `Inter` is not in `interface` or `--font-inter`).
 */
function namedIn(family: string): (text: string) => boolean {
  const name = searchText(unquote(family)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_-])${name}(?![\\p{L}\\p{N}_-])`, 'u');
  return (text) => re.test(text);
}

/** The definitions the project owns: what an edit may change, and whose code is the site's own. */
const projectDefinitions = (state: ProjectState) => Object.values(state.components).filter((d) => d.owner === 'project');

/**
 * Whether the site itself chose this font family: in a site style (the theme's font tokens are `fontTokens`, besides
 * any named font.*) or text style, as an element's font (on pages,
 * the shared header and footer, or the given components), or in a project code component's source. Text that
 * merely mentions the name, and the theme's own defaults, are not choices.
 */
export function siteChoosesFamily(state: ProjectState, family: string, fontTokens: ReadonlySet<string> = new Set(), components = projectDefinitions(state)): boolean {
  // CSS reads a run of spaces in an unquoted name as one, and family names ignore case.
  const key = (name: string) => searchText(unquote(name));
  const name = key(family);
  if (fontSlots(state, components, fontTokens).some((s) => s.get().split(',').some((part) => key(part) === name))) return true;
  const named = namedIn(family);
  return components.some((d) => d.kind === 'code' && typeof d.source === 'string' && named(searchText(d.source)));
}

/** Point every use of `from` at `to`, keeping the rest of each stack. */
export function renameFontFamily(state: ProjectState, from: string, to: string) {
  // A theme's definitions are locked to the pack's own copy (their hash), so a project's font never rewrites them.
  const name = searchText(unquote(from));
  for (const slot of fontSlots(state, projectDefinitions(state))) {
    const stack = slot.get();
    if (!stackUsesFamily(stack, from)) continue;
    slot.set(stack.split(',').map((part) => (entryName(part) === name ? `${part.startsWith(' ') ? ' ' : ''}'${to}'` : part)).join(','));
  }
}

/**
 * Every place the site uses a family, by the same rules as `fontAssetUsages`: font tokens and text styles (the
 * theme's font tokens are `fontTokens`, besides any named font.*), element fonts, and project code components that
 * name it (each once).
 */
export function familyUses(state: ProjectState, family: string, fontTokens: ReadonlySet<string> = new Set()): FontUse[] {
  const uses = fontSlots(state, state.components, fontTokens)
    .filter((s) => stackUsesFamily(s.get(), family))
    .map((s) => s.use);
  const named = namedIn(family);
  for (const d of projectDefinitions(state)) if (d.kind === 'code' && typeof d.source === 'string' && named(searchText(d.source))) uses.push({ kind: 'code', componentId: d.id });
  return uses;
}

/** Every font stack the given definitions write: the font of an element, override or variant (`fontFamily`). */
export function fontStacksIn(defs: readonly unknown[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'fontFamily' && typeof x === 'string') out.push(x);
        else walk(x);
      }
    }
  };
  defs.forEach(walk);
  return out;
}

/**
 * Which of `families` the given definitions and font stacks use, by the rules `familyUses` reads a site with: the font
 * of an element, override or variant, a code component's source that names the family (or a default of one of its
 * properties, which its code may set a font from), and a stack (a site style's font). Each family is listed once, as
 * `families` spells it.
 */
export function familiesUsedBy(families: readonly string[], defs: readonly unknown[], stacks: readonly string[] = []): string[] {
  const all = [...fontStacksIn(defs), ...stacks];
  const sources: string[] = [];
  for (const d of defs) {
    const def = d as { kind?: unknown; source?: unknown; properties?: Record<string, { default?: unknown }> };
    if (def?.kind !== 'code') continue;
    if (typeof def.source === 'string') sources.push(searchText(def.source));
    for (const p of Object.values(def.properties ?? {})) if (typeof p?.default === 'string') sources.push(searchText(p.default));
  }
  return families.filter((family) => {
    const named = namedIn(family);
    return all.some((stack) => stackUsesFamily(stack, family)) || sources.some(named);
  });
}

/** A stack with a family taken out wherever it names it (empty when nothing else is left). */
export function withoutFamily(stack: string, family: string): string {
  const name = searchText(unquote(family));
  return stack
    .split(',')
    .filter((part) => entryName(part) !== name)
    .join(',')
    .trim();
}

/** Does the stack lead with this family? */
export const stackLeadsWith = (stack: string, family: string) => entryName(stack.split(',')[0] ?? '') === searchText(unquote(family));

/** What a stack falls back to once nothing is left in it. */
export const FALLBACK_STACK = 'system-ui, sans-serif';

/**
 * Stop using a family wherever the site's own styles name it. A stack it leads becomes `replaceWith` when one is
 * given; anywhere else it is taken out of the stack, which then falls back to its next font (or FALLBACK_STACK once
 * nothing is left). A theme's locked definitions and code are never rewritten.
 */
export function dropFontFamily(state: ProjectState, family: string, replaceWith: string | null, fontTokens: ReadonlySet<string> = new Set()) {
  const name = searchText(unquote(family));
  for (const slot of fontSlots(state, projectDefinitions(state), fontTokens)) {
    const parts = slot.get().split(',');
    if (!parts.some((part) => entryName(part) === name)) continue;
    if (replaceWith && entryName(parts[0]) === name) {
      slot.set(replaceWith);
      continue;
    }
    slot.set(withoutFamily(slot.get(), family) || FALLBACK_STACK);
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

/**
 * How many styles use each imported font family, keyed by asset ID (for usage counts). A project's code component
 * that names the family in its source counts once, however often it names it.
 */
export function fontAssetUsages(state: ProjectState, fontTokens: ReadonlySet<string> = new Set()): Record<string, number> {
  const out: Record<string, number> = {};
  const families = projectFontFamilies(state);
  if (!families.length) return out;
  const stacks = fontSlots(state, state.components, fontTokens).map((s) => s.get());
  const sources = projectDefinitions(state).flatMap((d) => (d.kind === 'code' && typeof d.source === 'string' ? [searchText(d.source)] : []));
  for (const { family, faces } of families) {
    const named = namedIn(family);
    const n = stacks.filter((v) => stackUsesFamily(v, family)).length + sources.filter(named).length;
    if (n) for (const a of faces) out[a.id] = n;
  }
  return out;
}
