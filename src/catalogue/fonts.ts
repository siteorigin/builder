/**
 * The web fonts a site can use: those its theme pack ships (served from the pack's own .woff2 files through
 * generated @font-face rules, so no package needs installing), and the rules for font stacks. A family the site
 * cannot load would silently fall back to a system font, so font tokens only accept the theme's fonts, a
 * project's own fonts, or system fonts.
 */
import type { ProjectState } from '@shared/types';
import { FAMILY_KEYWORDS, importedFontStack, projectFontFamilies } from '@shared/fonts';
import { isFrozenThrough } from '@engine/draft';
import { getTheme, listThemes } from './index';
import type { PackFont } from './pack';

/** A font a theme ships. */
export type BundledFont = PackFont;

/** The template version new projects are created from. */
export const TEMPLATE_VERSION = '0.3.0';

/** The fonts this site's theme ships, which every project can use whatever template it was created from. */
export function installedFonts(state: Pick<ProjectState, 'site'>): BundledFont[] {
  return getTheme(state.site.themeId).fonts;
}

/** Installed family names, for prompts and pickers ("Plus Jakarta Sans Variable"). */
export function installedFontFamilies(state: Pick<ProjectState, 'site'>): string[] {
  return installedFonts(state).map((f) => f.family);
}

/** Generic families and fonts present on practically every system. */
const SYSTEM_FONTS = new Set(
  [
    'system-ui', '-apple-system', 'blinkmacsystemfont', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
    'segoe ui', 'helvetica neue', 'helvetica', 'arial', 'verdana', 'tahoma', 'trebuchet ms', 'georgia', 'times new roman', 'times', 'palatino', 'palatino linotype',
    'courier new', 'courier', 'sf mono', 'menlo', 'monaco', 'consolas'
  ]
);

/** The entries of a font stack as written, split on commas outside quotes. */
function stackEntries(stack: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote = '';
  for (const ch of stack) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ',') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((e) => e.trim()).filter(Boolean);
}

/** A word CSS reads as an identifier, so a bare name made of such words is a valid family. "1984" and "-" are not. */
const IDENT_WORD_RE = /^[A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF-]*$/;

const unquoted = (entry: string) => entry.replace(/^['"]|['"]$/g, '').trim();
/** CSS family names ignore case, and an unquoted name treats any run of spaces as one. */
const familyKey = (entry: string) => unquoted(entry).replace(/\s+/g, ' ').toLowerCase();

/** The family names in a font stack, without quotes. */
export function fontFamilies(stack: string): string[] {
  return stackEntries(stack).map(unquoted).filter(Boolean);
}

/**
 * Check a font stack against what the site can really load, by its first family (the one that is meant to show).
 * A bundled font's plain name ("Lora") does not match its package's @font-face family ("Lora Variable"), so the
 * real family is added in front of it, keeping the rest of the stack; a bare name gets the font's full stack.
 * A project's own font written bare gets its stack (quoted, with fallbacks), and one inside a longer stack that CSS would
 * not read as a name ("1984 Display") is quoted in place. A stack that needs no change is returned byte for byte.
 * Returns the stack to store, or an error a person can act on. `carried` are families taken as the project's own though
 * it has no file for them yet: a component package's fonts, which stay with the project it came from (#1418).
 */
export function resolveFontStack(state: ProjectState, value: string, carried: readonly string[] = []): { stack: string } | { error: string } {
  const entries = stackEntries(value);
  if (!entries.length) return { error: 'Choose a font.' };
  const keys = entries.map(familyKey);
  const own = new Map([...carried, ...projectFontFamilies(state).map((f) => f.family)].map((f) => [familyKey(f), f]));
  const installed = installedFonts(state);
  if (!own.has(keys[0]) && !SYSTEM_FONTS.has(keys[0])) {
    const names = installed.map((f) => f.name).join(', ');
    const named = (f: BundledFont) => familyKey(f.family) === keys[0] || familyKey(f.name) === keys[0];
    if (!installed.some(named)) {
      const other = listThemes().find((t) => t.fonts.some(named));
      if (other) return { error: `${other.fonts.find(named)!.name} comes with the ${other.name} theme, not this site's theme. Installed fonts: ${names}.` };
      return { error: `"${unquoted(entries[0])}" is not installed, so visitors would see a fallback font instead. Installed fonts: ${names}. System fonts such as Georgia, Arial or system-ui also work, or import the font.` };
    }
  }
  // An unquoted entry that names a project font, spelled as the font's own files spell it.
  const bare = (i: number) => (/^['"]/.test(entries[i]) || FAMILY_KEYWORDS.has(keys[i]) ? undefined : own.get(keys[i]));
  if (entries.length === 1 && bare(0)) return { stack: importedFontStack(bare(0)!) };
  const alias = (key: string) => (own.has(key) ? undefined : installed.find((f) => familyKey(f.name) === key && !keys.includes(familyKey(f.family))));
  if (entries.length === 1 && alias(keys[0])) return { stack: alias(keys[0])!.stack };
  // A name CSS would drop ("1984 Display") is quoted where it stands; a valid one is left as written.
  const fixed = entries.map((e, i) => (bare(i) && e.split(/\s+/).some((w) => !IDENT_WORD_RE.test(w)) ? `'${bare(i)}'` : e));
  if (!keys.some(alias)) return { stack: fixed.some((e, i) => e !== entries[i]) ? fixed.join(', ') : value };
  return { stack: fixed.flatMap((e, i) => (alias(keys[i]) ? [`'${alias(keys[i])!.family}'`, e] : [e])).join(', ') };
}

/**
 * Ways a code component can choose a font family while it runs, where its name need not be written out: a Svelte
 * style directive or an interpolated style value, a script's `fontFamily`, `font` or `setProperty('font-family', …)`,
 * and a font that comes from a custom property other than a site style's (`--so-…`, whose value the tokens carry).
 */
const RUNTIME_FONT = [
  /\bstyle:font(?:-family)?\s*=/,
  /\bfontFamily\b/,
  /\.font\s*=(?!=)/,
  /['"`]font(?:-family)?['"`]\s*,/,
  /\bfont(?:-family)?\s*:[^;<>}]*(?:\{|\$\{)/,
  /\bfont(?:-family)?\s*:[^;{}]*var\(\s*--(?!so-)/
];

/** Whether a code component's source can choose a font family at run time, which `usedPackFonts` cannot see. */
export function choosesFontAtRunTime(source: string): boolean {
  return RUNTIME_FONT.some((re) => re.test(source));
}

/**
 * Whether a code component's source says which theme fonts it uses, in a comment that starts with `Fonts:` and names
 * at least one of `families` (`<!-- Fonts: Lora Variable -->`). The families it names ship with the site, as any
 * family its source spells out.
 */
export function declaresFonts(source: string, families: string[]): boolean {
  const said = [...source.matchAll(/<!--\s*fonts?\s*:([\s\S]*?)-->|\/\*\s*fonts?\s*:([\s\S]*?)\*\/|\/\/\s*fonts?\s*:([^\n]*)/gi)].map((m) => (m[1] ?? m[2] ?? m[3] ?? '').replace(/\s+/g, ' ').toLowerCase());
  return said.some((text) => families.some((f) => text.includes(f.replace(/\s+/g, ' ').toLowerCase())));
}

/**
 * The theme fonts a project uses, so unused fonts are not built into the site. It reads tokens, styles and code
 * component source for the family name; a code component that builds a family name at run time is not seen.
 */
export function usedPackFonts(state: ProjectState, tokenValues: unknown[]): BundledFont[] {
  // Collections' layouts style every entry's page.
  const layouts = Object.values(state.collections ?? {}).flatMap((c) => [c?.settings?.template, c?.settings?.archiveTemplate]);
  const installed = installedFonts(state);
  const families = installed.map((f) => f.family.toLowerCase());
  // The text searched is the JSON of the tokens' values, the shell, the pages, the components and the layouts, one
  // array. A name holding none of JSON's punctuation can only be found inside the JSON of one value or one key, so
  // each document is searched on its own, and a document frozen through only once for these names.
  if (families.some((f) => /[[\]{},:]/.test(f))) {
    const haystack = searchable([tokenValues, state.site.shell, state.pages, state.components, layouts]);
    return installed.filter((_, i) => haystack.includes(families[i]));
  }
  const key = families.join('\n');
  const found = new Set<string>();
  const search = (text: string) => {
    for (const f of families) if (text.includes(f)) found.add(f);
  };
  const document = (doc: unknown) => {
    if (!doc || typeof doc !== 'object' || !isFrozenThrough(doc)) return search(searchable(doc));
    let seen = namesIn.get(doc);
    if (seen?.key !== key) {
      const text = searchable(doc);
      namesIn.set(doc, (seen = { key, names: families.filter((f) => text.includes(f)) }));
    }
    for (const f of seen.names) found.add(f);
  };
  search(searchable(tokenValues));
  document(state.site.shell);
  for (const map of [state.pages, state.components] as Array<Record<string, unknown>>) {
    for (const [id, doc] of Object.entries(map)) {
      // A key is in the text with its value, unless JSON leaves the value out.
      if (doc === undefined || typeof doc === 'function' || typeof doc === 'symbol') continue;
      search(searchable(id));
      document(doc);
    }
  }
  // JSON writes a layout a collection does not have as null.
  for (const layout of layouts) document(layout ?? null);
  return installed.filter((_, i) => found.has(families[i]));
}

/**
 * The families a document frozen through names, of the families `key` lists (one per line): such a document never
 * changes, so it is searched once for as long as the site's fonts are the same.
 */
const namesIn = new WeakMap<object, { key: string; names: string[] }>();

/** A value's JSON as names are searched for in it: whitespace inside a name may be any run of spaces or tabs, which JSON writes as escapes. */
const searchable = (value: unknown) => (JSON.stringify(value) ?? 'null').replace(/(\\[nrt]|\s)+/g, ' ').toLowerCase();
