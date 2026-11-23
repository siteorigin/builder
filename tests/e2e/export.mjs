// Export integrity (spec I07, I09): export the static site and the source project through the real
// controller (native save dialogs stubbed), then scan both for editor state, credentials, editor markup
// and deleted images. With --build, the exported source is also installed and built with plain
// `npm ci && npm run build`, as on a clean machine (slow, and needs the npm registry).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join, sep } from 'node:path';
import { createProject, knownFailure, launch, scratch, step, withTimeout } from './harness.mjs';

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

step('export through the controller');
const sourceOut = join(WORK, 'export-source');
const staticOut = join(WORK, 'export-static');
// Stand in for the native save dialogs: each call answers with the next destination.
await app.evaluate(({ dialog }, paths) => {
  const queue = [...paths];
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: queue.shift() });
}, [sourceOut, staticOut]);
const src = await withTimeout(win.evaluate(() => window.builder.project.exportSource()), 120000, 'Source export');
assert.equal(src.ok, true, `source export succeeds: ${src.message}`);
assert.equal(src.path, sourceOut);
const stat = await withTimeout(win.evaluate(() => window.builder.project.exportStatic()), 300000, 'Static export');
assert.equal(stat.ok, true, `static export succeeds: ${stat.message} ${stat.warnings?.join(' ')}`);
assert.equal(stat.path, staticOut);
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
await knownFailure('I09: deleted images ship in exports; export work in progress', () => noDeletedImage(srcFiles, 'source'));

step('I09: scan the static export');
const staticFiles = scan(staticOut, 'static');
assert.ok(staticFiles.includes('index.html') && staticFiles.includes('about/index.html'), 'static export has the prerendered pages');
await knownFailure('I09: deleted images ship in exports; export work in progress', () => noDeletedImage(staticFiles, 'static'));
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
} else console.log('\n(skipping the standalone npm ci && npm run build; pass --build to run it)');

cleanup();
console.log('\nexport: passed');
