// Design capture for Welcome's rail: the brand, the three start actions and the footer, on first run and with recent
// projects, in both appearances, at rest, under the pointer, with keyboard focus and while an open is on its way, at
// the window's smallest size, a laptop and a wide monitor. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/welcome-rail.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`: the whole window for context, and the rail on its own.
// The recent projects come from a fixture through the main process's own `projects:recents` handler, and an open waits
// forever, so the busy state holds still. Each capture checks its state on screen after it settles and throws rather
// than writing a wrong image.
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('welcome rail capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'welcome-rail');
mkdirSync(OUT, { recursive: true });
const { WORK, cleanup } = scratch('design-welcome-rail');
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const LAPTOP = { width: 1440, height: 900 };
const WIDE = { width: 2560, height: 1440 };
const SMALLEST = { width: 1100, height: 700 }; // The window's minimum size.

const { app, win, errors } = await launch(WORK);
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
// Captured at the display's own pixel density (2x on a Retina Mac), so type and hairlines can be judged.
const cdp = await win.context().newCDPSession(win);

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const home = '/Users/alex/Websites';
const RECENTS = [
  { name: 'Harbour Lane Studio', dir: `${home}/harbour-lane-studio`, openedAt: ago(4), description: 'A florist in Lyttelton: bouquets, weddings and a small shop.' },
  { name: 'Tide & Timber', dir: `${home}/tide-and-timber`, openedAt: ago(60 * 26), description: 'Boat builders and joinery, Whanganui.' },
  { name: 'Marlow Dental', dir: `${home}/marlow-dental`, openedAt: ago(60 * 24 * 9) },
  { name: 'Northside Physio', dir: `${home}/clients/northside-physio`, openedAt: ago(60 * 24 * 21) }
];

// The renderer's seam: the list comes from a fixture the script controls; opening a project waits forever.
await app.evaluate(({ ipcMain }) => {
  const c = (globalThis.__capture = { recents: [] });
  const swap = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, fn);
  };
  swap('projects:recents', () => c.recents);
  swap('projects:open', () => new Promise(() => undefined));
});

/** A fresh renderer over the given list, so no state leaks from the capture before it. */
async function fresh(recents, viewport = LAPTOP) {
  await app.evaluate((_, f) => Object.assign(globalThis.__capture, f), { recents });
  await win.setViewportSize(viewport);
  await win.reload();
  await win.waitForSelector(recents.length ? '.welcome-main h2#recents-title' : '.welcome-hero');
  await win.mouse.move(viewport.width - 4, viewport.height - 4);
  await pause(250);
}

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await pause(200);
}

/** Capture a state in each theme: the rail alone (`rail`) or the whole window. `check` must be on screen. */
async function shot(state, check, { themes = BOTH, rail = true } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await pause(150);
    if (!(await win.locator(check).first().isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    const box = rail ? await win.locator('.welcome-side').boundingBox() : { x: 0, y: 0, ...win.viewportSize() };
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } });
    writeFileSync(path, Buffer.from(data, 'base64'));
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

// First run: no projects, the main pane's hero has the primary action.
await fresh([]);
await shot('window-first-run', '.welcome-hero', { rail: false });
await shot('rail-first-run', '.welcome-side .welcome-action.secondary');

// Returning: New project is the rail's one primary action.
await fresh(RECENTS);
await shot('window-recents', '.recent-item.latest', { rail: false });
await shot('rail-recents', '.welcome-side .welcome-action.primary');

// Under the pointer: the primary, then a secondary.
await win.locator('.welcome-side .welcome-action.primary').hover();
await pause(250);
await shot('rail-hover-new', '.welcome-side .welcome-action.primary:hover', { themes: LIGHT });
await win.locator('.welcome-side .welcome-action').nth(1).hover();
await pause(250);
await shot('rail-hover-open', '.welcome-side .welcome-action:nth-child(2):hover', { themes: LIGHT });
await win.mouse.move(LAPTOP.width - 4, LAPTOP.height - 4);

// Keyboard: Open project has focus, reached by Tab so it draws the focus ring.
await win.locator('.welcome-side .welcome-action').nth(0).focus();
await win.keyboard.press('Tab');
await pause(150);
await shot('rail-focus', '.welcome-side .welcome-action:nth-child(2):focus-visible');

// Open project… on its way: its card says so, the rest wait.
await fresh(RECENTS);
await win.locator('.welcome-side .welcome-action').nth(1).click();
await win.waitForSelector('.welcome-side .welcome-action[aria-busy="true"]');
await win.mouse.move(LAPTOP.width - 4, LAPTOP.height - 4);
await pause(250);
await shot('rail-opening', '.welcome-side .welcome-action[aria-busy="true"]');

// The window's smallest size (the narrower rail), and a wide monitor's tall rail.
await fresh(RECENTS, SMALLEST);
await shot('window-smallest', '.welcome-side .welcome-action.primary', { themes: LIGHT, rail: false });
// Windows and Linux spell their keys out: drawn here by giving the hints those labels, at the narrow rail.
await fresh(RECENTS, SMALLEST);
await win.evaluate(() => {
  const words = ['Ctrl+Shift+N', 'Ctrl+O'];
  document.querySelectorAll('.welcome-side .welcome-action .kbd').forEach((k, i) => Object.assign(k, { textContent: words[i] }).setAttribute('data-keys', 'words'));
});
await pause(150);
await shot('rail-word-keys', '.welcome-side .kbd[data-keys="words"]', { themes: LIGHT });
await fresh(RECENTS, WIDE);
await shot('rail-wide', '.welcome-side .welcome-action.primary', { themes: LIGHT });
await fresh([], WIDE);
await shot('rail-wide-first-run', '.welcome-hero', { themes: ['dark'] });

await app.close();
cleanup();

const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const missing = written.filter((p) => !files.includes(p.split('/').pop()));
if (missing.length || errors.length) {
  console.error('missing:', missing, 'renderer errors:', errors);
  process.exit(1);
}
console.log(`welcome rail capture: ${written.length} images in ${OUT}`);
