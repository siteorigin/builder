// Design capture for Paste style onto one card of a repeated part (panels/StylePaste.tsx, #1347): a Foundation
// section's card picked on the page with Apply to set to "This card", the review of a paste onto that card alone and
// the page after it; the same card with "All 3 cards", where other cards keep values of their own, and the page
// after that; the card part picked in Layers, with no one card chosen; and the card removed while its review is open,
// which ends the review. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/style-paste-cards.mjs
//
// Each state is checked on screen after it settles and the harness throws rather than write an image of a state
// that did not render. Files are named `{state}--{theme}.png` and show the dialog, or the window after a paste.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInspector } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('paste style onto cards capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'style-paste-cards');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-paste-cards-')));
const THEMES = ['light', 'dark'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForSelector('.welcome');
await win.emulateMedia({ reducedMotion: 'reduce' });
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const dialog = win.getByRole('dialog', { name: 'Paste style' });
const inspector = win.locator('#dock-panel-inspect');
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

/** Capture `root` (the dialog unless given) in each theme; every `checks` selector must be visible in it. */
async function shot(state, checks, { themes = THEMES, root = dialog } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await win.mouse.move(2, 880);
    await pause(350);
    for (const check of [].concat(checks)) {
      const visible = await root.locator(check).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    await root.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

// ---- A populated project ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Northbridge Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
await pause(1200);

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const s0 = await snapshot();
const pageId = s0.state.site.homePageId;
const page = s0.state.pages[pageId];
const find = (cid) => page.rootIds.map((id) => page.nodes[id]).find((n) => s0.state.components[n.definitionId]?.componentId === cid);
const grid = find('features.grid');
const media = find('content.media');
if (!grid || !media) throw new Error('the business starter has no Services grid or Content with image on its home page');
const items = grid.props.items;
if (!Array.isArray(items) || items.length < 3) throw new Error('Services grid has fewer than 3 cards');
const owner = { kind: 'page', id: pageId };
const set = (nodeId, partId, scope, property, value, itemId) => ({ type: 'node.setStyle', owner, nodeId, partId, ...(itemId ? { itemId } : {}), scope, property, value });
async function apply(ops, label) {
  for (const op of ops) {
    const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: [o] }, { label: l }), [op, label]);
    if (!r.ok) throw new Error(`fixture: ${op.partId}.${op.property}: ${JSON.stringify(r.error ?? r).slice(0, 200)}`);
  }
}

// The copy: Content with image's image frame, as the issue's styled box (a warm fill and round corners). Every card
// shares a vertical padding; the first card has round corners of its own, the second a fill of its own and the third
// its own padding on phones, so each review has real befores (the card's own, and the shared one it stops using) and
// the All cards review has cards that keep values of their own, at all sizes and at one.
await apply(
  [
    set(media.id, 'frame', 'base', 'background', '#FDE68A'),
    set(media.id, 'frame', 'base', 'radius', '28px'),
    set(media.id, 'frame', 'base', 'paddingBlock', '24px'),
    set(media.id, 'frame', 'phone', 'paddingBlock', '16px'),
    set(grid.id, 'card', 'base', 'paddingBlock', '20px'),
    set(grid.id, 'card', 'base', 'radius', '6px', items[0].id),
    set(grid.id, 'card', 'base', 'background', { token: 'color.surface' }, items[1].id),
    set(grid.id, 'card', 'phone', 'paddingBlock', '12px', items[2].id)
  ],
  'Fixture styles'
);
await pause(1200);

// ---- Copy style from the image frame, in Layers ----
await win.locator('.rail [aria-label="Layers"]').click();
await pause(500);
const row = (name) => win.locator('[role="tree"] .list-item', { hasText: name }).first();
const expand = async (name) => {
  const r = row(name);
  if ((await r.getAttribute('aria-expanded')) !== 'true') await r.locator('.tree-toggle').click();
  await pause(300);
};
await expand('Content with image');
await row('Image frame').click({ button: 'right' });
await win.getByRole('menuitem', { name: 'Copy style' }).click();
await win.locator('.toast', { hasText: 'Copied the style of' }).waitFor();
await pause(300);

// ---- Card 1 picked on the page ----
const cards = frame.locator('li.features__card');
const fills = () => cards.evaluateAll((els) => els.map((el) => `${getComputedStyle(el).backgroundColor} r=${getComputedStyle(el).borderTopLeftRadius}`));
const reach = inspector.getByRole('radiogroup', { name: /style which cards/ });
await openInspector(win);
const pickCard = async (i) => {
  for (let tries = 0; tries < 20; tries++) {
    await cards.nth(i).scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await cards.nth(i).dispatchEvent('click').catch(() => {});
    if (await reach.waitFor({ timeout: 1500 }).then(() => true, () => false)) return;
  }
  const head = await inspector.locator('.insp-head').first().innerText().catch(() => '(no inspector head)');
  await win.screenshot({ path: join(OUT, `failed-pick-card-${i + 1}.fail.png`) });
  throw new Error(`card ${i + 1} did not open with an Apply to choice; the Inspector shows: ${head.replace(/\s+/g, ' ')}`);
};
const openPaste = async () => {
  await inspector.getByRole('button', { name: /^More actions for Card/ }).first().click();
  await win.getByRole('menuitem', { name: /Paste style/ }).click();
  await dialog.waitFor();
  await pause(500);
};
/** Paste, check which cards took it (each card's fill: true where it should be the pasted one), and capture. */
const pasteAndShow = async (state, pasted) => {
  await dialog.getByRole('button', { name: /^Paste \d+ styles?$/ }).click();
  await dialog.waitFor({ state: 'detached' });
  await win.locator('.toast', { hasText: 'Pasted the style of' }).waitFor();
  await pause(1500);
  // The cards in the middle of the canvas, so the shot shows which of them took the paste.
  await cards.nth(0).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await pause(500);
  const now = await fills();
  console.log(`${state}: card fills`, JSON.stringify(now));
  const wrong = pasted.flatMap((yes, i) => ((now[i].startsWith('rgb(253, 230, 138)') === yes) ? [] : [`card ${i + 1} ${yes ? 'did not take' : 'took'} the paste`]));
  if (wrong.length) throw new Error(`state "${state}": ${wrong.join(', ')}; refusing to write`);
  await shot(state, ['.toast', '.insp-head'], { root: win.locator('body'), themes: ['light'] });
  // Undo the paste, so the next state starts from the fixture.
  await win.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await pause(1200);
};

await pickCard(0);
await reach.getByRole('radio', { name: 'This card' }).click();
await pause(400);
console.log('before: card fills', JSON.stringify(await fills()));

// ---- Paste onto this card ----
await openPaste();
await shot('review-this-card', ['h3']);
await pasteAndShow('pasted-this-card', [true, false, false]);

// ---- Paste onto every card: the second card keeps its own fill ----
await pickCard(0);
await reach.getByRole('radio', { name: /^All \d+ cards$/ }).click();
await pause(400);
await openPaste();
await shot('review-all-cards', ['h3']);
// The second card keeps its own fill.
await pasteAndShow('pasted-all-cards', [true, false, true]);

// ---- The card part picked in Layers, no one card chosen ----
// Layers is still open from the copy: the rail button would close it.
if (!(await win.locator('[role="tree"]').first().isVisible().catch(() => false))) await win.locator('.rail [aria-label="Layers"]').click();
await pause(400);
const cardRow = win.locator('[role="tree"] .layer-part[data-name="Card"]').first();
if (!(await cardRow.count())) {
  const labels = await win.locator('[role="tree"] [role="treeitem"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  throw new Error(`no Card part row in Layers: ${labels.join(' | ')}`);
}
await cardRow.scrollIntoViewIfNeeded();
await cardRow.click({ button: 'right' });
await win.getByRole('menuitem', { name: /Paste style/ }).click();
await dialog.waitFor();
await pause(500);
await shot('review-layers-card', ['h3'], { themes: ['light'] });
await win.keyboard.press('Escape');
await dialog.waitFor({ state: 'detached' });

// ---- The card leaves its list while its review is open: the review gives way to the reason and Close ----
await pickCard(0);
await reach.getByRole('radio', { name: 'This card' }).click();
await pause(300);
await openPaste();
await apply([{ type: 'instance.listRemove', owner, nodeId: grid.id, prop: 'items', itemId: items[0].id }], 'Remove the card');
await dialog.locator('.paste-gone').waitFor();
await pause(500);
console.log('card gone: focus on', JSON.stringify(await win.evaluate(() => document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute('aria-label'))));
await shot('review-card-gone', ['.paste-gone'], { themes: ['light'] });
// An Undo that brings the card back leaves the review ended: Close is still the one way on.
await win.evaluate(() => window.builder.project.undo());
await pause(1000);
const footer = await dialog.locator('.modal-foot button, footer button').allInnerTexts();
if (!(await dialog.locator('.paste-gone').isVisible()) || footer.join('|') !== 'Close') throw new Error(`the review came back after the card did: footer ${JSON.stringify(footer)}`);
await win.keyboard.press('Escape');
await dialog.waitFor({ state: 'detached' });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`paste style onto cards capture: ${written.length} images written, ${count} in ${OUT}`);
if (written.length !== 8) {
  console.error(`expected 8 images, wrote ${written.length}`);
  process.exit(1);
}
if (errors.length) {
  console.error('page errors:', errors);
  process.exit(1);
}
