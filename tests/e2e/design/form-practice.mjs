// Design capture for the form practice panel in Preview: what a send does, the reply the next practice send gets, a
// confirmed live test, and the last result, for one form and for many. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/form-practice.mjs
//
// Each capture is verified on screen after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
//
// This script never delivers a form. The form's address is on a .test domain, which never resolves; requests to it
// are aborted and counted; and the page's handler for a live test is cut off, so the results shown are reported
// through the bridge message the page would send. The run fails if anything tried to reach the address.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createProject, eventually, launch, openInspector } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('form practice capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-forms-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const ENDPOINT = 'https://forms.harbour-lane.test/f/studio-enquiries';

const { app, win, errors } = await launch(WORK);
const written = [];
const pause = (ms) => win.waitForTimeout(ms);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

// Nothing may reach the form's address, whatever the page does.
const attempts = [];
await app.context().route('https://forms.harbour-lane.test/**', async (route) => {
  attempts.push(route.request().url());
  await route.abort();
});
// Installed in every preview page before the bridge loads. A confirmed live test stops at the listener, which runs
// first; the bridge's way of submitting the form is also disabled, so that if the listener ever missed one it still
// could not send, and the run fails on the count.
await app.context().addInitScript(() => {
  if (window.top === window) return;
  window.__captureLive = [];
  window.__captureBreach = 0;
  HTMLFormElement.prototype.requestSubmit = function requestSubmit() {
    window.__captureBreach++;
  };
  window.addEventListener(
    'message',
    (e) => {
      if (e.data?.type !== 'formLiveTest') return;
      e.stopImmediatePropagation();
      window.__captureLive.push(e.data.payload);
    },
    true
  );
});

const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const panel = win.locator('.form-practice');
const issue = win.locator('.ai-veil.issue');

async function page() {
  const handle = await win.locator('.frame-box iframe').elementHandle();
  const content = await handle.contentFrame();
  if (!content) throw new Error('the preview frame has no page');
  return content;
}
/** Report something to the editor exactly as the page's bridge does. */
async function bridge(type, payload) {
  const content = await page();
  await content.evaluate(
    ([t, p]) => window.parent.postMessage({ protocolVersion: 1, sessionId: window.name, navigationId: document.documentElement.getAttribute('data-so-navigation'), revision: 0, type: t, payload: p }, '*'),
    [type, payload]
  );
}

/**
 * Capture a state. `check` throws unless the state is on screen at the moment of capture. `area` is how much of the
 * canvas to keep: its foot, where the panel sits (legible), or all of it (how the panel sits on the page).
 */
async function shot(state, check, { themes = BOTH, area = 'controls', keepFocus = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(300);
    if (!keepFocus) await win.mouse.move(2, 300);
    // Past the arrival highlight on a new result.
    await pause(900);
    await eventually(check, 8000);
    // A report that arrives during the check gets its arrival highlight; let it finish.
    await pause(900);
    await check();
    const box = await win.locator('.canvas').boundingBox();
    const height = area === 'all' ? box.height : Math.min(box.height, 420);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: box.x, y: box.y + box.height - height, width: box.width, height } });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
}
const text = async (locator, expected) => assert.match(await locator.innerText(), expected);
const shows = (locator) => async () => assert.ok(await locator.first().isVisible(), 'not visible');
/** One option of the practice reply control, whatever role it takes. */
const option = (name) => panel.locator('.segmented button', { hasText: new RegExp(`^\\s*${name}\\s*$`) });
const liveButton = () => panel.locator('button', { hasText: /Send a real test/ });
const foldButton = () => panel.locator('.form-practice-fold');
/** Move focus as a keyboard user would, from the fold button, so the focus ring shows. */
async function tabFromFold(presses) {
  await foldButton().focus();
  for (let i = 0; i < presses; i++) await win.keyboard.press('Tab');
}

async function openPage(name) {
  await win.locator('.project-title').click();
  await win.locator('[role^="menuitem"]', { hasText: name }).first().click();
  await pause(900);
}

// ---- A contact form connected to an address, on the Contact page ----
await openPage('Contact');
await eventually(async () => assert.match(await (await page()).evaluate(() => location.pathname), /contact/), 30000);
const inspector = win.locator('#dock-panel-inspect');
if ((await frame.locator('form.so-form__form').count()) === 0) {
  await win.getByRole('button', { name: 'Insert', exact: true }).click();
  await win.getByRole('button', { name: 'Contact form' }).click();
} else {
  if (!(await win.locator('[role="tree"]').first().isVisible().catch(() => false))) await win.locator('.rail [aria-label="Layers"]').click();
  await win.locator('[role="tree"] .list-item', { hasText: 'Contact form' }).first().click();
}
await openInspector(win);
await inspector.locator('.insp-name h3', { hasText: 'Contact form' }).waitFor({ timeout: 30000 });
await inspector.getByLabel('Form service', { exact: true }).selectOption('endpoint');
await inspector.getByLabel('Form endpoint URL', { exact: true }).fill(ENDPOINT);
await inspector.getByLabel('Form endpoint URL', { exact: true }).press('Enter');
await eventually(async () => assert.equal(await frame.locator('form.so-form__form').first().getAttribute('action'), ENDPOINT), 30000);

await win.locator('button[title^="Preview:"]').click();
await panel.waitFor({ timeout: 30000 });
await pause(900);

// ---- One form ----
await shot('form-rest', async () => {
  assert.equal(await panel.isVisible(), true);
  assert.equal(await liveButton().isVisible(), true);
});
await shot('form-on-page', shows(panel), { themes: LIGHT, area: 'all' });

// A real practice send from the page itself: the form's own reply, and the panel's, together.
{
  const content = await page();
  await content.locator('form.so-form__form [name="name"]').fill('Ada Lovelace');
  await content.locator('form.so-form__form [name="email"]').fill('ada@example.com');
  await content.locator('form.so-form__form [name="message"]').fill('A practice enquiry about a kitchen.');
  await content.locator('form.so-form__form [name="email"]').press('Enter');
  await shot('form-practice-page', async () => {
    await text(panel.locator('[role="status"]'), /success message/);
    await text((await page()).locator('.so-form__status[role="status"]'), /Thank you/);
  }, { themes: LIGHT, area: 'all' });
}

// Practice sends, reported as the page reports them.
await bridge('formResult', { id: 'capture', kind: 'practice', result: 'success' });
await shot('form-practice-sent', () => text(panel.locator('[role="status"]'), /success message/));
await option('Error').click();
await bridge('formResult', { id: 'capture', kind: 'practice', result: 'error' });
await shot('form-practice-error', () => text(panel.locator('[role="status"]'), /error message/), { themes: LIGHT });
await option('Success').click();
await pause(200);

// Keyboard focus on the practice reply control.
await tabFromFold(1);
await shot('form-choice-focus', async () => assert.equal(await win.evaluate(() => document.activeElement?.closest('.segmented') !== null), true), { themes: LIGHT, keepFocus: true });
await win.evaluate(() => document.activeElement?.blur());

// The confirmation, before anything is sent.
await liveButton().click();
await shot('form-live-confirm', () => text(panel, /Send one real test message\?/));
await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
await pause(200);

/** Confirm a live test, which the page never acts on, and report `result` for it. */
async function liveResult(result, extra = {}) {
  const content = await page();
  const before = await content.evaluate(() => window.__captureLive.length);
  await eventually(async () => assert.equal(await liveButton().getAttribute('aria-disabled'), null), 8000);
  await liveButton().click();
  await panel.getByRole('button', { name: 'Send one real test message' }).click();
  const sent = await eventually(async () => {
    const list = await content.evaluate(() => window.__captureLive);
    assert.equal(list.length, before + 1, 'the live test was stopped before the page handled it');
    return list[list.length - 1];
  }, 8000);
  await pause(200);
  assert.equal(await content.evaluate(() => window.__captureBreach), 0, 'the page must not try to submit the form');
  await bridge('formResult', { id: sent.id, requestId: sent.requestId, kind: 'live', result, destination: sent.target, ...extra });
}
// Sending: the live test button is unavailable until it settles.
await liveResult('sending');
await shot('form-live-sending', async () => {
  await text(panel.locator('[role="status"]'), /Sending one real test message/);
  assert.equal(await liveButton().getAttribute('aria-disabled'), 'true');
});
const settle = await (await page()).evaluate(() => window.__captureLive.at(-1));
await bridge('formResult', { id: settle.id, requestId: settle.requestId, kind: 'live', result: 'not-sent' });
await pause(300);
await liveResult('sent', { status: 200 });
await shot('form-live-sent', () => text(panel.locator('[role="status"]'), /Check the service to see the message arrived/));
await liveResult('refused', { status: 422 });
await shot('form-live-refused', () => text(panel.locator('[role="status"]'), /status 422/), { themes: LIGHT });
await liveResult('unreadable');
await shot('form-live-unreadable', () => text(panel.locator('[role="status"]'), /no reply the editor could read/), { themes: LIGHT });

// A real test the page refused to send: required answers missing.
await liveResult('invalid');
await shot('form-live-invalid', () => text(panel.locator('[role="status"]'), /answers missing/), { themes: LIGHT });

// Folded to its title line, with the last result's lead still showing; then a practice send while folded.
await foldButton().click();
await shot('form-folded-live', async () => {
  assert.equal(await foldButton().getAttribute('aria-expanded'), 'false');
  await text(panel, /Real test not sent/);
}, { area: 'all' });
await bridge('formResult', { id: 'capture', kind: 'practice', result: 'success' });
await foldButton().focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await shot('form-folded-focus', async () => {
  await text(panel, /Practice send/);
  assert.equal(await win.evaluate(() => document.activeElement?.classList.contains('form-practice-fold')), true);
}, { themes: LIGHT, keepFocus: true });
await foldButton().click();
await pause(300);

// A page problem and the panel together: the bars stacked. Arriving on the page clears the last send's note.
await bridge('navigated', { path: await (await page()).evaluate(() => location.pathname) });
await eventually(async () => assert.equal((await panel.locator('[role="status"]').innerText()).trim(), ''), 8000);
await bridge('runtimeError', { message: 'Cannot read properties of undefined (reading "title")' });
await shot('form-with-problem', async () => {
  assert.equal(await issue.isVisible(), true);
  assert.equal(await panel.isVisible(), true);
}, { area: 'all', themes: LIGHT });
await bridge('revisionApplied', {});
await issue.waitFor({ state: 'detached' });

// ---- Many forms of every kind, with long names and a long address ----
const MANY = [
  { id: 'capture-a', label: 'Tell us about your kitchen or joinery project', place: 'page', service: 'endpoint', destination: 'https://forms.harbour-lane.test/f/studio-enquiries/kitchen-and-joinery?source=contact-page', live: true },
  { id: 'capture-b', label: 'Newsletter', place: 'footer', service: 'netlify', destination: '', live: false },
  { id: 'capture-c', label: '', place: 'header', service: 'none', destination: '', live: false },
  { id: 'capture-d', label: 'Book a site visit', place: 'page', service: 'endpoint', destination: 'https://forms.harbour-lane.test/f/site-visits', live: true }
];
await bridge('forms', { forms: MANY });
await shot('form-many', () => text(panel, /4 forms/), { area: 'all' });
await bridge('formResult', { id: 'capture-a', kind: 'practice', result: 'error' });
await shot('form-many-practice', () => text(panel.locator('[role="status"]'), /joinery project” showed its error message/), { themes: LIGHT });
const summary = panel.locator('summary');
await tabFromFold(1);
await shot('form-many-focus', async () => assert.equal(await win.evaluate(() => document.activeElement?.tagName), 'SUMMARY'), { themes: LIGHT, keepFocus: true });
await summary.click();
await shot('form-many-open', () => text(panel, /Netlify Forms/), { themes: LIGHT, area: 'all' });
await summary.click();
await liveButton().click();
await shot('form-many-choose', async () => {
  await text(panel, /Choose the form to send from/);
  assert.equal(await win.evaluate(() => document.activeElement?.tagName), 'SELECT');
}, { themes: LIGHT, keepFocus: true });
await panel.locator('select').selectOption('capture-a');
await shot('form-many-confirm', () => text(panel, /go to forms\.harbour-lane\.test/), { themes: LIGHT });
await panel.getByRole('button', { name: 'Cancel', exact: true }).click();

// ---- Narrow: a small window, and a phone-width preview ----
await win.setViewportSize({ width: 980, height: 720 });
await pause(500);
await shot('form-narrow', () => text(panel, /4 forms/), { themes: LIGHT, area: 'all' });
await foldButton().click();
await shot('form-narrow-folded', () => text(panel, /Practice: error reply/), { themes: LIGHT, area: 'all' });
await foldButton().click();
await win.setViewportSize({ width: 1440, height: 900 });
await pause(300);
await bridge('forms', { forms: [MANY[0]] });
await pause(300);
await win.getByRole('button', { name: 'Phone', exact: true }).click();
await pause(900);
await shot('form-phone', shows(panel), { area: 'all' });
await win.getByRole('button', { name: 'Desktop', exact: true }).click().catch(() => undefined);
await pause(500);

// A form that is not connected to anything: no live test to offer.
await bridge('forms', { forms: [{ id: 'capture-e', label: 'Contact us', place: 'page', service: 'none', destination: '', live: false }] });
await shot('form-unconnected', () => text(panel, /not connected to a form service/), { themes: LIGHT });

assert.deepEqual(attempts, [], 'nothing may reach the form address');
await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`form practice capture: ${written.length} written, ${count} PNGs in ${OUT}, 0 deliveries attempted`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
