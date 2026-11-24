// Design capture for component authoring: the Create component, Rename component, Make unique and Edit
// definition dialogs (Dialogs.tsx) and the editor for a code component's properties (PropSchemaEditor.tsx).
// Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/component-authoring.mjs
//
// Each state is checked on screen after it settles and the harness throws rather than write an image of a
// state that did not render. Files are named `{state}--{theme}.png` and show the dialog, except the states
// marked as whole-window.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('component authoring capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-authoring-')));
const THEMES = ['light', 'dark'];
const VIEWPORT = { width: 1440, height: 1000 };

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize(VIEWPORT);
await win.waitForSelector('.welcome', { timeout: 90000 });
await win.emulateMedia({ reducedMotion: 'reduce' });
const pause = (ms) => win.waitForTimeout(ms);
const modal = win.locator('.modal').last();
const inspector = win.locator('#dock-panel-inspect');
const sidePanel = win.locator('.side-panel-view:not([hidden])');
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

/** Capture the dialog (or the window) in each theme; every `texts` entry must be visible in it at that moment. */
async function shot(state, texts, { themes = THEMES, window: whole = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await win.mouse.move(2, 2);
    await pause(350);
    if (!(await modal.isVisible())) throw new Error(`state "${state}" (${theme}): no dialog is open; refusing to write`);
    for (const text of [].concat(texts)) {
      const visible = await modal.getByText(text).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${text}"; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    if (whole) await win.screenshot({ path });
    else await modal.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

/** Close the open dialog, discarding a draft when it asks. */
async function closeModal() {
  await win.keyboard.press('Escape');
  await pause(250);
  const discard = win.getByRole('button', { name: /^Discard/ });
  if (await discard.count()) await discard.first().click();
  await win.locator('.modal').first().waitFor({ state: 'detached', timeout: 10000 });
}

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(
    async ([operations, label]) => {
      const r = await window.builder.project.apply({ operations, label });
      if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
      return r.results;
    },
    [operations, label]
  );

async function select(name) {
  const layers = win.locator('.rail [aria-label="Layers"]');
  if ((await layers.getAttribute('aria-pressed')) !== 'true') await layers.click();
  await win.getByRole('treeitem', { name }).first().click();
  await win.locator('.dock-tab', { hasText: 'Inspector' }).click().catch(() => {});
  await pause(500);
}
async function componentSection() {
  const head = inspector.locator('.section-head', { hasText: 'Component' }).first();
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  await pause(200);
}
async function openInsert() {
  const group = sidePanel.locator('.insert-group[data-kind="component"]');
  if (!(await group.isVisible().catch(() => false))) await win.locator('.rail [aria-label="Insert"]').click();
  await group.waitFor();
}
async function openRename(name) {
  await openInsert();
  await sidePanel.getByRole('button', { name: `Manage ${name}`, exact: true }).click();
  await win.getByRole('menuitem', { name: /^Rename/ }).click();
  await modal.waitFor();
  await pause(250);
}
async function openDefinition(name) {
  await select(name);
  await componentSection();
  await inspector.getByRole('button', { name: /Edit everywhere/ }).click();
  await modal.waitFor();
  await pause(250);
}
async function openProperties(name) {
  await select(name);
  await componentSection();
  await inspector.getByRole('button', { name: 'Edit code' }).click();
  await modal.waitFor();
  await win.getByRole('tab', { name: /^Properties/ }).click();
  await modal.locator('.schema-editor').waitFor();
  await pause(300);
}

// ---- A populated project ----
const created = await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: false }), join(WORK, 'sites'));
if (!created.ok) throw new Error(`project creation failed: ${created.message}`);
await win.waitForSelector('.editor');
const frame = win.frameLocator('.frame-box iframe');
await frame.locator('h1').first().waitFor({ timeout: 120000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 60000 });
await pause(1200);

// Developer mode, through Settings so the editor's own state follows it: code components need it.
await win.locator('[aria-label="Settings"]').click();
await win.getByRole('switch', { name: 'Developer mode' }).click();
await win.keyboard.press('Escape');
await win.locator('.modal').first().waitFor({ state: 'detached' });

let st = await snapshot();
const homeId = st.site.homePageId;
const home = { kind: 'page', id: homeId };
const heroNode = st.pages[homeId].nodes[st.pages[homeId].rootIds[0]];
const heroName = heroNode.kind === 'instance' ? st.components[heroNode.definitionId]?.name : undefined;
if (!heroName || st.components[heroNode.definitionId].owner !== 'theme') throw new Error('the starter home page does not open with a theme component');

async function stack(heading) {
  const [{ nodeId }] = await apply([{ type: 'node.insert', owner: home, parentId: null, primitive: 'stack' }], 'Insert stack');
  await apply([{ type: 'node.insert', owner: home, parentId: nodeId, primitive: 'heading', text: heading }], 'Insert heading');
  await apply([{ type: 'node.insert', owner: home, parentId: nodeId, primitive: 'paragraph', text: 'Stand 14, north hall. Open every day of the fair.' }], 'Insert paragraph');
  return nodeId;
}
const cardStack = await stack('Exhibitor');
const [{ nodeId: cardId }] = await apply([{ type: 'component.createFromNode', owner: home, nodeId: cardStack, name: 'Exhibitor card' }], 'Create component');
const soloStack = await stack('Opening hours');
await apply([{ type: 'component.createFromNode', owner: home, nodeId: soloStack, name: 'Opening hours banner' }], 'Create component');
const spareStack = await stack('Spare layout');
const [{ nodeId: spareId }] = await apply([{ type: 'component.createFromNode', owner: home, nodeId: spareStack, name: 'Retired price strip' }], 'Create component');
st = await snapshot();
const cardDef = st.pages[homeId].nodes[cardId].definitionId;
const spareDef = st.pages[homeId].nodes[spareId].definitionId;
await apply([{ type: 'node.remove', owner: home, nodeId: spareId }], 'Remove the spare placement');
// A plain group, left as it is, for Create component to start from.
await stack('Feature highlight');

// The card is placed across several pages, one with a long title.
await apply([{ type: 'page.create', title: 'Spring exhibitors and visiting makers programme', route: '/spring-exhibitors/', starter: 'empty' }], 'Add page');
st = await snapshot();
for (const id of st.site.pageOrder.filter((p) => p !== homeId).slice(0, 5)) await apply([{ type: 'node.insert', owner: { kind: 'page', id }, parentId: null, definitionId: cardDef }], 'Place card');
await apply([{ type: 'node.insert', owner: home, parentId: null, definitionId: cardDef }], 'Place card again');

// A code component with one property of every type.
const SOURCE = `<script>\n\tlet { heading } = $props();\n</script>\n\n<section><h2>{heading}</h2></section>\n`;
const ALL_TYPES = {
  heading: { type: 'string', label: 'Heading', default: 'Visit the harbour studio' },
  intro: { type: 'string', label: 'Introduction', default: 'Makers, printers and boat builders\nunder one roof.', multiline: true },
  body: { type: 'richtext', label: 'Body text', default: 'A short paragraph about the studio.' },
  columns: { type: 'number', label: 'Columns', default: 3, min: 1, max: 6 },
  showBadge: { type: 'boolean', label: 'Show badge', default: true },
  tone: { type: 'enum', label: 'Tone', default: 'calm', options: [{ value: 'calm', label: 'Calm' }, { value: 'bold', label: 'Bold' }, { value: 'tide', label: 'Tide' }] },
  button: { type: 'link', label: 'Button link' },
  photo: { type: 'image', label: 'Photo' },
  badge: { type: 'icon', label: 'Badge icon', default: 'star' },
  speakers: { type: 'list', label: 'Speakers', itemLabel: 'Speaker', max: 12, fields: { name: { type: 'string', label: 'Name', default: '' }, role: { type: 'string', label: 'Role', default: '' } } },
  prices: { type: 'table', label: 'Price table', default: { columns: ['Ticket', 'Price'], rows: [['Day', '£12']] } }
};
const [{ definitionId: codeDef }] = await apply([{ type: 'component.createCode', name: 'Event programme', source: SOURCE, properties: ALL_TYPES }], 'Create code component');
await apply([{ type: 'node.insert', owner: home, parentId: null, definitionId: codeDef }], 'Place code component');
await pause(1500);

// ---- Create component ----
await select(/^Stack/);
await inspector.getByRole('button', { name: /^More actions for/ }).first().click();
await win.getByRole('menuitem', { name: /^Create component/ }).click();
await modal.waitFor();
await shot('create-empty', ['Component name']);
await shot('create-in-context', ['Component name'], { themes: ['light'], window: true });
await modal.getByLabel('Component name').fill('Feature highlight');
await shot('create-filled', ['Component name']);
await modal.getByLabel('Component name').fill('');
await modal.getByLabel('Component name').press('Enter');
await shot('create-required', ['Enter a name for this component.']);
await closeModal();

// ---- Rename component ----
await openRename('Exhibitor card');
await modal.getByLabel('Description').fill('Used for every stand on the fair pages');
await shot('rename-rest', ['Component name', 'Description']);
await modal.getByLabel('Component name').fill('Exhibitor card with a very long name for the spring fair page');
await modal.getByLabel('Description').fill('A long description of what this version is for, written by someone who wants to explain exactly where it belongs, which pages should use it, and how it differs from the other exhibitor cards in the library so that nobody picks the wrong one by accident.');
await shot('rename-long', ['Component name']);
await closeModal();

await openRename('Retired price strip');
await apply([{ type: 'component.remove', definitionId: spareDef }], 'Delete component');
await pause(500);
await shot('rename-deleted', ['This component has been deleted']);
await closeModal();

// ---- Make unique ----
await select('Exhibitor card');
await componentSection();
await inspector.getByRole('button', { name: 'Make unique…' }).click();
await modal.waitFor();
await shot('unique-rest', ['Name for the copy']);
await apply([{ type: 'node.remove', owner: home, nodeId: cardId }], 'Remove card');
await pause(500);
await shot('unique-stale', ['nothing to make unique']);
await win.evaluate(() => window.builder.project.undo());
await pause(500);
await closeModal();

// ---- Edit definition: used on many pages, used once, and from the theme ----
await openDefinition('Exhibitor card');
await shot('definition-many', ['Used on']);
await closeModal();
await openDefinition('Opening hours banner');
await shot('definition-once', ['Used once']);
await closeModal();
await openDefinition(heroName);
await shot('definition-theme', ['Foundation theme']);
await closeModal();

// ---- Properties: a new code component ----
await openInsert();
await sidePanel.getByRole('button', { name: 'New code component' }).click();
await modal.waitFor();
await win.getByRole('tab', { name: /^Properties/ }).click();
await modal.locator('.schema-editor').waitFor();
await shot('properties-new', ['Add property']);
// Each property's Remove is inside its settings, so each row is opened first.
for (let n = await modal.locator('.schema-row').count(); n > 0; n--) {
  const row = modal.locator('.schema-row').first();
  if ((await row.locator('.schema-row-toggle').getAttribute('aria-expanded')) !== 'true') await row.locator('.schema-row-toggle').click();
  await row.getByRole('button', { name: /^Remove / }).click();
}
await shot('properties-empty', ['No properties yet.']);
await closeModal();

// ---- Properties: one of every type ----
await openProperties('Event programme');
await shot('properties-all', ['Add property']);
await win.setViewportSize({ width: VIEWPORT.width, height: 3200 });
await pause(500);
await shot('properties-all-full', ['Add property']);
await win.setViewportSize({ width: 860, height: 760 });
await pause(500);
await shot('properties-narrow', ['Add property'], { themes: ['light'] });
await win.setViewportSize(VIEWPORT);
await pause(400);

// Keyboard focus on a row's type control.
await modal.getByLabel('Type').nth(1).focus();
await shot('properties-focus', ['Add property'], { themes: ['light'] });

// A row's settings open, for the types with the most to set.
const toggleFor = (name) => modal.getByRole('button', { name: new RegExp(`^${name} settings`) });
for (const name of ['columns', 'tone', 'speakers']) await toggleFor(name).click();
await toggleFor('columns').scrollIntoViewIfNeeded();
await win.setViewportSize({ width: VIEWPORT.width, height: 2000 });
await pause(500);
await shot('properties-open', ['Item fields', 'Options', 'Minimum']);
await win.setViewportSize(VIEWPORT);
await pause(300);
for (const name of ['columns', 'tone', 'speakers']) await toggleFor(name).click();

// Removing a property offers Undo.
await toggleFor('badge').click();
await modal.getByRole('button', { name: 'Remove badge' }).click();
await shot('properties-undo', ['Removed “Badge icon”.']);
await modal.locator('.schema-undo').getByRole('button', { name: 'Undo' }).click();
await toggleFor('badge').waitFor();
await toggleFor('badge').click();

// A setting that refuses what was typed keeps the text, with its reason, after the field is left.
await toggleFor('columns').click();
const minimum = modal.getByLabel('columns minimum');
await minimum.fill('three');
await minimum.press('Enter');
await pause(700);
if ((await minimum.inputValue()) !== 'three') throw new Error('the refused text did not stay in the field; refusing to write');
await shot('properties-refused', ['Minimum must be a number.', '1 problem to fix']);
await minimum.fill('1');
await minimum.press('Enter');
await pause(200);
await toggleFor('columns').click();

// Two names the engine refuses, reported on Save.
const first = modal.getByLabel('heading name');
await first.fill('Hero Title');
await first.press('Enter');
const second = modal.getByLabel('intro name');
await second.fill('body');
await second.press('Enter');
await pause(200);
await modal.getByRole('button', { name: 'Save' }).click();
await modal.locator('.scope-note.danger').first().waitFor();
await shot('properties-error', ['camelCase']);
await closeModal();

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`component authoring capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
