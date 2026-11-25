import type { ContrastPair } from '@shared/contrast';
import { FOUNDATION_CONTRAST_PAIRS } from '../foundation/contrast';

/**
 * The colours Editorial's stylesheet and components set against each other. Editorial keeps Foundation's pairings
 * (base.css.ts only changes shapes, rules and type): button text on Brand, Brand (strong) on hover, the light and
 * dark-section buttons reversed, Brand-coloured links and the numbered index on the three light grounds, text and
 * muted text on the same, the focus outline, and the accent on Dark sections. Open index entries (features) sit
 * straight on their section, so they take its colours rather than adding grounds of their own.
 */
export const EDITORIAL_CONTRAST_PAIRS: ContrastPair[] = FOUNDATION_CONTRAST_PAIRS.map((p) => ({ ...p }));
