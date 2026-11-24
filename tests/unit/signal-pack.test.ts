/**
 * Signal (issue #391): a second shipped theme that implements every Foundation contract with a look of its own, ships
 * its fonts as local files, and lets a multi-page site switch to it and back with nothing it holds changed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { BUILTIN_PACKS, FOUNDATION_PACK, SIGNAL_PACK } from '@catalogue/builtin';
import { BUILTIN_FONTS } from '@catalogue/builtin-fonts';
import { findTheme, listThemes, themePinProblem } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { mergeStyles, restyle } from '@catalogue/signal/components';
import { applyOperations } from '@engine/apply';
import { FONTS_DIR, STYLES_DIR, generateProject, packFileCopies } from '@generator/index';
import { buildPack } from '../../src/main/packs/build';
import { ProjectSession } from '../../src/main/project/session';
import { isGeneratedReadme, projectReadme, themeNotice } from '../../src/main/export';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-signal-'));
  dirs.push(d);
  return d;
};

/** The shipped packs a site can switch between (not development fixtures). */
const shipped = () => listThemes().filter((t) => !t.devOnly);

/** What a placement relies on: everything about a definition except how it looks and who made it. */
function contract(d: ComponentDefinition) {
  const repeats = Object.values(d.tree?.nodes ?? {}).flatMap((n) => (n.kind === 'repeat' ? [[n.id, n.list, n.children]] : []));
  return {
    componentId: d.componentId,
    contractVersion: d.contractVersion,
    kind: d.kind,
    owner: d.owner,
    name: d.name,
    description: d.description,
    category: d.category,
    tags: d.tags,
    icon: d.icon,
    properties: d.properties,
    parts: d.parts,
    slots: d.slots,
    state: d.state,
    examples: d.examples,
    // A part's node keeps its kind and the repeat it sits in, so single-item styles keep showing.
    partNodes: Object.fromEntries(Object.entries(d.parts).map(([p, part]) => [p, d.tree?.nodes[part.nodeId]?.kind ?? null])),
    repeats,
    variantAxes: Object.fromEntries(Object.entries(d.variantAxes ?? {}).map(([axis, a]) => [axis, { label: a.label, default: a.default, options: Object.fromEntries(Object.entries(a.options).map(([id, o]) => [id, o.label])) }])),
    dependencies: (d.dependencies ?? []).map((id) => id.slice(id.indexOf('.') + 1)),
    source: d.kind === 'code' ? d.source : undefined
  };
}

const def = (pack: { components: ComponentDefinition[] }, componentId: string) => pack.components.find((c) => c.componentId === componentId)!;

describe('the Signal pack', () => {
  it('ships beside Foundation, and is never the default for a new project', () => {
    expect(shipped().map((t) => t.id)).toEqual(['foundation', 'signal']);
    expect(findTheme('signal')).toMatchObject({ name: 'Signal', version: '0.1.0', license: 'GPL-3.0-or-later', source: 'bundled' });
    expect(createStarterState('business', 'New', false).site.themeId).toBe('foundation');
  });

  it('implements every contract of every other shipped pack, both ways', () => {
    const packs = shipped();
    expect(packs.length).toBeGreaterThanOrEqual(2);
    for (const a of packs)
      for (const b of packs) {
        if (a === b) continue;
        expect(b.components.map((c) => c.componentId), `${a.id} → ${b.id}`).toEqual(a.components.map((c) => c.componentId));
        for (const c of a.components) expect(contract(def(b, c.componentId!)), `${a.id} → ${b.id}: ${c.componentId}`).toEqual(contract(c));
      }
    for (const c of SIGNAL_PACK.components) {
      expect([c.id, c.provenance, c.license]).toEqual([`signal.${c.componentId}`, { pack: 'signal', packVersion: '0.1.0', componentId: c.componentId }, 'GPL-3.0-or-later']);
      // Whatever a definition needs comes from Signal itself.
      for (const dep of c.dependencies ?? []) expect(SIGNAL_PACK.components.some((x) => x.id === dep), `${c.id} needs ${dep}`).toBe(true);
    }
    // Restyling Signal's copies left Foundation's own definitions as they were.
    expect(def(FOUNDATION_PACK, 'features.grid').tree!.nodes.card.styles?.['base:hover']).toBeUndefined();
    expect(def(FOUNDATION_PACK, 'hero.split').tree!.nodes.eyebrow.styles?.base).not.toHaveProperty('radius');
  });

  it('has a look of its own: geometric and mono type, pill eyebrows, tiles that lift, a bento grid', () => {
    const signal = findTheme('signal')!;
    const token = (id: string) => signal.tokens.find((t) => t.id === id)!.value;
    expect(signal.tokens.map((t) => [t.id, t.group])).toEqual(findTheme('foundation')!.tokens.map((t) => [t.id, t.group]));
    expect(token('font.display')).toMatch(/^'Sora Variable'/);
    expect(token('font.body')).toMatch(/^'DM Sans Variable'/);
    expect(token('text.eyebrow')).toMatchObject({ family: expect.stringMatching(/^'JetBrains Mono Variable'/), transform: 'uppercase' });
    expect(token('radius.lg')).toBe('28px');

    // Every section eyebrow is a pill tinted with its own colour.
    const eyebrows = signal.components.filter((c) => c.tree?.nodes.eyebrow);
    expect(eyebrows.length).toBeGreaterThan(15);
    for (const c of eyebrows) expect(c.tree!.nodes.eyebrow.styles?.base, c.componentId).toMatchObject({ width: 'fit', radius: { token: 'radius.pill' }, background: 'color-mix(in srgb, currentColor 8%, transparent)' });

    const features = def(signal, 'features.grid');
    expect(features.tree!.nodes.card.styles).toMatchObject({
      base: { background: { token: 'color.surface-alt' }, transition: 'common', transitionDuration: 220 },
      'base:hover': { shadow: { token: 'shadow.md' }, background: { token: 'color.surface' } }
    });
    expect(features.tree!.nodes.card.styles!.base).not.toHaveProperty('border');
    expect(features.variantAxes!.tone.options.muted.styles!.card).toEqual({ base: { background: { token: 'color.surface' } } });
    expect(def(signal, 'hero.split').tree!.nodes.grid.styles?.desktop).toMatchObject({ gridTemplate: '1.15fr 1fr' });
    expect(def(signal, 'faq.list').tree!.nodes['item-divider'].styles?.base).toEqual({ hidden: true });

    // The bento: the first of three or more cards in the default layout spans two columns and two rows on desktop.
    expect(signal.baseCss).toMatch(/^\/\* Signal theme base styles \*\//);
    expect(signal.baseCss).toContain('@media screen and (min-width: 1024px) {\n  :where(.so-signal-features-grid__grid.so-signal-features-grid--layout-default > li.so-signal-features-grid__card:first-child:nth-last-child(n + 3)) { grid-column: 1 / -2; grid-row: span 2; }');
    // Lifts only play where a pointer hovers, for visitors who have not asked for less motion.
    expect(signal.baseCss).toContain('@media (hover: hover) and (prefers-reduced-motion: no-preference) {\n  :where(:is(a, button):is(.so-btn--primary, .so-btn--light):hover) { translate: 0 -2px; }');
    // Everything Foundation's stylesheet does for every section, Signal's does too, unchanged.
    expect(signal.baseCss).toContain(findTheme('foundation')!.baseCss.replace('/* Foundation theme base styles */\n', ''));
    expect(signal.aiProfile.guidance.join(' ')).toMatch(/featured tile/);
    expect(signal.aiProfile.examples!.find((e) => e.componentId === 'hero.centered')!.id).toBe('hero-centered-product');
  });

  it('draws the Services grid the bento rules are written for', () => {
    const state = applyOperations(createStarterState('blank', 'Bento', false), [{ type: 'theme.apply', themeId: 'signal' }]).state;
    const page = state.site.homePageId;
    const placed = applyOperations(state, [{ type: 'node.insert', owner: { kind: 'page', id: page }, componentId: 'features.grid' }]).state;
    const svelte = [...generateProject(placed, { instrument: false }).entries()].find(([path]) => path.endsWith('/signal-features-grid.svelte'))?.[1];
    expect(svelte).toBeTruthy();
    // The grid carries its layout option's class itself, and each card is a list item straight inside it.
    expect(svelte).toMatch(/<ul class=\{\["so-signal-features-grid__grid", [^\n]*`so-signal-features-grid--layout-\$\{variant_layout\}`\]\}>\s*\{#each items [^}]+\}\s*<li class=\{\["so-signal-features-grid__card",/);
    expect(svelte).toMatch(/variant_layout = "default"/);
  });

  it('restyles only nodes and options a definition has, and keeps every rule a change does not name', () => {
    const features = structuredClone(def(FOUNDATION_PACK, 'features.grid'));
    expect(() => restyle(structuredClone(features), { nodes: { nope: { base: { color: 'red' } } } })).toThrow(/no node "nope"/);
    expect(() => restyle(structuredClone(features), { variants: { tone: { loud: { card: { base: { color: 'red' } } } } } })).toThrow(/no tone option "loud"/);
    expect(mergeStyles({ base: { layout: 'grid', columns: 1 }, tablet: { columns: 2 } }, { base: { columns: null, gap: '8px' }, desktop: { columns: 3 } })).toEqual({ base: { layout: 'grid', gap: '8px' }, tablet: { columns: 2 }, desktop: { columns: 3 } });
  });
});

describe("Signal's fonts", () => {
  it("are every one of Foundation's and Signal's own two, each from local woff2 files with its licence", () => {
    expect(findTheme('signal')!.fonts.map((f) => f.family)).toEqual([...findTheme('foundation')!.fonts.map((f) => f.family), 'Sora Variable', 'JetBrains Mono Variable']);
    expect(BUILTIN_FONTS.map((f) => f.family)).toEqual(findTheme('signal')!.fonts.map((f) => f.family));
    const { pack, files } = buildPack(SIGNAL_PACK);
    for (const f of pack.fonts) {
      expect(f.license).toBe('OFL-1.1');
      expect(f.notice).toMatch(/SIL Open Font License/);
      for (const face of f.faces) {
        expect(face.file).toMatch(/^fonts\/[a-z0-9-]+\.woff2$/);
        expect(existsSync(files.get(face.file)!), face.file).toBe(true);
      }
    }
    expect(pack.fonts.find((f) => f.name === 'JetBrains Mono')?.category).toBe('monospace');
  });

  it('reach a Signal site as files in the project, only the three it uses', () => {
    const state = applyOperations(createStarterState('business', 'Fonts', false), [{ type: 'theme.apply', themeId: 'signal' }]).state;
    const files = generateProject(state, { instrument: false });
    const tokens = files.get(`${STYLES_DIR}/tokens.css`)!;
    const served = [...new Set([...tokens.matchAll(/@font-face \{\n\tfont-family: '([^']+)'/g)].map((m) => m[1]))];
    expect(served.sort()).toEqual(['DM Sans Variable', 'JetBrains Mono Variable', 'Sora Variable']);
    const urls = [...tokens.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^'\.\.\/fonts\/[a-z0-9-]+\.woff2'$/);
    expect(packFileCopies(state).every((c) => c.pack === 'signal' && c.path.startsWith(`${FONTS_DIR}/`))).toBe(true);
    expect(files.get(`${FONTS_DIR}/NOTICE.txt`)).toMatch(/^Fonts in this folder come with the Signal theme\.[^]*Sora \(OFL-1\.1\)/);
  });
});

/** Text set on the business starter's pages: its home hero, a forked section, an asset, a brand colour. */
function authored(): ProjectState {
  let s = createStarterState('business', 'Northwind', false);
  const home = s.site.homePageId;
  const instances = (pageId: string) => Object.values(s.pages[pageId].nodes).filter((n): n is InstanceNode => n.kind === 'instance');
  const of = (n: InstanceNode) => s.components[n.definitionId].componentId;
  const hero = instances(home)[0];
  s.assets.assets.a1 = { id: 'a1', name: 'Team', file: 'static/assets/team-aaaaaaaa.jpg', mime: 'image/jpeg', bytes: 1, width: 1200, height: 800, hash: 'x', kind: 'image', createdAt: '' };
  s = applyOperations(s, [
    { type: 'instance.setProp', owner: { kind: 'page', id: home }, nodeId: hero.id, prop: 'heading', value: 'Field service, finally calm' },
    { type: 'token.set', tokenId: 'color.brand', value: '#3a2fd0' }
  ]).state;
  // A section made unique: a project component, which keeps its own design whatever the theme.
  const other = Object.values(s.pages).find((p) => p.id !== home && instances(p.id).length > 1)!;
  const forked = instances(other.id).find((n) => !['intro.page'].includes(of(n)))!;
  s = applyOperations(s, [{ type: 'component.makeUnique', owner: { kind: 'page', id: other.id }, nodeId: forked.id, name: 'Our own section' }]).state;
  expect(Object.values(s.components).some((d) => d.owner === 'project')).toBe(true);
  return s;
}

describe('switching a multi-page site to Signal and back', () => {
  it('keeps every page, route, word, asset, site style and project component', () => {
    const start = authored();
    expect(Object.keys(start.pages).length).toBeGreaterThanOrEqual(3);
    const signal = applyOperations(start, [{ type: 'theme.apply', themeId: 'signal' }]).state;
    expect(signal.site.themeId).toBe('signal');
    expect(signal.themeLock.theme).toEqual({ id: 'signal', version: '0.1.0' });
    expect(themePinProblem(signal)).toBeNull();
    // The same pages, routes, nodes and content: only the theme's placements point at Signal's definitions.
    const rebound = (s: ProjectState) => JSON.parse(JSON.stringify(s.pages).replace(/"definitionId":"signal\./g, '"definitionId":"foundation.'));
    expect(rebound(signal)).toEqual(start.pages);
    expect(JSON.parse(JSON.stringify(signal.site.shell).replace(/"signal\./g, '"foundation.'))).toEqual(start.site.shell);
    expect(signal.assets).toEqual(start.assets);
    expect(signal.tokens).toEqual(start.tokens);
    const projectDefs = (s: ProjectState) => Object.values(s.components).filter((d) => d.owner === 'project');
    expect(projectDefs(signal)).toEqual(projectDefs(start));
    // Every theme placement on a page or in the shell is Signal's now.
    for (const page of Object.values(signal.pages))
      for (const n of Object.values(page.nodes)) if (n.kind === 'instance' && signal.components[n.definitionId].owner === 'theme') expect(n.definitionId).toMatch(/^signal\./);

    const back = applyOperations(signal, [{ type: 'theme.apply', themeId: 'foundation' }]).state;
    expect(back).toEqual(start);
  });

  it('keeps any font a Foundation site chose, and names a Signal font the site chose before going back', () => {
    // Every Foundation font comes with Signal: a heading set in Playfair Display stays in it.
    const playfair = BUILTIN_FONTS.find((f) => f.name === 'Playfair Display')!.stack;
    const onFoundation = applyOperations(createStarterState('business', 'Fonts', false), [{ type: 'token.set', tokenId: 'font.display', value: playfair }]).state;
    const toSignal = applyOperations(onFoundation, [{ type: 'theme.apply', themeId: 'signal' }]).state;
    expect(packFileCopies(toSignal).some((c) => c.file.includes('playfair'))).toBe(true);
    // An eyebrow style edited on Signal saves its mono family, which Foundation does not ship: the switch says so and
    // changes nothing, and goes ahead once the style is back to Signal's own.
    const eyebrow = findTheme('signal')!.tokens.find((t) => t.id === 'text.eyebrow')!.value as Record<string, unknown>;
    const edited = applyOperations(toSignal, [{ type: 'token.set', tokenId: 'text.eyebrow', value: { ...eyebrow, size: '0.8rem' } }]).state;
    expect(() => applyOperations(edited, [{ type: 'theme.apply', themeId: 'foundation' }])).toThrow(/JetBrains Mono: your site uses this font, which Foundation does not include/);
    const reset = applyOperations(edited, [{ type: 'token.set', tokenId: 'text.eyebrow', value: null }]).state;
    expect(applyOperations(reset, [{ type: 'theme.apply', themeId: 'foundation' }]).state.site.themeId).toBe('foundation');
  });

  it('switches an open project, saves it, and opens it again on Signal', async () => {
    const d = tmp();
    const s = await ProjectSession.create(d, authored());
    const pages = structuredClone(s.state.pages);
    expect((await s.apply({ operations: [{ type: 'theme.apply', themeId: 'signal' }] }, { label: 'Signal' })).ok).toBe(true);
    const theme = readFileSync(join(d, STYLES_DIR, 'theme.css'), 'utf8');
    expect(theme).toContain('/* Signal theme base styles */');
    const fonts = readdirSync(join(d, FONTS_DIR));
    for (const f of ['sora-', 'dm-sans-', 'jetbrains-mono-']) expect(fonts.some((x) => x.startsWith(f)), f).toBe(true);
    expect(fonts.some((x) => x.startsWith('fraunces-'))).toBe(false);
    await s.close();

    const again = await ProjectSession.open(d, 'test');
    expect(again.state.site.themeId).toBe('signal');
    expect(JSON.parse(JSON.stringify(again.state.pages).replace(/"definitionId":"signal\./g, '"definitionId":"foundation.'))).toEqual(pages);
    expect((await again.apply({ operations: [{ type: 'theme.apply', themeId: 'foundation' }] }, { label: 'Foundation' })).ok).toBe(true);
    expect(again.state.pages).toEqual(pages);
    expect(readFileSync(join(d, STYLES_DIR, 'theme.css'), 'utf8')).toContain('/* Foundation theme base styles */');
    await again.close();
  });
});

describe('a Signal site as it is exported', () => {
  it('is plain SvelteKit with no editor instrumentation and nothing fetched from elsewhere', () => {
    const state = applyOperations(authored(), [{ type: 'theme.apply', themeId: 'signal' }]).state;
    const files = generateProject(state, { instrument: false });
    for (const [path, text] of files) {
      expect(path.startsWith('.siteorigin/'), path).toBe(false);
      expect(text, path).not.toMatch(/data-so-(node|ctx|items)=/);
      expect(text, path).not.toMatch(/@fontsource|fonts\.googleapis|fonts\.gstatic/);
    }
    for (const css of [...files].filter(([p]) => p.endsWith('.css')).map(([, t]) => t)) for (const [, u] of css.matchAll(/url\(\s*['"]?([^'")]+)/g)) expect(u).not.toMatch(/^(https?:)?\/\//);
    expect(files.get(`${STYLES_DIR}/theme.css`)).toContain('/* Signal theme base styles */');
  });

  it('names its own theme in the README, which the app still knows as its own', () => {
    const notice = themeNotice(findTheme('signal')!);
    expect(notice).toMatch(/^The Signal theme is licensed under GPL-3\.0-or-later\./);
    const readme = projectReadme('Northwind', false, notice);
    expect(isGeneratedReadme(readme)).toBe(true);
    expect(isGeneratedReadme(projectReadme('Northwind', true, notice, true))).toBe(true);
    // Foundation's README is the one it always was.
    expect(themeNotice(findTheme('foundation')!)).toBe(projectReadme('x').split('## Notices\n\n')[1].trim());
    expect(isGeneratedReadme(readme.replace('Signal theme', 'Signal theme, customised,'))).toBe(false);
  });
});

it('lists Signal among the packs a release is built for', () => {
  expect(BUILTIN_PACKS.map((p) => p.id)).toContain('signal');
});
