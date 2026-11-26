// Design capture for the page outline (the Layers tab's Headings view). Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/page-outline.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`, clipped to the rail, the sidebar and a strip of
// canvas. Every heading problem is made with ordinary edits through the app's own edit seam
// (window.builder.project.apply): a second title, a level skipped in rich text, a fixable skip, six levels deep.
// Each capture checks its state on screen after it settles and throws rather than writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('page outline capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'page-outline');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-outline-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];
const W = 1440;
const H = 900;

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
win.setDefaultTimeout(60000);
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: W, height: H });
await win.waitForSelector('.welcome', { timeout: 120000 });
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
const frame = win.frameLocator('.frame-box iframe');
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

async function setTheme(theme) {
  await win.emulateMedia({ colorScheme: theme });
  await pause(250);
}

/**
 * Capture a state per theme. `prepare` runs after the theme is set (a focus, a key press); `check` must be visible
 * at the moment of capture. Without `prepare` the pointer is parked on the canvas and focus is dropped, so the panel
 * shows at rest.
 */
async function shot(state, check, { themes = BOTH, prepare, canvas = 220 } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (prepare) await prepare();
    else {
      await win.mouse.move(W - 200, 450);
      await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    }
    await pause(250);
    if (!(await win.locator(check).first().isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${check}"; refusing to write`);
    const b = await win.locator('.side-panel').boundingBox();
    if (!b) throw new Error(`state "${state}": the sidebar is not on screen`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: { x: 0, y: 0, width: Math.ceil(b.x + b.width + canvas), height: H } });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
async function apply(operations, label) {
  const r = await win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });
  if (!r?.ok) throw new Error(`${label} failed: ${JSON.stringify(r?.error ?? r)}`);
  await pause(400);
  return r;
}
const pageNamed = (snap, title) => {
  const p = Object.values(snap.state.pages).find((x) => x.title === title);
  if (!p) throw new Error(`no page called ${title}`);
  return p;
};
const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(250);
};
async function outlineView() {
  await openRail('Layers');
  const toggle = win.locator('.side-panel-view:not([hidden]) button[title^="The headings this page shows"]');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await win.locator('.outline-view').waitFor();
  await pause(300);
}
/** The outline of the named page, with nothing selected. */
async function showOutline(title) {
  await openRail('Pages');
  await win.locator('.side-panel-view:not([hidden]) [data-page]', { hasText: title }).first().click();
  await pause(900);
  await win.keyboard.press('Escape');
  await outlineView();
}
/** Drag the sidebar's edge by `dx` pixels (-60 takes the default width to its 200px minimum). */
async function resizeSidebar(dx) {
  const handle = win.locator('.seam.left .resizer');
  const b = await handle.boundingBox();
  if (!b) throw new Error('the sidebar resizer is not on screen');
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await win.mouse.down();
  await win.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 6 });
  await win.mouse.up();
  await pause(400);
}

// ---- Project: the business starter, healthy ----
const sites = join(WORK, 'sites');
const created = await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
if (!created?.ok) throw new Error(`project creation failed: ${created?.message}`);
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('h1').first().waitFor({ timeout: 240000 });
await pause(1500);

// 1. A healthy page.
await showOutline('Home');
await shot('outline-clean', '.outline-view .outline-row');

// ---- Real heading problems, made with ordinary edits ----
{
  const snap = await snapshot();
  const about = pageNamed(snap, 'About');
  const owner = { kind: 'page', id: about.id };
  await apply([{ type: 'node.insert', owner, componentId: 'hero.centered', props: { heading: 'Meet the studio behind Harbour Lane' } }], 'Add a second title');
  await apply(
    [
      {
        type: 'node.insert',
        owner,
        componentId: 'content.text',
        props: {
          heading: 'How we work',
          body: [
            { type: 'h4', spans: [{ text: 'Listening first, drawing second, and building only once the whole household has signed off on the plan' }] },
            { type: 'p', spans: [{ text: 'We start every project at your kitchen table.' }] }
          ]
        }
      }
    ],
    'Add a section that skips a level'
  );
  const contact = pageNamed(await snapshot(), 'Contact');
  const levelled = Object.entries(contact.nodes).filter(([, n]) => {
    const prop = n.kind === 'instance' ? snap.state.components[n.definitionId]?.properties?.headingLevel : null;
    return prop && (n.props.headingLevel ?? prop.default) === 'h1';
  });
  if (!levelled.length) throw new Error('Contact has no Heading 1 whose level can be changed');
  for (const [nodeId] of levelled) await apply([{ type: 'instance.setProp', owner: { kind: 'page', id: contact.id }, nodeId, prop: 'headingLevel', value: 'h2' }], 'Remove the page title');
  await apply([{ type: 'page.create', title: 'Holding page', route: '/holding/' }], 'Add a page with no headings');
  // A page six levels deep, with long words at the deepest levels and one skip the outline can fix.
  await apply([{ type: 'page.create', title: 'Renovation guide', route: '/guide/' }], 'Add a deep page');
  const guide = pageNamed(await snapshot(), 'Renovation guide');
  const gOwner = { kind: 'page', id: guide.id };
  for (const id of [...guide.rootIds]) await apply([{ type: 'node.remove', owner: gOwner, nodeId: id }], 'Clear');
  const headings = [
    [1, 'The Harbour Lane renovation guide'],
    [2, 'Planning your kitchen'],
    [3, 'Choosing cabinets and worktops'],
    [4, 'Timber species we stock'],
    [5, 'European oak, sustainably sourced from certified forests'],
    [6, 'Care and oiling schedule for the first year'],
    [2, 'Bathrooms'],
    [4, 'Lead times for tiles and fittings']
  ];
  for (const [i, [level, text]] of headings.entries()) {
    const r = await apply([{ type: 'node.insert', owner: gOwner, primitive: 'heading', text, index: i }], `Heading ${level}`);
    const nodeId = r.results?.[0]?.nodeId;
    if (!nodeId) throw new Error('heading insert returned no node');
    if (level !== 2) await apply([{ type: 'node.setContent', owner: gOwner, nodeId, field: 'tag', value: `h${level}` }], `Make it Heading ${level}`);
  }
}
await pause(800);

// 2. A second title and a skip inside rich text, then the same with a flagged row selected.
await showOutline('About');
await shot('outline-problems', '.outline-row.warn');
await win.locator('.outline-row.warn').first().click();
await pause(500);
await shot('outline-problems-selected', '.outline-row.warn[aria-current="true"]', { themes: LIGHT });

// 3. Keyboard: Tab from the view switch reaches the summary's button, the next Tab the list (one stop), then down two
// headings, selecting as it goes; and the type-ahead jump to a heading by its first letters.
await shot('outline-keyboard', '.outline-row:focus-visible', {
  themes: LIGHT,
  prepare: async () => {
    await win.locator('.side-panel-view:not([hidden]) button[title^="The headings this page shows"]').focus();
    await win.keyboard.press('Tab');
    await win.keyboard.press('Tab');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowDown');
    await pause(300);
  }
});
await shot('outline-keyboard-typeahead', '.outline-row:focus-visible', {
  themes: LIGHT,
  prepare: async () => {
    await win.locator('.outline-row[tabindex="0"]').first().focus();
    await win.keyboard.press('Home');
    await win.keyboard.type('hav');
    await pause(400);
  }
});
// Tab from a flagged heading reaches its own fix, then leaves the list.
await shot('outline-keyboard-fix', '.outline-next .btn:focus-visible', {
  themes: LIGHT,
  prepare: async () => {
    await win.locator('.outline-row[tabindex="0"]').first().focus();
    await win.keyboard.press('Home');
    for (let i = 0; i < 7; i++) await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Tab');
    await pause(400);
  }
});

// 4. No main heading; a page with only the shared header's and footer's headings.
await showOutline('Contact');
await shot('outline-no-title', '.outline-summary .scope-note', { themes: LIGHT });
await showOutline('Holding page');
await shot('outline-shared-only', '.outline-view', { themes: LIGHT });

// 5. Six levels deep, at the default sidebar and at its 200px minimum.
await showOutline('Renovation guide');
await shot('outline-deep', '.outline-row[data-level="6"]');
await resizeSidebar(-60);
await shot('outline-deep-narrow', '.outline-row[data-level="6"]', { themes: LIGHT });
await resizeSidebar(60);

// ---- Read-only: another copy of the app holds the project ----
{
  const { dir } = await snapshot();
  await win.evaluate(() => window.builder.projects.close());
  await win.waitForSelector('.welcome');
  writeFileSync(join(dir, '.siteorigin/lock.json'), JSON.stringify({ pid: process.pid, host: hostname(), instance: 'another-window', started: new Date().toISOString() }));
  const opened = await win.evaluate((d) => window.builder.projects.open(d), dir);
  if (!opened?.ok) throw new Error(`could not reopen read-only: ${opened?.message}`);
  await win.waitForSelector('.editor', { timeout: 120000 });
  await win.locator('.status-bar .read-only').waitFor();
  await pause(1500);
  await showOutline('About');
  await shot('outline-read-only', '.outline-row.warn', { themes: LIGHT });
  rmSync(join(dir, '.siteorigin/lock.json'), { force: true });
}

// ---- The minimum: a blank site, with no headings anywhere ----
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
const blank = await win.evaluate((dir) => window.builder.projects.create({ name: 'Blank', parentDir: dir, starter: 'blank', sampleImages: false }), sites);
if (!blank?.ok) throw new Error(`blank project failed: ${blank?.message}`);
await win.waitForSelector('.editor', { timeout: 120000 });
await pause(2500);
{
  // The blank starter's Home has nothing on it, and the footer has headings: take the footer away.
  const s = await snapshot();
  await apply(s.state.site.shell.footer.rootIds.map((nodeId) => ({ type: 'node.remove', owner: { kind: 'shell', id: 'footer' }, nodeId })), 'Remove the footer');
}
await outlineView();
await shot('outline-empty', '.outline-view .outline-empty', { themes: LIGHT });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`page outline capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
