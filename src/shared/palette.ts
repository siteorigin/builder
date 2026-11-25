/**
 * A whole site palette made from one brand colour, worked out in OKLCH so every step is an even perceptual one:
 * backgrounds, cards, alternate sections, lines and text in the brand's hue (or a warm one), a hover shade and dark
 * sections that keep the brand's colour instead of greying towards it, and an accent beside it. Site styles and
 * the AI brand tool share it, so both make the same palette from the same brand.
 *
 * Readability is not left to the targets. The theme's contrast pairs are checked on the colours as they will be
 * saved (#rrggbb), and the palette only ever moves from one that passes every pair to another that does:
 *
 * 1. Every colour is put at the end of its range that reads best (grounds and text on the brand at white or black,
 *    text at the other, dark sections black, their text white). On those ends only the brand itself can fail,
 *    as text on the grounds, and for any colour one of white and black gives it at least 4.58:1, so the brand is
 *    kept exactly, on light grounds when it reads there and on dark ones when only those work.
 * 2. When neither works (a mid-tone brand under Signal's tinted eyebrow pill), the brand's lightness moves the
 *    least it must, keeping its hue, and the palette says so.
 * 3. The colours then move from those ends towards the mood's targets, a group at a time; a target that would spoil
 *    a pair is approached only as far as every pair still passes.
 *
 * Pure and deterministic: the same brand, mood and theme always make the same palette.
 */
import type { TokenDef } from './types';
import { READABLE_TEXT_COLORS, TEXT_CONTRAST, compositeOver, contrastBetween, evaluatePairs, isFailing, type ContrastPair, type PairResult } from './contrast';
import { oklabToLinearRgb, oklabToRgb, parseColor, rgbToOklab, toHex6 } from './color';
import { resolvedCss } from './color-scheme';

export const PALETTE_MOODS = ['neutral', 'tinted', 'warm', 'high-contrast'] as const;
export type PaletteMood = (typeof PALETTE_MOODS)[number];

/** How each mood is named and described, to an author and to the AI alike. */
export const PALETTE_MOOD_INFO: Record<PaletteMood, { label: string; description: string }> = {
  neutral: { label: 'Neutral', description: 'Near-white backgrounds with a hint of the brand hue.' },
  tinted: { label: 'Tinted', description: 'Backgrounds, lines and text tinted with the brand hue.' },
  warm: { label: 'Warm', description: 'Cream and warm-stone backgrounds that sit with any brand.' },
  'high-contrast': { label: 'High contrast', description: 'White backgrounds, near-black text and stronger lines.' }
};

/** The colour roles a palette sets, where the theme has them. */
export const PALETTE_ROLES = [
  'color.background',
  'color.surface',
  'color.surface-alt',
  'color.border',
  'color.text',
  'color.muted',
  'color.brand',
  'color.brand-strong',
  'color.on-brand',
  'color.accent',
  'color.inverse',
  'color.on-inverse',
  'color.focus'
] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];

const WHITE = '#ffffff';
const BLACK = '#000000';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const rgbOf = (hex: string) => parseColor(hex)!;
const ratio = (a: string, b: string) => contrastBetween(rgbOf(a), rgbOf(b));

interface Lch {
  L: number;
  C: number;
  /** Degrees. */
  h: number;
}

/** A colour's OKLCH. */
function lchOf(hex: string): Lch {
  const [L, a, b] = rgbToOklab(rgbOf(hex));
  return { L, C: Math.hypot(a, b), h: (((Math.atan2(b, a) * 180) / Math.PI) % 360 + 360) % 360 };
}

/** Below this chroma a colour reads as grey, and its hue is noise. */
const GREY = 0.02;

const fits = (L: number, C: number, h: number) => {
  const rad = (h * Math.PI) / 180;
  return oklabToLinearRgb(L, C * Math.cos(rad), C * Math.sin(rad)).every((v) => v >= -1e-6 && v <= 1 + 1e-6);
};

/**
 * OKLCH as #rrggbb. Lightness and hue are kept and chroma is reduced until sRGB can show the colour, so a bright
 * hue never shifts or clips towards another one.
 */
export function oklchHex(L: number, C: number, h: number): string {
  const l = clamp(L, 0, 1);
  if (l >= 1) return WHITE;
  if (l <= 0) return BLACK;
  let c = Math.max(0, C);
  if (!fits(l, c, h)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(l, mid, h)) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  const rad = (h * Math.PI) / 180;
  const [r, g, b] = oklabToRgb(l, c * Math.cos(rad), c * Math.sin(rad));
  return toHex6({ r, g, b, a: 1 });
}

/** The colour `t` of the way from `from` to `to`, mixed in OKLab. */
function between(from: string, to: string, t: number): string {
  const [L1, a1, b1] = rgbToOklab(rgbOf(from));
  const [L2, a2, b2] = rgbToOklab(rgbOf(to));
  const [r, g, b] = oklabToRgb(L1 + (L2 - L1) * t, a1 + (a2 - a1) * t, b1 + (b2 - b1) * t);
  return toHex6({ r, g, b, a: 1 });
}

/** Text on the brand: white, the site's ink, or black, the first that reads at 4.5:1. Black always does where white does not. */
export function onBrandFor(brand: string): string {
  return READABLE_TEXT_COLORS.find((t) => ratio(t, brand) >= TEXT_CONTRAST) ?? BLACK;
}

/** How far the hover shade sits from the brand, in OKLCH lightness. */
const STRONG_STEP = 0.1;

/** The brand's hover shade: a perceptual step further from the text on it, in the brand's hue and chroma where sRGB has them. */
export function strongShade(brand: string, onBrand: string): string {
  const b = lchOf(brand);
  const away = lchOf(onBrand).L > b.L ? -1 : 1;
  return oklchHex(b.L + away * STRONG_STEP, b.C, b.h);
}

/** How colourful dark sections get: enough to carry the brand's hue, never a coloured slab. */
const INVERSE_CHROMA = 0.045;

/**
 * Dark sections in the brand's hue, at `L` (OKLCH lightness) and a quiet chroma, made darker where needed until
 * `onInverse`, the text on them, reads at 7:1.
 */
export function darkSection(brand: string, onInverse: string, L = 0.2): string {
  const b = lchOf(brand);
  const text = parseColor(onInverse) ? onInverse : WHITE;
  const chroma = b.C < GREY ? 0 : Math.min(b.C, INVERSE_CHROMA);
  let l = L;
  let hex = oklchHex(l, chroma, b.h);
  while (l > 0 && ratio(hex, text) < 7) hex = oklchHex((l = Math.max(0, l - 0.02)), chroma, b.h);
  return hex;
}

/** OKLCH lightness for each ground and text role, on a light page and on a dark one. */
interface Ramp {
  background: number;
  surface: number;
  alt: number;
  border: number;
  text: number;
  muted: number;
  focus: number;
}

interface Mood {
  light: Ramp;
  dark: Ramp;
  /** The most chroma the grounds get. */
  chroma: number;
  inverse: number;
  onInverse: number;
  accent: number;
}

const MOODS: Record<PaletteMood, Mood> = {
  neutral: {
    light: { background: 0.985, surface: 0.998, alt: 0.955, border: 0.86, text: 0.22, muted: 0.45, focus: 0.5 },
    dark: { background: 0.17, surface: 0.21, alt: 0.25, border: 0.4, text: 0.95, muted: 0.77, focus: 0.78 },
    chroma: 0.008,
    inverse: 0.2,
    onInverse: 0.96,
    accent: 0.76
  },
  tinted: {
    light: { background: 0.975, surface: 0.995, alt: 0.935, border: 0.82, text: 0.22, muted: 0.44, focus: 0.5 },
    dark: { background: 0.17, surface: 0.22, alt: 0.27, border: 0.43, text: 0.95, muted: 0.79, focus: 0.78 },
    chroma: 0.035,
    inverse: 0.2,
    onInverse: 0.96,
    accent: 0.76
  },
  warm: {
    light: { background: 0.98, surface: 0.995, alt: 0.945, border: 0.83, text: 0.23, muted: 0.45, focus: 0.5 },
    dark: { background: 0.18, surface: 0.22, alt: 0.26, border: 0.42, text: 0.95, muted: 0.78, focus: 0.78 },
    chroma: 0.025,
    inverse: 0.2,
    onInverse: 0.96,
    accent: 0.76
  },
  'high-contrast': {
    light: { background: 0.995, surface: 1, alt: 0.97, border: 0.68, text: 0.1, muted: 0.34, focus: 0.42 },
    dark: { background: 0.08, surface: 0.12, alt: 0.16, border: 0.55, text: 0.99, muted: 0.86, focus: 0.85 },
    chroma: 0.005,
    inverse: 0.12,
    onInverse: 0.99,
    accent: 0.82
  }
};

/** The hue warm grounds lean to: cream and stone. */
const WARM_HUE = 75;
/** The focus outline's hue for a grey brand: the blue browsers draw it in. */
const FOCUS_HUE = 260;

/** The signed shortest turn from hue `a` to hue `b`, in degrees. */
const turn = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

/** Where each role wants to be for this brand, mood and page: the palette before readability has its say. */
function targets(brand: string, mood: PaletteMood, page: 'light' | 'dark'): Record<PaletteRole, string> {
  const m = MOODS[mood];
  const ramp = m[page];
  const b = lchOf(brand);
  const grey = b.C < GREY;
  // Warm grounds lean to cream; a brand already near it pulls them half way to its own hue.
  const groundHue = mood === 'warm' ? (!grey && Math.abs(turn(WARM_HUE, b.h)) <= 60 ? WARM_HUE + turn(WARM_HUE, b.h) / 2 : WARM_HUE) : b.h;
  // A quiet brand never gets louder grounds than itself; warm grounds are tinted whatever the brand.
  const cap = mood === 'warm' ? m.chroma : grey ? 0 : Math.min(b.C, m.chroma);
  const ground = (L: number, C: number) => oklchHex(L, C, groundHue);
  const onBrand = onBrandFor(brand);
  const onInverse = ground(m.onInverse, Math.min(cap, 0.012));
  const accentHue = grey ? groundHue : (b.h + 30) % 360;
  const accentChroma = grey ? (mood === 'warm' ? 0.06 : 0) : clamp(b.C, 0.08, 0.14);
  return {
    'color.background': ground(ramp.background, cap),
    'color.surface': ground(ramp.surface, cap / 2),
    'color.surface-alt': ground(ramp.alt, cap),
    'color.border': ground(ramp.border, Math.min(cap * 2, 0.05)),
    'color.text': ground(ramp.text, Math.min(cap, 0.02)),
    'color.muted': ground(ramp.muted, Math.min(cap * 1.5, 0.04)),
    'color.brand': brand,
    'color.brand-strong': strongShade(brand, onBrand),
    'color.on-brand': onBrand,
    'color.accent': oklchHex(m.accent, accentChroma, accentHue),
    'color.inverse': darkSection(brand, onInverse, m.inverse),
    'color.on-inverse': onInverse,
    'color.focus': oklchHex(ramp.focus, 0.14, grey ? FOCUS_HUE : b.h)
  };
}

/**
 * Every colour at the end of its range that reads best on a light (`white`) or dark page: grounds and the text on
 * the brand at the page's end, text and the hover shade at the other, dark sections black with white on them.
 */
function extremes(brand: string, page: 'light' | 'dark', accent: string | undefined): Record<PaletteRole, string> {
  const [ground, ink] = page === 'light' ? [WHITE, BLACK] : [BLACK, WHITE];
  return {
    'color.background': ground,
    'color.surface': ground,
    'color.surface-alt': ground,
    'color.border': ground,
    'color.text': ink,
    'color.muted': ink,
    'color.brand': brand,
    'color.brand-strong': ink,
    'color.on-brand': ground,
    'color.accent': accent ?? WHITE,
    'color.inverse': BLACK,
    'color.on-inverse': WHITE,
    'color.focus': ink
  };
}

/** The order colours move towards their targets: grounds first, as they set the mood, then the brand's own, text, dark sections. */
const STAGES: PaletteRole[][] = [
  ['color.background', 'color.surface', 'color.surface-alt', 'color.border'],
  ['color.on-brand', 'color.brand-strong'],
  ['color.text', 'color.muted', 'color.focus'],
  ['color.inverse', 'color.on-inverse', 'color.accent']
];

/** How finely the brand's lightness is searched when it has to move (OKLCH lightness). */
const BRAND_STEP = 1 / 1024;

export interface PaletteHarmony {
  /** The colours to save, as #rrggbb: every role the theme has. */
  values: Partial<Record<PaletteRole, string>>;
  /** Whether the page is light or dark: a brand that only reads on dark grounds gets a dark page. */
  page: 'light' | 'dark';
  /** The brand colour asked for (#rrggbb). */
  requested: string;
  /** The brand colour the palette uses: the one asked for, unless no page could carry it as text. */
  brand: string;
  adjusted: boolean;
  /** The theme's pairs on the palette. Every pair passes on the built-in themes; one a theme of its own cannot pass shows as failing. */
  results: PairResult[];
}

export interface HarmonyInput {
  /** An opaque colour; see `paletteSeed` for the site's own. */
  brand: string;
  mood: PaletteMood;
  /** The site's effective tokens, so pairs on colours the palette does not set are measured as they are. */
  tokens: readonly TokenDef[];
  pairs: readonly ContrastPair[];
  /** An accent the author chose, kept as it is; otherwise the palette makes one. */
  accent?: string;
}

/** A palette in `mood` made from `brand` for a theme with these tokens and contrast pairs. */
export function harmonizePalette(input: HarmonyInput): PaletteHarmony {
  const requested = toHex6(rgbOf(input.brand));
  const accent = input.accent ? toHex6(rgbOf(input.accent)) : undefined;
  const has = new Set(input.tokens.filter((t) => t.group === 'color').map((t) => t.id));
  const roles = PALETTE_ROLES.filter((id) => has.has(id));
  const only = (all: Record<PaletteRole, string>) => Object.fromEntries(roles.map((id) => [id, all[id]])) as Partial<Record<PaletteRole, string>>;
  const failing = (values: Partial<Record<PaletteRole, string>>) => new Set(evaluatePairs([...input.tokens], input.pairs, parseColor, values as Record<string, string>).filter(isFailing).map((r) => r.pair.id));

  // Step 1 and 2: the brand on a page that carries it, moved only when no page can.
  const carry = (brand: string) => {
    for (const page of ['light', 'dark'] as const) {
      const start = only(extremes(brand, page, accent));
      if (!failing(start).size) return { brand, page, start, allowed: new Set<string>() };
    }
    return null;
  };
  let chosen = carry(requested);
  if (!chosen) {
    const seed = lchOf(requested);
    const tried = new Set([requested]);
    for (let k = 1; !chosen && k * BRAND_STEP <= 1; k++) {
      for (const dir of [-1, 1]) {
        const L = seed.L + dir * k * BRAND_STEP;
        if (L < 0 || L > 1) continue;
        const hex = oklchHex(L, seed.C, seed.h);
        if (tried.has(hex)) continue;
        tried.add(hex);
        if ((chosen = carry(hex))) break;
      }
    }
  }
  // A theme of its own may pair colours no palette can make readable: keep the brand, and what fails on its best page.
  if (!chosen) {
    const [light, dark] = (['light', 'dark'] as const).map((page) => ({ page, start: only(extremes(requested, page, accent)) }));
    const [lightFails, darkFails] = [failing(light.start), failing(dark.start)];
    const best = darkFails.size < lightFails.size ? { ...dark, allowed: darkFails } : { ...light, allowed: lightFails };
    chosen = { brand: requested, ...best };
  }

  // Step 3: towards the mood, only through palettes that keep every pair passing (or, failing that, no worse).
  const { brand, page, allowed } = chosen;
  const ok = (values: Partial<Record<PaletteRole, string>>) => [...failing(values)].every((id) => allowed.has(id));
  const goal = only(targets(brand, input.mood, page));
  if (accent && goal['color.accent']) goal['color.accent'] = accent;
  let values = { ...chosen.start };
  if (ok(goal)) values = goal;
  else {
    for (const stage of STAGES) {
      const ids = stage.filter((id) => roles.includes(id) && values[id] !== goal[id]);
      if (!ids.length) continue;
      const all = { ...values, ...Object.fromEntries(ids.map((id) => [id, goal[id]])) };
      if (ok(all)) {
        values = all;
        continue;
      }
      for (const id of ids) {
        const from = values[id]!;
        const to = goal[id]!;
        if (ok({ ...values, [id]: to })) {
          values = { ...values, [id]: to };
          continue;
        }
        // As far towards the target as every pair allows. Only passing palettes are ever kept, so this needs no
        // monotonic contrast to be right; it just finds a good point on the way.
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          if (ok({ ...values, [id]: between(from, to, mid) })) lo = mid;
          else hi = mid;
        }
        values = { ...values, [id]: between(from, to, lo) };
      }
    }
  }
  return {
    values,
    page,
    requested,
    brand,
    adjusted: brand !== requested,
    results: evaluatePairs([...input.tokens], input.pairs, parseColor, values as Record<string, string>)
  };
}

/**
 * The brand colour a palette is made from: the site's Brand as it shows (links followed; a translucent one as it
 * looks over the page), as #rrggbb. Null when it cannot be read (a `var()`).
 */
export function paletteSeed(tokens: readonly TokenDef[]): string | null {
  const brand = parseColor(resolvedCss(tokens, 'color.brand') ?? '');
  if (!brand) return null;
  if (brand.a >= 1) return toHex6(brand);
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const page = parseColor(resolvedCss(tokens, 'color.background') ?? '');
  return toHex6(compositeOver(brand, page ? compositeOver(page, white) : white));
}
