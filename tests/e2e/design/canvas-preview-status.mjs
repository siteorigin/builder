// Design capture for what the canvas shows when the preview is not simply running: the cards for setting up,
// starting (and starting for a while), paused, unavailable and stopped (with and without developer mode), the page
// problem bar (while editing, at a narrow width, in Preview, and restarting), and a layout with no entries to show it
// on. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/canvas-preview-status.mjs
//
// The preview's own states are pushed through the app's runtime status broadcast, and the page's problems are
// reported exactly as the preview's bridge reports them, from inside the real frame. Each capture is verified on
// screen after it settles; a state that did not render throws instead of writing a plausible-looking wrong image.
// Files are named `{state}--{theme}.png`.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createProject, launch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('canvas preview status capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-status-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const { app, win, errors } = await launch(WORK);
const written = [];
const pause = (ms) => win.waitForTimeout(ms);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system', developerMode: false }));

/**
 * Capture a state. `check` is a selector (or a function returning true) that must hold at the moment of capture.
 * `area` is 'canvas' (the canvas alone) or 'foot' (the lower part of the canvas, where the bars sit, kept legible).
 */
async function shot(state, check, { themes = BOTH, area = 'canvas' } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(300);
    await win.mouse.move(2, 450);
    await pause(250);
    const ok = typeof check === 'function' ? await check() : await win.locator(check).first().isVisible().catch(() => false);
    if (!ok) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const box = await win.locator('.canvas').boundingBox();
    const height = area === 'foot' ? Math.min(box.height, 360) : box.height;
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: box.x, y: box.y + box.height - height, width: box.width, height } });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}

const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
await pause(1500);
const issue = win.locator('.ai-veil.issue');

/** The page in the preview frame, as it is now (Try again replaces it). */
async function page() {
  const content = await (await win.locator('.frame-box iframe').elementHandle()).contentFrame();
  if (!content) throw new Error('the preview frame has no page');
  return content;
}
/** Report something to the editor from the preview page, exactly as its bridge does. */
async function bridge(type, payload) {
  await (await page()).evaluate(([t, p]) => {
    const navigationId = document.documentElement.dataset.soNavigation;
    window.parent.postMessage({ protocolVersion: 1, sessionId: window.name, navigationId, revision: p.revision ?? 0, type: t, payload: p }, '*');
  }, [type, payload]);
}
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());

// ---- A page problem while editing, after an edit, naming a generated component: Revert, Try again, Open source, Details ----
const s0 = await snapshot();
const home = s0.state.pages[s0.state.site.homePageId];
const heroNode = home.nodes[home.rootIds[0]];
const heroDef = s0.state.components[heroNode.definitionId];
const defKey = heroDef.id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
const [[prop]] = Object.entries(heroNode.props).filter(([, v]) => typeof v === 'string' && v.trim());
// Long enough for the page to count as working, so the edit after it is what the problem is put down to.
await pause(2200);
const edit = await win.evaluate(
  ([pageId, nodeId, prop]) => window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId, prop, value: 'Harbour Lane, rebuilt' }] }, { label: 'Edit hero heading' }),
  [home.id, heroNode.id, prop]
);
if (!edit.ok) throw new Error(`the edit was refused: ${edit.error?.message}`);
await bridge('runtimeError', { message: 'Cannot read properties of undefined (reading "title")', file: `http://127.0.0.1:5173/src/lib/siteorigin/generated/${defKey}.svelte?t=1`, revision: edit.revision });
await issue.getByRole('button', { name: /^Revert/ }).waitFor({ timeout: 10000 });
await issue.getByRole('button', { name: 'Open source' }).waitFor({ timeout: 10000 });
await pause(500);
await shot('problem-edit', '.ai-veil.issue');

// The same bar on a narrow canvas: the window at a small laptop's width with both side panels open.
await win.setViewportSize({ width: 1024, height: 760 });
await pause(800);
await shot('problem-edit-narrow', '.ai-veil.issue', { themes: LIGHT });
await win.setViewportSize({ width: 1440, height: 900 });
await pause(800);

// Reloading: Try again, held while the page's requests wait.
const origin = new URL(await win.locator('.frame-box iframe').getAttribute('src')).origin;
let release;
const gate = new Promise((resolve) => (release = resolve));
const hold = async (route) => {
  await gate;
  await route.continue().catch(() => undefined);
};
await app.context().route(`${origin}/**`, hold);
await issue.getByRole('button', { name: 'Try again' }).click();
await pause(300);
await shot('problem-restarting', '.ai-veil.issue.retrying', { themes: LIGHT, area: 'foot' });
release();
await app.context().unroute(`${origin}/**`, hold);
await issue.waitFor({ state: 'detached', timeout: 60000 });
await pause(1500);

// In Preview: the bar sits above the preview pill.
await win.locator('button[title^="Preview:"]').click();
await win.locator('.preview-pill').waitFor({ timeout: 8000 });
await pause(1500);
await bridge('runtimeError', { message: 'Cannot read properties of undefined (reading "title")' });
await issue.getByRole('button', { name: 'Try again' }).waitFor({ timeout: 10000 });
await pause(400);
await shot('problem-preview', '.ai-veil.issue', { themes: BOTH, area: 'foot' });
await win.locator('.preview-pill button', { hasText: 'Back to editing' }).click();
await pause(400);
await bridge('revisionApplied', {}).catch(() => undefined);
await issue.waitFor({ state: 'detached', timeout: 30000 }).catch(() => undefined);
if (await issue.isVisible().catch(() => false)) {
  await issue.getByRole('button', { name: 'Try again' }).click();
  await issue.waitFor({ state: 'detached', timeout: 60000 });
}
await pause(1000);

// ---- A layout with no entries to show it on ----
const made = await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'collection.create', collectionId: 'events', name: 'Events', singularName: 'Event' }] }, { label: 'Add Events' }));
if (!made.ok) throw new Error(`the collection was refused: ${made.error?.message}`);
await pause(600);
await win.locator('[data-testid="edit-layout-events"]').click().catch(async () => {
  // The Pages panel lists the layouts; open it first when another panel is showing.
  await win.getByRole('tab', { name: /Pages/ }).first().click();
  await win.locator('[data-testid="edit-layout-events"]').click();
});
await win.locator('[data-testid="template-no-entries"]').waitFor({ timeout: 10000 });
await pause(800);
await shot('layout-no-entries', '[data-testid="template-no-entries"]');
// Its first entry, added from the card: the layout is then shown on it.
await win.locator('[data-testid="template-no-entries"] button', { hasText: 'Add an event' }).click();
await win.locator('[data-testid="template-no-entries"]').waitFor({ state: 'detached', timeout: 15000 });
await win.locator('[data-testid="template-sample"]').waitFor({ timeout: 15000 });
await frame.locator('h1').first().waitFor({ timeout: 30000 });
await pause(1200);
await shot('layout-first-entry', '[data-testid="template-sample"]', { themes: LIGHT });
// The same strip on a narrow canvas: the entry picker and Done keep their room ahead of the width readout.
await win.setViewportSize({ width: 1024, height: 760 });
await pause(800);
await shot('layout-first-entry-narrow', '[data-testid="template-strip"] button', { themes: LIGHT });
await win.setViewportSize({ width: 1440, height: 900 });
await pause(800);
await win.locator('[data-testid="template-strip"] button', { hasText: 'Done' }).click();
await pause(800);

// ---- The preview's own states, pushed through the app's runtime status broadcast ----
const status = (s) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('runtime:status', s), s);
await status({ state: 'preparing', message: 'Installing the website tools. The first run takes about a minute.' });
await win.locator('.canvas-state .starting-mark').waitFor({ timeout: 8000 });
await pause(300);
await shot('status-preparing', '.canvas-state .starting-mark');
// Setting up for longer than its first run usually takes.
await pause(90500);
await shot('status-preparing-long', '.canvas-state .starting-mark', { themes: LIGHT });
await status({ state: 'starting' });
await pause(300);
await shot('status-starting', '.canvas-state .starting-mark');
// Starting for longer than it usually takes.
await pause(21000);
await shot('status-starting-long', '.canvas-state .starting-mark', { themes: LIGHT });
const detail = [
  'Error: listen EADDRINUSE: address already in use 127.0.0.1:5174',
  '    at Server.setupListenHandle [as _listen2] (node:net:1908:16)',
  '    at listenInCluster (node:net:1965:12)',
  '    at doListen (node:net:2139:7)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:83:21)'
].join('\n');
await status({ state: 'error', message: 'The preview server failed to start.', detail });
await pause(300);
await shot('status-error', '.canvas-state .status-card');
// Developer mode, switched in Settings as a person would, so the editor's own copy of the setting changes.
const developerMode = async (on) => {
  await win.locator('[aria-label="Settings"]').click();
  const sw = win.getByRole('switch', { name: 'Developer mode' });
  await sw.waitFor({ timeout: 8000 });
  if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
  await win.keyboard.press('Escape');
  await win.locator('.modal').waitFor({ state: 'detached', timeout: 8000 });
  await pause(400);
};
// With the technical details open, as a developer reading them would have them.
await developerMode(true);
await win.locator('.canvas-state details summary').click();
await pause(300);
await shot('status-error-dev', '.canvas-state details[open] pre');
await developerMode(false);
// Copying the details when the clipboard refuses: the card says so and puts the report where it can be selected.
await win.evaluate(() => {
  navigator.clipboard.writeText = () => Promise.reject(new Error('Capture: the clipboard refused'));
});
await win.locator('.canvas-state .status-card button', { hasText: 'Copy details' }).click();
await win.locator('.canvas-state .status-card-report').waitFor({ timeout: 8000 });
await pause(300);
await shot('status-error-copy-failed', '.canvas-state .status-card-report', { themes: LIGHT });
// The same card on a narrow canvas: the window at a small laptop's width with both side panels open.
await win.setViewportSize({ width: 1024, height: 760 });
await pause(800);
await shot('status-error-narrow', '.canvas-state .status-card', { themes: LIGHT });
// A short window: the card's body scrolls and its footer, with the way back, stays in view.
await win.setViewportSize({ width: 1024, height: 560 });
await pause(800);
await shot('status-error-short', async () => {
  const foot = await win.locator('.canvas-state .status-card-foot').boundingBox();
  const canvas = await win.locator('.canvas').boundingBox();
  return !!foot && !!canvas && foot.y + foot.height <= canvas.y + canvas.height;
}, { themes: LIGHT });
await win.setViewportSize({ width: 1440, height: 900 });
await pause(800);
await status({ state: 'error', message: 'The website tools could not be downloaded. Check your internet connection and try again. A connection is only needed once.', detail: 'npm ERR! code ENOTFOUND\nnpm ERR! network request to https://registry.npmjs.org/vite failed' });
await pause(600);
await shot('status-error-network', '.canvas-state .status-card', { themes: LIGHT });
await status({ state: 'idle' });
await pause(300);
await shot('status-paused', '.canvas-state .status-card');
await status({ state: 'unavailable', message: 'This project was made with a newer version of SiteOrigin Builder, which is needed to show its preview. Update the app to see and edit the site.' });
await pause(300);
await shot('status-unavailable', '.canvas-state .status-card');

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`canvas preview status capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
