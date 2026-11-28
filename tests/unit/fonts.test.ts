import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { installedFonts, resolveFontStack } from '@catalogue/fonts';
import { applyOperations, assetUsages } from '@engine/apply';
import { generateProject } from '@generator/index';
import { familiesUsedBy, familyUses, fontFaceCss, importedFontStack, projectFontFamilies, renameFontFamily, stackFallback, stackUsesFamily, withFallback } from '@shared/fonts';
import { validateOperation } from '@shared/ops';
import type { AssetRecord, ComponentDefinition } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';
import { foundationDesign } from './fixtures/packs';

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
  it('finds the families a component package uses: element fonts, site style stacks, and code naming them in its source or a default (#1418)', () => {
    const families = ['Brand Sans', 'Shore', 'Harbour', 'Unused'];
    const managed = { kind: 'managed', tree: { nodes: { a: { styles: { base: { fontFamily: "'Brand Sans', serif" } }, variants: { hover: { fontFamily: 'Shore' } } } } } };
    const code = { kind: 'code', source: '<p style:font-family={face}>Hi</p>', properties: { face: { type: 'string', default: "'Harbour', serif" } } };
    expect(familiesUsedBy(families, [managed, code])).toEqual(['Brand Sans', 'Shore', 'Harbour']);
    expect(familiesUsedBy(families, [], ["'Unused', sans-serif"])).toEqual(['Unused']);
    // A managed component's property default is no font: only its styles are.
    expect(familiesUsedBy(families, [{ kind: 'managed', properties: { t: { default: 'Harbour' } } }])).toEqual([]);
  });

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

  it('removes a file of a family in use only with a choice for its uses, and never keeps a family on no files', async () => {
    const { s } = await make();
    await s.apply({ operations: [add(face('f1', '400')), add(face('f2', '400', 'italic')), { type: 'token.set', tokenId: 'font.display', value: importedFontStack('Brand Sans') }] }, { label: 'Import' });
    // Issue 247: the upright file went at once because an italic one remained, and every paragraph turned italic.
    const plain = await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f1' }] }, { label: 'Remove' });
    expect(plain.ok).toBe(false);
    expect(plain.error?.message).toMatch(/This font is used 1 time\. Text drawn with this file of Brand Sans would be drawn with another of its files/);
    expect(s.state.assets.assets.f1).toBeDefined();
    // Kept on its other file, the family stays where it is.
    expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f1', fontUses: 'keep' }] }, { label: 'Remove' })).ok).toBe(true);
    expect(s.state.tokens.overrides['font.display']).toBe(importedFontStack('Brand Sans'));
    // The last file cannot be kept: its uses go to another font or fall back.
    const last = await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f2', fontUses: 'keep' }] }, { label: 'Remove' });
    expect(last.ok).toBe(false);
    expect(last.error?.message).toMatch(/last file of Brand Sans/);
    expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f2' }] }, { label: 'Remove' })).error?.message).toMatch(/This font is used 1 time\. Replace or remove/);
    // Falling back, each style goes to its own next font, and one that named only the family to the default.
    const styles = await s.apply({ operations: [{ type: 'token.set', tokenId: 'font.display', value: "'Brand Sans'" }, { type: 'token.set', tokenId: 'font.body', value: "'Brand Sans', Georgia, serif" }] }, { label: 'Styles' });
    expect(styles.ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f2', fontUses: 'fallback' }] }, { label: 'Remove' })).ok).toBe(true);
    expect(s.state.tokens.overrides['font.display']).toBe('system-ui, sans-serif');
    expect(s.state.tokens.overrides['font.body']).toBe('Georgia, serif');
    expect(s.state.assets.assets.f2).toBeUndefined();
  });

  it('puts another font in place of a removed family everywhere the site names it, in one Undo step', async () => {
    const { s } = await make();
    const pageId = Object.keys(s.state.pages)[0];
    await s.apply({ operations: [add(face('f1', '400')), add(face('f2', '400', 'normal', 'Other'))] }, { label: 'Import' });
    const stack = importedFontStack('Brand Sans');
    // A font token it leads, another it only backs up, and an element font on a page.
    const r = await s.apply(
      {
        operations: [
          { type: 'token.set', tokenId: 'font.display', value: stack },
          { type: 'token.set', tokenId: 'font.body', value: "Georgia, 'Brand Sans', serif" }
        ]
      },
      { label: 'Use fonts' }
    );
    expect(r.ok).toBe(true);
    const tree = s.state.pages[pageId];
    const nodeId = tree.rootIds[0];
    expect((await s.apply({ operations: [{ type: 'node.setStyle', owner: { kind: 'page', id: pageId }, nodeId, scope: 'base', property: 'fontFamily', value: stack }] }, { label: 'Style' })).ok).toBe(true);
    expect(familyUses(s.state, 'brand sans')).toEqual(
      expect.arrayContaining([{ kind: 'token', tokenId: 'font.display' }, { kind: 'token', tokenId: 'font.body' }, { kind: 'element', owner: { kind: 'page', id: pageId } }])
    );
    expect(familyUses(s.state, 'brand sans')).toHaveLength(3);
    const nodeFont = () => JSON.stringify(s.state.pages[pageId].nodes[nodeId]).match(/"fontFamily":"([^"]*)"/)?.[1];
    expect(nodeFont()).toBe(stack);
    // Choices outside the three, and stacks that aren't plain font names, are refused with nothing changed.
    expect(validateOperation({ type: 'asset.remove', assetId: 'f1', fontUses: 'drop' }).ok).toBe(false);
    const before = s.revision;
    for (const replaceWith of ['Georgia; color: red', ", 'Brand Sans', Georgia", 'Georgia,, serif'])
      expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f1', fontUses: { replaceWith } }] }, { label: 'Remove' })).error?.message).toMatch(/Font stacks may contain/);
    expect(s.revision).toBe(before);
    expect(s.state.assets.assets.f1).toBeDefined();
    // A replacement that names the family itself, or a font the site does not have, is refused.
    expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f1', fontUses: { replaceWith: stack } }] }, { label: 'Remove' })).error?.message).toMatch(/other than Brand Sans/);
    expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f1', fontUses: { replaceWith: "'Nowhere Sans', serif" } }] }, { label: 'Remove' })).ok).toBe(false);
    const done = await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f1', fontUses: { replaceWith: importedFontStack('Other') } }] }, { label: 'Remove Brand Sans' });
    expect(done.ok).toBe(true);
    expect(s.state.tokens.overrides['font.display']).toBe(importedFontStack('Other'));
    expect(s.state.tokens.overrides['font.body']).toBe('Georgia, serif');
    expect(nodeFont()).toBe(importedFontStack('Other'));
    expect(JSON.stringify(s.state.pages[pageId])).not.toMatch(/Brand Sans/);
    expect(s.state.assets.assets.f1).toBeUndefined();
    // One Undo brings back the file and every style that named it.
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.assets.assets.f1).toBeDefined();
    expect(s.state.tokens.overrides['font.display']).toBe(stack);
    expect(s.state.tokens.overrides['font.body']).toBe("Georgia, 'Brand Sans', serif");
    expect(nodeFont()).toBe(stack);
  });

  it('puts a font that lists the removed family as a backup in its place without it', async () => {
    const { s } = await make();
    // The theme's own Lora lists 'Lora' after 'Lora Variable': chosen in place of an imported Lora, it keeps the rest.
    await s.apply({ operations: [add(face('f1', '400', 'normal', 'Lora')), { type: 'token.set', tokenId: 'font.display', value: importedFontStack('Lora') }] }, { label: 'Import' });
    const bundled = installedFonts(s.state).find((f) => f.name === 'Lora')!.stack;
    expect(stackUsesFamily(bundled, 'Lora')).toBe(true);
    const r = await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f1', fontUses: { replaceWith: bundled } }] }, { label: 'Remove' });
    expect(r.ok).toBe(true);
    expect(stackUsesFamily(String(s.state.tokens.overrides['font.display']), 'Lora Variable')).toBe(true);
    expect(stackUsesFamily(String(s.state.tokens.overrides['font.display']), 'Lora')).toBe(false);
  });

  it('never takes the choice for a font the site uses from an AI run', async () => {
    const { s } = await make();
    await s.apply({ operations: [add(face('f1', '400')), add(face('f2', '400', 'italic')), { type: 'token.set', tokenId: 'font.display', value: importedFontStack('Brand Sans') }] }, { label: 'Import' });
    for (const fontUses of ['keep', 'fallback', { replaceWith: 'Georgia, serif' }] as const) {
      const r = await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f1', fontUses }] }, { label: 'Remove', source: 'ai' });
      expect(r.ok).toBe(false);
      expect(r.error?.message).toMatch(/Only the editor can remove a file of a font the site uses/);
    }
    expect(s.state.assets.assets.f1).toBeDefined();
    // An unused family's files can still go.
    expect((await s.apply({ operations: [{ type: 'token.set', tokenId: 'font.display', value: 'Georgia, serif' }, { type: 'asset.remove', assetId: 'f1' }] }, { label: 'Tidy', source: 'ai' })).ok).toBe(true);
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

  it('survives malformed records and treats family names without regard to case', () => {
    const state = createStarterState('business', 'Odd', false);
    state.assets.assets = {
      broken: null as unknown as AssetRecord,
      numeric: { ...face('numeric', '400'), font: { family: 'Brand Sans', weight: 400 as unknown as string, style: 'normal' } },
      a: face('a', '400', 'normal', 'Brand Sans'),
      b: face('b', '700', 'normal', 'brand sans')
    };
    const families = projectFontFamilies(state);
    expect(families).toHaveLength(1);
    expect(families[0].faces.map((f) => f.id)).toEqual(['a', 'b']);
    expect(fontFaceCss(state).match(/font-family: 'Brand Sans'/g)).toHaveLength(2);
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

  it('never rewrites a theme definition when a family is renamed, only the ones the project owns', () => {
    const state = createStarterState('business', 'Theme rename', false);
    // A theme-owned managed design in the project, beside Foundation's code sections.
    const theme = foundationDesign({ componentId: 'test.banner', name: 'Banner', properties: {}, parts: {}, build: (t) => t.el('root', 'section', {}, []) });
    state.components[theme.id] = theme;
    const fontOf = (d: ComponentDefinition) => (Object.values(d.tree!.nodes)[0] as unknown as { styles: { base: { fontFamily: string } } }).styles.base.fontFamily;
    (Object.values(theme.tree!.nodes)[0] as { styles?: unknown }).styles = { base: { fontFamily: "Georgia, 'Old Name', serif" } };
    state.components['project.copy'] = { ...structuredClone(theme), id: 'project.copy', owner: 'project' };
    const locked = JSON.stringify(theme);
    // The rename a font's last file makes by changing its family.
    const next = applyOperations({ ...state, components: state.components }, [add(face('f1', '400', 'normal', 'Old Name')), { type: 'asset.update', assetId: 'f1', font: { family: 'New Name', weight: '400', style: 'normal' } }]).state;
    expect(JSON.stringify(next.components[theme.id])).toBe(locked);
    expect(fontOf(next.components[theme.id])).toBe("Georgia, 'Old Name', serif");
    expect(fontOf(next.components['project.copy'])).toBe("Georgia, 'New Name', serif");
    // Renaming directly leaves the theme's copy alone as well.
    renameFontFamily(state, 'Old Name', 'Newer Name');
    expect(JSON.stringify(state.components[theme.id])).toBe(locked);
    expect(fontOf(state.components['project.copy'])).toBe("Georgia, 'Newer Name', serif");
  });

  it('counts a font as used while a project code component names it, and protects its last file', async () => {
    const { s } = await make();
    const code = (name: string, source: string) => ({ type: 'component.createCode' as const, name, source, properties: {} });
    const imported = await s.apply({ operations: [add(face('f1', '400')), add(face('f2', '700')), add(face('f3', '400', 'normal', 'Inter'))] }, { label: 'Import' });
    expect(imported.ok).toBe(true);
    expect(assetUsages(s.state).f1).toBeUndefined();
    // However often, and however it is cased or spaced, one component counts once; a word that only starts or ends a
    // longer name does not count at all (the font "Inter" is not in "interface" or "--font-inter").
    const r = await s.apply({ operations: [code('Banner', "<h2>Hello</h2>\n<style>\n  h2 { font-family: 'brand   SANS', serif; }\n  p { font: 1rem BRAND  Sans; }\n  .interface { font-family: var(--font-inter), system-ui, sans-serif; }\n</style>")] }, { label: 'Add code' });
    expect(r.ok).toBe(true);
    expect(assetUsages(s.state)).toMatchObject({ f1: 1, f2: 1 });
    expect(assetUsages(s.state).f3).toBeUndefined();
    // A theme's own code is not the project's choice; a second component of the project's is a second use.
    const themeCode = Object.values(s.state.components).find((d) => d.owner === 'theme' && d.kind === 'code')!;
    s.state = { ...s.state, components: { ...s.state.components, [themeCode.id]: { ...themeCode, source: `${themeCode.source}\n<style>p { font-family: 'Brand Sans'; }</style>` } } };
    expect(assetUsages(s.state)).toMatchObject({ f1: 1, f2: 1 });
    expect((await s.apply({ operations: [code('Footer', "<p>Hi</p>\n<style>p { font-family: Brand Sans, serif; }</style>")] }, { label: 'Add more code' })).ok).toBe(true);
    expect(assetUsages(s.state)).toMatchObject({ f1: 2, f2: 2 });
    // A file of the family goes only with a choice for its uses; kept on another file, the code still finds it. The
    // last one cannot be kept.
    expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f2' }] }, { label: 'Remove' })).error?.message).toMatch(/This font is used 2 times/);
    expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f2', fontUses: 'keep' }] }, { label: 'Remove' })).ok).toBe(true);
    const last = await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f1', fontUses: 'keep' }] }, { label: 'Remove' });
    expect(last.ok).toBe(false);
    expect(last.error?.message).toMatch(/This font is used 2 times, and it is the last file of Brand Sans/);
    expect(s.state.assets.assets.f1).toBeDefined();
    // Falling back never rewrites code: the author was told it names the font, and the file goes.
    const sources = () => Object.fromEntries(Object.values(s.state.components).filter((d) => d.owner === 'project').map((d) => [d.id, d.source]));
    const wrote = sources();
    expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f1', fontUses: 'fallback' }] }, { label: 'Remove' })).ok).toBe(true);
    expect(sources()).toEqual(wrote);
    expect(s.state.assets.assets.f1).toBeUndefined();
  });

  it('reads a style the way CSS does: a run of spaces is one, and a bare keyword is no font', async () => {
    const { s } = await make();
    await s.apply({ operations: [add(face('f1', '400')), add(face('f2', '400', 'normal', 'Serif'))] }, { label: 'Import' });
    // The session holds its project frozen: these hand edits are made to a copy.
    const st = structuredClone(s.state);
    st.tokens.overrides['font.body'] = 'Georgia, Brand   Sans, serif';
    expect(assetUsages(st)).toMatchObject({ f1: 1 });
    // A keyword is not a use of the font that shares its name, and renaming that font leaves the keyword alone.
    expect(assetUsages(st).f2).toBeUndefined();
    st.tokens.overrides['font.display'] = "Georgia, 'Serif', serif";
    expect(assetUsages(st).f2).toBe(1);
    renameFontFamily(st, 'Serif', 'Roman');
    expect(st.tokens.overrides['font.display']).toBe("Georgia, 'Roman', serif");
    renameFontFamily(st, 'Brand Sans', 'Brand Serif');
    expect(st.tokens.overrides['font.body']).toBe("Georgia, 'Brand Serif', serif");
  });

  it('quotes a family CSS would drop, and gives a bare imported name its stack', async () => {
    const { dir, s } = await make();
    await s.apply({ operations: [add(face('f1', '400', 'normal', '1984 Display')), add(face('f2', '400', 'normal', 'Brand Sans')), add(face('f3', '400', 'normal', 'Serif'))] }, { label: 'Import' });
    const stack = (value: string) => resolveFontStack(s.state, value);
    // A bare name, in any case or spacing, becomes the family's own stack.
    expect(stack('1984 Display')).toEqual({ stack: "'1984 Display', system-ui, sans-serif" });
    expect(stack('1984   display')).toEqual({ stack: "'1984 Display', system-ui, sans-serif" });
    expect(stack('brand sans')).toEqual({ stack: "'Brand Sans', system-ui, sans-serif" });
    // Inside the author's own stack, only a name CSS cannot read is quoted, and the rest stays as written.
    expect(stack('Georgia, 1984 Display, serif')).toEqual({ stack: "Georgia, '1984 Display', serif" });
    expect(stack('Georgia,Brand Sans,serif')).toEqual({ stack: 'Georgia,Brand Sans,serif' });
    expect(stack("'1984 Display', serif")).toEqual({ stack: "'1984 Display', serif" });
    // A name already quoted is kept as it was written, in either kind of quote, with no fallbacks added.
    expect(stack('"1984 Display"')).toEqual({ stack: '"1984 Display"' });
    // A keyword stays a keyword, even beside a font of the same name.
    expect(stack('serif')).toEqual({ stack: 'serif' });
    // What is stored is stable: resolving it again changes nothing.
    for (const value of ['1984 Display', 'Georgia, 1984 Display, serif']) {
      const once = stack(value) as { stack: string };
      expect(stack(once.stack)).toEqual(once);
    }
    // Through a font style, into the CSS the site is built from.
    const r = await s.apply({ operations: [{ type: 'token.set', tokenId: 'font.display', value: '1984 Display' }] }, { label: 'Use font' });
    expect(r.ok).toBe(true);
    expect(s.state.tokens.overrides['font.display']).toBe("'1984 Display', system-ui, sans-serif");
    const css = readFileSync(join(dir, 'src/lib/siteorigin/styles/tokens.css'), 'utf8');
    expect(css).toMatch(/--so-font-display:\s*'1984 Display', system-ui, sans-serif;/);
    expect(css).not.toMatch(/:\s*1984/);
    expect(assetUsages(s.state).f1).toBe(1);
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

describe("an imported font's fallback follows its kind (#1490)", () => {
  const kind = (a: AssetRecord, category?: 'serif' | 'sans-serif' | 'monospace') => ({ ...a, font: { ...a.font!, ...(category ? { category } : {}) } });

  it('keeps a face kind through the operation schema and refuses one that is no kind', () => {
    const ok = validateOperation(add(kind(face('f1', '400'), 'serif')));
    expect(ok.ok && ok.op.type === 'asset.add' && ok.op.asset.font).toEqual({ family: 'Brand Sans', weight: '400', style: 'normal', category: 'serif' });
    const upd = validateOperation({ type: 'asset.update', assetId: 'f1', font: { family: 'Mono', weight: '400', style: 'normal', category: 'monospace' } });
    expect(upd.ok && upd.op.type === 'asset.update' && upd.op.font?.category).toBe('monospace');
    const sans = validateOperation(add(kind(face('f2', '400'), 'sans-serif')));
    expect(sans.ok && sans.op.type === 'asset.add' && sans.op.asset.font?.category).toBe('sans-serif');
    expect(validateOperation({ type: 'asset.update', assetId: 'f1', font: { family: 'Mono', weight: '400', style: 'normal', category: 'cursive' } }).ok).toBe(false);
  });

  it('keeps a face kind when an edit of its weight, style or family does not say it', () => {
    const st = createStarterState('business', 'Fonts', false);
    const r = applyOperations(st, [add(kind(face('f1', '400', 'normal', 'Acme'), 'serif')), { type: 'asset.update', assetId: 'f1', font: { family: 'Acme Serif', weight: '700', style: 'normal' } }]);
    expect(r.state.assets.assets.f1.font).toEqual({ family: 'Acme Serif', weight: '700', style: 'normal', category: 'serif' });
    // Saying no kind at all keeps it too, and a kind that is said replaces it.
    const blank = applyOperations(r.state, [{ type: 'asset.update', assetId: 'f1', font: { family: 'Acme Serif', weight: '700', style: 'normal', category: undefined } }]);
    expect(blank.state.assets.assets.f1.font?.category).toBe('serif');
    const mono = applyOperations(r.state, [{ type: 'asset.update', assetId: 'f1', font: { family: 'Acme Serif', weight: '700', style: 'normal', category: 'monospace' } }]);
    expect(mono.state.assets.assets.f1.font?.category).toBe('monospace');
  });

  it('ends a stack in a fallback of its kind, and in sans-serif when the kind is unknown', () => {
    expect(importedFontStack('Source Serif 4', 'serif')).toBe("'Source Serif 4', Georgia, 'Times New Roman', serif");
    expect(importedFontStack('IBM Plex Mono', 'monospace')).toBe("'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace");
    expect(importedFontStack('Brand Sans', 'sans-serif')).toBe("'Brand Sans', system-ui, sans-serif");
    expect(importedFontStack('Brand Sans')).toBe("'Brand Sans', system-ui, sans-serif");
    // A hand-edited kind that is none of them (an inherited name included) is no kind.
    expect(importedFontStack('Brand Sans', 'constructor' as never)).toBe("'Brand Sans', system-ui, sans-serif");
  });

  it("takes a family's kind from the files that say it, and none when they disagree, in any order", () => {
    const st = createStarterState('business', 'Fonts', false);
    const set = (...faces: AssetRecord[]) => {
      st.assets.assets = Object.fromEntries(faces.map((a) => [a.id, a]));
      return projectFontFamilies(st)[0].category;
    };
    // An italic that says nothing takes its upright's kind.
    expect(set(kind(face('f1', '400'), 'serif'), face('f2', '400', 'italic'))).toBe('serif');
    expect(set(kind(face('f1', '400'), 'serif'), kind(face('f2', '700'), 'serif'))).toBe('serif');
    expect(set(face('f2', '400', 'italic'), kind(face('f1', '400'), 'serif'))).toBe('serif');
    // Files that disagree leave it unknown, whichever comes first.
    expect(set(kind(face('f1', '400'), 'serif'), kind(face('f2', '700'), 'monospace'), kind(face('f3', '500'), 'serif'))).toBeUndefined();
    expect(set(kind(face('f2', '700'), 'monospace'), kind(face('f1', '400'), 'serif'))).toBeUndefined();
    expect(set(face('f1', '400'))).toBeUndefined();
    expect(set({ ...face('f1', '400'), font: { ...face('f1', '400').font!, category: 'toString' as never } })).toBeUndefined();
  });

  it('gives a bare imported name the stack of its kind, into the CSS the site is built from', async () => {
    const { dir, s } = await make();
    // A file that says nothing listed first still takes its family's kind.
    await s.apply({ operations: [add(face('f0', '300', 'italic', 'Source Serif 4')), add(kind(face('f1', '300', 'normal', 'Source Serif 4'), 'serif')), add(kind(face('f2', '400', 'normal', 'IBM Plex Mono'), 'monospace'))] }, { label: 'Import' });
    expect(resolveFontStack(s.state, 'source serif 4')).toEqual({ stack: "'Source Serif 4', Georgia, 'Times New Roman', serif" });
    // An author's own stack is kept as written.
    expect(resolveFontStack(s.state, "'IBM Plex Mono', Arial, sans-serif")).toEqual({ stack: "'IBM Plex Mono', Arial, sans-serif" });
    const r = await s.apply({ operations: [{ type: 'token.set', tokenId: 'font.display', value: 'Source Serif 4' }, { type: 'token.set', tokenId: 'font.body', value: 'IBM Plex Mono' }] }, { label: 'Use fonts' });
    expect(r.ok).toBe(true);
    const css = readFileSync(join(dir, 'src/lib/siteorigin/styles/tokens.css'), 'utf8');
    expect(css).toMatch(/--so-font-display:\s*'Source Serif 4', Georgia, 'Times New Roman', serif;/);
    expect(css).toMatch(/--so-font-body:\s*'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;/);
    // Removing the family keeps the fallback of its kind.
    expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'f0', fontUses: 'keep' }, { type: 'asset.remove', assetId: 'f1', fontUses: 'fallback' }] }, { label: 'Remove' })).ok).toBe(true);
    expect(s.state.tokens.overrides['font.display']).toBe("Georgia, 'Times New Roman', serif");
  });

  it("reads which standard fallback a stack ends in, and swaps it for another", () => {
    expect(stackFallback("'Lora', system-ui, sans-serif")).toBe('sans-serif');
    expect(stackFallback("'Lora',Georgia,  'Times New Roman',serif")).toBe('serif');
    expect(stackFallback("'Lora', Arial, serif")).toBeNull();
    expect(stackFallback("'Lora', ui-monospace, \"SF Mono\", Menlo, Consolas, monospace")).toBe('monospace');
    expect(stackFallback("'Lora'")).toBeUndefined();
    expect(withFallback("'Lora', system-ui, sans-serif", 'serif')).toBe("'Lora', Georgia, 'Times New Roman', serif");
    expect(withFallback("'Lora', Arial, serif", 'monospace')).toBe("'Lora', ui-monospace, 'SF Mono', Menlo, Consolas, monospace");
    expect(withFallback("'Lora'", 'sans-serif')).toBe("'Lora', system-ui, sans-serif");
  });
});
