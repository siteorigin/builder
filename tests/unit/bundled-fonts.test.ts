import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ProjectState, TextStyleValue } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { getTheme } from '@catalogue/index';
import { BUNDLED_FONTS, fontFamilies, installedFontFamilies, installedFonts } from '@catalogue/fonts';
import { applyOperations } from '@engine/apply';
import { generateProject } from '@generator/index';

const fresh = () => createStarterState('business', 'Test', false);
const setFont = (s: ProjectState, value: string, tokenId = 'font.body') => applyOperations(s, [{ type: 'token.set', tokenId, value }]).state;
const layout = (s: ProjectState) => generateProject(s).get('src/routes/+layout.svelte')!;
const legacy = () => {
  const s = fresh();
  s.manifest.template.version = '0.1.0';
  return s;
};

describe('bundled fonts', () => {
  it('are all locked in the website template', () => {
    const dir = 'templates/sveltekit-brochure/files';
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
    const lock = JSON.parse(readFileSync(`${dir}/package-lock.json`, 'utf8'));
    expect(BUNDLED_FONTS.length).toBeGreaterThanOrEqual(6);
    for (const f of BUNDLED_FONTS) {
      expect(pkg.devDependencies[f.package], f.package).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock.packages[`node_modules/${f.package}`]?.version, f.package).toBe(pkg.devDependencies[f.package]);
    }
  });

  it('keep the theme defaults and tell the assistant what is installed', () => {
    const tokens = getTheme('foundation').tokens;
    for (const id of ['font.body', 'font.display']) expect(BUNDLED_FONTS.map((f) => f.stack)).toContain(tokens.find((t) => t.id === id)!.value);
    expect(getTheme('foundation').fontImports).toEqual(BUNDLED_FONTS.map((f) => f.package));
    expect(installedFontFamilies(fresh())).toContain('Plus Jakarta Sans Variable');
  });

  it('imports only the fonts a site uses', () => {
    const before = layout(fresh());
    expect(before).toContain("import '@fontsource-variable/inter';");
    expect(before).toContain("import '@fontsource-variable/fraunces';");
    expect(before).not.toContain('@fontsource-variable/lora');
    const after = layout(setFont(fresh(), BUNDLED_FONTS.find((f) => f.name === 'Lora')!.stack, 'font.display'));
    expect(after).toContain("import '@fontsource-variable/lora';");
    expect(after).toContain("import '@fontsource-variable/inter';");
    expect(after).not.toContain('@fontsource-variable/fraunces');
  });
});

describe('font token validation', () => {
  it('expands a bundled font name to the family its package declares', () => {
    for (const value of ['Lora', "'Lora'", 'lora']) expect(setFont(fresh(), value).tokens.overrides['font.body']).toBe(BUNDLED_FONTS.find((f) => f.name === 'Lora')!.stack);
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
    expect(layout(setFont(fresh(), 'Lora  Variable, serif'))).toContain("import '@fontsource-variable/lora';");
  });

  it('checks a literal family set on an element, an override or a variant', () => {
    const s = fresh();
    const hero = Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'instance')!;
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const op = (value: string) => ({ type: 'node.setStyle' as const, owner, nodeId: hero.id, partId: 'heading', scope: 'base' as const, property: 'fontFamily', value });
    expect(() => applyOperations(s, [op('Montserrat, serif')])).toThrow(/not installed/);
    const next = applyOperations(s, [op('Lora, serif')]).state;
    expect(JSON.stringify(next.pages[s.site.homePageId])).toContain("'Lora Variable', Lora, serif");
    expect(layout(next)).toContain("import '@fontsource-variable/lora';");
    expect(() => applyOperations(s, [op('inherit')])).not.toThrow();
  });

  it('keeps importing a font named only in code component source', () => {
    const s = setFont(fresh(), 'Georgia, serif', 'font.display');
    const def = Object.values(s.components).find((d) => d.kind === 'code')!;
    s.components[def.id] = { ...def, source: `${def.source}\n<style>p { font-family: Fraunces\tVariable, serif; }</style>` };
    expect(layout(s)).toContain("import '@fontsource-variable/fraunces';");
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
    expect((s.tokens.overrides['text.h1'] as TextStyleValue).family).toBe(BUNDLED_FONTS.find((f) => f.name === 'Playfair Display')!.stack);
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
    expect(r.state.tokens.custom[0].value).toBe(BUNDLED_FONTS.find((f) => f.name === 'Space Grotesk')!.stack);
    expect(layout(r.state)).toContain("import '@fontsource-variable/space-grotesk';");
  });
});

describe('projects from the first template', () => {
  it('only offer the fonts their lockfile installs', () => {
    expect(installedFonts(legacy()).map((f) => f.name)).toEqual(['Inter', 'Fraunces']);
    expect(() => setFont(legacy(), 'Lora')).toThrow(/not installed in this project/);
    expect(setFont(legacy(), 'Fraunces').tokens.overrides['font.body']).toBe(BUNDLED_FONTS[1].stack);
  });

  it('never import a package that is not installed, which would break the build', () => {
    const s = legacy();
    s.tokens.overrides['font.body'] = BUNDLED_FONTS.find((f) => f.name === 'Lora')!.stack;
    expect(layout(s)).not.toContain('@fontsource-variable/lora');
    // A missing or unrecognised template is treated the same way.
    for (const template of [undefined, { id: 'sveltekit-brochure', version: '0.1.1' }, { id: 'other', version: '0.2.0' }]) {
      const t = structuredClone(s);
      (t.manifest as { template?: unknown }).template = template;
      expect(installedFonts(t).map((f) => f.name)).toEqual(['Inter', 'Fraunces']);
      expect(layout(t)).not.toContain('@fontsource-variable/lora');
    }
  });

  it('new projects record the template that ships every font', () => {
    expect(fresh().manifest.template.version).toBe('0.2.0');
    expect(installedFonts(fresh())).toHaveLength(BUNDLED_FONTS.length);
  });
});
