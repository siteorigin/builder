/**
 * The focal point of a cropped image: which part of the picture stays in view when `object-fit: cover` cuts it
 * to a box of another shape. It is stored as an `objectPosition` style value, either one of the keywords the
 * style list offers or "X% Y%" across and down the picture, and reaches the exported site as `object-position`.
 */

export interface FocalPoint {
  /** Percent across the picture, 0 at the left edge. */
  x: number;
  /** Percent down the picture, 0 at the top edge. */
  y: number;
}

export const FOCUS_CENTER: FocalPoint = { x: 50, y: 50 };

const KEYWORDS: Record<string, FocalPoint> = {
  center: { x: 50, y: 50 },
  top: { x: 50, y: 0 },
  bottom: { x: 50, y: 100 },
  left: { x: 0, y: 50 },
  right: { x: 100, y: 50 }
};

/** Two percentages, whole or with one decimal place, and nothing else. */
const POINT_RE = /^(\d{1,3}(?:\.\d)?)%\s+(\d{1,3}(?:\.\d)?)%$/;

const clampPct = (n: number) => Math.min(100, Math.max(0, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The point a stored value names, or null when it is not one this control writes or reads. */
export function parseFocus(value: unknown): FocalPoint | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s in KEYWORDS) return { ...KEYWORDS[s] };
  const m = POINT_RE.exec(s);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return x <= 100 && y <= 100 ? { x, y } : null;
}

/** Whether a literal is a focus value: a keyword or "X% Y%" with both between 0 and 100. */
export function isFocusValue(value: string): boolean {
  return parseFocus(value) !== null;
}

/** The value to store for a point, clamped to the picture and rounded to a tenth of a percent. */
export function formatFocus(p: FocalPoint): string {
  return `${round1(clampPct(p.x))}% ${round1(clampPct(p.y))}%`;
}

/** A point clamped to the picture and rounded the way it will be stored. */
export function normalizeFocus(p: FocalPoint): FocalPoint {
  return { x: round1(clampPct(p.x)), y: round1(clampPct(p.y)) };
}

/** Whether two points are the same once stored. */
export function sameFocus(a: FocalPoint, b: FocalPoint): boolean {
  return formatFocus(a) === formatFocus(b);
}

/** "16/9", "4 / 5" or "1.5" as width over height; null for auto or anything unreadable. */
export function parseRatio(value: unknown): number | null {
  if (typeof value === 'number') return value > 0 && Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(value);
  if (!m) return null;
  const r = Number(m[1]) / (m[2] === undefined ? 1 : Number(m[2]));
  return r > 0 && Number.isFinite(r) ? r : null;
}

/** A rectangle as fractions (0 to 1) of the picture's width and height. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The part of a picture that `object-fit: cover` shows in a box, as fractions of the picture, for a given focus.
 * Ratios are width over height. CSS places the scaled picture so the point X% across it lines up with the point
 * X% across the box, so the hidden overflow on each axis is split X% before and the rest after.
 */
export function coverCrop(sourceRatio: number, boxRatio: number, focus: FocalPoint): CropRect {
  const p = normalizeFocus(focus);
  if (!(sourceRatio > 0) || !(boxRatio > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  if (boxRatio >= sourceRatio) {
    // The box is wider than the picture: it fills the width and loses some of its height.
    const h = sourceRatio / boxRatio;
    return { x: 0, y: (1 - h) * (p.y / 100), w: 1, h };
  }
  const w = boxRatio / sourceRatio;
  return { x: (1 - w) * (p.x / 100), y: 0, w, h: 1 };
}

/** Which way a crop cuts the picture: across (sides lost), down (top and bottom lost), or not at all. */
export function cropAxis(sourceRatio: number, boxRatio: number): 'x' | 'y' | null {
  if (!(sourceRatio > 0) || !(boxRatio > 0)) return null;
  // Within half a percent the crop loses under a pixel or two of an ordinary photo: treat it as uncropped.
  if (Math.abs(boxRatio / sourceRatio - 1) < 0.005) return null;
  return boxRatio > sourceRatio ? 'y' : 'x';
}

/**
 * The focus for a point picked on the picture (fractions across and down). That point then sits the same share
 * of the way across and down the crop, so it is always in view, and a point in the middle stays in the middle.
 */
export function focusFromPoint(px: number, py: number): FocalPoint {
  return normalizeFocus({ x: px * 100, y: py * 100 });
}

/** How a point reads aloud: "30% from the left, 20% from the top". */
export function describeFocus(p: FocalPoint): string {
  const n = normalizeFocus(p);
  if (n.x === 50 && n.y === 50) return 'Center';
  return `${n.x}% from the left, ${n.y}% from the top`;
}
