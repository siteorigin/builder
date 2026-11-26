// Design capture for History: its Changes list and its Saved versions, in every state that carries design weight.
// Opt-in only, never part of `npm run test:e2e`, and it never calls a provider:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/history.mjs
//
// A real project is edited and versions of it are saved and reviewed through the app's own calls. A long History
// (changes from earlier days, by you, the AI, a guest and from outside the app), the AI at work and a read-only
// opening are shown by sending the project's snapshot through the channel the project reports on, so the dialog
// renders exactly what it would for a project in that state. Each capture checks its state is on screen and throws
// rather than write an image of anything else. Files are `{state}--{theme}.png`, cropped to the dialog with a margin
// of the window; `context` is the whole window.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('history capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'history');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];

const { WORK, cleanup } = scratch('design-history');
const { app, win, errors } = await launch(WORK);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await win.emulateMedia({ reducedMotion: 'reduce' });
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const history = win.getByRole('dialog', { name: 'History' });

/** The dialog with a margin of the window around it, so its edge and shadow read. */
async function clip() {
  const box = await win.locator('.modal').last().boundingBox();
  const size = win.viewportSize();
  const x = Math.max(0, Math.floor(box.x - 24));
  const y = Math.max(0, Math.floor(box.y - 24));
  return { x, y, width: Math.min(size.width - x, Math.ceil(box.width + 48)), height: Math.min(size.height - y, Math.ceil(box.height + 48)) };
}

/** Capture History in each theme; `check` must be visible inside it. `hover` keeps the pointer where it is. */
async function shot(state, check, { themes = BOTH, full = false, hover = false } = {}) {
  await history.waitFor({ timeout: 30000 });
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    if (!hover) await win.mouse.move(4, 4);
    await pause(280);
    const target = typeof check === 'string' ? history.locator(check).first() : check;
    if (!(await target.isVisible().catch(() => false))) throw new Error(`"${state}" (${theme}): ${check} is not on screen; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(full ? {} : { clip: await clip() }) });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
/** Show the project as `change` makes it, through the channel the project reports its snapshot on. */
async function show(change) {
  const s = await snapshot();
  await app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0].webContents.send('project:changed', next), change(s));
  await pause(300);
  // Every state starts at the top of its list, as it does when the dialog opens.
  await win.evaluate(() => document.querySelectorAll('.modal *').forEach((el) => el.scrollTop && (el.scrollTop = 0)));
  await pause(100);
}
/** Back to the project as it really is. */
const real = () => show((s) => s);
const projectMenu = async (item) => {
  await win.locator('.project-title').click();
  await win.locator('[role="menu"]').waitFor();
  await win.locator('[role="menu"] [role^="menuitem"]', { hasText: item }).click();
  await history.waitFor();
  await pause(400);
};
const close = async () => {
  await win.keyboard.press('Escape');
  await history.waitFor({ state: 'detached' });
  await pause(150);
};
const tab = (name) => history.getByRole('tab', { name }).or(history.getByRole('button', { name, exact: true })).first();
async function toTab(name) {
  await tab(name).click();
  await pause(400);
}

// ---- A real project with real edits and real saved versions ----
await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const first = await snapshot();
const pageIds = first.state.site.pageOrder;
const apply = async (operations, label) => {
  const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
  if (!r?.ok) throw new Error(`${label}: ${JSON.stringify(r?.error)}`);
};
await apply([{ type: 'page.update', pageId: pageIds[1] ?? pageIds[0], title: 'Our studio' }], 'Rename page');

const saveVersion = async (name) => {
  const r = await win.evaluate(([n, k]) => window.builder.project.saveVersion(n, k), [name, (await snapshot()).workspaceKey]);
  if (!r.ok) throw new Error(`save ${name}: ${r.message}`);
};
await saveVersion('Approved by client');
await apply([{ type: 'page.create', title: 'Private dining' }], 'Add page');
await apply([{ type: 'page.update', pageId: pageIds[1] ?? pageIds[0], title: 'About the studio' }], 'Rename page');
await saveVersion('Approved by Marama before the spring launch, new menu photos and private dining');
await apply([{ type: 'page.create', title: 'Bookings' }], 'Add page');
await pause(600);

// ---- A long History: what the dialog shows for a project worked on over several days ----
const now = Date.now();
const H = 3600e3;
const LABELS = [
  ['Edit heading “Calm, considered interiors” on Home', 'user'],
  ['Change Primary color in Site styles', 'user'],
  ['Rewrite the About page introduction', 'ai'],
  ['Move Testimonials up on Home', 'user'],
  ['Edit text on Our studio', 'user', 'Marama'],
  ['Keep external change', 'system'],
  ['Add Gallery to Home', 'user'],
  ['Replace image in Hero on Home', 'user'],
  ['Make the pricing cards consistent and add a FAQ about parking and bookings', 'ai'],
  ['Delete Newsletter signup on Home', 'user'],
  ['Change Body font in Site styles', 'user'],
  ['Edit button “Book a consult” on Home', 'user', 'Tama'],
  ['Duplicate Services on Home', 'user'],
  ['Undo “Tighten the hero copy” on its own', 'ai']
];
/** `n` changes, oldest first, spread back over the last few days; the newest `undone` are undone. */
function longHistory(s, n, undone) {
  const entries = [];
  for (let i = 0; i < n; i++) {
    const [label, source, guestName] = LABELS[i % LABELS.length];
    const age = (n - i) * (n > 40 ? 1.6 : 2.2) * H;
    entries.push({ id: `h_cap${i}`, label, source, time: new Date(now - age).toISOString(), revision: i + 1, applied: i < n - undone, ...(guestName ? { guestName } : {}) });
  }
  return { ...s.history, canUndo: n - undone > 0, canRedo: undone > 0, entries };
}

// ---- Changes ----
await projectMenu('History…');
await shot('changes-real', '.history-step');
await show((s) => ({ ...s, history: longHistory(s, 36, 3) }));
await shot('changes-populated', '.history-step');
await shot('context', '.history-step', { full: true, themes: ['light'] });
// The current change has the longest name: the name gives way, when it was and what follows it stay.
await show((s) => ({ ...s, history: longHistory(s, 23, 0) }));
await shot('changes-now-long', '.history-now', { themes: ['light'] });
await show((s) => ({ ...s, history: longHistory(s, 36, 3) }));
// The pointer on an older row: what choosing it would do.
const row = history.locator('.history-step').nth(7);
await row.hover();
await shot('changes-hover', row, { hover: true, themes: ['light'] });
// Focus on a row from the keyboard.
await win.mouse.move(4, 4);
await history.locator('.history-step[tabindex="0"]').focus();
await win.keyboard.press('ArrowDown');
await win.keyboard.press('ArrowDown');
await shot('changes-focus', '.history-step:focus-visible', { themes: ['light'] });
// A step History can't make (this list is shown, not the project's own): the reason is said as a failure.
await history.locator('.history-step').nth(5).click();
await history.locator('.history-said-failed, .history-said.failed').first().waitFor({ timeout: 10000 }).catch(() => undefined);
await shot('changes-step-failed', '.history-said-failed, .history-said.failed', { themes: ['light'] });
// The full hundred, scrolled to the oldest.
await show((s) => ({ ...s, history: longHistory(s, 100, 0) }));
await history.locator('.history-step').last().scrollIntoViewIfNeeded();
await pause(200);
await shot('changes-scrolled', '.history-step', { themes: ['light'] });
// The AI at work: History is its to change.
await show((s) => ({ ...s, aiBusy: true, aiRunId: 'r_capture', history: longHistory(s, 36, 0) }));
await shot('changes-ai-busy', '.history-step');
// Read-only.
await show((s) => ({ ...s, readOnly: { reason: 'Another SiteOrigin Builder took over this project, so it is read-only here. Close and reopen it to edit.', canUnlock: true }, history: longHistory(s, 36, 0) }));
await shot('changes-read-only', '.history-step', { themes: ['light'] });
// No changes yet.
await show((s) => ({ ...s, history: { ...s.history, canUndo: false, canRedo: false, entries: [] } }));
await shot('changes-empty', '.modal-body');
await real();

// ---- Saved versions ----
await toTab('Saved versions');
await shot('versions-real', '.versions-list');
const extra = (s, n) => {
  const base = s.versions.list;
  const more = [];
  const names = ['Before the colour refresh', 'Launch day', 'First draft from the starter', 'Before importing the blog posts', 'Client review round 2', 'Before swapping the hero photos'];
  for (let i = 0; i < n; i++) {
    more.push({ ...base[base.length - 1], id: `v_cap${i}`, name: names[i % names.length], time: new Date(now - (i + 1) * 31 * H).toISOString(), auto: i === 1, bytes: 180000 + i * 41000, pages: 4 + (i % 3) });
  }
  return { ...s.versions, list: [...base, ...more] };
};
await show((s) => ({ ...s, versions: extra(s, 4) }));
await shot('versions-populated', '.versions-list');
await show((s) => ({ ...s, versions: extra(s, 14) }));
await history.locator('.versions-list li').last().scrollIntoViewIfNeeded();
await pause(200);
await shot('versions-scrolled', '.versions-list', { themes: ['light'] });
await show((s) => ({ ...s, aiBusy: true, aiRunId: 'r_capture', versions: extra(s, 2) }));
await shot('versions-ai-busy', '.versions-list');
await show((s) => ({ ...s, readOnly: { reason: 'Another SiteOrigin Builder took over this project, so it is read-only here. Close and reopen it to edit.', canUnlock: true }, versions: extra(s, 2) }));
await shot('versions-read-only', '.versions-list', { themes: ['light'] });
await show((s) => ({ ...s, versions: { list: [], bytes: 0 } }));
await shot('versions-empty', '.modal-body');
// The saved versions could not be read: a failure, said as one.
await show((s) => ({ ...s, versions: { list: [], bytes: 0, problem: 'The saved versions could not be read: versions/index.json is damaged.' } }));
await shot('versions-problem', '.scope-note.danger', { themes: ['light'] });
await real();
// A name being typed.
const field = history.getByRole('textbox', { name: 'Version name' });
await field.fill('Before the menu change');
await shot('versions-typing', '.versions-list', { themes: ['light'] });
await field.fill('');
// Reviewing the first saved version against the project as it is now.
// Renaming one, in place.
const renameButton = history.getByRole('button', { name: 'Rename “Approved by client”' });
if (await renameButton.count()) {
  await renameButton.click();
  await history.locator('.versions-list input').first().waitFor();
  await win.keyboard.type('Approved by client, final');
  await shot('versions-renaming', '.versions-list input', { themes: ['light'] });
  await win.keyboard.press('Escape');
  await pause(200);
  if (!(await history.isVisible())) throw new Error('Escape in the rename field closed History');
} else console.log('skipped versions-renaming: no Rename action');
await history.locator('.versions-list li', { hasText: 'Approved by client' }).getByRole('button', { name: /Review|Restore/ }).first().click();
await history.getByTestId('version-review').locator('ul, .scope-note, p').last().waitFor();
await history.getByRole('button', { name: /Restore this version/ }).waitFor();
await pause(500);
await shot('versions-review', '[data-testid="version-review"]');
// The same review while the AI works: Restore waits, and says why.
await show((s) => ({ ...s, aiBusy: true, aiRunId: 'r_capture' }));
await shot('versions-review-ai-busy', '[data-testid="version-review"] .history-note', { themes: ['light'] });
await real();
await close();

// ---- Opened straight onto Saved versions from the project menu: the name field takes focus ----
await projectMenu('Save version…');
await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Version name');
await shot('versions-opened', 'input[aria-label="Version name"]:focus', { themes: ['light'] });
await close();

// ---- Switching between the two: the dialog stays, its height with it ----
await projectMenu('History…');
await show((s) => ({ ...s, history: longHistory(s, 6, 0) }));
const before = await win.locator('.modal').last().boundingBox();
await toTab('Saved versions');
const after = await win.locator('.modal').last().boundingBox();
console.log(`switch: changes ${Math.round(before.height)}px → versions ${Math.round(after.height)}px`);
await shot('switch-short-to-versions', '.versions-list', { themes: ['light'] });
await close();

const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const missing = written.filter((p) => !files.includes(p.slice(OUT.length + 1)));
if (missing.length) throw new Error(`not written: ${missing.join(', ')}`);
if (errors.length) console.log('page errors:', errors);
console.log(`history capture: ${written.length} images in ${OUT}`);
await app.close();
cleanup();
