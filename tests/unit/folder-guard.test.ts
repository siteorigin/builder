/**
 * The preview's process never makes the project folder again once it has gone (#1454): SvelteKit writes its generated
 * files with a recursive mkdir at their absolute paths, which would bring back the old folder holding `.svelte-kit`.
 */
import fs, { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { guardProjectFolder, within } from '../../src/runtime/folder-guard';

const dirs: string[] = [];
const undo: Array<() => void> = [];
afterEach(() => {
  for (const u of undo.splice(0)) u();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project folder inside a parent of its own, guarded as the preview's worker guards it. */
function guarded() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'so-guard-')));
  dirs.push(parent);
  const root = join(parent, 'gone-site');
  mkdirSync(join(root, 'src', 'routes'), { recursive: true });
  undo.push(guardProjectFolder(root));
  return { parent, root };
}

/** As SvelteKit's sync writes a generated file (core/sync/utils.js). */
function kitWrite(file: string) {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export {};');
}

describe('the preview’s guard on its project folder', () => {
  it('makes nothing at the old address once the folder is deleted', async () => {
    const { root } = guarded();
    const generated = join(root, '.svelte-kit', 'generated', 'root.js');
    kitWrite(generated);
    expect(existsSync(generated)).toBe(true);
    rmSync(root, { recursive: true, force: true });
    expect(() => kitWrite(generated)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    // However the call reaches node:fs: named imports, the promise API, a callback, a URL.
    expect(() => mkdirSync(join(root, 'node_modules', '.vite'), { recursive: true })).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    await expect(mkdir(join(root, 'node_modules', '.vite-temp'), { recursive: true })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.mkdir(pathToFileURL(join(root, '.svelte-kit')), { recursive: true })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(new Promise((resolve, reject) => fs.mkdir(root, (e) => (e ? reject(e) : resolve(null))))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => fs.mkdirSync(Buffer.from(join(root, '.svelte-kit')), { recursive: true })).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(existsSync(root)).toBe(false);
  });

  it('makes nothing at the old address once the folder is renamed, even after a folder appears there again', () => {
    const { parent, root } = guarded();
    renameSync(root, join(parent, 'moved-away'));
    expect(() => kitWrite(join(root, '.svelte-kit', 'generated', 'server', 'internal.js'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(existsSync(root)).toBe(false);
    // The folder that moved away is not this server's any more, and neither is one put back at the address.
    renameSync(join(parent, 'moved-away'), root);
    expect(() => kitWrite(join(root, '.svelte-kit', 'generated', 'root.js'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(existsSync(join(root, '.svelte-kit'))).toBe(false);
  });

  it('leaves folders inside a folder that is there, and anywhere else, alone', async () => {
    const { parent, root } = guarded();
    kitWrite(join(root, '..cache', 'x.js'));
    await mkdir(join(root, 'node_modules', '.vite'), { recursive: true });
    expect(existsSync(join(root, 'node_modules', '.vite'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
    kitWrite(join(parent, 'gone-site-other', 'file.js'));
    expect(existsSync(join(parent, 'gone-site-other', 'file.js'))).toBe(true);
  });

  it('is undone with its undo', () => {
    const { root } = guarded();
    rmSync(root, { recursive: true, force: true });
    for (const u of undo.splice(0)) u();
    kitWrite(join(root, '.svelte-kit', 'root.js'));
    expect(existsSync(join(root, '.svelte-kit', 'root.js'))).toBe(true);
  });

  it('counts a child named like a parent step as inside', () => {
    expect(within('/p/site', '/p/site')).toBe(true);
    expect(within('/p/site', '/p/site/..cache/x')).toBe(true);
    expect(within('/p/site', '/p/site-moved')).toBe(false);
    expect(within('/p/site', '/p')).toBe(false);
    expect(within('/p/site', '/elsewhere')).toBe(false);
  });
});

describe('the preview worker', () => {
  it('guards its project folder from the moment it is asked to start', async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'so-guard-worker-')));
    dirs.push(parent);
    const root = join(parent, 'gone-site');
    mkdirSync(join(root, 'siteorigin', 'pages'), { recursive: true });
    writeFileSync(join(root, 'siteorigin', 'site.json'), JSON.stringify({ homePageId: 'home' }));
    writeFileSync(join(root, 'siteorigin', 'pages', 'home.json'), JSON.stringify({ route: '/' }));
    const posted: Array<{ type: string; message?: string }> = [];
    let deliver: (ev: { data: unknown }) => void = () => undefined;
    const cwd = process.cwd();
    Object.defineProperty(process, 'parentPort', {
      configurable: true,
      value: { on: (_e: string, cb: typeof deliver) => (deliver = cb), postMessage: (m: (typeof posted)[number]) => posted.push(m) }
    });
    try {
      await import('../../src/runtime/worker');
      // This folder has no Vite to load: the start fails after the guard is in place, as a server that started would.
      deliver({ data: { type: 'start', dir: root } });
      await expect.poll(() => posted.find((m) => m.type === 'error')).toBeTruthy();
      rmSync(root, { recursive: true, force: true });
      expect(() => kitWrite(join(root, '.svelte-kit', 'generated', 'root.js'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      expect(existsSync(root)).toBe(false);
    } finally {
      process.chdir(cwd);
      delete (process as { parentPort?: unknown }).parentPort;
    }
  });
});
