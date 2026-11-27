// Design capture harness for the shared popup menu (Menu and useMenu in components/ui.tsx): the rows that only state
// a fact beside the ones that act, and the trigger's open look. It opens the component manage menu (a component used
// inside another's design and needed by a code component), the toolbar's project and zoom menus, and, as a guest in a
// live session, the session pill's menu of who is where: opened by pointer, walked by the arrow keys, and kept open
// while someone moves to another page. Guest states are pushed through the editor's own `remote:state` and
// `remote:presence` channels with the main process's `remote:*` handlers stubbed, as tests/e2e/design/join-live.mjs
// does. Drives the real (built) app and writes crops of each menu with its trigger, in light and dark. Opt-in only,
// never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/menus.mjs
//
// Every capture is checked on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('menus capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'menus');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-menus-')));
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
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
const menuEl = win.locator('[role="menu"]');

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** The open menu and its trigger, with room around them. */
async function crop(trigger) {
  const boxes = [await menuEl.first().boundingBox()];
  if (trigger) boxes.push(await win.locator(trigger).first().boundingBox());
  const bs = boxes.filter(Boolean);
  if (!bs.length) throw new Error('nothing to crop');
  const pad = 20;
  const x0 = Math.max(0, Math.min(...bs.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...bs.map((b) => b.y)) - pad);
  const x1 = Math.min(W, Math.max(...bs.map((b) => b.x + b.width)) + pad);
  const y1 = Math.min(H, Math.max(...bs.map((b) => b.y + b.height)) + pad);
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

/** Capture the open menu with its trigger; `point` keeps the pointer where the state put it. */
async function shot(state, trigger, { themes = BOTH, keepPointer = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keepPointer) await win.mouse.move(W - 6, H - 6);
    await pause(200);
    const visible = await menuEl.first().isVisible().catch(() => false);
    if (!visible) await win.screenshot({ path: join(OUT, `${state}--${theme}.failed.jpg`), type: 'jpeg' });
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render its menu; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: await crop(trigger) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const escape = async (n = 1) => {
  for (let i = 0; i < n; i++) await win.keyboard.press('Escape'), await pause(150);
};
const waitMenu = async () => {
  await menuEl.first().waitFor();
  await pause(300);
};
async function clearNotices() {
  for (let i = 0; i < 10; i++) {
    const b = win.locator('.toasts .toast-dismiss').first();
    if (!(await b.isVisible().catch(() => false))) return;
    await b.click();
    await pause(120);
  }
}
const apply = (operations, label) =>
  win.evaluate(
    async ([operations, label]) => {
      const r = await window.builder.project.apply({ operations, label });
      if (!r?.ok) throw new Error(`${label}: ${r?.error?.message ?? JSON.stringify(r).slice(0, 200)}`);
      return r.results;
    },
    [operations, label]
  );
const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const panel = win.locator('.side-panel-view:not([hidden])');

// ---- A project with components that are used inside other components ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: false }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1500);
await win.locator('[aria-label="Settings"]').click();
await win.getByRole('switch', { name: 'Developer mode' }).click();
await pause(200);
await escape();
await pause(400);

let st = await snapshot();
const pageIds = st.site.pageOrder;
const home = { kind: 'page', id: st.site.homePageId ?? pageIds[0] };
const about = { kind: 'page', id: pageIds[1] ?? pageIds[0] };
// A card, placed on Home and inside a Team row component's design.
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner: home, parentId: null, componentId: 'layout.section' }], 'Insert Section');
const [{ nodeId: stack }] = await apply([{ type: 'node.insert', owner: home, parentId: section, slot: 'content', primitive: 'stack' }], 'Insert Stack');
await apply(
  [
    { type: 'node.insert', owner: home, parentId: stack, primitive: 'heading', text: 'Mara Ellison' },
    { type: 'node.insert', owner: home, parentId: stack, primitive: 'paragraph', text: 'Lead architect.' }
  ],
  'Fill card'
);
await apply([{ type: 'component.createFromNode', owner: home, nodeId: stack, name: 'Team member card' }], 'Create component');
st = await snapshot();
const card = Object.values(st.components).find((d) => d.owner === 'project' && d.name === 'Team member card');
if (!card) throw new Error('the card component was not created');
const [{ nodeId: section2 }] = await apply([{ type: 'node.insert', owner: about, parentId: null, componentId: 'layout.section' }], 'Insert Section');
const [{ nodeId: rowNode }] = await apply([{ type: 'node.insert', owner: about, parentId: section2, slot: 'content', primitive: 'row' }], 'Insert Row');
await apply(
  [
    { type: 'node.insert', owner: about, parentId: rowNode, definitionId: card.id },
    { type: 'node.insert', owner: about, parentId: rowNode, definitionId: card.id }
  ],
  'Insert cards'
);
await apply([{ type: 'component.createFromNode', owner: about, nodeId: rowNode, name: 'Team row' }], 'Create component');
// A code component that another code component imports.
await apply([{ type: 'component.createCode', name: 'Newsletter signup', description: 'Collects an email address.', source: '<section><h2>The monthly letter</h2><form><input placeholder="Email" /><button>Sign up</button></form></section>\n' }], 'Create Newsletter signup');
st = await snapshot();
const letter = Object.values(st.components).find((d) => d.owner === 'project' && d.name === 'Newsletter signup');
const file = letter.sourcePath.split('/').pop();
try {
  await apply([{ type: 'component.createCode', name: 'Footer signup band', description: 'The letter in a band.', source: `<script>\n  import Signup from './${file}';\n</script>\n<div class="band"><Signup /></div>\n` }], 'Create Footer signup band');
} catch (e) {
  console.log('dependent code component not made:', String(e).slice(0, 200));
}

const rail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(400);
};
await escape(2);
await rail('Insert');

// ---- The manage menu: where a component is used, including the places that can't be gone to ----
const manage = (name) => panel.getByRole('button', { name: `Manage ${name}`, exact: true });
await manage('Team member card').click();
await waitMenu();
await shot('manage-used', '[aria-label="Manage Team member card"]', { themes: BOTH });
await escape();
// The pointer resting on a place that is only a fact.
await manage('Team member card').click();
await waitMenu();
const inRow = menuEl.getByText(/^In Team row$/).first();
await inRow.hover();
await pause(250);
await shot('manage-hover-fact', '[aria-label="Manage Team member card"]', { themes: ['light'], keepPointer: true });
await escape();
// The keyboard walking down from the top: where the arrows stop.
await manage('Team member card').focus();
await win.keyboard.press('Enter');
await waitMenu();
for (let i = 0; i < 7; i++) await win.keyboard.press('ArrowDown'), await pause(60);
await pause(200);
console.log('arrowed to:', await win.evaluate(() => document.activeElement?.textContent));
await shot('manage-keys', '[aria-label="Manage Team member card"]', { themes: ['light'], keepPointer: true });
await escape();
if (await manage('Newsletter signup').count()) {
  await manage('Newsletter signup').click();
  await waitMenu();
  await shot('manage-code', '[aria-label="Manage Newsletter signup"]', { themes: ['light'] });
  await escape();
}

// ---- Toolbar triggers, open ----
await win.locator('.toolbar .project-title').click();
await waitMenu();
await shot('toolbar-project', '.toolbar .project-title');
await escape();
if (await win.locator('.toolbar .zoom-btn').isEnabled().catch(() => false)) {
  await win.locator('.toolbar .zoom-btn').click();
  await waitMenu();
  await shot('toolbar-zoom', '.toolbar .zoom-btn', { themes: ['light'] });
  await escape();
}

// The sidebar's split grip opens a width menu: it keeps its own open mark, not a button's.
if (await win.locator('.split-grip').first().isVisible().catch(() => false)) {
  await win.locator('.split-grip').first().click();
  await waitMenu();
  await shot('split-grip', '.split-grip', { themes: ['light'] });
  await escape();
}

// ---- A live session, as a guest: who is where ----
const hostState = await snapshot();
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await pause(600);
await clearNotices();
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
async function remote(patch) {
  await app.evaluate((_m, p) => {
    const base = globalThis.__joinState.phase === 'idle' ? {} : globalThis.__joinState;
    globalThis.__joinState = { ...base, ...p };
    globalThis.__joinSend('remote:state', globalThis.__joinState);
  }, patch);
  await pause(300);
}
const presence = (p) => app.evaluate((_m, v) => globalThis.__joinSend('remote:presence', { ...v, joinId: globalThis.__joinState.joinId }), p);
const MIN = 60_000;
const now = Date.now();
await app.evaluate((_m, state) => {
  globalThis.__joinHost = { revision: 1, state, readOnly: false, aiBusy: false, runtime: { state: 'starting' } };
}, hostState);
await win.evaluate(() => window.dispatchEvent(new CustomEvent('builder-command', { detail: 'join-live' })));
await win.locator('.modal .join-live').waitFor();
await win.locator('.modal input').nth(0).fill(INVITE);
await win.locator('.modal input').nth(1).fill('Ann Whitaker');
await win.locator('.modal').getByRole('button', { name: 'Ask to join' }).click();
await pause(300);
await remote({
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
  ]
});
await win.waitForSelector('.editor .toolbar .remote-pill');
await pause(800);
const mine = await win.evaluate(() => document.querySelector('.side-panel .list [aria-current="page"], .side-panel .list .selected')?.textContent ?? null);
console.log('guest page row:', mine);
const where = (g2Page) => ({ host: { pageId: hostState.site.homePageId ?? pageIds[0], viewportWidth: 1280, selection: null, previewPath: '/' }, guests: { g2: { pageId: g2Page, viewportWidth: 1280, selection: null, previewPath: '/' } } });
await presence(where(pageIds[2] ?? pageIds[1]));
await pause(400);
const pill = '.toolbar .remote-pill';
await win.locator(pill).click();
await waitMenu();
await shot('live-roster', pill);
// Someone moves while the menu is up: the menu says where they are now.
await presence(where(hostState.site.homePageId ?? pageIds[0]));
await pause(500);
await shot('live-moved', pill, { themes: ['light'] });
console.log('pill aria-expanded while open, after a re-render:', await win.locator(pill).getAttribute('aria-expanded'));
await escape();
await presence(where(pageIds[2] ?? pageIds[1]));
await pause(400);
// Opened from the keyboard and walked with Down: the facts are read, not stopped on.
await win.locator(pill).focus();
await win.keyboard.press('Enter');
await waitMenu();
await win.keyboard.press('ArrowDown');
await pause(250);
console.log('live arrowed to:', await win.evaluate(() => document.activeElement?.textContent));
await shot('live-keys', pill, { themes: ['light'], keepPointer: true });
// Someone joins while focus is on Leave session: focus stays on it.
await win.keyboard.press('End');
await pause(150);
await remote({ participants: [{ guestId: 'g1', displayName: 'Ann Whitaker', role: 'collaborator' }, { guestId: 'g2', displayName: 'Mo Haddad', role: 'collaborator' }, { guestId: 'g3', displayName: 'Quill', role: 'viewer' }, { guestId: 'g4', displayName: 'Rua Tane', role: 'viewer' }] });
await pause(400);
const after = await win.evaluate(() => document.activeElement?.textContent ?? '');
console.log('focus after a join:', after);
if (!/Leave session/.test(after)) throw new Error(`focus left Leave session when someone joined (now on "${after}")`);
await shot('live-joined', pill, { themes: ['light'], keepPointer: true });
await escape();

await app.close();
rmSync(WORK, { recursive: true, force: true });
if (errors.length) console.log('page errors:', errors.join('\n'));
const onDisk = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const missing = written.filter((p) => !onDisk.includes(p.split('/').pop()));
if (missing.length) throw new Error(`captures missing on disk: ${missing.join(', ')}`);
console.log(`DONE ${written.length} captures in ${OUT}`);
