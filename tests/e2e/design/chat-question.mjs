// Design capture harness for the AI panel's question card and its pictures: the card a waiting run shows above the
// composer (a yes-or-no that widens the request, a list of options, a grid of library pictures), a picture's larger
// preview, and the picture chips on a request, an answer and the composer. Opt-in only, never part of
// `npm run test:e2e`, and it never calls a real provider:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/chat-question.mjs
//
// History is seeded through the project's own chat storage before the project opens, and the waiting question is
// pushed through the same `ai:event` channel the agent uses. Each capture is verified on screen after it settles;
// a state that did not render throws instead of writing an image. Files are `q-{state}--{theme}.png`: the dock,
// or the whole window for the preview dialog.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('question card capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'chat-question');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-q-')));
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

/** Capture the dock (or the window) in each theme; `check` must be visible at the moment of capture. */
async function shot(state, check, { themes = THEMES, full = false, keep = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keep) await win.mouse.move(700, 450);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const path = join(OUT, `q-${state}--${theme}.png`);
    if (full) await win.screenshot({ path });
    else await win.locator('.dock').screenshot({ path });
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

// ---- A project to work in ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);

const snap = await win.evaluate(() => window.builder.project.snapshot());
const home = snap.state.pages[snap.state.site.homePageId];
const lib = Object.values(snap.state.assets.assets).filter((a) => a.kind === 'image').slice(0, 4);
if (lib.length < 4) throw new Error('the sample project has fewer than four images to offer');
const ref = (a) => ({ assetId: a.id, name: a.name });
// A picture that has since left Assets: the request and the offer still name it.
const gone = { assetId: 'a_gonehero01', name: 'old-hero-kitchen.jpg' };
const [{ dir: projectDir }] = await win.evaluate(() => window.builder.projects.recents());
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');

// ---- Seed a conversation: a request with pictures, and a turn whose question was answered with one ----
const t = (min) => new Date(Date.UTC(2026, 10, 20, 9, min)).toISOString();
const ctx = (page, selectionLabel = null) => ({ pageId: page.id, pageTitle: page.title, selection: null, selectionLabel, viewport: 1280 });
const done = (id, label) => ({ id, label, status: 'done' });
const MODEL = { provider: 'openai', id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' };
const convId = 'c_seedq';
const conversation = {
  id: convId,
  title: 'Use these photos in the gallery',
  createdAt: t(1),
  messages: [
    { id: 'm_u1', role: 'user', text: 'Use these photos in the gallery, the kitchen one first', time: t(2), context: ctx(home, 'Gallery'), runId: 'r_s1', images: [ref(lib[0]), ref(lib[1]), gone] },
    {
      id: 'm_a1',
      role: 'assistant',
      text: 'I put the two photos that are still in Assets into the gallery, with the one you chose first.',
      time: t(3),
      runId: 'r_s1',
      model: MODEL,
      activities: [done('a1', `Reading ${home.title}`), done('a2', 'Inspecting the selected element'), done('a3', 'Updating content'), done('a4', 'Checking the result')],
      questions: [{ id: 'q_s1', text: 'The kitchen photo is no longer in Assets. Which photo should go first instead?', choices: ['Keep the current order'], images: [ref(lib[0]), ref(lib[1])], answered: lib[1].name, answeredAssetId: lib[1].id }],
      result: { status: 'completed', summary: 'I put the two photos that are still in Assets into the gallery, with the one you chose first.', changes: [{ label: `Edited Gallery content on ${home.title}`, pageId: home.id }], validation: ['Project structure, links and references are valid.'], canUndo: true }
    }
  ]
};
const chatDir = join(projectDir, '.siteorigin', 'sessions', 'chat');
mkdirSync(chatDir, { recursive: true });
writeFileSync(join(chatDir, `${convId}.json`), JSON.stringify(conversation));

await win.evaluate(() => window.builder.ai.setKey('openai', 'sk-design-capture-not-a-real-key'));
await win.reload();
await win.waitForSelector('.recent-card');
await win.locator('.recent-card', { hasText: 'Harbour Lane Studio' }).click();
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await openAiTab();
await win.locator('.chat-log .msg-user .image-chip').first().waitFor({ timeout: 15000 });
// The pictures load from the local preview; wait until they have.
await win.waitForFunction(() => [...document.querySelectorAll('.chat-log .image-chip img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
await pause(400);
// A request's pictures (one no longer in Assets) and an answer given with a picture.
await shot('log-chips', '.chat-log .answered-image .image-chip');
// A chip opens its picture larger, with its size and description, and nothing to choose.
await win.locator('.chat-log .msg-user button.image-chip-open').first().click();
await win.getByRole('dialog').waitFor();
await win.waitForFunction(() => { const i = document.querySelector('[role="dialog"] img'); return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 30000 });
await pause(300);
await shot('chip-preview', '[role="dialog"] img', { themes: ['light'], full: true, keep: true });
await win.keyboard.press('Escape');
await win.getByRole('dialog').waitFor({ state: 'detached' });
await pause(200);

// Pictures attached to the next message, through the Assets panel's own action.
await win.getByRole('button', { name: 'Assets', exact: true }).click();
await pause(300);
for (const image of lib.slice(0, 2)) {
  await win.locator(`[data-asset="${image.id}"]`).click();
  await pause(200);
  await win.getByRole('button', { name: 'Use in AI chat' }).click();
  await pause(300);
  await win.locator('.asset-back').click();
  await pause(200);
}
await openAiTab();
const ta = win.getByRole('textbox', { name: 'Message' });
await ta.fill('Swap the second gallery photo for these two');
await pause(400);
await shot('composer-chips', '.composer .image-chip');
await ta.fill('');
while (await win.locator('.composer .image-chip-remove').count()) {
  await win.locator('.composer .image-chip-remove').first().click();
  await pause(120);
}
await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

// ---- A run that stops to ask ----
const runId = 'r_live';
const liveUser = { id: 'm_lu', role: 'user', text: 'Make the hero heading shorter and more confident', time: t(58), context: ctx(home, 'Heading'), runId };
const liveAi = { id: 'm_la', role: 'assistant', text: '', time: t(58), runId, model: MODEL, activities: [] };
await emit({ runId, conversationId: convId, kind: 'status', status: 'running' });
await emit({ runId, conversationId: convId, kind: 'message', message: liveUser });
await emit({ runId, conversationId: convId, kind: 'message', message: liveAi });
await emit({ runId, conversationId: convId, kind: 'status', status: 'awaiting-input' });
const ask = async (question) => {
  await emit({
    runId,
    conversationId: convId,
    kind: 'message',
    message: { ...liveAi, activities: [done('l1', `Reading ${home.title}`), done('l2', 'Inspecting the selected element'), { id: 'l4', label: 'Waiting for your answer', status: 'running' }], questions: [question] }
  });
  await pause(400);
};

// A yes-or-no that widens the request to the whole site.
await ask({ id: 'q_widen', text: 'The shorter heading reads better without the small line above it. Can I change things outside the heading?', choices: ['Yes, allow changes across the whole site', 'No, only change the selection'], widen: true });
await shot('widen', '.question-card >> text=Can I change things outside the heading');

// Several written options.
await ask({ id: 'q_tone', text: 'Which direction should the new heading take?', choices: ['Warm and personal: “Homes that feel like yours”', 'Confident and short: “Interiors, done properly”', 'Lead with the service: “Interior design for family homes in Auckland”', 'Keep the current heading'] });
await shot('choices', '.question-card .choice');

// Pictures from the library, one of which has since left Assets, and a written option.
await ask({ id: 'q_image', text: 'Which photo should lead the hero?', choices: ['Keep the current photo'], images: [...lib.slice(0, 3).map(ref), gone] });
await win.waitForFunction(() => [...document.querySelectorAll('.question-card img')].length >= 3 && [...document.querySelectorAll('.question-card img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
await pause(300);
await shot('images', '.question-card .image-choice');
// Hover on a picture, so its hover treatment is reviewed too.
await win.locator('.question-card .image-choice').first().hover();
await shot('images-hover', '.question-card .image-choice', { themes: ['light'], keep: true });
// Keyboard focus on the first picture.
await win.locator('.question-card .image-choice button').first().focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await shot('images-focus', '.question-card :focus-visible', { themes: ['light'], keep: true });
await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
// At the dock's narrowest.
await setDockWidth(300);
await shot('images-narrow', '.question-card .image-choice');
await setDockWidth(340);

// A picture's larger preview.
await win.locator('.question-card .image-choice').first().locator('button').first().click();
await win.getByRole('dialog').waitFor();
await win.waitForFunction(() => { const i = document.querySelector('[role="dialog"] img'); return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 30000 });
await pause(300);
await shot('preview', '[role="dialog"] img', { full: true, keep: true });
await win.keyboard.press('Escape');
await pause(300);

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.startsWith('q-') && f.endsWith('.png')).length;
console.log(`question card capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
