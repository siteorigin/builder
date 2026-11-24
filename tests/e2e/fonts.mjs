// Imported fonts against the real app (issue 247): the editor's samples are drawn in the imported files themselves,
// each file in Assets says what it covers and shows itself, removing a file of a family the site uses says what
// changes first and does what the author chose, and upright, italic and Cyrillic text paint in the imported files in
// the canvas and the exported site. What painted is read from Chromium itself (CSS.getPlatformFontsForNode), the
// same evidence the issue was reported with.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('fonts');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Type Specimen', parentDir: join(WORK, 'sites'), starter: 'blank' });

const files = (pkg) => resolve('node_modules/@fontsource-variable', pkg, 'files');
const LORA = files('lora');
const JAKARTA = files('plus-jakarta-sans');
const paths = [
  join(LORA, 'lora-latin-wght-normal.woff2'),
  join(LORA, 'lora-latin-wght-italic.woff2'),
  join(LORA, 'lora-cyrillic-wght-normal.woff2'),
  join(JAKARTA, 'plus-jakarta-sans-latin-wght-normal.woff2'),
  join(JAKARTA, 'plus-jakarta-sans-latin-wght-italic.woff2')
];
const snapshot = () => win.evaluate(() => window.builder.project.snapshot());
const apply = async (operations, label) => {
  const r = await win.evaluate(([operations, label]) => window.builder.project.apply({ operations }, { label }), [operations, label]);
  assert.ok(r.ok, `${label}: ${r.error?.message}`);
  return r.results;
};
const undo = () => win.evaluate(() => window.builder.project.undo());

/** The fonts Chromium painted a node's own text with, through a CDP session on its page or frame. */
async function painted(target, selector) {
  const cdp = await win.context().newCDPSession(target);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    assert.ok(nodeId, `${selector} is on the page`);
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    return fonts;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}
/** Every glyph of the node's text came from one imported file whose PostScript name matches `name`. */
async function paintedWith(target, selector, name, what) {
  await eventually(async () => {
    const fonts = await painted(target, selector);
    assert.ok(fonts.length > 0, `${what}: some text was painted`);
    for (const f of fonts) {
      assert.equal(f.isCustomFont, true, `${what}: painted with an imported file, not ${f.familyName} (${f.postScriptName})`);
      assert.match(f.postScriptName, name, `${what}: painted with ${name}, not ${f.postScriptName}`);
    }
  }, 20000);
}
const canvasFrame = () => win.frames().find((f) => f.url().startsWith('http://127.0.0.1'));

step('import Latin upright and italic Lora, Cyrillic upright Lora, and upright and italic Plus Jakarta Sans');
const imported = await win.evaluate((p) => window.builder.project.importAssets(p, 'font'), paths);
assert.equal(imported.ok, true, `the fonts import: ${imported.message}`);
assert.equal(imported.assetIds.length, 5, 'five font files');
const assets = (await snapshot()).state.assets.assets;
const idOf = (file) => imported.assetIds.find((id) => assets[id].file.includes(file));
const ids = {
  loraLatin: idOf('lora-latin-wght-normal'),
  loraItalic: idOf('lora-latin-wght-italic'),
  loraCyrillic: idOf('lora-cyrillic-wght-normal'),
  sans: idOf('plus-jakarta-sans-latin-wght-normal'),
  sansItalic: idOf('plus-jakarta-sans-latin-wght-italic')
};
assert.ok(Object.values(ids).every(Boolean), `every file is found: ${JSON.stringify(ids)}`);

step('Lora for headings, Plus Jakarta Sans for body text, and a section of upright, italic and Cyrillic text');
await apply(
  [
    { type: 'token.set', tokenId: 'font.display', value: "'Lora', system-ui, sans-serif" },
    { type: 'token.set', tokenId: 'font.body', value: "'Plus Jakarta Sans', system-ui, sans-serif" }
  ],
  'Choose fonts'
);
const homeId = (await snapshot()).state.site.homePageId;
const owner = { kind: 'page', id: homeId };
const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner, componentId: 'layout.section' }], 'Insert section');
// Latin and Cyrillic in headings of their own: the two upright Lora files share a PostScript name, so only a node
// with one alphabet shows which file (or fallback) drew it.
await apply([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'heading', text: 'Harbour' }], 'Insert heading');
await apply([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'heading', text: 'Гавань' }], 'Insert Cyrillic heading');
const [{ nodeId: body }] = await apply([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'richtext', text: 'Upright body text' }], 'Insert text');
// Apart, since Chromium counts an inline child's glyphs among its paragraph's.
await apply([{ type: 'node.setContent', owner, nodeId: body, field: 'text', value: [{ type: 'p', spans: [{ text: 'Upright body text' }] }, { type: 'p', spans: [{ text: 'italic words', em: true }] }] }], 'Write text');

step('the canvas paints Latin and Cyrillic headings in Lora, and upright and italic body text in their own files');
await frame.locator('h2, h1', { hasText: 'Harbour' }).first().waitFor();
await frame.locator('h2, h1', { hasText: 'Гавань' }).first().waitFor();
await frame.locator('em', { hasText: 'italic words' }).waitFor();
await canvasFrame().evaluate(() => document.fonts.ready);
const latinSel = 'main :is(h1, h2):first-of-type';
const cyrillicSel = 'main :is(h1, h2):nth-of-type(2)';
const uprightSel = 'main p:not(:has(em))';
const italicSel = 'main p em';
await paintedWith(canvasFrame(), latinSel, /^Lora-/, 'the canvas Latin heading');
await paintedWith(canvasFrame(), cyrillicSel, /^Lora-/, 'the canvas Cyrillic heading');
await paintedWith(canvasFrame(), uprightSel, /^PlusJakartaSans-(?!.*Italic)/, 'the canvas body text');
await paintedWith(canvasFrame(), italicSel, /^PlusJakartaSans-.*Italic/, 'the canvas italic words');

step('Site styles draws its samples in the imported files');
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
await win.locator('#dock-panel-styles').waitFor();
await win.locator('[data-token-id="font.display"] .ss-font-sample').waitFor();
await paintedWith(win, '[data-token-id="font.display"] .ss-font-sample', /^Lora-/, 'the heading font’s “Aa”');
await paintedWith(win, '[data-token-id="font.body"] .ss-font-sample', /^PlusJakartaSans-/, 'the body font’s “Aa”');
await paintedWith(win, '#dock-panel-styles .ss-look-type', /^Lora-/, 'the overview’s “Aa”');
await paintedWith(win, '#dock-panel-styles [data-token-id^="text."] .ss-specimen', /^(Lora|PlusJakartaSans)-/, 'the first text style’s specimen');
// The editor's own text keeps its font: the imported families are loaded under names of the editor's own.
const chrome = await painted(win, '#dock-panel-styles [data-token-id="font.display"] label');
assert.ok(chrome.length > 0 && chrome.reduce((n, f) => n + f.glyphCount, 0) > 0, 'the label was painted');
assert.ok(chrome.every((f) => !f.isCustomFont), `the editor's labels keep the system font: ${JSON.stringify(chrome)}`);

step('Assets names each file by style, weight, alphabet and file, and shows it in its own face');
await win.getByRole('button', { name: 'Assets', exact: true }).click();
await win.locator('aside.side-panel').getByRole('tab', { name: /^Fonts/ }).click();
const row = (id) => win.locator(`.font-face[data-font-file="${assets[id].file.split('/').pop()}"]`);
await eventually(async () => assert.match(await row(ids.loraLatin).locator('.font-face-meta').innerText(), /Variable \(400–700\) · Latin · .* · Family in use/));
await eventually(async () => assert.match(await row(ids.loraCyrillic).locator('.font-face-meta').innerText(), /Variable \(400–700\) · Cyrillic · /));
await eventually(async () => assert.match(await row(ids.loraItalic).locator('.font-face-meta').innerText(), /Variable \(400–700\) italic · Latin/));
await eventually(async () => assert.match(await row(ids.sans).locator('.font-face-meta').innerText(), /Variable \(200–800\) · Latin/));
assert.equal(await row(ids.loraCyrillic).locator('.font-face-file').innerText(), 'lora-cyrillic-wght-normal.woff2', 'the row names the file it was imported from');
assert.equal(await row(ids.loraCyrillic).locator('.font-face-sample').innerText(), 'Аа Бб Жж', 'the Cyrillic file shows Cyrillic letters');
await paintedWith(win, `[data-font-sample="${ids.loraCyrillic}"]`, /^Lora-/, 'the Cyrillic file’s sample');
await paintedWith(win, `[data-font-sample="${ids.loraItalic}"]`, /^Lora-.*Italic/, 'the italic file’s sample');
await paintedWith(win, `[data-font-sample="${ids.sans}"]`, /^PlusJakartaSans-(?!.*Italic)/, 'the upright body file’s sample');
const removeButton = (id) => row(id).getByRole('button', { name: /^Remove / });
const dialog = win.getByTestId('remove-font-dialog');

step('removing the upright body file says body text would turn italic, and Cancel keeps it');
await removeButton(ids.sans).click();
await dialog.waitFor();
const said = await dialog.innerText();
assert.match(said, /Your site uses Plus Jakarta Sans in 1 place/);
assert.match(said, /Body/);
assert.match(said, /Upright text in Plus Jakarta Sans would be drawn with its italic file \(plus-jakarta-sans-latin-wght-italic\.woff2\): ordinary paragraphs and headings set in it would turn italic\./);
assert.equal(await win.getByRole('button', { name: 'Remove file' }).isDisabled(), true, 'nothing is removed until the author chooses');
await win.getByRole('button', { name: 'Cancel' }).click();
await dialog.waitFor({ state: 'detached' });
assert.ok((await snapshot()).state.assets.assets[ids.sans], 'Cancel keeps the file');

step('knowingly keeping the family on its italic file draws body text in italic, and Undo brings the upright back');
await removeButton(ids.sans).click();
await dialog.getByRole('radio', { name: /Keep using Plus Jakarta Sans’s other file/ }).check();
await win.getByRole('button', { name: 'Remove file' }).click();
await dialog.waitFor({ state: 'detached' });
await eventually(async () => assert.equal((await snapshot()).state.assets.assets[ids.sans], undefined, 'the upright file is gone'));
await paintedWith(canvasFrame(), uprightSel, /^PlusJakartaSans-.*Italic/, 'body text, as the dialog said');
assert.equal((await undo()).ok, true);
await paintedWith(canvasFrame(), uprightSel, /^PlusJakartaSans-(?!.*Italic)/, 'body text after Undo');

step('choosing another font moves body text to it in one step');
await row(ids.sans).waitFor();
await removeButton(ids.sans).click();
await dialog.getByRole('radio', { name: 'Use another font instead' }).check();
await dialog.getByLabel('Font to use instead').selectOption({ label: 'Lora' });
await win.getByRole('button', { name: 'Remove file' }).click();
await dialog.waitFor({ state: 'detached' });
await eventually(async () => assert.equal((await snapshot()).state.tokens.overrides['font.body'], "'Lora', system-ui, sans-serif", 'body text uses Lora'));
const replaced = (await snapshot()).state.assets.assets;
assert.equal(replaced[ids.sans], undefined, 'the chosen file is gone');
assert.ok(replaced[ids.sansItalic], 'its sibling stays in Assets');
await paintedWith(canvasFrame(), uprightSel, /^Lora-/, 'body text in the replacement');
assert.equal((await undo()).ok, true);
await eventually(async () => assert.ok((await snapshot()).state.assets.assets[ids.sans], 'one Undo brings the file back'));
assert.equal((await snapshot()).state.tokens.overrides['font.body'], "'Plus Jakarta Sans', system-ui, sans-serif", 'and body text’s font');

step('removing the Cyrillic file says which letters would fall back, and they do');
await row(ids.loraCyrillic).waitFor();
await removeButton(ids.loraCyrillic).click();
await eventually(async () => assert.match(await dialog.innerText(), /Cyrillic letters in upright Lora would be drawn with a fallback font: that file doesn’t have them\./));
await dialog.getByRole('radio', { name: /Keep using Lora’s other files/ }).check();
await win.getByRole('button', { name: 'Remove file' }).click();
await dialog.waitFor({ state: 'detached' });
await eventually(async () => {
  const fonts = await painted(canvasFrame(), cyrillicSel);
  assert.ok(fonts.length > 0 && fonts.every((f) => !f.isCustomFont), `Cyrillic falls back, as the dialog said: ${JSON.stringify(fonts)}`);
}, 20000);
await paintedWith(canvasFrame(), latinSel, /^Lora-/, 'the Latin heading, still in Lora');
assert.equal((await undo()).ok, true);
await paintedWith(canvasFrame(), cyrillicSel, /^Lora-/, 'the Cyrillic heading after Undo');

step('the last file of a family falls back when the author lets it');
await row(ids.sansItalic).waitFor();
await removeButton(ids.sansItalic).click();
await dialog.getByRole('radio', { name: /Keep using Plus Jakarta Sans’s other file/ }).check();
await win.getByRole('button', { name: 'Remove file' }).click();
await dialog.waitFor({ state: 'detached' });
await removeButton(ids.sans).click();
await eventually(async () => assert.match(await dialog.innerText(), /Text set in Plus Jakarta Sans would be drawn with the next font of each style that names it/));
assert.equal(await dialog.getByRole('radio', { name: /Keep using/ }).count(), 0, 'the last file cannot be kept');
await dialog.getByRole('radio', { name: 'Let them fall back' }).check();
await win.getByRole('button', { name: 'Remove file' }).click();
await dialog.waitFor({ state: 'detached' });
await eventually(async () => {
  const s = (await snapshot()).state;
  assert.equal(s.assets.assets[ids.sans], undefined, 'the last file is gone');
  assert.equal(s.tokens.overrides['font.body'], 'system-ui, sans-serif', 'body text falls back');
});
await eventually(async () => {
  const fonts = await painted(canvasFrame(), uprightSel);
  assert.ok(fonts.length > 0 && fonts.every((f) => !f.isCustomFont), `body text is in the fallback font: ${JSON.stringify(fonts)}`);
}, 20000);
assert.equal((await undo()).ok, true);
assert.equal((await undo()).ok, true);
await eventually(async () => {
  const s = (await snapshot()).state;
  assert.ok(s.assets.assets[ids.sans] && s.assets.assets[ids.sansItalic], 'two Undos bring both files back');
  assert.equal(s.tokens.overrides['font.body'], "'Plus Jakarta Sans', system-ui, sans-serif");
});
await paintedWith(canvasFrame(), uprightSel, /^PlusJakartaSans-(?!.*Italic)/, 'body text after Undo');

step('the exported site paints the same files');
const exportDir = join(WORK, 'export-site');
const er = await withTimeout(win.evaluate((dest) => window.builderTest.exportStatic(dest), exportDir), 300000, 'Static export');
assert.ok(er.ok, `export succeeded: ${er.message}`);
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    let path = normalize(join(exportDir, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(exportDir)) throw new Error('outside');
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const [tab] = await Promise.all([
  app.waitForEvent('window'),
  app.evaluate(({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true } });
    void w.loadURL(url);
  }, url)
]);
await tab.waitForLoadState('load');
await tab.evaluate(() => document.fonts.ready);
await paintedWith(tab, latinSel, /^Lora-/, 'the exported Latin heading');
await paintedWith(tab, cyrillicSel, /^Lora-/, 'the exported Cyrillic heading');
await paintedWith(tab, uprightSel, /^PlusJakartaSans-(?!.*Italic)/, 'the exported body text');
await paintedWith(tab, italicSel, /^PlusJakartaSans-.*Italic/, 'the exported italic words');
await tab.close();
server.close();

assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();
cleanup();
console.log('\nfonts: passed');
