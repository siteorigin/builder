// Design capture for Find and replace (panels/FindReplace.tsx): the empty dialog, results grouped by page and
// shared part, match options, no matches, reviewing a replacement, matches that cannot be replaced, a replacement
// the project refuses, the result of a replace and its Undo, coming back from a match, a dense list and a narrow
// window. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/find-replace.mjs
//
// Each state is checked on screen after it settles and the harness throws rather than write an image of a state
// that did not render. Files are named `{state}--{theme}.png` and show the whole window.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('find and replace capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'find-replace');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-find-')));
const THEMES = ['light', 'dark'];
const SIZE = { width: 1360, height: 900 };

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize(SIZE);
await win.waitForSelector('.welcome', { timeout: 120000 });
await win.emulateMedia({ reducedMotion: 'reduce' });
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const dialog = win.getByRole('dialog', { name: 'Find and replace' });
const findField = dialog.getByLabel('Find', { exact: true });
const replaceField = dialog.getByLabel('Replace with');
const written = [];

/** Capture the window in each theme; every `checks` locator must be visible in the dialog at that moment. */
async function shot(state, checks, { themes = THEMES } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await win.mouse.move(2, 2);
    await pause(350);
    for (const check of [dialog, ...checks]) {
      const visible = await check.first().isVisible().catch(() => false);
      if (!visible) throw new Error(`state "${state}" (${theme}) did not render ${check}; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

/** A fresh dialog, so no state carries over from the last capture. */
async function open(query = '') {
  for (let i = 0; i < 3 && (await dialog.count()); i++) {
    await win.keyboard.press('Escape');
    await pause(200);
  }
  if (await dialog.count()) throw new Error('the dialog did not close');
  await win.keyboard.press('ControlOrMeta+Shift+KeyF');
  await dialog.waitFor({ timeout: 5000 });
  if (query) await findField.fill(query);
  await pause(350);
}

/** Open the replace step (the footer's primary action), and type the replacement. */
async function startReplace(text) {
  if (!(await replaceField.count())) await dialog.locator('.modal-foot .btn-primary').click();
  await replaceField.waitFor({ timeout: 3000 });
  await replaceField.fill(text);
  await pause(400);
}

// ---- A populated project: the business starter, with a long page title and a long heading ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await win.evaluate(async () => {
  const { state } = await window.builder.project.snapshot();
  const about = state.site.pageOrder.find((id) => state.pages[id].title === 'About');
  const hero = Object.values(state.pages[about].nodes).find((n) => n.props?.heading === 'A small studio with a long view');
  if (!hero) throw new Error('the About page has no hero to seed');
  await window.builder.project.apply(
    {
      operations: [
        { type: 'page.update', pageId: about, title: 'About the practice, the people behind it and how we work with clients' },
        { type: 'instance.setProp', owner: { kind: 'page', id: about }, nodeId: hero.id, prop: 'heading', value: 'A small studio with a long view of how homes, workplaces and neighbourhood cafés change over the decades people spend in them' }
      ]
    },
    { label: 'Seed long content' }
  );
});
await pause(1200);

// ---- Finding ----
await open();
await shot('rest', [findField]);

await open('studio');
await shot('results', [dialog.locator('mark', { hasText: /studio/i }), dialog.getByText('Header', { exact: true }), dialog.getByText('Footer', { exact: true })]);

await open('Studio');
await dialog.getByLabel('Match case').check();
await pause(350);
await shot('match-case', [dialog.locator('mark', { hasText: 'Studio' })]);

await open('wallpaper samples');
await shot('no-matches', [dialog.getByText(/wallpaper samples/).first()]);

await open('the');
await shot('dense', [dialog.locator('mark').nth(20)]);

// ---- Reviewing a replacement ----
await open('hello@example.com');
await startReplace('studio@harbourlane.example');
await shot('review', [replaceField, dialog.getByText('studio@harbourlane.example').first(), dialog.getByRole('button', { name: /^Replace \d+ match/ })]);

// Some matches left out.
const boxes = dialog.locator('input[type="checkbox"]:not(:disabled)').filter({ hasNot: win.locator('[aria-label="Match case"]') });
const rows = dialog.locator('li input[type="checkbox"]:not(:disabled)');
if ((await rows.count()) < 3) throw new Error(`expected at least 3 replaceable rows, found ${await rows.count()} (${await boxes.count()} boxes)`);
await rows.nth(1).uncheck();
await pause(350);
await shot('review-partial', [dialog.locator('li input[type="checkbox"]:not(:checked)').first()]);

// Keyboard focus on a row's checkbox.
await rows.nth(0).focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await pause(150);
await shot('review-focus', [dialog.locator('li input[type="checkbox"]:focus-visible')], { themes: ['light'] });

// Nothing chosen.
await open('hello@example.com');
await startReplace('studio@harbourlane.example');
const allRows = await rows.count();
for (let i = 0; i < allRows; i++) await rows.nth(i).uncheck();
await pause(350);
await shot('review-none', [dialog.locator('.modal-foot .btn-primary:disabled')], { themes: ['light'] });

// Matches that cannot be replaced from here: links to pages of the site.
await open('contact');
await startReplace('enquiries');
await shot('blocked', [dialog.locator('.find-match.blocked .find-lock').first()]);

// A replacement the project refuses: emptying a destination.
await open('hello@example.com');
await dialog.locator('.modal-foot .btn-primary').click();
await dialog.getByRole('button', { name: 'remove these words' }).click();
await pause(400);
await shot('refused', [dialog.getByRole('alert'), dialog.locator('.find-refused').first()]);

// A narrow window.
await win.setViewportSize({ width: 900, height: 640 });
await open('hello@example.com');
await startReplace('studio@harbourlane.example');
await shot('review-narrow', [replaceField], { themes: ['light'] });
await win.setViewportSize(SIZE);
await pause(300);

// ---- The result of a replace ----
await open('hello@example.com');
await startReplace('studio@harbourlane.example');
await dialog.getByRole('button', { name: /^Replace \d+ match/ }).click();
await dialog.getByRole('status').filter({ hasText: /Replaced \d+ match/ }).waitFor({ timeout: 10000 });
await pause(300);
await shot('replaced', [findField, dialog.getByRole('button', { name: 'Undo' })]);

// Undo from inside the dialog puts every match back.
await dialog.getByRole('button', { name: 'Undo' }).click();
await dialog.getByRole('status').filter({ hasText: 'Undone' }).waitFor({ timeout: 10000 });
await dialog.locator('mark', { hasText: 'hello@example.com' }).first().waitFor({ timeout: 10000 });
await shot('undone', [dialog.locator('mark').first()], { themes: ['light'] });

// Opening a match and coming back keeps the search, the replacement and the choices.
await open('hello@example.com');
await startReplace('studio@harbourlane.example');
await rows.nth(1).uncheck();
await pause(300);
await dialog.locator('.find-match').first().getByRole('button', { name: /^Open / }).click();
await dialog.waitFor({ state: 'detached', timeout: 5000 });
await pause(600);
await win.keyboard.press('ControlOrMeta+Shift+KeyF');
await dialog.waitFor({ timeout: 5000 });
await pause(400);
if ((await replaceField.inputValue()) !== 'studio@harbourlane.example') throw new Error('the replacement was not kept across Open');
if (await rows.nth(1).isChecked()) throw new Error('the left-out match was ticked again after Open');
await shot('resumed', [replaceField, dialog.getByRole('button', { name: 'Replace 4 matches' })], { themes: ['light'] });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`find and replace capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
