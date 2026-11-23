import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { assetUsages } from '@engine/apply';
import { generateProject } from '@generator/index';
import { fontFaceCss, importedFontStack, projectFontFamilies, renameFontFamily, stackUsesFamily } from '@shared/fonts';
import { validateOperation } from '@shared/ops';
import type { AssetRecord } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-fonts-'));
  dirs.push(dir);
  return { dir, s: await ProjectSession.create(dir, createStarterState('business', 'Fonts', false)) };
}
const face = (id: string, weight: string, style: 'normal' | 'italic' = 'normal', family = 'Brand Sans', ext = 'woff2'): AssetRecord => ({
  id,
  name: `${family} ${weight}`,
  file: `static/assets/brand-${id}-1a2b3c4d.${ext}`,
  mime: `font/${ext}`,
  bytes: 1000,
  hash: `hash-${id}`,
  kind: 'font',
  createdAt: '2026-01-01T00:00:00.000Z',
  font: { family, weight, style }
});
const add = (a: AssetRecord) => ({ type: 'asset.add' as const, asset: a });

describe('imported fonts', () => {
  it('keeps font metadata through the operation schema and rejects unsafe family names', () => {
    const ok = validateOperation(add(face('f1', '700', 'italic')));
    expect(ok.ok && ok.op.type === 'asset.add' && ok.op.asset.font).toEqual({ family: 'Brand Sans', weight: '700', style: 'italic' });
    expect(validateOperation(add(face('f2', '400', 'normal', "x'; } body { color: red"))).ok).toBe(false);
    expect(validateOperation({ type: 'asset.update', assetId: 'f1', font: { family: 'Ok', weight: 'bold', style: 'normal' } }).ok).toBe(false);
  });

  it('emits @font-face rules in the generated CSS, in a stable order', async () => {
    const { dir, s } = await make();
    const r = await s.apply({ operations: [add(face('f2', '700')), add(face('f1', '100 900', 'italic', 'Brand Sans', 'woff'))] }, { label: 'Import fonts' });
    expect(r.ok).toBe(true);
    const css = readFileSync(join(dir, 'src/lib/siteorigin/styles/tokens.css'), 'utf8');
    expect(css).toContain("font-family: 'Brand Sans';");
    expect(css).toContain("src: url('/assets/brand-f2-1a2b3c4d.woff2') format('woff2');");
    expect(css).toContain("src: url('/assets/brand-f1-1a2b3c4d.woff') format('woff');");
    expect(css).toContain('font-weight: 100 900;');
    expect(css).toContain('font-style: italic;');
    expect(css).toContain('font-display: swap;');
    expect(css.indexOf('brand-f1')).toBeLessThan(css.indexOf('brand-f2'));
    expect(css.indexOf('@font-face')).toBeLessThan(css.indexOf(':root'));
    expect(generateProject(s.state).get('src/lib/siteorigin/styles/tokens.css')).toBe(css);
  });

  it('emits nothing for a project without imported fonts', () => {
    expect(fontFaceCss(createStarterState('business', 'Plain', false))).toBe('');
  });

  it('groups faces by family and counts a family as used while a style names it', async () => {
    const { s } = await make();
    await s.apply({ operations: [add(face('f1', '400')), add(face('f2', '700')), add(face('f3', '400', 'normal', 'Other'))] }, { label: 'Import' });
    expect(projectFontFamilies(s.state).map((f) => [f.family, f.faces.length])).toEqual([['Brand Sans', 2], ['Other', 1]]);
    expect(assetUsages(s.state).f1).toBeUndefined();
    const r = await s.apply({ operations: [{ type: 'token.set', tokenId: 'font.display', value: importedFontStack('Brand Sans') }] }, { label: 'Use font' });
    expect(r.ok).toBe(true);
    const usage = assetUsages(s.state);
    expect(usage.f1).toBe(1);
    expect(usage.f2).toBe(1);
    expect(usage.f3).toBeUndefined();
    expect(stackUsesFamily("'Brand Sans Bold', serif", 'Brand Sans')).toBe(false);
  });

  it('protects the last file of a family in use, but lets another face go', async () => {
    const { s } = await make();
    await s.apply({ operations: [add(face('f1', '400')), add(face('f2', '700')), { type: 'token.set', tokenId: 'font.display', value: importedFontStack('Brand Sans') }] }, { label: 'Import' });
    expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f2' }] }, { label: 'Remove' })).ok).toBe(true);
    const last = await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f1' }] }, { label: 'Remove' });
    expect(last.ok).toBe(false);
    expect(last.error?.message).toMatch(/This font is used/);
  });

  it('never emits a rule from a font record edited into something unsafe', () => {
    const state = createStarterState('business', 'Edited', false);
    const evil = (patch: Partial<AssetRecord>, font: Partial<NonNullable<AssetRecord['font']>> = {}) => ({ ...face('x', '400'), ...patch, font: { ...face('x', '400').font!, ...font } });
    state.assets.assets = {
      a: evil({ id: 'a' }, { family: "x'; } body { display: none } @font-face { font-family: 'y" }),
      b: evil({ id: 'b' }, { weight: '400; src: url(https://evil.example/f)' }),
      c: evil({ id: 'c' }, { style: 'normal; color: red' as 'normal' }),
      d: evil({ id: 'd', file: "static/assets/x.woff2') ; } body { color: red" })
    };
    expect(fontFaceCss(state)).toBe('');
    expect(generateProject(state).get('src/lib/siteorigin/styles/tokens.css')).not.toMatch(/evil|display: none|color: red/);
  });

  it('orders rules the same whatever the locale', () => {
    const state = createStarterState('business', 'Order', false);
    state.assets.assets = { a: face('a', '400', 'normal', 'Zebra'), b: face('b', '400', 'normal', 'Émile') };
    // By code unit, "Z" sorts before "É"; a locale-aware sort would put Émile first.
    expect(projectFontFamilies(state).map((f) => f.family)).toEqual(['Zebra', 'Émile']);
  });

  it('counts real font uses only', async () => {
    const { s } = await make();
    const home = s.state.site.homePageId;
    await s.apply({ operations: [add(face('f1', '400')), { type: 'page.update', pageId: home, title: 'Brand Sans' }] }, { label: 'Title matches' });
    expect(assetUsages(s.state).f1).toBeUndefined();
    // Later in a stack, and in another case, is still a use.
    await s.apply({ operations: [{ type: 'token.set', tokenId: 'font.display', value: "Georgia, 'brand sans', serif" }] }, { label: 'Use font' });
    expect(assetUsages(s.state).f1).toBe(1);
  });

  it('accepts a family with non-ASCII letters as a font token', async () => {
    const { s } = await make();
    const r = await s.apply({ operations: [add(face('f1', '400', 'normal', 'Café Sans')), { type: 'token.set', tokenId: 'font.display', value: importedFontStack('Café Sans') }] }, { label: 'Use font' });
    expect(r.ok).toBe(true);
  });

  it('never replaces an image with a font', async () => {
    const { s } = await make();
    const image: AssetRecord = { ...face('i1', '400'), id: 'i1', kind: 'image', mime: 'image/png', file: 'static/assets/pic-1a2b3c4d.png', font: undefined };
    await s.apply({ operations: [add(image), add(face('f1', '400'))] }, { label: 'Import' });
    const r = await s.apply({ operations: [{ type: 'asset.replace', assetId: 'i1', withAssetId: 'f1' }] }, { label: 'Replace' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/Only an image/);
  });

  it('renames a family wherever it is written, leaving other values alone', () => {
    const state = createStarterState('business', 'Rename', false);
    const page = state.pages[state.site.homePageId];
    const nodeId = Object.keys(page.nodes)[0];
    (page.nodes[nodeId] as { styles?: unknown }).styles = { base: { fontFamily: "Georgia, 'Old Name', serif" } };
    page.title = 'Old Name';
    state.tokens.overrides['font.display'] = importedFontStack('Old Name');
    state.tokens.overrides['font.body'] = { token: 'font.display' };
    state.tokens.overrides['color.brand'] = 'Old Name';
    renameFontFamily(state, 'Old Name', 'New Name');
    expect((page.nodes[nodeId] as unknown as { styles: { base: { fontFamily: string } } }).styles.base.fontFamily).toBe("Georgia, 'New Name', serif");
    expect(state.tokens.overrides['font.display']).toBe(importedFontStack('New Name'));
    expect(state.tokens.overrides['font.body']).toEqual({ token: 'font.display' });
    expect(state.tokens.overrides['color.brand']).toBe('Old Name');
    expect(page.title).toBe('Old Name');
  });

  it('moves styles to the new name when a family is renamed', async () => {
    const { s } = await make();
    await s.apply({ operations: [add(face('f1', '400')), add(face('f2', '700')), { type: 'token.set', tokenId: 'font.display', value: importedFontStack('Brand Sans') }] }, { label: 'Import' });
    const rename = (id: string, weight: string) => ({ type: 'asset.update' as const, assetId: id, font: { family: 'New Name', weight, style: 'normal' as const } });
    // Half-way through, a file still provides the old name, so the style keeps it.
    await s.apply({ operations: [rename('f1', '400')] }, { label: 'Rename one' });
    expect(s.state.tokens.overrides['font.display']).toBe(importedFontStack('Brand Sans'));
    await s.apply({ operations: [rename('f2', '700')] }, { label: 'Rename two' });
    expect(s.state.tokens.overrides['font.display']).toBe(importedFontStack('New Name'));
    expect(assetUsages(s.state).f1).toBe(1);
  });
});
