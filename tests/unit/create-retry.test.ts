/**
 * New project after a cancelled or failed attempt: the destination is left as it was found, so creating again with
 * the same name and folder works. A folder the author made stays (empty); a folder the app made goes; a folder that
 * already held something is never written to.
 */
import { existsSync, mkdirSync, mkdtempSync, promises as fs, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  isTrusted: async () => true,
  trust: async () => undefined,
  loadSettings: async () => ({ settings: { developerMode: false } })
}));
// The website tools install stands in for npm: by default it finishes at once; a test can make it wait for Cancel,
// fail, or write into the folder while it runs.
const deps = vi.hoisted(() => ({ run: null as null | ((dir: string, signal?: AbortSignal) => Promise<void>) }));
vi.mock('../../src/main/runtime/manager', () => ({
  dependenciesReady: async () => true,
  prepareDependencies: async (dir: string, _onLine: (l: string) => void, signal?: AbortSignal) => {
    const run = deps.run;
    deps.run = null;
    await run?.(dir, signal);
  },
  buildProject: async () => ({ ok: true, logs: [] }),
  DevServer: class {
    status = { state: 'idle' };
    onStatus() {}
    notifyRevision() {}
    async start() {}
    async stop() {}
  }
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectLockedError, ProjectSession } = await import('../../src/main/project/session');

type Step = 'files' | 'dependencies' | 'preview';

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];

afterEach(async () => {
  deps.run = null;
  vi.restoreAllMocks();
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A controller whose window hears creation progress, so a test can press Cancel when a step begins. */
function setup() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'so-create-retry-')));
  dirs.push(parent);
  const hooks = { cancelAt: null as Step | null };
  let c!: InstanceType<typeof Controller>;
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, p: { step: string }) => {
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

const opts = (parent: string) => ({ name: 'Meadow Studio', parentDir: parent, starter: 'business' as const, sampleImages: true });

/** Part of the tools are installed, then npm waits for Cancel: it stops only once the abort arrives. */
const untilCancelled = (dir: string, signal?: AbortSignal) => {
  mkdirSync(join(dir, 'node_modules', 'vite'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'vite', 'package.json'), '{}');
  return new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    signal?.addEventListener('abort', () => reject(new Error('Cancelled')));
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
      expect(r).toEqual({ ok: false, message: 'Cancelled.' });
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
      expect(await c.create(opts(parent))).toEqual({ ok: false, message: 'Cancelled.' });
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

  it('cancels a Cancel pressed straight after Create, before anything is written', async () => {
    const { c, parent } = setup();
    const dir = join(parent, 'meadow-studio');
    mkdirSync(dir);
    const pending = c.create(opts(parent));
    c.cancelCreate();
    expect(await pending).toEqual({ ok: false, message: 'Cancelled.' });
    expect(readdirSync(dir)).toEqual([]);
    expect(c.session).toBeNull();
    expect(await c.create(opts(parent))).toEqual({ ok: true });
  });

  it('a creation that ends while a later one runs leaves that later one cancellable', async () => {
    const { c, parent } = setup();
    let failFirst!: () => void;
    deps.run = () => new Promise<void>((_resolve, reject) => (failFirst = () => reject(new Error('Installing dependencies failed (exit 1).'))));
    const first = c.create({ ...opts(parent), name: 'First Light' });
    await vi.waitFor(() => expect(failFirst).toBeTypeOf('function'));
    deps.run = untilCancelled;
    const second = c.create(opts(parent));
    await vi.waitFor(() => expect(existsSync(join(parent, 'meadow-studio', 'node_modules'))).toBe(true));
    failFirst();
    expect((await first).ok).toBe(false);
    c.cancelCreate();
    expect(await second).toEqual({ ok: false, message: 'Cancelled.' });
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
      expect(await c.create(settings)).toEqual({ ok: false, message: 'Cancelled.' });
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

describe('protecting what was already there', () => {
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
    vi.spyOn(ProjectSession.prototype, 'acquireLock').mockResolvedValue(new ProjectLockedError('This project is already open in SiteOrigin Builder on another computer.', { host: 'another computer', token: 'x' } as never));
    const r = await c.create(opts(parent));
    expect(r.ok).toBe(false);
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['siteorigin.project.json', '.siteorigin', 'package.json']));
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
