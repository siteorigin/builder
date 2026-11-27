/**
 * The website tools a production build runs from (KeptTools, #978): kept between exports so the files stay the ones the
 * system has already loaded and checked, and used again only for what the project's tools still are.
 */
import { chmodSync, existsSync, promises as fsp, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyProjectTools, KeptTools } from '../../src/main/runtime/stage';

const dirs: string[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-tools-${name}-`)));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const write = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** A project with installed tools: packages, a native module, npm's .bin links, the preview's own caches, and a link out. */
function project(): string {
  const dir = temp('project');
  const nm = join(dir, 'node_modules');
  write(join(nm, 'vite/package.json'), '{"name":"vite"}');
  write(join(nm, 'vite/dist/node/index.js'), 'export const vite = 1;\n');
  write(join(nm, 'vite/bin/vite.js'), '#!/usr/bin/env node\n');
  chmodSync(join(nm, 'vite/bin/vite.js'), 0o755);
  write(join(nm, '@rolldown/binding/rolldown.node'), 'native module bytes');
  write(join(nm, 'svelte/src/index.js'), 'export {};\n');
  mkdirSync(join(nm, '.bin'));
  symlinkSync('../vite/bin/vite.js', join(nm, '.bin/vite'));
  // The preview's caches and a link that leads out of node_modules are never part of a copy.
  write(join(nm, '.vite/deps/_metadata.json'), '{}');
  write(join(nm, '.vite-temp/vite.config.js.timestamp-1.mjs'), 'export default {};');
  symlinkSync('../../outside', join(nm, 'escape'));
  return dir;
}

/** A fresh staging folder for one export, holding the project's staged copy at `project/`. */
function staging(): string {
  const dir = temp('staging');
  mkdirSync(join(dir, 'project'));
  return join(dir, 'project');
}

/** Every entry under `dir`: its kind, mode and bytes or link target. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const p = join(e.parentPath, e.name);
    const rel = relative(dir, p).split('\\').join('/');
    const st = lstatSync(p);
    out[rel] = st.isSymbolicLink() ? `link ${readlinkSync(p)}` : st.isDirectory() ? `dir ${(st.mode & 0o7777).toString(8)}` : `file ${(st.mode & 0o7777).toString(8)} ${readFileSync(p, 'utf8')}`;
  }
  return out;
}

const ino = (p: string) => lstatSync(p).ino;
/** A file written with the default mode, as `tree` lists it: Windows has no group or other bits to take away. */
const WRITABLE = process.platform === 'win32' ? '666' : '644';
/**
 * The files the build's copy wrote while `step` ran (copyFresh copies each one with fs.copyFile). A new inode cannot
 * show a copy made again: the stale copy is removed just before, and ext4 hands the new file the inode it freed.
 */
async function copiedBy(step: () => Promise<unknown>): Promise<string[]> {
  const to: string[] = [];
  const copyFile = fsp.copyFile.bind(fsp);
  const spy = vi.spyOn(fsp, 'copyFile').mockImplementation(async (from, dest, mode) => {
    to.push(String(dest));
    return copyFile(from, dest, mode);
  });
  try {
    await step();
  } finally {
    spy.mockRestore();
  }
  return to;
}
/** Every file is settled (statTrusted with no settle interval) once a few milliseconds have passed. */
const settled = () => new Promise((r) => setTimeout(r, 30));
/** One app's kept copy, in a slot of its own, taken with every file settled unless the test says otherwise. */
function oneApp() {
  const slot = join(temp('root'), 'tools');
  const tools = new KeptTools(slot);
  return { slot, tools, take: (project: string, dest: string, settleMs = 0) => tools.take(project, dest, settleMs) };
}

describe('the build’s copy of the website tools', () => {
  it('holds what a fresh copy of the project’s tools holds, and is kept for the next export', async () => {
    const p = project();
    const { slot, take } = oneApp();
    await settled();
    const fresh = staging();
    await copyProjectTools(p, fresh);
    const first = staging();
    const tools = await take(p, first);
    expect(tree(join(first, 'node_modules'))).toEqual(tree(join(fresh, 'node_modules')));
    expect(Object.keys(tree(join(first, 'node_modules')))).not.toContain('.vite');
    await tools.keep();
    expect(existsSync(join(first, 'node_modules'))).toBe(false);
    expect(tree(join(slot, 'node_modules'))).toEqual(tree(join(fresh, 'node_modules')));
  });

  it('takes the kept copy for the next export, with the very same files, never the project’s own', async () => {
    const p = project();
    const { slot, take } = oneApp();
    await settled();
    const first = staging();
    await (await take(p, first)).keep();
    const native = join(slot, 'node_modules/@rolldown/binding/rolldown.node');
    const kept = ino(native);
    const script = ino(join(slot, 'node_modules/vite/dist/node/index.js'));
    const second = staging();
    const tools = await take(p, second);
    // The slot is held by this export until it puts the copy back.
    expect(existsSync(slot)).toBe(false);
    expect(ino(join(second, 'node_modules/@rolldown/binding/rolldown.node'))).toBe(kept);
    expect(kept).not.toBe(ino(join(p, 'node_modules/@rolldown/binding/rolldown.node')));
    expect(ino(join(second, 'node_modules/vite/dist/node/index.js'))).toBe(script);
    await tools.keep();
    expect(ino(native)).toBe(kept);
  });

  it('copies again whatever a build changed, added or swapped in its copy, and puts back the folders’ modes', async () => {
    const p = project();
    const nm = join(p, 'node_modules');
    const { slot, take } = oneApp();
    write(join(temp('elsewhere'), 'x'), '');
    await settled();
    const first = staging();
    const tools = await take(p, first);
    const copy = join(first, 'node_modules');
    // What a build may do where it runs: rewrite a file in place at the same size, change a mode, add files (its own
    // caches, a nested one), swap a folder for a link back to the project, point a link elsewhere, link a file in.
    writeFileSync(join(copy, 'vite/dist/node/index.js'), 'export const vite = 2;\n');
    chmodSync(join(copy, 'vite/bin/vite.js'), 0o644);
    write(join(copy, '.vite/deps/chunk.js'), 'cached');
    write(join(copy, '.vite-temp/config.mjs'), 'temp');
    write(join(copy, 'svelte/src/extra.js'), 'added');
    rmSync(join(copy, 'svelte/src'), { recursive: true });
    symlinkSync(join(nm, 'svelte/src'), join(copy, 'svelte/src'));
    rmSync(join(copy, '.bin/vite'));
    symlinkSync('../svelte/src/index.js', join(copy, '.bin/vite'));
    linkSync(join(copy, '@rolldown/binding/rolldown.node'), join(copy, 'hardlinked.node'));
    chmodSync(join(copy, 'vite'), 0o700);
    await tools.keep();

    const second = staging();
    await take(p, second);
    const fresh = staging();
    await copyProjectTools(p, fresh);
    expect(tree(join(second, 'node_modules'))).toEqual(tree(join(fresh, 'node_modules')));
    expect(readFileSync(join(second, 'node_modules/vite/dist/node/index.js'), 'utf8')).toBe('export const vite = 1;\n');
    expect(lstatSync(join(second, 'node_modules/svelte/src')).isDirectory()).toBe(true);
    // The project's own tools were never written through the swapped-in link.
    expect(readdirSync(join(nm, 'svelte/src'))).toEqual(['index.js']);
    expect(lstatSync(join(second, 'node_modules/@rolldown/binding/rolldown.node')).nlink).toBe(1);
    expect(statSync(join(second, 'node_modules/vite')).mode & 0o777).toBe(statSync(join(nm, 'vite')).mode & 0o777);
  });

  it('follows the project’s tools: a file changed or removed there, a package added', async () => {
    const p = project();
    const nm = join(p, 'node_modules');
    const { slot, take } = oneApp();
    await settled();
    await (await take(p, staging())).keep();
    writeFileSync(join(nm, 'vite/dist/node/index.js'), 'export const vite = 3;\n');
    rmSync(join(nm, 'svelte'), { recursive: true });
    write(join(nm, 'esm-env/index.js'), 'export const BROWSER = false;\n');
    await settled();
    const second = staging();
    await take(p, second);
    const fresh = staging();
    await copyProjectTools(p, fresh);
    expect(tree(join(second, 'node_modules'))).toEqual(tree(join(fresh, 'node_modules')));
  });

  it('copies again next time a file that had only just changed when it was copied', async () => {
    const p = project();
    const { take } = oneApp();
    // Nothing has settled for an hour: no stamp can stand for the bytes copied.
    await (await take(p, staging(), 3_600_000)).keep();
    const second = staging();
    const copied = await copiedBy(() => take(p, second, 3_600_000));
    // The kept copy is the one brought up to date, and the file is copied into it again.
    expect(readdirSync(join(dirname(second), 'tools'))).toEqual([]);
    expect(copied).toContain(join(second, 'node_modules/vite/dist/node/index.js'));
    // A link has no bytes to vouch for: it is kept as it is when it still says the same (Windows stores the project's
    // `../vite/bin/vite.js` with its own separators).
    expect(readlinkSync(join(second, 'node_modules/.bin/vite'))).toBe(readlinkSync(join(p, 'node_modules/.bin/vite')));
  });

  it('is held by one export at a time: another copies the tools afresh, and only one copy goes back', async () => {
    const p = project();
    const { slot, take } = oneApp();
    await settled();
    await (await take(p, staging())).keep();
    const kept = ino(join(slot, 'node_modules/vite/package.json'));
    const a = staging();
    const holding = await take(p, a);
    const b = staging();
    const other = await take(p, b);
    expect(ino(join(a, 'node_modules/vite/package.json'))).toBe(kept);
    const fresh = ino(join(b, 'node_modules/vite/package.json'));
    expect(fresh).not.toBe(kept);
    await other.keep();
    expect(ino(join(slot, 'node_modules/vite/package.json'))).toBe(fresh);
    // The slot is taken again by then: this copy stays in its staging folder, to be removed with it.
    await holding.keep();
    const left = readdirSync(dirname(a)).filter((n) => n.startsWith('tools-'));
    expect(left).toHaveLength(1);
    expect(ino(join(dirname(a), left[0], 'node_modules/vite/package.json'))).toBe(kept);
    expect(ino(join(slot, 'node_modules/vite/package.json'))).toBe(fresh);
  });

  it('never uses a copy this app did not put in the slot itself, and never follows a link there', async () => {
    const p = project();
    const { slot, take } = oneApp();
    await settled();
    await (await take(p, staging())).keep();
    const was = ino(join(slot, 'node_modules/vite/package.json'));
    // A later run of the app knows nothing of what an earlier one kept: the copy goes with the staging folder.
    const later = new KeptTools(slot);
    const second = staging();
    await later.take(p, second, 0);
    expect(ino(join(second, 'node_modules/vite/package.json'))).not.toBe(was);
    expect(existsSync(join(dirname(second), 'tools/node_modules/vite/package.json'))).toBe(true);
    const fresh = staging();
    await copyProjectTools(p, fresh);
    expect(tree(join(second, 'node_modules'))).toEqual(tree(join(fresh, 'node_modules')));

    // Nor one put in the place of the copy it kept, or a link to the project in its place: the project's own tools stay.
    const { slot: other, take: again } = oneApp();
    await (await again(p, staging())).keep();
    rmSync(other, { recursive: true });
    symlinkSync(p, other);
    const third = staging();
    await again(p, third);
    expect(lstatSync(join(p, 'node_modules')).isDirectory()).toBe(true);
    expect(tree(join(p, 'node_modules'))).toMatchObject({ 'vite/package.json': `file ${WRITABLE} {"name":"vite"}` });
    expect(tree(join(third, 'node_modules'))).toEqual(tree(join(fresh, 'node_modules')));
  });

  it('never moves anything out of a staging folder a build swapped for a link', async () => {
    const p = project();
    const { slot, take } = oneApp();
    await settled();
    const dest = staging();
    const tools = await take(p, dest);
    // The build puts a link to the project where its staging copy was.
    rmSync(dest, { recursive: true });
    symlinkSync(p, dest);
    await tools.keep();
    expect(lstatSync(join(p, 'node_modules')).isDirectory()).toBe(true);
    expect(existsSync(join(p, 'node_modules/vite/package.json'))).toBe(true);
    expect(existsSync(slot)).toBe(false);
  });

  it('brings a kept read-only folder up to date, and gives it back its mode', async () => {
    const p = project();
    const nm = join(p, 'node_modules');
    const { slot, take } = oneApp();
    chmodSync(join(nm, 'svelte/src'), 0o555);
    await settled();
    await (await take(p, staging())).keep();
    chmodSync(join(nm, 'svelte/src'), 0o755);
    writeFileSync(join(nm, 'svelte/src/index.js'), 'export const changed = true;\n');
    chmodSync(join(nm, 'svelte/src'), 0o555);
    await settled();
    const second = staging();
    await take(p, second);
    expect(readFileSync(join(second, 'node_modules/svelte/src/index.js'), 'utf8')).toBe('export const changed = true;\n');
    // The folder's own mode as the system reports it: 555 on macOS and Linux, 444 on Windows, whose read-only
    // attribute is all a chmod sets and whose folders have no execute bits.
    expect(statSync(join(second, 'node_modules/svelte/src')).mode & 0o777).toBe(statSync(join(nm, 'svelte/src')).mode & 0o777);
    if (process.platform !== 'win32') expect(statSync(join(second, 'node_modules/svelte/src')).mode & 0o777).toBe(0o555);
    for (const d of [join(nm, 'svelte/src'), join(second, 'node_modules/svelte/src'), join(slot, 'node_modules/svelte/src')]) if (existsSync(d)) chmodSync(d, 0o755);
  });

  it('keeps no stamp from a copy made while a folder of the tools changed (a package swapped in and back)', async () => {
    const p = project();
    const nm = join(p, 'node_modules');
    const { take } = oneApp();
    await settled();
    const copyFile = fsp.copyFile.bind(fsp);
    let swapped = false;
    const spy = vi.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      if (!swapped) {
        swapped = true;
        renameSync(join(nm, 'svelte'), join(nm, 'svelte-old'));
        renameSync(join(nm, 'svelte-old'), join(nm, 'svelte'));
      }
      return copyFile(from, to, mode);
    });
    await (await take(p, staging())).keep();
    spy.mockRestore();
    const second = staging();
    const copied = await copiedBy(() => take(p, second));
    expect(readdirSync(join(dirname(second), 'tools'))).toEqual([]);
    expect(copied).toContain(join(second, 'node_modules/vite/package.json'));
  });

  it('brings a kept copy up to date whatever a build did to its folders’ modes, even with nothing to keep', async () => {
    const p = project();
    const { slot, take } = oneApp();
    // Nothing settled: the copy is kept with no stamps.
    await (await take(p, staging(), 3_600_000)).keep();
    chmodSync(join(slot, 'node_modules/svelte/src'), 0o600);
    const second = staging();
    await take(p, second);
    const fresh = staging();
    await copyProjectTools(p, fresh);
    expect(tree(join(second, 'node_modules'))).toEqual(tree(join(fresh, 'node_modules')));
  });

  it('fails as a fresh copy does when the project has no tools, and leaves the slot alone', async () => {
    const p = project();
    const { slot, take } = oneApp();
    await settled();
    await (await take(p, staging())).keep();
    const bare = temp('bare');
    await expect(take(bare, staging())).rejects.toThrow(/ENOENT/);
    expect(existsSync(join(slot, 'node_modules/vite/package.json'))).toBe(true);
  });
});
