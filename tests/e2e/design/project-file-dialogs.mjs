// Design capture for the smaller project dialogs beside New project: Trust this project (over Welcome and over the
// open project), Duplicate project (its form, its problems, copying and the copy made) and Unpacking a project ZIP
// file (running, a long wait, being called off, and the notice a failure leaves). Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/project-file-dialogs.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`. The main process's own IPC handlers for these flows
// are swapped for fixtures, so a state that normally lasts a moment (a copy being made, a ZIP file unpacking, a
// project opening) holds still with realistic names, paths and the main process's own messages. Duplicate needs an
// open project, so a blank one is made for real first. Every capture checks its state on screen after it settles and
// throws rather than writing a wrong image. Reduced motion is emulated so spinners and dialog entrances cannot blur a
// frame. Dialog states are cropped to the dialog with a margin of the window behind it; `full` states are the window.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('project file dialogs capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'project-file-dialogs');
mkdirSync(OUT, { recursive: true });
const { WORK, cleanup } = scratch('design-project-file-dialogs');
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
const TRUST = { name: 'Harbour Lane Studio', dir: '/Users/alex/Downloads/harbour-lane-studio', reason: 'new' };
const TRUST_LONG = { name: 'Kōwhai Garden Supplies & Landscaping Co-operative of the Greater Wellington Region', dir: '/Users/alex/Downloads/from-client/2026/final-handover/kowhai-garden-supplies-and-landscaping-co-operative-of-the-greater-wellington-region', reason: 'unpacked' };
// As main sends it (controller.ts openZipNow): the folder chosen, the new folder's name, and the files written so far.
const UNPACK = { name: 'Harbour Lane Studio', dir: home, folder: 'harbour-lane-studio', done: 0, total: 486 };
const UNPACK_LONG = { name: 'Kōwhai Garden Supplies & Landscaping Co-operative of the Greater Wellington Region', dir: '/Users/alex/Documents/Client work/2026', folder: 'kowhai-garden-supplies-landscaping-co-operative-of-the-greater-wellington-region', done: 1204, total: 3318 };
// The main process's own messages for these outcomes (src/main/controller.ts).
const TRUST_FAILED = `SiteOrigin Builder does not have permission to open the files in ${TRUST.dir}. Move the project folder somewhere you own, such as your Documents folder, then open it again.`;
const UNPACK_FAILED = `There is not enough space to unpack Harbour Lane Studio in ${home}. Free up some space, or open the ZIP file again and choose a folder on another drive.`;
const taken = (slug) => `A folder named “${slug}” is already there. Choose another name or folder.`;
const NO_PERMISSION = '/Volumes/Archive/Sites';
const DISK_FULL = 'Your disk is full. Free up some space and try again.';

// The renderer's seam: every channel these dialogs read answers from a fixture the script controls.
await app.evaluate(({ ipcMain }) => {
  const c = (globalThis.__capture = { recents: [], open: { ok: false }, trust: 'hold', duplicate: 'hold', folder: null, pending: null });
  const hold = () => new Promise(() => undefined);
  const swap = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, fn);
  };
  swap('projects:recents', () => c.recents);
  swap('projects:removeRecent', () => undefined);
  swap('projects:open', () => {
    if (c.open === 'hold') return hold();
    // Held until the script settles it, as an unpacking ZIP file is.
    if (c.open === 'pending') return new Promise((resolve) => (c.pending = resolve));
    return c.open;
  });
  swap('projects:cancelOpen', () => undefined);
  swap('projects:trustAndOpen', () => (c.trust === 'hold' ? hold() : c.trust));
  swap('projects:duplicate', () => (c.duplicate === 'hold' ? hold() : c.duplicate));
  swap('dialogs:chooseFolder', () => c.folder);
});
const fixture = (f) => app.evaluate((_, f) => Object.assign(globalThis.__capture, f), f);
const settleOpen = (r) => app.evaluate((_, r) => globalThis.__capture.pending?.(r), r);

const send = (channel, payload) =>
  app.evaluate(({ BrowserWindow }, { channel, payload }) => BrowserWindow.getAllWindows()[0].webContents.send(channel, payload), { channel, payload });

/** A fresh Welcome over the given fixtures, so no state leaks from the capture before it. */
async function fresh(f = {}, viewport = FULL) {
  await fixture({ recents: RECENTS, open: { ok: false }, trust: 'hold', duplicate: 'hold', folder: null, pending: null, ...f });
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

/** Capture a state in each theme; `check` must be visible, and `text` in it, at the moment of capture. */
async function shot(state, check, { themes = BOTH, text = null, full = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await pause(120);
    const target = win.locator(check).first();
    if (!(await target.isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    if (text && !(await target.innerText()).includes(text)) throw new Error(`state "${state}" (${theme}) is missing "${text}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(full ? {} : { clip: await dialogClip() }) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const openProject = async () => {
  await win.locator('.welcome-action', { hasText: 'Open project' }).click();
};

// ---- Trust this project, over Welcome ----
await fresh({ open: { ok: false, needsTrust: TRUST } });
await openProject();
await win.waitForSelector('.trust-path');
await pause(150);
// Opened from the keyboard's point of view: focus starts on the safe choice.
await shot('trust', '.modal', { text: 'harbour-lane-studio' });
await win.keyboard.press('Tab');
await pause(100);
await shot('trust-tab', '.modal-foot .btn-primary:focus', { themes: LIGHT });
await win.getByRole('button', { name: 'Trust and open' }).click();
await win.mouse.move(4, 4);
await pause(150);
await shot('trust-opening', '.modal', { text: 'Opening' });

// Trusted here before, with setup files it no longer has.
await fresh({ open: { ok: false, needsTrust: { ...TRUST_LONG, reason: 'changed' } } });
await openProject();
await win.waitForSelector('.trust-path');
await pause(150);
await shot('trust-long', '.modal', { themes: LIGHT, text: 'greater-wellington' });

await fresh({ open: { ok: false, needsTrust: TRUST_LONG } }, SMALLEST);
await openProject();
await win.waitForSelector('.trust-path');
await pause(150);
await shot('trust-minimum', '.modal', { themes: LIGHT, full: true });

// Trusting it, then the project failing to open: the dialog goes and a notice says why.
await fresh({ open: { ok: false, needsTrust: TRUST }, trust: { ok: false, message: TRUST_FAILED } });
await openProject();
await win.waitForSelector('.trust-path');
await win.getByRole('button', { name: 'Trust and open' }).click();
await win.mouse.move(4, 4);
await win.waitForSelector('.toast.error');
await pause(250);
await shot('trust-failed', '.toast.error', { themes: LIGHT, full: true, text: 'permission' });

// ---- Unpacking a project ZIP file ----
await fresh({ open: 'pending' });
await openProject();
await send('projects:unpacking', UNPACK);
await win.waitForSelector('.unpack-body');
await send('projects:unpacking', { ...UNPACK, done: 137 });
await pause(150);
await shot('unpacking', '.modal', { text: 'Unpacking' });
// A long wait counts its time.
await pause(5600);
await send('projects:unpacking', { ...UNPACK, done: 352 });
await pause(150);
await shot('unpacking-elapsed', '.unpack-count .elapsed', { themes: LIGHT });
await win.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
await win.mouse.move(4, 4);
await pause(150);
await shot('unpacking-cancelling', '.modal', { themes: LIGHT, text: 'Canceling' });
await send('projects:unpacking', null);
await settleOpen({ ok: false });

await fresh({ open: 'pending' });
await openProject();
await send('projects:unpacking', UNPACK_LONG);
await win.waitForSelector('.unpack-body');
await pause(150);
await shot('unpacking-long', '.modal', { themes: LIGHT, text: 'Kōwhai' });
await send('projects:unpacking', null);
await settleOpen({ ok: false });

await fresh({ open: 'pending' }, SMALLEST);
await openProject();
await send('projects:unpacking', UNPACK);
await win.waitForSelector('.unpack-body');
await pause(150);
await shot('unpacking-minimum', '.modal', { themes: LIGHT, full: true });
// Unpacking fails: the dialog goes and a notice says why.
await send('projects:unpacking', null);
await settleOpen({ ok: false, message: UNPACK_FAILED });
await win.waitForSelector('.toast.error');
await pause(250);
await shot('unpacking-failed', '.toast.error', { themes: LIGHT, full: true, text: 'not enough space' });

// ---- Duplicate project, over a real open project ----
await win.setViewportSize(FULL);
await win.reload();
await win.waitForSelector('.welcome');
const sites = join(WORK, 'sites');
mkdirSync(sites, { recursive: true });
await createProject(win, { name: 'Storefront', parentDir: sites, starter: 'blank', sampleImages: false });
await win.mouse.move(FULL.width - 4, FULL.height - 4);

const openDuplicate = async (viewport = FULL) => {
  await win.setViewportSize(viewport);
  await win.locator('.toolbar .project-title').click();
  await win.getByRole('menuitem', { name: 'Duplicate project…' }).click();
  await win.waitForSelector('#duplicate-name');
  await win.mouse.move(viewport.width - 4, viewport.height - 4);
  await pause(200);
};
const closeDialog = async () => {
  await win.keyboard.press('Escape');
  await win.locator('.modal').waitFor({ state: 'detached' });
  await pause(100);
};
const duplicateButton = () => win.locator('.modal-foot').getByRole('button', { name: 'Duplicate', exact: true });
const press = async () => {
  await duplicateButton().click();
  await win.mouse.move(4, 4);
  await pause(200);
};
// Submitted from the keyboard (Enter in the name), so the focus ring shows where focus goes next.
const enter = async () => {
  await win.focus('#duplicate-name');
  await win.keyboard.press('Enter');
  await pause(200);
};

await fixture({ duplicate: 'hold' });
await openDuplicate();
await shot('dup', '#duplicate-path', { text: 'storefront-copy' });
await win.fill('#duplicate-name', 'Fall Campaign');
await pause(100);
await shot('dup-typed', '#duplicate-path', { themes: LIGHT, text: 'fall-campaign' });
await win.fill('#duplicate-name', '');
await pause(100);
await shot('dup-empty', '.modal', { themes: LIGHT });
if (await duplicateButton().isEnabled()) throw new Error('Duplicate is offered with no name');
await win.fill('#duplicate-name', 'Storefront — Fall 2026 seasonal campaign with the new product range');
await pause(100);
await shot('dup-long', '.modal', { themes: LIGHT });
await win.fill('#duplicate-name', 'Fall Campaign');
await press();
await shot('dup-copying', '.modal', { text: 'Copying' });
await closeDialog().catch(async () => {
  // Busy: the dialog cannot be closed until the copy is made, so the page is reloaded instead.
  await win.reload();
  await win.waitForSelector('.editor');
});

// A folder by the copy's name is already there: explained beneath both fields, focus back on the name.
await fixture({ duplicate: { ok: false, field: 'name', message: taken('fall-campaign') } });
await openDuplicate();
await win.fill('#duplicate-name', 'Fall Campaign');
await press();
await win.waitForSelector('.modal [role="alert"]');
await shot('dup-taken', '.modal', { text: 'already there' });
if (await duplicateButton().isEnabled()) throw new Error('Duplicate is offered again for a folder found taken');
await closeDialog();

await fixture({ duplicate: { ok: false, field: 'location', message: `SiteOrigin Builder does not have permission to write to ${NO_PERMISSION}. Choose another folder.` }, folder: NO_PERMISSION });
await openDuplicate();
await win.locator('.modal').getByRole('button', { name: 'Choose…' }).click();
await pause(150);
await enter();
await win.waitForSelector('.modal [role="alert"]');
// A folder that cannot be used: focus on Choose….
await shot('dup-no-permission', '.modal button:focus-visible', { themes: LIGHT, text: 'Choose' });
await closeDialog();

await fixture({ duplicate: { ok: false, field: 'form', message: DISK_FULL }, folder: null });
await openDuplicate();
await enter();
await win.waitForSelector('.modal [role="alert"]');
// The copy itself failed: focus on Duplicate, to try again.
await shot('dup-disk-full', '.modal-foot .btn-primary:focus-visible', { themes: LIGHT, text: 'Duplicate' });
await closeDialog();

await fixture({ duplicate: { ok: false, field: 'name', message: taken('storefront-copy') } });
await openDuplicate(SMALLEST);
await press();
await win.waitForSelector('.modal [role="alert"]');
await shot('dup-minimum', '.modal', { themes: LIGHT, full: true });
await closeDialog();

// Made: the copy is offered to open, the original still open.
await fixture({ duplicate: { ok: true, dir: `${sites}-copies/fall-campaign`, name: 'Fall Campaign' } });
await openDuplicate();
await win.fill('#duplicate-name', 'Fall Campaign');
await enter();
await win.waitForSelector('#duplicate-done');
await pause(150);
await shot('dup-done', '.modal-foot .btn-primary:focus-visible', { text: 'Open copy' });

// Opening the copy from somewhere new asks for trust, over the open project.
await fixture({ open: { ok: false, needsTrust: { name: 'Fall Campaign', dir: `${sites}-copies/fall-campaign`, reason: 'new' } } });
await win.getByRole('button', { name: 'Open copy' }).click();
await win.waitForSelector('.trust-path');
await win.mouse.move(4, 4);
await pause(200);
await shot('trust-over-editor', '.modal', { themes: LIGHT, text: 'fall-campaign' });

await app.close();
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`project file dialogs capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
