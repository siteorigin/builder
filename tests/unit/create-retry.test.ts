/**
 * New project after a cancelled or failed attempt: the destination is left as it was found, so creating again with
 * the same name and folder works. A folder the author made stays (empty); a folder the app made goes; a folder that
 * already held something is never written to.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const { ProjectSession } = await import('../../src/main/project/session');

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
  const steps: string[] = [];
  let c!: InstanceType<typeof Controller>;
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, p: { step: string }) => {
        if (channel !== 'create:progress') return;
        steps.push(p.step);
        if (p.step === hooks.cancelAt) {
          hooks.cancelAt = null;
          c.cancelCreate();
        }
      }
    }
  };
  c = new Controller(() => win as never);
  controllers.push(c);
  return { c, parent, hooks, steps };
}

const opts = (parent: string) => ({ name: 'Meadow Studio', parentDir: parent, starter: 'business' as const, sampleImages: true });

/** Wait for Cancel, as npm does: it stops only once the abort arrives. */
const untilCancelled = (_dir: string, signal?: AbortSignal) =>
  new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    signal?.addEventListener('abort', () => reject(new Error('Cancelled')));
  });

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
