// Design capture harness for the AI composer: the box at the foot of the AI panel where a request is written, with
// what it applies to, Edit or Ask, the model, images, and Send. Opt-in only, never part of `npm run test:e2e`, and it
// never calls a real provider:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/ai-composer.mjs
//
// Each capture is verified on screen after it settles; a state that did not render throws instead of writing an
// image. Files are `composer-{state}--{theme}.png`: the foot of the dock from just above the composer (and whatever
// sits on it: the run strip, a waiting question) to the window's edge, plus `composer-dock--{theme}.png`, the whole
// panel for context.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('AI composer capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'ai-composer');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-composer-')));
const THEMES = ['light', 'dark'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
const pause = (ms) => win.waitForTimeout(ms);
await win.waitForSelector('.welcome');
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.unmaximize();
  w.setContentSize(1440, 900);
});
await pause(600);
const size = await win.evaluate(() => [innerWidth, innerHeight]);
if (size[0] !== 1440 || size[1] !== 900) throw new Error(`window is ${size.join('x')}, expected 1440x900`);
const frame = win.frameLocator('.frame-box iframe');
const written = [];

await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** The foot of the dock: from 12px above the highest of the composer and what sits on it, down to the window's edge. */
async function footClip() {
  const dock = await win.locator('.dock').boundingBox();
  let top = Infinity;
  for (const sel of ['.chat .composer', '.chat .run-strip', '.chat .question-card', '.chat > .scope-note', '.menu']) {
    const loc = win.locator(sel);
    for (let i = 0; i < (await loc.count()); i++) {
      if (!(await loc.nth(i).isVisible())) continue;
      const b = await loc.nth(i).boundingBox();
      if (b) top = Math.min(top, b.y);
    }
  }
  if (!Number.isFinite(top)) throw new Error('no composer on screen');
  const y = Math.max(dock.y, top - 12);
  return { x: dock.x, y, width: dock.width, height: dock.y + dock.height - y };
}

/** Capture in each theme; `check` must be visible at the moment of capture. `keep` leaves the pointer and focus alone. */
async function shot(state, check, { themes = THEMES, dock = false, keep = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keep) await win.mouse.move(700, 450);
    await pause(150);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `composer-${state}--${theme}.png`);
    if (dock) await win.locator('.dock').screenshot({ path });
    else await win.screenshot({ path, clip: await footClip() });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

async function emit(e) {
  await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('ai:event', ev), e);
  await pause(120);
}
const openAiTab = async () => {
  await win.locator('.dock-tab', { hasText: 'AI' }).click();
  await pause(300);
};
async function setDockWidth(width) {
  const box = await win.locator('.dock').boundingBox();
  const handle = await win.locator('.seam.right .resizer').boundingBox();
  const y = handle.y + handle.height / 2;
  await win.mouse.move(handle.x + handle.width / 2, y);
  await win.mouse.down();
  await win.mouse.move(handle.x + handle.width / 2 + (box.width - width), y, { steps: 6 });
  await win.mouse.up();
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await win.mouse.move(10, 10);
  await pause(250);
  const now = (await win.locator('.dock').boundingBox()).width;
  if (Math.abs(now - width) > 2) throw new Error(`dock is ${now}px wide, expected ${width}`);
}
const blur = () => win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

// ---- A project to work in, with a provider connected (a placeholder key; nothing is ever sent) ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
const snap = await win.evaluate(() => window.builder.project.snapshot());
const home = snap.state.pages[snap.state.site.homePageId];
const libraryImages = Object.values(snap.state.assets.assets).filter((a) => a.kind === 'image').slice(0, 2);
if (libraryImages.length < 2) throw new Error('the sample project has fewer than two images to attach');
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.ai.setKey('openai', 'sk-design-capture-not-a-real-key'));
await win.reload();
await win.waitForSelector('.recent-card');
await win.locator('.recent-card', { hasText: 'Harbour Lane Studio' }).click();
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await openAiTab();
await pause(400);

const ta = win.getByRole('textbox', { name: 'Message' });

// Nothing selected: the request applies to the page.
await shot('page', '.chat .composer');

// An element selected (the state the composer is most often in).
await frame.locator('h1').first().click();
await pause(500);
await frame.locator('h1').first().click();
await pause(700);
await openAiTab();
await blur();
await shot('selection', '.chat .composer');
await shot('dock', '.chat .composer', { dock: true });

// Clicked into, before typing.
await ta.click();
await pause(200);
await shot('focused', '.chat textarea:focus', { keep: true });

// A draft long enough to wrap.
await ta.pressSequentially('Make this heading shorter and more confident, and keep the line about family-run. Use sentence case and no exclamation marks.', { delay: 0 });
await pause(300);
await shot('draft', '.chat textarea:focus', { keep: true });
await ta.fill('');
await blur();

// What the message applies to, its menu open.
await win.locator('.composer .scope-chip').click();
await pause(300);
await shot('scope-menu', '.menu [role="menuitemradio"]', { keep: true });
// The whole site, in the house's site-wide hue.
await win.locator('.menu [role="menuitemradio"]', { hasText: 'Whole site' }).click();
await pause(250);
await blur();
await shot('site', '.composer .scope-chip.site');
await win.locator('.composer .scope-chip').click();
await pause(300);
await win.locator('.menu [role="menuitemradio"]').first().click();
await pause(250);
await blur();

// Ask: a read-only question, chosen from the mode menu.
await win.locator('.composer .composer-mode').click();
await pause(300);
await shot('mode-menu', '.menu [role="menuitemradio"]', { keep: true });
await win.locator('.menu [role="menuitemradio"]', { hasText: 'Ask' }).click();
await pause(250);
await blur();
await shot('ask', '.composer .composer-mode >> text=Ask');
await win.locator('.composer .composer-mode').click();
await pause(300);
await win.locator('.menu [role="menuitemradio"]', { hasText: 'Edit' }).click();
await pause(250);
await blur();

// Library images attached, through the Assets panel's own action.
await win.getByRole('button', { name: 'Assets', exact: true }).click();
await pause(300);
for (const image of libraryImages) {
  await win.locator(`[data-asset="${image.id}"]`).click();
  await pause(200);
  await win.getByRole('button', { name: 'Use in AI chat' }).click();
  await pause(300);
  await win.locator('.asset-back').click();
  await pause(200);
}
await openAiTab();
await ta.fill('Use these two photos in the gallery, with the wider one first');
await pause(300);
await blur();
await shot('images', '.composer .image-chip');
await ta.fill('');
while (await win.locator('.composer .image-chip button').count()) {
  await win.locator('.composer .image-chip button').first().click();
  await pause(120);
}
await blur();

// Narrow dock, element selected.
await setDockWidth(300);
await shot('narrow', '.chat .composer');
await setDockWidth(340);

// A run in progress: the strip sits on the composer, which keeps a draft for afterwards.
const convId = (await win.evaluate(() => window.builder.ai.conversations())).active.id;
const runId = 'r_live';
const t = new Date(Date.UTC(2026, 10, 20, 9, 58)).toISOString();
const ctx = { pageId: home.id, pageTitle: home.title, selection: null, selectionLabel: 'Heading', viewport: 1280 };
const liveUser = { id: 'm_lu', role: 'user', text: 'Make the hero heading shorter and more confident', time: t, context: ctx, runId };
const liveAi = { id: 'm_la', role: 'assistant', text: '', time: t, runId, activities: [], model: { provider: 'openai', id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' } };
const done = (id, label) => ({ id, label, status: 'done' });
await emit({ runId, conversationId: convId, kind: 'status', status: 'running' });
await emit({ runId, conversationId: convId, kind: 'message', message: liveUser });
await emit({ runId, conversationId: convId, kind: 'message', message: { ...liveAi, activities: [done('l1', `Reading ${home.title}`), { id: 'l3', label: 'Updating content', status: 'running' }] } });
await pause(300);
await blur();
await shot('running', '.run-strip >> text=Updating content');

// A question waiting: the composer answers it.
await emit({ runId, conversationId: convId, kind: 'status', status: 'awaiting-input' });
await emit({
  runId,
  conversationId: convId,
  kind: 'message',
  message: {
    ...liveAi,
    activities: [done('l1', `Reading ${home.title}`), { id: 'l4', label: 'Waiting for your answer', status: 'running' }],
    questions: [{ id: 'q_tone', text: 'Should the heading keep “family-run”, or lead with the service area instead?', choices: ['Keep family-run', 'Lead with the service area'] }]
  }
});
await pause(400);
await blur();
await shot('answering', '.question-card');

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.startsWith('composer-') && f.endsWith('.png')).length;
console.log(`AI composer capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
