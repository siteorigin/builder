// Design capture for the pages of a structured collection's entries (records) in an exported website (Foundation),
// and their layout open in the editor. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/record-pages.mjs
//
// Drives the real (built) app: a business starter with sample pictures gets a Properties collection made as an author
// makes one (the collection first, then ten fields of every kind added to it: text, a number, a choice, yes/no, a link
// and rich text), three properties (one with every field filled, one with the choice set to another option, one with
// almost nothing), a collection of people with no text of their own (as the Content tab makes custom records), the
// Projects starter (a date, a picture, a link and a client) with two projects, and a blog of two posts, whose articles
// keep their date, author and reading time. The website is exported through the real controller and its built pages
// are captured from the export's own preview server, as a visitor sees them, at a desktop, a phone and the narrowest
// phone width; the Properties layout is captured open in the editor with its layers. Each capture checks its page on
// screen first and throws rather than writing a wrong image. Files are named `{state}--{width}.png`.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerChoosers, createProject, launch, scratch, withTimeout } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('record pages capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'record-pages');
mkdirSync(OUT, { recursive: true });
const { WORK, cleanup } = scratch('record-pages');
const { app, win } = await launch(WORK);
const written = [];
const pause = (ms) => win.waitForTimeout(ms);

const rich = (...paragraphs) => paragraphs.map((text) => ({ type: 'p', spans: [{ text }] }));

try {
  await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
  const state = (await win.evaluate(() => window.builder.project.snapshot())).state;
  const pictures = Object.values(state.assets.assets).filter((a) => (a.kind === 'image' || /\.(jpe?g|png|webp)$/i.test(a.file ?? '')) && !/portrait/i.test(a.name ?? ''));
  assert.ok(pictures.length >= 4, `the starter has sample pictures: ${pictures.length}`);
  const pic = (i) => pictures[i % pictures.length].id;
  const portrait = Object.values(state.assets.assets).find((a) => /portrait/i.test(a.name ?? ''))?.id ?? pic(4);

  // Made as the Content tab makes a custom collection of records with pages: the collection, then its fields.
  const made = await win.evaluate(
    () =>
      window.builder.project.apply(
        {
          operations: [
            {
              type: 'collection.create',
              collectionId: 'properties',
              name: 'Properties',
              kind: 'structured',
              singularName: 'Property',
              hasBody: true,
              pages: { detail: true, archive: true },
              route: '/properties/'
            }
          ]
        },
        { label: 'Add the Properties collection' }
      ),
    null
  );
  assert.equal(made.ok, true, `the Properties collection is made: ${made.error?.message}`);
  const fields = await win.evaluate(
    () =>
      window.builder.project.apply(
        {
          operations: [
            {
              type: 'collection.update',
              collectionId: 'properties',
              fields: {
                guidePrice: { type: 'string', label: 'Guide price', default: '' },
                region: { type: 'string', label: 'Region', default: '' },
                bedrooms: { type: 'number', label: 'Bedrooms', default: 0, min: 0 },
                landArea: { type: 'string', label: 'Land area', default: '' },
                era: { type: 'string', label: 'Era', default: '' },
                availability: {
                  type: 'enum',
                  label: 'Availability',
                  default: 'for-sale',
                  options: [
                    { value: 'for-sale', label: 'For sale' },
                    { value: 'under-offer', label: 'Under offer' },
                    { value: 'sold', label: 'Sold' }
                  ]
                },
                advisor: { type: 'string', label: 'Advisor', default: '' },
                pool: { type: 'boolean', label: 'Swimming pool', default: false },
                brochure: { type: 'link', label: 'Brochure', default: { type: 'none', target: '' } },
                highlights: { type: 'richtext', label: 'Highlights', default: [] }
              }
            }
          ]
        },
        { label: 'Add the Properties fields' }
      ),
    null
  );
  assert.equal(fields.ok, true, `the Properties fields are added: ${fields.error?.message}`);

  const story = [
    'Approached along a half-kilometre avenue of century-old cypresses, Bastide de Lourmarin spans 780 square metres of restored limewashed reception rooms, vaulted cellars, and a private guest pavilion.',
    'The house faces south across its own olive grove to the Luberon ridge. The original stone stair, the kitchen fireplace and the shuttered library have been kept as they were; everything else has been brought quietly up to date, from the geothermal heating to the wiring and the well.',
    'Outside, a walled potager, a lavender parterre and a 20-metre pool sit within twelve hectares of terraced land, with a separate barn that could become a studio or a second guest house.'
  ];
  const entries = await win.evaluate(
    ({ pics, story, villa, highlights }) =>
      window.builder.project.apply(
        {
          operations: [
            {
              type: 'entry.create',
              collectionId: 'properties',
              entryId: 'en_bastide01',
              title: 'Bastide de Lourmarin',
              publishedAt: '2026-10-20',
              draft: false,
              excerpt: 'An eighteenth-century bastide in the southern Luberon, with twelve hectares of olive groves and a private guest pavilion.',
              featuredImage: pics[0],
              body: story,
              values: {
                guidePrice: '€4,200,000',
                region: 'Luberon, Provence',
                bedrooms: 7,
                landArea: '12 hectares',
                era: '18th century',
                availability: 'for-sale',
                advisor: 'Camille Laurent',
                pool: true,
                brochure: { type: 'url', target: 'https://example.com/bastide-de-lourmarin.pdf' },
                highlights
              }
            },
            {
              type: 'entry.create',
              collectionId: 'properties',
              entryId: 'en_solis01',
              title: 'Villa Solis',
              publishedAt: '2026-10-12',
              draft: false,
              excerpt: 'A 1930s villa above the bay of Villefranche, restored by an Italian architect.',
              featuredImage: pics[1],
              body: villa,
              values: { guidePrice: '€6,850,000', region: 'Côte d’Azur', bedrooms: 5, landArea: '0.8 hectares', era: '1930s', availability: 'under-offer', advisor: 'Marc Duval' }
            },
            {
              type: 'entry.create',
              collectionId: 'properties',
              entryId: 'en_arrabida01',
              title: 'Casa da Arrábida',
              publishedAt: '2026-10-02',
              draft: false,
              values: { guidePrice: 'On application', region: 'Setúbal, Portugal' }
            }
          ]
        },
        { label: 'Add properties' }
      ),
    {
      pics: pictures.map((p) => p.id),
      story,
      villa: [
        'Villa Solis sits on the corniche above the bay of Villefranche, its terraces stepping down through a garden of agaves and old olive trees to a private gate onto the coast path.',
        'Restored in 2019 by an Italian architect, it keeps its original terrazzo floors, steel windows and a curved stair lit by a lantern roof.'
      ],
      highlights: rich('Restored eighteenth-century stone stair and vaulted wine cellars.', 'South-facing terraces with views to the Luberon ridge.', 'Separate two-bedroom guest pavilion with its own entrance.')
    }
  );
  assert.equal(entries.ok, true, `the properties are added: ${entries.error?.message}`);

  // A collection of people with no text of their own, made as the Content tab makes custom records: the collection,
  // then its fields.
  const people = await win.evaluate(
    ({ pics }) =>
      window.builder.project.apply(
        {
          operations: [
            { type: 'collection.create', collectionId: 'people', name: 'People', kind: 'structured', singularName: 'Person', hasBody: false, pages: { detail: true, archive: true }, route: '/people/' },
            {
              type: 'collection.update',
              collectionId: 'people',
              fields: {
                role: { type: 'string', label: 'Role', default: '' },
                studio: { type: 'string', label: 'Studio', default: '' },
                joined: { type: 'date', label: 'Joined', default: '' },
                email: { type: 'link', label: 'Email', default: { type: 'none', target: '' } },
                portrait: { type: 'image', label: 'Portrait', default: { assetId: null, alt: '' } },
                biography: { type: 'string', label: 'Biography', multiline: true, default: '' }
              }
            },
            {
              type: 'entry.create',
              collectionId: 'people',
              entryId: 'en_hannah01',
              title: 'Hannah Wells',
              draft: false,
              excerpt: 'Leads the studio’s residential work, from first drawings to the last cushion.',
              values: {
                role: 'Founding designer',
                studio: 'Harbour Lane, Millbrook',
                joined: '2014-03-01',
                email: { type: 'email', target: 'hannah@example.com' },
                portrait: { assetId: pics[4], alt: 'Hannah in the studio' },
                biography: 'Hannah trained as an architect in Glasgow and spent eight years restoring Georgian townhouses before founding the studio.\nShe still draws every plan by hand first.'
              }
            }
          ]
        },
        { label: 'Add people' }
      ),
    { pics: [...pictures.map((p) => p.id).slice(0, 4), portrait] }
  );
  assert.equal(people.ok, true, `the people are added: ${people.error?.message}`);

  // The Projects starter, as its button in the Content tab makes it, and a blog of two posts.
  const projects = await win.evaluate(
    ({ pics }) =>
      window.builder.project.apply(
        {
          operations: [
            {
              type: 'collection.create',
              collectionId: 'projects',
              name: 'Projects',
              kind: 'structured',
              singularName: 'Project',
              hasBody: true,
              pages: { detail: true, archive: true },
              route: '/projects/',
              fields: {
                client: { type: 'string', label: 'Client', default: '' },
                completed: { type: 'date', label: 'Completed', default: '' },
                image: { type: 'image', label: 'Image', default: { assetId: null, alt: '' } },
                website: { type: 'link', label: 'Website', default: { type: 'none', target: '' } }
              },
              taxonomies: { categories: { label: 'Categories', terms: {} } }
            },
            {
              type: 'entry.create',
              collectionId: 'projects',
              entryId: 'en_harbour01',
              title: 'Harbour Lane townhouse',
              publishedAt: '2026-09-18',
              draft: false,
              excerpt: 'A narrow Victorian townhouse opened up around a new garden kitchen.',
              featuredImage: pics[2],
              body: ['We took the back wall out, moved the kitchen to the garden side and rebuilt the stair in oak, so the light now reaches the front door.'],
              values: { client: 'The Okafor family', completed: '2026-06-30', image: { assetId: pics[3], alt: 'The finished main bedroom, with linen bedding and a brass wall lamp' }, website: { type: 'url', target: 'https://example.com/' } }
            },
            {
              type: 'entry.create',
              collectionId: 'projects',
              entryId: 'en_mill01',
              title: 'The Old Mill studio',
              publishedAt: '2026-08-02',
              draft: false,
              body: ['A two-room studio in a converted mill, with a long desk under the north light.'],
              values: { client: 'Wren & Co.', completed: '2026-04-12' }
            },
            { type: 'collection.create', collectionId: 'posts' },
            {
              type: 'entry.create',
              collectionId: 'posts',
              entryId: 'en_post01',
              title: 'Planning light before you plan furniture',
              publishedAt: '2026-09-12',
              author: 'Hannah Wells',
              draft: false,
              excerpt: 'Why we draw the light first, and the furniture last.',
              featuredImage: pics[1],
              body: ['We start every project by photographing each room at nine, twelve and four.', 'Then we draw where the light falls, and only then where the sofa goes.']
            },
            {
              type: 'entry.create',
              collectionId: 'posts',
              entryId: 'en_post02',
              title: 'Choosing oak: oiled, lacquered or left alone',
              publishedAt: '2026-08-14',
              author: 'Marcus Lee',
              draft: false,
              body: ['Three finishes, ten years of wear, and the one we recommend for family homes.']
            }
          ]
        },
        { label: 'Add projects and posts' }
      ),
    { pics: pictures.map((p) => p.id) }
  );
  assert.equal(projects.ok, true, `the projects and posts are added: ${projects.error?.message}`);

  // The Properties layout open in the editor, with its layers: what an author customises.
  {
    const cdp = await win.context().newCDPSession(win);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    const rail = (name) => win.locator(`.rail [aria-label="${name}"]`);
    const openRail = async (name) => {
      if ((await rail(name).getAttribute('aria-pressed')) !== 'true') await rail(name).click();
      await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await pause(400);
    };
    await openRail('Pages');
    await win.locator('[data-testid="edit-layout-properties"]').click();
    await win.locator('[data-testid="template-strip"]').waitFor({ timeout: 30000 });
    await openRail('Layers');
    await win.locator('[role="tree"] [role="treeitem"]').first().waitFor();
    // Every layer shown: each collapsed row opened.
    for (let i = 0; i < 6; i++) {
      const closed = win.locator('[role="tree"] [role="treeitem"][aria-expanded="false"] .tree-toggle');
      if (!(await closed.count())) break;
      await closed.first().click();
      await pause(150);
    }
    const frame = win.frameLocator('.frame-box iframe');
    await frame.locator('h1', { hasText: 'Bastide de Lourmarin' }).first().waitFor({ timeout: 60000 });
    await pause(1200);
    await win.mouse.move(2, 450);
    const file = join(OUT, 'layout-editor--1440.png');
    await win.screenshot({ path: file });
    written.push(file);
    console.log('wrote', file);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.detach();
  }

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
  const narrow = await tab(320);

  /** Open `path` on the preview and capture it whole (or the box `clip` names), once `check` is visible. */
  async function shot({ page, width, size }, state, path, check, { clip } = {}) {
    await size(900);
    await page.goto(new URL(path, base).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async () => {
      for (const img of document.images) {
        img.loading = 'eager';
        img.decoding = 'sync';
      }
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
    if (clip) {
      const box = await page.locator(clip).first().boundingBox();
      assert.ok(box, `${state}: ${clip} has a box`);
      await page.screenshot({ path: file, clip: { x: 0, y: box.y, width, height: box.height }, fullPage: true });
    } else {
      // The page at its own height, so the whole of it is painted at once.
      await size(await page.evaluate(() => document.documentElement.scrollHeight));
      await page.waitForTimeout(400);
      await page.screenshot({ path: file });
    }
    written.push(file);
    console.log('wrote', file);
  }

  // A property with every field filled, at both widths; one under offer; one with almost nothing.
  await shot(desktop, 'property', 'properties/bastide-de-lourmarin/', 'article h1');
  await shot(phone, 'property', 'properties/bastide-de-lourmarin/', 'article h1');
  await shot(narrow, 'property', 'properties/bastide-de-lourmarin/', 'article h1');
  await shot(desktop, 'property-under-offer', 'properties/villa-solis/', 'article h1');
  await shot(desktop, 'property-sparse', 'properties/casa-da-arrabida/', 'article h1');
  // The Projects starter's record: a date, a picture of its own and a link.
  await shot(desktop, 'project', 'projects/harbour-lane-townhouse/', 'article h1');
  await shot(phone, 'project', 'projects/harbour-lane-townhouse/', 'article h1');
  // A person, from a collection without text of its own.
  await shot(desktop, 'person', 'people/hannah-wells/', 'article h1');
  // A blog article keeps its date, author and reading time.
  await shot(desktop, 'article-header', 'blog/planning-light-before-you-plan-furniture/', 'article h1', { clip: 'article header' });

  const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
  for (const f of written) assert.ok(files.includes(f.split('/').pop()), `${f} was written`);
  console.log(`record pages capture: ${written.length} images in ${OUT}`);
} finally {
  await app.close().catch(() => {});
  // DESIGN_KEEP=1 keeps the exported website (in WORK/out) for inspecting its built markup.
  if (process.env.DESIGN_KEEP === '1') console.log(`kept the export in ${join(WORK, 'out')}`);
  else cleanup();
}
