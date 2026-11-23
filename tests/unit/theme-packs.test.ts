/**
 * Theme packs: authored with createPack, built into release files, registered for the editor, and pinned by
 * projects that use an installed pack. Sites get the pack's fonts as files copied into the project.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectState } from '@shared/types';
import type { AuthoredPack, ThemePack } from '@catalogue/pack';
import { P, createPack } from '@catalogue/dsl';
import { BUILTIN_PACKS, FOUNDATION_ALT_PACK, FOUNDATION_PACK } from '@catalogue/builtin';
import { defaultTheme, findTheme, getTheme, listThemes, registerPacks, themeLockEntry, themePinProblem } from '@catalogue/index';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { FONTS_DIR, generateProject, packFileCopies } from '@generator/index';
import { buildPack, registerBuiltinPacks, writeRelease } from '../../src/main/packs/build';
import { loadPackDir } from '../../src/main/packs/loader';
import { readPackFile } from '../../src/main/packs/files';
import { ProjectSession } from '../../src/main/project/session';
import { ProjectFormatError } from '../../src/main/project/documents';
import { editedGeneratedFile } from '../../src/main/export';
import { sha } from '../../src/main/project/fsutil';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  registerBuiltinPacks();
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

/** A third-party pack built from Foundation's components under another identity. */
function studio(over: Partial<AuthoredPack> = {}): AuthoredPack {
  const { components, ...meta } = FOUNDATION_PACK;
  const author = createPack({ ...meta, id: 'studio', name: 'Studio', version: '1.0.0', license: 'MIT', ...over });
  return author.define(components.map((c) => author.adopt(c)));
}

describe('authoring a pack', () => {
  it('stamps every component with the pack it is created from', () => {
    const a = createPack({ ...FOUNDATION_PACK, id: 'one', version: '1.2.3', license: 'MIT' });
    const b = createPack({ ...FOUNDATION_PACK, id: 'two', version: '2.0.0', license: 'Apache-2.0' });
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
    const a = createPack({ ...FOUNDATION_PACK, id: 'one', version: '1.0.0', license: 'MIT' });
    const b = createPack({ ...FOUNDATION_PACK, id: 'two', version: '1.0.0', license: 'MIT' });
    expect(() => a.define([b.managed(spec)])).toThrow(/does not belong to pack one@1\.0\.0/);
    const x = a.managed(spec);
    expect(() => a.define([x, x])).toThrow(/lists one\.promo\.note twice/);
  });

  it('builds Foundation and its development fixture from their own identities', () => {
    expect(FOUNDATION_PACK.components).toHaveLength(20);
    for (const c of FOUNDATION_PACK.components) expect([c.id, c.provenance?.pack, c.provenance?.packVersion, c.license]).toEqual([`foundation.${c.componentId}`, 'foundation', '0.1.0', 'GPL-3.0-or-later']);
    for (const [i, c] of FOUNDATION_ALT_PACK.components.entries()) {
      expect(c.id).toBe(`foundation-alt.${c.componentId}`);
      expect(c.provenance?.pack).toBe('foundation-alt');
      // The fixture keeps Foundation's contracts; only the split hero's layout differs.
      if (c.componentId !== 'hero.split') expect(JSON.stringify({ ...c, id: '', provenance: {} })).toBe(JSON.stringify({ ...FOUNDATION_PACK.components[i], id: '', provenance: {} }));
    }
    expect(BUILTIN_PACKS.map((p) => [p.id, !!p.devOnly])).toEqual([
      ['foundation', false],
      ['foundation-alt', true]
    ]);
  });
});

describe('a pack release', () => {
  it('loads back with every definition and generated file unchanged', async () => {
    const root = tmp();
    const built = BUILTIN_PACKS.map((a) => buildPack(a));
    for (const b of built) writeRelease(join(root, b.pack.id), b.pack, b.files);
    const loaded = await Promise.all(built.map((b) => loadPackDir(join(root, b.pack.id), { dir: root, source: 'bundled' })));
    for (const [i, l] of loaded.entries()) expect(JSON.stringify(l.pack.components)).toBe(JSON.stringify(BUILTIN_PACKS[i].components));
    // Same project, generated once with the packs from source and once with their releases.
    const state = createStarterState('business', 'Parity', false);
    const both = () => [...generateProject(state, { instrument: false }), ...generateProject(state, { instrument: true })];
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
    expect(() => registerPacks([...listThemes(), listThemes()[0]])).toThrow(/Two packs have the ID "foundation"/);
    // A fixture is never the default, even listed first.
    registerPacks([...listThemes()].reverse());
    expect(defaultTheme().id).toBe('foundation');
    registerPacks([]);
    expect(() => getTheme('foundation')).toThrow(/No theme packs are loaded/);
  });
});

/** Register the built-in packs plus an installed pack with this digest. */
function withInstalled(digest: string, over: Partial<AuthoredPack> = {}): ThemePack {
  const pack: ThemePack = { ...buildPack(studio(over)).pack, source: 'user', digest };
  registerPacks([...BUILTIN_PACKS.map((a) => buildPack(a).pack), pack]);
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

  it('notices a missing pack or another copy of the same version, but lets a new version through', () => {
    const state = (digest?: string) => ({ site: { themeId: 'studio' }, themeLock: { theme: { id: 'studio', version: '1.0.0', ...(digest ? { digest } : {}) } } });
    withInstalled('d1');
    expect(themePinProblem(state('d1'))).toBeNull();
    expect(themePinProblem(state())).toBeNull();
    expect(themePinProblem(state('d0'))).toMatch(/the installed pack with that version is a different copy/);
    withInstalled('d2', { version: '1.1.0' });
    expect(themePinProblem(state('d0'))).toBeNull();
    registerBuiltinPacks();
    expect(themePinProblem(state('d1'))).toMatch(/theme "studio" 1\.0\.0, which is not installed/);
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
});

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
