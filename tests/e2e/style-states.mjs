// Inspector state switcher (#350): a Services card's hover background is edited with the pointer in the dock and
// shown on the canvas while Hover is chosen, at rest again in Default, in Preview and on another selection, and reset
// cleanly, one state or all of them. Nothing of the editor's forced state reaches the site's files.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('style-states');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'State Studio', parentDir: join(WORK, 'sites'), starter: 'business' });
const dir = join(WORK, 'sites', 'state-studio');
const siteCss = () => readFileSync(join(dir, 'src/lib/siteorigin/styles/site.css'), 'utf8');
const pageSource = () => readFileSync(join(dir, 'src/routes/+page.svelte'), 'utf8');
const cardStyles = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const grid = page.rootIds.map((id) => page.nodes[id]).find((n) => s.state.components[n.definitionId]?.componentId === 'features.grid');
    return grid.overrides?.card ?? {};
  });

const RED = 'rgb(255, 0, 0)';
const card = frame.locator('li', { hasText: 'Planning & layout' }).first();
const other = frame.locator('li', { hasText: 'Materials & color' }).first();
const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
const forcedOnPage = () => frame.locator('[data-so-force-state]').count();
const states = win.getByRole('radiogroup', { name: 'State', exact: true });
const stateRadio = (name) => states.getByRole('radio', { name: new RegExp(`^${name}`) });
const dot = (name) => stateRadio(name).locator('.style-scope-dot');
const background = win.locator('.style-row[data-prop="background"]').first();

/**
 * Take the pointer off the page, as an author does who goes on to the Inspector: across the section's heading first,
 * since a hidden test window keeps the last element under the pointer hovered when the pointer leaves the frame.
 */
async function pointerToDock() {
  await frame.locator('h2', { hasText: 'Everything your project' }).hover();
  await win.mouse.move(20, 450, { steps: 4 });
  await eventually(async () => assert.equal(await card.evaluate((el) => el.matches(':hover')), false, 'the pointer is off the card'));
}

/** Give the card a background in the state being edited, typed as a custom colour. */
async function setBackground(color) {
  await background.locator('select').first().selectOption('custom');
  const input = win.getByRole('textbox', { name: 'Background value' });
  await input.fill(color);
  await input.press('Enter');
}

step('select a Services card from the canvas');
// The phone preview is shown at full scale, so a click lands where Playwright aims it.
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await win.waitForTimeout(800);
await card.scrollIntoViewIfNeeded();
// Alt-click picks the element itself, not its section; its padding is the card's own.
await card.click({ modifiers: ['Alt'], position: { x: 6, y: 6 } });
await openInspector(win);
await background.waitFor({ timeout: 15000 });
await pointerToDock();
await eventually(async () => assert.equal(await stateRadio('Default').getAttribute('aria-checked'), 'true', 'the card is edited at rest'));

step('a resting background of its own, which no state reset may touch');
await setBackground('#eeeeee');
const resting = 'rgb(238, 238, 238)';
await eventually(async () => assert.equal(await bg(card), resting, 'the cards show their resting background'), 30000);
const RESTING = { background: '#eeeeee' };

assert.equal(await win.locator('.style-row[data-prop="paddingBlock"]').count(), 1, 'padding is offered at rest');

step('choose Hover and give the card a red hover background, the pointer staying in the dock');
await stateRadio('Hover').click();
await eventually(async () => assert.equal(await card.getAttribute('data-so-force-state'), 'hover', 'the canvas holds the selected card hovered'));
// Only what a state can change is offered.
assert.equal(await win.locator('.style-row[data-prop="paddingBlock"]').count(), 0, 'no padding row in a state');
await setBackground('#ff0000');
await eventually(async () => assert.equal(await bg(card), RED, 'the canvas shows the selected card hovered'), 30000);
assert.equal(await bg(other), resting, 'the other cards stay at rest');
await eventually(async () => assert.equal(await dot('Hover').count(), 1, 'Hover is marked as holding changes'));
assert.deepEqual(await cardStyles(), { base: RESTING, 'base:hover': { background: '#ff0000' } });
await win.screenshot({ path: join(OUT, 'style-states-01-hover.png') });

step('the site gets a plain hover rule; nothing of the forced state');
await eventually(() => assert.match(siteCss(), /:where\(:hover\)\s*\{[^}]*#ff0000/, 'the hover rule is generated'), 15000);
assert.doesNotMatch(siteCss(), /so-force-state/);
assert.doesNotMatch(pageSource(), /so-force-state/);

step('Default shows the card at rest, Hover shows it hovered again');
await stateRadio('Default').click();
await eventually(async () => assert.equal(await bg(card), resting, 'at rest in Default'));
assert.equal(await forcedOnPage(), 0);
await stateRadio('Hover').click();
await eventually(async () => assert.equal(await bg(card), RED, 'hovered again'));

step('Preview shows the page as visitors find it');
await win.locator('.toolbar').getByRole('button', { name: 'Preview', exact: true }).click();
await eventually(async () => assert.equal(await forcedOnPage(), 0, 'nothing is held in a state in Preview'));
assert.equal(await bg(card), resting);
await win.locator('.toolbar').getByRole('button', { name: 'Edit', exact: true }).click();
// Preview let go of the selection, and with it the state: back in Edit, the card is edited at rest.
await eventually(async () => assert.equal(await stateRadio('Default').getAttribute('aria-checked'), 'true', 'Default is chosen again'), 15000);
assert.equal(await forcedOnPage(), 0);
assert.equal(await bg(card), resting);
await stateRadio('Hover').click();
await eventually(async () => assert.equal(await bg(card), RED, 'hovered again in Edit'), 15000);

step('reset the hover change: the card and the mark go back to rest');
await win.getByRole('button', { name: /^Reset the hover change for All sizes/ }).click();
await eventually(async () => assert.equal(await bg(card), resting, 'nothing shows on hover any more'), 30000);
await eventually(async () => assert.equal(await dot('Hover').count(), 0, 'Hover holds no changes'));
assert.deepEqual(await cardStyles(), { base: RESTING }, 'only the hover change is gone');
await eventually(() => assert.doesNotMatch(siteCss(), /#ff0000/, 'the hover rule is gone'), 15000);

step('a hover and a focus background, both reset at once');
await setBackground('#ff0000');
await eventually(async () => assert.equal(await bg(card), RED));
await stateRadio('Focus').click();
await eventually(async () => assert.equal(await card.getAttribute('data-so-force-state'), 'focus', 'the canvas holds the card focused'));
// Focus shows the resting background through until it has its own.
await eventually(async () => assert.equal(await bg(card), resting));
await setBackground('#0000ff');
await eventually(async () => assert.equal(await bg(card), 'rgb(0, 0, 255)', 'the canvas shows the card focused'), 30000);
await eventually(async () => assert.equal(await dot('Focus').count(), 1));
await win.screenshot({ path: join(OUT, 'style-states-02-focus.png') });
await win.getByRole('button', { name: 'Reset all states', exact: true }).click();
await eventually(async () => assert.deepEqual(await cardStyles(), { base: RESTING }, 'every state change is gone, the resting one stays'), 15000);
await eventually(async () => assert.equal(await bg(card), resting));
assert.equal(await dot('Hover').count(), 0);
assert.equal(await dot('Focus').count(), 0);

step('selecting another card edits it at rest');
await stateRadio('Focus').click();
await eventually(async () => assert.equal(await card.getAttribute('data-so-force-state'), 'focus', 'the card is held focused before the selection moves'));
await other.scrollIntoViewIfNeeded();
await other.click({ modifiers: ['Alt'], position: { x: 6, y: 6 } });
await eventually(async () => assert.equal(await stateRadio('Default').getAttribute('aria-checked'), 'true', 'back to Default'));
await eventually(async () => assert.equal(await forcedOnPage(), 0, 'nothing is held in a state'));

assert.deepEqual(errors, [], 'no page errors');
await app.close();
cleanup();
console.log('\nstyle-states: ok');
