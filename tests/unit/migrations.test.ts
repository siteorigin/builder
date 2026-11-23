import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { InstanceNode, ProjectState } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { definitionHash, migrateProject, MIGRATIONS, type Migration } from '@shared/migrations';
import { applyOperations } from '@engine/apply';
import { themeUpdates } from '@engine/theme-updates';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { getTheme } from '@catalogue/index';
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
    const [a, b] = Object.values(stored.pages);
    delete (a as Partial<typeof a>).seo;
    delete (a as Partial<typeof a>).shell;
    b.shell = 'none';
    delete (stored.tokens as Partial<typeof stored.tokens>).custom;
    stored.tokens.overrides = { 'color.brand': '#123456' };
    const { state } = migrateProject(stored)!;
    expect(state.pages[a.id].seo).toEqual({});
    expect(state.pages[a.id].shell).toBe('default');
    expect(state.pages[b.id].shell).toBe('none');
    expect(state.tokens.custom).toEqual([]);
    expect(state.tokens.overrides).toEqual({ 'color.brand': '#123456' });
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
    for (const def of Object.values(state.components)) if (def.owner === 'theme') expect(state.themeLock.components[def.id].hash).toBe(definitionHash(def));
  });

  it('does not bless a definition edited by hand', async () => {
    const stored = (await readProject(copyFixture())).stored;
    stored.components['foundation.hero.split'].description = 'Edited by hand';
    const { state } = migrateProject(stored)!;
    expect(state.themeLock.components['foundation.hero.split'].hash).not.toBe(definitionHash(state.components['foundation.hero.split']));
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
    expect(themeUpdates(s.state).available.map((u) => u.id)).toEqual([hero.id]);
    expect((await s.apply({ operations: [{ type: 'theme.refresh' }] }, { label: 'Update theme components' })).ok).toBe(true);
    expect(read(dir, rel).description).toBe(current(hero.id).description);
    expect((await s.undo()).ok).toBe(true);
    expect(read(dir, rel).description).toBe('An older description');
  });
});
