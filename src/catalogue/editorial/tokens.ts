import type { TokenDef } from '@shared/types';

const display = { token: 'font.display' };
const body = { token: 'font.body' };

/**
 * Editorial's tokens: the same IDs as Foundation's, so a site moves between the two themes with every token choice
 * it made still meaning the same thing. Ink on paper with one signal red, a high-contrast display serif over a
 * grotesk, square corners, hairline rules and no drop shadows.
 */
export const EDITORIAL_TOKENS: TokenDef[] = [
  // Colors
  { id: 'color.background', label: 'Background', group: 'color', value: '#f8f7f3' },
  { id: 'color.surface', label: 'Cards and panels', group: 'color', value: '#ffffff' },
  { id: 'color.surface-alt', label: 'Alternate background', group: 'color', value: '#eeebe4' },
  { id: 'color.text', label: 'Primary text', group: 'color', value: '#111111' },
  { id: 'color.muted', label: 'Muted text', group: 'color', value: '#4f4d48' },
  { id: 'color.brand', label: 'Brand', group: 'color', value: '#b52a1c' },
  { id: 'color.brand-strong', label: 'Brand (strong)', group: 'color', value: '#8a1f14' },
  { id: 'color.on-brand', label: 'Text on brand color', group: 'color', value: '#ffffff' },
  { id: 'color.accent', label: 'Accent', group: 'color', value: '#ff8a6b' },
  { id: 'color.inverse', label: 'Dark sections', group: 'color', value: '#111111' },
  { id: 'color.on-inverse', label: 'Text on dark sections', group: 'color', value: '#f4f1ea' },
  { id: 'color.border', label: 'Border', group: 'color', value: '#c9c4b9' },
  { id: 'color.focus', label: 'Keyboard focus outline', group: 'color', value: '#1f5bd8' },

  // Font families
  { id: 'font.body', label: 'Body font', group: 'font', value: "'Space Grotesk Variable', 'Space Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { id: 'font.display', label: 'Display font', group: 'font', value: "'Playfair Display Variable', 'Playfair Display', Georgia, 'Times New Roman', serif" },

  // Text styles
  { id: 'text.display', label: 'Display', group: 'text', value: { family: display, size: 'clamp(2.75rem, 1.2rem + 5.6vw, 6rem)', lineHeight: '1', weight: 500, tracking: '-0.02em' } },
  { id: 'text.h1', label: 'Heading 1', group: 'text', value: { family: display, size: 'clamp(2.35rem, 1.4rem + 3.4vw, 4.25rem)', lineHeight: '1.04', weight: 500, tracking: '-0.018em' } },
  { id: 'text.h2', label: 'Heading 2', group: 'text', value: { family: display, size: 'clamp(1.9rem, 1.3rem + 2.1vw, 3rem)', lineHeight: '1.08', weight: 500, tracking: '-0.012em' } },
  { id: 'text.h3', label: 'Heading 3', group: 'text', value: { family: body, size: '1.2rem', lineHeight: '1.3', weight: 600, tracking: '-0.01em' } },
  { id: 'text.lead', label: 'Lead', group: 'text', value: { family: body, size: 'clamp(1.1rem, 1rem + 0.4vw, 1.3rem)', lineHeight: '1.55', weight: 400, tracking: '-0.005em' } },
  { id: 'text.body', label: 'Body', group: 'text', value: { family: body, size: '1.02rem', lineHeight: '1.65', weight: 400, tracking: '0em' } },
  { id: 'text.small', label: 'Small', group: 'text', value: { family: body, size: '0.875rem', lineHeight: '1.5', weight: 400, tracking: '0.005em' } },
  { id: 'text.eyebrow', label: 'Eyebrow', group: 'text', value: { family: body, size: '0.75rem', lineHeight: '1.4', weight: 600, tracking: '0.16em', transform: 'uppercase' } },
  { id: 'text.stat', label: 'Statistic', group: 'text', value: { family: display, size: 'clamp(2.75rem, 1.9rem + 3vw, 4.5rem)', lineHeight: '1', weight: 400, tracking: '-0.03em' } },

  // Spacing
  { id: 'space.2xs', label: '2XS', group: 'space', value: '4px' },
  { id: 'space.xs', label: 'XS', group: 'space', value: '8px' },
  { id: 'space.sm', label: 'Small', group: 'space', value: '12px' },
  { id: 'space.md', label: 'Medium', group: 'space', value: '16px' },
  { id: 'space.lg', label: 'Large', group: 'space', value: '24px' },
  { id: 'space.xl', label: 'XL', group: 'space', value: '32px' },
  { id: 'space.2xl', label: '2XL', group: 'space', value: '48px' },
  { id: 'space.3xl', label: '3XL', group: 'space', value: '80px' },
  { id: 'space.section', label: 'Section', group: 'space', value: 'clamp(4rem, 2.6rem + 5.6vw, 8rem)' },

  // Containers
  { id: 'container.reading', label: 'Reading width', group: 'container', value: '680px' },
  { id: 'container.content', label: 'Content width', group: 'container', value: '1240px' },
  { id: 'container.gutter', label: 'Page gutter', group: 'container', value: 'clamp(1.25rem, 0.7rem + 2.8vw, 3rem)' },

  // Radii: square corners, with the larger steps only taking the edge off.
  { id: 'radius.sm', label: 'Small', group: 'radius', value: '0px' },
  { id: 'radius.md', label: 'Medium', group: 'radius', value: '0px' },
  { id: 'radius.lg', label: 'Large', group: 'radius', value: '2px' },
  { id: 'radius.pill', label: 'Pill', group: 'radius', value: '2px' },

  // Borders and shadows: hairline rules, and no drop shadows.
  { id: 'border.default', label: 'Standard border', group: 'border', value: '1px solid var(--so-color-border)' },
  { id: 'border.strong', label: 'Strong border', group: 'border', value: '1px solid var(--so-color-text)' },
  { id: 'shadow.sm', label: 'Small', group: 'shadow', value: 'none' },
  { id: 'shadow.md', label: 'Medium', group: 'shadow', value: 'none' },
  { id: 'shadow.lg', label: 'Large', group: 'shadow', value: 'none' }
];
