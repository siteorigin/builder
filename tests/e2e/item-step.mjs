// Previous and Next item on the selection chip (#552): a Services card's title picked on the page steps to the same
// title in the next card and back, with the pointer and from the keyboard, the chip and the Inspector saying which
// card it is, the page scrolled to it, and the cards themselves never changed.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('item-step');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Step Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });

const TITLES = ['Planning & layout', 'Materials & colour', 'Project delivery'];
const chip = win.locator('.ov-chip:not(.editing)');
const prev = chip.getByRole('button', { name: 'Previous item', exact: true });
const next = chip.getByRole('button', { name: 'Next item', exact: true });
const position = () => chip.getByTestId('chip-item-pos').innerText();
const inspectorPos = () => win.locator('#dock-panel-inspect .insp-kind-pos').first().innerText();
const title = (i) => frame.getByText(TITLES[i], { exact: true }).first();
const cards = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const grid = page.rootIds.map((id) => page.nodes[id]).find((n) => s.state.components[n.definitionId]?.componentId === 'features.grid');
    return { items: grid.props.items, revision: s.revision };
  });

/** The selection's outline sits on card `i`'s title: the same part, in that card. */
async function selectedIs(i) {
  await eventually(async () => {
    const box = await win.locator('.ov-selected').first().boundingBox();
    const want = await title(i).boundingBox();
    assert.ok(box && want, 'the selection and the title are both on screen');
    const mid = (b) => [b.x + b.width / 2, b.y + b.height / 2];
    const [[bx, by], [wx, wy]] = [mid(box), mid(want)];
    assert.ok(Math.abs(bx - wx) < 12 && Math.abs(by - wy) < 12, `the outline is on ${TITLES[i]} (outline at ${bx},${by}; title at ${wx},${wy})`);
  });
  await eventually(async () => assert.equal(await position(), `${i + 1} of 3`, 'the chip says which card'));
  await eventually(async () => assert.match(await inspectorPos(), new RegExp(`${i + 1} of 3`), 'and so does the Inspector'));
}

step('pick the first card’s title on the page');
// The phone preview stacks the cards, so one card can be scrolled out of sight while another is selected.
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await win.waitForTimeout(800);
const before = await cards();
await title(0).scrollIntoViewIfNeeded();
await title(0).dispatchEvent('click');
await chip.waitFor();
await selectedIs(0);
assert.equal(await prev.getAttribute('aria-disabled'), 'true', 'the first card has no Previous');
assert.equal(await next.getAttribute('aria-disabled'), null, 'but it has a Next');

step('Next selects the title in the next card');
await next.click();
await selectedIs(1);
assert.equal(await prev.getAttribute('aria-disabled'), null, 'the second card has a Previous');

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

step('Previous scrolls a card out of sight back into view');
await frame.locator('html').evaluate(() => window.scrollTo(0, 0));
await eventually(async () => {
  const b = await title(0).evaluate((el) => el.getBoundingClientRect().bottom);
  const h = await title(0).evaluate(() => innerHeight);
  assert.ok(b < 0 || b > h, 'the first card is out of sight');
});
await prev.click();
await eventually(async () => {
  const r = await title(0).evaluate((el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, h: innerHeight }));
  assert.ok(r.top >= 0 && r.bottom <= r.h, `the first card is scrolled into view (${JSON.stringify(r)})`);
});
await selectedIs(0);

step('stepping only moved the selection');
const after = await cards();
assert.deepEqual(after.items, before.items, 'the cards are as they were');
assert.equal(after.revision, before.revision, 'nothing was edited');

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nitem-step: ok');
