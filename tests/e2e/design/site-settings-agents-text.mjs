// Design capture for two of Site styles' site settings: AI agents (llms.txt, its full-text file, Markdown copies,
// WebMCP) and Visitor text (the words the site says on its own). Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/site-settings-agents-text.mjs
//
// Drives the real (built) app with a populated business project, seeds settings through the same project:apply
// channel the editor uses, and writes `{state}--{theme}.png`: the dock alone at 2x. Every capture is checked on
// screen after it settles, and a state that did not render throws instead of writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('site settings capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'site-settings-agents-text');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-agents-')));
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
// Captures at 2x, so 11px labels and switch edges are legible to a reviewer.
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

// Each section's heading, found by its title, whatever its closed-state summary says after it.
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
const headSel = (title) => `${sectionSel(title)} > .row > .section-head`;
const head = (title) => win.locator(`${PANEL} .section-head`, { hasText: new RegExp(`^${title}`) }).first();
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
/** The section whose heading is `title`, as a selector for its root. */
function sectionSel(title) {
  return `${PANEL} .section[data-cap="${slug(title)}"]`;
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
await shot('closed-default', headSel('AI agents'), { before: () => scrollToEl(`${sectionSel('Site details')}`, 40) });

// ---- AI agents open, as a new project has it: llms.txt on and nothing else ----
await setOpen('AI agents', true);
await shot('agents-default', `${sectionSel('AI agents')} .section-body`, { themes: ['light', 'dark'], before: () => scrollToEl(sectionSel('AI agents')) });
// The file itself shows on request.
const showFile = win.locator(`${sectionSel('AI agents')} button[aria-controls="site-llms-preview"]`);
if ((await showFile.count()) && (await showFile.getAttribute('aria-expanded')) === 'false') {
  await showFile.click();
  await pause(300);
}
await scrollToEl(`${sectionSel('AI agents')} [data-testid="llms-txt-preview"]`, 300);
await shot('agents-default-preview', `${sectionSel('AI agents')} [data-testid="llms-txt-preview"]`, { before: () => scrollToEl(`${sectionSel('AI agents')} [data-testid="llms-txt-preview"]`, 300) });
if (await showFile.count()) {
  await showFile.click();
  await pause(300);
}

// ---- Everything on, with a summary of the author's own ----
await mustApply([{ type: 'site.update', llmsFull: true, markdownMirrors: true, webmcp: true, llmsSummary: 'A design studio in Harbour Lane making brand identities, websites and print for small businesses.' }], 'Design capture: agents on');
await shot('agents-all-on', `${sectionSel('AI agents')} .section-body`, { themes: ['light', 'dark'], before: () => scrollToEl(sectionSel('AI agents')) });

// ---- llms.txt off while the others stay on: what still applies, and what does not ----
await mustApply([{ type: 'site.update', llmsTxt: false }], 'Design capture: llms.txt off');
await shot('agents-index-off', `${sectionSel('AI agents')} .section-body`, { before: () => scrollToEl(sectionSel('AI agents')) });
await mustApply([{ type: 'site.update', llmsTxt: true }], 'Design capture: llms.txt on');
await setOpen('AI agents', false);

// ---- Visitor text open, one language, nothing changed ----
await setOpen('Visitor text', true);
await shot('visitor-default', `${sectionSel('Visitor text')} .section-body`, { themes: ['light', 'dark'], before: () => scrollToEl(sectionSel('Visitor text')) });

// ---- Wording of the author's own: three changed, one of them leaving out its fill-in ----
await mustApply(
  [
    {
      type: 'site.update',
      visitorText: { language: 'en', text: { menu: 'Browse', skipLink: 'Jump to the main content', searchMany: 'Plenty of pages mention “{query}”' } }
    }
  ],
  'Design capture: own visitor text'
);
await shot('visitor-changed', `${sectionSel('Visitor text')} .section-body`, { themes: ['light', 'dark'], before: () => scrollToEl(sectionSel('Visitor text')) });
// The search group, where the wording that leaves out {count} sits.
// The Site search group, scrolled so "Several results" (whose wording leaves out {count}) is in view.
const many = `${sectionSel('Visitor text')} [data-vt-key="searchMany"]`;
const dropAt = (await win.locator(many).count()) ? many : `${sectionSel('Visitor text')} [role="group"][aria-label="Site search"]`;
await shot('visitor-fill-dropped', dropAt, { themes: ['light', 'dark'], before: () => scrollToEl(dropAt, 420) });

// ---- Finding one wording, and only the changed ones ----
const find = win.locator(`${sectionSel('Visitor text')} input[type="search"]`);
if (await find.count()) {
  await find.fill('result');
  await pause(300);
  await shot('visitor-find', `${sectionSel('Visitor text')} input[type="search"]`, { before: () => scrollToEl(sectionSel('Visitor text')) });
  await find.fill('zzzz');
  await pause(300);
  await shot('visitor-find-none', `${sectionSel('Visitor text')} input[type="search"]`, { before: () => scrollToEl(sectionSel('Visitor text')) });
  await find.fill('');
  const only = win.locator(`${sectionSel('Visitor text')} .segmented button`, { hasText: /^Changed/ });
  if (await only.count()) {
    await only.click();
    await pause(300);
    await shot('visitor-changed-only', `${sectionSel('Visitor text')} .section-body`, { themes: ['light', 'dark'], before: () => scrollToEl(sectionSel('Visitor text')) });
    await win.locator(`${sectionSel('Visitor text')} .segmented button`, { hasText: /^All/ }).click();
    await pause(300);
  }
}

// ---- Typing in a field: the wording being typed, before it is saved ----
const contactInput = win.locator(`${sectionSel('Visitor text')} [role="group"][aria-label="Contact form"] :is(input, textarea)`).first();
await contactInput.scrollIntoViewIfNeeded();
await contactInput.click();
await contactInput.fill('Send it');
await shot('visitor-typing', `${sectionSel('Visitor text')} [role="group"][aria-label="Contact form"]`, { before: () => scrollToEl(`${sectionSel('Visitor text')} [role="group"][aria-label="Contact form"]`, 40) });
await contactInput.fill('');
await win.keyboard.press('Escape');
await win.evaluate(() => document.activeElement?.blur());
await pause(300);

// ---- Pages in other languages: the language choice ----
await mustApply(
  [
    { type: 'page.create', pageId: 'pg_frca', title: 'Accueil', route: '/fr/' },
    { type: 'page.update', pageId: 'pg_frca', language: 'fr-CA' },
    { type: 'page.create', pageId: 'pg_deut', title: 'Startseite', route: '/de/' },
    { type: 'page.update', pageId: 'pg_deut', language: 'de' }
  ],
  'Design capture: pages in other languages'
);
await shot('visitor-languages', `${sectionSel('Visitor text')} select`, { before: () => scrollToEl(sectionSel('Visitor text')) });
const options = await win.locator(`${sectionSel('Visitor text')} select option`).allInnerTexts();
console.log('language options:', JSON.stringify(options));
writeFileSync(join(OUT, 'language-options.txt'), options.join('\n') + '\n');

// ---- The whole Visitor text section, screen by screen (light) ----
await tag();
const { top0, bottom } = await win.evaluate(([s, scr]) => {
  const el = document.querySelector(s);
  const box = document.querySelector(scr);
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return { top0: r.top - b.top + box.scrollTop, bottom: r.bottom - b.top + box.scrollTop };
}, [sectionSel('Visitor text'), SCROLLER]);
const client = await win.evaluate((scr) => document.querySelector(scr).clientHeight, SCROLLER);
let i = 0;
for (let t = top0; t < bottom - 120 && i < 8; t += client - 80) {
  i++;
  const at = t;
  await shot(`visitor-scroll-${String(i).padStart(2, '0')}`, `${sectionSel('Visitor text')} .section-body`, { before: () => scrollTo(at) });
}

// ---- Both sections closed with settings of the author's own: what each heading says about them ----
await setOpen('Visitor text', false);
await shot('closed-set', headSel('Visitor text'), { themes: ['light', 'dark'], before: () => scrollToEl(`${sectionSel('Site details')}`, 40) });

// ---- Every change put back while only the changed ones show: the rows stay, with a way back to All ----
await setOpen('Visitor text', true);
const changedBtn = win.locator(`${sectionSel('Visitor text')} .segmented button`, { hasText: /^Changed/ });
if (await changedBtn.count()) {
  await changedBtn.click();
  await pause(300);
  for (let n = 0; n < 6; n++) {
    const dot = win.locator(`${sectionSel('Visitor text')} .vt-field.set .reset-dot`).first();
    if (!(await dot.count())) break;
    await dot.click();
    await pause(700);
  }
  await shot('visitor-reset-all', `${sectionSel('Visitor text')} .segmented`, { before: () => scrollToEl(sectionSel('Visitor text')) });
}
await setOpen('Visitor text', false);

// ---- The narrowest dock, AI agents open ----
await setOpen('AI agents', true);
const resizer = win.locator('.seam.right .resizer');
const box = await resizer.boundingBox();
if (box) {
  await win.mouse.move(box.x + box.width / 2, box.y + 200);
  await win.mouse.down();
  await win.mouse.move(box.x + 200, box.y + 200, { steps: 6 });
  await win.mouse.up();
  await pause(500);
}
await shot('agents-narrow', `${sectionSel('AI agents')} .section-body`, { before: () => scrollToEl(sectionSel('AI agents')) });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`site settings capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
