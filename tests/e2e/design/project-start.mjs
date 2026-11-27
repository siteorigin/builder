// Design capture for the project start flow: Welcome with its recent projects, New project, Trust this project,
// and the setup and unpacking progress dialogs. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/project-start.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`. The main process's own IPC handlers are swapped for
// fixtures, so a state that normally lasts a moment (a step of setup, a project opening) holds still with realistic
// names and paths. Every capture checks its state on screen after it settles and throws rather than writing a wrong
// image. Reduced motion is emulated so spinners and dialog entrances cannot blur a frame.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('project start capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'project-start');
mkdirSync(OUT, { recursive: true });
const { WORK, cleanup } = scratch('design-project-start');
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const FULL = { width: 1440, height: 900 };
const SMALLEST = { width: 1100, height: 700 }; // The window's minimum size.

const { app, win, errors } = await launch(WORK);
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const home = '/Users/alex/Websites';
const RECENTS = [
  { name: 'Harbour Lane Studio', dir: `${home}/harbour-lane-studio`, openedAt: ago(4) },
  { name: 'Kōwhai Garden Supplies & Landscaping Co-operative', dir: `${home}/clients/2026/kowhai-garden-supplies-and-landscaping-co-operative`, openedAt: ago(180) },
  { name: 'Tide & Timber', dir: `${home}/tide-and-timber`, openedAt: ago(60 * 26) },
  { name: 'Old brochure site', dir: '/Volumes/Archive/Old Sites/old-brochure-site', openedAt: ago(60 * 24 * 40), missing: true },
  { name: 'Marlow Dental', dir: `${home}/marlow-dental`, openedAt: ago(60 * 24 * 9) },
  { name: 'Northside Physio', dir: `${home}/clients/northside-physio`, openedAt: ago(60 * 24 * 21) },
  { name: 'Ōtaki Beach Cafe', dir: `${home}/otaki-beach-cafe`, openedAt: ago(60 * 24 * 64) }
];
const DENSE = Array.from({ length: 20 }, (_, i) => {
  const base = RECENTS[i % RECENTS.length];
  return { ...base, name: i < RECENTS.length ? base.name : `${base.name} ${i + 1}`, dir: `${base.dir}-${i + 1}`, openedAt: ago(30 + i * i * 90) };
});
// Two copies of one project side by side: only their folder names tell them apart.
DENSE[18] = { ...DENSE[18], name: 'Marlow Dental', dir: `${home}/marlow-dental` };
DENSE[19] = { ...DENSE[18], dir: `${home}/marlow-dental-copy` };
const TRUST = { name: 'Harbour Lane Studio', dir: '/Users/alex/Downloads/harbour-lane-studio', reason: 'new' };
const TRUST_LONG = { name: 'Kōwhai Garden Supplies & Landscaping Co-operative of the Greater Wellington Region', dir: '/Users/alex/Downloads/from-client/2026/final-handover/kowhai-garden-supplies-and-landscaping-co-operative-of-the-greater-wellington-region', reason: 'unpacked' };
const CREATE_ERROR = 'Could not create the project: a folder called harbour-lane-studio already exists in ~/Websites. Choose another name or location.';

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
  swap('projects:pinRecent', (_e, dir, pinned) => {
    c.recents = c.recents.map((r) => (r.dir === dir ? { ...r, pinned } : r));
  });
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
  await win.waitForSelector('.welcome-main h2');
  await win.mouse.move(viewport.width - 4, viewport.height - 4);
  await pause(150);
}

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await pause(200);
}

/** Capture a state in each theme; `check` must be visible, and `text` on screen, at the moment of capture. */
async function shot(state, check, themes = BOTH, text = null) {
  for (const theme of themes) {
    await setTheme(theme);
    await pause(120);
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

const openNew = async () => {
  await win.locator('.welcome-action', { hasText: 'New project' }).click();
  await win.waitForSelector('.starter-grid');
  await pause(120);
};
const nameIt = (name = 'Harbour Lane Studio') => win.fill('input[placeholder^="For example"]', name);
const create = () => win.getByRole('button', { name: 'Create project' }).click();
const step = async (s, message, detail) => {
  await send('create:progress', { step: s, message, detail });
  await pause(150);
};

// ---- Welcome ----
await fresh();
await shot('welcome-first-run', '.empty-state');

await fresh({}, SMALLEST);
await shot('welcome-first-run-smallest', '.empty-state', LIGHT, 'New project');

await fresh({ recents: RECENTS });
await shot('welcome-recents', '.recent-grid', BOTH, 'Harbour Lane Studio');

await fresh({ recents: DENSE });
await shot('welcome-dense', '.recent-grid', LIGHT);

// A long list can be filtered by name or folder; the twins both match.
await win.locator('.recent-filter input').fill('marlow');
await pause(150);
await shot('welcome-filter', '.recent-grid', LIGHT, 'marlow-dental-copy');
await win.locator('.recent-filter input').fill('bakery');
await pause(150);
await shot('welcome-filter-none', '.recent-none', LIGHT, 'Clear filter');

// Recurring clients pinned above the rest (#259), one of them missing; the newest project still leads the rest.
await fresh({ recents: [...DENSE.slice(0, 18), { ...RECENTS[5], pinned: true }, { ...RECENTS[3], pinned: true }] });
await shot('welcome-pinned', '.recent-group', BOTH, 'Pinned');

await fresh({ recents: RECENTS }, SMALLEST);
await shot('welcome-smallest', '.recent-grid', LIGHT);

// Keyboard: Tab from the first card reaches its Remove button, its Pin button, then the second card.
await fresh({ recents: RECENTS });
await win.locator('.recent-card').first().focus();
await win.keyboard.press('Tab');
await win.keyboard.press('Tab');
await win.keyboard.press('Tab');
await shot('welcome-focus', '.recent-card:focus-visible', LIGHT);

// A project on its way: the card says so and everything else waits.
await fresh({ recents: RECENTS, open: 'hold' });
await win.locator('.recent-card', { hasText: 'Tide & Timber' }).click();
await pause(150);
await shot('welcome-opening', '.recent-card:has(.spinner)', LIGHT, 'Opening');

// A project whose folder has gone: its card says so and offers to find it.
await fresh({ recents: RECENTS });
await win.locator('.recent-card', { hasText: 'Old brochure site' }).hover();
await pause(200);
await shot('welcome-missing', '.recent-status', LIGHT, 'Find folder');

// Finding it: the picker has been answered and the project is on its way.
await fresh({ recents: RECENTS, open: 'hold' });
await win.locator('.recent-card', { hasText: 'Old brochure site' }).click();
await pause(150);
await shot('welcome-finding', '.recent-card:has(.spinner)', LIGHT, 'Finding folder');

// ---- New project ----
await fresh({ recents: RECENTS });
await openNew();
await shot('new-default', '.starter-grid');

await nameIt();
await shot('new-filled', '.starter-grid', LIGHT);

// Blank site chosen from the keyboard, so the radio's focus shows.
await win.locator('.starter-card[aria-checked="true"]').focus();
await win.keyboard.press('ArrowRight');
await pause(150);
await shot('new-blank', '.starter-card[aria-checked="true"]:focus-visible', LIGHT, 'Blank site');

await fresh({ recents: RECENTS, tools: 'download' });
await openNew();
await nameIt();
await shot('new-download', '#new-project-tools-note');

await fresh({ recents: RECENTS, tools: 'hold' });
await openNew();
await nameIt();
await shot('new-checking', '[data-tools="checking"]', LIGHT);

await fresh({ recents: RECENTS, create: { ok: false, message: CREATE_ERROR } });
await openNew();
await nameIt();
await create();
await pause(200);
await shot('new-error', '.modal [role="alert"]', LIGHT, 'already exists');

// The tallest form in the smallest window: the download note and an error together.
await fresh({ recents: RECENTS, tools: 'download', create: { ok: false, message: CREATE_ERROR } }, SMALLEST);
await openNew();
await nameIt();
await create();
await pause(250);
await shot('new-smallest', '.modal [role="alert"]', LIGHT);

// ---- Setup progress ----
await fresh({ recents: RECENTS });
await openNew();
await nameIt();
await create();
await win.waitForSelector('.progress-steps');
await step('files', 'Preparing project files…');
await shot('progress-files', '.progress-steps', LIGHT, 'Preparing files');
// npm's own output follows the line written for people, and must not replace it.
await step('dependencies', 'Setting up website tools…', 'A saved copy of the website tools could not be used, so it is being downloaded again…');
await step('dependencies', 'Setting up website tools…', 'npm warn deprecated inflight@1.0.6: This module is not supported');
await shot('progress-tools', '.progress-steps', BOTH, 'being downloaded again');
await step('preview', 'Starting preview…');
await shot('progress-preview', '.progress-steps', LIGHT, 'Starting preview');

// ---- Trust this project ----
await fresh({ recents: RECENTS, open: { ok: false, needsTrust: TRUST } });
await win.locator('.welcome-action', { hasText: 'Open project' }).click();
await win.waitForSelector('.trust-path');
await pause(150);
await shot('trust', '.trust-path', BOTH, 'harbour-lane-studio');
await win.getByRole('button', { name: 'Trust and open' }).click();
await pause(150);
await shot('trust-opening', '.modal', LIGHT, 'Opening');

await fresh({ recents: RECENTS, open: { ok: false, needsTrust: TRUST_LONG } });
await win.locator('.welcome-action', { hasText: 'Open project' }).click();
await win.waitForSelector('.trust-path');
await pause(150);
await shot('trust-long', '.trust-path', LIGHT, 'greater-wellington');

// ---- Unpacking a project ZIP file ----
await fresh({ recents: RECENTS });
await send('projects:unpacking', { name: 'Harbour Lane Studio', dir: '/Users/alex/Websites', folder: 'harbour-lane-studio', done: 112, total: 486 });
await win.waitForSelector('.modal .unpack-body');
await pause(150);
await shot('unpacking', '.modal', BOTH, 'Unpacking');
await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
await pause(150);
await shot('unpacking-cancelling', '.modal', LIGHT, 'Canceling');
await send('projects:unpacking', null);

await app.close();
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`project start capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
