/**
 * Reading where the selection's outline is on screen against where its element is, from frames of the editor's window
 * as Chromium composited them (CDP screencast): the `outlineScroll` scenario's measure of how far the outline trails a
 * page that scrolls under it (#1307). Pure functions of decoded pixels, so they are tested without a browser.
 *
 * The element's edge is found from markers the scenario puts in the page itself, so they scroll exactly as the page
 * does: solid blocks of MARKER colour, each starting a known distance below the element's bottom edge. The outline is
 * found by its keylines (Canvas.css `.ov-selected`): from its bottom edge upward, ink, the selection colour, white,
 * crisp or blended between pixels (an outline drawn in the page moves by fractions of a pixel with it). An
 * overlay drawn over a marker (an outline passing over it, a hover's hairline or name) can only hide its first rows,
 * never add earlier ones, so the earliest edge any marker gives is the element's.
 */

export type Rgb = readonly [number, number, number];
/** The outline's keylines: ink outside, the selection colour (`--select`, tokens.css), white inside. */
export const OUTLINE_INK: Rgb = [16, 24, 40];
export const OUTLINE_SELECT: Rgb = [23, 102, 192];
export const OUTLINE_WHITE: Rgb = [255, 255, 255];
/** The markers' colour: one no page of the fixture or overlay of the editor uses. */
export const MARKER: Rgb = [255, 0, 255];
/** An outline this far from its element or less sits on it (device-pixel snapping, the marker's own rounding). */
export const ATTACHED_PX = 1.5;
/** How far from the element's edge an outline is looked for (CSS px): eight frames of the scenario's scroll. */
export const OUTLINE_REACH = 100;
/** A marker moved by less than this between two frames has not moved. */
const MOVED_PX = 0.5;

/** A decoded frame: rows of `channels` bytes per pixel (3 or 4). */
export interface Pixels {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

const at = (img: Pixels, x: number, y: number): Rgb => {
  const i = (y * img.width + x) * img.channels;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
/** At least half the marker's colour over a light page: green held down, red and blue up. */
const isMarker = (p: Rgb) => p[1] < 128 && p[0] > 180 && p[2] > 180;

/** How close a pixel must be to the selection colour to be the middle of its keyline, and how far its blend with a
 *  neighbour still counts towards where that keyline is. */
const CORE_TOLERANCE = 45;
const BLEND_REACH = 110;
const lum = (p: Rgb) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
const SELECT_LUM = lum(OUTLINE_SELECT);

/**
 * The bottom edges (device pixels from the frame's top, fractional) of every selection outline crossing column `x`
 * between rows `y0` and `y1`. The keylines are 1, 2 and 1 CSS pixels of the editor (ink outside, the selection colour,
 * white inside): drawn by the editor they fall on whole device pixels, drawn in a page that sits between pixels as it
 * scrolls they are blended into their neighbours. So the selection colour's keyline is found by its middle (a run of
 * rows near the colour, no taller than the keyline and a pixel of blend), placed by the centre of everything in and
 * beside it that is partly that colour, and taken for a bottom edge when what is below it is dark (the ink) and what is
 * above it is lighter (the white): the edge is a keyline and a half of ink below its centre. A hover's hairline (white
 * and a dark blue of its own) and the outline's top edge (ink above, white below) are neither.
 */
export function outlineBottoms(img: Pixels, x: number, y0: number, y1: number, dpr: number): number[] {
  const k = Math.max(1, Math.round(dpr));
  const from = Math.max(0, Math.floor(y0));
  const to = Math.min(img.height, Math.ceil(y1));
  const out: number[] = [];
  const dist = (y: number) => Math.hypot(...at(img, x, y).map((v, i) => v - OUTLINE_SELECT[i]));
  for (let y = from; y < to; y++) {
    if (dist(y) >= CORE_TOLERANCE) continue;
    let end = y;
    while (end + 1 < to && dist(end + 1) < CORE_TOLERANCE) end++;
    const a = y;
    const b = end;
    y = end;
    if (b - a + 1 > 2 * k + 1 || a - k - 1 < 0 || b + k + 1 >= img.height) continue;
    let weight = 0;
    let sum = 0;
    for (let r = a - k; r <= b + k; r++) {
      const w = Math.max(0, 1 - dist(r) / BLEND_REACH);
      weight += w;
      sum += w * (r + 0.5);
    }
    let above = 0;
    for (let r = a - k; r < a; r++) above = Math.max(above, lum(at(img, x, r)));
    let below = 255;
    for (let r = b + 1; r <= b + k; r++) below = Math.min(below, lum(at(img, x, r)));
    if (below < SELECT_LUM && below < above - 40) out.push(sum / weight + 2 * k);
  }
  return out;
}

/** The first row of marker colour in column `x` between rows `y0` and `y1`, or null when there is none. */
export function markerTop(img: Pixels, x: number, y0: number, y1: number): number | null {
  const to = Math.min(img.height, Math.ceil(y1));
  for (let y = Math.max(0, Math.floor(y0)); y < to; y++) if (isMarker(at(img, x, y))) return y;
  return null;
}

/** Where to read a frame, in the editor's CSS pixels (the frame's coordinates over the window). */
export interface ReadingGeometry {
  /** The editor's device pixels per CSS pixel. */
  dpr: number;
  /** The column the outline is read in. */
  outlineX: number;
  /** Each marker's column, and how far below the element's edge it starts, both in the editor's CSS pixels. */
  markers: Array<{ x: number; below: number }>;
  /** The rows of the window the preview frame shows (its top and bottom). */
  top: number;
  bottom: number;
}

/** One frame read: when it was drawn (ms), the element's bottom edge, and every outline's bottom edge (CSS px). */
export interface FrameReading {
  t: number;
  element: number | null;
  outlines: number[];
}

export function readFrame(img: Pixels, geo: ReadingGeometry, t: number): FrameReading {
  const d = geo.dpr;
  const y0 = geo.top * d;
  const y1 = geo.bottom * d;
  // An overlay over a marker only hides its first rows: the earliest edge any of them gives is the element's.
  const edges = geo.markers.flatMap((m) => {
    const top = markerTop(img, Math.round(m.x * d), y0, y1);
    return top === null ? [] : [top / d - m.below];
  });
  const element = edges.length ? Math.min(...edges) : null;
  // Only outlines near the element's edge: a run of the selection colour elsewhere in the column is not its outline.
  const outlines = outlineBottoms(img, Math.round(geo.outlineX * d), y0, y1, d)
    .map((y) => y / d)
    .filter((o) => element === null || Math.abs(o - element) <= OUTLINE_REACH);
  return { t, element, outlines };
}

export interface OffsetSummary {
  /** Frames read in the window, and those in which the element had moved since the frame before. */
  frames: number;
  moving: number;
  /** Median over the moving frames of how far the outline was from its element (CSS px of the editor). */
  offsetPx: number;
  /** Median over the moving frames of how many frames behind the element the outline was: how long before, in frame
   *  periods, the element was where the outline is drawn. */
  lagFrames: number;
  /** Frames (moving or catching up) with the outline off its element. */
  trailing: number;
  /** Median of how far the element moved per frame period while moving (CSS px): the scroll's speed. */
  speedPx: number;
  /** The outline's distance from its element in the first frame (at rest, before the scroll) and the last (once it
   *  has stopped and everything has caught up). */
  restBefore: number;
  restAfter: number;
  /** Frames without the element's marker or without any outline: each a frame the reading could not be made in. */
  unread: number;
}

/** The outline in a frame furthest from its element (two drawn at once: the one trailing is the one seen trailing). */
function offsetIn(r: FrameReading): number | null {
  if (r.element === null || !r.outlines.length) return null;
  return r.outlines.reduce((worst, o) => (Math.abs(o - r.element!) > Math.abs(worst) ? o - r.element! : worst), r.outlines[0] - r.element);
}

/**
 * How long before frame `i` the element was where the outline is drawn in it, in frame periods: found on the element's
 * path through the frames before, within the run in which it moved one way. Zero when the outline is on it; null when
 * the element was never there in that run (an outline ahead of it).
 */
function lagOf(readings: FrameReading[], i: number, periodMs: number): number | null {
  const r = readings[i];
  const off = offsetIn(r);
  if (off === null || i < 1 || readings[i - 1].element === null) return null;
  if (Math.abs(off) <= ATTACHED_PX) return 0;
  const target = r.element! + off;
  const dir = Math.sign(r.element! - readings[i - 1].element!);
  if (!dir) return null;
  for (let j = i; j > 0; j--) {
    const a = readings[j - 1].element;
    const b = readings[j].element;
    if (a === null || b === null) return null;
    const step = Math.sign(b - a);
    // Where the element turned back, the run ends: the outline is not from before it.
    if (step === -dir) return null;
    if (step && (target - a) * (target - b) <= 0) {
      const t = readings[j - 1].t + ((target - a) / (b - a)) * (readings[j].t - readings[j - 1].t);
      return (r.t - t) / periodMs;
    }
  }
  return null;
}

const median = (values: number[]) => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** The window's frames, in the order drawn, summed up: the first is at rest before the scroll, the last after it. */
export function summarizeOffsets(readings: FrameReading[], periodMs: number): OffsetSummary {
  const offsets = readings.map(offsetIn);
  const unread = offsets.filter((o) => o === null).length;
  const moving: number[] = [];
  const speeds: number[] = [];
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1].element;
    const b = readings[i].element;
    if (a === null || b === null || Math.abs(b - a) < MOVED_PX) continue;
    moving.push(i);
    speeds.push(Math.abs(b - a) / Math.max(1, Math.round((readings[i].t - readings[i - 1].t) / periodMs)));
  }
  const movingOffsets = moving.map((i) => offsets[i]).filter((o): o is number => o !== null);
  const lags = moving.map((i) => lagOf(readings, i, periodMs)).filter((l): l is number => l !== null);
  return {
    frames: readings.length,
    moving: moving.length,
    offsetPx: median(movingOffsets.map(Math.abs)),
    lagFrames: median(lags),
    trailing: offsets.slice(1).filter((o) => o !== null && Math.abs(o) > ATTACHED_PX).length,
    speedPx: median(speeds),
    restBefore: offsets[0] ?? NaN,
    restAfter: offsets[offsets.length - 1] ?? NaN,
    unread
  };
}
