/**
 * Where the canvas's selection chip (the toolbar of the selection's name and actions) is drawn. Pure, for the canvas
 * to drive and the tests to check.
 */

/** The chip's height, in screen pixels. */
export const CHIP_H = 28;

/**
 * Where the chip starts along the strip above the page frame, in screen pixels from the frame's left. The chip is
 * always parked in that strip, never on the page, so it covers neither what is around the selection (the Button just
 * above a second one) nor what the selection shows (#905). It lines up with the selection and stays inside the frame,
 * which it may be as wide as: the strip is the chip's alone, since a collection layout's band has a row of its own
 * above it (Canvas.tsx, TEMPLATE_BAND_ROOM).
 */
export function chipLeft(selectionLeft: number, chipWidth: number, frameWidth: number): number {
  return Math.max(0, Math.min(selectionLeft, frameWidth - chipWidth));
}
