/**
 * The contrast Site styles reports for the colours a theme pairs on purpose: the exact case from the issue (a white
 * brand under white button text), the offers it makes, and the guards that keep unreadable values from slipping by.
 * Reference ratios were worked out separately, from the WCAG formula, not read back from the code.
 */
import { describe, expect, it } from 'vitest';
import type { TokenDef } from '@shared/types';
import { parseColor } from '@shared/color';
import { evaluatePairs, formatRatio, isFailing, pairsOf, suggestForeground, type ContrastPair, type PairResult } from '@shared/contrast';
import { effectiveTokens } from '@generator/index';
import { getTheme, listThemes } from '@catalogue/index';
import { STARTERS, createStarterState } from '@catalogue/starters';
import { FOUNDATION_CONTRAST_PAIRS } from '@catalogue/foundation/contrast';
import { derivedBrandTokens } from '@agent/brand';
import { sayContrast } from '../../src/renderer/src/lib/announce';

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
    // The sample shows white text on the strong brand, not the other way round.
    expect(hover).toMatchObject({ fg: '#ffffff', bg: '#16443a' });
  });

  it('flags brand-colored links on the page, cards and alternate sections', () => {
    const links = byId(results, 'brand-text-background');
    expect(links.status).toBe('fail');
    expect(ratioOf(links)).toBeCloseTo(1.043781, 5);
    expect(byId(results, 'brand-text-surface').status).toBe('fail');
    expect(byId(results, 'brand-text-surface-alt').status).toBe('fail');
  });

  it('offers dark ink for the button, and says what it does to the hover state', () => {
    const offer = suggestForeground(tokens, PAIRS, byId(results, 'button') as never);
    expect(offer).toMatchObject({ token: 'color.on-brand', value: '#14181a', everyState: false });
    const hover = byId(offer!.after, 'button-hover');
    expect(hover.status).toBe('fail');
    expect(ratioOf(hover)).toBeCloseTo(1.635359, 5);
    // The group's passing result is there too, not only the ones that fail.
    expect(byId(offer!.after, 'button').status).toBe('pass');
  });

  it('says every pair the offer would spoil, the light button on the brand panel included', () => {
    const offer = suggestForeground(tokens, PAIRS, byId(results, 'button') as never)!;
    expect(offer.breaks.map((r) => r.pair.id).sort()).toEqual(['button-hover', 'light-button', 'light-button-hover']);
    // Worst first: ink on the strong brand, and the light button's text on an ink button on a white brand panel.
    expect(offer.breaks[0].ratio).toBeLessThan(offer.breaks[offer.breaks.length - 1].ratio + 1e-9);
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

  it('offers a joint fix for a failing hover state when one exists', () => {
    const tokens = business({ 'color.brand': '#ffffff', 'color.brand-strong': '#ffffff' });
    const hover = byId(evaluatePairs(tokens, PAIRS), 'button-hover');
    expect(hover.status).toBe('fail');
    expect(suggestForeground(tokens, PAIRS, hover as never)).toMatchObject({ token: 'color.on-brand', value: '#14181a', everyState: true });
  });

  it('prefers the choice that keeps every state readable over the first one that fixes the resting state', () => {
    // Ink fixes the button at rest alone; black fixes it on a mid-grey hover too.
    const tokens = business({ 'color.brand': '#ffffff', 'color.brand-strong': '#777777' });
    const failing = byId(evaluatePairs(tokens, PAIRS), 'button');
    expect(suggestForeground(tokens, PAIRS, failing as never)).toMatchObject({ value: '#000000', everyState: true });
  });

  it('marks a fix for the resting state as costing the hover state when no choice keeps both', () => {
    const tokens = business({ 'color.brand': '#777777' });
    const offer = suggestForeground(tokens, PAIRS, byId(evaluatePairs(tokens, PAIRS), 'button') as never);
    expect(offer).toMatchObject({ value: '#000000', everyState: false });
    expect(byId(offer!.after, 'button-hover').status).toBe('fail');
  });

  it('offers a fix for a pair only when its declaration says the foreground is the author’s to change', () => {
    const asLink: ContrastPair = { id: 'link', use: 'Link', fg: 'color.brand', bg: 'color.background', state: 'rest', group: 'link' };
    const tokens = business({ 'color.brand': '#ffffff' });
    const failing = byId(evaluatePairs(tokens, [asLink]), 'link');
    expect(suggestForeground(tokens, [asLink], failing as never)).toMatchObject({ token: 'color.brand', value: '#14181a' });
    const unfixable = [{ ...asLink, fixable: false }];
    expect(suggestForeground(tokens, unfixable, byId(evaluatePairs(tokens, unfixable), 'link') as never)).toBeNull();
  });

  it('judges a choice only against its own group, but against every sibling in it, fixable or not', () => {
    const tokens = business({ 'color.text': '#ffffff' });
    const other: ContrastPair = { id: 'other', use: 'Other', fg: 'color.text', bg: 'color.inverse', state: 'rest', group: 'other' };
    const failing = byId(evaluatePairs(tokens, PAIRS), 'text-background');
    const offer = suggestForeground(tokens, [...PAIRS, other], failing as never)!;
    expect(offer.after.map((r) => r.pair.id).sort()).toEqual(['text-background', 'text-surface', 'text-surface-alt']);
    // A sibling that is not the author's to fix still counts against a choice: white hover on white, black rest on black.
    const sibling = { id: 'rest', use: 'Rest', fg: 'color.text', bg: 'color.inverse', state: 'rest' as const, group: 'text', fixable: false };
    const hover = { id: 'hov', use: 'Hover', fg: 'color.text', bg: 'color.background', state: 'hover' as const, group: 'text' };
    const dark = business({ 'color.text': '#ffffff', 'color.background': '#ffffff', 'color.inverse': '#000000' });
    const failingHover = byId(evaluatePairs(dark, [sibling, hover]), 'hov');
    expect(suggestForeground(dark, [sibling, hover], failingHover as never)).toBeNull();
  });

  it('never trades one ground for another: text on a white page and black cards gets no offer', () => {
    const tokens = business({ 'color.background': '#ffffff', 'color.surface': '#000000', 'color.surface-alt': '#ffffff', 'color.text': '#ffffff' });
    const results = evaluatePairs(tokens, PAIRS);
    const page = byId(results, 'text-background');
    const cards = byId(results, 'text-surface');
    expect([page.status, cards.status]).toEqual(['fail', 'pass']);
    expect(suggestForeground(tokens, PAIRS, page as never)).toBeNull();
    // And once ink is chosen the cards fail with no offer to switch back.
    const inked = business({ 'color.background': '#ffffff', 'color.surface': '#000000', 'color.surface-alt': '#ffffff', 'color.text': '#14181a' });
    const failingCards = byId(evaluatePairs(inked, PAIRS), 'text-surface');
    expect(failingCards.status).toBe('fail');
    expect(suggestForeground(inked, PAIRS, failingCards as never)).toBeNull();
  });

  it('offers nothing for a hover state whose resting state cannot be checked', () => {
    const tokens = business({ 'color.brand': 'currentcolor', 'color.brand-strong': '#ffffff', 'color.on-brand': '#ffffff' });
    const results = evaluatePairs(tokens, PAIRS);
    expect(byId(results, 'button').status).toBe('unknown');
    const hover = byId(results, 'button-hover');
    expect(hover.status).toBe('fail');
    expect(suggestForeground(tokens, PAIRS, hover as never)).toBeNull();
  });

  it('picks the choice that spoils nothing that reads now, and does not count a pair it makes readable', () => {
    // Text on brand is 90% black and the page is unreadable. Text and Alternate background follow it, so both are unknown now.
    // White fixes the button but turns the white cards' text white on white; black fixes it and breaks nothing that passes.
    const tokens = business({
      'color.background': 'currentcolor',
      'color.brand': '#757575',
      'color.brand-strong': '#757575',
      'color.on-brand': 'rgb(0 0 0 / 90%)',
      'color.surface': '#ffffff',
      'color.muted': '#000000',
      'color.text': { token: 'color.on-brand' },
      'color.surface-alt': { token: 'color.on-brand' }
    });
    const results = evaluatePairs(tokens, PAIRS);
    const failing = byId(results, 'button');
    expect(failing.status).toBe('fail');
    expect(suggestForeground(tokens, PAIRS, failing as never)).toMatchObject({ value: '#000000' });
  });

  it('breaks a tie by the failures a choice makes measurable on a ground that follows it', () => {
    // The page is unreadable and Alternate background follows Text on brand. Text is white, so white on a white alternate ground fails; black passes.
    const tokens = business({
      'color.background': 'currentcolor',
      'color.brand': '#757575',
      'color.brand-strong': '#757575',
      'color.on-brand': 'rgb(0 0 0 / 90%)',
      'color.surface-alt': { token: 'color.on-brand' },
      'color.text': '#ffffff',
      'color.muted': '#ffffff'
    });
    const offer = suggestForeground(tokens, PAIRS, byId(evaluatePairs(tokens, PAIRS), 'button') as never)!;
    expect(offer.value).toBe('#000000');
    // What black makes measurable and failing is said (the light button's hover), not hidden.
    expect(offer.breaks.map((r) => r.pair.id)).toEqual(['light-button-hover']);
  });

  it('offers a choice for a brand linked to an independent color', () => {
    const tokens = business({ 'color.brand': { token: 'color.surface' } });
    const failing = byId(evaluatePairs(tokens, PAIRS), 'button');
    expect(failing.status).toBe('fail');
    expect(suggestForeground(tokens, PAIRS, failing as never)).toMatchObject({ token: 'color.on-brand', value: '#14181a' });
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
    expect(formatRatio(4.499999999999)).toBe('4.49');
    expect(formatRatio(4.5)).toBe('4.50');
    expect(formatRatio(4.52)).toBe('4.52');
    expect(formatRatio(21)).toBe('21.00');
  });

  it('compares the ratio unrounded: 4.49913 fails though it would round to 4.50', () => {
    const tokens = business({ 'color.brand': 'rgb(118.67 118.67 118.67)', 'color.on-brand': '#ffffff' });
    const r = byId(evaluatePairs(tokens, PAIRS), 'button');
    expect(ratioOf(r)).toBeGreaterThan(4.499);
    expect(ratioOf(r)).toBeLessThan(4.5);
    expect(r.status).toBe('fail');
  });

  it('passes a pair that sits exactly on its minimum', () => {
    const pair: ContrastPair = { id: 'p', use: 'Sample', fg: 'color.text', bg: 'color.background', state: 'rest', group: 'p', min: 21 };
    expect(byId(evaluatePairs(business({ 'color.text': '#000000', 'color.background': '#ffffff' }), [pair]), 'p').status).toBe('pass');
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

  it('paints translucent text over the ground it sits on, not over the page', () => {
    const tokens = business({ 'color.background': '#ffffff', 'color.surface': '#000000', 'color.text': 'rgb(0 0 0 / 50%)' });
    const r = byId(evaluatePairs(tokens, PAIRS), 'text-surface');
    expect(ratioOf(r)).toBeCloseTo(1, 6);
  });

  it('paints a translucent page color once, not over itself', () => {
    // 50% black over white is (127.5, 127.5, 127.5); white brand text on it is 3.9767, not the 10.4 of a page painted twice.
    const tokens = business({ 'color.background': 'rgb(0 0 0 / 50%)', 'color.brand': '#ffffff' });
    const r = byId(evaluatePairs(tokens, PAIRS), 'brand-text-background');
    expect(r.status).toBe('fail');
    expect(ratioOf(r)).toBeCloseTo(3.976653, 5);
  });

  it('paints a translucent surface over a black page', () => {
    const tokens = business({ 'color.background': '#000000', 'color.surface': 'rgb(0 0 0 / 50%)', 'color.text': '#000000' });
    expect(ratioOf(byId(evaluatePairs(tokens, PAIRS), 'text-surface'))).toBeCloseTo(1, 6);
  });

  it.each([['currentcolor'], [{ token: 'color.nope' }]])('leaves a translucent color unknown when the page color (%j) is, but still measures opaque ones', (page) => {
    const tokens = business({ 'color.background': page, 'color.surface': 'rgb(0 0 0 / 50%)', 'color.surface-alt': '#ffffff', 'color.text': '#000000' });
    const results = evaluatePairs(tokens, PAIRS);
    expect(byId(results, 'text-surface').status).toBe('unknown');
    expect(byId(results, 'text-background').status).toBe('unknown');
    expect(ratioOf(byId(results, 'text-surface-alt'))).toBeCloseTo(21, 9);
  });

  it('holds a pair to its own minimum', () => {
    const pair: ContrastPair = { id: 'p', use: 'Sample', fg: 'color.text', bg: 'color.background', state: 'rest', group: 'p', min: 7 };
    const grey = business({ 'color.text': '#666666', 'color.background': '#ffffff' });
    expect(byId(evaluatePairs(grey, [pair]), 'p').status).toBe('fail');
    expect(byId(evaluatePairs(grey, [{ ...pair, min: undefined }]), 'p').status).toBe('pass');
    // A lower minimum is honoured too: 3.54:1 passes at 3.
    expect(byId(evaluatePairs(business({ 'color.text': '#888888', 'color.background': '#ffffff' }), [{ ...pair, min: 3 }]), 'p').status).toBe('pass');
  });

  it('leaves a translucent color unknown on a ground that differs from place to place, and measures an opaque one', () => {
    // The light button sits on brand panels and dark panels alike: its translucent background has no one ground to be measured on.
    const translucent = business({ 'color.on-brand': 'rgb(255 255 255 / 55%)' });
    const results = evaluatePairs(translucent, PAIRS);
    expect(byId(results, 'light-button').status).toBe('unknown');
    expect(byId(results, 'light-button-hover').status).toBe('unknown');
    expect(byId(results, 'button').status).not.toBe('unknown');
    expect(ratioOf(byId(evaluatePairs(business({}), PAIRS), 'light-button'))).toBeCloseTo(10.925771, 5);
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
    const links: Array<[string, unknown]> = Array.from({ length: 100 }, (_, i) => [`color.l${i}`, { token: `color.l${i + 1}` }]);
    const tokens = mini([...links, ['color.l100', '#000000'], ['color.fg', { token: 'color.l0' }], ['color.bg', '#ffffff']]);
    expect(ratioOf(evaluatePairs(tokens, [pair])[0])).toBeCloseTo(21, 9);
  });

  it.each([
    ['a missing foreground', [['color.bg', '#ffffff']] as Array<[string, unknown]>],
    ['a missing background', [['color.fg', '#000000']] as Array<[string, unknown]>],
    ['a cycle that does not return to where it started', [['color.fg', { token: 'color.a' }], ['color.a', { token: 'color.b' }], ['color.b', { token: 'color.a' }], ['color.bg', '#ffffff']] as Array<[string, unknown]>],
    ['a dangling reference', [['color.fg', { token: 'color.nope' }], ['color.bg', '#ffffff']] as Array<[string, unknown]>],
    ['a circular reference', [['color.fg', { token: 'color.other' }], ['color.other', { token: 'color.fg' }], ['color.bg', '#ffffff']] as Array<[string, unknown]>],
    ['a value that depends on where it is used', [['color.fg', 'var(--theme)'], ['color.bg', '#ffffff']] as Array<[string, unknown]>],
    ['currentcolor', [['color.fg', 'currentcolor'], ['color.bg', '#ffffff']] as Array<[string, unknown]>],
    ['an empty value', [['color.fg', '  '], ['color.bg', '#ffffff']] as Array<[string, unknown]>]
  ])('reports %s as unknown, never as a pass or a fail', (_, list) => {
    expect(evaluatePairs(mini(list), [pair])[0].status).toBe('unknown');
  });

  it('reads colors through the reader it is given, and keeps a bare keyword and padded values', () => {
    const tokens = mini([['color.fg', 'color-mix(in srgb, #000 100%, #000)'], ['color.bg', 'color-mix(in srgb, #fff 100%, #fff)']]);
    expect(evaluatePairs(tokens, [pair])[0].status).toBe('unknown');
    const reader = (css: string) => (css.includes('#000') ? { r: 0, g: 0, b: 0, a: 1 } : css.startsWith('color-mix') ? { r: 255, g: 255, b: 255, a: 1 } : parseColor(css));
    expect(ratioOf(evaluatePairs(tokens, [pair], reader)[0])).toBeCloseTo(21, 9);
    expect(ratioOf(evaluatePairs(mini([['color.fg', 'black'], ['color.bg', ' #ffffff ']]), [pair])[0])).toBeCloseTo(21, 9);
  });

  it('paints a translucent background over the page color', () => {
    const tokens = mini([['color.background', '#ffffff'], ['color.fg', '#000000'], ['color.bg', 'rgb(0 0 0 / 50%)']]);
    // 50% black over white is (127.5, 127.5, 127.5): black on it is 5.2808, not the 21 an opaque read would give.
    expect(ratioOf(evaluatePairs(tokens, [pair])[0])).toBeCloseTo(5.280823, 5);
  });
});

describe('what ships', () => {
  it('declares only tokens its theme has, with unique ids', () => {
    const declaring = listThemes().filter((t) => t.contrastPairs);
    expect(declaring.map((t) => t.id).sort()).toEqual(['editorial', 'foundation', 'foundation-alt']);
    for (const theme of declaring) {
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
      expect(results.map((r) => r.pair.id)).toEqual(expect.arrayContaining(['button', 'button-hover', 'dark-text', 'dark-accent', 'text-background', 'muted-surface-alt']));
      expect(results.filter((r) => r.status !== 'pass').map((r) => r.pair.id), theme.id).toEqual([]);
    }
    for (const starter of STARTERS) {
      const state = createStarterState(starter.id, 'Harbour', false);
      const results = evaluatePairs(effectiveTokens(state), getTheme(state.site.themeId).contrastPairs ?? []);
      expect(results.filter((r) => r.status !== 'pass').map((r) => r.pair.id), starter.id).toEqual([]);
    }
  });

  it('shows each pair as the site paints it: text on its ground, on each ground', () => {
    const results = evaluatePairs(business({}), PAIRS);
    expect(byId(results, 'button')).toMatchObject({ fg: '#ffffff', bg: '#1f5a4c' });
    expect(byId(results, 'brand-text-surface')).toMatchObject({ fg: '#1f5a4c', bg: '#ffffff' });
    expect(byId(results, 'brand-text-surface-alt')).toMatchObject({ fg: '#1f5a4c', bg: '#f2efe8' });
    expect(PAIRS.map((p) => p.id).sort()).toEqual([
      'brand-text-background', 'brand-text-surface', 'brand-text-surface-alt', 'button', 'button-hover', 'dark-accent', 'dark-button', 'dark-button-hover', 'dark-text',
      'focus-background', 'focus-surface', 'focus-surface-alt', 'light-button', 'light-button-hover', 'muted-background', 'muted-surface', 'muted-surface-alt',
      'text-background', 'text-surface', 'text-surface-alt'
    ]);
  });

  it('measures a button in a dark section on its hover mix, not its resting fill, and offers no change to the dark section color', () => {
    const results = evaluatePairs(business({ 'color.inverse': '#707070', 'color.on-inverse': '#ffffff' }), PAIRS);
    expect(byId(results, 'dark-button')).toMatchObject({ status: 'pass', fg: '#707070', bg: '#ffffff' });
    expect(ratioOf(byId(results, 'dark-button'))).toBeCloseTo(4.952144, 5);
    const hover = byId(results, 'dark-button-hover');
    expect(hover).toMatchObject({ status: 'fail', fg: '#707070' });
    expect(ratioOf(hover)).toBeCloseTo(4.2621, 4);
    expect(suggestForeground(business({ 'color.inverse': '#707070', 'color.on-inverse': '#ffffff' }), PAIRS, hover as never)).toBeNull();
  });

  it('measures the focus outline against the page, cards and alternate sections at 3:1', () => {
    const results = evaluatePairs(business({ 'color.focus': '#8c8c8c' }), PAIRS);
    expect(['focus-background', 'focus-surface', 'focus-surface-alt'].map((id) => [id, byId(results, id).status])).toEqual([
      ['focus-background', 'pass'],
      ['focus-surface', 'pass'],
      ['focus-surface-alt', 'fail']
    ]);
    expect(byId(results, 'focus-surface-alt')).toMatchObject({ min: 3, fg: '#8c8c8c', bg: '#f2efe8' });
    expect(ratioOf(byId(results, 'focus-surface-alt'))).toBeCloseTo(2.9283, 4);
  });

  it('lists the pairs that involve a token as foreground or background, hover mixes included', () => {
    expect(pairsOf(PAIRS, 'color.on-brand').map((p) => p.id)).toEqual(expect.arrayContaining(['button', 'button-hover', 'light-button', 'light-button-hover']));
    expect(pairsOf(PAIRS, 'color.brand').map((p) => p.id).sort()).toEqual(['brand-text-background', 'brand-text-surface', 'brand-text-surface-alt', 'button', 'light-button-hover']);
    expect(pairsOf(PAIRS, 'color.border')).toEqual([]);
  });

  it('follows the colors that follow a token, so editing the one a brand follows shows the button', () => {
    const tokens = business({ 'color.brand': { token: 'color.accent' } });
    expect(pairsOf(PAIRS, 'color.accent').map((p) => p.id)).not.toContain('button');
    expect(pairsOf(PAIRS, 'color.accent', tokens).map((p) => p.id)).toEqual(expect.arrayContaining(['button', 'brand-text-background', 'dark-accent']));
    // Four hops: brand follows a1, a1 follows a2, a2 follows a3, a3 follows border.
    const chain = ['color.brand', 'color.a1', 'color.a2', 'color.a3'].map((id, i, all) => ({ id, label: id, group: 'color', value: { token: all[i + 1] ?? 'color.border' } }) as TokenDef);
    const hops = [...chain, { id: 'color.border', label: 'Border', group: 'color', value: '#e3dfd5' } as TokenDef];
    expect(pairsOf(PAIRS, 'color.border', hops).map((p) => p.id)).toContain('button');
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

  it('keeps the brand tool choosing white, then ink, then black', () => {
    expect(derivedBrandTokens('#000000', '#ffffff')['color.on-brand']).toBe('#ffffff');
    expect(derivedBrandTokens('#1f5a4c', '#ffffff')['color.on-brand']).toBe('#ffffff');
    expect(derivedBrandTokens('#ffffff', '#ffffff')['color.on-brand']).toBe('#14181a');
    expect(derivedBrandTokens('#f5c518', '#ffffff')['color.on-brand']).toBe('#14181a');
    expect(derivedBrandTokens('#767676', '#ffffff')['color.on-brand']).toBe('#ffffff');
    expect(derivedBrandTokens('#777777', '#ffffff')['color.on-brand']).toBe('#000000');
  });
});

describe('what the status region says', () => {
  const key = (failing: string[], unknown = false) => `${failing.join('|')}\n${unknown ? 'unknown' : ''}`;
  it('names the unreadable pairs, and says readable again only after there were some', () => {
    expect(sayContrast(key([]), key(['Button text', 'Text on the page']))).toBe('Low contrast: Button text, Text on the page');
    expect(sayContrast(key(['Button text']), key([]))).toBe('Colors are readable again');
    expect(sayContrast(key([], true), key([]))).toBeNull();
    expect(sayContrast(key(['Button text']), key(['Text on the page']))).toBe('Low contrast: Text on the page');
  });
  it('clears an all-clear that is no longer true once some pair cannot be checked', () => {
    expect(sayContrast(key([]), key([], true))).toBe('');
  });
  it('stays quiet when only the could-not-be-checked flag moved, and never claims readable while some cannot be checked', () => {
    expect(sayContrast(key(['Button text']), key(['Button text'], true))).toBeNull();
    expect(sayContrast(key(['Button text'], true), key(['Button text']))).toBeNull();
    expect(sayContrast(key(['Button text']), key([], true))).toBe('');
  });
});
