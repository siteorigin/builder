/**
 * The contrast Site styles reports for the colours a theme pairs on purpose: the exact case from the issue (a white
 * brand under white button text), the offers it makes, and the guards that keep unreadable values from slipping by.
 * Reference ratios were worked out separately, from the WCAG formula, not read back from the code.
 */
import { describe, expect, it } from 'vitest';
import type { TokenDef } from '@shared/types';
import { evaluatePairs, formatRatio, isFailing, pairsOf, suggestForeground, type ContrastPair, type PairResult } from '@shared/contrast';
import { effectiveTokens } from '@generator/index';
import { getTheme, listThemes } from '@catalogue/index';
import { STARTERS, createStarterState } from '@catalogue/starters';
import { FOUNDATION_CONTRAST_PAIRS } from '@catalogue/foundation/contrast';
import { derivedBrandTokens } from '@agent/brand';

const PAIRS = FOUNDATION_CONTRAST_PAIRS;

/** The Business starter with some tokens set the way an author's edit saves them. */
function business(overrides: Record<string, unknown>): TokenDef[] {
  const state = createStarterState('business', 'Harbour', false);
  state.tokens.overrides = overrides as never;
  return effectiveTokens(state);
}

const byId = (results: PairResult[], id: string) => results.find((r) => r.pair.id === id)!;
const ratioOf = (r: PairResult) => (r.status === 'unknown' ? NaN : r.ratio);

describe('the issue: a white brand color under white button text', () => {
  const tokens = business({ 'color.brand': '#ffffff' });
  const results = evaluatePairs(tokens, PAIRS);

  it('measures the button at rest as unreadable and on hover as readable', () => {
    const rest = byId(results, 'button');
    expect(rest.status).toBe('fail');
    expect(ratioOf(rest)).toBeCloseTo(1, 6);
    const hover = byId(results, 'button-hover');
    expect(hover.status).toBe('pass');
    expect(ratioOf(hover)).toBeCloseTo(10.925771, 5);
  });

  it('flags brand-colored links on the page too', () => {
    const links = byId(results, 'brand-text-background');
    expect(links.status).toBe('fail');
    expect(ratioOf(links)).toBeCloseTo(1.043781, 5);
  });

  it('offers dark ink for the button, and says what it does to the hover state', () => {
    const offer = suggestForeground(tokens, PAIRS, byId(results, 'button') as never);
    expect(offer).toMatchObject({ token: 'color.on-brand', value: '#14181a', everyState: false });
    const hover = byId(offer!.after, 'button-hover');
    expect(hover.status).toBe('fail');
    expect(ratioOf(hover)).toBeCloseTo(1.635359, 5);
  });

  it('offers nothing for the hover state alone once ink is chosen: white would only undo the resting state', () => {
    const inked = evaluatePairs(business({ 'color.brand': '#ffffff', 'color.on-brand': '#14181a' }), PAIRS);
    expect(byId(inked, 'button').status).toBe('pass');
    expect(byId(inked, 'button-hover').status).toBe('fail');
    const offer = suggestForeground(business({ 'color.brand': '#ffffff', 'color.on-brand': '#14181a' }), PAIRS, byId(inked, 'button-hover') as never);
    expect(offer).toBeNull();
  });

  it('offers no change to brand-colored text: the brand is what the author is choosing', () => {
    expect(suggestForeground(tokens, PAIRS, byId(results, 'brand-text-background') as never)).toBeNull();
  });
});

describe('offers', () => {
  it('prefers a color that keeps every state readable', () => {
    const tokens = business({ 'color.brand': '#ffffff', 'color.brand-strong': '#ffffff' });
    const failing = byId(evaluatePairs(tokens, PAIRS), 'button');
    const offer = suggestForeground(tokens, PAIRS, failing as never);
    expect(offer).toMatchObject({ token: 'color.on-brand', value: '#14181a', everyState: true });
    expect(offer!.after.every((r) => r.status === 'pass')).toBe(true);
  });

  it('offers black for a mid-tone brand that misses with white and ink', () => {
    const tokens = business({ 'color.brand': '#777777' });
    const failing = byId(evaluatePairs(tokens, PAIRS), 'button');
    expect(ratioOf(failing)).toBeCloseTo(4.478089, 5);
    expect(suggestForeground(tokens, PAIRS, failing as never)?.value).toBe('#000000');
  });

  it('checks a text color against every ground it sits on', () => {
    const tokens = business({ 'color.text': '#fbfaf7' });
    const results = evaluatePairs(tokens, PAIRS);
    const failing = results.filter(isFailing).filter((r) => r.pair.fg === 'color.text');
    expect(failing.map((r) => r.pair.id).sort()).toEqual(['text-background', 'text-surface', 'text-surface-alt']);
    const offer = suggestForeground(tokens, PAIRS, failing[0]);
    expect(offer).toMatchObject({ token: 'color.text', value: '#14181a', everyState: true });
    expect(offer!.after.map((r) => r.pair.id).sort()).toEqual(['text-background', 'text-surface', 'text-surface-alt']);
  });

  it('judges the choice with the colors that follow the token, not the old ones', () => {
    // The button's background follows its text color: no foreground can fix a pair that moves with it.
    const tokens = business({ 'color.brand': { token: 'color.on-brand' } });
    const failing = byId(evaluatePairs(tokens, PAIRS), 'button');
    expect(ratioOf(failing)).toBeCloseTo(1, 6);
    expect(suggestForeground(tokens, PAIRS, failing as never)).toBeNull();
  });
});

describe('what a ratio says', () => {
  it('is compared before it is rounded and shown cut, so a failing pair never reads as the minimum', () => {
    const tokens = business({ 'color.brand': '#777777' });
    const failing = byId(evaluatePairs(tokens, PAIRS), 'button');
    expect(failing.status).toBe('fail');
    expect(formatRatio(ratioOf(failing))).toBe('4.47');
    expect(formatRatio(4.4999999)).toBe('4.49');
    expect(formatRatio(4.5)).toBe('4.50');
    expect(formatRatio(21)).toBe('21.00');
  });

  it('is exact at the extremes', () => {
    const tokens = business({ 'color.brand': '#ffffff', 'color.on-brand': '#000000' });
    expect(ratioOf(byId(evaluatePairs(tokens, PAIRS), 'button'))).toBeCloseTo(21, 9);
  });

  it('sees translucent text as the color it makes over its ground', () => {
    const tokens = business({ 'color.text': 'rgb(0 0 0 / 50%)', 'color.background': '#ffffff' });
    const r = byId(evaluatePairs(tokens, PAIRS), 'text-background');
    expect(r.status).toBe('fail');
    expect(ratioOf(r)).toBeCloseTo(3.976653, 5);
  });

  it('reads a light button on its hover mix of the two colors', () => {
    const tokens = business({ 'color.brand-strong': '#707070', 'color.on-brand': '#ffffff', 'color.brand': '#000000' });
    const results = evaluatePairs(tokens, PAIRS);
    expect(byId(results, 'light-button').status).toBe('pass');
    expect(ratioOf(byId(results, 'light-button'))).toBeCloseTo(4.952144, 5);
    expect(byId(results, 'light-button-hover').status).toBe('fail');
    expect(ratioOf(byId(results, 'light-button-hover'))).toBeCloseTo(3.765582, 5);
  });
});

describe('values that cannot be known', () => {
  const mini = (tokens: Array<[string, unknown]>): TokenDef[] => tokens.map(([id, value]) => ({ id, label: id, group: 'color', value }) as TokenDef);
  const pair: ContrastPair = { id: 'p', use: 'Sample', fg: 'color.fg', bg: 'color.bg', state: 'rest', group: 'p' };

  it('follows a chain of references longer than any limit', () => {
    const links: Array<[string, unknown]> = Array.from({ length: 12 }, (_, i) => [`color.l${i}`, { token: `color.l${i + 1}` }]);
    const tokens = mini([...links, ['color.l12', '#000000'], ['color.fg', { token: 'color.l0' }], ['color.bg', '#ffffff']]);
    expect(ratioOf(evaluatePairs(tokens, [pair])[0])).toBeCloseTo(21, 9);
  });

  it.each([
    ['a missing token', [['color.bg', '#ffffff']] as Array<[string, unknown]>],
    ['a dangling reference', [['color.fg', { token: 'color.nope' }], ['color.bg', '#ffffff']] as Array<[string, unknown]>],
    ['a circular reference', [['color.fg', { token: 'color.other' }], ['color.other', { token: 'color.fg' }], ['color.bg', '#ffffff']] as Array<[string, unknown]>],
    ['a value that depends on where it is used', [['color.fg', 'var(--theme)'], ['color.bg', '#ffffff']] as Array<[string, unknown]>],
    ['currentcolor', [['color.fg', 'currentcolor'], ['color.bg', '#ffffff']] as Array<[string, unknown]>],
    ['an empty value', [['color.fg', '  '], ['color.bg', '#ffffff']] as Array<[string, unknown]>]
  ])('reports %s as unknown, never as a pass or a fail', (_, list) => {
    expect(evaluatePairs(mini(list), [pair])[0].status).toBe('unknown');
  });

  it('paints a translucent background over the page color', () => {
    const tokens = mini([['color.background', '#ffffff'], ['color.fg', '#000000'], ['color.bg', 'rgb(0 0 0 / 50%)']]);
    // 50% black over white is (127.5, 127.5, 127.5): black on it is 5.2808, not the 21 an opaque read would give.
    expect(ratioOf(evaluatePairs(tokens, [pair])[0])).toBeCloseTo(5.280823, 5);
  });
});

describe('what ships', () => {
  it('declares only tokens its theme has, with unique ids', () => {
    for (const theme of listThemes().filter((t) => t.contrastPairs)) {
      const ids = new Set(theme.tokens.map((t) => t.id));
      const pairs = theme.contrastPairs!;
      expect(new Set(pairs.map((p) => p.id)).size).toBe(pairs.length);
      for (const p of pairs) {
        const used = [p.fg, ...(typeof p.bg === 'string' ? [p.bg] : [p.bg.mix[0], p.bg.mix[2]])];
        for (const id of used) expect(ids.has(id), `${theme.id} ${p.id} uses ${id}`).toBe(true);
      }
    }
  });

  it('is readable for every theme and starter as it is delivered', () => {
    const themes = listThemes().filter((t) => t.contrastPairs);
    expect(themes.length).toBeGreaterThanOrEqual(2);
    for (const theme of themes) {
      const results = evaluatePairs(theme.tokens, theme.contrastPairs!);
      expect(results.filter((r) => r.status !== 'pass').map((r) => r.pair.id), theme.id).toEqual([]);
    }
    for (const starter of STARTERS) {
      const state = createStarterState(starter.id, 'Harbour', false);
      const results = evaluatePairs(effectiveTokens(state), getTheme(state.site.themeId).contrastPairs ?? []);
      expect(results.filter((r) => r.status !== 'pass').map((r) => r.pair.id), starter.id).toEqual([]);
    }
  });

  it('lists the pairs that involve a token as foreground or background, hover mixes included', () => {
    expect(pairsOf(PAIRS, 'color.on-brand').map((p) => p.id)).toEqual(expect.arrayContaining(['button', 'button-hover', 'light-button', 'light-button-hover']));
    expect(pairsOf(PAIRS, 'color.brand').map((p) => p.id)).toEqual(expect.arrayContaining(['button', 'light-button-hover', 'brand-text-background']));
    expect(pairsOf(PAIRS, 'color.border')).toEqual([]);
  });

  it('agrees with the AI brand tool: the colors it derives for any brand keep the button readable at rest and on hover', () => {
    for (const brand of ['#ffffff', '#000000', '#777777', '#1f5a4c', '#d14131', '#f5c518', '#3442b8']) {
      const derived = derivedBrandTokens(brand, '#ffffff');
      const tokens = business(derived);
      const results = evaluatePairs(tokens, PAIRS);
      expect(byId(results, 'button').status, `${brand} button`).toBe('pass');
      expect(byId(results, 'button-hover').status, `${brand} hover`).toBe('pass');
    }
  });
});
