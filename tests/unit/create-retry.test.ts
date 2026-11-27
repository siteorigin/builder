/**
 * New project after a cancelled or failed attempt: the destination is left as it was found, so creating again with
 * the same name and folder works. A folder the author made stays (empty); a folder the app made goes; a folder that
 * already held something is never written to.
 */
import { existsSync, mkdirSync, mkdtempSync, promises as fs, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editorView } from './editor-feed';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}));
const settings = vi.hoisted(() => ({ recentsFail: false, recents: 0 }));
vi.mock('../../src/main/settings', () => ({
  addRecent: async () => {
    settings.recents++;
    if (settings.recentsFail) throw new Error('EACCES: permission denied, open settings.json');
  },
  renameRecent: async () => {
    if (settings.recentsFail) throw new Error('EACCES: permission denied, open settings.json');
  },
  isTrusted: async () => true,
  trust: async () => undefined,
  loadSettings: async () => ({ settings: { developerMode: false } })
}));
// The website tools install stands in for npm: by default it finishes at once; a test can make it wait for Cancel,
// fail, or write into the folder while it runs. A creation stages its install beside the project (stageDependencies);
// here the install runs in the project when it is moved in, once the project is locked, as npm did there. `staged`
// records each creation's staging: what the project held when it began, and whether it was discarded.
const deps = vi.hoisted(() => ({
  run: null as null | ((dir: string, signal?: AbortSignal) => Promise<void>),
  previewFails: false,
  ready: true,
  installs: 0,
  starts: 0,
  staged: [] as Array<{ dir: string; held: string[]; discarded: boolean; files: Record<string, string> }>,
  discard: null as null | (() => Promise<void>),
  atInstall: null as null | { manifest: boolean; lock: boolean },
  onStage: null as null | (() => void)
}));
vi.mock('../../src/main/runtime/manager', async () => {
  const { existsSync, readdirSync } = await import('node:fs');
  const prepareDependencies = async (dir: string, _onLine: (l: string) => void, signal?: AbortSignal) => {
    deps.installs++;
    // What the project held as its install began: its manifest, and its lock taken.
    deps.atInstall = { manifest: existsSync(`${dir}/siteorigin.project.json`), lock: existsSync(`${dir}/.siteorigin/lock.json`) };
    const run = deps.run;
    deps.run = null;
    await run?.(dir, signal);
  };
  return {
    dependenciesReady: async () => deps.ready,
    prepareDependencies,
    stageDependencies: (dir: string, files: Record<string, string>, signal?: AbortSignal) => {
      const staged = { dir, held: readdirSync(dir).sort(), discarded: false, files };
      deps.staged.push(staged);
      deps.onStage?.();
      return {
        adopt: (onLine: (l: string) => void) => prepareDependencies(dir, onLine, signal),
        discard: async () => {
          staged.discarded = true;
          await deps.discard?.();
        }
      };
    },
    buildProject: async () => ({ ok: true, logs: [] }),
    DevServer: class {
      status = { state: 'idle' };
      constructor(private dir: string) {}
      onStatus() {}
      onPublished() {}
      onGone() {}
      notifyRevision() {}
      async start() {
        deps.starts++;
        if (!deps.previewFails) return;
        // It got as far as writing its own output into the project.
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(`${this.dir}/.svelte-kit`, { recursive: true });
        writeFileSync(`${this.dir}/.svelte-kit/tsconfig.json`, '{}');
        throw new Error('The preview could not start.');
      }
      async stop() {}
    }
  };
});

const { Controller } = await import('../../src/main/controller');
const { ToolsDownloadError } = await import('../../src/main/runtime/availability');
const { ProjectLockedError, ProjectSession } = await import('../../src/main/project/session');
const { projectFolderName } = await import('@shared/project-name');

type Step = 'files' | 'dependencies' | 'preview';

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];

afterEach(async () => {
  deps.run = null;
  deps.previewFails = false;
  deps.ready = true;
  deps.installs = 0;
  deps.starts = 0;
  deps.staged = [];
  deps.discard = null;
  deps.atInstall = null;
  deps.onStage = null;
  settings.recentsFail = false;
  settings.recents = 0;
  vi.restoreAllMocks();
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A controller whose window hears creation progress, so a test can press Cancel when a step begins. */
function setup() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'so-create-retry-')));
  dirs.push(parent);
  const hooks = { cancelAt: null as Step | null, sent: [] as Array<{ channel: string; payload: unknown }> };
  const view = editorView();
  let c!: InstanceType<typeof Controller>;
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, p: { step: string }) => {
        hooks.sent.push({ channel, payload: view(channel, p) });
        if (channel !== 'create:progress') return;
        if (p.step === hooks.cancelAt) {
          hooks.cancelAt = null;
          c.cancelCreate();
        }
      }
    }
  };
  c = new Controller(() => win as never);
  controllers.push(c);
  return { c, parent, hooks };
}

/** Every path in the folder, files and folders alike. */
const tree = (d: string) => (readdirSync(d, { recursive: true }) as string[]).sort();
const theirLock = JSON.stringify({ pid: 1, host: 'another computer', instance: 'other-app', token: 'f00dfacef00dface', started: new Date().toISOString() });

const opts = (parent: string) => ({ name: 'Meadow Studio', parentDir: parent, starter: 'business' as const, sampleImages: true });

/** Part of the tools are installed, then npm waits for Cancel: it stops only once the abort arrives. */
const untilCancelled = (dir: string, signal?: AbortSignal) => {
  mkdirSync(join(dir, 'node_modules', 'vite'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'vite', 'package.json'), '{}');
  return new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Canceled'));
    signal?.addEventListener('abort', () => reject(new Error('Canceled')));
  });
};

describe('New project after Cancel', () => {
  for (const step of ['files', 'dependencies'] as const) {
    it(`keeps an empty folder the author made, empty, when cancelled during ${step}, and the same settings then create the project`, async () => {
      const { c, parent, hooks } = setup();
      const dir = join(parent, 'meadow-studio');
      mkdirSync(dir);
      hooks.cancelAt = step;
      if (step === 'dependencies') deps.run = untilCancelled;
      const r = await c.create(opts(parent));
      expect(r).toEqual({ ok: false, message: 'Canceled.' });
      expect(existsSync(dir)).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
      expect(c.session).toBeNull();

      expect(await c.create(opts(parent))).toEqual({ ok: true });
      expect(c.session!.dir).toBe(dir);
      expect(existsSync(join(dir, 'siteorigin.project.json'))).toBe(true);
    });

    it(`removes a folder the app made when cancelled during ${step}, and the same settings then create the project`, async () => {
      const { c, parent, hooks } = setup();
      const dir = join(parent, 'meadow-studio');
      hooks.cancelAt = step;
      if (step === 'dependencies') deps.run = untilCancelled;
      expect(await c.create(opts(parent))).toEqual({ ok: false, message: 'Canceled.' });
      expect(existsSync(dir)).toBe(false);
      expect(readdirSync(parent)).toEqual([]);

      expect(await c.create(opts(parent))).toEqual({ ok: true });
      expect(c.session!.dir).toBe(dir);
    });
  }

  it('releases the new project’s lock when the attempt stops after taking it, so nothing keeps writing to the folder', async () => {
    const { c, parent, hooks } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    const released = vi.spyOn(ProjectSession.prototype, 'releaseLock');
    hooks.cancelAt = 'dependencies';
    deps.run = untilCancelled;
    expect((await c.create(opts(parent))).ok).toBe(false);
    // The session never reached the editor, so closing the editor's project could not release it.
    expect(released).toHaveBeenCalledTimes(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('takes the manifest away while the lock is still held, and the claim on the folder last', async () => {
    const { c, parent, hooks } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    const atClose: string[][] = [];
    const close = ProjectSession.prototype.close;
    vi.spyOn(ProjectSession.prototype, 'close').mockImplementation(async function (this: InstanceType<typeof ProjectSession>) {
      atClose.push(readdirSync(dir).sort());
      return close.call(this);
    });
    hooks.cancelAt = 'dependencies';
    deps.run = untilCancelled;
    expect((await c.create(opts(parent))).ok).toBe(false);
    // Until the lock goes no other app can open the folder as a project, and once it goes there is none to open.
    expect(atClose).toEqual([['.siteorigin']]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('installs the website tools beside the project while its sample photos are encoded, before its documents', async () => {
    const { c, parent } = setup();
    expect(await c.create(opts(parent))).toEqual({ ok: true });
    expect(deps.staged).toHaveLength(1);
    const [staged] = deps.staged;
    expect(staged.dir).toBe(join(parent, 'meadow-studio'));
    expect(staged.held).toEqual(expect.arrayContaining(['.siteorigin', 'package.json', 'package-lock.json']));
    expect(staged.held).not.toContain('siteorigin.project.json');
    expect(staged.held).not.toContain('static');
    // Moved in once the project was locked (here, where the install runs), and nothing left to discard.
    expect(deps.installs).toBe(1);
    expect(staged.discarded).toBe(false);
  });

  it('starts no install once the attempt is cancelled before its photos are encoded', async () => {
    const { c, parent, hooks } = setup();
    hooks.cancelAt = 'files';
    expect(await c.create(opts(parent))).toEqual({ ok: false, message: 'Canceled.' });
    expect(deps.staged).toEqual([]);
    expect(deps.installs).toBe(0);
  });

  it('installs the website tools in the project after its files, as before, when no photos are encoded', async () => {
    const { c, parent } = setup();
    expect(await c.create({ ...opts(parent), sampleImages: false })).toEqual({ ok: true });
    expect(deps.staged).toEqual([]);
    expect(deps.installs).toBe(1);
    // In the project once its documents are written and it holds its lock.
    expect(deps.atInstall).toEqual({ manifest: true, lock: true });
    expect(existsSync(join(parent, 'meadow-studio', 'siteorigin.project.json'))).toBe(true);
  });

  it('installs from the package files it wrote, made from its own template, whatever the folder held after the copy', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    const cp = fs.cp.bind(fs);
    vi.spyOn(fs, 'cp').mockImplementation(async (from, to, o) => {
      await cp(from, to, o);
      // Something changes the copied package files before the app has made them this project's.
      if (String(to) === dir) for (const f of ['package.json', 'package-lock.json']) writeFileSync(join(dir, f), '{"name":"x","changedMeanwhile":true}');
    });
    expect(await c.create(opts(parent))).toEqual({ ok: true });
    const [staged] = deps.staged;
    expect(Object.keys(staged.files).sort()).toEqual(['package-lock.json', 'package.json']);
    for (const f of ['package.json', 'package-lock.json'] as const) {
      expect(staged.files[f]).toBe(readFileSync(join(dir, f), 'utf8'));
      expect(staged.files[f]).not.toContain('changedMeanwhile');
    }
    expect(JSON.parse(staged.files['package.json']).name).toBe('meadow-studio');
  });

  it('stops the install beside the project when the attempt stops before it is moved in, and waits for it', async () => {
    const { c, parent } = setup();
    let stopped = false;
    deps.discard = async () => {
      await new Promise((r) => setTimeout(r, 30));
      stopped = true;
    };
    // Cancel pressed as the install begins, while the photos are encoded.
    deps.onStage = () => c.cancelCreate();
    expect(await c.create(opts(parent))).toEqual({ ok: false, message: 'Canceled.' });
    expect(deps.staged.map((s) => s.discarded)).toEqual([true]);
    expect(stopped).toBe(true);
    expect(deps.installs).toBe(0);
    expect(readdirSync(parent)).toEqual([]);
  });

  it('cancels a Cancel pressed straight after Create, before anything is written', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    const pending = c.create(opts(parent));
    c.cancelCreate();
    expect(await pending).toEqual({ ok: false, message: 'Canceled.' });
    expect(readdirSync(dir)).toEqual([]);
    expect(c.session).toBeNull();
    expect(await c.create(opts(parent))).toEqual({ ok: true });
  });

  it('a creation that ends while a later one runs leaves that later one cancellable', async () => {
    const { c, parent } = setup();
    let failFirst!: () => void;
    deps.run = () => new Promise<void>((_resolve, reject) => (failFirst = () => reject(new Error('Installing dependencies failed (exit 1).'))));
    const first = c.create({ ...opts(parent), name: 'First Light' });
    await vi.waitFor(() => expect(failFirst).toBeTypeOf('function'), { timeout: 5000 });
    deps.run = untilCancelled;
    const second = c.create(opts(parent));
    await vi.waitFor(() => expect(existsSync(join(parent, 'meadow-studio', 'node_modules'))).toBe(true), { timeout: 5000 });
    failFirst();
    expect((await first).ok).toBe(false);
    c.cancelCreate();
    expect(await second).toEqual({ ok: false, message: 'Canceled.' });
    expect(readdirSync(parent)).toEqual([]);
  });

  for (const starter of ['business', 'blank'] as const) {
    it(`leaves nothing behind when Cancel lands just as the website tools finish, the last moment it can stop (${starter} starter)`, async () => {
      const { c, parent } = setup();
      const dir = join(parent, 'meadow-studio');
      mkdirSync(dir);
      const settings = { ...opts(parent), starter };
      // Everything creating a project writes before the preview starts is in the folder when this Cancel lands.
      deps.run = async (d) => {
        mkdirSync(join(d, 'node_modules', '.bin'), { recursive: true });
        writeFileSync(join(d, 'node_modules', '.package-lock.json'), '{}');
        mkdirSync(join(d, '.siteorigin', 'cache'), { recursive: true });
        writeFileSync(join(d, '.siteorigin', 'cache', 'deps.json'), '{}');
        c.cancelCreate();
      };
      expect(await c.create(settings)).toEqual({ ok: false, message: 'Canceled.' });
      expect(readdirSync(dir)).toEqual([]);
      expect(await c.create(settings)).toEqual({ ok: true });
    });
  }
});

describe('New project after a recoverable failure', () => {
  it('leaves an empty folder the author made empty when the website tools fail to install, and a retry works', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    deps.run = async (d) => {
      mkdirSync(join(d, 'node_modules', 'vite'), { recursive: true });
      writeFileSync(join(d, 'node_modules', 'vite', 'package.json'), '{}');
      throw new Error('Installing dependencies failed (exit 1). npm ERR! code E500');
    };
    const r = await c.create(opts(parent));
    expect(r.ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(await c.create(opts(parent))).toEqual({ ok: true });
  });
});

describe('New project when the website tools cannot be downloaded', () => {
  /** The tools needed a download and the registry could not be reached, after npm had made a start. */
  const offline = async (d: string) => {
    mkdirSync(join(d, 'node_modules', 'vite'), { recursive: true });
    throw new ToolsDownloadError('Downloading the website tools failed (ENOTFOUND). npm error code ENOTFOUND', 'ENOTFOUND');
  };

  it('opens the new project for editing with its preview saying what is missing, and Try again sets the tools up', async () => {
    const { c, parent, hooks } = setup();
    const dir = join(parent, 'meadow-studio');
    deps.ready = false;
    deps.run = offline;
    expect(await c.create(opts(parent))).toEqual({ ok: true });
    expect(c.session!.dir).toBe(dir);
    expect(c.session!.readOnly).toBeFalsy();
    expect(existsSync(join(dir, 'siteorigin.project.json'))).toBe(true);
    expect(settings.recents).toBe(1);
    // One install, and no preview started without its tools.
    expect(deps.installs).toBe(1);
    expect(deps.starts).toBe(0);
    const error = { state: 'error', message: 'The website tools could not be downloaded. Check your internet connection and try again. A connection is only needed once.' };
    expect(c.snapshot()!.runtime).toMatchObject(error);
    // The editor opens with it: the first snapshot it gets already says so.
    const first = hooks.sent.find((m) => m.channel === 'project:changed')?.payload as { runtime: unknown };
    expect(first.runtime).toMatchObject(error);
    expect(hooks.sent.filter((m) => m.channel === 'runtime:status').map((m) => m.payload)).toEqual([expect.objectContaining(error)]);
    // The switch to it is told as opening the project, not as starting a preview that waits for its tools.
    const steps = hooks.sent.filter((m) => m.channel === 'create:progress').map((m) => m.payload as { step: string; message: string });
    expect(steps.filter((p) => p.step === 'preview').map((p) => p.message)).toEqual(['Opening the project…']);

    // Back online, Try again installs the tools and starts the preview.
    await c.startRuntime();
    expect(deps.installs).toBe(2);
    expect(deps.starts).toBe(1);
  });

  it('removes the project as before when Cancel lands as the download fails', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    deps.run = async (d) => {
      c.cancelCreate();
      return offline(d);
    };
    expect((await c.create(opts(parent))).ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(c.session).toBeNull();
  });

  it('does not open the project when its lock is no longer this app’s as the download fails', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    deps.run = async (d) => {
      vi.spyOn(ProjectSession.prototype, 'stillOwner').mockResolvedValue(false);
      return offline(d);
    };
    expect((await c.create(opts(parent))).ok).toBe(false);
    expect(c.session).toBeNull();
    expect(deps.starts).toBe(0);
  });

  it('does not open the project when its lock stopped being this app’s while the open project closed for it', async () => {
    const { c, parent } = setup();
    deps.run = offline;
    // Still this app's when the download fails; another app's by the time the switch is made.
    vi.spyOn(ProjectSession.prototype, 'stillOwner').mockResolvedValueOnce(true).mockResolvedValue(false);
    const r = await c.create(opts(parent));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/lock was taken or removed/);
    expect(c.session).toBeNull();
  });
});

describe('New project when the preview fails to start', () => {
  it('closes the project it had opened and leaves an author’s folder empty, and a retry works', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    deps.previewFails = true;
    deps.run = async (d) => {
      mkdirSync(join(d, 'node_modules', 'vite'), { recursive: true });
    };
    const r = await c.create(opts(parent));
    expect(r).toEqual({ ok: false, message: 'The preview could not start.' });
    expect(c.session).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    deps.previewFails = false;
    expect(await c.create(opts(parent))).toEqual({ ok: true });
  });

  it('gives a project it could not close its manifest back, and removes nothing of it', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    deps.previewFails = true;
    let refuse = true;
    c.onSessionClosing = async () => {
      if (refuse) throw new Error('EIO: the workspace could not be saved');
    };
    const r = await c.create(opts(parent));
    expect(r.ok).toBe(false);
    expect(r.message).toContain(`The new project’s files were left in ${dir}.`);
    // Still open in the editor, and still a project on disk.
    expect(c.session?.dir).toBe(dir);
    expect(existsSync(join(dir, 'siteorigin.project.json'))).toBe(true);
    expect(existsSync(join(dir, 'package.json'))).toBe(true);
    refuse = false;
  });
});

describe('New project when cleaning up goes wrong', () => {
  it('gives the claim up when the folder cannot be read again after claiming it, so a retry works', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    const readdir = fs.readdir.bind(fs);
    let looks = 0;
    vi.spyOn(fs, 'readdir').mockImplementation((async (p: string, ...rest: unknown[]) => {
      if (p === dir && ++looks === 3) throw Object.assign(new Error('EMFILE: too many open files, scandir'), { code: 'EMFILE' });
      return (readdir as (...a: unknown[]) => Promise<string[]>)(p, ...rest);
    }) as never);
    expect((await c.create(opts(parent))).ok).toBe(false);
    expect(looks).toBe(3);
    expect(readdirSync(dir)).toEqual([]);
    vi.restoreAllMocks();
    expect(await c.create(opts(parent))).toEqual({ ok: true });
  });

  it('says so when some of the new project’s files could not be removed', async () => {
    const { c, parent, hooks } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation((async (p: string, o?: object) => {
      if (p === join(dir, 'README.md')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return rm(p, o);
    }) as never);
    hooks.cancelAt = 'files';
    const r = await c.create(opts(parent));
    expect(r.ok).toBe(false);
    expect(r.message).toBe(`Canceled. Some of the new project’s files could not be removed from ${dir}.`);
    expect(readdirSync(dir)).toEqual(['README.md']);
  });

  it('keeps a project that opened when its recent-projects entry cannot be saved', async () => {
    const { c, parent } = setup();
    settings.recentsFail = true;
    expect(await c.create(opts(parent))).toEqual({ ok: true });
    expect(settings.recents).toBe(1);
    expect(existsSync(join(parent, 'meadow-studio', 'siteorigin.project.json'))).toBe(true);
    expect(c.session).not.toBeNull();
  });
});

describe('protecting what was already there', () => {
  it('keeps entries named like project files that this attempt never wrote', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    // A blank project has no image notice and, before its preview, no preview output: these are someone else's.
    deps.run = async (d) => {
      writeFileSync(join(d, 'NOTICE.md'), 'synced from elsewhere');
      mkdirSync(join(d, '.svelte-kit'));
      writeFileSync(join(d, '.svelte-kit', 'note.txt'), 'not the preview’s');
      throw new Error('Installing dependencies failed (exit 1).');
    };
    expect((await c.create({ ...opts(parent), starter: 'blank' })).ok).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['.svelte-kit', 'NOTICE.md']);
    expect(readFileSync(join(dir, 'NOTICE.md'), 'utf8')).toBe('synced from elsewhere');
    expect(readFileSync(join(dir, '.svelte-kit', 'note.txt'), 'utf8')).toBe('not the preview’s');
  });

  it('removes nothing when another app took the new project over while its tools were installing', async () => {
    const { c, parent, hooks } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    const theirs = theirLock;
    let before: string[] = [];
    // Unlock in another window: the lock is now that app's.
    deps.run = (d, signal) => {
      writeFileSync(join(d, '.siteorigin', 'lock.json'), theirs);
      const installing = untilCancelled(d, signal);
      before = tree(d);
      return installing;
    };
    hooks.cancelAt = 'dependencies';
    expect(await c.create(opts(parent))).toEqual({ ok: false, message: `Canceled. The new project’s files were left in ${dir}.` });
    expect(tree(dir)).toEqual(before);
    expect(before).toContain('siteorigin.project.json');
    expect(before).toContain(join('.siteorigin', 'lock.json'));
    expect(readFileSync(join(dir, '.siteorigin', 'lock.json'), 'utf8')).toBe(theirs);
  });

  for (const made of [false, true]) {
    it(`keeps a file another app put in ${made ? 'the folder the app made' : 'the author’s folder'} during the attempt, and the folder with it`, async () => {
      const { c, parent } = setup();
      const dir = join(parent, 'meadow-studio');
      if (!made) mkdirSync(dir);
      deps.run = async (d) => {
        writeFileSync(join(d, 'notes.txt'), 'not the project’s');
        mkdirSync(join(d, 'Drafts'));
        writeFileSync(join(d, 'Drafts', 'plan.md'), 'mine');
        throw new Error('Installing dependencies failed (exit 1).');
      };
      expect((await c.create(opts(parent))).ok).toBe(false);
      expect(readdirSync(dir).sort()).toEqual(['Drafts', 'notes.txt']);
      expect(readFileSync(join(dir, 'Drafts', 'plan.md'), 'utf8')).toBe('mine');
      // Still not empty, so still protected.
      expect((await c.create(opts(parent))).message).toContain('already exists and is not empty');
      expect(readdirSync(dir).sort()).toEqual(['Drafts', 'notes.txt']);
    });
  }

  it('writes nothing when another creation claims the same empty folder first, and removes nothing of it', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    // The other app claims the folder just after this attempt has last found it empty.
    const readdir = fs.readdir.bind(fs);
    let looks = 0;
    vi.spyOn(fs, 'readdir').mockImplementation((async (p: string, ...rest: unknown[]) => {
      const seen = await (readdir as (...a: unknown[]) => Promise<string[]>)(p, ...rest);
      if (p === dir && ++looks === 2) mkdirSync(join(dir, '.siteorigin', 'sessions'), { recursive: true });
      return seen;
    }) as never);
    const r = await c.create(opts(parent));
    expect(looks).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('already exists and is not empty');
    expect(readdirSync(dir)).toEqual(['.siteorigin']);
    expect(readdirSync(join(dir, '.siteorigin'))).toEqual(['sessions']);
  });

  it('lets go of a folder that something else wrote into just before the claim, untouched', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    const readdir = fs.readdir.bind(fs);
    let looks = 0;
    vi.spyOn(fs, 'readdir').mockImplementation((async (p: string, ...rest: unknown[]) => {
      const seen = await (readdir as (...a: unknown[]) => Promise<string[]>)(p, ...rest);
      if (p === dir && ++looks === 2) writeFileSync(join(dir, '.DS_Store'), 'finder');
      return seen;
    }) as never);
    const r = await c.create(opts(parent));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('already exists and is not empty');
    expect(readdirSync(dir)).toEqual(['.DS_Store']);
    expect(readFileSync(join(dir, '.DS_Store'), 'utf8')).toBe('finder');
  });

  it('removes nothing once another app has opened the new project and holds its lock', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    let before: string[] = [];
    vi.spyOn(ProjectSession.prototype, 'acquireLock').mockImplementation(async () => {
      writeFileSync(join(dir, '.siteorigin', 'lock.json'), theirLock);
      before = tree(dir);
      return new ProjectLockedError('This project is already open in SiteOrigin Builder on another computer.', { host: 'another computer', token: 'x' } as never);
    });
    const r = await c.create(opts(parent));
    expect(r.ok).toBe(false);
    expect(before).toContain('siteorigin.project.json');
    expect(tree(dir)).toEqual(before);
    expect(readFileSync(join(dir, '.siteorigin', 'lock.json'), 'utf8')).toBe(theirLock);
  });

  it('removes nothing when taking the lock fails and another app’s lock is there', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    let before: string[] = [];
    vi.spyOn(ProjectSession.prototype, 'acquireLock').mockImplementation(async () => {
      writeFileSync(join(dir, '.siteorigin', 'lock.json'), theirLock);
      before = tree(dir);
      throw Object.assign(new Error('EMFILE: too many open files, open lock.json'), { code: 'EMFILE' });
    });
    const r = await c.create(opts(parent));
    expect(r.ok).toBe(false);
    expect(r.message).toContain(`The new project’s files were left in ${dir}.`);
    expect(before).toContain('siteorigin.project.json');
    expect(tree(dir)).toEqual(before);
  });

  for (const foreignLock of [false, true]) {
    it(`${foreignLock ? 'removes nothing' : 'cleans up'} when setting the project up fails part way${foreignLock ? ' and another app has locked it meanwhile' : ''}`, async () => {
      const { c, parent } = setup();
      const dir = join(parent, 'meadow-studio');
      mkdirSync(dir);
      const writeNew = ProjectSession.prototype.writeNew;
      let before: string[] = [];
      vi.spyOn(ProjectSession.prototype, 'writeNew').mockImplementation(async function (this: InstanceType<typeof ProjectSession>) {
        await writeNew.call(this);
        const d = this.dir;
        if (foreignLock) writeFileSync(join(d, '.siteorigin', 'lock.json'), theirLock);
        before = tree(d);
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      });
      const r = await c.create(opts(parent));
      expect(r.ok).toBe(false);
      expect(before).toContain('siteorigin.project.json');
      if (foreignLock) {
        expect(tree(dir)).toEqual(before);
      } else {
        expect(r.message).toBe('Your disk is full. Free up some space and try again.');
        expect(readdirSync(dir)).toEqual([]);
        vi.restoreAllMocks();
        expect(await c.create(opts(parent))).toEqual({ ok: true });
      }
    });
  }

  it('removes nothing when another app took over a project whose manifest it had put there first', async () => {
    const { c, parent, hooks } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    const cp = fs.cp.bind(fs);
    vi.spyOn(fs, 'cp').mockImplementation((async (from: string, to: string, o?: object) => {
      await cp(from, to, o);
      if (to === dir) writeFileSync(join(dir, 'siteorigin.project.json'), '{}');
    }) as never);
    let before: string[] = [];
    deps.run = (d, signal) => {
      writeFileSync(join(d, '.siteorigin', 'lock.json'), theirLock);
      const installing = untilCancelled(d, signal);
      before = tree(d);
      return installing;
    };
    hooks.cancelAt = 'dependencies';
    expect((await c.create(opts(parent))).ok).toBe(false);
    expect(tree(dir)).toEqual(before);
  });

  it('takes the manifest away first when setting up fails before the lock was taken', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    const writeNew = ProjectSession.prototype.writeNew;
    vi.spyOn(ProjectSession.prototype, 'writeNew').mockImplementation(async function (this: InstanceType<typeof ProjectSession>) {
      await writeNew.call(this);
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });
    const removed: string[] = [];
    const rm = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation((async (p: string, o?: object) => {
      if (p.startsWith(dir)) removed.push(p.slice(dir.length + 1));
      return rm(p, o);
    }) as never);
    expect((await c.create(opts(parent))).ok).toBe(false);
    expect(removed[0]).toBe('siteorigin.project.json');
    expect(removed).toContain('package.json');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps a folder something else made under a project name before this attempt wrote there', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    // It arrives while the template is copied, before the project's own documents and site are written.
    const cp = fs.cp.bind(fs);
    vi.spyOn(fs, 'cp').mockImplementation((async (from: string, to: string, o?: object) => {
      await cp(from, to, o);
      if (to === dir) {
        mkdirSync(join(dir, 'static'));
        writeFileSync(join(dir, 'static', 'synced.txt'), 'theirs');
      }
    }) as never);
    deps.run = async () => {
      throw new Error('Installing dependencies failed (exit 1).');
    };
    expect((await c.create({ ...opts(parent), starter: 'blank' })).ok).toBe(false);
    expect(readdirSync(dir)).toEqual(['static']);
    expect(readFileSync(join(dir, 'static', 'synced.txt'), 'utf8')).toBe('theirs');
  });

  it('refuses a folder that already holds files and leaves them untouched', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    const r = await c.create(opts(parent));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('already exists and is not empty');
    expect(readdirSync(dir)).toEqual(['notes.txt']);
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('mine');
  });
});

describe('the theme a new project starts with (#390)', () => {
  it('records the theme chosen, and refuses one it cannot start from before writing anything', async () => {
    const { c, parent } = setup();
    expect(await c.create({ ...opts(parent), themeId: 'foundation' })).toEqual({ ok: true });
    const site = JSON.parse(readFileSync(join(parent, 'meadow-studio', 'siteorigin', 'site.json'), 'utf8'));
    expect(site.themeId).toBe('foundation');
    expect(JSON.parse(readFileSync(join(parent, 'meadow-studio', 'siteorigin', 'theme-lock.json'), 'utf8')).theme).toEqual({ id: 'foundation', version: '0.1.0' });

    const other = realpathSync(mkdtempSync(join(tmpdir(), 'so-create-theme-')));
    dirs.push(other);
    expect(await c.create({ ...opts(other), themeId: 'nope' })).toEqual({ ok: false, message: 'The theme "nope" is not installed. Choose another theme.' });
    expect(await c.create({ ...opts(other), themeId: 'foundation-alt' })).toEqual({ ok: false, message: expect.stringMatching(/development fixture/) });
    expect(readdirSync(other)).toEqual([]);
  });
});

describe('the folder a new project is made in (#808)', () => {
  const named = (parent: string, name: string) => ({ ...opts(parent), name });
  const long = 'Kowhai Garden Supplies and Landscaping Co-operative of Greater Wellington and the Hutt Valley';

  it('is the folder projectFolderName gives for a long name, cut at the end of a word', async () => {
    const { c, parent } = setup();
    const folder = projectFolderName(long);
    expect(folder).toBe('kowhai-garden-supplies-and-landscaping-co-operative-of');
    expect(await c.create(named(parent, long))).toEqual({ ok: true });
    expect(readdirSync(parent)).toEqual([folder]);
    expect(c.session!.dir).toBe(join(parent, folder));
    // The package keeps an npm-safe name.
    expect(JSON.parse(readFileSync(join(parent, folder, 'package.json'), 'utf8')).name).toBe('kowhai-garden-supplies-and-landscaping-co-operative-of-great');
  });

  it('keeps a name in another script as written, so two such projects can share a parent folder beside “website”', async () => {
    const { c, parent } = setup();
    mkdirSync(join(parent, 'website'));
    writeFileSync(join(parent, 'website', 'notes.txt'), 'mine');
    expect(await c.create(named(parent, '日本語サイト'))).toEqual({ ok: true });
    expect(await c.create(named(parent, 'Ресторан'))).toEqual({ ok: true });
    expect(readdirSync(parent).sort()).toEqual(['website', 'ресторан', '日本語サイト'].sort());
    expect(c.session!.dir).toBe(join(parent, projectFolderName('Ресторан')));
    expect(JSON.parse(readFileSync(join(parent, '日本語サイト', 'package.json'), 'utf8')).name).toBe('website');
    expect(readdirSync(join(parent, 'website'))).toEqual(['notes.txt']);
  });

  it('says the name is the problem when a name with nothing a folder can keep meets a taken “website”', async () => {
    const { c, parent } = setup();
    mkdirSync(join(parent, 'website'));
    writeFileSync(join(parent, 'website', 'notes.txt'), 'mine');
    for (const name of ['🌸🌸', '...']) {
      const r = await c.create(named(parent, name));
      expect(r.ok).toBe(false);
      expect(r.message).toBe(`“${name}” has no letters or numbers to name its folder, so it would go in ${join(parent, 'website')}, which already exists and is not empty. Add a letter or number to the name, or choose another folder.`);
    }
    // A project really named Website is told the folder is taken, as for any other name.
    expect((await c.create(named(parent, 'Website'))).message).toBe(`${join(parent, 'website')} already exists and is not empty. Choose another name or folder.`);
    expect(readdirSync(join(parent, 'website'))).toEqual(['notes.txt']);
  });

  it('never gives a folder Windows keeps for a device', async () => {
    const { c, parent } = setup();
    expect(await c.create(named(parent, 'Con'))).toEqual({ ok: true });
    expect(readdirSync(parent)).toEqual(['con-site']);
  });

  it('treats a file in the folder’s place as taken, and leaves it', async () => {
    const { c, parent } = setup();
    writeFileSync(join(parent, 'website'), 'mine');
    const r = await c.create(named(parent, '🌸🌸'));
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/^“🌸🌸” has no letters or numbers to name its folder.*already exists and is not empty/) });
    expect(readFileSync(join(parent, 'website'), 'utf8')).toBe('mine');
  });

  it('says the name is the problem when “website” fills up just before the claim, and leaves what arrived', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'website');
    mkdirSync(dir);
    const readdir = fs.readdir.bind(fs);
    let looks = 0;
    vi.spyOn(fs, 'readdir').mockImplementation((async (p: string, ...rest: unknown[]) => {
      const seen = await (readdir as (...a: unknown[]) => Promise<string[]>)(p, ...rest);
      if (p === dir && ++looks === 2) writeFileSync(join(dir, 'notes.txt'), 'theirs');
      return seen;
    }) as never);
    const r = await c.create(named(parent, '...'));
    expect(r).toEqual({ ok: false, message: `“...” has no letters or numbers to name its folder, so it would go in ${dir}, which already exists and is not empty. Add a letter or number to the name, or choose another folder.` });
    expect(readdirSync(dir)).toEqual(['notes.txt']);
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('theirs');
  });

  it('tells a folder taken while it waited the same way, however long the message', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'website');
    vi.spyOn(c as unknown as { mayLeave: () => Promise<boolean> }, 'mayLeave').mockImplementation(async () => {
      mkdirSync(dir);
      writeFileSync(join(dir, 'notes.txt'), 'theirs');
      return true;
    });
    const r = await c.create(named(parent, '🌸🌸'));
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/^“🌸🌸” has no letters or numbers to name its folder.*already exists and is not empty/) });
    expect(readdirSync(dir)).toEqual(['notes.txt']);
  });
});
