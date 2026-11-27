// Design capture for the component editing band (Editor.tsx, Editor.css) in both of its forms: Edit everywhere on a
// page, and Component Studio with its view controls (panels/StudioControls.tsx). Opt-in only, never part of
// `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out node tests/e2e/design/component-mode-band.mjs
//
// A component with three variant axes and two UI states is made through the real edit pipeline and placed on two
// pages. Each state is checked on screen after it settles, and the harness throws rather than write an image of a
// state that did not render. Files are named `{state}--{theme}.png`: `*-window` is the whole editor, `*-band` the band
// alone with the toolbar above it.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { MOD } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('component mode band capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR;
if (!OUT || !isAbsolute(OUT)) throw new Error('DESIGN_CAPTURE_DIR must be an absolute path outside the repository');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-band-')));
const THEMES = ['light', 'dark'];
const WIDE = { width: 1440, height: 900 };

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize(WIDE);
await win.waitForSelector('.welcome', { timeout: 90000 });
await win.emulateMedia({ reducedMotion: 'reduce' });
const pause = (ms) => win.waitForTimeout(ms);
const band = win.locator('.mode-band');
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

/**
 * Capture in each theme; every `texts` entry must be visible in the band. `region` is 'window' (the whole editor) or
 * 'band' (the toolbar and the band, the full window width).
 */
async function shot(state, texts, { themes = THEMES, region = 'window', keepPointer = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    if (!keepPointer) await win.mouse.move(700, 600);
    await pause(400);
    if (!(await band.isVisible())) throw new Error(`state "${state}" (${theme}): no band on screen; refusing to write`);
    for (const text of [].concat(texts)) {
      const visible = await band.getByText(text, { exact: false }).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${text}"; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    let clip;
    if (region === 'band') {
      const b = await band.boundingBox();
      if (!b) throw new Error(`state "${state}": the band has no box`);
      clip = { x: 0, y: 0, width: b.x + b.width, height: b.y + b.height + 24 };
    }
    await win.screenshot({ path, ...(clip ? { clip } : {}) });
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

// ---- A project with a populated component placed on two pages ----
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
        intro: { type: 'string', label: 'Introduction', multiline: true, default: 'Pick monthly or save with a year up front.' }
      },
      nodes: [
        { kind: 'element', id: 'root', tag: 'section', children: ['heading', 'intro', 'tabs', 'monthly', 'annual', 'termsButton', 'drawer'] },
        { kind: 'text', id: 'heading', name: 'Heading', tag: 'h2', text: { $prop: 'heading' } },
        { kind: 'text', id: 'intro', name: 'Introduction', text: { $prop: 'intro' } },
        { kind: 'element', id: 'tabs', name: 'Tabs', children: ['monthlyTab', 'annualTab'] },
        { kind: 'link', id: 'monthlyTab', name: 'Monthly button', link: none, label: 'Monthly', appearance: 'secondary', stateAction: { state: 'billing', op: 'set', value: 'monthly' } },
        { kind: 'link', id: 'annualTab', name: 'Annual button', link: none, label: 'Annual', appearance: 'secondary', stateAction: { state: 'billing', op: 'set', value: 'annual' } },
        { kind: 'element', id: 'monthly', name: 'Monthly panel', children: ['monthlyText'], when: { ref: { $state: 'billing' }, eq: 'monthly' } },
        { kind: 'text', id: 'monthlyText', name: 'Monthly price', text: '$12 a month' },
        { kind: 'element', id: 'annual', name: 'Annual panel', children: ['annualText'], when: { ref: { $state: 'billing' }, eq: 'annual' } },
        { kind: 'text', id: 'annualText', name: 'Annual price', text: '$120 a year' },
        { kind: 'link', id: 'termsButton', name: 'Terms button', link: none, label: 'Terms', appearance: 'link', stateAction: { state: 'termsOpen', op: 'toggle' } },
        { kind: 'element', id: 'drawer', name: 'Terms drawer', children: ['drawerText'], when: { $state: 'termsOpen' }, overlay: 'drawer-end' },
        { kind: 'text', id: 'drawerText', name: 'Terms', text: 'Cancel any time.' }
      ],
      variantAxes: {
        tone: { label: 'Tone', default: 'light', options: { light: { label: 'Light' }, dark: { label: 'Dark', styles: { root: { background: '#1b2433' } } }, brand: { label: 'Brand' } } },
        width: { label: 'Width', default: 'wide', options: { narrow: { label: 'Narrow' }, wide: { label: 'Wide' } } },
        density: { label: 'Density', default: 'comfortable', options: { comfortable: { label: 'Comfortable' }, compact: { label: 'Compact' } } }
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
const homeId = await win.evaluate(async () => (await window.builder.project.snapshot()).state.site.homePageId);
await apply([{ type: 'node.insert', owner: { kind: 'page', id: homeId }, parentId: null, index: 0, definitionId: defId }], 'Place it');
await apply([{ type: 'page.create', title: 'About', starter: 'intro', addToNavigation: true }], 'Add About');
const aboutId = await win.evaluate(async () => Object.values((await window.builder.project.snapshot()).state.pages).find((p) => p.title === 'About').id);
await apply([{ type: 'node.insert', owner: { kind: 'page', id: aboutId }, parentId: null, index: 0, definitionId: defId }], 'Place it on About');
await apply([{ type: 'node.insert', owner: { kind: 'page', id: homeId }, parentId: null, index: 1, definitionId: defId }], 'Place it again');
// A component placed nowhere, with no variants or states: the Studio band at its plainest.
const [bare] = await apply([{ type: 'component.upsert', name: 'Plain note', properties: {}, nodes: [{ kind: 'element', id: 'root', children: ['body'] }, { kind: 'text', id: 'body', name: 'Body', text: 'A short note.' }] }], 'Make Plain note');
await pause(1500);

const openRail = async (name) => {
  if ((await win.locator(`.rail [aria-label="${name}"]`).getAttribute('aria-pressed')) !== 'true') await win.locator(`.rail [aria-label="${name}"]`).click();
};
const previewRoot = (id) => frame.locator(`[data-so-ctx="preview:${id}|preview"] [data-so-node="root"], [data-so-ctx="preview:${id}|preview"][data-so-node="root"]`).first();

// ---- Edit everywhere, entered from the placement's Inspector ----
await openRail('Layers');
await win.locator('[role="tree"] .list-item', { hasText: 'Pricing panel' }).first().click();
const tab = win.locator('#dock-tab-inspect');
if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
const compSection = win.locator('#dock-panel-inspect .section-head', { hasText: 'Component' }).first();
await compSection.waitFor();
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: 'Edit everywhere…' }).click();
await win.locator('.modal').getByRole('button', { name: /^Edit (everywhere|design)$/ }).click();
await band.filter({ hasText: 'Editing Pricing panel everywhere' }).waitFor({ timeout: 30000 });
await pause(1200);
// Entering selects the whole design; Escape steps back to its overview, with nothing selected.
await win.keyboard.press('Escape');
await pause(800);
await shot('everywhere-overview-window', ['Editing Pricing panel everywhere', 'Done editing']);
await shot('everywhere-band', ['Editing Pricing panel everywhere', 'Open in Component Studio'], { region: 'band' });
await win.setViewportSize({ width: 980, height: 760 });
await pause(800);
await shot('everywhere-narrowest-band', ['Done editing'], { region: 'band', themes: ['light'] });
await win.setViewportSize(WIDE);
await pause(800);

// The heading picked inside: the canvas outline and the selected layer take the mode's colour.
const headingRow = win.locator(`[role="tree"] [data-owner="component:${defId}"][data-node="heading"]`).first();
if (await headingRow.isVisible().catch(() => false)) await headingRow.click();
else await frame.locator('[data-so-node="heading"]').first().dispatchEvent('click');
await pause(900);
if (!(await win.locator('[role="tree"] .list-item.selected').first().isVisible())) throw new Error('no selected layer in Edit everywhere');
await shot('everywhere-selected-window', ['Editing Pricing panel everywhere']);

// Keyboard focus on Done editing, the way out.
await win.locator('.mode-band-done').focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await pause(300);
await shot('everywhere-done-focus-band', ['Done editing'], { region: 'band', themes: ['light'] });
await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
await win.locator('.mode-band-done').hover();
await pause(300);
await shot('everywhere-done-hover-band', ['Done editing'], { region: 'band', themes: ['light'], keepPointer: true });
await win.locator('.mode-band-done').click();
await band.waitFor({ state: 'detached' });
await pause(600);

// ---- Component Studio ----
async function openStudio(name, id) {
  await win.locator('.canvas').focus();
  await win.keyboard.press(`${MOD}+K`);
  await win.locator('.cmdk').waitFor();
  await win.keyboard.type(`${name} studio`);
  await win.locator('.cmdk [role="option"]', { hasText: 'in Component Studio' }).first().click();
  await band.filter({ hasText: `${name} in Component Studio` }).waitFor({ timeout: 30000 });
  await previewRoot(id).waitFor({ timeout: 60000 });
  // The canvas was focused only to open the command menu; its focus ring is not part of the state.
  await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await pause(1200);
}
await openStudio('Pricing panel', defId);
await shot('studio-window', ['Pricing panel in Component Studio', 'Preview only']);
await shot('studio-band', ['Pricing panel in Component Studio'], { region: 'band' });

// A narrower window: the sentence and the six selects share the row.
await win.setViewportSize({ width: 1180, height: 820 });
await pause(800);
await shot('studio-narrow-window', ['Pricing panel in Component Studio'], { themes: ['light'] });
await win.setViewportSize({ width: 980, height: 760 });
await pause(800);
await shot('studio-narrowest-window', ['Pricing panel in Component Studio'], { themes: ['light'] });
await win.setViewportSize(WIDE);
await pause(800);

// Non-default view: another tone, a state other than where visitors start, long content.
await win.locator('[data-studio-axis="tone"]').selectOption('dark');
await win.locator('[data-studio-state="billing"]').selectOption('annual');
const sampleOptions = await win.locator('[data-studio-sample] option').evaluateAll((os) => os.map((o) => o.value));
if (sampleOptions.length > 1) await win.locator('[data-studio-sample]').selectOption(sampleOptions[1]);
await pause(1500);
if ((await band.locator('.reset-dot').count()) !== 3) throw new Error('the three changed choices do not each carry a reset dot');
await shot('studio-changed-band', ['Pricing panel in Component Studio', 'Preview only'], { region: 'band' });
await win.setViewportSize({ width: 980, height: 760 });
await pause(800);
await shot('studio-changed-narrowest-band', ['Preview only'], { region: 'band', themes: ['light'] });
await win.setViewportSize(WIDE);
await pause(800);
await win.locator('.mode-band-done').click();
await band.waitFor({ state: 'detached' });
await pause(600);

// The plainest Studio: placed nowhere, with no fields a sample could change, so no preview row at all.
await openStudio('Plain note', bare.definitionId);
await shot('studio-plain-band', ['Not placed anywhere yet'], { region: 'band', themes: ['light'] });
await win.locator('.mode-band-done').click();
await band.waitFor({ state: 'detached' });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`component mode band capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
