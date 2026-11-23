// Export integrity (spec I07, I09): export the static site and the source project through the real
// controller (native save dialogs stubbed), then scan both for editor state, credentials, editor markup,
// deleted images and library images kept for later (only the editable project carries those). With --build, the exported source is also installed and built with plain
// `npm ci && npm run build`, as on a clean machine (slow, and needs the npm registry).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join, sep } from 'node:path';
import { createProject, launch, scratch, step, withTimeout } from './harness.mjs';

const BUILD = process.argv.includes('--build');
const { WORK, cleanup } = scratch('export');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Harbour Lane Studio', parentDir: join(WORK, 'sites'), starter: 'business', sampleImages: true });
const dir = join(WORK, 'sites', 'harbour-lane-studio');

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

step('ZIP exports');
const srcZip = await withTimeout(win.evaluate(() => window.builder.project.exportSource('zip')), 120000, 'Source ZIP export');
assert.equal(srcZip.ok, true, `source ZIP export succeeds: ${srcZip.message}`);
assert.equal(srcZip.path, sourceZip);
const statZip = await withTimeout(win.evaluate(() => window.builder.project.exportStatic('zip')), 300000, 'Static ZIP export');
assert.equal(statZip.ok, true, `static ZIP export succeeds: ${statZip.message}`);
assert.equal(statZip.path, staticZip);
assert.ok(statZip.warnings.some((w) => w.includes(draft.name) && /left out of the website/i.test(w)), `the website ZIP export names the draft it left out: ${statZip.warnings.join(' ')}`);

step('issue 212: a second website proof keeps the first one serving its own files');
assert.ok(stat.previewUrl, 'the first website export starts a preview');
await titleProof('Client proof 2');
const stat2 = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'Second static export');
assert.equal(stat2.ok, true, `the second static export succeeds: ${stat2.message} ${stat2.warnings?.join(' ')}`);
const staticOut2 = join(exportsDir, 'harbour-lane-studio-site-3');
assert.equal(stat2.path, staticOut2, 'the second proof goes to the next free folder beside the first');
assert.ok(stat2.previewUrl && stat2.previewUrl !== stat.previewUrl, 'the second proof has its own preview');
const titleOf = (html) => html.match(/<title>([^<]*)<\/title>/)?.[1].replace(/&amp;/g, '&');
// Refresh each proof after the second export finished, then follow its nested About link, as a browser tab would.
for (const [url, label] of [[stat.previewUrl, 'Client proof 1'], [stat2.previewUrl, 'Client proof 2']]) {
  const home = await fetch(url);
  assert.equal(home.status, 200, `${label} still serves its home page after the later export (${url})`);
  const html = await home.text();
  assert.equal(titleOf(html), label, `${label} serves its own home page`);
  const href = [...html.matchAll(/href="([^"]*about\/?)"/g)].map((m) => m[1])[0];
  assert.ok(href, `${label} links to its About page`);
  const about = await fetch(new URL(href, url));
  assert.equal(about.status, 200, `${label} serves the About page it links to (${href})`);
  assert.equal(titleOf(await about.text()), `${label} · About`, `${label} serves its own About page`);
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
for (let open = 0; open < 2; open++) {
  await win.getByRole('button', { name: 'Export', exact: true }).click();
  const items = win.locator('.modal .export-history li');
  await items.first().waitFor();
  assert.equal(await items.count(), 5, 'the dialog lists every export');
  const shown = await items.allInnerTexts();
  assert.ok(shown[0].includes(staticOut2) && shown[3].includes(staticOut), `the dialog shows both proofs' folders: ${shown.join(' | ')}`);
  assert.ok(shown.every((t) => /revision \d+/.test(t)), 'each export names its revision');
  assert.equal(await win.locator('.modal .export-history li button', { hasText: 'Preview in browser' }).count(), 2, 'both website folders offer their preview');
  assert.equal(await win.locator('.modal .export-history li button', { hasText: 'Show in folder' }).count(), 5, 'every export can be found on disk');
  await win.locator('.modal').getByRole('button', { name: 'Close', exact: true }).last().click();
  await win.locator('.modal').waitFor({ state: 'detached' });
}
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
}
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
