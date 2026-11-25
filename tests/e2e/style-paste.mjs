// Copy style and Paste style (#165): the Split hero's vertical padding, 72px at all sizes and 16px on phones, pasted
// onto the existing Content with image section without its text, link or photo, then taken back with one Undo.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('style-paste');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Paste Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const frame = win.frameLocator('.frame-box iframe');

const home = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const find = (componentId) => page.rootIds.map((id) => page.nodes[id]).find((n) => s.state.components[n.definitionId]?.componentId === componentId);
    return { hero: find('hero.split'), media: find('content.media'), sections: page.rootIds.length };
  });
const { hero, media: before, sections } = await home();

step('give the Split hero 72px vertical padding at all sizes and 16px on phones; Content with image has 96px on desktops');
const set = (scope, property, value, nodeId = hero.id) => ({ type: 'node.setStyle', owner: { kind: 'page', id: '' }, nodeId, partId: 'root', scope, property, value });
const applied = await win.evaluate(async (ops) => {
  const s = await window.builder.project.snapshot();
  return window.builder.project.apply({ operations: ops.map((o) => ({ ...o, owner: { kind: 'page', id: s.state.site.homePageId } })) }, { label: 'Hero padding' });
}, [set('base', 'paddingBlock', '72px'), set('phone', 'paddingBlock', '16px'), set('base', 'minHeight', '70vh'), set('desktop', 'paddingBlock', '96px', before.id)]);
assert.ok(applied.ok, `the hero padding is set: ${JSON.stringify(applied.error)}`);

// A section in the preview, found by its own heading. The preview reloads its styles after each edit.
const sectionWith = (tag, text) => frame.locator('section', { has: frame.locator(tag, { hasText: text }) }).first();
const studio = sectionWith('h2', 'Good design starts with listening');
const paddingOf = (loc) => loc.evaluate((el) => [getComputedStyle(el).paddingTop, getComputedStyle(el).paddingBottom]);
const padding = () => paddingOf(studio);
const width = (name) => win.getByRole('button', { name, exact: true }).first().click();
await eventually(async () => assert.deepEqual(await paddingOf(sectionWith('h1', 'Calm, considered spaces')), ['72px', '72px'], 'the hero shows its padding'), 30000);
await eventually(async () => assert.deepEqual(await padding(), ['96px', '96px'], 'the section starts with its own desktop padding'), 30000);
await width('Phone');
const phoneOriginal = await eventually(padding, 10000);
assert.notDeepEqual(phoneOriginal, ['16px', '16px'], 'the section starts with its own phone padding');
await width('Desktop');

step('copy the hero’s style from its actions menu');
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.list-item', { hasText: 'Split hero' }).first().click();
await openInspector(win);
await win.getByRole('button', { name: /^More actions for / }).click();
await win.getByRole('menuitem', { name: 'Copy style' }).click();
await win.locator('.toast', { hasText: 'Copied the style of Split hero' }).waitFor();

step('paste it onto Content with image from its Layers menu');
await win.locator('.list-item', { hasText: 'Content with image' }).first().click({ button: 'right' });
await win.getByRole('menuitem', { name: /Paste style…/ }).click();
const dialog = win.getByRole('dialog', { name: 'Paste style' });
await dialog.waitFor();
const changes = dialog.getByRole('region', { name: 'Changes' });
await eventually(async () => {
  const text = await changes.innerText();
  assert.match(text, /Vertical padding/);
  assert.match(text, /All sizes\s*not set\s*becomes\s*72px/);
  assert.match(text, /Phone\s*not set\s*becomes\s*16px/);
  // Its own desktop padding would win over the pasted All sizes value, so Every size removes it.
  assert.match(text, /Desktop\s*96px\s*becomes\s*cleared, uses All sizes/);
});
// The hero's minimum height has no control on this kind of section, and the dialog says so.
assert.match(await dialog.getByRole('region', { name: 'Not pasted' }).innerText(), /Min height[\s\S]*doesn’t offer min height/);
await dialog.getByLabel('Sizes').selectOption('phone');
await eventually(async () => assert.doesNotMatch(await changes.innerText(), /^All sizes$/m, 'Phone only leaves All sizes alone'));
await dialog.getByLabel('Sizes').selectOption('every');
await win.waitForTimeout(400);
await win.screenshot({ path: join(OUT, 'style-paste-review.png') });
await dialog.getByRole('button', { name: 'Paste style', exact: true }).click();
await dialog.waitFor({ state: 'detached' });

step('the section has the hero’s padding at desktop and on phones, and keeps its content');
await width('Desktop');
await eventually(async () => assert.deepEqual(await padding(), ['72px', '72px'], 'desktop padding: the pasted All sizes value, its own 96px removed'), 30000);
await width('Phone');
await eventually(async () => assert.deepEqual(await padding(), ['16px', '16px'], 'phone padding'), 30000);
const after = await home();
assert.deepEqual(after.media.overrides, { root: { base: { paddingBlock: '72px' }, phone: { paddingBlock: '16px' } } }, 'only the padding is pasted');
assert.deepEqual(after.media.props, before.props, 'its text, link and photo are its own');
assert.deepEqual(after.media.variants, before.variants, 'its design options are its own');
assert.equal(after.sections, sections, 'no section is added');
await win.screenshot({ path: join(OUT, 'style-paste-phone.png') });

step('one Undo takes the whole paste back');
await win.locator('[aria-label^="Undo"]').first().click();
await width('Desktop');
await eventually(async () => assert.deepEqual(await padding(), ['96px', '96px'], 'its own desktop padding is back'), 30000);
const undone = await home();
assert.deepEqual(undone.media.overrides, { root: { desktop: { paddingBlock: '96px' } } }, 'it has only its own override again');
assert.deepEqual(undone.hero.overrides, { root: { base: { paddingBlock: '72px', minHeight: '70vh' }, phone: { paddingBlock: '16px' } } }, 'the hero keeps its own');

step('paste Phone only from the section’s own actions menu');
await win.locator('.list-item', { hasText: 'Content with image' }).first().click();
await win.getByRole('button', { name: 'More actions for Content with image' }).click();
await win.getByRole('menuitem', { name: /Paste style…/ }).click();
await dialog.waitFor();
await dialog.getByLabel('Sizes').selectOption('phone');
await eventually(async () => {
  const text = await changes.innerText();
  assert.match(text, /Phone\s*not set\s*becomes\s*16px/);
  assert.doesNotMatch(text, /^(All sizes|Desktop)$/m, 'nothing but Phone changes');
});
await dialog.getByRole('button', { name: 'Paste style', exact: true }).click();
await dialog.waitFor({ state: 'detached' });
await width('Phone');
await eventually(async () => assert.deepEqual(await padding(), ['16px', '16px'], 'phone padding'), 30000);
await width('Desktop');
await eventually(async () => assert.deepEqual(await padding(), ['96px', '96px'], 'desktop keeps its own padding'), 30000);
assert.deepEqual((await home()).media.overrides, { root: { phone: { paddingBlock: '16px' }, desktop: { paddingBlock: '96px' } } }, 'only the phone value is pasted');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nstyle-paste: ok');
