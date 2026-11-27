/**
 * Switching projects keeps the one open now until its replacement is ready (#80): a project that cannot be read, or
 * a new project that is cancelled or fails, leaves the current project open, locked and previewing as it was.
 */
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { denyAccess } from './deny-access';
import { editorView } from './editor-feed';

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

const env = vi.hoisted(() => ({ userData: '', prepare: null as null | ((dir: string, signal?: AbortSignal) => Promise<void>), onFork: null as null | ((cwd: string) => void) }));
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
      env.onFork?.(opts.cwd);
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
      if (mayWrite && !(await mayWrite())) throw new Error('Canceled');
      await env.prepare?.(dir, signal);
      if (signal?.aborted) throw new Error('Canceled');
    }
  };
});

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { sha } = await import('../../src/main/project/fsutil');
const { addRecent, recents, saveSettings } = await import('../../src/main/settings');

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
  env.onFork = null;
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  workers.splice(0);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A project with its website tools in place, as the app leaves it once the preview has run. */
async function makeProject(name: string, starter: 'blank' | 'business' = 'blank'): Promise<string> {
  const dir = temp(name);
  const created = await ProjectSession.create(dir, createStarterState(starter, name, false));
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
  const view = editorView();
  c.send = (channel: string, payload?: unknown) => void sent.push([channel, view(channel, payload)]);
  controllers.push(c);
  return { c, sent, view };
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
    const { c, sent, view } = controller();
    const open = await openCurrent(c, current);
    sent.splice(0);
    const sentBefore = view.changes.length;
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
    // And whole, never as a change from the project before.
    const changedBeforeClose = sent.slice(0, closedAt).filter(([ch]) => ch === 'project:changed').length;
    expect(view.changes[sentBefore + changedBeforeClose].base).toBeNull();
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
    let ended = 0;
    c.onSessionClosed = () => void ended++;
    expect((await c.trustAndOpen(next)).ok).toBe(true);
    expect(c.session?.dir).toBe(next);
    // The project went, so its helpers did too, though putting its files away failed (#822).
    expect(ended).toBe(1);
    c.onSessionClosed = null;
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
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/^Canceled/) });
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
    const writeNew = ProjectSession.prototype.writeNew;
    const spy = vi.spyOn(ProjectSession.prototype, 'writeNew').mockImplementation(async function (this: InstanceType<typeof ProjectSession>) {
      const s = await writeNew.call(this);
      made.push(s);
      return s;
    });
    // The takeover is seen while the open project is being closed for the new one.
    c.onSessionClosing = async () => void made[0]?.emit('lock-lost');
    const r = await c.create(orchid(parent));
    spy.mockRestore();
    c.onSessionClosing = null;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/lock was taken or removed while it was being set up/);
    expect(c.session).toBeNull();
    // The handover it began is over: the next switch is not turned away.
    expect((await c.trustAndOpen(next)).ok).toBe(true);
    expect(c.session?.dir).toBe(next);
  });

  it('finishes the switch when a Cancel arrives while the open project is closing for it', async () => {
    const current = await makeProject('current');
    const parent = temp('parent');
    const { c } = controller();
    await openCurrent(c, current);
    c.onSessionClosing = async () => c.cancelCreate();
    const r = await c.create(orchid(parent));
    c.onSessionClosing = null;
    expect(r).toEqual({ ok: true });
    expect(c.session?.dir).toBe(join(parent, 'orchid-garden'));
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
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/^Canceled/) });
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

describe('copying for Paste while another project opens (#240)', () => {
  it('takes a copy only in the opening it was pressed in, never from a duplicate with the same IDs opened meanwhile', async () => {
    const original = await makeProject('original', 'business');
    // Duplicated as the app does: the same documents, so the same page and element IDs, under a new project ID.
    const duplicate = join(temp('duplicate'), 'site');
    cpSync(original, duplicate, { recursive: true, verbatimSymlinks: true });
    const manifest = join(duplicate, 'siteorigin.project.json');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), projectId: 'p_duplicate' }));
    const { c } = controller();
    const a = await openCurrent(c, original);
    const keyA = c.openingKey!;
    const pageId = a.session.state.site.homePageId;
    const nodeId = a.session.state.pages[pageId].rootIds[0];
    expect(nodeId).toBeTruthy();
    const revision = a.session.revision;

    const b = (await openCurrent(c, duplicate)).session;
    // Everything the copy names is in the duplicate too, at the same revision: only its opening tells them apart.
    expect(b.state.pages[pageId].rootIds[0]).toBe(nodeId);
    expect(b.revision).toBe(revision);
    const copy = vi.spyOn(b, 'copy');
    expect(await c.copy(pageId, nodeId, revision, keyA)).toEqual({ ok: false, message: 'That project is no longer open.' });
    expect(copy).not.toHaveBeenCalled();
    // The duplicate's own Copy, from its own opening, is taken as usual.
    const own = await c.copy(pageId, nodeId, revision, c.openingKey!);
    expect(own.ok).toBe(true);
    expect(own.clipboardId).toBeTruthy();
    // Closed and opened again, the same folder is another opening: a Copy pressed before still finds nothing.
    const keyB = c.openingKey!;
    await c.close();
    await openCurrent(c, duplicate);
    expect(await c.copy(pageId, nodeId, c.session!.revision, keyB)).toMatchObject({ ok: false });
    expect(await c.copy(pageId, nodeId, c.session!.revision, '')).toMatchObject({ ok: false });
  });
});

describe('the recent-projects entry of a renamed site (#31)', () => {
  const recentName = async (dir: string) => (await recents()).find((r) => r.dir === dir)?.name;

  it('takes the new name when the rename is made and when it is undone, keeping its place, and keeps it once closed to Welcome', async () => {
    const other = await makeProject('other');
    const kloof = await makeProject('kloof', 'business');
    const { c } = controller();
    await openCurrent(c, kloof);
    await openCurrent(c, other);
    await openCurrent(c, kloof);
    // Kept second, so a rename that moved it to the front would show.
    await addRecent(other, 'other', 'pother');
    // The settings cache outlives each test: only this test's own projects are looked at.
    const mine = async () => (await recents()).filter((r) => r.dir === kloof || r.dir === other);
    const before = await mine();
    expect(before.map((r) => r.dir)).toEqual([other, kloof]);
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'New Kloof Studio' }] }, { label: 'Rename site' })).ok).toBe(true);
    expect(await recentName(kloof)).toBe('New Kloof Studio');
    // A rename is no new opening: the entry stays where it was, with the time it was opened.
    const after = await mine();
    expect(after.map((r) => r.dir)).toEqual([other, kloof]);
    expect(after[1].openedAt).toBe(before[1].openedAt);
    expect((await c.session!.undo()).ok).toBe(true);
    expect(await recentName(kloof)).toBe('kloof');
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'New Kloof Studio' }] }, { label: 'Rename site' })).ok).toBe(true);
    expect((await c.closeProject()).ok).toBe(true);
    expect(await recentName(kloof)).toBe('New Kloof Studio');
    // Saved, so Welcome (and the next start of the app) reads it too.
    const saved = JSON.parse(readFileSync(join(env.userData, 'settings.json'), 'utf8')) as { recents: Array<{ dir: string; name: string }> };
    expect(saved.recents.find((r) => r.dir === kloof)?.name).toBe('New Kloof Studio');
  });

  it('writes the new name again when the project is left, if writing it failed when it was made', async () => {
    const kloof = await makeProject('kloof', 'business');
    const { c } = controller();
    await openCurrent(c, kloof);
    const saved = () => (JSON.parse(readFileSync(join(env.userData, 'settings.json'), 'utf8')) as { recents: Array<{ dir: string; name: string }> }).recents.find((r) => r.dir === kloof)?.name;
    expect(saved()).toBe('kloof');
    // The settings folder cannot be written while the rename is made: the list has the name, the disk does not.
    const restore = denyAccess(env.userData, 'write');
    try {
      expect((await c.apply({ operations: [{ type: 'site.update', name: 'New Kloof Studio' }] }, { label: 'Rename site' })).ok).toBe(true);
      await expect(saveSettings()).rejects.toThrow();
    } finally {
      restore();
    }
    expect(saved()).toBe('kloof');
    expect((await c.closeProject()).ok).toBe(true);
    expect(saved()).toBe('New Kloof Studio');
  });

  it('takes the name the project has when it is left for another one opened in its place', async () => {
    const kloof = await makeProject('kloof', 'business');
    const parent = temp('parent');
    const { c } = controller();
    await openCurrent(c, kloof);
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'New Kloof Studio' }] }, { label: 'Rename site' })).ok).toBe(true);
    // A name the list missed (a write that failed, say) is put right as the project is left.
    await addRecent(kloof, 'Kloof Light Studio', 'pkloof');
    expect((await c.create({ ...orchid(parent), attempt: 'attempt-1' })).ok).toBe(true);
    const list = (await recents()).filter((r) => r.dir === kloof || r.dir.startsWith(parent));
    expect(list.map((r) => r.name)).toEqual(['Orchid Garden', 'New Kloof Studio']);
  });
});

describe('the preview started while a project opens (#960)', () => {
  /** What the open project's preview served came from the worker that is running now. */
  const serving = (c: InstanceType<typeof Controller>) => c.dev?.url ?? null;
  /**
   * Hold each publication of an opening until a preview process has been forked for its folder (or 2 s pass), and
   * say for each whether one was: a preview that waited for the opening to finish would never be.
   */
  function holdPublicationForFork() {
    const forked: boolean[] = [];
    const proto = ProjectSession.prototype as unknown as { publishGenerated(initial: boolean): Promise<string[]> };
    const real = proto.publishGenerated;
    vi.spyOn(proto, 'publishGenerated').mockImplementation(async function (this: { dir: string }, initial: boolean) {
      const dir = this.dir;
      for (let i = 0; i < 200 && !workers.some((w) => w.cwd === dir); i++) await new Promise((r) => setTimeout(r, 10));
      forked.push(workers.some((w) => w.cwd === dir));
      return real.call(this, initial);
    });
    return forked;
  }
  afterEach(() => vi.restoreAllMocks());

  it('forks the preview before the opening publishes its files, and takes that same server over', async () => {
    const dir = await makeProject('early');
    const forked = holdPublicationForFork();
    const { c } = controller();
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    // The opening's own publication (the first: others may follow it, an icon refresh) found the preview forked.
    expect(forked[0]).toBe(true);
    expect(workers).toHaveLength(1);
    expect(workers[0].cwd).toBe(dir);
    expect(workers[0].exited).toBe(false);
    expect(serving(c)).toBe('http://127.0.0.1:1');
  });

  it('starts afresh when the opening’s publication changed the project’s files, so nothing read before it is served', async () => {
    const dir = await makeProject('changed');
    // A generated file gone from the folder: the opening writes it again.
    const manifest = JSON.parse(readFileSync(join(dir, 'siteorigin/generated-manifest.json'), 'utf8')) as { files: Record<string, string> };
    const gone = Object.keys(manifest.files).find((f) => f.startsWith('src/routes/'))!;
    rmSync(join(dir, gone));
    const forked = holdPublicationForFork();
    const sawFile: boolean[] = [];
    env.onFork = (cwd) => void (cwd === dir && sawFile.push(existsSync(join(dir, gone))));
    const { c } = controller();
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    expect(existsSync(join(dir, gone))).toBe(true);
    expect(forked[0]).toBe(true);
    // The first was forked before the file was written again, the one now serving after.
    expect(sawFile).toEqual([false, true]);
    // The server started early was stopped, and the one serving was started after the files landed.
    expect(workers).toHaveLength(2);
    expect(workers[0].exited).toBe(true);
    expect(workers[1].exited).toBe(false);
    expect(serving(c)).toBe('http://127.0.0.1:1');
  });

  it('stops the preview it started at once when the lock is lost while the project is still opening', async () => {
    const dir = await makeProject('taken');
    const stoppedBeforePublishing: boolean[] = [];
    const proto = ProjectSession.prototype as unknown as { publishGenerated(initial: boolean): Promise<string[]>; emit(e: string): boolean };
    const real = proto.publishGenerated;
    vi.spyOn(proto, 'publishGenerated').mockImplementation(async function (this: { dir: string; emit(e: string): boolean }, initial: boolean) {
      const w = await (async () => {
        for (let i = 0; i < 200 && !workers.some((x) => x.cwd === dir); i++) await new Promise((r) => setTimeout(r, 10));
        return workers.find((x) => x.cwd === dir);
      })();
      if (w && stoppedBeforePublishing.length === 0) {
        // Another app took the project while it was opening (the heartbeat says so).
        this.emit('lock-lost');
        for (let i = 0; i < 200 && !w.exited; i++) await new Promise((r) => setTimeout(r, 10));
        stoppedBeforePublishing.push(w.exited);
      }
      return real.call(this, initial);
    });
    const { c } = controller();
    await c.trustAndOpen(dir);
    // Opened from Welcome, the editor has the project before its publication runs.
    await until(() => stoppedBeforePublishing.length > 0, 'the opening to publish');
    expect(stoppedBeforePublishing).toEqual([true]);
  });

  it('stops the preview it started when the opening does not go ahead', async () => {
    const current = await makeProject('current');
    const next = await makeProject('next');
    const { c } = controller();
    const open = await openCurrent(c, current);
    // The author keeps editing the open project: the switch does not happen.
    c.beforeLeave = async () => false;
    expect((await c.trustAndOpen(next)).ok).toBe(false);
    const started = workers.find((w) => w.cwd === next);
    expect(started).toBeDefined();
    await until(() => started!.exited, 'the preview started for the project that did not open to stop');
    expect(c.session).toBe(open.session);
    expect(open.worker.exited).toBe(false);
    expect(existsSync(join(next, '.siteorigin/lock.json'))).toBe(false);
    c.beforeLeave = null;
  });

  it('on a switch, starts the new preview before the old one is asked to stop, and still stops the old one', async () => {
    const current = await makeProject('current');
    const next = await makeProject('next');
    const { c } = controller();
    const open = await openCurrent(c, current);
    let forkedWhenStopped = -1;
    const post = open.worker.postMessage.bind(open.worker);
    open.worker.postMessage = (m: { type: string }) => {
      if (m.type === 'stop') forkedWhenStopped = workers.filter((w) => w.cwd === next).length;
      post(m);
    };
    expect((await c.trustAndOpen(next)).ok).toBe(true);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the new project’s preview');
    expect(forkedWhenStopped).toBe(1);
    expect(open.worker.exited).toBe(true);
    expect(workers.filter((w) => w.cwd === next)).toHaveLength(1);
    expect(c.session?.dir).toBe(next);
  });
});
