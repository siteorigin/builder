// Design capture for the blog pages of an exported website (Foundation): an article, the blog's index and category
// archives with their page links, and the Featured post, Post grid and Post list sections. Opt-in only, never part
// of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/blog-pages.mjs
//
// Drives the real (built) app: a business starter with sample pictures gets a blog of nine posts (categories, tags,
// authors, pictures and full article text), a Journal page with the three feed sections and one feed that matches
// nothing, and a smaller page size so the index has a second page. The website is exported through the real
// controller and its built pages are captured from the export's own preview server, as a visitor sees them, at a
// desktop and a phone width. Each capture checks its page on screen first and throws rather than writing a wrong
// image. Files are named `{state}--{width}.png`.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerChoosers, createProject, eventually, launch, scratch, withTimeout } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('blog pages capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'blog-pages');
mkdirSync(OUT, { recursive: true });
const { WORK, cleanup } = scratch('blog-pages');
const { app, win } = await launch(WORK);
const written = [];

try {
  await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
  const state = (await win.evaluate(() => window.builder.project.snapshot())).state;
  // Room photographs only: the team's portraits are no post's picture.
  const pictures = Object.values(state.assets.assets).filter((a) => (a.kind === 'image' || /\.(jpe?g|png|webp)$/i.test(a.file ?? '')) && !/portrait/i.test(a.name ?? ''));
  assert.ok(pictures.length >= 5, `the starter has sample pictures: ${pictures.length}`);
  const pic = (i) => pictures[i % pictures.length].id;

  // Nine posts, newest first by date; every field filled on most, and a few left bare (no picture, no author,
  // no excerpt) as real blogs have them.
  const body = (i) => [
    'We started this project with a long conversation about how the family actually uses the house on a weekday morning, and the plan grew out of that, not out of a mood board.',
    '## What we changed first',
    'The kitchen moved to the garden side, where the light is. That one decision freed the old kitchen for a [study and a guest room](https://example.com/), and it made the hallway feel twice as wide.',
    '- Oak floors throughout, oiled rather than lacquered',
    '- Linen blinds on every window that faces the street',
    '- One paint colour for walls and ceilings, so the rooms read as one',
    { type: 'image', assetId: pic(i + 2), alt: 'The finished room', caption: 'The garden room in late afternoon light, three weeks after handover.' },
    '### Materials we kept',
    'Most of the original joinery stayed. We stripped it, repaired the worst of the doors and painted the rest.',
    '> The best rooms are the ones you stop noticing, because everything in them simply works.',
    '#### Before you call a builder',
    '- [ ] Measure every room, *including* the ceiling heights',
    '- [ ] Photograph the light at nine, twelve and four',
    '1. Survey and measured drawings',
    '2. A first layout, walked through on site',
    '3. Materials, samples and a fixed budget',
    'If you are planning something similar, **start with how you live**, then talk about finishes. It saves weeks.'
  ];
  const posts = [
    ['en_garden01', 'A garden room that opened up the whole house', '2026-10-28', 'Hannah Wells', 'How moving one kitchen to the light side of the house changed every room around it.', 0, ['projects'], ['kitchens', 'light']],
    ['en_oak01', 'Choosing oak: oiled, lacquered or left alone', '2026-10-14', 'Marcus Lee', 'Three finishes, ten years of wear, and the one we recommend for family homes.', 1, ['materials'], ['floors']],
    ['en_small01', 'Small flats, big ideas: storage that disappears', '2026-09-30', 'Sofia Alvarez', 'Built-in storage that reads as wall, not furniture.', 2, ['ideas'], ['storage']],
    ['en_light01', 'Planning light before you plan furniture', '2026-09-12', 'Hannah Wells', 'Why we draw the light first, and the furniture last.', 3, ['ideas'], ['light']],
    ['en_studio01', 'Inside the studio: how a project runs', '2026-08-25', '', 'From first call to handover, the eight steps every project goes through.', 4, ['studio'], []],
    ['en_kitchen01', 'The kitchen we almost got wrong', '2026-08-02', 'Marcus Lee', '', 5, ['projects'], ['kitchens']],
    ['en_colour01', 'One colour, every wall: a case for restraint', '2026-07-15', 'Sofia Alvarez', 'A single paint colour for walls and ceilings makes small rooms feel calm and bigger.', null, ['materials'], ['colour']],
    ['en_bedroom01', 'A quieter bedroom in three changes', '2026-06-20', 'Hannah Wells', 'Blinds, a softer lamp and one wall of storage.', 6, ['projects'], ['light']],
    ['en_reading01', 'Making room for a reading corner', '2026-05-30', 'Marcus Lee', 'The armchair, the lamp and the shelf: a corner in a weekend.', 7, ['ideas'], []]
  ];
  const setup = await win.evaluate(
    ({ posts, bodies, pics }) =>
      window.builder.project.apply(
        {
          operations: [
            { type: 'collection.create', collectionId: 'posts' },
            {
              type: 'collection.update',
              collectionId: 'posts',
              pageSize: 6,
              taxonomies: {
                categories: { label: 'Categories', terms: { projects: { label: 'Projects' }, materials: { label: 'Materials' }, ideas: { label: 'Ideas' }, studio: { label: 'Studio news' } } },
                tags: { label: 'Tags', terms: { kitchens: { label: 'Kitchens' }, light: { label: 'Light' }, floors: { label: 'Floors' }, storage: { label: 'Storage' }, colour: { label: 'Colour' }, unused: { label: 'Unused' } } }
              }
            },
            ...posts.map(([entryId, title, publishedAt, author, excerpt, image, categories, tags], i) => ({
              type: 'entry.create',
              collectionId: 'posts',
              entryId,
              title,
              publishedAt,
              draft: false,
              ...(author ? { author } : {}),
              ...(excerpt ? { excerpt } : {}),
              ...(image === null ? {} : { featuredImage: pics[image] }),
              body: bodies[i],
              terms: { categories, tags }
            }))
          ]
        },
        { label: 'Start the blog' }
      ),
    { posts, bodies: posts.map((_, i) => body(i)), pics: pictures.map((p) => p.id) }
  );
  assert.equal(setup.ok, true, `the blog is set up: ${setup.error?.message}`);

  // A Journal page with each feed section, and a grid for a tag nothing has (a feed with no entries).
  const journal = await win.evaluate(() =>
    window.builder.project.apply(
      {
        operations: [
          { type: 'page.create', pageId: 'pg_journal01', title: 'Journal', route: '/journal/', starter: 'intro' },
          { type: 'node.insert', owner: { kind: 'page', id: 'pg_journal01' }, componentId: 'blog.featured', props: { eyebrow: 'From the journal', heading: 'Latest story', titleLevel: 'h3' } },
          { type: 'node.insert', owner: { kind: 'page', id: 'pg_journal01' }, componentId: 'blog.grid', props: { heading: 'Latest articles', count: 3 } },
          { type: 'node.insert', owner: { kind: 'page', id: 'pg_journal01' }, componentId: 'blog.list', props: { heading: 'Recent posts', count: 4 } },
          { type: 'node.insert', owner: { kind: 'page', id: 'pg_journal01' }, componentId: 'blog.grid', props: { heading: 'Unused tag', tag: 'unused' } }
        ]
      },
      { label: 'Journal page' }
    )
  );
  assert.equal(journal.ok, true, `the journal page is set up: ${journal.error?.message}`);

  // Export the website into the scratch folder, answering the folder chooser, and capture from its preview.
  mkdirSync(join(WORK, 'out'), { recursive: true });
  await answerChoosers(app, [{ dialog: 'open', selection: 'folder', paths: [join(WORK, 'out')] }]);
  const stat = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'Static export');
  assert.equal(stat.ok, true, `static export succeeds: ${stat.message} ${stat.warnings?.join(' ')}`);
  assert.ok(stat.previewUrl, 'the export starts a preview');
  const base = stat.previewUrl.endsWith('/') ? stat.previewUrl : `${stat.previewUrl}/`;

  /** A hidden browser window on the preview (nothing may appear on screen). */
  const tab = async (width) => {
    const [page] = await Promise.all([
      app.waitForEvent('window'),
      app.evaluate(({ BrowserWindow }, w) => {
        const bw = new BrowserWindow({ show: false, width: w, height: 900, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } });
        void bw.loadURL('about:blank');
      }, width)
    ]);
    const cdp = await page.context().newCDPSession(page);
    /** The window's size as the page sees it: a full page is captured at its own height, so every picture is painted. */
    const size = (height) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 });
    await size(900);
    return { page, width, size };
  };
  const desktop = await tab(1280);
  const phone = await tab(390);

  /** Open `path` on the preview and capture it whole, once `check` is visible. */
  async function shot({ page, width, size }, state, path, check, { full = true, clip } = {}) {
    await size(900);
    await page.goto(new URL(path, base).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    // Every picture decoded, lazy ones included, before the capture.
    await page.evaluate(async () => {
      for (const img of document.images) {
        img.loading = 'eager';
        img.decoding = 'sync';
      }
      // Scrolled through once, so lazy pictures below the fold are asked for, then back to the top.
      for (let y = 0; y < document.documentElement.scrollHeight; y += 600) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      scrollTo(0, 0);
      await Promise.all([...document.images].map((i) => i.decode().catch(() => null)));
    });
    const blank = await page.evaluate(() => [...document.images].filter((i) => !i.complete || !i.naturalWidth).map((i) => i.currentSrc || i.src));
    if (blank.length) throw new Error(`state "${state}" has pictures that did not load: ${blank.join(', ')}; refusing to write`);
    await page.waitForTimeout(300);
    const visible = await page.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" did not render "${check}" at ${path}; refusing to write`);
    const inner = await page.evaluate(() => innerWidth);
    if (inner !== width) throw new Error(`state "${state}" rendered ${inner}px wide, not ${width}px; refusing to write`);
    const file = join(OUT, `${state}--${width}.png`);
    if (full && !clip) {
      await size(await page.evaluate(() => document.documentElement.scrollHeight));
      await page.waitForTimeout(400);
    }
    if (clip) {
      const box = await page.locator(clip).first().boundingBox();
      assert.ok(box, `${state}: ${clip} has a box`);
      await page.screenshot({ path: file, clip: { x: 0, y: Math.max(0, box.y - 24), width, height: box.height + 48 }, fullPage: true });
    } else await page.screenshot({ path: file });
    written.push(file);
    console.log('wrote', file);
  }

  // The article with both neighbours, the newest (one neighbour) and one without a picture or excerpt.
  await shot(desktop, 'article', 'blog/small-flats-big-ideas-storage-that-disappears/', 'article h1');
  await shot(phone, 'article', 'blog/small-flats-big-ideas-storage-that-disappears/', 'article h1');
  await shot(desktop, 'article-newest-nav', 'blog/a-garden-room-that-opened-up-the-whole-house/', 'article nav a', { clip: 'article nav' });
  await shot(desktop, 'article-oldest-nav', 'blog/making-room-for-a-reading-corner/', 'article nav a', { clip: 'article nav' });
  await shot(desktop, 'article-bare', 'blog/one-colour-every-wall-a-case-for-restraint/', 'article h1', { full: false });
  // The index's first page (a lead post and a grid), its second page and a category archive.
  await shot(desktop, 'index', 'blog/', '.so-archive__card--lead');
  await shot(phone, 'index', 'blog/', '.so-archive__card--lead');
  const next = await desktop.page.locator('a[rel="next"]').first().getAttribute('href');
  assert.ok(next, 'the index has a next page');
  await shot(desktop, 'index-page-2', new URL(next, new URL('blog/', base)).pathname.replace(/^\//, ''), '.so-archive__count');
  await shot(desktop, 'category', 'blog/category/ideas/', '.so-archive__eyebrow');
  // The feed sections on a page, and a feed that lists nothing.
  await shot(desktop, 'journal', 'journal/', 'h2');
  await shot(phone, 'journal', 'journal/', 'h2');

  const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
  for (const f of written) assert.ok(files.includes(f.split('/').pop()), `${f} was written`);
  console.log(`blog pages capture: ${written.length} images in ${OUT}`);
} finally {
  await app.close().catch(() => {});
  // DESIGN_KEEP=1 keeps the exported website (in WORK/out) for inspecting its built markup.
  if (process.env.DESIGN_KEEP === '1') console.log(`kept the export in ${join(WORK, 'out')}`);
  else cleanup();
}
