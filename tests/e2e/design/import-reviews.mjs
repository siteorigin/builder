// Design capture harness for the import reviews: the Assets file import review and the WordPress / Markdown post
// import review. Drives the real built app through every state of both dialogs in light and dark and writes one PNG
// per state and theme. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/import-reviews.mjs
//
// The fixtures go through the app's own seams: real files answered to the Assets chooser (project.reviewImport reads
// them), and real exports answered to the Posts panel's Import menu (project.reviewPostImport reads them). Each
// capture is verified after it settles; a state that did not render throws instead of writing a plausible-looking
// wrong image. Files are named `{state}--{theme}.png`. States are cropped to the dialog unless they say otherwise.
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { answerChoosers, choosersShown, createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('import reviews capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'import-reviews');
mkdirSync(OUT, { recursive: true });
const THEMES = ['light', 'dark'];
const POSTS_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'unit', 'fixtures', 'posts-import');
const STARTER = resolve('resources/starter-assets');

const { WORK, cleanup } = scratch('import-reviews');
const { app, win, errors } = await launch(WORK);
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const modal = win.locator('.modal');

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}
/** Capture a state; `check` must be visible in the dialog. `window: true` captures the whole window. */
async function shot(state, check, { themes = THEMES, window = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await win.mouse.move(4, 4);
    await pause(200);
    const visible = await modal.locator(check).first().isVisible().catch(() => false);
    if (!visible) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write (see debug-${state}--${theme}.png)`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    if (window) await win.screenshot({ path });
    else await modal.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
const closeModal = async () => {
  await win.keyboard.press('Escape');
  await modal.waitFor({ state: 'detached', timeout: 10000 });
  await pause(200);
};

// ---- Fixtures ----
const FIX = join(WORK, 'fixtures');
mkdirSync(FIX, { recursive: true });
const noisy = (file, width, height, format = 'png') => {
  const img = sharp({ create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } } });
  return (format === 'png' ? img.png({ compressionLevel: 1 }) : img.jpeg({ quality: 95 })).toFile(file);
};
const photo = async (file, src, width) => sharp(join(STARTER, `${src}.jpg`)).resize({ width }).jpeg({ quality: 82 }).toFile(file);
const heic = join(FIX, 'IMG_0042.heic');
copyFileSync(resolve('tests/unit/fixtures/portrait-rotated.heic'), heic);
const scan = join(FIX, 'field-scan-from-the-archive.png');
await noisy(scan, 3000, 2000);
// A large photo of a real scene: over the large-photo threshold, so the review offers a copy.
const camera = join(FIX, 'harbour-lane-living-room-oak-floor-afternoon-light.jpg');
await sharp(join(STARTER, 'kitchen.jpg')).resize({ width: 4200 }).jpeg({ quality: 98 }).toFile(camera);
// Over 25 MB: only its copy can be added.
const huge = join(FIX, 'warehouse-uncompressed-original.png');
await noisy(huge, 3200, 3000);
const plain = join(FIX, 'plain.jpg');
await photo(plain, 'studio', 800);
const layered = join(FIX, 'logo-artwork.webp');
writeFileSync(layered, 'not a webp picture at all');
const broken = join(FIX, 'team-photo-broken.png');
writeFileSync(broken, 'not really a png');
const empty = join(FIX, 'empty-export.jpg');
writeFileSync(empty, '');
const plainMany = [];
const names = ['hero', 'studio', 'kitchen', 'bedroom', 'reading', 'dining', 'person-1', 'person-2', 'person-3'];
const labels = ['team-offsite-2026', 'IMG_4821', 'kitchen-renovation-before-after-stone-benchtop', 'portrait-hannah-wells-crop', 'DSC00912', 'dining-room-tall-window-winter', 'brand-photo-shoot-selects-03', 'screenshot-2026-10-14-at-09.41.22', 'reading-nook'];
for (let i = 0; i < names.length; i++) {
  const p = join(FIX, `${labels[i]}.jpg`);
  await photo(p, names[i], 600 + i * 10);
  plainMany.push(p);
}
for (const f of ['brochure-2026.pdf', 'menu-autumn.pdf']) {
  const p = join(FIX, f);
  writeFileSync(p, '%PDF-1.4\n%\n');
  plainMany.push(p);
}

// ---- Project ----
await createProject(win, { name: 'Riverside Bakery', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const openTab = async (label) => {
  const b = win.locator(`.rail [aria-label="${label}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(400);
};

/** Choose `files` through the Assets panel's own Add images, and wait for the review. */
async function reviewFiles(files) {
  await openTab('Assets');
  await answerChoosers(app, [{ dialog: 'open', paths: files }]);
  await win.locator('.asset-add, .asset-drop').first().click();
  await modal.locator('[data-testid="import-review-row"]').first().waitFor({ timeout: 60000 }).catch(async (e) => {
    await win.screenshot({ path: join(OUT, 'debug-review-files.png') }).catch(() => {});
    console.log(JSON.stringify(await choosersShown(app), null, 1));
    throw e;
  });
  await pause(400);
}

// ---- Assets review ----
await reviewFiles([heic, scan, plain, layered]);
await shot('assets-mixed', '[data-testid="import-review-row"]');
await shot('assets-mixed-window', '[data-testid="import-review-row"]', { themes: ['light'], window: true });
await modal.locator('input[type="checkbox"]').first().focus();
await win.keyboard.press('Space');
await win.keyboard.press('Space');
await shot('assets-mixed-focus', 'input[type="checkbox"]:focus-visible', { themes: ['light'] });
await closeModal();

await reviewFiles([camera, huge, ...plainMany]);
await shot('assets-many', '[data-testid="import-review-row"]');
const all = modal.locator('[data-testid="import-review-all"] > summary');
if (await all.count()) {
  await all.click();
  await pause(250);
  await shot('assets-many-open', '[data-testid="import-review-row"]');
}
await closeModal();

await reviewFiles([broken, empty, layered]);
await shot('assets-refused', '[data-testid="import-review-row"]');
await closeModal();

// Narrow window: the dialog at its smallest.
await win.setViewportSize({ width: 640, height: 760 });
await pause(300);
await reviewFiles([heic, scan, plain, layered, ...plainMany.slice(0, 6)]);
await shot('assets-narrow', '[data-testid="import-review-row"]', { window: true });
await closeModal();
await win.setViewportSize({ width: 1440, height: 900 });
await pause(300);

// ---- Posts review ----
const wp = join(WORK, 'wordpress');
cpSync(join(POSTS_FIXTURES, 'wordpress'), wp, { recursive: true });
async function picture(file, src, width) {
  mkdirSync(dirname(file), { recursive: true });
  await photo(file, src, width);
}
await picture(join(wp, 'uploads/2019/03/loaf.jpg'), 'kitchen', 1600);
await picture(join(wp, 'uploads/2019/03/snow.jpg'), 'dining', 1200);
await picture(join(wp, 'uploads/2019/04/tart.png'), 'reading', 800);
const md = join(WORK, 'markdown');
cpSync(join(POSTS_FIXTURES, 'markdown'), md, { recursive: true });
await picture(join(md, 'images/oven.png'), 'studio', 900);
await picture(join(md, 'winter-hours/snow.jpg'), 'hero', 700);

// A larger export: 26 posts, some drafts, long titles, many terms; the uncapped list.
const big = join(WORK, 'big-export');
mkdirSync(big, { recursive: true });
const base = readFileSync(join(wp, 'export.xml'), 'utf8');
const head = base.slice(0, base.indexOf('<item>'));
const titles = ['Sourdough starter: a beginner’s guide to keeping it alive through winter', 'Our new rye loaf', 'Market day at the riverside', 'Closed for the public holiday', 'Meet Aroha, our new pastry chef', 'Why we stopped using palm oil', 'Croissant lamination, step by step', 'The bakery turns ten', 'Gluten-free trials', 'Autumn menu', 'Spring menu', 'Coffee pairing evening', 'Kids’ baking class', 'Supplier spotlight: Kōwhai Mill', 'Behind the counter', 'Wholesale orders now open', 'Christmas cake pre-orders', 'Hot cross buns are back', 'Our compost programme', 'New opening hours', 'Pie week', 'A visit from the food critic', 'Bread for the food bank', 'How we shape baguettes', 'Summer berry tarts', 'Thank you, Riverside'];
const items = titles
  .map((t, i) => {
    const d = new Date(Date.UTC(2023, 0, 1 + i * 13));
    const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const draft = i % 7 === 3;
    const cats = i % 3 === 0 ? ['News'] : i % 3 === 1 ? ['Workshops', 'Events'] : ['Menu'];
    const tags = i % 4 === 0 ? ['bread', 'sourdough', 'winter'] : i % 4 === 1 ? ['pastry'] : [];
    return `<item>
<title><![CDATA[${t}]]></title>
<link>https://riverside.example/${d.toISOString().slice(0, 7).replace('-', '/')}/${slug}/</link>
<pubDate>${d.toUTCString()}</pubDate>
<dc:creator><![CDATA[sam]]></dc:creator>
<content:encoded><![CDATA[<p>${t}. A short note from the bakery.</p>]]></content:encoded>
<wp:post_id>${100 + i}</wp:post_id>
<wp:post_date><![CDATA[${d.toISOString().slice(0, 19).replace('T', ' ')}]]></wp:post_date>
<wp:post_name><![CDATA[${slug}]]></wp:post_name>
<wp:status><![CDATA[${draft ? 'draft' : 'publish'}]]></wp:status>
<wp:post_type><![CDATA[post]]></wp:post_type>
${cats.map((c) => `<category domain="category" nicename="${c.toLowerCase()}"><![CDATA[${c}]]></category>`).join('\n')}
${tags.map((c) => `<category domain="post_tag" nicename="${c}"><![CDATA[${c}]]></category>`).join('\n')}
</item>`;
  })
  .join('\n');
writeFileSync(join(big, 'riverside-bakery.WordPress.2026-11-26.xml'), `${head}${items}\n</channel>\n</rss>\n`);

await openTab('Content');
const panel = win.locator('.posts-panel');
async function reviewPosts(item, answer) {
  await answerChoosers(app, [answer]);
  const headBtn = panel.getByTestId('posts-import');
  if (await headBtn.isVisible().catch(() => false)) await headBtn.click();
  else await panel.getByRole('button', { name: / options$/ }).first().click();
  await win.getByRole('menuitem', { name: item }).click();
  await modal.waitFor({ timeout: 30000 });
  await pause(400);
}

// Blocked: a page already holds /blog/, where a new Posts collection would go.
const blocker = await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'page.create', title: 'Blog', route: '/blog/' }] }, { label: 'Add Blog page' }));
if (!blocker.ok) throw new Error(`could not add the blocking page: ${blocker.error?.message}`);
await reviewPosts(/WordPress export/, { dialog: 'open', paths: [join(wp, 'export.xml')] });
await shot('posts-blocked', '[data-testid="post-import-problems"]');
await modal.getByRole('button', { name: /Cancel|Close/ }).last().click();
await modal.waitFor({ state: 'detached' });
await win.evaluate(() => window.builder.project.undo());
await pause(800);

await reviewPosts(/WordPress export/, { dialog: 'open', paths: [join(wp, 'export.xml')] });
await shot('posts-wordpress', '[data-testid="post-import-row"]');
await shot('posts-wordpress-window', '[data-testid="post-import-row"]', { themes: ['light'], window: true });
const missing = modal.locator('.post-import-missing > summary');
if (await missing.count()) {
  await missing.click();
  await pause(250);
  await shot('posts-wordpress-open', '[data-testid="post-import-row"]', { themes: ['light'] });
}
await closeModal();

await reviewPosts(/WordPress export/, { dialog: 'open', paths: [join(big, 'riverside-bakery.WordPress.2026-11-26.xml')] });
await shot('posts-many', '[data-testid="post-import-row"]', { window: true });
const routine = modal.locator('[data-testid="post-import-routine"] > summary');
if (await routine.count()) {
  await routine.click();
  await pause(250);
  await shot('posts-many-open', '[data-testid="post-import-routine"][open]', { window: true, themes: ['light'] });
  await modal.locator('.post-import-details input').check();
  await pause(250);
  await shot('posts-many-details', '.post-import-line.full', { window: true, themes: ['light'] });
}
await closeModal();

await reviewPosts(/folder of Markdown posts/i, { dialog: 'open', selection: 'folder', paths: [md] });
await shot('posts-markdown', '[data-testid="post-import-row"]');
await closeModal();

await win.setViewportSize({ width: 640, height: 760 });
await pause(300);
await reviewPosts(/WordPress export/, { dialog: 'open', paths: [join(wp, 'export.xml')] });
await shot('posts-narrow', '[data-testid="post-import-row"]', { window: true });
await closeModal();
await win.setViewportSize({ width: 1440, height: 900 });
await pause(300);

// Imported, with a picture the library refuses: the dialog stays to list what was not added.
const wpBroken = join(WORK, 'wordpress-broken');
cpSync(wp, wpBroken, { recursive: true });
writeFileSync(join(wpBroken, 'uploads/2019/04/tart.png'), 'not really a png');
await reviewPosts(/WordPress export/, { dialog: 'open', paths: [join(wpBroken, 'export.xml')] });
await modal.getByTestId('post-import-confirm').click();
await modal.getByRole('heading', { name: /^Imported/ }).waitFor({ timeout: 60000 });
await pause(600);
await shot('posts-result', '.import-review-row.refuse');
await shot('posts-result-window', '.import-review-row.refuse', { themes: ['light'], window: true });
await closeModal();

// ---- Verify ----
await app.close();
const pngs = readdirSync(OUT).filter((f) => f.endsWith('.png') && !f.startsWith('debug-'));
const missingFiles = written.filter((p) => !pngs.includes(p.split('/').pop()));
if (missingFiles.length) throw new Error(`missing captures: ${missingFiles.join(', ')}`);
if (errors.length) console.log('page errors:', errors);
console.log(`${written.length} captures in ${OUT}`);
cleanup?.();
rmSync(WORK, { recursive: true, force: true });
