// Hot updates in the canvas (#14): after a change to a component alone and then to the page or component that
// places it, the canvas shows one copy of the page, the same one a full reload of the frame and the static
// export show. Each scenario starts from a server-rendered, hydrated page and checks that every later step
// was a hot update of that same document, never a reload that would hide the problem.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('hot-update');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const canvas = await (await win.locator('.frame-box iframe').elementHandle()).contentFrame();
assert.ok(canvas, 'the canvas frame is found');

const ids = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const home = s.state.pages[s.state.site.homePageId];
  const def = (id) => s.state.components[home.nodes[id].definitionId];
  const served = (file) => '/' + file.replace(/^static\//, '');
  return {
    pageId: home.id,
    heroId: home.rootIds[0],
    heroDef: def(home.rootIds[0]).id,
    featuresId: home.rootIds[2],
    featuresDef: def(home.rootIds[2]).componentId === 'features.grid' ? def(home.rootIds[2]).id : null,
    heroImage: served(s.state.assets.assets.a_hero.file),
    reading: served(s.state.assets.assets.a_reading.file)
  };
});
assert.ok(ids.featuresDef, 'the third Home section is the features grid');
const apply = async (operations, label) => {
  const r = await win.evaluate(([operations, label]) => window.builder.project.apply({ operations }, { label }), [operations, label]);
  assert.equal(r.ok, true, `${label}: ${r.error?.message}`);
  return r;
};
const owner = { kind: 'page', id: ids.pageId };

/**
 * What a document shows: its h1 headings, main elements, and the images and lead paragraphs in main, in order.
 * Runs in a page: the canvas document itself when `html` is null, else `html` parsed there. For the canvas it
 * also reports the label of the document, whether its first section was hydrated from server-rendered markup
 * (which keeps Svelte's "[" block markers; markup rendered in the page has none) and the marks on its sections.
 */
function snapshot(html) {
  const doc = html === null ? document : new DOMParser().parseFromString(html, 'text/html');
  const main = doc.querySelector('main');
  const sections = main ? [...main.querySelectorAll('section')] : [];
  const markers = [];
  if (sections[0]) for (const w = doc.createTreeWalker(sections[0], NodeFilter.SHOW_COMMENT); w.nextNode(); ) markers.push(w.currentNode.data);
  return {
    h1: [...doc.querySelectorAll('h1')].map((el) => el.textContent.trim()),
    main: doc.querySelectorAll('main').length,
    images: main ? [...main.querySelectorAll('img')].map((img) => new URL(img.getAttribute('src') ?? '', 'http://site/').pathname) : [],
    leads: main ? [...main.querySelectorAll('[class*="__lead"]')].map((el) => el.textContent.trim()) : [],
    sections: sections.length,
    canvas: html === null ? { doc: window.__soDoc ?? null, hydrated: markers.some((m) => m.startsWith('[')), marks: sections.map((el) => el.__soMark ?? null) } : null
  };
}
const shown = () => canvas.evaluate(snapshot, null);
const content = ({ canvas: _, ...rest }) => rest;
const textCount = (text) => frame.getByText(text, { exact: true }).count();

/** Load the canvas document again (as Try again or reopening the project would), then label it and mark its sections. */
let loads = 0;
async function reloadCanvas() {
  await canvas.evaluate(() => {
    window.__soBeforeReload = true;
    location.reload();
  });
  await eventually(async () => assert.equal(await canvas.evaluate(() => window.__soBeforeReload ?? null), null, 'the frame loaded a new document'), 30000);
  // The bridge loads once the page has hydrated.
  await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 30000 });
  const doc = `load ${++loads}`;
  await canvas.evaluate((doc) => {
    window.__soDoc = doc;
    document.querySelectorAll('main section').forEach((el, i) => (el.__soMark = i + 1));
  }, doc);
  const s = await shown();
  assert.equal(s.canvas.hydrated, true, 'the reloaded page was hydrated from the server-rendered page');
  return { doc, sections: s.sections };
}

/** The canvas still shows document `doc`, updated in place, with one copy of Home: this headline and first image. */
async function single(doc, sections, headline, firstImage) {
  const s = await shown();
  assert.equal(s.canvas.doc, doc, 'the canvas was updated in place, not reloaded');
  assert.deepEqual(s.h1, [headline], 'one h1, with the latest headline');
  assert.equal(s.main, 1, 'one main element');
  assert.equal(s.sections, sections, 'each section appears once');
  assert.equal(s.images.length, 5, 'the Home page images appear once');
  assert.equal(s.images[0], firstImage, 'the hero image comes first');
  return s;
}
/** Long enough for a stale copy to show once an update has landed: the check before it can pass first. */
const settle = () => win.waitForTimeout(1000);

step('the hero: a project copy, on a freshly loaded page');
// Theme components are edited through a project copy, which has its own class names: once the canvas shows them,
// its update has landed and the reload loads a page that no update has touched since.
const heroCopy = (await apply([{ type: 'component.fork', definitionId: ids.heroDef }], 'Fork hero')).results[0].definitionId;
await eventually(async () => assert.match((await frame.locator('main section').first().getAttribute('class')) ?? '', /so-proj-/, 'the canvas shows the copy'), 30000);
let { doc, sections } = await reloadCanvas();
await single(doc, sections, 'Calm, considered spaces for everyday life', ids.heroImage);

step('a change to the hero component alone');
// The heading stops following the placement's text and gets its own: only the component's file changes.
await apply(
  [
    { type: 'node.setBinding', owner: { kind: 'component', id: heroCopy }, nodeId: 'heading', field: 'text', binding: null },
    { type: 'node.setContent', owner: { kind: 'component', id: heroCopy }, nodeId: 'heading', field: 'text', value: 'Rooms that feel like home' }
  ],
  'Hero component headline'
);
await eventually(() => single(doc, sections, 'Rooms that feel like home', ids.heroImage), 30000);
const marks = (await shown()).canvas.marks;
assert.equal(marks[0], null, 'the hero section was replaced');
assert.ok(marks.slice(1).every((m) => m !== null), 'the other sections were kept');

step('then a change to the page: the hero image');
await apply([{ type: 'instance.setProp', owner, nodeId: ids.heroId, prop: 'image', value: { assetId: 'a_reading', alt: 'A reading corner with an armchair' } }], 'Hero image');
await eventually(() => single(doc, sections, 'Rooms that feel like home', ids.reading), 30000);
await settle();
await single(doc, sections, 'Rooms that feel like home', ids.reading);

step('and another change to the page');
const lead = 'Plans, materials and a calm process.';
await apply([{ type: 'instance.setProp', owner, nodeId: ids.heroId, prop: 'lead', value: lead }], 'Hero lead');
const leadShown = async () => {
  const s = await single(doc, sections, 'Rooms that feel like home', ids.reading);
  assert.equal(s.leads.filter((t) => t === lead).length, 1, 'the new lead appears once');
  return s;
};
await eventually(leadShown, 30000);
await settle();
const afterHero = content(await leadShown());

step('the features grid: a component that places another, on a freshly loaded page');
// The features placement becomes a component of its own whose root is the theme's features grid, and that grid
// gets a project copy. Neither changes what the page shows.
const outer = (await apply([{ type: 'component.createFromNode', owner, nodeId: ids.featuresId, name: 'Services band' }], 'Services band')).results[0].definitionId;
const featuresCopy = (await apply([{ type: 'component.fork', definitionId: ids.featuresDef }], 'Fork features')).results[0].definitionId;
await eventually(async () => assert.match((await frame.locator('main section').nth(2).getAttribute('class')) ?? '', /so-proj-/, 'the canvas shows the copy'), 30000);
({ doc, sections } = await reloadCanvas());
assert.deepEqual(content(await shown()), afterHero, 'a full reload shows what the hot updates did');
const inner = await win.evaluate(async (outer) => (await window.builder.project.snapshot()).state.components[outer].tree.rootIds[0], outer);

step('a change to the features grid alone');
await apply(
  [
    { type: 'node.setBinding', owner: { kind: 'component', id: featuresCopy }, nodeId: 'eyebrow', field: 'text', binding: null },
    { type: 'node.setContent', owner: { kind: 'component', id: featuresCopy }, nodeId: 'eyebrow', field: 'text', value: 'Services, start to finish' }
  ],
  'Features eyebrow'
);
await eventually(async () => {
  await single(doc, sections, 'Rooms that feel like home', ids.reading);
  assert.equal(await textCount('Services, start to finish'), 1, 'the new eyebrow appears once');
}, 30000);
const featureMarks = (await shown()).canvas.marks;
assert.equal(featureMarks[2], null, 'the features section was replaced');
assert.ok(featureMarks.every((m, i) => i === 2 || m !== null), 'the other sections were kept');

step('then a change to the component that places it');
const heading = 'Everything a home project needs';
await apply([{ type: 'instance.setProp', owner: { kind: 'component', id: outer }, nodeId: inner, prop: 'heading', value: heading }], 'Services heading');
const featuresShown = async () => {
  const s = await single(doc, sections, 'Rooms that feel like home', ids.reading);
  assert.equal(await textCount(heading), 1, 'the new heading appears once');
  assert.equal(await textCount('Services, start to finish'), 1, 'the eyebrow appears once');
  assert.equal(s.leads.filter((t) => t === lead).length, 1, 'the hero lead appears once');
  return s;
};
await eventually(featuresShown, 30000);
await settle();
const hot = content(await featuresShown());

step('a full reload of the canvas shows the same page');
({ doc } = await reloadCanvas());
assert.deepEqual(content(await shown()), hot, 'a full reload shows what the hot updates did');

step('the static export shows the same page');
const exportDir = join(WORK, 'export-static');
const er = await win.evaluate((dest) => window.builderTest.exportStatic(dest), exportDir);
assert.equal(er.ok, true, `static export succeeds: ${er.message}`);
const exported = content(await win.evaluate(snapshot, readFileSync(join(exportDir, 'index.html'), 'utf8')));
assert.deepEqual(exported, hot, 'the export shows what the canvas shows');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nhot-update: passed');
