// Design capture harness for joining someone else's live session, the guest's side inside the app: the Join live
// session dialog (empty, filled in, opened over a project of this computer's, invalid, connecting, waiting, waiting
// while the host is away, turned away, and a project too large to open), then the remote shell's toolbar once the host
// lets the guest in (the session pill live, as a viewer, reconnecting and with the host away, in the full and compact
// tiers), the pill's menu, and a press of Leave session. Guest states are pushed through the editor's own
// `remote:state` and `remote:presence` channels, and the main process's `remote:*` handlers are replaced with stubs
// that answer as the relay would, so no relay is needed. Drives the real (built) app and writes crops of the dialog and
// the toolbar's right end, in light and dark. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/join-live.mjs
//
// Every capture is checked on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('join live capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'join-live');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-join-')));
const BOTH = ['light', 'dark'];
const W = 1440;
const H = 900;
const ROOM = 'r7kq2mxa9pzt4hn8wbc3vdfe';
const INVITE = `https://live.siteorigin.com/s/${ROOM}`;

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
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** Regions of the window: the dialog, the toolbar's right end (with the menu under it), or the whole window. */
async function region(name) {
  const vp = win.viewportSize();
  if (name === 'window') return undefined;
  if (name === 'toolbar') return { x: vp.width - 640, y: 0, width: 640, height: 52 };
  if (name === 'menu') return { x: vp.width - 520, y: 0, width: 520, height: 340 };
  if (name === 'dialog') {
    const box = await win.locator('.modal').first().boundingBox();
    if (!box) throw new Error('no dialog to crop');
    const pad = 24;
    return { x: Math.max(0, Math.round(box.x - pad)), y: Math.max(0, Math.round(box.y - pad)), width: Math.round(box.width + pad * 2), height: Math.round(box.height + pad * 2) };
  }
  throw new Error(`unknown region ${name}`);
}

/** Capture a state; `check` must be visible at the moment of capture. */
async function shot(state, check, { themes = BOTH, area = 'dialog', keepPointer = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keepPointer) await win.mouse.move(24, win.viewportSize().height - 60);
    // A toolbar at rest: focus a menu handed back on Escape is not part of the state.
    if (area === 'toolbar') await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) await win.screenshot({ path: join(OUT, `${state}--${theme}.failed.jpg`), type: 'jpeg' });
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: await region(area) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const escape = async (n = 1) => {
  for (let i = 0; i < n; i++) await win.keyboard.press('Escape'), await pause(150);
};
async function clearNotices() {
  for (let i = 0; i < 10; i++) {
    const b = win.locator('.toasts .toast-dismiss').first();
    if (!(await b.isVisible().catch(() => false))) return;
    await b.click();
    await pause(120);
  }
}

// ---- The relay, as the main process would answer for it ----
// The main process's own remote handlers are swapped for stubs the harness steers: a join answers at once and the
// states that follow are pushed by the script, and the host's project is whatever `globalThis.__joinHost` holds.
await app.evaluate(({ ipcMain, BrowserWindow }) => {
  const send = (channel, payload) => BrowserWindow.getAllWindows()[0].webContents.send(channel, payload);
  globalThis.__joinState = { phase: 'idle', ended: null };
  globalThis.__joinHost = null;
  globalThis.__joinSend = send;
  for (const ch of ['remote:join', 'remote:leave', 'remote:state', 'remote:snapshot', 'remote:presence', 'remote:apply']) ipcMain.removeHandler(ch);
  ipcMain.handle('remote:state', () => globalThis.__joinState);
  ipcMain.handle('remote:join', (_e, opts) => {
    globalThis.__joinState = { phase: 'joining', joinId: `join-${Date.now()}`, relayUrl: 'https://live.siteorigin.com', roomId: 'r7kq2mxa9pzt4hn8wbc3vdfe', displayName: opts.displayName, hostConnected: false, reconnecting: false };
    send('remote:state', globalThis.__joinState);
    return { ok: true, state: globalThis.__joinState };
  });
  ipcMain.handle('remote:leave', () => {
    globalThis.__joinState = { phase: 'idle', ended: { reason: 'left', message: 'You left the live session.' } };
    send('remote:state', globalThis.__joinState);
  });
  ipcMain.handle('remote:snapshot', () => globalThis.__joinHost);
  ipcMain.handle('remote:presence', () => undefined);
  ipcMain.handle('remote:apply', () => ({ ok: false, error: { code: 'CANCELLED', message: 'Not in a capture.', recoverable: false } }));
});

/** Push a guest state through the editor's own channel, as the main process sends it. */
async function remote(patch) {
  await app.evaluate((_m, p) => {
    const base = globalThis.__joinState.phase === 'idle' ? {} : globalThis.__joinState;
    globalThis.__joinState = { ...base, ...p };
    globalThis.__joinSend('remote:state', globalThis.__joinState);
  }, patch);
  await pause(300);
}
const presence = (p) => app.evaluate((_m, v) => globalThis.__joinSend('remote:presence', { ...v, joinId: globalThis.__joinState.joinId }), p);
const openJoin = async () => {
  await win.evaluate(() => window.dispatchEvent(new CustomEvent('builder-command', { detail: 'join-live' })));
  await win.locator('.modal .join-live').waitFor();
  await pause(300);
};
const dialog = win.locator('.modal');
const fill = async (link, name) => {
  await dialog.locator('input').nth(0).fill(link);
  await dialog.locator('input').nth(1).fill(name);
};
const ask = () => dialog.getByRole('button', { name: 'Ask to join' }).click();

// ---- A project of this computer's, open: what joining closes first; its documents stand in for the host's ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: false }), sites);
await win.waitForSelector('.editor');
await pause(2500);
const hostState = await win.evaluate(async () => (await window.builder.project.snapshot()).state);
const pageIds = Object.keys(hostState.pages);
await openJoin();
await shot('join-over-project', '.modal .join-live');
await escape();
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await pause(600);
await clearNotices();

// ---- The dialog, from Welcome ----
await openJoin();
await shot('join-empty', '.modal .join-live');
await fill(INVITE, 'Ann Whitaker');
await pause(150);
await shot('join-filled', '.modal .join-live', { themes: ['light'] });
// What a press of Ask to join says about a link that is not one, and a name left empty.
await fill('live.siteorigin.com/r7kq2mxa9pzt', '');
await ask();
await pause(250);
await shot('join-invalid', '.modal [aria-invalid="true"]');

// Connecting, then waiting in the room for the host.
await fill(INVITE, 'Ann Whitaker');
await ask();
await pause(400);
await shot('join-connecting', '.modal .join-wait');
await remote({ phase: 'waiting', hostConnected: true });
await shot('join-waiting', '.modal .join-wait');
await remote({ phase: 'waiting', hostConnected: false });
await shot('join-waiting-away', '.modal .join-wait .scope-note', { themes: ['light'] });
// Turned away: the form is offered again, with why.
await app.evaluate(() => {
  globalThis.__joinState = { phase: 'idle', ended: { reason: 'declined', message: 'The host declined your request to join.' } };
  globalThis.__joinSend('remote:state', globalThis.__joinState);
});
await pause(400);
await shot('join-declined', '.modal [role="alert"]');

// Let in, but the host's project is too large to send: the dialog says so and the shell never opens.
await ask();
await pause(300);
const MIN = 60_000;
const now = Date.now();
const admitted = (over = {}) => ({
  phase: 'admitted',
  hostConnected: true,
  reconnecting: false,
  guestId: 'g1',
  role: 'collaborator',
  projectName: 'Harbour Lane Studio',
  guestExpiresAt: null,
  sessionExpiresAt: now + 102 * MIN,
  relayClockOffsetMs: 0,
  hostRuntime: 'starting',
  previewRevision: null,
  previewUrl: null,
  previewProblem: null,
  tooLarge: false,
  participants: [
    { guestId: 'g1', displayName: 'Ann Whitaker', role: 'collaborator' },
    { guestId: 'g2', displayName: 'Mo Haddad', role: 'collaborator' },
    { guestId: 'g3', displayName: 'Quill', role: 'viewer' }
  ],
  ...over
});
await remote(admitted({ tooLarge: true }));
await shot('join-too-large', '.modal [role="alert"]');
await escape();
await pause(400);
await clearNotices();

// ---- Let in: the editor opens the host's project, and the toolbar shows the session ----
await app.evaluate((_m, state) => {
  globalThis.__joinHost = { revision: 1, state, readOnly: false, aiBusy: false, runtime: { state: 'starting' } };
}, hostState);
await openJoin();
await fill(INVITE, 'Ann Whitaker');
await ask();
await pause(300);
await remote(admitted());
await win.waitForSelector('.editor .toolbar .remote-pill');
await pause(800);
await presence({ host: { pageId: pageIds[0], viewportWidth: 1280, selection: null, previewPath: '/' }, guests: { g2: { pageId: pageIds[1] ?? pageIds[0], viewportWidth: 1280, selection: null, previewPath: '/' } } });
await pause(400);
await shot('tb-live', '.toolbar .remote-pill', { area: 'toolbar' });
await shot('window-live', '.toolbar .remote-pill', { area: 'window', themes: ['light'] });
// The pill's menu: who is where, and Leave.
await win.locator('.toolbar .remote-pill').click();
await win.locator('[role="menu"]').waitFor();
await pause(250);
await shot('tb-menu', '[role="menu"]', { area: 'menu' });
await escape();
await remote({ role: 'viewer', guestExpiresAt: Date.now() + 14 * MIN });
await shot('tb-viewer', '.toolbar .remote-pill', { area: 'toolbar', themes: ['light'] });
await remote({ role: 'collaborator', guestExpiresAt: null, reconnecting: true });
await shot('tb-reconnecting', '.toolbar .remote-pill', { area: 'toolbar' });
await remote({ reconnecting: false, hostConnected: false });
await shot('tb-away', '.toolbar .remote-pill', { area: 'toolbar', themes: ['light'] });
// Its menu while the host is away: the longest connection line.
await win.locator('.toolbar .remote-pill').click();
await win.locator('[role="menu"]').waitFor();
await pause(250);
await shot('tb-menu-away', '[role="menu"]', { area: 'menu', themes: ['light'] });
await escape();
await remote({ hostConnected: true });

// Narrower windows: the compact tier, at its widest and at the window's narrowest (the main process's minWidth, 1100;
// the overflow tier is below it, so a window never shows it).
for (const [tier, width] of [
  ['compact', 1231],
  ['narrowest', 1100]
]) {
  await win.setViewportSize({ width, height: H });
  await pause(500);
  await shot(`tb-${tier}-live`, '.toolbar .remote-pill', { area: 'toolbar', themes: ['light'] });
  await remote({ reconnecting: true });
  await shot(`tb-${tier}-reconnecting`, '.toolbar .remote-pill', { area: 'toolbar', themes: ['light'] });
  await remote({ reconnecting: false, hostConnected: false });
  await shot(`tb-${tier}-away`, '.toolbar .remote-pill', { area: 'toolbar', themes: ['light'] });
  await remote({ hostConnected: true });
}
await win.setViewportSize({ width: W, height: H });
await pause(500);

// A press of Leave session: what it does first. A question is captured; leaving at once shows where it lands.
await win.locator('.toolbar .remote-leave').click();
await pause(600);
if (await win.locator('.modal').first().isVisible().catch(() => false)) {
  await shot('leave-press', '.modal', { area: 'window' });
} else {
  await win.mouse.move(24, H - 60);
  await pause(300);
  const path = join(OUT, 'leave-press--light.png');
  await win.screenshot({ path });
  written.push(path);
  console.log('wrote', path, '(left at once, no question)');
}

await app.close();
rmSync(WORK, { recursive: true, force: true });
if (errors.length) console.log('page errors:', errors.join('\n'));
const onDisk = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const missing = written.filter((p) => !onDisk.includes(p.split('/').pop()));
if (missing.length) throw new Error(`captures missing on disk: ${missing.join(', ')}`);
console.log(`DONE ${written.length} captures in ${OUT}`);
