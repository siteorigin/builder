// Design capture for opening a recent project from Welcome: the frame after the click, the wait while the project
// opens, the editor's first page while the preview starts and the page loads, the page, and a filmstrip of the whole
// open at real speed. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/project-open.mjs
//
// Drives the real (built) app on a real project. The open is held at the main process's own handler, and the page's
// requests at the preview's origin, so each stage holds still; the filmstrip then opens the project again with nothing
// held. Every still checks its state on screen and throws rather than writing a wrong image; the filmstrip says how
// many frames it took and over how long.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createProject, launch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('project open capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-open-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const FULL = { width: 1440, height: 900 };
const SMALLEST = { width: 1100, height: 700 };
const NAME = 'Harbour Lane Studio';

const { app, win, errors } = await launch(WORK);
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

async function setTheme(theme, motion = 'reduce') {
  await win.emulateMedia({ colorScheme: theme, reducedMotion: motion });
  await pause(200);
}

/** Capture a state in each theme; `check` must be visible, and `text` in it, at the moment of capture. */
async function shot(state, check, themes = BOTH, text = null) {
  for (const theme of themes) {
    await setTheme(theme);
    const target = win.locator(check).first();
    if (!(await target.isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    if (text && !(await target.innerText()).includes(text)) throw new Error(`state "${state}" (${theme}) is missing "${text}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

// A real project, made and closed again, so Welcome lists it.
await createProject(win, { name: NAME, parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
await pause(1000);
await win.evaluate(() => window.builder.projects.close());
await win.locator('.recent-card', { hasText: NAME }).waitFor({ timeout: 30000 });
const origin = () => win.locator('.frame-box iframe').first().getAttribute('src').then((s) => new URL(s).origin);

/** Hold the main process's open until released: the real handler runs when it is. */
const holdOpen = () =>
  app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const real = globalThis.__realOpen ?? handlers.get('projects:open');
    globalThis.__realOpen = real;
    let release;
    globalThis.__openGate = new Promise((r) => (release = r));
    globalThis.__releaseOpen = release;
    ipcMain.removeHandler('projects:open');
    ipcMain.handle('projects:open', async (...args) => {
      await globalThis.__openGate;
      return real(...args);
    });
  });
const releaseOpen = () => app.evaluate(() => globalThis.__releaseOpen());

/** Every page the preview serves waits until released, so the frame stays loading. */
let releasePage = () => undefined;
const PREVIEW = /^https?:\/\/(127\.0\.0\.1|localhost|[^/]+\.localhost):\d+\//;
const holdPages = async () => {
  const gate = new Promise((r) => (releasePage = r));
  await app.context().route(PREVIEW, async (route) => {
    await gate;
    await route.continue().catch(() => undefined);
  });
};

// ---- Welcome, before the click ----
await win.setViewportSize(FULL);
await setTheme('light');
await win.mouse.move(FULL.width - 4, FULL.height - 4);
await shot('welcome', '.recent-card', LIGHT, NAME);

// ---- The frame after the click, while the project opens ----
await holdOpen();
await holdPages();
await win.locator('.recent-card', { hasText: NAME }).click();
await pause(150);
await win.mouse.move(FULL.width - 4, FULL.height - 4);
await shot('opening', '.editor-skeleton, .welcome:not([hidden])');
// The same wait once it has run long enough to show its one loading sign.
await pause(1200);
await shot('opening-wait', '.editor-skeleton, .welcome:not([hidden])');
await win.setViewportSize(SMALLEST);
await pause(200);
await shot('opening-smallest', '.editor-skeleton, .welcome:not([hidden])', LIGHT);
await win.setViewportSize(FULL);
await pause(200);

// ---- The editor's first page: the preview starting, then the page loading ----
await releaseOpen();
await win.locator('main.canvas').waitFor({ timeout: 60000 });
await win.locator('.frame-box iframe').first().waitFor({ state: 'attached', timeout: 90000 });
const url = await origin();
await win.mouse.move(FULL.width - 4, FULL.height - 4);
await pause(600);
await shot('first-page-loading', 'main.canvas[data-frame="loading"]');
// The preview's start, as the canvas shows it (the real one has passed by now): said through the app's own broadcast.
const status = (s) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('runtime:status', s), s);
await status({ state: 'starting' });
await pause(400);
await shot('first-page-starting', 'main.canvas');
await status({ state: 'ready', url });
await win.locator('.frame-box iframe').first().waitFor({ state: 'attached', timeout: 30000 });
await pause(300);

// ---- The page ----
releasePage();
await app.context().unroute(PREVIEW);
await win.locator('main.canvas[data-frame="ready"]').waitFor({ timeout: 90000 });
await pause(1200);
await shot('page-ready', 'main.canvas[data-frame="ready"]');

// ---- The whole open at real speed, frame by frame ----
await win.evaluate(() => window.builder.projects.close());
await win.locator('.recent-card', { hasText: NAME }).waitFor({ timeout: 30000 });
await app.evaluate(({ ipcMain }) => {
  ipcMain.removeHandler('projects:open');
  ipcMain.handle('projects:open', globalThis.__realOpen);
});
await setTheme('light', 'no-preference');
await win.mouse.move(FULL.width - 4, FULL.height - 4);
await pause(500);
const frames = join(OUT, 'strip-frames');
mkdirSync(frames, { recursive: true });
const t0 = Date.now();
await win.locator('.recent-card', { hasText: NAME }).click();
const taken = [];
let readyAt = null;
while (Date.now() - t0 < 12000) {
  const t = Date.now() - t0;
  const path = join(frames, `f${String(taken.length).padStart(3, '0')}.png`);
  await win.screenshot({ path });
  taken.push({ t, path });
  if (readyAt === null && (await win.locator('main.canvas[data-frame="ready"]').count())) readyAt = Date.now() - t0;
  if (readyAt !== null && Date.now() - t0 > readyAt + 600) break;
}
if (readyAt === null) throw new Error(`the page never came up during the filmstrip (${taken.length} frames over ${Date.now() - t0} ms); refusing to write`);
// Twelve frames, evenly spaced in time from the click to just after the page was ready, each labelled with its time.
const end = taken[taken.length - 1].t;
const picks = Array.from({ length: 12 }, (_, i) => taken.reduce((best, f) => (Math.abs(f.t - (end * i) / 11) < Math.abs(best.t - (end * i) / 11) ? f : best)));
const labelled = picks.map((f, i) => {
  const to = join(frames, `t${String(f.t).padStart(5, '0')}ms-${i}.png`);
  execFileSync('cp', [f.path, to]);
  return to;
});
const sheet = join(OUT, 'open-filmstrip--light.png');
execFileSync('bash', [join(homedir(), '.claude/skills/design-review/scripts/filmstrip.sh'), 'sheet', sheet, '4', ...labelled]);
written.push(sheet);
console.log(`wrote ${sheet}: ${taken.length} frames over ${end} ms, page ready at ${readyAt} ms`);

await app.close();
const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`project open capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
