/**
 * Curated type scales and font pairings: one choice that sets the proportions of every heading and text size
 * at once, and one that sets the display and body fonts together. Site styles and the AI's update_site_brand
 * both apply them as one batch of ordinary `token.set` edits, so each is one undo step and every text style
 * stays editable on its own afterwards.
 */
import type { EditOperation } from './ops';
import type { TextStyleValue, TokenDef } from './types';
import { textMetrics } from './styles';

/** The viewport widths a fluid size grows between: its smallest size up to a phone, its largest from a laptop up. */
export const FLUID_MIN_WIDTH = 360;
export const FLUID_MAX_WIDTH = 1280;

/** Rounded for CSS: at most four decimals, no trailing zeros, never exponent notation. */
const num = (n: number) => {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};
const rem = (px: number) => `${num(px / 16)}rem`;

/**
 * A size that grows with the window from `minPx` (at FLUID_MIN_WIDTH and below) to `maxPx` (at FLUID_MAX_WIDTH
 * and above), as `clamp(min, intercept + slope, max)` in rem and vw; a fixed rem size when the two are equal.
 */
export function fluidSize(minPx: number, maxPx: number, minWidth = FLUID_MIN_WIDTH, maxWidth = FLUID_MAX_WIDTH): string {
  if (!(minPx > 0) || !(maxPx > 0) || maxPx < minPx || !(maxWidth > minWidth)) throw new Error(`fluidSize(${minPx}, ${maxPx}) needs 0 < min <= max.`);
  if (minPx === maxPx) return rem(minPx);
  const slope = (maxPx - minPx) / (maxWidth - minWidth);
  const intercept = minPx - slope * minWidth;
  const vw = `${num(slope * 100)}vw`;
  const preferred = intercept === 0 ? vw : intercept > 0 ? `${rem(intercept)} + ${vw}` : `${vw} - ${rem(-intercept)}`;
  return `clamp(${rem(minPx)}, ${preferred}, ${rem(maxPx)})`;
}

const PX_PER: Record<string, number> = { px: 1, rem: 16, em: 16 };

/** A sum of rem, em, px and vw terms ("1.4rem + 4.4vw", "3vw - 0.5rem") at a viewport width, in pixels. */
function sumAt(expr: string, width: number): number | null {
  const s = expr.replace(/\s+/g, '');
  const re = /([+-]?)(\d*\.?\d+)(rem|em|px|vw)/y;
  let total = 0;
  let at = 0;
  while (at < s.length) {
    re.lastIndex = at;
    const m = re.exec(s);
    if (!m) return null;
    const n = parseFloat(m[2]) * (m[1] === '-' ? -1 : 1);
    total += m[3] === 'vw' ? (n * width) / 100 : n * PX_PER[m[3]];
    at = re.lastIndex;
  }
  return at ? total : null;
}

/**
 * A font size as it renders at a viewport width, in pixels: a fixed rem, em or px size, or a clamp() of those
 * and vw. Null for anything else (calc, min, max, custom properties), which the caller shows another way.
 */
export function sizeAtWidth(value: string, width: number): number | null {
  const v = value.trim();
  const m = /^clamp\(([^,()]+),([^,()]+),([^,()]+)\)$/i.exec(v);
  if (!m) {
    const fixed = /^(\d*\.?\d+)(rem|em|px)$/i.exec(v);
    return fixed ? parseFloat(fixed[1]) * PX_PER[fixed[2].toLowerCase()] : null;
  }
  const [lo, mid, hi] = [m[1], m[2], m[3]].map((x) => sumAt(x.toLowerCase(), width));
  if (lo === null || mid === null || hi === null) return null;
  return Math.min(Math.max(mid, lo), Math.max(lo, hi));
}

// ---------------------------------------------------------------------------
// Type scales
// ---------------------------------------------------------------------------

/** The text styles a type scale sets, largest first. Eyebrow and statistic styles keep their own character. */
export const TYPE_SCALE_ROLES = ['text.display', 'text.h1', 'text.h2', 'text.h3', 'text.lead', 'text.body', 'text.small'] as const;
export type TypeScaleRole = (typeof TYPE_SCALE_ROLES)[number];

export const TYPE_SCALE_IDS = ['compact', 'balanced', 'editorial', 'bold-display'] as const;
export type TypeScaleId = (typeof TYPE_SCALE_IDS)[number];
/** A preset, or the theme's own sizes. */
export type TypeScaleChoice = TypeScaleId | 'theme';
export const TYPE_SCALE_CHOICES = ['theme', ...TYPE_SCALE_IDS] as const;

/** One style in a scale: its size on a phone and on a desktop in pixels, its line height and its letter spacing. */
type RoleSpec = [minPx: number, maxPx: number, lineHeight: string, tracking: string];

export interface TypeScale {
  id: TypeScaleId;
  label: string;
  description: string;
  roles: Record<TypeScaleRole, RoleSpec>;
}

/**
 * Desktop heading steps of roughly 1.2, 1.25, 1.333 and 1.5, gentler on a phone, with body text that grows a
 * little and line heights that open up as text gets smaller.
 */
export const TYPE_SCALES: TypeScale[] = [
  {
    id: 'compact',
    label: 'Compact',
    description: 'Modest headings and tight spacing, so more fits on each screen.',
    roles: {
      'text.display': [27, 42, '1.12', '-0.02em'],
      'text.h1': [24, 35, '1.16', '-0.015em'],
      'text.h2': [21, 29, '1.2', '-0.01em'],
      'text.h3': [18, 20, '1.3', '-0.005em'],
      'text.lead': [17, 19, '1.45', '0em'],
      'text.body': [16, 16.5, '1.5', '0em'],
      'text.small': [13.5, 14, '1.4', '0.005em']
    }
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Clear steps between headings and comfortable text, for most sites.',
    roles: {
      'text.display': [34, 54, '1.08', '-0.025em'],
      'text.h1': [29, 43, '1.12', '-0.02em'],
      'text.h2': [25, 34, '1.18', '-0.015em'],
      'text.h3': [19, 22, '1.3', '-0.01em'],
      'text.lead': [18, 21, '1.5', '0em'],
      'text.body': [16, 17, '1.6', '0em'],
      'text.small': [14, 15, '1.45', '0.005em']
    }
  },
  {
    id: 'editorial',
    label: 'Editorial',
    description: 'Larger headings and roomy, slightly bigger text for reading.',
    roles: {
      'text.display': [38, 72, '1.06', '-0.03em'],
      'text.h1': [32, 54, '1.1', '-0.025em'],
      'text.h2': [26, 40.5, '1.16', '-0.018em'],
      'text.h3': [20, 24, '1.26', '-0.01em'],
      'text.lead': [19, 22.5, '1.55', '0em'],
      'text.body': [16.5, 18, '1.65', '0em'],
      'text.small': [14, 15.5, '1.5', '0.008em']
    }
  },
  {
    id: 'bold-display',
    label: 'Bold display',
    description: 'Dramatic, tightly set headlines over plain, steady text.',
    roles: {
      'text.display': [42, 108, '1.02', '-0.035em'],
      'text.h1': [34, 72, '1.06', '-0.03em'],
      'text.h2': [27, 48, '1.12', '-0.02em'],
      'text.h3': [20, 24, '1.22', '-0.012em'],
      'text.lead': [19, 22, '1.5', '0em'],
      'text.body': [16, 17, '1.55', '0em'],
      'text.small': [14, 15, '1.45', '0.005em']
    }
  }
];

/** What a scale sets on each text style; the font, weight and letter case are left as they are. */
export type ScaleMetrics = Pick<TextStyleValue, 'size' | 'lineHeight' | 'tracking'>;
const SCALE_KEYS = ['size', 'lineHeight', 'tracking'] as const;

export function typeScale(id: TypeScaleId): TypeScale {
  return TYPE_SCALES.find((s) => s.id === id)!;
}

/** A preset's metrics for each style, its sizes written as fluid clamp() lengths. */
export function scaleMetrics(id: TypeScaleId): Record<TypeScaleRole, ScaleMetrics> {
  const roles = typeScale(id).roles;
  return Object.fromEntries(TYPE_SCALE_ROLES.map((r) => [r, { size: fluidSize(roles[r][0], roles[r][1]), lineHeight: roles[r][2], tracking: roles[r][3] }])) as Record<TypeScaleRole, ScaleMetrics>;
}

/** The styles a scale can set in this site: those its theme declares as text styles, which have a theme value to go back to. */
export function scaleRoles(themeTokens: TokenDef[]): TypeScaleRole[] {
  return TYPE_SCALE_ROLES.filter((r) => themeTokens.some((t) => t.id === r && t.group === 'text'));
}

/** What a choice sets on each style the theme has: a preset's metrics, or the theme's own. */
function targets(themeTokens: TokenDef[], choice: TypeScaleChoice): Map<TypeScaleRole, ScaleMetrics> {
  const out = new Map<TypeScaleRole, ScaleMetrics>();
  const preset = choice === 'theme' ? null : scaleMetrics(choice);
  for (const role of scaleRoles(themeTokens)) {
    const m = preset ? preset[role] : textMetrics(themeTokens, role);
    if (m) out.set(role, { size: m.size, lineHeight: m.lineHeight, tracking: m.tracking });
  }
  return out;
}

const same = (a: unknown, b: unknown) => String(a ?? '').trim() === String(b ?? '').trim();
const sameScale = (a: ScaleMetrics, b: ScaleMetrics) => SCALE_KEYS.every((k) => same(a[k], b[k]));
/** Every metric equal, as the editor compares a text style with its theme value. */
function sameText(a: TextStyleValue, b: TextStyleValue): boolean {
  const fam = (v: TextStyleValue['family']) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '').trim());
  return fam(a.family) === fam(b.family) && SCALE_KEYS.every((k) => same(a[k], b[k])) && Number(a.weight) === Number(b.weight) && same(a.transform ?? 'none', b.transform ?? 'none');
}
const isLink = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && 'token' in v && !SCALE_KEYS.some((k) => k in (v as object));

/**
 * The edits that give the site a type scale, as one batch: each style the theme has takes the scale's size, line
 * height and letter spacing, and keeps its font, weight and case. A style already set that way is left alone; one
 * that ends up exactly as the theme has it goes back to the theme. A style saved as a link to another text style
 * (by hand, or from an older version) is always written out, so the style it follows changing later in the same
 * batch cannot carry it along. `tokens` are the site's styles with its changes (effectiveTokens).
 */
export function typeScaleOps(tokens: TokenDef[], themeTokens: TokenDef[], choice: TypeScaleChoice): EditOperation[] {
  const ops: EditOperation[] = [];
  for (const [role, target] of targets(themeTokens, choice)) {
    const declared = themeTokens.find((t) => t.id === role)!.value;
    const value = tokens.find((t) => t.id === role)?.value;
    // What the style is written out with now: its own, the style it follows, or the theme's when it cannot be read.
    const readable = textMetrics(tokens, role, declared);
    const current = readable ?? textMetrics(themeTokens, role);
    if (!current) continue;
    if (!isLink(value) && sameScale(current, target)) continue;
    const next: TextStyleValue = { ...current, ...target };
    const theme = isLink(declared) ? null : textMetrics(themeTokens, role);
    if (theme && sameText(next, theme)) ops.push({ type: 'token.set', tokenId: role, value: null });
    // The engine keeps the font, weight and case it can read; when it cannot read them, the whole style is written out.
    else ops.push({ type: 'token.set', tokenId: role, value: readable ? { ...target } : next });
  }
  return ops;
}

/** The choice the site's text styles match on every style the theme has, or null for a mix of its own. */
export function activeTypeScale(tokens: TokenDef[], themeTokens: TokenDef[]): TypeScaleChoice | null {
  if (!scaleRoles(themeTokens).length) return null;
  const matches = TYPE_SCALE_CHOICES.filter((choice) => {
    const want = targets(themeTokens, choice);
    return want.size > 0 && [...want].every(([role, target]) => {
      const m = textMetrics(tokens, role, themeTokens.find((t) => t.id === role)?.value);
      return !!m && sameScale(m, target);
    });
  });
  return matches.length === 1 ? matches[0] : null;
}

// ---------------------------------------------------------------------------
// Font pairings
// ---------------------------------------------------------------------------

export interface FontPairing {
  id: string;
  /** The fonts by the names the font list shows. */
  display: string;
  body: string;
  /** The character the pair gives a site, in a few words. */
  note: string;
}

/** Display and body fonts that work together, from the fonts the theme ships. */
export const FONT_PAIRINGS: FontPairing[] = [
  { id: 'fraunces-inter', display: 'Fraunces', body: 'Inter', note: 'Warm and approachable' },
  { id: 'playfair-lora', display: 'Playfair Display', body: 'Lora', note: 'Classic and literary' },
  { id: 'lora-dm-sans', display: 'Lora', body: 'DM Sans', note: 'Calm and considered' },
  { id: 'space-grotesk-dm-sans', display: 'Space Grotesk', body: 'DM Sans', note: 'Modern and technical' },
  { id: 'jakarta-inter', display: 'Plus Jakarta Sans', body: 'Inter', note: 'Clean and friendly' }
];

/** The first family of a font stack as the font list names it: no quotes, no "Variable". */
export function primaryFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').replace(/['"]/g, '').replace(/\s+Variable$/i, '').trim();
}

const key = (name: string) => name.trim().toLowerCase();

/** The pairings this site can use: both fonts are among `fontNames` (the fonts the theme ships). */
export function availablePairings(fontNames: string[]): FontPairing[] {
  const have = new Set(fontNames.map(key));
  return FONT_PAIRINGS.filter((p) => have.has(key(p.display)) && have.has(key(p.body)));
}

/** The pairing the display and body fonts are set to now, by their first family, or null. */
export function activePairing(pairings: FontPairing[], displayStack: string, bodyStack: string): FontPairing | null {
  return pairings.find((p) => key(p.display) === key(primaryFamily(displayStack)) && key(p.body) === key(primaryFamily(bodyStack))) ?? null;
}

/** The edits that set both fonts to a pairing, as one batch; a font already set is left alone. */
export function pairingOps(p: FontPairing, displayStack: string, bodyStack: string): EditOperation[] {
  const ops: EditOperation[] = [];
  if (key(primaryFamily(displayStack)) !== key(p.display)) ops.push({ type: 'token.set', tokenId: 'font.display', value: p.display });
  if (key(primaryFamily(bodyStack)) !== key(p.body)) ops.push({ type: 'token.set', tokenId: 'font.body', value: p.body });
  return ops;
}
