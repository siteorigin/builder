import type { ContrastPair } from '@shared/contrast';
import { FOUNDATION_CONTRAST_PAIRS } from '../foundation/contrast';

/**
 * The colours Signal sets against each other. Its buttons, links, check marks, focus outline and dark and brand
 * grounds are drawn by the same rules as Foundation's (Signal's stylesheet adds movement and elevation, not new
 * colour pairings), and its cards sit on the same three light grounds, so the pairs are Foundation's: Text on brand
 * on Brand, brand links and text on the page, cards and alternate sections, and the dark-section pairs, at rest and
 * on hover.
 */
export const SIGNAL_CONTRAST_PAIRS: ContrastPair[] = FOUNDATION_CONTRAST_PAIRS.map((p) => ({ ...p }));
