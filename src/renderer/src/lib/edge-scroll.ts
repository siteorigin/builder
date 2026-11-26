/**
 * Scrolling the canvas while a drag is held near its top or bottom edge (#904). Pure, for the canvas's drags to drive:
 * how fast the page should scroll for a pointer at a point of the visible canvas.
 */

/** How deep the band along the top and bottom edge is that scrolls, in screen pixels. */
export const EDGE_BAND = 56;
/** The fastest it scrolls, at the very edge, in screen pixels a second. */
export const EDGE_MAX_SPEED = 1400;
/** The slowest it scrolls, just inside the band, so the first step is seen to move. */
const EDGE_MIN_SPEED = 120;

export interface EdgeView {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The scroll speed for a pointer at (x, y) over `view` (the part of the canvas the page shows in, in screen pixels):
 * negative within the band along its top (up), positive within the band along its bottom (down), and 0 anywhere else,
 * off the view included. It quickens toward the edge. A view too short for two bands splits its height between them.
 */
export function edgeSpeed(x: number, y: number, view: EdgeView, band = EDGE_BAND): number {
  if (![x, y, view.left, view.top, view.right, view.bottom].every(Number.isFinite)) return 0;
  if (x < view.left || x > view.right || y < view.top || y > view.bottom) return 0;
  const depth = Math.min(band, (view.bottom - view.top) / 2);
  if (depth <= 0) return 0;
  const toTop = y - view.top;
  const toBottom = view.bottom - y;
  const reach = toTop < depth && toTop <= toBottom ? toTop : toBottom < depth ? toBottom : null;
  if (reach === null) return 0;
  const near = 1 - reach / depth;
  const speed = EDGE_MIN_SPEED + (EDGE_MAX_SPEED - EDGE_MIN_SPEED) * near * near;
  return reach === toTop ? -speed : speed;
}
