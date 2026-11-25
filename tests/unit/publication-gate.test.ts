import { AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicationGate, GATE_LIMITS, mergeHotPayloads } from '@runtime/publication-gate';

const ROOT = join('/project');
const abs = (rel: string) => join(ROOT, ...rel.split('/'));
const ignored = (p: string) => p.startsWith(join(ROOT, 'siteorigin')) || p.startsWith(join(ROOT, '.siteorigin'));

/**
 * A dev server as the gate sees Vite 8's: each watcher event for a file is worked on for a while (watchChange, the
 * plugins' hotUpdate hooks), then goes through `hotUpdateEnvironments`, whose `hmr(environment)` sends that file's
 * update to the environment at once. `delays` sets how long each file takes.
 */
function fakeVite(gate: ReturnType<typeof createPublicationGate>, delays: Record<string, number> = {}) {
  const watcher = new EventEmitter();
  const sent: Record<string, unknown[]> = { client: [], ssr: [] };
  const env = (name: string) => ({ name, hot: { send: (payload: unknown) => void sent[name].push(payload) } });
  const server = { watcher, environments: { client: env('client'), ssr: env('ssr') } };
  let t = 0;
  const onFile = (type: string) => (file: string) => {
    const timestamp = ++t;
    // Bound as Node's own timers are (fake ones are not): the work keeps the context the event was emitted in.
    setTimeout(AsyncResource.bind(() => {
      const hmr = async (environment: { name: string; hot: { send: (p: unknown) => void } }) => {
        if (type === 'unlink' && file.endsWith('.html')) return environment.hot.send({ type: 'full-reload', path: '*' });
        environment.hot.send({ type: 'update', updates: [{ type: 'js-update', path: file, acceptedPath: file, timestamp }] });
      };
      void gate.hotUpdateEnvironments(server, hmr as never);
    }), delays[file] ?? 5);
  };
  watcher.on('change', onFile('change'));
  watcher.on('add', onFile('add'));
  watcher.on('unlink', onFile('unlink'));
  gate.attach(server as never);
  /** What the page was sent: the files of each update message, in order. */
  const messages = (name = 'client') => sent[name].map((p) => ((p as { type: string }).type === 'update' ? (p as { updates: Array<{ path: string }> }).updates.map((u) => u.path) : (p as { type: string }).type));
  return { watcher, sent, messages };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('publication gate', () => {
  it('passes each file straight through when no batch is held', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate);
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    await vi.advanceTimersByTimeAsync(10);
    vite.watcher.emit('change', abs('src/routes/+page.svelte'));
    await vi.advanceTimersByTimeAsync(10);
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte')], [abs('src/routes/+page.svelte')]]);
    const ran = vi.fn();
    gate.afterBatch(ran);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('sends a held batch as one update, then what waited for it', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    // The page takes longer for Vite than the component: without the gate, they reach the page apart.
    const vite = fakeVite(gate, { [abs('src/routes/+page.svelte')]: 40, [abs('src/lib/A.svelte')]: 5 });
    const order: string[] = [];
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    vite.watcher.emit('add', abs('src/lib/B.svelte'));
    vite.watcher.emit('unlink', abs('src/lib/Old.svelte'));
    await vi.advanceTimersByTimeAsync(100);
    vite.watcher.emit('change', abs('src/routes/+page.svelte'));
    await vi.advanceTimersByTimeAsync(100);
    // Nothing reaches Vite, let alone the page, while the batch is landing.
    expect(vite.messages()).toEqual([]);
    gate.release('1', ['src/lib/A.svelte', 'src/lib/B.svelte', 'src/lib/Old.svelte', 'src/routes/+page.svelte', 'siteorigin/pages/home.json']);
    gate.afterBatch(() => order.push(`revision after ${vite.sent.client.length} message(s)`));
    await vi.advanceTimersByTimeAsync(5);
    expect(vite.messages()).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte'), abs('src/lib/B.svelte'), abs('src/lib/Old.svelte'), abs('src/routes/+page.svelte')]]);
    expect(vite.messages('ssr')).toHaveLength(1);
    expect(order).toEqual(['revision after 1 message(s)']);
  });

  it('waits for files the watcher reports after the batch was released', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate);
    const ran = vi.fn();
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    gate.release('1', ['src/lib/A.svelte', 'src/routes/+page.svelte']);
    gate.afterBatch(ran);
    await vi.advanceTimersByTimeAsync(200);
    // The page's file is on disk, but the watcher has not said so yet: the component alone must not go.
    expect(vite.messages()).toEqual([]);
    expect(ran).not.toHaveBeenCalled();
    vite.watcher.emit('change', abs('src/routes/+page.svelte'));
    await vi.advanceTimersByTimeAsync(10);
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte'), abs('src/routes/+page.svelte')]]);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('never lets an update already under way stand in for one of the batch', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate, { [abs('src/lib/X.svelte')]: 60, [abs('src/lib/A.svelte')]: 80 });
    // Saved in another editor just before the batch: Vite is still working on it when the batch is handed over.
    vite.watcher.emit('change', abs('src/lib/X.svelte'));
    await vi.advanceTimersByTimeAsync(10);
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    gate.release('1', ['src/lib/A.svelte']);
    await vi.advanceTimersByTimeAsync(60);
    // X's update arrived first, but A's has not: nothing goes yet.
    expect(vite.messages()).toEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    expect(vite.messages()).toEqual([[abs('src/lib/X.svelte'), abs('src/lib/A.svelte')]]);
  });

  it('reports a file the watcher never reported itself, so the batch still goes as one update', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate);
    const ran = vi.fn();
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    gate.release('1', ['src/lib/A.svelte', 'src/routes/+page.svelte']);
    gate.afterBatch(ran);
    await vi.advanceTimersByTimeAsync(GATE_LIMITS.settleMs - 10);
    expect(vite.messages()).toEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    // Vite reads the page's file again with the component's, as if the watcher had reported it.
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte'), abs('src/routes/+page.svelte')]]);
    expect(ran).toHaveBeenCalledOnce();
  });

  it('runs what waited at once when a batch changed no watched file', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate);
    const ran = vi.fn();
    gate.hold('1');
    gate.afterBatch(ran);
    expect(ran).not.toHaveBeenCalled();
    gate.release('1', ['siteorigin/site.json']);
    expect(ran).toHaveBeenCalledOnce();
    expect(vite.messages()).toEqual([]);
  });

  it('reloads the page when a file of the batch takes too long to reach its update', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate, { [abs('src/routes/+page.svelte')]: GATE_LIMITS.collectMs + 1000 });
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    vite.watcher.emit('change', abs('src/routes/+page.svelte'));
    gate.release('1', ['src/lib/A.svelte', 'src/routes/+page.svelte']);
    await vi.advanceTimersByTimeAsync(GATE_LIMITS.collectMs + 10);
    expect(vite.messages()).toEqual(['full-reload']);
    // Its update, when it comes, goes to a page that already has it.
    await vi.advanceTimersByTimeAsync(1000);
    expect(vite.messages()).toEqual(['full-reload', [abs('src/routes/+page.svelte')]]);
  });

  it('ends a hold that is never released', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate);
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    await vi.advanceTimersByTimeAsync(GATE_LIMITS.holdMs - 10);
    expect(vite.messages()).toEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    // The batch may still have been landing: the page loads what is on disk.
    expect(vite.messages()).toEqual(['full-reload']);
  });

  it('ignores a release it never held, and keeps holding for another open hold', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate);
    gate.release('stale', ['src/lib/A.svelte']);
    gate.hold('1');
    gate.hold('2');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    gate.release('1', ['src/lib/A.svelte']);
    await vi.advanceTimersByTimeAsync(50);
    expect(vite.messages()).toEqual([]);
    vite.watcher.emit('change', abs('src/lib/B.svelte'));
    gate.release('2', ['src/lib/B.svelte']);
    await vi.advanceTimersByTimeAsync(50);
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte'), abs('src/lib/B.svelte')]]);
  });

  it('keeps the next batch for its own update while the one before is still gathered', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate, { [abs('src/lib/A.svelte')]: 50 });
    const order: string[] = [];
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    gate.release('1', ['src/lib/A.svelte']);
    gate.afterBatch(() => order.push(`1 after ${vite.sent.client.length}`));
    await vi.advanceTimersByTimeAsync(10);
    gate.hold('2');
    vite.watcher.emit('change', abs('src/lib/B.svelte'));
    gate.release('2', ['src/lib/B.svelte']);
    gate.afterBatch(() => order.push(`2 after ${vite.sent.client.length}`));
    await vi.advanceTimersByTimeAsync(100);
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte')], [abs('src/lib/B.svelte')]]);
    expect(order).toEqual(['1 after 1', '2 after 2']);
  });

  it('sends a batch whose updates arrive while the next is landing together with that one', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate, { [abs('src/lib/A.svelte')]: 50 });
    const order: string[] = [];
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    gate.release('1', ['src/lib/A.svelte']);
    gate.afterBatch(() => order.push(`1 after ${vite.sent.client.length}`));
    await vi.advanceTimersByTimeAsync(10);
    // The next save is replacing its files when the first one's update is ready: the page must not fetch now.
    gate.hold('2');
    await vi.advanceTimersByTimeAsync(100);
    expect(vite.messages()).toEqual([]);
    expect(order).toEqual([]);
    vite.watcher.emit('change', abs('src/lib/B.svelte'));
    gate.release('2', ['src/lib/B.svelte']);
    gate.afterBatch(() => order.push(`2 after ${vite.sent.client.length}`));
    await vi.advanceTimersByTimeAsync(20);
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte'), abs('src/lib/B.svelte')]]);
    expect(order).toEqual(['1 after 1', '2 after 1']);
  });

  it('reports a missed file that is there as added, so what failed to import it is tried again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'so-gate-'));
    try {
      mkdirSync(join(root, 'src', 'lib'), { recursive: true });
      writeFileSync(join(root, 'src', 'lib', 'New.svelte'), '<p>new</p>');
      const gate = createPublicationGate({ root, ignored: () => false });
      const vite = fakeVite(gate);
      const reported: string[] = [];
      vite.watcher.on('all', (event: string, path: string) => reported.push(`${event} ${relative(root, path).split(sep).join('/')}`));
      gate.hold('1');
      gate.release('1', ['src/lib/New.svelte', 'src/lib/Gone.svelte']);
      await vi.advanceTimersByTimeAsync(GATE_LIMITS.settleMs + 20);
      expect(reported).toEqual(['add src/lib/New.svelte', 'unlink src/lib/Gone.svelte']);
      expect(vite.messages()).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sends the revision of a batch that changed nothing watched, released while the one before is gathered', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate, { [abs('src/lib/A.svelte')]: 50 });
    const order: string[] = [];
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    gate.release('1', ['src/lib/A.svelte']);
    gate.revision(() => order.push(`1 after ${vite.sent.client.length}`));
    await vi.advanceTimersByTimeAsync(10);
    gate.hold('2');
    gate.release('2', ['siteorigin/site.json']);
    gate.revision(() => order.push(`2 after ${vite.sent.client.length}`));
    await vi.advanceTimersByTimeAsync(100);
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte')]]);
    expect(order).toEqual(['1 after 1', '2 after 1']);
  });

  it('waits for a file a plugin reports while working on one of the batch', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate, { [abs('src/lib/dep.css')]: 60, [abs('src/lib/A.svelte')]: 5, [abs('src/routes/+page.svelte')]: 30 });
    // A preprocessor that read a stylesheet reports it changed while A is worked on.
    vite.watcher.on('change', (file: string) => {
      if (file === abs('src/lib/A.svelte')) vite.watcher.emit('change', abs('src/lib/dep.css'));
    });
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    vite.watcher.emit('change', abs('src/routes/+page.svelte'));
    gate.release('1', ['src/lib/A.svelte', 'src/routes/+page.svelte']);
    await vi.advanceTimersByTimeAsync(40);
    // The stylesheet's update has not come: the batch is not sent without it.
    expect(vite.messages()).toEqual([]);
    await vi.advanceTimersByTimeAsync(40);
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte'), abs('src/routes/+page.svelte'), abs('src/lib/dep.css')]]);
  });

  it('never opens a hold released before it was asked for', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate);
    gate.release('1', []);
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    await vi.advanceTimersByTimeAsync(10);
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte')]]);
  });

  it('lets a new batch go ahead once a page shows the one before, or none is open', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate);
    let pages = 1;
    const batches: number[] = [];
    const ready = vi.fn();
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    gate.release('1', ['src/lib/A.svelte']);
    gate.revision((batch) => batches.push(batch));
    void gate.caughtUp(600, () => pages).then(ready);
    await vi.advanceTimersByTimeAsync(100);
    // Sent, but the page is still fetching and applying it.
    expect(vite.messages()).toHaveLength(1);
    expect(batches).toEqual([1]);
    expect(ready).not.toHaveBeenCalled();
    gate.applied(1);
    await vi.advanceTimersByTimeAsync(GATE_LIMITS.pollMs);
    expect(ready).toHaveBeenCalledOnce();
    // The same revision sent again (a restored file) is a batch of its own: the page saying it showed the last one
    // does not cover it, and a page is waited for no longer than the cap.
    gate.revision((batch) => batches.push(batch));
    expect(batches).toEqual([1, 2]);
    gate.applied(1);
    gate.applied(7);
    const capped = vi.fn();
    void gate.caughtUp(600, () => pages).then(capped);
    await vi.advanceTimersByTimeAsync(590);
    expect(capped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(capped).toHaveBeenCalledOnce();
    // With no page open, nothing is waited for.
    pages = 0;
    const none = vi.fn();
    void gate.caughtUp(600, () => pages).then(none);
    await vi.advanceTimersByTimeAsync(0);
    expect(none).toHaveBeenCalledOnce();
  });

  it('sends an update Vite was working on when the batch was held with the batch, never during it', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate, { [abs('src/lib/X.svelte')]: 30 });
    vite.watcher.emit('change', abs('src/lib/X.svelte'));
    await vi.advanceTimersByTimeAsync(10);
    gate.hold('1');
    await vi.advanceTimersByTimeAsync(50);
    // X's update is ready while the batch's files are being replaced: the page must not fetch now.
    expect(vite.messages()).toEqual([]);
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    gate.release('1', ['src/lib/A.svelte']);
    await vi.advanceTimersByTimeAsync(20);
    expect(vite.messages()).toEqual([[abs('src/lib/X.svelte'), abs('src/lib/A.svelte')]]);
  });

  it('keeps waiting for a late file while the next batch is held, and never reloads for it', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate);
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    gate.release('1', ['src/lib/A.svelte', 'src/routes/+page.svelte']);
    await vi.advanceTimersByTimeAsync(100);
    gate.hold('2');
    // The first batch's deadline passes while the second is held; its late file is reported meanwhile.
    await vi.advanceTimersByTimeAsync(GATE_LIMITS.settleMs);
    vite.watcher.emit('change', abs('src/routes/+page.svelte'));
    vite.watcher.emit('change', abs('src/lib/B.svelte'));
    gate.release('2', ['src/lib/B.svelte']);
    await vi.advanceTimersByTimeAsync(20);
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte'), abs('src/routes/+page.svelte'), abs('src/lib/B.svelte')]]);
  });

  it('lets everything through when closed', async () => {
    const gate = createPublicationGate({ root: ROOT, ignored });
    const vite = fakeVite(gate);
    const ran = vi.fn();
    gate.hold('1');
    vite.watcher.emit('change', abs('src/lib/A.svelte'));
    gate.afterBatch(ran);
    gate.close();
    expect(ran).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    expect(vite.messages()).toEqual([[abs('src/lib/A.svelte')]]);
  });
});

describe('mergeHotPayloads', () => {
  const update = (path: string, timestamp: number, acceptedPath = path) => ({ type: 'js-update', path, acceptedPath, timestamp });
  it('puts every update in one message, each module once at its latest timestamp', () => {
    const merged = mergeHotPayloads([[{ type: 'update', updates: [update('/a', 1), update('/p', 1, '/a')] }], [{ type: 'update', updates: [{ ...update('/a', 2), isWithinCircularImport: false }, update('/b', 2)] }], [{ type: 'error', err: { message: 'x' } }]]);
    expect(merged).toEqual([[{ type: 'update', updates: [{ ...update('/a', 2), isWithinCircularImport: false }, update('/p', 1, '/a'), update('/b', 2)] }], [{ type: 'error', err: { message: 'x' } }]]);
    // A module inside a circular import for either file keeps that, so a failed import still reloads the page.
    expect(mergeHotPayloads([[{ type: 'update', updates: [{ ...update('/a', 1), isWithinCircularImport: true }] }], [{ type: 'update', updates: [update('/a', 2)] }]])).toEqual([[{ type: 'update', updates: [{ ...update('/a', 2), isWithinCircularImport: true }] }]]);
  });
  it('reloads every page once in place of everything when any file needs it', () => {
    expect(mergeHotPayloads([[{ type: 'update', updates: [update('/a', 1)] }], [{ type: 'full-reload', path: '/x.html' }], [{ type: 'full-reload', path: '*', triggeredBy: '/p/a.js' }], [{ type: 'full-reload', triggeredBy: '/p/b.js' }]])).toEqual([[{ type: 'full-reload', path: '*' }]]);
    expect(mergeHotPayloads([[{ type: 'full-reload', path: '*', triggeredBy: '/p/a.js' }]])).toEqual([[{ type: 'full-reload', path: '*', triggeredBy: '/p/a.js' }]]);
  });
  it('keeps a reload of one HTML page beside the updates, since other pages ignore it', () => {
    expect(mergeHotPayloads([[{ type: 'update', updates: [update('/a', 1)] }], [{ type: 'full-reload', path: '/src/app.html' }], [{ type: 'full-reload', path: '/src/app.html' }]])).toEqual([[{ type: 'update', updates: [update('/a', 1)] }], [{ type: 'full-reload', path: '/src/app.html' }]]);
  });
});
