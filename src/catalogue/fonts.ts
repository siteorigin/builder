/**
 * The web fonts a site can use: those its theme pack ships (served from the pack's own .woff2 files through
 * generated @font-face rules, so no package needs installing), and the rules for font stacks. A family the site
 * cannot load would silently fall back to a system font, so font tokens only accept the theme's fonts, a
 * project's own fonts, or system fonts.
 */
import type { ProjectState } from '@shared/types';
import { projectFontFamilies } from '@shared/fonts';
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
 * A stack that needs no change is returned byte for byte. Returns the stack to store, or an error a person can act on.
 */
export function resolveFontStack(state: ProjectState, value: string): { stack: string } | { error: string } {
  const entries = stackEntries(value);
  if (!entries.length) return { error: 'Choose a font.' };
  const keys = entries.map(familyKey);
  const own = new Set(projectFontFamilies(state).map((f) => familyKey(f.family)));
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
  const alias = (key: string) => (own.has(key) ? undefined : installed.find((f) => familyKey(f.name) === key && !keys.includes(familyKey(f.family))));
  if (entries.length === 1 && alias(keys[0])) return { stack: alias(keys[0])!.stack };
  if (!keys.some(alias)) return { stack: value };
  return { stack: entries.flatMap((e, i) => (alias(keys[i]) ? [`'${alias(keys[i])!.family}'`, e] : [e])).join(', ') };
}

/**
 * The theme fonts a project uses, so unused fonts are not built into the site. It reads tokens, styles and code
 * component source for the family name; a code component that builds a family name at run time is not seen.
 */
export function usedPackFonts(state: ProjectState, tokenValues: unknown[]): BundledFont[] {
  // Whitespace inside a name may be any run of spaces or tabs, which JSON writes as escapes.
  const haystack = JSON.stringify([tokenValues, state.site.shell, state.pages, state.components]).replace(/(\\[nrt]|\s)+/g, ' ').toLowerCase();
  return installedFonts(state).filter((f) => haystack.includes(f.family.toLowerCase()));
}
