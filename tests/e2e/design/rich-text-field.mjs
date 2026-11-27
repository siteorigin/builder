// Rich text field capture harness: drives the real (built) app through the states of the Inspector's rich text
// field (its toolbar at rest, in a list and in a link, and the inline row that adds or edits a link, with its
// errors, its unapplied note and its search engine ticks) and writes one PNG per state and theme, cropped to the
// dock around the field. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/rich-text-field.mjs
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('rich text field capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-rich-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 1000 });
await win.waitForSelector('.welcome', { timeout: 120000 });
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const insp = win.locator('#dock-panel-inspect');

async function until(check, what, ms = 45000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(150);
  }
}

/** Capture the dock's width around `target`, in the given themes; `verify` must hold at the moment of capture. */
async function shot(state, target, verify, themes = LIGHT) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(220);
    if (!(await verify().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render; refusing to write`);
    const dock = await win.locator('.dock').boundingBox();
    const box = await target.first().boundingBox();
    if (!dock || !box) throw new Error(`state "${state}" (${theme}) has no box; refusing to write`);
    const top = Math.max(dock.y, box.y - 36);
    const bottom = Math.min(dock.y + dock.height, box.y + box.height + 28);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: dock.x, y: top, width: dock.width, height: bottom - top } });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
  await pause(100);
}

const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(250);
};

async function insert(search, name) {
  await openRail('Insert');
  await win.getByLabel('Search items to add').fill(search);
  await until(async () => new RegExp(`^${name}`).test(await win.getByRole('listbox', { name: 'Results' }).getByRole('option').first().innerText()), `the ${name} result`);
  await win.getByLabel('Search items to add').press('Enter');
  await insp.locator('.insp-name h3', { hasText: name }).waitFor({ timeout: 45000 });
  await pause(400);
}

/** Set the text section's body through the same edit the Inspector sends. */
async function setBody(markdown) {
  await win.evaluate(async (markdown) => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === 'content.text');
    if (!node) throw new Error('no text section on the home page');
    const r = await window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: page.id }, nodeId: node.id, prop: 'body', value: markdown }] }, { label: 'Seed text' });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  }, markdown);
  await pause(400);
}

// ---- Project ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: false }), join(WORK, 'sites'));
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('h1').first().waitFor({ timeout: 180000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();
await win.evaluate(() => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('section:')) localStorage.removeItem(k);
  localStorage.setItem('section:content', '1');
});

await insert('text section', 'Text section');
const BODY = [
  'We keep our team **deliberately small**, so the people you meet at the start see your project through. Read [how we work](/about/) or [email the studio](mailto:hello@harbourlanestudio.example).',
  '',
  '- Listen to how you live and work',
  '- Plan the budget and the programme',
  '- Design every room, down to the finishes',
  '',
  'Ask for a *free first visit* from our team.'
].join('\n');
await setBody(BODY);

const rich = insp.locator('.rich-field').first();
await rich.waitFor({ timeout: 15000 });
const area = rich.locator('textarea');
await until(async () => (await area.inputValue()).includes('Listen to how'), 'the seeded text');
const tool = (name) => rich.getByRole('toolbar').getByRole('button', { name, exact: true });

/** Put the caret (or a selection) in the field as the author would, by the text it sits in. */
async function caret(find, len = 0, offset = 0) {
  await area.evaluate(
    (el, { find, len, offset }) => {
      const at = el.value.indexOf(find);
      if (at < 0) throw new Error(`no "${find}" in the field`);
      el.focus();
      el.setSelectionRange(at + offset, at + offset + len);
      el.dispatchEvent(new Event('select'));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }));
    },
    { find, len, offset }
  );
  await pause(200);
}

// The field at rest: the caret in a plain paragraph, so link and the item commands are off.
await caret('people you meet', 0, 4);
await shot('rest-caret-in-paragraph', rich, async () => (await tool('Link').getAttribute('aria-disabled')) === 'true', BOTH);

// Pressing an off command says why it is off.
await tool('Bold').click({ force: true });
await shot('off-command-note', rich, async () => (await rich.locator('.rich-note').innerText()).includes('Select some words'));

// Words selected: Link is on.
await caret('people you meet', 'people you meet'.length);
await shot('words-selected', rich, async () => (await tool('Link').getAttribute('aria-disabled')) === null);

// The caret in a list item: the list is pressed and the item commands are on (Move up is off on the first).
await caret('Listen to how', 0, 3);
await shot('caret-in-list', rich, async () => (await tool('Bulleted list').getAttribute('aria-pressed')) === 'true' && (await tool('Move item up').getAttribute('aria-disabled')) === 'true', BOTH);

// The caret in bold words: Bold is pressed.
await caret('deliberately small', 0, 4);
await shot('caret-in-bold', rich, async () => (await tool('Bold').getAttribute('aria-pressed')) === 'true');

// The caret in a link: Link becomes Edit link.
await caret('how we work](', 0, 3);
await shot('caret-in-link', rich, async () => (await tool('Edit link').count()) === 1);

// ---- The link row ----
// A new link on selected words.
await caret('free first visit', 'free first visit'.length);
await tool('Link').click();
const row = rich.locator('.rich-link');
await row.waitFor({ timeout: 8000 });
const dest = row.getByRole('combobox', { name: /^Link destination/ }).or(row.getByRole('textbox', { name: /^Link destination/ }));
await shot('link-new-empty', rich, async () => (await dest.inputValue()) === '' && (await dest.evaluate((el) => el === document.activeElement)), BOTH);

// Typed and not applied yet.
await dest.fill('/contact/');
await shot('link-new-typed', rich, async () => (await dest.inputValue()) === '/contact/' && (await row.locator('.field-error').count()) === 0, BOTH);

// Link on other words while this one is half typed: the row keeps it and says what to do.
await caret('people you meet', 'people you meet'.length);
await tool('Link').click();
await shot('link-notice-other-words', rich, async () => (await row.locator('.rich-link-notice').innerText()).includes('Apply or cancel') && (await dest.inputValue()) === '/contact/');
await caret('free first visit', 'free first visit'.length);

// A web address: the search engine ticks appear.
await dest.fill('https://www.harbourlanestudio.example/first-visit');
await shot('link-url-rels', rich, async () => (await row.locator('.link-rels').count()) === 1, BOTH);

// Something that is not an address.
await dest.fill('our contact page');
await dest.press('Enter');
await row.locator('.field-error').waitFor({ timeout: 5000 });
await shot('link-error', rich, async () => (await row.locator('.field-error').innerText()).includes('web address'), BOTH);

// Empty and applied.
await dest.fill('');
await dest.press('Enter');
await shot('link-error-empty', rich, async () => (await row.locator('.field-error').innerText()).includes('Type where'));
await dest.press('Escape');
await row.waitFor({ state: 'detached', timeout: 5000 });

// Editing an existing link: Remove appears.
await caret('how we work](', 0, 3);
await tool('Edit link').click();
await row.waitFor({ timeout: 8000 });
await shot('link-edit-existing', rich, async () => (await dest.inputValue()).includes('about') && (await row.getByRole('button', { name: /^Remove/ }).count()) === 1, BOTH);
await dest.press('Escape');
await row.waitFor({ state: 'detached', timeout: 5000 });

// ---- Keyboard focus in the toolbar ----
await caret('Plan the budget', 0, 2);
await area.press('Shift+Tab');
await pause(150);
await win.keyboard.press('ArrowRight');
await win.keyboard.press('ArrowRight');
await shot('toolbar-keyboard-focus', rich, () => win.evaluate(() => document.activeElement?.closest('.rich-tools') && document.activeElement.matches(':focus-visible')));
await win.evaluate(() => document.activeElement?.blur());

// ---- The narrowest Inspector ----
const split = win.getByRole('separator', { name: 'Resize right panel' });
await split.focus();
await win.keyboard.press('Home');
await pause(400);
await caret('people you meet', 'people you meet'.length);
await tool('Link').click();
await row.waitFor({ timeout: 8000 });
await dest.fill('https://www.harbourlanestudio.example/first-visit');
await shot('narrow-link-url', rich, async () => (await win.locator('.dock').boundingBox()).width <= 320 && (await row.locator('.link-rels').count()) === 1, BOTH);
await dest.press('Escape');
await row.waitFor({ state: 'detached', timeout: 5000 });
await caret('how we work](', 0, 3);
await tool('Edit link').click();
await row.waitFor({ timeout: 8000 });
await shot('narrow-link-edit-existing', rich, async () => (await row.getByRole('button', { name: /^Remove/ }).count()) === 1);
await dest.press('Escape');
await row.waitFor({ state: 'detached', timeout: 5000 });
await caret('people you meet', 'people you meet'.length);
await tool('Link').click();
await row.waitFor({ timeout: 8000 });
await dest.fill('our contact page');
await dest.press('Enter');
await row.locator('.field-error').waitFor({ timeout: 5000 });
await shot('narrow-link-error', rich, async () => (await row.locator('.field-error').innerText()).includes('web address'));
await dest.press('Escape');
await row.waitFor({ state: 'detached', timeout: 5000 });
await caret('Design every room', 0, 2);
await shot('narrow-caret-in-list', rich, async () => (await tool('Bulleted list').getAttribute('aria-pressed')) === 'true');

// Bold that applies to the words but can't be taken off just them (italic words inside a bold phrase, as typed): drawn
// on, and off. The project saves marks in separate runs, so the state is set on the button here to show its drawing.
await caret('people you meet', 'people you meet'.length);
await tool('Bold').evaluate((b) => (b.setAttribute('aria-pressed', 'true'), b.setAttribute('aria-disabled', 'true')));
await shot('pressed-and-off', rich, async () => (await tool('Bold').getAttribute('aria-pressed')) === 'true' && (await tool('Bold').getAttribute('aria-disabled')) === 'true', BOTH);

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`rich text field capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
