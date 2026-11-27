// Design capture harness for hosting a live session: the toolbar's Share button and its Live pill, the Share popover in
// each of its phases (start, starting, live with nobody yet, a full room with guests waiting, a session that lasts until
// the project closes, reconnecting, ending, a guest's removal and the session's end being confirmed), and the
// join-request notices (one, a crowd, while reconnecting, and with a dialog open). Host states are pushed through the
// editor's own `live:state` channel, as the main process sends them, so no relay is needed. Drives the real (built) app
// and writes crops of the toolbar's right end and the notices' band, in light and dark. Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/share-popover.mjs
//
// Every capture is checked on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('share popover capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'share-popover');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-share-')));
const BOTH = ['light', 'dark'];
const W = 1440;
const H = 900;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: W, height: H });
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** Regions of the window: the toolbar's right end with the popover under it, the notices' band, or the whole window. */
function region(name) {
  const vp = win.viewportSize();
  if (name === 'window') return undefined;
  if (name === 'popover') return { x: vp.width - 560, y: 0, width: 560, height: vp.height };
  if (name === 'toolbar') return { x: vp.width - 560, y: 0, width: 560, height: 56 };
  if (name === 'notices') return { x: Math.round(vp.width / 2 - 360), y: vp.height - 460, width: 720, height: 460 };
  throw new Error(`unknown region ${name}`);
}

/** Capture a state; `check` must be visible at the moment of capture. */
async function shot(state, check, { themes = BOTH, area = 'popover', keepPointer = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keepPointer) await win.mouse.move(24, win.viewportSize().height - 60);
    // The toolbar at rest: no focus ring left by the popover handing focus back, and a turning glyph caught at its first
    // frame rather than wherever it happened to be (a colour still easing in is finished), so captures of the pill
    // compare like with like.
    if (area === 'toolbar')
      await win.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        for (const a of document.getAnimations()) a instanceof CSSTransition ? a.finish() : (a.pause(), (a.currentTime = 0));
      });
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: region(area) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const escape = async (n = 1) => {
  for (let i = 0; i < n; i++) await win.keyboard.press('Escape'), await pause(150);
};
// A press of Remove or End session reaches no session here (the states are pushed, not run), and says so in a notice:
// dismiss those, so they never sit in a later capture.
async function clearNotices() {
  for (let i = 0; i < 10; i++) {
    const b = win.locator('.toasts .toast:not(.live-request) .toast-dismiss').first();
    if (!(await b.isVisible().catch(() => false))) return;
    await b.click();
    await pause(120);
  }
}

// ---- A project ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: false }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await pause(1200);
const workspaceKey = await win.evaluate(async () => (await window.builder.project.snapshot()).workspaceKey);
if (!workspaceKey) throw new Error('no workspaceKey for the open project');
// The headless window is not focused, so the page's clipboard would refuse; take what is copied instead.
await win.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } }));

/** Push a host state through the editor's own channel, as the main process sends it. */
async function live(state) {
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('live:state', s), state);
  await pause(250);
}
const run = { workspaceKey, runId: 'run-capture' };
const now = Date.now();
const MIN = 60_000;
const room = (over = {}) => ({
  ...run,
  phase: 'active',
  roomId: 'r7Kq2mXa9PzL',
  inviteUrl: 'https://live.siteorigin.com/s/r7Kq2mXa9PzL#k=Qm4vT8nB2xYw',
  projectName: 'Harbour Lane Studio',
  duration: '2h',
  startedAt: now - 18 * MIN,
  expiresAt: now + 102 * MIN,
  relayClockOffsetMs: 0,
  locked: false,
  participants: [],
  previewReady: true,
  lastError: null,
  ...over
});
const admitted = (guestId, displayName, role = 'viewer', guestExpiresAt = null) => ({ guestId, displayName, status: 'admitted', role, guestExpiresAt });
const pending = (guestId, displayName) => ({ guestId, displayName, status: 'pending' });
const crowd = [
  pending('g5', 'Priya Raman'),
  pending('g6', 'Bartholomew Okonkwo-Fitzgerald'),
  admitted('g1', 'Ann Whitaker', 'collaborator'),
  admitted('g2', 'Mo Haddad', 'viewer', now + 14 * MIN),
  admitted('g3', 'Quill', 'viewer'),
  admitted('g4', 'Hēmi Tūhoe-Marsden', 'collaborator')
];
const share = win.locator('.toolbar .share-btn');
const openShare = async () => {
  if ((await share.getAttribute('aria-expanded')) !== 'true') await share.click();
  await win.locator('.share-popover').waitFor();
  await pause(250);
};
const closeShare = async () => {
  if ((await share.getAttribute('aria-expanded')) === 'true') await escape();
  await win.locator('.share-popover').waitFor({ state: 'detached' });
};

// ---- Idle: the Share button and the start view ----
await shot('tb-idle', '.share-btn.idle', { area: 'toolbar' });
await openShare();
await shot('pop-start', '.share-popover .share-start');
// The last length picked (until the project closes): the longest segment label, selected.
await win.locator('.share-popover [role="radio"]').last().click();
await pause(150);
await shot('pop-start-project', '.share-popover [role="radio"][aria-checked="true"]', { themes: ['light'], keepPointer: true });
await closeShare();

// ---- Starting ----
await live({ ...run, phase: 'starting' });
await openShare();
await shot('pop-starting', '.share-popover .share-busy', { themes: ['light'] });
await closeShare();

// ---- Live, nobody yet ----
await live(room());
await shot('tb-live-empty', '.share-btn.live', { area: 'toolbar' });
await openShare();
await shot('pop-live-empty', '.share-popover .live-roster');
// Copy: what the author sees at the button.
await win.locator('.share-popover').getByRole('button', { name: /^Copy/ }).click();
await pause(200);
await shot('pop-copied', '.share-popover .live-roster', { themes: ['light'], area: 'window', keepPointer: true });
// End session with nobody in yet: still asked, as the link may already be out.
await win.locator('.share-popover').getByRole('button', { name: 'End session' }).click();
await win.locator('.modal').waitFor();
await pause(300);
await shot('confirm-end-empty', '.modal', { area: 'window', themes: ['light'] });
await escape();
await pause(200);
await closeShare();
await pause(4500);

// ---- A full room: two waiting, four in ----
await live(room({ participants: crowd }));
await shot('tb-live-full', '.share-btn.live .share-badge', { area: 'toolbar' });
await shot('notices-two', '.toast.live-request', { area: 'notices' });
await openShare();
await shot('pop-full', '.share-popover .live-waiting');
// Scrolled to its end: what stays and what goes.
await win.locator('.share-popover').evaluate((el) => {
  const s = [el, ...el.querySelectorAll('*')].find((n) => n.scrollHeight > n.clientHeight + 4 && getComputedStyle(n).overflowY !== 'visible');
  if (s) s.scrollTop = s.scrollHeight;
});
await pause(200);
await shot('pop-full-end', '.share-popover .live-roster', { themes: ['light'] });
await win.locator('.share-popover').evaluate((el) => [el, ...el.querySelectorAll('*')].forEach((n) => (n.scrollTop = 0)));
// A shorter window: the lists scroll between the session's head and its end.
await win.setViewportSize({ width: 1280, height: 640 });
await pause(500);
await shot('pop-full-short', '.share-popover .live-roster');
await win.setViewportSize({ width: W, height: H });
await pause(500);

// Remove and End session: what a press does first.
await win.locator('.share-popover').getByRole('button', { name: 'Remove Mo Haddad' }).click();
await pause(400);
const removeAsk = await win.locator('.modal, .share-confirm').first().isVisible().catch(() => false);
if (removeAsk) {
  await shot('confirm-remove', '.modal, .share-confirm', { area: 'window' });
  await escape();
  await pause(200);
} else console.log('no confirmation for Remove');
await openShare();
await win.locator('.share-popover').getByRole('button', { name: 'End session' }).click();
await pause(400);
const endAsk = await win.locator('.modal, .share-confirm').first().isVisible().catch(() => false);
if (endAsk) {
  await shot('confirm-end', '.modal, .share-confirm', { area: 'window' });
  await escape();
  await pause(200);
} else console.log('no confirmation for End session');
// Whatever the presses sent went to no session: put the room back as it was.
await live(room({ participants: crowd }));
await closeShare().catch(() => undefined);
await pause(300);
await clearNotices();

// ---- Until the project closes, locked ----
await live(room({ duration: 'project', expiresAt: now - 18 * MIN + 24 * 60 * MIN, locked: true, participants: crowd.slice(2, 4) }));
await shot('tb-live-project', '.share-btn.live', { area: 'toolbar', themes: ['light'] });
await openShare();
await shot('pop-project-locked', '.share-popover .live-roster');
await closeShare();

// ---- Reconnecting, with an error ----
await live(room({ phase: 'reconnecting', participants: crowd.slice(1, 4) }));
await shot('tb-reconnecting', '.share-btn.reconnecting', { area: 'toolbar' });
// The request still waiting stays on the canvas, saying when it can be answered.
await shot('notices-reconnecting', '.toast.live-request .live-request-paused', { area: 'notices' });
await openShare();
await shot('pop-reconnecting', '.share-popover .live-roster');
await closeShare();

// ---- Ending ----
await live({ ...run, phase: 'stopping' });
await openShare();
await shot('pop-ending', '.share-popover .share-busy', { themes: ['light'] });
await closeShare();

// ---- Join requests: a crowd at once, then with a dialog open ----
const many = ['Priya Raman', 'Bartholomew Okonkwo-Fitzgerald', 'Lena Sørensen', 'Tavita Fa’alogo', 'Marguerite Delacroix-Beaumont', 'Jun Park'].map((n, i) => pending(`w${i}`, n));
await live(room({ participants: [...many, admitted('g1', 'Ann Whitaker', 'collaborator')] }));
await shot('notices-crowd', '.toast.live-request', { area: 'window' });
await live(room({ participants: [pending('g5', 'Priya Raman'), admitted('g1', 'Ann Whitaker', 'collaborator')] }));
await shot('notices-one', '.toast.live-request', { area: 'notices' });
// Hidden without an answer: the request keeps waiting, counted on the pill.
const hide = win.locator('.toast.live-request .toast-dismiss');
if (await hide.isVisible().catch(() => false)) {
  await hide.click();
  await pause(300);
  await shot('notices-hidden', '.share-btn .share-badge', { themes: ['light'], area: 'toolbar' });
  // A new arrival brings a notice back.
  await live(room({ participants: [pending('g5', 'Priya Raman'), pending('g8', 'Jun Park'), admitted('g1', 'Ann Whitaker', 'collaborator')] }));
}
await win.locator('.toolbar [aria-label="Settings"]').click();
await win.waitForSelector('.modal');
await pause(400);
await shot('notices-dialog', '.toast.live-request', { area: 'window', themes: ['light'] });
await escape();

await live({ phase: 'idle', lastError: null });
await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`share popover capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
