// Hot updates in the canvas (#14): after a change to a component alone and then to the page that places it,
// the canvas shows one copy of the page, the same one a full reload of the frame and the static export show.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('hot-update');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });

const ids = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const home = s.state.pages[s.state.site.homePageId];
  const hero = home.nodes[home.rootIds[0]];
  return { pageId: home.id, heroId: hero.id, defId: hero.definitionId, reading: s.state.assets.assets.a_reading.file, hero: s.state.assets.assets.a_hero.file };
});
const apply = async (operations, label) => {
  const r = await win.evaluate(([operations, label]) => window.builder.project.apply({ operations }, { label }), [operations, label]);
  assert.equal(r.ok, true, `${label}: ${r.error?.message}`);
  return r;
};
const owner = { kind: 'page', id: ids.pageId };

/** What the canvas shows: every h1, the number of main elements and the images in main, in order. */
const shown = async () => ({
  h1: await frame.locator('h1').allTextContents(),
  main: await frame.locator('main').count(),
  images: (await frame.locator('main img').evaluateAll((els) => els.map((el) => el.getAttribute('src') ?? ''))).map((src) => basename(src))
});
/** One copy of the page, with the expected headline and first image. */
const single = async (headline, firstImage) => {
  const s = await shown();
  assert.deepEqual(s.h1.map((t) => t.trim()), [headline], 'one h1, with the latest headline');
  assert.equal(s.main, 1, 'one main element');
  assert.equal(s.images.length, 5, 'the Home page images appear once');
  assert.equal(s.images[0], basename(firstImage), 'the hero image comes first');
  return s;
};
/** Load the canvas document again, as Try again or reopening the project would. */
const canvas = win.frames().find((f) => f.parentFrame() === win.mainFrame() && f.url().startsWith('http://127.0.0.1'));
assert.ok(canvas, 'the canvas frame is found');
const reloadCanvas = async () => {
  await canvas.evaluate(() => {
    window.__soBeforeReload = true;
    location.reload();
  });
  await eventually(async () => assert.equal(await canvas.evaluate(() => window.__soBeforeReload ?? null), null, 'the frame loaded a new document'), 30000);
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
};

step('a project copy of the hero, on a freshly loaded page');
// Theme components are edited through a project copy. Hot updates only go wrong on a page that was loaded
// (server-rendered and hydrated) before them, so the canvas starts again from a fresh load.
const fork = await apply([{ type: 'component.fork', definitionId: ids.defId }], 'Fork hero');
const defId = fork.results[0].definitionId;
// The copy has its own class names: once the canvas shows them, its update has landed and the reload below
// loads a page that no update has touched since.
await eventually(async () => assert.match((await frame.locator('main section').first().getAttribute('class')) ?? '', /so-proj-/, 'the canvas shows the copy'), 30000);
await reloadCanvas();
await eventually(() => single('Calm, considered spaces for everyday life', ids.hero), 30000);

step('a change to the hero component alone');
// The heading stops following the placement's text and gets its own: only the component's file changes.
await apply(
  [
    { type: 'node.setBinding', owner: { kind: 'component', id: defId }, nodeId: 'heading', field: 'text', binding: null },
    { type: 'node.setContent', owner: { kind: 'component', id: defId }, nodeId: 'heading', field: 'text', value: 'Rooms that feel like home' }
  ],
  'Component headline'
);
await eventually(() => single('Rooms that feel like home', ids.hero), 30000);

step('then a change to the page: the hero image');
await apply([{ type: 'instance.setProp', owner, nodeId: ids.heroId, prop: 'image', value: { assetId: 'a_reading', alt: 'A reading corner with an armchair' } }], 'Hero image');
await eventually(() => single('Rooms that feel like home', ids.reading), 30000);
// Give a stale copy time to show: the check above may pass before the update has fully landed.
await win.waitForTimeout(1000);
await single('Rooms that feel like home', ids.reading);

step('and another change to the page');
await apply([{ type: 'instance.setProp', owner, nodeId: ids.heroId, prop: 'lead', value: 'Plans, materials and a calm process.' }], 'Hero lead');
await eventually(async () => assert.equal(await frame.locator('text=Plans, materials and a calm process.').count(), 1, 'the new lead appears once'), 30000);
await win.waitForTimeout(1000);
const hot = await single('Rooms that feel like home', ids.reading);

step('a full reload of the canvas shows the same page');
await reloadCanvas();
const reloaded = await eventually(() => single('Rooms that feel like home', ids.reading), 30000);
assert.deepEqual(reloaded, hot, 'the hot-updated canvas matches a fresh load');

step('the static export shows the same page');
const exportDir = join(WORK, 'export-static');
const er = await win.evaluate((dest) => window.builderTest.exportStatic(dest), exportDir);
assert.equal(er.ok, true, `static export succeeds: ${er.message}`);
const html = readFileSync(join(exportDir, 'index.html'), 'utf8');
const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
assert.deepEqual([...html.matchAll(/<h1[^>]*>([^<]*)<\/h1>/g)].map((m) => m[1].trim()), ['Rooms that feel like home'], 'the export has the one headline');
assert.deepEqual([...main.matchAll(/<img[^>]*?\ssrc="([^"]+)"/g)].map((m) => basename(m[1])), hot.images, 'the export has the same images in the same order');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nhot-update: passed');
