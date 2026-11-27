// Design capture harness for project storage: the Storage footer under every tab of the Assets panel and the
// Free up space dialog its button opens. Drives the real built app in light and dark and writes one PNG per
// state and theme. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/project-storage.mjs
//
// The figures come from the app's own seams: images imported one at a time (so each import is its own Undo
// step), a saved version, and Remove unused, which keeps the removed files for Undo. Each capture is verified
// after it settles; a state that did not render throws instead of writing a wrong image. Files are named
// `storage-{state}--{theme}.png`. Footer states are cropped to the sidebar; dialog states are the window.
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('project storage capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'project-storage');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-storage-')));
const THEMES = ['light', 'dark'];
const STARTER = resolve('resources/starter-assets');

// Six photos with distinct bytes (imports dedupe by hash), imported one by one, then left unused.
const FIX = join(WORK, 'fixtures');
mkdirSync(FIX, { recursive: true });
const photos = ['hero', 'studio', 'kitchen', 'bedroom', 'reading', 'dining'];
const fixtures = photos.map((p, i) => {
  const dest = join(FIX, `${p}-shoot-selects-${i + 1}.jpg`);
  execFileSync('sips', ['-Z', String(1200 + i * 20), join(STARTER, `${p}.jpg`), '--out', dest], { stdio: 'ignore' });
  return dest;
});
const pdf = join(FIX, 'harbour-lane-price-list-2026.pdf');
writeFileSync(pdf, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForSelector('.welcome');
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

const panel = win.locator('aside.side-panel');
async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}
/** Capture a state; `check` must be visible at the moment of capture. `window: true` captures the whole window. */
async function shot(state, check, { themes = THEMES, window = false, keep = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keep) await win.mouse.move(900, 450);
    await pause(200);
    const visible = await win.locator(check).first().isVisible().catch(() => false);
    if (!visible) {
      await win.screenshot({ path: join(OUT, `debug-${state}--${theme}.png`) }).catch(() => {});
      throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write (the window is in debug-${state}--${theme}.png)`);
    }
    const path = join(OUT, `storage-${state}--${theme}.png`);
    if (window) await win.screenshot({ path });
    else await panel.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}
const openAssets = async () => {
  const b = win.locator('.rail [aria-label="Assets"]');
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(600);
};
const storage = win.getByTestId('asset-storage');
const dialog = win.getByTestId('free-space-dialog');
const scrollBody = (to) => win.evaluate((y) => document.querySelectorAll('aside.side-panel .panel-body').forEach((el) => (el.scrollTop = y === 'end' ? el.scrollHeight : 0)), to);

// ---- The Business starter: its sample images, then six more imported one at a time and a document ----
const sites = join(WORK, 'sites');
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await openAssets();
for (const f of fixtures) {
  const r = await win.evaluate((p) => window.builder.project.importAssets([p]), f);
  if (!r.assetIds.length) throw new Error(`fixture import failed: ${r.message}`);
}
const docs = await win.evaluate((p) => window.builder.project.importAssets([p]), pdf);
if (!docs.assetIds.length) throw new Error(`document import failed: ${docs.message}`);
await storage.waitFor({ timeout: 20000 });
await pause(800);

// At rest: only what Assets takes.
await shot('footer-rest', '[data-testid="asset-storage"]');

// A saved version, then every unused image removed: their files are kept for Undo.
const saved = await win.evaluate(async () => window.builder.project.saveVersion('Before the spring refresh', (await window.builder.project.snapshot()).workspaceKey));
if (!saved.ok) throw new Error(`saving a version failed: ${saved.message}`);
await win.getByRole('radio', { name: /^Unused/ }).click();
await pause(300);
await win.locator('.asset-cleanup .btn-danger').click();
await storage.getByText('Kept for Undo').waitFor({ timeout: 30000 });
await storage.getByText('Saved versions').waitFor({ timeout: 30000 });
await pause(400);
await scrollBody('end');
await pause(300);
await shot('footer-full', '[data-testid="asset-storage"]');

// The same footer on the Documents tab.
await panel.getByRole('tab', { name: /^Documents/ }).click();
await pause(400);
await shot('footer-documents', '[data-testid="asset-storage"]', { themes: ['light'] });
await panel.getByRole('tab', { name: /^Images/ }).click();
await pause(300);

// A short window: how much of the panel the footer takes.
await win.setViewportSize({ width: 1440, height: 560 });
await pause(600);
await shot('footer-short', '[data-testid="asset-storage"]', { themes: ['light'] });
await storage.getByRole('button', { name: /^Storage/ }).click();
await pause(300);
await shot('footer-short-open', '[data-testid="asset-storage"] dl', { themes: ['light'] });
await storage.getByRole('button', { name: /^Storage/ }).click();
await storage.getByRole('button', { name: /^Free .+…$/ }).click();
await dialog.waitFor({ timeout: 10000 });
await pause(400);
await shot('dialog-short', '[data-testid="free-space-dialog"]', { themes: ['light'], window: true });
await win.locator('.modal-foot .btn[data-autofocus]').click();
await dialog.waitFor({ state: 'detached', timeout: 5000 });
await win.setViewportSize({ width: 1440, height: 900 });
await pause(600);

// Keyboard focus on the footer's button.
await win.keyboard.press('Shift');
await storage.getByRole('button', { name: /^Free .+…$/ }).focus();
await shot('footer-focus', '[data-testid="asset-storage"] button:focus-visible', { themes: ['light'], keep: true });

// ---- The dialog: the plan, every earlier step listed, then the figures going stale ----
await storage.getByRole('button', { name: /^Free .+…$/ }).click();
await dialog.waitFor({ timeout: 10000 });
await pause(400);
await shot('dialog', '[data-testid="free-space-dialog"]', { window: true });
const more = dialog.locator('.storage-more').first();
if (await more.count()) {
  await win.keyboard.press('Shift');
  await more.focus();
  await shot('dialog-more-focus', '[data-testid="free-space-dialog"] .storage-more:focus-visible', { themes: ['light'], window: true, keep: true });
  await more.click();
  await pause(300);
  await shot('dialog-more', '[data-testid="free-space-dialog"] .storage-more[aria-expanded="true"]', { window: true });
  await more.click();
  await win.evaluate(() => document.activeElement?.blur());
  await pause(200);
}

// Freeing refused (the AI is working, say): the reason, from the main process's own reply.
await app.evaluate(({ ipcMain }) => {
  ipcMain.removeHandler('project:reclaimStorage');
  ipcMain.handle('project:reclaimStorage', () => ({ ok: false, message: 'Wait for the AI to finish, then try again.' }));
});
await dialog.locator('xpath=ancestor::div[contains(@class,"modal")]').getByRole('button', { name: /^Free / }).click();
await dialog.getByText('Wait for the AI to finish').waitFor({ timeout: 10000 });
await win.evaluate(() => document.activeElement?.blur());
await pause(300);
await shot('dialog-error', '[data-testid="free-space-dialog"] [role="alert"]', { themes: ['light'], window: true });
await win.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
await dialog.waitFor({ state: 'detached', timeout: 5000 });
await storage.getByRole('button', { name: /^Free .+…$/ }).click();
await dialog.waitFor({ timeout: 10000 });
await pause(400);

// Undoing the removal while the dialog is open changes the plan: the figures on screen are marked stale.
if (!(await win.evaluate(() => window.builder.project.undo())).ok) throw new Error('could not undo the clean-up');
await dialog.getByRole('button', { name: /new figures/i }).waitFor({ timeout: 20000 });
await pause(300);
await shot('dialog-stale', '[data-testid="free-space-dialog"]', { window: true });
await dialog.getByRole('button', { name: /new figures/i }).click();
await pause(600);
await shot('dialog-nothing', '[data-testid="free-space-dialog"]', { window: true });
await win.locator('.modal-foot .btn[data-autofocus]').click();
await dialog.waitFor({ state: 'detached', timeout: 5000 });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.startsWith('storage-') && f.endsWith('.png')).length;
console.log(`project storage capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
