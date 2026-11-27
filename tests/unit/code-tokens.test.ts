/**
 * A component's `var(--so-…)` against the theme's tokens: a name the theme does not define compiles and renders its
 * fallback unnoticed, so the code check names it (with the nearest token) and a bundled theme may have none.
 */
import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { listThemes } from '@catalogue/index';
import { packTokenProblems } from '../../src/main/packs/build';
import { checkSvelteSource, projectTokenVars } from '../../src/main/codecheck';
import { tokenVarNames } from '@shared/styles';

const TOKENS = tokenVarNames([
  { id: 'color.brand', group: 'color' },
  { id: 'space.md', group: 'space' },
  { id: 'text.h1', group: 'text' }
]);

const component = (style: string, markup = '<p>Hi</p>') => `<script>\n\tlet { title = 'x' } = $props();\n</script>\n\n${markup}\n\n<style>\n${style}\n</style>\n`;
const tokenProblems = async (source: string, opts: { strict?: boolean } = {}) =>
  (await checkSvelteSource(source, { tokens: TOKENS, ...opts })).filter((p) => p.message.includes('not a token of this theme'));

describe('theme token names in component code', () => {
  it('accepts tokens the theme defines, a text style by metric, and a variable the component sets itself', async () => {
    const source = component('p { color: var(--so-color-brand); padding: var(--so-space-md, 1rem); font-size: var(--so-text-h1-size); gap: var(--so-gap); --so-gap: 2px; }', '<p style="color: var(--so-color-brand)">Hi</p>');
    expect(await tokenProblems(source)).toEqual([]);
  });

  it('leaves the variables the generated site sets (a button colour, the header offset) alone', async () => {
    expect(await tokenProblems(component('p { color: var(--so-surface-ink, var(--so-color-brand)); top: var(--so-header-offset, 4rem); background: var(--so-btn-bg); }'))).toEqual([]);
  });

  it('flags a misspelling with the nearest token, as a warning by default and an error in strict mode', async () => {
    const source = component('p { color: var(--so-color-brnd); }');
    expect(await tokenProblems(source)).toEqual([expect.objectContaining({ severity: 'warning', line: 8, message: '--so-color-brnd is not a token of this theme. Did you mean --so-color-brand?' })]);
    expect(await tokenProblems(source, { strict: true })).toEqual([expect.objectContaining({ severity: 'error', message: expect.stringContaining('Did you mean --so-color-brand?') })]);
  });

  it('names an invented token, with a suggestion only when one is close', async () => {
    const [near] = await tokenProblems(component('p { color: var(--so-color-primary); }'));
    expect(near.message).toBe('--so-color-primary is not a token of this theme. Did you mean --so-color-brand?');
    const [far] = await tokenProblems(component('p { color: var(--so-zzzzzzzzzzzzzzzzzzzz); }'));
    expect(far.message).toBe('--so-zzzzzzzzzzzzzzzzzzzz is not a token of this theme.');
  });

  it('flags a fallback-only use: the fallback is what hides the mistake', async () => {
    expect(await tokenProblems(component('p { padding: var(--so-space-mdd, 1rem); }'))).toHaveLength(1);
    expect(await tokenProblems(component('p { color: var(--so-nope, var(--so-colour-brand, red)); }'))).toHaveLength(2);
  });

  it('reads inline styles in the markup, and ignores comments', async () => {
    expect(await tokenProblems(component('', '<p style="margin: var(--so-space-mdx)">Hi</p>'))).toHaveLength(1);
    expect(await tokenProblems(component('/* var(--so-oops) */ p { color: red; }', '<!-- var(--so-oops) --><p>Hi</p>'))).toEqual([]);
  });

  it('reads var( in any case, and reports each line a typo is on', async () => {
    expect(await tokenProblems(component('p { color: VAR(--so-color-brnd, red); }'))).toHaveLength(1);
    expect(await tokenProblems(component('p { color: var(--so-nope); }\na { color: var(--so-nope); }'))).toHaveLength(2);
  });

  it('checks nothing without a token list', async () => {
    expect((await checkSvelteSource(component('p { color: var(--so-nope); }'))).filter((p) => p.message.includes('not a token'))).toEqual([]);
  });

  it('is built from the project theme, so a project token counts', () => {
    const state = createStarterState('business', 'Tokens', false);
    const vars = projectTokenVars(state);
    expect(vars.has('--so-color-brand')).toBe(true);
    expect(vars.has('--so-text-h1-size')).toBe(true);
    expect(vars.has('--so-color-primary')).toBe(false);
    state.tokens.custom.push({ id: 'color.sunset', label: 'Sunset', group: 'color', value: '#f80' });
    expect(projectTokenVars(state).has('--so-color-sunset')).toBe(true);
  });
});

describe('bundled themes', () => {
  it('name no CSS variable their own theme does not define', () => {
    // The committed releases, as the app loads them (tests/unit/setup.ts).
    expect(listThemes().map((p) => p.id)).toEqual(['foundation', 'foundation-alt']);
    for (const pack of listThemes()) expect(packTokenProblems(pack), pack.id).toEqual([]);
  });

  it('the pack check reports one that is misspelled', async () => {
    const pack = listThemes()[0];
    const code = pack.components.find((c) => c.kind === 'code' && c.source)!;
    const broken = { ...pack, components: [{ ...code, source: component('p { color: var(--so-color-brnd); }') }] };
    expect(packTokenProblems(broken)[0]).toContain('--so-color-brnd is not a token of this theme.');
  });
});
