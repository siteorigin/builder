/**
 * Library images on the page as WebP and AVIF sets (issue #583): what a resolved image offers, the <picture> the
 * runtime image renders from it, and the head's preload of the first section's hero, rendered as the website renders
 * them, under a base path.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { AssetRecord, ImageValue, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { generateEntry, generateProject, pageFile, pictureSets, resolveImage } from '@generator/index';
import { P, item } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { projectDesign } from './fixtures/packs';
import { managedFoundation } from './fixtures/agent-designs';
import { run, seoSite } from './fixtures/seo-site';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/**
 * A library picture as the importer records it: copies in its own format at `smaller`, and a WebP and (when `avif`)
 * an AVIF set at those widths and its full width, each copy's format its file's extension.
 */
function picture(id: string, opts: { mime?: string; width?: number; smaller?: number[]; modern?: Array<'webp' | 'avif'> } = {}): AssetRecord {
  const mime = opts.mime ?? 'image/jpeg';
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' }[mime]!;
  const width = opts.width ?? 2000;
  const stem = `static/assets/${id}-1a2b3c4d`;
  const smaller = opts.smaller ?? [160, 480, 960, 1440].filter((w) => w < width * 0.9);
  const modern = (opts.modern ?? ['webp', 'avif']).filter((m) => `image/${m}` !== mime);
  const variants: Array<{ width: number; file: string }> = [];
  for (const w of [...smaller, width]) {
    if (w < width) variants.push({ width: w, file: `${stem}-${w}w.${ext}` });
    for (const m of ['webp', 'avif'] as const) if (modern.includes(m)) variants.push({ width: w, file: `${stem}-${w}w.${m}` });
  }
  return { id, name: id, file: `${stem}.${ext}`, mime, bytes: 1000, width, height: width / 2, hash: id, kind: 'image', variants, createdAt: '2026-01-01T00:00:00.000Z' };
}

/** The Business starter, its hero showing `asset`. */
function site(asset: AssetRecord | null): ProjectState {
  const s = createStarterState('business', 'Harbour Lane Studio', true);
  s.assets.assets = {};
  if (asset) s.assets.assets.a_hero = { ...asset, id: 'a_hero' };
  return s;
}

const homeOf = (s: ProjectState) => s.pages[s.site.homePageId];

/**
 * The site with its split hero, the home page's first section, as a design drawn in the editor: its picture is an
 * image bound to the placement's `image` property, which the head's preload reads. (Foundation's hero is a code
 * component, which loads its picture eagerly but whose markup the preload cannot read: the Release gap below.)
 */
function managedHero(s: ProjectState): ProjectState {
  managedFoundation(s, ['hero.split']);
  const hero = homeOf(s).nodes[homeOf(s).rootIds[0]] as InstanceNode;
  const def = s.components[hero.definitionId];
  expect([def.componentId, def.kind, def.tree?.nodes.media]).toEqual(['hero.split', 'managed', expect.objectContaining({ kind: 'image', image: { $prop: 'image' } })]);
  return s;
}

/** The home page as the website renders it, under /studio: its head and body. */
async function renderHome(s: ProjectState): Promise<{ head: string; body: string }> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'picture-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => "/studio" + p; export const asset = (p) => "/studio/" + p; export const base = "/studio";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of generateProject(s)) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, 'src/routes/+page.svelte.js'))).default as Component<Record<string, unknown>>;
  const out = render(Page, { props: {} });
  const clean = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');
  return { head: clean(out.head), body: clean(out.body) };
}

/** An element's attributes, by name. */
function attrs(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/\s([a-z-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], (m[2] ?? '').replace(/&amp;/g, '&')]));
}

describe('a library image’s sets', () => {
  it('offers a JPEG’s own copies to its <img>, and its AVIF and WebP sets, best first, to a <picture>', () => {
    const sets = pictureSets(picture('hero'));
    const set = (ext: string, widths: number[]) => widths.map((w) => `/assets/hero-1a2b3c4d${w === 2000 && ext === 'jpg' ? '' : `-${w}w`}.${ext} ${w}w`).join(', ');
    expect(sets).toEqual({
      srcset: set('jpg', [160, 480, 960, 1440, 2000]),
      sources: [
        { type: 'image/avif', srcset: set('avif', [160, 480, 960, 1440, 2000]) },
        { type: 'image/webp', srcset: set('webp', [160, 480, 960, 1440, 2000]) }
      ]
    });
    // Listed in any order, a width twice, or a width no browser reads or wider than the picture: the same sets.
    const shuffled = picture('hero');
    shuffled.variants = [...shuffled.variants!].reverse();
    shuffled.variants.push({ width: 480, file: 'static/assets/other-1a2b3c4d-480w.avif' }, { width: 700.5, file: 'static/assets/hero-1a2b3c4d-700w.avif' }, { width: 2400, file: 'static/assets/hero-1a2b3c4d-2400w.webp' });
    expect(pictureSets(shuffled)).toEqual(sets);
  });

  it('gives an image imported before WebP and AVIF copies the srcset it always had, and no <picture>', () => {
    const old: AssetRecord = { ...picture('old'), variants: [160, 480, 960, 1440].map((w) => ({ width: w, file: `static/assets/old-1a2b3c4d-${w}w.jpg` })) };
    const before = [...old.variants!.map((v) => `/${v.file.replace(/^static\//, '')} ${v.width}w`), `/${old.file.replace(/^static\//, '')} ${old.width}w`].join(', ');
    expect(pictureSets(old)).toEqual({ srcset: before, sources: [] });
    const s = site(old);
    expect(resolveImage({ assetId: 'a_hero', alt: 'Old' }, { state: s })).toEqual({ src: '/assets/old-1a2b3c4d.jpg', alt: 'Old', width: 2000, height: 1000, srcset: before });
  });

  it('offers a WebP’s own copies to its <img> and only its AVIF set before them; an AVIF’s own set first, then its WebP one', () => {
    const webp = pictureSets(picture('w', { mime: 'image/webp', width: 1600 }));
    expect(webp.srcset).toBe('/assets/w-1a2b3c4d-160w.webp 160w, /assets/w-1a2b3c4d-480w.webp 480w, /assets/w-1a2b3c4d-960w.webp 960w, /assets/w-1a2b3c4d.webp 1600w');
    expect(webp.sources.map((x) => x.type)).toEqual(['image/avif']);
    const avif = pictureSets(picture('a', { mime: 'image/avif', width: 1600 }));
    expect(avif.srcset).toBe('/assets/a-1a2b3c4d-160w.avif 160w, /assets/a-1a2b3c4d-480w.avif 480w, /assets/a-1a2b3c4d-960w.avif 960w, /assets/a-1a2b3c4d.avif 1600w');
    expect(avif.sources).toEqual([
      { type: 'image/avif', srcset: avif.srcset },
      { type: 'image/webp', srcset: '/assets/a-1a2b3c4d-160w.webp 160w, /assets/a-1a2b3c4d-480w.webp 480w, /assets/a-1a2b3c4d-960w.webp 960w, /assets/a-1a2b3c4d-1600w.webp 1600w' }
    ]);
    // An AVIF whose WebP set was not made offers its own set to its <img> alone.
    expect(pictureSets(picture('a', { mime: 'image/avif', width: 1600, modern: [] })).sources).toEqual([]);
  });

  it('offers a set only when it reaches the picture’s full width, and a small picture its full-size WebP alone', () => {
    const short = picture('short');
    short.variants = short.variants!.filter((v) => v.file !== 'static/assets/short-1a2b3c4d-2000w.avif');
    expect(pictureSets(short).sources.map((x) => x.type)).toEqual(['image/webp']);
    const icon = picture('icon', { mime: 'image/png', width: 64, modern: ['webp'] });
    expect(pictureSets(icon)).toEqual({ sources: [{ type: 'image/webp', srcset: '/assets/icon-1a2b3c4d-64w.webp 64w' }] });
  });
});

describe('the image a page renders', () => {
  /** The hero's <picture> on the home page, its sources' attributes and its <img>'s. */
  const heroPicture = (body: string) => {
    const pic = body.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/)?.[0];
    expect(pic).toBeDefined();
    return { pic: pic!, sources: [...pic!.matchAll(/<source\b[^>]*>/g)].map((m) => attrs(m[0])), img: attrs(pic!.match(/<img\b[^>]*>/)![0]) };
  };

  it('is a <picture> with typed sources and the <img> it always was, each source sized as the <img> is', async () => {
    const s = site(picture('hero'));
    const { body } = await renderHome(s);
    const pic = body.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/)?.[0];
    expect(pic).toBeDefined();
    const sources = [...pic!.matchAll(/<source\b[^>]*>/g)].map((m) => attrs(m[0]));
    // The sources first, best first, then the one <img>.
    expect([...pic!.matchAll(/<(source|img)\b/g)].map((m) => m[1])).toEqual(['source', 'source', 'img']);
    expect(sources.map((x) => x.type)).toEqual(['image/avif', 'image/webp']);
    expect(sources[0].srcset).toBe([160, 480, 960, 1440, 2000].map((w) => `/studio/assets/hero-1a2b3c4d-${w}w.avif ${w}w`).join(', '));
    expect(sources[1].srcset).toBe([160, 480, 960, 1440, 2000].map((w) => `/studio/assets/hero-1a2b3c4d-${w}w.webp ${w}w`).join(', '));
    const img = attrs(pic!.match(/<img\b[^>]*>/)![0]);
    expect(img).toMatchObject({
      src: '/studio/assets/hero-1a2b3c4d.jpg',
      srcset: [160, 480, 960, 1440].map((w) => `/studio/assets/hero-1a2b3c4d-${w}w.jpg ${w}w`).concat('/studio/assets/hero-1a2b3c4d.jpg 2000w').join(', '),
      alt: 'A bright living room with oak furniture and linen curtains',
      width: '2000',
      height: '1000',
      loading: 'eager',
      fetchpriority: 'high'
    });
    expect(img.class).toMatch(/^so-img /);
    // Every source says the same width as the <img> (how wide the split hero shows it: see the Release gap below).
    expect(img.sizes).toBeTruthy();
    for (const x of sources) expect(x.sizes).toBe(img.sizes);
    // An image further down the page loads lazily, its own <picture> too.
    s.assets.assets.a_studio = { ...picture('studio'), id: 'a_studio' };
    const lower = (await renderHome(s)).body.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/g)!;
    expect(lower).toHaveLength(2);
    expect(attrs(lower[1].match(/<img\b[^>]*>/)![0])).toMatchObject({ loading: 'lazy', decoding: 'async' });
  });

  // Release gap: the release's hero.split hands its image no sizes, so its picture takes the runtime image's default (100vw), though it shows at half the page's width on a wide screen.
  it.fails('sizes the split hero’s picture by how wide it shows', async () => {
    const { img } = heroPicture((await renderHome(site(picture('hero')))).body);
    expect(img.sizes).toMatch(/^\(min-width: 1024px\) /);
  });

  it('stays a bare <img> for an image with copies in its own format only', async () => {
    const old: AssetRecord = { ...picture('old'), variants: [480, 960].map((w) => ({ width: w, file: `static/assets/old-1a2b3c4d-${w}w.jpg` })) };
    const { body } = await renderHome(site(old));
    expect(body).not.toContain('<picture');
    expect(body).toContain('<img src="/studio/assets/old-1a2b3c4d.jpg" srcset="/studio/assets/old-1a2b3c4d-480w.jpg 480w, /studio/assets/old-1a2b3c4d-960w.jpg 960w, /studio/assets/old-1a2b3c4d.jpg 2000w"');
  });
});

describe('the hero’s preload', () => {
  /** The head's image preload links. */
  const preloads = (head: string) => [...head.matchAll(/<link\b[^>]*rel="preload"[^>]*>/g)].map((m) => attrs(m[0])).filter((l) => l.as === 'image');

  /** The first source of the page's first <picture>. */
  const firstSource = (body: string) => attrs(body.match(/<picture\b[^>]*>\s*<source\b[^>]*>/)![0].replace(/^<picture\b[^>]*>\s*/, ''));

  it('asks for the set the hero’s <picture> takes first, at the widths and sizes it offers, under the base path', async () => {
    const { head, body } = await renderHome(managedHero(site(picture('hero'))));
    const first = firstSource(body);
    expect(first.srcset).toContain('/studio/assets/hero-1a2b3c4d-160w.avif 160w');
    expect(preloads(head)).toEqual([{ rel: 'preload', as: 'image', fetchpriority: 'high', type: 'image/avif', imagesrcset: first.srcset, imagesizes: first.sizes }]);
    // Asked for once, before anything else the page's head says (the title, which Svelte writes on its own, aside).
    expect(head.indexOf('rel="preload"')).toBeLessThan(head.indexOf('name="description"'));
  });

  it('asks for the set the release hero’s <picture> takes first, at the widths and sizes it offers, under the base path', async () => {
    const { head, body } = await renderHome(site(picture('hero')));
    const first = firstSource(body);
    expect(preloads(head)).toEqual([{ rel: 'preload', as: 'image', fetchpriority: 'high', type: 'image/avif', imagesrcset: first.srcset, imagesizes: first.sizes }]);
  });

  it('asks for the <img>’s own set, untyped, for an image with copies in its own format only, and its file for one with none', async () => {
    const old: AssetRecord = { ...picture('old'), variants: [480, 960].map((w) => ({ width: w, file: `static/assets/old-1a2b3c4d-${w}w.jpg` })) };
    const { head, body } = await renderHome(managedHero(site(old)));
    const img = attrs(body.match(/<img\b[^>]*old-1a2b3c4d[^>]*>/)![0]);
    expect(preloads(head)).toEqual([{ rel: 'preload', as: 'image', fetchpriority: 'high', imagesrcset: img.srcset, imagesizes: img.sizes }]);
    const single: AssetRecord = { ...picture('single'), variants: undefined };
    expect(preloads((await renderHome(managedHero(site(single)))).head)).toEqual([{ rel: 'preload', as: 'image', fetchpriority: 'high', href: '/studio/assets/single-1a2b3c4d.jpg' }]);
  });

  it('asks for nothing when the first section shows no picture, or shows it only further down the page', async () => {
    // A hero still waiting for its picture.
    const empty = managedHero(site(null));
    expect(preloads((await renderHome(empty)).head)).toEqual([]);
    // The hero's picture placed in the second section instead.
    const lower = managedHero(site(picture('hero')));
    const home = homeOf(lower);
    const [first, second] = home.rootIds;
    home.rootIds = [second, first, ...home.rootIds.slice(2)];
    expect((home.nodes[second] as InstanceNode).props.image).toBeUndefined();
    expect(preloads((await renderHome(lower)).head)).toEqual([]);
  });

  it('passes over a placeholder and an image hidden at every size to the first picture the section shows', async () => {
    const s = site(picture('hero'));
    s.assets.assets.a_other = { ...picture('other'), id: 'a_other' };
    const home = homeOf(s);
    home.nodes.box = { id: 'box', kind: 'element', tag: 'div', children: ['empty', 'hidden', 'veil', 'shown'] } as (typeof home.nodes)[string];
    home.nodes.empty = { id: 'empty', kind: 'image', image: { assetId: null, alt: '' } };
    home.nodes.hidden = { id: 'hidden', kind: 'image', image: { assetId: 'a_other', alt: '' }, styles: { base: { hidden: true } } };
    // Hidden by what is around it, at every size: by itself on phones, by its container everywhere else.
    home.nodes.veil = { id: 'veil', kind: 'element', tag: 'div', children: ['under'], styles: { base: { hidden: true } } } as (typeof home.nodes)[string];
    home.nodes.under = { id: 'under', kind: 'image', image: { assetId: 'a_other', alt: '' }, styles: { phone: { hidden: true } } };
    home.nodes.shown = { id: 'shown', kind: 'image', image: { assetId: 'a_hero', alt: 'Ours' } };
    home.rootIds = ['box', ...home.rootIds];
    const { head } = await renderHome(s);
    expect(preloads(head).map((l) => l.imagesrcset.split(', ')[0])).toEqual(['/studio/assets/hero-1a2b3c4d-160w.avif 160w']);
  });

  it('asks for nothing for a picture in a list, which loads lazily, and follows a page’s own literal image', async () => {
    const s = site(picture('hero'));
    const home = homeOf(s);
    // A gallery (a design showing a list of pictures) first: its pictures are list items, never eager. Nothing on its
    // photos opens them, so only being in a list keeps them out.
    const def = projectDesign(s, {
      componentId: 'test.gallery',
      name: 'Gallery',
      properties: { images: P.list('Images', 'Image', { image: P.image('Image') }, []) },
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.repeat('each', 'images', [b.el('photo', 'figure', {}, [b.image('media', item('image'))])])])
    });
    const gallery = makeInstance(def, { images: [1, 2, 3].map((i) => ({ id: `g${i}`, image: { assetId: 'a_hero', alt: '' } as ImageValue })) });
    home.nodes[gallery.id] = gallery;
    home.rootIds = [gallery.id, ...home.rootIds];
    const listed = await renderHome(s);
    expect(listed.body).toContain('hero-1a2b3c4d.jpg');
    expect(listed.body).not.toContain('fetchpriority="high"');
    expect(preloads(listed.head)).toEqual([]);
    // A picture placed straight on the page, in its first section.
    const own = site(picture('hero'));
    const page = homeOf(own);
    page.nodes.pic = { id: 'pic', kind: 'image', image: { assetId: 'a_hero', alt: 'Ours' } };
    page.rootIds = ['pic', ...page.rootIds];
    const { head, body } = await renderHome(own);
    const first = attrs(body.match(/<picture\b[^>]*>\s*<source\b[^>]*>/)![0].replace(/^<picture\b[^>]*>\s*/, ''));
    expect(preloads(head)).toEqual([{ rel: 'preload', as: 'image', fetchpriority: 'high', type: 'image/avif', imagesrcset: first.srcset, imagesizes: first.sizes }]);
  });

  it('asks for a picture the page gives a design that shows it inside its list, which the page loads eagerly', async () => {
    const s = site(picture('hero'));
    // A design repeating a row per item, each row showing the content the page puts in its slot.
    const tree = {
      rootIds: ['root'],
      nodes: {
        root: { id: 'root', kind: 'element', tag: 'section', children: ['rows'] },
        rows: { id: 'rows', kind: 'repeat', list: { $prop: 'items' }, children: ['row'] },
        row: { id: 'row', kind: 'element', tag: 'div', children: ['media'] },
        media: { id: 'media', kind: 'slot', slot: 'media' }
      }
    };
    s.components['project.rows'] = { schemaVersion: 2, id: 'project.rows', componentId: 'project.rows', contractVersion: 1, kind: 'managed', owner: 'project', name: 'Rows', description: '', category: 'custom', tags: [], icon: 'component', properties: { items: { type: 'list', label: 'Items', fields: {}, default: [] } }, parts: { root: { nodeId: 'root', label: 'Root' } }, slots: { media: { label: 'Media' } }, tree, provenance: { createdBy: 'user' }, license: 'Project' } as unknown as (typeof s.components)[string];
    const home = homeOf(s);
    home.nodes.rows = { id: 'rows', kind: 'instance', definitionId: 'project.rows', props: { items: [{ id: 'r1' }] }, slots: { media: ['slotted'] } } as InstanceNode;
    home.nodes.slotted = { id: 'slotted', kind: 'image', image: { assetId: 'a_hero', alt: 'Slotted' } };
    home.rootIds = ['rows', ...home.rootIds.filter((id) => id !== 'rows')];
    const { head, body } = await renderHome(s);
    const pic = body.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/)![0];
    expect(attrs(pic.match(/<img\b[^>]*>/)![0])).toMatchObject({ alt: 'Slotted', loading: 'eager' });
    const first = attrs(pic.match(/<source\b[^>]*>/)![0]);
    expect(preloads(head)).toEqual([{ rel: 'preload', as: 'image', fetchpriority: 'high', type: 'image/avif', imagesrcset: first.srcset, imagesizes: first.sizes }]);
  });

  it('asks for an entry’s featured picture where its layout shows it first, and nothing for an entry without one', () => {
    const { state } = seoSite();
    state.assets.assets.img_bowls = { ...picture('bowls'), id: 'img_bowls' };
    const page = generateEntry(run(state, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', featuredImage: 'img_bowls' }), 'posts', 'en_spring');
    const head = page.slice(page.indexOf('<svelte:head>'), page.indexOf('</svelte:head>'));
    expect(page.match(/rel="preload"/g)).toHaveLength(1);
    const link = head.match(/<link rel="preload" as="image"[^\n]*/)?.[0];
    expect(link).toContain('type="image/avif"');
    // The same widths and sizes as the image the layout renders.
    const shown = page.match(/<SoImage image=\{(\{"src":"\/assets\/bowls[^\n]*?\})\} eager sizes="([^"]+)"/);
    expect(shown).not.toBeNull();
    const avif = (JSON.parse(shown![1]) as { sources: Array<{ type: string; srcset: string }> }).sources[0];
    expect(avif.type).toBe('image/avif');
    const asked = avif.srcset.split(', ').map((c) => { const [path, w] = c.split(' '); return `so_asset(${JSON.stringify(path.slice(1))}) + " ${w}"`; }).join(', ');
    expect(link).toBe(`<link rel="preload" as="image" fetchpriority="high" type="image/avif" imagesrcset={[${asked}].join(', ')} imagesizes="${shown![2]}" />`);
    expect(page).toContain(`import { asset as so_asset } from '$app/paths';`);
    expect(generateEntry(state, 'posts', 'en_spring')).not.toContain('rel="preload"');
  });

  it('asks for the thumbnail a first picture that opens full size shows, and nothing when the card decides it only as it renders', async () => {
    const s = site(picture('hero'));
    const home = homeOf(s);
    // A figure on the page that opens its picture full size: the page shows a thumbnail of it.
    home.nodes.card = { id: 'card', kind: 'element', tag: 'figure', action: 'image', children: ['pic'] } as (typeof home.nodes)[string];
    home.nodes.pic = { id: 'pic', kind: 'image', image: { assetId: 'a_hero', alt: 'Ours' } };
    home.rootIds = ['card', ...home.rootIds];
    const { head, body } = await renderHome(s);
    expect(body).toContain('<a href="/studio/assets/hero-1a2b3c4d.jpg"');
    const first = attrs(body.match(/<picture\b[^>]*>\s*<source\b[^>]*>/)![0].replace(/^<picture\b[^>]*>\s*/, ''));
    expect(first.srcset).not.toContain('2000w');
    expect(preloads(head)).toEqual([{ rel: 'preload', as: 'image', fetchpriority: 'high', type: 'image/avif', imagesrcset: first.srcset, imagesizes: first.sizes }]);
    // A card holding two pictures opens the first one that shows, which the page works out as it renders: nothing is
    // asked for, not even an ordinary picture after it.
    home.nodes.card = { ...home.nodes.card, children: ['pic', 'pic2'] } as (typeof home.nodes)[string];
    home.nodes.pic2 = { id: 'pic2', kind: 'image', image: { assetId: 'a_hero', alt: 'Again' } };
    home.nodes.after = { id: 'after', kind: 'image', image: { assetId: 'a_hero', alt: 'After' } };
    home.nodes.wrap = { id: 'wrap', kind: 'element', tag: 'div', children: ['card', 'after'] } as (typeof home.nodes)[string];
    home.rootIds = ['wrap', ...home.rootIds.filter((id) => id !== 'card')];
    expect(preloads((await renderHome(s)).head)).toEqual([]);
  });

  it('shows a thumbnail that opens full size with only copies narrower than the picture, in every format', async () => {
    const s = site(null);
    s.assets.assets.a_kitchen = { ...picture('kitchen'), id: 'a_kitchen' };
    const { body } = await renderHome(s);
    const kitchen = body.slice(body.indexOf('<a href="/studio/assets/kitchen-1a2b3c4d.jpg"'));
    const pic = kitchen.match(/<picture\b[^>]*>[\s\S]*?<\/picture>/)![0];
    expect(pic).not.toMatch(/2000w/);
    expect([...pic.matchAll(/<source\b[^>]*>/g)].map((m) => [attrs(m[0]).type, attrs(m[0]).srcset.split(', ').map((c) => c.split(' ')[1])])).toEqual([
      ['image/avif', ['160w', '480w', '960w', '1440w']],
      ['image/webp', ['160w', '480w', '960w', '1440w']]
    ]);
    expect(attrs(pic.match(/<img\b[^>]*>/)![0])).toMatchObject({
      src: '/studio/assets/kitchen-1a2b3c4d-1440w.jpg',
      srcset: [160, 480, 960, 1440].map((w) => `/studio/assets/kitchen-1a2b3c4d-${w}w.jpg ${w}w`).join(', ')
    });
  });

  it('is written into the page’s own file, which imports the address helper only then', () => {
    const files = generateProject(managedHero(site(picture('hero'))));
    const page = files.get(pageFile(homeOf(site(null))))!;
    expect(page).toContain(`import { asset as so_asset } from '$app/paths';`);
    // Straight after the title.
    expect(page).toMatch(/<svelte:head>\n\t<title>[^\n]*<\/title>\n\t<link rel="preload" as="image" fetchpriority="high" type="image\/avif" imagesrcset=\{\[so_asset\("assets\/hero-1a2b3c4d-160w\.avif"\) \+ " 160w", /);
    expect(generateProject(site(null)).get(pageFile(homeOf(site(null))))).not.toContain('so_asset');
  });
});
