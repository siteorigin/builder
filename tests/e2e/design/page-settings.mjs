// Design capture for Page settings in the Inspector: the Page section (title, address, Inside, draft), Article,
// Language and translations, Header & footer, Advanced and the Site styles card at its foot. Opt-in only, never part
// of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/page-settings.mjs
//
// Drives the real (built) app with a populated business project, seeds pages through the same project:apply channel
// the editor uses, and writes `{state}--{theme}.png`: the dock alone at 2x. Every capture is checked on screen after
// it settles, and a state that did not render throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('page settings capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'page-settings');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-page-settings-')));
const PANEL = '#dock-panel-inspect';
const SCROLLER = `${PANEL} .panel-body`;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
// Captures at 2x, so 12px hints and field edges are legible to a reviewer.
const cdp = await win.context().newCDPSession(win);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
};

/** Capture `state` per theme: the dock alone, or `clip` (a selector) when given. `check` must be visible. */
async function shot(state, check, { themes = ['light'], before, keepMouse, clip } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (before) await before();
    if (!keepMouse) await win.mouse.move(2, 450);
    await pause(250);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    // Through CDP so the 2x device scale holds (Playwright's own screenshot renders at 1x here).
    const b = await region(clip);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 } });
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

/** The dock's box, widened to take in an open menu (portalled outside it) when there is one. */
async function region(clip) {
  const d = await win.locator(clip ?? '.dock').first().boundingBox();
  const m = (await win.locator('[role="menu"]').count()) ? await win.locator('[role="menu"]').first().boundingBox() : null;
  if (!m) return d;
  const x = Math.min(d.x, m.x - 8), y = Math.min(d.y, m.y - 8);
  return { x, y, width: Math.max(d.x + d.width, m.x + m.width + 8) - x, height: Math.max(d.y + d.height, m.y + m.height + 8) - y };
}

const scrollTo = (top) => win.evaluate(([sel, t]) => (document.querySelector(sel).scrollTop = t), [SCROLLER, top]);
/** Scroll the panel so `sel` sits `offset` pixels below its top edge. */
const scrollToEl = async (sel, offset = 8) => {
  const top = await win.evaluate(([s, scr, o]) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`nothing matches ${s}`);
    const box = document.querySelector(scr);
    return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - o;
  }, [sel, SCROLLER, offset]);
  await scrollTo(top);
  await pause(150);
};
const apply = (operations, label) => win.evaluate(([ops, l]) => window.builder.project.apply({ operations: ops }, { label: l }), [operations, label]);
const mustApply = async (operations, label) => {
  const r = await apply(operations, label);
  if (!r?.ok) throw new Error(`could not apply "${label}": ${JSON.stringify(r?.error)}`);
  await pause(600);
  return r;
};
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const pageBy = (s, title) => Object.values(s.pages).find((p) => p.title === title);

const head = (title) => win.locator(`${PANEL} .section-head`, { hasText: new RegExp(`^${title}`) }).first();
const sectionSel = (id) => `${PANEL} .section:has(> .row > .section-head[aria-controls$="${id}"]), ${PANEL} #${id}`;
const setOpen = async (title, open) => {
  const h = head(title);
  await h.waitFor();
  if ((await h.getAttribute('aria-expanded')) !== String(open)) {
    await h.click();
    await pause(300);
  }
};
const TITLES = ['Page', 'Article', 'Language', 'Header & footer', 'Search & sharing', 'Structured data', 'Advanced'];
const only = async (...open) => {
  for (const t of TITLES) if (await head(t).count()) await setOpen(t, open.includes(t));
};

/** Open Page settings for a page through its row in Pages, as an author does. */
async function pageSettings(title) {
  await win.locator('.side-panel .list-item', { hasText: title }).first().hover();
  await win.locator(`[aria-label="${title} options"]`).first().click();
  await win.getByRole('menuitem', { name: 'Page settings' }).click();
  await head('Page').waitFor();
  await pause(400);
}

// ---- A populated business site, open in the editor ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);

// Seed: About gets two pages inside it, a French and a German version (the German one a draft), and a long-titled
// page that can't move inside About (its address there is taken).
let state = (await snapshot()).state;
const about = pageBy(state, 'About').id;
const dupTeam = await mustApply([{ type: 'page.duplicate', pageId: about, title: 'Our team' }], 'Team');
await mustApply([{ type: 'page.update', pageId: dupTeam.results[0].pageId, route: '/about/our-team/' }], 'Team address');
const dupHistory = await mustApply([{ type: 'page.duplicate', pageId: about, title: 'Studio history' }], 'History');
await mustApply([{ type: 'page.update', pageId: dupHistory.results[0].pageId, route: '/about/studio-history/' }], 'History address');
const dupFr = await mustApply([{ type: 'page.duplicate', pageId: about, title: 'À propos' }], 'French');
const fr = dupFr.results[0].pageId;
await mustApply([{ type: 'page.update', pageId: fr, route: '/fr/a-propos/', language: 'fr' }], 'French address');
const dupDe = await mustApply([{ type: 'page.duplicate', pageId: about, title: 'Über uns' }], 'German');
const de = dupDe.results[0].pageId;
await mustApply([{ type: 'page.update', pageId: de, route: '/de/uber-uns/', language: 'de', draft: true }], 'German address');
await mustApply([{ type: 'page.update', pageId: fr, linkTranslationTo: about }], 'Link French');
await mustApply([{ type: 'page.update', pageId: de, linkTranslationTo: about }], 'Link German');
// A page to link: in English, so it clashes with About's own language.
await mustApply([{ type: 'page.duplicate', pageId: about, title: 'About the founders' }], 'Clash');
state = (await snapshot()).state;
const news = Object.values(state.pages).find((p) => p.id !== about && p.id !== state.site.homePageId && !p.route.startsWith('/about/') && !p.route.startsWith('/fr/') && !p.route.startsWith('/de/'));
if (!news) throw new Error('no page to make an article');
await mustApply([{ type: 'page.update', pageId: news.id, articleDate: '2026-03-14', byline: 'By Ana Ruiz', excerpt: 'The studio’s spring open day: tours of the workshop, new kitchen samples and a talk on reclaimed timber.' }], 'Article');

// Developer mode, through Settings as an author turns it on, so Advanced shows.
await win.locator('[aria-label="Settings"]').click();
const devSwitch = win.getByRole('switch', { name: 'Developer mode' });
if ((await devSwitch.getAttribute('aria-checked')) !== 'true') await devSwitch.click();
await pause(300);
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });
await win.locator('#dock-tab-inspect').click();
await pause(300);

// ---- About: the Page section, with pages inside it and an address that hasn't been exported ----
await pageSettings('About');
await only('Page');
await shot('page-basic', `${PANEL} input[aria-label="Page address"]`, { themes: ['light', 'dark'], before: () => scrollTo(0) });

// ---- About: the closed sections as a page opens with them ----
await only('Page');
await shot('closed-sections', `${PANEL} .section-head`, { before: () => scrollToEl(`${PANEL} [data-seo-field="pageTitle"]`, -200) });

// ---- About: Language open, with two translations (one a draft) ----
await only('Language');
await shot('language-translations', `${PANEL} [aria-label="Translations of this page"]`, { themes: ['light', 'dark'], before: () => scrollToEl(`${PANEL} [aria-label="Translations of this page"]`, 140) });

// ---- The link-a-translation control open, where it is a menu ----
const linker = win.locator(`${PANEL} [data-link-translation], ${PANEL} [aria-label="Link a translation"]`).first();
if ((await linker.count()) && (await linker.evaluate((el) => el.tagName)) !== 'SELECT') {
  await only('Language');
  await scrollToEl(`${PANEL} [aria-label="Translations of this page"]`, 140);
  await linker.click();
  await pause(400);
  await shot('language-link-menu', '[role="menu"]', { keepMouse: true });
  await win.keyboard.press('Escape');
  await pause(200);
}

// ---- Language for a page in the site language, with no translations ----
await pageSettings('Contact').catch(async () => pageSettings(news.title));
await only('Language');
await shot('language-empty', `${PANEL} [aria-label="Page language"]`, { before: () => scrollToEl(`${PANEL} [aria-label="Page language"]`, 140) });
// Its link menu: pages in its language, and pages linked to one in its language.
const linker2 = win.locator(`${PANEL} [data-link-translation]`).first();
if (await linker2.count()) {
  await linker2.click();
  await pause(400);
  await shot('language-empty-link-menu', '[role="menu"]', { keepMouse: true });
  await win.keyboard.press('Escape');
  await pause(200);
}

// ---- The article: Article open, date, byline, excerpt; and the date field focused by keyboard ----
await pageSettings(news.title);
await only('Article');
const dateSel = `${PANEL} input[type="date"], ${PANEL} [aria-label="Article date"]`;
await shot('article', dateSel, { themes: ['light', 'dark'], before: () => scrollToEl(`${PANEL} .section-head[aria-expanded="true"]`, 120) });
await shot('article-date-focus', dateSel, {
  themes: ['light', 'dark'],
  before: async () => {
    await scrollToEl(`${PANEL} .section-head[aria-expanded="true"]`, 120);
    const field = win.locator(dateSel).first();
    await field.focus();
    // A keyboard focus, so :focus-visible matches as it does for Tab.
    await win.keyboard.press('Shift+Tab');
    await win.keyboard.press('Tab');
  },
  keepMouse: true
});

// ---- The article date left incomplete: the saved date back, and a note saying so ----
await scrollToEl(`${PANEL} .section-head[aria-expanded="true"]`, 120);
await win.locator(dateSel).first().focus();
await win.keyboard.press('Backspace');
// Tab moves between the date's own parts; leave the field for the next one, as Tab does from its last part.
await win.locator(`${PANEL} input[placeholder="By Ana Ruiz"]`).first().focus();
await pause(400);
await shot('article-date-error', `${PANEL} [role="status"], ${PANEL} .field-error`, { keepMouse: true });

// ---- Inside, for a page inside About: the field, then its choices open ----
await pageSettings('Our team');
await only('Page');
const insideSel = `${PANEL} [aria-label^="Inside page"]`;
await shot('page-inside-child', insideSel, { before: () => scrollTo(0) });
if ((await win.locator(insideSel).first().evaluate((el) => el.tagName)) !== 'SELECT') {
  await win.locator(insideSel).first().click();
  await pause(400);
  await shot('inside-menu', '[role="menu"]', { keepMouse: true, themes: ['light', 'dark'] });
  await win.keyboard.press('Escape');
  await pause(200);
}

// ---- Header & footer, Advanced and the Site styles card, at the foot of the view ----
await pageSettings('About');
await only('Header & footer', 'Advanced');
await mustApply([{ type: 'page.update', pageId: about, showFooter: false }], 'Hide footer');
await shot('foot', `${PANEL} .insp-goto`, { themes: ['light', 'dark'], before: () => scrollTo(100000) });
await win.locator(`${PANEL} .insp-goto`).hover();
await shot('foot-goto-hover', `${PANEL} .insp-goto`, { keepMouse: true, before: () => scrollTo(100000) });

if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
console.log(`page settings capture: ${written.length} written, ${files.length} in ${OUT}`);
await app.close();
rmSync(WORK, { recursive: true, force: true });
