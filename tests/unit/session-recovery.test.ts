import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import type { AssetRecord } from '@shared/types';
import { LOCK_STALE_MS, ProjectLockedError, ProjectSession } from '../../src/main/project/session';
import { sha, toJson } from '../../src/main/project/fsutil';
import { instancesOf } from '@engine/tree';
import { denyAccess } from './deny-access';

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-recovery-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Persist', false));
  return { dir, s };
}
async function reopen(dir: string, id = 'test', opts: { force?: boolean | string } = {}) {
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

  it('treats an external save of exactly what an AI change would write as a conflict, so cancelling cannot erase it', async () => {
    const { dir, s } = await make();
    await s.beginRun('run_e');
    const site = read(dir, SITE);
    site.name = 'Same name';
    write(dir, SITE, site);
    const r = await s.apply({ operations: [{ type: 'site.update', name: 'Same name' }] }, { label: 'AI', source: 'ai', runId: 'run_e', history: false });
    expect(r.error?.code).toBe('CONFLICT');
    await s.abortRun();
    expect(read(dir, SITE).name).toBe('Same name');
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
    // Put the file back by hand: the conflict settles on the next reload. The AI's rename also reached the shared
    // header and footer, which site.json holds, so they go back too.
    const site = read(dir, SITE);
    expect(JSON.stringify(site.shell)).toContain('AI name');
    site.description = again.state.site.description;
    site.name = again.state.site.name;
    site.shell = again.state.site.shell;
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

  /** Move this process's monotonic clock on, as if it had been watching the lock for `ms`. */
  const later = (ms: number) => {
    const t = performance.now() + ms;
    vi.spyOn(performance, 'now').mockReturnValue(t);
  };

  it('expires a lock that has stopped changing, whatever host or PID it names', async () => {
    const { dir, s } = await make();
    await s.close();
    writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, host: 'old-hostname.local', instance: 'gone' }));
    age(dir, LOCK_STALE_MS + 1000);
    // Another computer's lock time says nothing on this clock: it is stale once it has been seen unchanged for long enough.
    expect(await ProjectSession.open(dir, 'me').catch((e) => e)).toBeInstanceOf(ProjectLockedError);
    later(LOCK_STALE_MS + 1000);
    await reopen(dir, 'me');
    // Same host, a live PID (pid reuse), but no heartbeat: also stale once it has stopped changing.
    const { dir: dir2, s: s2 } = await make();
    await s2.close();
    writeFileSync(lockFile(dir2), JSON.stringify({ pid: process.pid, host: hostname(), instance: 'gone' }));
    expect(await ProjectSession.open(dir2, 'me').catch((e) => e)).toBeInstanceOf(ProjectLockedError);
    later(2 * LOCK_STALE_MS + 2000);
    await reopen(dir2, 'me');
    // Same host, a process that is gone: stale at once.
    const { dir: dir3, s: s3 } = await make();
    await s3.close();
    writeFileSync(lockFile(dir3), JSON.stringify({ pid: 2 ** 22 + 4321, host: hostname(), instance: 'gone' }));
    await reopen(dir3, 'me');
  });

  it('treats a lock still being written as live, and one unreadable for a while as stale', async () => {
    const { dir, s } = await make();
    await s.close();
    writeFileSync(lockFile(dir), '');
    expect(await ProjectSession.open(dir, 'me').catch((e) => e)).toBeInstanceOf(ProjectLockedError);
    later(11_000);
    await reopen(dir, 'me');
  });

  it('never compares another computer’s lock time with its own clock', async () => {
    const { dir, s } = await make();
    await s.close();
    // The owner's clock is hours behind this one: by its own reckoning it refreshed the lock just now.
    writeFileSync(lockFile(dir), JSON.stringify({ pid: 1, host: 'studio-imac.local', instance: 'other', token: 'abc123', started: new Date().toISOString() }));
    age(dir, 3 * 3600_000);
    expect(await ProjectSession.open(dir, 'me').catch((e) => e)).toBeInstanceOf(ProjectLockedError);
    // Its heartbeat keeps changing the time (still hours behind): it stays live however long this app waits.
    later(LOCK_STALE_MS + 1000);
    age(dir, 3 * 3600_000 - 30_000);
    expect(await ProjectSession.open(dir, 'me').catch((e) => e)).toBeInstanceOf(ProjectLockedError);
    // This app's clock is hours ahead of a lock refreshed a moment ago: still live.
    const { dir: dir2, s: s2 } = await make();
    await s2.close();
    writeFileSync(lockFile(dir2), JSON.stringify({ pid: 1, host: 'studio-imac.local', instance: 'other', token: 'def456' }));
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 3 * 3600_000);
    expect(await ProjectSession.open(dir2, 'me').catch((e) => e)).toBeInstanceOf(ProjectLockedError);
    // Once it stops changing for the stale period on this app's own clock, the owner is gone.
    later(2 * LOCK_STALE_MS + 2000);
    await reopen(dir2, 'me');
  });

  it('leaves exactly one writer when several apps take over a stale lock at once', async () => {
    const { dir, s } = await make();
    await s.close();
    // Left by a process on this computer that no longer exists.
    writeFileSync(lockFile(dir), JSON.stringify({ pid: 2 ** 22 + 4321, host: hostname(), instance: 'crashed', token: 'aaaa' }));
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => ProjectSession.open(dir, id).catch((e) => e)));
    const winners = results.filter((r): r is ProjectSession => r instanceof ProjectSession);
    open.push(...winners);
    expect(winners).toHaveLength(1);
    for (const r of results) if (!(r instanceof ProjectSession)) expect(r).toBeInstanceOf(ProjectLockedError);
    const [winner] = winners;
    expect(JSON.parse(readFileSync(lockFile(dir), 'utf8')).instance).toBe((winner as unknown as { lockOwner: string }).lockOwner);
    expect((await winner.apply({ operations: [{ type: 'site.update', name: 'Only writer' }] }, { label: 'x' })).ok).toBe(true);
    expect(readdirSync(join(dir, '.siteorigin')).filter((f) => f.startsWith('lock.json.'))).toEqual([]);
  });

  it('leaves one successor when two apps unlock the same owner at once', async () => {
    const { dir, s } = await make();
    await s.close();
    const a = await reopen(dir, 'a');
    const shown = await ProjectSession.open(dir, 'b').catch((e) => e);
    expect(shown).toBeInstanceOf(ProjectLockedError);
    const token = (shown as ProjectLockedError).owner.token!;
    expect(token).toBeTruthy();
    // Both confirmed "Unlock" for the owner they were shown.
    const results = await Promise.all(['b', 'c'].map((id) => ProjectSession.open(dir, id, { force: token }).catch((e) => e)));
    const winners = results.filter((r): r is ProjectSession => r instanceof ProjectSession);
    open.push(...winners);
    expect(winners).toHaveLength(1);
    const loser = results.find((r) => !(r instanceof ProjectSession)) as ProjectLockedError;
    expect(loser).toBeInstanceOf(ProjectLockedError);
    // The loser is shown the new owner, not told it took over.
    expect(loser.owner.token).toBe(JSON.parse(readFileSync(lockFile(dir), 'utf8')).token);
    await a.refreshLock();
    expect(a.readOnly?.canUnlock).toBe(true);
    expect((await a.apply({ operations: [{ type: 'site.update', name: 'a' }] }, { label: 'x' })).ok).toBe(false);
    expect((await winners[0].apply({ operations: [{ type: 'site.update', name: 'winner' }] }, { label: 'x' })).ok).toBe(true);
  });

  it('never brings back a lock it no longer holds, and offers to unlock instead', async () => {
    const { dir, s } = await make();
    await s.close();
    const a = await reopen(dir, 'a');
    const token = JSON.parse(readFileSync(lockFile(dir), 'utf8')).token;
    // Another app takes over, saves and closes before this one looks again.
    const b = await ProjectSession.open(dir, 'b', { force: token });
    expect((await b.apply({ operations: [{ type: 'site.update', name: 'From b' }] }, { label: 'x' })).ok).toBe(true);
    await b.close();
    expect(existsSync(lockFile(dir))).toBe(false);
    expect((await a.apply({ operations: [{ type: 'site.update', name: 'From a' }] }, { label: 'x' })).ok).toBe(false);
    expect(existsSync(lockFile(dir))).toBe(false);
    expect(a.readOnly?.canUnlock).toBe(true);
    expect(read(dir, SITE).name).toBe('From b');
    // Unlocking with what it was shown creates a lock; it can never replace one that appeared since.
    await reopen(dir, 'a2', { force: a.readOnly!.lockToken });
    expect(await ProjectSession.open(dir, 'a3', { force: a.readOnly!.lockToken }).catch((e) => e)).toBeInstanceOf(ProjectLockedError);
  });

  it('passes over a claim left by a process that is gone', async () => {
    const { dir, s } = await make();
    await s.close();
    writeFileSync(lockFile(dir), JSON.stringify({ pid: 2 ** 22 + 4321, host: hostname(), instance: 'crashed', token: 'cccc' }));
    // It crashed part way through taking over, or through a save.
    writeFileSync(`${lockFile(dir)}.cccc.claim.1`, JSON.stringify({ pid: 2 ** 22 + 4321, host: hostname(), holder: 'cccc' }));
    const results = await Promise.all(['a', 'b', 'c'].map((id) => ProjectSession.open(dir, id).catch((e) => e)));
    const winners = results.filter((r): r is ProjectSession => r instanceof ProjectSession);
    open.push(...winners);
    expect(winners).toHaveLength(1);
    expect(readdirSync(join(dir, '.siteorigin')).filter((f) => f.startsWith('lock.json.'))).toEqual([]);
  });

  it('moves its lock time only from the heartbeat, which a long read never holds up', async () => {
    const { dir, s } = await make();
    await s.close();
    const a = await reopen(dir, 'a');
    const t0 = statSync(lockFile(dir)).mtimeMs;
    expect(await a.stillOwner()).toBe(true);
    expect(statSync(lockFile(dir)).mtimeMs).toBe(t0);
    // An export reads the project under exclusive(); the heartbeat still runs meanwhile.
    let finish!: () => void;
    const reading = a.exclusive(() => new Promise<void>((r) => (finish = r)));
    expect(await a.refreshLock()).toBe('mine');
    expect(statSync(lockFile(dir)).mtimeMs).toBeGreaterThan(t0);
    finish();
    await reading;
  });

  it('keeps moving its lock time forward when its clock steps back', async () => {
    const { dir, s } = await make();
    await s.close();
    const a = await reopen(dir, 'a');
    await a.refreshLock();
    const first = statSync(lockFile(dir)).mtimeMs;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 120_000);
    await a.refreshLock();
    expect(statSync(lockFile(dir)).mtimeMs).toBeGreaterThan(first);
  });

  it('lets no takeover land part way through a save', async () => {
    const { dir, s } = await make();
    await s.close();
    const a = await reopen(dir, 'a');
    const token = JSON.parse(readFileSync(lockFile(dir), 'utf8')).token;
    const events: string[] = [];
    let resume!: () => void;
    const gate = new Promise<void>((r) => (resume = r));
    let reached!: () => void;
    const atWrite = new Promise<void>((r) => (reached = r));
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(join(SITE))) {
        reached();
        await gate;
        await rename(from, to);
        events.push('a wrote');
        return;
      }
      return rename(from, to);
    });
    const saving = a.apply({ operations: [{ type: 'site.update', name: 'From a' }] }, { label: 'x' });
    await atWrite;
    // Another app is told the owner is gone and takes over while the save is paused before its document is written.
    const taking = ProjectSession.open(dir, 'b', { force: token }).then((b) => {
      events.push('b took over');
      open.push(b);
      return b;
    });
    await new Promise((r) => setTimeout(r, 100));
    events.push('a resumed');
    resume();
    expect((await saving).ok).toBe(true);
    const b = await taking;
    expect(events).toEqual(['a resumed', 'a wrote', 'b took over']);
    expect(b.state.site.name).toBe('From a');
    expect((await a.apply({ operations: [{ type: 'site.update', name: 'a again' }] }, { label: 'x' })).ok).toBe(false);
    expect(a.readOnly).not.toBeNull();
  });

  it('refuses a write when its lock cannot be read back, without giving up the project', async () => {
    const { dir, s } = await make();
    await s.close();
    const a = await reopen(dir, 'a');
    const body = readFileSync(lockFile(dir), 'utf8');
    writeFileSync(lockFile(dir), '');
    const r = await a.apply({ operations: [{ type: 'site.update', name: 'x' }] }, { label: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('BUSY');
    expect(a.readOnly).toBeNull();
    writeFileSync(lockFile(dir), body);
    expect((await a.apply({ operations: [{ type: 'site.update', name: 'x' }] }, { label: 'x' })).ok).toBe(true);
  });

  it('never writes again once closed', async () => {
    const { dir, s } = await make();
    await s.close();
    const a = await reopen(dir, 'a');
    await a.close();
    const b = await reopen(dir, 'b');
    expect((await a.apply({ operations: [{ type: 'site.update', name: 'late' }] }, { label: 'x' })).ok).toBe(false);
    expect((await b.apply({ operations: [{ type: 'site.update', name: 'b' }] }, { label: 'x' })).ok).toBe(true);
    expect(read(dir, SITE).name).toBe('b');
  });

  it('unlocks only the generation the user was shown, even from the same app', async () => {
    const { dir, s } = await make();
    await s.close();
    await reopen(dir, 'a');
    const shown = ((await ProjectSession.open(dir, 'me').catch((e) => e)) as ProjectLockedError).owner.token!;
    await reopen(dir, 'me', { force: shown });
    // A second confirmation of the same Unlock, from this same app, must not displace the successor.
    const again = await ProjectSession.open(dir, 'me', { force: shown }).catch((e) => e);
    expect(again).toBeInstanceOf(ProjectLockedError);
    expect((again as ProjectLockedError).owner.token).toBe(JSON.parse(readFileSync(lockFile(dir), 'utf8')).token);
    // A lock without a token (an older app) is identified by its content.
    const { dir: dir2, s: s2 } = await make();
    await s2.close();
    writeFileSync(lockFile(dir2), JSON.stringify({ pid: 1, host: 'studio-imac.local', instance: 'old' }));
    const old = ((await ProjectSession.open(dir2, 'me').catch((e) => e)) as ProjectLockedError).owner.token!;
    writeFileSync(lockFile(dir2), JSON.stringify({ pid: 2, host: 'studio-imac.local', instance: 'newer' }));
    expect(await ProjectSession.open(dir2, 'me', { force: old }).catch((e) => e)).toBeInstanceOf(ProjectLockedError);
    const newer = ((await ProjectSession.open(dir2, 'me').catch((e) => e)) as ProjectLockedError).owner.token!;
    await reopen(dir2, 'me', { force: newer });
  });

  it('treats a process it may not signal as alive', async () => {
    const { dir, s } = await make();
    await s.close();
    writeFileSync(lockFile(dir), JSON.stringify({ pid: 4242, host: hostname(), instance: 'other-user', token: 'b0b0' }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    });
    expect(await ProjectSession.open(dir, 'me').catch((e) => e)).toBeInstanceOf(ProjectLockedError);
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

describe('external edits against problems the project already has (#205)', () => {
  /** A page node that shows a component property, which only a component's design can. */
  const bind = (page: { rootIds: string[]; nodes: Record<string, unknown> }, id: string) => {
    page.nodes[id] = { id, kind: 'text', tag: 'p', text: { $prop: 'heading' } };
    page.rootIds.push(id);
  };

  it('accepts an unrelated external edit, and refuses one that brings in the same mistake elsewhere', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-recovery-'));
    dirs.push(dir);
    const start = createStarterState('business', 'Persist', false);
    bind(start.pages[start.site.homePageId] as never, 'n_old');
    const s = await ProjectSession.create(dir, start);
    open.push(s);
    expect(s.diagnostics().filter((d) => d.code === 'BINDING_SCOPE').map((d) => d.nodeId)).toEqual(['n_old']);
    // Unrelated: the problem stays as it was, so the change is kept.
    const site = read(dir, SITE);
    site.description = 'Edited in another editor';
    write(dir, SITE, site);
    expect(await s.reloadFromDisk()).toEqual({ ok: true });
    expect(s.state.site.description).toBe('Edited in another editor');
    // The same mistake on another element is new, so the change is refused.
    const pagePath = `siteorigin/pages/${s.state.site.homePageId}.json`;
    const page = read(dir, pagePath);
    bind(page, 'n_new');
    write(dir, pagePath, page);
    const r = await s.reloadFromDisk();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/component property, list item field or UI state/);
    expect(s.state.pages[s.state.site.homePageId].nodes.n_new).toBeUndefined();
  });

  it('refuses an external edit that repeats an older problem on another element of the same page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-recovery-'));
    dirs.push(dir);
    const start = createStarterState('business', 'Persist', false);
    const home = start.pages[start.site.homePageId];
    const missing = (id: string) => ({ id, kind: 'text', tag: 'p', text: 'x', styles: { base: { color: { token: 'color.gone' } } } });
    home.nodes.n_a = missing('n_a') as never;
    home.rootIds.push('n_a');
    const s = await ProjectSession.create(dir, start);
    open.push(s);
    const pagePath = `siteorigin/pages/${s.state.site.homePageId}.json`;
    const page = read(dir, pagePath);
    page.nodes.n_b = missing('n_b');
    page.rootIds.push('n_b');
    write(dir, pagePath, page);
    const r = await s.reloadFromDisk();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/color\.gone/);
  });
});

describe('comparing conflict versions and saved copies (#82)', () => {
  const HOME = 'src/routes/+page.svelte';

  /** Home's generated page, edited outside the app, then a visual edit that finds it so. */
  async function generatedConflict() {
    const { dir, s } = await make();
    writeFileSync(join(dir, HOME), '<h1>Hero edited by hand</h1>\n');
    const about = s.state.site.pageOrder[1];
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: about, title: 'About us' }] }, { label: 'Rename' })).ok).toBe(true);
    expect(s.conflicts).toEqual([expect.objectContaining({ path: HOME, kind: 'generated' })]);
    return { dir, s };
  }

  it('shows both versions of a generated file, keeps the hand-edited one under Saved copies when the generated one is used, and still lists it after reopening', async () => {
    const { dir, s } = await generatedConflict();
    const compared = await s.compareConflict(HOME);
    expect(compared.ok).toBe(true);
    expect(compared.disk).toEqual({ state: 'text', text: '<h1>Hero edited by hand</h1>\n' });
    expect(compared.builder).toMatchObject({ state: 'text', text: expect.stringContaining('Generated by SiteOrigin Builder') });

    expect(await s.resolveConflict(HOME, 'restore')).toEqual({ ok: true });
    expect(readFileSync(join(dir, HOME), 'utf8')).toContain('Generated by SiteOrigin Builder');
    expect(s.conflicts).toEqual([]);
    expect(s.savedCopies).toEqual([expect.objectContaining({ path: HOME, kind: 'generated', side: 'external' })]);
    const [copy] = s.savedCopies;
    expect(copy.file).toMatch(/^\.siteorigin\/recovery\/[^/]+\.external$/);
    expect(readFileSync(join(dir, copy.file), 'utf8')).toBe('<h1>Hero edited by hand</h1>\n');
    expect(await s.readSavedCopy(copy.id)).toEqual({ ok: true, content: { state: 'text', text: '<h1>Hero edited by hand</h1>\n' } });
    // Nothing left to compare once it is settled.
    expect((await s.compareConflict(HOME)).ok).toBe(false);

    await s.close();
    const again = await reopen(dir);
    expect(again.savedCopies).toEqual([copy]);
    expect(await again.readSavedCopy(copy.id)).toEqual({ ok: true, content: { state: 'text', text: '<h1>Hero edited by hand</h1>\n' } });

    // Taken off the list for good; the file itself stays.
    expect(await again.dismissSavedCopy(copy.id)).toEqual({ ok: true });
    expect(again.savedCopies).toEqual([]);
    expect(existsSync(join(dir, copy.file))).toBe(true);
    await again.close();
    open.splice(open.indexOf(again), 1);
    expect((await reopen(dir)).savedCopies).toEqual([]);
  });

  it('lists the copy a canonical conflict keeps, whichever version the author chooses', async () => {
    const restored = await runWithExternalEdit();
    await restored.s.abortRun();
    const external = readFileSync(join(restored.dir, SITE), 'utf8');
    const compared = await restored.s.compareConflict(SITE);
    expect(compared.disk).toEqual({ state: 'text', text: external });
    expect(compared.builder).toMatchObject({ state: 'text' });
    expect(compared.builder).not.toEqual(compared.disk);
    expect(await restored.s.resolveConflict(SITE, 'restore')).toEqual({ ok: true });
    // An AI run's conflict also keeps the version the run attempted (#739).
    expect(restored.s.savedCopies).toEqual([expect.objectContaining({ path: SITE, kind: 'canonical', side: 'external' }), expect.objectContaining({ path: SITE, kind: 'canonical', side: 'attempted' })]);
    expect(readFileSync(join(restored.dir, restored.s.savedCopies[0].file), 'utf8')).toBe(external);

    const kept = await runWithExternalEdit();
    await kept.s.abortRun();
    const builder = (await kept.s.compareConflict(SITE)).builder;
    expect(await kept.s.resolveConflict(SITE, 'keep')).toEqual({ ok: true });
    expect(kept.s.savedCopies).toEqual([expect.objectContaining({ path: SITE, kind: 'canonical', side: 'builder' }), expect.objectContaining({ path: SITE, kind: 'canonical', side: 'attempted' })]);
    expect(await kept.s.readSavedCopy(kept.s.savedCopies[0].id)).toEqual({ ok: true, content: builder });
  });

  it('never puts back SiteOrigin Builder’s version over a file it cannot read, and keeps the conflict', async () => {
    const { dir, s } = await runWithExternalEdit();
    await s.abortRun();
    rmSync(join(dir, SITE));
    mkdirSync(join(dir, SITE));
    const r = await s.resolveConflict(SITE, 'restore');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/could not be read/);
    expect(statSync(join(dir, SITE)).isDirectory()).toBe(true);
    expect(s.conflicts).toEqual([expect.objectContaining({ path: SITE })]);
    expect(s.savedCopies).toEqual([]);
  });

  it('finds copies by ID, and takes only the one asked for off the list', async () => {
    const { dir, s } = await generatedConflict();
    await s.resolveConflict(HOME, 'restore');
    // The same file edited by hand again, and put back again: a second copy, never written over the first.
    writeFileSync(join(dir, HOME), '<h1>Second hand edit</h1>\n');
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: s.state.site.pageOrder[1], title: 'About again' }] }, { label: 'Rename' })).ok).toBe(true);
    await s.resolveConflict(HOME, 'restore');
    const [second, first] = s.savedCopies;
    expect(second.file).not.toBe(first.file);
    expect(second.savedAt).toBeGreaterThanOrEqual(first.savedAt);
    expect(await s.readSavedCopy(first.id)).toMatchObject({ content: { text: '<h1>Hero edited by hand</h1>\n' } });
    expect(await s.readSavedCopy(second.id)).toMatchObject({ content: { text: '<h1>Second hand edit</h1>\n' } });
    expect((await s.readSavedCopy('0123456789abcdef')).ok).toBe(false);
    await s.dismissSavedCopy(first.id);
    expect(existsSync(join(dir, first.file))).toBe(true);
    await s.close();
    expect((await reopen(dir)).savedCopies).toEqual([second]);
  });

  it('keeps a copy that is away for a while on the list, so it is shown again once it is back', async () => {
    const { dir, s } = await generatedConflict();
    await s.resolveConflict(HOME, 'restore');
    writeFileSync(join(dir, HOME), '<h1>Second hand edit</h1>\n');
    await s.apply({ operations: [{ type: 'site.update', name: 'Touch' }] }, { label: 'Touch' });
    await s.resolveConflict(HOME, 'restore');
    const [second, first] = s.savedCopies;
    // A sync tool moves the first copy away while the other is taken off the list.
    const away = join(dir, 'away.tmp');
    await fsp.rename(join(dir, first.file), away);
    await s.close();
    const again = await reopen(dir);
    expect(again.savedCopies).toEqual([second]);
    expect(await again.dismissSavedCopy(second.id)).toEqual({ ok: true });
    await again.close();
    open.splice(open.indexOf(again), 1);
    await fsp.rename(away, join(dir, first.file));
    expect((await reopen(dir)).savedCopies).toEqual([first]);
  });

  it('refuses to put a version back while the saved copies list cannot be read, and changes nothing', async () => {
    const { dir, s } = await generatedConflict();
    await s.resolveConflict(HOME, 'restore');
    writeFileSync(join(dir, HOME), '<h1>Edited again</h1>\n');
    await s.apply({ operations: [{ type: 'site.update', name: 'Touch' }] }, { label: 'Touch' });
    const list = join(dir, '.siteorigin/recovery/copies.json');
    const listed = readFileSync(list, 'utf8');
    const restore = denyAccess(list, 'read');
    try {
      await expect(s.resolveConflict(HOME, 'restore')).rejects.toThrow(/could not be read/);
    } finally {
      restore();
    }
    expect(readFileSync(list, 'utf8')).toBe(listed);
    expect(readFileSync(join(dir, HOME), 'utf8')).toBe('<h1>Edited again</h1>\n');
    expect(s.conflicts.some((c) => c.path === HOME)).toBe(true);
  });

  it('keeps nothing when the generated file already is what SiteOrigin Builder makes', async () => {
    const { s } = await make();
    await s.restoreGeneratedFile(HOME);
    expect(s.savedCopies).toEqual([]);
  });

  it('saves a copy of a file under a deep route, whose name is kept short enough to save', async () => {
    const { dir, s } = await make();
    const segment = 'a'.repeat(50);
    const route = `/${[segment, segment, segment, segment].join('/')}/`;
    expect((await s.apply({ operations: [{ type: 'page.create', title: 'Deep', route }] }, { label: 'Add' })).ok).toBe(true);
    const path = `src/routes/${[segment, segment, segment, segment].join('/')}/+page.svelte`;
    expect(existsSync(join(dir, path))).toBe(true);
    writeFileSync(join(dir, path), '<p>Hand edit</p>\n');
    await s.apply({ operations: [{ type: 'site.update', name: 'Touch' }] }, { label: 'Touch' });
    expect(s.conflicts.some((c) => c.path === path)).toBe(true);
    expect(await s.resolveConflict(path, 'restore')).toEqual({ ok: true });
    expect(s.savedCopies[0]).toMatchObject({ path });
    expect(s.savedCopies[0].file.split('/').pop()!.length).toBeLessThan(255);
  });

  it('says why a version is not shown as text: too large, or not text', async () => {
    const { dir, s } = await generatedConflict();
    writeFileSync(join(dir, HOME), Buffer.from([0x3c, 0x00, 0xff, 0xfe]));
    expect((await s.compareConflict(HOME)).disk).toEqual({ state: 'binary' });
    writeFileSync(join(dir, HOME), 'x'.repeat(600 * 1024));
    expect((await s.compareConflict(HOME)).disk).toEqual({ state: 'too-large' });
    rmSync(join(dir, HOME));
    expect((await s.compareConflict(HOME)).disk).toEqual({ state: 'missing' });
    // A binary file is kept byte for byte.
    writeFileSync(join(dir, HOME), Buffer.from([0x3c, 0x00, 0xff, 0xfe]));
    await s.resolveConflict(HOME, 'restore');
    expect(readFileSync(join(dir, s.savedCopies[0].file)).equals(Buffer.from([0x3c, 0x00, 0xff, 0xfe]))).toBe(true);
    expect(await s.readSavedCopy(s.savedCopies[0].id)).toEqual({ ok: true, content: { state: 'binary' } });
  });

  it('never writes over a saved copies list it could not read: it is set aside, and the new copy listed', async () => {
    const { dir, s } = await generatedConflict();
    const list = join(dir, '.siteorigin/recovery/copies.json');
    mkdirSync(join(dir, '.siteorigin/recovery'), { recursive: true });
    writeFileSync(list, '{ broken');
    await s.resolveConflict(HOME, 'restore');
    expect(s.savedCopies).toHaveLength(1);
    expect(JSON.parse(readFileSync(list, 'utf8')).copies).toHaveLength(1);
    expect(readdirSync(join(dir, '.siteorigin/recovery')).some((f) => /^copies-unreadable-\d+\.json$/.test(f) && readFileSync(join(dir, '.siteorigin/recovery', f), 'utf8') === '{ broken')).toBe(true);
  });

  it('lists saved copies when the project is open read-only, and ignores entries that lead outside the recovery folder', async () => {
    const { dir, s } = await generatedConflict();
    await s.resolveConflict(HOME, 'restore');
    const [copy] = s.savedCopies;
    await s.close();
    const list = JSON.parse(readFileSync(join(dir, '.siteorigin/recovery/copies.json'), 'utf8'));
    list.copies.push(
      { ...copy, id: 'ffffffffffffffff', file: '.siteorigin/recovery/../../siteorigin/site.json' },
      { ...copy, id: 'eeeeeeeeeeeeeeee', file: '.siteorigin/recovery/gone.external' },
      { ...copy, id: 'dddddddddddddddd', file: 'siteorigin/site.json' },
      { ...copy, id: 'cccccccccccccccc', file: '.siteorigin/recovery/copies.json' }
    );
    writeFileSync(join(dir, '.siteorigin/recovery/copies.json'), toJson(list));
    const ro = await ProjectSession.openReadOnly(dir, { reason: 'Inspecting', canUnlock: false } as never);
    open.push(ro);
    expect(ro.savedCopies).toEqual([copy]);
    expect((await ro.readSavedCopy('ffffffffffffffff')).ok).toBe(false);
    expect((await ro.readSavedCopy(copy.id)).content).toMatchObject({ state: 'text' });
    // Nothing is written while read-only.
    const listed = readFileSync(join(dir, '.siteorigin/recovery/copies.json'), 'utf8');
    expect((await ro.dismissSavedCopy(copy.id)).ok).toBe(false);
    expect(ro.savedCopies).toEqual([copy]);
    expect(readFileSync(join(dir, '.siteorigin/recovery/copies.json'), 'utf8')).toBe(listed);
  });
});

describe('the version an AI run attempted, when it rolled back around a conflict (#739)', () => {
  const text = (v: unknown) => (v as { state: string; text?: string }).text ?? '';
  const nameIn = (v: unknown) => JSON.parse(text(v)).name as string;

  it('shows the file on disk, the pre-run version and the version the run tried to save', async () => {
    const { dir, s } = await runWithExternalEdit();
    const external = readFileSync(join(dir, SITE), 'utf8');
    await s.abortRun();
    expect(s.conflicts).toEqual([expect.objectContaining({ path: SITE, kind: 'canonical', aiRun: true })]);
    const compared = await s.compareConflict(SITE);
    expect(compared.disk).toEqual({ state: 'text', text: external });
    expect(nameIn(compared.builder)).toBe('Persist');
    expect(nameIn(compared.attempted)).toBe('AI name');
    expect(JSON.parse(text(compared.attempted)).description).not.toBe('Edited in another editor');
  });

  it('shows the latest version the run saved, not an earlier batch', async () => {
    const { dir, s } = await make();
    await s.beginRun('run_b');
    for (const name of ['First batch', 'Second batch']) expect((await s.apply({ operations: [{ type: 'site.update', name }] }, { label: 'AI', source: 'ai', runId: 'run_b', history: false })).ok).toBe(true);
    const site = read(dir, SITE);
    site.description = 'Edited in another editor';
    write(dir, SITE, site);
    await s.abortRun();
    const attempted = JSON.parse(text((await s.compareConflict(SITE)).attempted));
    expect(attempted.name).toBe('Second batch');
    expect(attempted.description).not.toBe('Edited in another editor');
  });

  it('shows a file the run created as missing before the run, and one it deleted as missing in its attempt', async () => {
    const created = await runWithExternalEdit(true);
    const page = Object.values(created.s.state.pages).find((p) => p.title === 'AI page')!;
    const pagePath = `siteorigin/pages/${page.id}.json`;
    const edited = read(created.dir, pagePath);
    edited.title = 'AI page, edited by hand';
    write(created.dir, pagePath, edited);
    await created.s.abortRun();
    const newFile = await created.s.compareConflict(pagePath);
    expect(newFile.builder).toEqual({ state: 'missing' });
    expect(JSON.parse(text(newFile.attempted)).title).toBe('AI page');

    const { dir, s } = await make();
    expect((await s.apply({ operations: [{ type: 'page.create', title: 'Spare' }] }, { label: 'Add' })).ok).toBe(true);
    const about = Object.values(s.state.pages).find((p) => p.title === 'Spare')!.id;
    const aboutPath = `siteorigin/pages/${about}.json`;
    const original = readFileSync(join(dir, aboutPath), 'utf8');
    await s.beginRun('run_d');
    expect((await s.apply({ operations: [{ type: 'page.remove', pageId: about }] }, { label: 'AI', source: 'ai', runId: 'run_d', history: false })).ok).toBe(true);
    expect(existsSync(join(dir, aboutPath))).toBe(false);
    // Put back by hand, with an edit, while the run is still going.
    writeFileSync(join(dir, aboutPath), original.replace('"title"', '"note": "by hand",\n  "title"'));
    await s.abortRun();
    const removed = await s.compareConflict(aboutPath);
    expect(removed.attempted).toEqual({ state: 'missing' });
    expect(removed.builder).toEqual({ state: 'text', text: original });
    // A removal is listed with no file to keep, and still is after reopening.
    expect(await s.resolveConflict(aboutPath, 'restore')).toEqual({ ok: true });
    expect(s.savedCopies).toEqual([expect.objectContaining({ path: aboutPath, side: 'external' }), expect.objectContaining({ path: aboutPath, side: 'attempted', removed: true })]);
    const removal = s.savedCopies[1];
    expect(existsSync(join(dir, removal.file))).toBe(false);
    expect(await s.readSavedCopy(removal.id)).toEqual({ ok: true, content: { state: 'missing' } });
    await s.close();
    expect((await reopen(dir)).savedCopies).toContainEqual(removal);
  });

  it('recovers a removal the run attempted as missing after a crash', async () => {
    const { dir, s } = await make();
    expect((await s.apply({ operations: [{ type: 'page.create', title: 'Spare' }] }, { label: 'Add' })).ok).toBe(true);
    const spare = Object.values(s.state.pages).find((p) => p.title === 'Spare')!.id;
    const sparePath = `siteorigin/pages/${spare}.json`;
    const original = readFileSync(join(dir, sparePath), 'utf8');
    await s.beginRun('run_r');
    expect((await s.apply({ operations: [{ type: 'page.remove', pageId: spare }] }, { label: 'AI', source: 'ai', runId: 'run_r', history: false })).ok).toBe(true);
    writeFileSync(join(dir, sparePath), original.replace('"title"', '"note": "by hand",\n  "title"'));
    const again = await reopen(dir);
    const compared = await again.compareConflict(sparePath);
    expect(compared.builder).toEqual({ state: 'text', text: original });
    expect(compared.attempted).toEqual({ state: 'missing' });
  });

  it('keeps the attempted version named while it cannot be read, and shows it once it can', async () => {
    const { dir } = await runWithExternalEdit();
    const marker = read(dir, '.siteorigin/sessions/active-run.json');
    const blob = join(dir, '.siteorigin/history/blobs', `${marker.paths[SITE].after}.json`);
    const away = join(dir, 'away.tmp');
    await fsp.rename(blob, away);
    // Crash, and the attempted version cannot be read as the project reopens.
    const again = await reopen(dir);
    expect((await again.compareConflict(SITE)).attempted).toEqual({ state: 'unreadable' });
    expect(readFileSync(join(dir, '.siteorigin/conflicts.json'), 'utf8')).toContain(marker.paths[SITE].after);
    await fsp.rename(away, blob);
    expect(nameIn((await again.compareConflict(SITE)).attempted)).toBe('AI name');
  });

  it('settles nothing while the attempted version cannot be read just now, and settles once it can', async () => {
    const { dir, s } = await runWithExternalEdit();
    const marker = read(dir, '.siteorigin/sessions/active-run.json');
    await s.abortRun();
    await s.close();
    const blob = join(dir, '.siteorigin/history/blobs', `${marker.paths[SITE].after}.json`);
    const external = readFileSync(join(dir, SITE), 'utf8');
    const restore = denyAccess(blob, 'read');
    let again: ProjectSession;
    try {
      again = await reopen(dir);
      expect((await again.compareConflict(SITE)).attempted).toEqual({ state: 'unreadable' });
      await expect(again.resolveConflict(SITE, 'restore')).rejects.toThrow(/could not be read/);
      await expect(again.resolveConflict(SITE, 'keep')).rejects.toThrow(/could not be read/);
      expect(again.conflicts).toEqual([expect.objectContaining({ path: SITE, aiRun: true })]);
      expect(again.savedCopies).toEqual([]);
      expect(readFileSync(join(dir, SITE), 'utf8')).toBe(external);
    } finally {
      restore();
    }
    expect(await again.resolveConflict(SITE, 'restore')).toEqual({ ok: true });
    expect(again.savedCopies.map((c) => c.side).sort()).toEqual(['attempted', 'external']);
  });

  it('settles a conflict whose attempted version is gone for good, with nothing of it to keep', async () => {
    const { dir, s } = await runWithExternalEdit();
    const marker = read(dir, '.siteorigin/sessions/active-run.json');
    await s.abortRun();
    await s.close();
    rmSync(join(dir, '.siteorigin/history/blobs', `${marker.paths[SITE].after}.json`));
    const again = await reopen(dir);
    expect((await again.compareConflict(SITE)).attempted).toEqual({ state: 'unreadable' });
    expect(await again.resolveConflict(SITE, 'restore')).toEqual({ ok: true });
    expect(again.savedCopies.map((c) => c.side)).toEqual(['external']);

    // A folder where the blob should be is damaged too, not a version to wait for.
    const other = await runWithExternalEdit();
    const named = read(other.dir, '.siteorigin/sessions/active-run.json').paths[SITE].after;
    await other.s.abortRun();
    await other.s.close();
    const blob = join(other.dir, '.siteorigin/history/blobs', `${named}.json`);
    rmSync(blob);
    mkdirSync(blob);
    const reopened = await reopen(other.dir);
    expect(await reopened.resolveConflict(SITE, 'keep')).toEqual({ ok: true });
    expect(reopened.conflicts).toEqual([]);
  });

  it('holds a conflict put back by hand until its attempted version can be listed under Saved copies', async () => {
    const { dir, s } = await runWithExternalEdit();
    const marker = readFileSync(join(dir, '.siteorigin/sessions/active-run.json'), 'utf8');
    await s.abortRun();
    const pre = text((await s.compareConflict(SITE)).builder);
    await s.close();
    // A crash before the rollback cleared its marker; the file is then put back by hand, and the recovery folder
    // cannot be written to as the project reopens.
    writeFileSync(join(dir, '.siteorigin/sessions/active-run.json'), marker);
    writeFileSync(join(dir, SITE), pre);
    const recovery = join(dir, '.siteorigin/recovery');
    mkdirSync(recovery, { recursive: true });
    const restore = denyAccess(recovery, 'write');
    let again: ProjectSession;
    try {
      again = await reopen(dir);
      expect(again.conflicts).toEqual([expect.objectContaining({ path: SITE, aiRun: true })]);
      expect(again.savedCopies).toEqual([]);
    } finally {
      restore();
    }
    expect((await again.reloadFromDisk()).ok).toBe(true);
    expect(again.conflicts).toEqual([]);
    expect(again.savedCopies).toEqual([expect.objectContaining({ path: SITE, side: 'attempted' })]);
  });

  it('keeps the attempted version when the file is put back by hand, in the open project or before it reopens', async () => {
    const live = await runWithExternalEdit();
    await live.s.abortRun();
    const compared = await live.s.compareConflict(SITE);
    writeFileSync(join(live.dir, SITE), text(compared.builder));
    expect((await live.s.reloadFromDisk()).ok).toBe(true);
    expect(live.s.conflicts).toEqual([]);
    expect(live.s.savedCopies).toEqual([expect.objectContaining({ path: SITE, side: 'attempted' })]);
    expect(await live.s.readSavedCopy(live.s.savedCopies[0].id)).toEqual({ ok: true, content: compared.attempted });

    const closed = await runWithExternalEdit();
    await closed.s.abortRun();
    const pre = text((await closed.s.compareConflict(SITE)).builder);
    await closed.s.close();
    writeFileSync(join(closed.dir, SITE), pre);
    const again = await reopen(closed.dir);
    expect(again.conflicts).toEqual([]);
    expect(again.savedCopies).toEqual([expect.objectContaining({ path: SITE, side: 'attempted' })]);
    expect(nameIn((await again.readSavedCopy(again.savedCopies[0].id)).content)).toBe('AI name');
  });

  it('recovers the attempted version after a crash in the middle of the run', async () => {
    const { dir } = await runWithExternalEdit();
    // Crash: the run never completed or aborted.
    const again = await reopen(dir);
    expect(again.conflicts).toEqual([expect.objectContaining({ path: SITE, aiRun: true })]);
    const compared = await again.compareConflict(SITE);
    expect(nameIn(compared.builder)).toBe('Persist');
    expect(nameIn(compared.attempted)).toBe('AI name');
  });

  it('recovers the latest attempted version after a crash between two batches', async () => {
    const { dir, s } = await make();
    await s.beginRun('run_c');
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'First batch' }] }, { label: 'AI', source: 'ai', runId: 'run_c', history: false })).ok).toBe(true);
    // The second batch is recorded in the run's marker, then the app dies before it is saved.
    const real = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('journal.json')) throw Object.assign(new Error('injected crash'), { code: 'EIO' });
      return real(from, to);
    });
    await s.apply({ operations: [{ type: 'site.update', name: 'Second batch' }] }, { label: 'AI', source: 'ai', runId: 'run_c', history: false }).catch(() => undefined);
    vi.restoreAllMocks();
    const site = read(dir, SITE);
    expect(site.name).toBe('First batch');
    site.description = 'Edited in another editor';
    write(dir, SITE, site);
    const again = await reopen(dir, 'test', { force: true });
    const compared = await again.compareConflict(SITE);
    expect(nameIn(compared.builder)).toBe('Persist');
    expect(nameIn(compared.attempted)).toBe('Second batch');
  });

  it('keeps the attempted version across closing and reopening the project, and through garbage collection', async () => {
    const { dir, s } = await runWithExternalEdit();
    await s.abortRun();
    s.historyByteLimit = 0;
    await s.collectGarbage();
    await s.close();
    const again = await reopen(dir);
    expect(again.conflicts).toEqual([expect.objectContaining({ path: SITE, aiRun: true })]);
    await again.collectGarbage();
    const compared = await again.compareConflict(SITE);
    expect(nameIn(compared.builder)).toBe('Persist');
    expect(nameIn(compared.attempted)).toBe('AI name');
  });

  it('lists the attempted version under Saved copies once the conflict is settled, either way', async () => {
    const restored = await runWithExternalEdit();
    await restored.s.abortRun();
    const attempted = (await restored.s.compareConflict(SITE)).attempted;
    expect(await restored.s.resolveConflict(SITE, 'restore')).toEqual({ ok: true });
    expect(restored.s.savedCopies.map((c) => c.side).sort()).toEqual(['attempted', 'external']);
    const copy = restored.s.savedCopies.find((c) => c.side === 'attempted')!;
    expect(copy).toMatchObject({ path: SITE, kind: 'canonical' });
    expect(await restored.s.readSavedCopy(copy.id)).toEqual({ ok: true, content: attempted });
    await restored.s.close();
    const reopened = await reopen(restored.dir);
    expect(reopened.savedCopies).toContainEqual(copy);
    expect(await reopened.readSavedCopy(copy.id)).toEqual({ ok: true, content: attempted });

    const kept = await runWithExternalEdit();
    await kept.s.abortRun();
    const tried = (await kept.s.compareConflict(kept.s.conflicts[0].path)).attempted;
    expect(await kept.s.resolveConflict(SITE, 'keep')).toEqual({ ok: true });
    expect(kept.s.savedCopies.map((c) => c.side).sort()).toEqual(['attempted', 'builder']);
    expect(await kept.s.readSavedCopy(kept.s.savedCopies.find((c) => c.side === 'attempted')!.id)).toEqual({ ok: true, content: tried });
  });

  it('compares a conflict no AI run left as before: two versions, and no attempted copy when settled', async () => {
    const { dir, s } = await make();
    const HOME = 'src/routes/+page.svelte';
    writeFileSync(join(dir, HOME), '<h1>Hero edited by hand</h1>\n');
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Touch' }] }, { label: 'Touch' })).ok).toBe(true);
    expect(s.conflicts).toEqual([expect.not.objectContaining({ aiRun: true })]);
    const generated = await s.compareConflict(HOME);
    expect(Object.keys(generated).sort()).toEqual(['builder', 'disk', 'ok']);
    expect(generated.disk).toEqual({ state: 'text', text: '<h1>Hero edited by hand</h1>\n' });
    expect(generated.builder).toMatchObject({ state: 'text', text: expect.stringContaining('Generated by SiteOrigin Builder') });
    await s.resolveConflict(HOME, 'restore');
    expect(s.savedCopies.map((c) => c.side)).toEqual(['external']);

    // A project document an interrupted save (not an AI run) left in conflict.
    const other = await make();
    await other.s.close();
    const sitePath = join(other.dir, SITE);
    const site = JSON.parse(readFileSync(sitePath, 'utf8'));
    const content = toJson({ ...site, name: 'Saved by the app' });
    writeFileSync(join(other.dir, '.siteorigin/history/blobs', `${sha(content)}.json`), content);
    writeFileSync(join(other.dir, '.siteorigin/journal.json'), JSON.stringify({ writes: [{ path: SITE, blob: sha(content), before: sha(readFileSync(sitePath, 'utf8')) }], deletes: [] }));
    write(other.dir, SITE, { ...site, description: 'Edited by hand' });
    const again = await reopen(other.dir);
    expect(again.conflicts).toEqual([expect.objectContaining({ path: SITE, kind: 'canonical' })]);
    expect(again.conflicts[0].aiRun).toBeUndefined();
    const manual = await again.compareConflict(SITE);
    expect(Object.keys(manual).sort()).toEqual(['builder', 'disk', 'ok']);
    expect(nameIn(manual.builder)).toBe('Saved by the app');
    expect(JSON.parse(text(manual.disk)).description).toBe('Edited by hand');
    expect(await again.resolveConflict(SITE, 'restore')).toEqual({ ok: true });
    expect(again.savedCopies.map((c) => c.side)).toEqual(['external']);
  });
});

describe('converting a design’s edited file to a code component (#737)', () => {
  const HERO = 'foundation.hero.split';
  const HERO_FILE = 'src/lib/siteorigin/generated/foundation-hero-split.svelte';
  const placements = (st: ProjectSession['state'], defId: string) => instancesOf(st, defId).map((u) => `${u.owner.kind}:${u.owner.id}/${u.node.id}`).sort();

  /**
   * The hero placed on Home (as the starter has it), on About, inside a project design and in the footer; then its
   * generated file edited by hand (a badge, its own count, a sibling design imported) and found so by a later save.
   */
  async function editedHero(edit = (text: string) => text) {
    const { dir, s } = await make();
    const [, about] = s.state.site.pageOrder;
    const ok = async (operations: unknown[], label: string) => {
      const r = await s.apply({ operations } as never, { label });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      return r;
    };
    await ok([{ type: 'node.insert', owner: { kind: 'page', id: about }, parentId: null, definitionId: HERO, props: { heading: 'About hero' }, variants: { tone: 'inverse' } }], 'Place');
    const made = await ok([{ type: 'component.create', name: 'Landing block' }], 'Create');
    const design = made.results![0].definitionId as string;
    const root = s.state.components[design].tree!.rootIds[0];
    await ok([{ type: 'node.insert', owner: { kind: 'component', id: design }, parentId: root, definitionId: HERO }], 'Place in design');
    await ok([{ type: 'node.insert', owner: { kind: 'shell', id: 'footer' }, parentId: null, definitionId: HERO }], 'Place in footer');
    const before = placements(s.state, HERO);
    expect(before.length).toBeGreaterThanOrEqual(4);
    const generated = readFileSync(join(dir, HERO_FILE), 'utf8');
    const edited = edit(
      generated
        .replace('<script>\n', '<script>\n\timport Banner from "./foundation-cta-banner.svelte";\n\tlet count = $state(0);\n')
        .replace(/(<section [^>]*>)/, '$1\n\t<button type="button" class="hand-badge" onclick={() => count++}>New {count}</button>')
        .concat('\n<style>\n\t.hand-badge { color: rebeccapurple; }\n</style>\n')
    );
    writeFileSync(join(dir, HERO_FILE), edited);
    await ok([{ type: 'page.update', pageId: about, title: 'About us' }], 'Rename');
    return { dir, s, generated, edited, before, design };
  }
  const historySteps = (s: ProjectSession) => s.historyInfo().entries.filter((e) => e.applied).length;

  it('makes the edited file a code component every placement uses, keeps the design for its styles and clears the conflict', async () => {
    const { dir, s, generated, edited, before } = await editedHero();
    expect(edited).not.toBe(generated);
    expect(s.conflicts).toEqual([{ path: HERO_FILE, kind: 'generated', reason: expect.stringMatching(/edited outside/), convert: { definitionId: HERO } }]);
    const steps = historySteps(s);
    const r = await s.resolveConflict(HERO_FILE, 'convert', { codeAllowed: true, expect: sha(edited) });
    expect(r).toEqual({ ok: true, definitionId: expect.any(String) });
    const code = s.state.components[r.definitionId!];
    const hero = s.state.components[HERO];
    expect(code).toMatchObject({ kind: 'code', owner: 'project', generatedFrom: HERO, componentId: hero.componentId, provenance: expect.objectContaining({ forkedFrom: HERO }) });
    expect(code.sourcePath).toMatch(/^src\/lib\/siteorigin\/custom\/[A-Za-z0-9_-]+\.svelte$/);
    // The edited file byte for byte, but for the one import the new folder needs.
    expect(code.source).toBe(edited.replace('"./foundation-cta-banner.svelte"', '"../generated/foundation-cta-banner.svelte"'));
    expect(readFileSync(join(dir, code.sourcePath!), 'utf8')).toBe(code.source);
    // Its contract is the design's, so every placement's values and choices still apply.
    expect(Object.keys(code.properties)).toEqual(Object.keys(hero.properties));
    expect(Object.keys(code.variantAxes ?? {})).toEqual(Object.keys(hero.variantAxes ?? {}));
    expect(code.slots).toEqual(hero.slots);
    expect(code.dependencies).toContain(HERO);
    // Every placement moved, the About hero with its own heading and tone; the design is placed nowhere now.
    expect(placements(s.state, r.definitionId!)).toEqual(before);
    expect(placements(s.state, HERO)).toEqual([]);
    const aboutHero = instancesOf(s.state, r.definitionId!).find((u) => u.owner.kind === 'page' && u.owner.id === s.state.site.pageOrder[1])!.node;
    expect(aboutHero).toMatchObject({ props: { heading: 'About hero' }, variants: { tone: 'inverse' } });
    // The design's file is Builder's again and the edited one is kept.
    expect(readFileSync(join(dir, HERO_FILE), 'utf8')).toBe(generated);
    expect(s.conflicts).toEqual([]);
    expect(s.savedCopies).toEqual([expect.objectContaining({ path: HERO_FILE, kind: 'generated', side: 'external' })]);
    expect(readFileSync(join(dir, s.savedCopies[0].file), 'utf8')).toBe(edited);
    // The design's rules, which the file's classes name, are still in the shared stylesheet; the pages use the code.
    expect(readFileSync(join(dir, 'src/lib/siteorigin/styles/components.css'), 'utf8')).toContain('.so-foundation-hero-split__');
    const home = readFileSync(join(dir, 'src/routes/+page.svelte'), 'utf8');
    expect(home).toContain(`"${code.sourcePath!.replace('src/', '../')}"`);
    expect(home).not.toContain('foundation-hero-split.svelte');
    // One step of history.
    expect(historySteps(s)).toBe(steps + 1);
    expect(s.historyInfo().undoLabel).toBe(`Convert “${hero.name}” to code`);
  });

  it('undoes the whole conversion in one step without bringing the conflict back, and keeps it across a reopen', async () => {
    const { dir, s, before, edited, generated } = await editedHero();
    const r = await s.resolveConflict(HERO_FILE, 'convert', { codeAllowed: true });
    expect(r.ok).toBe(true);
    const code = s.state.components[r.definitionId!];
    expect((await s.undo()).ok).toBe(true);
    expect(placements(s.state, HERO)).toEqual(before);
    expect(Object.hasOwn(s.state.components, r.definitionId!)).toBe(false);
    expect(existsSync(join(dir, code.sourcePath!))).toBe(false);
    expect(s.conflicts).toEqual([]);
    expect(readFileSync(join(dir, HERO_FILE), 'utf8')).toBe(generated);
    // The edited file stays under Saved copies whatever is undone.
    expect(s.savedCopies).toHaveLength(1);
    expect((await s.redo()).ok).toBe(true);
    expect(placements(s.state, r.definitionId!)).toEqual(before);
    expect(readFileSync(join(dir, code.sourcePath!), 'utf8')).toBe(code.source);

    const [copy] = s.savedCopies;
    await s.close();
    const again = await reopen(dir);
    expect(again.state.components[r.definitionId!]).toMatchObject({ kind: 'code', source: code.source, generatedFrom: HERO });
    expect(placements(again.state, r.definitionId!)).toEqual(before);
    expect(again.conflicts).toEqual([]);
    expect(again.savedCopies).toEqual([copy]);
    expect(await again.readSavedCopy(copy.id)).toEqual({ ok: true, content: { state: 'text', text: edited } });
  });

  it('never offers it for a page, a stylesheet or a file that is not text, and refuses it there', async () => {
    const { dir, s } = await make();
    const HOME = 'src/routes/+page.svelte';
    const CSS = 'src/lib/siteorigin/styles/components.css';
    writeFileSync(join(dir, HOME), '<h1>Hero edited by hand</h1>\n');
    writeFileSync(join(dir, CSS), '/* edited */\n');
    writeFileSync(join(dir, HERO_FILE), Buffer.from([0x3c, 0x70, 0x3e, 0x00, 0xff, 0x3c]));
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Touch' }] }, { label: 'Touch' })).ok).toBe(true);
    expect(s.conflicts.map((c) => c.path).sort()).toEqual([CSS, HERO_FILE, HOME].sort());
    expect(s.conflicts.filter((c) => c.convert)).toEqual([]);
    for (const path of [HOME, CSS, HERO_FILE]) {
      const r = await s.resolveConflict(path, 'convert', { codeAllowed: true });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Only a component’s own file/);
    }
    expect(s.conflicts).toHaveLength(3);
    expect(Object.values(s.state.components).some((d) => d.kind === 'code' && d.owner === 'project')).toBe(false);
    expect(s.savedCopies).toEqual([]);
  });

  it('changes nothing when the edited code fails the checks, Developer mode is off, or the file changed since it was compared', async () => {
    const { dir, s, edited } = await editedHero((text) => text.replace('let count = $state(0);', 'let count = $state(0;'));
    const unchanged = () => {
      expect(s.conflicts).toEqual([expect.objectContaining({ path: HERO_FILE, convert: { definitionId: HERO } })]);
      expect(readFileSync(join(dir, HERO_FILE), 'utf8')).toBe(edited);
      expect(Object.values(s.state.components).some((d) => d.kind === 'code' && d.owner === 'project')).toBe(false);
      expect(s.savedCopies).toEqual([]);
    };
    const steps = historySteps(s);
    const bad = await s.resolveConflict(HERO_FILE, 'convert', { codeAllowed: true });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/can’t become a code component: line \d+/);
    unchanged();
    // A valid file, but no Developer mode.
    const fixed = edited.replace('$state(0;', '$state(0);');
    writeFileSync(join(dir, HERO_FILE), fixed);
    const off = await s.resolveConflict(HERO_FILE, 'convert', { codeAllowed: false });
    expect(off).toEqual({ ok: false, message: expect.stringMatching(/Custom code needs Developer mode/) });
    // Compared as one version, another there now.
    const stale = await s.resolveConflict(HERO_FILE, 'convert', { codeAllowed: true, expect: sha(edited) });
    expect(stale).toEqual({ ok: false, message: 'The file changed since you compared the versions. Look again, then choose.' });
    expect(s.conflicts).toEqual([expect.objectContaining({ path: HERO_FILE })]);
    expect(readFileSync(join(dir, HERO_FILE), 'utf8')).toBe(fixed);
    expect(s.savedCopies).toEqual([]);
    expect(historySteps(s)).toBe(steps);
    // An import that leads nowhere from the file's new folder is refused too.
    writeFileSync(join(dir, HERO_FILE), fixed.replace('"./foundation-cta-banner.svelte"', '"./no-such-design.svelte"'));
    const missing = await s.resolveConflict(HERO_FILE, 'convert', { codeAllowed: true });
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/no-such-design\.svelte.*not a file in this project/);
    expect(s.savedCopies).toEqual([]);
  });

  it('converts nothing once the file is SiteOrigin Builder’s version again, and lets the conflict go', async () => {
    const { dir, s, generated } = await editedHero();
    writeFileSync(join(dir, HERO_FILE), generated);
    const r = await s.resolveConflict(HERO_FILE, 'convert', { codeAllowed: true });
    expect(r).toEqual({ ok: false, message: 'The file is SiteOrigin Builder’s version again, so there is nothing to convert.' });
    expect(s.conflicts).toEqual([]);
    expect(Object.values(s.state.components).some((d) => d.kind === 'code' && d.owner === 'project')).toBe(false);
    expect(s.savedCopies).toEqual([]);
    // Without a plain yes for Developer mode, nothing is converted either.
    writeFileSync(join(dir, HERO_FILE), `${generated}<p>again</p>\n`);
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Again' }] }, { label: 'Touch' })).ok).toBe(true);
    expect((await s.resolveConflict(HERO_FILE, 'convert')).message).toMatch(/Custom code needs Developer mode/);
  });

  it('says to reopen when the save stops after the project’s files are written', async () => {
    const { s } = await editedHero();
    vi.spyOn(s as unknown as { installHistory: () => Promise<unknown> }, 'installHistory').mockRejectedValueOnce(new Error('disk went away'));
    const r = await s.resolveConflict(HERO_FILE, 'convert', { codeAllowed: true });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/could not be finished: disk went away Close and reopen the project/) });
    expect(Object.values(s.state.components).some((d) => d.generatedFrom === HERO)).toBe(true);
  });

  it('leaves the edited file in place, still in conflict, when the conversion cannot be saved', async () => {
    const { dir, s, edited } = await editedHero();
    const persist = vi.spyOn(s as unknown as { persist: () => Promise<unknown> }, 'persist').mockRejectedValueOnce(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
    const r = await s.resolveConflict(HERO_FILE, 'convert', { codeAllowed: true });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/could not be saved, so nothing was converted/) });
    expect(readFileSync(join(dir, HERO_FILE), 'utf8')).toBe(edited);
    expect(s.conflicts).toEqual([expect.objectContaining({ path: HERO_FILE, convert: { definitionId: HERO } })]);
    expect(Object.values(s.state.components).some((d) => d.kind === 'code' && d.owner === 'project')).toBe(false);
    // And the choice can be made again.
    expect((await s.resolveConflict(HERO_FILE, 'convert', { codeAllowed: true })).ok).toBe(true);
    expect(s.conflicts).toEqual([]);
  });
});
