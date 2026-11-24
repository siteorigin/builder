/**
 * Read-only opens through the Controller (spec 16.6, 18.1): the preview, export and Duplicate leave the project folder
 * byte-identical, a project only a newer version can generate starts no preview at all, and a project taken over by
 * another app moves its preview out of the folder at once.
 */
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for Electron's utility process that starts at once and exits when asked to stop. */
class FakeWorker extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  posted: Array<{ type: string; dir?: string }> = [];
  exited = false;
  constructor(public cwd: string) {
    super();
  }
  /** A worker still starting: it never says it is ready. */
  silent = env.silent;
  postMessage(m: { type: string; dir?: string }) {
    this.posted.push(m);
    if (m.type === 'start' && !this.silent) queueMicrotask(() => this.emit('message', { type: 'ready', url: 'http://127.0.0.1:1' }));
    if (m.type === 'stop') this.kill();
  }
  kill() {
    if (this.exited) return true;
    this.exited = true;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

const env = vi.hoisted(() => ({ userData: '', saveTo: '', silent: false }));
const workers: FakeWorker[] = [];
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (name: string) => (name === 'userData' ? env.userData : env.userData), getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: env.saveTo }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
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
const { applyOperations } = await import('@engine/apply');
const { SCHEMA_VERSION } = await import('@shared/types');
const { sha } = await import('../../src/main/project/fsutil');

type Tree = Record<string, { kind: string; size: number; mtimeMs: number; hash?: string; link?: string }>;

/** Everything in the folder: paths, kinds, sizes, modification times and content hashes. */
function snapshotTree(root: string): Tree {
  const out: Tree = { '.': { kind: 'dir', size: 0, mtimeMs: lstatSync(root).mtimeMs } };
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      const rel = relative(root, p);
      if (st.isSymbolicLink()) out[rel] = { kind: 'link', size: st.size, mtimeMs: st.mtimeMs, link: readlinkSync(p) };
      else if (st.isDirectory()) {
        out[rel] = { kind: 'dir', size: 0, mtimeMs: st.mtimeMs };
        walk(p);
      } else out[rel] = { kind: 'file', size: st.size, mtimeMs: st.mtimeMs, hash: createHash('sha256').update(readFileSync(p)).digest('hex') };
    }
  };
  walk(root);
  return out;
}

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-ro-${name}-`)));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  env.userData = temp('userdata');
  env.silent = false;
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  workers.splice(0);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A project with its website tools in place, as the app leaves it once the preview has run. */
async function makeProject(at?: string): Promise<string> {
  const dir = at ?? temp('project');
  mkdirSync(dir, { recursive: true });
  // A heading on Home, so the page the preview serves carries the editor's markup.
  const blank = createStarterState('blank', 'Read Only Site', false);
  const home = { kind: 'page' as const, id: blank.site.homePageId };
  const placed = applyOperations(blank, [{ type: 'node.insert', owner: home, componentId: 'layout.section' }]);
  const state = applyOperations(placed.state, [{ type: 'node.insert', owner: home, parentId: placed.results[0].nodeId as string, slot: 'content', primitive: 'heading', text: 'Read Only Site' }]).state;
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

function lockByAnother(dir: string) {
  writeFileSync(join(dir, '.siteorigin/lock.json'), JSON.stringify({ pid: process.pid, host: hostname(), instance: 'another-window', started: new Date().toISOString() }));
}

function makeNewer(dir: string) {
  const path = join(dir, 'siteorigin.project.json');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), schemaVersion: SCHEMA_VERSION + 1 }, null, 2));
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

const inside = (dir: string, p: string) => {
  const rel = relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const stagingRoot = () => join(env.userData, 'preview-staging');
const stages = () => (existsSync(stagingRoot()) ? readdirSync(stagingRoot()) : []);

describe('a project another app is editing', () => {
  it('previews from a private copy and leaves the folder byte-identical', async () => {
    const dir = await makeProject();
    lockByAnother(dir);
    const before = snapshotTree(dir);
    const { c } = controller();
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    expect(c.session?.readOnly?.canUnlock).toBe(true);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    expect(workers).toHaveLength(1);
    const [w] = workers;
    const start = w.posted.find((m) => m.type === 'start')!;
    expect(inside(dir, w.cwd)).toBe(false);
    expect(start.dir).toBe(w.cwd);
    expect(inside(stagingRoot(), w.cwd)).toBe(true);
    const variant = '.siteorigin/cache/dev/src/routes/+page.svelte';
    expect(readFileSync(join(w.cwd, variant), 'utf8')).toBe(readFileSync(join(dir, variant), 'utf8'));
    expect(readFileSync(join(w.cwd, variant), 'utf8')).toContain('data-so-');
    // The preview's tools are the copy's own: what they write stays there.
    mkdirSync(join(w.cwd, 'node_modules/.vite-temp'));
    expect(existsSync(join(dir, 'node_modules/.vite-temp'))).toBe(false);
    await c.close();
    expect(w.exited).toBe(true);
    expect(stages()).toEqual([]);
    expect(snapshotTree(dir)).toEqual(before);
  });

  it('refuses both direct exports and leaves the folder byte-identical', async () => {
    const dir = await makeProject();
    lockByAnother(dir);
    const out = temp('out');
    const before = snapshotTree(dir);
    const { c } = controller();
    await c.trustAndOpen(dir);
    for (const r of [await c.exportSourceTo(join(out, 'source')), await c.buildStaticTo(join(out, 'site')), await c.exportSourceTo(join(out, 'source.zip'), 'zip')]) {
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/read-only/);
    }
    expect(readdirSync(out)).toEqual([]);
    await c.close();
    expect(snapshotTree(dir)).toEqual(before);
  });

  it('refuses a Duplicate inside the project and leaves the folder byte-identical', async () => {
    const dir = await makeProject();
    lockByAnother(dir);
    const before = snapshotTree(dir);
    const { c } = controller();
    await c.trustAndOpen(dir);
    // The copy's folder is named after it, in the folder chosen for it: here, the project itself or a folder in it.
    for (const [parentDir, name] of [[dir, 'copy'], [dir, '..draft'], [join(dir, 'missing'), 'copy']]) {
      expect(await c.duplicate({ name, parentDir, opening: c.openingKey! })).toEqual({ ok: false, field: 'location', message: 'Choose a folder outside the project folder.' });
    }
    // Through a linked folder that leads back into the project, to a folder not made yet.
    const link = join(temp('links'), 'back');
    symlinkSync(dir, link);
    expect((await c.duplicate({ name: 'copy', parentDir: join(link, 'new'), opening: c.openingKey! })).ok).toBe(false);
    await c.close();
    expect(snapshotTree(dir)).toEqual(before);
    // A new folder elsewhere is still fine.
    const { c: again } = controller();
    await again.trustAndOpen(dir);
    const elsewhere = temp('elsewhere');
    expect((await again.duplicate({ name: 'copy', parentDir: elsewhere, opening: again.openingKey! })).ok).toBe(true);
    expect(existsSync(join(elsewhere, 'copy', 'siteorigin.project.json'))).toBe(true);
  });
});

describe('a project from a newer version', () => {
  it('starts no preview, reports it unavailable with nothing to retry, and leaves the folder byte-identical', async () => {
    const dir = await makeProject();
    makeNewer(dir);
    const before = snapshotTree(dir);
    const { c, sent } = controller();
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    expect(c.session?.readOnly?.canUnlock).toBe(false);
    await until(() => sent.some(([ch, p]) => ch === 'runtime:status' && (p as { state: string }).state === 'unavailable'), 'the unavailable status');
    await c.startRuntime();
    c.broadcast();
    expect(c.snapshot()?.runtime).toMatchObject({ state: 'unavailable', message: expect.stringMatching(/newer version/) });
    const statuses = sent.filter(([ch]) => ch === 'runtime:status').map(([, p]) => (p as { state: string }).state);
    expect(statuses.every((s) => s === 'unavailable')).toBe(true);
    const changed = sent.filter(([ch]) => ch === 'project:changed').map(([, p]) => (p as { runtime: { state: string } }).runtime.state);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((s) => s === 'unavailable')).toBe(true);
    for (const r of [await c.exportSourceTo(join(temp('out'), 'source')), await c.buildStaticTo(join(temp('out'), 'site'))]) expect(r.ok).toBe(false);
    await c.close();
    expect(workers).toHaveLength(0);
    expect(stages()).toEqual([]);
    expect(snapshotTree(dir)).toEqual(before);
  });

  it('fails to open, writing nothing, when a broken page sorts before a newer one', async () => {
    const dir = await makeProject();
    rmSync(join(dir, '.siteorigin'), { recursive: true, force: true });
    const pages = join(dir, 'siteorigin/pages');
    const [first] = readdirSync(pages).sort();
    writeFileSync(join(pages, first), JSON.stringify({ ...JSON.parse(readFileSync(join(pages, first), 'utf8')), schemaVersion: SCHEMA_VERSION + 1 }));
    writeFileSync(join(pages, 'aaa-broken.json'), '{ not json');
    const before = snapshotTree(dir);
    const { c } = controller();
    const r = await c.trustAndOpen(dir);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/newer version/);
    expect(workers).toHaveLength(0);
    expect(snapshotTree(dir)).toEqual(before);
  });
});

describe('a project taken over while it is open', () => {
  it('moves the running preview out of the folder at once', async () => {
    const dir = await makeProject();
    const { c } = controller();
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    expect(c.session?.readOnly).toBeNull();
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    const [live] = workers;
    expect(live.cwd).toBe(dir);
    // Another app unlocks the project and takes it over; this one notices on its next heartbeat.
    lockByAnother(dir);
    const theirs = readFileSync(join(dir, '.siteorigin/lock.json'), 'utf8');
    await c.session!.refreshLock();
    expect(live.posted.at(-1)?.type).toBe('stop');
    await until(() => workers.length === 2 && c.snapshot()?.runtime.state === 'ready', 'the staged preview');
    expect(live.exited).toBe(true);
    const staged = workers[1];
    expect(inside(dir, staged.cwd)).toBe(false);
    expect(inside(stagingRoot(), staged.cwd)).toBe(true);
    await c.close();
    expect(stages()).toEqual([]);
    expect(readFileSync(join(dir, '.siteorigin/lock.json'), 'utf8')).toBe(theirs);
  });

  it('calls off an export when the lock changed hands before the heartbeat saw it', async () => {
    const dir = await makeProject();
    const { c } = controller();
    await c.trustAndOpen(dir);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    lockByAnother(dir);
    const theirs = readFileSync(join(dir, '.siteorigin/lock.json'), 'utf8');
    const out = temp('out');
    const r = await c.exportSourceTo(join(out, 'source'));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/took over/);
    expect(readdirSync(out)).toEqual([]);
    expect(c.session?.readOnly).not.toBeNull();
    expect(readFileSync(join(dir, '.siteorigin/lock.json'), 'utf8')).toBe(theirs);
  });
});

describe('a project another app is editing, as it changes', () => {
  it('follows the other app’s edits into the copy', async () => {
    const dir = await makeProject();
    lockByAnother(dir);
    const { c } = controller();
    await c.trustAndOpen(dir);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    const stage = workers[0].cwd;
    // The other app regenerates a page and its editor variant.
    writeFileSync(join(dir, 'src/routes/+page.svelte'), '<h1>Changed by the other app</h1>');
    await until(() => readFileSync(join(stage, 'src/routes/+page.svelte'), 'utf8').includes('Changed by the other app'), 'the copy to follow');
    expect(workers).toHaveLength(1);
  });

  it('never clears copies around a project kept inside the folder they are made in', async () => {
    const dir = await makeProject(join(stagingRoot(), 'preview-999999-abc'));
    lockByAnother(dir);
    const before = snapshotTree(dir);
    const { c, sent } = controller();
    await c.trustAndOpen(dir);
    await until(() => sent.some(([ch, p]) => ch === 'runtime:status' && (p as { state: string }).state === 'error'), 'the preview error');
    expect(workers).toHaveLength(0);
    await c.close();
    expect(snapshotTree(dir)).toEqual(before);
  });

  it('never makes or clears copies through a data folder that leads into the project', async () => {
    const dir = await makeProject();
    lockByAnother(dir);
    mkdirSync(join(dir, 'inside'));
    writeFileSync(join(dir, 'inside', 'preview-1-keep'), 'mine');
    symlinkSync(join(dir, 'inside'), stagingRoot());
    const before = snapshotTree(dir);
    const { c, sent } = controller();
    await c.trustAndOpen(dir);
    await until(() => sent.some(([ch, p]) => ch === 'runtime:status' && (p as { state: string }).state === 'error'), 'the preview error');
    expect(workers).toHaveLength(0);
    // The explanation survives the next snapshot instead of turning into "paused".
    c.broadcast();
    expect(c.snapshot()?.runtime.state).toBe('error');
    await c.close();
    expect(snapshotTree(dir)).toEqual(before);
  });
});

describe('a takeover at the last moment', () => {
  it('previews from a copy when the lock changed hands just before the preview would start in the folder', async () => {
    const dir = await makeProject();
    const original = ProjectSession.prototype.stillOwner;
    let armed = true;
    // Another app takes the project over after it opened, before the heartbeat could notice.
    ProjectSession.prototype.stillOwner = async function (this: InstanceType<typeof ProjectSession>) {
      if (armed) {
        armed = false;
        lockByAnother(dir);
      }
      return original.call(this);
    };
    try {
      const { c } = controller();
      await c.trustAndOpen(dir);
      await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
      expect(armed).toBe(false);
      expect(workers.length).toBeGreaterThan(0);
      for (const w of workers) expect(inside(dir, w.cwd)).toBe(false);
      expect(c.session?.readOnly?.canUnlock).toBe(true);
    } finally {
      ProjectSession.prototype.stillOwner = original;
    }
  });

  it('stops a live preview that is still starting, at once', async () => {
    const dir = await makeProject();
    env.silent = true;
    const { c } = controller();
    await c.trustAndOpen(dir);
    await until(() => workers.length === 1, 'the live worker');
    const [live] = workers;
    expect(live.cwd).toBe(dir);
    env.silent = false;
    lockByAnother(dir);
    await c.session!.refreshLock();
    expect(live.posted.at(-1)?.type).toBe('stop');
    await until(() => workers.length === 2 && c.snapshot()?.runtime.state === 'ready', 'the staged preview');
    expect(inside(dir, workers[1].cwd)).toBe(false);
  });

  it('calls off an export taken over just before it is put in place, keeping the previous ZIP', async () => {
    const dir = await makeProject();
    const { c } = controller();
    await c.trustAndOpen(dir);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    const s = c.session!;
    const owner = s.stillOwner.bind(s);
    let checks = 0;
    // Owned through the snapshot (two checks); taken over before the third, as the archive is about to be put in place.
    s.stillOwner = async () => {
      if (++checks === 3) lockByAnother(dir);
      return owner();
    };
    const out = temp('out');
    const zip = join(out, 'source.zip');
    writeFileSync(zip, 'the previous export');
    const r = await c.exportSourceTo(zip, 'zip');
    expect(checks).toBe(3);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/took over/);
    expect(readFileSync(zip, 'utf8')).toBe('the previous export');
    expect(readdirSync(out)).toEqual(['source.zip']);
  });
});

describe('reinstalling the website tools', () => {
  it('reports a removal that fails instead of staying on "Reinstalling"', async () => {
    const dir = await makeProject();
    const { c } = controller();
    await c.trustAndOpen(dir);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    chmodSync(join(dir, 'node_modules/@sveltejs'), 0o500);
    try {
      await c.repairDependencies();
    } finally {
      chmodSync(join(dir, 'node_modules/@sveltejs'), 0o755);
    }
    expect(c.snapshot()?.runtime.state).toBe('error');
  });
});

describe('closing', () => {
  it('waits for a copy still being made, and leaves none behind', async () => {
    const dir = await makeProject();
    lockByAnother(dir);
    const before = snapshotTree(dir);
    const { c } = controller();
    await c.trustAndOpen(dir);
    await c.close();
    expect(stages()).toEqual([]);
    expect(workers.every((w) => w.exited)).toBe(true);
    expect(snapshotTree(dir)).toEqual(before);
  });

  it('is joined by a second close, which waits for the preview copy to go', async () => {
    const dir = await makeProject();
    lockByAnother(dir);
    const { c } = controller();
    await c.trustAndOpen(dir);
    await until(() => c.snapshot()?.runtime.state === 'ready', 'the preview');
    const first = c.close();
    expect(c.isClosing).toBe(true);
    await c.close();
    expect(stages()).toEqual([]);
    await first;
    expect(c.isClosing).toBe(false);
  });
});
