/**
 * Issue 584: the website's PNG icons in an open project. The session publishes them beside the generated text under
 * the same ownership rules as a theme's fonts: claimed by their bytes, never written over someone else's file, kept as
 * they are when they cannot be made, and drawn again only when what they are made from changes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AssetRecord, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { WEB_MANIFEST } from '@shared/site-icons';
import { ProjectSession } from '../../src/main/project/session';
import { editedGeneratedFile } from '../../src/main/export';
import { sha } from '../../src/main/project/fsutil';
import { renderSiteIcons } from '../../src/main/project/image-variants';
import { setSiteIconRenderer, SITE_ICON_PATHS, type SiteIconRenderer } from '../../src/main/project/site-icons';

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(async () => {
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
const centre = async (png: Buffer) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = ((info.height >> 1) * info.width + (info.width >> 1)) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
};

/** Draws in this process, counting each set it is asked for; `fail` makes it fail as a stuck worker does. */
function renderer() {
  const r = { calls: 0, fail: false };
  const fn: SiteIconRenderer = async (data, mime, icons) => {
    r.calls++;
    if (r.fail) return { ok: false, unreadable: false };
    return { ok: true, icons: await renderSiteIcons(data, mime, icons) };
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
    for (const [path, size] of SITE_ICON_PATHS.map((p, i) => [p, [180, 192, 512][i]] as const)) {
      const bytes = readFileSync(join(d, path));
      expect(await sharp(bytes).metadata()).toMatchObject({ format: 'png', width: size, height: size });
      expect(claimed[path]).toBe(sha(bytes));
    }
    expect(claimed[`static/${WEB_MANIFEST}`]).toBe(sha(readFileSync(join(d, 'static', WEB_MANIFEST))));
    expect(JSON.parse(readFileSync(join(d, 'static', WEB_MANIFEST), 'utf8')).name).toBe('Harbour Lane');
    expect(await editedGeneratedFile(d)).toBeNull();
    const dev = join(d, '.siteorigin/cache/dev');
    expect(readdirSync(dev, { recursive: true }).map(String).filter((f) => f.endsWith('.png'))).toEqual([]);
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
  });

  it('are made from the favicon picture once one is chosen, and follow its file put back or replaced with no document changing', async () => {
    renderer();
    const d = tmp();
    const s = await create(d, await withFavicon(d, '#ff0000'));
    expect(await centre(readFileSync(join(d, 'static/icon-192.png')))).toEqual({ r: 255, g: 0, b: 0 });
    writeFileSync(join(d, 'static/assets/logo-1a2b3c4d.png'), await square('#0000ff'));
    // Seen when the library's files are looked at again (the app does so when static/ changes, and before an export).
    expect(await s.refreshSiteIcons()).toBe(await s.siteIconSource());
    expect(await centre(readFileSync(join(d, 'static/icon-192.png')))).toEqual({ r: 0, g: 0, b: 255 });
    expect(s.siteIconsMade).toBe(await s.siteIconSource());
    expect(await editedGeneratedFile(d)).toBeNull();
    // A missing file gives the monogram's icons; put back, the picture's again.
    const blue = readFileSync(join(d, 'static/assets/logo-1a2b3c4d.png'));
    rmSync(join(d, 'static/assets/logo-1a2b3c4d.png'));
    await s.refreshSiteIcons();
    expect(await centre(readFileSync(join(d, 'static/apple-touch-icon.png')))).not.toEqual({ r: 0, g: 0, b: 255 });
    writeFileSync(join(d, 'static/assets/logo-1a2b3c4d.png'), blue);
    await s.refreshSiteIcons();
    expect(await centre(readFileSync(join(d, 'static/apple-touch-icon.png')))).toEqual({ r: 0, g: 0, b: 255 });
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
    SITE_ICON_PATHS.forEach((p, i) => expect(readFileSync(join(d, p)).equals(made[i])).toBe(true));
    SITE_ICON_PATHS.forEach((p, i) => expect(manifest(d)[p]).toBe(sha(made[i])));
    expect(await editedGeneratedFile(d)).toBeNull();
  });

  it('never replace a file of someone else’s at an icon’s address, whether or not they can be made', async () => {
    const r = renderer();
    r.fail = true;
    const d = tmp();
    await (await create(d)).close();
    // An older project with its own home-screen icon, opened by this version.
    writeFileSync(join(d, 'static/apple-touch-icon.png'), 'my own icon');
    let s = await open(d);
    expect(s.conflicts.map((c) => c.path)).toEqual(['static/apple-touch-icon.png']);
    await s.close();
    r.fail = false;
    s = await open(d);
    expect(readFileSync(join(d, 'static/apple-touch-icon.png'), 'utf8')).toBe('my own icon');
    expect(s.conflicts.map((c) => c.path)).toEqual(['static/apple-touch-icon.png']);
    expect(manifest(d)['static/apple-touch-icon.png']).toBeUndefined();
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
    // Restored as it is generated now, for the new name.
    expect(restored.equals(original)).toBe(false);
    expect(await editedGeneratedFile(d)).toBeNull();
    expect(s.conflicts).toEqual([]);
  });
});
