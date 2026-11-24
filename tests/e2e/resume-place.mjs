// Resuming at the same section (#224): the last call to action on Home, selected and scrolled to, is selected again
// after a Preview → Edit round trip (from the pill and from the toolbar) and stays where the visitor scrolled; a
// visitor's section jump on the page, or link to About, leaves Edit with nothing selected; returning to Home from the page list, and
// reopening the project, selects it again and brings it into view. A section removed meanwhile selects nothing. None of
// it is a change to the site or its Undo history: it is kept in the project's local workspace file.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('resume-place');
const { app, win, errors } = await launch(WORK);
let frame = await createProject(win, { name: 'Resume Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const dir = join(WORK, 'sites', 'resume-studio');

const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = (operations, label) => win.evaluate(([o, l]) => window.builder.project.apply({ operations: o }, { label: l }), [operations, label]);

const s0 = (await snapshot()).state;
const home = s0.site.homePageId;
const about = Object.values(s0.pages).find((p) => p.title === 'About').id;
const cta = s0.pages[home].rootIds.at(-1);
assert.equal(s0.components[s0.pages[home].nodes[cta].definitionId].componentId, 'cta.banner', 'Home ends with a call to action');
assert.ok(s0.pages[home].rootIds.length >= 6, 'Home is long enough to scroll');

const crumbs = win.locator('.status-bar nav[aria-label="Selected element"]');
const pageShown = win.locator('.project-title .page');
const scrollY = () => frame.locator('html').evaluate(() => Math.round(window.scrollY));
const scrollTo = (y) => frame.locator('html').evaluate((html, y) => window.scrollTo({ top: y, behavior: 'instant' }), y);
/** The element the page draws for a node of the page (a managed component is drawn by its design's root). */
const drawn = (nodeId) => frame.locator(`[data-so-node="${nodeId}"], [data-so-ctx$="|${nodeId}"]`).first();
const inView = (nodeId) =>
  drawn(nodeId).evaluate((el) => {
    const r = (getComputedStyle(el).display === 'contents' ? el.firstElementChild || el : el).getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  });
async function settledScroll() {
  return eventually(async () => {
    const a = await scrollY();
    await win.waitForTimeout(300);
    assert.equal(await scrollY(), a, 'the page has stopped moving');
    return a;
  });
}
/** The call to action is what the editor has selected: the crumbs name it and Layers marks its row. */
async function ctaSelected(where) {
  await eventually(async () => assert.match(await crumbs.innerText(), /Call to action/, `${where}: the crumbs name the call to action`));
  await showTab('Layers');
  await eventually(async () => assert.equal(await win.locator(`[role="tree"] [data-node="${cta}"]`).getAttribute('aria-selected'), 'true', `${where}: Layers selects it`));
}
async function nothingSelected(where) {
  await eventually(async () => assert.equal((await crumbs.innerText()).trim(), '', `${where}: nothing is selected`));
  await showTab('Layers');
  assert.equal(await win.locator('[role="tree"] [aria-selected="true"]').count(), 0, `${where}: no layer is selected`);
}
async function openPage(title) {
  await showTab('Pages');
  await win.locator('.side-panel-view:not([hidden]) [data-page]', { hasText: title }).first().click();
  await eventually(async () => assert.match(await pageShown.innerText(), new RegExp(title)));
}
/** Show a sidebar panel (the rail's buttons toggle theirs). */
async function showTab(name) {
  const button = win.locator(`.rail [aria-label="${name}"]`);
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
}
const toolbarMode = (name) => win.locator(`.toolbar button[aria-label="${name}"]`);
const backToEditing = () => win.getByRole('group', { name: 'Preview', exact: true }).getByRole('button', { name: 'Back to editing' });
/** The page is loaded and in Preview, so a link is followed rather than picked. */
const previewing = () => eventually(async () => assert.equal(await frame.locator('html').evaluate((html) => document.readyState === 'complete' && !html.hasAttribute('data-so-editing')), true, 'the page is ready for a visitor'));
const before = await snapshot();
const applied = (snap) => snap.history.entries.filter((e) => e.applied).length;

step('select the last call to action on Home: it is scrolled into view');
await showTab('Layers');
await win.locator(`[role="tree"] [data-node="${cta}"]`).click();
await ctaSelected('selected');
await eventually(async () => assert.equal(await inView(cta), true, 'the call to action is in view'), 15000);
const atCta = await settledScroll();
assert.ok(atCta > 1000, `the page scrolled down to it (${atCta}px)`);

step('Preview, scroll as a visitor, Back to editing: selected again, the page stays where the visitor left it');
await toolbarMode('Preview').click();
await nothingSelected('in Preview');
// Back at the top, well away from the call to action, as a visitor reading the page from its start.
await scrollTo(0);
assert.equal(await settledScroll(), 0);
assert.equal(await inView(cta), false, 'the call to action is out of view');
await backToEditing().click();
await ctaSelected('back from the pill');
await win.waitForTimeout(1000);
assert.equal(await scrollY(), 0, 'the page stays where the visitor left it');

step('Preview and Edit from the toolbar do the same');
await toolbarMode('Preview').click();
await nothingSelected('in Preview again');
await toolbarMode('Edit').click();
await ctaSelected('back from the toolbar');
await win.waitForTimeout(1000);
assert.equal(await scrollY(), 0, 'still where the visitor left it');

step('a visitor section jump on the page leaves Edit with nothing selected');
await toolbarMode('Preview').click();
await previewing();
await frame.locator('html').evaluate(() => (location.hash = '#a-section-further-down'));
await eventually(async () => assert.match(await win.getByRole('group', { name: 'Preview', exact: true }).locator('output').innerText(), /#a-section-further-down/, 'the pill shows the jump'));
await toolbarMode('Edit').click();
await nothingSelected('Home after the jump');

step('a visitor link to About opens About in Edit with nothing selected');
await toolbarMode('Preview').click();
await previewing();
await frame.locator('header nav a', { hasText: 'About' }).first().evaluate((a) => a.click());
await eventually(async () => assert.match(await pageShown.innerText(), /About/, 'the editor follows the visitor'), 15000);
await toolbarMode('Edit').click();
await nothingSelected('About after the visitor link');

step('returning to Home from the page list selects the call to action again, in view');
await openPage('Home');
await ctaSelected('Home again');
await eventually(async () => assert.equal(await inView(cta), true, 'the call to action is in view'), 15000);
assert.ok((await settledScroll()) > 1000, 'the page is scrolled down to it');
await win.screenshot({ path: join(SHOTS, 'resume-place-home.png') });

step('About → Home through the page list resumes on Home too');
await openPage('About');
await nothingSelected('About, never edited');
await openPage('Home');
await ctaSelected('Home from About');
await eventually(async () => assert.equal(await inView(cta), true, 'in view'), 15000);
const after = await snapshot();
assert.equal(after.revision, before.revision, 'none of this changed the site');
assert.equal(applied(after), applied(before), 'nor added a step to Undo');

step('reopening the project opens Home at the call to action, in view');
await win.waitForTimeout(500);
const closed = await win.evaluate(() => window.builder.projects.close());
assert.ok(closed.ok, 'the project closes');
await win.waitForSelector('.welcome');
const workspace = JSON.parse(readFileSync(join(dir, '.siteorigin', 'workspace.json'), 'utf8'));
assert.equal(workspace.pagePlaces?.[home]?.nodeId, cta, 'the place is kept in the local workspace file');
const documents = readdirSync(join(dir, 'siteorigin'), { recursive: true }).filter((f) => String(f).endsWith('.json'));
for (const f of documents) assert.ok(!readFileSync(join(dir, 'siteorigin', String(f)), 'utf8').includes('pagePlaces'), `${f} carries no editor place`);
const opened = await win.evaluate((d) => window.builder.projects.open(d), dir);
assert.ok(opened.ok, `the project opens: ${JSON.stringify(opened)}`);
await win.waitForSelector('.editor');
frame = win.frameLocator('.frame-box iframe');
await frame.locator('html[data-so-editing]').waitFor({ state: 'attached', timeout: 60000 });
await eventually(async () => assert.match(await pageShown.innerText(), /Home/));
await ctaSelected('reopened');
await eventually(async () => assert.equal(await inView(cta), true, 'the call to action is in view after reopening'), 20000);
assert.ok((await settledScroll()) > 1000, 'the reopened page is scrolled down to it');

step('a section removed meanwhile selects nothing in its place');
await openPage('About');
const section = (await snapshot()).state.pages[about].rootIds[0];
await showTab('Layers');
await win.locator(`[role="tree"] [data-node="${section}"]`).click();
await eventually(async () => assert.equal(await win.locator(`[role="tree"] [data-node="${section}"]`).getAttribute('aria-selected'), 'true'));
await openPage('Home');
await ctaSelected('Home, before the removal');
await openPage('About');
await eventually(async () => assert.equal(await win.locator(`[role="tree"] [data-node="${section}"]`).getAttribute('aria-selected'), 'true', 'About resumes at its section'));
await openPage('Home');
await ctaSelected('Home again, before the removal');
const removed = await apply([{ type: 'node.remove', owner: { kind: 'page', id: about }, nodeId: section }], 'Remove');
assert.equal(removed.ok, true, removed.error?.message);
await openPage('About');
await nothingSelected('About without its section');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nresume-place: all checks passed');
