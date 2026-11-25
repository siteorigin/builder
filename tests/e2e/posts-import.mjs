// Import posts (#399): a WordPress export (published posts, a draft, categories and tags, formatted block-editor and
// classic prose, a script, a frame, an embedded video, pictures in an uploads folder beside it) and a folder of
// Markdown posts are each read from the Posts panel's Import menu, reviewed, cancelled once, then imported as one
// change that Undo takes back and Redo brings again. Pictures become library images with their responsive copies,
// old WordPress addresses keep working, and nothing unsafe arrives. A hostile export (entity expansion) is refused
// while the editor keeps answering. The static website has the imported blog, its redirects and its sitemap.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { answerChoosers, createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'unit', 'fixtures', 'posts-import');
const { WORK, cleanup } = scratch('posts-import');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Riverside Bakery', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const dir = join(WORK, 'sites', 'riverside-bakery');
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const posts = async () => Object.values((await snapshot()).state.collections.posts?.entries ?? {});

/** A real picture: a gradient, so it decodes and gets responsive copies. */
async function picture(file, width, height, format) {
  mkdirSync(dirname(file), { recursive: true });
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px.set([(x * 255) / width, (y * 255) / height, 120], (y * width + x) * 3);
  const img = sharp(px, { raw: { width, height, channels: 3 } });
  await (format === 'png' ? img.png() : img.jpeg({ quality: 80 })).toFile(file);
}

step('a WordPress export with its uploads folder, and a folder of Markdown posts');
const wp = join(WORK, 'wordpress');
cpSync(join(FIXTURES, 'wordpress'), wp, { recursive: true });
await picture(join(wp, 'uploads/2019/03/loaf.jpg'), 1600, 1000, 'jpg');
await picture(join(wp, 'uploads/2019/03/snow.jpg'), 1200, 800, 'jpg');
await picture(join(wp, 'uploads/2019/04/tart.png'), 800, 600, 'png');
const md = join(WORK, 'markdown');
cpSync(join(FIXTURES, 'markdown'), md, { recursive: true });
await picture(join(md, 'images/oven.png'), 900, 600, 'png');
await picture(join(md, 'winter-hours/snow.jpg'), 700, 500, 'jpg');

await win.locator('.rail [aria-label="Posts"]').click();
const panel = win.locator('.posts-panel');
const modal = win.locator('.modal');
/** Choose Import… → `item` in the Posts panel, with the chooser answered `answer`. */
async function chooseImport(item, answer) {
  await answerChoosers(app, [answer]);
  await panel.getByTestId('posts-import').click();
  await win.getByRole('menuitem', { name: item }).click();
}

step('the review says what the WordPress export would bring, and Cancel brings nothing');
const before = (await snapshot()).revision;
await chooseImport(/WordPress export/, { dialog: 'open', paths: [join(wp, 'export.xml')] });
await modal.getByRole('heading', { name: 'Import 3 posts' }).waitFor({ timeout: 30000 });
const lead = await modal.locator('.import-review-lead').innerText();
assert.match(lead, /From export\.xml \(https:\/\/riverside\.example\) into a new Posts at \/blog\/: 2 published posts, 1 draft, 3 pictures, 2 old addresses kept working\./, lead);
assert.match(lead, /new categories: News, Workshops; new tags: Bread/, lead);
assert.equal(await modal.getByTestId('post-import-row').count(), 3);
const winterRow = await modal.getByTestId('post-import-row').first().innerText();
assert.match(winterRow, /Its old address \/2019\/03\/winter-workshop\/ keeps working\./, winterRow);
assert.match(winterRow, /Removed a script\./, winterRow);
assert.match(winterRow, /Left out an embedded frame or player \(https:\/\/ads\.example\/banner\)\./, winterRow);
assert.match(await modal.locator('.post-import-missing summary').innerText(), /1 picture is not in the chosen folder/);
assert.match(await modal.locator('.import-review-rest').innerText(), /1 page: only posts are imported\./);
await modal.getByRole('button', { name: 'Cancel' }).click();
await modal.waitFor({ state: 'detached' });
assert.equal((await snapshot()).revision, before, 'a cancelled review changes nothing');
assert.equal((await snapshot()).state.collections.posts, undefined, 'no blog was made');

step('importing makes one change: the posts, their pictures with responsive copies, terms and old addresses');
await chooseImport(/WordPress export/, { dialog: 'open', paths: [join(wp, 'export.xml')] });
await modal.getByTestId('post-import-confirm').click();
await modal.waitFor({ state: 'detached', timeout: 60000 });
await eventually(async () => assert.equal((await posts()).length, 3, 'three posts are in the project'));
const s1 = await snapshot();
const entries = Object.values(s1.state.collections.posts.entries);
const winter = entries.find((e) => e.slug === 'winter-workshop');
const spring = entries.find((e) => e.slug === 'spring-menu');
const summer = entries.find((e) => e.slug === 'summer-plans');
assert.deepEqual([winter.draft, spring.draft, summer.draft], [false, false, true], 'the draft stays a draft');
assert.equal(winter.publishedAt, '2019-03-01');
assert.equal(winter.author, 'Sam Baker');
assert.deepEqual(winter.terms, { categories: ['news', 'workshops'], tags: ['bread'] });
const types = winter.body.map((b) => b.type);
assert.deepEqual(types, ['p', 'h2', 'ul', 'blockquote', 'image', 'p'], `the text keeps its structure: ${types}`);
const stored = readFileSync(join(dir, 'siteorigin/collections/posts/entries', `${winter.id}.json`), 'utf8');
assert.ok(!/alert|ads\.example|<script/i.test(stored), 'nothing unsafe is stored');
const loaf = s1.state.assets.assets[winter.body.find((b) => b.type === 'image').assetId];
assert.equal(loaf.width, 1600, 'the original upload is imported, not its resized copy');
assert.equal(loaf.originalName, 'loaf.jpg', 'the picture keeps the name of the file that was read');
assert.ok(loaf.variants?.length, 'the picture has responsive copies');
for (const f of [loaf.file, ...loaf.variants.map((v) => v.file)]) assert.ok(existsSync(join(dir, f)), `${f} is in the project`);
assert.ok(winter.featuredImage && s1.state.assets.assets[winter.featuredImage].name === 'snow', 'the featured picture is imported');
assert.deepEqual(s1.state.site.redirects, [
  { from: '/2019/03/winter-workshop/', entryId: winter.id },
  { from: '/2019/04/spring-menu/', entryId: spring.id }
]);
assert.ok(JSON.stringify(spring.body).includes(`"target":"${winter.id}"`), 'a link between imported posts goes to the entry');
const applied = s1.history.entries.filter((e) => e.applied).map((e) => e.label);
assert.equal(applied.at(-1), 'Import 3 posts', `one change in History: ${applied}`);
await win.locator('.post-body').waitFor();
assert.match(await win.locator('.post-body').innerText(), /Join us for a bread-making workshop/, 'the first post opens in the writer');
assert.match(await win.locator('.toast').filter({ hasText: 'Imported 3 posts' }).innerText(), /Imported 3 posts/);

step('Undo takes the whole import back, and Redo brings it again');
const undo = await win.evaluate(() => window.builder.project.undo());
assert.equal(undo.ok, true);
await eventually(async () => assert.equal((await snapshot()).state.collections.posts, undefined, 'Undo removes the blog it made'));
assert.equal((await snapshot()).state.site.redirects, undefined, 'and the old addresses');
const redo = await win.evaluate(() => window.builder.project.redo());
assert.equal(redo.ok, true);
await eventually(async () => assert.equal((await posts()).length, 3, 'Redo brings the posts back'));

step('a folder of Markdown posts joins them');
await chooseImport(/Folder of Markdown posts/, { dialog: 'open', selection: 'folder', paths: [md] });
await modal.getByRole('heading', { name: 'Import 4 posts' }).waitFor({ timeout: 30000 });
assert.match(await modal.getByTestId('post-import-row').first().innerText(), /It links to “Winter hours”, which arrives as a draft: publish that post, or change the link, before the website is exported\./, 'the review says a published post links to a draft');
await modal.getByTestId('post-import-confirm').click();
await modal.waitFor({ state: 'detached', timeout: 60000 });
await eventually(async () => assert.equal((await posts()).length, 7, 'seven posts in all'));
const open = (await posts()).find((e) => e.slug === 'open-day');
assert.equal(open.title, 'Open day: meet the bakers');
assert.equal(open.draft, false, 'a post without a draft setting stays published');
assert.deepEqual(open.body.map((b) => b.type), ['p', 'h2', 'ol', 'blockquote', 'image', 'p']);
assert.equal((await posts()).find((e) => e.slug === 'winter-hours').draft, true);
const s2 = await snapshot();
assert.deepEqual(Object.values(s2.state.collections.posts.settings.taxonomies.categories.terms).map((t) => t.label), ['News', 'Workshops', 'Events'], 'categories with the same name are one');
assert.equal(s2.state.assets.assets[open.featuredImage].id, open.body.find((b) => b.type === 'image').assetId, 'the same picture as featured and in the text is one image');

step('a hostile export is refused with a reason, and the editor keeps answering');
const bad = join(WORK, 'bad');
mkdirSync(bad);
const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">${Array.from({ length: 9 }, (_, i) => `<!ENTITY lol${i + 1} "${`&lol${i || ''};`.repeat(10)}">`).join('')}]><rss><channel><wp:wxr_version>1.2</wp:wxr_version><item>&lol9;</item></channel></rss>`;
writeFileSync(join(bad, 'export.xml'), laughs);
const rev = (await snapshot()).revision;
await chooseImport(/WordPress export/, { dialog: 'open', paths: [join(bad, 'export.xml')] });
const answered = await win.evaluate(async () => {
  const t0 = performance.now();
  await window.builder.app.info();
  return performance.now() - t0;
});
assert.ok(answered < 1000, `the editor answers while the file is read: ${answered} ms`);
await eventually(async () => assert.match(await win.locator('.toast.error').last().innerText(), /export\.xml is not a WordPress export that can be read: it declares a document type/));
assert.equal(await modal.count(), 0, 'no review opens');
writeFileSync(join(bad, 'export.xml'), `<rss><channel><wp:wxr_version>1.2</wp:wxr_version><item><title>Cut off`);
await chooseImport(/WordPress export/, { dialog: 'open', paths: [join(bad, 'export.xml')] });
await eventually(async () => assert.match(await win.locator('.toast.error').last().innerText(), /is never closed/));
assert.equal((await snapshot()).revision, rev, 'nothing changed');

step('the static website has the imported blog, its old addresses and its sitemap');
// The author publishes the draft the open day links to, as the review asked, and gives the site its address.
const hours = (await posts()).find((e) => e.slug === 'winter-hours');
const site = await win.evaluate(
  (id) => window.builder.project.apply({ operations: [{ type: 'entry.update', collectionId: 'posts', entryId: id, draft: false }, { type: 'site.update', baseUrl: 'https://riverside.example' }] }, { label: 'Publish' }),
  hours.id
);
assert.equal(site.ok, true, site.error?.message);
const exportsDir = join(WORK, 'exports');
mkdirSync(exportsDir);
await answerChoosers(app, [{ dialog: 'open', selection: 'folder', paths: [exportsDir] }]);
const stat = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'Static export');
assert.equal(stat.ok, true, `static export succeeds: ${stat.message} ${stat.warnings?.join(' ')}`);
const page = (...path) => readFileSync(join(stat.path, ...path, 'index.html'), 'utf8').replace(/<!--[^]*?-->/g, '');
const built = page('blog', 'winter-workshop');
assert.match(built, /<h1[^>]*>Winter workshop &amp; tasting<\/h1>/, 'the post has its own page');
assert.match(built, /<strong>bread-making<\/strong>/, 'with its formatting');
assert.match(built, /<h2[^>]*>What to bring<\/h2>/);
const loafImg = [...built.matchAll(/<img [^>]*>/g)].map((m) => m[0]).find((t) => t.includes('loaf'));
assert.ok(loafImg, 'the post shows its picture');
assert.match(loafImg, /srcset="[^"]*\d+w/, `the picture in the text has its responsive copies: ${loafImg}`);
assert.match(built, /<figcaption[^>]*>Fresh from the oven<\/figcaption>/);
assert.match(built, /href="https:\/\/www\.youtube\.com\/watch\?v=abc123"/, 'the embedded video is a link');
assert.match(built, /<time datetime="2019-03-01">/);
const html = readdirSync(stat.path, { recursive: true }).filter((f) => /\.(html|js)$/.test(f)).map((f) => readFileSync(join(stat.path, f), 'utf8')).join('\n');
assert.ok(!html.includes("alert('tracking')") && !html.includes('ads.example'), 'nothing unsafe reaches the website');
const refresh = page('2019', '03', 'winter-workshop').match(/<meta http-equiv="refresh" content="0; url=([^"]*)"/)?.[1];
assert.ok(refresh, 'the old WordPress address sends visitors on');
assert.equal(new URL(refresh.replace(/&amp;/g, '&'), 'https://riverside.example/2019/03/winter-workshop/').href, 'https://riverside.example/blog/winter-workshop/', 'it leads to the post on the same site');
assert.match(page('blog', 'open-day'), /We open our doors on <strong>Saturday<\/strong>\. This paragraph runs over two lines\./, 'the Markdown post has its page');
assert.ok(existsSync(join(stat.path, 'blog', 'winter-hours', 'index.html')), 'the post published since has its page');
assert.ok(!existsSync(join(stat.path, 'blog', 'summer-plans')) && !existsSync(join(stat.path, 'blog', 'bad-draft')), 'drafts have no page');
assert.ok(existsSync(join(stat.path, 'blog', 'category', 'news', 'index.html')), 'categories get their archives');
const sitemap = readFileSync(join(stat.path, 'sitemap.xml'), 'utf8');
assert.ok(sitemap.includes('<url><loc>https://riverside.example/blog/winter-workshop/</loc><lastmod>2019-03-01</lastmod></url>'), `the sitemap lists the imported post: ${sitemap}`);
assert.ok(!sitemap.includes('summer-plans'), 'and never a draft');

assert.deepEqual(errors, [], `no errors in the editor: ${errors.join('\n')}`);
await app.close();
cleanup();
console.log('posts-import: ok');
