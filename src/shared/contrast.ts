/**
 * WCAG contrast for the colours a theme pairs on purpose: text on its button, on a card, on a dark section.
 * A theme declares those pairs by token id (`ThemePack.contrastPairs`); this module reads the project's
 * effective tokens, follows their references, and says which pairs are readable, with a foreground to offer
 * when one is not. It is pure: the caller passes the colour reader (the plain parser, or the renderer's, which
 * also asks the browser about colours the parser leaves alone).
 *
 * Ratios are never rounded before they are compared with the minimum, and are shown cut (never rounded) to two
 * decimals, so a pair that reads "4.50:1" passes and one that fails never reads as the minimum.
 */
import type { TokenDef } from './types';
import { parseColor, toHex6, type Rgba } from './color';

/** The minimum ratio for text of ordinary size (WCAG 2.2 AA, 1.4.3). */
export const TEXT_CONTRAST = 4.5;

/** A readable choice for text, in the order a brand prefers them: white, then the site's ink, then pure black. */
export const READABLE_TEXT_COLORS = ['#ffffff', '#14181a', '#000000'] as const;

/** A colour as the evaluator reads it: sRGB, or null when it cannot be known (a `var()`, `currentcolor`). */
export type ColorReader = (css: string) => Rgba | null;

const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of an sRGB colour (channels 0-255; alpha is not part of it). */
export function relativeLuminance(c: Pick<Rgba, 'r' | 'g' | 'b'>): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** The ratio between two opaque colours, 1 to 21. */
export function contrastBetween(a: Pick<Rgba, 'r' | 'g' | 'b'>, b: Pick<Rgba, 'r' | 'g' | 'b'>): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` painted over an opaque `under`. */
export function compositeOver(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

/**
 * A ratio as shown: cut to two decimals, so it never reads as more than it is (a pair that fails never shows the
 * minimum). The tiny allowance is for the representation of the hundredths, so 4.52 does not read 4.51; no colour
 * pair is within it of a minimum without being on it.
 */
export function formatRatio(ratio: number): string {
  return (Math.floor(ratio * 100 + 1e-11) / 100).toFixed(2);
}

/**
 * One end of a pair: a colour token, or what `color-mix(in srgb, A p%, B)` makes of two of them (premultiplied,
 * as the browser mixes), for a hover colour that is itself a mix.
 */
export type PairColor = string | { mix: [a: string, aPercent: number, b: string] };

export interface ContrastPair {
  id: string;
  /** What the pair colours, in an author's words ("Button text on hover"). */
  use: string;
  /** The text (or icon) colour: a token id. This is the token a fix changes. */
  fg: string;
  bg: PairColor;
  /** A hover state is only fixed by a colour that keeps its resting state readable too. */
  state: 'rest' | 'hover';
  /** The background sits on grounds that differ from place to place (a light button on a brand panel or a dark one), so a translucent colour in it cannot be measured. */
  varyingGround?: boolean;
  /** Pairs that colour one thing in its different states, or one text colour on its different grounds. */
  group: string;
  /** False when the foreground is itself the colour the author is choosing (brand text on the page), so changing it is no fix. */
  fixable?: boolean;
  /** Defaults to the text minimum. */
  min?: number;
  /** The foreground is drawn at this opacity (an element's own, not its colour's), so it is seen as the colour it makes over the ground. */
  opacity?: number;
}

/** A pair that could be measured: the ratio, the minimum it needed, and both colours as the site shows them (#rrggbb). */
interface Measured {
  pair: ContrastPair;
  ratio: number;
  min: number;
  fg: string;
  bg: string;
}
export type FailingPair = Measured & { status: 'fail' };
/** `unknown`: a colour that cannot be known here (a `var()`, `currentcolor`, a token that is missing or circular). */
export type PairResult = (Measured & { status: 'pass' }) | FailingPair | { status: 'unknown'; pair: ContrastPair };

export const isFailing = (r: PairResult): r is FailingPair => r.status === 'fail';

/** Where translucent colours land: the page background, itself painted over white. */
const BACKDROP = 'color.background';

/** The token graph: ids to values, with `overrides` standing in for tokens being tried. */
function tokenGraph(tokens: TokenDef[], overrides: Record<string, string> = {}) {
  const byId = new Map<string, unknown>(tokens.map((t) => [t.id, t.value]));
  for (const [id, v] of Object.entries(overrides)) byId.set(id, v);
  /** A colour token's CSS, references followed; null for a dangling or circular chain, or a value that is not text. */
  const css = (id: string): string | null => {
    const seen = new Set<string>();
    let cur = id;
    for (;;) {
      if (seen.has(cur) || !byId.has(cur)) return null;
      seen.add(cur);
      const v = byId.get(cur);
      if (v && typeof v === 'object' && 'token' in v && typeof (v as { token: unknown }).token === 'string') cur = (v as { token: string }).token;
      else return typeof v === 'string' && v.trim() ? v.trim() : null;
    }
  };
  return { css, has: (id: string) => byId.has(id) };
}

/** The pairs' results for these tokens. `overrides` evaluates the pairs as if those tokens had those values. */
export function evaluatePairs(tokens: TokenDef[], pairs: readonly ContrastPair[], read: ColorReader = parseColor, overrides: Record<string, string> = {}): PairResult[] {
  const graph = tokenGraph(tokens, overrides);
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  const pageCss = graph.css(BACKDROP);
  const pageColor = pageCss ? read(pageCss) : null;
  // A theme with no page colour paints on white; one whose page colour cannot be known leaves every translucent colour unknown.
  const page = pageColor ? compositeOver(pageColor, white) : graph.has(BACKDROP) ? null : white;
  /** A token's colour as the site shows it: opaque, a translucent one painted over `under`; null when that cannot be known. */
  const solid = (id: string, under: Rgba | null): Rgba | null => {
    if (id === BACKDROP) return page;
    const css = graph.css(id);
    const c = css ? read(css) : null;
    return !c ? null : c.a >= 1 ? c : under ? compositeOver(c, under) : null;
  };
  return pairs.map((pair): PairResult => {
    const under = pair.varyingGround ? null : page;
    const colorOf = (c: PairColor): Rgba | null => {
      if (typeof c === 'string') return solid(c, under);
      const [a, pa, b] = [solid(c.mix[0], under), c.mix[1] / 100, solid(c.mix[2], under)];
      // The two ends are opaque once painted over the page, so the mix is a plain weighted average.
      return a && b ? { r: a.r * pa + b.r * (1 - pa), g: a.g * pa + b.g * (1 - pa), b: a.b * pa + b.b * (1 - pa), a: 1 } : null;
    };
    const fg = graph.css(pair.fg);
    const fgRead = fg ? read(fg) : null;
    const bg = colorOf(pair.bg);
    if (!fgRead || !bg) return { status: 'unknown', pair };
    // Text with opacity, its colour's or its own, is seen as the colour it makes over its ground.
    const shown = compositeOver(pair.opacity === undefined ? fgRead : { ...fgRead, a: fgRead.a * pair.opacity }, bg);
    const ratio = contrastBetween(shown, bg);
    const min = pair.min ?? TEXT_CONTRAST;
    const measured = { pair, ratio, min, fg: toHex6(shown), bg: toHex6(bg) };
    return ratio >= min ? { status: 'pass', ...measured } : { status: 'fail', ...measured };
  });
}

/** A foreground the author can choose for a failing pair, and what it would leave hard to read. */
export interface ForegroundSuggestion {
  token: string;
  value: string;
  /** The pair's group with the suggestion applied. */
  after: PairResult[];
  /** True when every pair of the group is readable with it; false when a resting state is fixed at the cost of another (a hover colour). */
  everyState: boolean;
  /** Pairs that fail with it and did not before, anywhere in the theme (a light button on the same colour, a ground that follows it), worst first. */
  breaks: FailingPair[];
}

/**
 * A white, ink or black foreground that makes `failing` readable. One that keeps every pair of its group readable
 * wins, and among those the one that spoils the fewest other pairs (white, then ink, then black on a tie). Failing
 * that, a group with a single resting state still gets one that fixes it, saying what it costs (`everyState: false`).
 * A hover state gets none, and neither does a text color on several grounds with no choice for all of them: fixing
 * one ground would only undo another, and the offers would trade places. Null for a pair whose foreground is not
 * the author's to change, and when no choice helps.
 */
export function suggestForeground(tokens: TokenDef[], pairs: readonly ContrastPair[], failing: FailingPair, read: ColorReader = parseColor): ForegroundSuggestion | null {
  const { pair } = failing;
  if (pair.fixable === false) return null;
  const group = pairs.filter((p) => p.group === pair.group && p.fg === pair.fg);
  const before = new Map(evaluatePairs(tokens, pairs, read).map((r) => [r.pair.id, r.status]));
  const tries = READABLE_TEXT_COLORS.map((value) => {
    const overrides = { [pair.fg]: value };
    const after = evaluatePairs(tokens, group, read, overrides);
    const breaks = evaluatePairs(tokens, pairs, read, overrides)
      .filter(isFailing)
      .filter((r) => before.get(r.pair.id) !== 'fail')
      .sort((a, b) => a.ratio - b.ratio);
    // What read well and would not weighs most; a pair that only becomes measurable, and fails, breaks a tie.
    const spoiled = breaks.filter((r) => before.get(r.pair.id) === 'pass').length;
    return { value, after, breaks, spoiled, fixed: after.find((r) => r.pair.id === pair.id)?.status === 'pass', everyState: after.every((r) => r.status === 'pass') };
  });
  const fewest = <T extends { breaks: unknown[]; spoiled: number }>(list: T[]): T | undefined =>
    list.reduce<T | undefined>((best, t) => (!best || t.spoiled < best.spoiled || (t.spoiled === best.spoiled && t.breaks.length < best.breaks.length) ? t : best), undefined);
  const lone = pair.state === 'rest' && group.filter((p) => p.state === 'rest').length === 1;
  const best = fewest(tries.filter((t) => t.everyState)) ?? (lone ? fewest(tries.filter((t) => t.fixed)) : undefined);
  return best ? { token: pair.fg, value: best.value, after: best.after, everyState: best.everyState, breaks: best.breaks } : null;
}

/**
 * The pairs that involve a token, as foreground or background, hover mixes included. Given the project's tokens, also
 * the pairs whose colours follow it (Brand set to follow Accent: changing Accent changes the button).
 */
export function pairsOf(pairs: readonly ContrastPair[], tokenId: string, tokens: readonly TokenDef[] = []): ContrastPair[] {
  const affects = new Set([tokenId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of tokens) {
      const v = t.value;
      const ref = v && typeof v === 'object' && 'token' in v ? String((v as { token: unknown }).token) : null;
      if (ref && affects.has(ref) && !affects.has(t.id)) (affects.add(t.id), (grew = true));
    }
  }
  const ends = (p: ContrastPair) => [p.fg, ...(typeof p.bg === 'string' ? [p.bg] : [p.bg.mix[0], p.bg.mix[2]])];
  return pairs.filter((p) => ends(p).some((id) => affects.has(id)));
}
