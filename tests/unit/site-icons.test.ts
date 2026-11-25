/**
 * Issue 584: what a website gives home screens, bookmarks and installed shortcuts beside its favicon. The generator
 * writes the web app manifest and the head tags and says what the PNG icons are made from; the media worker draws
 * them; each session keeps the last set so a save that changes nothing they are made from draws nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { compile } from 'svelte/compiler';
import type { AssetRecord, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { generateProject } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { generateWebManifest, siteIconSet, themeColorMeta } from '@generator/site-icons';
import { APPLE_TOUCH_ICON, SITE_ICON_FILES, WEB_MANIFEST } from '@shared/site-icons';
import { validateRoute } from '@shared/routes';
import { heldAsMedia } from '../../src/main/project/versions';
import { handleVariantRequest, renderSiteIcons } from '../../src/main/project/image-variants';
import { setSiteIconRenderer, SiteIconMaker, SITE_ICON_PATHS, type SiteIconRenderer } from '../../src/main/project/site-icons';

const fresh = () => createStarterState('business', 'Test Studio', false);
const dirs: string[] = [];
afterEach(() => {
  setSiteIconRenderer(null);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-icons-'));
  dirs.push(d);
  return d;
};

/** The colour of one pixel of a PNG, with its alpha (255 for a picture without an alpha channel). */
async function pixel(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}
const hex = (p: { r: number; g: number; b: number }) => '#' + [p.r, p.g, p.b].map((v) => v.toString(16).padStart(2, '0')).join('');

/** A favicon picture in a project folder, and the state that chooses it. */
function withFavicon(dir: string, bytes: Buffer, mime = 'image/png', name = 'logo-1a2b3c4d.png'): ProjectState {
  const s = fresh();
  mkdirSync(join(dir, 'static/assets'), { recursive: true });
  writeFileSync(join(dir, 'static/assets', name), bytes);
  const record: AssetRecord = { id: 'as_logo', name: 'Logo', file: `static/assets/${name}`, mime, bytes: bytes.length, width: 64, height: 32, hash: 'x', kind: 'image', createdAt: '' };
  s.assets.assets[record.id] = record;
  s.site.favicon = record.id;
  return s;
}

/** A 200×100 picture: a red bar across the middle on a see-through ground. */
const wideLogo = () =>
  sharp({ create: { width: 200, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: 200, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }, top: 30, left: 0 }])
    .png()
    .toBuffer();

const inProcess: SiteIconRenderer = async (data, mime, icons) => {
  try {
    return { ok: true, icons: await renderSiteIcons(data, mime, icons) };
  } catch {
    return { ok: false, unreadable: true };
  }
};

describe('the web app manifest', () => {
  it('is JSON with the site’s name, description, language, direction, colours and icons, addressed from where it is', () => {
    const s = fresh();
    s.site.description = 'Ceramics in Cape Town.';
    const files = generateProject(s);
    const manifest = JSON.parse(files.get(`static/${WEB_MANIFEST}`)!);
    expect(manifest).toEqual({
      name: 'Test Studio',
      description: 'Ceramics in Cape Town.',
      lang: 'en',
      dir: 'ltr',
      start_url: './',
      scope: './',
      display: 'minimal-ui',
      background_color: '#fbfaf7',
      theme_color: '#1f5a4c',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
      ]
    });
    // The icons it names are the ones the editor draws.
    expect(manifest.icons.map((i: { src: string }) => `static/${i.src}`)).toEqual(SITE_ICON_PATHS.filter((p) => !p.endsWith(APPLE_TOUCH_ICON)));
    // The editor's preview has the same manifest, and a run that reuses earlier files gives the same bytes.
    expect(generateProject(s, { instrument: true }).get(`static/${WEB_MANIFEST}`)).toBe(files.get(`static/${WEB_MANIFEST}`));
    const cache = new GenerationCache();
    generateProject(fresh(), {}, cache);
    expect(generateProject(s, {}, cache).get(`static/${WEB_MANIFEST}`)).toBe(files.get(`static/${WEB_MANIFEST}`));
  });

  it('keeps any name as JSON, follows the language’s direction, and leaves out what the site does not say', () => {
    const s = fresh();
    s.site.name = '  Café «Ω» "quoted" </script>\n ';
    s.site.description = '   ';
    s.site.language = 'ar';
    const manifest = JSON.parse(generateWebManifest(s));
    expect(manifest.name).toBe('Café «Ω» "quoted" </script>');
    expect(manifest).not.toHaveProperty('description');
    expect(manifest).not.toHaveProperty('short_name');
    expect(manifest).toMatchObject({ lang: 'ar', dir: 'rtl' });
    s.site.direction = 'ltr';
    s.site.name = ' ';
    expect(JSON.parse(generateWebManifest(s))).toMatchObject({ name: 'Website', dir: 'ltr' });
  });

  it('reads colours through links, other notations and opacity, and falls back when one cannot be read', () => {
    const colors = (s: ProjectState) => {
      const m = JSON.parse(generateWebManifest(s));
      return [m.background_color, m.theme_color];
    };
    let s = fresh();
    // A brand linked to the accent takes the accent's colour.
    s.tokens.overrides['color.brand'] = { token: 'color.accent' };
    expect(colors(s)).toEqual(['#fbfaf7', '#d98f48']);
    // A circular link is passed over for the accent; a background the parser cannot read, for the cards' colour.
    s = fresh();
    s.tokens.overrides['color.brand'] = { token: 'color.brand-strong' };
    s.tokens.overrides['color.brand-strong'] = { token: 'color.brand' };
    s.tokens.overrides['color.background'] = 'var(--paper)';
    expect(colors(s)).toEqual(['#ffffff', '#d98f48']);
    // Other notations, and a see-through brand laid over the background.
    s = fresh();
    s.tokens.overrides['color.background'] = 'rgb(0 0 0)';
    s.tokens.overrides['color.brand'] = 'rgb(255 255 255 / 50%)';
    expect(colors(s)).toEqual(['#000000', '#808080']);
    s.tokens.overrides['color.brand'] = 'oklch(0.628 0.2577 29.23)';
    expect(colors(s)[1]).toBe('#ff0000');
    // Nothing readable at all: the built-in colours.
    for (const id of ['color.background', 'color.surface', 'color.brand', 'color.accent']) s.tokens.overrides[id] = 'currentcolor';
    expect(colors(s)).toEqual(['#ffffff', '#1f5a4c']);
  });
});

describe('the head of every page', () => {
  it('links the home-screen icon and the manifest beside the favicon, with the browser’s theme colour', () => {
    const layout = generateProject(fresh()).get('src/routes/+layout.svelte')!;
    const head = layout.slice(layout.indexOf('<svelte:head>'), layout.indexOf('</svelte:head>'));
    expect(head).toContain('<link rel="icon" href={asset("favicon.svg")} type="image/svg+xml" />');
    expect(head).toContain('<link rel="apple-touch-icon" sizes="180x180" href={asset("apple-touch-icon.png")} />');
    expect(head).toContain('<link rel="manifest" href={asset("manifest.webmanifest")} />');
    expect(head).toContain('<meta name="theme-color" content="#1f5a4c" />');
    expect(themeColorMeta(fresh())).toBe('<meta name="theme-color" content="#1f5a4c" />');
    expect(() => compile(layout, { filename: 'src/routes/+layout.svelte', generate: 'server' })).not.toThrow();
  });
});

describe('what the icons are made from', () => {
  it('is the monogram, edge to edge, until a favicon picture is chosen', () => {
    const s = fresh();
    const set = siteIconSet(s);
    expect(set.source).toEqual({ kind: 'svg', svg: set.monogram });
    expect(set.monogram).toContain('<rect width="64" height="64" fill="#1f5a4c"/>');
    expect(set.monogram).toContain('>T</text>');
    // The browser tab's monogram keeps its rounded corners.
    expect(generateProject(s).get('static/favicon.svg')).toContain('rx="14"');
    expect(set.icons).toEqual([
      { path: 'static/apple-touch-icon.png', size: 180, background: '#fbfaf7' },
      { path: 'static/icon-192.png', size: 192 },
      { path: 'static/icon-512.png', size: 512 }
    ]);
    const chosen = withFavicon(tmp(), Buffer.from('png'));
    expect(siteIconSet(chosen).source).toEqual({ kind: 'file', file: 'static/assets/logo-1a2b3c4d.png', mime: 'image/png' });
  });

  it('keeps every generated file’s address from pages and from saved versions', () => {
    for (const f of [...SITE_ICON_FILES, 'favicon.svg']) {
      expect(validateRoute(`/${f}/`)).not.toBeNull();
      expect(heldAsMedia(`static/${f}`)).toBe(f === 'favicon.svg');
    }
    expect(heldAsMedia('static/assets/logo-1a2b3c4d.png')).toBe(true);
    expect(heldAsMedia('static/icons/apple-touch-icon.png')).toBe(true);
  });
});

describe('drawing the icons', () => {
  it('draws the monogram at each size, its letter showing, with the iOS icon opaque', async () => {
    const set = siteIconSet(fresh());
    const [apple, small, large] = await renderSiteIcons(Buffer.from(set.monogram), 'image/svg+xml', set.icons);
    for (const [png, size] of [[apple, 180], [small, 192], [large, 512]] as const) {
      const meta = await sharp(png).metadata();
      expect(meta).toMatchObject({ format: 'png', width: size, height: size, space: 'srgb' });
      // Square corners in the brand colour, and the letter drawn in the text colour on brand.
      expect(hex(await pixel(png, 1, 1))).toBe('#1f5a4c');
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let light = 0;
      for (let i = 0; i < data.length; i += info.channels) if (data[i] > 230 && data[i + 1] > 230 && data[i + 2] > 230) light++;
      expect(light / (size * size)).toBeGreaterThan(0.02);
    }
    expect((await sharp(apple).metadata()).hasAlpha).toBe(false);
    // Drawn from the SVG at full size, never enlarged from a small raster: the large icon's edge is sharp.
    expect(hex(await pixel(large, 256, 2))).toBe('#1f5a4c');
    // The same picture always makes the same bytes.
    expect((await renderSiteIcons(Buffer.from(set.monogram), 'image/svg+xml', set.icons))[2].equals(large)).toBe(true);
  });

  it('fits a wide picture whole and centred, filling see-through parts only on the iOS icon', async () => {
    const [apple, small] = await renderSiteIcons(await wideLogo(), 'image/png', [{ size: 180, background: '#fbfaf7' }, { size: 192 }]);
    expect(await pixel(small, 96, 96)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect((await pixel(small, 2, 2)).a).toBe(0);
    // The bar reaches both sides, so the picture was not cropped.
    expect((await pixel(small, 1, 96)).r).toBeGreaterThan(200);
    expect(await pixel(apple, 2, 2)).toEqual({ r: 0xfb, g: 0xfa, b: 0xf7, a: 255 });
    expect(await pixel(apple, 90, 90)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it('takes the first frame of a moving picture, and says when a picture cannot be decoded', async () => {
    const frame = (r: number, b: number) => sharp({ create: { width: 8, height: 8, channels: 4, background: { r, g: 0, b, alpha: 1 } } }).png().toBuffer();
    const gif = await sharp([await frame(255, 0), await frame(0, 255)], { join: { animated: true } }).gif().toBuffer();
    const [icon] = await renderSiteIcons(gif, 'image/gif', [{ size: 192 }]);
    expect(await pixel(icon, 96, 96)).toMatchObject({ r: 255, b: 0, a: 255 });
    const bytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    const ok = await handleVariantRequest({ id: 1, kind: 'icons', data: bytes(gif), mime: 'image/gif', width: 0, icons: [{ size: 180, background: '#ffffff' }, { size: 192 }] });
    expect(ok).toMatchObject({ id: 1, ok: true });
    expect(ok.ok && ok.icons?.length).toBe(2);
    const bad = await handleVariantRequest({ id: 2, kind: 'icons', data: bytes(Buffer.from('not a picture at all')), mime: 'image/png', width: 0, icons: [{ size: 192 }] });
    expect(bad).toMatchObject({ id: 2, ok: false, unreadable: true });
  });
});

describe('a project’s icons', () => {
  /** The renderer, counting what it is asked to draw. */
  const counting = (inner: SiteIconRenderer = inProcess) => {
    const calls: string[] = [];
    const fn: SiteIconRenderer = (data, mime, icons) => (calls.push(mime), inner(data, mime, icons));
    setSiteIconRenderer(fn);
    return calls;
  };

  it('are drawn once for what they are made from, and again when it changes', async () => {
    const calls = counting();
    const dir = tmp();
    const maker = new SiteIconMaker();
    const s = fresh();
    const first = await maker.make(dir, s);
    expect([...first.files!.keys()]).toEqual(SITE_ICON_PATHS);
    expect(maker.key).toBe(first.key);
    // The same state, or another with the same name and colours, draws nothing; the same buffers come back.
    expect((await maker.make(dir, s)).files!.get(SITE_ICON_PATHS[0])).toBe(first.files!.get(SITE_ICON_PATHS[0]));
    expect(await maker.make(dir, fresh())).toBe(first);
    expect(calls).toEqual(['image/svg+xml']);
    // A new name is a new monogram, and a new background a new iOS icon.
    s.site.name = 'Harbour';
    const renamed = await maker.make(dir, s);
    expect(renamed.key).not.toBe(first.key);
    s.tokens.overrides['color.background'] = '#000000';
    expect((await maker.make(dir, s)).key).not.toBe(renamed.key);
    expect(calls).toHaveLength(3);
  });

  it('are drawn from the favicon’s bytes as they are now, and from the monogram when its file cannot be used', async () => {
    const calls = counting();
    const dir = tmp();
    const s = withFavicon(dir, await wideLogo());
    const maker = new SiteIconMaker();
    const made = await maker.make(dir, s);
    expect(calls).toEqual(['image/png']);
    expect(await pixel(made.files!.get('static/icon-192.png')!, 96, 96)).toMatchObject({ r: 255, g: 0, b: 0 });
    // Replaced in place, with the record as it was: drawn again from the new bytes.
    writeFileSync(join(dir, 'static/assets/logo-1a2b3c4d.png'), await sharp({ create: { width: 10, height: 10, channels: 3, background: '#0000ff' } }).png().toBuffer());
    const replaced = await maker.make(dir, s);
    expect(replaced.key).not.toBe(made.key);
    expect(await pixel(replaced.files!.get('static/icon-192.png')!, 96, 96)).toMatchObject({ r: 0, g: 0, b: 255 });
    // A missing file gives the monogram's icons, as does a picture the decoder refuses (it is asked first).
    rmSync(join(dir, 'static/assets/logo-1a2b3c4d.png'));
    const missing = await maker.make(dir, s);
    expect(missing.key).toBe((await maker.input(dir, { ...s, site: { ...s.site, favicon: null } })).key);
    expect(hex(await pixel(missing.files!.get('static/icon-192.png')!, 1, 1))).toBe('#1f5a4c');
    writeFileSync(join(dir, 'static/assets/logo-1a2b3c4d.png'), 'not a picture');
    calls.length = 0;
    const refused = await maker.make(dir, s);
    expect(calls).toEqual(['image/png', 'image/svg+xml']);
    expect(hex(await pixel(refused.files!.get('static/icon-192.png')!, 1, 1))).toBe('#1f5a4c');
    // Only a regular file directly in static/assets/ is read: a record pointing elsewhere gets the monogram.
    s.assets.assets.as_logo.file = 'siteorigin/site.json';
    expect((await maker.input(dir, s)).mime).toBe('image/svg+xml');
  });

  it('draw an SVG favicon only once it has been cleaned, as an import would clean it', async () => {
    const seen: string[] = [];
    counting(async (data, mime, icons) => (seen.push(data.toString()), inProcess(data, mime, icons)));
    const dir = tmp();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" fill="#00f"/></svg>';
    const s = withFavicon(dir, Buffer.from(svg), 'image/svg+xml', 'mark-1a2b3c4d.svg');
    const made = await new SiteIconMaker().make(dir, s);
    expect(seen[0]).not.toContain('script');
    expect(await pixel(made.files!.get('static/icon-192.png')!, 96, 96)).toMatchObject({ r: 0, g: 0, b: 255 });
  });

  it('are left undrawn, and not asked for again for a while, when they cannot be made', async () => {
    const dir = tmp();
    const maker = new SiteIconMaker();
    // No renderer at all (a command-line tool, a test): nothing is drawn.
    expect((await maker.make(dir, fresh())).files).toBeNull();
    const calls = counting(async () => ({ ok: false, unreadable: false }));
    const failed = await maker.make(dir, fresh());
    expect(failed.files).toBeNull();
    expect(maker.key).toBeNull();
    // A worker that failed is not asked again for the same icons straight away...
    expect((await maker.make(dir, fresh())).files).toBeNull();
    expect(calls).toHaveLength(1);
    // ...but other icons are asked for, and a reply missing an icon is a failure too.
    const s = fresh();
    s.site.name = 'Other';
    counting(async (data, mime, icons) => {
      const r = await inProcess(data, mime, icons);
      return r.ok ? { ok: true, icons: r.icons.slice(1) } : r;
    });
    expect((await maker.make(dir, s)).files).toBeNull();
    counting();
    s.site.name = 'Third';
    expect((await maker.make(dir, s)).files?.size).toBe(3);
  });
});
