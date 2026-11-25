// The page problem bar's Revert and Open source (#738). The page's errors are reported exactly as the preview's
// bridge reports them, from inside the real preview frame: an error naming a generated component's file offers its
// source, and an error that follows an edit offers to undo that edit, which brings the page back.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('preview-error');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const issue = win.locator('.ai-veil.issue');
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());

/** Report something to the editor from the preview page, as its bridge does. */
async function bridge(type, payload) {
  const handle = await win.locator('.frame-box iframe').elementHandle();
  const content = await handle.contentFrame();
  await content.evaluate(([t, p]) => window.parent.postMessage({ protocolVersion: 1, sessionId: window.name, navigationId: location.pathname, revision: 0, type: t, payload: p }, '*'), [type, payload]);
}
const settle = () => win.waitForTimeout(2200);

const s0 = await snapshot();
const home = s0.state.pages[s0.state.site.homePageId];
const heroNode = home.nodes[home.rootIds[0]];
const heroDef = s0.state.components[heroNode.definitionId];
const defKey = heroDef.id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
const heroProp = Object.entries(heroNode.props).find(([, v]) => typeof v === 'string')?.[0];
assert.ok(heroProp, 'the hero has a text property to edit');

step('an error with no edit before it offers no Revert, and names the component it came from');
await settle();
await bridge('runtimeError', {
  message: 'Cannot read properties of undefined (reading "title")',
  stack: `TypeError: Cannot read properties of undefined (reading "title")\n    at Hero (http://127.0.0.1:5173/src/lib/siteorigin/generated/${defKey}.svelte?t=1:12:3)`,
  revision: s0.revision
});
await issue.getByRole('button', { name: 'Try again' }).waitFor();
assert.equal(await issue.getByRole('button', { name: /^Revert/ }).count(), 0, 'nothing was changed since the page last worked');
await issue.getByRole('button', { name: 'Open source' }).click();
await win.getByRole('textbox', { name: `${heroDef.name} Svelte source, read only` }).waitFor({ timeout: 10000 });
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });

step('an error with no component in it offers only what it did before');
await bridge('runtimeError', { message: 'Something else went wrong', revision: s0.revision });
await eventually(async () => assert.match(await issue.innerText(), /Try again/));
assert.equal(await issue.getByRole('button', { name: 'Open source' }).count(), 0, 'no component is named');
assert.equal(await issue.getByRole('button', { name: /^Revert/ }).count(), 0);
await bridge('revisionApplied', {});
await issue.waitFor({ state: 'detached' });

step('an error after an edit offers to revert it, and Revert brings the page back without it');
await settle();
const before = heroNode.props[heroProp];
const r = await win.evaluate(
  ([pageId, nodeId, prop]) => window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId, prop, value: 'Broken by this edit' }] }, { label: 'Break the hero' }),
  [home.id, heroNode.id, heroProp]
);
assert.equal(r.ok, true, r.error?.message);
// The edit's error, as the page reports it while showing that edit: its own later "shown" leaves it in place.
await bridge('runtimeError', { message: 'Cannot read properties of undefined (reading "title")', stack: `at http://127.0.0.1:5173/src/lib/siteorigin/generated/${defKey}.svelte:4:1`, revision: r.revision });
await bridge('revisionApplied', { revision: r.revision });
const revert = issue.getByRole('button', { name: 'Revert “Break the hero”' });
await revert.waitFor({ timeout: 10000 });
await win.waitForTimeout(500);
assert.equal(await issue.isVisible(), true, 'showing the change that broke the page does not clear its error');
await revert.click();
await issue.waitFor({ state: 'detached', timeout: 60000 });
const after = await snapshot();
assert.equal(after.state.pages[home.id].nodes[heroNode.id].props[heroProp], before, 'the edit is undone');
assert.equal(after.history.entries.find((e) => e.id === r.entryId)?.applied, false, 'its History step is undone');

step('after an Undo, an error offers no Revert');
await settle();
await bridge('runtimeError', { message: 'Still broken', revision: after.revision });
await issue.getByRole('button', { name: 'Try again' }).waitFor();
assert.equal(await issue.getByRole('button', { name: /^Revert/ }).count(), 0, 'undoing the undo is a Redo, not a revert');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\npreview-error: passed');
