// Style states and Background image capture harness: drives the real (built) app to the Inspector's Style tab and
// writes the State picker (under the size picker) and the Background image control in each state that carries
// design weight, at the dock's default and narrowest widths. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/style-states-background.mjs
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, openInspector, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('style states capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'style-states-background');
mkdirSync(OUT, { recursive: true });
const { WORK, cleanup } = scratch('design-style-states');
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const { app, win, errors } = await launch(WORK, {}, { viewport: { width: 1440, height: 1100 } });
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = await createProject(win, { name: 'State Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const dock = win.locator('#dock-panel-inspect');

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/** Capture the region around `target` (inside the dock), the dock's full width, `before` px above and `after` below. */
async function shot(state, target, themes = BOTH, { before = 12, after = 12, check } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    await win.mouse.move(700, 1090);
    await pause(200);
    const el = dock.locator(target).first();
    if (!(await el.isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${target}"; refusing to write`);
    if (check && !(await check())) throw new Error(`state "${state}" (${theme}) failed its check; refusing to write`);
    const box = await el.boundingBox();
    const panel = await dock.boundingBox();
    const y = Math.max(panel.y, box.y - before);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: panel.x, y, width: panel.width, height: Math.min(box.y + box.height + after, panel.y + panel.height) - y } });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

async function expandStyle() {
  const head = dock.locator('.section-head', { hasText: 'Style' }).first();
  await head.waitFor({ timeout: 15000 }).catch(async (e) => {
    await win.screenshot({ path: join(OUT, 'failed-style-section.png') });
    throw e;
  });
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  await dock.locator('.style-scope').waitFor({ timeout: 15000 });
}

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const grid = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  const node = page.rootIds.map((id) => page.nodes[id]).find((n) => s.state.components[n.definitionId]?.componentId === 'features.grid');
  return { owner: { kind: 'page', id: page.id }, nodeId: node.id };
});
const asset = Object.keys((await snapshot()).state.assets.assets).find(Boolean);
if (!asset) throw new Error('the starter has no sample images');
const apply = (operations) => win.evaluate((ops) => window.builder.project.apply({ operations: ops }, { label: 'Capture setup' }), operations);
const setCard = (property, value, state) => apply([{ type: 'node.setStyle', ...grid, partId: 'card', scope: 'base', ...(state ? { state } : {}), property, value }]);

const radios = dock.locator('.style-state-picker [role="radio"]');
const stateRadio = (name) => dock.locator('.style-state-picker').getByRole('radio', { name: new RegExp(`^${name}`) });
const sizeRadio = (name) => dock.locator('.style-scope-picker:not(.style-state-picker)').getByRole('radio', { name: new RegExp(`^${name}`) });
const count = (n) => async () => (await radios.count()) === n;

async function resizeDock(width) {
  const seam = win.locator('.seam.right .resizer');
  const now = Number(await seam.getAttribute('aria-valuenow'));
  const b = await seam.boundingBox();
  await win.mouse.move(b.x + b.width / 2, b.y + 300);
  await win.mouse.down();
  await win.mouse.move(b.x + b.width / 2 + (now - width), b.y + 300, { steps: 6 });
  await win.mouse.up();
  await pause(300);
  const got = Number(await seam.getAttribute('aria-valuenow'));
  if (Math.abs(got - width) > 2) throw new Error(`dock is ${got}px wide, wanted ${width}`);
}

// ---- The card itself: the group, so only its own states ----
// The phone preview is shown at full scale, so a click lands where it is aimed.
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await pause(800);
const card = frame.locator('li', { hasText: 'Planning & layout' }).first();
await card.scrollIntoViewIfNeeded();
await card.click({ modifiers: ['Alt'], position: { x: 6, y: 6 } });
await openInspector(win);
await expandStyle();
await shot('states-card-default', '.style-scope', LIGHT, { check: count(4) });

// ---- Background image on the card ----
const bgRow = '.style-row[data-prop="backgroundImage"]';
const showRow = async () => {
  await dock.locator(bgRow).first().scrollIntoViewIfNeeded();
  await pause(300);
};
await showRow();
await shot('bg-empty', bgRow, LIGHT);
await setCard('backgroundImage', { assetId: asset });
await dock.locator(`${bgRow} .style-media-options`).waitFor({ timeout: 15000 });
await showRow();
await shot('bg-picture', bgRow, BOTH);
await setCard('backgroundImage', { assetId: asset, size: 'cover', position: '30% 20%', scrim: 'rgba(0, 0, 0, 0.45)' });
await win.waitForFunction(() => document.querySelector('.style-row[data-prop="backgroundImage"] select:last-of-type')?.value !== '', null, { timeout: 15000 }).catch(() => {});
await showRow();
await shot('bg-scrim-preset', bgRow, BOTH);
await setCard('backgroundImage', { assetId: asset, scrim: 'linear-gradient(to bottom, rgba(20, 40, 80, 0.2), rgba(0, 0, 0, 0.8))' });
await pause(800);
await showRow();
await shot('bg-scrim-custom', bgRow, LIGHT);
// Custom chosen over a preset opens the field with that preset in it, to adjust.
await setCard('backgroundImage', { assetId: asset, scrim: 'rgba(0, 0, 0, 0.45)' });
await pause(800);
await dock.locator(`${bgRow} .style-media-options select`).nth(1).selectOption('custom');
await dock.locator(`${bgRow} .style-media-custom input`).waitFor({ timeout: 10000 });
await showRow();
await shot('bg-custom-from-preset', bgRow, LIGHT);
// The picture set for All sizes, seen from Phone: it shows through, saying where it comes from.
await sizeRadio('Phone').click();
await pause(600);
await showRow();
await shot('bg-inherited-phone', bgRow, LIGHT, { check: async () => (await dock.locator(`${bgRow} .insp-note`).count()) > 0 });
await sizeRadio('All sizes').click();
await pause(300);

// ---- A heading inside the card: once the card is an interaction group, its group's states are offered too ----
await setCard('backgroundImage', null);
const made = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  const node = page.rootIds.map((id) => page.nodes[id]).find((n) => s.state.components[n.definitionId]?.componentId === 'features.grid');
  const def = s.state.components[node.definitionId];
  // A theme design is forked into the project first (the placement moves to the fork), then its card is marked.
  const forked = await window.builder.project.apply({ operations: [{ type: 'component.fork', definitionId: def.id }] }, { label: 'Own the services grid' });
  if (!forked.ok) return JSON.stringify(forked.error ?? forked);
  const id = forked.results?.[0]?.definitionId ?? def.id;
  const ops = [{ type: 'node.setContent', owner: { kind: 'component', id }, nodeId: def.parts.card.nodeId, field: 'interactionGroup', value: true }];
  const r = await window.builder.project.apply({ operations: ops }, { label: 'Cards are groups' });
  return r.ok ? null : JSON.stringify(r.error ?? r);
});
if (made) throw new Error(`could not make the card a group: ${made}`);
await pause(1500);
const heading = card.locator('h3').first();
await heading.click({ modifiers: ['Alt'] });
await expandStyle();
await dock.locator('.style-scope').scrollIntoViewIfNeeded();
await shot('states-default', '.style-scope', BOTH, { check: count(6) });
await stateRadio('Hover').click();
await win.waitForFunction(() => document.querySelector('.style-scope-note strong')?.textContent?.startsWith('Hover'), null, { timeout: 10000 });
// A hover change of its own, so Hover carries the "has its own changes" mark.
const headingRow = dock.locator('.style-row[data-prop="color"]').first();
await headingRow.locator('select').first().selectOption('custom');
const colorInput = dock.getByRole('textbox', { name: /^Text color value|^Color value/ }).first();
await colorInput.fill('#cc3300');
await colorInput.press('Enter');
await dock.locator('.style-state-picker [data-state="hover"] .style-scope-dot').waitFor({ timeout: 15000 });
await shot('states-hover-marked', '.style-scope', BOTH);
await stateRadio('Group hover').click();
await pause(300);
await shot('states-group-hover', '.style-scope', LIGHT);
await sizeRadio('Phone').click();
await pause(300);
await shot('states-phone-group-hover', '.style-scope', LIGHT);
await sizeRadio('All sizes').click();
await stateRadio('Default').click();
await pause(300);
await shot('states-default-marked', '.style-scope', LIGHT);
// From the keyboard: an arrow moves to Hover, which shows its focus ring.
await stateRadio('Default').focus();
await win.keyboard.press('ArrowRight');
await pause(300);
await shot('states-keyboard', '.style-scope', LIGHT, { check: async () => (await dock.locator('.style-state-picker [data-state="hover"]:focus-visible').count()) === 1 });

// ---- The dock at its narrowest ----
await resizeDock(300);
await stateRadio('Focus').click();
await pause(300);
await shot('narrow-states-focus', '.style-scope', LIGHT);
await card.click({ modifiers: ['Alt'], position: { x: 6, y: 6 } });
await expandStyle();
await setCard('backgroundImage', { assetId: asset, scrim: 'rgba(0, 0, 0, 0.65)' });
await dock.locator(`${bgRow} .style-media-options`).waitFor({ timeout: 15000 });
await showRow();
await shot('narrow-bg-scrim', bgRow, LIGHT);

if (errors.length) throw new Error(`page errors: ${errors.join('\n')}`);
await app.close();
cleanup?.();
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
console.log(`wrote ${written.length} captures; ${files.length} PNGs in ${OUT}`);
if (written.length !== 19) throw new Error(`expected 19 captures, wrote ${written.length}`);
