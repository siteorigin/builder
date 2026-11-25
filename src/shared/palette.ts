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
import { READABLE_TEXT_COLORS, TEXT_CONTRAST, compositeOver, contrastBetween, evaluatePairs, isFailing, pairsOf, type ColorReader, type ContrastPair, type PairResult } from './contrast';
import { oklabToLinearRgb, oklabToRgb, parseColor, rgbToOklab, toHex6 } from './color';
import { darkValue, resolvedCss } from './color-scheme';
import { tokenVar } from './styles';
import type { DarkColorValue, TokensDoc } from './types';

export const PALETTE_MOODS = ['neutral', 'tinted', 'warm', 'high-contrast'] as const;
export type PaletteMood = (typeof PALETTE_MOODS)[number];

/** How each mood is named and described, to an author and to the AI alike. */
export const PALETTE_MOOD_INFO: Record<PaletteMood, { label: string; description: string; brief: string }> = {
  neutral: { label: 'Neutral', description: 'Near-white backgrounds with a hint of the brand hue.', brief: 'near-white' },
  tinted: { label: 'Tinted', description: 'Backgrounds, lines and text tinted with the brand hue.', brief: 'brand-tinted' },
  warm: { label: 'Warm', description: 'Cream and warm-stone backgrounds that sit with any brand.', brief: 'cream' },
  'high-contrast': { label: 'High contrast', description: 'White backgrounds, near-black text and stronger lines.', brief: 'white, near-black text' }
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
 * `onInverse`, the text on them, reads at 7:1 (translucent text as the colour it makes over the section).
 */
export function darkSection(brand: string, onInverse: string, L = 0.2): string {
  const b = lchOf(brand);
  const text = parseColor(onInverse) ?? rgbOf(WHITE);
  const chroma = b.C < GREY ? 0 : Math.min(b.C, INVERSE_CHROMA);
  const reads = (hex: string) => {
    const ground = rgbOf(hex);
    return contrastBetween(compositeOver(text, ground), ground) >= 7;
  };
  let l = L;
  let hex = oklchHex(l, chroma, b.h);
  while (l > 0 && !reads(hex)) hex = oklchHex((l = Math.max(0, l - 0.02)), chroma, b.h);
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
  // Warm grounds lean to cream. A brand within 30° of it pulls them half way to its own hue, and the pull fades to
  // nothing by 60°, so no brand hue makes the grounds jump; one further round (a blue) leaves them cream, never purple.
  const warmTurn = turn(WARM_HUE, b.h);
  const pull = grey ? 0 : Math.abs(warmTurn) <= 30 ? 0.5 : Math.max(0, (0.5 * (60 - Math.abs(warmTurn))) / 30);
  const groundHue = mood === 'warm' ? (WARM_HUE + warmTurn * pull + 360) % 360 : b.h;
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
/** How many steps past the first brand that works are still looked at: more than 8-bit rounding moves a colour. */
const NEARBY_STEPS = 8;

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
  /**
   * Why the palette is not to be used, if it is not: pairs that fail, and pairs a palette colour is part of that
   * cannot be measured (a `var()` against the page), which it might have made unreadable without anyone knowing.
   * Empty on the built-in themes.
   */
  unreadable: PairResult[];
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
  /** How colours are read; the editor passes one that also asks the browser. */
  read?: ColorReader;
}

/** A palette in `mood` made from `brand` for a theme with these tokens and contrast pairs. */
export function harmonizePalette(input: HarmonyInput): PaletteHarmony {
  const requested = toHex6(rgbOf(input.brand));
  const accent = input.accent ? toHex6(rgbOf(input.accent)) : undefined;
  const has = new Set(input.tokens.filter((t) => t.group === 'color').map((t) => t.id));
  const roles = PALETTE_ROLES.filter((id) => has.has(id));
  const only = (all: Record<PaletteRole, string>) => Object.fromEntries(roles.map((id) => [id, all[id]])) as Partial<Record<PaletteRole, string>>;
  const read = input.read ?? parseColor;
  const measure = (values: Partial<Record<PaletteRole, string>>) => evaluatePairs([...input.tokens], input.pairs, read, values as Record<string, string>);
  const failing = (values: Partial<Record<PaletteRole, string>>) => new Set(measure(values).filter(isFailing).map((r) => r.pair.id));

  // Step 1 and 2: the brand on a page that carries it, moved only when no page can.
  const carry = (brand: string) => {
    for (const page of ['light', 'dark'] as const) {
      const start = only(extremes(brand, page, accent));
      if (!failing(start).size) return { brand, page, start, allowed: new Set<string>() };
    }
    return null;
  };
  let chosen = carry(requested);
  // Moving the brand can only fix pairs it is part of once every other palette colour has a value of its own (a link
  // from one to the brand is replaced): a theme pairing other colours no page fixes is not searched for.
  const brandCanFix = () => {
    const own = input.tokens.map((t) => ((roles as string[]).includes(t.id) && t.id !== 'color.brand' ? { ...t, value: BLACK } : t));
    const brandPairs = new Set(pairsOf(input.pairs, 'color.brand', own).map((p) => p.id));
    return (['light', 'dark'] as const).some((page) => [...failing(only(extremes(requested, page, accent)))].every((id) => brandPairs.has(id)));
  };
  if (!chosen && brandCanFix()) {
    const seed = lchOf(requested);
    const tried = new Set([requested]);
    // Both directions at each step. Saved colours round to 8 bits, so a few steps past the first that works may land
    // nearer the brand: the nearest saved colour of those wins (darker on a tie).
    const found: NonNullable<ReturnType<typeof carry>>[] = [];
    for (let k = 1, last = Infinity; k <= last && k * BRAND_STEP <= 1; k++) {
      for (const L of [seed.L - k * BRAND_STEP, seed.L + k * BRAND_STEP]) {
        if (L < 0 || L > 1) continue;
        const hex = oklchHex(L, seed.C, seed.h);
        if (tried.has(hex)) continue;
        tried.add(hex);
        const c = carry(hex);
        if (c) (found.push(c), (last = Math.min(last, k + NEARBY_STEPS)));
      }
    }
    chosen = found.sort((a, b) => Math.abs(lchOf(a.brand).L - seed.L) - Math.abs(lchOf(b.brand).L - seed.L))[0] ?? null;
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
  const results = measure(values);
  // A pair that cannot be measured is safe only when the palette cannot have moved it: each end shows as it did,
  // names no colour the palette changes (a `var(--so-color-brand)` inside a mix), and does not sit, see-through or
  // unknown, on a page whose colour changed. Anything else might have been made unreadable without anyone knowing.
  const next = input.tokens.map((t) => (Object.hasOwn(values, t.id) ? { ...t, value: values[t.id as PaletteRole]! } : t));
  const asBefore = (id: string) => {
    const [a, b] = [resolvedCss(input.tokens, id), resolvedCss(next, id)];
    if (a === b) return true;
    const [ca, cb] = [a ? read(a) : null, b ? read(b) : null];
    return !!ca && !!cb && ca.r === cb.r && ca.g === cb.g && ca.b === cb.b && ca.a === cb.a;
  };
  const moved = roles.filter((id) => !asBefore(id)).map(tokenVar);
  const pageMoved = !asBefore('color.background');
  const touched = (pair: ContrastPair) => {
    const grounds = typeof pair.bg === 'string' ? [pair.bg] : [pair.bg.mix[0], pair.bg.mix[2]];
    const css = (id: string) => resolvedCss(next, id) ?? '';
    // The text is seen over its ground; only a ground that is see-through (or might be) is seen over the page.
    const overPage = (id: string) => {
      const c = css(id) ? read(css(id)) : null;
      return !c || c.a < 1;
    };
    return [pair.fg, ...grounds].some((id) => !asBefore(id) || moved.some((v) => css(id).includes(v))) || (pageMoved && !pair.varyingGround && grounds.some(overPage));
  };
  return {
    values,
    page,
    requested,
    brand,
    adjusted: brand !== requested,
    results,
    unreadable: results.filter((r) => r.status === 'fail' || (r.status === 'unknown' && touched(r.pair)))
  };
}

/**
 * The palette's colours a site has to save: those it does not show already. A colour written another way (#1E3A5F)
 * is left as it is, and so is a link that still lands on the palette's colour once the rest is saved, so a colour
 * that follows another keeps following it.
 */
export function paletteChanges(tokens: readonly TokenDef[], values: Partial<Record<PaletteRole, string>>): Array<[PaletteRole, string]> {
  let after = tokens.map((t) => (Object.hasOwn(values, t.id) ? { ...t, value: values[t.id as PaletteRole]! } : t));
  const out: Array<[PaletteRole, string]> = [];
  for (const [id, hex] of Object.entries(values) as Array<[PaletteRole, string]>) {
    const was = tokens.find((t) => t.id === id);
    if (!was) continue;
    // Keeping one that already lands on its colour leaves every colour kept before it landing where it did.
    const kept = after.map((t) => (t.id === id ? was : t));
    // Exactly the saved colour, channel for channel: one that only rounds to it (an oklch() value) is measured otherwise.
    const shown = parseColor(resolvedCss(kept, id) ?? '');
    const saved = rgbOf(hex);
    if (shown && shown.a >= 1 && shown.r === saved.r && shown.g === saved.g && shown.b === saved.b) after = kept;
    else out.push([id, hex]);
  }
  return out;
}

/**
 * Dark values that keep a site's dark palette showing what it shows now while these light colours change: each one
 * the dark palette takes from the light palette gets its present light value as a dark value of its own. The dark
 * palette is the author's to remake from the new colours (token.setColorScheme with regenerate).
 */
export function darkPins(light: readonly TokenDef[], dark: TokensDoc['darkOverrides'], changed: readonly string[]): Array<[string, DarkColorValue]> {
  const own = dark && typeof dark === 'object' ? dark : {};
  return changed.flatMap((id): Array<[string, DarkColorValue]> => {
    if (Object.hasOwn(own, id) && darkValue(own[id]) !== null) return [];
    const v = darkValue(light.find((t) => t.id === id)?.value);
    return v === null ? [] : [[id, v]];
  });
}

/**
 * The brand colour a palette is made from: the site's Brand as it shows (links followed; a translucent one as it
 * looks over the page), as #rrggbb. Null when it cannot be read (a `var()`).
 */
export function paletteSeed(tokens: readonly TokenDef[]): string | null {
  const brand = parseColor(resolvedCss(tokens, 'color.brand') ?? '');
  if (!brand) return null;
  if (brand.a >= 1) return toHex6(brand);
  // The page as the contrast check takes it: white when the theme has none, unknown when its colour cannot be read.
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const page = parseColor(resolvedCss(tokens, 'color.background') ?? '');
  if (!page && tokens.some((t) => t.id === 'color.background')) return null;
  return toHex6(compositeOver(brand, page ? compositeOver(page, white) : white));
}
