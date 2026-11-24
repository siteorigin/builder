// Design capture for Project health: the status bar, the Project health dialog (problems, conflicts, the theme
// update, read-only) and the page heading outline it links to. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/project-health.mjs
//
// Drives the real (built) app and writes `{state}--{theme}.png`. Heading problems are made with real edits. States
// that need a damaged project (conflicts, missing files, a theme update, a failed preview) are pushed through the
// main process's own `project:changed` broadcast. Every capture checks its state on screen after it settles and
// throws rather than writing a wrong image.
import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('project health capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
// Defaults to a folder under the OS temp folder; set DESIGN_CAPTURE_DIR to keep the images elsewhere.
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'project-health');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-health-')));
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

/** The part of the window a state is about. */
async function region(area) {
  const vp = win.viewportSize();
  if (area === 'window') return undefined;
  if (area === 'status') {
    const b = await win.locator('.status-bar').boundingBox();
    return { x: 0, y: Math.floor(b.y - 1), width: vp.width, height: Math.ceil(b.height + 1) };
  }
  if (area === 'modal') {
    const b = await win.locator('.modal').first().boundingBox();
    const x = Math.max(0, Math.floor(b.x - 20));
    const y = Math.max(0, Math.floor(b.y - 20));
    return { x, y, width: Math.min(vp.width - x, Math.ceil(b.width + 40)), height: Math.min(vp.height - y, Math.ceil(b.height + 40)) };
  }
  if (area === 'panel') {
    const b = await win.locator('.side-panel').boundingBox();
    return { x: 0, y: 0, width: Math.ceil(b.x + b.width + 16), height: vp.height };
  }
  throw new Error(`unknown area ${area}`);
}

/** Capture a state; `check` (and `text`, when given) must be visible at the moment of capture. */
async function shot(state, check, { themes = BOTH, area = 'window', text = null, keepPointer = false } = {}) {
  for (const theme of themes) {
    await setTheme(theme);
    if (!keepPointer) await win.mouse.move(W - 300, 300);
    // The status bar is captured at rest: closing a dialog with Escape leaves keyboard focus on its opener.
    if (area === 'status') await win.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await pause(200);
    const target = text ? win.locator(check, { hasText: text }).first() : win.locator(check).first();
    if (!(await target.isVisible().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render "${check}"${text ? ` with "${text}"` : ''}; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, ...(area === 'window' ? {} : { clip: await region(area) }) });
    written.push(path);
    console.log('wrote', path);
  }
  await setTheme('light');
}

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
/** Push a changed snapshot through the channel the main process announces every change on. */
const broadcast = (snap) =>
  app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    w.webContents.send('project:changed', s);
  }, snap);
async function seed(mutate) {
  const snap = await snapshot();
  mutate(snap);
  await broadcast(snap);
  await pause(350);
}
const unseed = async () => {
  await broadcast(await snapshot());
  await pause(350);
};
async function apply(operations, label) {
  const r = await win.evaluate(({ operations, label }) => window.builder.project.apply({ operations }, { label }), { operations, label });
  if (!r?.ok) throw new Error(`${label} failed: ${JSON.stringify(r?.error ?? r)}`);
  await pause(500);
  return r;
}
const pageNamed = (snap, title) => {
  const p = Object.values(snap.state.pages).find((x) => x.title === title);
  if (!p) throw new Error(`no page called ${title}`);
  return p;
};
const openHealth = async () => {
  await win.locator('.status-bar button[title^="Project health:"]').click();
  await win.locator('.modal').first().waitFor();
  await pause(350);
};
const closeHealth = async () => {
  await win.keyboard.press('Escape');
  await win.locator('.modal').first().waitFor({ state: 'detached' });
  await pause(200);
};
const openRail = async (name) => {
  const b = win.locator(`.rail [aria-label="${name}"]`);
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
  await pause(250);
};
/** The Layers panel's headings view, on the named page. */
async function showOutline(title) {
  await openRail('Pages');
  await win.locator('.side-panel-view:not([hidden]) [data-page]', { hasText: title }).first().click();
  await pause(900);
  await outlineView();
}
async function outlineView() {
  await openRail('Layers');
  const toggle = win.locator('.side-panel-view:not([hidden]) button[title^="The headings this page shows"]');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await win.locator('.outline-view').waitFor();
  await pause(300);
}

// ---- Project: the business starter, healthy ----
const sites = join(WORK, 'sites');
const created = await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), sites);
if (!created?.ok) throw new Error(`project creation failed: ${created?.message}`);
await win.waitForSelector('.editor', { timeout: 120000 });
await frame.locator('h1').first().waitFor({ timeout: 240000 });
await pause(1500);

await shot('sb-clean', '.status-bar .problems', { area: 'status', text: 'No problems' });
await frame.locator('h1').first().click();
await pause(600);
await shot('sb-selection', '.status-bar .crumbs button[aria-current]', { area: 'status', themes: LIGHT });
await win.keyboard.press('Escape');
await pause(200);

await openHealth();
await shot('health-clean', '.modal .health-summary.ok', { area: 'modal', text: 'No problems found' });
await closeHealth();
await showOutline('Home');
await shot('outline-clean', '.outline-view .outline-row', { area: 'panel', themes: BOTH });

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
}
await pause(800);

await showOutline('About');
await shot('outline-problems', '.outline-row.warn', { area: 'panel' });
await showOutline('Contact');
await shot('outline-no-title', '.outline-summary .scope-note', { area: 'panel', themes: LIGHT, text: 'No main heading' });
await showOutline('Holding page');
// A page of its own with no headings still lists the shared header's and footer's.
await shot('outline-shared-only', '.outline-view', { area: 'panel', themes: LIGHT });
await showOutline('About');

await shot('sb-warnings', '.status-bar .problems.warn', { area: 'status' });
await openHealth();
await shot('health-warnings', '.modal .health-row.warn', { area: 'modal', themes: LIGHT });
await closeHealth();

// ---- A damaged project: every kind of problem at once ----
const conflictsIn = (s) => [
  { path: `siteorigin/pages/${pageNamed(s, 'About').id}.json`, reason: 'Changed outside SiteOrigin Builder.', kind: 'canonical' },
  { path: 'siteorigin/components/custom.harbour-lane-testimonial-carousel-with-a-long-name/component.json', reason: 'Changed outside SiteOrigin Builder during an AI run.', kind: 'canonical' },
  { path: 'src/routes/about/+page.svelte', reason: 'Generated file was edited outside SiteOrigin Builder. Restore it to resume generation.', kind: 'generated' }
];
const THEME_UPDATES = {
  available: [
    { id: 'foundation.hero.centered', name: 'Hero' },
    { id: 'foundation.content.text', name: 'Text' },
    { id: 'foundation.contact.form', name: 'Contact form' }
  ],
  kept: [{ id: 'foundation.data.table', name: 'Table', reason: 'Its stored definition was changed outside the theme.' }]
};
const withConflicts = (s) => {
  s.conflicts = conflictsIn(s);
  s.diagnostics = [...s.diagnostics, ...s.conflicts.map((c) => ({ severity: 'error', code: 'CONFLICT', message: `${c.path}: ${c.reason}` }))];
};
const withMissingFiles = (s) => {
  const [used, spare] = Object.keys(s.state.assets.assets);
  if (!used || !spare) throw new Error('the project needs two images');
  const name = (id) => s.state.assets.assets[id].name;
  s.assetUsage = { ...s.assetUsage, [used]: 3, [spare]: 0 };
  s.diagnostics = [
    { severity: 'error', code: 'ASSET_FILE_MISSING', message: `${name(used)} is missing its original file and 2 smaller copies in the project folder. Locate the file or choose another image in Assets.`, owner: { kind: 'asset', id: used } },
    { severity: 'warning', code: 'ASSET_FILE_MISSING', message: `${name(spare)} is missing a smaller copy in the project folder. Make the copies again in Assets.`, owner: { kind: 'asset', id: spare } },
    ...s.diagnostics
  ];
};

await seed((s) => {
  withMissingFiles(s);
  withConflicts(s);
  s.themeUpdates = THEME_UPDATES;
});
await shot('sb-problems', '.status-bar .problems.error', { area: 'status' });
await openHealth();
await shot('health-mixed', '.modal .health-row.danger', { area: 'modal', text: 'is missing' });
await shot('health-mixed-window', '.modal .health-row.danger', { themes: LIGHT, text: 'is missing' });
await closeHealth();
await win.setViewportSize({ width: 1280, height: 800 });
await pause(500);
await openHealth();
await shot('health-mixed-1280', '.modal .health-row.danger', { themes: LIGHT, text: 'is missing' });
await closeHealth();
await win.setViewportSize({ width: W, height: H });
await pause(500);

await seed((s) => withConflicts(s));
await openHealth();
await shot('health-conflicts', '.modal .health-row.danger', { area: 'modal', themes: BOTH, text: 'About page' });
await closeHealth();

await seed((s) => {
  s.diagnostics = [];
  s.conflicts = [];
  s.themeUpdates = THEME_UPDATES;
});
await openHealth();
await win.locator('.modal .health-details summary').first().click();
await pause(200);
await shot('health-theme-update', '.modal .health-row', { area: 'modal', themes: BOTH, text: 'theme component' });
await closeHealth();

// ---- Only quiet things: a note, updates and the copies kept when conflicts were settled ----
await seed((s) => {
  const home = pageNamed(s, 'Home');
  s.diagnostics = [{ severity: 'info', code: 'PAGE_NOTE', message: 'Home: the page has no description, so search engines will write their own from its text.', owner: { kind: 'page', id: home.id } }];
  s.conflicts = [];
  s.themeUpdates = THEME_UPDATES;
  s.savedCopies = [
    { id: 'copy-1', path: `siteorigin/pages/${pageNamed(s, 'About').id}.json`, kind: 'canonical', side: 'external', savedAt: Date.UTC(2026, 10, 23, 14, 5), file: '.siteorigin/recovery/copy-1.json' },
    { id: 'copy-2', path: 'src/routes/about/+page.svelte', kind: 'generated', side: 'external', savedAt: Date.UTC(2026, 10, 23, 14, 6), file: '.siteorigin/recovery/copy-2.svelte' }
  ];
});
await openHealth();
await shot('health-quiet', '.modal .health-jumps', { area: 'modal', themes: BOTH, text: 'Saved copies' });
await closeHealth();

// ---- The preview is still starting ----
await seed((s) => {
  s.diagnostics = [];
  s.conflicts = [];
  s.savedCopies = [];
  s.runtime = { state: 'preparing', message: 'Installing the website tools…' };
});
await openHealth();
await shot('health-starting', '.modal .health-summary.busy', { area: 'modal', themes: LIGHT });
await closeHealth();

// ---- The website tools failed ----
await seed((s) => {
  s.diagnostics = [];
  s.conflicts = [];
  s.runtime = {
    state: 'error',
    message: 'The preview could not start.',
    detail: "npm ERR! code ELIFECYCLE\nnpm ERR! errno 1\n\n[vite] Internal server error: Failed to resolve import \"./Testimonial.svelte\" from \"src/routes/about/+page.svelte\". Does the file exist?\n  Plugin: vite:import-analysis\n  File: src/routes/about/+page.svelte:14:29\n  12 |  import Hero from '$lib/components/Hero.svelte';\n  13 |  import Text from '$lib/components/Text.svelte';\n  14 |  import Testimonial from './Testimonial.svelte';\n     |                          ^"
  };
});
await shot('sb-preview-problem', '.status-bar .preview-status.error', { area: 'status' });
await openHealth();
await shot('health-runtime-closed', '.modal .health-row.danger', { area: 'modal', themes: LIGHT, text: 'couldn’t start' });
await win.locator('.modal .health-details summary').first().click();
await pause(200);
await shot('health-runtime-error', '.modal .health-details pre', { area: 'modal', themes: BOTH });
await closeHealth();
await unseed();

// ---- Keyboard: the route from a heading problem to the outline ----
await openHealth();
const showHeadings = win.locator('.modal button', { hasText: 'Show headings' }).first();
await showHeadings.focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await pause(200);
await shot('health-focus', '.modal button:focus-visible', { area: 'modal', themes: LIGHT, keepPointer: true });
await win.keyboard.press('Enter');
await win.locator('.outline-view .outline-row:focus').waitFor();
await pause(400);
await shot('outline-from-health', '.outline-row:focus-visible', { themes: LIGHT, keepPointer: true });

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
  await shot('sb-read-only', '.status-bar .read-only', { area: 'status', themes: LIGHT });
  await openHealth();
  await shot('health-read-only', '.modal .scope-note', { area: 'modal', themes: LIGHT, text: 'Read-only' });
  await closeHealth();
  await showOutline('About');
  await shot('outline-read-only', '.outline-row.warn', { area: 'panel', themes: LIGHT });
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
await shot('outline-empty', '.outline-view .outline-empty', { area: 'panel', themes: LIGHT });

await app.close();
rmSync(WORK, { recursive: true, force: true });

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`project health capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
