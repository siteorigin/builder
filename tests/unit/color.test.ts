import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { colorFromPicker, opacityOf, paintableColor, parseColor, pickerHex, retirePicks, toHex6 } from '@shared/color';
import { validateStyleValue } from '@shared/styles';
import { effectiveTokens } from '@generator/index';
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from '../../src/main/project/session';

/** Each channel within `tol` of the expected hex, for colour spaces whose maths rounds differently from a browser's. */
function near(value: string, expected: string, tol = 1) {
  const got = parseColor(value)!;
  const want = parseColor(expected)!;
  expect(got, value).not.toBeNull();
  for (const k of ['r', 'g', 'b'] as const) expect(Math.abs(got[k] - want[k]), `${value} ${k}`).toBeLessThanOrEqual(tol);
}

describe('parseColor', () => {
  it('reads every hex length, in either case', () => {
    expect(pickerHex('#d14131')).toBe('#d14131');
    expect(pickerHex('#D14131')).toBe('#d14131');
    expect(pickerHex('#abc')).toBe('#aabbcc');
    expect(pickerHex('#ABC')).toBe('#aabbcc');
    expect(opacityOf('#d1413180')).toBeCloseTo(128 / 255, 5);
    expect(pickerHex('#d1413180')).toBe('#d14131');
    expect(opacityOf('#abc8')).toBeCloseTo(136 / 255, 5);
    expect(pickerHex('#abc8')).toBe('#aabbcc');
    expect(opacityOf('#d14131')).toBe(1);
    expect(opacityOf('#d14131ff')).toBe(1);
  });

  it('reads rgb() in the legacy and the modern syntax', () => {
    expect(pickerHex('rgb(209, 65, 49)')).toBe('#d14131');
    expect(pickerHex('rgb(209 65 49)')).toBe('#d14131');
    expect(pickerHex('RGB( 209 , 65 , 49 )')).toBe('#d14131');
    expect(pickerHex('rgba(209, 65, 49, 0.5)')).toBe('#d14131');
    expect(opacityOf('rgba(209, 65, 49, 0.5)')).toBe(0.5);
    expect(opacityOf('rgb(209 65 49 / 0.25)')).toBe(0.25);
    expect(opacityOf('rgb(209 65 49 / 40%)')).toBe(0.4);
    expect(opacityOf('rgb(209, 65, 49)')).toBe(1);
    expect(opacityOf('rgb(1 2 3/0.5)')).toBe(0.5);
    expect(opacityOf('rgb(1 2 3 /0.5)')).toBe(0.5);
    expect(opacityOf('rgb(1,2,3,.5)')).toBe(0.5);
    expect(pickerHex('rgb(1,2,3,.5)')).toBe('#010203');
    expect(pickerHex('rgb(100% 0% 0% / 50%)')).toBe('#ff0000');
    expect(pickerHex('rgb(none 0 0)')).toBe('#000000');
    expect(pickerHex('rgb(none 255 0)')).toBe('#00ff00');
    expect(pickerHex('rgb(5.5 10 20)')).toBe('#060a14');
    expect(pickerHex('rgb(.5 1e1 +20)')).toBe('#010a14');
    expect(pickerHex('rgb(10% 20 30)')).toBe('#1a141e');
  });

  it('refuses what CSS refuses, so the picker never starts from text the page would not paint', () => {
    for (const v of [
      'rgb(209, 65 49)', 'rgb(209 65, 49)', 'rgb(209,65,49,)', 'rgb(209,65,49 / .4)', 'rgb(209 65 49 .4)', 'rgb(209 65 49 / )', 'rgb(209 65 49 / 1 2)',
      'rgb(10%, 20, 30)', 'rgb(NONE, 0, 0)', 'rgb(0, 0, 0, none)', 'rgb(5. 10 20)', 'rgb(1 2 3 / .4 / .5)',
      'hsl(120, 50, 50)', 'hsl(120, none, 50%)', 'oklab(0.5, 0.1, 0.1)', 'lab(50, 10, 10)', 'oklch(0.5 0.1)', 'rgb()', 'rgb(, , )'
    ]) {
      expect(parseColor(v), v).toBeNull();
    }
  });

  it('clamps what CSS clamps', () => {
    expect(pickerHex('rgb(300, -5, 0)')).toBe('#ff0000');
    expect(opacityOf('rgb(0 0 0 / 2)')).toBe(1);
    expect(opacityOf('rgb(0 0 0 / -1)')).toBe(0);
  });

  it('reads hsl() with every hue unit', () => {
    expect(pickerHex('hsl(0 100% 50%)')).toBe('#ff0000');
    expect(pickerHex('hsl(120, 100%, 25%)')).toBe('#008000');
    expect(pickerHex('hsl(120deg 100% 25%)')).toBe('#008000');
    expect(pickerHex('hsl(0.5turn 100% 50%)')).toBe('#00ffff');
    expect(pickerHex('hsl(200grad 100% 50%)')).toBe('#00ffff');
    expect(pickerHex('hsl(3.14159265rad 100% 50%)')).toBe('#00ffff');
    expect(pickerHex('hsl(-120 100% 50%)')).toBe('#0000ff');
    expect(pickerHex('hsl(0 0% 100%)')).toBe('#ffffff');
    expect(opacityOf('hsla(180, 100%, 50%, 0.3)')).toBe(0.3);
    expect(pickerHex('hsl(120 50 50)')).toBe('#40bf40');
  });

  it('clamps legacy hsl() saturation and lightness, and clips the channels of the modern syntax', () => {
    expect(pickerHex('hsl(30, 120%, 60%)')).toBe('#ff9933');
    expect(pickerHex('hsl(30 120% 60%)')).toBe('#ff991f');
    expect(pickerHex('hsl(30 200% 120%)')).toBe('#ccffff');
    expect(pickerHex('hsl(30, 200%, 120%)')).toBe('#ffffff');
    expect(pickerHex('hsl(30 -50% 50%)')).toBe('#808080');
    expect(pickerHex('hsl(30 200% -20%)')).toBe('#000000');
    // A huge percentage is still a valid number: the maths must not overflow before it is divided.
    expect(pickerHex('hsl(30 1e307% 50%)')).toBe('#ff8000');
  });

  it('reads the modern colour spaces, clamped into sRGB', () => {
    near('oklch(0.628 0.2577 29.23)', '#ff0000', 2);
    near('oklch(62.8% 0.2577 29.23deg)', '#ff0000', 2);
    near('oklab(0.628 0.2249 0.1258)', '#ff0000', 2);
    near('lab(54.2905 80.8049 69.891)', '#ff0000', 2);
    near('lch(54.2905 106.8386 40.8526)', '#ff0000', 2);
    // Mid-tones, where the transfer curve and the matrices matter (a red alone cannot tell them from linear scaling).
    near('oklch(0.7 0.1 200)', '#40b1b7');
    near('lab(60 -30 40)', '#6a9e45');
    near('lch(70 40 280)', '#97a9f3');
    // Percentages scale to each channel's reference range: 100% chroma is 0.4 in OKLCH, 125 in Lab, 150 in LCH.
    expect(pickerHex('oklch(70% 25% 200)')).toBe(pickerHex('oklch(0.7 0.1 200)'));
    expect(pickerHex('lab(60% -24% 32%)')).toBe(pickerHex('lab(60 -30 40)'));
    expect(pickerHex('lch(70% 30% 280)')).toBe(pickerHex('lch(70 45 280)'));
    expect(pickerHex('oklab(70% -25% 12.5%)')).toBe(pickerHex('oklab(0.7 -0.1 0.05)'));
    expect(pickerHex('oklch(1 0 0)')).toBe('#ffffff');
    expect(pickerHex('oklch(0 0 0)')).toBe('#000000');
    expect(pickerHex('lab(100 0 0)')).toBe('#ffffff');
    expect(pickerHex('lab(0 0 0)')).toBe('#000000');
    expect(opacityOf('oklch(0.628 0.2577 29.23 / 0.5)')).toBe(0.5);
    expect(opacityOf('oklab(0.628 0.2249 0.1258 / 0.5)')).toBe(0.5);
    expect(opacityOf('lab(54.2905 80.8049 69.891 / 0.5)')).toBe(0.5);
    expect(opacityOf('lch(54.2905 106.8386 40.8526 / 0.5)')).toBe(0.5);
    // Out of gamut: it clips to the nearest channel values rather than failing.
    expect(parseColor('oklch(0.7 0.4 150)')).not.toBeNull();
  });

  it('reads the keywords the editor accepts', () => {
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(pickerHex('white')).toBe('#ffffff');
    expect(pickerHex('BLACK')).toBe('#000000');
    expect(opacityOf('white')).toBe(1);
    expect(opacityOf('black')).toBe(1);
    expect(opacityOf('transparent')).toBe(0);
  });

  it('gives null for numbers that overflow rather than a color with NaN channels', () => {
    for (const v of ['hsl(1e308turn 100% 50%)', 'oklab(0.7 1e200 1e200)', 'oklch(0.7 1e308 40)', 'lab(50 1e308 1e308)', 'rgb(1e999 0 0)']) {
      const c = parseColor(v);
      expect(c === null || [c.r, c.g, c.b, c.a].every(Number.isFinite), v).toBe(true);
    }
    expect(parseColor('hsl(1e308turn 100% 50%)')).toBeNull();
    expect(parseColor('oklab(0.7 1e200 1e200)')).toBeNull();
    // Only the blue channel overflows here: checking just the first would let it through.
    expect(parseColor('oklab(0.7 1e200 -2.5e199)')).toBeNull();
    expect(parseColor('lab(50 1e200 -2.5e199)')).toBeNull();
  });

  it('gives null, never black, for what it cannot resolve', () => {
    for (const v of ['', 'currentcolor', 'var(--so-color-brand)', 'color-mix(in srgb, #fff 50%, #000)', 'rgb(from #fff r g b)', '#12345', '#1234567', '#12', '#xyz', 'rgb(1 2)', 'rgb(1 2 3', 'rgb(1 2 3 4 5)', 'rgb(a b c)', 'hsl(red 1% 1%)', 'calc(1)', 'red']) {
      expect(parseColor(v), v).toBeNull();
      expect(pickerHex(v), v).toBeNull();
    }
    expect(opacityOf('currentcolor')).toBe(1);
  });

  it('resolves everything the site accepts that does not depend on another value', () => {
    const accepted = ['#abc', '#abcd', '#d14131', '#d1413180', 'rgb(209, 65, 49)', 'rgba(209, 65, 49, 0.5)', 'rgb(209 65 49 / 50%)', 'hsl(10 63% 50%)', 'oklch(0.6 0.2 30)', 'lab(50 40 30)', 'white', 'black', 'transparent'];
    for (const v of accepted) {
      expect(validateStyleValue('color', v), v).toBeNull();
      expect(parseColor(v), v).not.toBeNull();
    }
    // The editor's check is looser than CSS: these pass it, and the parser must not invent a color for them.
    for (const v of ['rgb(209, 65 49)', '#abcde', 'rgb(209,65,49,)']) {
      expect(validateStyleValue('color', v), v).toBeNull();
      expect(parseColor(v), v).toBeNull();
    }
    // What the editor accepts but only a browser can resolve stays unresolved here, on purpose.
    for (const v of ['currentcolor', 'color-mix(in srgb, #fff 50%, #000)']) {
      expect(validateStyleValue('color', v), v).toBeNull();
      expect(parseColor(v), v).toBeNull();
    }
  });
});

describe('toHex6', () => {
  it('rounds each channel and ignores opacity', () => {
    expect(toHex6({ r: 209.4, g: 64.5, b: 48.6, a: 0.2 })).toBe('#d14131');
    expect(toHex6({ r: 0, g: 127.5, b: 255, a: 1 })).toBe('#0080ff');
    expect(toHex6({ r: -4, g: 300, b: 0.4, a: 1 })).toBe('#00ff00');
    expect(toHex6({ r: 0, g: 0, b: 300, a: 1 })).toBe('#0000ff');
  });
});

describe('colorFromPicker', () => {
  it('saves a plain #rrggbb over an opaque colour, whatever notation it was in', () => {
    for (const was of ['#d14131', '#abc', 'rgb(209, 65, 49)', 'hsl(10 63% 50%)', 'rgb(209 65 49 / 1)', '#d14131ff', 'oklch(0.6 0.2 30)']) {
      expect(colorFromPicker(was, '#c0392b'), was).toBe('#c0392b');
    }
  });

  it('saves a plain #rrggbb over the transparent keyword, which names no color of its own', () => {
    expect(colorFromPicker('transparent', '#c0392b')).toBe('#c0392b');
    expect(colorFromPicker(' TRANSPARENT ', '#c0392b')).toBe('#c0392b');
  });

  it('keeps an explicit zero opacity, since the picker has no opacity control to bring it back', () => {
    expect(colorFromPicker('rgb(0 0 0 / 0)', '#c0392b')).toBe('rgb(192 57 43 / 0)');
    expect(colorFromPicker('rgba(0, 0, 0, 0)', '#c0392b')).toBe('rgba(192, 57, 43, 0)');
    expect(colorFromPicker('#d1413100', '#0000ff')).toBe('#0000ff00');
    expect(colorFromPicker('#d130', '#0000ff')).toBe('#0000ff00');
  });

  it('saves a plain #rrggbb over a value it cannot resolve', () => {
    expect(colorFromPicker('currentcolor', '#c0392b')).toBe('#c0392b');
    expect(colorFromPicker('', '#c0392b')).toBe('#c0392b');
  });

  it('keeps the opacity of a translucent colour and its notation where it can', () => {
    expect(colorFromPicker('#d1413180', '#c0392b')).toBe('#c0392b80');
    expect(colorFromPicker('#D14131A0', '#C0392B')).toBe('#c0392ba0');
    expect(colorFromPicker('#abc8', '#c0392b')).toBe('#c0392b88');
    expect(colorFromPicker('rgba(209, 65, 49, 0.5)', '#c0392b')).toBe('rgba(192, 57, 43, 0.5)');
    expect(colorFromPicker('rgb(209 65 49 / 0.35)', '#c0392b')).toBe('rgb(192 57 43 / 0.35)');
    expect(colorFromPicker('rgb(209 65 49 / 40%)', '#c0392b')).toBe('rgb(192 57 43 / 0.4)');
    expect(colorFromPicker('hsl(10 63% 50% / 0.2)', '#c0392b')).toBe('rgb(192 57 43 / 0.2)');
    expect(colorFromPicker('oklch(0.6 0.2 30 / 0.2)', '#c0392b')).toBe('rgb(192 57 43 / 0.2)');
    expect(colorFromPicker('rgb(209 65 49 / 0.0004)', '#c0392b')).toBe('rgb(192 57 43 / 0.0004)');
    // A tiny alpha stays tiny: rounding it to 0 or 1 would change what the next pick does.
    expect(colorFromPicker('rgb(209 65 49 / 0.0000004)', '#c0392b')).toBe('rgb(192 57 43 / 4e-7)');
    expect(colorFromPicker('rgb(209 65 49 / 0.123456789)', '#c0392b')).toBe('rgb(192 57 43 / 0.123456789)');
    expect(colorFromPicker('rgb(209 65 49 / 0.9999996)', '#c0392b')).toBe('rgb(192 57 43 / 0.9999996)');
    expect(colorFromPicker('  RGBA(209, 65, 49, 0.5) ', '#c0392b')).toBe('rgba(192, 57, 43, 0.5)');
    // A colour only a browser could resolve keeps its opacity too.
    expect(colorFromPicker('color-mix(in srgb, #d14131 50%, transparent)', '#c0392b', { r: 209, g: 65, b: 49, a: 0.5 })).toBe('rgb(192 57 43 / 0.5)');
  });

  it('rewrites nothing when the picked colour is the one the picker showed', () => {
    for (const was of ['rgb(209, 65, 49)', '#abc', 'rgba(209, 65, 49, 0.5)', '#d1413180', 'hsl(10 63% 50% / 0.2)']) {
      expect(colorFromPicker(was, pickerHex(was)!), was).toBe(was);
    }
  });

  it('keeps the colour it was given for a picked value it cannot read', () => {
    expect(colorFromPicker('rgb(209, 65, 49)', 'not a color')).toBe('rgb(209, 65, 49)');
    expect(colorFromPicker('rgb(209, 65, 49)', '#xyz')).toBe('rgb(209, 65, 49)');
  });
});

describe('paintableColor', () => {
  it('paints colors and gradients, and nothing that could load a resource or has no color of its own', () => {
    for (const v of ['#d14131', 'rgb(209, 65, 49)', 'rgba(209 65 49 / 0.5)', 'color-mix(in srgb, #f00 50%, #00f)', 'linear-gradient(red, blue)', 'var(--so-color-brand)']) expect(paintableColor(v), v).toBe(true);
    for (const v of ['', '   ', 'currentcolor', 'CurrentColor', 'url(http://127.0.0.1:1/x.png)', 'url("x") red', 'image-set("a.png" 1x)', 'red; background: blue', '#fff /* x */', 'red}']) expect(paintableColor(v), v).toBe(false);
  });
});

describe('retirePicks', () => {
  it('retires the picks up to the saved one, and all of them for a value nobody here sent', () => {
    expect(retirePicks(['#00f', '#0f0'], '#00f')).toEqual(['#0f0']);
    expect(retirePicks(['#00f', '#0f0'], '#0f0')).toEqual([]);
    expect(retirePicks(['#00f', '#0f0'], '#f00')).toEqual([]);
    expect(retirePicks([], '#f00')).toEqual([]);
    // Out and back to the same color: the first match retires itself, the rest are still on their way.
    expect(retirePicks(['#00f', '#0f0', '#00f'], '#00f')).toEqual(['#0f0', '#00f']);
  });
});

describe('a saved colour through save, reopen, adjust and undo', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  const brand = (s: ProjectSession) => effectiveTokens(s.state).find((t) => t.id === 'color.brand')!.value as string;

  // What the picker would start from and save on the way, for each representation the issue names.
  const cases: Array<{ label: string; saved: string; start: string; opacity: number; adjusted: string }> = [
    { label: 'rgb()', saved: 'rgb(209, 65, 49)', start: '#d14131', opacity: 1, adjusted: '#c0392b' },
    { label: 'short hex', saved: '#d43', start: '#dd4433', opacity: 1, adjusted: '#c0392b' },
    { label: 'six-digit hex', saved: '#d14131', start: '#d14131', opacity: 1, adjusted: '#c0392b' },
    { label: 'translucent rgba()', saved: 'rgba(209, 65, 49, 0.5)', start: '#d14131', opacity: 0.5, adjusted: 'rgba(192, 57, 43, 0.5)' },
    { label: 'translucent hex', saved: '#d1413180', start: '#d14131', opacity: 128 / 255, adjusted: '#c0392b80' }
  ];

  for (const c of cases) {
    it(`${c.label}: the picker starts from the saved colour and an adjustment undoes cleanly`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'so-color-'));
      dirs.push(dir);
      const first = await ProjectSession.create(dir, createStarterState('business', 'Colors', false));
      const original = brand(first);
      const saved = await first.apply({ operations: [{ type: 'token.set', tokenId: 'color.brand', value: c.saved }] }, { label: 'Change Brand color' });
      expect(saved.ok, saved.error?.message).toBe(true);
      await first.close();

      // Reopened, the saved text is intact and the picker starts from it, not from black.
      const s = await ProjectSession.open(dir, 'test');
      expect(brand(s)).toBe(c.saved);
      expect(pickerHex(brand(s))).toBe(c.start);
      expect(opacityOf(brand(s))).toBeCloseTo(c.opacity, 5);

      // Adjusting in the picker saves a colour that still carries the opacity.
      const next = colorFromPicker(brand(s), '#c0392b');
      expect(next).toBe(c.adjusted);
      expect(opacityOf(next)).toBeCloseTo(c.opacity, 2);
      const adjusted = await s.apply({ operations: [{ type: 'token.set', tokenId: 'color.brand', value: next }] }, { label: 'Change Brand color' });
      expect(adjusted.ok, adjusted.error?.message).toBe(true);
      expect(brand(s)).toBe(c.adjusted);

      // Undo returns the saved text exactly, and the picker follows it.
      await s.undo();
      expect(brand(s)).toBe(c.saved);
      expect(pickerHex(brand(s))).toBe(c.start);
      await s.undo();
      expect(brand(s)).toBe(original);
      await s.close();
    });
  }
});
