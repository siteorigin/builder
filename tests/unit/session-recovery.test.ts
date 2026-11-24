import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import type { AssetRecord } from '@shared/types';
import { LOCK_STALE_MS, ProjectLockedError, ProjectSession } from '../../src/main/project/session';
import { sha, toJson } from '../../src/main/project/fsutil';

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
      if (String(to).endsWith(SITE)) {
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
    expect(r.message).toMatch(/component property or list item field/);
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
