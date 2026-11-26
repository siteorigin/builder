import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ProjectState, TextStyleValue } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { getTheme, listThemes, registerPacks } from '@catalogue/index';
import { fontFamilies, installedFontFamilies, installedFonts } from '@catalogue/fonts';
import { applyOperations } from '@engine/apply';
import { FONTS_DIR, generateProject, packFileCopies } from '@generator/index';
import { parseFontFaces } from '../../src/main/packs/build';
import { buildFont } from '../../src/main/packs/build';
import { builtinFont } from '@catalogue/builtin-fonts';
import { SHARED_BASE_CSS } from '@catalogue/foundation/base.css';

const fresh = () => createStarterState('business', 'Test', false);
const setFont = (s: ProjectState, value: string, tokenId = 'font.body') => applyOperations(s, [{ type: 'token.set', tokenId, value }]).state;
const layout = (s: ProjectState) => generateProject(s).get('src/routes/+layout.svelte')!;
const tokensCss = (s: ProjectState) => generateProject(s).get('src/lib/siteorigin/styles/tokens.css')!;
/** The families the site's stylesheet declares @font-face rules for. */
const served = (s: ProjectState) => [...new Set([...tokensCss(s).matchAll(/@font-face \{\n\tfont-family: '([^']+)'/g)].map((m) => m[1]))];
const legacy = () => {
  const s = fresh();
  s.manifest.template.version = '0.1.0';
  return s;
};
const BUNDLED_FONTS = () => getTheme('foundation').fonts;
const font = (name: string) => BUNDLED_FONTS().find((f) => f.name === name)!;
const PACKAGES = ['inter', 'fraunces', 'plus-jakarta-sans', 'dm-sans', 'space-grotesk', 'playfair-display', 'lora', 'sora', 'jetbrains-mono'].map((n) => `@fontsource-variable/${n}`);

describe('Signal fonts', () => {
  it('ship the same scripts: JetBrains Mono is held to the Latin subsets of its Sora and DM Sans', () => {
    const files = [...buildFont(builtinFont('JetBrains Mono'), process.cwd()).files.keys()];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/-latin(-ext)?-wght/);
  });
});

describe('skip link', () => {
  it('hides itself clear of the top edge of the page, so no sliver of it shows', () => {
    const rule = SHARED_BASE_CSS.match(/\.so-skip-link \{[^}]*\}/)![0];
    expect(rule).toMatch(/top: 12px/);
    expect(rule).toMatch(/translateY\(calc\(-100% - (\d+)px\)\)/);
    expect(Number(rule.match(/translateY\(calc\(-100% - (\d+)px\)\)/)![1])).toBeGreaterThan(12);
  });
});

describe('bundled fonts', () => {
  it('ship with the theme, so the website template installs none', () => {
    const dir = 'templates/sveltekit-brochure/files';
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    const lock = JSON.parse(readFileSync(`${dir}/package-lock.json`, 'utf8'));
    expect(Object.keys(pkg.devDependencies).filter((d) => d.startsWith('@fontsource'))).toEqual([]);
    expect(Object.keys(lock.packages).filter((d) => d.includes('@fontsource'))).toEqual([]);
    // The pack is built from pinned packages, so a rebuild cannot change a site's font files.
    const builder = JSON.parse(readFileSync('package.json', 'utf8'));
    const builderLock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    for (const p of PACKAGES) {
      expect(builder.devDependencies[p], p).toMatch(/^\d+\.\d+\.\d+$/);
      expect(builderLock.packages[`node_modules/${p}`]?.version, p).toBe(builder.devDependencies[p]);
    }
  });

  it('carry every face of the stylesheets they come from, with an open licence', () => {
    expect(BUNDLED_FONTS().length).toBeGreaterThanOrEqual(6);
    for (const [i, f] of BUNDLED_FONTS().entries()) {
      const css = parseFontFaces(readFileSync(`node_modules/${PACKAGES[i]}/index.css`, 'utf8'));
      expect(f.faces.map((x) => [x.file.replace('fonts/', './files/'), x.weight, x.style, x.unicodeRange, x.format]), f.name).toEqual(css.map((c) => [c.url, c.weight, c.style, c.unicodeRange, c.format]));
      expect(f.license).toBe('OFL-1.1');
      expect(f.notice).toMatch(/SIL Open Font License/);
    }
  });

  it('keep the theme defaults and tell the assistant what is installed', () => {
    const tokens = getTheme('foundation').tokens;
    for (const id of ['font.body', 'font.display']) expect(BUNDLED_FONTS().map((f) => f.stack)).toContain(tokens.find((t) => t.id === id)!.value);
    expect(installedFontFamilies(fresh())).toContain('Plus Jakarta Sans Variable');
  });

  it('serves only the fonts a site uses, from files copied into the project', () => {
    const before = fresh();
    expect(served(before)).toEqual(['Inter Variable', 'Fraunces Variable']);
    expect(layout(before)).not.toContain('@fontsource');
    const css = tokensCss(before);
    expect(css).toContain("@font-face {\n\tfont-family: 'Inter Variable';\n\tfont-style: normal;\n\tfont-display: swap;\n\tfont-weight: 100 900;\n\tsrc: url('../fonts/inter-latin-wght-normal.woff2') format('woff2-variations');\n\tunicode-range: U+0000-00FF,");
    // Every face the stylesheet names is a file the editor copies in, and nothing else is.
    const urls = [...css.matchAll(/url\('\.\.\/fonts\/([^']+)'\)/g)].map((m) => `${FONTS_DIR}/${m[1]}`);
    expect(packFileCopies(before).map((c) => c.path)).toEqual(urls);
    expect(packFileCopies(before).every((c) => c.pack === 'foundation' && c.file === c.path.replace(`${FONTS_DIR}/`, 'fonts/'))).toBe(true);
    expect(generateProject(before).get(`${FONTS_DIR}/NOTICE.txt`)).toMatch(/^Fonts in this folder come with the Foundation theme\.[^]*Inter \(OFL-1\.1\)[^]*Fraunces \(OFL-1\.1\)/);
    const after = setFont(fresh(), font('Lora').stack, 'font.display');
    expect(served(after)).toEqual(['Inter Variable', 'Lora Variable']);
    expect(packFileCopies(after).some((c) => c.path.includes('fraunces'))).toBe(false);
  });

  it('serves nothing and writes no notice when a site uses only system fonts', () => {
    const s = setFont(setFont(fresh(), 'Georgia, serif', 'font.display'), 'system-ui, sans-serif');
    expect(served(s)).toEqual([]);
    expect(packFileCopies(s)).toEqual([]);
    expect(generateProject(s).has(`${FONTS_DIR}/NOTICE.txt`)).toBe(false);
  });
});

describe('font token validation', () => {
  it('expands a bundled font name to the family its package declares', () => {
    for (const value of ['Lora', "'Lora'", 'lora']) expect(setFont(fresh(), value).tokens.overrides['font.body']).toBe(font('Lora').stack);
  });

  it("adds the real family in place and keeps the caller's fallbacks", () => {
    expect(setFont(fresh(), 'Lora, Arial, sans-serif').tokens.overrides['font.body']).toBe("'Lora Variable', Lora, Arial, sans-serif");
    expect(setFont(fresh(), 'system-ui, Lora, serif').tokens.overrides['font.body']).toBe("system-ui, 'Lora Variable', Lora, serif");
  });

  it('reads quoted commas and runs of spaces as CSS does', () => {
    const s = fresh();
    s.assets.assets['f1'] = { id: 'f1', name: 'x', file: 'static/assets/brand-aaaaaaaa.woff2', mime: 'font/woff2', bytes: 1, hash: 'x', kind: 'font', createdAt: '', font: { family: 'Brand Sans', weight: '400', style: 'normal' } };
    expect(fontFamilies("'Brand, Sans', serif")).toEqual(['Brand, Sans', 'serif']);
    expect(setFont(fresh(), 'Lora  Variable, serif').tokens.overrides['font.body']).toBe('Lora  Variable, serif');
    expect(served(setFont(fresh(), 'Lora  Variable, serif'))).toContain('Lora Variable');
  });

  it('checks a literal family set on an element, an override or a variant', () => {
    const s = fresh();
    const hero = Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'instance')!;
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const op = (value: string) => ({ type: 'node.setStyle' as const, owner, nodeId: hero.id, partId: 'heading', scope: 'base' as const, property: 'fontFamily', value });
    expect(() => applyOperations(s, [op('Montserrat, serif')])).toThrow(/not installed/);
    const next = applyOperations(s, [op('Lora, serif')]).state;
    expect(JSON.stringify(next.pages[s.site.homePageId])).toContain("'Lora Variable', Lora, serif");
    expect(served(next)).toContain('Lora Variable');
    expect(() => applyOperations(s, [op('inherit')])).not.toThrow();
  });

  it('keeps serving a font named only in code component source', () => {
    const s = setFont(fresh(), 'Georgia, serif', 'font.display');
    const def = Object.values(s.components).find((d) => d.kind === 'code')!;
    s.components[def.id] = { ...def, source: `${def.source}\n<style>p { font-family: Fraunces\tVariable, serif; }</style>` };
    expect(served(s)).toContain('Fraunces Variable');
  });

  it('keeps a stack that already names the installed family', () => {
    const value = "'DM Sans Variable', Arial, sans-serif";
    expect(setFont(fresh(), value).tokens.overrides['font.body']).toBe(value);
  });

  it('accepts system fonts', () => {
    for (const value of ['Georgia, serif', 'system-ui, sans-serif', "ui-monospace, 'SF Mono', monospace", "'Helvetica Neue', Helvetica, Arial, sans-serif"])
      expect(setFont(fresh(), value).tokens.overrides['font.body']).toBe(value);
  });

  it('rejects a family that would silently fall back, naming what is installed', () => {
    expect(() => setFont(fresh(), 'Montserrat, sans-serif')).toThrow(/"Montserrat" is not installed[^]*Plus Jakarta Sans/);
    expect(() => setFont(fresh(), "Comic Neue, 'Inter Variable', sans-serif")).toThrow(/not installed/);
  });

  it('checks a family set directly on a text style', () => {
    const s = applyOperations(fresh(), [{ type: 'token.set', tokenId: 'text.h1', value: { family: 'Playfair Display' } }]).state;
    expect((s.tokens.overrides['text.h1'] as TextStyleValue).family).toBe(font('Playfair Display').stack);
    expect(() => applyOperations(fresh(), [{ type: 'token.set', tokenId: 'text.h1', value: { family: 'Montserrat' } }])).toThrow(/not installed/);
  });

  it('does not let an older text style family block an unrelated change', () => {
    for (const family of ['Old Custom Font', "'Arial"]) {
      const s = fresh();
      s.tokens.overrides['text.h1'] = { family, size: '2rem', lineHeight: '1.1', weight: 500, tracking: '0em' };
      const next = applyOperations(s, [{ type: 'token.set', tokenId: 'text.h1', value: { size: '3rem' } }]).state;
      expect(next.tokens.overrides['text.h1']).toMatchObject({ family, size: '3rem' });
    }
  });

  it("accepts the project's own imported fonts", () => {
    const s = fresh();
    s.assets.assets['f1'] = { id: 'f1', name: 'Brand Sans Bold', file: 'static/assets/brand-sans-aaaaaaaa.woff2', mime: 'font/woff2', bytes: 1, hash: 'x', kind: 'font', createdAt: '', font: { family: 'Brand Sans', weight: '700', style: 'normal' } };
    expect(setFont(s, "'Brand Sans', sans-serif").tokens.overrides['font.body']).toBe("'Brand Sans', sans-serif");
    // The family the @font-face rule declares counts, not the file's display name.
    expect(() => setFont(s, "'Brand Sans Bold', sans-serif")).toThrow(/not installed/);
  });

  it("lets a project's own font use a bundled font's name without being rewritten", () => {
    const s = fresh();
    s.assets.assets['f1'] = { id: 'f1', name: 'Lora', file: 'static/assets/lora-aaaaaaaa.woff2', mime: 'font/woff2', bytes: 1, hash: 'x', kind: 'font', createdAt: '', font: { family: 'Lora', weight: '400', style: 'normal' } };
    expect(setFont(s, "'Lora', serif").tokens.overrides['font.body']).toBe("'Lora', serif");
  });

  it('applies to new custom font styles', () => {
    expect(() => applyOperations(fresh(), [{ type: 'token.create', group: 'font', label: 'Accent', value: 'Montserrat' }])).toThrow(/not installed/);
    const r = applyOperations(fresh(), [{ type: 'token.create', group: 'font', label: 'Accent', value: 'Space Grotesk' }]);
    expect(r.state.tokens.custom[0].value).toBe(font('Space Grotesk').stack);
    expect(served(r.state)).toContain('Space Grotesk Variable');
  });
});

describe('projects from earlier templates', () => {
  it('can use every font of their theme, because the fonts come from the theme rather than the lockfile', () => {
    for (const template of [{ id: 'sveltekit-brochure', version: '0.1.0' }, { id: 'sveltekit-brochure', version: '0.1.1' }, { id: 'sveltekit-brochure', version: '0.2.0' }, { id: 'other', version: '0.2.0' }, undefined]) {
      const s = legacy();
      (s.manifest as { template?: unknown }).template = template;
      expect(installedFonts(s)).toEqual(BUNDLED_FONTS());
      const next = setFont(s, 'Lora');
      expect(next.tokens.overrides['font.body']).toBe(font('Lora').stack);
      expect(served(next)).toContain('Lora Variable');
      // Their package.json may still list the font packages, but the site no longer imports them.
      expect(layout(next)).not.toContain('@fontsource');
    }
  });

  it('new projects record the template without font packages', () => {
    expect(fresh().manifest.template.version).toBe('0.3.0');
    expect(installedFonts(fresh())).toHaveLength(BUNDLED_FONTS().length);
  });

  it('refuses a font that only another theme ships, naming that theme', () => {
    const packs = [...listThemes()];
    const other = { ...structuredClone(packs[0]), id: 'other', name: 'Other', fonts: [{ ...font('Lora'), family: 'Brand Serif Variable', name: 'Brand Serif', stack: "'Brand Serif Variable', serif" }] };
    registerPacks([...packs, other]);
    try {
      expect(() => setFont(fresh(), 'Brand Serif')).toThrow(/Brand Serif comes with the Other theme, not this site's theme/);
    } finally {
      registerPacks(packs);
    }
  });
});
