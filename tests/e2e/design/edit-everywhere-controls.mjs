// Design capture for Edit everywhere's contract and interaction controls: the Inspector sections a component's own
// design shows (Properties, Slots, Variants and UI state on its root; When clicked, Conditions, Dialog or drawer and
// On each placement on the nodes inside), in ContractControls.tsx and InteractionControls.tsx, beside the Conditions
// and Entrance sections they sit with. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/edit-everywhere-controls.mjs
//
// A populated component is made through the real edit pipeline and opened in Component Studio. Each state is checked
// on screen after it settles and the harness throws rather than write an image of a state that did not render. Files
// are named `{state}--{theme}.png` and show the Inspector panel.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { MOD } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('edit everywhere controls capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-everywhere-')));
const THEMES = ['light', 'dark'];
// Tall, so the root's whole stack of sections fits the Inspector without scrolling.
const VIEWPORT = { width: 1440, height: 4200 };

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
const inspector = win.locator('#dock-panel-inspect');
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

/**
 * Capture the Inspector in each theme; every `texts` entry must be visible in it. `clip` limits the image to the
 * sections whose heads it names, top to bottom, so a long stack can be shown a few sections at a time.
 */
async function shot(state, texts, { themes = THEMES, clip, keepFocus = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    if (!keepFocus) await win.mouse.move(2, 2);
    await pause(350);
    for (const text of [].concat(texts)) {
      const visible = await inspector.getByText(text, { exact: false }).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${text}"; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    const box = await inspector.boundingBox();
    if (!box) throw new Error(`state "${state}": no Inspector on screen`);
    let region = box;
    if (clip) {
      const rects = [];
      for (const title of clip) {
        const section = inspector.locator('.section', { has: win.locator(`.section-head:has-text("${title}")`) }).first();
        const r = await section.boundingBox();
        if (!r) throw new Error(`state "${state}": no "${title}" section to clip to`);
        rects.push(r);
      }
      const top = Math.min(...rects.map((r) => r.y)) - 4;
      const bottom = Math.max(...rects.map((r) => r.y + r.height)) + 4;
      region = { x: box.x, y: Math.max(box.y, top), width: box.width, height: Math.min(box.y + box.height, bottom) - Math.max(box.y, top) };
    } else {
      // The panel down to the end of its last section, not the empty space below it.
      const last = await inspector.locator('.section').last().boundingBox();
      if (last) region = { ...box, height: Math.min(box.height, last.y + last.height - box.y + 16) };
    }
    await win.screenshot({ path, clip: region });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

const apply = (operations, label) =>
  win.evaluate(
    async ([operations, label]) => {
      const r = await window.builder.project.apply({ operations, label });
      if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
      return r.results;
    },
    [operations, label]
  );

/** Open a section (scrolling it into view) by its ID. */
const openSection = async (id) => {
  for (let i = 0; i < 2; i++) {
    await win.evaluate((sid) => window.dispatchEvent(new CustomEvent('inspector-open-section', { detail: { id: sid, scroll: false } })), id);
    await pause(300);
  }
};
const scrollTop = () => win.evaluate(() => document.querySelector('#dock-panel-inspect .panel-body')?.scrollTo({ top: 0 }));

// ---- A project with a populated component placed twice ----
const sites = join(WORK, 'sites');
const res = await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'blank', sampleImages: false }), sites);
if (!res.ok) throw new Error(`project creation failed: ${res.message}`);
await win.waitForSelector('.editor');
const frame = win.frameLocator('.frame-box iframe');
await frame.locator('body *').first().waitFor({ timeout: 90000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });

const none = { type: 'none', target: '' };
const [made] = await apply(
  [
    {
      type: 'component.upsert',
      name: 'Pricing panel',
      properties: {
        heading: { type: 'string', label: 'Heading', default: 'Plans for every team' },
        intro: { type: 'string', label: 'Introduction', multiline: true, default: 'Pick monthly or save with a year up front.' },
        showBadge: { type: 'boolean', label: 'Show badge', default: true },
        features: {
          type: 'list',
          label: 'Features',
          itemLabel: 'Feature',
          fields: { title: { type: 'string', label: 'Title', default: '' }, detail: { type: 'string', label: 'Detail', default: '' } },
          default: [
            { title: 'Unlimited projects', detail: 'Make as many sites as you need.' },
            { title: 'Priority support', detail: 'Answers within a working day.' }
          ]
        },
        spare: { type: 'number', label: 'Seats included', default: 5 }
      },
      nodes: [
        { kind: 'element', id: 'root', tag: 'section', children: ['badge', 'heading', 'intro', 'tabs', 'monthly', 'annual', 'features', 'actions', 'termsButton', 'drawer'] },
        { kind: 'text', id: 'badge', name: 'Badge', text: 'New', when: { $prop: 'showBadge' } },
        { kind: 'text', id: 'heading', name: 'Heading', tag: 'h2', text: { $prop: 'heading' } },
        { kind: 'text', id: 'intro', name: 'Introduction', text: { $prop: 'intro' } },
        { kind: 'element', id: 'tabs', name: 'Tabs', children: ['monthlyTab', 'annualTab', 'nextTab'] },
        { kind: 'link', id: 'monthlyTab', name: 'Monthly button', link: none, label: 'Monthly', appearance: 'secondary', stateAction: { state: 'billing', op: 'set', value: 'monthly' } },
        { kind: 'link', id: 'annualTab', name: 'Annual button', link: none, label: 'Annual', appearance: 'secondary', stateAction: { state: 'billing', op: 'set', value: 'annual' } },
        { kind: 'link', id: 'nextTab', name: 'Next plan button', link: none, label: 'Next', appearance: 'text', stateAction: { state: 'billing', op: 'next', wrap: true } },
        { kind: 'element', id: 'monthly', name: 'Monthly panel', children: ['monthlyText'], when: { ref: { $state: 'billing' }, eq: 'monthly' } },
        { kind: 'text', id: 'monthlyText', name: 'Monthly price', text: '$12 a month' },
        { kind: 'element', id: 'annual', name: 'Annual panel', children: ['annualText'], when: { ref: { $state: 'billing' }, eq: 'annual' } },
        { kind: 'text', id: 'annualText', name: 'Annual price', text: '$120 a year' },
        { kind: 'repeat', id: 'features', name: 'Feature list', list: 'features', children: ['featureTitle'] },
        { kind: 'text', id: 'featureTitle', name: 'Feature title', text: { $item: 'title' } },
        { kind: 'slot', id: 'actions', slot: 'actions' },
        { kind: 'link', id: 'termsButton', name: 'Terms button', link: none, label: 'Terms', appearance: 'link', stateAction: { state: 'termsOpen', op: 'toggle' } },
        { kind: 'element', id: 'drawer', name: 'Terms drawer', children: ['drawerText'], when: { $state: 'termsOpen' }, overlay: 'drawer-end' },
        { kind: 'text', id: 'drawerText', name: 'Terms', text: 'Cancel any time.' }
      ],
      parts: { heading: { nodeId: 'heading', label: 'Heading' } },
      slots: {
        actions: { label: 'Buttons', description: 'The calls to action under the prices.', primitives: ['link'], max: 2 }
      },
      variantAxes: {
        tone: { label: 'Tone', default: 'light', options: { light: { label: 'Light' }, dark: { label: 'Dark', styles: { root: { background: '#1b2433' } } }, brand: { label: 'Brand' } } },
        width: { label: 'Width', options: { narrow: { label: 'Narrow' }, wide: { label: 'Wide' } } }
      },
      state: {
        billing: { type: 'enum', label: 'Billing', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }, { value: 'lifetime', label: 'Lifetime' }] },
        termsOpen: { type: 'boolean', label: 'Terms open' }
      }
    }
  ],
  'Make Pricing panel'
);
const defId = made.definitionId;
const pageId = (await win.evaluate(async () => (await window.builder.project.snapshot()).state.site.homePageId));
const owner = { kind: 'page', id: pageId };
await apply([{ type: 'node.insert', owner, parentId: null, index: 0, definitionId: defId }], 'Place it');
const [second] = await apply([{ type: 'node.insert', owner, parentId: null, index: 1, definitionId: defId }], 'Place it again');
// The second placement has no heading, so making Heading required has a placement to report.
await apply([{ type: 'instance.setProp', owner, nodeId: second.nodeId, prop: 'heading', value: '' }], 'Clear the second heading');
// An empty component, for the sections' empty states.
const [bare] = await apply([{ type: 'component.upsert', name: 'Plain note', properties: {}, nodes: [{ kind: 'element', id: 'root', children: ['body'] }, { kind: 'text', id: 'body', name: 'Body', text: 'A short note.' }] }], 'Make Plain note');

// ---- Open the component in Component Studio ----
async function openStudio(name, id) {
  await win.locator('.canvas').focus();
  await win.keyboard.press(`${MOD}+K`);
  await win.locator('.cmdk').waitFor();
  await win.keyboard.type(`${name} studio`);
  await win.locator('.cmdk [role="option"]', { hasText: 'in Component Studio' }).first().click();
  await win.locator('.mode-band').filter({ hasText: `${name} in Component Studio` }).waitFor({ timeout: 30000 });
  await frame.locator(`[data-so-ctx="preview:${id}|preview"] [data-so-node="root"], [data-so-ctx="preview:${id}|preview"][data-so-node="root"]`).first().waitFor({ timeout: 60000 });
  await pause(1200);
}
const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
async function selectNode(id, nodeId) {
  await openRail('Layers');
  const row = win.locator(`[role="tree"] [data-owner="component:${id}"][data-node="${nodeId}"]`).first();
  if (!(await row.isVisible().catch(() => false))) await frame.locator(`[data-so-ctx="preview:${id}|preview"] [data-so-node="${nodeId}"]`).first().dispatchEvent('click');
  else await row.click();
  for (let i = 0; i < 40 && (await row.getAttribute('aria-selected').catch(() => null)) !== 'true'; i++) await pause(250);
  if ((await row.getAttribute('aria-selected')) !== 'true') throw new Error(`could not select ${nodeId}`);
  const tab = win.locator('#dock-tab-inspect');
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await inspector.waitFor();
  await pause(700);
  await scrollTop();
}

// ---- The empty component's root: every section's empty state ----
await openStudio('Plain note', bare.definitionId);
await selectNode(bare.definitionId, 'root');
await shot('root-empty', ['Properties', 'Slots', 'Variants', 'UI state'], { clip: ['Properties', 'Slots', 'Variants', 'UI state'] });
await win.getByRole('button', { name: 'Done editing' }).first().click().catch(() => {});
await pause(800);

// ---- The populated component's root ----
await openStudio('Pricing panel', defId);
await selectNode(defId, 'root');
await shot('root-stack', ['Properties', 'Slots', 'Variants', 'UI state', 'Conditions']);
await shot('root-properties', ['Properties'], { clip: ['Properties'] });
await shot('root-slots-variants', ['Slots', 'Variants'], { clip: ['Slots', 'Variants'] });
await shot('root-ui-state', ['UI state'], { clip: ['UI state'] });

// Required on for Heading: the note under it says which placements are missing it now. Feature fields opened.
await inspector.getByRole('switch', { name: 'Heading required' }).click();
await inspector.locator('[role="status"]', { hasText: 'missing' }).first().waitFor({ timeout: 15000 });
await inspector.locator('.contract-fields > summary').first().click();
await pause(400);
await shot('root-properties-required', ['missing Heading'], { clip: ['Properties'] });

// A slot's contract being edited, restricted to what is checked.
await inspector.getByRole('button', { name: 'Edit Buttons' }).click();
await pause(400);
await shot('root-slot-form', ['What belongs there'], { clip: ['Slots'] });
// Saved with no name: refused at the Name field, which takes focus.
const slotName = inspector.locator('[data-slot-form] input').first();
await slotName.fill('');
await inspector.locator('[data-slot-form]').getByRole('button', { name: 'Save' }).click();
await pause(400);
await shot('root-slot-form-refused', ['Give the slot a name'], { clip: ['Slots'], themes: ['light'], keepFocus: true });
await inspector.getByRole('button', { name: 'Cancel' }).first().click();
await pause(300);

// A property name being renamed: its count shows inside the field while it is focused.
await inspector.getByLabel('Name of the Heading property').focus();
await pause(300);
await shot('root-property-focused', ['Properties'], { clip: ['Properties'], themes: ['light'], keepFocus: true });
await inspector.getByLabel('Name of the Heading property').press('Escape');

// Add rows with text typed in, so their buttons are live.
await inspector.getByLabel('Name of the choice').fill('Size');
await inspector.getByLabel('Its first option').fill('Compact');
await inspector.getByLabel('Name of the state').fill('Menu open');
await inspector.getByLabel('Kind of state').selectOption('boolean');
await pause(300);
await shot('root-add-rows-typed', ['Variants', 'UI state'], { clip: ['Variants', 'UI state'], themes: ['light'] });
await inspector.getByLabel('Name of the choice').fill('');
await inspector.getByLabel('Its first option').fill('');
await inspector.getByLabel('Name of the state').fill('');
await inspector.getByLabel('Kind of state').selectOption('enum');

// ---- A button inside: When clicked, beside Conditions and Entrance ----
await selectNode(defId, 'nextTab');
await openSection('def-entrance');
await scrollTop();
await shot('button-when-clicked', ['When clicked', 'Conditions'], { clip: ['When clicked', 'Conditions'] });

// ---- A container inside: On each placement, Slots' add row, Conditions, Dialog or drawer, Entrance ----
await selectNode(defId, 'drawer');
await openSection('def-entrance');
await scrollTop();
await shot('container-drawer', ['On each placement', 'Dialog or drawer'], { clip: ['On each placement', 'Slots', 'Conditions', 'Dialog or drawer', 'Entrance'] });

// ---- The heading, a styled part ----
await selectNode(defId, 'heading');
await scrollTop();
await shot('heading-part', ['On each placement'], { clip: ['On each placement'], themes: ['light'] });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`edit everywhere controls capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
