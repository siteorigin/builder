import type { ContrastPair } from '@shared/contrast';
import { FOUNDATION_CONTRAST_PAIRS } from '../foundation/contrast';

/**
 * The colours Signal sets against each other. Its buttons, links, check marks, focus outline and dark and brand
 * grounds are drawn by the same rules as Foundation's (Signal's stylesheet adds movement and elevation, not new
 * colour pairings), and its cards sit on the same three light grounds, so it has Foundation's pairs: Text on brand
 * on Brand, brand links and text on the page, cards and alternate sections, and the dark-section pairs, at rest and
 * on hover. Its own: the eyebrow pill (see ./components), whose ground is its own colour at 8% over the section, on
 * the page and on soft sections in the brand colour, and on dark sections in the accent.
 */
const pill = (fg: string, ground: string) => ({ mix: [fg, 8, ground] as [string, number, string] });

export const SIGNAL_CONTRAST_PAIRS: ContrastPair[] = [
  ...FOUNDATION_CONTRAST_PAIRS.map((p) => ({ ...p })),
  { id: 'eyebrow-background', use: 'Eyebrow labels on the page', fg: 'color.brand', bg: pill('color.brand', 'color.background'), state: 'rest', group: 'brand-text', fixable: false },
  { id: 'eyebrow-surface-alt', use: 'Eyebrow labels on alternate sections', fg: 'color.brand', bg: pill('color.brand', 'color.surface-alt'), state: 'rest', group: 'brand-text', fixable: false },
  { id: 'eyebrow-dark', use: 'Eyebrow labels in dark sections', fg: 'color.accent', bg: pill('color.accent', 'color.inverse'), state: 'rest', group: 'dark-accent', fixable: false }
];
