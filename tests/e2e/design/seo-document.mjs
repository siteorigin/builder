// Design capture for one document in the SEO view: its three tabs (Search result on a computer and a phone, light and
// dark results; Link preview; Structured data) with its Search & sharing settings beside them, for a site that has no
// public URL or sharing image yet (as a new site starts) and for one that has both, with a Service page's facts.
// Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/seo-document.mjs
//
// Drives the real (built) app with the business starter, seeds everything through the same project:apply channel the
// editor uses, and writes `{state}--{theme}.png` at 2x, clipped to the whole document. The window is made tall enough
// for the document to show whole, so a capture is never cut at the fold. Every capture is checked on screen after it
// settles, and a state that did not render throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('SEO document capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'seo-document');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-seodoc-')));
const LIGHT = ['light'];
const BOTH = ['light', 'dark'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
const cdp = await win.context().newCDPSession(win);
let size = { width: 1920, height: 1200 };
const resize = async (width, height) => {
  size = { width, height };
  await win.setViewportSize(size);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await win.waitForTimeout(500);
};
await resize(1920, 1200);
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const view = '.seo-view';

const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
};

/** How far the view, or the preview tab bounded to it, still runs past what shows. */
const overflow = () =>
  win.evaluate(() => {
    const s = document.querySelector('.seo-scroll');
    const panel = document.querySelector('.seo-view .seo-preview-wide > [role="tabpanel"]:not([hidden])');
    return Math.max(0, Math.ceil(s.scrollHeight - s.clientHeight), panel ? Math.ceil(panel.scrollHeight - panel.clientHeight) : 0);
  });

/**
 * Capture the whole document per theme, in a window tall enough to show it whole: grown until neither the view nor
 * the preview tab (bounded to the view's height) scrolls. `height` instead captures the window at that height, as
 * it is, scrolled to the top.
 */
async function shot(state, check, { themes = LIGHT, width = 1920, height, before } = {}) {
  await resize(width, height ?? 1200);
  await win.evaluate(() => (document.querySelector('.seo-scroll').scrollTop = 0));
  for (let i = 0; !height && i < 4; i++) {
    const need = await overflow();
    if (!need) break;
    await resize(width, Math.min(4400, size.height + need + 8));
  }
  for (const theme of themes) {
    await setTheme(theme);
    if (before) await before();
    await win.mouse.move(2, 300);
    await pause(300);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const b = await win.locator(`${view} .seo-scroll`).boundingBox();
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
const tab = (name) => win.locator(`${view} [role="tab"]`, { hasText: name }).first();
const choose = async (name) => {
  await tab(name).click();
  await pause(name === 'Structured data' ? 1400 : 700);
};
const setSerp = async (device, dark) => {
  await choose('Search result');
  await win.locator(`${view} .serp-controls [role="radio"]`, { hasText: device === 'mobile' ? 'Phone' : 'Computer' }).click();
  const on = await win.locator(`${view} .serp-theme [role="switch"]`).getAttribute('aria-checked');
  if ((on === 'true') !== dark) await win.locator(`${view} .serp-theme [role="switch"]`).click();
  await pause(500);
};
const open = async (title) => {
  await win.locator('.seo-panel .seo-open', { hasText: title }).first().click();
  await win.locator(`${view} [data-seo-doc]`).waitFor();
  await pause(900);
};

// ---- A business site as it starts: no public URL, no sharing image, and About with a short description ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
const s0 = (await snapshot()).state;
const about = Object.values(s0.pages).find((p) => p.title === 'About');
if (!about) throw new Error('the business starter has no About page');
await apply(
  [
    { type: 'site.update', socialImage: null },
    { type: 'page.update', pageId: about.id, description: 'Meet the team behind Harbour Lane Studio.' },
    { type: 'page.create', pageId: 'pg_garden', title: 'Garden design', starter: 'services' }
  ],
  'Seed a new site'
);

await win.locator('.rail [data-rail="seo"]').click();
await win.locator(`${view} .seo-ov`).waitFor();
await pause(600);
await open('About');

// Search result: a computer, light and dark editor; a phone; dark results.
await setSerp('desktop', false);
await shot('new-search', `${view} .serp-page`, { themes: BOTH });
await setSerp('mobile', false);
await shot('new-search-phone', `${view} .serp-page-mobile`);
await setSerp('desktop', true);
await shot('new-search-dark-results', `${view} .serp-page[data-serp-theme="dark"]`);
await setSerp('desktop', false);
// The narrower window, where the settings go under the previews.
await shot('new-search-narrow', `${view} .serp-page`, { width: 1440 });
await choose('Link preview');
await shot('new-link', `${view} .share-preview`);
await choose('Structured data');
await shot('new-data', `${view} .seo-data`);

// ---- The same site published: a public URL, a sharing image, and a Service page with its facts ----
const image = Object.values((await snapshot()).state.assets.assets).find((a) => a.kind === 'image');
await apply(
  [
    { type: 'site.update', baseUrl: 'https://harbourlane.studio', ...(image ? { socialImage: image.id } : {}) },
    { type: 'page.update', pageId: about.id, description: 'Meet the designers behind Harbour Lane Studio, and how a calm, practical room comes together from first sketch to fitting.' },
    { type: 'page.update', pageId: 'pg_garden', description: 'Planting plans, paving and lighting for small city gardens, drawn up and built by the Harbour Lane team.', structuredData: { type: 'Service', serviceType: 'Garden design', areaServed: 'Cape Town' } }
  ],
  'Publish the site'
);
await choose('Search result');
await shot('live-search', `${view} .serp-page`);
await choose('Link preview');
await shot('live-link', `${view} .share-preview img`, { themes: BOTH });
// An ordinary window: the previews stay beside the settings and the tab scrolls under its tabs.
await shot('live-link-window', `${view} .share-preview img`, { width: 1920, height: 1080 });
await choose('Structured data');
await shot('live-data', `${view} .seo-summary`, { themes: BOTH });

await open('Garden design');
await choose('Structured data');
await shot('service-data', `${view} .seo-summary`);
await win.locator(`${view} .seo-json summary`).click();
await pause(400);
await shot('service-json', `${view} .seo-graph`);

console.log(`wrote ${written.length} captures to ${OUT}`);
if (errors.length) console.log('page errors:', errors.slice(0, 5));
await app.close();
