// Editing flows against the real app: inline text, insert, responsive override, undo, reorder, export.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('flows');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const dir = join(WORK, 'sites', 'harbour-lane-studio');
const read = (rel) => readFileSync(join(dir, rel), 'utf8');
const projectSnapshot = () => win.evaluate(() => window.builder.project.snapshot());
await win.waitForTimeout(1500);
await win.screenshot({ path: join(OUT, '10-images.png') });

step('inline text edit');
const h1 = frame.locator('h1').first();
await h1.click();
await win.waitForTimeout(300);
await h1.dblclick();
await win.waitForTimeout(300);
// A double-click starts at the word clicked; Select All takes the whole heading.
await win.keyboard.press(`${MOD}+a`);
await win.keyboard.type('Rooms that work beautifully');
await win.keyboard.press('Enter');
await eventually(() => assert.ok(read('src/routes/+page.svelte').includes('Rooms that work beautifully'), 'the new heading is written to the page source'));
assert.ok(!read('src/routes/+page.svelte').includes('data-so-'), 'no editor instrumentation in the page source');
await eventually(async () => assert.equal(await h1.innerText(), 'Rooms that work beautifully', 'the preview shows the new heading'));

step('inline rich text: bold, italic and a page link');
const rich = frame.locator('.so-rich', { hasText: 'That conversation shapes' }).first();
await rich.scrollIntoViewIfNeeded();
await rich.click();
await win.waitForTimeout(300);
await rich.dblclick();
await eventually(async () => assert.equal(await rich.getAttribute('contenteditable'), 'true', 'the rich text is being edited'));
await rich.evaluate((el) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = n.nodeValue.indexOf('conversation');
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(n, at);
    range.setEnd(n, at + 'conversation'.length);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
});
await win.keyboard.press(`${MOD}+b`);
await win.keyboard.press(`${MOD}+i`);
await win.keyboard.press(`${MOD}+k`);
await eventually(async () => assert.equal(await win.locator('[role="dialog"]').count(), 0, 'the command menu stays closed while editing text'));
// An address no page has keeps the field open, says so, and links nothing.
const linkField = frame.locator('input[aria-label="Link destination"]');
await win.keyboard.type('/abot/');
await win.keyboard.press('Enter');
await eventually(async () => assert.match(await frame.locator('#so-link-error').innerText(), /No page has the address \/abot\//, 'the link field says the page does not exist'));
assert.equal(await linkField.inputValue(), '/abot/', 'the link field keeps what was typed');
assert.equal(await rich.locator('a').count(), 0, 'nothing is linked');
await linkField.fill('/about/');
await eventually(async () => assert.equal(await rich.locator('a[href="/about/"]').count(), 1, 'the words are linked'));
await win.keyboard.press(`${MOD}+Enter`);
const richSpan = async () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const about = Object.values(s.state.pages).find((x) => x.title === 'About');
    for (const n of Object.values(page.nodes)) {
      for (const b of Array.isArray(n.props?.body) ? n.props.body : []) {
        const span = b.spans?.find((x) => x.text === 'conversation');
        if (span) return { span, about: about.id };
      }
    }
    return null;
  });
await eventually(async () => {
  const found = await richSpan();
  assert.ok(found, 'the edited words are stored as their own span');
  assert.deepEqual(found.span, { text: 'conversation', strong: true, em: true, link: { type: 'page', target: found.about } }, 'bold, italic and the page ID are stored together');
});
await eventually(async () => assert.equal(await rich.locator('a[href="/about/"] strong em').count(), 1, 'the preview shows the linked bold italic words'));
assert.ok(!read('src/lib/siteorigin/runtime/RichText.svelte').includes('data-so-'), 'no editor instrumentation in the rich text helper');

step('inline rich text: the word double-clicked, and line breaks inside a paragraph (#175)');
const mediaBody = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    for (const n of Object.values(s.state.pages[s.state.site.homePageId].nodes)) {
      const b = n.props?.body;
      if (Array.isArray(b) && b.some((x) => x.spans?.some((sp) => sp.text.startsWith('Before we draw')))) return { body: b, revision: s.revision };
    }
    return null;
  });
const lastText = (body) => body[1].spans.map((x) => x.text).join('');
const second = rich.locator('p').nth(1);
// The canvas is scaled to fit, so a word's place on screen is its place in the frame, scaled.
const onScreen = async (word) => {
  const at = await second.evaluate((p, w) => {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue.indexOf(w);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + 2);
      r.setEnd(n, i + 3);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, width: innerWidth };
    }
    throw new Error(`no ${w}`);
  }, word);
  const box = await win.locator('.frame-box iframe').boundingBox();
  const scale = box.width / at.width;
  return { x: box.x + at.x * scale, y: box.y + at.y * scale };
};
// Selected first, where the editor scrolls it to, then double-clicked where it then is.
await rich.click();
await win.waitForTimeout(800);
const cushion = await onScreen('cushion');
await win.mouse.dblclick(cushion.x, cushion.y);
await eventually(async () => assert.equal(await rich.getAttribute('contenteditable'), 'true', 'the rich text is being edited'));
assert.equal(await rich.evaluate(() => getSelection().toString()), 'cushion', 'the edit selects the word double-clicked, not the whole text');
await win.keyboard.type('detail');
// The address goes at the end of the paragraph, with Shift+Enter between its lines.
await second.evaluate((p) => {
  const range = document.createRange();
  range.selectNodeContents(p);
  range.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
});
await win.keyboard.press('Shift+Enter');
await win.keyboard.type('Studio 4');
await win.keyboard.press('Shift+Enter');
await win.keyboard.type('Harbour Lane');
await win.keyboard.press(`${MOD}+Enter`);
await eventually(async () => {
  const found = await mediaBody();
  assert.equal(found.body.length, 2, 'the two paragraphs stay two: no line becomes a paragraph of its own');
  assert.equal(lastText(found.body), 'That conversation shapes every decision that follows, from the first sketch to the last detail.\nStudio 4\nHarbour Lane', 'the word and the lines are stored in their paragraph');
  assert.ok(found.body[0].spans[0].text.startsWith('Before we draw'), 'the first paragraph is untouched');
  assert.ok(found.body[1].spans.some((x) => x.text === 'conversation' && x.strong && x.em && x.link?.type === 'page'), 'the linked bold italic words keep their marks');
});
const edited = await mediaBody();
await eventually(async () => assert.equal(await second.locator('br').count(), 2, 'the preview shows the lines inside one paragraph'));
assert.match(read('src/lib/siteorigin/runtime/RichText.svelte'), /<br \/>/, 'the exported helper writes a line break as <br>');
assert.ok(read('src/routes/+page.svelte').includes('Harbour Lane'), 'the page source holds the address');
// Undo and Redo take the whole edit back and forth.
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.ok(lastText((await mediaBody()).body).endsWith('last cushion.'), 'undo puts the word and the paragraph back'));
await eventually(async () => assert.equal(await second.locator('br').count(), 0, 'the preview shows the paragraph as it was'));
await win.locator('[aria-label^="Redo"]').first().click();
await eventually(async () => assert.deepEqual((await mediaBody()).body, edited.body, 'redo writes the edit again, marks and links included'));
await eventually(async () => assert.equal(await second.locator('br').count(), 2, 'the lines are back'));
// Opening the edit again and leaving it changes nothing.
const settled = (await mediaBody()).revision;
await rich.click();
await win.waitForTimeout(800);
const detail = await onScreen('detail');
await win.mouse.dblclick(detail.x, detail.y);
await eventually(async () => assert.equal(await rich.getAttribute('contenteditable'), 'true', 'the rich text is being edited again'));
assert.equal(await rich.evaluate(() => getSelection().toString()), 'detail', 'the edit starts at the word double-clicked again');
await win.keyboard.press(`${MOD}+Enter`);
await eventually(async () => assert.equal(await rich.getAttribute('contenteditable'), null, 'the edit ends'));
await win.waitForTimeout(500);
assert.equal((await mediaBody()).revision, settled, 'reopening and leaving the text is no change');
assert.equal(await second.locator('br').count(), 2, 'the lines stay');

step('rich text the project refuses goes back to what was saved');
const savedRich = await rich.innerHTML();
// One run of words over the 20,000 characters text may hold, and the same length split across two runs.
for (const long of ['<p>' + 'x'.repeat(20001) + '</p>', '<p>' + 'x'.repeat(10001) + '<strong>' + 'y'.repeat(10000) + '</strong></p>']) {
  const before = await win.evaluate(async () => (await window.builder.project.snapshot()).revision);
  await rich.click();
  await rich.dblclick();
  await eventually(async () => assert.equal(await rich.getAttribute('contenteditable'), 'true', 'the rich text is being edited'));
  await rich.evaluate((el, html) => {
    el.innerHTML = html;
    el.dispatchEvent(new Event('input'));
  }, long);
  await win.keyboard.press(`${MOD}+Enter`);
  await eventually(async () => assert.equal(await rich.innerHTML(), savedRich, 'the page shows the saved text again'));
  assert.equal(await rich.getAttribute('contenteditable'), null, 'the edit has ended');
  assert.equal(await win.evaluate(async () => (await window.builder.project.snapshot()).revision), before, 'nothing was stored');
  await eventually(async () => assert.ok((await win.locator('.toast').allInnerTexts()).some((t) => /could not be saved|too long/i.test(t)), 'the author is told why'));
}

step('insert pricing via Insert panel');
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await win.getByRole('button', { name: 'Pricing' }).click();
await eventually(async () => assert.equal(await frame.locator('text=Clear packages, no surprises').count(), 1, 'one pricing section is inserted'));
await win.screenshot({ path: join(OUT, '11-inserted.png') });

step('phone-only padding override on selected section');
const phoneRule = /@media \(max-width: 767\.98px\)[\s\S]*padding-block: var\(--so-space-lg\)/;
const siteCss = () => read('src/lib/siteorigin/styles/site.css');
assert.doesNotMatch(siteCss(), phoneRule, 'no phone padding rule before the edit');
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await win.waitForTimeout(800);
await win.getByRole('button', { name: 'Style', exact: true }).last().click();
await win.getByRole('radiogroup', { name: 'Edit styles for' }).getByRole('radio', { name: 'Phone', exact: true }).click();
await win.locator('.style-row', { hasText: 'Vertical padding' }).first().locator('select').selectOption('token:space.lg');
await eventually(() => assert.match(siteCss(), phoneRule, 'the phone-only padding rule is generated'));
await win.screenshot({ path: join(OUT, '12-phone.png') });

step('undo / redo');
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(() => assert.doesNotMatch(siteCss(), /padding-block: var\(--so-space-lg\)/, 'undo removes the padding rule'));
await win.locator('[aria-label^="Redo"]').first().click();
await eventually(() => assert.match(siteCss(), phoneRule, 'redo restores the padding rule'));

step('style one pricing plan without restyling the others (#81)');
await win.getByRole('radiogroup', { name: 'Edit styles for' }).first().getByRole('radio', { name: 'All sizes', exact: true }).click();
const plans = frame.locator('li[class*="__plan"]');
await eventually(async () => assert.equal(await plans.count(), 3, 'three plan cards are shown'));
const fills = () => plans.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
const shared = (await fills())[0];
const reach = win.locator('#dock-panel-inspect').getByRole('group', { name: 'Style which plan cards' });
// The preview can swap its elements while it settles after earlier edits: click again until the card is selected.
const selectPlan = (i) =>
  eventually(async () => {
    await plans.nth(i).click({ position: { x: 6, y: 6 }, timeout: 3000 });
    await reach.waitFor({ timeout: 3000 });
  });
await selectPlan(1);
assert.equal(await reach.getByRole('button', { name: /^All 3 plan cards$/ }).getAttribute('aria-pressed'), 'true', 'all cards is the default');
await reach.getByRole('button', { name: 'This plan card' }).click();
await win.locator('#dock-panel-inspect .style-row', { hasText: 'Background' }).first().locator('select').selectOption('token:color.brand');
const onlyDesign = async () => {
  const [a, b, c] = await fills();
  assert.equal(a, shared, 'the first plan keeps the shared fill');
  assert.equal(c, shared, 'the third plan keeps the shared fill');
  assert.notEqual(b, shared, 'the chosen plan has its own fill');
};
await eventually(onlyDesign);
const pricingNode = async () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId].componentId === 'pricing.plans');
    return { owner: { kind: 'page', id: page.id }, id: node.id, plans: node.props.plans.map((p) => p.id), itemOverrides: node.itemOverrides };
  });
const placed = await pricingNode();
assert.deepEqual(Object.keys(placed.itemOverrides.plan.items), [placed.plans[1]], 'only the chosen plan has its own style');
// Undo takes the one change back; redo restores it.
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.deepEqual(await fills(), [shared, shared, shared], 'undo returns the plan to the shared fill'));
await win.locator('[aria-label^="Redo"]').first().click();
await eventually(onlyDesign);
// The style follows its plan when the plans are reordered.
await win.evaluate((p) => window.builder.project.apply({ operations: [{ type: 'instance.listMove', owner: p.owner, nodeId: p.id, prop: 'plans', itemId: p.plans[1], index: 0 }], label: 'Move plan' }), placed);
await eventually(async () => {
  const [a, b, c] = await fills();
  assert.deepEqual([b, c], [shared, shared], 'the plans now second and third keep the shared fill');
  assert.notEqual(a, shared, 'the moved plan keeps its own fill');
});
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(onlyDesign);
await selectPlan(1);
await win.locator('#dock-panel-inspect').getByRole('button', { name: /Reset to shared style/ }).first().click();
await eventually(async () => assert.deepEqual(await fills(), [shared, shared, shared], 'reset returns the plan to the shared fill'));
assert.equal((await pricingNode()).itemOverrides, undefined, 'nothing is left of the plan’s own style');

step('copy a section, delete it, then paste it on another page');
const sectionsOn = (title) =>
  win.evaluate(async (t) => {
    const s = await window.builder.project.snapshot();
    const p = Object.values(s.state.pages).find((x) => x.title === t);
    return p.rootIds.map((id) => s.state.components[p.nodes[id].definitionId]?.name ?? p.nodes[id].kind);
  }, title);
const pageRow = (title) => win.locator('.side-panel-view:not([hidden]) [data-page]', { hasText: title }).first();
assert.ok(!(await sectionsOn('Contact')).includes('Services grid'), 'Contact starts without a services grid');
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click();
await win.keyboard.press(`${MOD}+c`);
await win.locator('.toast', { hasText: 'Copied Services grid' }).waitFor();
await win.keyboard.press('Delete');
await eventually(async () => assert.ok(!(await sectionsOn('Home')).includes('Services grid'), 'the original section is deleted'));
await win.locator('.rail [aria-label="Pages"]').click();
await pageRow('Contact').click();
await win.keyboard.press(`${MOD}+v`);
await eventually(async () => assert.ok((await sectionsOn('Contact')).includes('Services grid'), 'the copy is pasted on Contact although its original is gone'));
await eventually(() => assert.ok(read('src/routes/contact/+page.svelte').includes('Everything your project needs, in one place'), 'the copy is written to the Contact page'));
assert.equal(await win.locator('.toast.error').count(), 0, 'no paste error is shown');
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.ok(!(await sectionsOn('Contact')).includes('Services grid'), 'undo takes the paste back'));
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.ok((await sectionsOn('Home')).includes('Services grid'), 'a second undo restores the original'));
await pageRow('Home').click();

step('select two sections by keyboard alone and move them to another page as one change (#167)');
const pageJson = (title) =>
  win.evaluate(async (t) => {
    const s = await window.builder.project.snapshot();
    return JSON.stringify(Object.values(s.state.pages).find((x) => x.title === t));
  }, title);
const focusedName = () => win.evaluate(() => document.activeElement?.closest('[role="treeitem"]')?.getAttribute('data-name') ?? null);
const selectedNames = () => win.locator('[role="tree"] [role="treeitem"][aria-selected="true"]').evaluateAll((rows) => rows.map((r) => r.dataset.name));
/** Arrow down a menu until the focused item starts with `name`. The menu moves focus a moment after each key
 *  (later still in a window that is never shown), so each key waits for it. */
const focusedText = () => win.evaluate(() => document.activeElement?.textContent ?? '');
const menuTo = async (name) => {
  // The menu takes focus once it has opened; a key sent before then would go to the tree.
  await eventually(async () => assert.ok(await win.evaluate(() => !!document.activeElement?.closest('[role="menu"] [role^="menuitem"]')), 'an item of the menu has focus'));
  const seen = [];
  for (let i = 0; i < 12; i++) {
    const text = await focusedText();
    if (text.startsWith(name)) return;
    seen.push(text);
    await win.keyboard.press('ArrowDown');
    await eventually(async () => assert.notEqual(await focusedText(), text, 'ArrowDown moves to the next item'));
  }
  assert.fail(`the menu reaches ${name} (focus went through ${JSON.stringify(seen)})`);
};
const [homeBefore, aboutBefore] = [await pageJson('Home'), await pageJson('About')];
await win.locator('.rail [aria-label="Layers"]').click();
// Keyboard alone from here, with the pointer resting away from where the menus open (a menu focuses the item under it).
await win.mouse.move(2, 2);
// Into the tree at its one tab stop, type-ahead to Gallery, then Shift+↓ takes Testimonials too.
await win.locator('[role="tree"] [role="treeitem"][tabindex="0"]').focus();
await win.keyboard.type('Gallery');
await eventually(async () => assert.equal(await focusedName(), 'Gallery', 'type-ahead reaches Gallery'));
await win.keyboard.press('Shift+ArrowDown');
await eventually(async () => assert.deepEqual(await selectedNames(), ['Gallery', 'Testimonials'], 'Shift+↓ selects Gallery and Testimonials together'));
assert.equal(await focusedName(), 'Testimonials', 'focus moves on to Testimonials');
assert.equal(await win.locator('[role="tree"] [role="treeitem"][tabindex="0"]').count(), 1, 'the tree keeps one tab stop');
assert.equal(await win.locator('[role="tree"] [role="treeitem"][tabindex="0"]').getAttribute('data-name'), 'Testimonials', 'on the selection itself');
assert.equal(await win.locator('[role="tree"]').first().getAttribute('aria-multiselectable'), 'true', 'the tree says several can be selected');
// Escape keeps just the selection; Cmd/Ctrl+↑ moves focus alone; Space adds the focused layer again.
await win.keyboard.press('Escape');
await eventually(async () => assert.deepEqual(await selectedNames(), ['Testimonials'], 'Escape keeps only Testimonials'));
await win.keyboard.press(`${MOD}+ArrowUp`);
await eventually(async () => assert.equal(await focusedName(), 'Gallery', 'Cmd/Ctrl+↑ moves focus to Gallery'));
assert.deepEqual(await selectedNames(), ['Testimonials'], 'without selecting it');
await win.keyboard.press(' ');
await eventually(async () => assert.deepEqual(await selectedNames(), ['Gallery', 'Testimonials'], 'Space adds Gallery'));
await win.locator('.layers-picked', { hasText: '2 sections selected' }).waitFor();
await win.locator('.status-bar .crumbs-count', { hasText: '2 sections selected' }).waitFor();
await win.screenshot({ path: join(OUT, '16-two-selected.png') });
// Their menu (Shift+F10), Move to page…, About.
await win.keyboard.press('Shift+F10');
await win.locator('[role="menu"]', { hasText: '2 sections selected' }).waitFor();
await menuTo('Move to page');
await win.keyboard.press('Enter');
await win.locator('[role="menu"]', { hasText: 'Move 2 sections to the end of' }).waitFor();
await menuTo('About');
await win.keyboard.press('Enter');
await eventually(async () => assert.deepEqual((await sectionsOn('About')).slice(-2), ['Gallery', 'Testimonials'], 'both land at the end of About, in order'));
const homeNow = await sectionsOn('Home');
assert.ok(!homeNow.includes('Gallery') && !homeNow.includes('Testimonials'), 'and leave Home');
await win.locator('.toast', { hasText: 'Moved Gallery and Testimonials to the end of About.' }).waitFor();
await eventually(async () => assert.deepEqual(await selectedNames(), ['Gallery', 'Testimonials'], 'About opens with both selected'));
await eventually(async () => assert.equal(await focusedName(), 'Gallery', 'keyboard focus follows them there, to the selection'));
// One Undo puts both pages back as they were.
await win.keyboard.press(`${MOD}+z`);
await eventually(async () => assert.deepEqual([await pageJson('Home'), await pageJson('About')], [homeBefore, aboutBefore], 'one Undo puts both pages back'));
await win.locator('.rail [aria-label="Pages"]').click();
await pageRow('Home').click();

step('place a library image already used in the Gallery from Assets (#13)');
const readingAlt = 'A reading corner with an armchair and shelves of books';
const placedReading = () =>
  win.evaluate(async () => {
    const snap = await window.builder.project.snapshot();
    const home = snap.state.pages[snap.state.site.homePageId];
    return Object.values(home.nodes).filter((n) => n.kind === 'image' && n.image.assetId === 'a_reading').map((n) => n.image.alt);
  });
const homeSections = () => win.evaluate(async () => {
  const snap = await window.builder.project.snapshot();
  return snap.state.pages[snap.state.site.homePageId].rootIds.length;
});
assert.deepEqual(await placedReading(), [], 'the reading nook starts out only in the Gallery');
const sectionsBefore = await homeSections();
const previewReading = frame.locator(`img[alt="${readingAlt}"]`);
await win.locator('.rail [aria-label="Assets"]').click();
await win.locator('[data-asset="a_reading"]').click();
// Its Gallery use names the row and selects the Gallery on Home with that row open at its image (#228): the copy
// goes right after the Gallery, in a section of its own.
await win.locator('button.asset-use[title="Show Gallery · Image 3: Reading room, Old Mill on Home"]').click();
// The row's ID is the one the placed Gallery gave it, not the starter's.
const readingRow = await win.evaluate(async () => {
  const snap = await window.builder.project.snapshot();
  const home = snap.state.pages[snap.state.site.homePageId];
  const gallery = Object.values(home.nodes).find((n) => n.kind === 'instance' && snap.state.components[n.definitionId]?.name === 'Gallery');
  return gallery.props.images.find((row) => row.image?.assetId === 'a_reading').id;
});
await eventually(async () =>
  assert.deepEqual(
    await win.evaluate((id) => {
      const head = document.getElementById(`list-head-${id}`);
      const field = document.getElementById(`list-item-${id}`)?.querySelector('[data-field="image"]');
      return { inInspector: !!head?.closest('#dock-panel-inspect'), open: head?.getAttribute('aria-expanded'), focused: !!field && field.contains(document.activeElement) };
    }, readingRow),
    { inInspector: true, open: 'true', focused: true },
    'the Reading room row is open, with focus in its image field'
  )
);
const placeWhere = win.getByTestId('asset-place-where');
await eventually(async () => assert.equal(await placeWhere.innerText(), 'Goes in a new section after Gallery on Home. Select something on the page to put it elsewhere.'));
const shownBefore = await previewReading.count();
await win.getByRole('button', { name: 'Place on page' }).click();
await eventually(async () => assert.deepEqual(await placedReading(), [readingAlt], 'one new image on Home, with the suggested alt text'));
assert.equal(await homeSections(), sectionsBefore + 1, 'in a new section');
assert.equal(
  await win.evaluate(async () => {
    const snap = await window.builder.project.snapshot();
    const home = snap.state.pages[snap.state.site.homePageId];
    const at = home.rootIds.findIndex((id) => snap.state.components[home.nodes[id].definitionId]?.name === 'Gallery');
    const next = home.nodes[home.rootIds[at + 1]];
    return (next.slots?.content ?? []).map((id) => home.nodes[id].image?.assetId).join();
  }),
  'a_reading',
  'the new section is the one right after the Gallery'
);
await eventually(async () => assert.equal(await previewReading.count(), shownBefore + 1, 'the preview shows the placed copy beside the Gallery’s'));
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Image' }).waitFor();
// Edit on the selection chip moves focus to the first control in the inspector, a picker button included.
await win.locator('.dock-tab', { hasText: 'AI' }).click();
await win.locator('#dock-panel-inspect').waitFor({ state: 'hidden' });
await win.locator('.ov-chip .chip-text', { hasText: 'Edit' }).click();
await eventually(async () => {
  const at = await win.evaluate(() => {
    const el = document.activeElement;
    const panel = document.getElementById('dock-panel-inspect');
    if (!el || !panel?.contains(el)) return null;
    // The control the page would reach first among the open sections' fields.
    const first = [...panel.querySelectorAll('.section-body input:not([type="hidden"]), .section-body textarea, .section-body select, .section-body button, .section-body [role="switch"]')].find((n) => n.offsetParent !== null && !n.disabled);
    return { tag: el.tagName, first: first === el };
  });
  assert.ok(at, 'focus is inside the inspector');
  assert.equal(at.first, true, 'on the first control of its open sections');
});
await win.screenshot({ path: join(OUT, '16-placed-image.png') });
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.deepEqual(await placedReading(), [], 'one Undo takes the placed copy away'));
assert.equal(await homeSections(), sectionsBefore, 'and its section with it');
await eventually(async () => assert.equal(await previewReading.count(), shownBefore, 'the preview shows only the Gallery’s copy again'));

step('drag to reorder: canvas grip and layers');
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
await win.waitForTimeout(800);
const order = async () =>
  (
    await win.evaluate(async () => {
      const s = await window.builder.project.snapshot();
      const p = s.state.pages[s.state.site.homePageId];
      return p.rootIds.map((id) => s.state.components[p.nodes[id].definitionId]?.name);
    })
  ).slice(0, 3);
assert.deepEqual(await order(), ['Split hero', 'Logo strip', 'Services grid']);
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.list-item', { hasText: 'Split hero' }).click();
await win.waitForTimeout(800);
const gb = await win.locator('.ov-chip [aria-label="Drag to move"]').boundingBox();
assert.ok(gb, 'the selection chip shows a drag grip');
const wrap = await win.locator('.frame-wrap').boundingBox();
await win.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await win.mouse.down();
await win.mouse.move(wrap.x + wrap.width / 2, wrap.y + 620, { steps: 8 });
await win.waitForTimeout(200);
await win.screenshot({ path: join(OUT, '16-drag.png') });
await win.mouse.up();
await eventually(async () => assert.deepEqual(await order(), ['Logo strip', 'Split hero', 'Services grid'], 'the canvas drag moves the hero below the logo strip'));
await win.locator('.list-item', { hasText: 'Split hero' }).dragTo(win.locator('.list-item', { hasText: 'Logo strip' }), { targetPosition: { x: 40, y: 4 } });
await eventually(async () => assert.deepEqual(await order(), ['Split hero', 'Logo strip', 'Services grid'], 'the Layers drag moves the hero back to the top'));


step('edit a component everywhere: canvas, layers and inspector agree');
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click();
const compSection = win.locator('.section-head', { hasText: 'Component' });
if ((await compSection.getAttribute('aria-expanded')) === 'false') await compSection.click();
await win.getByRole('button', { name: 'Edit everywhere…' }).click();
await win.getByRole('button', { name: /Make a copy and edit/ }).click();
await win.locator('.mode-band').waitFor();
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'entering outlines the design on the canvas'));
// A click in the page picks the design's own node under the pointer: Layers and the inspector follow it.
// The services grid now places the project's own copy of its design: its heading is that copy's part.
const fork = await eventually(async () => {
  const s = await projectSnapshot();
  const page = s.state.pages[s.state.site.homePageId];
  const grid = page.nodes[page.rootIds[2]];
  const def = s.state.components[grid.definitionId];
  assert.equal(def.owner, 'project', 'the grid places the copy being edited');
  return { gridId: grid.id, defId: def.id, headingNode: def.parts.heading.nodeId };
});
const { gridId, headingNode } = fork;
const headingRow = win.locator(`[role="treeitem"][data-owner="component:${fork.defId}"][data-node="${headingNode}"]`);
// The copy's heading as the preview shows it once the copy is built (its class names the copy), not the
// original's, which a click while the preview catches up would miss.
const gridHeading = frame.locator(`[data-so-ctx$="|${gridId}"] h2[class*="so-${fork.defId.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}__"]`).first();
await gridHeading.waitFor({ timeout: 30000 });
// The preview can still be settling after entering the mode: a click the canvas missed is clicked again, and
// picking in the design selects the same node each time.
await eventually(async () => {
  if ((await headingRow.count()) !== 1 || (await headingRow.getAttribute('aria-selected')) !== 'true') await gridHeading.click({ timeout: 3000 });
  await eventually(async () => assert.equal(await headingRow.getAttribute('aria-selected'), 'true', 'Layers selects the picked node of the design'), 3000);
}, 20000);
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'the picked node is outlined'));
await win.locator('.insp-scope.definition').first().waitFor();
// And back: Escape shows the overview, then the Layers row outlines that node on the canvas again.
await win.keyboard.press('Escape');
await eventually(async () => assert.equal(await win.locator('.ov-selected').count(), 0, 'Escape clears the selection'));
await headingRow.click();
await eventually(async () => assert.ok((await win.locator('.ov-selected').count()) >= 1, 'a Layers pick in the design is outlined on the canvas'));
await win.locator('.insp-scope.definition').first().waitFor();
await win.locator('.mode-band-done').click();
await win.locator('.mode-band').waitFor({ state: 'detached' });

step('tone and layout combine, and a code component offers its tone');
const axis = (label) => win.locator('#dock-panel-inspect .field', { hasText: new RegExp(`^${label}`) }).locator('select').first();
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click();
await axis('Tone').selectOption('inverse');
await axis('Layout').selectOption('four-columns');
await eventually(() => {
  const page = read('src/routes/+page.svelte');
  assert.match(page, /variant_tone="inverse"/, 'the section keeps its dark tone');
  assert.match(page, /variant_layout="four-columns"/, 'alongside its four-column layout');
});
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await win.getByRole('button', { name: 'Contact form' }).click();
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Contact form' }).waitFor();
await axis('Tone').selectOption('muted');
await eventually(() => assert.match(read('src/routes/+page.svelte'), /variant="muted"/, 'the form takes the tone chosen in the Inspector'));
await eventually(async () => assert.equal(await frame.locator('section.so-form--muted').count(), 1, 'the preview shows the form in that tone'));

step('a contact form shows only the setting its service needs, and keeps the others');
const inspector = win.locator('#dock-panel-inspect');
const setting = (label) => inspector.getByLabel(label, { exact: true });
const SETTINGS = ['Form endpoint URL', 'Web3Forms access key', 'Netlify form name'];
const noteOf = (control) =>
  control.evaluate((el) => {
    const note = document.getElementById(el.getAttribute('aria-describedby') ?? '');
    return {
      text: note?.textContent ?? '',
      visible: !!note && note.checkVisibility() && !!el.closest('.field')?.contains(note),
      warnings: [...(note?.querySelectorAll('.field-warning') ?? [])].map((w) => w.textContent)
    };
  });
// The placed form's service values and its own FORM_UNCONNECTED message, from the project itself.
const formState = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === 'contact.form');
    const { provider, endpoint, accessKey, formName } = node.props;
    const warning = s.diagnostics.filter((d) => d.code === 'FORM_UNCONNECTED' && d.nodeId === node.id).map((d) => d.message).join(' ');
    return { provider, endpoint, accessKey, formName, warning };
  });
// Exactly one service setting is in the inspector. Its own visible note gives the setup steps. While the form cannot
// send, the problems above the Inspector's sections say so with exactly one warning, which the project check repeats;
// once a value has been entered, the note beside it gives that warning too.
const showsOnly = (label, setup, warning) =>
  eventually(async () => {
    for (const other of SETTINGS) assert.equal(await setting(other).count(), other === label ? 1 : 0, `${other} is ${other === label ? 'shown' : 'hidden'} for this service`);
    const note = await noteOf(setting(label));
    assert.ok(note.visible, `the note under ${label} is visible in its field`);
    for (const text of setup) assert.ok(note.text.includes(text), `the note under ${label} says “${text}”: ${note.text}`);
    const entered = (await setting(label).inputValue()).trim() !== '';
    assert.deepEqual(note.warnings, warning && entered ? [warning] : [], `the note under ${label} warns ${warning && entered ? `“${warning}”` : 'nothing'}`);
    const problems = await inspector.locator('.insp-problems .insp-scope.danger').allInnerTexts();
    assert.equal(problems.length, warning ? 1 : 0, `the problems above the sections: ${JSON.stringify(problems)}`);
    if (warning) assert.ok(problems[0].includes('This form can’t send messages yet.') && problems[0].includes(warning), `the problem says the form can’t send and “${warning}”: ${problems[0]}`);
    const { warning: check } = await formState();
    if (warning) assert.ok(check.endsWith(warning), `the project check says “${warning}”: ${check}`);
    else assert.equal(check, '', 'the project check has nothing to say about the form');
  });
const service = setting('Form service');
const ENDPOINT_SETUP = ['paste the HTTPS endpoint it gives you', 'https://formspree.io/f/abc123'];
const WEB3_SETUP = ['web3forms.com', 'emails you an access key'];
const NETLIFY_SETUP = ['hosted on Netlify', 'form detection', 'then deploy'];
await showsOnly('Form endpoint URL', ENDPOINT_SETUP, 'Add the HTTPS endpoint your form service gives you.');
assert.equal(await service.getAttribute('aria-describedby'), null, 'the service list carries none of the setting’s note');
await service.selectOption('web3forms');
await showsOnly('Web3Forms access key', WEB3_SETUP, 'Add your Web3Forms access key.');
await setting('Web3Forms access key').fill('e2e-test-key');
await setting('Web3Forms access key').press('Enter');
await showsOnly('Web3Forms access key', WEB3_SETUP, null);
await service.selectOption('netlify');
await showsOnly('Netlify form name', NETLIFY_SETUP, null);
assert.equal(await setting('Netlify form name').inputValue(), 'contact', 'Netlify starts with a form name');
await setting('Netlify form name').fill('');
await setting('Netlify form name').press('Enter');
await showsOnly('Netlify form name', NETLIFY_SETUP, 'Add a form name for Netlify Forms.');
// A name typed and not yet committed is still a draft when the author moves to the service list.
await setting('Netlify form name').fill('enquiries');
assert.equal((await formState()).formName, '', 'the typed name is still a draft');
await service.focus();
await service.selectOption('endpoint');
await eventually(async () => {
  const { provider, formName } = await formState();
  assert.deepEqual({ provider, formName }, { provider: 'endpoint', formName: 'enquiries' }, 'leaving the name for the service list saves it');
});
await showsOnly('Form endpoint URL', ENDPOINT_SETUP, 'Add the HTTPS endpoint your form service gives you.');
await setting('Form endpoint URL').fill('http://insecure.example/f');
await setting('Form endpoint URL').press('Enter');
await showsOnly('Form endpoint URL', ENDPOINT_SETUP, 'Use the full HTTPS endpoint your form service gives you, starting with https://.');
await setting('Form endpoint URL').fill('https://formspree.io/f/e2etest');
await setting('Form endpoint URL').press('Enter');
await showsOnly('Form endpoint URL', ENDPOINT_SETUP, null);
await service.selectOption('netlify');
await showsOnly('Netlify form name', NETLIFY_SETUP, null);
assert.equal(await setting('Netlify form name').inputValue(), 'enquiries', 'the Netlify form name typed before the switch is kept, and connects the form');
await service.selectOption('endpoint');
await showsOnly('Form endpoint URL', ENDPOINT_SETUP, null);
assert.equal(await setting('Form endpoint URL').inputValue(), 'https://formspree.io/f/e2etest', 'switching back shows the endpoint entered before');
await service.selectOption('web3forms');
await showsOnly('Web3Forms access key', WEB3_SETUP, null);
assert.equal(await setting('Web3Forms access key').inputValue(), 'e2e-test-key', 'switching back shows the key entered before');
assert.deepEqual(await formState(), { provider: 'web3forms', endpoint: 'https://formspree.io/f/e2etest', accessKey: 'e2e-test-key', formName: 'enquiries', warning: '' }, 'the project keeps every service’s setting');
await eventually(async () => assert.equal(await frame.locator('form.so-form__form input[name="access_key"]').inputValue(), 'e2e-test-key', 'the preview form sends that key to Web3Forms'));

step('a contact form asks a single-choice question whose choices the author names, orders and removes (issue #238)');
const QUESTION = 'Which service are you interested in?';
const formFields = inspector.locator('[data-list="fields"]');
// The fields of the placed form, from the project itself.
const storedFields = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const page = s.state.pages[s.state.site.homePageId];
    const node = Object.values(page.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === 'contact.form');
    return node.props.fields.map((f) => ({ label: f.label, name: f.name, type: f.type, options: (f.options ?? []).map((o) => [o.label, o.value]) }));
  });
const question = () => storedFields().then((fields) => fields.find((f) => f.type === 'choice' || f.label === QUESTION));
await formFields.getByRole('button', { name: 'Add field' }).click();
const opened = formFields.locator('.list-editor-body:not([hidden])');
await opened.getByLabel('Label', { exact: true }).fill(QUESTION);
await opened.getByLabel('Label', { exact: true }).press('Enter');
await eventually(async () => assert.equal((await question())?.label, QUESTION, 'the new field takes the question as its label'));
const choicesGroup = opened.getByRole('group', { name: /^Choices/ });
assert.equal(await choicesGroup.count(), 0, 'a text field has no choices to edit');
assert.equal(await opened.getByLabel('Placeholder', { exact: true }).count(), 1, 'a text field has a placeholder');
await opened.getByLabel('Type', { exact: true }).selectOption('choice');
await eventually(async () => {
  assert.equal(await choicesGroup.count(), 1, 'a single-choice field shows its choices');
  assert.equal(await opened.getByLabel('Placeholder', { exact: true }).count(), 0, 'and no placeholder, which it never shows');
});
const newChoice = choicesGroup.getByLabel('New choice');
for (const [i, label] of ['Kitchen', 'Lighting', 'Other'].entries()) {
  await newChoice.fill(label);
  await newChoice.press('Enter');
  await eventually(async () => assert.equal((await question()).options.length, i + 1, `“${label}” is added`));
}
// The author acts on what the inspector shows, once it shows what the project holds.
const shownChoices = () => choicesGroup.locator('.choices-row input').evaluateAll((inputs) => inputs.map((input) => input.value));
await eventually(async () => assert.deepEqual(await shownChoices(), ['Kitchen', 'Lighting', 'Other'], 'the inspector lists the three choices'));
// Renamed, then moved before the rename has come back: both land, and the choice is still sent as it was made.
await choicesGroup.getByLabel('Choice 2', { exact: true }).fill('Éclairage');
await choicesGroup.getByRole('button', { name: 'Move “Lighting” up' }).click();
await eventually(async () =>
  assert.deepEqual((await question()).options, [['Éclairage', 'Lighting'], ['Kitchen', 'Kitchen'], ['Other', 'Other']], 'the renamed choice moves up and keeps its value')
);
await eventually(async () => assert.ok((await choicesGroup.innerText()).includes('Sent as “Lighting”'), 'the editor says what the renamed choice is sent as'));
// A rename the project refuses (a label already offered), then a move at once: the move lands, the label comes back.
await eventually(async () => assert.deepEqual(await shownChoices(), ['Éclairage', 'Kitchen', 'Other'], 'the inspector shows the move'));
await choicesGroup.getByLabel('Choice 2', { exact: true }).fill('ÉCLAIRAGE');
await choicesGroup.getByRole('button', { name: 'Move “Kitchen” up' }).click();
await eventually(async () => assert.deepEqual((await question()).options, [['Kitchen', 'Kitchen'], ['Éclairage', 'Lighting'], ['Other', 'Other']], 'the move lands though the rename before it was refused'));
await eventually(async () => assert.deepEqual(await shownChoices(), ['Kitchen', 'Éclairage', 'Other'], 'and the refused label is put back'));
await choicesGroup.getByRole('button', { name: 'Remove “Other”' }).click();
await eventually(async () => assert.deepEqual((await question()).options, [['Kitchen', 'Kitchen'], ['Éclairage', 'Lighting']], 'the removed choice is gone'));
await eventually(async () => {
  const preview = frame.locator('fieldset.so-form__choices', { has: frame.locator('legend', { hasText: QUESTION }) });
  assert.deepEqual(await preview.locator('input[type="radio"]').evaluateAll((radios) => radios.map((r) => [r.closest('label').textContent.trim(), r.value])), [['Kitchen', 'Kitchen'], ['Éclairage', 'Lighting']], 'the preview asks with radio buttons that send each choice’s value');
});
// A checkbox has neither choices nor a placeholder; switching back finds the choices as they were.
await opened.getByLabel('Type', { exact: true }).selectOption('checkbox');
await eventually(async () => {
  assert.equal(await choicesGroup.count(), 0, 'a checkbox hides the choices');
  assert.equal(await opened.getByLabel('Placeholder', { exact: true }).count(), 0, 'and the placeholder');
});
await eventually(async () => assert.equal(await frame.locator('.so-form__check input[type="checkbox"]').count(), 1, 'the preview shows a checkbox'));
await opened.getByLabel('Type', { exact: true }).selectOption('choice');
await eventually(async () => assert.deepEqual((await question()).options, [['Kitchen', 'Kitchen'], ['Éclairage', 'Lighting']], 'the choices are kept while hidden'));
await eventually(async () => assert.equal(await choicesGroup.count(), 1, 'and shown again'));

step('a contact form practises its sends in Preview, and sends one real message only when the author confirms a live test (issue #193)');
// The service is answered here and counted. A .test address never resolves, so nothing could reach a real service.
const ENDPOINT = 'https://forms.e2e.test/f/rehearsal';
const delivered = [];
const deliver = async (route) => {
  delivered.push({ method: route.request().method(), url: route.request().url(), body: route.request().postData() ?? '' });
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ok":true}' });
};
await app.context().route('https://forms.e2e.test/**', deliver);
await service.selectOption('endpoint');
await setting('Form endpoint URL').fill(ENDPOINT);
await setting('Form endpoint URL').press('Enter');
const contact = frame.locator('form.so-form__form');
await eventually(async () => assert.equal(await contact.getAttribute('action'), ENDPOINT, 'the preview form posts to the endpoint'));
const answer = async () => {
  await contact.getByLabel('Name').fill('Ada');
  await contact.getByLabel('Email').fill('ada@example.com');
  await contact.getByLabel('Message').fill('A rehearsal enquiry');
};
const formStatus = () => frame.locator('.so-form__status[role="status"]').innerText();
const formAlert = () => frame.locator('.so-form__status[role="alert"]').innerText();
const practicePanel = win.locator('.form-practice');
const practiceNote = () => practicePanel.locator('[role="status"]').innerText();

await answer();
await contact.getByRole('button', { name: 'Send message' }).press('Enter');
await contact.getByLabel('Email').press('Enter');
await win.waitForTimeout(600);
assert.equal(delivered.length, 0, 'Edit sends nothing');
assert.equal(await formStatus(), '', 'Edit shows no sent message');

await win.locator('button[title^="Preview:"]').click();
await eventually(async () => {
  const text = await practicePanel.innerText();
  assert.ok(text.includes('Form sends are simulated in Preview. Nothing is sent unless you test live delivery.'), `Preview says before any send that sends are simulated: ${text}`);
  assert.ok(text.includes('sends to forms.e2e.test/f/rehearsal'), `and where the form sends once published: ${text}`);
});
await answer();
await contact.getByLabel('Email').press('Enter');
await eventually(async () => assert.equal(await practiceNote(), 'Practice send: the form showed its sent message. Nothing was sent.', 'Preview explains the practice send'));
assert.equal(await formStatus(), 'Thank you. Your message has been sent.', 'the form shows its own sent message');
assert.equal(delivered.length, 0, 'a practice send in Preview sends nothing');

await practicePanel.getByRole('button', { name: 'Error', exact: true }).click();
await answer();
await contact.getByLabel('Email').press('Enter');
await eventually(async () => assert.equal(await practiceNote(), 'Practice send: the form showed its error message. Nothing was sent.', 'Preview explains the failed practice send'));
assert.equal(await formAlert(), 'Sorry, your message could not be sent. Please try again or contact us directly.', 'the form shows its own error message');
assert.equal(await contact.getByLabel('Message').inputValue(), 'A rehearsal enquiry', 'a failed send keeps the answers');
assert.equal(delivered.length, 0, 'a failed practice send sends nothing');

await practicePanel.getByRole('button', { name: /Test live delivery/ }).click();
await eventually(async () => {
  const text = await practicePanel.innerText();
  assert.ok(text.includes('Send one real test message?') && text.includes('go to forms.e2e.test/f/rehearsal'), `the live test names where it sends before it sends: ${text}`);
});
assert.equal(delivered.length, 0, 'opening the live test sends nothing');
await practicePanel.getByRole('button', { name: 'Send one real test message' }).click();
await eventually(() => assert.equal(delivered.length, 1, 'the confirmed live test sends one message'));
assert.equal(delivered[0].method, 'POST');
assert.equal(delivered[0].url, ENDPOINT, 'the live test goes to the address the author confirmed');
assert.ok(delivered[0].body.includes('A rehearsal enquiry'), 'the live test sends the answers in the form');
await eventually(async () => assert.equal(await practiceNote(), 'Live test sent to forms.e2e.test/f/rehearsal. The service answered with status 200. Check the service to see the message arrived.', 'Preview reports what the service answered'));

await practicePanel.getByRole('button', { name: 'Success', exact: true }).click();
await answer();
await contact.getByLabel('Email').press('Enter');
await eventually(async () => assert.equal(await practiceNote(), 'Practice send: the form showed its sent message. Nothing was sent.', 'the next send is a practice again'));
assert.equal(delivered.length, 1, 'only the confirmed live test was sent');
await win.locator('button[title^="Edit:"]').click();
await app.context().unroute('https://forms.e2e.test/**', deliver);

step('repeatable lists: capacity, and focus after a move to either end');
if (!(await win.locator('[role="tree"]').first().isVisible())) await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('[role="tree"] .list-item', { hasText: 'Services grid' }).first().click();
const cards = win.locator('#dock-panel-inspect [data-list]').first();
await cards.waitFor();
const rows = cards.locator('.list-editor-head button.title');
const titles = async () => (await rows.allInnerTexts()).map((t) => t.trim());
const maxOf = async () => Number((await cards.locator('.insp-count').innerText()).split('/')[1]);
const max = await maxOf();
assert.ok(max >= (await rows.count()), 'the count shows the maximum from the schema');
await cards.getByRole('button', { name: /^Add / }).click(); // Four cards, so a middle card can move without reaching an end.
await eventually(async () => assert.equal(await rows.count(), 4, 'a card is added'));
const count = 4;
assert.equal((await cards.locator('.insp-count').innerText()).trim(), `4 / ${max}`, 'the count shows the schema maximum');
const subject = (await titles())[1];
const focusedId = () => win.evaluate(() => document.activeElement?.id ?? '');
const status = () => cards.locator('[role="status"]').innerText();
const moveTo = async (dir, expectedIndex) => {
  const button = cards.locator('.list-editor-item', { has: win.locator('button.title', { hasText: subject }) }).getByRole('button', { name: `Move ${subject} ${dir}` });
  await button.focus();
  await win.keyboard.press('Enter');
  await eventually(async () => assert.equal((await titles())[expectedIndex], subject, `${subject} moves ${dir} to position ${expectedIndex + 1}`));
  await eventually(async () => assert.match(await status(), new RegExp(`${subject} moved to position ${expectedIndex + 1} of ${count}`), 'the new position is announced'));
};
const focusedCard = async () => win.evaluate(() => document.activeElement?.closest('.list-editor-item')?.querySelector('button.title')?.textContent?.trim());
// Intermediate moves keep focus on the button that moved the card.
await moveTo('down', 2);
await eventually(async () => {
  assert.match(await focusedId(), /^list-down-/, 'focus stays on Move down for a move that is not the last');
  assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), `Move ${subject} down`, 'on the moved card\'s own button');
});
await moveTo('up', 1);
await eventually(async () => {
  assert.match(await focusedId(), /^list-up-/, 'focus stays on Move up for a move that is not the first');
  assert.equal(await win.evaluate(() => document.activeElement?.getAttribute('aria-label')), `Move ${subject} up`, 'on the moved card\'s own button');
});
// Reaching either end disables the button that was used, so focus goes to the card's disclosure.
await moveTo('up', 0);
await eventually(async () => assert.match(await focusedId(), /^list-head-/, 'focus lands on the disclosure at the top'));
assert.equal(await focusedCard(), subject, 'the disclosure is the moved card');
await moveTo('down', 1);
await moveTo('down', 2);
await moveTo('down', 3);
await eventually(async () => assert.match(await focusedId(), /^list-head-/, 'focus lands on the disclosure at the bottom'));
assert.equal(await focusedCard(), subject, 'the disclosure is still the moved card');

// At the maximum Add stays in the tab order, says why, and adds nothing.
const addButton = cards.getByRole('button', { name: /^Add / });
for (let n = 4; n < max; n++) {
  await addButton.click();
  await eventually(async () => assert.equal(await rows.count(), n + 1, 'a card is added'));
}
await eventually(async () => assert.equal(await addButton.getAttribute('aria-disabled'), 'true', 'Add is marked unavailable at the maximum'));
assert.equal(await addButton.evaluate((el) => el.disabled), false, 'Add is not natively disabled, so it keeps its place in the tab order');
await addButton.focus();
assert.equal(await win.evaluate(() => document.activeElement?.classList.contains('insp-add')), true, 'Add can be focused at the maximum');
assert.match(await cards.locator('.insp-note').innerText(), new RegExp(`at most ${max} items`), 'the limit is explained at the add action');
assert.equal(await addButton.getAttribute('aria-describedby'), await cards.locator('.insp-note').getAttribute('id'), 'the explanation describes Add');
const revision = () => win.evaluate(async () => (await window.builder.project.snapshot()).revision);
const before = await revision();
await addButton.click({ force: true });
await win.waitForTimeout(400);
assert.equal(await rows.count(), max, 'a click at the maximum adds nothing');
assert.equal(await revision(), before, 'and sends no edit');
assert.equal((await cards.locator('.insp-count').innerText()).trim(), `${max} / ${max}`);

step('site styles and chat panels');
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
await win.locator('#dock-panel-styles').waitFor();
await win.screenshot({ path: join(OUT, '13-styles.png') });
await win.locator('.dock-tab', { hasText: 'AI' }).click();
await win.locator('.chat-empty').waitFor(); // No provider is connected in this run.
await win.screenshot({ path: join(OUT, '14-chat.png') });
if (!(await win.locator('[role="tree"]').first().isVisible())) await win.locator('.rail [aria-label="Layers"]').click();
await win.waitForTimeout(300);
await win.screenshot({ path: join(OUT, '15-layers.png') });

step('a data table on About: find, insert, edit, undo, reopen and fit a phone (issue #179)');
await win.locator('.rail [aria-label="Pages"]').click();
await pageRow('About').click();
await frame.locator('text=A small studio with a long view').first().waitFor();
await win.getByRole('button', { name: 'Insert', exact: true }).click();
const search = win.getByLabel('Search items to add');
const firstResult = win.getByRole('listbox', { name: 'Results' }).getByRole('option').first();
for (const q of ['comparison', 'timetable', 'table']) {
  await search.fill(q);
  await eventually(async () => assert.match(await firstResult.innerText(), /^Data table/, `"${q}" finds the Data table first`));
}
await search.press('Enter');
await win.locator('#dock-panel-inspect .insp-name h3', { hasText: 'Data table' }).waitFor();
const tableEd = win.locator('#dock-panel-inspect [data-table="table"]');
const previewRows = () => frame.locator('.so-table__table tbody tr');
const headers = async () => (await frame.locator('.so-table__table thead th').allInnerTexts()).map((t) => t.trim());
await eventually(async () => assert.equal(await previewRows().count(), 3, 'the table starts with three workshops'));
assert.deepEqual(await headers(), ['Day', 'Workshop', 'Start time'], 'every column has a header cell');
const activeLabel = () => win.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.labels?.[0]?.textContent?.trim() ?? '');

// Add a fourth workshop, undo the addition, and redo it.
await tableEd.getByRole('button', { name: 'Add row' }).click();
await eventually(async () => assert.equal(await previewRows().count(), 4, 'a fourth row is added'));
await eventually(async () => assert.equal(await activeLabel(), 'Day', 'focus lands in the new row\'s first cell'));
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.equal(await previewRows().count(), 3, 'undo takes the new row away'));
await win.locator('[aria-label^="Redo"]').first().click();
await eventually(async () => assert.equal(await previewRows().count(), 4, 'redo brings it back'));
const rowHeads = tableEd.locator('.list-editor-head button.title');
if ((await rowHeads.nth(3).getAttribute('aria-expanded')) !== 'true') await rowHeads.nth(3).click();
await tableEd.getByLabel('Day', { exact: true }).fill('Friday');
await win.keyboard.press('Tab');
await tableEd.getByLabel('Workshop', { exact: true }).fill('Raku');
await win.keyboard.press('Tab');
await tableEd.getByLabel('Start time', { exact: true }).fill('17:00');
await win.keyboard.press('Enter');
await eventually(async () => assert.deepEqual((await previewRows().nth(3).locator('td').allInnerTexts()).map((t) => t.trim()), ['Friday', 'Raku', '17:00'], 'the new workshop shows in its row'));

// A cell typed and then left by clicking a column's move button keeps what was typed (each step names its cell).
await rowHeads.nth(0).click();
await tableEd.getByLabel('Start time', { exact: true }).fill('11:00');
await tableEd.getByRole('button', { name: 'Move column Start time left' }).click();
await eventually(async () => assert.deepEqual(await headers(), ['Day', 'Start time', 'Workshop'], 'the column moves with its header'));
await eventually(async () => assert.deepEqual((await previewRows().nth(0).locator('td').allInnerTexts()).map((t) => t.trim()), ['Monday', '11:00', 'Wheel throwing'], 'the typed time moved with its column'));
await eventually(async () => assert.match(await tableEd.locator('[role="status"]').innerText(), /Column Start time moved to position 2 of 3/, 'the new place is announced'));
assert.equal(await activeLabel(), 'Move column Start time left', 'focus stays on the button that moved the column');
await tableEd.getByLabel('Column 3 name').fill('Class');
await win.keyboard.press('Enter');
await eventually(async () => assert.deepEqual(await headers(), ['Day', 'Start time', 'Class'], 'a renamed column keeps its cells'));
// Remove row takes the row out and focus moves to the next row; Undo brings it back.
await tableEd.getByRole('button', { name: 'Remove row Wednesday · 18:30' }).click();
await eventually(async () => assert.equal(await previewRows().count(), 3, 'Remove row takes the row out'));
await eventually(async () => assert.equal(await win.evaluate(() => document.activeElement?.textContent?.trim()), 'Saturday · 09:30', 'focus moves to the next row'));
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.deepEqual((await previewRows().nth(1).locator('td').allInnerTexts()).map((t) => t.trim()), ['Wednesday', '18:30', 'Hand building'], 'undo puts the row back where it was'));
await win.locator('#dock-panel-inspect').getByLabel('Caption', { exact: true }).fill('Weekly workshops');
await win.keyboard.press('Enter');

// The saved table survives closing and reopening the project.
const savedTable = () => win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const about = Object.values(s.state.pages).find((p) => p.title === 'About');
  const node = Object.values(about.nodes).find((n) => n.kind === 'instance' && s.state.components[n.definitionId]?.componentId === 'data.table');
  return node.props.table;
});
await eventually(async () => assert.equal((await savedTable()).rows.length, 4));
const before179 = await savedTable();
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
const reopened = await win.evaluate((d) => window.builder.projects.open(d), dir);
assert.ok(reopened.ok, `the project reopens: ${JSON.stringify(reopened)}`);
await win.waitForSelector('.editor');
assert.deepEqual(await savedTable(), before179, 'the reopened table has the same columns, rows, cells and IDs');
await win.locator('.rail [aria-label="Pages"]').click();
await pageRow('About').click();
await eventually(async () => assert.equal(await previewRows().count(), 4, 'the reopened preview shows all four workshops'));

// On a narrow phone the table scrolls inside its own region, and the page does not scroll sideways.
const width = win.getByLabel('Preview width in pixels');
await width.fill('320');
await width.press('Enter');
await eventually(async () => {
  const fit = await frame.locator('html').evaluate(() => {
    const region = document.querySelector('.so-table__scroll');
    region.scrollLeft = region.scrollWidth;
    const last = region.querySelector('thead th:last-child').getBoundingClientRect();
    const box = region.getBoundingClientRect();
    return { page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth, region: region.scrollWidth, shown: region.clientWidth, last: [last.left, last.right], box: [box.left, box.right], focusable: region.tabIndex };
  });
  assert.equal(fit.view, 320, 'the preview is phone width');
  assert.ok(fit.page <= fit.view, `the page does not scroll sideways (${fit.page} > ${fit.view})`);
  assert.ok(fit.region > fit.shown, 'the table is wider than the phone, so its region scrolls');
  assert.ok(fit.last[0] >= fit.box[0] - 1 && fit.last[1] <= fit.box[1] + 1, `the last column can be scrolled into view (${fit.last} within ${fit.box})`);
  assert.equal(fit.focusable, 0, 'the scrolling region takes keyboard focus');
});
await win.screenshot({ path: join(OUT, '16-table-phone.png') });
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();

step('lists and links from buttons alone, in Insert, the Inspector and on the canvas (issue #43)');
await win.getByRole('button', { name: 'Insert', exact: true }).click();
const results = win.getByRole('listbox', { name: 'Results' }).getByRole('option');
for (const [q, first] of [['bulleted list', /^Bulleted list/], ['numbered list', /^Numbered list/]]) {
  await search.fill(q);
  await eventually(async () => assert.match(await results.first().innerText(), first, `"${q}" finds it first`));
}
await search.fill('list');
await eventually(async () => {
  const found = await results.allInnerTexts();
  assert.ok(found.some((t) => t.startsWith('Bulleted list')) && found.some((t) => t.startsWith('Numbered list')), `"list" finds both kinds of list: ${found.join(' | ')}`);
});
// A numbered list from Insert, then a bulleted one, which the rest of this step works on.
await search.fill('numbered list');
await eventually(async () => assert.match(await results.first().innerText(), /^Numbered list/));
await search.press('Enter');
await win.locator('#dock-panel-inspect .rich-field textarea').waitFor();
await search.fill('bulleted list');
await eventually(async () => assert.match(await results.first().innerText(), /^Bulleted list/));
await search.press('Enter');
const insp = win.locator('#dock-panel-inspect');
const listField = insp.locator('.rich-field textarea');
await listField.waitFor();
const tools = insp.getByRole('toolbar', { name: 'Text formatting' });
const listText = () =>
  win.evaluate(async () => {
    const s = await window.builder.project.snapshot();
    const about = Object.values(s.state.pages).find((p) => p.title === 'About');
    const node = Object.values(about.nodes).find((n) => n.kind === 'text' && n.rich && JSON.stringify(n.text).includes('Second item'));
    return node ? node.text : null;
  });
const words = (blocks) => blocks.flatMap((b) => (b.items ?? [b.spans]).map((it) => it.map((s) => s.text).join('')));
await eventually(async () => assert.deepEqual(await listText(), [{ type: 'ul', items: [[{ text: 'First item' }], [{ text: 'Second item' }], [{ text: 'Third item' }]] }], 'a real bulleted list is inserted'));
/** Put the field's caret (or selection) on `word`, as the author would, so the buttons follow it. */
const selectInField = async (word, whole) => {
  await listField.focus();
  await listField.evaluate((el, [w, all]) => {
    const i = el.value.indexOf(w);
    el.setSelectionRange(all ? i : i + 1, all ? i + w.length : i + 1);
    el.dispatchEvent(new Event('select'));
  }, [word, whole]);
  assert.equal(await listField.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd)), whole ? word : '', `the field selects ${whole ? word : 'a caret in it'}`);
};
// Move an item with the pointer: one Undo step, which Redo puts back.
await selectInField('Second item', false);
await tools.getByRole('button', { name: 'Move item up' }).click();
await eventually(async () => assert.deepEqual(words(await listText()), ['Second item', 'First item', 'Third item'], 'the item moves up'));
await win.locator('[aria-label^="Undo"]').first().click();
await eventually(async () => assert.deepEqual(words(await listText()), ['First item', 'Second item', 'Third item'], 'one Undo puts it back'));
await win.locator('[aria-label^="Redo"]').first().click();
await eventually(async () => assert.deepEqual(words(await listText()), ['Second item', 'First item', 'Third item'], 'Redo moves it again'));
// Link selected words through the link field: no Markdown typed.
await eventually(async () => assert.match(await listField.inputValue(), /^- Second item\n- First item\n- Third item$/));
await selectInField('Third item', true);
await tools.getByRole('button', { name: 'Link', exact: true }).click();
await insp.getByRole('textbox', { name: 'Link destination' }).fill('/about/');
await insp.getByRole('textbox', { name: 'Link destination' }).press('Enter');
await eventually(async () => {
  const blocks = await listText();
  const about = await win.evaluate(async () => Object.values((await window.builder.project.snapshot()).state.pages).find((p) => p.title === 'About').id);
  assert.deepEqual(blocks[0].items[2], [{ text: 'Third item', link: { type: 'page', target: about } }], 'the words link to the About page by its ID');
});
// From the keyboard: Tab reaches the buttons, the arrow keys move along them, and Enter makes the list numbered.
await selectInField('First item', false);
await win.keyboard.press('Tab');
await win.keyboard.press('Home');
await win.keyboard.press('ArrowRight');
await win.keyboard.press('ArrowRight');
await eventually(async () => assert.equal(await activeLabel(), 'Numbered list', 'the arrow keys move along the toolbar'));
await win.keyboard.press('Enter');
await eventually(async () => assert.equal((await listText())[0].type, 'ol', 'the list is numbered'));
assert.equal(await activeLabel(), 'Numbered list', 'focus stays on the button');
// On the canvas, from the keyboard alone: the selection's More actions start the edit, Tab reaches the toolbar,
// and its commands run on the text's selection. The whole edit is then one change.
const listOnPage = frame.locator('.so-rich', { hasText: 'Second item' }).first();
await eventually(async () => assert.equal(await listOnPage.locator('ol > li').count(), 3, 'the page shows a numbered list'));
await win.screenshot({ path: join(OUT, '17-list.png') });
await win.locator('.ov-chip [aria-haspopup="menu"]').focus();
await win.keyboard.press('Enter');
await win.getByRole('menuitem', { name: 'Edit text', exact: true }).press('Enter');
await eventually(async () => assert.equal(await listOnPage.getAttribute('contenteditable'), 'true', 'the list is being edited'));
await listOnPage.evaluate((el) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue === 'Second item') return getSelection().collapse(n, 2);
});
const pageTools = frame.getByRole('toolbar', { name: 'Text formatting' });
await pageTools.waitFor();
const focusedTool = () => frame.locator('html').evaluate(() => document.activeElement?.shadowRoot?.activeElement?.getAttribute('aria-label') ?? null);
await win.keyboard.press('Tab');
await win.keyboard.press('End');
await eventually(async () => assert.equal(await focusedTool(), 'Move item down', 'End reaches the last button'));
await win.keyboard.press('Enter');
await eventually(async () => assert.deepEqual(await listOnPage.locator('li').allInnerTexts(), ['First item', 'Second item', 'Third item'], 'the item moves down on the page'));
// Back to a bulleted list, still from the keyboard: the whole list changes kind.
await win.keyboard.press('Tab');
await win.keyboard.press('Home');
await win.keyboard.press('ArrowRight');
await eventually(async () => assert.equal(await focusedTool(), 'Bulleted list'));
await win.keyboard.press('Enter');
await eventually(async () => assert.equal(await listOnPage.locator('ul > li').count(), 3, 'the list is bulleted again'));
const applied = () => win.evaluate(async () => (await window.builder.project.snapshot()).history.entries.filter((e) => e.applied).length);
const historyBefore = await applied();
await win.keyboard.press(`${MOD}+Enter`);
await eventually(async () => assert.deepEqual(words(await listText()), ['First item', 'Second item', 'Third item'], 'the move is saved'));
assert.equal((await listText())[0].type, 'ul', 'the list is saved bulleted');
assert.equal(await applied(), historyBefore + 1, 'the canvas edit is one Undo step');
await eventually(async () => assert.equal(await pageTools.count(), 0, 'the toolbar goes when the edit ends'));

step('export static');
const t0 = Date.now();
const exportDir = join(WORK, 'export-static');
const er = await win.evaluate((dest) => window.builderTest.exportStatic(dest), exportDir);
console.log('export:', er.message, Date.now() - t0, 'ms');
assert.equal(er.ok, true, `static export succeeds: ${er.message} ${er.warnings?.join(' ')}`);
const about = readFileSync(join(exportDir, 'about/index.html'), 'utf8');
assert.ok(about.includes('A small studio with a long view'), 'the About page is prerendered with its content');
assert.doesNotMatch(about, /data-so-|siteorigin-bridge/, 'no editor markup in the export');
assert.deepEqual([...about.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]), ['Day', 'Start time', 'Class'], 'each exported column has a header cell');
assert.match(about, /<caption id="([^"]+)"[^>]*>Weekly workshops<\/caption>/, 'the exported table has its caption');
assert.match(about, /role="region" tabindex="0" aria-labelledby="[^"]+"/, 'the exported table scrolls in a named, focusable region');
assert.match(about.replace(/<!--[\s\S]*?-->/g, ''), /<td[^>]*>Friday<\/td><td[^>]*>17:00<\/td><td[^>]*>Raku<\/td>/, 'the fourth workshop is exported with each cell under its column');
const aboutMarkup = about.replace(/<!--[\s\S]*?-->/g, '');
assert.match(aboutMarkup, /<ul[^>]*><li>First item<\/li><li>Second item<\/li><li><a[^>]*href="(\.\.)?\/about\/"[^>]*>Third item<\/a><\/li><\/ul>/, 'the bulleted list is exported as a real list, with its link');
assert.match(aboutMarkup, /<ol[^>]*><li>First step<\/li><li>Second step<\/li><li>Third step<\/li><\/ol>/, 'the numbered list is exported as a real numbered list');
assert.ok(readFileSync(join(exportDir, 'index.html'), 'utf8').includes('Rooms that work beautifully'), 'the exported home page has the edited heading');
assert.ok(!readdirSync(exportDir).includes('.siteorigin'), 'no editor state in the export');

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nflows: passed');
