/**
 * CSS colours as the visual picker needs them. A site can save any colour `validateStyleValue` accepts
 * (short hex, hex with alpha, rgb(), hsl(), oklch(), ...), but a native colour input only holds #rrggbb and
 * no opacity. These helpers turn a saved value into what the picker starts from, and a picked colour back
 * into a saved value without losing the opacity the original carried.
 *
 * Values the parser cannot resolve on its own (`currentcolor`, `var()`, `color-mix()`, relative colours)
 * give null: callers must treat that as "not editable visually", never as black.
 */

/** A colour in sRGB: channels 0-255 (not rounded), alpha 0-1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const ANGLE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/i;

/** A channel's number, or its percentage of `full`; `none` is zero. Null when it is neither. */
function channel(s: string, full: number): number | null {
  if (s.toLowerCase() === 'none') return 0;
  if (s.endsWith('%')) {
    const n = s.slice(0, -1);
    return NUMBER.test(n) ? (Number(n) * full) / 100 : null;
  }
  return NUMBER.test(s) ? Number(s) : null;
}

/** Alpha as 0-1 from a number or a percentage; `none` is zero. */
function alphaOf(s: string | undefined): number | null {
  if (s === undefined) return 1;
  const v = channel(s, 1);
  return v === null ? null : clamp(v, 0, 1);
}

/** An angle in degrees (a bare number is degrees); `none` is zero. */
function hueOf(s: string): number | null {
  if (s.toLowerCase() === 'none') return 0;
  const m = ANGLE.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'deg').toLowerCase();
  return unit === 'deg' ? n : unit === 'grad' ? n * 0.9 : unit === 'rad' ? (n * 180) / Math.PI : n * 360;
}

const toSrgb = (v: number) => {
  const c = clamp(v, 0, 1);
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
};

function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

/** CIE Lab (D50, as CSS defines it) to sRGB. */
function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const eps = 216 / 24389;
  const kappa = 24389 / 27;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const x = (fx ** 3 > eps ? fx ** 3 : (116 * fx - 16) / kappa) * 0.96422;
  const y = L > kappa * eps ? fy ** 3 : L / kappa;
  const z = (fz ** 3 > eps ? fz ** 3 : (116 * fz - 16) / kappa) * 0.82521;
  return [toSrgb(3.1338561 * x - 1.6168667 * y - 0.4906146 * z), toSrgb(-0.9787684 * x + 1.9161415 * y + 0.033454 * z), toSrgb(0.0719453 * x - 0.2289914 * y + 1.4052427 * z)];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const f = (n: number) => {
    const k = (n + (((h % 360) + 360) % 360) / 30) % 12;
    return 255 * (light - sat * Math.min(light, 1 - light) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

/** The components of `fn(a b c / d)` or the legacy `fn(a, b, c, d)`, or null when it is neither. */
function args(inner: string): { parts: string[]; alpha: string | undefined } | null {
  if (/[()]/.test(inner) || /\bfrom\b/i.test(inner)) return null;
  const slash = inner.split('/');
  if (slash.length > 2) return null;
  const parts = slash[0].trim().split(/\s*,\s*|\s+/).filter(Boolean);
  let alpha: string | undefined = slash[1]?.trim();
  if (alpha === '') return null;
  if (alpha === undefined && parts.length === 4) alpha = parts.pop();
  else if (alpha !== undefined && parts.length === 4) return null;
  return parts.length === 3 ? { parts, alpha } : null;
}

const done = (rgb: [number, number, number], a: number | null): Rgba | null => (a === null ? null : { r: rgb[0], g: rgb[1], b: rgb[2], a });

/** A CSS colour as sRGB, or null when it is not one the parser can resolve on its own. */
export function parseColor(value: string): Rgba | null {
  const s = value.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h) || ![3, 4, 6, 8].includes(h.length)) return null;
    const wide = h.length <= 4;
    const byte = (i: number) => parseInt(wide ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16);
    return { r: byte(0), g: byte(1), b: byte(2), a: h.length === 4 || h.length === 8 ? byte(3) / 255 : 1 };
  }
  const m = /^([a-z]+)\((.*)\)$/s.exec(s);
  if (!m) return null;
  const parsed = args(m[2]);
  if (!parsed) return null;
  const [p0, p1, p2] = parsed.parts;
  const a = alphaOf(parsed.alpha);
  switch (m[1]) {
    case 'rgb':
    case 'rgba': {
      const [r, g, b] = [channel(p0, 255), channel(p1, 255), channel(p2, 255)];
      return r === null || g === null || b === null ? null : done([clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)], a);
    }
    case 'hsl':
    case 'hsla': {
      const [h, sat, light] = [hueOf(p0), channel(p1, 100), channel(p2, 100)];
      return h === null || sat === null || light === null ? null : done(hslToRgb(h, sat, light), a);
    }
    case 'oklab': {
      const [L, x, y] = [channel(p0, 1), channel(p1, 0.4), channel(p2, 0.4)];
      return L === null || x === null || y === null ? null : done(oklabToRgb(clamp(L, 0, 1), x, y), a);
    }
    case 'oklch': {
      const [L, c, h] = [channel(p0, 1), channel(p1, 0.4), hueOf(p2)];
      if (L === null || c === null || h === null) return null;
      const rad = (h * Math.PI) / 180;
      return done(oklabToRgb(clamp(L, 0, 1), Math.max(0, c) * Math.cos(rad), Math.max(0, c) * Math.sin(rad)), a);
    }
    case 'lab': {
      const [L, x, y] = [channel(p0, 100), channel(p1, 125), channel(p2, 125)];
      return L === null || x === null || y === null ? null : done(labToRgb(clamp(L, 0, 100), x, y), a);
    }
    case 'lch': {
      const [L, c, h] = [channel(p0, 100), channel(p1, 150), hueOf(p2)];
      if (L === null || c === null || h === null) return null;
      const rad = (h * Math.PI) / 180;
      return done(labToRgb(clamp(L, 0, 100), Math.max(0, c) * Math.cos(rad), Math.max(0, c) * Math.sin(rad)), a);
    }
    default:
      return null;
  }
}

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

/** The colour's #rrggbb, ignoring opacity: what a native colour input holds. */
export function toHex6(c: Rgba): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

/** What the picker starts from for a saved value (#rrggbb, opacity left out), or null when it cannot be resolved. */
export function pickerHex(value: string): string | null {
  const c = parseColor(value);
  return c ? toHex6(c) : null;
}

/** The value's opacity, 0-1: 1 for an opaque colour and for one that cannot be resolved. */
export function opacityOf(value: string): number {
  return parseColor(value)?.a ?? 1;
}

/** An opacity as short CSS text: 0.5, 0.35, 0.0004, 0 (six decimals at most, no trailing zeros). */
const alphaText = (a: number) => String(Number(clamp(a, 0, 1).toFixed(6)));

/**
 * The value to save when `picked` (#rrggbb) is chosen in the picker on top of `current`. An opaque or
 * unresolvable or fully transparent current value becomes the plain #rrggbb. A translucent one keeps its opacity and, where it
 * can, its notation: 8-digit hex stays hex, legacy rgba() stays rgba(), anything else becomes rgb(r g b / a).
 * Picking the colour the picker already showed returns `current` untouched, so nothing is rewritten.
 * `resolved` is the colour a browser made of `current` when `parseColor` could not (a `color-mix()`).
 */
export function colorFromPicker(current: string, picked: string, resolved?: Rgba | null): string {
  const next = parseColor(picked);
  if (!next) return current;
  const was = resolved ?? parseColor(current);
  const hex = toHex6(next);
  if (was && toHex6(was) === hex) return current;
  // Nothing to preserve in a colour that is opaque, or so transparent that a pick would look like nothing happened.
  if (!was || was.a >= 1 || was.a <= 0) return hex;
  const text = current.trim().toLowerCase();
  const alpha = Math.round(was.a * 255);
  if (text.startsWith('#')) return `${hex}${alpha.toString(16).padStart(2, '0')}`;
  const [r, g, b] = [Math.round(next.r), Math.round(next.g), Math.round(next.b)];
  if (text.startsWith('rgba(') && text.includes(',')) return `rgba(${r}, ${g}, ${b}, ${alphaText(was.a)})`;
  return `rgb(${r} ${g} ${b} / ${alphaText(was.a)})`;
}
