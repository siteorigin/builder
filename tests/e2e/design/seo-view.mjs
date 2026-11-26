// Design capture for the SEO view: the rail's SEO entry, its sidebar list, the overview table in the canvas's place,
// a page's and a post's search result, link preview and structured data with their settings, the view read-only,
// and Site styles' Crawlers and Redirects sections. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/seo-view.mjs
//
// Drives the real (built) app with a populated business site, seeds posts, sharing settings and redirects through the
// same project:apply channel the editor uses, and writes `{state}--{theme}.png` at 2x. Every capture is checked on
// screen after it settles, and a state that did not render throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('SEO view capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'seo-view');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-seo-')));
const THEMES = ['light', 'dark'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
const cdp = await win.context().newCDPSession(win);
let size = { width: 1440, height: 900 };
const resize = async (width, height) => {
  size = { width, height };
  await win.setViewportSize(size);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await win.waitForTimeout(500);
};
await resize(1440, 900);
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
};

/** Capture `state` per theme: the whole window, or the box of `clip` when given. */
async function shot(state, check, { themes = THEMES, before, clip, hover } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (before) await before();
    if (hover) await win.locator(hover).first().hover({ force: true });
    else await win.mouse.move(2, size.height / 2);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const b = clip ? await win.locator(clip).first().boundingBox() : { x: 0, y: 0, ...size };
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 } });
    const path = join(OUT, `${state}--${theme}.png`);
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const apply = async (operations, label) => {
  const r = await win.evaluate(([ops, l]) => window.builder.project.apply({ operations: ops }, { label: l }), [operations, label]);
  if (!r?.ok) throw new Error(`could not apply "${label}": ${JSON.stringify(r?.error)}`);
  await pause(600);
};
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const rail = (id) => win.locator(`.rail [data-rail="${id}"]`);
const view = '.seo-view';
const scrollView = (top) => win.evaluate((t) => (document.querySelector('.seo-scroll').scrollTop = t), top);

// ---- A populated business site with a blog: one post published, one a draft, sharing set on the site ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await apply(
  [
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio: tours of the new workshop and the materials library', publishedAt: '2027-03-02', draft: false },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter hours', publishedAt: '2026-11-14' }
  ],
  'Add posts'
);
const s0 = (await snapshot()).state;
const about = Object.values(s0.pages).find((p) => p.title === 'About');
const contact = Object.values(s0.pages).find((p) => /contact/i.test(p.title));
const image = Object.values(s0.assets.assets).find((a) => a.kind === 'image');
const ops = [{ type: 'page.update', pageId: about.id, description: 'Meet the designers behind Harbour Lane Studio, and how a calm, practical room comes together from first sketch to fitting.' }];
if (image) ops.push({ type: 'site.update', socialImage: image.id });
if (contact) ops.push({ type: 'page.update', pageId: contact.id, noindex: true });
await apply(ops, 'Seed search settings');

// ---- The SEO view: overview ----
await rail('seo').click();
await win.locator(`${view} .seo-ov`).waitFor();
await pause(800);
await shot('overview', `${view} .seo-ov-table`);
await shot('overview-hover', `${view} .seo-ov-table`, { themes: ['light'], hover: `${view} .seo-ov-row:nth-child(2) td:nth-child(3)` });
await win.locator(`${view} .seo-ov-filter input`).check();
await pause(300);
await shot('overview-problems', `${view} .seo-ov-table`, { themes: ['light'] });
await win.locator(`${view} .seo-ov-filter input`).uncheck();

// Squeezed: a smaller window with the dock open leaves the table its narrowest.
await resize(1180, 820);
await shot('overview-narrow', `${view} .seo-ov-table`);
await resize(1440, 900);

// ---- A page: search result, link preview, structured data, and its settings ----
await win.locator('.seo-panel .seo-open', { hasText: 'About' }).first().click();
await win.locator(`${view} [data-seo-doc]`).waitFor();
await pause(800);
await shot('page-search', `${view} .seo-doc`);
const tab = (name) => win.locator(`${view} [role="tab"]`, { hasText: name }).first();
await tab('Link preview').click();
await pause(800);
await shot('page-link', `${view} .share-preview`);
await tab('Structured data').click();
await pause(1200);
await shot('page-data', `${view} .seo-doc`, { themes: ['light'] });
await tab('Search result').click();
await pause(400);
// The settings, scrolled to.
await win.evaluate(() => {
  const s = document.querySelector('.seo-scroll');
  const at = document.querySelector('.seo-view .seo-settings');
  s.scrollTop = at.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 20;
});
await shot('page-settings', `${view} .seo-settings`);
await win.evaluate(() => {
  const s = document.querySelector('.seo-scroll');
  s.scrollTop = s.scrollHeight;
});
await shot('page-settings-end', `${view} .seo-settings`, { themes: ['light'] });
await scrollView(0);

// Wide: a large window, where a page's settings can sit beside its previews.
await resize(1920, 1080);
await shot('page-wide', `${view} .seo-doc`);
await resize(1440, 900);

// ---- A page hidden from search engines: why it is kept out of search ----
if (contact) {
  await win.locator('.seo-panel .seo-open', { hasText: contact.title }).first().click();
  await pause(800);
  await shot('page-hidden', `${view} .seo-doc`, { themes: ['light'] });
}

// ---- A post: search result and its settings ----
await win.locator('.seo-panel .seo-open', { hasText: 'Spring open studio' }).first().click();
await pause(1000);
await shot('post-search', `${view} .seo-doc`);
await win.evaluate(() => {
  const s = document.querySelector('.seo-scroll');
  const at = document.querySelector('.seo-view .seo-settings');
  s.scrollTop = at.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 20;
});
await shot('post-settings', `${view} .seo-settings`);
await scrollView(0);
await resize(1920, 1080);
await shot('post-wide', `${view} .seo-doc`, { themes: ['light'] });
await resize(1440, 900);
await win.locator('.seo-panel .seo-open', { hasText: 'Winter hours' }).first().click();
await pause(800);
await shot('post-draft', `${view} .seo-doc`, { themes: ['light'] });

// The Close button's tooltip, with a document open.
await win.locator(`${view} .seo-leave`).hover();
await pause(1200);
await shot('close-tooltip', `${view} .seo-leave`, { themes: ['light'], hover: `${view} .seo-leave`, clip: '.seo-bar' });

// ---- Site styles: Crawlers (Custom) and Redirects, one with a problem and the form open ----
await win.keyboard.press('Escape');
await pause(300);
await win.keyboard.press('Escape');
await pause(300);
await apply(
  [
    { type: 'site.update', crawlerPolicy: { preset: 'custom', base: 'block-ai-training', overrides: { GPTBot: 'allow' }, disallowPaths: ['/private/'] } },
    { type: 'redirect.add', from: '/old-services/', pageId: about.id },
    { type: 'redirect.add', from: '/team/', to: '/nowhere/' },
    { type: 'redirect.add', from: '/winter/', entryId: 'en_winter' },
    { type: 'redirect.add', from: '/studio-a/', to: '/studio-b/' },
    { type: 'redirect.add', from: '/studio-b/', pageId: about.id }
  ],
  'Seed crawlers and redirects'
);
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);
const section = (title) => win.locator('.dock .section').filter({ has: win.locator('.section-head', { hasText: new RegExp(`^${title}`) }) }).first();
const openSection = async (id, title) => {
  await win.evaluate((i) => window.dispatchEvent(new CustomEvent('inspector-open-section', { detail: { id: i, scroll: false } })), id);
  await pause(400);
  await section(title).locator('.section-head').scrollIntoViewIfNeeded();
  await section(title).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await pause(300);
};
await openSection('site-crawlers', 'Crawlers');
await shot('crawlers', '.dock .crawler-row', { clip: '.dock' });
await win.locator('.dock .crawler-preview').evaluate((el) => el.scrollIntoView({ block: 'end' }));
await shot('crawlers-end', '.dock .crawler-preview', { themes: ['light'], clip: '.dock' });
await openSection('site-redirects', 'Redirects');
await shot('redirects', '.dock .so-redirects', { clip: '.dock' });
await win.locator('#site-redirects-add').click();
await pause(300);
await win.locator('.dock .so-redirect-form').evaluate((el) => el.scrollIntoView({ block: 'center' }));
await shot('redirects-form', '.dock .so-redirect-form', { clip: '.dock' });
await win.locator('.dock .so-redirect-form button', { hasText: 'Cancel' }).click();

// ---- Read-only: the project held by another window ----
const dir = (await snapshot()).dir;
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
writeFileSync(join(dir, '.siteorigin/lock.json'), JSON.stringify({ pid: process.pid, host: hostname(), instance: 'another-window', started: new Date().toISOString() }));
const opened = await win.evaluate((d) => window.builder.projects.open(d), dir);
if (!opened?.ok) throw new Error('could not open read-only: ' + JSON.stringify(opened));
await win.waitForSelector('.editor');
const ro = await snapshot();
if (!ro.readOnly) throw new Error('the project did not open read-only');
await pause(2500);
await rail('seo').click();
await win.locator(`${view} .seo-ov`).waitFor();
await pause(600);
await shot('readonly-overview', `${view} .seo-ov-table`, { themes: ['light'] });
await win.locator('.seo-panel .seo-open', { hasText: 'About' }).first().click();
await pause(800);
await win.evaluate(() => {
  const s = document.querySelector('.seo-scroll');
  const at = document.querySelector('.seo-view .seo-settings');
  s.scrollTop = at.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 200;
});
await shot('readonly-page', `${view} .seo-settings`, { themes: ['light'] });

console.log(`wrote ${written.length} captures to ${OUT}`);
if (errors.length) console.log('page errors:', errors.slice(0, 5));
await app.close();
