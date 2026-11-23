import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import type { AssetRecord } from '@shared/types';
import { LOCK_STALE_MS, ProjectLockedError, ProjectSession } from '../../src/main/project/session';
import { sha, toJson } from '../../src/main/project/fsutil';

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-recovery-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Persist', false));
  return { dir, s };
}
async function reopen(dir: string, id = 'test', opts: { force?: boolean } = {}) {
  const s = await ProjectSession.open(dir, id, opts);
  open.push(s);
  return s;
}
const read = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
const write = (dir: string, rel: string, v: unknown) => writeFileSync(join(dir, rel), toJson(v));
const SITE = 'siteorigin/site.json';

/** An AI run that renamed the site and added a page, with site.json then edited outside the app. */
async function runWithExternalEdit(addPage = false) {
  const { dir, s } = await make();
  await s.beginRun('run_a');
  const ops = [{ type: 'site.update' as const, name: 'AI name' }, ...(addPage ? [{ type: 'page.create' as const, title: 'AI page' }] : [])];
  const r = await s.apply({ operations: ops }, { label: 'AI', source: 'ai', runId: 'run_a', history: false });
  expect(r.ok).toBe(true);
  const site = read(dir, SITE);
  site.description = 'Edited in another editor';
  write(dir, SITE, site);
  return { dir, s };
}

describe('canonical conflicts (spec 18.5)', () => {
  it('reverts what it safely can, holds the changed file and blocks edits until the user chooses', async () => {
    const { dir, s } = await runWithExternalEdit(true);
    const aiPage = Object.values(s.state.pages).find((p) => p.title === 'AI page')!;
    const r = await s.abortRun();
    expect(r).toMatchObject({ restored: false, conflict: SITE });
    // The untouched-by-anyone-else page file is rolled back; site.json keeps its external version on disk.
    expect(existsSync(join(dir, `siteorigin/pages/${aiPage.id}.json`))).toBe(false);
    expect(read(dir, SITE).description).toBe('Edited in another editor');
    expect(s.state.site.name).toBe('Persist');
    expect(s.conflicts).toEqual([expect.objectContaining({ path: SITE, kind: 'canonical' })]);
    // Shown once: conflicts are not repeated as diagnostics.
    expect(s.diagnostics().some((d) => d.code === 'CONFLICT')).toBe(false);
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'x' }] }, { label: 'x' })).error?.code).toBe('CONFLICT');
    expect((await s.undo()).error?.code).toBe('CONFLICT');
    // Keeping the external version would leave the AI page in the page order with no page file.
    const keep = await s.resolveConflict(SITE, 'keep');
    expect(keep.ok).toBe(false);
    expect(keep.message).toMatch(/inconsistent/);
    const restore = await s.resolveConflict(SITE, 'restore');
    expect(restore.ok).toBe(true);
    expect(read(dir, SITE).description).not.toBe('Edited in another editor');
    expect(readdirSync(join(dir, '.siteorigin/recovery')).some((f) => f.endsWith('.external'))).toBe(true);
    expect(s.conflicts).toEqual([]);
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'After' }] }, { label: 'x' })).ok).toBe(true);
  });

  it('keeps the external version when the project stays valid, as an undoable change', async () => {
    const { dir, s } = await runWithExternalEdit();
    await s.abortRun();
    const keep = await s.resolveConflict(SITE, 'keep');
    expect(keep).toEqual({ ok: true });
    expect(s.state.site.description).toBe('Edited in another editor');
    // The AI's rename was in the same file: keeping the external file keeps what that file says.
    expect(s.state.site.name).toBe(read(dir, SITE).name);
    expect(s.conflicts).toEqual([]);
    expect(s.historyInfo().undoLabel).toBe('Keep external change');
    // Undo puts Builder's (pre-run) version back on disk; redo brings the external version again.
    expect((await s.undo()).ok).toBe(true);
    expect(read(dir, SITE).description).not.toBe('Edited in another editor');
    expect((await s.redo()).ok).toBe(true);
    expect(read(dir, SITE).description).toBe('Edited in another editor');
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'After' }] }, { label: 'x' })).ok).toBe(true);
  });

  it('accepts unrelated external edits while a conflict is held, without settling it', async () => {
    const { dir, s } = await runWithExternalEdit();
    await s.abortRun();
    const tokens = read(dir, 'siteorigin/tokens.json');
    tokens.overrides['color.brand'] = '#123456';
    write(dir, 'siteorigin/tokens.json', tokens);
    expect((await s.reloadFromDisk()).ok).toBe(true);
    expect(s.state.tokens.overrides['color.brand']).toBe('#123456');
    // site.json is still read as Builder's version, and still waits for a decision.
    expect(s.state.site.description).not.toBe('Edited in another editor');
    expect(s.conflicts.map((c) => c.path)).toEqual([SITE]);
  });

  it('opens a project whose interrupted AI run conflicts, instead of deadlocking it', async () => {
    const { dir } = await runWithExternalEdit();
    // Crash: the run never completed or aborted.
    const again = await reopen(dir);
    expect(again.state.site.name).toBe('Persist');
    expect(again.conflicts.map((c) => c.path)).toEqual([SITE]);
    // A reload that finds nothing new must not leave the project stuck: the conflict stays resolvable.
    expect((await again.reloadFromDisk()).ok).toBe(true);
    expect((await again.resolveConflict(SITE, 'keep')).ok).toBe(true);
    expect((await again.apply({ operations: [{ type: 'site.update', name: 'Unstuck' }] }, { label: 'x' })).ok).toBe(true);
  });

  it('remembers a held conflict across a restart, and drops it once the file is put back', async () => {
    const { dir, s } = await runWithExternalEdit();
    const before = (await s.abortRun()).conflict;
    expect(before).toBe(SITE);
    await s.close();
    const again = await reopen(dir);
    expect(again.conflicts.map((c) => c.path)).toEqual([SITE]);
    expect(again.state.site.description).not.toBe('Edited in another editor');
    // Put the file back by hand: the conflict settles on the next reload.
    const site = read(dir, SITE);
    site.description = again.state.site.description;
    site.name = again.state.site.name;
    write(dir, SITE, site);
    await again.reloadFromDisk();
    expect(again.conflicts).toEqual([]);
  });

  it('treats a file still holding an earlier batch of the run as the run’s own work (marker crash window)', async () => {
    const { dir, s } = await make();
    await s.beginRun('run_b');
    await s.apply({ operations: [{ type: 'site.update', name: 'Batch one' }] }, { label: 'AI', source: 'ai', runId: 'run_b', history: false });
    const batchOne = readFileSync(join(dir, SITE), 'utf8');
    await s.apply({ operations: [{ type: 'site.update', name: 'Batch two' }] }, { label: 'AI', source: 'ai', runId: 'run_b', history: false });
    // Crash after the marker named batch two but before batch two reached the file.
    writeFileSync(join(dir, SITE), batchOne);
    await s.releaseLock();
    const again = await reopen(dir);
    expect(again.conflicts).toEqual([]);
    expect(again.state.site.name).toBe('Persist');
    expect(read(dir, SITE).name).toBe('Persist');
  });

  it('keeps a partly replayed save consistent instead of refusing to open', async () => {
    const { dir, s } = await make();
    // A batch that adds a page: site.json (page order) and the new page file.
    const r = await s.apply({ operations: [{ type: 'page.create', title: 'Journal page' }] }, { label: 'x' });
    const pageId = Object.values(s.state.pages).find((p) => p.title === 'Journal page')!.id;
    const pagePath = `siteorigin/pages/${pageId}.json`;
    const siteAfter = readFileSync(join(dir, SITE), 'utf8');
    const pageAfter = readFileSync(join(dir, pagePath), 'utf8');
    expect(r.ok).toBe(true);
    await s.undo();
    await s.close();
    const siteBefore = readFileSync(join(dir, SITE), 'utf8');
    // Crash: the journal says both files should change; neither did, and site.json was then edited elsewhere.
    const external = { ...JSON.parse(siteBefore), description: 'Edited elsewhere' };
    write(dir, SITE, external);
    writeFileSync(join(dir, '.siteorigin/history/blobs', `${sha(siteAfter)}.json`), siteAfter);
    writeFileSync(join(dir, '.siteorigin/history/blobs', `${sha(pageAfter)}.json`), pageAfter);
    writeFileSync(
      join(dir, '.siteorigin/journal.json'),
      JSON.stringify({ writes: [{ path: SITE, blob: sha(siteAfter), before: sha(siteBefore) }, { path: pagePath, blob: sha(pageAfter), before: null }], deletes: [] })
    );
    const again = await reopen(dir);
    // The documents in use are the whole batch; the external site.json waits for a decision.
    expect(again.state.site.pageOrder).toContain(pageId);
    expect(again.state.pages[pageId]).toBeDefined();
    expect(again.conflicts.map((c) => c.path)).toEqual([SITE]);
    expect(read(dir, SITE).description).toBe('Edited elsewhere');
    // The held version is on record before the journal is gone, so another crash cannot lose it.
    expect(existsSync(join(dir, '.siteorigin/conflicts.json'))).toBe(true);
    expect(existsSync(join(dir, '.siteorigin/journal.json'))).toBe(false);
  });

  it('recovers a run whose document was deleted outside the app, instead of refusing to open', async () => {
    const { dir, s } = await make();
    await s.beginRun('run_c');
    await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }] }, { label: 'AI', source: 'ai', runId: 'run_c', history: false });
    rmSync(join(dir, SITE));
    await s.releaseLock();
    const again = await reopen(dir);
    expect(again.state.site.name).toBe('Persist');
    expect(again.conflicts.map((c) => c.path)).toEqual([SITE]);
    expect((await again.resolveConflict(SITE, 'restore')).ok).toBe(true);
    expect(read(dir, SITE).name).toBe('Persist');
  });
});

describe('generated files edited outside the app', () => {
  it('drops the editor variant so the preview shows the external version', async () => {
    const { dir, s } = await make();
    const rel = 'src/routes/about/+page.svelte';
    expect(existsSync(join(dir, '.siteorigin/cache/dev', rel))).toBe(true);
    writeFileSync(join(dir, rel), '<h1>Hand edited</h1>\n');
    const aboutId = s.state.site.pageOrder[1];
    await s.apply({ operations: [{ type: 'page.update', pageId: aboutId, title: 'About us' }] }, { label: 'Rename' });
    expect(s.conflicts).toEqual([expect.objectContaining({ path: rel, kind: 'generated' })]);
    expect(existsSync(join(dir, '.siteorigin/cache/dev', rel))).toBe(false);
    // The preview compares the project file with this list to tell an outside edit from Builder's own file.
    const hashes = () => JSON.parse(readFileSync(join(dir, '.siteorigin/cache/dev/.clean-hashes.json'), 'utf8'));
    expect(hashes()[rel]).not.toBe(sha(readFileSync(join(dir, rel), 'utf8')));
    expect((await s.resolveConflict(rel, 'restore')).ok).toBe(true);
    expect(hashes()[rel]).toBe(sha(readFileSync(join(dir, rel), 'utf8')));
    expect(existsSync(join(dir, '.siteorigin/cache/dev', rel))).toBe(true);
    expect(s.conflicts).toEqual([]);
  });
});

describe('project lock', () => {
  const lockFile = (dir: string) => join(dir, '.siteorigin/lock.json');
  const age = (dir: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    utimesSync(lockFile(dir), t, t);
  };

  it('honours a fresh lock from another computer, and offers an unlock', async () => {
    const { dir, s } = await make();
    await s.close();
    writeFileSync(lockFile(dir), JSON.stringify({ pid: 1, host: 'studio-imac.local', instance: 'other', started: new Date().toISOString() }));
    const err = await ProjectSession.open(dir, 'me').catch((e) => e);
    expect(err).toBeInstanceOf(ProjectLockedError);
    expect(err.owner.host).toBe('studio-imac.local');
    const forced = await reopen(dir, 'me', { force: true });
    expect(JSON.parse(readFileSync(lockFile(dir), 'utf8')).instance).toBe('me');
    expect(forced.readOnly).toBeNull();
  });

  it('expires a lock that has not been refreshed, whatever host or PID it names', async () => {
    const { dir, s } = await make();
    await s.close();
    writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, host: 'old-hostname.local', instance: 'gone' }));
    age(dir, LOCK_STALE_MS + 1000);
    await reopen(dir, 'me');
    // Same host, a live PID (pid reuse), but no heartbeat for minutes: also stale.
    const { dir: dir2, s: s2 } = await make();
    await s2.close();
    writeFileSync(lockFile(dir2), JSON.stringify({ pid: process.pid, host: hostname(), instance: 'gone' }));
    age(dir2, LOCK_STALE_MS + 1000);
    await reopen(dir2, 'me');
  });

  it('treats a lock still being written as live, and an old unreadable one as stale', async () => {
    const { dir, s } = await make();
    await s.close();
    writeFileSync(lockFile(dir), '');
    expect(await ProjectSession.open(dir, 'me').catch((e) => e)).toBeInstanceOf(ProjectLockedError);
    age(dir, 60_000);
    await reopen(dir, 'me');
  });

  it('becomes read-only when another app takes the lock over', async () => {
    const { dir, s } = await make();
    await s.close();
    const a = await reopen(dir, 'a');
    await reopen(dir, 'b', { force: true });
    await a.refreshLock();
    expect(a.readOnly?.canUnlock).toBe(true);
    expect((await a.apply({ operations: [{ type: 'site.update', name: 'x' }] }, { label: 'x' })).ok).toBe(false);
  });
});

describe('read-only inspection (spec 16.6)', () => {
  it('opens a newer-format project without writing anything', async () => {
    const { dir, s } = await make();
    await s.close();
    rmSync(join(dir, '.siteorigin'), { recursive: true, force: true });
    const manifest = read(dir, 'siteorigin.project.json');
    manifest.schemaVersion = 999;
    write(dir, 'siteorigin.project.json', manifest);
    const err = await ProjectSession.open(dir, 'me').catch((e) => e);
    expect(err.readOnly).toBe(true);
    expect(existsSync(join(dir, '.siteorigin'))).toBe(false);
    const ro = await ProjectSession.openReadOnly(dir, { reason: err.message, canUnlock: false });
    open.push(ro);
    expect(ro.state.site.name).toBe('Persist');
    expect((await ro.apply({ operations: [{ type: 'site.update', name: 'x' }] }, { label: 'x' })).ok).toBe(false);
    expect(await ro.beginRun('r')).toMatch(/newer version/);
    expect(await ro.reloadFromDisk()).toEqual({ ok: true });
    expect(existsSync(join(dir, '.siteorigin'))).toBe(false);
  });
});

describe('history retention and garbage collection (spec 18.4)', () => {
  const blobs = (dir: string) => readdirSync(join(dir, '.siteorigin/history/blobs')).filter((f) => f.endsWith('.json'));

  it('deletes blobs that nothing references', async () => {
    const { dir, s } = await make();
    await s.apply({ operations: [{ type: 'site.update', name: 'One' }] }, { label: 'x' });
    const orphan = '{"orphan":true}\n';
    writeFileSync(join(dir, '.siteorigin/history/blobs', `${sha(orphan)}.json`), orphan);
    await s.collectGarbage();
    expect(blobs(dir)).not.toContain(`${sha(orphan)}.json`);
    // Undo still works: its blobs are kept.
    expect((await s.undo()).ok).toBe(true);
  });

  it('prunes the oldest groups past the byte cap', async () => {
    const { dir, s } = await make();
    for (let i = 0; i < 6; i++) await s.apply({ operations: [{ type: 'site.update', name: `Name ${i}` }] }, { label: `Edit ${i}` });
    expect(s.historyInfo().entries.length).toBe(6);
    const siteBytes = readFileSync(join(dir, SITE)).length;
    // Room for about two groups (each holds a before and an after copy of site.json).
    s.historyByteLimit = siteBytes * 3.5;
    await s.collectGarbage();
    const entries = s.historyInfo().entries;
    expect(entries.length).toBeLessThan(6);
    // Pruned to what fits, not to a single group.
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[entries.length - 1].label).toBe('Edit 5');
    expect(blobs(dir).length).toBeLessThanOrEqual(entries.length + 1);
    expect((await s.undo()).ok).toBe(true);
  });

  it('trims redo from its far end when everything is undone, so redo still works', async () => {
    const { s } = await make();
    for (let i = 0; i < 3; i++) await s.apply({ operations: [{ type: 'site.update', name: `Name ${i}` }] }, { label: `Edit ${i}` });
    for (let i = 0; i < 3; i++) expect((await s.undo()).ok).toBe(true);
    s.historyByteLimit = 1;
    await s.collectGarbage();
    expect(s.historyInfo().entries.map((e) => e.label)).toEqual(['Edit 0']);
    expect((await s.redo()).ok).toBe(true);
    expect(s.state.site.name).toBe('Name 0');
  });

  it('removes a deleted image and its sizes only once no retained history can bring it back', async () => {
    const { dir, s } = await make();
    mkdirSync(join(dir, 'static/assets'), { recursive: true });
    const files = ['photo-1a2b3c4d.jpg', 'photo-1a2b3c4d-480w.jpg', 'photo-1a2b3c4d-960w.jpg'];
    for (const f of files) writeFileSync(join(dir, 'static/assets', f), 'jpeg');
    writeFileSync(join(dir, 'static/assets', 'hand-placed.png'), 'png');
    const asset: AssetRecord = {
      id: 'a_photo', name: 'Photo', file: 'static/assets/photo-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 4, hash: '1a2b3c4d', kind: 'image', createdAt: new Date().toISOString(),
      variants: [{ width: 480, file: 'static/assets/photo-1a2b3c4d-480w.jpg' }, { width: 960, file: 'static/assets/photo-1a2b3c4d-960w.jpg' }]
    };
    expect((await s.apply({ operations: [{ type: 'asset.add', asset }] }, { label: 'Import image' })).ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'asset.remove', assetId: 'a_photo' }] }, { label: 'Remove image' })).ok).toBe(true);
    const old = new Date(Date.now() - 60 * 60_000);
    for (const f of [...files, 'hand-placed.png']) utimesSync(join(dir, 'static/assets', f), old, old);
    // Undo can still restore the image, so its files stay.
    await s.collectGarbage();
    for (const f of files) expect(existsSync(join(dir, 'static/assets', f))).toBe(true);
    // Pruning down to the latest group still keeps "Remove image" while it is the group undo would restore.
    await s.apply({ operations: [{ type: 'site.update', name: 'Later' }] }, { label: 'Later edit' });
    // Once history no longer holds a version with the image, the files go; files the importer never made stay.
    s.historyByteLimit = 1;
    await s.collectGarbage();
    expect(s.historyInfo().entries.length).toBe(1);
    for (const f of files) expect(existsSync(join(dir, 'static/assets', f))).toBe(false);
    expect(existsSync(join(dir, 'static/assets/hand-placed.png'))).toBe(true);
  });
});
