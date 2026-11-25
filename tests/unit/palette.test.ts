/**
 * The palette made from a brand colour (#357): for any brand and mood, on every built-in theme, each pair the theme
 * sets against each other passes its WCAG minimum as saved, with the brand kept exactly wherever a page can carry it.
 * The pairs are measured again here with `evaluatePairs` on the saved #rrggbb values, not read back from the generator.
 */
import { describe, expect, it } from 'vitest';
import type { TokenDef } from '@shared/types';
import { parseColor, rgbToOklab } from '@shared/color';
import { contrastBetween, evaluatePairs, type ContrastPair } from '@shared/contrast';
import { PALETTE_MOODS, PALETTE_ROLES, harmonizePalette, oklchHex, paletteSeed, type PaletteMood } from '@shared/palette';
import { getTheme } from '@catalogue/index';

/** Yellows, cyans, deep indigos, pastels, near-blacks and near-whites, saturated mid-tones, and the greys where Signal's eyebrow pill reads on neither page. */
const BRANDS = [
  '#f5c518', '#ffff00', '#ffd60a', '#eab308',
  '#00ffff', '#06b6d4', '#22d3ee',
  '#1e1b4b', '#312e81', '#4338ca',
  '#a7c7e7', '#f8c8dc', '#c1e1c1', '#fdfd96', '#e6e6fa',
  '#000000', '#0a0a0a', '#111827',
  '#ffffff', '#fafafa',
  '#777777', '#747474', '#707070', '#787878', '#0064fa', '#e11d48', '#d14131', '#22c55e', '#00ff00', '#ff00ff', '#f97316',
  '#1f5a4c', '#1e3a5f', '#6b2d5c', '#8b4513'
];
const THEMES = ['foundation', 'signal', 'editorial'];

const themeOf = (id: string) => {
  const theme = getTheme(id);
  expect(theme.id).toBe(id);
  return { tokens: theme.tokens as TokenDef[], pairs: theme.contrastPairs ?? [] };
};
const make = (brand: string, mood: PaletteMood, themeId = 'foundation', accent?: string) => harmonizePalette({ brand, mood, ...themeOf(themeId), accent });
const lch = (hex: string) => {
  const [L, a, b] = rgbToOklab(parseColor(hex)!);
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
};
const ratio = (a: string, b: string) => contrastBetween(parseColor(a)!, parseColor(b)!);

describe('every pair readable, for any brand and mood (#357)', () => {
  it(`passes every contrast pair of every built-in theme for ${BRANDS.length} brands in each mood`, () => {
    expect(BRANDS.length).toBeGreaterThanOrEqual(20);
    const failures: string[] = [];
    let checked = 0;
    for (const themeId of THEMES) {
      const { tokens, pairs } = themeOf(themeId);
      expect(pairs.length).toBeGreaterThan(10);
      for (const mood of PALETTE_MOODS)
        for (const brand of BRANDS) {
          const h = make(brand, mood, themeId);
          for (const role of PALETTE_ROLES) expect(h.values[role], `${themeId} ${mood} ${brand} ${role}`).toMatch(/^#[0-9a-f]{6}$/);
          for (const r of evaluatePairs(tokens, pairs, parseColor, h.values as Record<string, string>)) {
            checked++;
            if (r.status !== 'pass') failures.push(`${themeId} ${mood} ${brand}: ${r.pair.id} ${r.status}${r.status === 'fail' ? ` ${r.ratio.toFixed(3)} < ${r.min}` : ''}`);
          }
          expect(h.results.every((r) => r.status === 'pass'), `${themeId} ${mood} ${brand} reports its own pairs as passing`).toBe(true);
        }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(BRANDS.length * PALETTE_MOODS.length * THEMES.length * 20);
  });

  it('keeps the brand exactly wherever a page can carry it as text, which on Foundation and Editorial is every brand', () => {
    for (const themeId of ['foundation', 'editorial'])
      for (const mood of PALETTE_MOODS)
        for (const brand of BRANDS) {
          const h = make(brand, mood, themeId);
          expect(h.adjusted, `${themeId} ${mood} ${brand}`).toBe(false);
          expect(h.values['color.brand']).toBe(brand);
        }
    expect(make('#1f5a4c', 'tinted', 'signal')).toMatchObject({ adjusted: false, brand: '#1f5a4c' });
  });

  it("moves a mid-grey brand the least it must on Signal, whose tinted eyebrow pill reads on neither a white nor a black page, and says so", () => {
    const h = make('#747474', 'tinted', 'signal');
    expect(h).toMatchObject({ requested: '#747474', adjusted: true });
    expect(h.values['color.brand']).toBe(h.brand);
    expect(h.brand).not.toBe('#747474');
    // The smallest step that works: no more than a few 8-bit levels of grey either way, and still grey.
    expect(Math.abs(lch(h.brand).L - lch('#747474').L)).toBeLessThan(0.03);
    expect(lch(h.brand).C).toBeLessThan(0.005);
  });

  it('gives a brand that only reads on dark grounds a dark page, and a dark brand a light one', () => {
    for (const brand of ['#f5c518', '#ffff00', '#a7c7e7', '#ffffff', '#22d3ee']) {
      const h = make(brand, 'neutral');
      expect(h.page, brand).toBe('dark');
      expect(lch(h.values['color.background']!).L, brand).toBeLessThan(0.3);
      expect(lch(h.values['color.text']!).L, brand).toBeGreaterThan(0.8);
    }
    for (const brand of ['#1e3a5f', '#1f5a4c', '#6b2d5c', '#000000', '#4338ca']) {
      const h = make(brand, 'neutral');
      expect(h.page, brand).toBe('light');
      expect(lch(h.values['color.background']!).L, brand).toBeGreaterThan(0.95);
    }
  });

  it('is deterministic', () => {
    for (const mood of PALETTE_MOODS) expect(make('#6b2d5c', mood, 'signal')).toEqual(make('#6b2d5c', mood, 'signal'));
  });
});

describe('the palette follows the brand (#357)', () => {
  it('gives a cool navy brand cool grounds instead of the theme’s warm stone, more so when tinted', () => {
    const navy = lch('#1e3a5f').h;
    const neutral = make('#1e3a5f', 'neutral').values;
    const tinted = make('#1e3a5f', 'tinted').values;
    for (const id of ['color.background', 'color.surface-alt', 'color.border', 'color.muted'] as const) {
      expect(Math.abs(lch(tinted[id]!).h - navy), id).toBeLessThan(12);
      expect(lch(tinted[id]!).C, id).toBeGreaterThan(lch(neutral[id]!).C);
    }
    // Foundation's own alternate background is a warm stone; the navy one is not.
    expect(lch(getTheme('foundation').tokens.find((t) => t.id === 'color.surface-alt')!.value as string).h).toBeLessThan(120);
    expect(lch(tinted['color.surface-alt']!).h).toBeGreaterThan(200);
  });

  it('makes four distinct moods, with warm grounds leaning to cream and high contrast at the extremes', () => {
    const all = PALETTE_MOODS.map((m) => make('#1f5a4c', m).values);
    expect(new Set(all.map((v) => v['color.background'])).size).toBe(4);
    expect(new Set(all.map((v) => v['color.surface-alt'])).size).toBe(4);
    const warm = make('#1e3a5f', 'warm').values;
    expect(lch(warm['color.background']!).h).toBeGreaterThan(40);
    expect(lch(warm['color.background']!).h).toBeLessThan(110);
    const high = make('#1f5a4c', 'high-contrast').values;
    expect(ratio(high['color.text']!, high['color.background']!)).toBeGreaterThanOrEqual(15);
    expect(ratio(high['color.muted']!, high['color.background']!)).toBeGreaterThanOrEqual(7);
  });

  it('keeps hover, dark sections and accent in the brand’s hue, and the hover shade further from the text on the button', () => {
    const plum = lch('#6b2d5c');
    const v = make('#6b2d5c', 'tinted').values;
    for (const id of ['color.brand-strong', 'color.inverse'] as const) expect(Math.abs(lch(v[id]!).h - plum.h), id).toBeLessThan(10);
    expect(Math.abs(lch(v['color.accent']!).h - ((plum.h + 30) % 360))).toBeLessThan(10);
    expect(lch(v['color.brand-strong']!).L).toBeLessThan(plum.L);
    expect(ratio(v['color.on-brand']!, v['color.brand-strong']!)).toBeGreaterThan(ratio(v['color.on-brand']!, '#6b2d5c'));
  });

  it('keeps an accent the author chose, and still passes every pair', () => {
    const { tokens, pairs } = themeOf('foundation');
    const h = make('#1e3a5f', 'tinted', 'foundation', '#d98f48');
    expect(h.values['color.accent']).toBe('#d98f48');
    expect(evaluatePairs(tokens, pairs, parseColor, h.values as Record<string, string>).every((r) => r.status === 'pass')).toBe(true);
  });

  it('sets only the roles a theme has', () => {
    const tokens = getTheme('foundation').tokens.filter((t) => t.id !== 'color.focus') as TokenDef[];
    const h = harmonizePalette({ brand: '#1f5a4c', mood: 'neutral', tokens, pairs: [] });
    expect(Object.keys(h.values)).not.toContain('color.focus');
    expect(Object.keys(h.values)).toHaveLength(PALETTE_ROLES.length - 1);
  });

  it('reports a pair of a theme of its own that no palette can make readable, without moving the brand for it', () => {
    const { tokens } = themeOf('foundation');
    const impossible: ContrastPair = { id: 'self', use: 'Text on itself', fg: 'color.text', bg: 'color.text', state: 'rest', group: 'self' };
    const h = harmonizePalette({ brand: '#1f5a4c', mood: 'neutral', tokens, pairs: [...(getTheme('foundation').contrastPairs ?? []), impossible] });
    expect(h.adjusted).toBe(false);
    expect(h.results.filter((r) => r.status !== 'pass').map((r) => r.pair.id)).toEqual(['self']);
  });
});

describe('colors the palette is made from and into', () => {
  it('reduces chroma, never lightness or hue, to bring a colour into sRGB', () => {
    const c = lch(oklchHex(0.9, 0.4, 260));
    expect(c.L).toBeCloseTo(0.9, 2);
    expect(Math.abs(c.h - 260)).toBeLessThan(3);
    expect(oklchHex(1.2, 0.1, 30)).toBe('#ffffff');
    expect(oklchHex(-0.1, 0.1, 30)).toBe('#000000');
  });

  it('starts from the brand as the site shows it: links followed, a translucent one over the page, none that cannot be read', () => {
    const base = getTheme('foundation').tokens as TokenDef[];
    const set = (id: string, value: unknown) => base.map((t) => (t.id === id ? { ...t, value } : t)) as TokenDef[];
    expect(paletteSeed(set('color.brand', '#1E3A5F'))).toBe('#1e3a5f');
    expect(paletteSeed(set('color.brand', { token: 'color.accent' }))).toBe('#d98f48');
    expect(paletteSeed(set('color.brand', 'rgba(0, 0, 0, 0.5)'))).toBe('#7e7d7c');
    expect(paletteSeed(set('color.brand', 'var(--x)'))).toBeNull();
  });
});
