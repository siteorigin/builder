// Content editors capture harness: drives the real (built) app through the states of the two focused editors in
// the Inspector, the data table editor (columns, rows, adding, removing, reordering, its limits) and the image
// focal point editor (the crop at each screen size and the point that stays in view), and writes one PNG of the
// dock per state and theme. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/content-editors.mjs
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('content editors capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'content-editors');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-content-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 1200 });
await win.waitForSelector('.welcome');
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(150);
  }
}

/** Capture the dock in the given themes; `verify` must hold at the moment of capture. */
async function shot(state, verify, themes = BOTH, { moveMouse = true } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    if (moveMouse) await win.mouse.move(700, 1190);
    await pause(200);
    if (!(await verify().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.locator('.dock').screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
  await pause(120);
}

// ---- Project ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1500);
await win.locator('.dock-tab', { hasText: 'Inspector' }).click();

// ---- The data table ----
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await win.getByLabel('Search items to add').fill('table');
await until(async () => /^Data table/.test(await win.getByRole('listbox', { name: 'Results' }).getByRole('option').first().innerText()), 'the Data table result');
await win.getByLabel('Search items to add').press('Enter');
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Data table' }).waitFor({ timeout: 30000 });
const tableEd = win.locator('#dock-panel-inspect [data-table="table"]');
await tableEd.waitFor({ timeout: 15000 });

/** Put a table in the project through the same edit the Inspector sends. */
async function setTable(columns, rows) {
  const value = {
    columns: columns.map((label, i) => ({ id: `col_c${i}`, label })),
    rows: rows.map((cells, r) => ({ id: `row_r${r}`, cells: Object.fromEntries(cells.map((text, i) => [`col_c${i}`, text])) }))
  };
  await win.evaluate(async (v) => {
    const s = await window.builder.project.snapshot();
    for (const page of Object.values(s.state.pages)) {
      const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === 'data.table');
      if (!node) continue;
      const r = await window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: page.id }, nodeId: node.id, prop: 'table', value: v }] }, { label: 'Seed table' });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return;
    }
    throw new Error('no data table on any page');
  }, value);
  const count = `${columns.length} column${columns.length === 1 ? '' : 's'} · ${rows.length} row${rows.length === 1 ? '' : 's'}`;
  await until(async () => (await tableEd.locator('.insp-count').first().innerText()).trim() === count, `the table to show ${count}`);
  await pause(250);
}
const tableShows = (text) => async () => (await tableEd.isVisible()) && (await tableEd.innerText()).includes(text);
const rowHead = (i) => tableEd.locator('.list-editor-head button.title').nth(i);

const PLANS = ['Plan', 'Pages', 'Support', 'Price'];
const PLAN_ROWS = [
  ['Starter', '5', 'Email', '$19'],
  ['Studio', '25', 'Email and chat', '$49'],
  ['Agency', 'Unlimited', 'Priority', '$129'],
  ['Enterprise', 'Unlimited', 'Dedicated manager', 'Ask us']
];
await setTable(PLANS, PLAN_ROWS);
await tableEd.scrollIntoViewIfNeeded();
await shot('table-rest', tableShows('Enterprise'));

await rowHead(1).click();
await until(async () => (await rowHead(1).getAttribute('aria-expanded')) === 'true', 'row 2 to open');
await shot('table-row-open', async () => (await tableEd.getByLabel('Support', { exact: true }).inputValue()) === 'Email and chat');

// Keyboard focus on an open row's move control: reached with Tab, so the focus ring is the real one.
await rowHead(2).click();
await until(async () => (await rowHead(2).getAttribute('aria-expanded')) === 'true', 'row 3 to open');
await tableEd.getByRole('button', { name: /^Move row .* up$/ }).focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await shot('table-keyboard-focus', () => win.evaluate(() => /^Move row /.test(document.activeElement?.getAttribute('aria-label') ?? '') && document.activeElement.matches(':focus-visible')), LIGHT);
await win.evaluate(() => document.activeElement?.blur());
await rowHead(2).click();

await setTable(
  ['Workshop or course name as printed in the brochure', 'Who it suits best', 'Starts'],
  [
    ['Wheel throwing for complete beginners, including all clay and glazes', 'Anyone who has never touched clay before', 'Monday 18:30'],
    ['Hand building', 'Returning students', 'Wednesday 18:30'],
    ['', '', '']
  ]
);
await rowHead(0).click();
await shot('table-long-text', tableShows('Wheel throwing'), LIGHT);
await rowHead(0).click();

await setTable(['Opening hours'], [['Monday to Friday, 9 to 5'], ['Saturday, 10 to 2']]);
await shot('table-one-column', tableShows('at least one column'), LIGHT);

await setTable(['Day', 'Workshop', 'Start time'], []);
await shot('table-no-rows', tableShows('0 rows'), BOTH);

await setTable(Array.from({ length: 12 }, (_, i) => `Week ${i + 1}`), [Array.from({ length: 12 }, (_, i) => `Topic ${i + 1}`)]);
await shot('table-column-limit', tableShows('at most 12 columns'), LIGHT);
// Scrolled sideways: the first column stays beside the disclosures, and both edges show there is more.
await tableEd.locator('.table-grid-scroll').evaluate((el) => (el.scrollLeft = 200));
await shot('table-scrolled', async () => (await tableEd.locator('.table-grid-frame.more-left.more-right').count()) === 1, LIGHT);

await setTable(['Day', 'Workshop'], Array.from({ length: 60 }, (_, i) => [`Day ${i + 1}`, `Session ${i + 1}`]));
await tableEd.getByRole('button', { name: 'Add row' }).scrollIntoViewIfNeeded();
await shot('table-row-limit', tableShows('at most 60 rows'), LIGHT);
await setTable(PLANS, PLAN_ROWS);

// ---- The image focal point ----
const styleRow = (name) => win.locator('.style-row', { hasText: name }).first();
const pad = win.locator('.focus-pad');
const caption = win.locator('.focus-caption');
const captionIs = (re) => async () => (await win.locator('.focus-editor').isVisible()) && re.test(await caption.innerText());
const across = win.getByRole('textbox', { name: 'Image focus across, percent from the left' });
// A size with its own changes adds ", has its own changes" to its name.
const scopeRadio = (name) => win.getByRole('radiogroup', { name: 'Edit styles for' }).getByRole('radio', { name: new RegExp(`^${name}`) });
async function selectPart(img, section) {
  await img.scrollIntoViewIfNeeded();
  await img.click({ modifiers: ['Alt'] });
  await until(async () => new RegExp(`Image[\\s\\S]*Part of ${section}`).test(await win.locator('.insp-head').first().innerText()), `the ${section} image to be selected`);
  await styleRow('Aspect ratio').waitFor({ timeout: 15000 });
}

// The phone preview is shown at full scale, so a click lands where Playwright aims it.
await win.getByRole('radio', { name: 'Phone', exact: true }).first().click();
await pause(800);
await selectPart(frame.locator('img[src*="studio"]').first(), 'Content with image');
await scopeRadio('All sizes').click();
await win.locator('.focus-editor').scrollIntoViewIfNeeded();
// The section's own design may already crop this picture, so its ratio is set to the picture's own shape first.
await styleRow('Aspect ratio').locator('select').selectOption('auto');
await until(captionIs(/whole picture shows/), 'the uncropped caption');
await shot('focus-no-crop', captionIs(/whole picture shows/), LIGHT);

await styleRow('Aspect ratio').locator('select').selectOption('1/1');
await until(captionIs(/67% of the picture’s width shows/), 'the square crop');
await pad.and(win.locator('.is-cropped')).waitFor({ timeout: 15000 });
await win.locator('.focus-editor').scrollIntoViewIfNeeded();
await shot('focus-square-center', captionIs(/67% of the picture’s width shows/));

await across.click();
await across.fill('20');
await across.press('Enter');
await until(async () => (await across.inputValue()) === '20', 'Across to read 20');
await win.evaluate(() => document.activeElement?.blur());
await shot('focus-square-placed', captionIs(/67%/));

// A drag in progress: the point and the crop follow the pointer, nothing is committed.
{
  const b = await pad.boundingBox();
  await win.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.5);
  await win.mouse.down();
  await win.mouse.move(b.x + b.width * 0.72, b.y + b.height * 0.35, { steps: 5 });
  await shot('focus-dragging', async () => (await win.locator('.focus-pad.is-dragging').count()) === 1, LIGHT, { moveMouse: false });
  await win.keyboard.press('Escape');
  await win.mouse.up();
  await pause(300);
}

// Keyboard focus reaching the editor.
await across.focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await shot('focus-keyboard', () => across.evaluate((el) => el === document.activeElement && el.matches(':focus-visible')), LIGHT);
await win.evaluate(() => document.activeElement?.blur());

// A coordinate outside the picture: the field says what was typed and why it wasn't used.
await across.click();
await across.fill('140');
await across.press('Enter');
await shot('focus-invalid', async () => (await win.locator('.focus-error').innerText()).includes('140'), LIGHT);
// Typing in the field again takes the message away; the saved 20 stays.
await across.click();
await across.fill('');
await until(async () => (await win.locator('.focus-error').count()) === 0, 'the error to clear');
await across.fill('20');
await across.press('Enter');
await win.evaluate(() => document.activeElement?.blur());

// A size that inherits: the phone shows the all-sizes point as placeholders.
await scopeRadio('Phone').click();
await until(async () => (await across.inputValue()) === '' && (await across.getAttribute('placeholder')) === '20', 'Phone to inherit the point');
await win.locator('.focus-editor').scrollIntoViewIfNeeded();
await shot('focus-phone-inherited', captionIs(/On phone|In the phone/), LIGHT);
await scopeRadio('All sizes').click();
await pause(300);

// Image fit Contain: nothing is cropped, so the point has nothing to do at this size.
// This part offers no Image fit control, so the value goes in through the edit the control would send.
await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  const id = page.rootIds.find((n) => s.state.components[page.nodes[n].definitionId]?.componentId === 'content.media');
  const r = await window.builder.project.apply({ operations: [{ type: 'node.setStyle', owner: { kind: 'page', id: page.id }, nodeId: id, partId: 'media', scope: 'base', property: 'objectFit', value: 'contain' }] }, { label: 'Fit image' });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
});
await until(captionIs(/shows the whole picture/), 'the contain caption');
await win.locator('.focus-editor').scrollIntoViewIfNeeded();
await shot('focus-contain', captionIs(/shows the whole picture/), LIGHT);
await win.locator('[aria-label^="Undo"]').first().click();
await until(captionIs(/67%/), 'Undo to bring the crop back');

// A portrait in a wide box on phones: the crop runs the other way, over a different picture.
await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  const hero = page.nodes[page.rootIds[0]];
  const r = await window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: page.id }, nodeId: hero.id, prop: 'image', value: { assetId: 'a_person1', alt: 'Portrait of Hannah Wells' } }] }, { label: 'Change image' });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
});
const heroImg = frame.locator('img[src*="person-1"]').first();
await heroImg.waitFor({ timeout: 30000 });
await selectPart(heroImg, 'Split hero');
await scopeRadio('Phone').click();
await styleRow('Aspect ratio').locator('select').selectOption('16/9');
await until(captionIs(/45% of the picture’s height shows/), 'the portrait crop');
await win.locator('.focus-editor').scrollIntoViewIfNeeded();
await shot('focus-portrait-phone', captionIs(/45% of the picture’s height shows/));

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`content editors capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
