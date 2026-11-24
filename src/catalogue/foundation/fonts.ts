/**
 * The web fonts Foundation ships: variable fonts from the Fontsource packages (all under the SIL Open Font
 * License), whose faces and files are copied into the pack when it is built.
 */
import type { PackFontSource } from '../pack';

const fontsource = (slug: string) => ({ css: `@fontsource-variable/${slug}/index.css`, noticeFile: `@fontsource-variable/${slug}/LICENSE`, license: 'OFL-1.1' });

export const FOUNDATION_FONTS: PackFontSource[] = [
  { family: 'Inter Variable', name: 'Inter', category: 'sans-serif', stack: "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif", ...fontsource('inter') },
  { family: 'Fraunces Variable', name: 'Fraunces', category: 'serif', stack: "'Fraunces Variable', 'Fraunces', Georgia, 'Times New Roman', serif", ...fontsource('fraunces') },
  { family: 'Plus Jakarta Sans Variable', name: 'Plus Jakarta Sans', category: 'sans-serif', stack: "'Plus Jakarta Sans Variable', 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif", ...fontsource('plus-jakarta-sans') },
  { family: 'DM Sans Variable', name: 'DM Sans', category: 'sans-serif', stack: "'DM Sans Variable', 'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif", ...fontsource('dm-sans') },
  { family: 'Space Grotesk Variable', name: 'Space Grotesk', category: 'sans-serif', stack: "'Space Grotesk Variable', 'Space Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif", ...fontsource('space-grotesk') },
  { family: 'Playfair Display Variable', name: 'Playfair Display', category: 'serif', stack: "'Playfair Display Variable', 'Playfair Display', Georgia, 'Times New Roman', serif", ...fontsource('playfair-display') },
  { family: 'Lora Variable', name: 'Lora', category: 'serif', stack: "'Lora Variable', 'Lora', Georgia, 'Times New Roman', serif", ...fontsource('lora') }
];
