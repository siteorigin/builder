/**
 * Buttons in Site styles (#1475). Foundation's buttons take their corners from `radius.button`, which follows Pill
 * until it is given a value of its own, and their label from `text.button` (font, size, weight, case, letter
 * spacing). The label's size sizes the whole button, since its padding is in em. A change to either reaches every
 * button the theme draws and nothing else: badges and filter pills keep following Pill.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectState, TokenDef } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { getTheme, listThemes, registerPacks } from '@catalogue/index';
import { restorePacks } from './fixtures/packs';
import { applyOperations } from '@engine/apply';
import { STYLES_DIR, generateProject, generateTokensCss } from '@generator/index';
import { TYPE_SCALE_ROLES } from '@shared/type-scale';
import { buttonStyleIds, tokenFollowers } from '@shared/button-styles';
import { findTokenCycle, tokenResetOrder } from '@engine/tokens';

const THEMES = ['foundation', 'foundation-alt'];
const starter = (themeId = 'foundation') => {
  const s = createStarterState('blank', 'Buttons', false);
  return themeId === s.site.themeId ? s : { ...s, site: { ...s.site, themeId } };
};
const set = (s: ProjectState, tokenId: string, value: unknown) => applyOperations(s, [{ type: 'token.set', tokenId, value }]).state;
const declared = (themeId: string, id: string) => getTheme(themeId).tokens.find((t) => t.id === id);

describe.each(THEMES)('the %s theme', (themeId) => {
  const theme = getTheme(themeId);

  it('declares the button corners, following Pill, and the button label with the type buttons had', () => {
    expect(declared(themeId, 'radius.button')).toMatchObject({ group: 'radius', value: { token: 'radius.pill' } });
    expect(declared(themeId, 'text.button')).toMatchObject({
      group: 'text',
      value: { family: { token: 'font.body' }, size: '0.97rem', lineHeight: '1.2', weight: 550, tracking: '-0.005em', transform: 'none' }
    });
    expect(buttonStyleIds(theme.tokens)).toEqual({ radius: 'radius.button', text: 'text.button' });
  });

  it('draws every button from them, with nothing about its shape or type fixed', () => {
    const rule = theme.baseCss.slice(theme.baseCss.indexOf('.so-btn {'), theme.baseCss.indexOf('}', theme.baseCss.indexOf('.so-btn {')));
    for (const v of ['radius-button', 'text-button-family', 'text-button-size', 'text-button-weight', 'text-button-line-height', 'text-button-tracking', 'text-button-transform']) expect(rule).toContain(`var(--so-${v})`);
    expect(rule).not.toMatch(/radius-pill|font-body|font-weight: 550|letter-spacing: -0\.005em|font-size: 0\.97rem/);
    // The header's call to action, the pricing switch's track and the search and signup rows follow the buttons.
    const source = (id: string) => theme.components.find((c) => c.componentId === id)!.source!;
    // As it is, never in calc(), where a size such as x-large is not valid: on the bar, and in both phone menus.
    const cta = [...source('shell.header').matchAll(/\.so-header__cta \{([^}]*)\}/g)].map((m) => m[1]).filter((d) => d.includes('font-size'));
    expect(cta).toHaveLength(3);
    for (const d of cta) expect(d).toContain('font-size: var(--so-text-button-size);');
    expect(source('pricing.toggle')).toMatch(/\.billing__switch \{[^}]*border-radius: var\(--so-radius-button\)/);
    for (const id of ['site.search', 'block.signup']) {
      expect(source(id), id).toContain('calc(var(--so-radius-button) - var(--so-space-2xs) - 1px)');
      expect(source(id), id).not.toContain('calc(var(--so-radius-pill) - var(--so-space-2xs) - 1px)');
    }
    // Badges and filter pills are not buttons: they stay pills.
    expect(theme.baseCss).toMatch(/\.so-filter__pill \{[^}]*border-radius: var\(--so-radius-pill\)/);
    expect(source('pricing.plans')).toMatch(/\.pricing__badge \{[^}]*border-radius: var\(--so-radius-pill\)/);
  });

  it('writes the defaults out as links and metrics, and a change to either as the site stylesheet', () => {
    const s0 = starter(themeId);
    const css0 = generateTokensCss(s0);
    expect(css0).toContain('--so-radius-button: var(--so-radius-pill);');
    expect(css0).toContain('--so-text-button-family: var(--so-font-body);');
    expect(css0).toContain('--so-text-button-weight: 550;');
    let s = set(s0, 'radius.button', '0px');
    s = set(s, 'text.button', { family: { token: 'font.display' }, transform: 'uppercase', tracking: '0.08em', weight: 700, size: '1.125rem', lineHeight: '1.4' });
    const css = generateTokensCss(s);
    expect(css).toContain('--so-text-button-weight: 700;');
    expect(css).toContain('--so-text-button-line-height: 1.4;');
    expect(css).toContain('--so-radius-button: 0px;');
    expect(css).toContain('--so-text-button-family: var(--so-font-display);');
    expect(css).toContain('--so-text-button-transform: uppercase;');
    expect(css).toContain('--so-text-button-tracking: 0.08em;');
    expect(css).toContain('--so-text-button-size: 1.125rem;');
    // Pill itself is untouched.
    expect(css).toContain(`--so-radius-pill: ${declared(themeId, 'radius.pill')!.value};`);
    // A partial change keeps the other metrics; a reset goes back to following Pill.
    expect(set(s0, 'text.button', { weight: 700 }).tokens.overrides['text.button']).toEqual({ family: { token: 'font.body' }, size: '0.97rem', lineHeight: '1.2', weight: 700, tracking: '-0.005em', transform: 'none' });
    expect(generateTokensCss(set(s, 'radius.button', null))).toContain('--so-radius-button: var(--so-radius-pill);');
  });
});

describe('the type scale', () => {
  it('leaves the button label alone', () => {
    expect(TYPE_SCALE_ROLES).not.toContain('text.button');
  });
});

describe('the Buttons styles a theme declares', () => {
  const tok = (id: string, group: TokenDef['group'], value: TokenDef['value']): TokenDef => ({ id, label: id, group, value });

  it('are found only under their own ids and groups', () => {
    expect(buttonStyleIds([])).toEqual({ radius: null, text: null });
    // A theme with only one of them still shows it; one of the wrong kind is not a button style.
    expect(buttonStyleIds([tok('radius.button', 'radius', '4px')])).toEqual({ radius: 'radius.button', text: null });
    expect(buttonStyleIds([tok('text.button', 'text', { family: 'serif', size: '1rem', lineHeight: '1.2', weight: 500, tracking: '0' })])).toEqual({ radius: null, text: 'text.button' });
    expect(buttonStyleIds([tok('radius.button', 'space', '4px'), tok('text.button', 'font', 'serif')])).toEqual({ radius: null, text: null });
  });

  it('name the styles that already follow one, directly or along a chain, so a link to them is never offered', () => {
    // The indirect follower comes first, so one pass over the list would miss it.
    const tokens = [tok('radius.lg', 'radius', { token: 'radius.md' }), tok('radius.md', 'radius', { token: 'radius.pill' }), tok('radius.sm', 'radius', '6px'), tok('radius.pill', 'radius', { token: 'radius.button' }), tok('radius.button', 'radius', '0px'), tok('color.brand', 'color', { token: 'radius.button' })];
    expect([...tokenFollowers(tokens, 'radius.button', 'radius')].sort()).toEqual(['radius.lg', 'radius.md', 'radius.pill']);
    expect([...tokenFollowers(tokens, 'radius.sm', 'radius')]).toEqual([]);
    // The colour picker's loop filter reads the same helper, within its own group.
    const colors = [tok('color.accent', 'color', { token: 'color.link' }), tok('color.link', 'color', { token: 'color.brand' }), tok('color.brand', 'color', '#123456')];
    expect([...tokenFollowers(colors, 'color.brand', 'color')].sort()).toEqual(['color.accent', 'color.link']);
    expect([...tokenFollowers(colors, 'color.brand', 'radius')]).toEqual([]);
  });

  it('can all be put back in one step after Pill was made to follow the button corners', () => {
    let s = set(starter(), 'radius.button', '0px');
    s = set(s, 'radius.pill', { token: 'radius.button' });
    // Putting the button corners back first would make them follow Pill, which follows them.
    expect(() => applyOperations(s, [{ type: 'token.set', tokenId: 'radius.button', value: null }])).toThrow(/loop/);
    // Given in the order that fails, Pill is put back first.
    const ids = tokenResetOrder(s, ['radius.button', 'radius.pill']);
    expect(ids).toEqual(['radius.pill', 'radius.button']);
    // Ids it can never put back are kept, last, for the engine to refuse.
    expect(tokenResetOrder(s, ['radius.button'])).toEqual(['radius.button']);
    const back = applyOperations(s, ids.map((tokenId) => ({ type: 'token.set' as const, tokenId, value: null }))).state;
    expect(back.tokens.overrides).toEqual({});
  });
});

describe('putting every style back on a theme whose colours follow each other', () => {
  afterAll(() => restorePacks());
  const color = (id: string, value: TokenDef['value']): TokenDef => ({ id: `color.${id}`, label: id.toUpperCase(), group: 'color', value });
  const link = (id: string) => ({ token: `color.${id}` });
  /** A project on a theme of these colours, with these light and dark values of its own. */
  function linked(themeColors: TokenDef[], light: Record<string, unknown>, dark: Record<string, unknown>): ProjectState {
    const base = getTheme('foundation');
    registerPacks([...listThemes().filter((t) => t.id !== 'linked'), { ...base, id: 'linked', name: 'Linked', tokens: [...base.tokens, ...themeColors] }]);
    const s = starter();
    const own = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`color.${k}`, v]));
    return { ...s, site: { ...s.site, themeId: 'linked' }, tokens: { ...s.tokens, overrides: own(light) as ProjectState['tokens']['overrides'], darkOverrides: own(dark) as NonNullable<ProjectState['tokens']['darkOverrides']> } };
  }
  /** Whether resetting in this order passes no loop on the way, in either palette, and ends with nothing of the owner's. */
  function clean(s: ProjectState, order: string[]): boolean {
    const overrides = { ...s.tokens.overrides };
    for (const id of order) {
      delete overrides[id];
      if (findTokenCycle({ ...s, tokens: { ...s.tokens, overrides } })) return false;
    }
    return Object.keys(overrides).length === 0;
  }

  it('finds an order when the order the styles follow each other in leads there', () => {
    // Putting X back first (the order given) strands A in a light loop and B in a dark one; the theme's chains say B, A, X.
    const s = linked(
      [color('a', link('u')), color('u', link('b')), color('b', link('y')), color('x', link('a')), color('w', link('x')), color('v', '#111111'), color('y', '#222222')],
      { x: '#333333', a: link('v'), b: link('w') },
      { u: '#444444', w: '#555555', v: link('b'), y: link('x') }
    );
    expect(findTokenCycle(s)).toBeNull();
    const ids = Object.keys(s.tokens.overrides);
    expect(clean(s, ids)).toBe(false);
    expect(clean(s, tokenResetOrder(s, ids))).toBe(true);
  });

  it('finds an order when the order given leads there and the theme chains do not', () => {
    const s = linked(
      [color('a', link('c')), color('b', link('a')), color('c', link('d')), color('f', link('b')), color('d', '#111111'), color('e', '#222222')],
      { b: link('e'), a: '#333333', c: link('f') },
      { a: '#444444', f: '#555555', d: link('b'), e: link('c') }
    );
    expect(findTokenCycle(s)).toBeNull();
    expect(clean(s, tokenResetOrder(s, Object.keys(s.tokens.overrides)))).toBe(true);
  });
});

const BROWSER = existsSync(chromium.executablePath());
let browser: Browser | undefined;
beforeAll(async () => {
  if (BROWSER) browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 30_000 });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

type Look = { radius: string; family: string; size: string; weight: string; transform: string; tracking: string; lineHeight: string; height: number; paddingTop: string };

describe.runIf(BROWSER)('a button in a browser', () => {
  /** A primary button, a text button and a filter pill, under the stylesheets a site loads, in the order it loads them. */
  async function looks(s: ProjectState): Promise<Record<'primary' | 'text' | 'pill', Look>> {
    const files = generateProject(s);
    const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
    const tab = await browser!.newPage({ viewport: { width: 1200, height: 600 } });
    try {
      await tab.setContent(`<!doctype html><html><head><style>${css}</style></head><body><a id="primary" class="so-btn so-btn--primary" href="#">Book a visit</a> <a id="text" class="so-btn so-btn--text" href="#">See services</a> <button id="pill" class="so-filter__pill">All</button></body></html>`);
      return (await tab.evaluate(`(() => Object.fromEntries(['primary', 'text', 'pill'].map((id) => {
        const el = document.getElementById(id);
        const c = getComputedStyle(el);
        return [id, { radius: c.borderTopLeftRadius, family: c.fontFamily, size: c.fontSize, weight: c.fontWeight, transform: c.textTransform, tracking: c.letterSpacing, lineHeight: c.lineHeight, height: Math.round(el.getBoundingClientRect().height), paddingTop: c.paddingTop }];
      })))()`)) as Record<'primary' | 'text' | 'pill', Look>;
    } finally {
      await tab.close();
    }
  }

  it('looks as it always did until Buttons is changed', async () => {
    const { primary, text, pill } = await looks(starter());
    expect(primary).toMatchObject({ radius: '999px', weight: '550', transform: 'none', size: '15.52px' });
    expect(primary.family).toMatch(/Inter/);
    expect(primary.height).toBeGreaterThanOrEqual(46);
    expect(text.radius).toBe('0px');
    expect(pill.radius).toBe('999px');
  });

  it('takes its corners and label from Buttons, while pills stay pills and text buttons stay flat', async () => {
    let s = set(starter(), 'radius.button', '4px');
    s = set(s, 'text.button', { family: { token: 'font.display' }, transform: 'uppercase', tracking: '0.08em', weight: 700, size: '1.25rem', lineHeight: '1.5' });
    const { primary, text, pill } = await looks(s);
    expect(primary.lineHeight).toBe('30px');
    expect(primary).toMatchObject({ radius: '4px', weight: '700', transform: 'uppercase', size: '20px', tracking: '1.6px' });
    expect(primary.family).toMatch(/Fraunces/);
    // The padding is in em, so a bigger label makes a bigger button.
    expect(primary.paddingTop).toBe('14px');
    expect(primary.height).toBeGreaterThan(46);
    // A text button takes the label's type, and keeps its own flat shape.
    expect(text).toMatchObject({ radius: '0px', transform: 'uppercase', weight: '700', size: '20px', tracking: '1.6px', paddingTop: '4px' });
    expect(text.family).toMatch(/Fraunces/);
    expect(pill.radius).toBe('999px');
  });

  it('follows Pill until it has corners of its own', async () => {
    const following = await looks(set(starter(), 'radius.pill', '10px'));
    expect(following.primary.radius).toBe('10px');
    const own = await looks(set(set(starter(), 'radius.button', '2px'), 'radius.pill', '10px'));
    expect(own.primary.radius).toBe('2px');
    expect(own.pill.radius).toBe('10px');
    // Linked to another step, it follows that step instead.
    const md = await looks(set(set(starter(), 'radius.button', { token: 'radius.md' }), 'radius.md', '3px'));
    expect(md.primary.radius).toBe('3px');
    expect(md.pill.radius).toBe('999px');
  });
});
