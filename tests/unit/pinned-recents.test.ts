/**
 * Recurring client projects kept on the Recent projects list (#259). A pinned project stays listed however many
 * others are opened after it, opening it again (through Open project…, say) pushes no other project off, and its pin
 * survives a restart, a rename of its site, a link to its folder, and its moved folder being found (#217). The newest
 * twenty unpinned projects rotate as before.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const saved = () => (JSON.parse(readFileSync(join(env.userData, 'settings.json'), 'utf8')) as { recents: Array<{ dir: string; name: string; openedAt: string; pinned?: unknown }> }).recents;
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
    // The list itself stays newest first: the pin keeps the project, not a new place in the order.
    expect(list.map((r) => r.name)).toEqual(['Client 21', ...Array.from({ length: 19 }, (_, i) => `Client ${20 - i}`), 'Longstanding client']);
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
    expect(after.map((r) => [r.dir, r.pinned === true])).toEqual([[longstanding, true], ...before.map((d) => [d, false])]);
  });

  it('keeps the pin through a restart, a rename of the site, and the folder opened through a link', async () => {
    const longstanding = site('longstanding-client');
    await settings.addRecent(longstanding, 'Longstanding client', 'plong');
    await settings.pinRecent(longstanding, true);
    expect(saved()[0]).toMatchObject({ dir: longstanding, pinned: true });

    vi.resetModules();
    settings = await import('../../src/main/settings');
    await settings.renameRecent(longstanding, 'Longstanding Client Ltd');
    expect(saved().map((r) => [r.dir, r.name, r.pinned])).toEqual([[longstanding, 'Longstanding Client Ltd', true]]);
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
    const at = (dir: string, name: string, pinned = false) => ({ dir, name, openedAt: '2026-01-01T00:00:00.000Z', projectId: name, ...(pinned ? { pinned: true } : {}) });
    const s = await settings.loadSettings();
    const gone = join(root, 'gone', 'mill-road');
    const pinnedDir = site('pinned');
    const others = Array.from({ length: 19 }, (_, i) => site(`u${i + 1}`));
    // A pinned project among the newest, and Mill Road, missing, the last of twenty unpinned.
    s.recents = [at(others[0], 'U1'), at(pinnedDir, 'Pinned', true), ...others.slice(1).map((d, i) => at(d, `U${i + 2}`)), at(gone, 'Mill Road')];
    // Another project opened for Mill Road takes the place of the oldest other one only.
    const other = site('other/mill-road');
    await settings.addRecent(other, 'Mill Road', 'pother', gone);
    expect(s.recents.map((r) => r.dir)).toEqual([other, others[0], pinnedDir, ...others.slice(1, 18), gone]);
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
    expect((await settings.recents()).map((r) => [r.dir, r.pinned === true])).toEqual([[newer, true], ...ordinary.map((d) => [d, false])]);
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

  it('keeps the pin of a link that was pinned when its project’s missing entry, not pinned, is found through it', async () => {
    const gone = join(root, 'clients', 'mill-road');
    await settings.addRecent(gone, 'Mill Road', 'pmill');
    const moved = site('delivered/mill-road');
    const link = join(root, 'link-to-mill-road');
    symlinkSync(moved, link);
    await settings.addRecent(link, 'Mill Road', 'pmill');
    await settings.pinRecent(link, true);
    await settings.addRecent(moved, 'Mill Road', 'pmill', gone);
    expect((await settings.recents()).map((r) => [r.dir, r.pinned === true])).toEqual([[moved, true]]);
  });

  it('gives no pin to another project put in a pinned project’s old folder', async () => {
    const folder = join(root, 'clients', 'site');
    const at = (projectId?: string) => ({ dir: folder, name: 'Site', openedAt: '2026-01-01T00:00:00.000Z', pinned: true, ...(projectId ? { projectId } : {}) });
    const s = await settings.loadSettings();
    s.recents = [at('pold')];
    site('clients/site');
    await settings.addRecent(folder, 'New client', 'pnew');
    expect((await settings.recents()).map((r) => [r.name, r.pinned === true])).toEqual([['New client', false]]);
    // An entry listed before IDs were kept cannot be told apart from it, and keeps its pin.
    s.recents = [at()];
    await settings.addRecent(folder, 'New client', 'pnew');
    expect((await settings.recents()).map((r) => [r.name, r.pinned === true])).toEqual([['New client', true]]);
  });

  it('writes a pin again when its first write failed, and answers only once it is on disk', async (ctx) => {
    const longstanding = site('longstanding-client');
    await settings.addRecent(longstanding, 'Longstanding client', 'plong');
    chmodSync(env.userData, 0o500);
    let failed = false;
    try {
      await settings.pinRecent(longstanding, true);
    } catch {
      failed = true;
    } finally {
      chmodSync(env.userData, 0o755);
    }
    // Only where the folder really refuses the write (not for an administrator, nor on Windows).
    if (!failed) return ctx.skip();
    expect(saved()[0]).not.toHaveProperty('pinned');
    expect(await settings.pinRecent(longstanding, true)).toBe(true);
    expect(saved()[0]).toMatchObject({ dir: longstanding, pinned: true });
  });

  it('unpins a project into its place by when it was opened, where newer projects rotate it off', async () => {
    const longstanding = site('longstanding-client');
    await settings.addRecent(longstanding, 'Longstanding client', 'plong');
    await settings.pinRecent(longstanding, true);
    await twentyMore();
    const openedAt = saved().find((r) => r.dir === longstanding)?.openedAt;
    await settings.pinRecent(longstanding, false);
    expect(saved().find((r) => r.dir === longstanding)).not.toHaveProperty('pinned');
    expect(saved().find((r) => r.dir === longstanding)?.openedAt).toBe(openedAt);
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
    expect(await settings.pinRecent(longstanding, true)).toBe(false);
    expect(await settings.recents()).toEqual([]);
    const other = site('other-client');
    await settings.addRecent(other, 'Other client', 'pother');
    await settings.addRecent(longstanding, 'Longstanding client', 'plong');
    expect(await settings.pinRecent(longstanding, true)).toBe(true);
    await settings.removeRecent(longstanding);
    expect(await listed()).toEqual([['Other client', false]]);

    const odd = site('odd');
    writeFileSync(join(env.userData, 'settings.json'), JSON.stringify({ recents: [{ dir: odd, name: 'Odd', openedAt: '2026-01-01T00:00:00.000Z', pinned: 'yes' }] }));
    vi.resetModules();
    settings = await import('../../src/main/settings');
    expect(await listed()).toEqual([['Odd', false]]);
    expect(await settings.recents()).toEqual([expect.not.objectContaining({ pinned: expect.anything() })]);
  });
});
