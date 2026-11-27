// Design capture for creating a project and the dialogs around it: New project (starting point, name, location,
// website tools), setup progress, failures, Trust this project, and unpacking a project ZIP file. Opt-in only,
// never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/new-project.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`. The main process's own IPC handlers are swapped for
// fixtures, so a state that normally lasts a moment (a step of setup, a project opening) holds still with realistic
// names and paths. Every capture checks its state on screen after it settles and throws rather than writing a wrong
// image. Reduced motion is emulated so spinners and dialog entrances cannot blur a frame. Dialog states are cropped
// to the dialog with a margin of the window behind it; `full` states are the whole window.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('new project capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'new-project');
mkdirSync(OUT, { recursive: true });
const { WORK, cleanup } = scratch('design-new-project');
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const FULL = { width: 1440, height: 900 };
const SMALLEST = { width: 1100, height: 700 }; // The window's minimum size.

const { app, win, errors } = await launch(WORK);
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const home = '/Users/alex/Websites';
const RECENTS = [
  { name: 'Harbour Lane Studio', dir: `${home}/harbour-lane-studio`, openedAt: new Date(Date.now() - 4 * 60000).toISOString() },
  { name: 'Tide & Timber', dir: `${home}/tide-and-timber`, openedAt: new Date(Date.now() - 26 * 3600000).toISOString() }
];
const LONG_NAME = 'Kōwhai Garden Supplies & Landscaping Co-operative';
const TRUST = { name: 'Harbour Lane Studio', dir: '/Users/alex/Downloads/harbour-lane-studio', reason: 'new' };
const TRUST_LONG = { name: 'Kōwhai Garden Supplies & Landscaping Co-operative of the Greater Wellington Region', dir: '/Users/alex/Downloads/from-client/2026/final-handover/kowhai-garden-supplies-and-landscaping-co-operative-of-the-greater-wellington-region', reason: 'unpacked' };
// The main process's own messages for these failures (src/main/controller.ts).
const CREATE_ERROR = '/Users/alex/Websites/harbour-lane-studio already exists and is not empty. Choose another name or folder.';
const NO_PERMISSION = 'SiteOrigin Builder does not have permission to write to that folder. Choose a folder in your Documents and try again.';

// The renderer's seam: every channel it reads for this flow answers from a fixture the script controls.
await app.evaluate(({ ipcMain }) => {
  const c = (globalThis.__capture = { recents: [], tools: 'local', open: { ok: false }, create: 'hold', attempt: null });
  const hold = () => new Promise(() => undefined);
  const swap = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, fn);
  };
  swap('projects:recents', () => c.recents);
  swap('projects:removeRecent', () => undefined);
  swap('projects:websiteTools', () => (c.tools === 'hold' ? hold() : c.tools));
  swap('projects:open', () => (c.open === 'hold' ? hold() : c.open));
  swap('projects:create', (_e, opts) => {
    c.attempt = opts.attempt;
    return c.create === 'hold' ? hold() : c.create;
  });
  swap('projects:cancelCreate', () => undefined);
  swap('projects:cancelOpen', () => undefined);
  swap('projects:trustAndOpen', () => hold());
  swap('dialogs:defaultProjectsFolder', () => '/Users/alex/Websites');
});

const send = (channel, payload) =>
  app.evaluate(({ BrowserWindow }, { channel, payload }) => {
    const p = channel === 'create:progress' ? { ...payload, attempt: globalThis.__capture.attempt } : payload;
    BrowserWindow.getAllWindows()[0].webContents.send(channel, p);
  }, { channel, payload });

/** A fresh renderer over the given fixtures, so no state leaks from the capture before it. */
async function fresh(fixture = {}, viewport = FULL) {
  await app.evaluate((_, f) => Object.assign(globalThis.__capture, { recents: [], tools: 'local', open: { ok: false }, create: 'hold', attempt: null }, f), fixture);
  await win.setViewportSize(viewport);
  await win.reload();
  await win.waitForSelector('.welcome');
  await win.mouse.move(viewport.width - 4, viewport.height - 4);
  await pause(150);
}

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await pause(200);
}

/** The dialog and a margin of the window behind it, inside the viewport. */
async function dialogClip(margin = 40) {
  const box = await win.locator('.modal').first().boundingBox();
  const vp = win.viewportSize();
  if (!box) throw new Error('no dialog to crop to');
  const x = Math.max(0, Math.floor(box.x - margin));
  const y = Math.max(0, Math.floor(box.y - margin));
  return { x, y, width: Math.min(vp.width - x, Math.ceil(box.width + margin * 2)), height: Math.min(vp.height - y, Math.ceil(box.height + margin * 2)) };
}

/**
 * Capture a state in each theme; `check` must be visible, and `text` in it, at the moment of capture. Images are
 * cropped to the dialog unless `full`. Previews load asynchronously, so `ready` names what is still loading and must
 * be gone.
 */
async function shot(state, check, { themes = BOTH, text = null, full = false, ready = null } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await pause(120);
    const target = win.locator(check).first();
    if (!(await target.isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    if (text && !(await target.innerText()).includes(text)) throw new Error(`state "${state}" (${theme}) is missing "${text}"; refusing to write`);
    if (ready) await win.locator(ready).first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {
      throw new Error(`state "${state}" (${theme}) still shows "${ready}"; refusing to write`);
    });
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(full ? {} : { clip: await dialogClip() }) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const openNew = async () => {
  await win.locator('.welcome-action', { hasText: 'New project' }).click();
  await win.waitForSelector('.starter-grid');
  await pause(200);
};
const nameIt = (name = 'Harbour Lane Studio') => win.fill('#new-project-name', name);
// The pointer leaves Create once it is pressed, so a returning form never shows it hovered.
const create = async () => {
  await win.getByRole('button', { name: /^Create/ }).click();
  await win.mouse.move(4, 4);
};
const step = async (s, message, detail) => {
  await send('create:progress', { step: s, message, detail });
  await pause(150);
};
// Starter artwork still loading its theme thumbnails.
const ART = '.starter-grid [data-loading]';

// ---- New project ----
await fresh({ recents: RECENTS });
await openNew();
await shot('new-default', '.starter-grid', { full: true, ready: ART });

await nameIt();
await shot('new-filled', '.starter-grid', { ready: ART });

// Blank site chosen from the keyboard, so the radio's focus shows.
await win.locator('.starter-card[aria-checked="true"]').focus();
await win.keyboard.press('ArrowRight');
await pause(150);
await shot('new-blank', '.starter-card[aria-checked="true"]:focus-visible', { themes: LIGHT, text: 'Blank' });

// Each theme the dialog offers, so switching one for another can be judged from the previews and the line about it.
await fresh({ recents: RECENTS });
await openNew();
await nameIt();
for (const id of ['foundation', 'signal', 'editorial']) {
  await win.selectOption('#new-project-theme', id);
  await pause(200);
  await shot(`new-theme-${id}`, `.starter-art[data-theme="${id}"]`, { themes: id === 'signal' ? BOTH : LIGHT, ready: ART });
}

// Shorter windows, where the previews have the least room, down to the window's minimum size.
for (const [label, width, height] of [['short', 1280, 800], ['shorter', 1280, 730], ['minimum', 1100, 700]]) {
  await fresh({ recents: RECENTS }, { width, height });
  await openNew();
  await nameIt();
  await win.selectOption('#new-project-theme', 'signal');
  await pause(200);
  await shot(`new-${label}`, '.starter-art[data-theme="signal"]', { themes: LIGHT, full: true, ready: ART });
  // The previews take the room the window can spare, never more: the ordinary form fits without scrolling.
  const over = await win.locator('.modal-body').evaluate((b) => b.scrollHeight - b.clientHeight);
  if (over > 1) throw new Error(`the form scrolls in a ${width}x${height} window (${over}px over)`);
}

// A long name: the destination folder and everything that repeats the name.
await fresh({ recents: RECENTS });
await openNew();
await nameIt(LONG_NAME);
await shot('new-long-name', '.starter-grid', { themes: LIGHT, ready: ART });

await fresh({ recents: RECENTS, tools: 'download' });
await openNew();
await nameIt();
await shot('new-download', '#new-project-tools-note', { ready: ART });

await fresh({ recents: RECENTS, tools: 'hold' });
await openNew();
await nameIt();
await shot('new-checking', '[data-tools="checking"]', { themes: LIGHT });

await fresh({ recents: RECENTS, create: { ok: false, message: CREATE_ERROR } });
await openNew();
await nameIt();
await create();
await pause(250);
await shot('new-error', '.modal [role="alert"]', { text: 'already exists', ready: ART });
if (await win.getByRole('button', { name: /^Create/ }).isEnabled()) throw new Error('Create is offered again for a folder already found taken');

// A failure about the chosen location: the form comes back with the reason beside the folder.
await fresh({ recents: RECENTS, tools: 'download', create: { ok: false, message: NO_PERMISSION } });
await openNew();
await nameIt();
await create();
await pause(250);
await shot('new-setup-failed', '.modal [role="alert"]', { themes: LIGHT, text: 'permission' });

// Setup canceled: main answers with its own "Cancelled." and the form comes back, which is no failure.
await fresh({ recents: RECENTS, create: { ok: false, message: 'Canceled.' } });
await openNew();
await nameIt();
await create();
await pause(250);
await shot('new-canceled', '#new-project-error', { themes: LIGHT, text: 'canceled' });

// The tallest form in the smallest window: the longest failure message, with setup needing a download.
await fresh({ recents: RECENTS, tools: 'download', create: { ok: false, message: NO_PERMISSION } }, SMALLEST);
await openNew();
await nameIt();
await create();
await pause(250);
await shot('new-smallest', '.modal [role="alert"]', { themes: LIGHT, full: true });
// The failure can be retried, so what happens offline stays in view beside it, and the whole form still fits.
if (!(await win.locator('#new-project-tools-note').isVisible())) throw new Error('the offline guidance went with a retryable failure');
const overflow = await win.locator('.modal-body').evaluate((b) => b.scrollHeight - b.clientHeight);
if (overflow > 1) throw new Error(`the tallest form scrolls in the smallest window (${overflow}px over)`);

// A long name wraps its folder onto a second line, which the previews give back: the form still fits, ordinary or
// with a failure and the offline note.
for (const [label, viewport, fixture] of [
  ['new-long-short', { width: 1280, height: 800 }, {}],
  ['new-long-smallest', SMALLEST, { tools: 'download', create: { ok: false, message: NO_PERMISSION } }]
]) {
  await fresh({ recents: RECENTS, ...fixture }, viewport);
  await openNew();
  await nameIt(LONG_NAME);
  if (fixture.create) {
    await create();
    await pause(250);
  }
  await shot(label, '.starter-grid', { themes: LIGHT, full: true, ready: ART });
  const over = await win.locator('.modal-body').evaluate((b) => b.scrollHeight - b.clientHeight);
  if (over > 1) throw new Error(`${label}: the form scrolls with a wrapped folder (${over}px over)`);
}

// ---- Setup progress ----
await fresh({ recents: RECENTS });
await openNew();
await nameIt();
await create();
await win.waitForSelector('.progress-steps');
await step('files', 'Preparing project files…');
await shot('progress-files', '.progress-steps', { themes: LIGHT, text: 'Preparing' });
// npm's own output follows the line written for people, and must not replace it.
await step('dependencies', 'Setting up website tools…', 'A saved copy of the website tools could not be used, so it is being downloaded again…');
await step('dependencies', 'Setting up website tools…', 'npm warn deprecated inflight@1.0.6: This module is not supported');
await shot('progress-tools', '.progress-steps', { text: 'being downloaded again' });
await win.locator('.modal').getByRole('button', { name: /Cancel/ }).click();
await pause(150);
await shot('progress-cancelling', '.modal', { themes: LIGHT, text: 'Stopping' });

await fresh({ recents: RECENTS });
await openNew();
await nameIt(LONG_NAME);
await create();
await win.waitForSelector('.progress-steps');
await step('dependencies', 'Setting up website tools…');
await step('preview', 'Starting preview…');
await shot('progress-preview', '.progress-steps', { themes: LIGHT, text: 'Starting preview' });

// The website tools could not be downloaded: main opens the project without its preview and says so.
await fresh({ recents: RECENTS, tools: 'download' });
await openNew();
await win.locator('.starter-card', { hasText: 'Blank site' }).click();
await nameIt();
await create();
await win.waitForSelector('.progress-steps');
await step('dependencies', 'Setting up website tools…', 'Installing the tools that build and preview your site.');
await step('preview', 'Opening the project…', 'The website tools could not be downloaded, so the preview waits until you are back online.');
await shot('progress-offline', '.progress-steps', { themes: LIGHT });

// DESIGN_CAPTURE_ONLY=new stops after New project and setup, for reviewing those alone.
if (process.env.DESIGN_CAPTURE_ONLY !== 'new') {
  // ---- Trust this project ----
  await fresh({ recents: RECENTS, open: { ok: false, needsTrust: TRUST } });
  await win.locator('.welcome-action', { hasText: 'Open project' }).click();
  await win.waitForSelector('.trust-path');
  await pause(150);
  await shot('trust', '.trust-path', { text: 'harbour-lane-studio' });
  await win.getByRole('button', { name: 'Trust and open' }).click();
  await pause(150);
  await shot('trust-opening', '.modal', { themes: LIGHT, text: 'Opening' });

  await fresh({ recents: RECENTS, open: { ok: false, needsTrust: TRUST_LONG } });
  await win.locator('.welcome-action', { hasText: 'Open project' }).click();
  await win.waitForSelector('.trust-path');
  await pause(150);
  await shot('trust-long', '.trust-path', { themes: LIGHT, text: 'greater-wellington' });

  // ---- Unpacking a project ZIP file ----
  await fresh({ recents: RECENTS });
  await send('projects:unpacking', { name: 'Harbour Lane Studio', dir: '/Users/alex/Websites', folder: 'harbour-lane-studio', done: 112, total: 486 });
  await win.waitForSelector('.modal .unpack-body');
  await pause(150);
  await shot('unpacking', '.modal', { text: 'Unpacking' });
  await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  await pause(150);
  await shot('unpacking-cancelling', '.modal', { themes: LIGHT, text: 'Canceling' });
  await send('projects:unpacking', null);
}

await app.close();
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`new project capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
