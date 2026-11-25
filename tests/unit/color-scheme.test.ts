/**
 * Visitor light and dark palettes (issue #389): the dark palette made from the light one, the edits that keep it, and
 * what the generated site gets in each mode. A site with one palette gets exactly what it always did.
 */
import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { getTheme } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { findTokenCycle } from '@engine/tokens';
import { validateState } from '@engine/validate';
import { RUNTIME_DIR, STYLES_DIR, effectiveTokens, generateProject, generateTokensCss } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { THEME_BOOTSTRAP, THEME_TOGGLE_FILE } from '@generator/color-scheme';
import { colorSchemeMode, deriveDarkPalette, withDarkPalette } from '@shared/color-scheme';
import { evaluatePairs } from '@shared/contrast';
import { tokensSummary } from '../../src/agent/context';
import { fieldKey } from '../../src/renderer/src/lib/held';

const fresh = () => createStarterState('business', 'Palette Studio', false);
const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const withMode = (s: ProjectState, mode: 'single' | 'system' | 'toggle') => run(s, { type: 'token.setColorScheme', mode });
const pairsOf = (s: ProjectState) => getTheme(s.site.themeId).contrastPairs ?? [];
const failing = (s: ProjectState, scheme: 'light' | 'dark') => evaluatePairs(effectiveTokens(s, scheme), pairsOf(s)).filter((r) => r.status !== 'pass');

describe('the dark palette made from the light one', () => {
  it('keeps every pair Foundation sets against each other readable, the same every time', () => {
    const s = fresh();
    const dark = deriveDarkPalette(effectiveTokens(s), getTheme(s.site.themeId).tokens, pairsOf(s));
    expect(dark).toEqual(deriveDarkPalette(effectiveTokens(s), getTheme(s.site.themeId).tokens, pairsOf(s)));
    expect(Object.values(dark).every((v) => typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v))).toBe(true);
    const tokens = withDarkPalette(effectiveTokens(s), dark);
    const results = evaluatePairs(tokens, pairsOf(s));
    expect(results.length).toBeGreaterThan(10);
    expect(results.filter((r) => r.status !== 'pass')).toEqual([]);
    // Dark grounds, light text, and the brand's hue kept.
    expect(dark['color.background']).toMatch(/^#[0-2]/);
    expect(dark['color.text']).toMatch(/^#[d-f]/);
  });

  it('follows the brand the author chose, and stays readable for a bright one', () => {
    const s = run(fresh(), { type: 'token.set', tokenId: 'color.brand', value: '#ff2d55' }, { type: 'token.set', tokenId: 'color.accent', value: '#ffe600' });
    const on = withMode(s, 'system');
    expect(on.tokens.darkOverrides?.['color.brand']).not.toEqual(withMode(fresh(), 'system').tokens.darkOverrides?.['color.brand']);
    expect(failing(on, 'dark')).toEqual([]);
  });

  it('keeps a role that follows another following it, within the dark palette', () => {
    const s = run(fresh(), { type: 'token.set', tokenId: 'color.brand-strong', value: { token: 'color.brand' } });
    const on = withMode(s, 'system');
    expect(on.tokens.darkOverrides).not.toHaveProperty('color.brand-strong');
    const dark = effectiveTokens(on, 'dark');
    expect(dark.find((t) => t.id === 'color.brand-strong')?.value).toEqual({ token: 'color.brand' });
  });
});

describe('choosing the palettes', () => {
  it('makes the dark palette the first time, keeps it while one palette is chosen, and makes it again on request', () => {
    const s = fresh();
    expect(colorSchemeMode(s.tokens)).toBe('single');
    expect(s.tokens).not.toHaveProperty('colorSchemeMode');
    expect(s.tokens).not.toHaveProperty('darkOverrides');
    const on = withMode(s, 'system');
    expect(on.tokens.colorSchemeMode).toBe('system');
    expect(Object.keys(on.tokens.darkOverrides ?? {})).toContain('color.background');
    const edited = run(on, { type: 'token.set', tokenId: 'color.background', value: '#000000', scheme: 'dark' });
    const off = withMode(edited, 'single');
    expect(off.tokens).not.toHaveProperty('colorSchemeMode');
    expect(off.tokens.darkOverrides?.['color.background']).toBe('#000000');
    // Back on (either way), as it was left.
    expect(withMode(off, 'toggle').tokens.darkOverrides?.['color.background']).toBe('#000000');
    const remade = run(edited, { type: 'token.setColorScheme', mode: 'system', regenerate: true });
    expect(remade.tokens.darkOverrides?.['color.background']).toBe(on.tokens.darkOverrides?.['color.background']);
    expect(() => run(off, { type: 'token.setColorScheme', mode: 'single', regenerate: true })).toThrow(/one palette/);
  });

  it('sets, links and resets dark colors, and only colors, only with a dark palette', () => {
    const s = fresh();
    expect(() => run(s, { type: 'token.set', tokenId: 'color.text', value: '#ffffff', scheme: 'dark' })).toThrow(/one palette/);
    const on = withMode(s, 'toggle');
    expect(() => run(on, { type: 'token.set', tokenId: 'space.md', value: '20px', scheme: 'dark' })).toThrow(/Only colors/);
    expect(() => run(on, { type: 'token.set', tokenId: 'color.text', value: 'red; x', scheme: 'dark' })).toThrow();
    expect(() => run(on, { type: 'token.set', tokenId: 'color.text', value: { token: 'space.md' }, scheme: 'dark' })).toThrow(/color style/);
    const linked = run(on, { type: 'token.set', tokenId: 'color.focus', value: { token: 'color.accent' }, scheme: 'dark' });
    expect(linked.tokens.darkOverrides?.['color.focus']).toEqual({ token: 'color.accent' });
    // The light palette is untouched by dark edits.
    expect(linked.tokens.overrides).toEqual(s.tokens.overrides);
    const reset = run(linked, { type: 'token.set', tokenId: 'color.focus', value: null, scheme: 'dark' });
    expect(reset.tokens.darkOverrides).not.toHaveProperty('color.focus');
    expect(effectiveTokens(reset, 'dark').find((t) => t.id === 'color.focus')?.value).toEqual(effectiveTokens(reset).find((t) => t.id === 'color.focus')?.value);
    expect(validateState(linked).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('refuses links that loop once the dark palette is laid over the light one, turned on or not', () => {
    // Dark Accent follows Brand; Brand has no dark color of its own and follows Accent in the light palette: each map
    // alone is fine, together they loop in the dark palette.
    let s = withMode(fresh(), 'system');
    s = run(s, { type: 'token.set', tokenId: 'color.brand', value: null, scheme: 'dark' }, { type: 'token.set', tokenId: 'color.accent', value: { token: 'color.brand' }, scheme: 'dark' });
    expect(() => run(s, { type: 'token.set', tokenId: 'color.brand', value: { token: 'color.accent' } })).toThrow(/dark palette's colors refer to each other in a loop/);
    expect(() => run(withMode(s, 'single'), { type: 'token.set', tokenId: 'color.brand', value: { token: 'color.accent' } })).toThrow(/loop/);
    // The other way round too: a dark link that closes a loop through light links.
    const lit = run(fresh(), { type: 'token.set', tokenId: 'color.brand', value: { token: 'color.accent' } });
    const on = run(withMode(lit, 'system'), { type: 'token.set', tokenId: 'color.brand', value: null, scheme: 'dark' });
    expect(() => run(on, { type: 'token.set', tokenId: 'color.accent', value: { token: 'color.brand' }, scheme: 'dark' })).toThrow(/loop/);
    // A hand-edited loop is reported.
    const hand = structuredClone(on);
    hand.tokens.darkOverrides!['color.accent'] = { token: 'color.brand' };
    expect(findTokenCycle(hand)).not.toBeNull();
  });

  it('keeps the dark palette right when one of your own colors is replaced or removed', () => {
    let s = withMode(fresh(), 'toggle');
    const created = applyOperations(s, [{ type: 'token.create', group: 'color', label: 'Sea green', value: '#2e8b57' }]);
    const sea = created.results[0].tokenId as string;
    s = run(created.state, { type: 'token.set', tokenId: sea, value: '#9fe0bb', scheme: 'dark' }, { type: 'token.set', tokenId: 'color.focus', value: { token: sea }, scheme: 'dark' });
    // Replaced: the dark palette's link moves with every other use.
    const replaced = run(s, { type: 'token.remove', tokenId: sea, replacementTokenId: 'color.accent' });
    expect(replaced.tokens.darkOverrides?.['color.focus']).toEqual({ token: 'color.accent' });
    expect(replaced.tokens.darkOverrides).not.toHaveProperty(sea);
    // Kept as values: each palette keeps the color it showed.
    const kept = run(s, { type: 'token.remove', tokenId: sea, detach: true });
    expect(kept.tokens.darkOverrides?.['color.focus']).toBe('#9fe0bb');
    expect(kept.tokens.darkOverrides).not.toHaveProperty(sea);
    // A light link to it, with no dark color of its own, kept the dark color it showed.
    const aliased = run(s, { type: 'token.set', tokenId: 'color.border', value: { token: sea } }, { type: 'token.set', tokenId: 'color.border', value: null, scheme: 'dark' });
    const detached = run(aliased, { type: 'token.remove', tokenId: sea, detach: true });
    expect(detached.tokens.overrides['color.border']).toBe('#2e8b57');
    expect(detached.tokens.darkOverrides?.['color.border']).toBe('#9fe0bb');
    // Used directly by a page, a color that differs between palettes cannot be kept as one value.
    const home = s.pages[s.site.homePageId];
    const styled = run(s, { type: 'node.setStyle', owner: { kind: 'page', id: home.id }, nodeId: home.rootIds[0], scope: 'base', property: 'color', value: { token: sea } } as EditOperation);
    expect(() => run(styled, { type: 'token.remove', tokenId: sea, detach: true })).toThrow(/different color in the dark palette/);
    expect(run(withMode(styled, 'single'), { type: 'token.remove', tokenId: sea, detach: true }).tokens.custom.some((t) => t.id === sea)).toBe(false);
  });
});

describe('what the site gets in each mode', () => {
  const files = (s: ProjectState, instrument = false) => generateProject(s, { instrument });
  const tokensCss = (s: ProjectState) => files(s).get(`${STYLES_DIR}/tokens.css`)!;

  it('gives a site with one palette exactly what it always had, whatever dark colors it keeps', () => {
    const plain = fresh();
    const css = tokensCss(plain);
    expect(css).not.toMatch(/color-scheme|@media|data-so-theme/);
    expect(css.endsWith('}\n')).toBe(true);
    // Turned on and off again: the kept dark colors change nothing.
    const off = withMode(run(withMode(plain, 'toggle'), { type: 'token.set', tokenId: 'color.text', value: '#ffffff', scheme: 'dark' }), 'single');
    expect(off.tokens.darkOverrides).toBeDefined();
    for (const instrument of [false, true]) expect([...files(off, instrument)]).toEqual([...files(plain, instrument)]);
    const layout = files(plain).get('src/routes/+layout.svelte')!;
    expect(layout).not.toContain('localStorage');
    expect(layout).not.toContain('ThemeToggle');
    expect(files(plain).has(`${RUNTIME_DIR}/${THEME_TOGGLE_FILE}`)).toBe(false);
    expect(files(plain).get(`${RUNTIME_DIR}/visitor-text.js`)).not.toContain('themeToggle');
    expect(files(plain).get(`${STYLES_DIR}/site.css`)).not.toContain('so-theme-toggle');
  });

  it('adds the dark palette on screens that ask for dark, and prints the light one, for a site that follows the device', () => {
    const base = fresh();
    const s = withMode(base, 'system');
    const css = tokensCss(s);
    const light = tokensCss(base);
    // The light palette is as it was, and says so.
    expect(css.startsWith(light.slice(0, -2))).toBe(true);
    expect(css).toContain('\tcolor-scheme: light;\n}');
    expect(css).toContain('@media screen and (prefers-color-scheme: dark) {\n\t:root {\n\t\tcolor-scheme: dark;');
    expect(css).toContain(`\t\t--so-color-background: ${s.tokens.darkOverrides!['color.background']};`);
    expect(css).toContain('@media print {\n\t:root {\n\t\tcolor-scheme: light;');
    expect(css).not.toContain('data-so-theme');
    // Only the stylesheet changes: no switch, no script.
    expect(files(s).get('src/routes/+layout.svelte')).toEqual(files(base).get('src/routes/+layout.svelte'));
    expect(files(s).has(`${RUNTIME_DIR}/${THEME_TOGGLE_FILE}`)).toBe(false);
  });

  it('adds the switch, its rules and the remembered choice for a site whose visitors switch', () => {
    const s = run(withMode(fresh(), 'toggle'), { type: 'token.set', tokenId: 'color.focus', value: { token: 'color.accent' }, scheme: 'dark' });
    const css = tokensCss(s);
    expect(css).toContain('\t:root:not([data-so-theme="light"]) {');
    expect(css).toContain('@media screen {\n\t:root[data-so-theme="dark"] {');
    expect(css).toContain('\t\t--so-color-focus: var(--so-color-accent);');
    expect(css).toContain('\t.so-theme-toggle {\n\t\tdisplay: none !important;');
    const clean = files(s);
    const layout = clean.get('src/routes/+layout.svelte')!;
    expect(layout).toContain(`<svelte:head>\n\t${THEME_BOOTSTRAP}`);
    expect(layout).toContain(`import { startThemeToggle } from '../lib/siteorigin/runtime/${THEME_TOGGLE_FILE}';`);
    expect(layout).toContain('return startThemeToggle(() => text().themeToggle);');
    expect(clean.get(`${RUNTIME_DIR}/${THEME_TOGGLE_FILE}`)).toContain('localStorage.setItem(KEY, next)');
    expect(clean.get(`${RUNTIME_DIR}/visitor-text.js`)).toContain('"themeToggle": "Dark mode"');
    expect(clean.get(`${STYLES_DIR}/site.css`)).toContain('.so-theme-toggle {');
    // The editor's preview has the switch but remembers nothing, so the canvas's own Light and Dark stay in charge.
    const dev = files(s, true);
    expect(dev.get('src/routes/+layout.svelte')).not.toContain('localStorage');
    expect(dev.get(`${RUNTIME_DIR}/${THEME_TOGGLE_FILE}`)).not.toContain('localStorage');
    expect(dev.get('src/routes/+layout.svelte')).toContain('startThemeToggle');
    for (const [path, source] of [...clean, ...dev])
      if (path.endsWith('.svelte')) for (const generate of ['server', 'client'] as const) expect(() => compile(source, { filename: path, generate, runes: true }), path).not.toThrow();
  });

  it('never writes an unsafe or broken dark declaration from a hand-edited document', () => {
    const s = withMode(fresh(), 'toggle');
    s.tokens.darkOverrides = { 'color.text': '#fff; } body { visibility: hidden', 'color.muted': { token: 'space.md' }, 'space.md': '99px', 'color.border': 12 as never, 'color.nope': '#000' };
    const css = generateTokensCss(s);
    expect(css).not.toContain('visibility');
    expect(css).not.toMatch(/--so-color-muted: var\(--so-space/);
    expect(css).not.toMatch(/\t\t--so-space-md/);
    expect(css).not.toContain('--so-color-border: 12');
    expect(css).not.toContain('--so-color-nope');
    // Each one left out is said.
    const warnings = validateState(s).filter((d) => d.severity === 'warning' && d.message.includes('dark palette')).map((d) => d.message);
    expect(warnings).toHaveLength(4);
    expect(warnings.join('\n')).toMatch(/"space\.md", which is not a color/);
    expect(warnings.join('\n')).toMatch(/"color\.muted" follows "space\.md"/);
  });

  it('makes again only what a change of palettes reaches, the same bytes as a full run', () => {
    const cache = new GenerationCache();
    let s = fresh();
    for (const mode of ['toggle', 'system', 'single', 'toggle'] as const) {
      s = withMode(s, mode);
      for (const opts of [{}, { instrument: true }]) expect([...generateProject(s, opts, cache)]).toEqual([...generateProject(s, opts)]);
    }
    s = run(s, { type: 'token.set', tokenId: 'color.text', value: '#fafafa', scheme: 'dark' });
    expect([...generateProject(s, {}, cache)]).toEqual([...generateProject(s)]);
  });
});

describe('the assistant and held edits', () => {
  it('tells the assistant each color in both palettes', () => {
    expect(tokensSummary(fresh()).find((t) => t.id === 'color.text')).not.toHaveProperty('darkValue');
    const s = withMode(fresh(), 'system');
    const text = tokensSummary(s).find((t) => t.id === 'color.text');
    expect(text).toMatchObject({ darkValue: s.tokens.darkOverrides!['color.text'], darkOverridden: true });
    expect(tokensSummary(s).find((t) => t.id === 'space.md')).not.toHaveProperty('darkValue');
  });

  it('keeps a dark color and its light one as different fields', () => {
    const light: EditOperation = { type: 'token.set', tokenId: 'color.brand', value: '#000000' };
    expect(fieldKey([light])).not.toBe(fieldKey([{ ...light, scheme: 'dark' } as EditOperation]));
    expect(fieldKey([{ ...light, scheme: 'dark' } as EditOperation])).toBe(fieldKey([{ ...light, value: '#ffffff', scheme: 'dark' } as EditOperation]));
  });
});
