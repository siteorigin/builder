import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { InstanceNode, ProjectState } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { definitionHash, matchesLock, migrateProject, MIGRATIONS, type Migration } from '@shared/migrations';
import { sha256Hex } from '@shared/sha256';
import { createHash } from 'node:crypto';
import { applyOperations } from '@engine/apply';
import { themeUpdates } from '@engine/theme-updates';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { getTheme } from '@catalogue/index';
import { managed } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { examplesFor } from '@agent/examples';
import { readProject, readState } from '../../src/main/project/documents';
import { ProjectSession } from '../../src/main/project/session';
import { sha, toJson } from '../../src/main/project/fsutil';

const FIXTURE = join(__dirname, 'fixtures/v1-project');
const dirs: string[] = [];
const open: ProjectSession[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'so-migrate-'));
  dirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}
async function session(dir: string, id = 'test') {
  const s = await ProjectSession.open(dir, id);
  open.push(s);
  return s;
}
const read = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
const write = (dir: string, rel: string, v: unknown) => writeFileSync(join(dir, rel), toJson(v));
const MANIFEST = 'siteorigin.project.json';
const SITE = 'siteorigin/site.json';

/** Every file under a folder with its bytes, for proving that nothing was written. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
const canonicalJson = (dir: string) => Object.keys(tree(dir)).filter((p) => p === MANIFEST || (p.startsWith('siteorigin/') && p.endsWith('.json') && !p.endsWith('generated-manifest.json')));

describe('the migration pipeline', () => {
  const v1 = () => readState(copyFixture());

  it('the fixture really is a version 1 project', () => {
    expect(read(FIXTURE, MANIFEST).schemaVersion).toBe(1);
    expect(read(FIXTURE, 'siteorigin/components/foundation.hero.split/component.json').schemaVersion).toBe(1);
  });

  it('keeps its released entries first and in order, so a new migration can only be appended', () => {
    expect(MIGRATIONS[0].id).toBe('document-baseline');
    expect(new Set(MIGRATIONS.map((m) => m.id)).size).toBe(MIGRATIONS.length);
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length + 1);
  });

  it('runs entries in order from the stored version, on a copy', async () => {
    const stored = (await readProject(copyFixture())).stored;
    const snapshot = structuredClone(stored);
    const calls: string[] = [];
    const entry = (id: string): Migration => ({ id, description: id, migrate: (p) => void calls.push(`${id}:${p.manifest.schemaVersion}`) });
    const result = migrateProject(stored, [entry('a'), entry('b'), entry('c')])!;
    expect(calls).toEqual(['a:1', 'b:2', 'c:3']);
    expect(result).toMatchObject({ from: 1, to: 4, applied: ['a', 'b', 'c'] });
    expect(stored).toEqual(snapshot);
    const mixed = structuredClone(result.state);
    calls.length = 0;
    expect(migrateProject(mixed, [entry('a'), entry('b'), entry('c')])).toBeNull();
    const page = Object.values(mixed.pages)[0];
    page.schemaVersion = 3;
    expect(migrateProject(mixed, [entry('a'), entry('b'), entry('c')])!.applied).toEqual(['c']);
  });

  it('brings every document of the fixture to the current version', async () => {
    const { state } = migrateProject((await readProject(copyFixture())).stored)!;
    const docs = [state.manifest, state.site, state.tokens, state.assets, state.themeLock, ...Object.values(state.pages), ...Object.values(state.components)];
    expect(docs.every((d) => d.schemaVersion === SCHEMA_VERSION)).toBe(true);
    expect(validateState(state).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('fills in missing containers without touching ones that have content', async () => {
    const stored = (await readProject(copyFixture())).stored;
    const [a, b] = Object.values(stored.pages) as Array<(typeof stored.pages)[string] & { shell?: string }>;
    delete (a as Partial<typeof a>).seo;
    delete a.shell;
    b.shell = 'none';
    delete (stored.tokens as Partial<typeof stored.tokens>).custom;
    stored.tokens.overrides = { 'color.brand': '#123456' };
    const { state } = migrateProject(stored)!;
    expect(state.pages[a.id].seo).toEqual({});
    // A page that had no setting showed both shared parts, and still does.
    expect(state.pages[a.id]).toMatchObject({ showHeader: true, showFooter: true });
    expect(state.pages[b.id]).toMatchObject({ showHeader: false, showFooter: false });
    expect(state.tokens.custom).toEqual([]);
    expect(state.tokens.overrides).toEqual({ 'color.brand': '#123456' });
  });

  it('turns the single header and footer setting into one for each, in the same place in the page file', async () => {
    const stored = (await readProject(copyFixture())).stored;
    const [both, neither] = Object.values(stored.pages) as Array<(typeof stored.pages)[string] & { shell?: string }>;
    expect(both.shell).toBe('default');
    neither.shell = 'none';
    const { state, applied } = migrateProject(stored)!;
    expect(applied).toContain('independent-header-footer');
    expect(state.pages[both.id]).toMatchObject({ showHeader: true, showFooter: true });
    expect(state.pages[neither.id]).toMatchObject({ showHeader: false, showFooter: false });
    for (const page of Object.values(state.pages)) {
      expect(page).not.toHaveProperty('shell');
      const keys = Object.keys(page);
      expect(keys.slice(keys.indexOf('seo'), keys.indexOf('seo') + 3)).toEqual(['seo', 'showHeader', 'showFooter']);
    }
    // A page whose setting sat elsewhere in the file gets the two in that place.
    const moved = (await readProject(copyFixture())).stored;
    const page = Object.values(moved.pages)[0] as unknown as Record<string, unknown>;
    const { shell, ...rest } = page;
    for (const k of Object.keys(page)) delete page[k];
    Object.assign(page, { shell, ...rest });
    expect(Object.keys(migrateProject(moved)!.state.pages[page.id as string]).slice(0, 3)).toEqual(['showHeader', 'showFooter', 'schemaVersion']);
    // Pages render as they did: both parts, or neither.
    const layout = generateProject(state).get('src/routes/+layout.svelte')!;
    const route = state.pages[neither.id].route.replace(/\/$/, '');
    expect(layout).toContain(`const pagesWithoutHeader = new Set(${JSON.stringify([route])});`);
    expect(layout).toContain(`const pagesWithoutFooter = new Set(${JSON.stringify([route])});`);
  });

  it('converts only the pages still in the old format, keeping a newer page’s own choices', async () => {
    const current = migrateProject((await readProject(copyFixture())).stored)!.state;
    const [older, newer] = Object.values(current.pages);
    newer.showHeader = false;
    const stored = structuredClone(current);
    const old = stored.pages[older.id] as unknown as Record<string, unknown>;
    old.schemaVersion = SCHEMA_VERSION - 1;
    delete old.showHeader;
    delete old.showFooter;
    old.shell = 'none';
    const { state, applied } = migrateProject(stored)!;
    expect(applied).toEqual(['independent-header-footer']);
    expect(state.pages[older.id]).toMatchObject({ showHeader: false, showFooter: false, schemaVersion: SCHEMA_VERSION });
    expect(state.pages[newer.id]).toEqual(newer);
    // A page with only one of the two settings keeps it and takes the other from the old setting.
    const half = structuredClone(current);
    const partial = half.pages[older.id] as unknown as Record<string, unknown>;
    partial.schemaVersion = SCHEMA_VERSION - 1;
    partial.showHeader = true;
    delete partial.showFooter;
    partial.shell = 'none';
    expect(migrateProject(half)!.state.pages[older.id]).toMatchObject({ showHeader: true, showFooter: false });
    // A page in this format that is stamped older (a file put back from a copy) keeps its choices too.
    const restamped = structuredClone(current);
    restamped.pages[newer.id].schemaVersion = 1;
    expect(migrateProject(restamped)!.state.pages[newer.id]).toEqual(newer);
  });

  it('gives each document exactly the steps it has not had', async () => {
    const stored = migrateProject((await readProject(copyFixture())).stored, [{ id: 'a', description: 'a', migrate: () => undefined }, { id: 'b', description: 'b', migrate: () => undefined }])!.state;
    const [restored, current] = Object.values(stored.pages);
    restored.schemaVersion = 1;
    const seen: Array<[string, boolean, boolean]> = [];
    const step = (id: string): Migration => ({ id, description: id, migrate: (_p, due) => void seen.push([id, due(_p.pages[restored.id]), due(_p.pages[current.id])]) });
    const { state } = migrateProject(stored, [step('a'), step('b'), step('c')])!;
    expect(seen).toEqual([
      ['a', true, false],
      ['b', true, false],
      ['c', true, true]
    ]);
    expect(state.pages[restored.id].schemaVersion).toBe(4);
    expect(state.pages[current.id].schemaVersion).toBe(4);
  });

  it('advances a document a step replaced rather than changed', async () => {
    const stored = (await readProject(copyFixture())).stored;
    const replace: Migration = {
      id: 'replace',
      description: 'replace',
      migrate: (p, due) => {
        for (const [id, page] of Object.entries(p.pages)) if (due(page)) p.pages[id] = { ...page, title: `${page.title}!` };
      }
    };
    const seen: boolean[] = [];
    const after: Migration = { id: 'after', description: 'after', migrate: (p, due) => void seen.push(...Object.values(p.pages).map((x) => due(x))) };
    const { state } = migrateProject(stored, [replace, after])!;
    expect(seen.every(Boolean)).toBe(true);
    expect(Object.values(state.pages).every((x) => x.schemaVersion === 3)).toBe(true);
  });

  it('is a no-op on a current project and on documents already migrated', async () => {
    const state = await v1();
    expect(migrateProject(state)).toBeNull();
    const again = structuredClone(state);
    Object.values(again.pages)[0].schemaVersion = 1;
    const fixed = migrateProject(again)!.state;
    expect(fixed).toEqual(state);
  });

  it('keeps unmodified theme definitions recognised as theme data', async () => {
    const { state } = migrateProject((await readProject(copyFixture())).stored)!;
    for (const def of Object.values(state.components)) {
      if (def.owner !== 'theme') continue;
      expect(matchesLock(state.themeLock.components[def.id].hash, def)).toBe(true);
      // Vouched for by the old 32-bit hash only, so re-stamped in it: never upgraded to a SHA-256 entry.
      expect(state.themeLock.components[def.id].hash).not.toMatch(/^sha256:/);
    }
  });

  it('does not bless a definition edited by hand', async () => {
    const stored = (await readProject(copyFixture())).stored;
    stored.components['foundation.hero.split'].description = 'Edited by hand';
    const { state } = migrateProject(stored)!;
    expect(state.themeLock.components['foundation.hero.split'].hash).not.toBe(definitionHash(state.components['foundation.hero.split']));
    expect(matchesLock(state.themeLock.components['foundation.hero.split'].hash, state.components['foundation.hero.split'])).toBe(false);
  });
});

describe('opening an older project', () => {
  it('migrates it on disk and keeps a copy of the old documents', async () => {
    const dir = copyFixture();
    const before = read(dir, MANIFEST);
    const s = await session(dir);
    expect(s.state.manifest.schemaVersion).toBe(SCHEMA_VERSION);
    for (const p of canonicalJson(dir)) expect(read(dir, p).schemaVersion, p).toBe(SCHEMA_VERSION);
    expect(existsSync(join(dir, '.siteorigin/journal.json'))).toBe(false);
    const backups = readdirSync(join(dir, '.siteorigin/recovery')).filter((d) => d.startsWith('migration-v1-to-'));
    expect(backups).toHaveLength(1);
    expect(read(join(dir, '.siteorigin/recovery', backups[0]), MANIFEST)).toEqual(before);
    expect(s.recoveryNotes.join(' ')).toContain(backups[0]);
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Works' }] }, { label: 'x' })).ok).toBe(true);
  });

  it('does nothing the second time', async () => {
    const dir = copyFixture();
    await (await session(dir)).close();
    const stored = canonicalJson(dir).map((p) => readFileSync(join(dir, p), 'utf8'));
    const again = await session(dir);
    expect(again.recoveryNotes).toEqual([]);
    expect(canonicalJson(dir).map((p) => readFileSync(join(dir, p), 'utf8'))).toEqual(stored);
    expect(readdirSync(join(dir, '.siteorigin/recovery')).filter((d) => d.startsWith('migration-'))).toHaveLength(1);
  });

  it('finishes after a crash in the middle of publishing', async () => {
    const dir = copyFixture();
    const realRename = fsp.rename.bind(fsp);
    let pageWrites = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).startsWith(join(dir, 'siteorigin/pages/')) && ++pageWrites === 2) throw new Error('simulated crash');
      return realRename(from, to);
    });
    await expect(ProjectSession.open(dir, 'crash')).rejects.toThrow('simulated crash');
    vi.restoreAllMocks();
    // A mixed set of files on disk, with the journal that describes the whole update.
    expect(existsSync(join(dir, '.siteorigin/journal.json'))).toBe(true);
    expect(new Set(canonicalJson(dir).map((p) => read(dir, p).schemaVersion)).size).toBe(2);
    const s = await session(dir);
    expect(s.recoveryNotes.join(' ')).toContain('Finished an interrupted save');
    for (const p of canonicalJson(dir)) expect(read(dir, p).schemaVersion, p).toBe(SCHEMA_VERSION);
    expect(existsSync(join(dir, '.siteorigin/journal.json'))).toBe(false);
  });

  it('leaves the old project intact after a crash while copying it', async () => {
    const dir = copyFixture();
    const before = canonicalJson(dir).map((p) => readFileSync(join(dir, p), 'utf8'));
    const realRename = fsp.rename.bind(fsp);
    let copies = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('/recovery/migration-') && ++copies === 3) throw new Error('simulated crash');
      return realRename(from, to);
    });
    await expect(ProjectSession.open(dir, 'crash')).rejects.toThrow('simulated crash');
    vi.restoreAllMocks();
    expect(canonicalJson(dir).map((p) => readFileSync(join(dir, p), 'utf8'))).toEqual(before);
    const s = await session(dir);
    expect(s.state.manifest.schemaVersion).toBe(SCHEMA_VERSION);
    for (const p of canonicalJson(dir)) expect(read(dir, p).schemaVersion, p).toBe(SCHEMA_VERSION);
  });

  it('leaves the project untouched when the update cannot be generated', async () => {
    const dir = copyFixture();
    const pages = readdirSync(join(dir, 'siteorigin/pages'));
    const bad = read(dir, `siteorigin/pages/${pages[0]}`);
    bad.rootIds.push('missing-node');
    write(dir, `siteorigin/pages/${pages[0]}`, bad);
    const before = canonicalJson(dir).map((p) => readFileSync(join(dir, p), 'utf8'));
    await expect(ProjectSession.open(dir, 'fatal')).rejects.toThrow(/inconsistent/);
    expect(canonicalJson(dir).map((p) => readFileSync(join(dir, p), 'utf8'))).toEqual(before);
  });

  /** A v1 undo step that would put a deleted v1 component back: its "after" state (absent) still matches. */
  function oldUndoStep(dir: string) {
    const body = readFileSync(join(dir, 'siteorigin/components/foundation.logos.strip/component.json'), 'utf8');
    const blob = sha(body);
    mkdirSync(join(dir, '.siteorigin/history/blobs'), { recursive: true });
    writeFileSync(join(dir, `.siteorigin/history/blobs/${blob}.json`), body);
    const path = 'siteorigin/components/old.removed/component.json';
    write(dir, '.siteorigin/history/history.json', { entries: [{ id: 'h1', label: 'Remove component', source: 'user', time: new Date().toISOString(), revision: 1, docs: { [path]: { before: blob, after: null } } }], cursor: 1 });
    return path;
  }

  it('never restores old-format documents through undo', async () => {
    const dir = copyFixture();
    const path = oldUndoStep(dir);
    const s = await session(dir);
    expect(s.historyInfo().canUndo).toBe(false);
    expect((await s.undo()).ok).toBe(false);
    expect(existsSync(join(dir, path))).toBe(false);
  });

  it('drops old undo steps when a crash interrupted the update', async () => {
    const dir = copyFixture();
    const path = oldUndoStep(dir);
    const realRename = fsp.rename.bind(fsp);
    let pageWrites = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).startsWith(join(dir, 'siteorigin/pages/')) && ++pageWrites === 2) throw new Error('simulated crash');
      return realRename(from, to);
    });
    await expect(ProjectSession.open(dir, 'crash')).rejects.toThrow('simulated crash');
    vi.restoreAllMocks();
    const s = await session(dir);
    expect(s.historyInfo().canUndo).toBe(false);
    expect((await s.undo()).ok).toBe(false);
    expect(existsSync(join(dir, path))).toBe(false);
  });

  it('keeps hand-formatted files out of conflict when a crash interrupts the update', async () => {
    const dir = copyFixture();
    const pages = readdirSync(join(dir, 'siteorigin/pages'));
    for (const f of pages) writeFileSync(join(dir, 'siteorigin/pages', f), JSON.stringify(read(dir, `siteorigin/pages/${f}`)));
    const realRename = fsp.rename.bind(fsp);
    let pageWrites = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).startsWith(join(dir, 'siteorigin/pages/')) && ++pageWrites === 2) throw new Error('simulated crash');
      return realRename(from, to);
    });
    await expect(ProjectSession.open(dir, 'crash')).rejects.toThrow('simulated crash');
    vi.restoreAllMocks();
    const s = await session(dir);
    expect(s.conflicts).toEqual([]);
    for (const p of canonicalJson(dir)) expect(read(dir, p).schemaVersion, p).toBe(SCHEMA_VERSION);
  });

  it('does not replay an unfinished save from a newer version', async () => {
    const dir = copyFixture();
    mkdirSync(join(dir, '.siteorigin'), { recursive: true });
    write(dir, '.siteorigin/journal.json', { schemaVersion: SCHEMA_VERSION + 1, writes: [], deletes: [] });
    const before = tree(dir);
    const err = await ProjectSession.open(dir, 'old-app').catch((e) => e);
    expect(err.readOnly).toBe(true);
    expect(tree(dir)).toEqual(before);
  });

  it('forgets a hold that was settled while the app was closed', async () => {
    const dir = copyFixture();
    const body = readFileSync(join(dir, SITE), 'utf8');
    const blob = sha(body);
    mkdirSync(join(dir, '.siteorigin/history/blobs'), { recursive: true });
    writeFileSync(join(dir, `.siteorigin/history/blobs/${blob}.json`), body);
    write(dir, '.siteorigin/conflicts.json', { conflicts: [{ path: SITE, reason: 'Changed outside.', builder: blob }] });
    const s = await session(dir);
    expect(s.conflicts).toEqual([]);
    expect(existsSync(join(dir, '.siteorigin/conflicts.json'))).toBe(false);
  });

  it('does not overwrite a file edited after it was validated', async () => {
    const dir = copyFixture();
    const realRename = fsp.rename.bind(fsp);
    let edited = false;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      // The first file of the recovery copy: validation is done and nothing has been published.
      if (!edited && String(to).includes('/recovery/migration-')) {
        edited = true;
        write(dir, SITE, { ...read(dir, SITE), description: 'Edited at the last moment' });
      }
      return realRename(from, to);
    });
    await expect(ProjectSession.open(dir, 'race')).rejects.toThrow(/changed outside/);
    vi.restoreAllMocks();
    expect(read(dir, SITE).description).toBe('Edited at the last moment');
  });

  it('stays blocked after a failed update even if a reload finds nothing left to migrate', async () => {
    const dir = copyFixture();
    const s = await session(dir);
    for (const f of ['siteorigin/tokens.json', 'siteorigin/assets.json']) write(dir, f, { ...read(dir, f), schemaVersion: 1 });
    const realRename = fsp.rename.bind(fsp);
    let writes = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if ((String(to) === join(dir, 'siteorigin/tokens.json') || String(to) === join(dir, 'siteorigin/assets.json')) && ++writes === 2) throw new Error('simulated failure');
      return realRename(from, to);
    });
    await expect(s.reloadFromDisk()).rejects.toThrow('simulated failure');
    vi.restoreAllMocks();
    const assets = read(dir, 'siteorigin/assets.json');
    write(dir, 'siteorigin/assets.json', { ...assets, schemaVersion: SCHEMA_VERSION });
    await s.reloadFromDisk();
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Blocked' }] }, { label: 'x' })).error?.message).toMatch(/Close and reopen/);
    expect(existsSync(join(dir, '.siteorigin/journal.json'))).toBe(true);
  });

  it('blocks edits after a failed update instead of replacing its journal', async () => {
    const dir = copyFixture();
    const s = await session(dir);
    for (const f of ['siteorigin/tokens.json', 'siteorigin/assets.json']) write(dir, f, { ...read(dir, f), schemaVersion: 1 });
    const realRename = fsp.rename.bind(fsp);
    let writes = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if ((String(to) === join(dir, 'siteorigin/tokens.json') || String(to) === join(dir, 'siteorigin/assets.json')) && ++writes === 2) throw new Error('simulated failure');
      return realRename(from, to);
    });
    await expect(s.reloadFromDisk()).rejects.toThrow('simulated failure');
    vi.restoreAllMocks();
    const journal = readFileSync(join(dir, '.siteorigin/journal.json'), 'utf8');
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Blocked' }] }, { label: 'x' })).error?.message).toMatch(/Close and reopen/);
    expect(readFileSync(join(dir, '.siteorigin/journal.json'), 'utf8')).toBe(journal);
  });

  it('waits for a file in conflict, then finishes', async () => {
    const dir = copyFixture();
    const site = read(dir, SITE);
    // A held conflict: Builder's version and a different external file.
    const held = toJson({ ...site, description: 'Builder version' });
    const blob = sha(held);
    writeFileSync(join(dir, SITE), toJson({ ...site, description: 'External version' }));
    mkdirSync(join(dir, '.siteorigin/history/blobs'), { recursive: true });
    writeFileSync(join(dir, `.siteorigin/history/blobs/${blob}.json`), held);
    write(dir, '.siteorigin/conflicts.json', { conflicts: [{ path: SITE, reason: 'Changed outside.', builder: blob }] });
    const s = await session(dir);
    expect(s.conflicts.map((c) => c.path)).toEqual([SITE]);
    // The update is in memory only while the choice is open: the external file is not rewritten.
    expect(s.state.site.schemaVersion).toBe(SCHEMA_VERSION);
    expect(read(dir, SITE).description).toBe('External version');
    expect(read(dir, MANIFEST).schemaVersion).toBe(1);
    expect((await s.resolveConflict(SITE, 'restore')).ok).toBe(true);
    for (const p of canonicalJson(dir)) expect(read(dir, p).schemaVersion, p).toBe(SCHEMA_VERSION);
    expect(read(dir, SITE).description).toBe('Builder version');
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'After' }] }, { label: 'x' })).ok).toBe(true);
  });

  it('stores a single file put back from an older copy, keeping undo', async () => {
    const dir = copyFixture();
    const s = await session(dir);
    await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'rename' });
    const tokens = read(dir, 'siteorigin/tokens.json');
    write(dir, 'siteorigin/tokens.json', { ...tokens, schemaVersion: 1 });
    expect((await s.reloadFromDisk()).ok).toBe(true);
    expect(read(dir, 'siteorigin/tokens.json').schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.historyInfo().canUndo).toBe(true);
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Again' }] }, { label: 'x' })).ok).toBe(true);
  });
});

describe('read-only opens never write', () => {
  it('shows an older project in the current format without touching it', async () => {
    const dir = copyFixture();
    const before = tree(dir);
    const ro = await ProjectSession.openReadOnly(dir, { reason: 'Locked elsewhere.', canUnlock: true });
    open.push(ro);
    expect(ro.state.manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(await ro.reloadFromDisk()).toEqual({ ok: true });
    expect((await ro.apply({ operations: [{ type: 'site.update', name: 'x' }] }, { label: 'x' })).ok).toBe(false);
    expect(tree(dir)).toEqual(before);
  });

  it('a document newer than the app makes the whole project read-only', async () => {
    const dir = copyFixture();
    const pages = readdirSync(join(dir, 'siteorigin/pages'));
    const p = read(dir, `siteorigin/pages/${pages[0]}`);
    write(dir, `siteorigin/pages/${pages[0]}`, { ...p, schemaVersion: SCHEMA_VERSION + 1 });
    const before = tree(dir);
    const err = await ProjectSession.open(dir, 'me').catch((e) => e);
    expect(err.readOnly).toBe(true);
    expect(tree(dir)).toEqual(before);
    const ro = await ProjectSession.openReadOnly(dir, { reason: err.message, canUnlock: false });
    open.push(ro);
    expect(tree(dir)).toEqual(before);
  });
});

describe('theme component updates', () => {
  /** A project whose installed hero predates a fix in the theme. */
  async function outdated(edit?: (s: ProjectState) => void) {
    const state = structuredClone((await readProject(copyFixture())).state);
    const hero = state.components['foundation.hero.centered'];
    hero.description = 'An older description';
    hero.tree!.nodes.root.styles = { base: { background: { token: 'color.surface-alt' } } };
    state.themeLock.components[hero.id].hash = definitionHash(hero);
    edit?.(state);
    return state;
  }
  const current = (id: string) => getTheme('foundation').components.find((c) => c.id === id)!;

  it('offers and applies a newer definition, leaving content and overrides alone', async () => {
    const state = await outdated();
    const hero = state.components['foundation.hero.centered'];
    expect(themeUpdates(state).available.map((u) => u.id)).toContain(hero.id);
    const pages = JSON.stringify(state.pages);
    const { state: next, results } = applyOperations(state, [{ type: 'theme.refresh' }]);
    expect(results[0].updated).toContain(hero.id);
    expect(definitionHash(next.components[hero.id])).toBe(definitionHash(current(hero.id)));
    expect(next.themeLock.components[hero.id].hash).toBe(definitionHash(current(hero.id)));
    expect(JSON.stringify(next.pages)).toBe(pages);
    expect(themeUpdates(next).available).toEqual([]);
    expect(generateProject(next).size).toBeGreaterThan(0);
  });

  it('never overwrites a project-owned or forked component', async () => {
    const state = await outdated();
    const fork = Object.values(state.components).find((d) => d.owner === 'project' && d.kind === 'managed')!;
    const before = JSON.stringify(fork);
    const { state: next } = applyOperations(state, [{ type: 'theme.refresh' }]);
    expect(JSON.stringify(next.components[fork.id])).toBe(before);
    expect(themeUpdates(state).available.map((u) => u.id)).not.toContain(fork.id);
  });

  it('keeps a definition changed by hand and says why', async () => {
    const state = await outdated((s) => {
      s.components['foundation.hero.centered'].name = 'Hand edited';
    });
    const u = themeUpdates(state);
    expect(u.available.map((x) => x.id)).not.toContain('foundation.hero.centered');
    expect(u.kept.find((k) => k.id === 'foundation.hero.centered')?.reason).toMatch(/changed outside/);
    const { state: next } = applyOperations(state, [{ type: 'theme.refresh' }]);
    expect(next.components['foundation.hero.centered'].name).toBe('Hand edited');
    expect(() => applyOperations(state, [{ type: 'theme.refresh', definitionIds: ['foundation.hero.centered'] }])).toThrow(/cannot be updated/);
  });

  it('never replaces a project definition that shares a theme ID', async () => {
    const state = await outdated((s) => {
      s.components['foundation.hero.centered'].owner = 'project';
    });
    const before = JSON.stringify(state.components['foundation.hero.centered']);
    expect(themeUpdates(state).available.map((u) => u.id)).not.toContain('foundation.hero.centered');
    const { state: next } = applyOperations(state, [{ type: 'theme.refresh' }]);
    expect(JSON.stringify(next.components['foundation.hero.centered'])).toBe(before);
  });

  it('keeps a definition a project component builds on through another component', async () => {
    const state = await outdated((s) => {
      const host = Object.values(s.components).find((d) => d.owner === 'project' && d.kind === 'managed')!;
      const middle = s.components['foundation.faq.list'];
      host.tree!.nodes.nested = { id: 'nested', kind: 'instance', definitionId: middle.id, props: {} };
      (host.tree!.nodes[host.tree!.rootIds[0]] as { children: string[] }).children.push('nested');
      middle.tree!.nodes.nested = { id: 'nested', kind: 'instance', definitionId: 'foundation.hero.centered', props: {} };
      (middle.tree!.nodes[middle.tree!.rootIds[0]] as { children: string[] }).children.push('nested');
      s.themeLock.components[middle.id].hash = definitionHash(middle);
    });
    expect(themeUpdates(state).kept.find((k) => k.id === 'foundation.hero.centered')?.reason).toMatch(/built on/);
  });

  it('keeps a definition a code component imports', async () => {
    const state = await outdated((s) => {
      const code = Object.values(s.components).find((d) => d.kind === 'code' && d.owner === 'project')!;
      code.dependencies = ['foundation.hero.centered'];
    });
    expect(themeUpdates(state).kept.find((k) => k.id === 'foundation.hero.centered')?.reason).toMatch(/built on/);
  });

  it('keeps a definition whose new version rejects content a placement holds', async () => {
    const state = await outdated((s) => {
      const page = s.pages[s.site.homePageId];
      const hero = Object.values(page.nodes).find((n) => n.kind === 'instance' && n.definitionId === 'foundation.hero.centered') as InstanceNode;
      hero.props.heading = 'x'.repeat(2001);
    });
    expect(themeUpdates(state).kept.find((k) => k.id === 'foundation.hero.centered')?.reason).toMatch(/longer than/);
  });

  it('keeps a definition whose new version would lose a styled part', async () => {
    const state = await outdated((s) => {
      const hero = s.components['foundation.hero.centered'];
      hero.parts.retired = { nodeId: 'root', label: 'Retired part' };
      s.themeLock.components[hero.id].hash = definitionHash(hero);
      const page = s.pages[s.site.homePageId];
      const inst = Object.values(page.nodes).find((n) => n.kind === 'instance' && n.definitionId === hero.id) as InstanceNode;
      inst.overrides = { retired: { base: { opacity: 0.5 } } };
    });
    expect(themeUpdates(state).kept.find((k) => k.id === 'foundation.hero.centered')?.reason).toMatch(/retired/);
  });

  it('holds an update over malformed content instead of failing', async () => {
    const state = await outdated((s) => {
      const faq = s.components['foundation.faq.list'];
      faq.description = 'An older description';
      s.themeLock.components[faq.id].hash = definitionHash(faq);
      const placed = Object.values(s.pages).flatMap((p) => Object.values(p.nodes)).find((n) => n.kind === 'instance' && n.definitionId === faq.id) as InstanceNode;
      // A hand-edited list whose items are not objects.
      placed.props.items = ['legacy'];
    });
    expect(themeUpdates(state).kept.find((k) => k.id === 'foundation.faq.list')?.reason).toMatch(/could not be checked/);
  });

  it('treats a definition whose old 32-bit hash collides with its lock as edited', async () => {
    // The hero as installed from an older theme release, and a hand edit that the old 32-bit FNV-1a lock hash
    // cannot tell apart from it.
    const [installedName, editedName] = fnvCollidingValues(structuredClone((await readProject(copyFixture())).state.components['foundation.hero.centered']), 'description');
    expect(installedName).not.toBe(editedName);
    const state = await outdated((s) => {
      const hero = s.components['foundation.hero.centered'];
      hero.description = installedName;
      s.themeLock.components[hero.id].hash = definitionHash(hero);
      hero.description = editedName;
    });
    const hero = state.components['foundation.hero.centered'];
    expect(legacyHash({ ...hero, description: installedName })).toBe(legacyHash(hero));
    expect(definitionHash({ ...hero, description: installedName })).not.toBe(definitionHash(hero));
    expect(themeUpdates(state).available.map((u) => u.id)).not.toContain(hero.id);
    expect(themeUpdates(state).kept.find((k) => k.id === hero.id)?.reason).toMatch(/changed outside the theme/);
    const { state: next } = applyOperations(state, [{ type: 'theme.refresh' }]);
    expect(next.components[hero.id].description).toBe(editedName);
  });

  it('still reads a lock entry written with the old 32-bit hash, and replaces it with SHA-256 on refresh', async () => {
    const state = await outdated((s) => {
      const hero = s.components['foundation.hero.centered'];
      s.themeLock.components[hero.id].hash = legacyHash(hero);
    });
    const hero = state.components['foundation.hero.centered'];
    expect(themeUpdates(state).available.map((u) => u.id)).toContain(hero.id);
    const { state: next } = applyOperations(state, [{ type: 'theme.refresh' }]);
    expect(next.themeLock.components[hero.id].hash).toBe(definitionHash(current(hero.id)));
    expect(next.themeLock.components[hero.id].hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('treats a definition that no longer matches its old 32-bit lock entry as edited', async () => {
    const state = await outdated((s) => {
      const hero = s.components['foundation.hero.centered'];
      s.themeLock.components[hero.id].hash = legacyHash(hero);
      hero.description = 'Edited by hand';
    });
    const hero = state.components['foundation.hero.centered'];
    expect(themeUpdates(state).available.map((u) => u.id)).not.toContain(hero.id);
    expect(themeUpdates(state).kept.find((k) => k.id === hero.id)?.reason).toMatch(/changed outside the theme/);
  });

  /** The fixture's gallery placement and the page it is on. */
  const placedGallery = (s: ProjectState) => {
    const page = Object.values(s.pages).find((p) => Object.values(p.nodes).some((n) => n.kind === 'instance' && n.definitionId === 'foundation.media.gallery'))!;
    return { page, node: Object.values(page.nodes).find((n) => n.kind === 'instance' && n.definitionId === 'foundation.media.gallery') as InstanceNode };
  };

  it('updates a gallery saved before its photos could open, and its photos keep doing nothing (#75)', async () => {
    const state = await outdated();
    const id = 'foundation.media.gallery';
    expect(JSON.stringify(state.components[id])).not.toContain('"action"');
    expect(themeUpdates(state).available.map((u) => u.id)).toContain(id);
    const { page, node } = placedGallery(state);
    // The AI is not shown a worked example its installed gallery would refuse.
    expect(examplesFor(state, 'media.gallery')).toEqual([]);
    const pages = JSON.stringify(state.pages);
    const { state: next } = applyOperations(state, [{ type: 'theme.refresh' }]);
    expect(examplesFor(next, 'media.gallery').map((e) => e.id)).toEqual(['gallery-work']);
    expect(definitionHash(next.components[id])).toBe(definitionHash(current(id)));
    expect(JSON.stringify(next.pages)).toBe(pages);
    expect(validateState(next).filter((d) => d.severity === 'error')).toEqual([]);
    // Each saved photo takes the new field's default: nothing happens when it is clicked.
    const source = generateProject(next).get(`src/routes${page.route === '/' ? '' : page.route.replace(/\/$/, '')}/+page.svelte`)!;
    const count = (node.props.images as Array<Record<string, unknown>>).length;
    expect(count).toBeGreaterThan(0);
    expect((node.props.images as Array<Record<string, unknown>>).every((it) => !('action' in it))).toBe(true);
    expect(source.match(/"action":"none"/g)).toHaveLength(count);
    expect(source).not.toMatch(/"action":"(image|link)"/);
  });

  /** A project component that links as a whole around whatever its placement puts in its slot. */
  const linkedPanel = () => ({
    ...managed({
      componentId: 'test.panel',
      name: 'Linked panel',
      description: '',
      category: 'content',
      tags: [],
      icon: 'sparkles',
      properties: {},
      parts: {},
      slots: { content: { label: 'Content' } },
      build: (b) => b.el('panel', 'div', { link: { type: 'url', target: 'https://example.com/panel' } }, [b.slot('content-slot', 'content')])
    }),
    owner: 'project' as const
  });

  it('still offers a gallery update beside a card that already cannot link (#75)', async () => {
    const state = await outdated((s) => {
      const panel = linkedPanel();
      s.components[panel.id] = panel;
      const page = s.pages[s.site.homePageId];
      const holder = makeInstance(panel, {});
      const button = { id: 'n_button75', kind: 'link' as const, link: { type: 'url' as const, target: 'https://example.com/more' }, label: 'More', appearance: 'primary' };
      page.nodes[button.id] = button;
      holder.slots = { content: [button.id] };
      page.nodes[holder.id] = holder;
      page.rootIds.push(holder.id);
    });
    expect(validateState(state).filter((d) => d.code === 'CARD_LINK_INTERACTIVE')).toHaveLength(1);
    expect(themeUpdates(state).available.map((u) => u.id)).toContain('foundation.media.gallery');
  });

  it('holds a gallery update that would add a second problem to a placement whose card already cannot link (#75)', async () => {
    const state = await outdated((s) => {
      const panel = {
        ...managed({
          componentId: 'test.panel2',
          name: 'Two-slot panel',
          description: '',
          category: 'content',
          tags: [],
          icon: 'sparkles',
          properties: {},
          parts: {},
          slots: { content: { label: 'Content' }, extra: { label: 'Extra' } },
          build: (b) => b.el('panel', 'div', { link: { type: 'url', target: 'https://example.com/panel' } }, [b.slot('content-slot', 'content'), b.slot('extra-slot', 'extra')])
        }),
        owner: 'project' as const
      };
      s.components[panel.id] = panel;
      const { page, node } = placedGallery(s);
      const holder = makeInstance(panel, {});
      const button = { id: 'n_button75b', kind: 'link' as const, link: { type: 'url' as const, target: 'https://example.com/more' }, label: 'More', appearance: 'primary' };
      page.nodes[button.id] = button;
      holder.slots = { content: [node.id], extra: [button.id] };
      page.nodes[holder.id] = holder;
      page.rootIds = page.rootIds.map((id) => (id === node.id ? holder.id : id));
    });
    // The button already stops the card linking; the newer gallery would be a second thing inside it.
    expect(validateState(state).filter((d) => d.code === 'CARD_LINK_INTERACTIVE')).toHaveLength(1);
    expect(themeUpdates(state).kept.find((k) => k.id === 'foundation.media.gallery')?.reason).toMatch(/from inside a card that links there/);
  });

  it('holds a gallery update that would put a link inside a card that links today (#75)', async () => {
    const state = await outdated((s) => {
      const panel = {
        ...managed({
          componentId: 'test.panel',
          name: 'Linked panel',
          description: '',
          category: 'content',
          tags: [],
          icon: 'sparkles',
          properties: {},
          parts: {},
          slots: { content: { label: 'Content' } },
          build: (b) => b.el('panel', 'div', { link: { type: 'url', target: 'https://example.com/panel' } }, [b.slot('content-slot', 'content')])
        }),
        owner: 'project' as const
      };
      s.components[panel.id] = panel;
      const { page, node } = placedGallery(s);
      const holder = makeInstance(panel, {});
      holder.slots = { content: [node.id] };
      page.nodes[holder.id] = holder;
      page.rootIds = page.rootIds.map((id) => (id === node.id ? holder.id : id));
    });
    // The panel links today: the older gallery has nothing inside it that opens.
    expect(validateState(state).filter((d) => d.code === 'CARD_LINK_INTERACTIVE')).toEqual([]);
    expect(themeUpdates(state).available.map((u) => u.id)).not.toContain('foundation.media.gallery');
    expect(themeUpdates(state).kept.find((k) => k.id === 'foundation.media.gallery')?.reason).toMatch(/from inside a card that links there/);
    expect(() => applyOperations(state, [{ type: 'theme.refresh', definitionIds: ['foundation.media.gallery'] }])).toThrow(/cannot be updated/);
  });

  it('hashes the whole definition', async () => {
    const hero = structuredClone((await readProject(copyFixture())).state.components['foundation.hero.centered']);
    const base = definitionHash(hero);
    expect(definitionHash({ ...hero, name: `${hero.name} ` })).not.toBe(base);
    expect(definitionHash({ ...hero, description: `${hero.description ?? ''} ` })).not.toBe(base);
    expect(definitionHash({ ...hero, tree: { ...hero.tree!, rootIds: [...hero.tree!.rootIds].reverse().concat('x') } })).not.toBe(base);
    expect(definitionHash(structuredClone(hero))).toBe(base);
  });

  it('hashes definitions with SHA-256 exactly as node:crypto does', () => {
    for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'é漢字🙂'.repeat(100), 'x'.repeat(100_000)]) expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('moves the locked pack version only when the whole set is current', async () => {
    const state = await outdated((s) => {
      s.themeLock.theme.version = '0.0.1';
    });
    const { state: next } = applyOperations(state, [{ type: 'theme.refresh' }]);
    expect(next.themeLock.theme.version).toBe(getTheme('foundation').version);
    const partial = await outdated((s) => {
      s.themeLock.theme.version = '0.0.1';
      s.components['foundation.faq.list'].name = 'Hand edited';
    });
    const { state: held } = applyOperations(partial, [{ type: 'theme.refresh' }]);
    expect(held.themeLock.theme.version).toBe('0.0.1');
  });

  it('leaves every project-owned document byte-identical', async () => {
    const state = await outdated((s) => {
      const fork = Object.values(s.components).find((d) => d.owner === 'project' && d.kind === 'managed')!;
      delete fork.dependencies;
      fork.tree!.nodes.nested = { id: 'nested', kind: 'instance', definitionId: 'foundation.faq.list', props: {} };
      (fork.tree!.nodes[fork.tree!.rootIds[0]] as { children: string[] }).children.push('nested');
    });
    const fork = Object.values(state.components).find((d) => d.owner === 'project' && d.kind === 'managed')!;
    const before = JSON.stringify(fork);
    const { state: next } = applyOperations(state, [{ type: 'theme.refresh' }]);
    expect(JSON.stringify(next.components[fork.id])).toBe(before);
  });

  it('keeps a definition a project component is built on', async () => {
    const state = await outdated((s) => {
      const host = Object.values(s.components).find((d) => d.owner === 'project' && d.kind === 'managed')!;
      host.tree!.nodes.nested = { id: 'nested', kind: 'instance', definitionId: 'foundation.hero.centered', props: {} };
      (host.tree!.nodes[host.tree!.rootIds[0]] as { children: string[] }).children.push('nested');
    });
    const u = themeUpdates(state);
    expect(u.available.map((x) => x.id)).not.toContain('foundation.hero.centered');
    expect(u.kept.find((k) => k.id === 'foundation.hero.centered')?.reason).toMatch(/built on/);
  });

  it('keeps a definition whose new version drops something placements use', async () => {
    const state = await outdated((s) => {
      const hero = s.components['foundation.hero.centered'];
      hero.parts.retired = { nodeId: 'root', label: 'Retired part' };
      s.themeLock.components[hero.id].hash = definitionHash(hero);
    });
    const kept = themeUpdates(state).kept.find((k) => k.id === 'foundation.hero.centered');
    expect(kept?.reason).toMatch(/part "retired"/);
  });

  it('is undoable through a session, and reaches the disk through the journal', async () => {
    const dir = copyFixture();
    const s = await session(dir);
    const rel = 'siteorigin/components/foundation.hero.centered/component.json';
    const hero = read(dir, rel);
    hero.description = 'An older description';
    const lock = read(dir, 'siteorigin/theme-lock.json');
    lock.components[hero.id].hash = definitionHash(hero);
    write(dir, rel, hero);
    write(dir, 'siteorigin/theme-lock.json', lock);
    expect((await s.reloadFromDisk()).ok).toBe(true);
    expect(themeUpdates(s.state).available.map((u) => u.id)).toContain(hero.id);
    expect((await s.apply({ operations: [{ type: 'theme.refresh' }] }, { label: 'Update theme components' })).ok).toBe(true);
    expect(read(dir, rel).description).toBe(current(hero.id).description);
    expect((await s.undo()).ok).toBe(true);
    expect(read(dir, rel).description).toBe('An older description');
  });
});

/** The theme lock's original hash: FNV-1a 32-bit over the definition's JSON. */
function fnv(h: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const legacyHash = (def: object) => fnv(0x811c9dc5, JSON.stringify(def)).toString(36);

/**
 * Two values for a string field that give the definition the same 32-bit FNV-1a hash. The hash runs left to right,
 * so values that leave it in the same state collide whatever follows; a birthday search finds a pair in about 2^16
 * tries.
 */
function fnvCollidingValues(def: object, field: string): [string, string] {
  const marker = 'FNV_COLLISION_MARKER';
  const [prefix] = JSON.stringify({ ...def, [field]: marker }).split(marker);
  const start = fnv(0x811c9dc5, prefix);
  const seen = new Map<number, string>();
  for (let i = 0; i < 2_000_000; i++) {
    const value = `Hero ${i.toString(36)}`;
    const h = fnv(start, value);
    const other = seen.get(h);
    if (other !== undefined) return [other, value];
    seen.set(h, value);
  }
  throw new Error('No collision found.');
}
