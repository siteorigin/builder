/**
 * A website's light and dark palettes (TokensDoc `colorSchemeMode` and `darkOverrides`). The light palette is the
 * site's tokens as they always were; the dark one is the same tokens with the dark palette's own colours laid over
 * them, links followed within it. This module reads the mode, builds the dark palette's tokens, and makes a dark
 * palette from a light one the first time an author turns it on.
 */
import { COLOR_SCHEME_MODES, type ColorSchemeMode, type DarkColorValue, type TokenDef, type TokensDoc } from './types';
import { evaluatePairs, type ContrastPair } from './contrast';
import { oklabToRgb, parseColor, rgbToOklab, toHex6 } from './color';

/** The palette an editor shows or edits: the site's own (light), or the dark one beside it. */
export type PaletteScheme = 'light' | 'dark';

/** The site's mode, as one the editor knows: anything else is a single palette. */
export function colorSchemeMode(tokens: Pick<TokensDoc, 'colorSchemeMode'> | undefined): ColorSchemeMode {
  const mode = tokens?.colorSchemeMode;
  return mode && (COLOR_SCHEME_MODES as readonly string[]).includes(mode) ? mode : 'single';
}

/** Whether visitors can see the dark palette. */
export const hasDarkPalette = (tokens: Pick<TokensDoc, 'colorSchemeMode'> | undefined): boolean => colorSchemeMode(tokens) !== 'single';

const refOf = (v: unknown): string | null =>
  v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { token?: unknown }).token === 'string' && Object.keys(v).length === 1 ? (v as { token: string }).token : null;

/** A stored dark colour the palette can use: a non-empty colour, or a link. Anything else (a hand edit) is left out. */
export function darkValue(v: unknown): DarkColorValue | null {
  const ref = refOf(v);
  if (ref) return { token: ref };
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * The tokens as the dark palette has them: each colour with a dark value of its own takes it, and every other token
 * is as in `tokens` (the light palette). Only colour tokens can have a dark value.
 */
export function withDarkPalette(tokens: TokenDef[], dark: TokensDoc['darkOverrides']): TokenDef[] {
  if (!dark || typeof dark !== 'object') return tokens;
  return tokens.map((t) => {
    if (t.group !== 'color' || !Object.hasOwn(dark, t.id)) return t;
    const v = darkValue(dark[t.id]);
    return v === null ? t : { ...t, value: v };
  });
}

/**
 * How light each of the common colour roles is in a dark palette made from a light one (OKLab lightness), chosen so
 * every pair a theme sets against each other stays readable: dark grounds, light text, and a lightened brand with
 * dark text on it. A dark section stays dark, a step off the page.
 */
const ROLE_LIGHTNESS: Record<string, number> = {
  'color.background': 0.17,
  'color.surface': 0.21,
  'color.surface-alt': 0.25,
  'color.text': 0.94,
  'color.muted': 0.79,
  'color.brand': 0.78,
  'color.brand-strong': 0.85,
  'color.on-brand': 0.15,
  'color.accent': 0.8,
  'color.inverse': 0.19,
  'color.on-inverse': 0.94,
  'color.border': 0.42,
  'color.focus': 0.8
};

/** The most colourful a made colour gets (OKLCH chroma): enough to keep the brand's hue, never a neon on black. */
const MAX_CHROMA = 0.1;

/** A colour token's CSS in `tokens`, links followed; null for a dangling or circular link. */
function resolvedCss(tokens: readonly TokenDef[], id: string): string | null {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const seen = new Set<string>();
  for (let cur: string | null = id; cur; ) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const v: unknown = byId.get(cur)?.value;
    const ref = refOf(v);
    if (!ref) return typeof v === 'string' && v.trim() ? v.trim() : null;
    cur = ref;
  }
  return null;
}

/** A colour's hue (radians) and chroma, or none for a colour that cannot be read. */
function hueOf(css: string | null): { h: number; c: number } | null {
  const rgb = css ? parseColor(css) : null;
  if (!rgb) return null;
  const [, a, b] = rgbToOklab(rgb);
  return { h: Math.atan2(b, a), c: Math.hypot(a, b) };
}

/** The colour at lightness `L` with the hue and (capped) chroma of `from`: a neutral grey when `from` is unknown. */
function madeColor(L: number, from: { h: number; c: number } | null, chroma: number): string {
  const c = from ? Math.min(from.c, chroma) : 0;
  const [r, g, b] = oklabToRgb(L, c * Math.cos(from?.h ?? 0), c * Math.sin(from?.h ?? 0));
  return toHex6({ r, g, b, a: 1 });
}

/**
 * A dark palette made from the light one: each common colour role at its dark lightness, keeping the hue of the
 * colour it has now (the theme's, when the site's own cannot be read). A role that follows another colour keeps
 * following it, where that still reads well. Colours of the site's own and roles the theme does not have keep their
 * light value. The result is checked against the theme's contrast pairs: when a kept link or a strong hue spoils
 * one, the palette is made again without links, then without hue. Pure and deterministic, so the same light palette
 * always makes the same dark one.
 */
export function deriveDarkPalette(light: readonly TokenDef[], themeDefaults: readonly TokenDef[], pairs: readonly ContrastPair[] = []): Record<string, DarkColorValue> {
  const colors = light.filter((t) => t.group === 'color');
  const ids = new Set(colors.map((t) => t.id));
  const attempt = (keepLinks: boolean, chroma: number): Record<string, DarkColorValue> => {
    const out: Record<string, DarkColorValue> = {};
    for (const t of colors) {
      const L = Object.hasOwn(ROLE_LIGHTNESS, t.id) ? ROLE_LIGHTNESS[t.id] : undefined;
      if (L === undefined) continue;
      const ref = refOf(t.value);
      if (keepLinks && ref && ids.has(ref) && Object.hasOwn(ROLE_LIGHTNESS, ref)) continue;
      out[t.id] = madeColor(L, hueOf(resolvedCss(light, t.id)) ?? hueOf(resolvedCss(themeDefaults, t.id)), chroma);
    }
    return out;
  };
  const readable = (dark: Record<string, DarkColorValue>) => !evaluatePairs(withDarkPalette([...light], dark), pairs).some((r) => r.status === 'fail');
  const tries = [attempt(true, MAX_CHROMA), attempt(false, MAX_CHROMA), attempt(false, 0)];
  return tries.find(readable) ?? tries[tries.length - 1];
}
