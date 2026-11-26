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

async function frame() {
  const content = await (await win.locator('.frame-box iframe').elementHandle()).contentFrame();
  if (!content) throw new Error('the preview frame has no page');
  return content;
}
/** Report something to the editor from the preview page, as its bridge does. */
async function bridge(type, payload) {
  await (await frame()).evaluate(([t, p]) => {
    const navigationId = document.documentElement.dataset.soNavigation;
    if (!navigationId) throw new Error('the preview bridge has not named its navigation');
    window.parent.postMessage({ protocolVersion: 1, sessionId: window.name, navigationId, revision: p.revision ?? 0, type: t, payload: p }, '*');
  }, [type, payload]);
}
/** The bar's buttons, by name, in order. */
const buttons = () => issue.getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent.trim()));
/** Long enough for the page to count as working (1.5 s without an error). */
const settle = () => win.waitForTimeout(2200);
const apply = async (prop, value, label) => {
  const r = await win.evaluate(
    ([pageId, nodeId, prop, value, label]) => window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: pageId }, nodeId, prop, value }] }, { label }),
    [home.id, heroNode.id, prop, value, label]
  );
  assert.equal(r.ok, true, `${label}: ${r.error?.message}`);
  return r;
};

const s0 = await snapshot();
const home = s0.state.pages[s0.state.site.homePageId];
const heroNode = home.nodes[home.rootIds[0]];
const heroDef = s0.state.components[heroNode.definitionId];
const defKey = heroDef.id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
const textProps = Object.entries(heroNode.props).filter(([, v]) => typeof v === 'string' && v.trim());
assert.ok(textProps.length >= 2, 'the hero has two text properties to edit');
const [[keptProp], [brokenProp, brokenBefore]] = textProps;

step('the first edit after the page opens, followed by an error, offers to revert it');
// The page loaded and went a moment without an error: that is the sighting Revert works from.
await settle();
const early = await apply(keptProp, 'Early edit', 'Early edit');
await bridge('runtimeError', { message: 'Broken by the first edit', revision: early.revision });
await issue.getByRole('button', { name: 'Revert “Early edit”' }).waitFor({ timeout: 10000 });
await bridge('revisionApplied', {});
await issue.waitFor({ state: 'detached' });

step('an error with no edit before it offers no Revert, and Open source opens the generated component read only');
await settle();
await bridge('runtimeError', { message: 'Cannot read properties of undefined (reading "title")', file: `http://127.0.0.1:5173/src/lib/siteorigin/generated/${defKey}.svelte?t=1`, revision: s0.revision });
await issue.getByRole('button', { name: 'Open source' }).waitFor();
assert.deepEqual(await buttons(), ['Try again', 'Open source', 'Details'], 'nothing was changed since the page last worked');
await issue.getByRole('button', { name: 'Open source' }).click();
const source = win.getByRole('textbox', { name: `${heroDef.name} Svelte source, read only` });
await source.waitFor({ timeout: 10000 });
assert.equal(await source.getAttribute('aria-readonly'), 'true', 'a generated component opens read only');
await win.keyboard.press('Escape');
await win.locator('.modal').waitFor({ state: 'detached' });

step('an error with nothing to trace offers only what it did before, and the change it happened on does not clear it');
await bridge('runtimeError', { message: 'Something else went wrong', revision: s0.revision });
await eventually(async () => assert.match(await issue.innerText(), /Something on this page/));
await eventually(async () => assert.deepEqual(await buttons(), ['Try again', 'Details']));
await bridge('revisionApplied', { revision: s0.revision });
await win.waitForTimeout(400);
assert.equal(await issue.isVisible(), true, 'showing the same change again does not mend the page');
await bridge('revisionApplied', {});
await issue.waitFor({ state: 'detached' });

step('an error after two changes offers no Revert: which of them broke the page is unknown');
await settle();
await apply(keptProp, 'Kept edit', 'Keep this edit');
const second = await apply(brokenProp, 'Second edit', 'Another edit');
await bridge('runtimeError', { message: 'Two changes ago', revision: second.revision });
await eventually(async () => assert.deepEqual(await buttons(), ['Try again', 'Details']));
// Undo the second, and let the page work again with the first in place.
assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true);
await bridge('revisionApplied', {});
await issue.waitFor({ state: 'detached' });

step('an error after an edit offers to revert it, and Revert brings the page back without it, keeping the edit before');
await settle();
const r = await apply(brokenProp, 'Broken by this edit', 'Break the hero');
// The edit's error, as the page reports it, either side of the page's own word that it shows the edit.
await bridge('runtimeError', { message: 'Cannot read properties of undefined (reading "title")', stack: `at http://127.0.0.1:5173/src/lib/siteorigin/generated/${defKey}.svelte:4:1`, revision: r.revision });
await bridge('revisionApplied', { revision: r.revision });
const revert = issue.getByRole('button', { name: 'Revert “Break the hero”' });
await revert.waitFor({ timeout: 10000 });
assert.deepEqual(await buttons(), ['Revert “Break the hero”', 'Try again', 'Open source', 'Details']);
const sessionBefore = await (await frame()).evaluate(() => window.name);
await revert.click();
await issue.waitFor({ state: 'detached', timeout: 60000 });
const after = await snapshot();
const node = after.state.pages[home.id].nodes[heroNode.id];
assert.equal(node.props[brokenProp], brokenBefore, 'the edit is undone');
assert.equal(node.props[keptProp], 'Kept edit', 'the edit before it stays');
assert.equal(after.history.entries.find((e) => e.id === r.entryId)?.applied, false, 'its History step is undone');
await eventually(async () => assert.notEqual(await (await frame()).evaluate(() => window.name), sessionBefore, 'the preview loads again'), 30000);
await eventually(async () => assert.doesNotMatch(await (await frame()).locator('body').innerText(), /Broken by this edit/), 30000);

step('after an Undo, an error offers no Revert');
await settle();
await apply(brokenProp, 'Undo me', 'Undo me');
await bridge('revisionApplied', {});
await settle();
assert.equal((await win.evaluate(() => window.builder.project.undo())).ok, true);
const undone = await snapshot();
assert.equal(undone.history.canUndo, true, 'there is still a change to undo');
await bridge('runtimeError', { message: 'Still broken', revision: undone.revision });
await eventually(async () => assert.deepEqual(await buttons(), ['Try again', 'Details']), 8000);

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\npreview-error: passed');
