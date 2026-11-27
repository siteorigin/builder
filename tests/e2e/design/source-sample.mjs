// Design capture for the two parts of the Connect source dialog (SourceDialog) an author spends the most time in once
// the form is filled in: the conversion script, and the sample "Test and fetch a sample" shows. Opt-in only, never
// part of `npm run test:e2e`, and it never saves a source:
//
//   npm run build && DESIGN_CAPTURE=1 [DESIGN_CAPTURE_DIR=/abs/out] node tests/e2e/design/source-sample.mjs
//
// A Business site gets an empty Staff collection with four fields, opened in the Connect source dialog from the
// Content panel the way a person opens it. Every Test reads a small API this script serves on 127.0.0.1, so the
// sample, the empty fields and the errors are what a real source and a real converter give. A capture checks the
// state's own marker is on screen and throws rather than write an image of anything else. Files are
// `{state}--{theme}.png`, cropped to the dialog with a margin of the window.
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, launch, scratch } from '../harness.mjs';

if (process.env.DESIGN_CAPTURE !== '1') {
  console.log('source sample capture: set DESIGN_CAPTURE=1 to run');
  process.exit(0);
}
const OUT = process.env.DESIGN_CAPTURE_DIR ?? join(realpathSync(tmpdir()), 'so-design-capture', 'source-sample');
mkdirSync(OUT, { recursive: true });
const BOTH = ['light', 'dark'];
const LIGHT = ['light'];

// The API: a list of people under data.items, with a nested picture (never fetched: nothing reads it as one) and a
// long biography so wrapping shows.
const PEOPLE = [
  { id: 101, name: 'Ana Ruiz', slug: 'ana-ruiz', role: 'Architect', office: 'London', years: 12, updated: '2026-10-02T09:30:00Z', photo: { url: 'https://cdn.example.com/people/ana-ruiz.jpg', alt: 'Ana at the drawing board' }, bio: 'Leads the residential studio. Before Riverside she spent eight years restoring listed mills along the Calder.' },
  { id: 102, name: 'Ben Okafor', slug: 'ben-okafor', role: 'Engineer', office: 'Leeds', years: 4, updated: '2026-09-18T14:05:00Z', photo: { url: 'https://cdn.example.com/people/ben-okafor.jpg', alt: 'Ben on site' }, bio: 'Structural engineer.' },
  { id: 103, name: 'Dev Patel', slug: 'dev-patel', role: 'Architect', office: 'Bristol', years: 7, updated: '2026-08-30T08:00:00Z', photo: null, bio: '' },
  // More than a Test samples: the counts are for all of them, and only the first few are shown.
  { id: 104, name: 'Mia Lee', slug: 'mia-lee', role: 'Designer', office: 'London', years: 2, updated: '2026-07-11T10:00:00Z', photo: null, bio: 'Interiors.' },
  { id: 105, name: 'Sam Hart', slug: 'sam-hart', role: 'Engineer', office: 'Leeds', years: 9, updated: '2026-06-02T16:45:00Z', photo: null, bio: 'Civil engineer.' }
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

const SCRIPT = `// convert gets every record the source sent, and gives back one entry for each.
export function convert(items, helpers) {
  return items.map((item) => ({
    externalId: String(item.id),
    title: item.name,
    slug: item.slug,
    updatedAt: helpers.date(item.updated),
    excerpt: item.bio.split('. ')[0],
    values: { role: item.role, office: item.office, years: item.years },
  }));
}
`;
// Runs, and throws on the record with no picture: the error names the line.
const THROWS = SCRIPT.replace("excerpt: item.bio.split('. ')[0],", 'excerpt: item.photo.alt,');
// Cannot be read at all.
const BROKEN = SCRIPT.replace('slug: item.slug,', 'slug: item.slug');

const { WORK, cleanup } = scratch('design-source-sample');
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
await apply(
  [
    {
      type: 'collection.create',
      collectionId: 'staff',
      name: 'Staff directory',
      kind: 'structured',
      singularName: 'Person',
      hasBody: false,
      pages: { detail: false, archive: false },
      fields: { role: { type: 'string', label: 'Role' }, office: { type: 'string', label: 'Office' }, years: { type: 'number', label: 'Years with the studio' }, email: { type: 'string', label: 'Email' } }
    }
  ],
  'Staff for the capture'
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

/** Capture the dialog in each theme; `check` must be visible inside it at the moment of capture. */
async function shot(state, check, { themes = BOTH } = {}) {
  const box = win.locator('.modal').last();
  await box.waitFor({ timeout: 15000 });
  for (const theme of themes) {
    await win.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await win.mouse.move(4, 4);
    await pause(300);
    if (!(await box.locator(check).first().isVisible().catch(() => false))) {
      await win.screenshot({ path: join(OUT, `FAILED-${state}.png`) });
      throw new Error(`"${state}" (${theme}): "${check}" is not on screen; refusing to write`);
    }
    const path = join(OUT, `${state}--${theme}.png`);
    await win.screenshot({ path, clip: await clip('.modal') });
    written.push(path);
    console.log('wrote', path);
  }
  await win.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}
const dialog = () => win.locator('.modal').last();
const body = () => win.locator('.modal .modal-body').last();
const into = (sel, block = 'start') => body().locator(sel).first().evaluate((el, block) => el.scrollIntoView({ block }), block);
/** The conversion script, whichever control holds it: a code editor, or a plain text box. */
const script = () => dialog().getByRole('textbox', { name: 'Conversion script (JavaScript)' });
async function writeScript(code) {
  const box = script();
  if (await box.evaluate((el) => el.tagName === 'TEXTAREA')) return box.fill(code);
  await box.click();
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await win.keyboard.insertText(code);
}
const test = async (expect) => {
  await win.locator('[data-testid="source-test"]').click();
  await dialog().locator(expect).first().waitFor({ timeout: 30000 }).catch(async (e) => {
    await win.screenshot({ path: join(OUT, 'FAILED-test.png') });
    throw new Error(`the Test gave no ${expect}: ${await dialog().locator('[data-testid="source-status"]').innerText().catch(() => '?')}`, { cause: e });
  });
  await pause(500);
};

await win.locator('.rail [aria-label="Content"]').click();
// The panel's head switches collection from a menu, then the collection's options hold its source.
await win.locator('[data-testid="collection-options-staff"], .posts-switch').first().waitFor({ timeout: 15000 }).catch(async (e) => {
  await win.screenshot({ path: join(OUT, 'FAILED-panel.png') });
  throw e;
});
if (!(await win.locator('[data-testid="collection-options-staff"]').count())) {
  await win.locator('.posts-switch').click();
  await win.getByRole('menuitemradio', { name: /^Staff directory/ }).or(win.getByRole('menuitem', { name: /^Staff directory/ })).first().click();
}
await win.locator('[data-testid="collection-options-staff"]').click();
await win.getByRole('menuitem', { name: /Connect external source/ }).click();
await win.locator('.modal').waitFor();
await pause(300);
await dialog().getByLabel('Name', { exact: true }).fill('Team API');
await dialog().getByLabel('Address', { exact: true }).fill(`${API}/team`);
await dialog().getByLabel('Where the records are in a reply').fill('data.items');

// ---- Detail by detail: one path that finds nothing, one field a record key matches, one with no match ----
for (const [label, path] of [
  ['Title', 'name'],
  ['Address (slug)', 'slug'],
  ['Updated', 'updated'],
  ['Role', 'role'],
  ['Office', 'location']
]) {
  await dialog().getByLabel(label, { exact: true }).first().fill(path);
}
await pause(200);
await test('[data-testid="source-sample"]');
await shot('mapping-sample', '[data-testid="source-sample"]');
await into('[data-testid="source-sample"] details >> nth=-1', 'end');
await pause(200);
await shot('mapping-sample-records', '[data-testid="source-sample"] details');
// The settings changed after the Test: the sample says it is from before.
await dialog().getByLabel('Office', { exact: true }).first().fill('office');
await pause(300);
await into('[data-testid="source-sample"]');
await shot('mapping-sample-stale', '[data-testid="source-sample"]', { themes: LIGHT });
// A source that cannot be reached: said in the footer.
await dialog().getByLabel('Address', { exact: true }).fill(`${API}/broken`);
await test('[data-testid="source-status"] .field-error');
await shot('mapping-failed', '[data-testid="source-status"] .field-error', { themes: LIGHT });
await dialog().getByLabel('Address', { exact: true }).fill(`${API}/team`);

// ---- By a script ----
await dialog().getByRole('radio', { name: /script/i }).click();
await pause(300);
await into('[data-testid="source-sample"], [data-testid="source-status"]', 'start').catch(() => {});
await script().evaluate((el) => el.scrollIntoView({ block: 'center' }));
await pause(200);
await shot('script-template', '[data-testid="source-test"]');
await writeScript(BROKEN);
await test('[data-testid="source-status"] .field-error');
await script().evaluate((el) => el.scrollIntoView({ block: 'center' }));
await shot('script-unreadable', '[data-testid="source-status"] .field-error');
await writeScript(THROWS);
await test('[data-testid="source-status"] .field-error');
await script().evaluate((el) => el.scrollIntoView({ block: 'center' }));
await shot('script-throws', '[data-testid="source-status"] .field-error', { themes: LIGHT });
// The records the last passing Test read, to find the one the script stopped on.
const last = dialog().locator('[data-testid="source-sample-last"]');
if (await last.count()) {
  await into('[data-testid="source-sample-last"]');
  await shot('script-throws-records', '[data-testid="source-sample-last"]', { themes: LIGHT });
}
await writeScript(SCRIPT);
await test('[data-testid="source-sample"]');
await shot('script-sample', '[data-testid="source-sample"]');

await win.keyboard.press('Escape');
await pause(300);
if (await win.locator('.modal').count()) await win.locator('.modal .modal-head [aria-label="Close"]').last().click();
const st = (await win.evaluate(() => window.builder.project.snapshot())).state;
if (Object.keys(st.sources ?? {}).length) throw new Error('the capture saved a source; it must only test');
if (errors.length) throw new Error(`page errors: ${errors.join('\n')}`);
await win.evaluate(() => window.builder.projects.close());
await app.close();
server.close();
cleanup();

const count = readdirSync(OUT).filter((f) => f.endsWith('.png') && !f.startsWith('FAILED')).length;
console.log(`source sample capture: ${written.length} written, ${count} PNGs in ${OUT}`);
if (count < written.length) throw new Error('fewer PNGs on disk than captures written');
