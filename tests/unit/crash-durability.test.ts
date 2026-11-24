import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { SCHEMA_VERSION } from '@shared/types';
import { sha } from '../../src/main/project/fsutil';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  disarm?.();
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-crash-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Persist', false));
  return { dir, s };
}

async function reopen(dir: string) {
  // The crashed session lives on in this process; a real crash ends it, and a claim it held while writing is then
  // cleared at once (its process is gone). Clearing it here stands in for that.
  for (const f of readdirSync(join(dir, '.siteorigin'))) if (/^lock\.json\..*\.claim\.\d+$/.test(f)) rmSync(join(dir, '.siteorigin', f));
  const s = await ProjectSession.open(dir, `after-crash-${Math.random()}`, { force: true });
  open.push(s);
  return s;
}

/** Every file system call that changes something on disk. */
const MUTATING = ['writeFile', 'appendFile', 'rename', 'rm', 'unlink', 'link', 'rmdir', 'mkdir', 'utimes', 'chmod', 'copyFile', 'open', 'truncate'] as const;
let disarm: (() => void) | null = null;

/**
 * Simulate the process dying just before its `step`-th change to the disk: that change and every one after it
 * never happens. Reads still work, so the code under test may carry on in memory, but nothing more reaches the disk.
 */
function crashBefore(step: number | ((method: string, args: unknown[]) => boolean)): { crashed: () => boolean } {
  const fs = fsp as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originals = new Map(MUTATING.map((m) => [m, fs[m]]));
  let count = 0;
  let dead = false;
  for (const m of MUTATING) {
    const real = originals.get(m)!;
    fs[m] = function (this: unknown, ...args: unknown[]) {
      // Opening for reading changes nothing.
      if (m === 'open' && (args[1] === undefined || args[1] === 'r')) return real.apply(this, args);
      if (dead || (typeof step === 'number' ? ++count >= step : step(m, args))) {
        dead = true;
        return Promise.reject(Object.assign(new Error('injected crash'), { code: 'EIO' }));
      }
      return real.apply(this, args);
    };
  }
  disarm = () => {
    for (const [m, real] of originals) fs[m] = real;
    disarm = null;
  };
  return { crashed: () => dead };
}

/**
 * Run `op` with a crash injected before each disk change in turn, checking the reopened project every time. `build`
 * prepares the project once; each crash point starts from a copy of it, opened and then readied by `start`.
 */
async function eachCrashPoint(
  setup: { build: (s: ProjectSession) => Promise<void>; start?: (s: ProjectSession) => Promise<void>; afterCrash?: (dir: string) => void },
  op: (s: ProjectSession) => Promise<unknown>,
  check: (s: ProjectSession) => Promise<void>
) {
  const base = await make();
  await setup.build(base.s);
  await base.s.close();
  let points = 0;
  for (let step = 1; step < 500; step++) {
    const dir = mkdtempSync(join(tmpdir(), 'so-crash-'));
    dirs.push(dir);
    cpSync(base.dir, dir, { recursive: true });
    const s = await ProjectSession.open(dir, `before-crash-${step}`);
    open.push(s);
    await setup.start?.(s);
    const crash = crashBefore(step);
    await op(s).catch(() => undefined);
    const crashed = crash.crashed();
    disarm?.();
    // What the disk holds when the process has died: anything checked or changed here comes before recovery.
    if (crashed) setup.afterCrash?.(dir);
    const again = await reopen(dir);
    await check(again);
    if (!crashed) return points;
    points++;
  }
  throw new Error('The operation never finished.');
}

const pageTitles = (s: ProjectSession) => Object.values(s.state.pages).map((p) => p.title);
function filesContaining(dir: string, text: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    // A write's own temporary file (hidden, never served) can be left by a crash; it is not a published file.
    .filter((e) => e.isFile() && !/^\.[0-9a-f]{12}\.tmp$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => readFileSync(f, 'utf8').includes(text));
}

describe('crash durability', { timeout: 300_000 }, () => {
  it('recovers an AI run interrupted while completing to the complete run or its checkpoint, never a mixture', async () => {
    const setup = {
      build: async (s: ProjectSession) => {
        expect((await s.apply({ operations: [{ type: 'site.update', name: 'Before run' }] }, { label: 'Rename' })).ok).toBe(true);
      },
      start: async (s: ProjectSession) => {
        expect(await s.beginRun('run_c')).toBeNull();
        const r = await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }, { type: 'page.create', title: 'AI page' }] }, { label: 'AI', source: 'ai', runId: 'run_c', history: false });
        expect(r.ok).toBe(true);
      }
    };
    const outcomes = new Set<string>();
    const points = await eachCrashPoint(setup, (s) => s.completeRun('AI: test'), async (s) => {
      expect(s.conflicts).toEqual([]);
      const group = s.historyInfo().entries.find((e) => e.runId === 'run_c');
      if (s.state.site.name === 'AI name') {
        outcomes.add('complete');
        // The complete run: its work, and one undoable group that takes the project back to the checkpoint.
        expect(pageTitles(s)).toContain('AI page');
        expect(group?.applied).toBe(true);
        expect((await s.undo()).ok).toBe(true);
        expect(s.state.site.name).toBe('Before run');
        expect(pageTitles(s)).not.toContain('AI page');
      } else {
        outcomes.add('checkpoint');
        expect(s.state.site.name).toBe('Before run');
        expect(pageTitles(s)).not.toContain('AI page');
        expect(group).toBeUndefined();
        // The edit before the run is still the one to undo.
        expect((await s.undo()).ok).toBe(true);
        expect(s.state.site.name).toBe('Persist');
      }
    });
    expect(points).toBeGreaterThan(0);
    expect(outcomes).toEqual(new Set(['complete', 'checkpoint']));
  });

  it('rolls an AI change interrupted at any point back to its checkpoint, generated files included', async () => {
    const setup = {
      build: async (s: ProjectSession) => {
        expect((await s.apply({ operations: [{ type: 'site.update', name: 'Before run' }] }, { label: 'Rename' })).ok).toBe(true);
      },
      start: async (s: ProjectSession) => {
        expect(await s.beginRun('run_b')).toBeNull();
      }
    };
    await eachCrashPoint(
      setup,
      (s) => s.apply({ operations: [{ type: 'site.update', name: 'AI name' }, { type: 'page.create', title: 'Interrupted page' }] }, { label: 'AI', source: 'ai', runId: 'run_b', history: false }),
      async (s) => {
        expect(s.conflicts).toEqual([]);
        expect(s.state.site.name).toBe('Before run');
        expect(pageTitles(s)).not.toContain('Interrupted page');
        // No route or other generated file is left behind from the interrupted batch.
        expect(filesContaining(join(s.dir, 'src'), 'Interrupted page')).toEqual([]);
        expect((await s.undo()).ok).toBe(true);
        expect(s.state.site.name).toBe('Persist');
      }
    );
  });

  it('keeps the undo position across a crash at any point of an undo', async () => {
    const setup = {
      build: async (s: ProjectSession) => {
        expect((await s.apply({ operations: [{ type: 'site.update', name: 'One' }] }, { label: 'One' })).ok).toBe(true);
        expect((await s.apply({ operations: [{ type: 'site.update', name: 'Two' }] }, { label: 'Two' })).ok).toBe(true);
      }
    };
    await eachCrashPoint(setup, (s) => s.undo(), async (s) => {
      expect(s.conflicts).toEqual([]);
      if (s.state.site.name === 'Two') {
        expect(s.historyInfo().canRedo).toBe(false);
        expect((await s.undo()).ok).toBe(true);
        expect(s.state.site.name).toBe('One');
      } else {
        expect(s.state.site.name).toBe('One');
        expect(s.historyInfo().redoLabel).toBe('Two');
        expect((await s.redo()).ok).toBe(true);
        expect(s.state.site.name).toBe('Two');
        expect((await s.undo()).ok).toBe(true);
      }
      expect((await s.undo()).ok).toBe(true);
      expect(s.state.site.name).toBe('Persist');
    });
  });

  it('keeps the undo position across a crash at any point of a redo', async () => {
    const setup = {
      build: async (s: ProjectSession) => {
        expect((await s.apply({ operations: [{ type: 'site.update', name: 'One' }] }, { label: 'One' })).ok).toBe(true);
        expect((await s.undo()).ok).toBe(true);
      }
    };
    await eachCrashPoint(setup, (s) => s.redo(), async (s) => {
      expect(s.conflicts).toEqual([]);
      if (s.state.site.name === 'One') {
        expect(s.historyInfo().canRedo).toBe(false);
        expect((await s.undo()).ok).toBe(true);
      } else {
        expect(s.state.site.name).toBe('Persist');
        expect((await s.redo()).ok).toBe(true);
        expect(s.state.site.name).toBe('One');
        expect((await s.undo()).ok).toBe(true);
      }
      expect(s.state.site.name).toBe('Persist');
      expect(s.historyInfo().canUndo).toBe(false);
    });
  });

  it('deletes a whole collection or none of it, whatever point a crash interrupts it (#392)', async () => {
    const setup = {
      build: async (s: ProjectSession) => {
        const r = await s.apply(
          {
            operations: [
              { type: 'collection.create', collectionId: 'posts' },
              { type: 'entry.create', collectionId: 'posts', entryId: 'en_first', title: 'One' },
              { type: 'entry.create', collectionId: 'posts', entryId: 'en_second', title: 'Two', body: ['See [one](entry:en_first).'] }
            ]
          },
          { label: 'Blog' }
        );
        expect(r.error?.message).toBeUndefined();
        expect(r.ok).toBe(true);
      }
    };
    const outcomes = new Set<string>();
    const entriesOf = (s: ProjectSession) => Object.keys(s.state.collections.posts?.entries ?? {}).sort();
    const posts = (dir: string) => join(dir, 'siteorigin/collections/posts');
    // Before recovery, an entry is never on disk without its collection's settings: entries go first.
    const left = (dir: string) => (existsSync(join(posts(dir), 'entries')) ? readdirSync(join(posts(dir), 'entries')) : []);
    Object.assign(setup, { afterCrash: (dir: string) => expect(left(dir).length === 0 || existsSync(join(posts(dir), 'collection.json'))).toBe(true) });
    await eachCrashPoint(setup, (s) => s.apply({ operations: [{ type: 'collection.remove', collectionId: 'posts' }] }, { label: 'Delete Posts' }), async (s) => {
      expect(s.conflicts).toEqual([]);
      const posts = join(s.dir, 'siteorigin/collections/posts');
      if (s.state.collections.posts) {
        outcomes.add('kept');
        expect(entriesOf(s)).toEqual(['en_first', 'en_second']);
        expect(readdirSync(join(posts, 'entries')).sort()).toEqual(['en_first.json', 'en_second.json']);
        expect(s.historyInfo().undoLabel).toBe('Blog');
      } else {
        outcomes.add('deleted');
        expect(existsSync(join(posts, 'collection.json'))).toBe(false);
        expect(existsSync(join(posts, 'entries'))).toBe(false);
        expect(s.historyInfo().undoLabel).toBe('Delete Posts');
        expect((await s.undo()).ok).toBe(true);
        expect(entriesOf(s)).toEqual(['en_first', 'en_second']);
      }
    });
    expect(outcomes).toEqual(new Set(['kept', 'deleted']));
  });

  it('keeps a collection whose deletion was interrupted while an entry was added to it outside the app (#392)', async () => {
    const late = { schemaVersion: SCHEMA_VERSION, id: 'en_late', slug: 'late', title: 'Late', publishedAt: '2026-01-01', draft: true, terms: {}, values: {}, body: [] };
    const setup = {
      build: async (s: ProjectSession) => {
        const r = await s.apply({ operations: [{ type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_first', title: 'One' }] }, { label: 'Blog' });
        expect(r.ok).toBe(true);
      },
      afterCrash: (dir: string) => {
        const entries = join(dir, 'siteorigin/collections/posts/entries');
        if (existsSync(join(dir, 'siteorigin/collections/posts/collection.json'))) {
          mkdirSync(entries, { recursive: true });
          writeFileSync(join(entries, 'en_late.json'), JSON.stringify(late));
        }
      }
    };
    let added = 0;
    await eachCrashPoint(setup, (s) => s.apply({ operations: [{ type: 'collection.remove', collectionId: 'posts' }] }, { label: 'Delete Posts' }), async (s) => {
      // The project opens; the late entry keeps its collection whenever it was added.
      if (existsSync(join(s.dir, 'siteorigin/collections/posts/entries/en_late.json'))) {
        added++;
        expect(s.state.collections.posts?.entries.en_late).toEqual(late);
        rmSync(join(s.dir, 'siteorigin/collections/posts/entries/en_late.json'));
      }
    });
    expect(added).toBeGreaterThan(0);
  });

  it('records an edit and its undo step together, whatever point a crash interrupts it', async () => {
    const setup = {
      build: async (s: ProjectSession) => {
        expect((await s.apply({ operations: [{ type: 'site.update', name: 'One' }] }, { label: 'One' })).ok).toBe(true);
        expect((await s.apply({ operations: [{ type: 'site.update', name: 'Tail' }] }, { label: 'Tail' })).ok).toBe(true);
        expect((await s.undo()).ok).toBe(true);
      }
    };
    await eachCrashPoint(setup, (s) => s.apply({ operations: [{ type: 'site.update', name: 'Two' }] }, { label: 'Two' }), async (s) => {
      expect(s.conflicts).toEqual([]);
      if (s.state.site.name === 'Two') {
        // The edit replaced the redo tail.
        expect(s.historyInfo().undoLabel).toBe('Two');
        expect(s.historyInfo().canRedo).toBe(false);
        expect((await s.undo()).ok).toBe(true);
      } else {
        expect(s.historyInfo().redoLabel).toBe('Tail');
      }
      expect(s.state.site.name).toBe('One');
      expect(s.historyInfo().undoLabel).toBe('One');
      expect((await s.undo()).ok).toBe(true);
      expect(s.state.site.name).toBe('Persist');
    });
  });

  it('keeps an undone AI step redoable, or notes it undone, whatever point a crash interrupts the edit that replaces it (issue 276)', async () => {
    const setup = {
      build: async (s: ProjectSession) => {
        expect((await s.apply({ operations: [{ type: 'site.update', name: 'One' }] }, { label: 'One' })).ok).toBe(true);
        expect(await s.beginRun('run_tail')).toBeNull();
        expect((await s.apply({ operations: [{ type: 'site.update', name: 'Tail' }] }, { label: 'AI', source: 'ai', runId: 'run_tail', history: false })).ok).toBe(true);
        expect(await s.completeRun('AI: Tail')).toBe(true);
        expect((await s.undoGroup('run_tail')).ok).toBe(true);
      }
    };
    await eachCrashPoint(setup, (s) => s.apply({ operations: [{ type: 'site.update', name: 'Two' }] }, { label: 'Two' }), async (s) => {
      expect(s.conflicts).toEqual([]);
      const info = s.historyInfo();
      if (s.state.site.name === 'Two') {
        // The edit replaced the redo tail, and History noted the AI step it let go as undone.
        expect(info.entries.some((e) => e.runId === 'run_tail')).toBe(false);
        expect(info.droppedRuns).toEqual({ run_tail: 'undone' });
      } else {
        expect(s.state.site.name).toBe('One');
        expect(info.entries.find((e) => e.runId === 'run_tail')).toMatchObject({ applied: false });
        expect(info.droppedRuns).toBeUndefined();
      }
    });
  });

  describe('a save that fails part way', () => {
    /** Make every rename onto `suffix` fail, as a full or failing disk would. */
    const failRenameTo = (suffix: string) => {
      const real = fsp.rename.bind(fsp);
      const fs = fsp as unknown as Record<string, unknown>;
      fs.rename = async (from: string, to: string) => {
        if (String(to).endsWith(suffix)) throw Object.assign(new Error('injected failure'), { code: 'EIO' });
        return real(from, to);
      };
      disarm = () => {
        fs.rename = real;
        disarm = null;
      };
    };

    it('blocks further edits until the project is reopened, which finishes the save', async () => {
      const { dir, s } = await make();
      failRenameTo('siteorigin/site.json');
      await expect(s.apply({ operations: [{ type: 'site.update', name: 'Half saved' }] }, { label: 'x' })).rejects.toThrow('injected failure');
      disarm?.();
      const next = await s.apply({ operations: [{ type: 'page.create', title: 'Later' }] }, { label: 'y' });
      expect(next.ok).toBe(false);
      expect(next.error?.message).toMatch(/reopen/);
      const again = await reopen(dir);
      expect(again.state.site.name).toBe('Half saved');
      expect(again.historyInfo().undoLabel).toBe('x');
    });

    it('leaves a run whose save failed for reopening to undo, rather than keeping it without an undo step', async () => {
      const { dir, s } = await make();
      expect(await s.beginRun('run_f')).toBeNull();
      failRenameTo('siteorigin/site.json');
      await expect(s.apply({ operations: [{ type: 'site.update', name: 'AI name' }, { type: 'page.create', title: 'AI page' }] }, { label: 'AI', source: 'ai', runId: 'run_f', history: false })).rejects.toThrow();
      disarm?.();
      // The orchestrator's error path.
      expect(await s.abortRun()).toEqual({ restored: false });
      expect(existsSync(join(dir, '.siteorigin/sessions/active-run.json'))).toBe(true);
      const again = await reopen(dir);
      expect(again.state.site.name).toBe('Persist');
      expect(pageTitles(again)).not.toContain('AI page');
      expect(again.conflicts).toEqual([]);
    });

    it('reports a run as finished once its completion is decided, even if recording it then fails', async () => {
      const { dir, s } = await make();
      expect(await s.beginRun('run_d')).toBeNull();
      expect((await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }] }, { label: 'AI', source: 'ai', runId: 'run_d', history: false })).ok).toBe(true);
      failRenameTo('history/history.json');
      expect(await s.completeRun('AI: decided')).toBe(true);
      disarm?.();
      expect((await s.apply({ operations: [{ type: 'site.update', name: 'x' }] }, { label: 'x' })).ok).toBe(false);
      const again = await reopen(dir);
      expect(again.state.site.name).toBe('AI name');
      expect(again.historyInfo().entries.find((e) => e.runId === 'run_d')?.applied).toBe(true);
    });

    it('undoes a run instead of finishing it from a damaged completion', async () => {
      const { dir, s } = await make();
      expect(await s.beginRun('run_x')).toBeNull();
      expect((await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }] }, { label: 'AI', source: 'ai', runId: 'run_x', history: false })).ok).toBe(true);
      const c = crashBefore((m, args) => m === 'rename' && String(args[1]).endsWith('history/history.json'));
      await s.completeRun('AI: test').catch(() => undefined);
      expect(c.crashed()).toBe(true);
      disarm?.();
      const journalPath = join(dir, '.siteorigin/journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      expect(journal.finishRun).toBe('run_x');
      journal.history.cursor = journal.history.entries.length + 5;
      writeFileSync(journalPath, JSON.stringify(journal));
      const again = await reopen(dir);
      expect(again.state.site.name).toBe('Persist');
      expect(again.historyInfo().entries.find((e) => e.runId === 'run_x')).toBeUndefined();
      expect(again.recoveryNotes.join(' ')).toMatch(/could not be finished/);
    });

    it('finishes a run whose completion was saved by the previous format, without installing its undo steps', async () => {
      const { dir, s } = await make();
      expect(await s.beginRun('run_v')).toBeNull();
      expect((await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }] }, { label: 'AI', source: 'ai', runId: 'run_v', history: false })).ok).toBe(true);
      crashBefore((m, args) => m === 'rename' && String(args[1]).endsWith('history/history.json'));
      await s.completeRun('AI: test').catch(() => undefined);
      disarm?.();
      // The app was updated to a new document format before the project was opened again.
      const journalPath = join(dir, '.siteorigin/journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      expect(journal.finishRun).toBe('run_v');
      journal.history.schemaVersion = SCHEMA_VERSION - 1;
      writeFileSync(journalPath, JSON.stringify(journal));
      const again = await reopen(dir);
      expect(again.state.site.name).toBe('AI name');
      expect(existsSync(join(dir, '.siteorigin/sessions/active-run.json'))).toBe(false);
      // Its undo steps hold documents of the old format, so they are not offered.
      expect(again.historyInfo().entries.find((e) => e.runId === 'run_v')).toBeUndefined();
      expect(again.recoveryNotes.join(' ')).not.toMatch(/could not be finished/);
      expect(again.recoveryNotes.join(' ')).toMatch(/cannot be undone/);
    });

    it('never trusts a previous-format completion that also changes files', async () => {
      const { dir, s } = await make();
      expect(await s.beginRun('run_w')).toBeNull();
      expect((await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }] }, { label: 'AI', source: 'ai', runId: 'run_w', history: false })).ok).toBe(true);
      crashBefore((m, args) => m === 'rename' && String(args[1]).endsWith('history/history.json'));
      await s.completeRun('AI: test').catch(() => undefined);
      disarm?.();
      const journalPath = join(dir, '.siteorigin/journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      journal.history.schemaVersion = SCHEMA_VERSION - 1;
      // A completion never writes files of its own; one that claims to is not what this app wrote.
      const site = readFileSync(join(dir, 'siteorigin/site.json'), 'utf8');
      const blob = journal.history.entries.find((e: { runId?: string }) => e.runId === 'run_w').docs['siteorigin/site.json'].after;
      journal.writes = [{ path: 'siteorigin/site.json', before: sha(site), blob }];
      writeFileSync(journalPath, JSON.stringify(journal));
      const again = await reopen(dir);
      expect(again.state.site.name).toBe('Persist');
      expect(again.recoveryNotes.join(' ')).toMatch(/could not be finished/);
    });

    it('never finishes a run from a completion whose step leaves out a file the run changed', async () => {
      const { dir, s } = await make();
      expect(await s.beginRun('run_p')).toBeNull();
      expect((await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }, { type: 'page.create', title: 'AI page' }] }, { label: 'AI', source: 'ai', runId: 'run_p', history: false })).ok).toBe(true);
      crashBefore((m, args) => m === 'rename' && String(args[1]).endsWith('history/history.json'));
      await s.completeRun('AI: test').catch(() => undefined);
      disarm?.();
      const journalPath = join(dir, '.siteorigin/journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      const step = journal.history.entries.find((e: { runId?: string }) => e.runId === 'run_p');
      const page = Object.keys(step.docs).find((p) => p.startsWith('siteorigin/pages/') && step.docs[p].before === null)!;
      delete step.docs[page];
      writeFileSync(journalPath, JSON.stringify(journal));
      const again = await reopen(dir);
      expect(again.state.site.name).toBe('Persist');
      expect(pageTitles(again)).not.toContain('AI page');
      expect(again.recoveryNotes.join(' ')).toMatch(/could not be finished/);
    });

    it('never finishes a run from a completion with an empty or unapplied step, or beside an unreadable marker', async () => {
      const damage: Array<(j: { history: { cursor: number; entries: Array<{ runId?: string; docs: unknown }> } }, dir: string) => void> = [
        (j) => (j.history.entries.find((e) => e.runId === 'run_x')!.docs = {}),
        (j) => (j.history.cursor = j.history.entries.findIndex((e) => e.runId === 'run_x')),
        (j) => (j.history.entries.find((e) => e.runId === 'run_x')!.docs = null),
        (_j, dir) => writeFileSync(join(dir, '.siteorigin/sessions/active-run.json'), '{"id": "run_x", "paths": {'.slice(0, 12))
      ];
      for (const harm of damage) {
        const { dir, s } = await make();
        expect(await s.beginRun('run_x')).toBeNull();
        expect((await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }] }, { label: 'AI', source: 'ai', runId: 'run_x', history: false })).ok).toBe(true);
        crashBefore((m, args) => m === 'rename' && String(args[1]).endsWith('history/history.json'));
        await s.completeRun('AI: test').catch(() => undefined);
        disarm?.();
        const journalPath = join(dir, '.siteorigin/journal.json');
        const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
        harm(journal, dir);
        writeFileSync(journalPath, JSON.stringify(journal));
        const again = await reopen(dir);
        expect(again.historyInfo().entries.find((e) => e.runId === 'run_x' && e.applied)).toBeUndefined();
        expect(again.recoveryNotes.join(' ')).toMatch(/could not be finished/);
      }
    });
  });

  describe('a component definition deleted outside the app while its source remains', () => {
    /** An unplaced code component, and an AI run that removes it and is interrupted at `crash`. */
    async function interruptedRemoval(crash: (method: string, args: unknown[]) => boolean) {
      const { dir, s } = await make();
      expect((await s.apply({ operations: [{ type: 'component.createCode', name: 'Widget', source: '<p>Widget</p>' }] }, { label: 'Add widget' })).ok).toBe(true);
      const def = Object.values(s.state.components).find((d) => d.name === 'Widget')!;
      const meta = `siteorigin/components/${def.id}/component.json`;
      const source = def.sourcePath!;
      const sourceText = readFileSync(join(dir, source), 'utf8');
      expect(await s.beginRun('run_m')).toBeNull();
      const c = crashBefore(crash);
      await s.apply({ operations: [{ type: 'component.remove', definitionId: def.id }] }, { label: 'AI', source: 'ai', runId: 'run_m', history: false }).catch(() => undefined);
      expect(c.crashed()).toBe(true);
      disarm?.();
      // While the app is down, someone deletes only the definition.
      rmSync(join(dir, meta), { force: true });
      expect(existsSync(join(dir, source))).toBe(true);
      return { dir, def, meta, source, sourceText };
    }

    async function expectReported({ dir, def, meta, source, sourceText }: Awaited<ReturnType<typeof interruptedRemoval>>) {
      const again = await reopen(dir);
      // Reported, not silently recreated: the definition stays deleted on disk until the user chooses.
      expect(again.conflicts).toContainEqual(expect.objectContaining({ path: meta, kind: 'canonical' }));
      expect(existsSync(join(dir, meta))).toBe(false);
      expect(readFileSync(join(dir, source), 'utf8')).toBe(sourceText);
      // Keeping the external change leaves the definition deleted and the source exactly as found.
      expect((await again.resolveConflict(meta, 'keep')).ok).toBe(true);
      expect(again.state.components[def.id]).toBeUndefined();
      expect(existsSync(join(dir, meta))).toBe(false);
      expect(readFileSync(join(dir, source), 'utf8')).toBe(sourceText);
    }

    it('is reported when the run stopped before its save was journaled', async () => {
      await expectReported(await interruptedRemoval((m, args) => m === 'rename' && String(args[1]).endsWith('journal.json')));
    });

    it('is reported when the run stopped after its delete was journaled', async () => {
      await expectReported(await interruptedRemoval((m, args) => m === 'rm' && String(args[0]).endsWith('.svelte')));
    });

    it('is still reported after a second crash part way through recovery', async () => {
      const r = await interruptedRemoval((m, args) => m === 'rm' && String(args[0]).endsWith('.svelte'));
      const c = crashBefore((m, args) => m === 'rename' && String(args[1]).endsWith('conflicts.json'));
      await ProjectSession.open(r.dir, 'interrupted-recovery', { force: true }).catch(() => undefined);
      expect(c.crashed()).toBe(true);
      disarm?.();
      await expectReported(r);
    });

    it('can be undone after the deletion is kept', async () => {
      const r = await interruptedRemoval((m, args) => m === 'rename' && String(args[1]).endsWith('journal.json'));
      const again = await reopen(r.dir);
      expect((await again.resolveConflict(r.meta, 'keep')).ok).toBe(true);
      expect((await again.undo()).ok).toBe(true);
      expect(again.state.components[r.def.id]?.source).toBe(r.sourceText);
      expect(existsSync(join(r.dir, r.meta))).toBe(true);
    });

    it('can still be restored', async () => {
      const r = await interruptedRemoval((m, args) => m === 'rename' && String(args[1]).endsWith('journal.json'));
      const again = await reopen(r.dir);
      expect((await again.resolveConflict(r.meta, 'restore')).ok).toBe(true);
      expect(again.conflicts).toEqual([]);
      expect(existsSync(join(r.dir, r.meta))).toBe(true);
      expect(again.state.components[r.def.id]?.source).toBe(r.sourceText);
    });
  });
});

describe('flush order', () => {
  type Step = { op: 'write' | 'sync' | 'rename' | 'rm'; path: string; to?: string };
  /**
   * Record, in completion order, every write through a file handle, every flush of a file or folder, and every rename
   * and removal. A flush takes a few milliseconds here, and any rename or removal while one is still running is
   * recorded as a violation: the code must wait for each flush before its next step.
   */
  async function trace() {
    const log: Step[] = [];
    const violations: string[] = [];
    let flushing = 0;
    const fs = fsp as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const realOpen = fs.open;
    const realRename = fs.rename;
    const realRm = fs.rm;
    fs.open = async function (this: unknown, ...args: unknown[]) {
      const handle = (await realOpen.apply(this, args)) as { sync: () => Promise<void>; writeFile: (...a: unknown[]) => Promise<void> };
      const sync = handle.sync.bind(handle);
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (...a: unknown[]) => {
        await writeFile(...a);
        log.push({ op: 'write', path: String(args[0]) });
      };
      handle.sync = async () => {
        flushing++;
        try {
          await sync();
          await new Promise((r) => setTimeout(r, 5));
        } finally {
          flushing--;
        }
        log.push({ op: 'sync', path: String(args[0]) });
      };
      return handle;
    };
    fs.rename = async function (this: unknown, ...args: unknown[]) {
      if (flushing) violations.push(`rename ${String(args[1])} while a flush was running`);
      await realRename.apply(this, args);
      log.push({ op: 'rename', path: String(args[0]), to: String(args[1]) });
    };
    fs.rm = async function (this: unknown, ...args: unknown[]) {
      if (flushing) violations.push(`remove ${String(args[0])} while a flush was running`);
      await realRm.apply(this, args);
      log.push({ op: 'rm', path: String(args[0]) });
    };
    disarm = () => {
      Object.assign(fs, { open: realOpen, rename: realRename, rm: realRm });
      disarm = null;
    };
    const at = (pred: (e: Step) => boolean, from = 0) => {
      const i = log.findIndex((e, n) => n >= from && pred(e));
      expect(i, 'missing step').toBeGreaterThanOrEqual(0);
      return i;
    };
    /** A durable replacement: data written and flushed, then renamed into place, then its folder flushed. */
    const durableWrite = (path: string, from: number) => {
      const rename = at((e) => e.op === 'rename' && e.to === path, from);
      const tmp = log[rename].path;
      const flushed = at((e) => e.op === 'sync' && e.path === tmp, from);
      expect(at((e) => e.op === 'write' && e.path === tmp, from)).toBeLessThan(flushed);
      expect(flushed).toBeLessThan(rename);
      return at((e) => e.op === 'sync' && e.path === dirname(path), rename);
    };
    const durableRemove = (path: string, from: number) => at((e) => e.op === 'sync' && e.path === dirname(path), at((e) => e.op === 'rm' && e.path === path, from));
    return { log, violations, at, durableWrite, durableRemove };
  }

  it('makes the journal, then each document, then the history durable before the journal goes', async () => {
    const { dir, s } = await make();
    const custom = join(dir, 'src/lib/siteorigin/custom');
    const newCustomFolder = !existsSync(custom);
    const { log, violations, at, durableWrite, durableRemove } = await trace();
    expect((await s.apply({ operations: [{ type: 'component.createCode', name: 'Widget', source: '<p>Widget</p>' }] }, { label: 'Add widget' })).ok).toBe(true);
    const def = Object.values(s.state.components).find((d) => d.name === 'Widget')!;
    expect((await s.apply({ operations: [{ type: 'component.remove', definitionId: def.id }] }, { label: 'Remove widget' })).ok).toBe(true);
    disarm?.();
    expect(violations).toEqual([]);

    const local = join(dir, '.siteorigin');
    const journal = join(local, 'journal.json');
    const meta = join(dir, 'siteorigin/components', def.id, 'component.json');
    const source = join(dir, def.sourcePath!);
    let from = 0;
    for (const change of ['create', 'remove'] as const) {
      const journalRename = at((e) => e.op === 'rename' && e.to === journal, from);
      const journalWritten = durableWrite(journal, from);
      const removed = at((e) => e.op === 'rm' && e.path === journal, journalWritten);
      // Every blob the change writes is durable before the journal that names it is renamed into place.
      for (const [i, e] of log.entries()) {
        if (i < from || i > removed || e.op !== 'rename' || !e.to?.includes('/history/blobs/')) continue;
        expect(i).toBeLessThan(journalRename);
        expect(durableWrite(e.to, from)).toBeLessThan(journalRename);
      }
      const history = durableWrite(join(local, 'history', 'history.json'), journalWritten);
      if (change === 'create') {
        for (const doc of [meta, source]) {
          const renamed = at((e) => e.op === 'rename' && e.to === doc, from);
          expect(renamed).toBeGreaterThan(journalWritten);
          expect(durableWrite(doc, journalWritten)).toBeLessThan(removed);
          // The documents go before the history that records them.
          expect(renamed).toBeLessThan(at((e) => e.op === 'rename' && e.to === join(local, 'history', 'history.json'), journalWritten));
        }
        // New folders are recorded in their parents before the journal goes.
        expect(at((e) => e.op === 'sync' && e.path === join(dir, 'siteorigin/components'), from)).toBeLessThan(removed);
        if (newCustomFolder) expect(at((e) => e.op === 'sync' && e.path === dirname(custom), from)).toBeLessThan(removed);
      } else {
        // The source goes first, then its definition, each flushed, all before the history and the journal go.
        const sourceGone = durableRemove(source, journalWritten);
        const metaGone = durableRemove(meta, journalWritten);
        expect(sourceGone).toBeLessThan(metaGone);
        expect(metaGone).toBeLessThan(history);
      }
      expect(history).toBeLessThan(removed);
      expect(durableWrite(join(local, 'state.json'), journalWritten)).toBeLessThan(removed);
      expect(durableWrite(join(dir, 'siteorigin/generated-manifest.json'), journalWritten)).toBeLessThan(removed);
      // The journal's removal is itself flushed before the change counts as done.
      from = durableRemove(journal, removed) + 1;
    }
  });

  it('flushes the folders a stopped save created before recovery retires its journal', async () => {
    const { dir, s } = await make();
    const c = crashBefore((m, args) => m === 'rename' && String(args[1]).endsWith('component.json'));
    await s.apply({ operations: [{ type: 'component.createCode', name: 'Widget', source: '<p>Widget</p>' }] }, { label: 'Add widget' }).catch(() => undefined);
    expect(c.crashed()).toBe(true);
    disarm?.();
    const journal = join(dir, '.siteorigin/journal.json');
    const created = JSON.parse(readFileSync(journal, 'utf8')).writes.map((w: { path: string }) => w.path).find((p: string) => p.endsWith('component.json'))!;
    const { violations, at } = await trace();
    const again = await ProjectSession.open(dir, 'after', { force: true });
    disarm?.();
    expect(Object.values(again.state.components).some((d) => d.name === 'Widget')).toBe(true);
    expect(violations).toEqual([]);
    const retired = at((e) => e.op === 'rm' && e.path === journal);
    for (const folder of [dirname(join(dir, created)), join(dir, 'siteorigin/components'), join(dir, 'siteorigin')]) expect(at((e) => e.op === 'sync' && e.path === folder)).toBeLessThan(retired);
    await again.close();
  });

  it('records a finished AI run before clearing its marker, and clears the marker before the journal', async () => {
    const { dir, s } = await make();
    expect(await s.beginRun('run_f')).toBeNull();
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }] }, { label: 'AI', source: 'ai', runId: 'run_f', history: false })).ok).toBe(true);
    const { violations, at, durableWrite, durableRemove } = await trace();
    expect(await s.completeRun('AI: test')).toBe(true);
    disarm?.();
    expect(violations).toEqual([]);
    const local = join(dir, '.siteorigin');
    const journal = join(local, 'journal.json');
    const decided = durableWrite(journal, 0);
    const history = durableWrite(join(local, 'history', 'history.json'), decided);
    const marker = durableRemove(join(local, 'sessions', 'active-run.json'), history);
    expect(durableRemove(journal, marker)).toBeGreaterThan(marker);
  });
});
