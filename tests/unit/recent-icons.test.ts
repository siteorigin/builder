/**
 * Each Recent projects card shows its site's own icon: the home-screen PNG every save draws in the project folder
 * (static/apple-touch-icon.png), read when the list is asked for. Only a regular file that starts as a PNG and is a
 * sensible size is read; anything else leaves the card to its initials.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => env.userData, isPackaged: false } }));

type Settings = typeof import('../../src/main/settings');
const dirs: string[] = [];
let root = '';
let settings: Settings;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a small icon')]);

beforeEach(async () => {
  env.userData = realpathSync(mkdtempSync(join(tmpdir(), 'so-icon-userdata-')));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'so-icon-sites-')));
  dirs.push(env.userData, root);
  vi.resetModules();
  settings = await import('../../src/main/settings');
});
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A listed project folder, with `icon` written as its home-screen icon when given. */
async function listed(folder: string, icon?: (path: string) => void) {
  const dir = join(root, folder);
  mkdirSync(join(dir, 'static'), { recursive: true });
  writeFileSync(join(dir, 'siteorigin.project.json'), '{}');
  icon?.(join(dir, 'static', 'apple-touch-icon.png'));
  await settings.addRecent(dir, folder, folder);
  return dir;
}
const iconOf = async (dir: string) => (await settings.recents()).find((r) => r.dir === dir)?.icon;

describe('Recent projects site icons', () => {
  it('reads the site icon as a PNG data URL', async () => {
    const dir = await listed('florist', (p) => writeFileSync(p, PNG));
    expect(await iconOf(dir)).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('leaves a project with no icon file to its initials', async () => {
    const dir = await listed('never-saved');
    expect(await iconOf(dir)).toBeUndefined();
  });

  it('reads nothing that is not a PNG, is oversized, or is a link', async () => {
    const notPng = await listed('not-png', (p) => writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"/>'));
    const huge = await listed('huge', (p) => writeFileSync(p, Buffer.concat([PNG, Buffer.alloc(300 * 1024)])));
    const target = join(root, 'elsewhere.png');
    writeFileSync(target, PNG);
    const linked = await listed('linked', (p) => symlinkSync(target, p));
    const folder = await listed('folder', (p) => mkdirSync(p));
    for (const dir of [notPng, huge, linked, folder]) expect(await iconOf(dir), dir).toBeUndefined();
  });

  it('gives a missing project no icon, and never keeps one in the settings file', async () => {
    const dir = await listed('gone', (p) => writeFileSync(p, PNG));
    rmSync(dir, { recursive: true, force: true });
    const entry = (await settings.recents()).find((r) => r.dir === dir);
    expect(entry?.missing).toBe(true);
    expect(entry?.icon).toBeUndefined();
    const saved = JSON.parse((await import('node:fs')).readFileSync(join(env.userData, 'settings.json'), 'utf8')) as { recents: Array<Record<string, unknown>> };
    expect(saved.recents.every((r) => !('icon' in r))).toBe(true);
  });
});
