// Design capture for two of Site styles' site settings: Site details (name, description, public URL, language, text
// direction, favicon, sharing image and who publishes the site) and the Not-found page. Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/site-details-not-found.mjs
//
// Drives the real (built) app with a populated business project, seeds settings through the same project:apply
// channel the editor uses, and writes `{state}--{theme}.png`: the dock alone at 2x. Every capture is checked on
// screen after it settles, and a state that did not render throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('site details capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'site-details-not-found');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-details-')));
const PANEL = '#dock-panel-styles';
const SCROLLER = `${PANEL} .panel-body`;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
// Captures at 2x, so 11px labels and field edges are legible to a reviewer.
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

/** Capture `state` per theme: the dock alone. `check` must be visible at the moment of capture. */
async function shot(state, check, { themes = ['light'], before } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await tag();
    if (before) await before();
    await win.mouse.move(2, 450);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    // Through CDP so the 2x device scale holds (Playwright's own screenshot renders at 1x here).
    const b = await win.locator('.dock').boundingBox();
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 } });
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const scrollTo = (top) => win.evaluate(([sel, t]) => (document.querySelector(sel).scrollTop = t), [SCROLLER, top]);
/** Scroll the panel so `sel` sits `offset` pixels below its top edge. */
const scrollToEl = async (sel, offset = 8) => {
  await tag();
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
  await pause(900);
};

const SECTIONS = { details: 'Site details', agents: 'AI agents', crawlers: 'Crawlers', redirects: 'Redirects', visitor: 'Visitor text', notFound: 'Not-found page' };
const slug = (title) => title.toLowerCase().replace(/[^a-z]+/g, '-');
/** Marks each section with its title's slug, so a capture can find it whatever its heading's summary says. */
const tag = () =>
  win.evaluate((panel) => {
    for (const s of document.querySelectorAll(`${panel} .section`)) {
      const t = s.querySelector(':scope > .row > .section-head')?.childNodes;
      const title = [...(t ?? [])].find((n) => n.nodeType === 3)?.textContent?.trim() ?? '';
      s.dataset.cap = title.toLowerCase().replace(/[^a-z]+/g, '-');
    }
  }, PANEL);
const head = (title) => win.locator(`${PANEL} .section-head`, { hasText: new RegExp(`^${title}`) }).first();
const headSel = (title) => `${sectionSel(title)} > .row > .section-head`;
const setOpen = async (title, open) => {
  const h = head(title);
  if ((await h.getAttribute('aria-expanded')) !== String(open)) {
    await h.click();
    await pause(300);
  }
};
const closeAll = async () => {
  for (const t of Object.values(SECTIONS)) await setOpen(t, false);
};
function sectionSel(title) {
  return `${PANEL} .section[data-cap="${slug(title)}"]`;
}
const details = () => sectionSel('Site details');
const notFound = () => sectionSel('Not-found page');

/** Site details, screen by screen, from its heading to its end. */
async function detailsScreens(prefix, themes = ['light']) {
  await tag();
  const { top0, bottom } = await win.evaluate(([s, scr]) => {
    const el = document.querySelector(s);
    const box = document.querySelector(scr);
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return { top0: r.top - b.top + box.scrollTop - 8, bottom: r.bottom - b.top + box.scrollTop };
  }, [details(), SCROLLER]);
  const client = await win.evaluate((scr) => document.querySelector(scr).clientHeight, SCROLLER);
  let i = 0;
  for (let t = top0; t < bottom - 120 && i < 4; t += client - 80) {
    i++;
    const at = t;
    await shot(`${prefix}-${i}`, `${details()} .section-body`, { themes, before: () => scrollTo(at) });
  }
}

// ---- A populated business site, open in the editor, on the Site styles tab ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
await pause(600);
await closeAll();
for (const t of Object.values(SECTIONS)) if (!(await head(t).count())) throw new Error(`no "${t}" section`);

// ---- The site settings closed, as a new project has them ----
await shot('closed-default', headSel('Site details'), { before: () => scrollToEl(details(), 40) });

// ---- Site details open, as a new business project has it ----
await setOpen('Site details', true);
await detailsScreens('details-default');
await shot('details-default-top', `${details()} .section-body`, { themes: ['dark'], before: () => scrollToEl(details()) });

// ---- Site details filled in: an address, a language with a region, right to left, both pictures ----
const snap = await win.evaluate(() => window.builder.project.snapshot());
const images = Object.values(snap?.state?.assets?.assets ?? {}).filter((a) => a.kind === 'image' && a.file);
if (images.length < 2) throw new Error(`the business starter has ${images.length} images; need two`);
await mustApply(
  [{ type: 'site.update', baseUrl: 'https://harbourlane.studio', language: 'fr-CA', favicon: images[0].id, socialImage: images[1].id, identity: { kind: 'LocalBusiness', telephone: '+1 514 555 0134' } }],
  'Design capture: details filled'
);
await detailsScreens('details-filled');
await shot('details-filled-top', `${details()} .section-body`, { themes: ['dark'], before: () => scrollToEl(details()) });

// ---- Text that can't be saved: an address without https:// and a language that is not a code ----
const urlInput = win.locator(`${details()} #site-public-url`);
await urlInput.fill('harbourlane.studio');
await urlInput.press('Tab');
const lang = win.locator(`${details()} .ss-lang, ${details()} [data-site-language]`).first();
await lang.fill('Frensh');
await lang.press('Tab');
await pause(400);
await shot('details-errors', `${details()} .field-error`, { before: () => scrollToEl(`${details()} #site-public-url`, 120) });
for (const input of [urlInput, lang]) {
  await input.focus();
  await input.press('Escape');
}
await win.evaluate(() => document.activeElement?.blur());
await pause(300);

// ---- The site name cleared: refused with the reason, the saved name kept ----
const nameInput = win.locator(`${details()} #site-name`);
await nameInput.fill('');
await nameInput.press('Tab');
await pause(400);
await shot('details-name-refused', `${details()} .field-error`, { before: () => scrollToEl(details()) });
await nameInput.focus();
await nameInput.press('Escape');
await win.evaluate(() => document.activeElement?.blur());
await pause(300);

// ---- Both closed with settings of the author's own ----
await setOpen('Site details', false);
await mustApply([{ type: 'site.update', notFoundHeading: 'We can’t find that page', notFoundMessage: 'It may have moved when we rebuilt the site. Try the menu, or start again from the home page.' }], 'Design capture: own not-found wording');
await shot('closed-set', headSel('Not-found page'), { themes: ['light', 'dark'], before: () => scrollToEl(details(), 40) });
await mustApply([{ type: 'site.update', notFoundHeading: '', notFoundMessage: '' }], 'Design capture: not-found wording back');

// ---- The Not-found page open, built-in wording ----
await setOpen('Not-found page', true);
await shot('notfound-default', `${notFound()} .section-body`, { themes: ['light', 'dark'], before: () => scrollToEl(notFound()) });

// ---- Wording of the author's own in two of its three fields ----
await mustApply([{ type: 'site.update', notFoundHeading: 'We can’t find that page', notFoundMessage: 'It may have moved when we rebuilt the site. Try the menu, or start again from the home page.' }], 'Design capture: own not-found wording');
await shot('notfound-changed', `${notFound()} .section-body`, { themes: ['light', 'dark'], before: () => scrollToEl(notFound()) });

// ---- The narrowest dock, Site details open at its top ----
await setOpen('Not-found page', false);
await setOpen('Site details', true);
const resizer = win.locator('.seam.right .resizer');
const box = await resizer.boundingBox();
if (box) {
  await win.mouse.move(box.x + box.width / 2, box.y + 200);
  await win.mouse.down();
  await win.mouse.move(box.x + 200, box.y + 200, { steps: 6 });
  await win.mouse.up();
  await pause(500);
}
await shot('details-narrow', `${details()} .section-body`, { before: () => scrollToEl(details()) });
await setOpen('Site details', false);
await setOpen('Not-found page', true);
await shot('notfound-narrow', `${notFound()} .section-body`, { before: () => scrollToEl(notFound()) });

// ---- A long public address, closed, at the narrowest dock: the summary gives way before the title ----
await setOpen('Not-found page', false);
await mustApply([{ type: 'site.update', baseUrl: 'https://www.harbourlane-interiors-and-design-studio.co.za' }], 'Design capture: long address');
await shot('closed-long-host-narrow', headSel('Site details'), { before: () => scrollToEl(details(), 40) });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`site details capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
