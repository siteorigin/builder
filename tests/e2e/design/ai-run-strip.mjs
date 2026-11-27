// Design capture harness for the AI run strip: the live status row above the composer while the AI works. Opt-in
// only, never part of `npm run test:e2e`, and it never calls a real provider:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] [DESIGN_ONLY=regex] node tests/e2e/design/ai-run-strip.mjs
//
// Runs are pushed through the same `ai:event` channel the agent uses, into a fresh conversation, so the strip renders
// exactly as a real run draws it. The API key is a placeholder that is never sent anywhere. Each capture is verified on
// screen after it settles; a state that did not render throws instead of writing an image. Files are
// `strip-{state}--{width}--{theme}.png`: the bottom of the dock (the end of the log, the strip and the composer) at the
// display's density, plus one full window for context.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('AI run strip capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'ai-run-strip');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-strip-')));
const ONLY = process.env.DESIGN_ONLY ? new RegExp(process.env.DESIGN_ONLY) : null;

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
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** Drag the dock's edge to a width, and confirm it took. */
async function setDockWidth(width) {
  const box = await win.locator('.dock').boundingBox();
  if (Math.abs(box.width - width) <= 2) return;
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

/**
 * Capture the bottom of the dock: `above` CSS px of whatever sits over the strip (the log, or a question card), the
 * strip, and the composer to the dock's foot. `check` must be visible at the moment of capture.
 */
async function shot(state, check, { widths = [340], themes = ['light', 'dark'], top = '.run-strip', above = 120 } = {}) {
  for (const width of widths) {
    for (const theme of themes) {
      const name = `strip-${state}--${width}--${theme}`;
      if (ONLY && !ONLY.test(name)) continue;
      await setDockWidth(width);
      await setTheme(theme);
      await win.mouse.move(700, 450);
      await pause(200);
      const visible = await win.locator(check).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${name}" did not render "${check}"; refusing to write`);
      const dock = await win.locator('.dock').boundingBox();
      const anchor = await win.locator(top).first().boundingBox();
      const y = Math.max(dock.y, anchor.y - above);
      const path = join(OUT, `${name}.png`);
      await win.screenshot({ path, clip: { x: dock.x, y, width: dock.width, height: dock.y + dock.height - y } });
      written.push(path);
      console.log('wrote', path);
    }
  }
  await setTheme('light');
}

async function emit(e) {
  await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('ai:event', ev), e);
  await pause(120);
}

// ---- A project with a provider connected ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
// The strip needs the editor and the dock, not the preview, so a slow preview never holds a capture.
await win.waitForSelector('.dock');
const snap = await win.evaluate(() => window.builder.project.snapshot());
const pages = Object.values(snap.state.pages);
const home = snap.state.pages[snap.state.site.homePageId];
const contact = pages.find((p) => p.title === 'Contact') ?? home;
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
await win.evaluate(() => window.builder.ai.setKey('openai', 'sk-design-capture-not-a-real-key'));
await win.reload();
await win.waitForSelector('.recent-card');
await win.locator('.recent-card', { hasText: 'Harbour Lane Studio' }).click();
await win.waitForSelector('.editor');
// The strip needs the editor and the dock, not the preview, so a slow preview never holds a capture.
await win.waitForSelector('.dock');
await pause(1200);
await win.locator('.dock-tab', { hasText: 'AI' }).click();
await pause(300);
// A fresh project opens on an empty conversation, which the runs go into.
await win.waitForSelector('.chat-empty');
const convId = (await win.evaluate(() => window.builder.ai.conversations())).active.id;

const t = (min) => new Date(Date.UTC(2026, 10, 20, 9, min)).toISOString();
const ctx = (page, selectionLabel = null, extra = {}) => ({ pageId: page.id, pageTitle: page.title, selection: null, selectionLabel, viewport: 1280, ...extra });
const done = (id, label) => ({ id, label, status: 'done' });
const MODEL = { provider: 'openai', id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' };
let seq = 0;

/** Start a run in this conversation: its request, its reply so far, and its status. Returns what moves it on. */
async function startRun(text, context, { mode, steps = [], status = 'running', reply = '', model = MODEL } = {}) {
  const runId = `r_strip${++seq}`;
  const user = { id: `m_u${seq}`, role: 'user', text, time: t(seq), context, runId };
  const ai = { id: `m_a${seq}`, role: 'assistant', text: reply, time: t(seq), runId, model, activities: steps };
  await emit({ runId, conversationId: convId, kind: 'status', status: 'preparing', mode });
  await emit({ runId, conversationId: convId, kind: 'message', message: user });
  await emit({ runId, conversationId: convId, kind: 'message', message: ai });
  if (status !== 'preparing') await emit({ runId, conversationId: convId, kind: 'status', status, mode });
  await pause(300);
  return {
    runId,
    status: (s) => emit({ runId, conversationId: convId, kind: 'status', status: s, mode }),
    message: (patch) => emit({ runId, conversationId: convId, kind: 'message', message: { ...ai, ...patch } }),
    end: async () => {
      await emit({ runId, conversationId: convId, kind: 'message', message: { ...ai, activities: steps.map((s) => ({ ...s, status: 'done' })), result: { status: 'cancelled', summary: 'Stopped.', changes: [], validation: [], canUndo: false } } });
      await emit({ runId, conversationId: convId, kind: 'status', status: 'cancelled', mode });
      await pause(300);
    }
  };
}

// 1. An edit limited to a part of the Contact page, just started: no step yet, so the model is thinking.
let run = await startRun('Tighten the page introduction so it reads in one breath', ctx(contact, 'Page introduction'));
await shot('started', '.run-strip >> text=Thinking', { widths: [340, 300] });
// The window around it, once, for where the strip sits against the canvas's own notice.
if (!ONLY || ONLY.test('strip-window')) {
  await setDockWidth(340);
  const path = join(OUT, 'strip-window--1440--light.png');
  await win.screenshot({ path });
  written.push(path);
  console.log('wrote', path);
}
// 2. The same run a few steps in: the current step names what it is doing.
await run.message({ activities: [done('s1', `Reading ${contact.title}`), done('s2', 'Inspecting the selected element'), { id: 's3', label: 'Updating content', status: 'running' }], text: 'The introduction repeats the heading. I’ll cut it to one sentence that says' });
await pause(300);
await shot('step', '.run-strip >> text=Updating content', { widths: [340, 300] });
// 3. Checking.
await run.status('validating');
await run.message({ activities: [done('s1', `Reading ${contact.title}`), done('s3', 'Updating content'), { id: 's4', label: 'Checking Contact at phone width', status: 'running' }] });
await pause(300);
await shot('checking', '.run-strip >> text=Checking Contact at phone width', { themes: ['light'] });
// 4. Stopping: nothing left to press.
await run.status('stopping');
await pause(300);
await shot('stopping', '.run-strip >> text=Stopping', { themes: ['light'] });
await run.end();

// 5. A whole-site edit from Home, with a long step at the narrowest dock.
run = await startRun('Make every page’s call to action say Book a consultation', ctx(home, null, { scope: 'site' }), {
  steps: [done('w1', 'Reading the project'), { id: 'w2', label: 'Updating the call to action on Services, About and Contact', status: 'running' }]
});
await shot('whole-site', '.run-strip >> text=Whole site', { widths: [340, 300], themes: ['light'] });
await run.end();

// 5b. A run that went to another model than the composer's next one, which the strip then names.
run = await startRun('Tighten the page introduction so it reads in one breath', ctx(contact, 'Page introduction'), {
  model: { provider: 'openai', id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  steps: [done('m1', `Reading ${contact.title}`), { id: 'm2', label: 'Updating content', status: 'running' }]
});
await shot('other-model', '.run-strip >> text=Sent to', { widths: [340, 300], themes: ['light'] });
await run.end();

// 5c. A component edited everywhere: its reach in plum, with the component mark.
run = await startRun('Make the quote larger', ctx(home, 'Quote', { component: { name: 'Testimonial card' } }), { steps: [{ id: 'c1', label: 'Updating styles', status: 'running' }] });
await shot('component', '.run-strip >> text=Testimonial card everywhere', { widths: [300], themes: ['light', 'dark'] });
await run.end();

// 5d. An element in the shared footer: it reaches every page, in green, named as the Layers panel names it.
run = await startRun('Make the opening hours bold', ctx(home, 'Opening hours', { selection: { owner: { kind: 'shell', id: 'footer' }, instancePath: [], nodeId: 'n_hours' } }), { steps: [{ id: 'f1', label: 'Updating styles', status: 'running' }] });
await shot('shared-footer', '.run-strip >> text=Shared footer', { widths: [340], themes: ['light', 'dark'] });
await run.end();

// 6. A question: it reads the site and changes nothing, so it stops without undoing.
run = await startRun('Where do I change the footer’s opening hours?', ctx(home, null, { mode: 'ask' }), { mode: 'ask', steps: [{ id: 'q1', label: 'Reading the shared footer', status: 'running' }] });
await shot('ask', '.run-strip >> text=Read only', { themes: ['light', 'dark'] });
await run.end();

// 7. Waiting on the author: the strip names the pause and the question card above it asks.
run = await startRun('Shorten the hero heading', ctx(home, 'Heading'), { steps: [done('a1', `Reading ${home.title}`)] });
await run.status('awaiting-input');
await run.message({
  activities: [done('a1', `Reading ${home.title}`), { id: 'a2', label: 'Waiting for your answer', status: 'running' }],
  questions: [{ id: 'q_strip', text: 'The shorter heading reads better without the small line above it. Can I change things outside the heading?', choices: ['Yes, allow changes across the whole site', 'No, only change the selection'], widen: true }]
});
await pause(400);
await shot('waiting', '.question-card >> text=Can I change things outside the heading', { themes: ['light'], above: 16 });
await run.end();

// 8. A run in another conversation.
await emit({ runId: 'r_elsewhere', conversationId: 'c_somewhere_else', kind: 'status', status: 'running' });
await pause(300);
await shot('elsewhere', '.run-strip.elsewhere', { themes: ['light'] });
// ...and one waiting there on the author.
await emit({ runId: 'r_elsewhere', conversationId: 'c_somewhere_else', kind: 'status', status: 'awaiting-input' });
await pause(300);
await shot('elsewhere-waiting', '.run-strip.elsewhere >> text=Needs your answer', { themes: ['light'] });
await emit({ runId: 'r_elsewhere', conversationId: 'c_somewhere_else', kind: 'status', status: 'cancelled' });

await app.close();
rmSync(WORK, { recursive: true, force: true });
const count = readdirSync(OUT).filter((f) => f.startsWith('strip-') && f.endsWith('.png')).length;
console.log(`AI run strip capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
