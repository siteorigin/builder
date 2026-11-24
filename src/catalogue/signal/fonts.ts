/**
 * The web fonts Signal ships (see ../builtin-fonts): every font Foundation ships, so a site that chose one of them
 * keeps it when it switches to Signal, then Sora for headings and JetBrains Mono for eyebrow labels. DM Sans, one of
 * Foundation's, is Signal's text face.
 */
import type { PackFontSource } from '../pack';
import { builtinFont } from '../builtin-fonts';
import { FOUNDATION_FONTS } from '../foundation/fonts';

export const SIGNAL_FONTS: PackFontSource[] = [...FOUNDATION_FONTS, builtinFont('Sora'), builtinFont('JetBrains Mono')];
