// Previous and Next item on the selection chip (#552): a Services card's title picked on the page steps to the same
// title in the next card and back, with the pointer and from the keyboard, the chip and the Inspector saying which
// card it is, the page scrolled to it, and the cards themselves never changed.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS, cleanup } = scratch('item-step');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Step Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });

const TITLES = ['Planning & layout', 'Materials & color', 'Project delivery'];
const chip = win.locator('.ov-chip:not(.editing)');
const prev = chip.getByRole('button', { name: 'Previous item', exact: true });
const next = chip.getByRole('button', { name: 'Next item', exact: true });
const position = () => chip.getByTestId('chip-item-pos').innerText();
const inspectorPos = async () => {
  const pos = win.locator('#dock-panel-inspect .insp-kind-pos').first();
  assert.ok(await pos.isVisible(), 'the Inspector shows the item position');
  return pos.innerText();
};
const title = (i) => frame.getByText(TITLES[i], { exact: true }).first();
const cards = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const grid = page.rootIds.map((id) => page.nodes[id]).find((n) => s.state.components[n.definitionId]?.componentId === 'features.grid');
    return { items: grid.props.items, revision: s.revision };
  });

/** The selection's outline sits on card `i`'s title (or `part(i)`): the same part, in that card. */
async function selectedIs(i, { part = title, inspector = true } = {}) {
  await eventually(async () => {
    const box = await win.locator('.ov-selected').first().boundingBox();
    const want = await part(i).boundingBox();
    assert.ok(box && want, 'the selection and the part are both on screen');
    const mid = (b) => [b.x + b.width / 2, b.y + b.height / 2];
    const [[bx, by], [wx, wy]] = [mid(box), mid(want)];
    assert.ok(Math.abs(bx - wx) < 12 && Math.abs(by - wy) < 12, `the outline is on ${TITLES[i]} (outline at ${bx},${by}; title at ${wx},${wy})`);
  });
  await eventually(async () => assert.equal(await position(), `${i + 1} of 3`, 'the chip says which card'));
  if (inspector) await eventually(async () => assert.match(await inspectorPos(), new RegExp(`${i + 1} of 3`), 'and so does the Inspector'));
}

step('pick the first card’s title on the page');
// The phone preview stacks the cards, so one card can be scrolled out of sight while another is selected.
await win.getByRole('radio', { name: 'Phone', exact: true }).first().click();
await win.waitForTimeout(800);
const before = await cards();
await title(0).scrollIntoViewIfNeeded();
// Alt-click picks the title itself, not the card or the section around it.
await title(0).click({ modifiers: ['Alt'] });
await chip.waitFor();
await eventually(async () => assert.match(await chip.locator('.label').innerText(), /title/i, 'the card title is selected'));
// The Inspector is opened so its item position is read where a person sees it.
await openInspector(win);
await selectedIs(0);
assert.equal(await prev.getAttribute('aria-disabled'), 'true', 'the first card has no Previous');
assert.equal(await next.getAttribute('aria-disabled'), null, 'but it has a Next');

step('Next selects the title in the next card');
await next.click();
await selectedIs(1);
assert.equal(await prev.getAttribute('aria-disabled'), null, 'the second card has a Previous');
await chip.screenshot({ path: join(SHOTS, 'item-step-chip.png') });

step('from the keyboard: Next on the last card stays put, and the arrow keys reach Previous');
await next.focus();
await win.keyboard.press('Enter');
await selectedIs(2);
// The pressed control keeps focus and the toolbar's one Tab stop, now marked disabled but still focusable.
await eventually(async () => assert.equal(await next.evaluate((el) => el === document.activeElement), true, 'Next keeps focus'));
assert.equal(await next.getAttribute('aria-disabled'), 'true', 'the last card has no Next');
assert.equal(await next.getAttribute('tabindex'), '0', 'Next holds the Tab stop');
assert.equal(await chip.locator('button[tabindex="0"]').count(), 1, 'the chip is one Tab stop');
await win.keyboard.press('Enter');
await win.waitForTimeout(400);
assert.equal(await position(), '3 of 3', 'Next never wraps to the first card');
await win.keyboard.press('ArrowLeft');
await eventually(async () => assert.equal(await prev.evaluate((el) => el === document.activeElement), true, 'ArrowLeft moves to Previous'));
await win.keyboard.press('Enter');
await selectedIs(1);

step('Previous scrolls a card out of sight back into view, with the Inspector closed');
// The Inspector reveals its item on the page too: closed, only the selection's own scroll can bring the card back.
await win.getByRole('button', { name: 'Right panel', exact: true }).click();
await eventually(async () => assert.equal(await chip.getByRole('button', { name: 'Edit', exact: true }).count(), 1, 'the Inspector is closed: the chip offers the way back'));
await frame.locator('html').evaluate(() => window.scrollTo(0, 0));
await eventually(async () => {
  const r = await title(0).evaluate((el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, h: innerHeight }));
  assert.ok(r.bottom <= 0 || r.top >= r.h, `the first card is wholly out of sight (${JSON.stringify(r)})`);
});
await prev.click();
await eventually(async () => {
  const r = await title(0).evaluate((el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, h: innerHeight }));
  assert.ok(r.top >= 0 && r.bottom <= r.h, `the first card is scrolled into view (${JSON.stringify(r)})`);
});
await selectedIs(0, { inspector: false });
assert.match((await win.locator('[role="status"]').allInnerTexts()).join(' '), /1 of 3/, 'the new position is announced');
await win.getByRole('button', { name: 'Right panel', exact: true }).click();

step('stepping only moved the selection');
const after = await cards();
assert.deepEqual(after.items, before.items, 'the cards are as they were');
assert.equal(after.revision, before.revision, 'nothing was edited');

step('a part some cards hide is stepped over');
// A card's link shows only when it has a label: give the first and last cards one, so the middle card hides it.
const where = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = s.state.pages[s.state.site.homePageId];
  return { pageId: page.id, gridId: page.rootIds.find((id) => s.state.components[page.nodes[id].definitionId]?.componentId === 'features.grid') };
});
const label = async (i, value) => {
  const operations = [{ type: 'instance.setProp', owner: { kind: 'page', id: where.pageId }, nodeId: where.gridId, prop: 'items', itemId: before.items[i].id, field: 'linkLabel', value }];
  const r = await win.evaluate((operations) => window.builder.project.apply({ operations, label: 'Link label' }), operations);
  assert.equal(r.ok, true, r.error?.message);
};
await label(0, 'Plan with us');
await label(2, 'Talk to the delivery team');
const link = (i) => frame.getByText(['Plan with us', null, 'Talk to the delivery team'][i], { exact: true }).first();
await eventually(async () => assert.equal(await link(2).count(), 1, 'the last card shows its link'));
await link(0).scrollIntoViewIfNeeded();
await link(0).click({ modifiers: ['Alt'] });
await eventually(async () => assert.match(await chip.locator('.label').innerText(), /link/i, 'the first card’s link is selected'));
await selectedIs(0, { part: link });
await next.click();
await selectedIs(2, { part: link });
await prev.click();
await selectedIs(0, { part: link });

step('Next is marked unavailable once no later card shows the part');
await label(2, '');
await eventually(async () => assert.equal(await link(2).count(), 0, 'the last card hides its link'));
await next.click();
await eventually(async () => assert.equal(await next.getAttribute('aria-disabled'), 'true', 'nothing to step to'));
assert.equal(await position(), '1 of 3', 'the selection stayed on the first card');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nitem-step: ok');
