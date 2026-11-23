/**
 * The web fonts installed with the website template (self-hosted from @fontsource-variable packages, all under
 * the SIL Open Font License), and the rules for font stacks. A family the site cannot load would silently fall
 * back to a system font, so font tokens only accept installed fonts, a project's own fonts, or system fonts.
 */
import type { ProjectState } from '@shared/types';
import { projectFontFamilies } from '@shared/fonts';

export interface BundledFont {
  /** The CSS family name the package's @font-face rules declare. */
  family: string;
  /** The name a person would use. */
  name: string;
  package: string;
  category: 'sans-serif' | 'serif';
  /** A complete font stack, for font tokens. */
  stack: string;
}

export const BUNDLED_FONTS: BundledFont[] = [
  { family: 'Inter Variable', name: 'Inter', package: '@fontsource-variable/inter', category: 'sans-serif', stack: "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { family: 'Fraunces Variable', name: 'Fraunces', package: '@fontsource-variable/fraunces', category: 'serif', stack: "'Fraunces Variable', 'Fraunces', Georgia, 'Times New Roman', serif" },
  { family: 'Plus Jakarta Sans Variable', name: 'Plus Jakarta Sans', package: '@fontsource-variable/plus-jakarta-sans', category: 'sans-serif', stack: "'Plus Jakarta Sans Variable', 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { family: 'DM Sans Variable', name: 'DM Sans', package: '@fontsource-variable/dm-sans', category: 'sans-serif', stack: "'DM Sans Variable', 'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { family: 'Space Grotesk Variable', name: 'Space Grotesk', package: '@fontsource-variable/space-grotesk', category: 'sans-serif', stack: "'Space Grotesk Variable', 'Space Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { family: 'Playfair Display Variable', name: 'Playfair Display', package: '@fontsource-variable/playfair-display', category: 'serif', stack: "'Playfair Display Variable', 'Playfair Display', Georgia, 'Times New Roman', serif" },
  { family: 'Lora Variable', name: 'Lora', package: '@fontsource-variable/lora', category: 'serif', stack: "'Lora Variable', 'Lora', Georgia, 'Times New Roman', serif" }
];

/** The template version new projects are created from. */
export const TEMPLATE_VERSION = '0.2.0';
/** What each template's lockfile installs. Any other project is only assumed to have the original two fonts. */
const FONTS_BY_TEMPLATE: Record<string, string[]> = { '0.2.0': BUNDLED_FONTS.slice(0, 7).map((f) => f.package) };
const ORIGINAL_FONTS = ['@fontsource-variable/inter', '@fontsource-variable/fraunces'];

/** The bundled fonts this project's own package.json actually installs. */
export function installedFonts(state: Pick<ProjectState, 'manifest'>): BundledFont[] {
  const template = state.manifest.template;
  const packages = (template?.id === 'sveltekit-brochure' && Object.hasOwn(FONTS_BY_TEMPLATE, template.version) ? FONTS_BY_TEMPLATE[template.version] : undefined) ?? ORIGINAL_FONTS;
  return BUNDLED_FONTS.filter((f) => packages.includes(f.package));
}

/** Installed family names, for prompts and pickers ("Plus Jakarta Sans Variable"). */
export function installedFontFamilies(state: Pick<ProjectState, 'manifest'>): string[] {
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
    const bundled = BUNDLED_FONTS.find((f) => familyKey(f.family) === keys[0] || familyKey(f.name) === keys[0]);
    if (!bundled) return { error: `"${unquoted(entries[0])}" is not installed, so visitors would see a fallback font instead. Installed fonts: ${names}. System fonts such as Georgia, Arial or system-ui also work, or import the font.` };
    if (!installed.includes(bundled)) return { error: `${bundled.name} is not installed in this project, which was created with an earlier version. Installed fonts: ${names}.` };
  }
  const alias = (key: string) => (own.has(key) ? undefined : installed.find((f) => familyKey(f.name) === key && !keys.includes(familyKey(f.family))));
  if (entries.length === 1 && alias(keys[0])) return { stack: alias(keys[0])!.stack };
  if (!keys.some(alias)) return { stack: value };
  return { stack: entries.flatMap((e, i) => (alias(keys[i]) ? [`'${alias(keys[i])!.family}'`, e] : [e])).join(', ') };
}

/**
 * The font packages a project uses, so unused fonts are not built into the site. It reads tokens, styles and code
 * component source for the family name; a code component that builds a family name at run time is not seen.
 */
export function usedFontPackages(state: ProjectState, tokenValues: unknown[]): string[] {
  // Whitespace inside a name may be any run of spaces or tabs, which JSON writes as escapes.
  const haystack = JSON.stringify([tokenValues, state.site.shell, state.pages, state.components]).replace(/(\\[nrt]|\s)+/g, ' ').toLowerCase();
  return installedFonts(state)
    .filter((f) => haystack.includes(f.family.toLowerCase()))
    .map((f) => f.package);
}
