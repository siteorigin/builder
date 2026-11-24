/**
 * The web fonts the theme packs shipped with the app carry: variable fonts from the Fontsource packages (all under the
 * SIL Open Font License), whose faces and files are copied into a pack when it is built. Each pack takes the fonts it
 * offers from this list and sets its own defaults among them; a site only ever gets the files of the fonts it uses.
 */
import type { PackFontSource } from './pack';

const fontsource = (slug: string) => ({ css: `@fontsource-variable/${slug}/index.css`, noticeFile: `@fontsource-variable/${slug}/LICENSE`, license: 'OFL-1.1' });

export const BUILTIN_FONTS: PackFontSource[] = [
  { family: 'Inter Variable', name: 'Inter', category: 'sans-serif', stack: "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif", ...fontsource('inter') },
  { family: 'Fraunces Variable', name: 'Fraunces', category: 'serif', stack: "'Fraunces Variable', 'Fraunces', Georgia, 'Times New Roman', serif", ...fontsource('fraunces') },
  { family: 'Plus Jakarta Sans Variable', name: 'Plus Jakarta Sans', category: 'sans-serif', stack: "'Plus Jakarta Sans Variable', 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif", ...fontsource('plus-jakarta-sans') },
  { family: 'DM Sans Variable', name: 'DM Sans', category: 'sans-serif', stack: "'DM Sans Variable', 'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif", ...fontsource('dm-sans') },
  { family: 'Space Grotesk Variable', name: 'Space Grotesk', category: 'sans-serif', stack: "'Space Grotesk Variable', 'Space Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif", ...fontsource('space-grotesk') },
  { family: 'Playfair Display Variable', name: 'Playfair Display', category: 'serif', stack: "'Playfair Display Variable', 'Playfair Display', Georgia, 'Times New Roman', serif", ...fontsource('playfair-display') },
  { family: 'Lora Variable', name: 'Lora', category: 'serif', stack: "'Lora Variable', 'Lora', Georgia, 'Times New Roman', serif", ...fontsource('lora') },
  { family: 'Sora Variable', name: 'Sora', category: 'sans-serif', stack: "'Sora Variable', 'Sora', system-ui, -apple-system, 'Segoe UI', sans-serif", ...fontsource('sora') },
  { family: 'JetBrains Mono Variable', name: 'JetBrains Mono', category: 'monospace', stack: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace", ...fontsource('jetbrains-mono') }
];

/** One of these fonts, by its name. */
export function builtinFont(name: string): PackFontSource {
  const font = BUILTIN_FONTS.find((f) => f.name === name);
  if (!font) throw new Error(`${name} is not one of the built-in fonts.`);
  return font;
}

/** The stack of one of these fonts, by its name, for a pack's font tokens. */
export const builtinFontStack = (name: string): string => builtinFont(name).stack;
