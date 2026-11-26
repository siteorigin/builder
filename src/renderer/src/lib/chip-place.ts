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
 * after what the strip already shows on its left (`taken`: a collection layout's entry picker and Done), when there is
 * room beside it.
 */
export function chipLeft(selectionLeft: number, chipWidth: number, frameWidth: number, taken = 0): number {
  const within = Math.max(0, Math.min(selectionLeft, frameWidth - chipWidth));
  // With too little room beside what is there, the chip still starts after it, and narrows (see chipRoom) rather
  // than covering the entry picker or Done; only a strip with no room left at all is shared.
  return taken > 0 && taken + CHIP_MIN <= frameWidth ? Math.max(taken, within) : within;
}

/** The narrowest a parked chip is drawn beside something else in the strip: its grip, name and More actions. */
export const CHIP_MIN = 96;

/** How wide a chip starting at `left` may be, so it ends at the frame's right edge. */
export const chipRoom = (left: number, frameWidth: number) => Math.max(CHIP_MIN, frameWidth - left);
