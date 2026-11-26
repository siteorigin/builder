/**
 * Issue 584: what a website gives home screens, bookmarks and installed shortcuts beside its favicon. The generator
 * writes the web app manifest and the head tags and says what the PNG icons are made from; the media worker draws
 * them; each session keeps the last set so a save that changes nothing they are made from draws nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { compile } from 'svelte/compiler';
import type { AssetRecord, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { generateProject } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { generateWebManifest, siteIconSet, themeColorMeta } from '@generator/site-icons';
import { APPLE_TOUCH_ICON, FAVICON_ICO, SITE_ICON_FILES, WEB_MANIFEST } from '@shared/site-icons';
import { icoImages } from './ico';
import { validateRoute } from '@shared/routes';
import { heldAsMedia } from '../../src/main/project/versions';
import { handleVariantRequest, renderSiteIcons } from '../../src/main/project/image-variants';
import { setSiteIconRenderer, SiteIconMaker, siteIconTiming, SITE_ICON_PATHS, type SiteIconRenderer } from '../../src/main/project/site-icons';

const fresh = () => createStarterState('business', 'Test Studio', false);
const dirs: string[] = [];
// Waited for however busy the machine is; the test of a late set passes its own budget. Drawing on a loaded machine
// can take a while.
siteIconTiming.budgetMs = 60_000;
vi.setConfig({ testTimeout: 30_000 });
afterEach(() => {
  setSiteIconRenderer(null);
  vi.restoreAllMocks();
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

/** A 200×100 opaque red picture with a blue stripe down each end, which a crop to a square would cut off. */
const wideBanner = () =>
  sharp({ create: { width: 200, height: 100, channels: 3, background: '#ff0000' } })
    .composite([
      { input: { create: { width: 10, height: 100, channels: 3, background: '#0000ff' } }, top: 0, left: 0 },
      { input: { create: { width: 10, height: 100, channels: 3, background: '#0000ff' } }, top: 0, left: 190 }
    ])
    .png()
    .toBuffer();

/** A PNG whose header claims 20000×20000 pixels: past the decoder's pixel limit, whatever its file size. */
function hugePng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(20000, 0);
  ihdr.writeUInt32BE(20000, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])), chunk('IEND', Buffer.alloc(0))]);
}

const inProcess: SiteIconRenderer = async (data, mime, icons, opts) => {
  try {
    return { ok: true, icons: await renderSiteIcons(data, mime, icons, opts) };
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
    expect(manifest.icons.map((i: { src: string }) => `static/${i.src}`)).toEqual(SITE_ICON_PATHS.filter((p) => !p.endsWith(APPLE_TOUCH_ICON) && !p.endsWith(FAVICON_ICO)));
    // The editor's preview has the same manifest, and a run that reuses earlier files gives the same bytes.
    expect(generateProject(s, { instrument: true }).get(`static/${WEB_MANIFEST}`)).toBe(files.get(`static/${WEB_MANIFEST}`));
    const cache = new GenerationCache();
    generateProject(fresh(), {}, cache);
    expect(generateProject(s, {}, cache).get(`static/${WEB_MANIFEST}`)).toBe(files.get(`static/${WEB_MANIFEST}`));
    // A palette change (a new state, as every edit makes) reaches the manifest and the monogram through the cache too.
    const branded = structuredClone(s);
    branded.tokens.overrides['color.brand'] = '#123456';
    const cached = generateProject(branded, {}, cache);
    expect(JSON.parse(cached.get(`static/${WEB_MANIFEST}`)!).theme_color).toBe('#123456');
    expect(cached.get('static/favicon.svg')).toContain('fill="#123456"');
    expect(cached.get(`static/${WEB_MANIFEST}`)).toBe(generateProject(branded).get(`static/${WEB_MANIFEST}`));
  });

  it('keeps any name as JSON, follows the language’s direction, and leaves out what the site does not say', () => {
    const s = fresh();
    s.site.name = '  Café «Ω» "quoted" </script>\n ';
    s.site.description = 'Line one\n"Line" two\\';
    s.site.language = 'ar';
    let manifest = JSON.parse(generateWebManifest(s));
    expect(manifest.name).toBe('Café «Ω» "quoted" </script>');
    expect(manifest.description).toBe('Line one\n"Line" two\\');
    // A blank description, or one a hand edit made something other than text, is left out.
    s.site.description = '   ';
    expect(JSON.parse(generateWebManifest(s))).not.toHaveProperty('description');
    (s.site as { description: unknown }).description = 42;
    manifest = JSON.parse(generateWebManifest(s));
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
    // A brand linked to another colour takes that colour.
    s.tokens.overrides['color.brand'] = { token: 'color.inverse' };
    expect(colors(s)).toEqual(['#fbfaf7', '#14211d']);
    // A circular link is passed over for the accent; a background the parser cannot read, for the cards' colour.
    s = fresh();
    s.tokens.overrides['color.brand'] = { token: 'color.brand-strong' };
    s.tokens.overrides['color.brand-strong'] = { token: 'color.brand' };
    s.tokens.overrides['color.background'] = 'var(--paper)';
    s.tokens.overrides['color.surface'] = '#eeeeee';
    expect(colors(s)).toEqual(['#eeeeee', '#d98f48']);
    // Other notations, and a see-through brand laid over the background.
    s = fresh();
    s.tokens.overrides['color.background'] = 'rgb(0 0 0)';
    s.tokens.overrides['color.brand'] = 'rgb(255 255 255 / 50%)';
    expect(colors(s)).toEqual(['#000000', '#808080']);
    s.tokens.overrides['color.brand'] = 'oklch(0.628 0.2577 29.23)';
    expect(colors(s)[1]).toBe('#ff0000');
    // A see-through background is laid over white.
    s.tokens.overrides['color.background'] = 'rgb(0 0 0 / 50%)';
    expect(colors(s)[0]).toBe('#808080');
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
    // The editor's preview has them too.
    const dev = generateProject(fresh(), { instrument: true }).get('src/routes/+layout.svelte')!;
    expect(dev).toContain('<link rel="manifest" href={asset("manifest.webmanifest")} />');
    expect(dev).toContain('<meta name="theme-color" content="#1f5a4c" />');
  });
});

describe('what the icons are made from', () => {
  it('is the monogram, edge to edge, until a favicon picture is chosen', () => {
    const s = fresh();
    const set = siteIconSet(s);
    expect(set.source).toEqual({ kind: 'svg', svg: set.monogram });
    expect(set.monogram).toContain('<rect width="64" height="64" fill="#1f5a4c"/>');
    expect(set.monogram).toContain('fill="#ffffff">T</text>');
    s.tokens.overrides['color.on-brand'] = { token: 'color.accent' };
    expect(siteIconSet(s).monogram).toContain('fill="#d98f48">T</text>');
    delete s.tokens.overrides['color.on-brand'];
    // The browser tab's monogram keeps its rounded corners.
    expect(generateProject(s).get('static/favicon.svg')).toContain('rx="14"');
    expect(set.icons).toEqual([
      { path: 'static/apple-touch-icon.png', size: 180, background: '#fbfaf7' },
      { path: 'static/icon-192.png', size: 192 },
      { path: 'static/icon-512.png', size: 512 },
      { path: 'static/favicon.ico', size: 48, ico: [16, 32, 48] }
    ]);
    const chosen = withFavicon(tmp(), Buffer.from('png'));
    expect(siteIconSet(chosen).source).toEqual({ kind: 'file', file: 'static/assets/logo-1a2b3c4d.png', mime: 'image/png' });
    expect(siteIconSet(chosen).icons).toContainEqual({ path: 'static/favicon.ico', size: 48, ico: [16, 32, 48] });
    // A hand edit pointing the favicon at a document, or naming the site with something other than text.
    chosen.assets.assets.as_logo.kind = 'document';
    expect(siteIconSet(chosen).source.kind).toBe('svg');
    (chosen.site as { name: unknown }).name = 7;
    expect(siteIconSet(chosen).monogram).toContain('>S</text>');
    chosen.site.name = '&Co';
    expect(siteIconSet(chosen).monogram).toContain('>&amp;</text>');
  });

  it('keeps every generated file’s address from pages and from saved versions', () => {
    for (const f of [...SITE_ICON_FILES, 'favicon.svg']) {
      expect(validateRoute(`/${f}/`)).not.toBeNull();
      expect(heldAsMedia(`static/${f}`)).toBe(f === 'favicon.svg');
    }
    expect(heldAsMedia('static/favicon.ico')).toBe(false);
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

  it('makes favicon.ico from the same source, as one file of 16, 32 and 48 pixel PNGs', async () => {
    const set = siteIconSet(fresh());
    const spec = set.icons.find((i) => i.path === `static/${FAVICON_ICO}`)!;
    const draw = async (data: Buffer, mime: string) => icoImages((await renderSiteIcons(data, mime, [spec]))[0]);
    const monogram = await draw(Buffer.from(set.monogram), 'image/svg+xml');
    expect(monogram.map((i) => i.width)).toEqual([16, 32, 48]);
    for (const image of monogram) {
      expect(image).toMatchObject({ height: image.width, bitCount: 32 });
      expect(await sharp(image.png).metadata()).toMatchObject({ format: 'png', width: image.width, height: image.width, depth: 'uchar', channels: 4 });
      expect(hex(await pixel(image.png, 1, 1))).toBe('#1f5a4c');
    }
    // A picture keeps its transparency, and one without an alpha channel is given one, as an ICO's PNGs must have.
    for (const image of await draw(await wideLogo(), 'image/png')) {
      expect((await pixel(image.png, 1, 1)).a).toBe(0);
      // Resampled this small, the bar's edges may reach its middle by a step.
      const middle = await pixel(image.png, image.width / 2, image.width / 2);
      expect(middle).toMatchObject({ r: 255, g: 0, b: 0 });
      expect(middle.a).toBeGreaterThan(250);
    }
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#0000ff' } }).jpeg().toBuffer();
    const grey = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#777777' } }).toColourspace('b-w').png().toBuffer();
    expect((await sharp(grey).metadata()).channels).toBe(1);
    for (const [data, mime] of [[jpeg, 'image/jpeg'], [grey, 'image/png']] as const) {
      const images = await draw(data, mime);
      expect(images).toHaveLength(3);
      for (const image of images) {
        expect(await sharp(image.png).metadata()).toMatchObject({ width: image.width, height: image.height, depth: 'uchar', channels: 4 });
        expect((await pixel(image.png, image.width / 2, image.width / 2)).a).toBe(255);
      }
    }
    // A wide picture is fitted whole, as in the PNG icons: both its ends are kept, with padding above.
    for (const image of await draw(await wideBanner(), 'image/png')) {
      const middle = image.width / 2;
      for (const x of [0, image.width - 1]) {
        const end = await pixel(image.png, x, middle);
        expect(end.b).toBeGreaterThan(end.r);
      }
      expect((await pixel(image.png, middle, 1)).a).toBe(0);
    }
  });

  it('hands favicon.ico back from the worker among the other icons', async () => {
    const set = siteIconSet(fresh());
    const reply = await handleVariantRequest({ id: 1, kind: 'icons', data: new Uint8Array(Buffer.from(set.monogram)), mime: 'image/svg+xml', width: 0, icons: set.icons });
    const replied = reply.ok ? (reply.icons ?? []) : [];
    expect(replied).toHaveLength(set.icons.length);
    expect(icoImages(Buffer.from(replied[set.icons.findIndex((i) => i.path === `static/${FAVICON_ICO}`)])).map((i) => i.width)).toEqual([16, 32, 48]);
    // And through the maker, whose requests carry the sizes it is made at.
    setSiteIconRenderer(inProcess);
    const drawn = await new SiteIconMaker().make(tmp(), fresh());
    expect(icoImages(drawn.files!.get(`static/${FAVICON_ICO}`)!)).toHaveLength(3);
  });

  it('fits a wide picture whole and centred, filling see-through parts only on the iOS icon', async () => {
    const [apple, small] = await renderSiteIcons(await wideLogo(), 'image/png', [{ size: 180, background: '#fbfaf7' }, { size: 192 }]);
    expect(await pixel(small, 96, 96)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect((await pixel(small, 2, 2)).a).toBe(0);
    expect(await pixel(apple, 2, 2)).toEqual({ r: 0xfb, g: 0xfa, b: 0xf7, a: 255 });
    expect(await pixel(apple, 90, 90)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    // Whole: both ends of an opaque banner are kept (a crop to the square would cut them), with padding above it.
    const [banner] = await renderSiteIcons(await wideBanner(), 'image/png', [{ size: 192 }]);
    expect(await pixel(banner, 1, 96)).toMatchObject({ r: 0, b: 255, a: 255 });
    expect(await pixel(banner, 190, 96)).toMatchObject({ r: 0, b: 255, a: 255 });
    expect((await pixel(banner, 96, 4)).a).toBe(0);
  });

  it('takes the first frame of a moving picture, and says when a picture cannot be decoded', async () => {
    const frame = (r: number, b: number) => sharp({ create: { width: 8, height: 8, channels: 4, background: { r, g: 0, b, alpha: 1 } } }).png().toBuffer();
    const gif = await sharp([await frame(255, 0), await frame(0, 255)], { join: { animated: true } }).gif().toBuffer();
    const [icon] = await renderSiteIcons(gif, 'image/gif', [{ size: 192 }]);
    expect(await pixel(icon, 96, 96)).toMatchObject({ r: 255, b: 0, a: 255 });
    const bytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    const ok = await handleVariantRequest({ id: 1, kind: 'icons', data: bytes(gif), mime: 'image/gif', width: 0, icons: [{ size: 180, background: '#ffffff' }, { size: 192 }] });
    expect(ok).toMatchObject({ id: 1, ok: true });
    const replied = ok.ok ? (ok.icons ?? []) : [];
    expect(replied).toHaveLength(2);
    for (const [i, size] of [180, 192].entries()) expect(await sharp(Buffer.from(replied[i])).metadata()).toMatchObject({ format: 'png', width: size, height: size, hasAlpha: i === 1 });
    const bad = await handleVariantRequest({ id: 2, kind: 'icons', data: bytes(Buffer.from('not a picture at all')), mime: 'image/png', width: 0, icons: [{ size: 192 }] });
    expect(bad).toMatchObject({ id: 2, ok: false, unreadable: true });
    // Too many pixels to decode is the picture's doing as well, so its icons come from the monogram.
    const huge = await handleVariantRequest({ id: 3, kind: 'icons', data: bytes(hugePng()), mime: 'image/png', width: 0, icons: [{ size: 192 }] });
    expect(huge).toMatchObject({ id: 3, ok: false, unreadable: true });
  });
});

describe('a project’s icons', () => {
  /** The renderer, counting what it is asked to draw. */
  const counting = (inner: SiteIconRenderer = inProcess) => {
    const calls: string[] = [];
    const fn: SiteIconRenderer = (data, mime, icons, opts) => (calls.push(mime), inner(data, mime, icons, opts));
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
    expect((await maker.make(dir, fresh())).files).toBe(first.files);
    expect(calls).toEqual(['image/svg+xml']);
    // A new name is a new monogram, and a new background a new iOS icon.
    s.site.name = 'Harbour';
    const renamed = await maker.make(dir, s);
    expect(renamed.key).not.toBe(first.key);
    s.tokens.overrides['color.background'] = '#000000';
    expect((await maker.make(dir, s)).key).not.toBe(renamed.key);
    expect(calls).toHaveLength(3);
    // The new background is the one the iOS icon of a see-through favicon is filled with.
    const withPicture = withFavicon(dir, await wideLogo());
    withPicture.tokens.overrides['color.background'] = '#123456';
    expect(await pixel((await maker.make(dir, withPicture)).files!.get('static/apple-touch-icon.png')!, 2, 2)).toEqual({ r: 0x12, g: 0x34, b: 0x56, a: 255 });
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
    // Bytes that are no picture at all are never given to the decoder.
    writeFileSync(join(dir, 'static/assets/logo-1a2b3c4d.png'), 'not a picture');
    calls.length = 0;
    expect((await maker.make(dir, s)).key).toBe(missing.key);
    expect(calls).toEqual([]);
    writeFileSync(join(dir, 'static/assets/logo-1a2b3c4d.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('damaged')]));
    const refused = await maker.make(dir, s);
    expect(calls).toEqual(['image/png', 'image/svg+xml']);
    expect(hex(await pixel(refused.files!.get('static/icon-192.png')!, 1, 1))).toBe('#1f5a4c');
    // The monogram standing in is kept a while, then the picture is tried again (a refusal can be passing).
    expect((await maker.make(dir, s)).files).toBe(refused.files);
    expect(calls).toHaveLength(2);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    await maker.make(dir, s);
    expect(calls).toEqual(['image/png', 'image/svg+xml', 'image/png', 'image/svg+xml']);
    vi.restoreAllMocks();
    // Only a regular file directly in static/assets/ is read: a record pointing elsewhere gets the monogram.
    s.assets.assets.as_logo.file = 'siteorigin/site.json';
    expect((await maker.input(dir, s)).mime).toBe('image/svg+xml');
  });

  it('read the favicon only from the project’s own folder, and as the picture its bytes are', async () => {
    const dir = tmp();
    const monogram = async (s: ProjectState) => (await new SiteIconMaker().input(dir, { ...s, site: { ...s.site, favicon: null } })).key;
    // static/assets/ linked to a folder elsewhere: nothing there is read.
    const elsewhere = tmp();
    const outside = withFavicon(elsewhere, await wideLogo());
    mkdirSync(join(dir, 'static'), { recursive: true });
    symlinkSync(join(elsewhere, 'static/assets'), join(dir, 'static/assets'), 'dir');
    expect((await new SiteIconMaker().input(dir, outside)).key).toBe(await monogram(outside));
    rmSync(join(dir, 'static/assets'));
    // SVG markup at a PNG's address is cleaned as an SVG; compressed or unknown bytes are not given to the decoder.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" fill="#00f"/></svg>';
    const disguised = withFavicon(dir, Buffer.from(svg));
    const read = await new SiteIconMaker().input(dir, disguised);
    expect(read.mime).toBe('image/svg+xml');
    expect(read.untrusted).toBe(true);
    const gzipped = withFavicon(dir, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]));
    expect((await new SiteIconMaker().input(dir, gzipped)).key).toBe(await monogram(gzipped));
    // An AVIF is known by its brand, read from the first bytes only, whatever size its file-type box claims.
    const box = (brand: string, size: number) => Buffer.concat([Buffer.from([size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255]), Buffer.from(`ftyp${brand}\0\0\0\0mif1`, 'latin1'), Buffer.alloc(1 << 20)]);
    expect((await new SiteIconMaker().input(dir, withFavicon(dir, box('avif', 24)))).mime).toBe('image/avif');
    const claimsAll = withFavicon(dir, box('mif1', 0xffffffff));
    expect((await new SiteIconMaker().input(dir, claimsAll)).key).toBe(await monogram(claimsAll));
    // A JPEG kept under a PNG's record is drawn as the JPEG it is.
    const jpeg = withFavicon(dir, await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00ff00' } }).jpeg().toBuffer());
    expect((await new SiteIconMaker().input(dir, jpeg)).mime).toBe('image/jpeg');
    // A link, or a pipe whose opening would wait for a writer, is never opened.
    rmSync(join(dir, 'static/assets/logo-1a2b3c4d.png'));
    writeFileSync(join(dir, 'static/assets/real-1a2b3c4d.png'), await wideLogo());
    symlinkSync(join(dir, 'static/assets/real-1a2b3c4d.png'), join(dir, 'static/assets/logo-1a2b3c4d.png'));
    expect((await new SiteIconMaker().input(dir, jpeg)).key).toBe(await monogram(jpeg));
    if (process.platform !== 'win32') {
      rmSync(join(dir, 'static/assets/logo-1a2b3c4d.png'));
      execFileSync('mkfifo', [join(dir, 'static/assets/logo-1a2b3c4d.png')]);
      expect((await new SiteIconMaker().input(dir, jpeg)).key).toBe(await monogram(jpeg));
    }
  });

  it('draw one set at a time, with only the newest asked for meanwhile waiting its turn', async () => {
    const dir = tmp();
    const gates: Array<() => void> = [];
    const drawn: string[] = [];
    setSiteIconRenderer(async (data, mime, icons) => (drawn.push(data.toString().match(/>(.)<\/text>/)![1]), await new Promise<void>((r) => gates.push(r)), inProcess(data, mime, icons)));
    const maker = new SiteIconMaker();
    const named = (name: string) => {
      const s = fresh();
      s.site.name = name;
      return s;
    };
    // A is drawn; B waits; C takes B's place; A asked again shares A's drawing.
    const a = maker.make(dir, named('Alpha'), Infinity);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const b = maker.make(dir, named('Bravo'), Infinity);
    const c = maker.make(dir, named('Charlie'), Infinity);
    const again = maker.make(dir, named('Alpha'), Infinity);
    expect(maker.drawing((await maker.input(dir, named('Bravo'))).key)).toBe(false);
    // B is no longer wanted: told at once that it is not ready.
    expect((await b).files).toBeNull();
    gates[0]();
    expect((await a).files?.size).toBe(4);
    expect((await again).files).toBe((await a).files);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]();
    expect((await c).files?.size).toBe(4);
    expect(drawn).toEqual(['A', 'C']);
    // Both sets are kept: asked for again, neither is drawn again.
    expect((await maker.make(dir, named('Alpha'))).files).toBe((await a).files);
    expect(drawn).toHaveLength(2);
  });

  it('count a picture drawn once more after the monogram stood in for it as a new set', async () => {
    const dir = tmp();
    let refuse = true;
    const calls = counting(async (data, mime, icons, opts) => (refuse && mime === 'image/png' ? { ok: false, unreadable: true } : inProcess(data, mime, icons, opts)));
    const maker = new SiteIconMaker();
    const s = withFavicon(dir, await wideLogo());
    const standIn = await maker.make(dir, s);
    expect(hex(await pixel(standIn.files!.get('static/icon-192.png')!, 1, 1))).toBe('#1f5a4c');
    // Tried again after a while, failing on the worker: the stand-in waits another while.
    refuse = false;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    counting(async () => ({ ok: false, unreadable: false }));
    expect((await maker.make(dir, s)).id).toBe(standIn.id);
    counting(async (data, mime, icons, opts) => inProcess(data, mime, icons, opts));
    expect((await maker.make(dir, s)).id).toBe(standIn.id);
    // Once that while is over, the picture is drawn: the same input, a new set.
    vi.spyOn(Date, 'now').mockReturnValue(now + 125_000);
    const picture = await maker.make(dir, s);
    expect(picture.key).toBe(standIn.key);
    expect(picture.id).toBeGreaterThan(standIn.id!);
    expect(maker.madeId(picture.key)).toBe(picture.id);
    expect(await pixel(picture.files!.get('static/icon-192.png')!, 96, 96)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(calls.length).toBeGreaterThan(0);
  });

  it('stop holding up a save that takes too long for them, and say so once they are ready', async () => {
    const dir = tmp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setSiteIconRenderer(async (data, mime, icons) => (await gate, inProcess(data, mime, icons)));
    const late = vi.fn();
    const maker = new SiteIconMaker(late);
    const pending = await maker.make(dir, fresh(), 20);
    expect(pending.files).toBeNull();
    expect(late).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(late).toHaveBeenCalledTimes(1));
    expect((await maker.make(dir, fresh(), 20)).files?.size).toBe(4);
    // Waited for without a limit, a set is made however long it takes.
    const s = fresh();
    s.site.name = 'Patient';
    expect((await maker.make(dir, s, Infinity)).files?.size).toBe(4);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('draw an SVG favicon only once it has been cleaned, as an import would clean it, away from the editor', async () => {
    const seen: Array<{ untrusted?: boolean }> = [];
    counting(async (data, mime, icons, opts) => (seen.push(opts ?? {}), inProcess(data, mime, icons, opts)));
    const dir = tmp();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" fill="#00f"/></svg>';
    const s = withFavicon(dir, Buffer.from(svg), 'image/svg+xml', 'mark-1a2b3c4d.svg');
    const made = await new SiteIconMaker().make(dir, s);
    expect(seen).toEqual([{ untrusted: true }]);
    expect(await pixel(made.files!.get('static/icon-192.png')!, 96, 96)).toMatchObject({ r: 0, g: 0, b: 255 });
    // The worker cleans it: one the importer would refuse is not drawn, and the monogram stands in for it.
    const bytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    const entities = Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(await handleVariantRequest({ id: 1, kind: 'icons', data: bytes(entities), mime: 'image/svg+xml', width: 0, icons: [{ size: 192 }], untrusted: true })).toMatchObject({ ok: false, unreadable: true });
    expect(await handleVariantRequest({ id: 2, kind: 'icons', data: bytes(Buffer.from(svg)), mime: 'image/svg+xml', width: 0, icons: [{ size: 192 }], untrusted: true })).toMatchObject({ ok: true });
    // The monogram is the app's own, and is drawn as it is.
    seen.length = 0;
    await new SiteIconMaker().make(dir, fresh());
    expect(seen).toEqual([{ untrusted: false }]);
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
    // ...only after a while; and a worker failing on a favicon picture is not the picture's fault: no monogram instead.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect((await maker.make(dir, fresh())).files).toBeNull();
    expect(calls).toHaveLength(2);
    const picture = withFavicon(dir, await wideLogo());
    calls.length = 0;
    expect((await maker.make(dir, picture)).files).toBeNull();
    expect(calls).toEqual(['image/png']);
    vi.restoreAllMocks();
    // ...but other icons are asked for, and a reply missing an icon is a failure too.
    const s = fresh();
    s.site.name = 'Other';
    counting(async (data, mime, icons) => {
      const r = await inProcess(data, mime, icons);
      return r.ok ? { ok: true, icons: r.icons.slice(1) } : r;
    });
    expect((await maker.make(dir, s)).files).toBeNull();
    // (The monogram shows the first letter only: a name with another one is another set.)
    counting();
    s.site.name = 'Zulu';
    expect((await maker.make(dir, s)).files?.size).toBe(4);
  });
});
