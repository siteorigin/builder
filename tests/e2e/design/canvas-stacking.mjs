// Design capture for everything that stands over the foot of the canvas, together: the Previewing bar, the AI's notice,
// the page problem bar and the Form practice panel, with the window's notices (toasts) above them, in Edit and in
// Preview, on a tall and a short canvas. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/canvas-stacking.mjs
//
// Run states go through the agent's own event channel, as the main process sends them; the page problem is reported
// exactly as the preview's bridge reports it, from inside the real frame; the toast is the app's own, raised by asking
// to delete the shared header. Each capture is verified on screen after it settles, and a state that did not render
// throws instead of writing a plausible-looking wrong image. Beside the images, geometry.json records where every bar,
// the page and the notices stood in each state, so overlaps are read as numbers. Files are `{state}--{theme}.png`.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createProject, launch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('canvas stacking capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-stacking-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const PILL = '.canvas .preview-pill';
const RUN = '.canvas .canvas-notice.ai-run';
const ISSUE = '.canvas .canvas-notice.issue';
const PRACTICE = '.canvas .form-practice';
const TOAST = '.toasts .toast';
// Every control a bar of the foot offers: each must be reachable by a pointer at its centre.
const ACTIONS = { foot: '.canvas .canvas-foot button' };
const PARTS = { foot: '.canvas .canvas-foot', addressFull: '.canvas .pill-address-full', pill: PILL, run: RUN, issue: ISSUE, practice: PRACTICE, page: '.canvas .frame-box', toasts: '.toasts', toast: TOAST };

const { app, win, errors } = await launch(WORK);
const written = [];
const geometry = {};
const pause = (ms) => win.waitForTimeout(ms);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system', developerMode: false }));

/** Where each part stands, in window pixels, and how far into the canvas's visible area the page reaches. */
async function measure() {
  return win.evaluate(([parts, actions]) => {
    const out = {};
    const canvas = document.querySelector('.canvas')?.getBoundingClientRect();
    out.canvas = canvas && { top: Math.round(canvas.top), bottom: Math.round(canvas.bottom), height: Math.round(canvas.height) };
    for (const [name, sel] of Object.entries(parts)) {
      const els = [...document.querySelectorAll(sel)];
      const boxes = els.map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
      if (!boxes.length) continue;
      const top = Math.min(...boxes.map((r) => r.top));
      const bottom = Math.max(...boxes.map((r) => r.bottom));
      out[name] = { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(Math.min(...boxes.map((r) => r.left))), right: Math.round(Math.max(...boxes.map((r) => r.right))) };
      if (name !== 'page' && name !== 'toasts' && name !== 'toast') out[name].z = getComputedStyle(els[0]).zIndex;
    }
    // The foot's rows, which never overlap one another.
    const rows = [...document.querySelectorAll('.canvas .canvas-foot > :not(.sr-only)')].map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
    out.overlaps = 0;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) out.overlaps++;
    }
    const scroll = document.querySelector('.canvas-scroll');
    if (scroll && out.page) out.pageVisibleBottom = Math.round(Math.min(out.page.bottom, scroll.getBoundingClientRect().bottom));
    // Each bar's own action, and whether a pointer at its centre reaches it rather than something standing over it.
    out.covered = [];
    for (const [name, sel] of Object.entries(actions)) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || !el.contains(hit)) out.covered.push(`${name}: ${el.textContent.trim() || el.getAttribute('aria-label')}`);
      }
    }
    // How far the page reaches under the foot's top: positive means a bar stands on the page.
    if (out.foot && out.pageVisibleBottom) out.pageUnderBars = Math.max(0, out.pageVisibleBottom - out.foot.top);
    return out;
  }, [PARTS, ACTIONS]);
}

/**
 * Capture a state. `check` is a selector that must show at the moment of capture; `area` is 'canvas' (all of it) or
 * 'window' (the whole window, for the notices, which are centred on the window rather than the canvas).
 */
async function shot(state, check, { themes = BOTH, area = 'canvas', keepFocus = false, count } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(400);
    if (!keepFocus) await win.mouse.move(2, 450);
    await pause(250);
    for (const sel of [check].flat()) {
      const ok = await win.locator(sel).first().isVisible().catch(() => false);
      if (!ok) throw new Error(`state "${state}" (${theme}) did not render "${sel}"; refusing to write`);
    }
    if (count) for (const [sel, n] of Object.entries(count)) {
      const got = await win.locator(sel).count();
      if (got !== n) throw new Error(`state "${state}" (${theme}): ${got} of "${sel}", expected ${n}; refusing to write`);
    }
    // The stack's promises, checked before anything is written: every bar's action can be pressed, no bar stands on the
    // page (8px clear), and a notice stands 12px clear above the topmost bar.
    const g = await measure();
    if (g.covered.length) throw new Error(`state "${state}" (${theme}): covered ${g.covered.join(', ')}; refusing to write`);
    if (g.overlaps) throw new Error(`state "${state}" (${theme}): ${g.overlaps} rows of the foot overlap; refusing to write`);
    const tops = g.foot ? [g.foot.top] : [];
    if (tops.length && g.pageVisibleBottom > Math.min(...tops) - 8 + 1) throw new Error(`state "${state}" (${theme}): the page ends ${Math.min(...tops) - g.pageVisibleBottom}px above the foot, under 8px; refusing to write`);
    if (tops.length && g.toasts && g.toasts.bottom > Math.min(...tops) - 12 + 1) throw new Error(`state "${state}" (${theme}): the notices end ${Math.min(...tops) - g.toasts.bottom}px above the foot, under 12px; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    if (area === 'window') await win.screenshot({ path });
    else {
      const box = await win.locator('.canvas').boundingBox();
      await win.screenshot({ path, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    }
    if (theme === themes[0]) geometry[state] = g;
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}

/** A run status, sent to the renderer exactly as the main process sends it. */
/** Each run its own ID, as main gives it: a run that ended never runs again. */
let runs = 0;
async function emit(status, mode = 'edit') {
  // Filed in the conversation the chat shows, so its question is answered there.
  const conversationId = await win.evaluate(() => window.builder.ai.conversations().then((c) => c.active.id));
  await app.evaluate(({ BrowserWindow }, ev) => BrowserWindow.getAllWindows()[0].webContents.send('ai:event', ev), { runId: `r_${mode}_${runs}`, conversationId, kind: 'status', status, mode });
  await pause(300);
}
async function endRun(mode = 'edit') {
  await emit('cancelled', mode);
  runs++;
  await win.locator(RUN).waitFor({ state: 'detached', timeout: 8000 });
  await pause(300);
}
async function content() {
  const c = await (await win.locator('.frame-box iframe').elementHandle()).contentFrame();
  if (!c) throw new Error('the preview frame has no page');
  return c;
}
/** Report something to the editor from the preview page, exactly as its bridge does. */
async function bridge(type, payload) {
  await (await content()).evaluate(([t, p]) => {
    const navigationId = document.documentElement.dataset.soNavigation;
    window.parent.postMessage({ protocolVersion: 1, sessionId: window.name, navigationId, revision: p.revision ?? 0, type: t, payload: p }, '*');
  }, [type, payload]);
}
async function problem() {
  await bridge('runtimeError', { message: 'Cannot read properties of undefined (reading "title")' });
  await win.locator(ISSUE).getByRole('button', { name: 'Try again' }).waitFor({ timeout: 10000 });
  await pause(600);
}
async function clearProblem() {
  await win.locator(ISSUE).getByRole('button', { name: 'Try again' }).click();
  await win.locator(ISSUE).waitFor({ state: 'detached', timeout: 60000 });
  await pause(1500);
}
/** The app's own error notice, which stays until dismissed: asking to delete the shared header. */
async function raiseToast(frame) {
  await frame.locator('header').first().click({ position: { x: 40, y: 20 } });
  await pause(400);
  await win.locator('.canvas').focus().catch(() => undefined);
  await win.keyboard.press('Delete');
  await win.locator(TOAST).first().waitFor({ timeout: 8000 });
  await pause(500);
}
async function dismissToasts() {
  for (const b of await win.locator('.toasts .toast-dismiss').all()) await b.click().catch(() => undefined);
  await pause(400);
}
const toPreview = async () => {
  await win.locator('button[title^="Preview:"]').click();
  await win.locator(PILL).waitFor({ timeout: 8000 });
  await pause(1500);
};
const toEdit = async () => {
  await win.locator(`${PILL} button`, { hasText: 'Back to editing' }).click();
  await win.locator(PILL).waitFor({ state: 'detached', timeout: 8000 });
  await pause(900);
};

const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
await pause(1500);

// ---- Edit: the AI at work and a page problem, with the page ending above them ----
await emit('running');
await problem();
await shot('edit-run-problem', [RUN, ISSUE]);
await clearProblem();

// ---- Edit: a notice raised while the AI works sits above its card ----
await raiseToast(frame);
await shot('edit-run-toast', [RUN, TOAST], { themes: LIGHT, area: 'window' });
await dismissToasts();
await endRun();

// ---- Preview: the bar alone, then with the AI and a problem, then a notice over the stack ----
await toPreview();
await shot('preview-pill', PILL);
await emit('running');
await problem();
await shot('preview-run-problem', [PILL, RUN, ISSUE]);
await clearProblem();
await toEdit();
await raiseToast(frame);
await toPreview();
await shot('preview-run-toast', [PILL, RUN, TOAST], { area: 'window' });
await dismissToasts();
await endRun();
await toEdit();

// ---- Preview of the Contact page: all four at once, on a tall and on a short canvas ----
await win.locator('.project-title').click();
await win.locator('[role^="menuitem"]', { hasText: 'Contact' }).first().click();
await pause(1500);
if ((await frame.locator('form').count()) === 0) {
  await win.getByRole('button', { name: 'Insert', exact: true }).click();
  await win.getByRole('button', { name: 'Contact form' }).click();
  await frame.locator('form').first().waitFor({ timeout: 30000 });
}
await toPreview();
await win.locator(PRACTICE).waitFor({ timeout: 30000 });
await emit('running');
await problem();
await shot('preview-all-four', [PILL, RUN, ISSUE, PRACTICE]);
await win.setViewportSize({ width: 1180, height: 640 });
await pause(1200);
await shot('preview-all-four-short', [PILL, RUN, ISSUE, PRACTICE]);
await win.setViewportSize({ width: 960, height: 700 });
await pause(1200);
await shot('preview-all-four-narrow', [PILL, RUN, ISSUE, PRACTICE], { themes: LIGHT });
// An address too long for its slot, read by keyboard: the whole of it shows as a row just above the bar, lifting the
// bars over it, and Escape puts it away with focus left on the address. The window narrows until the address elides.
const elided = win.locator(`${PILL} .pill-address[tabindex="0"]`);
for (const width of [960, 900, 860, 820, 780]) {
  if (await elided.count()) break;
  await win.setViewportSize({ width, height: 700 });
  await pause(900);
}
if (!(await elided.count())) throw new Error('no window width elided the address; the full-address state was not reached');
await win.keyboard.press('Shift');
await elided.focus();
await pause(300);
await shot('preview-address-focus', ['.canvas .pill-address-full', RUN, ISSUE], { themes: LIGHT, keepFocus: true });
await win.keyboard.press('Escape');
await pause(300);
if (await win.locator('.canvas .pill-address-full').isVisible()) throw new Error('Escape did not put the full address away');
if (!(await elided.evaluate((el) => el === document.activeElement))) throw new Error('Escape moved focus off the address');
await win.evaluate(() => document.activeElement?.blur());
// At a fixed zoom on the short window the page is held at its floor and the pasteboard scrolls: scrolled to its end, the
// page stops above the foot, never under it.
await win.setViewportSize({ width: 1180, height: 640 });
await pause(900);
await win.getByRole('button', { name: /^Zoom:/ }).click();
await win.locator('[role^="menuitem"]', { hasText: /^100%$/ }).click();
await pause(1200);
await win.locator('.canvas-scroll').evaluate((el) => el.scrollTo(el.scrollWidth, el.scrollHeight));
await pause(500);
await shot('preview-all-four-zoomed', [PILL, RUN, ISSUE, PRACTICE], { themes: LIGHT });
await win.getByRole('button', { name: /^Zoom:/ }).click();
await win.locator('[role^="menuitem"]', { hasText: 'Fit to window' }).click();
await pause(900);
await win.setViewportSize({ width: 1440, height: 900 });
await pause(900);
await clearProblem();
await endRun();
await toEdit();

await app.close();
writeFileSync(join(OUT, 'geometry.json'), JSON.stringify(geometry, null, 2));
if (errors.length) console.log('renderer errors:', errors);
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
const missing = written.filter((p) => !files.includes(p.slice(OUT.length + 1)));
if (missing.length) throw new Error(`missing captures: ${missing.join(', ')}`);
console.log(`canvas stacking capture: ${written.length} images in ${OUT}`);
rmSync(WORK, { recursive: true, force: true });
