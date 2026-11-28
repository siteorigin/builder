// Design capture for Welcome's first run: the panel a person sees the first time they open the app, with no recent
// projects. The whole window at its smallest size, two laptops and a wide desktop monitor, the panel on its own, its
// button focused and under the pointer, and the panel waiting while a project opens. Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/first-run.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`. The recent list comes from the main process's own
// `projects:recents` handler, answered empty, and opening a project waits forever, so the waiting state holds still.
// Each capture checks its state on screen after it settles and throws rather than writing a wrong image.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('first run capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'first-run');
mkdirSync(OUT, { recursive: true });
const { WORK, cleanup } = scratch('design-first-run');
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const LAPTOP = { width: 1440, height: 900 };
const SMALL_LAPTOP = { width: 1280, height: 800 }; // A 1080p laptop at 150% scaling, just above the compact layout.
const WIDE = { width: 2560, height: 1440 };
const SMALLEST = { width: 1100, height: 700 }; // The window's minimum size.
const HERO = '.welcome-hero';
const HERO_BUTTON = '.welcome-hero .btn-primary';

const { app, win, errors } = await launch(WORK);
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

// The renderer's seam: no recent projects, and an open that never finishes.
await app.evaluate(({ ipcMain }) => {
  const swap = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, fn);
  };
  swap('projects:recents', () => []);
  swap('projects:open', () => new Promise(() => undefined));
});

/** A fresh renderer at the given size, so no state leaks from the capture before it. */
async function fresh(viewport = LAPTOP) {
  await win.setViewportSize(viewport);
  await win.reload();
  await win.waitForSelector(HERO);
  await win.mouse.move(viewport.width - 4, viewport.height - 4);
  await pause(200);
}

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await pause(200);
}

/** Capture a state in each theme; `check` must be visible, and `text` in it, at the moment of capture. With `crop`,
 *  only that element is written. */
async function shot(state, check, themes = BOTH, { text = null, crop = null } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await pause(150);
    const target = win.locator(check).first();
    if (!(await target.isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    if (text && !(await target.innerText()).includes(text)) throw new Error(`state "${state}" (${theme}) is missing "${text}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    if (crop) await win.locator(crop).first().screenshot({ path });
    else await win.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

// ---- The whole window, at each size ----
await fresh(LAPTOP);
await shot('laptop', HERO, BOTH, { text: 'New project' });
await shot('panel', HERO, BOTH, { crop: HERO });

await fresh(WIDE);
await shot('wide', HERO, BOTH, { text: 'New project' });

await fresh(SMALL_LAPTOP);
await shot('small-laptop', HERO, ['light'], { text: 'New project' });

await fresh(SMALLEST);
await shot('smallest', HERO, BOTH, { text: 'New project' });

// ---- Its one action ----
// Reached from the keyboard: Tab until the panel's button has focus, so it shows the focus a keyboard user sees.
await fresh(LAPTOP);
for (let i = 0; i < 20; i++) {
  if (await win.locator(`${HERO_BUTTON}:focus-visible`).count()) break;
  await win.keyboard.press('Tab');
}
await shot('focus', `${HERO_BUTTON}:focus-visible`, LIGHT, { crop: HERO });

await fresh(LAPTOP);
await win.locator(HERO_BUTTON).hover();
await pause(200);
await shot('hover', HERO_BUTTON, LIGHT, { crop: HERO });

// ---- Waiting while a project opens from the rail's Open project… ----
await fresh(LAPTOP);
await win.locator('.welcome-action', { hasText: 'Open project' }).click();
await win.waitForSelector(`${HERO_BUTTON}:disabled`);
await pause(150);
await shot('opening', `${HERO_BUTTON}:disabled`, LIGHT);

await app.close();
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`first run capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) throw new Error(`page errors during capture:\n${errors.join('\n')}`);
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
