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

/** A box on the frame, in screen pixels from its top left corner. */
export interface DrawnBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the drop line for a gap is drawn (see the canvas's dropBox): centred on the gap `b`, 2px of colour between its
 * keylines, starting at the centre of its ring 7px in. `clip` is the part of the frame the canvas shows, in the same
 * pixels: the line stays at least 6px inside it (8px from its far side), so its keylines and ring are never clipped and
 * a gap past the edge the canvas shows is drawn pinned to that edge rather than out of sight (#904); its length is cut
 * to what shows.
 */
export function dropLineBox(b: DrawnBox, clip: EdgeView, snap: (v: number) => number = (v) => v): DrawnBox & { vertical: boolean } {
  const vertical = b.height > b.width;
  const within = (v: number, lo: number, hi: number) => Math.max(lo + 6, Math.min(v, hi - 8));
  const span = (start: number, length: number, lo: number, hi: number) => {
    // As far in from each side as a gap on the frame's own edge starts and ends.
    const from = Math.max(start, lo + 7);
    const to = Math.min(start + length, hi - 2);
    if (to - from >= 4) return { start: from, length: to - from };
    // None of its length shows (a gap beside a narrow item off to the side): a short stretch of it at the edge it is
    // past, so the place still shows.
    const short = Math.max(4, Math.min(length, 24, hi - lo - 9));
    return { start: start >= hi - 2 ? hi - 2 - short : lo + 7, length: short };
  };
  if (vertical) {
    const s = span(b.top + 7, Math.max(4, b.height - 9), clip.top, clip.bottom);
    return { left: snap(within(b.left + b.width / 2 - 1, clip.left, clip.right)), top: s.start, width: 2, height: s.length, vertical };
  }
  const s = span(b.left + 7, Math.max(4, b.width - 9), clip.left, clip.right);
  return { left: s.start, top: snap(within(b.top + b.height / 2 - 1, clip.top, clip.bottom)), width: s.length, height: 2, vertical };
}
