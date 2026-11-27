// Design capture for the notice at the foot of the canvas while the AI works: editing, checking its changes, stopping,
// reading the site to answer a question (and stopping that), and waiting for the author's answer; in Edit and in
// Preview (above the Previewing bar), on a narrow canvas, under a page problem, and under the Form practice panel.
// Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/canvas-ai-notice.mjs
//
// Run states are pushed through the agent's own event channel, as the main process sends them; the page problem is
// reported exactly as the preview's bridge reports it, from inside the real frame. Each capture is verified on screen
// after it settles; a state that did not render throws instead of writing a plausible-looking wrong image. Files are
// named `{state}--{theme}.png`.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createProject, launch, openInspector } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('canvas AI notice capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-ai-notice-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
// The AI notice, and the page problem bar beside it.
const NOTICE = '.canvas .canvas-notice.ai-run';
const ISSUE = '.canvas .canvas-notice.issue';

const { app, win, errors } = await launch(WORK);
const written = [];
const pause = (ms) => win.waitForTimeout(ms);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system', developerMode: false }));

/**
 * Capture a state. `check` is a selector, with the text it must hold, that must show at the moment of capture.
 * `area` is 'foot' (the lower part of the canvas, where the bars sit, kept legible) or 'canvas' (all of it).
 */
async function shot(state, check, { themes = BOTH, area = 'foot', text, keepFocus = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(350);
    if (!keepFocus) await win.mouse.move(2, 450);
    await pause(250);
    const el = win.locator(check).first();
    const ok = await el.isVisible().catch(() => false);
    if (!ok) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    if (text && !text.test(await el.innerText())) throw new Error(`state "${state}" (${theme}): "${check}" does not say ${text}; refusing to write`);
    const box = await win.locator('.canvas').boundingBox();
    const height = area === 'foot' ? Math.min(box.height, 300) : box.height;
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: box.x, y: box.y + box.height - height, width: box.width, height } });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}

/** A run status, sent to the renderer exactly as the main process sends it. */
async function emit(status, mode = 'edit') {
  await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('ai:event', ev), { runId: `r_${mode}`, conversationId: 'c_capture', kind: 'status', status, mode });
  await pause(250);
}
/** Fails unless `upper` stands clear above `lower` by at least `gap` px: stacked cards never meet. */
async function clearAbove(upper, lower, gap = 8) {
  const a = await win.locator(upper).first().boundingBox();
  const b = await win.locator(lower).first().boundingBox();
  if (!a || !b) throw new Error(`stack check: ${!a ? upper : lower} is not on screen`);
  const space = b.y - (a.y + a.height);
  if (space < gap) throw new Error(`stack check: ${upper} is ${space.toFixed(1)}px above ${lower}, under ${gap}px; refusing to write`);
}
/** Keyboard focus on a control, as Tab would leave it, so its ring shows. */
async function keyFocus(selector) {
  await win.keyboard.press('Shift');
  await win.locator(selector).first().focus();
  if (!(await win.locator(selector).first().evaluate((el) => el.matches(':focus-visible')))) throw new Error(`${selector} has no visible focus; refusing to write`);
}
async function endRun(mode = 'edit') {
  await emit('cancelled', mode);
  await win.locator(NOTICE).waitFor({ state: 'detached', timeout: 8000 });
  await pause(300);
}

async function page() {
  const content = await (await win.locator('.frame-box iframe').elementHandle()).contentFrame();
  if (!content) throw new Error('the preview frame has no page');
  return content;
}
/** Report something to the editor from the preview page, exactly as its bridge does. */
async function bridge(type, payload) {
  await (await page()).evaluate(([t, p]) => {
    const navigationId = document.documentElement.dataset.soNavigation;
    window.parent.postMessage({ protocolVersion: 1, sessionId: window.name, navigationId, revision: p.revision ?? 0, type: t, payload: p }, '*');
  }, [type, payload]);
}
const toPreview = async () => {
  await win.locator('button[title^="Preview:"]').click();
  await win.locator('.preview-pill').waitFor({ timeout: 8000 });
  await pause(1200);
};
const toEdit = async () => {
  await win.locator('.preview-pill button', { hasText: 'Back to editing' }).click();
  await win.locator('.preview-pill').waitFor({ state: 'detached', timeout: 8000 });
  await pause(900);
};

const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
await pause(1500);

// ---- Edit mode: an edit request through each of its phases ----
await emit('running');
await shot('edit-working', NOTICE, { text: /edit/i });
await shot('edit-working-canvas', NOTICE, { themes: LIGHT, area: 'canvas' });
await emit('validating');
await shot('edit-checking', NOTICE, { themes: LIGHT, text: /check/i });
await emit('awaiting-input');
await shot('edit-asking', NOTICE, { text: /question/i });
await keyFocus(`${NOTICE} .btn-primary`);
await shot('edit-asking-focus', `${NOTICE} :focus-visible`, { keepFocus: true });
await win.evaluate(() => document.activeElement?.blur());
await emit('stopping');
await shot('edit-stopping', NOTICE, { text: /stop/i });
await endRun();

// ---- A question: the AI reads the site, and stops ----
await emit('running', 'ask');
await shot('ask-reading', NOTICE, { text: /read/i });
await emit('stopping', 'ask');
await shot('ask-stopping', NOTICE, { themes: LIGHT, text: /stop/i });
await endRun('ask');

// ---- A narrow canvas: a small laptop's window with both side panels open ----
await win.setViewportSize({ width: 1024, height: 760 });
await pause(900);
await win.locator('.rail [aria-label="Pages"]').click().catch(() => undefined);
await openInspector(win).catch(() => undefined);
await pause(700);
await emit('running');
await shot('narrow-working', NOTICE, { themes: LIGHT, text: /edit/i });
await emit('awaiting-input');
await shot('narrow-asking', NOTICE, { themes: LIGHT, text: /question/i });
await endRun();
// Narrower still, the longest notice wraps, and the page problem stands on its measured height.
await win.setViewportSize({ width: 900, height: 760 });
await pause(900);
await emit('running', 'ask');
await bridge('runtimeError', { message: 'Cannot read properties of undefined (reading "title")' });
await win.locator(ISSUE).getByRole('button', { name: 'Try again' }).waitFor({ timeout: 10000 });
await pause(600);
await clearAbove(ISSUE, NOTICE);
await shot('narrowest-reading-problem', NOTICE, { themes: LIGHT, text: /read/i });
await win.locator(ISSUE).getByRole('button', { name: 'Try again' }).click();
await win.locator(ISSUE).waitFor({ state: 'detached', timeout: 60000 });
await pause(1200);
await endRun('ask');
await win.setViewportSize({ width: 1440, height: 900 });
await pause(900);

// ---- Beside a page problem, while editing ----
await emit('running');
await bridge('runtimeError', { message: 'Cannot read properties of undefined (reading "title")' });
await win.locator(ISSUE).getByRole('button', { name: 'Try again' }).waitFor({ timeout: 10000 });
await pause(500);
await clearAbove(ISSUE, NOTICE);
await shot('with-problem', ISSUE, {});
if (!(await win.locator(NOTICE).isVisible())) throw new Error('the AI notice left while the page problem showed');

// ---- Preview: above the Previewing bar, with and without the problem ----
await toPreview();
await clearAbove(ISSUE, NOTICE);
await clearAbove(NOTICE, '.preview-pill');
await shot('preview-problem', ISSUE, { themes: LIGHT });
await win.locator(ISSUE).getByRole('button', { name: 'Try again' }).click();
await win.locator(ISSUE).waitFor({ state: 'detached', timeout: 60000 });
await pause(1500);
await shot('preview-working', NOTICE, { text: /edit/i });
await keyFocus('.preview-pill button:has-text("Back to editing")');
await shot('preview-focus', '.preview-pill :focus-visible', { themes: BOTH, keepFocus: true });
await win.evaluate(() => document.activeElement?.blur());
await emit('awaiting-input');
await shot('preview-asking', NOTICE, { themes: LIGHT, text: /question/i });
await endRun();
await toEdit();

// ---- Under the Form practice panel: the Contact page's form, in Preview ----
await win.locator('.project-title').click();
await win.locator('[role^="menuitem"]', { hasText: 'Contact' }).first().click();
await pause(1500);
if ((await frame.locator('form').count()) === 0) {
  await win.getByRole('button', { name: 'Insert', exact: true }).click();
  await win.getByRole('button', { name: 'Contact form' }).click();
  await frame.locator('form').first().waitFor({ timeout: 30000 });
}
await toPreview();
await win.locator('.form-practice').waitFor({ timeout: 30000 });
await emit('running');
await clearAbove('.form-practice', NOTICE);
await shot('with-practice', '.form-practice', {});
if (!(await win.locator(NOTICE).isVisible())) throw new Error('the AI notice did not show under the Form practice panel');
await endRun();

await app.close();
if (errors.length) console.log('renderer errors:', errors);
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const missing = written.filter((p) => !files.includes(p.slice(OUT.length + 1)));
if (missing.length) throw new Error(`missing captures: ${missing.join(', ')}`);
console.log(`canvas AI notice capture: ${written.length} images in ${OUT}`);
rmSync(WORK, { recursive: true, force: true });
