/**
 * Recurring client projects kept on the Recent projects list (#259). A pinned project stays listed however many
 * others are opened after it, opening it again (through Open project…, say) pushes no other project off, and its pin
 * survives a restart, a rename of its site, a link to its folder, and its moved folder being found (#217). The newest
 * twenty unpinned projects rotate as before.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  env.userData = realpathSync(mkdtempSync(join(tmpdir(), 'so-pin-userdata-')));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'so-pin-sites-')));
  dirs.push(env.userData, root);
  vi.resetModules();
  settings = await import('../../src/main/settings');
});
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A project folder with a manifest, so its card is not shown as missing. */
function site(folder: string): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'siteorigin.project.json'), '{}');
  return dir;
}
const listed = async () => (await settings.recents()).map((r) => [r.name, r.pinned === true]);
const saved = () => (JSON.parse(readFileSync(join(env.userData, 'settings.json'), 'utf8')) as { recents: Array<{ dir: string; name: string; pinned?: unknown }> }).recents;
/** Twenty more client sites opened after the first, newest last. */
async function twentyMore() {
  for (let i = 1; i <= 20; i++) await settings.addRecent(site(`client-${i}`), `Client ${i}`, `client-${i}`);
}

describe('a pinned project on the Recent projects list (#259)', () => {
  it('drops the oldest project once twenty more are opened, as before, unless it is pinned', async () => {
    const longstanding = site('longstanding-client');
    await settings.addRecent(longstanding, 'Longstanding client', 'plong');
    await twentyMore();
    expect((await settings.recents()).map((r) => r.dir)).not.toContain(longstanding);
    expect(await settings.recents()).toHaveLength(20);

    await settings.addRecent(longstanding, 'Longstanding client', 'plong');
    await settings.pinRecent(longstanding, true);
    await twentyMore();
    await settings.addRecent(site('client-21'), 'Client 21', 'client-21');
    const list = await settings.recents();
    // Twenty-one projects opened after it, and it is still listed, pinned, with the newest twenty of the rest.
    expect(list).toHaveLength(21);
    expect(list.filter((r) => r.pinned).map((r) => [r.dir, r.missing])).toEqual([[longstanding, false]]);
    expect(list.filter((r) => !r.pinned).map((r) => r.name)).toEqual(['Client 21', ...Array.from({ length: 19 }, (_, i) => `Client ${20 - i}`)]);
  });

  it('pushes no other project off when a pinned one is opened again, and keeps it pinned', async () => {
    const longstanding = site('longstanding-client');
    await settings.addRecent(longstanding, 'Longstanding client', 'plong');
    await settings.pinRecent(longstanding, true);
    await twentyMore();
    const before = (await settings.recents()).filter((r) => !r.pinned).map((r) => r.dir);
    expect(before).toHaveLength(20);
    // Reopened through Open project… (the native picker): the same folder, listed again as the newest.
    await settings.addRecent(longstanding, 'Longstanding client', 'plong');
    const after = await settings.recents();
    expect(after[0]).toMatchObject({ dir: longstanding, pinned: true });
    expect(after.filter((r) => !r.pinned).map((r) => r.dir)).toEqual(before);
  });

  it('keeps the pin through a restart, a rename of the site, and the folder opened through a link', async () => {
    const longstanding = site('longstanding-client');
    await settings.addRecent(longstanding, 'Longstanding client', 'plong');
    await settings.pinRecent(longstanding, true);
    expect(saved()[0]).toMatchObject({ dir: longstanding, pinned: true });

    vi.resetModules();
    settings = await import('../../src/main/settings');
    await settings.renameRecent(longstanding, 'Longstanding Client Ltd');
    const link = join(root, 'shortcut');
    symlinkSync(longstanding, link);
    await settings.addRecent(link, 'Longstanding Client Ltd', 'plong');
    expect((await settings.recents()).map((r) => [r.dir, r.name, r.pinned])).toEqual([[link, 'Longstanding Client Ltd', true]]);
  });

  it('keeps the pin when the moved folder of a pinned project takes over its missing entry, and not for another project', async () => {
    const gone = join(root, 'clients', 'mill-road');
    await settings.addRecent(gone, 'Mill Road', 'pmill');
    await settings.pinRecent(gone, true);
    await twentyMore();
    // Another project called Mill Road, chosen for the missing card, is listed as itself and leaves the card pinned.
    const other = site('another/mill-road');
    await settings.addRecent(other, 'Mill Road', 'pother', gone);
    let list = await settings.recents();
    expect(list.filter((r) => r.pinned).map((r) => [r.dir, r.missing])).toEqual([[gone, true]]);
    expect(list.find((r) => r.dir === other)?.pinned).toBeUndefined();
    // The same project, found in its new folder, takes the entry over with its pin.
    const moved = site('delivered/mill-road');
    await settings.addRecent(moved, 'Mill Road', 'pmill', gone);
    list = await settings.recents();
    expect(list.filter((r) => r.pinned).map((r) => [r.dir, r.missing])).toEqual([[moved, false]]);
    expect(list.map((r) => r.dir)).not.toContain(gone);
    expect(list.filter((r) => !r.pinned)).toHaveLength(20);
  });

  it('never lets a pinned entry use up a place the #217 rule keeps for a missing one', async () => {
    const pinnedDir = site('pinned');
    await settings.addRecent(pinnedDir, 'Pinned', 'ppin');
    await settings.pinRecent(pinnedDir, true);
    const gone = join(root, 'gone', 'mill-road');
    await settings.addRecent(gone, 'Mill Road', 'pmill');
    for (let i = 1; i <= 19; i++) await settings.addRecent(site(`client-${i}`), `Client ${i}`, `client-${i}`);
    // Mill Road is the oldest of the twenty unpinned now; another project opened for it does not push it off.
    await settings.addRecent(site('other/mill-road'), 'Mill Road', 'pother', gone);
    const list = await settings.recents();
    const unpinned = list.filter((r) => !r.pinned);
    expect(unpinned).toHaveLength(20);
    expect(unpinned.at(-1)?.dir).toBe(gone);
    expect(list.filter((r) => r.pinned).map((r) => r.dir)).toEqual([pinnedDir]);
    expect(list.map((r) => r.name)).not.toContain('Client 1');
  });

  it('takes no project off when a pinned one is opened while an unpin has left more than twenty', async () => {
    const [older, newer] = [site('older-client'), site('newer-client')];
    for (const [dir, name] of [[older, 'Older client'], [newer, 'Newer client']]) {
      await settings.addRecent(dir, name, name);
      await settings.pinRecent(dir, true);
    }
    await twentyMore();
    await settings.pinRecent(older, false);
    const ordinary = (await settings.recents()).filter((r) => !r.pinned).map((r) => r.dir);
    expect(ordinary).toHaveLength(21);
    await settings.addRecent(newer, 'Newer client', 'Newer client');
    expect((await settings.recents()).filter((r) => !r.pinned).map((r) => r.dir)).toEqual(ordinary);
  });

  it('leaves one pinned entry when a pinned project’s moved folder is found where a link already listed it', async () => {
    const gone = join(root, 'clients', 'mill-road');
    await settings.addRecent(gone, 'Mill Road', 'pmill');
    await settings.pinRecent(gone, true);
    const moved = site('delivered/mill-road');
    const link = join(root, 'link-to-mill-road');
    symlinkSync(moved, link);
    await settings.addRecent(link, 'Mill Road', 'pmill');
    await settings.addRecent(moved, 'Mill Road', 'pmill', gone);
    expect((await settings.recents()).map((r) => [r.dir, r.pinned === true, r.missing])).toEqual([[moved, true, false]]);
  });

  it('unpins a project into its place by when it was opened, where newer projects rotate it off', async () => {
    const longstanding = site('longstanding-client');
    await settings.addRecent(longstanding, 'Longstanding client', 'plong');
    await settings.pinRecent(longstanding, true);
    await twentyMore();
    await settings.pinRecent(longstanding, false);
    expect(saved().find((r) => r.dir === longstanding)).not.toHaveProperty('pinned');
    // Unpinning takes nothing off at once...
    expect((await settings.recents()).at(-1)).toMatchObject({ dir: longstanding });
    expect(await settings.recents()).toHaveLength(21);
    // ...and the next opening keeps the newest twenty.
    await settings.addRecent(site('client-21'), 'Client 21', 'client-21');
    expect((await settings.recents()).map((r) => r.dir)).not.toContain(longstanding);
    expect(await settings.recents()).toHaveLength(20);
  });

  it('pins only a listed folder, removes a pinned one on its own, and reads a hand-edited pin as none', async () => {
    const longstanding = site('longstanding-client');
    await settings.pinRecent(longstanding, true);
    expect(await settings.recents()).toEqual([]);
    await settings.addRecent(longstanding, 'Longstanding client', 'plong');
    await settings.pinRecent(longstanding, true);
    await settings.removeRecent(longstanding);
    expect(await settings.recents()).toEqual([]);

    const odd = site('odd');
    writeFileSync(join(env.userData, 'settings.json'), JSON.stringify({ recents: [{ dir: odd, name: 'Odd', openedAt: '2026-01-01T00:00:00.000Z', pinned: 'yes' }] }));
    vi.resetModules();
    settings = await import('../../src/main/settings');
    expect(await listed()).toEqual([['Odd', false]]);
    expect(await settings.recents()).toEqual([expect.not.objectContaining({ pinned: expect.anything() })]);
  });
});
