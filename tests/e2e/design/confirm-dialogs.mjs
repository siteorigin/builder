// Design capture for the confirmation dialogs (ConfirmHost and every confirmDialog prompt). Opt-in only, never part
// of `npm run test:e2e`, and it never calls a provider, opens a browser or answers a question destructively:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/confirm-dialogs.mjs
//
// Each prompt is opened the way a person opens it, through the real panel that asks it, so the capture shows the
// words its caller really passes. A capture checks that its dialog is on screen and that the safe choice holds focus,
// and throws rather than write an image of anything else. Files are `{prompt}--{theme}.png`, cropped to the dialog
// with a margin of the window; `context` is the whole window.
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('confirm dialogs capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'confirm-dialogs');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const LONG_VERSION = 'Approved by Marama before the spring launch, new menu photos';
const LONG_URL = 'https://bookings.harbourlane.example/reservations/spring-menu/private-dining-room?party=8&sitting=early&utm_source=website&utm_campaign=spring-launch';

const SOURCE = `<script>
	let { heading = 'Book a table at Harbour Lane', text = 'Tell us when you would like to visit.' } = $props();
</script>

<section class="booking">
	<h2>{heading}</h2>
	<p>{text}</p>
</section>
`;

const { WORK, cleanup } = scratch('design-confirm');
const { app, win, errors } = await launch(WORK);
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system', developerMode: true }));
await win.emulateMedia({ reducedMotion: 'reduce' });
// Nothing here may reach the desktop, whatever a prompt is answered.
await app.evaluate(({ shell }) => {
  shell.openExternal = async () => undefined;
  shell.showItemInFolder = () => undefined;
});
const pause = (ms) => win.waitForTimeout(ms);
const frame = win.frameLocator('.frame-box iframe');
const written = [];
const question = (title) => win.getByRole('dialog', { name: title });

/** The top dialog with a margin of the window around it, so its edge and shadow read. */
async function clip() {
  const box = await win.locator('.modal').last().boundingBox();
  const size = win.viewportSize();
  const x = Math.max(0, Math.floor(box.x - 24));
  const y = Math.max(0, Math.floor(box.y - 24));
  return { x, y, width: Math.min(size.width - x, Math.ceil(box.width + 48)), height: Math.min(size.height - y, Math.ceil(box.height + 48)) };
}

/** Capture one prompt in each theme. `safe` is the button that must hold focus, unless `focus` names another. */
async function shot(state, title, safe, { themes = BOTH, full = false, focus = safe } = {}) {
  const dialog = question(title);
  await dialog.waitFor({ timeout: 60000 });
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await win.mouse.move(4, 4);
    await pause(260);
    if (!(await dialog.isVisible())) throw new Error(`"${state}" (${theme}): the dialog is not on screen; refusing to write`);
    const focused = await win.evaluate(() => (document.activeElement === document.body ? '(page body)' : document.activeElement?.textContent?.trim().slice(0, 60)));
    if (focused !== focus) throw new Error(`"${state}" (${theme}): focus is on "${focused}", expected "${focus}"; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(full ? {} : { clip: await clip() }) });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

/** Answer with a named button and wait for the question to go. */
async function answer(title, label) {
  const dialog = question(title);
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await pause(150);
}
/** Escape means stay where you were. */
async function dismiss(title) {
  await win.keyboard.press('Escape');
  await question(title).waitFor({ state: 'detached' });
  await pause(150);
}
const closeTopDialog = async () => {
  await win.locator('.modal').last().getByRole('button', { name: 'Close', exact: true }).first().click();
};
const apply = async (operations, label) => {
  const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
  if (!r?.ok) throw new Error(`${label}: ${JSON.stringify(r?.error)}`);
};
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const railPanel = async (name) => {
  const button = win.locator(`.rail [aria-label="${name}"]`);
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await pause(200);
};
const menu = (label) =>
  app.evaluate(({ Menu }, l) => {
    const find = (items) => {
      for (const i of items) {
        if (i.label === l) return i;
        const f = i.submenu && find(i.submenu.items);
        if (f) return f;
      }
    };
    const item = find(Menu.getApplicationMenu().items);
    if (!item) throw new Error(`No menu item ${l}`);
    item.click();
  }, label);

// ---- A real project, with a conversation in its own chat storage and a placeholder key that is never sent ----
const sites = join(WORK, 'sites');
await createProject(win, { name: 'Harbour Lane Studio', parentDir: sites, starter: 'business', sampleImages: true });
const dir = join(sites, 'harbour-lane-studio');
const first = await snapshot();
const home = first.state.pages[first.state.site.homePageId];
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');

const at = (m) => new Date(Date.UTC(2026, 10, 20, 9, m)).toISOString();
const context = { pageId: home.id, pageTitle: home.title, selection: null, selectionLabel: null, viewport: 1280 };
const chatDir = join(dir, '.siteorigin', 'sessions', 'chat');
mkdirSync(chatDir, { recursive: true });
writeFileSync(
  join(chatDir, 'c_seedconfirm.json'),
  JSON.stringify({
    id: 'c_seedconfirm',
    title: 'Add an FAQ section to the home page',
    createdAt: at(10),
    messages: [
      { id: 'm_u1', role: 'user', text: 'Add an FAQ section to the home page', time: at(10), context, runId: 'r_seed1' },
      {
        id: 'm_a1',
        role: 'assistant',
        text: '',
        time: at(11),
        runId: 'r_seed1',
        result: { status: 'failed', summary: 'The changes introduced errors that could not be repaired. The project was restored to how it was before this request.', changes: [], validation: [], canUndo: false }
      }
    ]
  })
);
await win.evaluate(() => window.builder.ai.setKey('openai', 'sk-design-capture-not-a-real-key'));
await win.reload();
await win.waitForSelector('.recent-card');
await win.emulateMedia({ reducedMotion: 'reduce' });
await win.locator('.recent-card', { hasText: 'Harbour Lane Studio' }).click();
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 60000 });
await pause(1200);

// ---- The AI panel: replacing a draft, and clearing history ----
await win.locator('.dock-tab', { hasText: 'AI' }).click();
await win.getByRole('button', { name: 'Edit and try again' }).waitFor({ timeout: 30000 });
await win.getByRole('textbox', { name: 'Message' }).fill('Actually, make the questions about bookings and parking');
await win.getByRole('button', { name: 'Edit and try again' }).click();
await shot('replace-draft', 'Replace your draft?', 'Cancel');
await dismiss('Replace your draft?');
await win.getByRole('textbox', { name: 'Message' }).fill('');

const CLEAR = 'Clear AI conversation history?';
// Keyboard only: open the menu, choose Clear history, and press Enter straight away. The question must take that
// Enter on its safe choice, so the history is still there afterwards.
const history0 = win.getByRole('button', { name: 'Earlier conversations' });
await history0.focus();
await win.keyboard.press('Enter');
await win.locator('.menu [role^="menuitem"]').first().waitFor();
await pause(150);
await win.keyboard.press('End');
await win.keyboard.press('Enter');
await win.keyboard.press('Enter');
await question(CLEAR).waitFor({ state: 'detached' });
await pause(300);
if (!(await win.getByRole('button', { name: 'Edit and try again' }).isVisible())) throw new Error('an immediate Enter on Clear history cleared the history');
const returned = await win.evaluate(() => document.activeElement?.getAttribute('aria-label'));
if (returned !== 'Earlier conversations') throw new Error(`focus returned to "${returned}", not Earlier conversations`);
await win.getByRole('button', { name: 'Earlier conversations' }).click();
await win.locator('.menu [role^="menuitem"]', { hasText: 'Clear history' }).click();
await shot('clear-history', CLEAR, 'Cancel');
await shot('context', CLEAR, 'Cancel', { full: true });
// The keyboard path to the destructive choice: one Tab from the safe one.
await win.keyboard.press('Tab');
await shot('clear-history-focus', CLEAR, 'Cancel', { focus: 'Clear history' });
await dismiss(CLEAR);

// ---- Saved versions: an ordinary name and a very long one ----
const projectMenu = async (item) => {
  await win.locator('.project-title').click();
  await win.locator('[role="menu"]').waitFor();
  await win.locator('[role="menu"] [role^="menuitem"]', { hasText: item }).click();
};
const history = win.getByRole('dialog', { name: 'History' });
for (const name of ['Approved by client', LONG_VERSION]) {
  await projectMenu('Save version…');
  const field = history.getByRole('textbox', { name: 'Version name' });
  await field.waitFor();
  await field.fill(name);
  await field.press('Enter');
  await history.locator('.versions-list li', { hasText: name.slice(0, 40) }).first().waitFor({ timeout: 30000 });
  await closeTopDialog();
  await history.waitFor({ state: 'detached' });
}
await projectMenu('History…');
await history.getByRole('tab', { name: 'Saved versions' }).click();
const DELETE = 'Delete saved version?';
await history.getByRole('button', { name: 'Delete “Approved by client”' }).click();
await shot('delete-version', DELETE, 'Cancel');
await answer(DELETE, 'Cancel');
await history.getByRole('button', { name: `Delete “${LONG_VERSION}”` }).click();
await shot('delete-version-long', DELETE, 'Cancel');
// The longest prompt in a small window: the actions must stay on screen.
await win.setViewportSize({ width: 640, height: 560 });
await pause(300);
await shot('delete-version-small', DELETE, 'Cancel');
await win.setViewportSize({ width: 1440, height: 900 });
await pause(300);
await dismiss(DELETE);
await closeTopDialog();
await history.waitFor({ state: 'detached' });

// ---- Settings: removing a saved key, and closing with one typed but not saved ----
await win.locator('[aria-label="Settings"]').click();
await win.getByRole('tab', { name: 'AI assistant' }).click();
const keyInput = win.locator('#settings-api-key');
// A saved key shows Replace and Remove; its field appears only once Replace is chosen.
const removeButton = win.locator('.modal .btn-danger').filter({ hasText: 'Remove' }).first();
await removeButton.waitFor();
await pause(300);
await removeButton.click();
const REMOVE = /^Remove the .* API key\?$/;
await shot('remove-key', REMOVE, 'Keep key');
await dismiss(REMOVE);
await win.locator('.modal').getByRole('button', { name: 'Replace', exact: true }).click();
await keyInput.waitFor();
await keyInput.fill('sk-design-capture-typed-not-saved');
await pause(200);
await win.keyboard.press('Escape');
const SAVE_KEY = 'Save the API key you entered?';
await shot('save-key', SAVE_KEY, 'Keep editing');
await answer(SAVE_KEY, 'Keep editing');
await keyInput.fill('');
await pause(200);
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });

// ---- The code editor: discard, and revert with and without property changes ----
await apply(
  [
    {
      type: 'component.createCode',
      name: 'Booking card',
      description: 'A short booking prompt.',
      source: SOURCE,
      properties: { heading: { type: 'string', label: 'Heading', default: 'Book a table at Harbour Lane' }, text: { type: 'string', label: 'Text', default: 'Tell us when you would like to visit.' } }
    }
  ],
  'Create the component'
);
const definitionId = Object.entries((await snapshot()).state.components).find(([, c]) => c.name === 'Booking card')?.[0];
if (!definitionId) throw new Error('the code component was not created');
await apply([{ type: 'node.insert', owner: { kind: 'page', id: home.id }, definitionId }], 'Place it');
await frame.getByText('Tell us when you would like to visit.').first().waitFor({ timeout: 60000 });
await railPanel('Layers');
await win.getByRole('treeitem', { name: /Booking card/ }).first().click();
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await win.evaluate(() => window.dispatchEvent(new CustomEvent('inspector-open-section', { detail: 'component' })));
await win.locator('#dock-panel-inspect').getByRole('button', { name: 'Edit code' }).first().click();
await win.locator('.modal .cm-content').getByText('Book a table').first().waitFor({ timeout: 30000 });
async function setDoc(text) {
  await win.locator('.modal .cm-content').click();
  await win.keyboard.press(`${MOD}+A`);
  await win.keyboard.insertText(text);
  await pause(200);
}
await setDoc(SOURCE.replace('Book a table at Harbour Lane', 'Reserve your table'));
await closeTopDialog();
const DISCARD = 'Discard your changes?';
await shot('discard-changes', DISCARD, 'Keep editing');
await answer(DISCARD, 'Keep editing');
await win.locator('.modal').getByRole('button', { name: 'Revert', exact: true }).click();
const REVERT = 'Revert your changes?';
await shot('revert-changes', REVERT, 'Keep editing');
await answer(REVERT, 'Keep editing');

// Code and a property both edited: the property change is the part that can't come back.
await win.getByRole('tab', { name: /^Properties/ }).click();
const labelField = win.getByRole('textbox', { name: 'heading label' });
await labelField.fill('Headline');
await labelField.press('Tab');
await pause(200);
await win.locator('.modal').getByRole('button', { name: 'Revert', exact: true }).click();
await shot('revert-mixed', REVERT, 'Keep editing');
await answer(REVERT, 'Revert changes');
await closeTopDialog();
await win.locator('.modal').waitFor({ state: 'detached' });

// ---- A new code component that was never saved ----
await railPanel('Insert');
await win.getByRole('button', { name: 'New code component' }).click();
await win.locator('.modal .cm-content').waitFor();
await win.fill('input[placeholder="Booking widget"]', 'Opening hours');
await pause(200);
await closeTopDialog();
const DISCARD_NEW = 'Discard this new component?';
await shot('discard-new', DISCARD_NEW, 'Keep editing');
await answer(DISCARD_NEW, 'Discard');
await win.locator('.modal').waitFor({ state: 'detached' });

// ---- Leaving with a change that cannot be saved ----
await win.keyboard.press('Escape');
await railPanel('Layers');
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
const titleField = win.locator('#dock-panel-inspect').getByRole('textbox', { name: 'Title', exact: true });
await titleField.waitFor({ timeout: 15000 });
const homeTitle = await titleField.inputValue();
await titleField.fill('');
await menu('Close Project');
const LEAVE = 'Leave without your last change?';
await shot('leave', LEAVE, 'Keep editing');
await answer(LEAVE, 'Keep editing');
await titleField.fill(homeTitle);
await titleField.press('Tab');
await pause(400);

// ---- Links followed in Preview, through the page's own click handling ----
await win.locator('button[title^="Preview:"]').click();
await frame.locator('html').waitFor();
await pause(1200);
const follow = (href) =>
  frame.locator('body').evaluate((body, url) => {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = 'link';
    body.append(a);
    a.click();
    a.remove();
  }, href);
for (const [state, href, title, safe] of [
  ['link-web', 'https://harbourlane.example/menu', 'Open this link in your browser?', 'Cancel'],
  ['link-web-long', LONG_URL, 'Open this link in your browser?', 'Cancel'],
  ['link-email', 'mailto:hello@harbourlane.example', 'Write an email?', 'Cancel'],
  ['link-phone', 'tel:+6495550142', 'Open this number in your phone app?', 'Cancel']
]) {
  await follow(href);
  await shot(state, title, safe);
  await dismiss(title);
}

// ---- A project another app holds: Unlock, asked over the Project health dialog ----
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
writeFileSync(join(dir, '.siteorigin', 'lock.json'), JSON.stringify({ pid: process.pid, host: hostname(), instance: 'another-window', started: new Date().toISOString() }));
const reopened = await win.evaluate((d) => window.builder.projects.open(d), dir);
if (!reopened?.ok) throw new Error(`the locked project did not open: ${JSON.stringify(reopened)}`);
await win.waitForSelector('.editor');
await win.locator('.status-bar .read-only').click();
await win.getByRole('button', { name: 'Unlock…' }).click();
const UNLOCK = 'Unlock this project?';
await shot('unlock', UNLOCK, 'Keep read-only');
await dismiss(UNLOCK);

await app.close();
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`confirm dialogs capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
