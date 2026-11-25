/**
 * The web fonts Editorial ships: its display serif and grotesk first, then the rest of Foundation's, so a site that
 * chose any Foundation font keeps it when it moves to Editorial (and back). Only the fonts a site uses are built
 * into it.
 */
import type { PackFontSource } from '../pack';
import { FOUNDATION_FONTS } from '../foundation/fonts';

const FIRST = ['Playfair Display', 'Space Grotesk'];

export const EDITORIAL_FONTS: PackFontSource[] = [
  ...FIRST.map((name) => FOUNDATION_FONTS.find((f) => f.name === name)!),
  ...FOUNDATION_FONTS.filter((f) => !FIRST.includes(f.name))
];
