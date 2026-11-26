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
 * and always starts after what the strip already shows on its left (`taken`: a collection layout's entry picker and
 * Done), narrowed to the room left there (see chipRoom), so it never covers them.
 */
export function chipLeft(selectionLeft: number, chipWidth: number, frameWidth: number, taken = 0): number {
  return Math.max(taken, Math.max(0, Math.min(selectionLeft, frameWidth - chipWidth)));
}

/** The narrowest a parked chip is drawn beside something else in the strip: its grip, name and More actions. */
export const CHIP_MIN = 96;

/**
 * How wide the chip may be: the frame's width, or beside a collection layout's strip, the room after it (never less
 * than CHIP_MIN). It does not depend on where the chip last sat, so a chip that was narrow is not kept narrow.
 */
export const chipRoom = (taken: number, frameWidth: number) => (taken > 0 ? Math.max(CHIP_MIN, frameWidth - taken) : frameWidth);
