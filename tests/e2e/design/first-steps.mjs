// Design capture for what a first-time author sees after New project: the editor on a new Business site with its
// Get started list, each step's state as the author works through it, the list folded away, and the editor once the
// list is hidden. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/first-steps.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`. Every capture checks its state on screen after it
// settles and throws rather than writing a wrong image. Reduced motion is emulated so nothing is caught mid-entrance.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOD, answerChoosers, createProject, launch, scratch, withTimeout } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('first steps capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'get-started');
mkdirSync(OUT, { recursive: true });
const { WORK, cleanup } = scratch('design-first-steps');
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const { app, win, errors } = await launch(WORK);
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await pause(250);
}

/** The list and a margin of the window around it. */
async function listClip(margin = 48) {
  const box = await win.locator('.get-started').first().boundingBox();
  const vp = win.viewportSize();
  if (!box) throw new Error('no Get started list to crop to');
  const x = Math.max(0, Math.floor(box.x - margin));
  const y = Math.max(0, Math.floor(box.y - margin));
  return { x, y, width: Math.min(vp.width - x, Math.ceil(box.width + margin * 2)), height: Math.min(vp.height - y, Math.ceil(box.height + margin * 2)) };
}

/** Capture a state in each theme; `check` must be visible (and hold `text`) at the moment of capture. */
async function shot(state, check, { themes = BOTH, text = null, crop = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    // Through the status bar, so nothing a previous step hovered stays hovered.
    await win.mouse.move(720, 894);
    await win.mouse.move(1430, 600);
    await pause(200);
    const target = win.locator(check).first();
    if (!(await target.isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    if (text && !(await target.innerText()).includes(text)) throw new Error(`state "${state}" (${theme}) is missing "${text}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(crop ? { clip: await listClip() } : {}) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

// ---- A new Business site, as New project opens it ----
await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
await pause(1500);
const list = '.get-started';
await shot('opened', list, { text: '0 of 5' });
await shot('list-fresh', list, { crop: true, text: '0 of 5' });

// The first step: its button opens the heading's text in the Inspector.
await win.locator('.gs-step', { hasText: 'main heading' }).click();
await pause(900);
await shot('heading-step', '.dock', { themes: LIGHT });
// Written through the same operation the field commits, so the step ticks from the project, not the click.
const home = await win.evaluate(() => window.builder.project.snapshot().then((s) => s.state.site.homePageId));
const hero = await win.evaluate((id) => window.builder.project.snapshot().then((s) => s.state.pages[id].rootIds[0]), home);
const r = await win.evaluate(({ home, hero }) => window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: home }, nodeId: hero, prop: 'heading', value: 'Rooms that work as hard as you do' }] }, { label: 'Edit heading' }), { home, hero });
if (!r.ok) throw new Error(`heading edit refused: ${r.error?.message}`);
await pause(900);
await shot('list-one-done', list, { crop: true, text: '1 of 5' });

// Add a page: the form opens at the top of the Pages list.
await win.locator('.gs-step', { hasText: 'Add a page' }).click();
await pause(400);
await shot('add-page-step', list, { themes: LIGHT });
await win.keyboard.type('Services');
await win.keyboard.press('Enter');
await pause(1200);

// Preview, then back to Edit.
await win.locator('.gs-step', { hasText: 'Preview your site' }).click();
await pause(1200);
await win.getByRole('button', { name: 'Edit', exact: true }).first().click();
await pause(800);
await shot('three-done', list, { text: '3 of 5' });
await shot('list-three-done', list, { crop: true, text: '3 of 5' });

// Folded to its heading.
await win.locator('.get-started-toggle').click();
await pause(300);
await shot('folded', list, { crop: true, themes: LIGHT, text: '3 of 5' });
await win.locator('.get-started-toggle').click();
await pause(300);

// The smallest window, with the list under the pages.
await win.setViewportSize({ width: 1100, height: 700 });
await pause(600);
await shot('smallest', list, { themes: LIGHT });
await win.setViewportSize({ width: 1440, height: 900 });
await pause(600);

// The colours step and an export: every step done.
await win.locator('.gs-step', { hasText: 'name or colors' }).click();
await pause(900);
await shot('style-step', '.dock', { themes: LIGHT });
// Focus is on the Brand color control, in view, and both halves of the step are open: Basics, and Site details.
if (!(await win.evaluate(() => document.activeElement?.closest('[data-color-pick]') !== null && document.activeElement?.closest('.dock') !== null))) throw new Error('the name and colors step did not focus Brand color');
if ((await win.locator('.dock .section-head', { hasText: 'Site details' }).getAttribute('aria-expanded')) !== 'true') throw new Error('Site details did not open with the name and colors step');
const t = await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'site.update', name: 'Harbour Lane Interiors' }] }, { label: 'Rename site' }));
if (!t.ok) throw new Error(`site rename refused: ${t.error?.message}`);
const exportsDir = join(WORK, 'exports');
mkdirSync(exportsDir, { recursive: true });
// A source export is the editable project, not a website: it leaves the step open.
await answerChoosers(app, [{ dialog: 'open', selection: 'folder', paths: [exportsDir] }]);
const src = await withTimeout(win.evaluate(() => window.builder.project.exportSource()), 120000, 'Source export');
if (!src.ok) throw new Error(`source export failed: ${src.message}`);
await pause(800);
if (!(await win.locator('.get-started-count').innerText()).includes('4 of 5')) throw new Error('a source export ticked Export your website');
await answerChoosers(app, [{ dialog: 'open', selection: 'folder', paths: [exportsDir] }]);
const ex = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'Website export');
if (!ex.ok) throw new Error(`export failed: ${ex.message}`);
await pause(1200);
await shot('all-done', list, { crop: true, text: '5 of 5' });

// Folded when finished: Hide stays on the heading.
await win.locator('.get-started-toggle').click();
await pause(300);
await shot('all-done-folded', list, { crop: true, themes: LIGHT, text: '5 of 5' });
await win.locator('.get-started-toggle').click();
await pause(300);

// Hidden for good: the notice says so, and the list is gone.
await win.locator('.get-started-close').click();
await pause(400);
if (await win.locator(list).isVisible().catch(() => false)) throw new Error('the list is still shown after Hide');
await shot('hidden', '.editor', { themes: LIGHT });

// The way back: the command menu offers Show Get started while the list is hidden.
await win.keyboard.press(`${MOD}+K`);
await win.locator('.cmdk').waitFor();
await win.keyboard.type('get started');
await pause(300);
await shot('command-show', '.cmdk', { themes: LIGHT, text: 'Show Get started' });
await win.keyboard.press('Enter');
await pause(500);
await shot('shown-again', list, { crop: true, themes: LIGHT, text: '5 of 5' });

await app.close();
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`first steps capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
