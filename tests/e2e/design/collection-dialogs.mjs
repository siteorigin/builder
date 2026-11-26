// Design capture for a collection's settings dialog (CollectionSchemaDialog), the Connect source dialog
// (SourceDialog) and the Inspector's controls for a list shown from a collection (CollectionListControls). Opt-in
// only, never part of `npm run test:e2e`, and it never saves a source:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/collection-dialogs.mjs
//
// A Business site gets a data-only Team collection with one field of every kind that has settings of its own, a
// Projects collection, and a Team grid on Home connected to Team through the real edit pipeline. The dialogs are
// opened from the Content panel the way a person opens them, and the source dialog's Test reads a small API this
// script serves on 127.0.0.1, so its sample and its error are what a real source gives. A capture checks the state's
// own marker is on screen and throws rather than write an image of anything else. Files are `{state}--{theme}.png`,
// cropped to the dialog (or the Inspector) with a margin of the window.
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, openInspector, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('collection dialogs capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'collection-dialogs');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

// The API the source is tested against: a list of people under data.items, and an address that always fails.
const PEOPLE = [
  { id: 101, name: 'Ana Ruiz', slug: 'ana-ruiz', role: 'Architect', office: 'London', updated: '2026-10-02' },
  { id: 102, name: 'Ben Okafor', slug: 'ben-okafor', role: 'Engineer', office: 'Leeds', updated: '2026-09-18' },
  { id: 103, name: 'Dev Patel', slug: 'dev-patel', role: 'Architect', office: 'Bristol', updated: '2026-08-30' }
];
const server = createServer((req, res) => {
  if (req.url?.startsWith('/team')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: { items: PEOPLE, total: PEOPLE.length } }));
  }
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Service unavailable' }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${server.address().port}`;

const { WORK, cleanup } = scratch('design-collection-dialogs');
const { app, win, errors } = await launch(WORK, {}, { viewport: { width: 1440, height: 1000 } });
await win.evaluate(() => window.builder.app.setSettings({ appearance: 'system' }));
await win.emulateMedia({ reducedMotion: 'reduce' });
const pause = (ms) => win.waitForTimeout(ms);
const written = [];

await createProject(win, { name: 'Riverside Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const apply = async (operations, label) => {
  const r = await win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);
  if (!r?.ok) throw new Error(`${label}: ${JSON.stringify(r?.error ?? r)}`);
  return r;
};
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());

await apply(
  [
    { type: 'collection.create', collectionId: 'projects', kind: 'structured', singularName: 'Project', route: '/work/', pages: { detail: true, archive: true }, fields: { client: { type: 'string', label: 'Client' } } },
    { type: 'entry.create', collectionId: 'projects', entryId: 'en_mill', title: 'The Old Mill', draft: false, values: { client: 'Hart Family' } },
    {
      type: 'collection.create',
      collectionId: 'team',
      kind: 'structured',
      singularName: 'Team member',
      hasBody: false,
      pages: { detail: false, archive: false },
      taxonomies: { departments: { label: 'Departments', terms: { design: { label: 'Design' }, build: { label: 'Build' } } } },
      fields: {
        role: { type: 'string', label: 'Role', description: 'Their job title, as it appears on business cards.' },
        bio: { type: 'string', label: 'Short biography', multiline: true },
        years: { type: 'number', label: 'Years with the studio', min: 0, max: 60 },
        office: { type: 'enum', label: 'Office', options: [{ value: 'london', label: 'London' }, { value: 'leeds', label: 'Leeds' }, { value: 'bristol', label: 'Bristol' }], default: 'london' },
        senior: { type: 'boolean', label: 'Senior' },
        lead: { type: 'reference', label: 'Lead on', collection: 'projects' }
      }
    },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz', draft: false, values: { role: 'Architect', years: 12, senior: true } },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_okafor', title: 'Ben Okafor', draft: false, values: { role: 'Engineer', years: 4 } },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_patel', title: 'Dev Patel', draft: false, values: { role: 'Architect', years: 7 } },
    { type: 'collection.create', collectionId: 'posts' },
    // Only an empty collection can be connected to a source.
    { type: 'collection.create', collectionId: 'staff', name: 'Staff directory', kind: 'structured', singularName: 'Person', hasBody: false, pages: { detail: false, archive: false }, fields: { role: { type: 'string', label: 'Role' }, office: { type: 'string', label: 'Office' } } }
  ],
  'Collections for the capture'
);
let st = (await snapshot()).state;
const home = { kind: 'page', id: st.site.homePageId };
const inserted = await apply([{ type: 'node.insert', owner: home, parentId: null, componentId: 'team.grid' }], 'Team grid');
const gridId = inserted.results[0].nodeId;
await apply(
  [
    {
      type: 'instance.setListSource',
      owner: home,
      nodeId: gridId,
      prop: 'people',
      source: { query: { collectionId: 'team', where: [{ field: 'field.role', op: 'eq', value: 'Architect' }, { field: 'field.years', op: 'gte', value: 5 }, { field: 'field.senior', op: 'eq', value: true }, { field: 'field.office', op: 'in', value: ['london', 'leeds'] }], sort: [{ field: 'title', direction: 'desc' }], limit: 6 }, fields: { name: 'title', role: 'field.role', bio: 'field.bio' } }
    }
  ],
  'Team grid from Team'
);

/** The box `sel` with a margin of the window around it, so its edge and shadow read. */
async function clip(sel, margin = 24) {
  const box = await win.locator(sel).last().boundingBox();
  if (!box) throw new Error(`nothing to crop to: ${sel}`);
  const size = win.viewportSize();
  const x = Math.max(0, Math.floor(box.x - margin));
  const y = Math.max(0, Math.floor(box.y - margin));
  return { x, y, width: Math.min(size.width - x, Math.ceil(box.width + margin * 2)), height: Math.min(size.height - y, Math.ceil(box.height + margin * 2)) };
}

/** Capture `within` (the dialog by default) in each theme; `check` must be visible inside it at the moment of capture. */
async function shot(state, check, { themes = BOTH, within = '.modal' } = {}) {
  const box = win.locator(within).last();
  await box.waitFor({ timeout: 15000 }).catch(async (e) => {
    await win.screenshot({ path: join(OUT, `FAILED-${state}.png`) });
    throw e;
  });
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await win.mouse.move(4, 4);
    await pause(300);
    if (!(await box.locator(check).first().isVisible().catch(() => false))) await win.screenshot({ path: join(OUT, `FAILED-${state}.png`) });
    if (!(await box.locator(check).first().isVisible().catch(() => false))) throw new Error(`"${state}" (${theme}): "${check}" is not on screen; refusing to write`);
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: await clip(within) });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}
const body = () => win.locator('.modal .modal-body').last();
const scrollBody = (to) => body().evaluate((el, to) => (el.scrollTop = to === 'end' ? el.scrollHeight : to), to);
const scrollTo = (sel) => body().locator(sel).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
const dismiss = async () => {
  await win.keyboard.press('Escape');
  await pause(250);
  if (await win.locator('.modal').count()) {
    await win.locator('.modal .modal-head [aria-label="Close"]').last().click();
    await pause(250);
  }
  if (await win.locator('.modal').count()) throw new Error('a dialog did not close');
};

await win.locator('.rail [aria-label="Content"]').click();
/** A collection's actions show on its row once it is the one the panel lists. */
const choose = async (id) => {
  await win.locator(`.content-collection-open[data-collection="${id}"]`).click();
  await win.locator(`[data-testid="collection-settings-${id}"]`).waitFor();
};

// ---- A collection's settings ----
const openSchema = async (id) => {
  await choose(id);
  await win.locator(`[data-testid="collection-settings-${id}"]`).click();
  await win.locator('.modal').waitFor();
  await pause(300);
};
await openSchema('team');
await shot('schema-top', 'input[maxlength="80"]');
await scrollTo('[data-field="years"]');
await shot('schema-fields', '[data-field="years"]');
await scrollBody('end');
await shot('schema-end', 'text=Groupings', { themes: LIGHT });
// A field added and not yet saved: its kind can still change.
await body().getByRole('button', { name: 'Add a field' }).click();
await win.getByRole('menuitem', { name: 'Choice' }).click();
await pause(300);
await scrollBody('end');
await shot('schema-new-field', 'text=Groupings');
// The collection changed while the dialog was open: Save is refused in the dialog, which offers to show it as it is now.
await apply([{ type: 'entry.create', collectionId: 'team', entryId: 'en_leemia', title: 'Mia Lee', draft: false, values: { role: 'Designer' } }], 'An entry added meanwhile');
await win.locator('[data-testid="schema-save"]').click();
await pause(300);
await shot('schema-error', '[role="alert"]', { themes: LIGHT });
await dismiss();
await openSchema('posts');
await shot('schema-posts', 'input[maxlength="80"]', { themes: LIGHT });
await dismiss();

// ---- Connect external source ----
await choose('staff');
await win.locator('[data-testid="collection-source-staff"]').click();
await win.getByRole('menuitem', { name: /Connect external source/ }).click();
await win.locator('.modal').waitFor();
await pause(300);
await shot('source-new', '[data-testid="source-test"]');
const dialog = () => win.locator('.modal').last();
await dialog().getByLabel('Address', { exact: true }).fill(`${API}/team`);
if (!(await dialog().getByLabel('Headers 1 name').count())) await dialog().getByRole('button', { name: /^Add a header|^Add$/ }).first().click();
await dialog().getByLabel('Headers 1 name').fill('Authorization');
await dialog().getByLabel('Headers 1 value').fill('Bearer ${secret:api-token}');
await dialog().getByLabel('Where the records are in a reply').fill('data.items');
await pause(300);
await dialog().getByLabel('Value of the secret api-token').evaluate((el) => el.closest('.sd-secret').scrollIntoView({ block: 'center' }));
await pause(200);
await shot('source-filled', '.sd-secret .badge.amber');
await dialog().getByLabel('Value of the secret api-token').fill('sk_live_capture');
await dialog().getByRole('button', { name: 'Keep on this computer' }).click();
await pause(600);
// Where each detail is read from, for the records this API sends.
for (const [label, path] of [['Title', 'name'], ['Role', 'role']]) {
  const input = dialog().getByLabel(label, { exact: true });
  if (await input.count()) await input.first().fill(path);
}
await win.locator('[data-testid="source-test"]').click();
await dialog().locator('[data-testid="source-sample"]').waitFor({ timeout: 30000 });
await pause(500);
await shot('source-tested', '[data-testid="source-sample"]');
await dialog().getByLabel('Address', { exact: true }).fill(`${API}/broken`);
await win.locator('[data-testid="source-test"]').click();
await dialog().locator('[data-testid="source-status"] .field-error').waitFor({ timeout: 30000 });
await pause(400);
await shot('source-error', '[data-testid="source-status"] .field-error');
await dialog().getByRole('radio', { name: /script/i }).click();
await pause(300);
await body().locator('textarea').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
await pause(200);
await shot('source-converter', 'textarea', { themes: LIGHT });
await dialog().getByLabel('Kind of source').selectOption('sanity');
await pause(300);
await scrollBody(0);
await shot('source-sanity', 'textarea', { themes: LIGHT });
await dialog().getByLabel('Kind of source').selectOption('strapi');
await pause(300);
await shot('source-strapi', '[data-testid="source-test"]', { themes: LIGHT });
await dismiss();
if (Object.keys((await snapshot()).state.sources ?? {}).length) throw new Error('the capture saved a source; it must only test');

// ---- The Inspector: a list shown from a collection ----
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator(`.layers-tree [data-node="${gridId}"]`).first().click();
await openInspector(win);
const panel = '#dock-panel-inspect';
const listSource = win.locator(`${panel} [data-list-source="people"]`).first();
await listSource.waitFor({ timeout: 15000 });
await listSource.locator('.cq-map-row').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
await pause(400);
await shot('inspector-list-mapping', '[data-list-source="people"] .cq-map-row', { within: panel });
await listSource.locator('.cq').evaluate((el) => {
  const scroller = el.closest('[class*="scroll"], .insp') ?? el.parentElement;
  el.scrollIntoView({ block: 'end' });
  return scroller?.className;
});
await pause(300);
await shot('inspector-list', '[data-list-source="people"]', { within: panel });
await listSource.getByRole('radio', { name: 'Its own items' }).click();
await pause(500);
await win.locator(`${panel} [data-list-source="people"]`).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
await shot('inspector-list-own', '[data-list-source="people"]', { within: panel, themes: LIGHT });

st = (await snapshot()).state;
if (errors.length) throw new Error(`page errors: ${errors.join('\n')}`);
await win.evaluate(() => window.builder.projects.close());
await app.close();
server.close();
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png')).length;
console.log(`collection dialogs capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
