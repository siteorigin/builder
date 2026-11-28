/**
 * Theme packs: authored with createPack, built into release files, registered for the editor, and pinned by
 * projects that use an installed pack. Sites get the pack's fonts as files copied into the project.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectState } from '@shared/types';
import type { AuthoredPack, ThemePack } from '@catalogue/pack';
import { P, createPack } from '@catalogue/dsl';
import { builtinFont } from '@catalogue/builtin-fonts';
import { defaultTheme, findTheme, getTheme, listThemes, registerPacks, themeLockEntry, themePinProblem } from '@catalogue/index';
import { createStarterState, starterProblem } from '@catalogue/starters';
import { applyOperations, assetUsages } from '@engine/apply';
import { contractConflicts } from '@engine/theme-updates';
import { validateState } from '@engine/validate';
import { FONTS_DIR, generateProject, packFileCopies } from '@generator/index';
import { buildPack, fileSource, writeRelease } from '../../src/main/packs/build';
import { loadPackDir } from '../../src/main/packs/loader';
import { readPackFile, registerPackFiles } from '../../src/main/packs/files';
import { ProjectSession, ThemeUnavailableError } from '../../src/main/project/session';
import { ProjectFormatError } from '../../src/main/project/documents';
import { editedGeneratedFile } from '../../src/main/export';
import { sha } from '../../src/main/project/fsutil';
import { ROOT, metaOf, restorePacks } from './fixtures/packs';

const dirs: string[] = [];
afterEach(async () => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  await restorePacks();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-theme-packs-'));
  dirs.push(d);
  return d;
};

const spec = {
  componentId: 'promo.note',
  name: 'Note',
  description: 'A short note.',
  category: 'content' as const,
  tags: ['note'],
  icon: 'sticky-note',
  properties: { text: P.str('Text', 'Hello') },
  parts: { root: { nodeId: 'root', label: 'Note' } },
  build: (b: Parameters<Parameters<ReturnType<typeof createPack>['managed']>[0]['build']>[0]) => b.text('root', 'p', { $prop: 'text' })
};

/**
 * A theme the app ships, as it loads it, in the form a pack is authored in: its data and components, with its fonts
 * named from the fonts the app's packs are built with.
 */
function authored(id: 'foundation' | 'foundation-alt' = 'foundation'): AuthoredPack {
  const pack = findTheme(id)!;
  return { ...metaOf(pack, { fonts: pack.fonts.map((f) => builtinFont(f.name)) }), components: pack.components };
}

/** A third-party pack built from Foundation's components under another identity. */
function studio(over: Partial<AuthoredPack> = {}): AuthoredPack {
  const { components, ...meta } = authored();
  const author = createPack({ ...meta, id: 'studio', name: 'Studio', version: '1.0.0', license: 'MIT', devOnly: undefined, ...over });
  return author.define(components.map((c) => author.adopt(c)));
}

describe('authoring a pack', () => {
  it('stamps every component with the pack it is created from', () => {
    const a = createPack({ ...authored(), id: 'one', version: '1.2.3', license: 'MIT' });
    const b = createPack({ ...authored(), id: 'two', version: '2.0.0', license: 'Apache-2.0' });
    const x = a.managed(spec);
    const y = b.managed(spec);
    expect([x.id, x.provenance, x.license]).toEqual(['one.promo.note', { pack: 'one', packVersion: '1.2.3', componentId: 'promo.note' }, 'MIT']);
    expect([y.id, y.provenance, y.license]).toEqual(['two.promo.note', { pack: 'two', packVersion: '2.0.0', componentId: 'promo.note' }, 'Apache-2.0']);
    // Everything but the identity is the same component.
    const strip = (d: typeof x) => JSON.stringify({ ...d, id: '', provenance: {}, license: '' });
    expect(strip(x)).toBe(strip(y));
    expect(a.define([x]).components).toEqual([x]);
  });

  it('refuses a component of another pack, or one listed twice', () => {
    const a = createPack({ ...authored(), id: 'one', version: '1.0.0', license: 'MIT' });
    const b = createPack({ ...authored(), id: 'two', version: '1.0.0', license: 'MIT' });
    expect(() => a.define([b.managed(spec)])).toThrow(/does not belong to pack one@1\.0\.0/);
    const x = a.managed(spec);
    expect(() => a.define([x, x])).toThrow(/lists one\.promo\.note twice/);
  });

  it('ships Foundation and its development fixture under their own identities', () => {
    const foundation = findTheme('foundation')!;
    const alt = findTheme('foundation-alt')!;
    expect(foundation.components.map((c) => c.componentId)).toEqual([
      'shell.header', 'shell.footer', 'hero.centered', 'hero.split', 'hero.screenshot', 'intro.page', 'content.article', 'logos.strip', 'features.grid', 'features.bento', 'content.media', 'features.alternating', 'tabs.showcase', 'content.steps-media', 'content.steps', 'content.text', 'stats.row',
      'testimonials.grid', 'team.grid', 'pricing.plans', 'pricing.toggle', 'pricing.compare', 'data.table', 'faq.list', 'content.pages', 'content.news', 'blog.featured', 'blog.grid', 'blog.list', 'media.gallery', 'media.carousel', 'media.video', 'cta.banner', 'contact.details', 'contact.form', 'site.search', 'layout.section', 'layout.split',
      'block.feature', 'block.stat', 'block.testimonial', 'block.callout', 'block.download', 'block.facts', 'block.signup', 'block.video'
    ]);
    expect(alt.components.map((c) => c.componentId)).toEqual(foundation.components.map((c) => c.componentId));
    for (const c of foundation.components) expect([c.id, c.provenance?.pack, c.provenance?.packVersion, c.license]).toEqual([`foundation.${c.componentId}`, 'foundation', '0.1.0', 'MIT-0']);
    for (const [i, c] of alt.components.entries()) {
      expect(c.id).toBe(`foundation-alt.${c.componentId}`);
      expect(c.provenance?.pack).toBe('foundation-alt');
      // The fixture keeps Foundation's contracts under its own identity.
      expect(JSON.stringify({ ...c, id: '', provenance: {} })).toBe(JSON.stringify({ ...foundation.components[i], id: '', provenance: {} }));
    }
    // The blocks (#664) insert as elements in every theme, so a theme switch keeps where Insert puts them.
    for (const pack of [foundation, alt])
      expect(pack.components.filter((c) => c.insertAs === 'element').map((c) => c.componentId), pack.id).toEqual(['block.feature', 'block.stat', 'block.testimonial', 'block.callout', 'block.download', 'block.facts', 'block.signup', 'block.video']);
    expect(foundation.components.filter((c) => c.insertAs !== undefined && c.insertAs !== 'element')).toEqual([]);
    expect(listThemes().map((p) => [p.id, !!p.devOnly])).toEqual([
      ['foundation', false],
      ['foundation-alt', true]
    ]);
  });
});

describe('a pack release', () => {
  it('loads back with every definition and generated file unchanged', async () => {
    const root = tmp();
    // The themes the app ships, built again from what their releases hold.
    const sources = [authored('foundation'), authored('foundation-alt')];
    const built = sources.map((a) => buildPack(a));
    for (const b of built) writeRelease(join(root, b.pack.id), b.pack, b.files);
    const loaded = await Promise.all(built.map((b) => loadPackDir(join(root, b.pack.id), { dir: root, source: 'bundled' })));
    for (const [i, l] of loaded.entries()) {
      expect(JSON.stringify(l.pack.components)).toBe(JSON.stringify(sources[i].components));
      expect(l.pack.fonts).toEqual(built[i].pack.fonts);
      // Every file the release ships is its source, byte for byte.
      for (const [rel, abs] of built[i].files) expect(readFileSync(join(root, l.pack.id, rel)).equals(readFileSync(abs)), rel).toBe(true);
    }
    // Same project, generated once with the releases the app ships and once with the ones built again.
    const state = createStarterState('business', 'Parity', false);
    const both = () => [...generateProject(state, { instrument: false }), ...generateProject(state, { instrument: true }), ...packFileCopies(state).map((c) => [c.path, c.file])];
    const fromSource = both();
    registerPacks(loaded.map((l) => l.pack));
    expect(both()).toEqual(fromSource);
  });
});

describe('the pack registry', () => {
  it('finds packs by ID, falls back to the default theme, and refuses two packs with one ID', () => {
    expect(listThemes().map((t) => t.id)).toEqual(['foundation', 'foundation-alt']);
    expect(defaultTheme().id).toBe('foundation');
    expect(findTheme('nope')).toBeUndefined();
    expect(getTheme('nope').id).toBe('foundation');
    expect(getTheme('foundation-alt').id).toBe('foundation-alt');
    expect(findTheme('foundation-alt')?.devOnly).toBe(true);
    expect(() => registerPacks([...listThemes(), listThemes()[0]])).toThrow(/Two packs have the ID "foundation"/);
    // A fixture is never the default, even listed first: the first pack that is not one is.
    registerPacks([...listThemes()].reverse());
    expect(defaultTheme().id).toBe('foundation');
    expect(getTheme('nope').id).toBe('foundation');
    registerPacks([findTheme('foundation-alt')!, findTheme('foundation')!]);
    expect(defaultTheme().id).toBe('foundation');
    registerPacks([]);
    expect(() => getTheme('foundation')).toThrow(/No theme packs are loaded/);
  });
});

describe('starting a project on a theme', () => {
  it('starts a new project of either starter, recording the theme chosen and placing only its sections', () => {
    for (const starter of ['business', 'blank'] as const) {
      const s = createStarterState(starter, 'Magazine', false, 'foundation-alt');
      expect(s.site.themeId).toBe('foundation-alt');
      expect(s.themeLock.theme).toEqual({ id: 'foundation-alt', version: '0.1.0' });
      const placed = [...Object.values(s.pages), s.site.shell.header, s.site.shell.footer].flatMap((t) => Object.values(t.nodes)).filter((n) => n.kind === 'instance');
      expect(placed.length).toBeGreaterThan(starter === 'business' ? 10 : 1);
      for (const n of placed) expect(n.definitionId).toMatch(/^foundation-alt\./);
      expect(validateState(s).filter((d) => d.severity === 'error'), starter).toEqual([]);
    }
    // Without a choice, a project starts on the default theme.
    expect(createStarterState('blank', 'Plain', false).site.themeId).toBe('foundation');
  });

  it('says before anything is made when a theme cannot make a starter', () => {
    expect(starterProblem('business', 'foundation-alt')).toBeNull();
    expect(starterProblem('blank')).toBeNull();
    expect(starterProblem('business', 'nope')).toMatch(/"nope" is not installed/);
    // An installed pack without the split hero can make a blank site, but not the Business starter.
    const { components, ...meta } = authored();
    const author = createPack({ ...meta, id: 'sparse', name: 'Sparse', version: '1.0.0', license: 'MIT' });
    registerPacks([...listThemes(), buildPack(author.define(components.filter((c) => c.componentId !== 'hero.split').map((c) => author.adopt(c)))).pack]);
    expect(starterProblem('blank', 'sparse')).toBeNull();
    expect(starterProblem('business', 'sparse')).toMatch(/^The Sparse theme cannot make the Business starter: Unknown component "hero\.split"/);
    // One with every section, but a header without the navigation the starters fill in.
    const bare = createPack({ ...meta, id: 'bare', name: 'Bare', version: '1.0.0', license: 'MIT' });
    const headless = components.map((c) => {
      const d = bare.adopt(c);
      if (d.componentId === 'shell.header') delete d.properties.links;
      return d;
    });
    registerPacks([...listThemes(), buildPack(bare.define(headless)).pack]);
    expect(starterProblem('blank', 'bare')).toMatch(/^The Bare theme cannot make the Blank site: Header: property "links" is not compatible\./);
    // And one whose image section lost the layout the Business starter chooses for it.
    const plain = createPack({ ...meta, id: 'plain', name: 'Plain', version: '1.0.0', license: 'MIT' });
    const fixed = components.map((c) => {
      const d = plain.adopt(c);
      if (d.componentId === 'content.media') delete d.variantAxes!.layout.options['media-end'];
      return d;
    });
    registerPacks([...listThemes(), buildPack(plain.define(fixed)).pack]);
    expect(starterProblem('blank', 'plain')).toBeNull();
    expect(starterProblem('business', 'plain')).toMatch(/^The Plain theme cannot make the Business starter: Content with image: layout variant "media-end" is missing\./);
    // A pack whose definitions cannot be compared is refused on its own; the others are still offered.
    const broken = createPack({ ...meta, id: 'broken', name: 'Broken', version: '1.0.0', license: 'MIT' });
    const odd = components.map((c) => {
      const d = broken.adopt(c);
      if (d.componentId === 'shell.header') (d.properties.ctaStyle as { options: unknown[] }).options.unshift(null);
      return d;
    });
    registerPacks([...listThemes(), buildPack(broken.define(odd)).pack]);
    expect(starterProblem('blank', 'broken')).toMatch(/^The Broken theme cannot make the Blank site: its sections could not be read/);
    expect(starterProblem('blank', 'foundation-alt')).toBeNull();
  });
});

/** Register the built-in packs plus an installed pack with this digest. */
function withInstalled(digest: string, over: Partial<AuthoredPack> = {}): ThemePack {
  const pack: ThemePack = { ...buildPack(studio(over)).pack, source: 'user', digest };
  registerPacks([...listThemes().filter((t) => t.source === 'bundled'), pack]);
  return pack;
}

describe('pinning an installed pack', () => {
  it('records the exact release of an installed pack, never of a bundled one', () => {
    withInstalled('d1');
    expect(themeLockEntry(getTheme('foundation'))).toEqual({ id: 'foundation', version: '0.1.0' });
    expect(themeLockEntry(getTheme('studio'))).toEqual({ id: 'studio', version: '1.0.0', digest: 'd1' });
    const next = applyOperations(createStarterState('business', 'Pin', false), [{ type: 'theme.apply', themeId: 'studio' }]).state;
    expect(next.themeLock.theme).toEqual({ id: 'studio', version: '1.0.0', digest: 'd1' });
    // Back to a bundled theme, the pin goes.
    expect(applyOperations(next, [{ type: 'theme.apply', themeId: 'foundation' }]).state.themeLock.theme).toEqual({ id: 'foundation', version: '0.1.0' });
  });

  it('never lets a built-in theme stand in for an installed pack that had its ID (#390)', () => {
    // A built-in theme took the ID: a project made with an installed pack of that ID records its digest.
    for (const version of ['0.1.0', '2.0.0']) expect(themePinProblem({ site: { themeId: 'foundation-alt' }, themeLock: { theme: { id: 'foundation-alt', version, digest: 'd1' } } }), version).toMatch(/built-in theme with that ID, which is a different design/);
    expect(themePinProblem({ site: { themeId: 'foundation-alt' }, themeLock: { theme: { id: 'foundation-alt', version: '0.1.0' } } })).toBeNull();
  });

  it('notices a missing pack or another copy of the same version, but lets a new version through', async () => {
    const state = (digest?: string) => ({ site: { themeId: 'studio' }, themeLock: { theme: { id: 'studio', version: '1.0.0', ...(digest ? { digest } : {}) } } });
    withInstalled('d1');
    expect(themePinProblem(state('d1'))).toBeNull();
    // An installed pack is only used with a recorded release.
    expect(themePinProblem(state())).toMatch(/does not record which copy/);
    expect(themePinProblem({ site: { themeId: 'studio' }, themeLock: { theme: { id: 'foundation', version: '0.1.0' } } })).toMatch(/does not record which copy/);
    expect(themePinProblem(state('d0'))).toMatch(/the installed pack with that version is a different copy/);
    withInstalled('d2', { version: '1.1.0' });
    expect(themePinProblem(state('d0'))).toBeNull();
    await restorePacks();
    expect(themePinProblem(state('d1'))).toMatch(/theme "studio" 1\.0\.0, which is not installed/);
  });

  it('never lets an older installed release stand in for the one the project recorded (#1493)', async () => {
    const state = (version: string) => ({ site: { themeId: 'studio' }, themeLock: { theme: { id: 'studio', version, digest: 'd0' } } });
    withInstalled('d1', { version: '1.1.0' });
    for (const recorded of ['1.2.0', '1.1.1', '1.10.0', '2.0.0']) expect(themePinProblem(state(recorded)), recorded).toMatch(new RegExp(`needs "studio" ${recorded.replace(/\./g, '\\.')} or newer, but the installed copy is 1\\.1\\.0`));
    // A newer installed release is fine, and so is the release of a prerelease the project recorded.
    for (const recorded of ['1.0.9', '1.1.0-beta.2', '0.9.0']) expect(themePinProblem(state(recorded)), recorded).toBeNull();
    // An installed prerelease is older than its release.
    withInstalled('d1', { version: '1.2.0-rc.1' });
    expect(themePinProblem(state('1.2.0'))).toMatch(/needs "studio" 1\.2\.0 or newer, but the installed copy is 1\.2\.0-rc\.1/);
    expect(themePinProblem(state('1.2.0-rc.0'))).toBeNull();
    expect(themePinProblem(state('1.2.0-rc.2'))).toMatch(/or newer/);
    await restorePacks();
  });

  it('opens a project whose theme is not installed read-only', async () => {
    const d = tmp();
    withInstalled('d1');
    const state = applyOperations(createStarterState('business', 'Gone', false), [{ type: 'theme.apply', themeId: 'studio' }]).state;
    await (await ProjectSession.create(d, state)).close();
    await restorePacks();
    const theme = readFileSync(join(d, 'src/lib/siteorigin/styles/theme.css'), 'utf8');
    const err = await ProjectSession.open(d, 'test').catch((e) => e);
    expect(err).toBeInstanceOf(ThemeUnavailableError);
    expect((err as Error).message).toMatch(/uses the theme "studio" 1\.0\.0, which is not installed/);
    expect(readFileSync(join(d, 'src/lib/siteorigin/styles/theme.css'), 'utf8')).toBe(theme);
  });

  it('refuses to undo back to a theme that is no longer installed', async () => {
    const d = tmp();
    withInstalled('d1');
    const s = await ProjectSession.create(d, createStarterState('business', 'Undo', false));
    expect((await s.apply({ operations: [{ type: 'theme.apply', themeId: 'studio' }] }, { label: 'Studio' })).ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'theme.apply', themeId: 'foundation' }] }, { label: 'Foundation' })).ok).toBe(true);
    await restorePacks();
    const theme = readFileSync(join(d, 'src/lib/siteorigin/styles/theme.css'), 'utf8');
    const r = await s.undo();
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/Cannot undo "Foundation": This project uses the theme "studio"[^]*not installed/);
    expect(s.state.site.themeId).toBe('foundation');
    expect(readFileSync(join(d, 'src/lib/siteorigin/styles/theme.css'), 'utf8')).toBe(theme);
    await s.close();
  });

  it('opens a project read-only rather than restyle it from another copy of its pack', async () => {
    const d = tmp();
    withInstalled('d1');
    const s = await ProjectSession.create(d, applyOperations(createStarterState('business', 'Pinned', false), [{ type: 'theme.apply', themeId: 'studio' }]).state);
    await s.close();
    const theme = readFileSync(join(d, 'src/lib/siteorigin/styles/theme.css'), 'utf8');
    withInstalled('d2', { baseCss: 'body { color: red; }' });
    const err = await ProjectSession.open(d, 'test').catch((e) => e);
    expect(err).toBeInstanceOf(ProjectFormatError);
    expect((err as ProjectFormatError).readOnly).toBe(true);
    expect(readFileSync(join(d, 'src/lib/siteorigin/styles/theme.css'), 'utf8')).toBe(theme);
    withInstalled('d1');
    await (await ProjectSession.open(d, 'test')).close();
  });

  it('opens a project read-only rather than restyle it from an older release of its pack (#1493)', async () => {
    const d = tmp();
    withInstalled('d1', { version: '1.2.0' });
    const s = await ProjectSession.create(d, applyOperations(createStarterState('business', 'Older', false), [{ type: 'theme.apply', themeId: 'studio' }]).state);
    await s.close();
    const theme = readFileSync(join(d, 'src/lib/siteorigin/styles/theme.css'), 'utf8');
    withInstalled('d0', { version: '1.1.0', baseCss: 'body { color: red; }' });
    const err = await ProjectSession.open(d, 'test').catch((e) => e);
    expect(err).toBeInstanceOf(ProjectFormatError);
    expect((err as ProjectFormatError).readOnly).toBe(true);
    expect((err as Error).message).toMatch(/needs "studio" 1\.2\.0 or newer, but the installed copy is 1\.1\.0/);
    expect(readFileSync(join(d, 'src/lib/siteorigin/styles/theme.css'), 'utf8')).toBe(theme);
    // A newer release opens it.
    withInstalled('d3', { version: '1.2.1' });
    await (await ProjectSession.open(d, 'test')).close();
  });
});

const inter = builtinFont('Inter');
// Studio ships Inter only, and sets its display font to it.
const onlyInter = () => ({ fonts: [inter], tokens: authored().tokens.map((t) => (t.id === 'font.display' ? { ...t, value: inter.stack } : t)) });

describe('a new project', () => {
  it('records the theme it is made with when the default is not installed', () => {
    registerPacks([findTheme('foundation-alt')!]);
    const s = createStarterState('blank', 'Fallback', false);
    expect(s.site.themeId).toBe('foundation-alt');
    expect(s.themeLock.theme.id).toBe('foundation-alt');
    expect(themePinProblem(s)).toBeNull();
  });
});

describe('switching to a pack with other fonts', () => {
  it('takes the new theme’s fonts where the site kept the defaults', () => {
    const studioPack = withInstalled('d1', onlyInter());
    const next = applyOperations(createStarterState('business', 'Fonts', false), [{ type: 'theme.apply', themeId: 'studio' }]).state;
    expect(packFileCopies(next)).toEqual(studioPack.fonts[0].faces.map((f) => ({ path: `${FONTS_DIR}/${f.file.slice('fonts/'.length)}`, pack: 'studio', file: f.file })));
  });

  it('is not blocked by text that only mentions a font, nor by a font the project imported itself', () => {
    withInstalled('d1', onlyInter());
    const s = createStarterState('business', 'Fonts', false);
    const hero = Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'instance')!;
    (hero as { props: Record<string, unknown> }).props.heading = 'Set in Lora Variable, our favourite';
    expect(applyOperations(s, [{ type: 'theme.apply', themeId: 'studio' }]).state.site.themeId).toBe('studio');
    const own = createStarterState('business', 'Fonts', false);
    own.assets.assets['f1'] = { id: 'f1', name: 'Lora', file: 'static/assets/lora-aaaaaaaa.woff2', mime: 'font/woff2', bytes: 1, hash: 'x', kind: 'font', createdAt: '', font: { family: 'Lora Variable', weight: '400', style: 'normal' } };
    own.tokens.overrides['font.body'] = "'Lora Variable', serif";
    expect(applyOperations(own, [{ type: 'theme.apply', themeId: 'studio' }]).state.site.themeId).toBe('studio');
  });

  it.each([
    ['on an element', 'Playfair Display, serif'],
    ['on an element, spaced as CSS allows', 'Playfair  Display  Variable, serif']
  ])('is refused for a font chosen %s', (_how, value) => {
    withInstalled('d1', onlyInter());
    const s = createStarterState('business', 'Fonts', false);
    const hero = Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'instance')!;
    const styled = applyOperations(s, [{ type: 'node.setStyle', owner: { kind: 'page', id: s.site.homePageId }, nodeId: hero.id, partId: 'heading', scope: 'base', property: 'fontFamily', value }]).state;
    expect(packFileCopies(styled).some((c) => c.file.includes('playfair'))).toBe(true);
    expect(() => applyOperations(styled, [{ type: 'theme.apply', themeId: 'studio' }])).toThrow(/Playfair Display: your site uses this font/);
  });

  it('is refused for a font chosen in a font token the theme names otherwise', () => {
    // "Serif" ships Lora and Inter, and keeps its body font in "type.body"; Studio ships Inter only.
    const { components, ...meta } = authored();
    const serifAuthor = createPack({ ...meta, id: 'serif', name: 'Serif', version: '1.0.0', license: 'MIT', fonts: meta.fonts.filter((f) => ['Inter', 'Lora'].includes(f.name)), tokens: [...meta.tokens, { id: 'type.body', label: 'Body', group: 'font', value: inter.stack }] });
    const serif: ThemePack = { ...buildPack(serifAuthor.define(components.map((c) => serifAuthor.adopt(c)))).pack, source: 'user', digest: 's1' };
    const studioPack = withInstalled('d1', onlyInter());
    registerPacks([...listThemes(), serif]);
    const onSerif = applyOperations(createStarterState('business', 'Fonts', false), [{ type: 'theme.apply', themeId: 'serif' }]).state;
    expect(studioPack.fonts.map((f) => f.name)).toEqual(['Inter']);
    const chose = applyOperations(onSerif, [{ type: 'token.set', tokenId: 'type.body', value: 'Lora' }]).state;
    expect(() => applyOperations(chose, [{ type: 'theme.apply', themeId: 'studio' }])).toThrow(/Lora: your site uses this font/);
  });

  it('counts an imported font chosen in a font token the theme names otherwise, and settles it when the font goes', () => {
    // Issue 247: a use the count missed let the font go without the author seeing what changes.
    const { components, ...meta } = authored();
    const serifAuthor = createPack({ ...meta, id: 'serif', name: 'Serif', version: '1.0.0', license: 'MIT', tokens: [...meta.tokens, { id: 'type.body', label: 'Body', group: 'font', value: inter.stack }] });
    registerPacks([...listThemes(), { ...buildPack(serifAuthor.define(components.map((c) => serifAuthor.adopt(c)))).pack, source: 'user', digest: 's1' }]);
    const face = { id: 'f1', name: 'Brand', file: 'static/assets/brand-aaaaaaaa.woff2', mime: 'font/woff2', bytes: 1, hash: 'x', kind: 'font' as const, createdAt: '', font: { family: 'Brand Sans', weight: '400', style: 'normal' as const } };
    const s = applyOperations(createStarterState('business', 'Fonts', false), [{ type: 'theme.apply', themeId: 'serif' }, { type: 'asset.add', asset: face }, { type: 'token.set', tokenId: 'type.body', value: "'Brand Sans', Georgia, serif" }]).state;
    expect(assetUsages(s).f1).toBe(1);
    expect(() => applyOperations(s, [{ type: 'asset.remove', assetId: 'f1' }])).toThrow(/This font is used 1 time/);
    const gone = applyOperations(s, [{ type: 'asset.remove', assetId: 'f1', fontUses: 'fallback' }]).state;
    expect(gone.tokens.overrides['type.body']).toBe('Georgia, serif');
  });

  it('reads a project code component for the fonts it names, and not for longer names that contain one', () => {
    withInstalled('d1', onlyInter());
    const withSource = (css: string) => applyOperations(createStarterState('business', 'Fonts', false), [{ type: 'component.createCode', name: 'Banner', source: `<p>Hi</p>\n<style>${css}</style>`, properties: {} }]).state;
    expect(() => applyOperations(withSource("p { font-family: 'Lora  Variable', serif; }"), [{ type: 'theme.apply', themeId: 'studio' }])).toThrow(/Lora: your site uses this font, which Studio does not include/);
    expect(applyOperations(withSource('p { font-family: var(--font-lora-variable), Lora_Variable_Alt, Lora VariableExtended; }'), [{ type: 'theme.apply', themeId: 'studio' }]).state.site.themeId).toBe('studio');
  });

  it('is refused for a font chosen in a text style', () => {
    withInstalled('d1', onlyInter());
    const styled = applyOperations(createStarterState('business', 'Fonts', false), [{ type: 'token.set', tokenId: 'text.h1', value: { family: 'Space Grotesk' } }]).state;
    expect(() => applyOperations(styled, [{ type: 'theme.apply', themeId: 'studio' }])).toThrow(/Space Grotesk: your site uses this font/);
  });

  it('refuses, naming the font, when the site chose a font the new theme does not ship', () => {
    withInstalled('d1', onlyInter());
    const chose = applyOperations(createStarterState('business', 'Fonts', false), [{ type: 'token.set', tokenId: 'font.display', value: 'Lora' }]).state;
    expect(() => applyOperations(chose, [{ type: 'theme.apply', themeId: 'studio' }])).toThrow(/Lora: your site uses this font, which Studio does not include/);
    // Back on a font the new theme has, the switch goes ahead.
    const back = applyOperations(chose, [{ type: 'token.set', tokenId: 'font.display', value: 'Inter' }]).state;
    expect(applyOperations(back, [{ type: 'theme.apply', themeId: 'studio' }]).state.site.themeId).toBe('studio');
  });
});

/**
 * Foundation's validated inventory, with Inter's Latin face now read from a copy that changed on disk after
 * validation (as if the pack's file were replaced while the app ran).
 */
function changedOnDisk(scratch: string) {
  const release = join(ROOT, 'resources', 'packs', 'foundation');
  const listed = (JSON.parse(readFileSync(join(release, 'pack.json'), 'utf8')) as { files: Record<string, unknown> }).files;
  const files = new Map(Object.keys(listed).map((rel) => [rel, join(release, rel)]));
  const changed = join(scratch, '.changed-inter.woff2');
  const bytes = readFileSync(files.get('fonts/inter-latin-wght-normal.woff2')!);
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(changed, bytes);
  return new Map([...files].map(([rel, abs]) => [rel, rel === 'fonts/inter-latin-wght-normal.woff2' ? { ...fileSource(abs), abs: changed } : fileSource(abs)]));
}

describe("a site's theme fonts", () => {
  const fontPaths = (d: string, state: ProjectState) => packFileCopies(state).map((c) => join(d, c.path));

  it('are copied into the project byte for byte, listed as generated, and follow font changes', async () => {
    const d = tmp();
    const s = await ProjectSession.create(d, createStarterState('business', 'Fonts', false));
    const copies = packFileCopies(s.state);
    expect(copies.length).toBeGreaterThan(0);
    const manifest = () => JSON.parse(readFileSync(join(d, 'siteorigin/generated-manifest.json'), 'utf8')).files as Record<string, string>;
    for (const c of copies) {
      const bytes = readFileSync(join(d, c.path));
      expect(bytes.equals(await readPackFile(c.pack, c.file))).toBe(true);
      expect(manifest()[c.path]).toBe(sha(bytes));
    }
    expect(readFileSync(join(d, FONTS_DIR, 'NOTICE.txt'), 'utf8')).toMatch(/Fraunces \(OFL-1\.1\)/);
    // The export's check that nothing generated was edited reads fonts as bytes.
    expect(await editedGeneratedFile(d)).toBeNull();

    await s.apply({ operations: [{ type: 'token.set', tokenId: 'font.display', value: 'Lora' }] }, { label: 'Font' });
    expect(fontPaths(d, s.state).some((p) => p.includes('lora-latin-wght'))).toBe(true);
    expect(existsSync(join(d, FONTS_DIR, 'lora-latin-wght-normal.woff2'))).toBe(true);
    expect(existsSync(join(d, FONTS_DIR, 'fraunces-latin-wght-normal.woff2'))).toBe(false);
    expect(Object.keys(manifest()).some((p) => p.includes('fraunces'))).toBe(false);
    // Exactly the faces now in use are on disk and claimed, each the pack's own bytes.
    const onDisk = readdirSync(join(d, FONTS_DIR)).filter((f) => f.endsWith('.woff2')).map((f) => `${FONTS_DIR}/${f}`).sort();
    expect(onDisk).toEqual(packFileCopies(s.state).map((c) => c.path).sort());
    expect(Object.keys(manifest()).filter((p) => p.startsWith(`${FONTS_DIR}/`) && p.endsWith('.woff2')).sort()).toEqual(onDisk);
    for (const c of packFileCopies(s.state)) {
      const bytes = readFileSync(join(d, c.path));
      expect(bytes.equals(await readPackFile(c.pack, c.file))).toBe(true);
      expect(manifest()[c.path]).toBe(sha(bytes));
    }
    await s.close();
  });

  it('keep the claim a publication that stopped part way left, when the pack cannot supply the file again', async () => {
    const d = tmp();
    await (await ProjectSession.create(d, createStarterState('business', 'Fonts', false))).close();
    const path = `${FONTS_DIR}/inter-latin-wght-normal.woff2`;
    const disk = sha(readFileSync(join(d, path)));
    // The older hash is still the settled one; the newer one, already on disk, is only pending.
    const m = JSON.parse(readFileSync(join(d, 'siteorigin/generated-manifest.json'), 'utf8'));
    m.files[path] = 'a'.repeat(64);
    m.pending = { [path]: disk };
    writeFileSync(join(d, 'siteorigin/generated-manifest.json'), JSON.stringify(m));
    registerPackFiles('foundation', changedOnDisk(d));
    const s = await ProjectSession.open(d, 'test');
    expect(JSON.parse(readFileSync(join(d, 'siteorigin/generated-manifest.json'), 'utf8')).files[path]).toBe(disk);
    expect(await editedGeneratedFile(d)).toBeNull();
    await s.close();
  });

  it('keep a copy the pack can no longer supply, rather than delete it', async () => {
    const d = tmp();
    const s = await ProjectSession.create(d, createStarterState('business', 'Fonts', false));
    const path = `${FONTS_DIR}/inter-latin-wght-normal.woff2`;
    const original = readFileSync(join(d, path));
    const before = JSON.parse(readFileSync(join(d, 'siteorigin/generated-manifest.json'), 'utf8')).files[path];
    // The pack's copy no longer matches what was validated (it changed on disk after startup).
    registerPackFiles('foundation', changedOnDisk(d));
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename' })).ok).toBe(true);
    expect(readFileSync(join(d, path)).equals(original)).toBe(true);
    expect(JSON.parse(readFileSync(join(d, 'siteorigin/generated-manifest.json'), 'utf8')).files[path]).toBe(before);
    expect(await editedGeneratedFile(d)).toBeNull();
    await s.close();
  });

  it('keep claiming a copy that has gone missing while the pack cannot supply it, so the export notices', async () => {
    const d = tmp();
    const s = await ProjectSession.create(d, createStarterState('business', 'Fonts', false));
    const path = `${FONTS_DIR}/inter-latin-wght-normal.woff2`;
    rmSync(join(d, path));
    registerPackFiles('foundation', changedOnDisk(d));
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename' })).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(d, 'siteorigin/generated-manifest.json'), 'utf8')).files[path]).toBeTruthy();
    expect(await editedGeneratedFile(d)).toBe(path);
    await s.close();
  });

  it("never keep another theme's file under a new theme's name", async () => {
    const d = tmp();
    // Studio's Inter face shares Foundation's file name, but is not the same file, and cannot be read.
    const studioPack = withInstalled('d1', onlyInter());
    const s = await ProjectSession.create(d, createStarterState('business', 'Fonts', false));
    const path = `${FONTS_DIR}/inter-latin-wght-normal.woff2`;
    expect(existsSync(join(d, path))).toBe(true);
    registerPackFiles('studio', new Map(studioPack.fonts[0].faces.map((f) => [f.file, { abs: join(d, 'missing.woff2'), size: 1, sha256: 'b'.repeat(64) }])));
    expect((await s.apply({ operations: [{ type: 'theme.apply', themeId: 'studio' }] }, { label: 'Studio' })).ok).toBe(true);
    expect(existsSync(join(d, path))).toBe(false);
    expect(JSON.parse(readFileSync(join(d, 'siteorigin/generated-manifest.json'), 'utf8')).files[path]).toBeUndefined();
    await s.close();
  });

  it('leave an obsolete font that was edited outside the app where it is', async () => {
    const d = tmp();
    const s = await ProjectSession.create(d, createStarterState('business', 'Fonts', false));
    const path = `${FONTS_DIR}/fraunces-latin-wght-normal.woff2`;
    writeFileSync(join(d, path), Buffer.from('wOF2 my own'));
    await s.apply({ operations: [{ type: 'token.set', tokenId: 'font.display', value: 'Lora' }] }, { label: 'Font' });
    expect(readFileSync(join(d, path)).toString()).toBe('wOF2 my own');
    expect(JSON.parse(readFileSync(join(d, 'siteorigin/generated-manifest.json'), 'utf8')).files[path]).toBeUndefined();
    await s.close();
  });

  it('keep a font file edited outside the app, and restore it on request', async () => {
    const d = tmp();
    const s = await ProjectSession.create(d, createStarterState('business', 'Fonts', false));
    const path = `${FONTS_DIR}/inter-latin-wght-normal.woff2`;
    const original = readFileSync(join(d, path));
    writeFileSync(join(d, path), Buffer.from('wOF2 replaced'));
    expect(await editedGeneratedFile(d)).toBe(path);
    await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename' });
    expect(readFileSync(join(d, path)).toString()).toBe('wOF2 replaced');
    expect(s.conflicts.some((c) => c.path === path)).toBe(true);
    await s.restoreGeneratedFile(path);
    expect(readFileSync(join(d, path)).equals(original)).toBe(true);
    expect(await editedGeneratedFile(d)).toBeNull();
    await s.close();
  });
});
