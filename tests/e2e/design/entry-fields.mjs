// Collection entry fields capture harness: drives the real (built) app through the form that fills in an entry's
// custom fields (EntryValueFields): a record with no text, whose fields are the whole form, and an article, whose
// fields sit in its details. It shows each kind of field, a reference to one entry (with two entries of one name and
// a draft among them), references to a few entries and to many, a collection with no other entries, references whose
// entries or collection have gone (written by hand into the project's files), and a synced collection's read-only
// form, and writes one PNG per state and theme. Opt-in only, never part of `npm run test:e2e`:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/entry-fields.mjs
//
// Each capture is verified after it settles; a state that did not render throws instead of writing a
// plausible-looking wrong image. Files are named `{state}--{theme}.png`.
import { _electron as electron } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('entry fields capture harness: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'entry-fields');
mkdirSync(OUT, { recursive: true });
// Resolved, because Vite fails to import through a symlinked project path (macOS tmpdir is one).
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'so-entry-fields-')));
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await win.setViewportSize({ width: 1440, height: 1000 });
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

/** Capture `target` (an object with screenshot({ path })) in the given themes; `verify` must hold at the moment of capture. */
async function shot(state, target, verify, themes = BOTH, { moveMouse = true } = {}) {
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme });
    await pause(250);
    if (moveMouse) await win.mouse.move(4, 4);
    await pause(200);
    if (!(await verify().catch(() => false))) throw new Error(`state "${state}" (${theme}) did not render; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await target.screenshot({ path });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light' });
  await pause(120);
}

const apply = (operations, label = 'Seed') =>
  win.evaluate(
    async ({ operations, label }) => {
      const r = await window.builder.project.apply({ operations }, { label });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r;
    },
    { operations, label }
  );
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());

// ---- The project and its collections ----
await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Architects', parentDir: dir, starter: 'business', sampleImages: false }), join(WORK, 'sites'));
await win.waitForSelector('.editor');
await frame.locator('h1').first().waitFor({ timeout: 90000 });
await pause(1200);
await win.locator('.rail [aria-label="Content"]').click();
await win.locator('.posts-panel [data-starter="posts"]').click();
await until(async () => !!(await snapshot()).state.collections.posts, 'the blog');

const PEOPLE = [
  ['en_ana00001', 'Ana Ruiz', false],
  ['en_sam00001', 'Sam Taylor', false],
  ['en_sam00002', 'Sam Taylor', false],
  ['en_kit00001', 'Kit Okonkwo-Hargreaves, Associate Director of Sustainable Practice', false],
  ['en_lee00001', 'Lee Chen', true],
  ['en_mia00001', 'Mia Novak', false],
  ['en_tom00001', 'Tomás Ferreira', false]
];
const SERVICES = ['Feasibility studies', 'Site analysis', 'Planning applications', 'Listed building consent', 'Concept design', 'Developed design', 'Technical design', 'Interior architecture', 'Landscape design', 'Passivhaus design', 'Retrofit assessment', 'Energy modelling', 'Daylight studies', 'Acoustic design', 'Accessibility audits', 'Heritage statements', 'Contract administration', 'Tender packages', 'Cost planning', 'Construction phase support', 'Party wall advice', 'Building regulations', 'Fire strategy', 'Furniture design', 'Lighting design', 'Wayfinding', 'Masterplanning', 'Community consultation', 'Design and access statements', 'Measured surveys', 'Condition surveys', 'Model making', 'Visualisation', 'Virtual reality walkthroughs', 'Workshop facilitation', 'Brief writing', 'Post-occupancy evaluation', 'Embodied carbon assessment', 'Circular design strategy', 'Timber frame design', 'Straw bale construction', 'Rammed earth', 'Green roofs', 'Rainwater harvesting', 'Solar design', 'Heat pump strategy', 'Ventilation design', 'Planning appeals', 'Expert witness', 'Teaching and talks', 'Exhibitions', 'Competitions', 'Pro bono work', 'School buildings', 'Housing', 'Workplaces', 'Libraries', 'Museums', 'Health buildings', 'Places of worship'];
const id8 = (i) => `en_svc${String(i).padStart(5, '0')}`;
const date = (i) => `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`;
await apply([
  { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured', singularName: 'Person', hasBody: false, pages: { detail: false, archive: false }, fields: { role: { type: 'string', label: 'Role' } } },
  ...PEOPLE.map(([entryId, title, draft], i) => ({ type: 'entry.create', collectionId: 'team', entryId, title, draft, publishedAt: date(i), values: { role: 'Architect' } })),
  { type: 'collection.create', collectionId: 'services', name: 'Services', kind: 'structured', singularName: 'Service', hasBody: false, pages: { detail: false, archive: false } },
  ...SERVICES.map((title, i) => ({ type: 'entry.create', collectionId: 'services', entryId: id8(i), title, draft: i === 7, publishedAt: date(i) })),
  { type: 'collection.create', collectionId: 'partners', name: 'Partners', kind: 'structured', singularName: 'Partner', hasBody: false, pages: { detail: false, archive: false } }
]);
await apply([
  {
    type: 'collection.create',
    collectionId: 'projects',
    name: 'Projects',
    kind: 'structured',
    singularName: 'Project',
    hasBody: false,
    route: '/work/',
    pages: { detail: true, archive: true },
    fields: {
      client: { type: 'string', label: 'Client', description: 'As it appears in the credits.' },
      area: { type: 'number', label: 'Floor area (m²)', min: 0 },
      featured: { type: 'boolean', label: 'Featured on the home page' },
      sector: { type: 'enum', label: 'Sector', options: [{ value: 'civic', label: 'Civic' }, { value: 'housing', label: 'Housing' }, { value: 'workplace', label: 'Workplace' }], default: 'civic' },
      started: { type: 'date', label: 'Started on site', description: 'The day work began on site.' },
      completed: { type: 'date', label: 'Completed' },
      lead: { type: 'reference', label: 'Project lead', collection: 'team', description: 'Named on the project page.' },
      team: { type: 'reference', label: 'Project team', collection: 'team', multiple: true, description: 'In the order they are credited.' },
      services: { type: 'reference', label: 'Services', collection: 'services', multiple: true },
      partners: { type: 'reference', label: 'Partners', collection: 'partners', multiple: true }
    }
  },
  {
    type: 'entry.create',
    collectionId: 'projects',
    entryId: 'en_lib00001',
    title: 'Harbour Lane library',
    publishedAt: '2026-09-14',
    values: { client: 'Harbour District Council', area: 1840, featured: true, sector: 'civic', started: '2025-03-03', lead: 'en_sam00002', team: ['en_ana00001', 'en_lee00001', 'en_sam00002'], services: [id8(4), id8(6), id8(9), id8(37)] }
  },
  // A reference to an entry of its own collection: the project names other projects.
  { type: 'entry.create', collectionId: 'projects', entryId: 'en_mill0001', title: 'The Old Mill', publishedAt: '2026-05-01' }
]);
// An article collection's custom fields sit in its details.
await apply([{ type: 'collection.update', collectionId: 'posts', fields: { project: { type: 'reference', label: 'About the project', collection: 'projects' }, readTime: { type: 'number', label: 'Reading time (minutes)', min: 1 }, people: { type: 'reference', label: 'People in this post', collection: 'team', multiple: true } } }]).catch(async (e) => {
  console.log('could not add fields to the blog:', String(e).slice(0, 300));
});
await apply([{ type: 'entry.create', collectionId: 'posts', entryId: 'en_post0001', title: 'Opening the Harbour Lane library', publishedAt: '2026-11-12', author: 'Ana Ruiz', values: { project: 'en_lib00001', readTime: 4, people: ['en_ana00001', 'en_mia00001'] }, body: ['The doors opened on a wet Saturday morning, and by noon the reading room was full.'] }]).catch((e) => console.log('could not add the post:', String(e).slice(0, 300)));
await pause(500);

/** The writer's page, the whole of it (taller than the window if it must be). */
const page = win.locator('.post-page');
/** One field, by name, cropped with a margin, scrolled to the top of the writer. */
const field = (name, { below = 0 } = {}) => ({
  async screenshot({ path }) {
    const el = win.locator(`[data-entry-value="${name}"]`);
    await el.evaluate((n) => n.scrollIntoView({ block: 'start' }));
    await win.locator('.post-scroll').evaluate((n) => (n.scrollTop -= 28));
    await pause(150);
    const b = await el.boundingBox();
    const p = await page.boundingBox();
    const view = win.viewportSize();
    const y = Math.max(0, b.y - 20);
    await win.screenshot({ path, clip: { x: p.x + 1, y, width: p.width - 2, height: Math.min(view.height - y, b.height + 40 + below) } });
  }
});
async function openCollection(id) {
  const back = win.locator('.posts-panel [aria-label="All collections"], .posts-panel .posts-back');
  if (await back.first().isVisible().catch(() => false)) await back.first().click();
  const pick = win.locator(`.content-collection-open[data-collection="${id}"]`);
  if (await pick.isVisible().catch(() => false)) await pick.click();
  else {
    await win.locator('.posts-switch').click();
    await win.locator('[role^="menuitem"]', { hasText: (await snapshot()).state.collections[id].settings.name }).first().click();
  }
  await win.locator('.posts-panel .post-row').first().waitFor();
}
async function openEntry(collectionId, title) {
  await openCollection(collectionId);
  await win.locator('.posts-panel .post-row', { hasText: title }).first().click({ timeout: 8000 }).catch(async (e) => {
    await win.screenshot({ path: join(OUT, '..', 'debug.png') });
    throw e;
  });
  await until(async () => (await win.locator('.post-title-input').inputValue()) === title, `the writer to show “${title}”`);
  await pause(500);
}
const values = win.locator('[data-testid="entry-values"]');
const shown = () => values.isVisible();

// ---- A record: its fields are the whole form ----
await openEntry('projects', 'Harbour Lane library');
await win.setViewportSize({ width: 1440, height: 3400 });
await pause(400);
await shot('record', page, shown);
await win.setViewportSize({ width: 1440, height: 1000 });
await pause(300);
await shot('ref-one', field('lead'), shown);
await shot('refs-few', field('team'), shown, LIGHT);
await shot('refs-many', field('services'), shown, LIGHT);
// Past twelve entries the list is found by typing (once that exists).
const finder = win.locator('[data-entry-value="services"] input[aria-label^="Find"]');
if (await finder.count()) {
  await finder.fill('design');
  await shot('refs-many-find', field('services'), async () => (await finder.inputValue()) === 'design', LIGHT, { moveMouse: false });
  await finder.fill('thatch');
  await shot('refs-many-none', field('services'), async () => (await finder.inputValue()) === 'thatch', LIGHT, { moveMouse: false });
  await finder.fill('');
} else console.log('no find field on the services list');
// The most a reference names (50): the rest of the boxes are unavailable, and the field says why.
const services = (await snapshot()).state.collections.projects.entries.en_lib00001.values.services;
await apply([{ type: 'entry.update', collectionId: 'projects', entryId: 'en_lib00001', values: { services: SERVICES.slice(0, 50).map((_, i) => id8(i)) } }], 'Fifty services');
await pause(500);
await shot('refs-full', field('services'), async () => (await win.locator('[data-entry-value="services"] .post-terms-count').innerText()).startsWith('50 of'), LIGHT);
await apply([{ type: 'entry.update', collectionId: 'projects', entryId: 'en_lib00001', values: { services } }], 'Four services');
await pause(500);
await shot('refs-none', field('partners'), shown, LIGHT);
await shot('dates', field('started', { below: 90 }), shown, LIGHT);
// Keyboard on the list of a few.
await win.locator('[data-entry-value="team"] input[type="checkbox"]').nth(1).focus();
await win.keyboard.press('Shift+Tab');
await win.keyboard.press('Tab');
await shot('refs-focus', field('team'), () => win.evaluate(() => !!document.activeElement?.matches('[data-entry-value="team"] input:focus-visible')), LIGHT, { moveMouse: false });
await win.evaluate(() => document.activeElement?.blur());
// A chip removed from the keyboard: the caret goes to the chip now in its place.
await win.locator('[data-entry-value="team"] .entry-ref-chips button').first().focus();
await win.keyboard.press('Enter');
await until(async () => (await win.locator('[data-entry-value="team"] .entry-ref-chips li').count()) === 2, 'the chip to go');
await pause(300);
await shot('chip-removed', field('team'), () => win.evaluate(() => !!document.activeElement?.matches('[data-entry-value="team"] .entry-ref-chips li:first-child button')), LIGHT, { moveMouse: false });
await apply([{ type: 'entry.update', collectionId: 'projects', entryId: 'en_lib00001', values: { team: ['en_ana00001', 'en_lee00001', 'en_sam00002'] } }], 'Team back');
await win.evaluate(() => document.activeElement?.blur());
await pause(400);
// A date typed only in part, then left.
const started = win.locator('[data-entry-value="completed"] input');
await started.click();
await win.keyboard.type('31');
// Out of the field, to another one.
await win.locator('[data-entry-value="client"] input').focus();
await pause(600);
await shot('date-partial', field('completed'), shown, LIGHT, { moveMouse: false });
// Cleared, so the writer has nothing unsaved when it moves on.
await started.fill('');
await win.locator('[data-entry-value="client"] input').focus();
await pause(400);
for (const b of await win.locator('.toast-dismiss').all()) await b.click().catch(() => undefined);

// ---- An article: its fields in its details ----
if ((await snapshot()).state.collections.posts?.settings.fields?.project) {
  await openEntry('posts', 'Opening the Harbour Lane library');
  const head = win.locator('.post-page .post-details .section-head').first();
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await pause(400);
  const details = {
    async screenshot({ path }) {
      await win.locator('.post-page .post-custom').evaluate((n) => n.scrollIntoView({ block: 'start' }));
      await win.locator('.post-scroll').evaluate((n) => (n.scrollTop -= 28));
      await pause(150);
      const p = await page.boundingBox();
      const d = await win.locator('.post-page .post-custom').boundingBox();
      const y = Math.max(0, d.y - 60);
      await win.screenshot({ path, clip: { x: p.x + 1, y, width: p.width - 2, height: Math.min(win.viewportSize().height - y, d.height + 120) } });
    }
  };
  await shot('article', details, () => win.locator('.post-page .post-custom [data-testid="entry-values"]').isVisible());
}

// ---- Gone: references written by hand to an entry and a collection the project no longer has ----
const site = readdirSync(join(WORK, 'sites')).map((d) => join(WORK, 'sites', d))[0];
const find = (dir, test, out = []) => {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) find(p, test, out);
    else if (test(p)) out.push(p);
  }
  return out;
};
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const libFile = find(join(site, 'siteorigin'), (p) => p.endsWith('.json') && readFileSync(p, 'utf8').includes('"en_lib00001"') && readFileSync(p, 'utf8').includes('"Harbour Lane library"'))[0];
const projectsFile = find(join(site, 'siteorigin'), (p) => p.endsWith('.json') && readFileSync(p, 'utf8').includes('"Started on site"'))[0];
if (!libFile || !projectsFile) throw new Error(`could not find the project's files (entry: ${libFile}, collection: ${projectsFile})`);
const lib = json(libFile);
lib.values.lead = 'en_gone0001';
lib.values.team = ['en_ana00001', 'en_gone0002', 'en_sam00002'];
writeFileSync(libFile, JSON.stringify(lib, null, 2));
const projects = json(projectsFile);
projects.fields.partners.collection = 'suppliers';
writeFileSync(projectsFile, JSON.stringify(projects, null, 2));
async function reopen() {
  const r = await win.evaluate((dir) => window.builder.projects.open(dir, { folder: true }), site);
  if (r && r.ok === false) throw new Error(`could not reopen: ${JSON.stringify(r).slice(0, 300)}`);
  await win.waitForSelector('.editor');
  await pause(1500);
}
await reopen();
await openEntry('projects', 'Harbour Lane library');
await win.setViewportSize({ width: 1440, height: 3400 });
await pause(400);
await shot('gone', page, async () => (await shown()) && (await snapshot()).state.collections.projects.entries.en_lib00001.values.lead === 'en_gone0001', LIGHT);
await win.setViewportSize({ width: 1440, height: 1000 });
await pause(300);
await shot('gone-one', field('lead'), shown, LIGHT);
await shot('gone-few', field('team'), shown, BOTH);
await shot('gone-collection', field('partners'), shown, LIGHT);

// ---- Read-only: the collection synced from an external source ----
lib.values.lead = 'en_sam00002';
lib.values.team = ['en_ana00001', 'en_lee00001', 'en_sam00002'];
writeFileSync(libFile, JSON.stringify(lib, null, 2));
projects.fields.partners.collection = 'partners';
writeFileSync(projectsFile, JSON.stringify(projects, null, 2));
await reopen();
// A source's settings are saved only once they are tested, so they are written by hand too.
mkdirSync(join(site, 'siteorigin', 'sources', 'practice-cms'), { recursive: true });
writeFileSync(join(site, 'siteorigin', 'sources', 'practice-cms', 'source.json'), JSON.stringify({ schemaVersion: lib.schemaVersion, id: 'practice-cms', name: 'Practice CMS', adapter: 'rest', collectionId: 'projects', config: { url: 'https://cms.example.com/v1/projects', itemsPath: 'data' } }, null, 2));
const synced = json(projectsFile);
synced.sourceId = 'practice-cms';
writeFileSync(projectsFile, JSON.stringify(synced, null, 2));
const stamp = { sourceId: 'practice-cms', externalId: 'p-1', contentHash: 'abc123', syncedAt: '2026-11-20T09:00:00.000Z' };
const lib2 = json(libFile);
lib2.source = stamp;
writeFileSync(libFile, JSON.stringify(lib2, null, 2));
await reopen();
await openEntry('projects', 'Harbour Lane library');
await win.setViewportSize({ width: 1440, height: 3400 });
await pause(400);
await shot('readonly', page, async () => (await shown()) && (await values.evaluate((n) => n.disabled || !!n.closest('fieldset:disabled'))), BOTH);
await win.setViewportSize({ width: 1440, height: 1000 });

if (errors.length) console.log('page errors:', errors.join('\n'));
await app.close();
rmSync(WORK, { recursive: true, force: true });
const files = readdirSync(OUT).filter((f) => f.endsWith('.png'));
if (!existsSync(OUT) || written.length === 0) throw new Error('no captures written');
console.log(`wrote ${written.length} captures; ${files.length} PNGs in ${OUT}`);
