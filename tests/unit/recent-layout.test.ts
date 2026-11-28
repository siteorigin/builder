/**
 * Each Recent projects card carries where its editor last drew the panels and page (#1758): the sidebar, the panel
 * widths and the preview's width and zoom from the project's workspace file, read when the list is asked for, so the
 * outline shown from a click is drawn at the sizes the editor opens with. Nothing else in the file reaches Welcome, and
 * a file that cannot be used leaves the card without a layout.
 */
import { execFileSync } from 'node:child_process';
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

beforeEach(async () => {
  env.userData = realpathSync(mkdtempSync(join(tmpdir(), 'so-layout-userdata-')));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'so-layout-sites-')));
  dirs.push(env.userData, root);
  vi.resetModules();
  settings = await import('../../src/main/settings');
});
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A listed project folder, with `workspace` written as its workspace file when given. */
async function listed(folder: string, workspace?: (path: string) => void) {
  const dir = join(root, folder);
  mkdirSync(join(dir, '.siteorigin'), { recursive: true });
  writeFileSync(join(dir, 'siteorigin.project.json'), '{}');
  workspace?.(join(dir, '.siteorigin', 'workspace.json'));
  await settings.addRecent(dir, folder, folder);
  return dir;
}
const layoutOf = async (dir: string) => (await settings.recents()).find((r) => r.dir === dir)?.layout;

describe('Recent projects saved layout', () => {
  it('reads the panels and page from the workspace file, and nothing else in it', async () => {
    const dir = await listed('florist', (p) =>
      writeFileSync(p, JSON.stringify({ pageId: 'home', leftTab: 'layers', leftWidth: 300, rightWidth: 400, viewport: 768, zoom: 0.5, rightTab: 'inspect', chatDrafts: { c1: 'An unsent message' } }))
    );
    expect(await layoutOf(dir)).toEqual({ leftTab: 'layers', leftWidth: 300, rightWidth: 400, viewport: 768, zoom: 0.5 });
  });

  it('keeps Fit as the zoom, and the fields there are when only some were saved', async () => {
    const dir = await listed('bakery', (p) => writeFileSync(p, JSON.stringify({ zoom: 'fit', leftWidth: 220 })));
    expect(await layoutOf(dir)).toEqual({ zoom: 'fit', leftWidth: 220 });
  });

  it('leaves out a field of the wrong kind, for the editor’s defaults', async () => {
    const dir = await listed('dental', (p) => writeFileSync(p, JSON.stringify({ leftTab: false, leftWidth: '300', rightWidth: { w: 1 }, viewport: 768, zoom: 'half' })));
    expect(await layoutOf(dir)).toEqual({ viewport: 768 });
  });

  it('has no layout for a project never opened, or one whose file cannot be used', async () => {
    expect(await layoutOf(await listed('never-opened'))).toBeUndefined();
    expect(await layoutOf(await listed('broken', (p) => writeFileSync(p, '{"leftWidth": 3')))).toBeUndefined();
    expect(await layoutOf(await listed('a-list', (p) => writeFileSync(p, '[300, 400]')))).toBeUndefined();
    expect(await layoutOf(await listed('nothing-of-it', (p) => writeFileSync(p, JSON.stringify({ pageId: 'home' }))))).toBeUndefined();
    expect(await layoutOf(await listed('a-folder', (p) => mkdirSync(p)))).toBeUndefined();
  });

  it('reads the file as opening the project does: a large one, and one a link leads to', async () => {
    // Unsent messages share the file: however long they are, the outline is drawn where the editor will draw.
    const large = await listed('long-draft', (p) => writeFileSync(p, JSON.stringify({ rightWidth: 400, chatDrafts: { c1: 'x'.repeat(5 * 1024 * 1024) } })));
    expect(await layoutOf(large)).toEqual({ rightWidth: 400 });
    const elsewhere = join(root, 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify({ leftWidth: 300 }));
    expect(await layoutOf(await listed('linked', (p) => symlinkSync(elsewhere, p)))).toEqual({ leftWidth: 300 });
  });

  // A read of a pipe would wait for a writer, and the whole list with it.
  it.skipIf(process.platform === 'win32')('does not read a pipe in place of the file', async () => {
    expect(await layoutOf(await listed('piped', (p) => execFileSync('mkfifo', [p])))).toBeUndefined();
  });

  it('has no layout for a missing folder', async () => {
    const dir = await listed('moved', (p) => writeFileSync(p, JSON.stringify({ leftWidth: 300 })));
    rmSync(dir, { recursive: true, force: true });
    const entry = (await settings.recents()).find((r) => r.dir === dir);
    expect(entry?.missing).toBe(true);
    expect(entry?.layout).toBeUndefined();
  });
});
