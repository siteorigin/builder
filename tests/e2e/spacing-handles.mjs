// Spacing handles on the canvas (#384): the Split hero's vertical padding dragged on the page snaps to a spacing
// style and shows as it moves, is saved as one edit on release and taken back by one Undo; Escape mid-drag puts
// the page back and saves nothing; and a drag while Phone is edited (and previewed) changes only Phone, in exact
// pixels with Alt held.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('spacing-handles');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Spacing Studio', parentDir: join(WORK, 'sites'), starter: 'business' });

const snap = () => win.evaluate(() => window.builder.project.snapshot());
const heroNode = (s) => {
  const page = s.state.pages[s.state.site.homePageId];
  return page.rootIds.map((id) => page.nodes[id]).find((n) => s.state.components[n.definitionId]?.componentId === 'hero.split');
};
const applied = (s) => s.history.entries.filter((e) => e.applied).map((e) => e.id);
/** The snapshot once a save has landed: the project's state shows a change a moment before its history does. */
const landed = (after, check) =>
  eventually(async () => {
    const s = await snap();
    assert.ok(s.revision > after.revision, 'the save has landed');
    check(s);
    return s;
  }, 15000);
const hero = frame.locator('section', { has: frame.locator('h1', { hasText: 'Calm, considered spaces' }) }).first();
const padding = () => hero.evaluate((el) => [Number.parseFloat(getComputedStyle(el).paddingTop), Number.parseFloat(getComputedStyle(el).paddingBottom)]);
const previews = () => frame.locator('style[data-so-spacing]').count();
const handle = win.getByTestId('spacing-padding-top');
const hud = win.getByTestId('spacing-hud');
/** Screen pixels per page pixel: the frame is drawn scaled to fit the canvas. */
const zoom = async () => {
  const box = await win.locator('.frame-box iframe').boundingBox();
  const inner = await frame.locator('html').evaluate(() => innerWidth);
  return box.width / inner;
};
/** Press the top padding handle and move it so the padding would be `to` page pixels, in a few steps (or one). */
async function dragTopTo(to, steps = 4) {
  const b = await handle.boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  const [from] = await padding();
  const target = y + (to - from) * (await zoom());
  await win.mouse.move(x, y);
  await win.mouse.down();
  if (steps > 1) await win.mouse.move(x, (y + target) / 2, { steps });
  await win.mouse.move(x, target, { steps });
}

step('select the Split hero: its vertical padding gets handles on the page');
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.list-item', { hasText: 'Split hero' }).first().click();
await handle.waitFor();
const handles = () => win.locator('[data-testid^="spacing-"]:not([data-testid="spacing-hud"])').evaluateAll((els) => els.map((e) => e.dataset.testid).sort());
// The section offers Vertical padding only: no side padding or margin handles.
assert.deepEqual(await handles(), ['spacing-padding-bottom', 'spacing-padding-top']);
const before = await snap();
const original = heroNode(before).overrides ?? {};
const start = await padding();
assert.ok(start[0] > 40, `the hero starts with room above its content: ${start}`);

step('drag the top padding toward 25px: it snaps to Large (24px) on both sides as it moves, and nothing is saved yet');
await dragTopTo(25);
await eventually(async () => assert.match(await hud.innerText(), /Vertical padding\s*Large · 24px/));
await eventually(async () => assert.deepEqual(await padding(), [24, 24], 'the page shows the snapped padding while dragging'));
const held = await snap();
assert.equal(held.revision, before.revision, 'nothing is saved mid-drag');
assert.deepEqual(applied(held), applied(before), 'no history entry mid-drag');
await win.screenshot({ path: join(OUT, 'spacing-drag.png') });

step('release: one edit saves the spacing style for all sizes, and the page keeps showing it');
await win.mouse.up();
const saved = await landed(before, (s) => assert.deepEqual(heroNode(s).overrides?.root?.base?.paddingBlock, { token: 'space.lg' }));
assert.equal(applied(saved).length, applied(before).length + 1, 'one history entry');
assert.equal(saved.history.undoLabel, 'Set vertical padding');
assert.equal(saved.revision, before.revision + 1, 'one revision');
assert.deepEqual(heroNode(saved).overrides.root, { ...original.root, base: { ...original.root?.base, paddingBlock: { token: 'space.lg' } } }, 'only the padding changed');
// The preview rule goes once the site's own stylesheet shows the same padding.
await eventually(async () => assert.equal(await previews(), 0, 'the drag preview is handed over to the saved style'), 15000);
assert.deepEqual(await padding(), [24, 24], 'the saved style shows on its own');
assert.equal(await hud.count(), 0, 'the HUD goes with the drag');

step('a release before the page has measured its spacing styles saves where it let go');
// The page's answers are held back in the editor for a moment, and the hero is picked again so its handles start
// with no measurements: the release always comes first.
await win.evaluate(() => {
  const held = new WeakSet();
  window.addEventListener(
    'message',
    (e) => {
      if (e.data?.type !== 'spaceMeasured' || held.has(e.data)) return;
      e.stopImmediatePropagation();
      held.add(e.data);
      setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: e.data, origin: e.origin, source: e.source })), 1200);
    },
    true
  );
});
await win.locator('.list-item', { hasText: 'Logo strip' }).first().click();
await eventually(async () => assert.match(await win.locator('.ov-chip').first().innerText(), /Logo strip/));
await win.locator('.list-item', { hasText: 'Split hero' }).first().click();
await eventually(async () => assert.match(await win.locator('.ov-chip').first().innerText(), /Split hero/));
await handle.waitFor();
await dragTopTo(47, 1);
await win.mouse.up();
const quick = await landed(saved, (s) => assert.deepEqual(heroNode(s).overrides?.root?.base?.paddingBlock, { token: 'space.2xl' }));
assert.equal(applied(quick).length, applied(saved).length + 1, 'one more history entry');
assert.deepEqual(heroNode(quick).overrides.root, { ...heroNode(saved).overrides.root, base: { ...heroNode(saved).overrides.root.base, paddingBlock: { token: 'space.2xl' } } }, 'only the padding changed');
await eventually(async () => assert.equal(await previews(), 0), 15000);
assert.deepEqual(await padding(), [48, 48]);
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.deepEqual(heroNode(await snap()).overrides?.root?.base?.paddingBlock, { token: 'space.lg' }));
await eventually(async () => assert.deepEqual(await padding(), [24, 24]), 15000);

step('Escape mid-drag puts the page back and saves nothing');
const beforeEscape = await snap();
await dragTopTo(70);
await eventually(async () => assert.match(await hud.innerText(), /3XL · 72px/));
await eventually(async () => assert.deepEqual(await padding(), [72, 72]));
await win.keyboard.press('Escape');
// Still holding the mouse: Escape alone ends the drag.
await eventually(async () => assert.deepEqual(await padding(), [24, 24], 'the padding is back where it was'));
assert.equal(await previews(), 0, 'no preview is left on the page');
assert.equal(await hud.count(), 0, 'the HUD goes with the drag');
await win.mouse.up();
await win.waitForTimeout(500);
const escaped = await snap();
assert.equal(escaped.revision, beforeEscape.revision, 'nothing is saved');
assert.deepEqual(applied(escaped), applied(beforeEscape), 'no history entry');
assert.deepEqual(await padding(), [24, 24], 'releasing after Escape saves nothing either');
assert.match(await win.locator('.ov-chip').first().innerText(), /Split hero/, 'Escape ended the drag, not the selection');

step('one Undo takes the drag back');
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.deepEqual(heroNode(await snap()).overrides ?? {}, original, 'the overrides are as they were'));
assert.deepEqual(applied(await snap()), applied(before), 'the history is where it started');
await eventually(async () => assert.deepEqual(await padding(), start, 'the page shows its original padding'), 15000);

step('editing Phone while the canvas shows Desktop: no handles, since the drag would not show');
await win.getByRole('button', { name: 'Style', exact: true }).last().click();
await win.getByRole('radiogroup', { name: 'Edit styles for' }).getByRole('radio', { name: 'Phone', exact: true }).click();
await eventually(async () => assert.equal(await win.locator('[data-testid^="spacing-"]').count(), 0));

step('previewing Phone: an Alt drag writes exact pixels to the Phone override only');
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await handle.waitFor({ timeout: 15000 });
await eventually(async () => assert.equal(await frame.locator('html').evaluate(() => innerWidth), 390));
const phoneStart = await padding();
await win.keyboard.down('Alt');
await dragTopTo(37);
await eventually(async () => assert.match(await hud.innerText(), /Vertical padding\s*37px/));
await eventually(async () => assert.deepEqual(await padding(), [37, 37]));
await win.mouse.up();
await win.keyboard.up('Alt');
await eventually(async () => assert.equal(heroNode(await snap()).overrides?.root?.phone?.paddingBlock, '37px'), 15000);
const phoneSaved = heroNode(await snap()).overrides.root;
assert.equal(phoneSaved.base?.paddingBlock, original.root?.base?.paddingBlock, 'All sizes is left alone');
assert.equal(phoneSaved.desktop?.paddingBlock, original.root?.desktop?.paddingBlock, 'Desktop is left alone');
await eventually(async () => assert.equal(await previews(), 0), 15000);
assert.deepEqual(await padding(), [37, 37], 'the phone padding shows');
assert.notDeepEqual(phoneStart, [37, 37], 'it was another size before');
await win.screenshot({ path: join(OUT, 'spacing-phone.png') });
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
await eventually(async () => assert.deepEqual(await padding(), start, 'desktop keeps its padding'), 15000);

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nspacing-handles: ok');
