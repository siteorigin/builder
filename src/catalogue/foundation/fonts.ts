/**
 * The web fonts Foundation ships (see ../builtin-fonts): Inter and Fraunces, its defaults, and the sans and serif
 * faces Site styles offers beside them.
 */
import type { PackFontSource } from '../pack';
import { builtinFont } from '../builtin-fonts';

export const FOUNDATION_FONTS: PackFontSource[] = ['Inter', 'Fraunces', 'Plus Jakarta Sans', 'DM Sans', 'Space Grotesk', 'Playfair Display', 'Lora'].map(builtinFont);
