import type { ContrastPair } from '@shared/contrast';
import { FOUNDATION_CONTRAST_PAIRS } from '../foundation/contrast';

/**
 * The colours Editorial's stylesheet and components set against each other. Editorial keeps Foundation's pairings
 * (base.css.ts only changes shapes, rules and type): button text on Brand, Brand (strong) on hover, the light and
 * dark-section buttons reversed, Brand-coloured links and the numbered index on the three light grounds, text and
 * muted text on the same, the focus outline, and the accent on Dark sections. Open index entries (features) sit
 * straight on their section, so they take its colours rather than adding grounds of their own; on a Dark section their
 * descriptions are Text on dark sections at 78% opacity, which is a pair of its own, as are the footer's group labels (its text at 70%, dark footer and light), and the
 * form fields' outlines (its text at 55%, a control's edge, so 3:1).
 */
export const EDITORIAL_CONTRAST_PAIRS: ContrastPair[] = [
  ...FOUNDATION_CONTRAST_PAIRS.map((p) => ({ ...p })),
  { id: 'dark-index-text', use: 'Index descriptions in dark sections', fg: 'color.on-inverse', bg: 'color.inverse', opacity: 0.78, state: 'rest', group: 'dark-text' },
  { id: 'footer-labels', use: 'Footer group labels', fg: 'color.on-inverse', bg: 'color.inverse', opacity: 0.7, state: 'rest', group: 'dark-text' },
  { id: 'field-edge', use: 'Form field outlines on the page', fg: 'color.text', bg: 'color.background', opacity: 0.55, state: 'rest', group: 'text', min: 3 },
  { id: 'field-edge-surface-alt', use: 'Form field outlines on alternate sections', fg: 'color.text', bg: 'color.surface-alt', opacity: 0.55, state: 'rest', group: 'text', min: 3 },
  { id: 'footer-labels-light', use: 'Footer group labels in a light footer', fg: 'color.text', bg: 'color.surface-alt', opacity: 0.7, state: 'rest', group: 'text' }
];
