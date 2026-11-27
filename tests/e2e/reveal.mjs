// Editing a repeated item reveals it on the page: an FAQ question opened in the inspector opens and is outlined on
// the canvas, shows the answer as it is typed at phone and desktop widths with the caret kept in the field, and
// follows the question the inspector moves to. None of it is saved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, openInspector, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('reveal');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: false });
const dir = join(WORK, 'sites', 'harbour-lane-studio');
const read = (rel) => readFileSync(join(dir, rel), 'utf8');

step('open the FAQ on Contact from Layers');
await win.locator('.side-panel-view:not([hidden]) [data-page]', { hasText: 'Contact' }).first().click();
// The FAQ's questions: the header's menu button is a disclosure too.
const questions = frame.locator('.so-foundation-faq-list__root details');
await questions.first().waitFor({ state: 'attached', timeout: 30000 });
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('[role="tree"] .list-item', { hasText: 'FAQ' }).first().click();
await openInspector(win);
const list = win.locator('#dock-panel-inspect [data-list="items"]');
await list.waitFor();
const rows = list.locator('.list-editor-head button.title');
const opened = () => questions.evaluateAll((els) => els.map((d) => d.open));
const outlines = () => win.locator('.ov-revealed').count();
assert.deepEqual(await opened(), [false, false, false, false], 'every question starts closed, as visitors find it');
const contentOf = (els) => els.map((d) => [d.querySelector('summary').textContent.trim(), d.querySelector('p').textContent.trim()]);
const before = new Map(await questions.evaluateAll(contentOf));

step('opening a question in the inspector reveals it on the page');
await rows.nth(1).click();
await eventually(async () => assert.deepEqual(await opened(), [false, true, false, false], 'the second question opens on the page'));
await eventually(async () => assert.equal(await outlines(), 1, 'and is outlined'));

step('the answer shows as it is typed, at phone and desktop widths, with the caret kept in the field');
const answerField = list.locator('.list-editor-body:not([hidden]) textarea').first();
const answerOnPage = questions.nth(1).locator('p');
const typed = 'Yes. We work across the whole region, and we are happy to arrange remote consultations for early planning, site visits by appointment, and regular video calls while drawings are prepared.';
await answerField.click();
await win.keyboard.press(`${MOD}+a`);
await win.keyboard.type(typed);
await eventually(async () => assert.equal(await answerOnPage.innerText(), typed, 'the page shows the answer being typed'));
assert.ok(!read('src/routes/contact/+page.svelte').includes(typed), 'nothing is saved while typing');
const inField = () => win.evaluate(() => document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.closest('[data-list="items"]') !== null);
const tall = () => answerOnPage.evaluate((el) => el.getBoundingClientRect().height);
const atDesktop = await tall();
await win.getByRole('radio', { name: 'Phone', exact: true }).click();
await eventually(async () => assert.ok((await tall()) > atDesktop, 'the typed answer wraps onto more lines at phone width'));
assert.equal(await inField(), true, 'the caret stays in Answer after choosing Phone');
assert.equal(await answerOnPage.innerText(), typed, 'the typed answer still shows at phone width');
await win.keyboard.type(' Ask us.');
await eventually(async () => assert.equal(await answerOnPage.innerText(), `${typed} Ask us.`, 'typing carries on in the field'));
const atPhone = await tall();
await win.getByRole('radio', { name: 'Desktop', exact: true }).click();
await eventually(async () => assert.ok((await tall()) < atPhone, 'back at desktop width, the answer takes fewer lines'));
assert.equal(await inField(), true, 'the caret stays in Answer after choosing Desktop');

step('saving keeps the question open, and the page shows the saved answer');
await win.keyboard.press(`${MOD}+Enter`);
await eventually(() => assert.ok(read('src/routes/contact/+page.svelte').includes(`${typed} Ask us.`), 'the answer is saved'));
await eventually(async () => {
  assert.deepEqual(await opened(), [false, true, false, false], 'the question stays open after the page updates');
  assert.equal(await answerOnPage.innerText(), `${typed} Ask us.`, 'with the saved answer');
});

step('picking the revealed answer on the page keeps its question open, and shows its text as it is typed there');
// Every time the question closes on the page from here on is counted: the hand-overs below must never close it, even
// briefly. The save's update can still be on its way (the page showed the typed answer already) and render the FAQ
// afresh: the question is then a new element, so it is followed by its words wherever it is rendered, and the one the
// update took off the page, closed once it is gone, is not counted.
await questions.nth(1).evaluate((d) => {
  window.closes = 0;
  const question = d.querySelector('summary').textContent.trim();
  // Each record whose old value was set is one close, however soon it opened again.
  new MutationObserver((records) => {
    for (const r of records) if (r.oldValue !== null && r.target.isConnected && r.target.querySelector('summary')?.textContent.trim() === question) window.closes++;
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'], attributeOldValue: true });
});
// Dispatched on the answer itself: the scaled canvas throws off a pointer's aim at text this far down the page.
await answerOnPage.dispatchEvent('click', { altKey: true });
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Answer' }).waitFor();
await eventually(async () => assert.deepEqual(await opened(), [false, true, false, false], 'the question stays open under the pointer'));
assert.equal(await outlines(), 0, 'the selection marks the item, so it gets no second outline');
const partField = win.locator('#dock-panel-inspect textarea').first();
await partField.evaluate((el) => (el.focus(), el.setSelectionRange(el.value.length, el.value.length)));
await win.keyboard.type(' Really.');
await eventually(async () => assert.equal(await answerOnPage.innerText(), `${typed} Ask us. Really.`, 'the page shows the answer as it is typed in the part inspector too'));
await win.keyboard.press('Escape');
// Well inside the time typed text waits for a save that never comes: a cancel puts the saved answer back at once.
await eventually(async () => assert.equal(await answerOnPage.innerText(), `${typed} Ask us.`, 'Escape puts the saved answer back on the page'), 1500);
await win.keyboard.press('Escape');
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'FAQ' }).waitFor();
await eventually(async () => assert.equal(await rows.nth(1).getAttribute('aria-expanded'), 'true', 'back on the section, its list opens on that question'));
assert.deepEqual(await opened(), [false, true, false, false], 'and the question stays open on the page');
assert.equal(await questions.nth(1).evaluate(() => window.closes), 0, 'it never closed on the way from the list to the answer and back');

step('moving to another question follows it, a moved question stays revealed, and closing it leaves the page as visitors find it');
const title = (await rows.nth(1).innerText()).trim();
await rows.nth(2).click();
await eventually(async () => assert.deepEqual(await opened(), [false, false, true, false], 'the third question opens and the second closes again'));
await rows.nth(1).click();
await eventually(async () => assert.deepEqual(await opened(), [false, true, false, false], 'the second question opens again'));
await list.getByRole('button', { name: `Move ${title} down` }).click();
await eventually(async () => assert.deepEqual(await opened(), [false, false, true, false], 'the moved question stays open in its new place'));
assert.equal((await questions.nth(2).locator('summary').innerText()).trim(), title, 'it is the same question, followed by its id');
await eventually(async () => assert.equal(await outlines(), 1, 'and still outlined'));
await rows.nth(2).click();
await eventually(async () => assert.deepEqual(await opened(), [false, false, false, false], 'closing the row closes the question it opened'));
await eventually(async () => assert.equal(await outlines(), 0, 'and its outline goes'));
const after = new Map(await questions.evaluateAll(contentOf));
for (const [question, answer] of before) assert.equal(after.get(question), question === title ? `${typed} Ask us.` : answer, `${question} keeps its content, apart from the answer saved`);
const saved = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const page = Object.values(s.state.pages).find((p) => p.title === 'Contact');
  const faq = page.rootIds.map((id) => page.nodes[id]).find((n) => s.state.components[n.definitionId]?.componentId === 'faq.list');
  return faq.props.items.map((i) => Object.keys(i).sort().join(','));
});
assert.deepEqual([...new Set(saved)], ['answer,id,question'], 'the saved questions hold only their content');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nreveal: passed');
