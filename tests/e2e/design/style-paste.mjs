// Design capture for Paste style (panels/StylePaste.tsx): a section's style held after Copy style, the review of a
// section-wide paste at every size (parts, colours, cleared values, container widths and states, styles that can't
// be pasted), one size only, a long review in a short window scrolled to its end and with what isn't pasted opened
// from the heading, nothing to change, and each blocked state: read-only, the AI working, a selection that has
// changed and nothing copied. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/style-paste.mjs
//
// Each state is checked on screen after it settles and the harness throws rather than write an image of a state
// that did not render. Files are named `{state}--{theme}.png` and show the dialog, or the window for the held copy.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('paste style capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'style-paste');
mkdirSync(OUT, { recursive: true });
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-design-paste-')));
const THEMES = ['light', 'dark'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1360, height: 900 });
await win.waitForSelector('.welcome');
await win.emulateMedia({ reducedMotion: 'reduce' });
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const dialog = win.getByRole('dialog', { name: 'Paste style' });
const written = [];
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));

/** Capture `root` (the dialog unless given) in each theme; every `checks` selector must be visible in it. */
async function shot(state, checks, { themes = THEMES, root = dialog, scrollEnd = false } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await win.mouse.move(2, 880);
    await pause(300);
    if (scrollEnd) await win.evaluate(() => document.querySelectorAll('.modal *').forEach((el) => el.scrollHeight > el.clientHeight + 2 && (el.scrollTop = el.scrollHeight)));
    await pause(150);
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
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
await pause(1200);

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const home = async () => {
  const s = await snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  const find = (cid) => page.rootIds.map((id) => page.nodes[id]).find((n) => s.state.components[n.definitionId]?.componentId === cid);
  return { pageId: s.state.site.homePageId, hero: find('hero.split'), media: find('content.media'), stats: find('stats.row') };
};
const { pageId, hero, media, stats } = await home();
const owner = { kind: 'page', id: pageId };
const set = (nodeId, partId, scope, property, value, state) => ({ type: 'node.setStyle', owner, nodeId, partId, scope, ...(state ? { state } : {}), property, value });
async function apply(ops, label) {
  for (const op of ops) {
    // One at a time, so a value this build refuses is named and skipped rather than sinking the whole fixture.
    const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: [o] }, { label: l }), [op, label]);
    if (!r.ok) console.log(`fixture: skipped ${op.partId}.${op.property} at ${op.scope}${op.state ? `:${op.state}` : ''}: ${JSON.stringify(r.error ?? r).slice(0, 160)}`);
  }
}

// The copy: the hero with styles across its parts, sizes, container widths and a state, some of which the
// destination does not offer. The destination already has values of its own, so the review shows real befores.
await apply(
  [
    set(hero.id, 'root', 'base', 'paddingBlock', '72px'),
    set(hero.id, 'root', 'phone', 'paddingBlock', '16px'),
    set(hero.id, 'root', 'cq-medium', 'paddingBlock', '48px'),
    set(hero.id, 'root', 'base', 'background', { token: 'color.inverse' }),
    set(hero.id, 'root', 'base', 'color', '#ffffff'),
    set(hero.id, 'root', 'base', 'minHeight', '70vh'),
    set(hero.id, 'heading', 'base', 'color', { token: 'color.brand' }),
    set(hero.id, 'heading', 'tablet', 'color', '#f5e6c8'),
    set(hero.id, 'heading', 'base', 'textStyle', { token: 'text.display' }),
    set(hero.id, 'heading', 'base', 'maxWidth', '18ch'),
    set(hero.id, 'heading', 'base', 'color', '#ffd28a', 'hover'),
    set(hero.id, 'lead', 'base', 'color', { token: 'color.muted' }),
    set(hero.id, 'media', 'base', 'radius', '16px'),
    set(hero.id, 'media', 'base', 'aspectRatio', '4 / 3'),
    set(hero.id, 'media', 'desktop', 'radius', '24px'),
    set(hero.id, 'root', 'base', 'customCss', 'letter-spacing: 0.01em;'),
    set(media.id, 'root', 'desktop', 'paddingBlock', '96px'),
    set(media.id, 'root', 'base', 'background', { token: 'color.surface' }),
    set(media.id, 'heading', 'base', 'color', '#2b3a55'),
    set(media.id, 'media', 'base', 'radius', '4px'),
    set(media.id, 'media', 'base', 'aspectRatio', '4 / 3')
  ],
  'Fixture styles'
);
await pause(1200);

// ---- Copy style: what the editor shows once a style is held ----
await win.locator('.rail [aria-label="Layers"]').click();
await pause(500);
const row = (name) => win.locator('[role="tree"] .list-item', { hasText: name }).first();
await row('Split hero').click();
await pause(500);
await row('Split hero').click({ button: 'right' });
await win.getByRole('menuitem', { name: 'Copy style' }).click();
await win.locator('.toast', { hasText: 'Copied the style of Split hero' }).waitFor();
await pause(400);
await shot('copy-held', ['.toast'], { root: win.locator('body') });
// The menu that offers it, with the held copy named.
await row('Content with image').click({ button: 'right' });
await win.locator('[role="menu"]').waitFor();
await pause(300);
await shot('menu-offer', ['[role="menu"]'], { root: win.locator('body'), themes: ['light'] });
await win.keyboard.press('Escape');
await pause(200);

const openPaste = async (name) => {
  await row(name).click({ button: 'right' });
  await win.getByRole('menuitem', { name: /Paste style/ }).click();
  await dialog.waitFor();
  await pause(500);
};
const closePaste = async () => {
  await win.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await pause(200);
};
const sizes = (label) => dialog.getByRole('radio', { name: label, exact: true }).click();

// ---- The review, every size ----
await openPaste('Content with image');
await shot('review-every', ['h3']);
await sizes('Phone');
await pause(400);
await shot('review-phone', ['h3']);
await sizes('All sizes');
await pause(400);
await shot('review-base', ['h3'], { themes: ['light'] });
await sizes('Match the copy');
await pause(300);
await closePaste();

// ---- A long review in a short window: what stays in reach when the list scrolls ----
await win.setViewportSize({ width: 1360, height: 640 });
await pause(400);
await openPaste('Content with image');
await shot('review-short-top', ['h3'], { themes: ['light'] });
await shot('review-short-end', ['h3'], { themes: ['light', 'dark'], scrollEnd: true });
// The heading's "5 not pasted" opens the folded list and brings it up under the pinned strip.
await win.evaluate(() => document.querySelectorAll('.modal *').forEach((el) => (el.scrollTop = 0)));
await dialog.getByRole('button', { name: /not pasted$/ }).click();
await pause(500);
await shot('review-skipped-open', ['.paste-skip'], { themes: ['light'] });
await closePaste();
await win.setViewportSize({ width: 1360, height: 900 });
await pause(400);

// ---- Nothing to change: onto the section it came from ----
await openPaste('Split hero');
await shot('nothing-to-change', ['h3'], { themes: ['light'] });
await closePaste();

// ---- Blocked: read-only and the AI working (the snapshot the main process would send) ----
const push = async (change) => {
  const s = await snapshot();
  await app.evaluate(({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0].webContents.send('project:changed', next), change(s));
  await pause(500);
};
await openPaste('Content with image');
await push((s) => ({ ...s, readOnly: { reason: 'Another app is editing this project.', canUnlock: true } }));
await shot('blocked-read-only', ['h3'], { themes: ['light', 'dark'] });
await push((s) => ({ ...s, aiBusy: true, aiRunId: 'r_capture' }));
await shot('blocked-ai-busy', ['h3'], { themes: ['light'] });
await push((s) => s);
await closePaste();

// The selection changed: the destination goes away while the review is open.
await openPaste('Statistics');
await apply([{ type: 'node.remove', owner, nodeId: stats.id }], 'Remove statistics');
await pause(700);
if (await dialog.isVisible().catch(() => false)) await shot('blocked-selection-changed', ['h2'], { themes: ['light', 'dark'] });
else console.log('skipped blocked-selection-changed: the dialog closed');
if (await dialog.isVisible().catch(() => false)) await closePaste();

// Nothing copied: the dialog outlives the copy (it belongs to another opening).
await openPaste('Content with image');
await push((s) => ({ ...s, workspaceKey: `${s.workspaceKey}-other` }));
if (await dialog.isVisible().catch(() => false)) await shot('blocked-nothing-copied', ['h2'], { themes: ['light'] });
else console.log('skipped blocked-nothing-copied: the dialog closes with its opening');
await push((s) => s);
await pause(300);
if (await dialog.isVisible().catch(() => false)) await closePaste();

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`paste style capture: ${written.length} images written, ${count} in ${OUT}`);
if (errors.length) {
  console.error('page errors:', errors);
  process.exit(1);
}
