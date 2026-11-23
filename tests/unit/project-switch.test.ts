/**
 * Switching projects keeps the one open now until its replacement is ready (#80): a project that cannot be read, or
 * a new project that is cancelled or fails, leaves the current project open, locked and previewing as it was.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for Electron's utility process that starts at once and exits when asked to stop. */
class FakeWorker extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exited = false;
  constructor(public cwd: string) {
    super();
  }
  postMessage(m: { type: string }) {
    if (m.type === 'start') queueMicrotask(() => this.emit('message', { type: 'ready', url: 'http://127.0.0.1:1' }));
    if (m.type === 'stop') this.kill();
  }
  kill() {
    if (this.exited) return true;
    this.exited = true;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

const env = vi.hoisted(() => ({ userData: '', prepare: null as null | ((dir: string, signal?: AbortSignal) => Promise<void>) }));
const workers: FakeWorker[] = [];
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  utilityProcess: {
    fork: (_path: string, _args: string[], opts: { cwd: string }) => {
      const w = new FakeWorker(opts.cwd);
      workers.push(w);
      return w;
    }
  }
}));

// Setting up a new project's website tools runs npm; here it finishes at once, or when a test lets it.
vi.mock('../../src/main/runtime/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/runtime/manager')>();
  return {
    ...real,
    prepareDependencies: async (dir: string, _onLine: unknown, signal?: AbortSignal, mayWrite?: () => Promise<boolean>) => {
      if (mayWrite && !(await mayWrite())) throw new Error('Cancelled');
      await env.prepare?.(dir, signal);
      if (signal?.aborted) throw new Error('Cancelled');
    }
  };
});

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { sha } = await import('../../src/main/project/fsutil');

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-switch-${name}-`)));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  env.userData = temp('userdata');
  env.prepare = null;
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  workers.splice(0);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A project with its website tools in place, as the app leaves it once the preview has run. */
async function makeProject(name: string): Promise<string> {
  const dir = temp(name);
  const created = await ProjectSession.create(dir, createStarterState('blank', name, false));
  await created.close();
  const pkg = '{"name":"site","type":"module"}';
  writeFileSync(join(dir, 'package.json'), pkg);
  writeFileSync(join(dir, 'vite.config.js'), 'export default {};');
  mkdirSync(join(dir, 'node_modules/@sveltejs/kit'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/@sveltejs/kit/package.json'), '{"name":"@sveltejs/kit"}');
  mkdirSync(join(dir, 'node_modules/.bin'));
  symlinkSync('../@sveltejs/kit/package.json', join(dir, 'node_modules/.bin/kit'));
  writeFileSync(join(dir, '.siteorigin/cache/deps.json'), JSON.stringify({ lockHash: sha('' + pkg), preparedAt: '2026-01-01T00:00:00.000Z' }));
  return dir;
}

function controller() {
  const c = new Controller(() => null);
  const sent: Array<[string, unknown]> = [];
  c.send = (channel: string, payload?: unknown) => void sent.push([channel, payload]);
  controllers.push(c);
  return { c, sent };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

const lockOf = (dir: string) => JSON.parse(readFileSync(join(dir, '.siteorigin/lock.json'), 'utf8')) as { token: string };
const closedCount = (sent: Array<[string, unknown]>) => sent.filter(([ch]) => ch === 'project:closed').length;

/** Open `dir` as the current project, with its preview running. */
async function openCurrent(c: InstanceType<typeof Controller>, dir: string) {
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
  return { session: c.session!, lock: lockOf(dir).token, worker: workers.at(-1)! };
}

describe('opening a project that cannot be read while another is open', () => {
  it('keeps the current project open, locked and previewing, and names the broken file', async () => {
    const current = await makeProject('current');
    const broken = await makeProject('broken');
    const manifest = join(broken, 'siteorigin.project.json');
    writeFileSync(manifest, '{"schemaVersion": 1, "projectId": "abc", "name": "Half a sit');
    const { c, sent } = controller();
    const open = await openCurrent(c, current);
    sent.splice(0);

    // Not yet trusted (the trust prompt's own check), trusting it, and opening it once trusted (the recent-project
    // path) all fail the same way, without a trust prompt.
    for (const attempt of [() => c.open(broken), () => c.trustAndOpen(broken), () => c.open(broken)]) {
      const r = await attempt();
      expect(r.ok).toBe(false);
      expect('needsTrust' in r && r.needsTrust).toBeFalsy();
      expect(r.message).toContain('siteorigin.project.json');
      expect(r.message).toContain(broken);
      expect(c.session).toBe(open.session);
      expect(c.snapshot()?.dir).toBe(current);
      expect(lockOf(current).token).toBe(open.lock);
      expect(open.worker.exited).toBe(false);
      expect(closedCount(sent)).toBe(0);
    }
    // Nothing was written into the folder that could not be opened, and no lock was left behind in it.
    expect(readFileSync(manifest, 'utf8')).toBe('{"schemaVersion": 1, "projectId": "abc", "name": "Half a sit');
    expect(existsSync(join(broken, '.siteorigin/lock.json'))).toBe(false);
  });

  it('switches once the replacement has opened: the old project closes, then the new one is shown', async () => {
    const current = await makeProject('current');
    const next = await makeProject('next');
    const { c, sent } = controller();
    const open = await openCurrent(c, current);
    sent.splice(0);
    expect((await c.trustAndOpen(next)).ok).toBe(true);
    expect(c.session?.dir).toBe(next);
    expect(c.session).not.toBe(open.session);
    expect(open.worker.exited).toBe(true);
    expect(existsSync(join(current, '.siteorigin/lock.json'))).toBe(false);
    expect(closedCount(sent)).toBe(1);
    // The new project is announced only after the old one closed, so the editor never mixes the two.
    const closedAt = sent.findIndex(([ch]) => ch === 'project:closed');
    const changedAt = sent.findIndex(([ch, p]) => ch === 'project:changed' && (p as { dir: string }).dir === next);
    expect(changedAt).toBeGreaterThan(closedAt);
    // The editor let go of the old preview before it was stopped.
    const idleAt = sent.findIndex(([ch, p]) => ch === 'runtime:status' && (p as { state: string }).state === 'idle');
    expect(idleAt).toBeGreaterThan(-1);
    expect(idleAt).toBeLessThan(closedAt);
    expect(sent.slice(0, closedAt).some(([ch, p]) => ch === 'project:changed' && (p as { dir: string }).dir === next)).toBe(false);
  });

  it('reopens the folder that is already open without locking itself out', async () => {
    const current = await makeProject('current');
    const { c } = controller();
    const open = await openCurrent(c, current);
    const key = c.snapshot()?.workspaceKey;
    expect((await c.open(current)).ok).toBe(true);
    expect(c.session?.dir).toBe(current);
    expect(c.session).not.toBe(open.session);
    expect(c.snapshot()?.workspaceKey).not.toBe(key);
    expect(c.session?.readOnly).toBeFalsy();
  });

  it('keeps the open project when its own manifest was damaged and it is chosen again', async () => {
    const current = await makeProject('current');
    const { c, sent } = controller();
    const open = await openCurrent(c, current);
    sent.splice(0);
    writeFileSync(join(current, 'siteorigin.project.json'), '{"schemaVersion": 1, "proj');
    const r = await c.open(current);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('siteorigin.project.json');
    expect(c.session).toBe(open.session);
    expect(closedCount(sent)).toBe(0);
  });

  it('opens a project whose preview setup record is damaged, setting its tools up again', async () => {
    const current = await makeProject('current');
    const next = await makeProject('next');
    writeFileSync(join(next, '.siteorigin/cache/deps.json'), '{"lockHash": "ab');
    const { c } = controller();
    await openCurrent(c, current);
    expect((await c.trustAndOpen(next)).ok).toBe(true);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the new project’s preview');
    expect(c.session?.dir).toBe(next);
  });

  it('lets one switch at a time close the open project: another arriving meanwhile is turned away, its project let go', async () => {
    const current = await makeProject('current');
    const next = await makeProject('next');
    const other = await makeProject('other');
    const { c } = controller();
    await openCurrent(c, current);
    // Hold the open project's close part way, after the switch has begun it.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let closing!: () => void;
    const closingStarted = new Promise<void>((r) => (closing = r));
    c.onSessionClosing = async () => {
      closing();
      await held;
    };
    const first = c.trustAndOpen(next);
    await closingStarted;
    const second = await c.trustAndOpen(other);
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/Another project is opening/);
    expect(existsSync(join(other, '.siteorigin/lock.json'))).toBe(false);
    release();
    expect((await first).ok).toBe(true);
    expect(c.session?.dir).toBe(next);
    c.onSessionClosing = null;
  });

  it('tells the editor the open project closed even when putting it away fails at the end', async () => {
    const current = await makeProject('current');
    const next = await makeProject('next');
    const { c, sent } = controller();
    const open = await openCurrent(c, current);
    sent.splice(0);
    vi.spyOn(open.session, 'close').mockRejectedValueOnce(new Error('The disk went away.'));
    expect((await c.trustAndOpen(next)).ok).toBe(true);
    expect(c.session?.dir).toBe(next);
    const closedAt = sent.findIndex(([ch]) => ch === 'project:closed');
    const shownAt = sent.findIndex(([ch, p]) => ch === 'project:changed' && (p as { dir: string }).dir === next);
    expect(closedAt).toBeGreaterThan(-1);
    expect(shownAt).toBeGreaterThan(closedAt);
    await open.session.close();
  });
});

/** Hold the new project's setup (only that one) until the test lets it finish. */
function holdSetup() {
  let release!: () => void;
  const started = new Promise<string>((resolve) => {
    env.prepare = (dir, signal) =>
      new Promise<void>((done) => {
        env.prepare = null;
        resolve(dir);
        release = done;
        signal?.addEventListener('abort', () => done());
      });
  });
  return { started, release: () => release() };
}

const orchid = (parentDir: string) => ({ name: 'Orchid Garden', parentDir, starter: 'blank' as const, sampleImages: false });

describe('a new project made while another is open', () => {
  it('is built beside the open project, which closes only when the new one is shown', async () => {
    const current = await makeProject('current');
    const parent = temp('parent');
    const { c, sent } = controller();
    const open = await openCurrent(c, current);
    sent.splice(0);
    const setup = holdSetup();
    const created = c.create({ ...orchid(parent), attempt: 'attempt-1' });
    const dir = await setup.started;
    // Setting up: the open project is untouched (still locked by this app), and the new one is already locked too.
    expect(c.session).toBe(open.session);
    expect(lockOf(current).token).toBe(open.lock);
    expect(open.worker.exited).toBe(false);
    expect(closedCount(sent)).toBe(0);
    expect(existsSync(join(dir, '.siteorigin/lock.json'))).toBe(true);
    setup.release();
    expect(await created).toEqual({ ok: true });
    expect(c.session?.dir).toBe(dir);
    expect(open.worker.exited).toBe(true);
    expect(existsSync(join(current, '.siteorigin/lock.json'))).toBe(false);
    const closedAt = sent.findIndex(([ch]) => ch === 'project:closed');
    const shownAt = sent.findIndex(([ch, p]) => ch === 'project:changed' && (p as { dir: string }).dir === dir);
    expect(closedAt).toBeGreaterThan(-1);
    expect(shownAt).toBeGreaterThan(closedAt);
    // Every step names the attempt it is about, so only its own dialog follows it.
    const steps = sent.filter(([ch]) => ch === 'create:progress').map(([, p]) => p as { attempt?: string });
    expect(steps.length).toBeGreaterThan(2);
    expect(steps.every((p) => p.attempt === 'attempt-1')).toBe(true);
    // Cancel ends (the dialog's last step starts) before the open project starts closing, not after.
    const committedAt = sent.findIndex(([ch, p]) => ch === 'create:progress' && (p as { step: string }).step === 'preview');
    expect(committedAt).toBeGreaterThan(-1);
    expect(committedAt).toBeLessThan(closedAt);
  });

  it('asks before setting anything up, and keeping editing then makes nothing', async () => {
    const current = await makeProject('current');
    const parent = temp('parent');
    const { c, sent } = controller();
    const open = await openCurrent(c, current);
    sent.splice(0);
    let asked = 0;
    c.beforeLeave = async () => (asked++, false);
    env.prepare = async () => {
      throw new Error('nothing may be set up');
    };
    expect(await c.create(orchid(parent))).toEqual({ ok: false });
    expect(asked).toBe(1);
    expect(existsSync(join(parent, 'orchid-garden'))).toBe(false);
    expect(sent.some(([ch]) => ch === 'create:progress')).toBe(false);
    expect(c.session).toBe(open.session);
  });

  it('asks again at the switch, and keeping editing then removes the new project and keeps the open one', async () => {
    const current = await makeProject('current');
    const parent = temp('parent');
    const { c, sent } = controller();
    const open = await openCurrent(c, current);
    sent.splice(0);
    const answers = [true, false];
    let asked = 0;
    c.beforeLeave = async () => answers[asked++];
    const closes = vi.spyOn(ProjectSession.prototype, 'close');
    const setup = holdSetup();
    const created = c.create(orchid(parent));
    await setup.started;
    // Once before anything was set up, and not again until the new project is ready.
    expect(asked).toBe(1);
    setup.release();
    const r = await created;
    expect(r).toEqual({ ok: false });
    expect(asked).toBe(2);
    expect(c.session).toBe(open.session);
    expect(open.worker.exited).toBe(false);
    expect(closedCount(sent)).toBe(0);
    expect(existsSync(join(parent, 'orchid-garden'))).toBe(false);
    // The new project's own session let its lock go (its heartbeat stops with it) before its folder was removed.
    expect(closes.mock.contexts.some((s) => (s as InstanceType<typeof ProjectSession>).dir === join(parent, 'orchid-garden'))).toBe(true);
    closes.mockRestore();
  });

  it('is removed, and never shown, when the open project closes meanwhile (quitting)', async () => {
    const current = await makeProject('current');
    const parent = temp('parent');
    const { c, sent } = controller();
    await openCurrent(c, current);
    sent.splice(0);
    const setup = holdSetup();
    const created = c.create(orchid(parent));
    const dir = await setup.started;
    // As quitting does: the open project is closed while the new one is still being set up.
    await c.close();
    setup.release();
    expect((await created).ok).toBe(false);
    expect(c.session).toBeNull();
    expect(existsSync(dir)).toBe(false);
    expect(sent.some(([ch, p]) => ch === 'project:changed' && (p as { dir: string }).dir === dir)).toBe(false);
  });

  it('is called off by a cancel made while the open project is asked about at the switch', async () => {
    const current = await makeProject('current');
    const parent = temp('parent');
    const { c, sent } = controller();
    const open = await openCurrent(c, current);
    sent.splice(0);
    let asked = 0;
    c.beforeLeave = async () => {
      if (++asked === 2) c.cancelCreate();
      return true;
    };
    const r = await c.create(orchid(parent));
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/^Cancelled/) });
    expect(asked).toBe(2);
    expect(c.session).toBe(open.session);
    expect(closedCount(sent)).toBe(0);
    expect(existsSync(join(parent, 'orchid-garden'))).toBe(false);
  });

  it('is rolled back when another app takes it over while the open project closes for it, and later switches still work', async () => {
    const current = await makeProject('current');
    const next = await makeProject('next');
    const parent = temp('parent');
    const { c } = controller();
    await openCurrent(c, current);
    const made: InstanceType<typeof ProjectSession>[] = [];
    const create = ProjectSession.create.bind(ProjectSession);
    const spy = vi.spyOn(ProjectSession, 'create').mockImplementation(async (...args) => {
      const s = await create(...args);
      made.push(s);
      return s;
    });
    // The takeover is seen while the open project is being closed for the new one.
    c.onSessionClosing = async () => void made[0]?.emit('lock-lost');
    const r = await c.create(orchid(parent));
    spy.mockRestore();
    c.onSessionClosing = null;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Another app opened the new project/);
    expect(c.session).toBeNull();
    // The handover it began is over: the next switch is not turned away.
    expect((await c.trustAndOpen(next)).ok).toBe(true);
    expect(c.session?.dir).toBe(next);
  });

  it('is never shown once the app is quitting', async () => {
    const current = await makeProject('current');
    const parent = temp('parent');
    const { c, sent } = controller();
    const open = await openCurrent(c, current);
    sent.splice(0);
    const setup = holdSetup();
    const created = c.create(orchid(parent));
    const dir = await setup.started;
    c.quitting = true;
    setup.release();
    expect((await created).ok).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(c.session).toBe(open.session);
    expect(closedCount(sent)).toBe(0);
    c.quitting = false;
  });

  it('is called off with every other one being set up when the app quits, which waits until all have gone', async () => {
    const current = await makeProject('current');
    const parent = temp('parent');
    const { c } = controller();
    const open = await openCurrent(c, current);
    const started: string[] = [];
    // Each install runs until it is called off.
    env.prepare = (dir, signal) =>
      new Promise<void>((done) => {
        started.push(dir);
        signal?.addEventListener('abort', () => done());
      });
    const first = c.create(orchid(parent));
    const second = c.create({ ...orchid(parent), name: 'Second Garden' });
    await until(() => started.length === 2, 'both installs');
    await c.stopCreating();
    expect(c.isCreating).toBe(false);
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
    expect(c.session).toBe(open.session);
  });
});

describe('a new project that is cancelled while another is open', () => {
  it('keeps the current project open and removes only the folder it started', async () => {
    const current = await makeProject('current');
    const parent = temp('parent');
    const { c, sent } = controller();
    const open = await openCurrent(c, current);
    sent.splice(0);
    // Cancel as soon as the new project's files are being prepared.
    const send = c.send.bind(c);
    c.send = (channel: string, payload?: unknown) => {
      send(channel, payload);
      if (channel === 'create:progress' && (payload as { step: string }).step === 'files') c.cancelCreate();
    };
    const r = await c.create({ name: 'Orchid Garden', parentDir: parent, starter: 'blank', sampleImages: false });
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/^Cancelled/) });
    // Nothing is left behind, not even the folder moved aside to be removed.
    expect(readdirSync(parent)).toEqual([]);
    // A folder that was already there (empty) is the author's: cancelling leaves it.
    mkdirSync(join(parent, 'orchid-garden'));
    expect((await c.create({ name: 'Orchid Garden', parentDir: parent, starter: 'blank', sampleImages: false })).ok).toBe(false);
    expect(existsSync(join(parent, 'orchid-garden'))).toBe(true);
    expect(c.session).toBe(open.session);
    expect(lockOf(current).token).toBe(open.lock);
    expect(open.worker.exited).toBe(false);
    expect(closedCount(sent)).toBe(0);
  });
});
