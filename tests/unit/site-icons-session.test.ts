/**
 * Issue 584: the website's PNG icons in an open project. The session publishes them beside the generated text under
 * the same ownership rules as a theme's fonts: claimed by their bytes, never written over someone else's file, kept as
 * they are when they cannot be made, and drawn again only when what they are made from changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AssetRecord, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { FAVICON_ICO, WEB_MANIFEST } from '@shared/site-icons';
import { icoImages } from './ico';
import { siteIconSet } from '@generator/site-icons';
import { ProjectSession } from '../../src/main/project/session';
import { editedGeneratedFile } from '../../src/main/export';
import { sha } from '../../src/main/project/fsutil';
import { renderSiteIcons } from '../../src/main/project/image-variants';
import { setSiteIconRenderer, siteIconTiming, SITE_ICON_PATHS, type SiteIconRenderer } from '../../src/main/project/site-icons';

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
// Saves wait for their icons here however busy the machine is; the tests of a late set shorten the wait. Drawing on a
// loaded machine can take a while.
beforeEach(() => void (siteIconTiming.budgetMs = 60_000));
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  siteIconTiming.budgetMs = 2_000;
  setSiteIconRenderer(null);
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-icons-session-'));
  dirs.push(d);
  return d;
};
const fresh = () => createStarterState('business', 'Harbour Lane', false);
const manifest = (d: string) => JSON.parse(readFileSync(join(d, 'siteorigin/generated-manifest.json'), 'utf8')).files as Record<string, string>;
const at = async (png: Buffer, x?: number, y?: number) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = ((y ?? info.height >> 1) * info.width + (x ?? info.width >> 1)) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
};
const centre = (png: Buffer) => at(png);
const pngsIn = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.png')) : []);

/** Draws in this process, counting each set it is asked for; `fail` makes it fail as a stuck worker does. */
function renderer() {
  const r = { calls: 0, fail: false };
  const fn: SiteIconRenderer = async (data, mime, icons, opts) => {
    r.calls++;
    if (r.fail) return { ok: false, unreadable: false };
    return { ok: true, icons: await renderSiteIcons(data, mime, icons, opts) };
  };
  setSiteIconRenderer(fn);
  return r;
}

async function create(d: string, state: ProjectState = fresh()) {
  const s = await ProjectSession.create(d, state);
  s.settleMs = 0;
  sessions.push(s);
  return s;
}
async function open(d: string) {
  const s = await ProjectSession.open(d, 'test');
  s.settleMs = 0;
  sessions.push(s);
  return s;
}
const rename = (s: ProjectSession, name: string) => s.apply({ operations: [{ type: 'site.update', name }] }, { label: 'Rename' });

/** A one-colour square picture. */
const square = (color: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).png().toBuffer();

/** A project whose favicon is a picture in its library. */
async function withFavicon(d: string, color: string): Promise<ProjectState> {
  const s = fresh();
  const bytes = await square(color);
  mkdirSync(join(d, 'static/assets'), { recursive: true });
  writeFileSync(join(d, 'static/assets/logo-1a2b3c4d.png'), bytes);
  const record: AssetRecord = { id: 'as_logo', name: 'Logo', file: 'static/assets/logo-1a2b3c4d.png', mime: 'image/png', bytes: bytes.length, width: 64, height: 64, hash: sha(bytes), kind: 'image', createdAt: '' };
  s.assets.assets[record.id] = record;
  s.site.favicon = record.id;
  return s;
}

describe('the website’s icons in a project', () => {
  it('are written as PNGs with the manifest, claimed by their bytes, and kept out of the preview’s own copies', async () => {
    renderer();
    const d = tmp();
    await create(d);
    const claimed = manifest(d);
    expect(icoImages(readFileSync(join(d, 'static', FAVICON_ICO))).map((i) => i.width)).toEqual([16, 32, 48]);
    expect(claimed[`static/${FAVICON_ICO}`]).toBe(sha(readFileSync(join(d, 'static', FAVICON_ICO))));
    for (const [path, size] of [['static/apple-touch-icon.png', 180], ['static/icon-192.png', 192], ['static/icon-512.png', 512]] as const) {
      const bytes = readFileSync(join(d, path));
      expect(await sharp(bytes).metadata()).toMatchObject({ format: 'png', width: size, height: size });
      expect(claimed[path]).toBe(sha(bytes));
    }
    expect(claimed[`static/${WEB_MANIFEST}`]).toBe(sha(readFileSync(join(d, 'static', WEB_MANIFEST))));
    expect(JSON.parse(readFileSync(join(d, 'static', WEB_MANIFEST), 'utf8')).name).toBe('Harbour Lane');
    expect(await editedGeneratedFile(d)).toBeNull();
    const dev = join(d, '.siteorigin/cache/dev');
    expect(pngsIn(dev)).toEqual([]);
    // Nor on a later save that draws them again, which replaces every one of them in the project.
    const before = SITE_ICON_PATHS.map((p) => readFileSync(join(d, p)));
    expect((await rename(sessions[0], 'Renamed')).ok).toBe(true);
    expect(pngsIn(dev)).toEqual([]);
    SITE_ICON_PATHS.forEach((p, i) => expect(readFileSync(join(d, p)).equals(before[i])).toBe(false));
  });

  it('are drawn again only when what they are made from changes', async () => {
    const r = renderer();
    const d = tmp();
    const s = await create(d);
    expect(r.calls).toBe(1);
    const before = readFileSync(join(d, SITE_ICON_PATHS[2]));
    // A change the icons do not depend on draws nothing.
    expect((await s.apply({ operations: [{ type: 'site.update', description: 'Pottery.' }] }, { label: 'Describe' })).ok).toBe(true);
    expect(r.calls).toBe(1);
    // A new name is a new monogram.
    expect((await rename(s, 'Zephyr')).ok).toBe(true);
    expect(r.calls).toBe(2);
    const after = readFileSync(join(d, SITE_ICON_PATHS[2]));
    expect(after.equals(before)).toBe(false);
    expect(manifest(d)[SITE_ICON_PATHS[2]]).toBe(sha(after));
    // Undo puts the earlier icons back, the same bytes.
    expect((await s.undo()).ok).toBe(true);
    expect(readFileSync(join(d, SITE_ICON_PATHS[2])).equals(before)).toBe(true);
    // A new brand colour is a new monogram too.
    expect((await s.apply({ operations: [{ type: 'token.set', tokenId: 'color.brand', value: '#aa0000' }] }, { label: 'Brand' })).ok).toBe(true);
    expect(await at(readFileSync(join(d, SITE_ICON_PATHS[1])), 1, 1)).toEqual({ r: 0xaa, g: 0, b: 0 });
    expect(JSON.parse(readFileSync(join(d, 'static', WEB_MANIFEST), 'utf8')).theme_color).toBe('#aa0000');
  });

  it('are published on their own once ready when a save stopped waiting for them', async () => {
    renderer();
    const d = tmp();
    await (await create(d)).close();
    // Held under this app's lock, as the editor holds a project.
    const s = await open(d);
    const before = readFileSync(join(d, SITE_ICON_PATHS[2]));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setSiteIconRenderer(async (data, mime, icons) => (await gate, { ok: true, icons: await renderSiteIcons(data, mime, icons) }));
    siteIconTiming.budgetMs = 50;
    // The save waits no longer than its budget, and goes ahead with the icons as they were.
    expect((await rename(s, 'Slow')).ok).toBe(true);
    expect(readFileSync(join(d, SITE_ICON_PATHS[2])).equals(before)).toBe(true);
    expect(manifest(d)[SITE_ICON_PATHS[2]]).toBe(sha(before));
    const changed = vi.fn();
    s.on('changed', changed);
    release();
    await vi.waitFor(() => expect(readFileSync(join(d, SITE_ICON_PATHS[2])).equals(before)).toBe(false), { timeout: 20_000 });
    await vi.waitFor(() => expect(manifest(d)[SITE_ICON_PATHS[2]]).toBe(sha(readFileSync(join(d, SITE_ICON_PATHS[2])))));
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ changedDocs: [], label: 'Update site icons' }));
    expect(s.siteIconsPublished).toBe(await s.siteIconSource());
  });

  it('wait, for a new project not yet under this app’s lock, until it is opened before they are published late', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setSiteIconRenderer(async (data, mime, icons) => (await gate, { ok: true, icons: await renderSiteIcons(data, mime, icons) }));
    siteIconTiming.budgetMs = 50;
    const d = tmp();
    const s = await create(d);
    for (const p of SITE_ICON_PATHS) expect(existsSync(join(d, p))).toBe(false);
    release();
    const key = await s.siteIconSource();
    await vi.waitFor(() => expect(s.siteIconsDrawing(key)).toBe(false));
    await new Promise((r) => setTimeout(r, 100));
    // Ready, but not written by a session that has no lock: another app may have opened the project meanwhile.
    for (const p of SITE_ICON_PATHS) expect(existsSync(join(d, p))).toBe(false);
    // The editor publishes them as the project opens under its lock (here, asked for directly).
    expect(await s.refreshSiteIcons()).toEqual({ key, published: true, drawing: false });
    for (const p of SITE_ICON_PATHS) expect(manifest(d)[p]).toBe(sha(readFileSync(join(d, p))));
  });

  it('take the picture drawn once more after the monogram stood in for it', async () => {
    let refuse = true;
    setSiteIconRenderer(async (data, mime, icons, opts) => (refuse && mime === 'image/png' ? { ok: false, unreadable: true } : { ok: true, icons: await renderSiteIcons(data, mime, icons, opts) }));
    const d = tmp();
    const s = await create(d, await withFavicon(d, '#ff0000'));
    expect(await at(readFileSync(join(d, 'static/icon-192.png')), 1, 1)).toEqual({ r: 0x1f, g: 0x5a, b: 0x4c });
    refuse = false;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    // An export waits for the icons and publishes them: the same input as before, but the picture this time.
    await s.prepareSiteIcons();
    expect(await s.refreshSiteIcons()).toMatchObject({ published: true });
    expect(await centre(readFileSync(join(d, 'static/icon-192.png')))).toEqual({ r: 255, g: 0, b: 0 });
    expect(manifest(d)['static/icon-192.png']).toBe(sha(readFileSync(join(d, 'static/icon-192.png'))));
    vi.restoreAllMocks();
  });

  it('are made from the favicon picture once one is chosen, and follow its file put back or replaced with no document changing', async () => {
    renderer();
    const d = tmp();
    const s = await create(d, await withFavicon(d, '#ff0000'));
    expect(await centre(readFileSync(join(d, 'static/icon-192.png')))).toEqual({ r: 255, g: 0, b: 0 });
    writeFileSync(join(d, 'static/assets/logo-1a2b3c4d.png'), await square('#0000ff'));
    // Seen when the library's files are looked at again (the app does so when static/ changes, and before an export).
    expect(await s.refreshSiteIcons()).toEqual({ key: await s.siteIconSource(), published: true, drawing: false });
    expect(await centre(readFileSync(join(d, 'static/icon-192.png')))).toEqual({ r: 0, g: 0, b: 255 });
    const ico = async () => Promise.all(icoImages(readFileSync(join(d, 'static', FAVICON_ICO))).map((i) => centre(i.png)));
    expect(await ico()).toEqual(Array(3).fill({ r: 0, g: 0, b: 255 }));
    expect(s.siteIconsPublished).toBe(await s.siteIconSource());
    expect(await editedGeneratedFile(d)).toBeNull();
    // A missing file gives the monogram's icons; put back, the picture's again.
    const blue = readFileSync(join(d, 'static/assets/logo-1a2b3c4d.png'));
    rmSync(join(d, 'static/assets/logo-1a2b3c4d.png'));
    await s.refreshSiteIcons();
    expect(await at(readFileSync(join(d, 'static/apple-touch-icon.png')), 1, 1)).toEqual({ r: 0x1f, g: 0x5a, b: 0x4c });
    writeFileSync(join(d, 'static/assets/logo-1a2b3c4d.png'), blue);
    await s.refreshSiteIcons();
    expect(await centre(readFileSync(join(d, 'static/apple-touch-icon.png')))).toEqual({ r: 0, g: 0, b: 255 });
    // Choosing no favicon, and undoing that, takes favicon.ico to the monogram and back with the other icons.
    expect((await s.apply({ operations: [{ type: 'site.update', favicon: null }] }, { label: 'No favicon' })).ok).toBe(true);
    const corners = await Promise.all(icoImages(readFileSync(join(d, 'static', FAVICON_ICO))).map((i) => at(i.png, 1, 1)));
    expect(corners).toEqual(Array(3).fill({ r: 0x1f, g: 0x5a, b: 0x4c }));
    expect(manifest(d)[`static/${FAVICON_ICO}`]).toBe(sha(readFileSync(join(d, 'static', FAVICON_ICO))));
    expect((await s.undo()).ok).toBe(true);
    expect(await ico()).toEqual(Array(3).fill({ r: 0, g: 0, b: 255 }));
  });

  it('cost only their own update when they cannot be made: the save goes ahead and the icons already there stay claimed', async () => {
    const r = renderer();
    r.fail = true;
    const d = tmp();
    // Created while they cannot be made: no icons, nothing else missing, nothing in conflict.
    const s = await create(d);
    for (const p of SITE_ICON_PATHS) expect(existsSync(join(d, p))).toBe(false);
    expect(existsSync(join(d, 'static', WEB_MANIFEST))).toBe(true);
    expect(s.conflicts).toEqual([]);
    expect(await editedGeneratedFile(d)).toBeNull();
    // Once they can be, the next change that needs them writes them.
    r.fail = false;
    expect((await rename(s, 'Second')).ok).toBe(true);
    const made = SITE_ICON_PATHS.map((p) => readFileSync(join(d, p)));
    // Failing again, a rename still saves, and the icons there stay, neither replaced nor removed as obsolete.
    r.fail = true;
    expect((await rename(s, 'Third')).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(d, 'siteorigin/site.json'), 'utf8')).name).toBe('Third');
    expect(JSON.parse(readFileSync(join(d, 'static', WEB_MANIFEST), 'utf8')).name).toBe('Third');
    SITE_ICON_PATHS.forEach((p, i) => expect(readFileSync(join(d, p)).equals(made[i])).toBe(true));
    SITE_ICON_PATHS.forEach((p, i) => expect(manifest(d)[p]).toBe(sha(made[i])));
    expect(await editedGeneratedFile(d)).toBeNull();
    // An icon edited outside the app meanwhile is still named, though it cannot be made again now; one gone missing
    // stays claimed, so the export notices.
    writeFileSync(join(d, SITE_ICON_PATHS[1]), 'edited');
    rmSync(join(d, SITE_ICON_PATHS[2]));
    expect((await rename(s, 'Fourth')).ok).toBe(true);
    expect(s.conflicts.map((c) => c.path)).toEqual([SITE_ICON_PATHS[1]]);
    expect(readFileSync(join(d, SITE_ICON_PATHS[1]), 'utf8')).toBe('edited');
    expect(manifest(d)[SITE_ICON_PATHS[1]]).toBe(sha(made[1]));
    expect(manifest(d)[SITE_ICON_PATHS[2]]).toBe(sha(made[2]));
    expect(await editedGeneratedFile(d)).toBe(SITE_ICON_PATHS[1]);
  });

  it('keep claiming the icon a publication that stopped part way left, when they cannot be made again', async () => {
    const r = renderer();
    const d = tmp();
    await (await create(d)).close();
    const path = SITE_ICON_PATHS[0];
    const disk = sha(readFileSync(join(d, path)));
    // The older hash is still the settled one; the newer one, already on disk, is only pending.
    const m = JSON.parse(readFileSync(join(d, 'siteorigin/generated-manifest.json'), 'utf8'));
    m.files[path] = 'a'.repeat(64);
    m.pending = { [path]: disk };
    writeFileSync(join(d, 'siteorigin/generated-manifest.json'), JSON.stringify(m));
    r.fail = true;
    let s = await open(d);
    expect(manifest(d)[path]).toBe(disk);
    expect(s.conflicts).toEqual([]);
    expect(await editedGeneratedFile(d)).toBeNull();
    await s.close();
    // The settled version on disk, with a newer one only pending, keeps the settled claim.
    const m2 = JSON.parse(readFileSync(join(d, 'siteorigin/generated-manifest.json'), 'utf8'));
    m2.pending = { [path]: 'b'.repeat(64) };
    writeFileSync(join(d, 'siteorigin/generated-manifest.json'), JSON.stringify(m2));
    s = await open(d);
    expect(manifest(d)[path]).toBe(disk);
    expect(s.conflicts).toEqual([]);
  });

  it.each(['static/apple-touch-icon.png', 'static/favicon.ico'])('never replace a file of someone else’s at %s, whether or not the icons can be made', async (theirs) => {
    const r = renderer();
    r.fail = true;
    const d = tmp();
    await (await create(d)).close();
    // An older project with its own icon there, opened by this version.
    writeFileSync(join(d, theirs), 'my own icon');
    let s = await open(d);
    expect(s.conflicts.map((c) => c.path)).toEqual([theirs]);
    await s.close();
    r.fail = false;
    s = await open(d);
    expect(readFileSync(join(d, theirs), 'utf8')).toBe('my own icon');
    expect(s.conflicts.map((c) => c.path)).toEqual([theirs]);
    expect(manifest(d)[theirs]).toBeUndefined();
    // The others are written and claimed as usual.
    expect(manifest(d)['static/icon-192.png']).toBe(sha(readFileSync(join(d, 'static/icon-192.png'))));
  });

  it('keep an icon edited outside the app, and restore it byte for byte on request', async () => {
    renderer();
    const d = tmp();
    const s = await create(d);
    const original = readFileSync(join(d, 'static/icon-512.png'));
    writeFileSync(join(d, 'static/icon-512.png'), 'edited');
    expect(await editedGeneratedFile(d)).toBe('static/icon-512.png');
    expect((await rename(s, 'Renamed')).ok).toBe(true);
    expect(readFileSync(join(d, 'static/icon-512.png'), 'utf8')).toBe('edited');
    expect(s.conflicts.some((c) => c.path === 'static/icon-512.png')).toBe(true);
    await s.restoreGeneratedFile('static/icon-512.png');
    const restored = readFileSync(join(d, 'static/icon-512.png'));
    expect(await sharp(restored).metadata()).toMatchObject({ format: 'png', width: 512 });
    // Restored as it is generated now, for the new name: exactly the icon drawn from the renamed site's monogram.
    expect(restored.equals(original)).toBe(false);
    const set = siteIconSet(s.state);
    expect(restored.equals((await renderSiteIcons(Buffer.from(set.monogram), 'image/svg+xml', [{ size: 512 }]))[0])).toBe(true);
    expect(await editedGeneratedFile(d)).toBeNull();
    expect(s.conflicts).toEqual([]);
  });
});
