/**
 * Curated type scales and font pairings: one choice that sets the proportions of every heading and text size
 * at once, and one that sets the display and body fonts together. Site styles and the AI's update_site_brand
 * both apply them as one batch of ordinary `token.set` edits, so each is one undo step and every text style
 * stays editable on its own afterwards.
 */
import type { EditOperation } from './ops';
import type { TextStyleValue, TokenDef } from './types';
import { linkOf, textMetrics } from './styles';

/** The viewport widths a fluid size grows between: its smallest size up to a phone, its largest from a laptop up. */
export const FLUID_MIN_WIDTH = 360;
export const FLUID_MAX_WIDTH = 1280;

/** Rounded for CSS: at most four decimals and no trailing zeros. Callers keep values small enough to avoid exponents. */
const num = (n: number) => {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};
const rem = (px: number) => `${num(px / 16)}rem`;
const sensible = (n: number) => Number.isFinite(n) && n > 0 && n <= 10000;

/**
 * A size that grows with the window from `minPx` (at `minWidth` and below) to `maxPx` (at `maxWidth` and above),
 * as `clamp(min, intercept + slope, max)` in rem and vw; a fixed rem size when the two are equal.
 */
export function fluidSize(minPx: number, maxPx: number, minWidth = FLUID_MIN_WIDTH, maxWidth = FLUID_MAX_WIDTH): string {
  if (!sensible(minPx) || !sensible(maxPx) || maxPx < minPx || !sensible(minWidth) || !sensible(maxWidth) || maxWidth <= minWidth)
    throw new Error(`fluidSize(${minPx}, ${maxPx}) needs sizes and widths between 0 and 10000px, the smaller first.`);
  if (minPx === maxPx) return rem(minPx);
  const slope = (maxPx - minPx) / (maxWidth - minWidth);
  const intercept = minPx - slope * minWidth;
  const vw = `${num(slope * 100)}vw`;
  const preferred = num(intercept / 16) === '0' ? vw : intercept > 0 ? `${rem(intercept)} + ${vw}` : `${vw} - ${rem(-intercept)}`;
  return `clamp(${rem(minPx)}, ${preferred}, ${rem(maxPx)})`;
}

const PX_PER: Record<string, number> = { px: 1, rem: 16, em: 16 };

/**
 * A sum of rem, em, px and viewport-width terms ("1.4rem + 4.4vw", "3vw - 0.5rem") at a window width, in pixels.
 * Small, large and dynamic viewport widths are the window's width here. Null for anything else.
 */
function sumAt(expr: string, width: number): number | null {
  const s = expr.replace(/\s+/g, '');
  // The first term may go unsigned; every later one is joined by + or -.
  const first = /([+-]?)(\d*\.?\d+)(rem|em|px|[sld]?vw)/y;
  const next = /([+-])(\d*\.?\d+)(rem|em|px|[sld]?vw)/y;
  let total = 0;
  let at = 0;
  while (at < s.length) {
    const re = at === 0 ? first : next;
    re.lastIndex = at;
    const m = re.exec(s);
    if (!m) return null;
    const n = parseFloat(m[2]) * (m[1] === '-' ? -1 : 1);
    total += m[3].endsWith('vw') ? (n * width) / 100 : n * PX_PER[m[3]];
    at = re.lastIndex;
  }
  return at ? total : null;
}

/**
 * A font size as it renders at a window width, in pixels: a fixed rem, em or px size, or a clamp() of those and
 * viewport widths. Null for anything else (calc, min, max, custom properties), which the caller shows as written.
 */
export function sizeAtWidth(value: string, width: number): number | null {
  const v = value.trim().toLowerCase();
  const m = /^clamp\(([^,()]+),([^,()]+),([^,()]+)\)$/.exec(v);
  if (!m) {
    const fixed = /^(\d*\.?\d+)(rem|em|px)$/.exec(v);
    return fixed ? parseFloat(fixed[1]) * PX_PER[fixed[2]] : null;
  }
  const [lo, mid, hi] = [m[1], m[2], m[3]].map((x) => sumAt(x, width));
  if (lo === null || mid === null || hi === null) return null;
  // As in CSS: the preferred size held between the two, the smallest winning if it is the larger.
  return Math.max(lo, Math.min(mid, hi));
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
export const TYPE_SCALE_CHOICES = ['theme', ...TYPE_SCALE_IDS] as const;
export type TypeScaleChoice = (typeof TYPE_SCALE_CHOICES)[number];

/** One style in a scale: its size on a phone and on a desktop in whole pixels, its line height and its letter spacing. */
type RoleSpec = [minPx: number, maxPx: number, lineHeight: string, tracking: string];

export interface TypeScale {
  id: TypeScaleId;
  label: string;
  description: string;
  roles: Record<TypeScaleRole, RoleSpec>;
}

/**
 * Desktop heading steps of roughly 1.2, 1.25, 1.333 and 1.5, gentler on a phone, with body text that grows a
 * little and line heights that open up as text gets smaller. Heading 3 stays modest: the theme uses it for card
 * titles, plan names and questions. Whole pixels, so the size fields show each end exactly.
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
      'text.body': [16, 16, '1.5', '0em'],
      'text.small': [14, 14, '1.4', '0.005em']
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
      'text.h2': [26, 40, '1.16', '-0.018em'],
      'text.h3': [20, 24, '1.26', '-0.01em'],
      'text.lead': [19, 23, '1.55', '0em'],
      'text.body': [16, 18, '1.65', '0em'],
      'text.small': [14, 15, '1.5', '0.008em']
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
const TEXT_KEYS = ['family', 'size', 'lineHeight', 'weight', 'tracking', 'transform'] as const;
/** The letter cases the engine accepts on a text style. */
const CASES = ['none', 'uppercase', 'lowercase', 'capitalize'];

export function typeScale(id: TypeScaleId): TypeScale {
  return TYPE_SCALES.find((s) => s.id === id)!;
}

/** A preset's metrics for each style, its sizes written as fluid clamp() lengths. */
export function scaleMetrics(id: TypeScaleId): Record<TypeScaleRole, ScaleMetrics> {
  const roles = typeScale(id).roles;
  return Object.fromEntries(TYPE_SCALE_ROLES.map((r) => [r, { size: fluidSize(roles[r][0], roles[r][1]), lineHeight: roles[r][2], tracking: roles[r][3] }])) as Record<TypeScaleRole, ScaleMetrics>;
}

/**
 * The styles a scale can set in this site: those its theme declares as text styles that can be written out, by
 * the theme or by the project's own change to them. A theme without some of them simply has fewer.
 */
export function scaleRoles(themeTokens: TokenDef[], tokens: TokenDef[] = themeTokens): TypeScaleRole[] {
  return TYPE_SCALE_ROLES.filter((r) => {
    const declared = themeTokens.find((t) => t.id === r && t.group === 'text');
    return !!declared && (textMetrics(themeTokens, r) !== null || textMetrics(tokens, r, declared.value) !== null);
  });
}

/** What a choice sets on each style: a preset's metrics, or the theme's own (null where the theme has none to give). */
function targets(themeTokens: TokenDef[], tokens: TokenDef[], choice: TypeScaleChoice): Map<TypeScaleRole, ScaleMetrics | null> {
  const preset = choice === 'theme' ? null : scaleMetrics(choice);
  return new Map(
    scaleRoles(themeTokens, tokens).map((role) => {
      const m = preset ? preset[role] : textMetrics(themeTokens, role);
      return [role, m ? { size: m.size, lineHeight: m.lineHeight, tracking: m.tracking } : null];
    })
  );
}

const same = (a: unknown, b: unknown) => String(a ?? '').trim() === String(b ?? '').trim();
const sameScale = (a: ScaleMetrics, b: ScaleMetrics) => SCALE_KEYS.every((k) => same(a[k], b[k]));
/** Every metric equal, as the editor compares a text style with its theme value. */
function sameText(a: TextStyleValue, b: TextStyleValue): boolean {
  const fam = (v: TextStyleValue['family']) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '').trim());
  return fam(a.family) === fam(b.family) && SCALE_KEYS.every((k) => same(a[k], b[k])) && Number(a.weight) === Number(b.weight) && same(a.transform ?? 'none', b.transform ?? 'none');
}
const asStyle = (role: string, value: unknown): TokenDef[] => [{ id: role, label: role, group: 'text', value: value as TextStyleValue }];

/** The text styles a style follows through saved links, nearest first. */
function followed(tokens: TokenDef[], role: string): string[] {
  const out: string[] = [];
  for (let cur = linkOf(tokens.find((t) => t.id === role)?.value, 'text'); cur && cur !== role && !out.includes(cur); cur = linkOf(tokens.find((t) => t.id === cur)?.value, 'text')) out.push(cur);
  return out;
}

/**
 * A saved style that cannot be read as it stands (a metric missing or broken in a hand-edited document): the
 * theme's metrics with every saved metric that reads kept in place of the theme's, and which ones were kept.
 */
function repaired(role: string, saved: unknown, theme: TextStyleValue): { metrics: TextStyleValue; kept: Set<string> } {
  let out: Record<string, unknown> = { ...theme };
  const kept = new Set<string>();
  const fields = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  for (const k of TEXT_KEYS) {
    if (!Object.hasOwn(fields, k)) continue;
    const tried = { ...out, [k]: fields[k] };
    if (textMetrics(asStyle(role, tried), role)) (out = tried), kept.add(k);
  }
  return { metrics: textMetrics(asStyle(role, out), role)!, kept };
}

/** Whether the engine keeps these metrics through an edit of the others: a letter case it knows, a font that exists. */
function keepable(m: TextStyleValue, tokens: TokenDef[]): boolean {
  if (m.transform !== undefined && !CASES.includes(String(m.transform))) return false;
  const ref = m.family && typeof m.family === 'object' ? (m.family as { token?: unknown }).token : null;
  return ref === null || tokens.some((t) => t.id === ref && t.group === 'font');
}

export interface TypeScaleEdits {
  /** One batch of token.set edits: apply them together, as one step. */
  ops: EditOperation[];
  /** Styles left out because what they hold could not be kept through the change (fix them in Site styles). */
  unscalable: TypeScaleRole[];
}

/**
 * The edits that give the site a type scale, as one batch: each style the theme has takes the scale's size, line
 * height and letter spacing, and keeps its font, weight and case.
 * - A style already set that way is left alone; a changed one that ends up exactly as the theme writes it goes back
 *   to the theme. Choosing the theme's own scale leaves styles that were never changed alone, so one the theme
 *   writes as a link to another keeps following it.
 * - Only the three scale metrics are sent, and the engine keeps the rest. A style is edited before any style it
 *   follows through a saved link (by hand, or from an older version), so it is written out from what it shows
 *   before the batch, whatever the batch then does to the styles it followed.
 * - A saved style that cannot be read is sent whole, except the metrics it saved that read, which the engine keeps.
 * `tokens` are the site's styles with its changes (effectiveTokens), `overrides` the changes themselves.
 */
export function typeScaleOps(tokens: TokenDef[], themeTokens: TokenDef[], overrides: Record<string, unknown>, choice: TypeScaleChoice): TypeScaleEdits {
  const ops: EditOperation[] = [];
  const unscalable = new Set<TypeScaleRole>();
  const want = targets(themeTokens, tokens, choice);
  // A style that follows another has a longer chain of links than the one it follows, so it goes first.
  const order = [...want.keys()].sort((a, b) => followed(tokens, b).length - followed(tokens, a).length);
  for (const role of order) {
    const target = want.get(role);
    const changed = Object.hasOwn(overrides, role);
    if (!target || (choice === 'theme' && !changed)) continue;
    const declared = themeTokens.find((t) => t.id === role)!.value;
    const value = tokens.find((t) => t.id === role)?.value;
    const themeOwn = textMetrics(themeTokens, role);
    const readable = textMetrics(tokens, role, declared);
    const fix = readable || !themeOwn ? null : repaired(role, value, themeOwn);
    const current = readable ?? fix?.metrics;
    if (!current) continue;
    const next: TextStyleValue = { ...current, ...target };
    // Back to the theme only where the theme writes the style out itself: a link of the theme's would follow styles a scale does not set.
    const backToTheme = changed && !linkOf(declared, 'text') && !!themeOwn && sameText(next, themeOwn);
    const already = !!readable && !linkOf(value, 'text') && sameScale(readable, target);
    if (already && !(choice === 'theme' && backToTheme)) continue;
    if (!keepable(current, tokens)) {
      unscalable.add(role);
      continue;
    }
    const sent = fix ? Object.fromEntries(TEXT_KEYS.filter((k) => !fix.kept.has(k) || (SCALE_KEYS as readonly string[]).includes(k)).flatMap((k) => (next[k] === undefined ? [] : [[k, next[k]]]))) : { ...target };
    ops.push({ type: 'token.set', tokenId: role, value: backToTheme ? null : sent });
  }
  return { ops, unscalable: TYPE_SCALE_ROLES.filter((r) => unscalable.has(r)) };
}

/**
 * The choice the site's text styles match on every style the theme has, or null for sizes of their own. When the
 * theme's own sizes are also a preset's, the theme's is the one named.
 */
export function activeTypeScale(tokens: TokenDef[], themeTokens: TokenDef[]): TypeScaleChoice | null {
  return (
    TYPE_SCALE_CHOICES.find((choice) => {
      const want = targets(themeTokens, tokens, choice);
      return (
        want.size > 0 &&
        [...want].every(([role, target]) => {
          const m = textMetrics(tokens, role, themeTokens.find((t) => t.id === role)?.value);
          return !!target && !!m && sameScale(m, target);
        })
      );
    }) ?? null
  );
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

/** A pairing with the font stacks the theme ships for its two fonts. */
export interface AvailablePairing extends FontPairing {
  displayStack: string;
  bodyStack: string;
}

/** A shipped font: the name the font list shows, and its stack. */
export interface ShippedFont {
  name: string;
  stack: string;
}

/** The first family of a font stack as CSS reads it: no quotes, runs of spaces as one, any case. */
const firstFamily = (stack: string) =>
  (stack.split(',')[0] ?? '')
    .replace(/['"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** The pairings this site can use: both fonts are among those the theme ships. */
export function availablePairings(fonts: ShippedFont[]): AvailablePairing[] {
  const stackOf = (name: string) => fonts.find((f) => f.name.trim().toLowerCase() === name.toLowerCase())?.stack;
  return FONT_PAIRINGS.flatMap((p) => {
    const displayStack = stackOf(p.display);
    const bodyStack = stackOf(p.body);
    return displayStack && bodyStack ? [{ ...p, displayStack, bodyStack }] : [];
  });
}

/**
 * The pairing the display and body fonts show now (their stacks with any links followed), by the family each
 * stack starts with: the shipped font itself, not a project font of the same name. Null for fonts of their own.
 */
export function activePairing(pairings: AvailablePairing[], displayStack: string, bodyStack: string): AvailablePairing | null {
  return pairings.find((p) => firstFamily(p.displayStack) === firstFamily(displayStack) && firstFamily(p.bodyStack) === firstFamily(bodyStack)) ?? null;
}

/**
 * The edits that set both fonts to a pairing's shipped stacks, as one batch. A font already set to its stack is
 * left alone; one that follows another font is always set, since the other may be about to change.
 */
export function pairingOps(p: AvailablePairing, tokens: TokenDef[]): EditOperation[] {
  return (
    [
      ['font.display', p.displayStack],
      ['font.body', p.bodyStack]
    ] as const
  )
    .filter(([id, stack]) => {
      const v = tokens.find((t) => t.id === id)?.value;
      return typeof v !== 'string' || firstFamily(v) !== firstFamily(stack);
    })
    // A stack longer than a font style takes goes by the font's name, which the engine expands to the same stack.
    .map(([tokenId, stack]) => ({ type: 'token.set' as const, tokenId, value: stack.length <= 200 ? stack : tokenId === 'font.display' ? p.display : p.body }));
}
