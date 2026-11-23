// Export integrity (spec I07, I09): export the static site and the source project through the real
// controller (native save dialogs stubbed), then scan both for editor state, credentials, editor markup,
// deleted images and library images kept for later (only the editable project carries those). With --build, the exported source is also installed and built with plain
// `npm ci && npm run build`, as on a clean machine (slow, and needs the npm registry).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, delimiter, join, sep } from 'node:path';
import { createProject, eventually, launch, scratch, step, withTimeout } from './harness.mjs';

// ---------------------------------------------------------------------------
// A phone photo's metadata, written and read back by hand (little-endian EXIF and an XMP packet)
// ---------------------------------------------------------------------------

const u16le = (n) => Buffer.from([n & 255, n >> 8]);
const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const asciiField = (tag, s) => ({ tag, type: 2, count: s.length + 1, value: Buffer.from(s + '\0', 'latin1') });
const SERIAL = 'SERIAL-E2E-0042';
const MAKE = 'Acme Phones';

/** EXIF with orientation 6, a camera make, model and serial, GPS coordinates, and an artist and copyright. */
function phoneExif() {
  const dirs = [
    [asciiField(0x010f, MAKE), asciiField(0x0110, 'Pocket 9'), { tag: 0x0112, type: 3, count: 1, value: u16le(6) }, asciiField(0x013b, 'Jane Doe Photography'), asciiField(0x8298, '(c) 2026 Jane Doe'), { tag: 0x8769, ptr: 1 }, { tag: 0x8825, ptr: 2 }],
    [asciiField(0xa431, SERIAL)],
    [asciiField(0x0001, 'N'), { tag: 0x0002, type: 5, count: 3, value: Buffer.concat([51, 1, 30, 1, 1234, 100].map(u32le)) }, asciiField(0x0003, 'W'), { tag: 0x0004, type: 5, count: 3, value: Buffer.concat([0, 1, 7, 1, 3900, 100].map(u32le)) }]
  ];
  const size = (d) => 2 + d.length * 12 + 4 + d.reduce((n, e) => n + (e.value && e.value.length > 4 ? e.value.length + (e.value.length & 1) : 0), 0);
  const starts = [8];
  for (let k = 1; k < dirs.length; k++) starts.push(starts[k - 1] + size(dirs[k - 1]));
  const parts = [Buffer.from('II*\0', 'latin1'), u32le(8)];
  dirs.forEach((d, k) => {
    let data = starts[k] + 2 + d.length * 12 + 4;
    const tail = [];
    parts.push(u16le(d.length));
    for (const e of d) {
      if (e.ptr) {
        parts.push(u16le(e.tag), u16le(4), u32le(1), u32le(starts[e.ptr]));
        continue;
      }
      parts.push(u16le(e.tag), u16le(e.type), u32le(e.count));
      if (e.value.length <= 4) parts.push(Buffer.concat([e.value, Buffer.alloc(4 - e.value.length)]));
      else {
        parts.push(u32le(data));
        tail.push(e.value, Buffer.alloc(e.value.length & 1));
        data += e.value.length + (e.value.length & 1);
      }
    }
    parts.push(u32le(0), ...tail);
  });
  return Buffer.concat(parts);
}
const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
const PHONE_XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="51,30.2N" exif:GPSLongitude="0,7.65W">' +
  '<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>';

/** A JPEG with the phone metadata added after its JFIF header. */
function withPhoneMetadata(jpeg) {
  const at = 4 + jpeg.readUInt16BE(4);
  const exif = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), phoneExif()]));
  const xmp = segment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(PHONE_XMP)]));
  return Buffer.concat([jpeg.subarray(0, at), exif, xmp, jpeg.subarray(at)]);
}

/** What a JPEG says about itself: its first EXIF directory's tags, orientation and credits, and its XMP. */
function jpegMetadata(buf) {
  const out = { tags: [], orientation: undefined, artist: undefined, copyright: undefined, xmp: '' };
  for (let i = 2; i + 4 <= buf.length && buf[i] === 0xff && buf[i + 1] !== 0xda; ) {
    const len = buf.readUInt16BE(i + 2);
    const payload = buf.subarray(i + 4, i + 2 + len);
    if (buf[i + 1] === 0xe1 && payload.toString('latin1', 0, 6) === 'Exif\0\0') {
      const t = payload.subarray(6);
      assert.equal(t.toString('latin1', 0, 2), 'II', 'the EXIF keeps its byte order');
      const ifd = t.readUInt32LE(4);
      for (let k = 0; k < t.readUInt16LE(ifd); k++) {
        const e = ifd + 2 + k * 12;
        const tag = t.readUInt16LE(e);
        out.tags.push(tag);
        const count = t.readUInt32LE(e + 4);
        const text = () => (count <= 4 ? t.subarray(e + 8, e + 8 + count) : t.subarray(t.readUInt32LE(e + 8), t.readUInt32LE(e + 8) + count)).toString('latin1').replace(/\0+$/, '');
        if (tag === 0x0112) out.orientation = t.readUInt16LE(e + 8);
        if (tag === 0x013b) out.artist = text();
        if (tag === 0x8298) out.copyright = text();
      }
    }
    if (buf[i + 1] === 0xe1 && payload.toString('latin1', 0, 29) === 'http://ns.adobe.com/xap/1.0/\0') out.xmp += payload.subarray(29).toString('utf8');
    i += 2 + len;
  }
  return out;
}

/** Assert a published copy of the photo carries no location or device details, and keeps its credits. */
function assertPublicPhoto(buf, label, { original }) {
  const text = buf.toString('latin1');
  assert.ok(!text.includes(SERIAL) && !text.includes(MAKE) && !text.includes('Pocket 9'), `${label} has no camera make, model or serial`);
  const m = jpegMetadata(buf);
  assert.ok(!m.tags.includes(0x8825), `${label} has no GPS directory`);
  assert.ok(!/GPS/.test(m.xmp), `${label} has no GPS in its XMP`);
  assert.equal(m.artist, 'Jane Doe Photography', `${label} keeps the photographer credit`);
  assert.equal(m.copyright, '(c) 2026 Jane Doe', `${label} keeps the copyright`);
  assert.match(m.xmp, /<rdf:li>Jane Doe<\/rdf:li>/, `${label} keeps the XMP creator`);
  assert.equal(m.orientation, original ? 6 : undefined, original ? `${label} keeps its orientation tag` : `${label} is already upright and has no orientation tag`);
}

const BUILD = process.argv.includes('--build');
const { WORK, cleanup } = scratch('export');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const dir = join(WORK, 'sites', 'harbour-lane-studio');

step('a rotated, geotagged phone photo placed on Home');
// A real JPEG, encoded by Chromium, stored on its side: 1200 × 2000 with red in its stored top-left corner, so
// orientation 6 shows it 2000 × 1200 with red at the top right.
const sideways = Buffer.from(
  await win.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 2000;
    const g = c.getContext('2d');
    g.fillStyle = '#1040c0';
    g.fillRect(0, 0, 1200, 2000);
    g.fillStyle = '#e01010';
    g.fillRect(0, 0, 300, 300);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }),
  'base64'
);
const photoPath = join(WORK, 'client-house.jpg');
writeFileSync(photoPath, withPhoneMetadata(sideways));
const photoHash = createHash('sha256').update(readFileSync(photoPath)).digest('hex');
const photoImport = await win.evaluate((p) => window.builder.project.importAssets([p]), photoPath);
assert.equal(photoImport.ok, true, `the photo imports: ${photoImport.message}`);
const photoId = photoImport.assetIds[0];
const photo = (await win.evaluate(() => window.builder.project.snapshot())).state.assets.assets[photoId];
assert.deepEqual([photo.width, photo.height], [2000, 1200], 'the photo is recorded as it is displayed');
assert.deepEqual(photo.variants.map((v) => v.width), [480, 960, 1440], 'the photo has three responsive copies');
const homeHero = await win.evaluate(async () => {
  const s = await window.builder.project.snapshot();
  const home = s.state.pages[s.state.site.homePageId];
  return { pageId: home.id, heroId: home.rootIds[0] };
});
const placed = await win.evaluate(
  ([h, id]) => window.builder.project.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: h.pageId }, nodeId: h.heroId, prop: 'image', value: { assetId: id, alt: 'The front of the house' } }] }, { label: 'Hero image' }),
  [homeHero, photoId]
);
assert.equal(placed.ok, true, `the photo is placed in the Home hero: ${placed.error?.message}`);
// Let the preview show it before the next edit, so two hot updates of the page never overlap.
await frame.locator(`main img[src*="${basename(photo.file).replace(/\.jpg$/, '')}"]`).first().waitFor({ timeout: 60000 });
await win.waitForTimeout(1000);
assert.deepEqual(await win.evaluate((id) => window.builder.project.photoMetadata(id), photoId), { location: true, device: true }, 'Assets can tell the author the photo records where it was taken');
const photoFiles = [photo.file, ...photo.variants.map((v) => v.file)];

step('a saved API key, private files, and an image that was imported and then deleted');
const CANARY = 'sk-i09-canary-0123456789abcdef';
const saved = await win.evaluate(async (k) => (await window.builder.ai.setKey('openai', k)).find((p) => p.id === 'openai'), CANARY);
assert.equal(saved.configured, true, 'the canary key is saved');
// Private files a user might keep in their project folder; neither export may include them.
writeFileSync(join(dir, '.env.local'), `OPENAI_API_KEY=${CANARY}\n`);
writeFileSync(join(dir, 'static', 'deploy-key.pem'), `${CANARY}\n`);
const svgPath = join(WORK, 'deleted-mark.svg');
writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" fill="#5d2b8a"/></svg>\n');
const imported = await win.evaluate((p) => window.builder.project.importAssets([p]), svgPath);
assert.equal(imported.ok, true, `the image imports: ${imported.message}`);
const [assetId] = imported.assetIds;
const record = (await win.evaluate(() => window.builder.project.snapshot())).state.assets.assets[assetId];
const deletedFiles = [record.file, ...(record.variants ?? []).map((v) => v.file)].map((f) => basename(f));
assert.ok(existsSync(join(dir, record.file)), `the imported file is in the project (${record.file})`);
const removed = await win.evaluate((id) => window.builder.project.apply({ operations: [{ type: 'asset.remove', assetId: id }] }, { label: 'Delete image' }), assetId);
assert.equal(removed.ok, true, 'the unused image is deleted');
const after = (await win.evaluate(() => window.builder.project.snapshot())).state;
assert.equal(after.assets.assets[assetId], undefined, 'the deleted image has no asset record');
// A starter image the site still shows: both exports must keep it.
const used = Object.values(after.assets.assets).find((a) => JSON.stringify(after.pages).includes(`"${a.id}"`));
assert.ok(used, 'the starter uses at least one image');
const usedFile = basename(used.file);

step('an image kept in the library for later, not placed anywhere');
const draftPath = join(WORK, 'unpublished-sketch.svg');
writeFileSync(draftPath, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#2b8a5d"/></svg>\n');
const draftImport = await win.evaluate((p) => window.builder.project.importAssets([p]), draftPath);
assert.equal(draftImport.ok, true, `the draft imports: ${draftImport.message}`);
const draftSnap = await win.evaluate(() => window.builder.project.snapshot());
const draft = draftSnap.state.assets.assets[draftImport.assetIds[0]];
assert.equal(draftSnap.assetUsage[draft.id] ?? 0, 0, 'the draft is not used anywhere yet');
const draftFiles = [draft.file, ...(draft.variants ?? []).map((v) => v.file)];
const draftNames = draftFiles.map((f) => basename(f));

step('a bundled font chosen by name really ships');
const font = await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'token.set', tokenId: 'font.display', value: 'Lora' }] }, { label: 'Change font' }));
assert.equal(font.ok, true, `the bundled font is accepted: ${font.error?.message}`);
const unknownFont = await win.evaluate(() => window.builder.project.apply({ operations: [{ type: 'token.set', tokenId: 'font.display', value: 'Montserrat' }] }, { label: 'Change font' }));
assert.equal(unknownFont.ok, false, 'a font that is not installed is refused instead of silently falling back');

step('export through the controller');
// Folder exports ask for a parent folder and create a new folder inside it, so nothing is ever replaced.
const exportsDir = join(WORK, 'exports');
mkdirSync(join(exportsDir, 'harbour-lane-studio-site'), { recursive: true });
// Somebody else's file in the folder that is already there: no export may touch it.
writeFileSync(join(exportsDir, 'harbour-lane-studio-site', 'keep.txt'), 'not an export\n');
const sourceOut = join(exportsDir, 'harbour-lane-studio-source');
const staticOut = join(exportsDir, 'harbour-lane-studio-site-2');
const sourceZip = join(exportsDir, 'source.zip');
const staticZip = join(exportsDir, 'site.zip');
// Stand in for the native dialogs: folder pickers answer with the parent, save dialogs with the next ZIP.
await app.evaluate(({ dialog }, { parent, zips }) => {
  const queue = [...zips];
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: queue.shift() });
}, { parent: exportsDir, zips: [sourceZip, staticZip] });
// Issue 212: each website proof carries its own visible title, so two successive previews can be told apart.
const pageIds = Object.fromEntries(Object.values(after.pages).map((p) => [p.route, p.id]));
assert.ok(pageIds['/'] && pageIds['/about/'], 'the starter has a home page and an About page');
const titleProof = async (label) => {
  const r = await win.evaluate(
    ({ home, about, label }) =>
      window.builder.project.apply({ operations: [{ type: 'page.update', pageId: home, seoTitle: label }, { type: 'page.update', pageId: about, seoTitle: `${label} · About` }] }, { label: 'Retitle' }),
    { home: pageIds['/'], about: pageIds['/about/'], label }
  );
  assert.equal(r.ok, true, `the proof is retitled ${label}: ${r.error?.message}`);
};
await titleProof('Client proof 1');
const src = await withTimeout(win.evaluate(() => window.builder.project.exportSource()), 120000, 'Source export');
assert.equal(src.ok, true, `source export succeeds: ${src.message}`);
assert.equal(src.path, sourceOut);
const stat = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'Static export');
assert.equal(stat.ok, true, `static export succeeds: ${stat.message} ${stat.warnings?.join(' ')}`);
assert.equal(stat.path, staticOut, 'an existing folder is never replaced: the export takes the next free name');
assert.ok(!stat.warnings.some((w) => /placeholder/.test(w)), `no placeholder warning when every visible image is chosen: ${stat.warnings.join(' ')}`);
assert.ok(stat.warnings.some((w) => w.includes(draft.name) && /left out of the website/i.test(w)), `the website export names the draft it left out: ${stat.warnings.join(' ')}`);
assert.ok(stat.warnings.some((w) => w.includes(photo.name) && /leaves out where/.test(w)), `the website export says it left out where the photo was taken: ${stat.warnings.join(' ')}`);
assert.ok(src.warnings.some((w) => w.includes(photo.name) && /still records where/.test(w)), `the source export says the photo keeps its location: ${src.warnings.join(' ')}`);

// Issue 212: the first proof is opened in a browser tab now, before any later export, as the author did.
assert.ok(stat.previewUrl, 'the first website export starts a preview');
/** A browser tab on a proof: a hidden window (nothing may appear on screen) that never leaves the proof's address. */
async function proofTab(url) {
  const [tab] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ BrowserWindow }, url) => {
      const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true } });
      const origin = new URL(url).origin;
      w.webContents.on('will-navigate', (e, to) => new URL(to).origin !== origin && e.preventDefault());
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      void w.loadURL(url);
    }, url)
  ]);
  await tab.waitForLoadState('load');
  return tab;
}
const tab1 = await proofTab(stat.previewUrl);
assert.equal(await tab1.title(), 'Client proof 1', 'the first proof opens with its own title');

step('ZIP exports');
const srcZip = await withTimeout(win.evaluate(() => window.builder.project.exportSource('zip')), 120000, 'Source ZIP export');
assert.equal(srcZip.ok, true, `source ZIP export succeeds: ${srcZip.message}`);
assert.equal(srcZip.path, sourceZip);
const statZip = await withTimeout(win.evaluate(() => window.builder.project.exportStatic('zip')), 300000, 'Static ZIP export');
assert.equal(statZip.ok, true, `static ZIP export succeeds: ${statZip.message}`);
assert.equal(statZip.path, staticZip);
assert.ok(statZip.warnings.some((w) => w.includes(draft.name) && /left out of the website/i.test(w)), `the website ZIP export names the draft it left out: ${statZip.warnings.join(' ')}`);
assert.ok(statZip.warnings.some((w) => w.includes(photo.name) && /leaves out where/.test(w)), `the website ZIP export says it left out where the photo was taken: ${statZip.warnings.join(' ')}`);

step('issue 212: a second website proof keeps the first one serving its own files');
await titleProof('Client proof 2');
const stat2 = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'Second static export');
assert.equal(stat2.ok, true, `the second static export succeeds: ${stat2.message} ${stat2.warnings?.join(' ')}`);
const staticOut2 = join(exportsDir, 'harbour-lane-studio-site-3');
assert.equal(stat2.path, staticOut2, 'the second proof goes to the next free folder beside the first');
assert.ok(stat2.previewUrl && stat2.previewUrl !== stat.previewUrl, 'the second proof has its own preview');
const tab2 = await proofTab(stat2.previewUrl);
// Refresh each tab after the second export finished, then follow its own About link.
for (const [tab, label] of [[tab1, 'Client proof 1'], [tab2, 'Client proof 2']]) {
  const reloaded = await tab.reload();
  assert.equal(reloaded?.status(), 200, `${label} still serves its home page when refreshed after the later export`);
  assert.equal(await tab.title(), label, `${label} shows its own home page`);
  await Promise.all([tab.waitForURL(/\/about\/$/), tab.locator('a[href*="about"]').first().click()]);
  assert.equal(await tab.title(), `${label} · About`, `${label} serves its own About page`);
  await tab.reload();
  assert.equal(await tab.title(), `${label} · About`, `${label} serves its own About page when refreshed`);
  await tab.close();
}

step('issue 212: the export dialog still lists what was handed off after it is closed and reopened');
const recent = (await win.evaluate(() => window.builder.project.snapshot())).recentExports;
assert.deepEqual(
  recent.map((e) => [e.kind, e.format, e.path]),
  [['site', 'folder', staticOut2], ['site', 'zip', staticZip], ['source', 'zip', sourceZip], ['site', 'folder', staticOut], ['source', 'folder', sourceOut]],
  'every export of this opening is listed, newest first'
);
assert.deepEqual(recent.map((e) => e.previewUrl), [stat2.previewUrl, undefined, undefined, stat.previewUrl, undefined], 'each website folder keeps its own preview');
assert.ok(recent[0].revision > recent[3].revision, 'the proofs name the revisions they were made from');
// Finder must not open during tests: Show in folder records what it would reveal instead.
await app.evaluate(({ shell }) => {
  globalThis.revealed = [];
  shell.showItemInFolder = (p) => void globalThis.revealed.push(p);
});
const modal = win.locator('.modal');
const history = modal.getByRole('region', { name: 'Recent exports' });
const closeDialog = async () => {
  await modal.getByRole('button', { name: 'Close', exact: true }).last().click();
  await modal.waitFor({ state: 'detached' });
};
for (let open = 0; open < 2; open++) {
  await win.getByRole('button', { name: 'Export', exact: true }).click();
  const items = history.getByRole('listitem');
  await items.first().waitFor();
  assert.equal(await items.count(), recent.length, 'the dialog lists every export');
  for (const [i, e] of recent.entries()) {
    const item = items.nth(i);
    const text = await item.innerText();
    assert.ok(text.includes(e.path), `row ${i} shows where the export went: ${text}`);
    assert.ok(text.includes(`revision ${e.revision}`), `row ${i} names its revision: ${text}`);
    assert.match(text, e.kind === 'site' ? /^Website/ : /^Editable project/, `row ${i} says what was exported`);
    assert.equal(text.includes('(ZIP file)'), e.format === 'zip', `row ${i} says whether it is a ZIP file`);
    const preview = item.getByRole('button', { name: 'Preview in browser' });
    assert.equal(await preview.count(), e.previewUrl ? 1 : 0, `row ${i} offers a preview only for a website folder`);
    if (e.previewUrl) assert.equal(await preview.getAttribute('title'), e.previewUrl, `row ${i} previews its own proof`);
    if (open) continue;
    await item.getByRole('button', { name: 'Show in folder' }).click();
    const shown = await eventually(async () => {
      const r = await app.evaluate(() => globalThis.revealed.splice(0));
      assert.equal(r.length, 1, 'Show in folder reveals one item');
      return r[0];
    });
    assert.equal(shown, realpathSync(e.path), `row ${i} reveals its own export`);
  }
  await closeDialog();
}

step('issue 212: an export made in the dialog joins the list at once');
await win.getByRole('button', { name: 'Export', exact: true }).click();
await modal.getByRole('button', { name: /Editable project, for a developer/ }).click();
await modal.getByRole('status').filter({ hasText: 'Source project exported.' }).waitFor({ timeout: 120000 });
const sourceOut2 = join(exportsDir, 'harbour-lane-studio-source-2');
assert.equal(await history.getByRole('listitem').count(), recent.length + 1, 'the new export is listed');
assert.ok((await history.getByRole('listitem').first().innerText()).includes(sourceOut2), 'the newest export is listed first');
await closeDialog();
assert.deepEqual(readdirSync(join(exportsDir, 'harbour-lane-studio-site')), ['keep.txt'], 'the folder that was already there was never written into');
assert.equal(readFileSync(join(exportsDir, 'harbour-lane-studio-site', 'keep.txt'), 'utf8'), 'not an export\n');
for (const zip of [sourceZip, staticZip]) assert.equal(readFileSync(zip).subarray(0, 4).toString('hex'), '504b0304', `${basename(zip)} is a ZIP file`);
const listing = (zip) => spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
const siteList = listing(staticZip);
if (!siteList.error) {
  assert.ok(siteList.stdout.split('\n').includes('about/index.html'), 'the site ZIP holds the prerendered pages at its root');
  const sourceList = listing(sourceZip).stdout.split('\n');
  assert.ok(sourceList.includes('harbour-lane-studio-source/package.json'), 'the source ZIP holds the project in one named folder');
  const siteEntries = siteList.stdout.split('\n');
  assert.deepEqual(siteEntries.filter((f) => draftNames.includes(basename(f))), [], 'the site ZIP has no files of the unused draft');
  assert.deepEqual(siteEntries.filter((f) => deletedFiles.includes(basename(f))), [], 'the site ZIP has no files of the deleted image');
  assert.ok(siteEntries.some((f) => basename(f) === usedFile), `the site ZIP keeps the image the site uses (${usedFile})`);
  for (const f of draftFiles) assert.ok(sourceList.includes(`harbour-lane-studio-source/${f}`), `the source ZIP keeps the draft for later (${f})`);
  for (const f of photoFiles) {
    const served = f.replace(/^static\//, '');
    const entry = spawnSync('unzip', ['-p', staticZip, served], { maxBuffer: 64 * 1024 * 1024 });
    assert.equal(entry.status, 0, `the site ZIP holds ${served}`);
    assertPublicPhoto(entry.stdout, `the site ZIP's ${served}`, { original: f === photo.file });
  }
  const sourceEntry = spawnSync('unzip', ['-p', sourceZip, `harbour-lane-studio-source/${photo.file}`], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(createHash('sha256').update(sourceEntry.stdout).digest('hex'), photoHash, 'the editable project ZIP keeps the original photo as imported');
}

step('the photo as visitors get it, and as the project keeps it');
const pixels = async (buf) =>
  win.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const at = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
    return { width: img.naturalWidth, height: img.naturalHeight, topLeft: at(5, 5), topRight: at(img.naturalWidth - 6, 5) };
  }, buf.toString('base64'));
const red = ([r, g, b]) => r > 180 && g < 90 && b < 90;
const blue = ([r, g, b]) => r < 90 && b > 150;
for (const f of photoFiles) {
  const published = readFileSync(join(staticOut, f.replace(/^static\//, '')));
  assertPublicPhoto(published, `the website's ${basename(f)}`, { original: f === photo.file });
  const shown = await pixels(published);
  const width = f === photo.file ? 2000 : photo.variants.find((v) => v.file === f).width;
  assert.deepEqual([shown.width, shown.height], [width, Math.round((width * 1200) / 2000)], `${basename(f)} is shown upright at its size`);
  assert.ok(red(shown.topRight) && blue(shown.topLeft), `${basename(f)} is turned the right way: ${JSON.stringify(shown)}`);
}
const homeHtml = readFileSync(join(staticOut, 'index.html'), 'utf8');
for (const f of photoFiles) assert.ok(homeHtml.includes(f.replace(/^static\//, '')), `the Home page offers ${basename(f)} to visitors`);
const kept = readFileSync(join(dir, photo.file));
assert.equal(createHash('sha256').update(kept).digest('hex'), photoHash, 'the project keeps the original photo byte for byte');
assert.equal(readFileSync(join(sourceOut, photo.file)).equals(kept), true, 'the editable project export keeps the original photo as imported');
const finalState = (await win.evaluate(() => window.builder.project.snapshot())).state;
assert.deepEqual(finalState.assets.assets[photoId], photo, 'the asset record is unchanged');
assert.ok(JSON.stringify(finalState.pages[finalState.site.homePageId].nodes[homeHero.heroId]).includes(photoId), 'the Home hero still uses the photo');
assert.deepEqual(errors, [], 'no uncaught errors in the editor');
await app.close();

/** Every file under `root`, relative, with `/` separators. */
function files(root, rel = '') {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? files(root, r) : [r];
  });
}
const EDITOR_MARKUP = /data-so-(ctx|node)|siteorigin-bridge/;
function scan(root, label) {
  const all = files(root);
  assert.ok(all.length > 0, `${label} export has files`);
  const editorState = all.filter((f) => f.split('/').includes('.siteorigin'));
  assert.deepEqual(editorState, [], `${label} export has no .siteorigin editor state (history, chat, caches)`);
  assert.ok(!readdirSync(root).includes('.siteorigin'), `${label} export has no .siteorigin folder`);
  const leaked = all.filter((f) => readFileSync(join(root, f)).includes(CANARY));
  assert.deepEqual(leaked, [], `${label} export contains no saved or private API key`);
  const bridged = all.filter((f) => /\.(html|js|mjs|ts|svelte)$/.test(f) && EDITOR_MARKUP.test(readFileSync(join(root, f), 'utf8')));
  assert.deepEqual(bridged, [], `${label} export has no editor markup or bridge`);
  assert.ok(all.some((f) => basename(f) === usedFile), `${label} export keeps the image the site uses (${usedFile})`);
  return all;
}
/** Only images the site still uses are exported; a deleted one stays in the project only for undo. */
const noDeletedImage = (all, label) => assert.deepEqual(all.filter((f) => deletedFiles.includes(basename(f))), [], `${label} export has no files of the deleted image`);

step('I09: scan the source export');
const srcFiles = scan(sourceOut, 'source');
for (const f of ['package.json', 'package-lock.json', 'siteorigin.project.json', 'vite.config.js', 'README.md']) assert.ok(srcFiles.includes(f), `source export includes ${f}`);
assert.ok(!srcFiles.some((f) => /^(node_modules|build|\.svelte-kit)\//.test(f)), 'source export has no installed packages or build output');
assert.ok(!srcFiles.some((f) => /(^|\/)\.env(\.|$)/.test(f)), 'source export has no .env files');
noDeletedImage(srcFiles, 'source');
for (const f of draftFiles) assert.ok(srcFiles.includes(f), `the editable source export keeps the unused draft (${f})`);
for (const f of ['jsconfig.json', 'NOTICE.md', 'src/lib/siteorigin/paths.json']) assert.ok(srcFiles.includes(f), `source export includes ${f}`);
assert.ok(!srcFiles.includes('svelte.config.js'), 'no svelte.config.js: SvelteKit 3 reads its config from vite.config.js and rejects that file');
assert.ok(!srcFiles.includes('.npmrc'), 'no engine-strict .npmrc in the export');
assert.equal(JSON.parse(readFileSync(join(sourceOut, 'package.json'), 'utf8')).engines.node, '>=22.17.0');
assert.match(readFileSync(join(sourceOut, 'README.md'), 'utf8'), /^# Harbour Lane Studio\n[^]*Node\.js 22\.17/);

step('I09: scan the static export');
const staticFiles = scan(staticOut, 'static');
scan(staticOut2, 'second static');
assert.ok(staticFiles.includes('index.html') && staticFiles.includes('about/index.html'), 'static export has the prerendered pages');
noDeletedImage(staticFiles, 'static');
assert.deepEqual(staticFiles.filter((f) => draftNames.includes(basename(f))), [], 'the website has no files of the unused draft');
assert.ok(used.variants?.length, 'the starter image has responsive variants to check');
for (const v of used.variants) assert.ok(staticFiles.some((f) => basename(f) === basename(v.file)), `the website keeps the responsive variants of an image it uses (${v.file})`);
for (const f of draftFiles) assert.ok(existsSync(join(dir, f)), `the draft stays in the working project (${f})`);
assert.ok(staticFiles.includes('favicon.svg'), 'static export has a favicon');
assert.ok(staticFiles.some((f) => /lora.*\.woff2$/i.test(f)), 'the chosen font is built into the site');
assert.ok(!staticFiles.some((f) => /fraunces.*\.woff2$/i.test(f)), 'the font it replaced is not');
const css = staticFiles.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(staticOut, f), 'utf8')).join('\n');
assert.match(css, /--so-font-display:\s*['"]Lora Variable['"]/, 'the display font token uses the family the font declares');
assert.match(css, /@font-face\s*\{[^}]*font-family:\s*['"]?Lora Variable[^}]*url\([^)]*lora[^)]*\.woff2/i, 'the font has an @font-face rule pointing at its file');
const authoring = staticFiles.filter((f) => f === 'siteorigin.project.json' || f.startsWith('siteorigin/') || f.endsWith('.svelte'));
assert.deepEqual(authoring, [], 'static export has no authoring metadata or sources');

if (BUILD) {
  step('I07: npm ci && npm run build in the exported source, outside the app');
  // A plain environment: nothing from the app or this repository's npm configuration leaks in.
  // npm scripts put this repository's node_modules/.bin first on PATH; drop it so the export cannot borrow
  // Builder's own vite or svelte-kit.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_|SITEORIGIN_|ELECTRON_)/i.test(k)));
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  env[pathKey] = env[pathKey].split(delimiter).filter((p) => !p.includes(`node_modules${sep}.bin`)).join(delimiter);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  for (const args of [['ci', '--no-audit', '--no-fund'], ['run', 'build']]) {
    const t0 = Date.now();
    const r = spawnSync(npm, args, { cwd: sourceOut, env, encoding: 'utf8', shell: process.platform === 'win32', timeout: 600000 });
    console.log(`npm ${args.join(' ')}: exit ${r.status} in ${Math.round((Date.now() - t0) / 1000)}s`);
    assert.equal(r.status, 0, `npm ${args.join(' ')} succeeds in the exported source:\n${(r.stdout ?? '').slice(-3000)}\n${(r.stderr ?? '').slice(-3000)}`);
  }
  assert.ok(existsSync(join(sourceOut, 'build', 'index.html')), 'the standalone build writes build/index.html');
  assert.ok(existsSync(join(sourceOut, 'build', 'about', 'index.html')), 'the standalone build prerenders nested routes');
  assert.ok(files(join(sourceOut, 'build')).some((f) => /lora.*\.woff2$/i.test(f)), 'the standalone build includes the chosen font');
} else console.log('\n(skipping the standalone npm ci && npm run build; pass --build to run it)');

cleanup();
console.log('\nexport: passed');
