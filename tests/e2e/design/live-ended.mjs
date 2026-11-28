// Design capture harness for a guest whose live session ends without them choosing it (#1462): the host ends the
// session, removes them, or their timed access runs out, while text they typed is still on its way. Each ending is
// reached from the remote shell with that text in hand: a held edit (the field changed at the host while they typed)
// beside a field still being typed in, a field being typed in alone, a long multi-line draft, and nothing typed at all.
// Captures Welcome as the guest lands on it, a moment later, the notices' band close up, and Copy text pressed.
//
// Guest states are pushed through the editor's own `remote:state` and `remote:changed` channels, and the main
// process's `remote:*` handlers are replaced with stubs that answer as the relay would (as design/join-live.mjs does),
// so no relay is needed. Drives the real (built) app, in light and dark. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/live-ended.mjs
//
// Every capture is checked on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('live ended capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'live-ended');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-ended-')));
const BOTH = ['light', 'dark'];
const W = 1440;
const H = 900;
const INVITE = 'https://live.siteorigin.com/s/r7kq2mxa9pzt4hn8wbc3vdfe';
const ENDINGS = {
  ended: 'The host ended the live session.',
  kicked: 'The host removed you from the live session.',
  'expired-guest': 'Your access to the live session has ended.'
};

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

/** The window, or the notices' band at the bottom of it (every notice, with room around it). */
async function region(name) {
  if (name === 'window') return undefined;
  if (name === 'notices') {
    const boxes = await win.locator('.toasts .toast').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, r: r.right, b: r.bottom })));
    if (!boxes.length) throw new Error('no notices to crop');
    const pad = 32;
    const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
    const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
    const right = Math.min(W, Math.max(...boxes.map((b) => b.r)) + pad);
    const bottom = Math.min(H, Math.max(...boxes.map((b) => b.b)) + pad);
    return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
  }
  throw new Error(`unknown region ${name}`);
}

/** Capture a state; `check` must be visible at the moment of capture. `freeze` stops the clock on notices first. */
async function shot(state, check, { themes = BOTH, area = 'window', keepPointer = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keepPointer) await win.mouse.move(W / 2, 120);
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

async function clearNotices() {
  for (let i = 0; i < 12; i++) {
    const b = win.locator('.toasts .toast-dismiss, .toasts .toast.held button:text-is("Discard")').first();
    if (!(await b.isVisible().catch(() => false))) return;
    await b.click();
    await pause(150);
  }
}

// ---- The relay, as the main process would answer for it ----
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
  // An edit sent while `__applyHold` is set waits for an answer the host never gives: the session ends first.
  globalThis.__applyHold = false;
  globalThis.__applyWaiting = [];
  ipcMain.handle('remote:apply', () => {
    const refused = { ok: false, error: { code: 'CANCELLED', message: 'Not in a capture.', recoverable: false } };
    if (!globalThis.__applyHold) return refused;
    return new Promise((resolve) => globalThis.__applyWaiting.push(() => resolve({ ok: false, error: { code: 'CANCELLED', message: 'The live session ended.', recoverable: false } })));
  });
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

/** The session ends the way `reason` says, as the main process tells the editor. */
async function endAs(reason) {
  await app.evaluate((_m, ended) => {
    globalThis.__joinState = { phase: 'idle', ended };
    globalThis.__joinSend('remote:state', globalThis.__joinState);
    // What was waiting for the host is answered as the main process answers it once the join has ended.
    globalThis.__applyHold = false;
    for (const answer of globalThis.__applyWaiting.splice(0)) answer();
  }, { reason, message: ENDINGS[reason] });
  await win.locator('.welcome').waitFor();
  await pause(400);
  const state = await win.evaluate(() => window.builder.remote.state());
  if (state.phase !== 'idle' || state.ended?.reason !== reason) throw new Error(`the session did not end as ${reason}: ${JSON.stringify(state)}`);
}

const MIN = 60_000;
const admitted = () => ({
  phase: 'admitted',
  hostConnected: true,
  reconnecting: false,
  guestId: 'g1',
  role: 'collaborator',
  projectName: 'Harbour Lane Studio',
  guestExpiresAt: null,
  sessionExpiresAt: Date.now() + 102 * MIN,
  relayClockOffsetMs: 0,
  hostRuntime: 'starting',
  previewRevision: null,
  previewUrl: null,
  previewProblem: null,
  tooLarge: false,
  participants: [
    { guestId: 'g1', displayName: 'Ann Whitaker', role: 'collaborator' },
    { guestId: 'g2', displayName: 'Mo Haddad', role: 'collaborator' }
  ]
});

// ---- A project of this computer's: its documents stand in for the host's, and it shows in Welcome's recents ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: false }), sites);
await win.waitForSelector('.editor');
await pause(2500);
const hostState = await win.evaluate(async () => (await window.builder.project.snapshot()).state);
const homeId = hostState.site.homePageId;
const homePage = hostState.pages[homeId];
const heroId = homePage.rootIds.find((id) => homePage.nodes[id].kind === 'instance' && hostState.components[homePage.nodes[id].definitionId]?.name === 'Split hero');
if (!heroId) throw new Error('the Business Home page has no Split hero');
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await pause(600);
await clearNotices();

/** The host's project at `revision`, with the hero's heading set to `heading` when given. */
const hostAt = (revision, heading) => {
  const state = structuredClone(hostState);
  if (heading !== undefined) state.pages[homeId].nodes[heroId].props.heading = heading;
  return { revision, state, readOnly: false, aiBusy: false, runtime: { state: 'starting' } };
};

/** Join from Welcome and come in as a collaborator, with the Split hero selected in the Inspector. */
async function joinAndSelectHero() {
  await app.evaluate((_m, host) => (globalThis.__joinHost = host), hostAt(1));
  await win.evaluate(() => window.dispatchEvent(new CustomEvent('builder-command', { detail: 'join-live' })));
  await win.locator('.modal .join-live').waitFor();
  const dialog = win.locator('.modal');
  await dialog.locator('input').nth(0).fill(INVITE);
  await dialog.locator('input').nth(1).fill('Ann Whitaker');
  await dialog.getByRole('button', { name: 'Ask to join' }).click();
  await pause(300);
  await remote(admitted());
  await win.waitForSelector('.editor .toolbar .remote-pill');
  await pause(800);
  await win.locator('.rail [aria-label="Layers"]').click();
  await win.locator('.list-item', { hasText: 'Split hero' }).first().click();
  const tab = win.locator('#dock-tab-inspect');
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await win.locator('#dock-panel-inspect').waitFor();
  await pause(400);
  return win.locator('#dock-panel-inspect');
}

/** The Inspector's text fields for the hero: its Heading, and one other single-line field and one multi-line one. */
async function heroFields(panel) {
  const heading = panel.getByRole('textbox', { name: 'Heading', exact: true });
  await heading.waitFor();
  const others = await panel.locator('input[type="text"], input:not([type]), textarea').evaluateAll((els) =>
    els.map((el, i) => ({ i, tag: el.tagName, label: (el.labels?.[0]?.textContent ?? el.getAttribute('aria-label') ?? '').trim(), visible: !!el.offsetParent }))
  );
  const line = others.find((o) => o.visible && o.tag === 'INPUT' && o.label && !/^Heading$/.test(o.label));
  const area = others.find((o) => o.visible && o.tag === 'TEXTAREA' && o.label);
  const all = panel.locator('input[type="text"], input:not([type]), textarea');
  return { heading, line: line ? all.nth(line.i) : null, lineLabel: line?.label ?? null, area: area ? all.nth(area.i) : null, areaLabel: area?.label ?? null };
}

const recovered = () => win.locator('.toasts').innerText().catch(() => '');

// ---- 1. The host ends the session: a held edit, and a field still being typed in ----
{
  const panel = await joinAndSelectHero();
  const f = await heroFields(panel);
  // The guest types a new heading; the host's heading changes meanwhile; leaving the field holds both versions.
  await f.heading.click();
  await f.heading.fill('Copy desk suggestion: bring your spare radio valves.');
  await app.evaluate((_m, { host, joinId }) => {
    globalThis.__joinHost = host;
    globalThis.__joinSend('remote:changed', { joinId, snapshot: host });
  }, { host: hostAt(2, 'Good things are worth fixing.'), joinId: (await win.evaluate(() => window.builder.remote.state())).joinId });
  await pause(600);
  await f.heading.press('Tab');
  await win.locator('.toasts .toast.held').waitFor({ timeout: 10000 });
  // A second field, typed in and still focused as the session ends.
  const second = f.line ?? f.area;
  if (!second) throw new Error('the hero has no second text field to type in');
  await second.click();
  await second.fill('Open Saturdays 9 till 1, workshop at the back.');
  await pause(400);
  await shot('guest-before-end', '.toasts .toast.held', { themes: ['light'], keepPointer: true });
  await endAs('ended');
  await shot('ended-host', '.welcome', { keepPointer: true });
  if ((await win.locator('.toasts .toast').count()) > 0) await shot('ended-host-notices', '.toasts .toast', { keepPointer: true, area: 'notices' });
  console.log('notices after the host ended it:', JSON.stringify(await recovered()));
  // A moment later: what is still on offer once a status notice would have gone.
  await pause(5500);
  await shot('ended-host-later', '.welcome', { themes: ['light'] });
  console.log('notices a moment later:', JSON.stringify(await recovered()));
  const copy = win.locator('.toasts button', { hasText: 'Copy text' }).first();
  if (await copy.isVisible().catch(() => false)) {
    await copy.focus();
    await win.keyboard.press('Enter');
    await pause(300);
    await shot('ended-host-copied', '.toasts .toast', { themes: ['light'], keepPointer: true, area: 'notices' });
  } else console.log('no Copy text on offer after the host ended the session');
  // The guest opens a project of their own meanwhile: what is still on offer over it.
  await win.locator('.welcome .recent-card').first().click();
  await win.waitForSelector('.editor .toolbar');
  await pause(2500);
  await shot('ended-then-open', '.editor .toolbar', { themes: ['light'] });
  console.log('notices over the next project:', JSON.stringify(await recovered()));
  await win.evaluate(() => window.builder.projects.close());
  await win.waitForSelector('.welcome');
  await pause(600);
  await clearNotices();
}

// ---- 2. The guest's access runs out with a field being typed in ----
{
  const panel = await joinAndSelectHero();
  const f = await heroFields(panel);
  await f.heading.click();
  await f.heading.fill('Repairs while you wait, most days');
  await pause(400);
  await endAs('expired-guest');
  await shot('ended-expired', '.welcome', { keepPointer: true });
  console.log('notices after access ran out:', JSON.stringify(await recovered()));
  await pause(5500);
  await shot('ended-expired-later', '.welcome', { themes: ['light'] });
  await clearNotices();
}

// ---- 3. The host removes the guest from a long multi-line draft ----
{
  const panel = await joinAndSelectHero();
  const f = await heroFields(panel);
  const field = f.area ?? f.line;
  await field.click();
  await field.fill(
    'We fix radios, record players, valve amplifiers and the odd sewing machine. Bring it in, tell us what it used to do, and we will tell you honestly whether it is worth saving before we start.\nMost repairs are back with you within a fortnight, and every one comes with a six-month guarantee on the work.'
  );
  await pause(400);
  await endAs('kicked');
  await shot('ended-removed-long', '.welcome', { keepPointer: true });
  if ((await win.locator('.toasts .toast').count()) > 0) await shot('ended-removed-long-notices', '.toasts .toast', { themes: ['light'], keepPointer: true, area: 'notices' });
  // Discard from the keyboard on the only card: where focus goes once nothing is left to copy.
  const discard = win.locator('.toasts .toast.held button', { hasText: 'Discard' }).first();
  if (await discard.isVisible().catch(() => false)) {
    await discard.focus();
    await win.keyboard.down('Enter');
    await pause(120);
    await win.keyboard.up('Enter');
    await pause(400);
    const at = await win.evaluate(() => {
      const el = document.activeElement;
      return el && el !== document.body ? `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}"` : 'the page itself';
    });
    console.log('focus after discarding the last card:', at);
    await shot('ended-removed-discarded', '.welcome', { themes: ['light'], keepPointer: true });
  }
  await clearNotices();
}

// ---- 5. The access runs out just as an edit is on its way to the host ----
{
  const panel = await joinAndSelectHero();
  const f = await heroFields(panel);
  await app.evaluate(() => (globalThis.__applyHold = true));
  await f.heading.click();
  await f.heading.fill('Bring it in, we will tell you straight');
  await f.heading.press('Tab');
  await pause(500);
  await endAs('expired-guest');
  await shot('ended-in-flight', '.welcome', { themes: ['light'], keepPointer: true });
  if ((await win.locator('.toasts .toast').count()) > 0) await shot('ended-in-flight-notices', '.toasts .toast', { themes: ['light'], keepPointer: true, area: 'notices' });
  console.log('notices for an edit on its way:', JSON.stringify(await recovered()));
  await clearNotices();
}

// ---- 4. The host ends the session with nothing typed: the ending alone ----
{
  await joinAndSelectHero();
  await endAs('ended');
  await shot('ended-clean', '.welcome', { themes: ['light'] });
  console.log('notices with nothing typed:', JSON.stringify(await recovered()));
  await clearNotices();
}

// ---- 6. The host removes the section being typed in, then ends the session ----
{
  const panel = await joinAndSelectHero();
  const f = await heroFields(panel);
  const field = f.line ?? f.area;
  await field.click();
  await field.fill('Ask about our valve testing day');
  await pause(300);
  const gone = structuredClone(hostState);
  gone.pages[homeId].rootIds = gone.pages[homeId].rootIds.filter((id) => id !== heroId);
  delete gone.pages[homeId].nodes[heroId];
  await app.evaluate((_m, { host, joinId }) => {
    globalThis.__joinHost = host;
    globalThis.__joinSend('remote:changed', { joinId, snapshot: host });
  }, { host: { revision: 3, state: gone, readOnly: false, aiBusy: false, runtime: { state: 'starting' } }, joinId: (await win.evaluate(() => window.builder.remote.state())).joinId });
  await win.locator('.toasts .toast.error').first().waitFor({ timeout: 10000 });
  await pause(300);
  await shot('field-gone-offer', '.toasts .toast.error', { themes: ['light'], keepPointer: true, area: 'notices' });
  const offer = win.locator('.toasts .toast.error button', { hasText: 'Copy text' }).first();
  if (await offer.isVisible().catch(() => false)) {
    await offer.click();
    await pause(300);
    await shot('field-gone-offer-copied', '.toasts .toast.error', { themes: ['light'], keepPointer: true, area: 'notices' });
  }
  await endAs('ended');
  await shot('ended-field-gone', '.welcome', { themes: ['light'], keepPointer: true });
  console.log('notices after the field went and the host ended it:', JSON.stringify(await recovered()));
  await clearNotices();
}

await app.close();
rmSync(WORK, { recursive: true, force: true });
if (errors.length) console.log('page errors:', errors.join('\n'));
const onDisk = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const missing = written.filter((p) => !onDisk.includes(p.split('/').pop()));
if (missing.length) throw new Error(`captures missing on disk: ${missing.join(', ')}`);
console.log(`DONE ${written.length} captures in ${OUT}`);
