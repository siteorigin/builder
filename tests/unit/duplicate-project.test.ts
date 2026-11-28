/**
 * Duplicate project (#176): the copy gets its own name, kept through every opening and close, beside the site's
 * own visitor-facing name; the destination is checked before anything is written.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for Electron's utility process that starts at once and exits when asked to stop. */
class FakeWorker extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exited = false;
  postMessage(m: { type: string }) {
    if (m.type === 'start') queueMicrotask(() => this.emit('message', { type: 'ready', url: 'http://127.0.0.1:1' }));
    if (m.type === 'stop') this.kill();
  }
  kill() {
    if (this.exited) return true;
    this.exited = true;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  utilityProcess: { fork: () => new FakeWorker() }
}));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { sha } = await import('../../src/main/project/fsutil');
const { recents } = await import('../../src/main/settings');
const { MAX_COPY_NAME, projectDisplayName, projectFolderName } = await import('@shared/project-name');

const dirs: string[] = [];
const controllers: InstanceType<typeof Controller>[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-dup-${name}-`)));
  dirs.push(d);
  return d;
};

beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function makeProject(parent: string, folder: string, name: string): Promise<string> {
  const dir = join(parent, folder);
  mkdirSync(dir);
  const created = await ProjectSession.create(dir, createStarterState('blank', name, false));
  await created.close();
  const pkg = '{"name":"site","type":"module"}';
  const lock = JSON.stringify({ name: 'site', lockfileVersion: 3, requires: true, packages: { '': { name: 'site' } } }, null, 2) + '\n';
  writeFileSync(join(dir, 'package.json'), pkg);
  writeFileSync(join(dir, 'package-lock.json'), lock);
  writeFileSync(join(dir, 'vite.config.js'), 'export default {};');
  mkdirSync(join(dir, 'node_modules/@sveltejs/kit'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/@sveltejs/kit/package.json'), '{"name":"@sveltejs/kit"}');
  mkdirSync(join(dir, 'node_modules/.bin'));
  symlinkSync('../@sveltejs/kit/package.json', join(dir, 'node_modules/.bin/kit'));
  writeFileSync(join(dir, '.siteorigin/cache/deps.json'), JSON.stringify({ lockHash: sha(lock + pkg), preparedAt: '2026-01-01T00:00:00.000Z' }));
  return dir;
}

function controller() {
  const c = new Controller(() => null);
  c.send = () => undefined;
  controllers.push(c);
  return c;
}

/** A file chosen from outside the project, in a folder of its own. */
function sourceFile(name: string, text: string): string {
  const file = join(temp('source'), name);
  writeFileSync(file, text);
  return file;
}

const recentName = async (dir: string) => (await recents()).find((r) => r.dir === dir)?.name;
const read = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
const siteName = (dir: string) => read(dir, 'siteorigin/site.json').name as string;

describe('the name a project is shown by', () => {
  it('is a working copy’s own name when it has one, and the site’s name otherwise', () => {
    expect(projectDisplayName({ manifest: {}, site: { name: 'Storefront' } })).toBe('Storefront');
    expect(projectDisplayName({ manifest: { workingCopyName: '  Fall Campaign ' }, site: { name: 'Storefront' } })).toBe('Fall Campaign');
    expect(projectDisplayName({ manifest: { workingCopyName: '  ' }, site: { name: 'Storefront' } })).toBe('Storefront');
    expect(projectFolderName('Fall Campaign')).toBe('fall-campaign');
    expect(projectFolderName('***')).toBe('website');
    // Names Windows keeps for devices are never a folder's whole name.
    expect(projectFolderName('Con')).toBe('con-site');
    expect(projectFolderName('LPT1')).toBe('lpt1-site');
    expect(projectFolderName('Console')).toBe('console');
    // The folder New project shows and makes (#808): a long name ends at a word, other scripts keep their words.
    expect(projectFolderName('Kowhai Garden Supplies and Landscaping Co-operative of Greater Wellington')).toBe('kowhai-garden-supplies-and-landscaping-co-operative-of');
    expect(projectFolderName('a'.repeat(70))).toBe('a'.repeat(60));
    expect(projectFolderName('日本語サイト')).toBe('日本語サイト');
    expect(projectFolderName('🌸🌸')).toBe('website');
    expect(projectFolderName('...')).toBe('website');
  });
});

describe('a duplicated project (#176)', () => {
  it('keeps the name it was given through opening, a rename of its site and closing, and leaves the original as it was', async () => {
    const sites = temp('sites');
    const original = await makeProject(sites, 'storefront', 'Storefront');
    const c = controller();
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    const originalKey = c.openingKey!;
    const manifestBefore = readFileSync(join(original, 'siteorigin.project.json'), 'utf8');
    const siteBefore = readFileSync(join(original, 'siteorigin/site.json'), 'utf8');

    const dup = await c.duplicate({ name: '  Fall   Campaign ', parentDir: sites, opening: originalKey });
    const copy = join(sites, 'fall-campaign');
    expect(dup).toEqual({ ok: true, dir: copy, name: 'Fall Campaign' });
    // The original stays open, and Recent projects lists the copy by its own name.
    expect(c.session?.dir).toBe(original);
    expect(c.openingKey).toBe(originalKey);
    expect(await recentName(copy)).toBe('Fall Campaign');
    // A project of its own, with the site as it was: visitors still see Storefront.
    const manifest = read(copy, 'siteorigin.project.json');
    expect(manifest.projectId).not.toBe(read(original, 'siteorigin.project.json').projectId);
    expect(manifest).toMatchObject({ name: 'Fall Campaign', workingCopyName: 'Fall Campaign' });
    expect(siteName(copy)).toBe('Storefront');
    expect(readdirSync(sites).sort()).toEqual(['fall-campaign', 'storefront']);

    // Open copy: trusted already, so it opens without asking, and the editor shows the copy's name.
    expect(await c.open(copy)).toEqual({ ok: true });
    expect(c.session?.dir).toBe(copy);
    expect(projectDisplayName(c.snapshot()!.state)).toBe('Fall Campaign');
    expect(await recentName(copy)).toBe('Fall Campaign');
    // An edit still meant for the original is refused once the copy is open; one made in the copy lands there.
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'Lost' }] }, { opening: originalKey })).ok).toBe(false);
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'Fall Storefront' }] }, { label: 'Rename site', opening: c.openingKey! })).ok).toBe(true);
    expect(await c.flush()).toBe(true);
    expect(siteName(copy)).toBe('Fall Storefront');
    // The working copy's name is not the brand: renaming the site leaves it.
    expect(await recentName(copy)).toBe('Fall Campaign');
    await c.close();
    expect(await recentName(copy)).toBe('Fall Campaign');
    expect(await recentName(original)).toBe('Storefront');

    // Kept on disk through the session's own writes, so it is the same after opening again.
    expect(await c.open(copy)).toEqual({ ok: true });
    expect(c.snapshot()!.state.manifest.workingCopyName).toBe('Fall Campaign');
    expect(c.snapshot()!.state.site.name).toBe('Fall Storefront');
    await c.close();
    expect(await recentName(copy)).toBe('Fall Campaign');
    // Nothing reached the original.
    expect(readFileSync(join(original, 'siteorigin.project.json'), 'utf8')).toBe(manifestBefore);
    expect(readFileSync(join(original, 'siteorigin/site.json'), 'utf8')).toBe(siteBefore);
  });

  it('carries the project brief (#518), which each project then keeps for itself', async () => {
    const sites = temp('sites');
    const original = await makeProject(sites, 'storefront', 'Storefront');
    const c = controller();
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    const brief = { description: 'The Storefront shop site.', notes: 'Client: Ana.\nLaunch before the autumn sale.' };
    expect((await c.apply({ operations: [{ type: 'brief.update', ...brief }] }, { label: 'Edit project notes', opening: c.openingKey! })).ok).toBe(true);
    expect(await c.flush()).toBe(true);
    expect(await c.duplicate({ name: 'Fall Campaign', parentDir: sites, opening: c.openingKey! })).toMatchObject({ ok: true });
    const copy = join(sites, 'fall-campaign');
    expect(read(copy, 'siteorigin/brief.json')).toMatchObject(brief);
    expect((await recents()).find((r) => r.dir === copy)?.description).toBe(brief.description);
    // Edited in the copy, the brief changes there alone.
    expect(await c.open(copy)).toEqual({ ok: true });
    expect(c.snapshot()!.state.brief).toMatchObject(brief);
    expect((await c.apply({ operations: [{ type: 'brief.update', description: 'The autumn campaign.' }] }, { label: 'Edit project description', opening: c.openingKey! })).ok).toBe(true);
    await c.close();
    expect(read(copy, 'siteorigin/brief.json')).toMatchObject({ description: 'The autumn campaign.', notes: brief.notes });
    expect(read(original, 'siteorigin/brief.json')).toMatchObject(brief);
  });

  it('carries the current Assets and the files the site’s own source uses, never a replaced file kept for undo (#1378)', async () => {
    const sites = temp('sites');
    const original = await makeProject(sites, 'storefront', 'Storefront');
    const c = controller();
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    const s = c.session!;
    const imported = await c.importAssets([sourceFile('Guide.txt', 'First edition.'), sourceFile('Briefing.txt', 'Press briefing.')], 'document');
    expect(imported).toMatchObject({ ok: true });
    const [guide, briefing] = imported.assetIds;
    const retired = s.state.assets.assets[guide].file;
    // A new edition of the guide (Replace file…): the first stays in the original, for undo and its saved versions.
    expect(await c.locateAsset(guide, sourceFile('Guide.txt', 'Second edition.'))).toMatchObject({ ok: true });
    const current = s.state.assets.assets[guide].file;
    expect(current).not.toBe(retired);
    expect(existsSync(join(original, retired))).toBe(true);
    // A file the owner put among the assets, and one only hand-written source names, are the site’s own.
    writeFileSync(join(original, 'static/assets/price-list.txt'), 'Prices.');
    writeFileSync(join(original, 'static/assets/map-0a1b2c3d.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    // A picture deleted from Assets, kept for undo like the first edition.
    writeFileSync(join(original, 'static/assets/old-photo-0f1e2d3c.jpg'), 'old photo');
    mkdirSync(join(original, 'src/routes/visit'), { recursive: true });
    writeFileSync(join(original, 'src/routes/visit/+page.svelte'), '<img src="/assets/map-0a1b2c3d.svg" alt="Map" />\n');
    expect(await c.flush()).toBe(true);

    expect(await c.duplicate({ name: 'Fall Campaign', parentDir: sites, opening: c.openingKey! })).toMatchObject({ ok: true });
    const copy = join(sites, 'fall-campaign');
    // Every document in Assets, linked or not, with the edition it holds now.
    expect(readFileSync(join(copy, current), 'utf8')).toBe('Second edition.');
    expect(readFileSync(join(copy, s.state.assets.assets[briefing].file), 'utf8')).toBe('Press briefing.');
    expect(existsSync(join(copy, 'static/assets/price-list.txt'))).toBe(true);
    expect(existsSync(join(copy, 'static/assets/map-0a1b2c3d.svg'))).toBe(true);
    // The copy has none of the original’s history, so the old edition would only be published from it.
    expect(existsSync(join(copy, retired))).toBe(false);
    expect(existsSync(join(copy, 'static/assets/old-photo-0f1e2d3c.jpg'))).toBe(false);
    expect(existsSync(join(original, retired))).toBe(true);
    expect(existsSync(join(original, 'static/assets/old-photo-0f1e2d3c.jpg'))).toBe(true);
  });

  it('refuses a destination the copy’s preview could not run from, and copies a project out of one (#1366)', async () => {
    const sites = temp('sites');
    const hashed = join(sites, 'Client #47');
    mkdirSync(hashed);
    const original = await makeProject(hashed, 'storefront', 'Storefront');
    const c = controller();
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    // Into a folder with a “#” or “?” in its path, or reached through a link to one: nothing is made.
    const asked = join(sites, 'Archive ?8');
    mkdirSync(asked);
    symlinkSync(hashed, join(sites, 'linked'));
    for (const parentDir of [hashed, asked, join(sites, 'linked')]) {
      const r = await c.duplicate({ name: 'Copy', parentDir, opening: c.openingKey! });
      expect(r).toMatchObject({ ok: false, field: 'location', message: expect.stringMatching(/^The preview can’t run from a folder whose path contains “[#?]”, and “(Client #47|Archive \?8)” does\. Choose a folder with no “#” or “\?” anywhere in its path/) });
    }
    expect(readdirSync(hashed)).toEqual(['storefront']);
    expect(readdirSync(asked)).toEqual([]);
    // A folder without them is where the project goes on from.
    expect(await c.duplicate({ name: 'Copy', parentDir: sites, opening: c.openingKey! })).toMatchObject({ ok: true });
    expect(existsSync(join(sites, 'copy', 'siteorigin.project.json'))).toBe(true);
  });

  it('explains a name or destination it cannot use, and writes nothing', async () => {
    const sites = temp('sites');
    const original = await makeProject(sites, 'storefront', 'Storefront');
    const c = controller();
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    const opening = c.openingKey!;
    // A folder by the copy's name that already holds something is never written into.
    mkdirSync(join(sites, 'fall-campaign'));
    writeFileSync(join(sites, 'fall-campaign', 'notes.txt'), 'mine');
    expect(await c.duplicate({ name: 'Fall Campaign', parentDir: sites, opening })).toEqual({
      ok: false,
      field: 'name',
      message: 'A folder named “fall-campaign” is already there. Choose another name or folder.'
    });
    expect(readdirSync(join(sites, 'fall-campaign'))).toEqual(['notes.txt']);
    expect(await c.duplicate({ name: '   ', parentDir: sites, opening })).toMatchObject({ ok: false, field: 'name' });
    expect(await c.duplicate({ name: 'x'.repeat(MAX_COPY_NAME + 1), parentDir: sites, opening })).toMatchObject({ ok: false, field: 'name' });
    // An empty folder is someone's too (another copy's or an export's, claimed and still being filled).
    mkdirSync(join(sites, 'spring'));
    expect(await c.duplicate({ name: 'Spring', parentDir: sites, opening })).toMatchObject({ ok: false, field: 'name', message: expect.stringMatching(/“spring” is already there/) });
    expect(readdirSync(join(sites, 'spring'))).toEqual([]);
    // A folder renamed or removed since it was chosen is not made again under its old name.
    expect(await c.duplicate({ name: 'Copy', parentDir: join(sites, 'gone'), opening })).toMatchObject({ ok: false, field: 'location', message: expect.stringMatching(/no longer there/) });
    expect(await c.duplicate({ name: 'Copy', parentDir: 'relative/folder', opening })).toMatchObject({ ok: false, field: 'location' });
    // Chosen in an opening that has since closed, even of the same project.
    await c.close();
    expect(await c.duplicate({ name: 'Copy', parentDir: sites, opening })).toMatchObject({ ok: false, field: 'form' });
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    expect(await c.duplicate({ name: 'Copy', parentDir: sites, opening })).toMatchObject({ ok: false, field: 'form' });
    expect(readdirSync(sites).sort()).toEqual(['fall-campaign', 'spring', 'storefront']);
    // A name as long as allowed is taken.
    const longest = 'x'.repeat(MAX_COPY_NAME);
    expect(await c.duplicate({ name: longest, parentDir: sites, opening: c.openingKey! })).toMatchObject({ ok: true, name: longest });
  });

  it('copies nothing once the project closes before the copy starts, removing the folder it claimed', async () => {
    const sites = temp('sites');
    const original = await makeProject(sites, 'storefront', 'Storefront');
    const c = controller();
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    // Asked in this opening, which ends before the copy is read.
    const copying = c.duplicate({ name: 'Fall Campaign', parentDir: sites, opening: c.openingKey! });
    const closing = c.close();
    expect(await copying).toMatchObject({ ok: false, field: 'form' });
    await closing;
    expect(readdirSync(sites)).toEqual(['storefront']);
    expect(await recentName(join(sites, 'fall-campaign'))).toBeUndefined();
  });

  it('copies nothing once quitting has begun', async () => {
    const sites = temp('sites');
    const original = await makeProject(sites, 'storefront', 'Storefront');
    const c = controller();
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    c.quitting = true;
    expect(await c.duplicate({ name: 'Fall Campaign', parentDir: sites, opening: c.openingKey! })).toMatchObject({ ok: false, field: 'form' });
    expect(readdirSync(sites)).toEqual(['storefront']);
    expect(c.isDuplicating).toBe(false);
  });

  it('is trusted only while the original’s setup files are the ones that were trusted', async () => {
    const sites = temp('sites');
    const original = await makeProject(sites, 'storefront', 'Storefront');
    const c = controller();
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    // Changed on disk after the original was trusted and opened.
    writeFileSync(join(original, 'vite.config.js'), 'export default { plugins: [] };');
    const dup = await c.duplicate({ name: 'Fall Campaign', parentDir: sites, opening: c.openingKey! });
    expect(dup.ok).toBe(true);
    // Open copy asks first, as opening the original again would.
    expect(await c.open(join(sites, 'fall-campaign'))).toMatchObject({ ok: false, needsTrust: { dir: join(sites, 'fall-campaign'), name: 'Fall Campaign' } });
    expect(c.session?.dir).toBe(original);
  });

  it('lets only one of two copies to the same new folder land, leaving nothing of the other', async () => {
    const sites = temp('sites');
    const original = await makeProject(sites, 'storefront', 'Storefront');
    const c = controller();
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    const opts = { name: 'Fall Campaign', parentDir: sites, opening: c.openingKey! };
    const results = await Promise.all([c.duplicate(opts), c.duplicate(opts)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ field: 'name', message: expect.stringMatching(/is already there/) });
    expect(readdirSync(sites).sort()).toEqual(['fall-campaign', 'storefront']);
    expect(read(join(sites, 'fall-campaign'), 'siteorigin.project.json').workingCopyName).toBe('Fall Campaign');
  });

  it('copies nothing while the project does not hold every change yet, as Export refuses (#1373)', async () => {
    const sites = temp('sites');
    const original = await makeProject(sites, 'storefront', 'Storefront');
    const c = controller();
    expect((await c.trustAndOpen(original)).ok).toBe(true);
    const opts = { name: 'Fall Campaign', parentDir: sites, opening: c.openingKey! };
    const session = (c as unknown as { session: { unsettled: boolean; placeJournal: (...a: unknown[]) => Promise<void> } }).session;
    // The AI is still making changes, which Stop would take back.
    const aiBusy = c.aiBusy;
    c.aiBusy = () => true;
    expect(await c.duplicate(opts)).toEqual({ ok: false, field: 'form', message: 'Wait for the AI to finish before duplicating the project.' });
    c.aiBusy = aiBusy;
    // A save did not finish.
    session.unsettled = true;
    expect(await c.duplicate(opts)).toMatchObject({ ok: false, field: 'form', message: expect.stringMatching(/^A save did not finish/) });
    session.unsettled = false;
    // A change failed to save, and still stands.
    const placeJournal = session.placeJournal.bind(session);
    const failNext = () =>
      (session.placeJournal = async () => {
        session.placeJournal = placeJournal;
        throw new Error('ENOSPC: no space left on device');
      });
    failNext();
    // The editor hears that its change was not saved, as a refusal (#1435).
    const unsaved = { ok: false, error: { code: 'SAVE_FAILED', message: expect.stringMatching(/^That change could not be saved: /), recoverable: true, details: { save: 'failed' } } };
    expect(await c.apply({ operations: [{ type: 'site.update', name: 'Lost name' }] })).toMatchObject(unsaved);
    const lost = { ok: false, field: 'form', message: expect.stringMatching(/^A change could not be saved, so the copy would leave it out/) };
    expect(await c.duplicate(opts)).toMatchObject(lost);
    expect(readdirSync(sites)).toEqual(['storefront']);
    // Once a later save succeeds, nothing is left out.
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'Kept name' }] })).ok).toBe(true);
    // A save queued ahead of the copy that fails is caught once it has run, and the folder claimed for the copy goes.
    failNext();
    const failing = c.apply({ operations: [{ type: 'site.update', name: 'Lost again' }] });
    const copying = c.duplicate(opts);
    expect(await failing).toMatchObject(unsaved);
    expect(await copying).toMatchObject(lost);
    expect(readdirSync(sites)).toEqual(['storefront']);
    expect((await c.apply({ operations: [{ type: 'site.update', name: 'Kept name' }] })).ok).toBe(true);
    expect(await c.duplicate(opts)).toMatchObject({ ok: true });
    expect(siteName(join(sites, 'fall-campaign'))).toBe('Kept name');
  });
});
