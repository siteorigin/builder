/**
 * Signal's site styles. The IDs are Foundation's, one for one, so a site's own choices (an element's colour, a text
 * style it picked) keep meaning the same thing whichever of the two themes it switches to; only the values differ.
 * A cool near-white page, soft indigo-tinted panels with a hairline edge, an electric indigo brand with a signal-orange
 * accent, geometric headings in Sora, DM Sans for reading, JetBrains Mono for eyebrow labels, generous corners, and a
 * tighter product rhythm: a narrower content column and less air between sections than Foundation's brochure pace.
 */
import type { TokenDef } from '@shared/types';
import { builtinFontStack } from '../builtin-fonts';

const display = { token: 'font.display' };
const body = { token: 'font.body' };

export const SIGNAL_TOKENS: TokenDef[] = [
  // Colors
  { id: 'color.background', label: 'Background', group: 'color', value: '#f6f7fb' },
  { id: 'color.surface', label: 'Cards and panels', group: 'color', value: '#ffffff' },
  { id: 'color.surface-alt', label: 'Alternate background', group: 'color', value: '#e6e9f8' },
  { id: 'color.text', label: 'Primary text', group: 'color', value: '#0e1124' },
  { id: 'color.muted', label: 'Muted text', group: 'color', value: '#4f566b' },
  { id: 'color.brand', label: 'Brand', group: 'color', value: '#4636e0' },
  { id: 'color.brand-strong', label: 'Brand (strong)', group: 'color', value: '#3024a8' },
  { id: 'color.on-brand', label: 'Text on brand color', group: 'color', value: '#ffffff' },
  { id: 'color.accent', label: 'Accent', group: 'color', value: '#ff7a45' },
  { id: 'color.inverse', label: 'Dark sections', group: 'color', value: '#0e1124' },
  { id: 'color.on-inverse', label: 'Text on dark sections', group: 'color', value: '#eef0f8' },
  { id: 'color.border', label: 'Border', group: 'color', value: '#d3d8e9' },
  { id: 'color.focus', label: 'Keyboard focus outline', group: 'color', value: '#2f5bea' },
  { id: 'color.error', label: 'Errors', group: 'color', value: '#b3261e' },
  { id: 'color.error-on-inverse', label: 'Errors on dark sections', group: 'color', value: '#ff8a80' },

  // Font families
  { id: 'font.body', label: 'Body font', group: 'font', value: builtinFontStack('DM Sans') },
  { id: 'font.display', label: 'Display font', group: 'font', value: builtinFontStack('Sora') },

  // Text styles: tight geometric headings, and the mono eyebrow that labels every section.
  { id: 'text.display', label: 'Display', group: 'text', value: { family: display, size: 'clamp(2.6rem, 1.3rem + 4.6vw, 5rem)', lineHeight: '1.04', weight: 600, tracking: '-0.035em' } },
  { id: 'text.h1', label: 'Heading 1', group: 'text', value: { family: display, size: 'clamp(2.2rem, 1.45rem + 2.9vw, 3.5rem)', lineHeight: '1.08', weight: 600, tracking: '-0.03em' } },
  { id: 'text.h2', label: 'Heading 2', group: 'text', value: { family: display, size: 'clamp(1.8rem, 1.3rem + 1.75vw, 2.6rem)', lineHeight: '1.12', weight: 600, tracking: '-0.025em' } },
  { id: 'text.h3', label: 'Heading 3', group: 'text', value: { family: display, size: '1.15rem', lineHeight: '1.35', weight: 600, tracking: '-0.015em' } },
  { id: 'text.lead', label: 'Lead', group: 'text', value: { family: body, size: 'clamp(1.08rem, 1rem + 0.35vw, 1.22rem)', lineHeight: '1.6', weight: 400, tracking: '-0.005em' } },
  { id: 'text.body', label: 'Body', group: 'text', value: { family: body, size: '1rem', lineHeight: '1.65', weight: 400, tracking: '0em' } },
  { id: 'text.small', label: 'Small', group: 'text', value: { family: body, size: '0.875rem', lineHeight: '1.5', weight: 400, tracking: '0em' } },
  { id: 'text.eyebrow', label: 'Eyebrow', group: 'text', value: { family: builtinFontStack('JetBrains Mono'), size: '0.75rem', lineHeight: '1.4', weight: 500, tracking: '0.08em', transform: 'uppercase' } },
  { id: 'text.stat', label: 'Statistic', group: 'text', value: { family: display, size: 'clamp(2.4rem, 1.8rem + 2vw, 3.4rem)', lineHeight: '1', weight: 600, tracking: '-0.045em' } },

  // Spacing
  { id: 'space.2xs', label: '2XS', group: 'space', value: '4px' },
  { id: 'space.xs', label: 'XS', group: 'space', value: '8px' },
  { id: 'space.sm', label: 'Small', group: 'space', value: '12px' },
  { id: 'space.md', label: 'Medium', group: 'space', value: '16px' },
  { id: 'space.lg', label: 'Large', group: 'space', value: '24px' },
  { id: 'space.xl', label: 'XL', group: 'space', value: '32px' },
  { id: 'space.2xl', label: '2XL', group: 'space', value: '44px' },
  { id: 'space.3xl', label: '3XL', group: 'space', value: '64px' },
  { id: 'space.section', label: 'Section', group: 'space', value: 'clamp(3.75rem, 2.4rem + 5vw, 6.75rem)' },

  // Containers
  { id: 'container.reading', label: 'Reading width', group: 'container', value: '680px' },
  { id: 'container.content', label: 'Content width', group: 'container', value: '1160px' },
  { id: 'container.gutter', label: 'Page gutter', group: 'container', value: 'clamp(1.25rem, 0.8rem + 2.4vw, 2.5rem)' },

  // Radii: generous, so cards and panels read as soft tiles.
  { id: 'radius.sm', label: 'Small', group: 'radius', value: '10px' },
  { id: 'radius.md', label: 'Medium', group: 'radius', value: '18px' },
  { id: 'radius.lg', label: 'Large', group: 'radius', value: '28px' },
  { id: 'radius.pill', label: 'Pill', group: 'radius', value: '999px' },

  // Borders and shadows: hairlines tinted toward the brand, and soft indigo-tinted elevation.
  { id: 'border.default', label: 'Standard border', group: 'border', value: '1px solid var(--so-color-border)' },
  { id: 'border.strong', label: 'Strong border', group: 'border', value: '1px solid var(--so-color-text)' },
  { id: 'shadow.sm', label: 'Small', group: 'shadow', value: '0 1px 2px rgb(14 17 36 / 0.05), 0 1px 3px rgb(14 17 36 / 0.04)' },
  { id: 'shadow.md', label: 'Medium', group: 'shadow', value: '0 14px 34px -14px rgb(46 42 143 / 0.24), 0 4px 10px -4px rgb(14 17 36 / 0.06)' },
  { id: 'shadow.lg', label: 'Large', group: 'shadow', value: '0 32px 64px -24px rgb(46 42 143 / 0.32), 0 12px 24px -12px rgb(14 17 36 / 0.10)' }
];
