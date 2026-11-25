/**
 * The palette made from a brand colour (#357): for any brand and mood, on every built-in theme, each pair the theme
 * sets against each other passes its WCAG minimum as saved, with the brand kept exactly wherever a page can carry it.
 * The pairs are measured again here with `evaluatePairs` on the saved #rrggbb values, not read back from the generator.
 */
import { describe, expect, it } from 'vitest';
import type { TokenDef } from '@shared/types';
import { parseColor, rgbToOklab } from '@shared/color';
import { contrastBetween, evaluatePairs, type ContrastPair } from '@shared/contrast';
import { PALETTE_MOODS, PALETTE_ROLES, darkPins, darkSection, harmonizePalette, oklchHex, paletteChanges, paletteSeed, type PaletteMood } from '@shared/palette';
import { compositeOver } from '@shared/contrast';
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
    // Every grey from #707070 to #787878 reads on neither page; the nearest that does on each side are #6f6f6f and
    // #797979, and the palette takes whichever is nearer the brand in lightness.
    for (const grey of ['#707070', '#787878']) expect(make(grey, 'tinted', 'signal').adjusted, grey).toBe(true);
    for (const grey of ['#6f6f6f', '#797979']) expect(make(grey, 'tinted', 'signal').adjusted, grey).toBe(false);
    const L = lch('#747474').L;
    const nearer = Math.abs(lch('#6f6f6f').L - L) < Math.abs(lch('#797979').L - L) ? '#6f6f6f' : '#797979';
    expect(h.brand).toBe(nearer);
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
    // Under dark text (a yellow button) the hover shade goes lighter instead, still further from the text.
    const y = make('#f5c518', 'tinted').values;
    expect(y['color.on-brand']).toBe('#14181a');
    expect(lch(y['color.brand-strong']!).L).toBeGreaterThan(lch('#f5c518').L);
    expect(ratio(y['color.on-brand']!, y['color.brand-strong']!)).toBeGreaterThan(ratio(y['color.on-brand']!, '#f5c518'));
  });

  it('turns warm grounds smoothly as the brand hue moves away from cream, and leaves a blue brand on cream', () => {
    const groundHue = (h: number) => lch(make(oklchHex(0.45, 0.12, h), 'warm').values['color.surface-alt']!).h;
    // Low-chroma grounds saved as 8-bit hex carry a few degrees of hue noise; a cut-off would jump by about 30°.
    for (let h = 20; h <= 140; h += 4) expect(Math.abs(groundHue(h + 4) - groundHue(h)), `${h}°`).toBeLessThan(10);
    expect(Math.abs(groundHue(260) - 75)).toBeLessThan(6);
  });

  it('keeps an accent the author chose, and still passes every pair', () => {
    const { tokens, pairs } = themeOf('foundation');
    const h = make('#1e3a5f', 'tinted', 'foundation', '#E9A23B');
    expect(h.values['color.accent']).toBe('#e9a23b');
    expect(make('#1e3a5f', 'tinted').values['color.accent']).not.toBe('#e9a23b');
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
  it('holds back a palette whose colours sit in a pair it cannot measure, and lets one through whose colours do not', () => {
    const custom = (id: string, value: string) => ({ id, label: id, group: 'color', value }) as TokenDef;
    const tokens = [...(getTheme('foundation').tokens as TokenDef[]), custom('color.custom-ink', 'var(--ink, #fff)'), custom('color.custom-paper', '#f0e6d2')];
    const onPage: ContrastPair = { id: 'ink-page', use: 'Ink on the page', fg: 'color.custom-ink', bg: 'color.background', state: 'rest', group: 'ink' };
    const apart: ContrastPair = { id: 'ink-paper', use: 'Ink on paper', fg: 'color.custom-ink', bg: 'color.custom-paper', state: 'rest', group: 'ink' };
    const theme = getTheme('foundation').contrastPairs ?? [];
    const held = harmonizePalette({ brand: '#1f5a4c', mood: 'tinted', tokens, pairs: [...theme, onPage] });
    expect(held.results.filter((r) => r.status !== 'pass').map((r) => [r.pair.id, r.status])).toEqual([['ink-page', 'unknown']]);
    expect(held.unreadable.map((r) => r.pair.id)).toEqual(['ink-page']);
    const through = harmonizePalette({ brand: '#1f5a4c', mood: 'tinted', tokens, pairs: [...theme, apart] });
    expect(through.results.filter((r) => r.status !== 'pass').map((r) => r.pair.id)).toEqual(['ink-paper']);
    expect(through.unreadable).toEqual([]);
    // A colour reader that can resolve it (the editor's asks the browser) measures the pair, and the palette keeps it
    // readable: white ink needs a dark page.
    const read = (css: string) => parseColor(css.replace('var(--ink, #fff)', '#ffffff'));
    const measured = harmonizePalette({ brand: '#1f5a4c', mood: 'tinted', tokens, pairs: [...theme, onPage], read });
    expect(measured.unreadable).toEqual([]);
    expect(measured.page).toBe('dark');
    expect(measured.results.find((r) => r.pair.id === 'ink-page')?.status).toBe('pass');
  });

  it('follows every way a palette colour reaches a pair it cannot measure, and lets an untouched one through', () => {
    const custom = (id: string, value: string) => ({ id, label: id, group: 'color', value }) as TokenDef;
    const theme = getTheme('foundation').contrastPairs ?? [];
    const pair = (id: string, fg: string, bg: string): ContrastPair => ({ id, use: id, fg, bg, state: 'rest', group: id });
    const tokens = [
      ...(getTheme('foundation').tokens as TokenDef[]),
      custom('color.custom-ink', 'var(--ink)'),
      // Brand by its CSS variable inside a mix: no token link, but the palette changes it all the same.
      custom('color.custom-tint', 'color-mix(in srgb, var(--so-color-brand) 100%, #fff)'),
      custom('color.custom-white', '#ffffff'),
      custom('color.custom-veil', 'rgb(0 0 0 / 0.2)')
    ];
    const blocked = (p: ContrastPair, brand = '#f5c518') => harmonizePalette({ brand, mood: 'neutral', tokens, pairs: [...theme, p] }).unreadable.map((r) => r.pair.id);
    expect(blocked(pair('tint-white', 'color.custom-tint', 'color.custom-white'))).toEqual(['tint-white']);
    // A see-through ground is seen over the page, which the palette changed.
    expect(blocked(pair('ink-veil', 'color.custom-ink', 'color.custom-veil'))).toEqual(['ink-veil']);
    // Unknown ink on a brand the palette leaves exactly as it is: nothing it measures moved.
    expect(blocked(pair('ink-brand', 'color.custom-ink', 'color.brand'), '#1f5a4c')).toEqual([]);
    expect(blocked(pair('ink-brand', 'color.custom-ink', 'color.brand'), '#1e3a5f')).toEqual(['ink-brand']);
  });

  it('follows a CSS variable through a relay, and never mistakes a longer name for a palette colour', () => {
    const custom = (id: string, value: unknown) => ({ id, label: id, group: 'color', value }) as TokenDef;
    const theme = getTheme('foundation').contrastPairs ?? [];
    const tokens = [
      ...(getTheme('foundation').tokens as TokenDef[]),
      custom('color.custom-relay', 'color-mix(in srgb, var(--so-color-brand) 100%, #fff)'),
      custom('color.custom-uses', 'var(--so-color-custom-relay)'),
      custom('color.custom-linked', { token: 'color.custom-uses' }),
      custom('color.custom-static', 'var(--so-color-brand-static, #000)'),
      custom('color.custom-white', '#ffffff')
    ];
    const blocked = (fg: string) =>
      harmonizePalette({ brand: '#f5c518', mood: 'neutral', tokens, pairs: [...theme, { id: fg, use: fg, fg, bg: 'color.custom-white', state: 'rest', group: fg }] }).unreadable.map((r) => r.pair.id);
    expect(blocked('color.custom-linked')).toEqual(['color.custom-linked']);
    // CSS function names are not case-sensitive.
    tokens.push(custom('color.custom-shout', 'color-mix(in srgb, VAR(--so-color-brand) 100%, #fff)'));
    expect(blocked('color.custom-shout')).toEqual(['color.custom-shout']);
    expect(blocked('color.custom-static')).toEqual([]);
  });

  it('is held back, naming the pair, when a fixed accent cannot be read on dark sections', () => {
    const h = make('#1e3a5f', 'tinted', 'foundation', '#000000');
    expect(h.values['color.accent']).toBe('#000000');
    expect(h.unreadable.map((r) => r.pair.id)).toEqual(['dark-accent']);
  });

  it('saves only colours the site does not show already, keeping a link that still lands on the palette colour', () => {
    const base = getTheme('foundation').tokens as TokenDef[];
    const h = make('#1e3a5f', 'tinted');
    const sea = { id: 'color.custom-sea', label: 'Sea', group: 'color', value: '#1E3A5F' } as TokenDef;
    const tokens = [...base.map((t) => (t.id === 'color.brand' ? { ...t, value: { token: 'color.custom-sea' } } : t.id === 'color.background' ? { ...t, value: h.values['color.background']!.toUpperCase() } : t)), sea] as TokenDef[];
    const changes = Object.fromEntries(paletteChanges(tokens, h.values));
    expect(changes['color.brand']).toBeUndefined(); // follows Sea, which is the brand
    expect(changes['color.background']).toBeUndefined(); // the same colour, written in capitals
    const opaque = tokens.map((t) => (t.id === 'color.custom-sea' ? { ...t, value: '#1e3a5fff' } : t)) as TokenDef[];
    expect(Object.fromEntries(paletteChanges(opaque, h.values))['color.brand']).toBeUndefined(); // and with full opacity spelled out
    expect(changes['color.on-brand']).toBeUndefined(); // already the theme's white
    expect(changes['color.surface-alt']).toBe(h.values['color.surface-alt']);
    // A link that would land elsewhere is replaced: Brand (strong) following Brand is not the hover shade.
    const linked = tokens.map((t) => (t.id === 'color.brand-strong' ? { ...t, value: { token: 'color.brand' } } : t)) as TokenDef[];
    expect(Object.fromEntries(paletteChanges(linked, h.values))['color.brand-strong']).toBe(h.values['color.brand-strong']);
    // A value that only rounds to the palette's colour is measured otherwise, so it is saved as the palette has it.
    const [L, a, b] = rgbToOklab(parseColor('#1e3a5f')!);
    const near = base.map((t) => (t.id === 'color.brand' ? { ...t, value: `oklab(${L + 0.0004} ${a} ${b})` } : t)) as TokenDef[];
    expect(parseColor(`oklab(${L + 0.0004} ${a} ${b})`)!.r).not.toBe(30);
    expect(Object.fromEntries(paletteChanges(near, h.values))['color.brand']).toBe('#1e3a5f');
    // Missing channels read as black alone, but a hover mix fills them from the other colour: saved as the palette has it.
    const none = base.map((t) => (t.id === 'color.on-brand' ? { ...t, value: 'rgb(none none none)' } : t)) as TokenDef[];
    const grey = make('#777777', 'neutral');
    expect(grey.values['color.on-brand']).toBe('#000000');
    expect(Object.fromEntries(paletteChanges(none, grey.values))['color.on-brand']).toBe('#000000');
  });

  it('pins the colours a dark palette takes from the light ones as it shows them, and leaves its own', () => {
    const light = getTheme('foundation').tokens.map((t) => (t.id === 'color.brand' ? { ...t, value: { token: 'color.accent' } } : t.id === 'color.muted' ? { ...t, value: 'color-mix(in srgb, #5c5f59 60%, white)' } : t)) as TokenDef[];
    const dark = { 'color.background': '#101010', 'color.accent': '#ffcc00', 'color.surface': { token: 'color.gone' } };
    const pins = Object.fromEntries(darkPins(light, dark, ['color.background', 'color.brand', 'color.text', 'color.surface', 'color.muted']));
    // Brand shows the dark accent through its link: pinned as that colour, written out. A dark link that lands
    // nowhere is no colour of its own, so Surface is pinned as the light one it shows. Muted, a mix the parser cannot
    // read, keeps its CSS exactly, so nothing rounds.
    expect(pins).toEqual({ 'color.brand': '#ffcc00', 'color.text': '#191a18', 'color.surface': '#ffffff', 'color.muted': 'color-mix(in srgb, #5c5f59 60%, white)' });
    // A colour nothing can show is left for the caller to measure.
    const gone = light.map((t) => (t.id === 'color.text' ? { ...t, value: { token: 'color.gone' } } : t)) as TokenDef[];
    expect(darkPins(gone, {}, ['color.text'])).toEqual([]);
  });
});

describe('colors the palette is made from and into', () => {
  it('reduces chroma, never lightness or hue, to bring a colour into sRGB', () => {
    const c = lch(oklchHex(0.9, 0.4, 260));
    expect(c.L).toBeCloseTo(0.9, 2);
    expect(Math.abs(c.h - 260)).toBeLessThan(3);
    // A colour sRGB already has keeps its chroma.
    expect(lch(oklchHex(0.6, 0.05, 200)).C).toBeCloseTo(0.05, 2);
    expect(oklchHex(1.2, 0.1, 30)).toBe('#ffffff');
    expect(oklchHex(-0.1, 0.1, 30)).toBe('#000000');
  });

  it('starts from the brand as the site shows it: links followed, a translucent one over the page, none that cannot be read', () => {
    const base = getTheme('foundation').tokens as TokenDef[];
    const set = (id: string, value: unknown) => base.map((t) => (t.id === id ? { ...t, value } : t)) as TokenDef[];
    expect(paletteSeed(set('color.brand', '#1E3A5F'))).toBe('#1e3a5f');
    expect(paletteSeed(set('color.brand', { token: 'color.accent' }))).toBe('#d98f48');
    expect(paletteSeed(set('color.brand', 'rgba(0, 0, 0, 0.5)'))).toBe('#7e7d7c');
    // Over a page of another colour, it is that page that shows through.
    const red = set('color.brand', 'rgba(0, 0, 0, 0.5)').map((t) => (t.id === 'color.background' ? { ...t, value: '#ff0000' } : t)) as TokenDef[];
    expect(paletteSeed(red)).toBe('#800000');
    // A page colour that cannot be read leaves the translucent brand unknown, never assumed to be over white.
    expect(paletteSeed(red.map((t) => (t.id === 'color.background' ? { ...t, value: 'var(--page)' } : t)) as TokenDef[])).toBeNull();
    expect(paletteSeed(set('color.brand', 'var(--x)'))).toBeNull();
  });

  it('makes dark sections dark enough for translucent text on them, as it shows, and no darker', () => {
    const text = parseColor('#ffffff96')!;
    for (const brand of ['#000000', '#1e3a5f']) {
      const section = parseColor(darkSection(brand, '#ffffff96'))!;
      expect(contrastBetween(compositeOver(text, section), section), brand).toBeGreaterThanOrEqual(7);
    }
    // Opaque text reads at 7:1 on the first try, keeping the brand's hue.
    const navy = darkSection('#1e3a5f', '#ffffff');
    expect(lch(navy).L).toBeCloseTo(0.2, 2);
    expect(Math.abs(lch(navy).h - lch('#1e3a5f').h)).toBeLessThan(10);
  });
});
