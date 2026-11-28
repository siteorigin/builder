/**
 * Opening a received project must always come back as a structured result: a truncated manifest names the file
 * and folder, leaves the folder untouched, and never rejects the call (which left the Open button disabled).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, promises as fsp, readFileSync, statSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {},
  shell: {}
}));

import { dialog } from 'electron';
import { Controller, readManifestSummary } from '../../src/main/controller';
import { loadSettings, trust, untrust } from '../../src/main/settings';
import { NOT_A_PROJECT_ZIP, WEBSITE_ZIP } from '../../src/main/unzip';
import { zipDirectory } from '../../src/main/zip';

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
const fingerprint = (d: string) =>
  readdirSync(d)
    .filter((f) => statSync(join(d, f)).isFile())
    .sort()
    .map((f) => `${f}:${createHash('sha256').update(readFileSync(join(d, f))).digest('hex')}`)
    .join('|');

beforeEach(() => {
  state.userData = tmp('so-userdata-');
});
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const truncated = '{"schemaVersion": 1, "projectId": "abc", "name": "Half a sit';

describe('opening a received project', () => {
  it('reports a truncated manifest by file and folder, for the chooser path and the recent path alike', async () => {
    const dir = tmp('so-truncated-');
    writeFileSync(join(dir, 'siteorigin.project.json'), truncated);
    const before = fingerprint(dir);
    const c = new Controller(() => null);
    const r = await c.open(dir);
    expect(r.ok).toBe(false);
    expect(r.needsTrust).toBeUndefined();
    expect(r.message).toContain('siteorigin.project.json');
    expect(r.message).toContain(dir);
    expect(fingerprint(dir)).toBe(before);
    // The same project reached again (the recent-project entry) behaves the same way, and a trust attempt is refused too.
    expect((await c.open(dir)).message).toBe(r.message);
    const t = await c.trustAndOpen(dir);
    expect(t.ok).toBe(false);
    expect(t.message).toContain(dir);
    expect(fingerprint(dir)).toBe(before);
  });

  it('answers a missing project folder with a normal message, not a rejection', async () => {
    const dir = tmp('so-empty-');
    const r = await new Controller(() => null).open(dir);
    expect(r).toEqual({ ok: false, message: expect.stringContaining(`The project in ${dir} was not found`) });
    const gone = join(dir, 'deleted');
    expect(await new Controller(() => null).open(gone)).toEqual({ ok: false, message: expect.stringContaining(`The project folder ${gone} was not found`) });
  });

  // #809: a Recent projects card whose folder was moved. The author chose no folder, so nothing may say they chose wrong.
  it('says a project asked for by its folder was not found, never that a chosen folder is the wrong kind', async () => {
    const gone = join(tmp('so-moved-'), 'mill-road');
    const r = await new Controller(() => null).open(gone);
    expect(r).toEqual({ ok: false, message: `The project folder ${gone} was not found. It may have been moved, renamed or deleted.` });
    // The folder is still there, but the project has gone from it.
    const emptied = tmp('so-emptied-');
    const e = await new Controller(() => null).open(emptied);
    expect(e).toEqual({ ok: false, message: `The project in ${emptied} was not found: its siteorigin.project.json is no longer there. It may have been moved, renamed or deleted.` });
    // A file now where the folder was: the folder was not found.
    const file = join(emptied, 'mill-road');
    writeFileSync(file, '');
    expect((await new Controller(() => null).open(file)).message).toBe(`The project folder ${file} was not found. It may have been moved, renamed or deleted.`);
    for (const m of [r.message, e.message]) expect(m).not.toMatch(/not a SiteOrigin Builder project|Choose a folder/);
  });

  it('still says a folder the author chose is not a project', async () => {
    const dir = tmp('so-chosen-');
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [dir] });
    const r = await new Controller(() => ({}) as never).open(undefined, { folder: true });
    expect(r).toEqual({ ok: false, message: 'That folder is not a SiteOrigin Builder project. Choose a folder that contains siteorigin.project.json.' });
  });

  it('still asks for trust on a healthy manifest, naming the project', async () => {
    const dir = tmp('so-healthy-');
    writeFileSync(join(dir, 'siteorigin.project.json'), JSON.stringify({ name: 'Cafe' }));
    const r = await new Controller(() => null).open(dir);
    expect(r.needsTrust).toEqual({ dir, name: 'Cafe', reason: 'new' });
  });
});

describe('a trusted project with a truncated manifest', () => {
  it('names the file and folder and leaves the manifest as received, so another project can be opened', async () => {
    const dir = tmp('so-trusted-');
    const file = join(dir, 'siteorigin.project.json');
    writeFileSync(file, truncated);
    const c = new Controller(() => null);
    const t = await c.trustAndOpen(dir);
    expect(t.ok).toBe(false);
    expect(t.message).toContain('siteorigin.project.json');
    expect(t.message).toContain(dir);
    // Now trusted, the recent-project entry takes the trusted path and gets the same structured answer.
    const r = await c.open(dir);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(t.message);
    expect(readFileSync(file, 'utf8')).toBe(truncated);
    expect(c.session).toBeNull();
  });
});

describe('readManifestSummary', () => {
  it.each([['empty', ''], ['truncated', truncated], ['a JSON null', 'null'], ['an array', '[]']])('rejects %s', async (_n, text) => {
    const dir = tmp('so-manifest-');
    writeFileSync(join(dir, 'siteorigin.project.json'), text);
    const r = await readManifestSummary(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(dir);
  });

  it('falls back to the folder name when the manifest has none', async () => {
    const dir = tmp('so-noname-');
    mkdirSync(join(dir, 'x'));
    writeFileSync(join(dir, 'siteorigin.project.json'), '{}');
    const r = await readManifestSummary(dir);
    expect(r.ok && r.name).toBe(basename(dir));
  });
});

describe('opening a project ZIP file (#263)', () => {
  /** An editable project exported as a ZIP file the way Builder exports one: under one `cafe-source/` folder. */
  async function editableZip(name = 'Cafe') {
    const src = tmp('so-zip-src-');
    writeFileSync(join(src, 'siteorigin.project.json'), JSON.stringify({ schemaVersion: 1, projectId: 'p_abc', name }));
    mkdirSync(join(src, 'siteorigin', 'pages'), { recursive: true });
    writeFileSync(join(src, 'siteorigin', 'pages', 'home.json'), '{"title":"Home"}');
    mkdirSync(join(src, 'static', 'assets'), { recursive: true });
    writeFileSync(join(src, 'static', 'assets', 'photo-1234abcd.jpg'), Buffer.alloc(64 * 1024, 9));
    const zip = join(tmp('so-zip-'), 'cafe-source.zip');
    await zipDirectory(src, zip, 'cafe-source');
    return zip;
  }
  /** Every file under `dir` with its contents, to tell whether a copy was touched. */
  const tree = (dir: string, base = ''): string[] =>
    readdirSync(join(dir, base)).flatMap((n) => (statSync(join(dir, base, n)).isDirectory() ? tree(dir, join(base, n)) : [`${join(base, n)}:${hash(join(dir, base, n))}`]));
  const eventuallyTrue = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(check()).toBe(true);
  };
  const chooseFolder = (dir: string) => vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [dir] });
  const hash = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

  beforeEach(() => vi.mocked(dialog.showOpenDialog).mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('unpacks an editable project ZIP into a new folder where the recipient chooses, then asks for trust', async () => {
    const zip = await editableZip();
    const before = hash(zip);
    const parent = tmp('so-recipient-');
    chooseFolder(parent);
    const c = new Controller(() => null);
    const r = await c.open(zip);
    expect(r).toEqual({ ok: false, needsTrust: { dir: join(parent, 'cafe'), name: 'Cafe', reason: 'unpacked' } });
    // The project is at the top of its folder, with its pages and media as exported, and nothing else is left beside it.
    expect(readdirSync(parent)).toEqual(['cafe']);
    expect(JSON.parse(readFileSync(join(parent, 'cafe', 'siteorigin.project.json'), 'utf8')).name).toBe('Cafe');
    expect(readFileSync(join(parent, 'cafe', 'siteorigin', 'pages', 'home.json'), 'utf8')).toBe('{"title":"Home"}');
    expect(readFileSync(join(parent, 'cafe', 'static', 'assets', 'photo-1234abcd.jpg'))).toEqual(Buffer.alloc(64 * 1024, 9));
    // Nothing opened or remembered before the recipient trusts it, and the ZIP file is as it was.
    expect(c.session).toBeNull();
    expect((await loadSettings()).recents.some((x) => x.dir.startsWith(parent))).toBe(false);
    expect(hash(zip)).toBe(before);
    // Cancelling the trust prompt keeps the working copy; opening it later asks again.
    expect((await c.open(join(parent, 'cafe'))).needsTrust).toEqual({ dir: join(parent, 'cafe'), name: 'Cafe', reason: 'new' });
  });

  it('unpacks nothing into a folder whose path the preview cannot run under, saying which, and does into one it can (#1366)', async () => {
    const zip = await editableZip();
    const parent = tmp('so-recipient-');
    const hashed = join(parent, 'Client #47');
    mkdirSync(hashed);
    const events: unknown[] = [];
    const win = { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => channel === 'projects:unpacking' && events.push(payload) } };
    const c = new Controller(() => win as never);
    chooseFolder(hashed);
    expect(await c.open(zip)).toEqual({ ok: false, message: 'The preview can’t run from a folder whose path contains “#”, and “Client #47” does. Choose a folder with no “#” or “?” anywhere in its path, or rename that folder.' });
    expect(readdirSync(hashed)).toEqual([]);
    expect(events).toEqual([]);
    // The same ZIP file into a folder with a “%” and spaces is unpacked and asks for trust.
    const percent = join(parent, 'Client 47% & %20');
    mkdirSync(percent);
    chooseFolder(percent);
    expect((await c.open(zip)).needsTrust?.dir).toBe(join(percent, 'cafe'));
  });

  it('opens the same ZIP file twice into two working copies, never overwriting the first', async () => {
    const zip = await editableZip();
    const parent = tmp('so-recipient-');
    const c = new Controller(() => null);
    chooseFolder(parent);
    expect((await c.open(zip)).needsTrust?.dir).toBe(join(parent, 'cafe'));
    // The first copy is edited meanwhile.
    writeFileSync(join(parent, 'cafe', 'siteorigin', 'pages', 'home.json'), '{"title":"Edited"}');
    const first = tree(join(parent, 'cafe'));
    chooseFolder(parent);
    expect((await c.open(zip)).needsTrust?.dir).toBe(join(parent, 'cafe-2'));
    expect(tree(join(parent, 'cafe'))).toEqual(first);
    expect(readFileSync(join(parent, 'cafe-2', 'siteorigin', 'pages', 'home.json'), 'utf8')).toBe('{"title":"Home"}');
    expect(readdirSync(parent).sort()).toEqual(['cafe', 'cafe-2']);
  });

  it('opens two ZIP files asked for at once one after the other, the unpacking dialog describing one at a time', async () => {
    const zip = await editableZip();
    const parent = tmp('so-recipient-');
    const events: unknown[] = [];
    const win = { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => channel === 'projects:unpacking' && events.push(payload) } };
    const c = new Controller(() => win as never);
    chooseFolder(parent);
    chooseFolder(parent);
    const [a, b] = await Promise.all([c.open(zip), c.open(zip)]);
    expect([a.needsTrust?.dir, b.needsTrust?.dir].sort()).toEqual([join(parent, 'cafe'), join(parent, 'cafe-2')]);
    // Each one starts at none of its files written, and may count them as it goes, before it ends.
    const starts = events.filter((e) => e === null || (e as { done: number }).done === 0);
    // The second is told the folder it will get, the first's name being taken by then.
    const start = (folder: string) => ({ name: 'Cafe', dir: parent, folder, done: 0, total: expect.any(Number) });
    expect(starts).toEqual([start('cafe'), null, start('cafe-2'), null]);
  });

  it('takes a ZIP file chosen in the Open project picker, and the picker now offers ZIP files', async () => {
    const zip = await editableZip();
    const parent = tmp('so-recipient-');
    chooseFolder(zip);
    chooseFolder(parent);
    const r = await new Controller(() => null).open();
    expect(r.needsTrust?.dir).toBe(join(parent, 'cafe'));
    const picker = (vi.mocked(dialog.showOpenDialog).mock.calls[0] as unknown[])[1] as { filters: Array<{ extensions: string[] }>; properties: string[] };
    expect(picker.filters[0].extensions).toEqual(['json', 'zip']);
    // macOS takes a folder or a file in one picker; Windows and Linux pickers take one or the other.
    expect(picker.properties).toEqual(process.platform === 'darwin' ? ['openDirectory', 'openFile'] : ['openFile']);
  });

  it('chooses a folder when asked to, on Windows and Linux too', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await new Controller(() => null).open(undefined, { folder: true })).toEqual({ ok: false });
    const picker = (vi.mocked(dialog.showOpenDialog).mock.calls[0] as unknown[])[1] as { properties: string[] };
    expect(picker.properties).toContain('openDirectory');
    if (process.platform !== 'darwin') expect(picker.properties).not.toContain('openFile');
  });

  it('explains a website ZIP and any other ZIP file without asking where to save anything', async () => {
    const site = tmp('so-site-');
    writeFileSync(join(site, 'index.html'), '<h1>Cafe</h1>');
    mkdirSync(join(site, '_app'));
    writeFileSync(join(site, '_app', 'start.js'), '');
    const websiteZip = join(tmp('so-zip-'), 'cafe-site.zip');
    await zipDirectory(site, websiteZip);
    const c = new Controller(() => null);
    expect(await c.open(websiteZip)).toEqual({ ok: false, message: WEBSITE_ZIP });
    // It says what to ask for, in the words of the sender's Export dialog.
    expect(WEBSITE_ZIP).toMatch(/editable version/);
    expect(WEBSITE_ZIP).toMatch(/Export, then Editable project, saved as a ZIP file/);
    const other = tmp('so-other-');
    writeFileSync(join(other, 'notes.txt'), 'hello');
    const otherZip = join(tmp('so-zip-'), 'notes.zip');
    await zipDirectory(other, otherZip);
    expect(await c.open(otherZip)).toEqual({ ok: false, message: NOT_A_PROJECT_ZIP });
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each([['truncated', truncated], ['null', 'null'], ['an array', '[]'], ['a number', '42']])('refuses a project ZIP whose manifest is %s, before asking where to save it', async (_n, text) => {
    const src = tmp('so-zip-src-');
    writeFileSync(join(src, 'siteorigin.project.json'), text);
    const zip = join(tmp('so-zip-'), 'half.zip');
    await zipDirectory(src, zip, 'half-source');
    const r = await new Controller(() => null).open(zip);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/siteorigin\.project\.json in that ZIP file is incomplete or damaged/);
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('still opens a project folder whose name ends in .zip as a folder', async () => {
    const dir = join(tmp('so-parent-'), 'studio.zip');
    mkdirSync(dir);
    writeFileSync(join(dir, 'siteorigin.project.json'), JSON.stringify({ name: 'Studio' }));
    expect((await new Controller(() => null).open(dir)).needsTrust).toEqual({ dir, name: 'Studio', reason: 'new' });
  });

  it('leaves nothing behind when the recipient cancels choosing a folder', async () => {
    const zip = await editableZip();
    const mkdtemp = vi.spyOn(fsp, 'mkdtemp');
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await new Controller(() => null).open(zip)).toEqual({ ok: false });
    expect(dialog.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(mkdtemp).not.toHaveBeenCalled();
  });

  it('cancels only the ZIP file being unpacked, not one waiting its turn', async () => {
    // Two projects, so each result can be told apart. Which one takes its turn first is not the order they were asked
    // for: each waits on its own check that the file is there, and either check can finish first.
    const zips = { Cafe: await editableZip('Cafe'), Bistro: await editableZip('Bistro') };
    const parent = tmp('so-recipient-');
    let unpacking: string | undefined;
    const win = { isDestroyed: () => false, webContents: { send: (channel: string, payload: { name: string } | null) => channel === 'projects:unpacking' && payload && (unpacking = payload.name) } };
    const c = new Controller(() => win as never);
    const mkdir = fsp.mkdir.bind(fsp);
    let cancelled: string | undefined;
    vi.spyOn(fsp, 'mkdir').mockImplementation(async (p, o) => {
      if (!cancelled && String(p).includes('.siteorigin-open-')) {
        cancelled = unpacking;
        c.cancelUnpacking();
      }
      return mkdir(p, o as never);
    });
    chooseFolder(parent);
    chooseFolder(parent);
    const [cafe, bistro] = await Promise.all([c.open(zips.Cafe), c.open(zips.Bistro)]);
    const results = { Cafe: cafe, Bistro: bistro };
    expect(cancelled === 'Cafe' || cancelled === 'Bistro').toBe(true);
    const waiting = cancelled === 'Cafe' ? 'Bistro' : 'Cafe';
    expect(results[cancelled as 'Cafe' | 'Bistro']).toEqual({ ok: false });
    expect(results[waiting].needsTrust?.dir).toBe(join(parent, waiting.toLowerCase()));
    expect(readdirSync(parent)).toEqual([waiting.toLowerCase()]);
  });

  it('saves a forgotten trust once a save that failed can be made, so it never comes back', async () => {
    const dir = join(tmp('so-recipient-'), 'cafe');
    await trust(dir, 'old-hash');
    const file = join(state.userData, 'settings.json');
    const saved = readFileSync(file, 'utf8');
    // The settings cannot be written: the removal fails, and the old record is still on disk.
    rmSync(file);
    mkdirSync(join(file, 'blocked'), { recursive: true });
    await expect(untrust(dir)).rejects.toThrow();
    rmSync(file, { recursive: true });
    writeFileSync(file, saved);
    await untrust(dir);
    expect(JSON.parse(readFileSync(file, 'utf8')).trusted[dir]).toBeUndefined();
  });

  it('asks nothing when its window goes while the ZIP file is being read', async () => {
    const zip = await editableZip();
    const c = new Controller(() => null);
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      if (String(args[0]) === zip) c.cancelOpen();
      return open(...args);
    });
    expect(await c.open(zip)).toEqual({ ok: false });
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('never unpacks into the open project, even through a link chosen as the folder', async () => {
    const zip = await editableZip();
    const projectDir = tmp('so-open-project-');
    mkdirSync(join(projectDir, 'src', 'routes'), { recursive: true });
    const link = join(tmp('so-links-'), 'routes-link');
    symlinkSync(join(projectDir, 'src', 'routes'), link);
    const c = new Controller(() => null);
    c.session = { dir: projectDir } as never;
    chooseFolder(link);
    const r = await c.open(zip);
    c.session = null;
    expect(r).toEqual({ ok: false, message: 'Choose a location outside the open project’s folder.' });
    expect(readdirSync(join(projectDir, 'src', 'routes'))).toEqual([]);
  });

  it('neither overwrites nor trusts settings it could not read at start', async () => {
    // A fresh start of the app whose settings file cannot be read.
    state.userData = tmp('so-userdata-unread-');
    mkdirSync(join(state.userData, 'settings.json', 'blocked'), { recursive: true });
    vi.resetModules();
    const fresh = await import('../../src/main/settings');
    await expect(fresh.untrust(join(state.userData, 'cafe'))).rejects.toThrow(/could not read its settings/);
    expect(statSync(join(state.userData, 'settings.json')).isDirectory()).toBe(true);
  });

  it('unpacks nothing when its window goes while the folder picker is up', async () => {
    const zip = await editableZip();
    const parent = tmp('so-recipient-');
    const c = new Controller(() => null);
    vi.mocked(dialog.showOpenDialog).mockImplementationOnce(async () => {
      // The editor reloads (or its window closes) while the picker is open; then a folder is chosen anyway.
      c.cancelOpen();
      return { canceled: false, filePaths: [parent] };
    });
    expect(await c.open(zip)).toEqual({ ok: false });
    expect(readdirSync(parent)).toEqual([]);
  });

  it('leaves nothing behind when the unpacking is cancelled part way', async () => {
    const zip = await editableZip();
    const parent = tmp('so-recipient-');
    const c = new Controller(() => null);
    const mkdir = fsp.mkdir.bind(fsp);
    let cancelled = false;
    vi.spyOn(fsp, 'mkdir').mockImplementation(async (p, o) => {
      // The first folder made inside the private unpacking folder: files are being written.
      if (!cancelled && String(p).includes('.siteorigin-open-')) {
        cancelled = true;
        // The unpacking dialog's Cancel.
        c.cancelUnpacking();
      }
      return mkdir(p, o as never);
    });
    chooseFolder(parent);
    expect(await c.open(zip)).toEqual({ ok: false });
    expect(cancelled).toBe(true);
    expect(readdirSync(parent)).toEqual([]);
    // A cancel with nothing being unpacked does nothing, and the next open works.
    c.cancelUnpacking();
    vi.restoreAllMocks();
    chooseFolder(parent);
    expect((await c.open(zip)).needsTrust?.dir).toBe(join(parent, 'cafe'));
  });

  it('never unpacks into a folder that appears while it unpacks, and never inherits an old folder’s trust', async () => {
    const zip = await editableZip();
    const parent = tmp('so-recipient-');
    // An earlier copy at cafe-2 was trusted, then deleted.
    await trust(join(parent, 'cafe-2'), 'old-hash');
    const mkdir = fsp.mkdir.bind(fsp);
    let appeared = false;
    vi.spyOn(fsp, 'mkdir').mockImplementation(async (p, o) => {
      if (!appeared && String(p).includes('.siteorigin-open-')) {
        appeared = true;
        // Something else makes the folder the copy would have taken.
        mkdirSync(join(parent, 'cafe'));
      }
      return mkdir(p, o as never);
    });
    chooseFolder(parent);
    const r = await new Controller(() => null).open(zip);
    expect(r.needsTrust?.dir).toBe(join(parent, 'cafe-2'));
    expect(readdirSync(join(parent, 'cafe'))).toEqual([]);
    expect((await loadSettings()).trusted[join(parent, 'cafe-2')]).toBeUndefined();
    // Forgotten on disk too, so it stays forgotten after a restart.
    await eventuallyTrue(() => !(join(parent, 'cafe-2') in JSON.parse(readFileSync(join(state.userData, 'settings.json'), 'utf8')).trusted));
  });
});
