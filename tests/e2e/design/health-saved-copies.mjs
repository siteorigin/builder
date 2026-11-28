// Design capture for Project health's file conflicts and Saved copies: each conflict kind (a project document, one an
// AI request's rollback left, a page's generated file, a design's own file), comparing versions, a choice being made,
// settling, the saved copies (several, from earlier days, one viewed, one loading, one being taken off the list),
// read-only, the narrowest window, and keyboard focus. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/health-saved-copies.mjs
//
// Everything is real: the conflicts are made on disk (held project documents written as an interrupted save leaves
// them, generated files edited by hand), the choices go through the app, and the saved copies are the ones settling
// makes, plus older ones written to the recovery folder before the project opens. Busy states hold the main process's
// own handler for a moment. Writes `{state}--{theme}.png`; every capture checks its state on screen and throws rather
// than writing a wrong image.
import { _electron as electron } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('saved copies capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'health-saved-copies');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-copies-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const W = 1440;
const H = 900;
// Tall enough for the dialog (89vh at most) to hold the whole of the part captured, unscrolled.
const TALL = 2200;

const app = await electron.launch({ args: ['.'], env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' } });
const win = await app.firstWindow();
win.setDefaultTimeout(60000);
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: W, height: H });
await win.waitForSelector('.welcome', { timeout: 120000 });
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system', developerMode: false }));
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const sha = (s) => createHash('sha256').update(s).digest('hex');

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/**
 * Capture a state. `area`: 'window', 'modal' (the dialog and a margin), or a selector inside the dialog, captured on
 * its own. `check` (with `text`, when given) must be visible at the moment of capture.
 */
async function shot(state, check, { themes = BOTH, area = 'modal', text = null, keepPointer = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keepPointer) await win.mouse.move(4, 4);
    await pause(200);
    const target = text ? win.locator(check, { hasText: text }).first() : win.locator(check).first();
    if (!(await target.isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${check}"${text ? ` with "${text}"` : ''}; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    if (area === 'window') await win.screenshot({ path });
    else if (area === 'modal') {
      const vp = win.viewportSize();
      const b = await win.locator('.modal').first().boundingBox();
      const x = Math.max(0, Math.floor(b.x - 20));
      const y = Math.max(0, Math.floor(b.y - 20));
      await win.screenshot({ path, clip: { x, y, width: Math.min(vp.width - x, Math.ceil(b.width + 40)), height: Math.min(vp.height - y, Math.ceil(b.height + 40)) } });
    } else {
      const el = win.locator(area).first();
      await el.scrollIntoViewIfNeeded();
      await pause(100);
      const b = await el.boundingBox();
      const pad = 12;
      await win.screenshot({ path, clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad } });
    }
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
async function eventually(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(250);
  }
}
async function apply(operations, label) {
  const r = await win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });
  if (!r?.ok) throw new Error(`${label} failed: ${JSON.stringify(r?.error ?? r)}`);
  await pause(500);
}
const pageNamed = (snap, title) => {
  const p = Object.values(snap.state.pages).find((x) => x.title === title);
  if (!p) throw new Error(`no page called ${title}`);
  return p;
};
const openHealth = async () => {
  await win.locator('.status-bar button[title^="Project health:"]').click();
  await win.locator('.modal').first().waitFor();
  await pause(400);
};
const closeHealth = async () => {
  await win.keyboard.press('Escape');
  await win.locator('.modal').first().waitFor({ state: 'detached' });
  await pause(200);
};
const tall = () => win.setViewportSize({ width: W, height: TALL });
const normal = () => win.setViewportSize({ width: W, height: H });
const dialog = () => win.locator('.modal').first();
const row = (text) => dialog().locator('.health-row', { hasText: text }).first();
async function reopen(dir) {
  await win.evaluate(() => window.builder.projects.close());
  await win.waitForSelector('.welcome');
  const opened = await win.evaluate((d) => window.builder.projects.open(d), dir);
  if (!opened?.ok) throw new Error(`could not reopen: ${opened?.message}`);
  await win.waitForSelector('.editor', { timeout: 120000 });
  await pause(2500);
}
/** Hold one of the main process's handlers for `ms` before it answers, or for ever (`ms` null) until released. */
const holdHandler = (channel, ms) =>
  app.evaluate(({ ipcMain }, [channel, ms]) => {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers?.get(channel);
    if (!original) throw new Error(`no handler for ${channel}`);
    globalThis.__held ??= {};
    globalThis.__held[channel] = original;
    handlers.set(channel, (...args) => new Promise((resolve) => setTimeout(() => resolve(original(...args)), ms ?? 2 ** 30)));
  }, [channel, ms]);
const releaseHandler = (channel) =>
  app.evaluate(({ ipcMain }, channel) => {
    ipcMain._invokeHandlers.set(channel, globalThis.__held[channel]);
  }, channel);

// ---- A business site, then conflicts made on disk as an interrupted save and an AI rollback leave them ----
const sites = join(WORK, 'sites');
const created = await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
if (!created?.ok) throw new Error(`project creation failed: ${created?.message}`);
await win.waitForSelector('.editor', { timeout: 120000 });
await win.frameLocator('.frame-box iframe').locator('h1').first().waitFor({ timeout: 240000 });
await pause(1500);
const first = await snapshot();
const dir = first.dir;
const ABOUT_DOC = `siteorigin/pages/${pageNamed(first, 'About').id}.json`;
const CONTACT_DOC = `siteorigin/pages/${pageNamed(first, 'Contact').id}.json`;
const ABOUT_PAGE = 'src/routes/about/+page.svelte';
const HERO = readdirSync(join(dir, 'src/lib/siteorigin/generated')).find((f) => f.includes('hero'));
if (!HERO) throw new Error('the business starter has no generated hero file');
const HERO_FILE = `src/lib/siteorigin/generated/${HERO}`;
// Generated files edited by hand, found by the next save.
writeFileSync(join(dir, ABOUT_PAGE), `${readFileSync(join(dir, ABOUT_PAGE), 'utf8')}\n<!-- edited by hand -->\n`);
writeFileSync(join(dir, HERO_FILE), readFileSync(join(dir, HERO_FILE), 'utf8').replace(/(<section [^>]*>)/, '$1\n\t<p class="hand-badge">Made by hand</p>'));
await apply([{ type: 'site.update', name: 'Harbour Lane Studio Ltd' }], 'Rename');
await eventually(async () => (await snapshot()).conflicts.length === 2, 'two generated files in conflict');
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
{
  const local = (...p) => join(dir, '.siteorigin', ...p);
  const blob = (content) => {
    const h = sha(content);
    writeFileSync(local('history', 'blobs', `${h}.json`), content);
    return h;
  };
  const about = readFileSync(join(dir, ABOUT_DOC), 'utf8');
  const contact = readFileSync(join(dir, CONTACT_DOC), 'utf8');
  const builderAbout = blob(about);
  const builderContact = blob(contact);
  const retitled = (text, title) => `${JSON.stringify({ ...JSON.parse(text), title }, null, 2)}\n`;
  const attempted = blob(retitled(contact, 'Contact us'));
  writeFileSync(join(dir, ABOUT_DOC), retitled(about, 'About the studio'));
  writeFileSync(join(dir, CONTACT_DOC), retitled(contact, 'Get in touch'));
  writeFileSync(
    local('conflicts.json'),
    JSON.stringify({
      conflicts: [
        { path: ABOUT_DOC, reason: 'Changed outside SiteOrigin Builder while a save was interrupted.', builder: builderAbout },
        { path: CONTACT_DOC, reason: 'Changed outside SiteOrigin Builder during an AI run.', builder: builderContact, aiRun: true, attempted }
      ]
    })
  );
  // Older saved copies, from earlier conflicts: yesterday's and last month's, one of a file that was removed.
  mkdirSync(local('recovery'), { recursive: true });
  const day = 86400000;
  const older = [
    { id: '0a1b2c3d4e5f6071', path: 'src/routes/services/+page.svelte', kind: 'generated', side: 'external', savedAt: Date.now() - day - 3 * 3600000, file: '.siteorigin/recovery/older-1.svelte' },
    { id: '1a2b3c4d5e6f7082', path: 'siteorigin/site.json', kind: 'canonical', side: 'builder', savedAt: Date.now() - 34 * day, file: '.siteorigin/recovery/older-2.json' },
    { id: '2a3b4c5d6e7f8093', path: 'siteorigin/components/custom.testimonial-quote/component.json', kind: 'canonical', side: 'attempted', removed: true, savedAt: Date.now() - 36 * day, file: '.siteorigin/recovery/older-3.json' }
  ];
  writeFileSync(join(dir, older[0].file), '<script>\n\timport Hero from "#lib/siteorigin/generated/hero.svelte";\n</script>\n\n<Hero heading="Our services" />\n<!-- tweaked by hand -->\n');
  writeFileSync(join(dir, older[1].file), JSON.stringify({ name: 'Harbour Lane Studio', language: 'en' }, null, 2));
  writeFileSync(local('recovery', 'copies.json'), JSON.stringify({ copies: older }));
}
await reopen(dir);
await eventually(async () => (await snapshot()).conflicts.length === 4, 'four conflicts');

// ---- Several conflicts, nothing compared ----
await openHealth();
await shot('conflicts-dialog', '.modal [data-group="problems"] .health-place', { text: 'files changed in two places' });
await tall();
await pause(300);
await shot('conflicts-block', '.modal [data-group="problems"] .health-place', { area: '.modal [data-group="problems"] .health-place' });
await shot('saved-list', '.modal [data-group="saved"]', { area: '.modal [data-group="saved"]' });

// ---- Comparing: a project document's two versions, and an AI rollback's three ----
await row('About page').getByRole('button', { name: 'Compare versions' }).click();
await dialog().locator('.version-pane').first().waitFor();
await pause(300);
await shot('conflict-compare', '.modal .version-pane', { area: '.modal [data-group="problems"] .health-place .health-row:has(.version-pane)' });
await row('About page').getByRole('button', { name: 'Hide versions' }).click();
await row('Contact page').getByRole('button', { name: 'Compare versions' }).click();
await dialog().locator('.version-pane').first().waitFor();
await pause(300);
await shot('conflict-compare-ai', '.modal .version-pane', { area: '.modal [data-group="problems"] .health-place .health-row:has(.version-pane)', themes: LIGHT });
await row('Contact page').getByRole('button', { name: 'Hide versions' }).click();
await pause(200);
// A page's generated file: one way back, with the edit shown beside it.
await row('website file').getByRole('button', { name: 'Compare versions' }).click();
await dialog().locator('.version-pane').first().waitFor();
await pause(300);
await shot('conflict-compare-generated', '.modal .version-pane', { area: '.modal [data-group="problems"] .health-place .health-row:has(.version-pane)', themes: LIGHT });
await row('website file').getByRole('button', { name: 'Hide versions' }).click();
await pause(200);

// ---- Keyboard: tabbing from a row's Compare to its choices ----
await row('About page').getByRole('button', { name: 'Compare versions' }).focus();
await win.keyboard.press('Tab');
await win.keyboard.press('Tab');
await pause(200);
await shot('conflict-focus', '.modal .health-choice button:focus-visible', { area: '.modal [data-group="problems"] .health-place .health-row', themes: LIGHT, keepPointer: true });

// ---- A choice being made: the dialog held while it runs ----
await holdHandler('project:resolveConflict', 4000);
await row('About page').getByRole('button', { name: 'Keep the file on disk' }).click();
await pause(300);
await shot('conflict-busy', '.modal .health-choice button[aria-disabled="true"]', { area: '.modal [data-group="problems"] .health-place', themes: LIGHT, keepPointer: true });
await eventually(async () => (await snapshot()).conflicts.length === 3, 'the About document settled');
await releaseHandler('project:resolveConflict');
await pause(500);
// One more settled, so the list has today's copies above the older ones.
await row('website file').getByRole('button', { name: /Use SiteOrigin Builder/ }).click();
await eventually(async () => (await snapshot()).conflicts.length === 2, 'the About file restored');
await pause(600);
await normal();
await pause(300);
await shot('after-settle', '.modal .health-summary', { themes: LIGHT });
await tall();
await pause(300);
await shot('saved-list-today', '.modal [data-group="saved"]', { area: '.modal [data-group="saved"]' });

// ---- A saved copy viewed, and one loading ----
const savedRow = (n) => dialog().locator('[data-group="saved"] .health-row').nth(n);
await savedRow(0).getByRole('button', { name: 'View copy' }).click();
await savedRow(0).locator('.versions').waitFor();
await pause(300);
await shot('saved-view', '.modal [data-group="saved"] .version-pane', { area: '.modal [data-group="saved"]' });
await savedRow(0).getByRole('button', { name: 'Hide copy' }).click();
await holdHandler('project:readSavedCopy', null);
await savedRow(1).getByRole('button', { name: 'View copy' }).click();
await pause(400);
await shot('saved-loading', '.modal [data-group="saved"] .spinner', { area: '.modal [data-group="saved"]', themes: LIGHT });
await releaseHandler('project:readSavedCopy');
await closeHealth();

// ---- Taking a copy off the list, while it is being taken off ----
await openHealth();
await holdHandler('project:dismissSavedCopy', 4000);
await savedRow(2).getByRole('button', { name: 'Remove from list' }).click();
await pause(300);
await shot('saved-removing', '.modal [data-group="saved"]', { area: '.modal [data-group="saved"]', themes: LIGHT, keepPointer: true });
await eventually(async () => (await snapshot()).savedCopies.length === 4, 'the copy taken off the list');
await releaseHandler('project:dismissSavedCopy');
await pause(300);
// Taken off: a line in its place says so, with Undo, which has the focus.
await shot('saved-removed', '.modal .saved-taken', { area: '.modal [data-group="saved"]', keepPointer: true });
await dialog().getByRole('button', { name: 'Undo' }).press('Enter');
await eventually(async () => (await snapshot()).savedCopies.length === 5, 'the copy put back on the list');
await pause(300);
await savedRow(2).getByRole('button', { name: 'Remove from list' }).click();
await eventually(async () => (await snapshot()).savedCopies.length === 4, 'the copy taken off the list again');
await closeHealth();

// ---- The narrowest window ----
await win.setViewportSize({ width: 1100, height: 700 });
await pause(400);
await openHealth();
await shot('narrow-conflicts', '.modal [data-group="problems"] .health-place', { themes: LIGHT });
await dialog().locator('[data-group="saved"]').scrollIntoViewIfNeeded();
await pause(200);
await shot('narrow-saved', '.modal [data-group="saved"]', { themes: LIGHT });
await closeHealth();

// ---- Read-only: another copy of the app holds the project ----
await normal();
writeFileSync(join(dir, '.siteorigin/lock.json'), JSON.stringify({ pid: process.pid, host: hostname(), instance: 'another-window', started: new Date().toISOString() }));
await reopen(dir);
await win.locator('.status-bar .read-only').waitFor();
// A read-only opening reads no conflicts of its own; one shown read-only (a live session's viewer, say) is pushed
// through the main process's own change broadcast.
{
  const snap = await snapshot();
  snap.conflicts = [
    { path: CONTACT_DOC, reason: 'Changed outside SiteOrigin Builder during an AI run.', kind: 'canonical', aiRun: true },
    { path: HERO_FILE, reason: 'Generated file was edited outside SiteOrigin Builder. Restore it to resume generation.', kind: 'generated' }
  ];
  snap.diagnostics = [...snap.diagnostics, ...snap.conflicts.map((c) => ({ severity: 'error', code: 'CONFLICT', message: `${c.path}: ${c.reason}` }))];
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()).webContents.send('project:changed', s), snap);
  await pause(400);
}
await tall();
await openHealth();
await shot('read-only-conflicts', '.modal [data-group="problems"] .health-place', { area: '.modal [data-group="problems"] .health-place', themes: LIGHT });
await shot('read-only-saved', '.modal [data-group="saved"]', { area: '.modal [data-group="saved"]', themes: LIGHT });
await closeHealth();
rmSync(join(dir, '.siteorigin/lock.json'), { force: true });
await normal();
await reopen(dir);

// ---- Everything settled: only the saved copies are left ----
await openHealth();
for (const text of ['Contact page', 'hero component file']) {
  const r = row(text);
  if (!(await r.count())) continue;
  await r.getByRole('button', { name: /Use SiteOrigin Builder/ }).click();
  await pause(1200);
}
await eventually(async () => (await snapshot()).conflicts.length === 0, 'every conflict settled', 60000);
await pause(600);
await shot('saved-only', '.modal [data-group="saved"]');
await tall();
await pause(300);
await shot('saved-only-list', '.modal [data-group="saved"]', { area: '.modal [data-group="saved"]', themes: LIGHT });
await closeHealth();

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`saved copies capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
