import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from 'svelte/compiler';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateProject } from '@generator/index';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { CompileCache, compileFile, compileProject } from '../../src/main/compile';
import { createCompilePool, FILES_PER_WORKER } from '../../src/main/compile-client';
import type { CompileRequest } from '../../src/main/compile-file';
import { ProjectSession } from '../../src/main/project/session';

// The real compiler, counted: a check that reuses an outcome makes no call for it.
vi.mock('svelte/compiler', async (importOriginal) => {
  const real = await importOriginal<typeof import('svelte/compiler')>();
  return { ...real, compile: vi.fn(real.compile) };
});
const calls = () => vi.mocked(compile).mock.calls.length;
/** The compiler calls `fn` makes, and what it returns. */
async function counted<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const before = calls();
  const out = await fn();
  return [out, calls() - before];
}

const made = applyOperations(createStarterState('business', 'Test', false), [{ type: 'component.createCode', name: 'Card', source: '<div></div>\n' }]);
const cardId = (made.results[0] as { definitionId: string }).definitionId;
const withCard = (source: string, from: ProjectState = made.state): ProjectState => {
  const state = structuredClone(from);
  state.components[cardId].source = source;
  return state;
};
const apply = (state: ProjectState, ops: EditOperation[]) => applyOperations(state, ops).state;
const svelteFiles = (state: ProjectState) => [...generateProject(state, { instrument: false }).keys()].filter((p) => p.endsWith('.svelte')).length;
const BROKEN = '<div id="a" id="a"></div>\n';

describe('build checks with a compile cache (#975)', () => {
  it('compile a file again only when its source changed, with the same diagnostics as a check without one', async () => {
    const cache = new CompileCache();
    const [first, n1] = await counted(() => compileProject(made.state, undefined, { cache }));
    expect(first).toEqual([]);
    expect(n1).toBe(2 * svelteFiles(made.state));
    // Nothing changed: nothing compiles again.
    const [again, n2] = await counted(() => compileProject(made.state, undefined, { cache }));
    expect([again, n2]).toEqual([[], 0]);
    // One component's source changed: only its file compiles again, both ways.
    const changed = withCard('<section></section>\n');
    const [third, n3] = await counted(() => compileProject(changed, undefined, { cache }));
    expect([third, n3]).toEqual([await compileProject(changed), 2]);
  });

  it('never report a file that fails as passing: a cached failure is reported as it was, and a fix compiles again', async () => {
    const cache = new CompileCache();
    await compileProject(made.state, undefined, { cache });
    const broken = withCard(BROKEN);
    const [failed, n1] = await counted(() => compileProject(broken, undefined, { cache }));
    expect(failed).toEqual(await compileProject(broken));
    expect(failed.map((d) => d.code)).toEqual(['COMPILE']);
    // The client build fails first, so the server build is never tried: exactly as without a cache.
    expect(n1).toBe(1);
    const [cached, n2] = await counted(() => compileProject(broken, undefined, { cache }));
    expect([cached, n2]).toEqual([failed, 0]);
    const [fixed, n3] = await counted(() => compileProject(made.state, undefined, { cache }));
    expect([fixed, n3]).toEqual([[], 2]);
    // Broken again in the same way: compiled again, since the outcome kept was the fixed source's.
    const [rebroken, n4] = await counted(() => compileProject(broken, undefined, { cache }));
    expect([rebroken, n4]).toEqual([failed, 1]);
  });

  it('name a cached failure from the project as it is now', async () => {
    const cache = new CompileCache();
    const broken = withCard(BROKEN);
    await compileProject(broken, undefined, { cache });
    const renamed = apply(broken, [{ type: 'component.rename', definitionId: cardId, name: 'Price card' }]);
    const [got, n] = await counted(() => compileProject(renamed, undefined, { cache }));
    expect(got).toEqual(await compileProject(renamed));
    expect(got[0].message).toMatch(/^Price card \(line 1\): /);
    // The rename changed no source the compiler reads, so nothing compiled again.
    expect(n).toBe(0);
  });

  it('forget the files the website no longer has', async () => {
    const cache = new CompileCache();
    await compileProject(made.state, undefined, { cache });
    expect(cache.size).toBe(svelteFiles(made.state));
    const removed = apply(made.state, [{ type: 'component.remove', definitionId: cardId }]);
    await compileProject(removed, undefined, { cache });
    expect(cache.size).toBe(svelteFiles(removed));
    expect(cache.size).toBeLessThan(svelteFiles(made.state));
  });

  it('keep only what a check reads of the compiler’s error, and stop at the first build that fails', () => {
    const error = Object.assign(new Error('Attributes need to be unique\nhttps://svelte.dev/e/attribute_duplicate'), { name: 'CompileError', code: 'attribute_duplicate', start: { line: 3, column: 9, character: 40 }, end: { line: 4, column: 2, character: 50 }, frame: 'a frame', ast: { huge: true } });
    const builds: string[] = [];
    const failing = (which: string) => ((_: string, o: { generate?: unknown }) => {
      builds.push(String(o.generate));
      if (o.generate === which) throw error;
      return {};
    }) as unknown as typeof compile;
    expect(compileFile(failing('client'), 'src/a.svelte', 'x')).toEqual({ message: error.message, code: 'attribute_duplicate', start: { line: 3 }, end: { line: 4 } });
    expect(builds).toEqual(['client']);
    builds.length = 0;
    // A file that only the server build refuses is still refused.
    expect(compileFile(failing('server'), 'src/a.svelte', 'x')).toEqual({ message: error.message, code: 'attribute_duplicate', start: { line: 3 }, end: { line: 4 } });
    expect(builds).toEqual(['client', 'server']);
    builds.length = 0;
    expect(compileFile(failing('neither'), 'src/a.svelte', 'x')).toBeNull();
    expect(builds).toEqual(['client', 'server']);
  });
});

describe('the website files a session gives a build check (#975)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('are the files a generation without its cache makes, after opening and after each change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-compile-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
    try {
      const same = () => expect(session.websiteFiles()).toEqual(generateProject(session.state, { instrument: false }));
      same();
      const home = session.state.site.homePageId;
      const hero = session.state.pages[home].rootIds[0];
      expect((await session.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: home }, nodeId: hero, prop: 'heading', value: 'Checked heading' }] }, { label: 'Edit', source: 'user' })).ok).toBe(true);
      same();
      expect(session.websiteFiles().get('src/routes/+page.svelte')).toContain('Checked heading');
      expect((await session.apply({ operations: [{ type: 'component.createCode', name: 'Card', source: '<div></div>\n' }] }, { label: 'Add', source: 'user', codeAllowed: true })).ok).toBe(true);
      same();
    } finally {
      await session.close();
    }
  });
});

/** The compiler itself, uncounted: what a worker compiles with is not compiled here. */
const elsewhere = (await vi.importActual<typeof import('svelte/compiler')>('svelte/compiler')).compile;

/** A stand-in compile worker: answers each batch with the real compiler, unless told to fail in some way. */
class FakeWorker {
  static spawned = 0;
  batches: Array<Array<[string, string]>> = [];
  killed = false;
  private listeners: Record<string, Array<(m?: any) => void>> = {};
  constructor(private how: 'answer' | 'crash' | 'hang' | 'refuse' | 'short' = 'answer') {
    FakeWorker.spawned++;
  }
  on(event: string, fn: (m?: any) => void) {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }
  private emit(event: string, m?: unknown) {
    for (const fn of this.listeners[event] ?? []) fn(m);
  }
  postMessage(m: CompileRequest) {
    this.batches.push(m.files);
    setTimeout(() => {
      if (this.how === 'crash') return this.emit('exit', 1);
      if (this.how === 'hang') return;
      if (this.how === 'refuse') return this.emit('message', { id: m.id, ok: false, error: 'no compiler' });
      let runs = 0;
      const outcomes = m.files.map(([path, source]) => compileFile(elsewhere, path, source, () => runs++));
      this.emit('message', { id: m.id, ok: true, outcomes: this.how === 'short' ? outcomes.slice(1) : outcomes, runs });
    }, 1);
  }
  kill() {
    this.killed = true;
    return true;
  }
}

describe('build checks compiled in workers (#975)', () => {
  const pool = (how: ConstructorParameters<typeof FakeWorker>[0] = 'answer', size = 3, extra: { timeoutMs?: number } = {}) => {
    const workers: FakeWorker[] = [];
    const p = createCompilePool(() => {
      const w = new FakeWorker(how);
      workers.push(w);
      return w;
    }, { size, idleMs: 60_000, ...extra });
    return { p, workers };
  };

  it('give the same diagnostics as compiling here, with every file compiled once in some worker', async () => {
    const broken = withCard(BROKEN);
    const { p, workers } = pool();
    const offload = vi.fn((files: Array<[string, string]>) => p.compile(files));
    const [got, here] = await counted(() => compileProject(broken, undefined, { offload }));
    expect(here).toBe(0);
    expect(got).toEqual(await compileProject(broken));
    expect(got.map((d) => d.code)).toEqual(['COMPILE']);
    expect(workers).toHaveLength(3);
    const sent = workers.flatMap((w) => w.batches.flat().map(([path]) => path));
    expect(sent.sort()).toEqual([...generateProject(broken, { instrument: false }).keys()].filter((path) => path.endsWith('.svelte')).sort());
    p.stop();
  });

  it('compile the files here when a worker crashes, refuses, answers short or takes too long, never reporting them as passing', async () => {
    const broken = withCard(BROKEN);
    const expected = await compileProject(broken);
    for (const how of ['crash', 'refuse', 'short', 'hang'] as const) {
      const { p } = pool(how, 2, { timeoutMs: 50 });
      const [got, here] = await counted(() => compileProject(broken, undefined, { offload: (files) => p.compile(files) }));
      expect(got, how).toEqual(expected);
      expect(here, how).toBeGreaterThan(0);
      p.stop();
    }
  });

  it('hand the workers only the files whose source changed, to as few workers as keep each busy', async () => {
    const cache = new CompileCache();
    const { p, workers } = pool();
    const offload = (files: Array<[string, string]>) => p.compile(files);
    const [, here] = await counted(() => compileProject(made.state, undefined, { cache, offload }));
    expect(here).toBe(0);
    // The whole site is shared out between the workers.
    const files = svelteFiles(made.state);
    expect(files).toBeGreaterThan(3 * FILES_PER_WORKER);
    expect(workers.map((w) => w.batches.map((b) => b.length))).toEqual([[Math.ceil(files / 3)], [Math.ceil((files - 1) / 3)], [Math.floor(files / 3)]]);
    const [, again] = await counted(() => compileProject(withCard('<section></section>\n'), undefined, { cache, offload }));
    expect(again).toBe(0);
    // The one file changed went to the first worker, already running, and nothing else did.
    expect(workers.map((w) => w.batches.length)).toEqual([2, 1, 1]);
    expect(workers[0].batches.at(-1)!.map(([path]) => path)).toEqual([expect.stringContaining('.svelte')]);
    // A large batch is shared out, as evenly as the files allow.
    const many = Array.from({ length: 3 * FILES_PER_WORKER + 1 }, (_, i): [string, string] => [`src/f${i}.svelte`, `<p>${i}</p>\n`]);
    const done = await p.compile(many);
    expect(done?.outcomes).toEqual(many.map(() => null));
    expect(done?.runs).toBe(2 * many.length);
    const shares = workers.map((w) => w.batches.at(-1)!.length);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(many.length);
    expect(Math.max(...shares) - Math.min(...shares)).toBe(1);
    p.stop();
  });

  it('start a worker again after one crashed, and give nothing once stopped', async () => {
    let crash = true;
    const spawned: FakeWorker[] = [];
    const p = createCompilePool(() => {
      const w = new FakeWorker(crash ? 'crash' : 'answer');
      spawned.push(w);
      return w;
    }, { size: 1, idleMs: 60_000 });
    const files: Array<[string, string]> = [['src/a.svelte', '<div></div>\n']];
    expect(await p.compile(files)).toEqual({ outcomes: [undefined], runs: 0 });
    crash = false;
    expect(await p.compile(files)).toEqual({ outcomes: [null], runs: 2 });
    expect(spawned).toHaveLength(2);
    p.stop();
    expect(await p.compile(files)).toEqual({ outcomes: [undefined], runs: 0 });
    expect(spawned.at(-1)!.killed).toBe(true);
  });

  it('keep what the workers that answered said when another fails, and compile only its share here', async () => {
    const broken = withCard(BROKEN);
    const kinds = ['answer', 'crash', 'answer'] as const;
    const workers: FakeWorker[] = [];
    const p = createCompilePool(() => {
      const w = new FakeWorker(kinds[workers.length % kinds.length]);
      workers.push(w);
      return w;
    }, { size: 3, idleMs: 60_000 });
    const [got, here] = await counted(() => compileProject(broken, undefined, { offload: (files) => p.compile(files) }));
    expect(got).toEqual(await compileProject(broken));
    // Only the crashed worker's files were compiled here: two builds each, one for the broken card if it was among them.
    const lost = workers[1].batches[0];
    const brokenLost = lost.some(([, source]) => source === BROKEN);
    expect(here).toBe(2 * lost.length - (brokenLost ? 1 : 0));
    p.stop();
  });

  it('end each worker once it has been idle, while the first goes on taking the small checks', async () => {
    vi.useFakeTimers();
    try {
      const { p, workers } = pool('answer', 3, {});
      const many = Array.from({ length: 3 * FILES_PER_WORKER }, (_, i): [string, string] => [`src/f${i}.svelte`, `<p>${i}</p>\n`]);
      const big = p.compile(many);
      await vi.advanceTimersByTimeAsync(10);
      await big;
      expect(workers).toHaveLength(3);
      // A one-file check every 40 s keeps the first worker; the other two end 60 s after their last batch.
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(40_000);
        const small = p.compile([['src/one.svelte', `<p>${i}</p>\n`]]);
        await vi.advanceTimersByTimeAsync(10);
        await small;
      }
      expect(workers.map((w) => w.killed)).toEqual([false, true, true]);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(workers.map((w) => w.killed)).toEqual([true, true, true]);
      p.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a failure of the compiler itself (#975)', () => {
  it('is reported like any failure, but never kept, so the next check compiles the file again', async () => {
    const overflow = (() => {
      throw new RangeError('Maximum call stack size exceeded');
    }) as unknown as typeof compile;
    const failure = compileFile(overflow, 'src/deep.svelte', '<div></div>\n');
    expect(failure).toEqual({ message: 'Maximum call stack size exceeded', unexpected: true });
    const cache = new CompileCache();
    cache.set('src/deep.svelte', '<div></div>\n', failure);
    expect(cache.get('src/deep.svelte', '<div></div>\n')).toBeUndefined();
    // Not even an earlier outcome of the file survives it.
    cache.set('src/deep.svelte', '<div></div>\n', null);
    cache.set('src/deep.svelte', '<div></div>\n', failure);
    expect(cache.get('src/deep.svelte', '<div></div>\n')).toBeUndefined();
    // A fault the compiler found in the source is kept.
    const real = compileFile(elsewhere, 'src/a.svelte', BROKEN);
    expect(real && 'unexpected' in real).toBe(false);
    cache.set('src/a.svelte', BROKEN, real);
    expect(cache.get('src/a.svelte', BROKEN)).toEqual(real);
  });

  it('once it fails a file in a worker, the next check compiles the file again and passes it', async () => {
    const cache = new CompileCache();
    let failOnce = true;
    const offload = async (files: Array<[string, string]>) => {
      const outcomes = files.map(([path, source]) => (failOnce && path === 'src/routes/+page.svelte' ? { message: 'Maximum call stack size exceeded', unexpected: true as const } : compileFile(elsewhere, path, source)));
      failOnce = false;
      return { outcomes, runs: 0 };
    };
    const first = await compileProject(made.state, undefined, { cache, offload });
    expect(first.map((d) => d.message)).toEqual([expect.stringContaining('Maximum call stack size exceeded')]);
    const [again, here] = await counted(() => compileProject(made.state, undefined, { cache }));
    expect(again).toEqual([]);
    expect(here).toBe(2);
  });
});
