// Hot updates in the canvas (#14): after a change to a component alone and then to the page or component that
// places it, the canvas shows one copy of the page, the same one a full reload of the frame and the static
// export show. Each scenario starts from a server-rendered, hydrated page and checks that every later step
// was a hot update of that same document, never a reload that would hide the problem.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, openInspector, scratch, step } from './harness.mjs';

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
 * also reports the label of the document, which sections were hydrated from server-rendered markup (it keeps
 * Svelte's "[" block markers; markup rendered in the page has none) and the marks on its sections.
 */
function snapshot(html) {
  const doc = html === null ? document : new DOMParser().parseFromString(html, 'text/html');
  const main = doc.querySelector('main');
  const sections = main ? [...main.querySelectorAll('section')] : [];
  const hydrated = (el) => {
    for (const w = doc.createTreeWalker(el, NodeFilter.SHOW_COMMENT); w.nextNode(); ) if (w.currentNode.data.startsWith('[')) return true;
    return false;
  };
  return {
    h1: [...doc.querySelectorAll('h1')].map((el) => el.textContent.trim()),
    h2: main ? [...main.querySelectorAll('h2')].map((el) => el.textContent.trim()) : [],
    main: doc.querySelectorAll('main').length,
    images: main ? [...main.querySelectorAll('img')].map((img) => new URL(img.getAttribute('src') ?? '', 'http://site/').pathname) : [],
    leads: main ? [...main.querySelectorAll('[class*="__lead"]')].map((el) => el.textContent.trim()) : [],
    sections: sections.length,
    canvas: html === null ? { doc: window.__soDoc ?? null, hydrated: sections.map(hydrated), marks: sections.map((el) => el.__soMark ?? null) } : null
  };
}
const shown = () => canvas.evaluate(snapshot, null);
const content = ({ canvas: _, ...rest }) => rest;
const textCount = (text) => frame.getByText(text, { exact: true }).count();

/**
 * Load the canvas document again (as Try again or reopening the project would), then label it and mark its
 * sections. The section about to be edited must have been hydrated from the server-rendered page.
 */
let loads = 0;
async function reloadCanvas(edited) {
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
  assert.equal(s.canvas.hydrated[edited], true, 'the section to edit was hydrated from the server-rendered page');
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
/**
 * Until the canvas shows the project copy at section `index`. The copy has its own class names and no theme
 * ones left; once they show, its update has landed and a reload loads a page no update has touched since.
 */
const showsCopy = (index) =>
  eventually(async () => {
    const cls = (await frame.locator('main section').nth(index).getAttribute('class')) ?? '';
    assert.match(cls, /so-proj-/, 'the canvas shows the copy');
    assert.doesNotMatch(cls, /so-foundation-/, 'the theme component is gone');
  }, 30000);

step('the hero: a project copy, on a freshly loaded page');
// Theme components are edited through a project copy.
const heroCopy = (await apply([{ type: 'component.fork', definitionId: ids.heroDef }], 'Fork hero')).results[0].definitionId;
await showsCopy(0);
let { doc, sections } = await reloadCanvas(0);
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
await showsCopy(2);
({ doc, sections } = await reloadCanvas(2));
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
content(await featuresShown());

step('one save that changes the hero component and the page reaches the canvas as one update (#735)');
// Every update packet the page is sent, and every state the hero passes through as the page changes.
await canvas.evaluate(async () => {
  const { createHotContext } = await import('/@vite/client');
  window.__soUpdates = [];
  createHotContext('/@siteorigin-test/hot-update-probe').on('vite:beforeUpdate', (p) => window.__soUpdates.push(p.updates.map((u) => u.path)));
  window.__soHero = [];
  const read = () => {
    const hero = document.querySelector('main section');
    return `${hero?.querySelector('h1')?.textContent.trim() ?? ''} | ${hero?.querySelector('[class*="__lead"]')?.textContent.trim() ?? ''}`;
  };
  new MutationObserver(() => window.__soHero.push(read())).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
});
const headline2 = 'Homes with room to breathe';
const lead2 = 'Measured plans and honest materials.';
await apply(
  [
    { type: 'node.setContent', owner: { kind: 'component', id: heroCopy }, nodeId: 'heading', field: 'text', value: headline2 },
    { type: 'instance.setProp', owner, nodeId: ids.heroId, prop: 'lead', value: lead2 }
  ],
  'Hero headline and lead'
);
const bothShown = async () => {
  const s = await single(doc, sections, headline2, ids.reading);
  assert.equal(s.leads.filter((t) => t === lead2).length, 1, 'the new lead appears once');
  return s;
};
await eventually(bothShown, 30000);
await settle();
const probe = await canvas.evaluate(() => ({ updates: window.__soUpdates, hero: window.__soHero }));
assert.equal(probe.updates.length, 1, `the save reached the page as one hot update: ${JSON.stringify(probe.updates)}`);
assert.ok(probe.updates[0].length >= 2, `the update carries the component and the page: ${JSON.stringify(probe.updates[0])}`);
const half = probe.hero.filter((h) => h === `${headline2} | ${lead}` || h === `Rooms that feel like home | ${lead2}`);
assert.deepEqual(half, [], 'the canvas never showed half of the save');
const hot = content(await bothShown());

step('a full reload of the canvas shows the same page');
({ doc } = await reloadCanvas(0));
assert.deepEqual(content(await shown()), hot, 'a full reload shows what the hot updates did');

step('the static export shows the same page');
const exportDir = join(WORK, 'export-static');
const er = await win.evaluate((dest) => window.builderTest.exportStatic(dest), exportDir);
assert.equal(er.ok, true, `static export succeeds: ${er.message}`);
const exported = content(await win.evaluate(snapshot, readFileSync(join(exportDir, 'index.html'), 'utf8')));
assert.deepEqual(exported, hot, 'the export shows what the canvas shows');

step('a click made while a save is still reaching the page selects what was clicked once it has (#755)');
const lead3 = 'Light-filled rooms, made to last.';
const heroHeading = frame.locator('main section').first().locator('h1');
await heroHeading.evaluate((el) => el.scrollIntoView({ block: 'center' }));
// The page holds the save's update until the test lets it go (Vite waits on its beforeUpdate listeners), so the click
// lands while the page still shows the hero as it was.
await canvas.evaluate(async () => {
  const { createHotContext } = await import('/@vite/client');
  window.__soHeld = false;
  window.__soHold = new Promise((resolve) => (window.__soRelease = resolve));
  createHotContext('/@siteorigin-test/hold-probe').on('vite:beforeUpdate', () => {
    if (!window.__soHold) return;
    window.__soHeld = true;
    return window.__soHold;
  });
});
await apply([{ type: 'instance.setProp', owner, nodeId: ids.heroId, prop: 'lead', value: lead3 }], 'Hero lead again');
await eventually(async () => assert.equal(await canvas.evaluate(() => window.__soHeld), true, 'the page has the update, held'), 30000);
// The editor has the save by now too.
await win.waitForTimeout(300);
/** What the editor has selected, as the canvas names it (no selection: null). */
const selected = async () => {
  const raw = await win.locator('[data-opening]').first().getAttribute('data-selected-ref');
  return raw ? JSON.parse(raw) : null;
};
const before = await selected();
assert.notEqual(before?.nodeId, ids.heroId, 'the hero is not selected yet');
let released = 0;
try {
  await heroHeading.click();
  await win.waitForTimeout(500);
  assert.deepEqual(await selected(), before, 'the click waits while the page still shows the hero before the save');
} finally {
  await canvas.evaluate(() => {
    window.__soHold = null;
    window.__soRelease();
  });
  released = Date.now();
}
// The page's acknowledgement lets the click go, well before the canvas would stop waiting for one (4 s after the save).
await eventually(async () => assert.equal((await selected())?.nodeId, ids.heroId, 'the click selects the hero once the page shows the save, with no second click'), 15000);
assert.ok(Date.now() - released < 2000, `the page’s acknowledgement released the click (selected ${Date.now() - released} ms after the update was let go)`);
assert.ok((await shown()).leads.includes(lead3), 'the page shows the save');

step('a field left while its save waits for the page to take the one before shows what was typed until the save lands, never the value before it');
{
  const eyebrowBefore = 'Before the slow save';
  const typed = 'Typed while the page catches up';
  await apply([{ type: 'instance.setProp', owner, nodeId: ids.heroId, prop: 'eyebrow', value: eyebrowBefore }], 'Hero eyebrow');
  await eventually(async () => assert.ok((await frame.getByText(eyebrowBefore, { exact: true }).count()) > 0, 'the page shows the eyebrow'), 30000);
  await openInspector(win);
  const field = win.locator('#dock-panel-inspect').getByRole('textbox', { name: 'Eyebrow', exact: true });
  await eventually(async () => assert.equal(await field.inputValue(), eyebrowBefore, 'the Inspector shows the saved eyebrow'));
  // The page holds the next save's update, so the save after it waits for the page (the preview takes saves one at a
  // time) and lands only some time after the field is left.
  await canvas.evaluate(() => {
    window.__soHeld = false;
    window.__soHold = new Promise((resolve) => (window.__soRelease = resolve));
  });
  await apply([{ type: 'instance.setProp', owner, nodeId: ids.heroId, prop: 'lead', value: 'Held at the page' }], 'Hero lead held');
  await eventually(async () => assert.equal(await canvas.evaluate(() => window.__soHeld), true, 'the page has the update, held'), 30000);
  try {
    await field.fill(typed);
    // Every value the field shows from the moment it is left until its save has landed (or 3 s).
    const shownAfterLeaving = await field.evaluate(async (el, until) => {
      const seen = [el.value];
      const started = await window.builder.project.snapshot().then((s) => s.revision);
      el.blur();
      const t0 = performance.now();
      while (performance.now() - t0 < 3000) {
        await new Promise((r) => setTimeout(r, 10));
        if (seen.at(-1) !== el.value) seen.push(el.value);
        if (el.value === until && (await window.builder.project.snapshot()).revision > started && performance.now() - t0 > 1000) break;
      }
      return seen;
    }, typed);
    assert.deepEqual(shownAfterLeaving, [typed], 'the field shows what was typed throughout, and never the saved value from before');
  } finally {
    await canvas.evaluate(() => {
      window.__soHold = null;
      window.__soRelease();
    });
  }
  await eventually(async () => assert.equal(await field.inputValue(), typed, 'the field shows the saved text'));
  await eventually(async () => assert.ok((await frame.getByText(typed, { exact: true }).count()) > 0, 'the page shows it'), 30000);
}

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nhot-update: passed');
