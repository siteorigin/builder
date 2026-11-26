/**
 * Where the canvas's selection chip (the toolbar of the selection's name and actions) is drawn. Pure, for the canvas
 * to drive and the tests to check.
 */

/** The chip's height, in screen pixels. */
export const CHIP_H = 28;
/** Room between the chip and the edge it sits by, in screen pixels. */
export const CHIP_GAP = 4;

export type ChipPlacement = 'inside' | 'strip';

/**
 * Where the chip goes. It never covers what is around the selection, nor what the selection itself shows (#905). A
 * tall top-level box (a section) carries it inside its top edge only when the room its own border and padding leave
 * there (`roomInside`, in the same zoomed pixels as the box; null while the page has not measured it) holds the whole
 * chip, and its top is on screen. Everything else (a button among others in a column, a part of a component, text
 * being typed, a box with no padding to spare, or one scrolled past the top or bottom of the page) parks the chip in
 * the strip above the page frame, lined up with the selection. `frameHeight` is the visible page's height.
 */
export function chipPlacement(box: { top: number; height: number }, topLevel: boolean, frameHeight: number, roomInside: number | null): ChipPlacement {
  if (!topLevel || roomInside === null) return 'strip';
  const needs = CHIP_GAP + 2 + CHIP_H + 2;
  return box.top >= 0 && box.height > 120 && roomInside >= needs && box.top + needs <= frameHeight ? 'inside' : 'strip';
}
