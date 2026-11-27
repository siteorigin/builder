/**
 * A page checked for the assistant is loaded once the preview has published the revision it is about (#976), rather
 * than after a fixed wait: at once when nothing was just written, as soon as the change's files are in the preview's
 * hands otherwise, and never later than its cap.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}));
vi.mock('../../src/main/settings', () => ({
  addRecent: async () => undefined,
  renameRecent: async () => undefined,
  isTrusted: async () => true,
  trust: async () => undefined,
  loadSettings: async () => ({ settings: { developerMode: false } })
}));
// A preview server that says it is ready when started, and publishes a revision only when the test says so: with the
// ticket of the last notification it was given, unless the test names an earlier one.
const servers = vi.hoisted(() => [] as Array<{ publish(revision: number, ticket?: number): void; notices: Array<[number, number]>; stopped: boolean }>);
vi.mock('../../src/main/runtime/manager', () => ({
  dependenciesReady: async () => true,
  prepareDependencies: async () => undefined,
  stageDependencies: () => ({ adopt: async () => undefined, discard: async () => undefined }),
  buildProject: async () => ({ ok: true, logs: [] }),
  DevServer: class {
    status: { state: string; url?: string } = { state: 'idle' };
    holding = false;
    url: string | null = null;
    stopped = false;
    private statusFns: Array<(s: unknown) => void> = [];
    private publishedFns: Array<(r: number, ticket: number) => void> = [];
    notices: Array<[number, number]> = [];
    constructor() {
      servers.push(this);
    }
    onStatus(fn: (s: unknown) => void) {
      this.statusFns.push(fn);
    }
    onPublished(fn: (r: number, ticket: number) => void) {
      this.publishedFns.push(fn);
    }
    onGone() {}
    notifyRevision(revision: number, ticket: number) {
      this.notices.push([revision, ticket]);
    }
    async hold() {
      return () => {};
    }
    publish(revision: number, ticket = this.notices.at(-1)?.[1] ?? 0) {
      for (const fn of this.publishedFns) fn(revision, ticket);
    }
    async start() {
      this.status = { state: 'ready', url: 'http://127.0.0.1:9' };
      this.url = this.status.url!;
      for (const fn of this.statusFns) fn(this.status);
    }
    async stop() {
      this.stopped = true;
    }
  }
}));

const { Controller } = await import('../../src/main/controller');

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  servers.splice(0);
});

async function opened() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'so-published-')));
  dirs.push(parent);
  const c = new Controller(() => null);
  controllers.push(c);
  expect(await c.create({ name: 'Kloof Light Studio', parentDir: parent, starter: 'blank', sampleImages: false })).toEqual({ ok: true });
  // The preview comes up serving the project as it is.
  for (let i = 0; i < 200 && !servers.length; i++) await new Promise((r) => setTimeout(r, 10));
  expect(servers).toHaveLength(1);
  for (let i = 0; i < 200 && c.snapshot()?.runtime.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 10));
  return c;
}

/** What `p` settled with by the time the queued work after it has run, or 'waiting'. */
async function settled(p: Promise<unknown>) {
  let done: unknown = 'waiting';
  void p.then((v) => (done = v));
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return done;
}

describe('waiting for the preview to publish a revision', () => {
  it('waits not at all for what the preview already serves, and until a change is published otherwise', async () => {
    const c = await opened();
    const at = c.session!.revision;
    expect(await settled(c.previewPublished(at, 60_000))).toBe(true);
    // A change the preview has not been handed yet is waited for, and the wait ends when it is published.
    const res = await c.apply({ operations: [{ type: 'site.update', name: 'Kloof Light' }] }, { label: 'Rename' });
    expect(res.ok).toBe(true);
    const next = c.session!.revision;
    expect(next).toBeGreaterThan(at);
    expect(servers[0].notices.at(-1)?.[0]).toBe(next);
    const waiting = c.previewPublished(next, 60_000);
    expect(await settled(waiting)).toBe('waiting');
    servers[0].publish(next - 1);
    expect(await settled(waiting)).toBe('waiting');
    servers[0].publish(next);
    expect(await settled(waiting)).toBe(true);
    expect(await settled(c.previewPublished(next, 60_000))).toBe(true);
  });

  it('waits for the change it was told of last, not only for its revision number', async () => {
    const c = await opened();
    await c.apply({ operations: [{ type: 'site.update', name: 'Kloof Light' }] }, { label: 'Rename' });
    const first = servers[0].notices.at(-1)!;
    servers[0].publish(first[0]);
    await c.apply({ operations: [{ type: 'site.update', name: 'Kloof Light Studio' }] }, { label: 'Rename again' });
    const second = servers[0].notices.at(-1)!;
    expect(second[1]).toBeGreaterThan(first[1]);
    // A publication of the revision carrying the earlier notification's number (the file put back at the same
    // revision, published before the second change reached Vite) is not the second change's.
    const waiting = c.previewPublished(second[0], 60_000);
    servers[0].publish(second[0], first[1]);
    expect(await settled(waiting)).toBe('waiting');
    servers[0].publish(second[0], second[1]);
    expect(await settled(waiting)).toBe(true);
  });

  it('says it was not published when its cap passes first, and stops waiting when the preview stops', async () => {
    const c = await opened();
    const ahead = c.session!.revision + 5;
    const started = Date.now();
    expect(await c.previewPublished(ahead, 50)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    const waiting = c.previewPublished(ahead, 60_000);
    expect(await settled(waiting)).toBe('waiting');
    await c.close();
    // No preview is running: nothing to wait for, and a page check then says so.
    expect(await settled(waiting)).toBe(true);
  });
});
