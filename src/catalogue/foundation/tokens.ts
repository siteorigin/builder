import type { TokenDef } from '@shared/types';

const display = { token: 'font.display' };
const body = { token: 'font.body' };

export const FOUNDATION_TOKENS: TokenDef[] = [
  // Colors
  { id: 'color.background', label: 'Background', group: 'color', value: '#fbfaf7' },
  { id: 'color.surface', label: 'Cards and panels', group: 'color', value: '#ffffff' },
  { id: 'color.surface-alt', label: 'Alternate background', group: 'color', value: '#f2efe8' },
  { id: 'color.text', label: 'Primary text', group: 'color', value: '#191a18' },
  { id: 'color.muted', label: 'Muted text', group: 'color', value: '#5c5f59' },
  { id: 'color.brand', label: 'Brand', group: 'color', value: '#1f5a4c' },
  { id: 'color.brand-strong', label: 'Brand (strong)', group: 'color', value: '#16443a' },
  { id: 'color.on-brand', label: 'Text on brand colour', group: 'color', value: '#ffffff' },
  { id: 'color.accent', label: 'Accent', group: 'color', value: '#d98f48' },
  { id: 'color.inverse', label: 'Dark sections', group: 'color', value: '#14211d' },
  { id: 'color.on-inverse', label: 'Text on dark sections', group: 'color', value: '#f1eee6' },
  { id: 'color.border', label: 'Border', group: 'color', value: '#e3dfd5' },
  { id: 'color.focus', label: 'Keyboard focus outline', group: 'color', value: '#2f6fed' },

  // Font families
  { id: 'font.body', label: 'Body font', group: 'font', value: "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { id: 'font.display', label: 'Display font', group: 'font', value: "'Fraunces Variable', 'Fraunces', Georgia, 'Times New Roman', serif" },

  // Text styles
  { id: 'text.display', label: 'Display', group: 'text', value: { family: display, size: 'clamp(2.6rem, 1.4rem + 4.4vw, 4.9rem)', lineHeight: '1.03', weight: 480, tracking: '-0.025em' } },
  { id: 'text.h1', label: 'Heading 1', group: 'text', value: { family: display, size: 'clamp(2.25rem, 1.5rem + 2.8vw, 3.6rem)', lineHeight: '1.08', weight: 480, tracking: '-0.02em' } },
  { id: 'text.h2', label: 'Heading 2', group: 'text', value: { family: display, size: 'clamp(1.85rem, 1.35rem + 1.7vw, 2.7rem)', lineHeight: '1.12', weight: 480, tracking: '-0.015em' } },
  { id: 'text.h3', label: 'Heading 3', group: 'text', value: { family: body, size: '1.2rem', lineHeight: '1.35', weight: 600, tracking: '-0.01em' } },
  { id: 'text.lead', label: 'Lead', group: 'text', value: { family: body, size: 'clamp(1.08rem, 1rem + 0.35vw, 1.25rem)', lineHeight: '1.6', weight: 400, tracking: '-0.005em' } },
  { id: 'text.body', label: 'Body', group: 'text', value: { family: body, size: '1rem', lineHeight: '1.65', weight: 400, tracking: '0em' } },
  { id: 'text.small', label: 'Small', group: 'text', value: { family: body, size: '0.875rem', lineHeight: '1.5', weight: 400, tracking: '0em' } },
  { id: 'text.eyebrow', label: 'Eyebrow', group: 'text', value: { family: body, size: '0.78rem', lineHeight: '1.4', weight: 600, tracking: '0.12em', transform: 'uppercase' } },
  { id: 'text.stat', label: 'Statistic', group: 'text', value: { family: display, size: 'clamp(2.4rem, 1.8rem + 2vw, 3.4rem)', lineHeight: '1', weight: 460, tracking: '-0.03em' } },

  // Spacing
  { id: 'space.2xs', label: '2XS', group: 'space', value: '4px' },
  { id: 'space.xs', label: 'XS', group: 'space', value: '8px' },
  { id: 'space.sm', label: 'Small', group: 'space', value: '12px' },
  { id: 'space.md', label: 'Medium', group: 'space', value: '16px' },
  { id: 'space.lg', label: 'Large', group: 'space', value: '24px' },
  { id: 'space.xl', label: 'XL', group: 'space', value: '32px' },
  { id: 'space.2xl', label: '2XL', group: 'space', value: '48px' },
  { id: 'space.3xl', label: '3XL', group: 'space', value: '72px' },
  { id: 'space.section', label: 'Section', group: 'space', value: 'clamp(4rem, 2.8rem + 5vw, 7.5rem)' },

  // Containers
  { id: 'container.reading', label: 'Reading width', group: 'container', value: '720px' },
  { id: 'container.content', label: 'Content width', group: 'container', value: '1200px' },
  { id: 'container.gutter', label: 'Page gutter', group: 'container', value: 'clamp(1.25rem, 0.8rem + 2.4vw, 2.5rem)' },

  // Radii
  { id: 'radius.sm', label: 'Small', group: 'radius', value: '6px' },
  { id: 'radius.md', label: 'Medium', group: 'radius', value: '12px' },
  { id: 'radius.lg', label: 'Large', group: 'radius', value: '22px' },
  { id: 'radius.pill', label: 'Pill', group: 'radius', value: '999px' },

  // Borders and shadows
  { id: 'border.default', label: 'Standard border', group: 'border', value: '1px solid var(--so-color-border)' },
  { id: 'border.strong', label: 'Strong border', group: 'border', value: '1px solid var(--so-color-text)' },
  { id: 'shadow.sm', label: 'Small', group: 'shadow', value: '0 1px 2px rgb(20 24 22 / 0.06), 0 1px 1px rgb(20 24 22 / 0.04)' },
  { id: 'shadow.md', label: 'Medium', group: 'shadow', value: '0 10px 30px -12px rgb(20 24 22 / 0.18), 0 2px 6px rgb(20 24 22 / 0.05)' },
  { id: 'shadow.lg', label: 'Large', group: 'shadow', value: '0 30px 60px -20px rgb(20 24 22 / 0.28), 0 8px 20px -8px rgb(20 24 22 / 0.12)' }
];
