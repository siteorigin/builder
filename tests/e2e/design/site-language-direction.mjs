// Design capture for the site's language and text direction (Site styles > Site details > Language and direction) and
// the live canvas that follows them. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/site-language-direction.mjs
//
// Drives the real (built) app with a populated business project. The direction and the language are chosen in the
// dock as an author chooses them (a click, typed text), and Arabic copy is typed into the canvas; a page's own language
// goes through the same project:apply channel the editor uses. Writes `{state}--{theme}.png` at 2x: `window-*` is the
// whole editor, `canvas-*` the canvas alone. Every capture is checked on screen after it settles, and the canvas must
// have taken the language and direction the state stands for (its <html lang> and dir) in the same document, without
// a reload, or the state throws instead of writing a wrong image. DESIGN_CAPTURE_LENIENT=1 captures a canvas that did
// not follow anyway, for a picture of a preview that does not follow. manifest.json lists, for each capture, what the
// canvas declared, whether it was still the same document, and where its page was scrolled. DESIGN_CAPTURE_TRACE=1
// also logs what the preview server sends the canvas (hot updates, reloads), to find what reloaded it.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('site language capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'site-language-direction');
mkdirSync(OUT, { recursive: true });
const LENIENT = process.env.DESIGN_CAPTURE_LENIENT === '1';
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-lang-')));
const PANEL = '#dock-panel-styles';
const SCROLLER = `${PANEL} .panel-body`;
const GROUP = `${PANEL} [aria-labelledby="site-details-language"]`;
const W = 1440;
const H = 900;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
// What the preview's dev server told the canvas (a hot update, or a reload and the file that caused it), for the log.
win.on('console', (m) => m.text().startsWith('[vite]') && console.log(`canvas: ${m.text()}`));
if (process.env.DESIGN_CAPTURE_TRACE === '1')
  win.on('websocket', (ws) => ws.on('framereceived', (f) => typeof f.payload === 'string' && /full-reload|"update"|siteorigin:revision/.test(f.payload) && console.log(`hmr: ${f.payload.slice(0, 300)}`)));
await win.setViewportSize({ width: W, height: H });
const cdp = await win.context().newCDPSession(win);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const manifest = [];
const problems = [];

const setTheme = async (theme) => {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
};

/** What the canvas's document declares, whether it is the document marked last, and where its page is scrolled. */
const declared = () =>
  frame.locator('html').evaluate((el) => ({ lang: el.getAttribute('lang'), dir: el.getAttribute('dir'), same: window.__soCaptureMark === true, scrollY: Math.round(window.scrollY) }));
/** Marks the canvas's document, so a later look can tell whether the change reloaded it. */
const mark = () => frame.locator('html').evaluate(() => (window.__soCaptureMark = true));

/** Waits for the canvas to declare `want`; returns what it declares and whether that is `want`. */
async function follows(want, ms = 20000) {
  const end = Date.now() + ms;
  let got = await declared().catch(() => null);
  while (Date.now() < end && !(got?.lang === want.lang && got?.dir === want.dir)) {
    await pause(250);
    got = await declared().catch(() => null);
  }
  return { got, ok: got?.lang === want.lang && got?.dir === want.dir };
}

/** The canvas, with the editor's marks over and around its page. */
async function canvasClip() {
  const c = await win.locator('.canvas').boundingBox();
  return { x: c.x, y: c.y, width: Math.min(c.width, W - c.x), height: Math.min(c.height, H - c.y) };
}

/**
 * Capture `state` per theme. `check` must be visible at the moment of capture, and with `want` the canvas must declare
 * that language and direction first; with `kept` too, in the document marked before the change. `region` is 'window'
 * or 'canvas'.
 */
async function shot(state, check, { themes = ['light'], region = 'window', want, kept = false, before } = {}) {
  let canvas = null;
  let followed = null;
  if (want) {
    const r = await follows(want);
    canvas = r.got;
    followed = r.ok;
    const reloaded = kept && r.got && !r.got.same;
    const problem = !r.ok ? `declares ${JSON.stringify({ lang: r.got?.lang, dir: r.got?.dir })}, not ${JSON.stringify(want)}` : reloaded ? 'was loaded again for the change' : null;
    if (problem && !LENIENT) throw new Error(`state "${state}": the canvas ${problem}; refusing to write`);
    if (problem) {
      problems.push(`${state}: the canvas ${problem}`);
      console.log(`MISMATCH ${state}: the canvas ${problem}`);
    }
    // The page lays itself out again once its direction changes.
    await pause(700);
  }
  for (const theme of themes) {
    await setTheme(theme);
    if (before) await before();
    await win.mouse.move(2, 450);
    await pause(250);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    const clip = region === 'canvas' ? await canvasClip() : { x: 0, y: 0, width: W, height: H };
    // Through CDP so the 2x device scale holds (Playwright's own screenshot renders at 1x here).
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    const now = await declared().catch(() => null);
    manifest.push({ file: `${state}--${theme}.png`, region, canvas: now ?? canvas, wanted: want ?? null, followed });
    console.log('wrote', path);
  }
  await setTheme('light');
}

const scrollTo = (top) => win.evaluate(([sel, t]) => (document.querySelector(sel).scrollTop = t), [SCROLLER, top]);
/** Scroll the dock so `sel` sits `offset` pixels below its top edge. */
const scrollDockTo = async (sel, offset = 8) => {
  const top = await win.evaluate(([s, scr, o]) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`nothing matches ${s}`);
    const box = document.querySelector(scr);
    return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - o;
  }, [sel, SCROLLER, offset]);
  await scrollTo(top);
  await pause(150);
};
/** Scroll the canvas's page: a number of pixels, or 'end'. */
const scrollPage = async (to) => {
  await frame.locator('html').evaluate((_, t) => window.scrollTo({ top: t === 'end' ? document.documentElement.scrollHeight : t, behavior: 'instant' }), to);
  await pause(400);
};
const apply = async (operations, label) => {
  const r = await win.evaluate(([ops, l]) => window.builder.project.apply({ operations: ops }, { label: l }), [operations, label]);
  if (!r?.ok) throw new Error(`could not apply "${label}": ${JSON.stringify(r?.error)}`);
};
const stylesTab = async () => {
  await win.locator('.dock-tab', { hasText: 'Site styles' }).click();
  await pause(400);
};
const direction = (name) => win.locator(`${GROUP} [role="radio"]`, { hasText: name });
const choose = async (name) => {
  await direction(name).click();
  // Chosen once the project has taken the change.
  await win.locator(`${GROUP} [role="radio"][aria-checked="true"]`, { hasText: name }).waitFor({ timeout: 8000 }).catch(() => {
    throw new Error(`"${name}" did not become the chosen direction`);
  });
};
const language = () => win.locator(`${GROUP} .ss-lang`).first();
const typeLanguage = async (text) => {
  await language().fill(text);
  await language().press('Enter');
  await win.evaluate(() => document.activeElement?.blur());
  await pause(400);
};
const width = async (name) => {
  await win.locator(`[role="radiogroup"][aria-label="Preview width"] [aria-label="${name}"]`).click();
  await pause(900);
};
const page = async (title) => {
  await win.locator('.pages-list [role="option"]', { hasText: new RegExp(`^${title}`) }).first().click();
  await pause(1200);
};
const clearSelection = async () => {
  const box = await win.locator('.canvas-scroll').boundingBox();
  await win.mouse.click(box.x + 16, box.y + 120);
  await win.locator('.ov-chip').waitFor({ state: 'detached', timeout: 8000 }).catch(() => undefined);
  await pause(250);
};
/** Whether the page shows the editor's text formatting toolbar. */
const toolbarShown = () => frame.locator('html').evaluate(() => [...document.documentElement.children].some((h) => h.shadowRoot?.querySelector('[role="toolbar"][aria-label="Text formatting"]')));
/** Replace the text of `target` in the canvas by typing, as an author does, and keep it. */
const retype = async (target, text, rich) => {
  await target.dispatchEvent('dblclick');
  await frame.locator('[contenteditable]').first().waitFor({ timeout: 8000 });
  await win.keyboard.press('Meta+A');
  await win.keyboard.type(text);
  await pause(300);
  if (rich && !(await toolbarShown())) throw new Error('the text formatting toolbar did not open; refusing to go on');
};
const keepEdit = async (rich) => {
  await win.keyboard.press(rich ? 'Meta+Enter' : 'Enter');
  await pause(1500);
};

// ---- A populated business site, open in the editor, Site details open at Language and direction ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1500);
await stylesTab();
const details = win.locator(`${PANEL} .section-head`, { hasText: /^Site details/ }).first();
if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click();
await pause(400);
const atGroup = () => scrollDockTo(GROUP, 24);

// ---- At rest: English, automatic, left to right ----
await shot('window-ltr-rest', GROUP, { want: { lang: 'en', dir: 'ltr' }, before: atGroup });

// ---- The main heading selected while the site turns right to left (the change the dock's choice makes, made with the
//      heading still selected, since opening Site styles puts the selection's marks away): the canvas runs right to
//      left in place, and the marks follow the heading to its new side ----
await mark();
await frame.locator('h1').first().dispatchEvent('click', { altKey: true });
await win.locator('.ov-chip').first().waitFor({ timeout: 8000 });
await pause(500);
await apply([{ type: 'site.update', direction: 'rtl' }], 'Design capture: right to left with the heading selected');
await shot('canvas-rtl-selection-kept', '.ov-chip', { region: 'canvas', want: { lang: 'en', dir: 'rtl' }, kept: true });
await clearSelection();
await apply([{ type: 'site.update', direction: 'auto' }], 'Design capture: automatic again');
await follows({ lang: 'en', dir: 'ltr' });

// ---- Right to left chosen in the dock with a click ----
await stylesTab();
await atGroup();
await choose('Right to left');
await shot('window-rtl-chosen', GROUP, { want: { lang: 'en', dir: 'rtl' }, kept: true, themes: ['light', 'dark'], before: atGroup });

// ---- The author's place kept: halfway down the page, Left to right and then Right to left again ----
await scrollPage(900);
const placeBefore = (await declared()).scrollY;
await choose('Left to right');
await follows({ lang: 'en', dir: 'ltr' });
await choose('Right to left');
await shot('canvas-rtl-middle', '.frame-box', { region: 'canvas', want: { lang: 'en', dir: 'rtl' }, kept: true });
const placeAfter = (await declared()).scrollY;
if (Math.abs(placeAfter - placeBefore) > 40) problems.push(`the canvas moved from ${placeBefore}px to ${placeAfter}px down the page across two direction changes`);
await shot('canvas-rtl-top', '.frame-box', { region: 'canvas', want: { lang: 'en', dir: 'rtl' }, before: () => scrollPage(0) });
await shot('canvas-rtl-end', '.frame-box', { region: 'canvas', want: { lang: 'en', dir: 'rtl' }, before: () => scrollPage('end') });
await scrollPage(0);

// ---- Back to left to right ----
await choose('Left to right');
await shot('window-ltr-chosen', GROUP, { want: { lang: 'en', dir: 'ltr' }, kept: true, before: atGroup });

// ---- Arabic typed as the language, direction automatic: the canvas runs right to left in Arabic ----
await choose('Automatic');
await typeLanguage('Arabic');
await shot('window-ar-automatic', GROUP, { want: { lang: 'ar', dir: 'rtl' }, kept: true, themes: ['light', 'dark'], before: atGroup });
await width('Phone');
await shot('canvas-ar-phone', '.frame-box', { region: 'canvas', want: { lang: 'ar', dir: 'rtl' }, before: () => scrollPage(0) });
await width('Desktop');

// ---- Arabic with left to right chosen: the site's direction wins over the language's ----
await choose('Left to right');
await shot('window-ar-ltr', GROUP, { want: { lang: 'ar', dir: 'ltr' }, kept: true, before: atGroup });

// ---- English again, automatic ----
await choose('Automatic');
await typeLanguage('en');
await shot('window-en-again', GROUP, { want: { lang: 'en', dir: 'ltr' }, kept: true, before: atGroup });

// ---- An English site with one page in Arabic: that page runs right to left in the canvas, and the dock says why ----
const snap = await win.evaluate(() => window.builder.project.snapshot());
const about = Object.values(snap.state.pages).find((p) => p.title === 'About');
if (!about) throw new Error('the business starter has no About page');
await apply([{ type: 'page.update', pageId: about.id, language: 'ar' }], 'Design capture: About in Arabic');
await page('About');
await stylesTab();
await shot('window-page-ar', GROUP, { want: { lang: 'ar', dir: 'rtl' }, before: atGroup });

// ---- Arabic copy typed on that page: its heading, and a paragraph of rich text with the formatting toolbar open ----
await scrollPage(0);
await retype(frame.locator('main h1').first(), 'استوديو صغير برؤية بعيدة المدى', false);
await keepEdit(false);
const rich = frame.locator('main .so-rich').first();
if (!(await rich.count())) throw new Error('the About page has no rich text to type into');
await rich.scrollIntoViewIfNeeded();
await retype(rich, 'بدأنا عام 2011 بمشروعين صغيرين، واليوم ننجز أكثر من 120 مشروعاً كل سنة في Harbor Lane.', true);
await shot('canvas-page-ar-editing', '.frame-box', { region: 'canvas', want: { lang: 'ar', dir: 'rtl' } });
await keepEdit(true);
await clearSelection();
await shot('canvas-page-ar-native', '.frame-box', { region: 'canvas', want: { lang: 'ar', dir: 'rtl' }, before: () => scrollPage(0) });
await page('Home');
await stylesTab();
await shot('window-page-en-home', GROUP, { want: { lang: 'en', dir: 'ltr' }, before: atGroup });

await app.close();
rmSync(WORK, { recursive: true, force: true });
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ problems, captures: manifest }, null, 2));

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`site language capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (problems.length) console.log('problems:\n' + problems.join('\n'));
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
if (problems.length && !LENIENT) throw new Error('the canvas did not keep its place; see problems above');
