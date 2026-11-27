// Insert's thumbnails of Your components and the site's brand colour (#972): a change of the brand colour draws again
// only the thumbnails of components that show it, and the picture every other one keeps is the one a new photograph
// of it gives. Two cards, one on the brand colour; the colour changes; then the project is opened again with its
// thumbnails deleted, so each is photographed afresh in the same launch (where the same picture comes out byte for
// byte), and each must match what Insert showed.
//
// Run: npm run build && node tests/e2e/thumbs-brand.mjs
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, cleanup } = scratch('thumbs-brand');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Brand Cards', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const captures = () => win.evaluate(() => window.builderTest.thumbCaptures());
const panel = win.locator('.side-panel-view:not([hidden])');
const tile = (name) => panel.locator('.insert-tile.project', { has: win.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
const openInsert = async () => {
  const group = panel.locator('.insert-group[data-kind="component"]');
  if (!(await group.isVisible())) await win.getByRole('button', { name: 'Insert', exact: true }).click();
  await group.waitFor();
  const more = panel.locator('button.insert-more', { hasText: /^Show all/ });
  if (await more.isVisible()) await more.click();
};
/** The picture a tile shows (a data URL), once it shows one. */
const picture = async (name) => {
  await tile(name).scrollIntoViewIfNeeded();
  const img = tile(name).locator('.component-thumb img.insert-shot');
  await img.waitFor({ timeout: 90000 });
  return img.getAttribute('src');
};
/** Until no photograph has been taken for a while. */
const quiet = async () => {
  let n = await captures();
  for (let still = 0; still < 4; ) {
    await win.waitForTimeout(700);
    const m = await captures();
    still = m === n ? still + 1 : 0;
    n = m;
  }
  return n;
};

step('two cards, one on the brand colour, each with its thumbnail');
const card = (name) => ({ type: 'component.upsert', name, properties: {}, nodes: [{ kind: 'element', id: 'root', tag: 'article', children: ['title', 'body'] }, { kind: 'text', id: 'title', tag: 'h3', text: name }, { kind: 'text', id: 'body', tag: 'p', text: 'A card of the brand test.' }] });
const [{ definitionId: plainId }, { definitionId: brandId }] = await apply([card('Plain card'), card('Brand card')], 'Two cards');
const st = await snapshot();
await apply([{ type: 'node.setStyle', owner: { kind: 'component', id: brandId }, nodeId: st.components[brandId].tree.rootIds[0], scope: 'base', property: 'background', value: { token: 'color.brand' } }], 'Brand card on the brand colour');
await openInsert();
const plainBefore = await picture('Plain card');
const brandBefore = await picture('Brand card');
const drawn = await quiet();
assert.ok(drawn >= 2, `both cards are photographed (${drawn})`);
assert.ok(plainId && brandId);

step('a brand colour change draws again only the card that shows it');
await apply([{ type: 'token.set', tokenId: 'color.brand', value: '#1f7a5c' }], 'Green brand');
await eventually(async () => assert.notEqual(await picture('Brand card'), brandBefore, 'the card on the brand colour is drawn again'), 90000);
const after = await quiet();
assert.equal(after - drawn, 1, `one photograph for the brand change, of the card that shows it (${after - drawn})`);
const plainKept = await picture('Plain card');
const brandAfter = await picture('Brand card');
assert.equal(plainKept, plainBefore, 'the card that never shows the brand colour keeps its picture');

step('what each card keeps is what a new photograph of it gives');
const dir = await win.evaluate(async () => (await window.builder.project.snapshot()).dir);
await win.evaluate(() => window.builder.projects.close());
await win.waitForSelector('.welcome');
const thumbs = join(dir, '.siteorigin', 'cache', 'thumbs');
rmSync(thumbs, { recursive: true, force: true });
assert.equal(existsSync(thumbs), false);
const opened = await win.evaluate((d) => window.builder.projects.open(d), dir);
assert.ok(opened.ok, `the project opens again (${opened.message ?? ''})`);
await win.waitForSelector('.editor');
await openInsert();
const plainFresh = await picture('Plain card');
const brandFresh = await picture('Brand card');
const again = await quiet();
assert.equal(again - after, 2, `both photographed afresh (${again - after})`);
assert.equal(plainFresh, plainKept, 'the plain card’s kept picture is the one a new photograph gives');
assert.equal(brandFresh, brandAfter, 'and the brand card’s');

step('nothing of the thumbnails’ window is ever shown or focused');
const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ editor: w.webContents.getURL().startsWith('app://'), visible: w.isVisible(), focused: w.isFocused() })));
assert.ok(windows.every((w) => !w.visible && (w.editor || !w.focused)), `no window is shown, and the thumbnails' never takes focus (${JSON.stringify(windows)})`);

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nthumbs-brand: passed');
