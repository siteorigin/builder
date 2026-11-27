/**
 * With its last window closed (macOS keeps the app running without one), an open project's preview server stops and
 * the project stays open: its lock held, its folder watched. A window brought up again starts the preview while its
 * editor loads. A live session's guests keep it running until the session ends (#1036).
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
// A preview server that is ready once started (or fails, when the test says so), and says whether it was stopped; its
// stop can be held open by the test.
const servers = vi.hoisted(() => [] as Array<{ stopped: boolean; started: boolean; dir: string }>);
const behaviour = vi.hoisted(() => ({ fail: false, stopping: null as Promise<void> | null, finish: () => {}, starting: null as Promise<void> | null }));
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
    started = false;
    exited = Promise.resolve();
    private statusFns: Array<(s: unknown) => void> = [];
    constructor(readonly dir: string) {
      servers.push(this);
    }
    onStatus(fn: (s: unknown) => void) {
      this.statusFns.push(fn);
    }
    onPublished() {}
    onGone() {}
    notifyRevision() {}
    async hold() {
      return () => {};
    }
    async start() {
      this.started = true;
      if (behaviour.starting) {
        // A start held by the test: starting until it lets it go (and fails, when it says so).
        this.status = { state: 'starting' };
        for (const fn of this.statusFns) fn(this.status);
        await behaviour.starting;
      }
      this.status = behaviour.fail ? { state: 'error', message: 'The preview could not start.' } as never : { state: 'ready', url: 'http://127.0.0.1:9' };
      this.url = this.status.url ?? null;
      for (const fn of this.statusFns) fn(this.status);
    }
    async stop() {
      this.stopped = true;
      await behaviour.stopping;
      // As the real server: idle once its process has gone.
      this.status = { state: 'idle' };
      for (const fn of this.statusFns) fn(this.status);
    }
  }
}));

const { Controller } = await import('../../src/main/controller');

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];

afterEach(async () => {
  // A stop a test held open ends, so closing never waits on it.
  behaviour.finish();
  behaviour.stopping = null;
  behaviour.starting = null;
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  servers.splice(0);
  behaviour.fail = false;
  behaviour.stopping = null;
});

const until = async (what: () => boolean) => {
  for (let i = 0; i < 300 && !what(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(what()).toBe(true);
};
/** Long enough for the preview work queued now to have run. */
const queued = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
};

/** What the controller sent the editor's window, when the test gives it one. */
const sent: Array<[string, unknown]> = [];
const editor = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => void sent.push([channel, payload]) } };
const lastStatus = () => sent.filter(([channel]) => channel === 'runtime:status').at(-1)?.[1];

async function opened(state = 'ready', withWindow = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'so-no-window-')));
  dirs.push(parent);
  sent.length = 0;
  const c = new Controller(() => (withWindow ? (editor as never) : null));
  controllers.push(c);
  expect(await c.create({ name: 'Harbour Lights', parentDir: parent, starter: 'blank', sampleImages: false })).toEqual({ ok: true });
  await until(() => servers.length === 1 && c.snapshot()?.runtime.state === state);
  return c;
}

describe('an open project with no window', () => {
  it('stops its preview when the last window closes, keeps the project open and locked, and starts it again for the next window', async () => {
    const c = await opened();
    const session = c.session!;
    const opening = c.snapshot()!.workspaceKey;
    c.windowClosed();
    await until(() => servers[0].stopped);
    expect(c.session).toBe(session);
    expect(await session.stillOwner()).toBe(true);
    expect(c.snapshot()?.runtime.state).toBe('idle');
    // The window brought up again is told the preview is starting, never that it is paused, and gets a new server.
    c.windowOpened();
    expect(c.snapshot()?.runtime.state).toBe('starting');
    await until(() => servers.length === 2 && c.snapshot()?.runtime.state === 'ready');
    expect(servers[1].stopped).toBe(false);
    expect(c.snapshot()?.workspaceKey).toBe(opening);
    // Another window coming up while this one is open starts nothing more.
    c.windowOpened();
    await queued();
    expect(servers).toHaveLength(2);
  });

  it('starts the preview for a window brought up while the stop is still under way', async () => {
    const c = await opened();
    let finish!: () => void;
    behaviour.stopping = new Promise<void>((r) => (finish = behaviour.finish = r));
    c.windowClosed();
    await until(() => servers[0].stopped);
    c.windowOpened();
    await queued();
    // Its start waits its turn behind the stop, then comes.
    expect(servers).toHaveLength(1);
    expect(c.snapshot()?.runtime.state).toBe('starting');
    finish();
    behaviour.stopping = null;
    await until(() => servers.length === 2 && c.snapshot()?.runtime.state === 'ready');
  });

  it('keeps the preview of a window brought up before the stop had its turn', async () => {
    const c = await opened();
    c.windowClosed();
    c.windowOpened();
    await queued();
    expect(servers).toHaveLength(1);
    expect(servers[0].stopped).toBe(false);
    expect(c.snapshot()?.runtime.state).toBe('ready');
  });

  it('starts no preview with no window open, whatever asks for one, until a window shows the project', async () => {
    const c = await opened();
    c.windowClosed();
    await until(() => servers[0].stopped);
    // A restart asked for with no window (as a takeover asks for a copy's preview) waits for the window.
    await c.startRuntime();
    expect(servers).toHaveLength(1);
    expect(c.snapshot()?.runtime.state).toBe('idle');
    c.windowOpened();
    await until(() => servers.length === 2 && c.snapshot()?.runtime.state === 'ready');
  });

  it('keeps serving a live session’s guests with no window, and stops once the session ends', async () => {
    const c = await opened();
    let hosting = true;
    Object.defineProperty(c.live, 'running', { get: () => hosting });
    c.windowClosed();
    await queued();
    expect(servers[0].stopped).toBe(false);
    expect(c.snapshot()?.runtime.state).toBe('ready');
    // The session ends: the host tells the editor (there is none), and nobody is left to see the preview.
    hosting = false;
    (c.live as unknown as { ctx: { emit(channel: string, payload: unknown): void } }).ctx.emit('live:state', { phase: 'idle', lastError: null });
    await until(() => servers[0].stopped);
  });

  it('stops the process of a preview that failed, and keeps its error for the window that comes back', async () => {
    behaviour.fail = true;
    const c = await opened('error');
    behaviour.fail = false;
    c.windowClosed();
    await until(() => servers[0].stopped);
    c.windowOpened();
    await queued();
    // No start the author did not ask for: the error is still what the window shows, with its Try again.
    expect(servers).toHaveLength(1);
    expect(c.snapshot()?.runtime).toEqual({ state: 'error', message: 'The preview could not start.' });
  });

  it('keeps the error of a preview that failed while its stop for the closed window waited its turn', async () => {
    const c = await opened();
    // Try again, with the window then closed while the new server is starting; it fails after.
    let release!: () => void;
    behaviour.starting = new Promise<void>((r) => (release = r));
    behaviour.fail = true;
    const retry = c.startRuntime();
    await until(() => servers.length === 2 && c.snapshot()?.runtime.state === 'starting');
    c.windowClosed();
    release();
    await retry;
    await until(() => servers[1].stopped);
    expect(c.snapshot()?.runtime).toEqual({ state: 'error', message: 'The preview could not start.' });
    behaviour.fail = false;
    behaviour.starting = null;
    c.windowOpened();
    await queued();
    expect(servers).toHaveLength(2);
    expect(c.snapshot()?.runtime.state).toBe('error');
  });

  it('tells a window that came up while a failed preview was put away its error, not that it is paused', async () => {
    behaviour.fail = true;
    const c = await opened('error', true);
    behaviour.fail = false;
    let finish!: () => void;
    behaviour.stopping = new Promise<void>((r) => (finish = behaviour.finish = r));
    c.windowClosed();
    await until(() => servers[0].stopped);
    c.windowOpened();
    finish();
    await queued();
    expect(lastStatus()).toEqual({ state: 'error', message: 'The preview could not start.' });
    expect(servers).toHaveLength(1);
  });

  it('tells a window a start after the rest ended with no server, never leaving it on starting', async () => {
    const c = await opened('ready', true);
    c.windowClosed();
    await until(() => servers[0].stopped);
    const landed = await c.session!.previewHold!();
    c.windowOpened();
    // The window is told it is starting (its first snapshot); what it is told after that is what counts.
    expect(c.snapshot()?.runtime.state).toBe('starting');
    sent.length = 0;
    await new Promise((r) => setTimeout(r, 300));
    // The lock cannot be read as this app's when the save has landed: the start ends with no server.
    vi.spyOn(c.session!, 'stillOwner').mockResolvedValue(false);
    landed([]);
    await queued();
    expect(servers).toHaveLength(1);
    expect(lastStatus()).toEqual({ state: 'idle' });
  });

  it('never tells a window brought up during the stop that the preview is paused', async () => {
    const c = await opened('ready', true);
    let finish!: () => void;
    behaviour.stopping = new Promise<void>((r) => (finish = behaviour.finish = r));
    c.windowClosed();
    await until(() => servers[0].stopped);
    c.windowOpened();
    sent.length = 0;
    finish();
    await until(() => servers.length === 2 && c.snapshot()?.runtime.state === 'ready');
    const told = sent.filter(([channel]) => channel === 'runtime:status').map(([, s]) => (s as { state: string }).state);
    expect(told).not.toContain('idle');
    expect(told.at(-1)).toBe('ready');
  });

  it('starts nothing for a window closed again before the start it brought had forked', async () => {
    const c = await opened();
    c.windowClosed();
    await until(() => servers[0].stopped);
    // Closed at once, before the start had its turn.
    c.windowOpened();
    c.windowClosed();
    await queued();
    expect(servers).toHaveLength(1);
    // And closed while the start was past its checks, waiting at the fork (here for a save to land).
    const landed = await c.session!.previewHold!();
    c.windowOpened();
    await new Promise((r) => setTimeout(r, 300));
    c.windowClosed();
    landed([]);
    await queued();
    expect(servers).toHaveLength(1);
    expect(c.snapshot()?.runtime.state).toBe('idle');
    // The next window starts it.
    c.windowOpened();
    await until(() => servers.length === 2 && c.snapshot()?.runtime.state === 'ready');
  });

  it('leaves the exported websites’ previews running with no window', async () => {
    const c = await opened();
    const previews = (c as unknown as { previews: { stopAll(): void; stop(url: string): void } }).previews;
    const stopAll = vi.spyOn(previews, 'stopAll');
    const stop = vi.spyOn(previews, 'stop');
    c.windowClosed();
    await until(() => servers[0].stopped);
    c.windowOpened();
    await until(() => servers.length === 2);
    expect([stopAll.mock.calls.length, stop.mock.calls.length]).toEqual([0, 0]);
  });

  it('starts a fresh server only once a save held by the server before it has landed its files', async () => {
    const c = await opened();
    // An outside change lands its files under the running server's hold; the window closes and comes back meanwhile.
    const landed = await c.session!.previewHold!();
    c.windowClosed();
    await until(() => servers[0].stopped);
    c.windowOpened();
    await new Promise((r) => setTimeout(r, 500));
    expect(servers).toHaveLength(1);
    landed([]);
    await until(() => servers.length === 2 && c.snapshot()?.runtime.state === 'ready');
  });

  it('forks nothing in the folder when the project was taken over while a save was landing', async () => {
    const c = await opened();
    c.windowClosed();
    await until(() => servers[0].stopped);
    const landed = await c.session!.previewHold!();
    c.windowOpened();
    await new Promise((r) => setTimeout(r, 300));
    // Another app takes the project over before the files land: the lock is read again before any fork.
    vi.spyOn(c.session!, 'stillOwner').mockResolvedValue(false);
    landed([]);
    await queued();
    expect(servers.map((s) => s.dir)).toEqual([c.session!.dir]);
  });

  it('starts a fresh server only once a save that began with none running has landed its files', async () => {
    const c = await opened();
    c.windowClosed();
    await until(() => servers[0].stopped);
    await queued();
    // A change made outside the app while no window is open: its files land with no server to hold their updates.
    const landed = await c.session!.previewHold!();
    c.windowOpened();
    // Long past the start's checks: it waits for the files, not for them.
    await new Promise((r) => setTimeout(r, 500));
    expect(servers).toHaveLength(1);
    landed([]);
    await until(() => servers.length === 2 && c.snapshot()?.runtime.state === 'ready');
  });

  it('closes cleanly with its preview stopped, and a window after that starts nothing', async () => {
    const c = await opened();
    c.windowClosed();
    await until(() => servers[0].stopped);
    await c.close();
    expect(c.session).toBeNull();
    c.windowOpened();
    await queued();
    expect(servers).toHaveLength(1);
  });
});
