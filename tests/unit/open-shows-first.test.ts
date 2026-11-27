/**
 * A project opened from Welcome reaches the editor as soon as its documents are read and sound (#959): generating and
 * checking its website's files, its sweep and its look for missing image files come after the editor has it, and what
 * they find is still shown.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const env = vi.hoisted(() => ({ userData: '' }));
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

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { sha } = await import('../../src/main/project/fsutil');

type Snap = { dir: string; conflicts: Array<{ path: string; kind?: string }>; saveFailure: { kind: string } | null; state: { pages: Record<string, unknown> }; missingAssets: Array<{ assetId: string }>; diagnostics: Array<{ code: string }> };

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-shown-${name}-`)));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of controllers.splice(0)) await c.close();
  workers.splice(0);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A project with its website tools in place, as the app leaves it once the preview has run; `gone` names a library image whose file is not there. */
async function makeProject(name: string, opts: { gone?: string } = {}): Promise<string> {
  const dir = temp(name);
  const state = createStarterState('blank', name, false);
  if (opts.gone) state.assets.assets[opts.gone] = { id: opts.gone, name: 'Gone', file: `static/assets/${opts.gone.slice(2)}-00000000.jpg`, mime: 'image/jpeg', bytes: 1, hash: opts.gone, kind: 'image', createdAt: 'now' };
  const created = await ProjectSession.create(dir, state);
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

/** A controller whose sends are recorded, each snapshot as the editor holds it once sent (and noted in `events`, if given). */
function controller(events?: string[]) {
  const c = new Controller(() => null);
  const sent: Array<[string, unknown]> = [];
  const view = editorView();
  c.send = (channel: string, payload?: unknown) => {
    if (channel === 'project:changed') events?.push('snapshot');
    sent.push([channel, channel === 'project:changed' ? structuredClone(view(channel, payload)) : payload]);
  };
  controllers.push(c);
  const snapshots = () => sent.filter(([ch]) => ch === 'project:changed').map(([, p]) => p as Snap);
  return { c, sent, snapshots };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error(`Timed out waiting for ${what}`);
}

const proto = ProjectSession.prototype as unknown as { publishGenerated(this: InstanceType<typeof ProjectSession>, initial: boolean, ...rest: unknown[]): Promise<string[]> };

/** Hold the first publication of a project being opened (never a new project's) until `release` is called. */
function holdOpeningPublication(events: string[]) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const real = proto.publishGenerated;
  let first = true;
  vi.spyOn(proto, 'publishGenerated').mockImplementation(async function (this: InstanceType<typeof ProjectSession>, initial: boolean, ...rest: unknown[]) {
    if (!initial && first) {
      first = false;
      events.push('publish');
      await held;
    }
    return real.call(this, initial, ...rest);
  });
  return release;
}

/** A generated website file the project's manifest claims. */
const generatedRoute = (dir: string) => Object.keys((JSON.parse(readFileSync(join(dir, 'siteorigin/generated-manifest.json'), 'utf8')) as { files: Record<string, string> }).files).find((f) => f.startsWith('src/routes/') && f.endsWith('.svelte'))!;

describe('a project opened from Welcome (#959)', () => {
  it('reaches the editor before its publication generates the website, which then still runs', async () => {
    const dir = await makeProject('first');
    const route = generatedRoute(dir);
    rmSync(join(dir, route));
    const events: string[] = [];
    const release = holdOpeningPublication(events);
    const { c, snapshots } = controller(events);
    const opened = c.trustAndOpen(dir);
    await until(() => events.includes('publish'), 'the publication to start');
    // The editor had the documents before the publication began.
    expect(events.slice(0, 2)).toEqual(['snapshot', 'publish']);
    const first = snapshots().find((s) => s.dir === dir)!;
    expect(Object.keys(first.state.pages).length).toBeGreaterThan(0);
    expect(existsSync(join(dir, route))).toBe(false);
    expect((await opened).ok).toBe(true);
    // The preview is not shown while the publication is held, however long that is.
    await new Promise((r) => setTimeout(r, 200));
    expect(workers.filter((w) => w.cwd === dir).length).toBeLessThanOrEqual(1);
    expect(c.snapshot()?.runtime.state).not.toBe('ready');
    release();
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    expect(existsSync(join(dir, route))).toBe(true);
    expect(c.session?.saveUnfinished).toBe(false);
  });

  it('tells the editor of a generated file edited outside the app once the publication has looked at it, and keeps the edit', async () => {
    const dir = await makeProject('edited');
    const route = generatedRoute(dir);
    const edited = readFileSync(join(dir, route), 'utf8') + '\n<!-- edited outside -->\n';
    writeFileSync(join(dir, route), edited);
    const { c, snapshots } = controller();
    // No preview start, so nothing but the publication's own news can tell the editor.
    c.startRuntime = async () => undefined;
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await until(() => snapshots().some((s) => s.conflicts.some((x) => x.path === route && x.kind === 'generated')), 'the editor to be told of the edited file');
    // The editor had the project before the publication looked at its files.
    expect(snapshots()[0].conflicts.some((x) => x.path === route)).toBe(false);
    expect(readFileSync(join(dir, route), 'utf8')).toBe(edited);
  });

  it('never shows the editor a conflict list the publication is part way through', async () => {
    const dir = await makeProject('partway');
    const route = generatedRoute(dir);
    writeFileSync(join(dir, route), readFileSync(join(dir, route), 'utf8') + '\n<!-- edited outside -->\n');
    const { c, snapshots } = controller();
    c.startRuntime = async () => undefined;
    let mid: Snap | null = null;
    const target = ProjectSession.prototype as unknown as { writeManifest(this: InstanceType<typeof ProjectSession>, files: unknown): Promise<void> };
    const real = target.writeManifest;
    vi.spyOn(target, 'writeManifest').mockImplementation(async function (this: InstanceType<typeof ProjectSession>, files: unknown) {
      // Mid-publication the session knows of the edited file: a snapshot sent now still shows the list from before.
      if (!mid && this.conflicts.some((x) => x.path === route)) {
        c.broadcast();
        mid = snapshots().at(-1)!;
      }
      return real.call(this, files);
    });
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await until(() => snapshots().some((s) => s.conflicts.some((x) => x.path === route)), 'the edited file to be shown');
    expect(mid).not.toBeNull();
    expect(mid!.conflicts.map((x) => x.path)).toEqual([]);
  });

  it('stays open with its save unfinished when the publication fails after the editor has it', async () => {
    const dir = await makeProject('failing');
    const real = proto.publishGenerated;
    let healthyFirst: boolean | null = null;
    const { c, snapshots } = controller();
    vi.spyOn(proto, 'publishGenerated').mockImplementation(async function (this: InstanceType<typeof ProjectSession>, initial: boolean, ...rest: unknown[]) {
      if (!initial && healthyFirst === null) {
        healthyFirst = snapshots().some((s) => s.dir === dir && !s.saveFailure);
        throw new Error('EIO: the disk could not be written');
      }
      return real.call(this, initial, ...rest);
    });
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await until(() => snapshots().some((s) => s.saveFailure?.kind === 'unfinished'), 'the editor to be told the save is unfinished');
    // It failed once the editor had the project as it was read.
    expect(healthyFirst).toBe(true);
    expect(c.session?.dir).toBe(dir);
    expect(existsSync(join(dir, '.siteorigin/lock.json'))).toBe(true);
    // Nothing more is written until the project is reopened.
    const r = await c.session!.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/reopen/);
  });

  it('publishes nothing once another app has taken the project while the editor was being given it', async () => {
    const dir = await makeProject('taken');
    const route = generatedRoute(dir);
    rmSync(join(dir, route));
    const lock = join(dir, '.siteorigin/lock.json');
    let lost = 0;
    const s = await ProjectSession.open(dir, 'me', {
      sweepLater: true,
      shown: async (opened) => {
        opened.on('lock-lost', () => lost++);
        // Another app's lock in its place: its claim on the project outlived this one's.
        writeFileSync(lock, JSON.stringify({ pid: 1, host: 'other.local', instance: 'other', token: 'theirs', started: new Date().toISOString() }));
      }
    });
    expect(existsSync(join(dir, route))).toBe(false);
    expect(JSON.parse(readFileSync(lock, 'utf8')).token).toBe('theirs');
    expect(lost).toBeGreaterThan(0);
    await s.close();
  });

  it('starts a preview of its own when a save lands files after the one started while it opened was judged usable', async () => {
    const dir = await makeProject('saved');
    const target = Controller.prototype as unknown as { startRuntimeChecked(this: InstanceType<typeof Controller>, s: unknown, usable: unknown): Promise<void> };
    const real = target.startRuntimeChecked;
    let saved: boolean | null = null;
    vi.spyOn(target, 'startRuntimeChecked').mockImplementation(async function (this: InstanceType<typeof Controller>, s: unknown, usable: unknown) {
      // An edit made from the first snapshot lands between the server being judged usable and being taken over.
      if (usable && saved === null) saved = (await this.session!.apply({ operations: [{ type: 'site.update', name: 'Saved early' }] }, { label: 'Rename' })).ok;
      return real.call(this, s, usable);
    });
    const { c } = controller();
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    expect(saved).toBe(true);
    const mine = workers.filter((w) => w.cwd === dir);
    expect(mine).toHaveLength(2);
    expect(mine[0].exited).toBe(true);
    expect(mine[1].exited).toBe(false);
  });

  it('waits for a save still landing files before deciding whether to take over the preview started while it opened', async () => {
    const dir = await makeProject('landing');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered = false;
    const now = ProjectSession.prototype as unknown as { publishGeneratedNow(this: unknown, ...args: unknown[]): Promise<string[]> };
    const realNow = now.publishGeneratedNow;
    const target = Controller.prototype as unknown as { startRuntimeChecked(this: InstanceType<typeof Controller>, s: unknown, usable: unknown): Promise<void> };
    const real = target.startRuntimeChecked;
    let saving: Promise<unknown> | null = null;
    vi.spyOn(target, 'startRuntimeChecked').mockImplementation(async function (this: InstanceType<typeof Controller>, s: unknown, usable: unknown) {
      if (usable && !saving) {
        // The site's icons, which a project made here publishes after its first open, first.
        await this.session!.refreshSiteIcons().catch(() => null);
        // A save made from the first snapshot, its files being written (its hold taken) as the takeover is decided.
        vi.spyOn(now, 'publishGeneratedNow').mockImplementation(async function (this: unknown, ...args: unknown[]) {
          entered = true;
          await held;
          return realNow.apply(this, args);
        });
        saving = this.session!.apply({ operations: [{ type: 'site.update', name: 'Saved while starting' }] }, { label: 'Rename' });
        await until(() => entered, 'the save to start writing');
      }
      return real.call(this, s, usable);
    });
    const { c } = controller();
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await until(() => entered, 'the save to start writing');
    await new Promise((r) => setTimeout(r, 150));
    // Nothing is taken over, or started, while the save is writing.
    expect(c.dev).toBeNull();
    expect(workers.filter((w) => w.cwd === dir)).toHaveLength(1);
    release();
    expect(((await saving!) as { ok: boolean }).ok).toBe(true);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    // The save changed the website's files: a server of its own serves it.
    const mine = workers.filter((w) => w.cwd === dir);
    expect(mine).toHaveLength(2);
    expect(mine[0].exited).toBe(true);
  });

  it('closes a project it was opening when the handover to it fails, letting its lock go', async () => {
    const current = await makeProject('current');
    const next = await makeProject('next');
    const { c } = controller();
    expect((await c.trustAndOpen(current)).ok).toBe(true);
    const open = c.session;
    c.beforeLeave = async () => {
      throw new Error('the editor did not answer');
    };
    expect((await c.trustAndOpen(next)).ok).toBe(false);
    c.beforeLeave = null;
    expect(c.session).toBe(open);
    await until(() => !existsSync(join(next, '.siteorigin/lock.json')), 'the second project’s lock to go');
  });
});

/** Hold every call of a session method (of the project in `dir`, if given) until `release` is called, counting the calls. */
function holdMethod(name: 'refreshAssetFiles' | 'sweep', dir?: string, events?: string[]) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const calls: number[] = [];
  const target = ProjectSession.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const real = target[name];
  vi.spyOn(target, name).mockImplementation(async function (this: { dir: string }, ...args: unknown[]) {
    if (dir === undefined || this.dir === dir) {
      events?.push(name);
      calls.push(Date.now());
      await held;
    }
    return real.apply(this, args);
  });
  return { release, calls };
}

const blobsIn = (dir: string) => readdirSync(join(dir, '.siteorigin/history/blobs'));

describe('what an opening finds after the editor has the project (#959)', () => {
  it('lists missing image files in Project health once its look at the library is done, while the editor and preview go on without it', async () => {
    const dir = await makeProject('missing', { gone: 'a_gone' });
    const events: string[] = [];
    const look = holdMethod('refreshAssetFiles', undefined, events);
    const { c, snapshots } = controller(events);
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await until(() => look.calls.length > 0, 'the look for missing files');
    // Asked for after the editor had the project, and the preview is not held up by it.
    expect(events.indexOf('snapshot')).toBeLessThan(events.indexOf('refreshAssetFiles'));
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    expect(snapshots().every((s) => s.missingAssets.length === 0)).toBe(true);
    look.release();
    await until(() => snapshots().some((s) => s.missingAssets.some((m) => m.assetId === 'a_gone')), 'the missing file to be shown');
    expect(snapshots().at(-1)!.diagnostics.some((d) => d.code === 'ASSET_FILE_MISSING')).toBe(true);
  });

  it('sweeps history it no longer needs as the next command after the open, which does not wait for it', async () => {
    const dir = await makeProject('sweep');
    const orphan = '{"orphan":true}\n';
    writeFileSync(join(dir, '.siteorigin/history/blobs', `${sha(orphan)}.json`), orphan);
    const sweep = holdMethod('sweep');
    const s = await Promise.race([ProjectSession.open(dir, 'me', { sweepLater: true }), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
    expect(s).not.toBeNull();
    // The sweep is queued ahead of what is asked for next: an edit waits for it.
    let edited = false;
    const edit = s!.apply({ operations: [{ type: 'site.update', name: 'After the sweep' }] }, { label: 'Rename' }).then((r) => (edited = r.ok));
    await until(() => sweep.calls.length > 0, 'the sweep to be asked for');
    await new Promise((r) => setTimeout(r, 100));
    expect(edited).toBe(false);
    expect(blobsIn(dir)).toContain(`${sha(orphan)}.json`);
    sweep.release();
    await edit;
    expect(edited).toBe(true);
    expect(blobsIn(dir)).not.toContain(`${sha(orphan)}.json`);
    await s!.close();
  });

  it('shows the project a switch opens without waiting for its sweep', async () => {
    const current = await makeProject('current');
    const next = await makeProject('next');
    const { c, snapshots } = controller();
    expect((await c.trustAndOpen(current)).ok).toBe(true);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the first project’s preview');
    const sweep = holdMethod('sweep', next);
    expect((await c.trustAndOpen(next)).ok).toBe(true);
    await until(() => snapshots().some((s) => s.dir === next), 'the editor to be given the second project');
    await until(() => sweep.calls.length > 0, 'the sweep to be asked for');
    sweep.release();
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the second project’s preview');
  });

  it('watches the folders the publication makes, when they were not there as the project was attached', async () => {
    const dir = await makeProject('nostatic');
    rmSync(join(dir, 'static'), { recursive: true, force: true });
    const watched: string[] = [];
    const target = Controller.prototype as unknown as { watchFolder(this: unknown, s: unknown, d: string, l: unknown): unknown };
    const real = target.watchFolder;
    vi.spyOn(target, 'watchFolder').mockImplementation(function (this: unknown, s: unknown, d: string, l: unknown) {
      watched.push(d);
      return real.call(this, s, d, l);
    });
    const checks = vi.spyOn(Controller.prototype as unknown as { checkAssetFiles(s: unknown): Promise<void> }, 'checkAssetFiles');
    const { c } = controller();
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    expect(existsSync(join(dir, 'static'))).toBe(true);
    await until(() => watched.includes(join(dir, 'static')), 'static/ to be watched');
    // What the watch would have told of before it was there is looked for once it is.
    expect(checks).toHaveBeenCalled();
  });
});

describe('the folders an open makes and flushes (#959)', () => {
  it('flushes them together, and recovers only once every flush has finished', async () => {
    const dir = await makeProject('flush');
    const local = join(dir, '.siteorigin');
    const flushed = [dir, local, join(local, 'history'), join(local, 'history/blobs'), join(local, 'sessions')];
    const entered: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let releaseLast!: () => void;
    const last = new Promise<void>((r) => (releaseLast = r));
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      const path = String(args[0]);
      if (args[1] !== 'r' || !flushed.includes(path)) return handle;
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        entered.push(path);
        await (path === join(local, 'history/blobs') ? last : held);
        return sync();
      };
      return handle;
    });
    const target = ProjectSession.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const recover = target.loadSavedCopies;
    let recovering = false;
    vi.spyOn(target, 'loadSavedCopies').mockImplementation(function (this: unknown, ...args: unknown[]) {
      recovering = true;
      return recover.apply(this, args);
    });
    const opening = ProjectSession.open(dir, 'me', { sweepLater: true });
    try {
      // Every flush is under way at once, and recovery waits for them all, the last one too.
      await until(() => flushed.every((p) => entered.includes(p)), 'every folder to be flushed at once');
      expect(recovering).toBe(false);
      release();
      await new Promise((r) => setTimeout(r, 100));
      expect(recovering).toBe(false);
    } finally {
      release();
      releaseLast();
    }
    const s = await opening;
    expect(recovering).toBe(true);
    await s.close();
  });
});
