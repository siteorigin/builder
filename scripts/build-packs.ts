/**
 * Build the packs authored in this repository into the release files the app loads: `resources/packs/<id>/`
 * for shipped packs, `resources/packs-dev/<id>/` for development fixtures. Each release is written to a staging
 * folder, loaded back through the app's own loader, and only then put in place.
 *
 *   npm run build:packs                       build every pack, drawing any thumbnail whose source changed
 *   npm run build:packs -- --require-previews  fail rather than build without thumbnails (for packaging)
 */
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_PACKS } from '@catalogue/builtin';
import { buildPack, writeRelease } from '../src/main/packs/build';
import { loadPackDir } from '../src/main/packs/loader';
import { renderPreviews } from './packs/previews';
import { packManifestProblems } from '../src/main/codecheck';

const root = process.cwd();
const requirePreviews = process.argv.includes('--require-previews');
const started = Date.now();
for (const authored of BUILTIN_PACKS) {
  const { pack, files } = buildPack(authored, root);
  // Each code component takes exactly the properties its manifest declares, with the defaults it declares.
  const disagree = await packManifestProblems(pack.components);
  if (disagree.length) throw new Error(`The ${pack.id} pack's code does not match its manifest. ${disagree.join(' ')}`);
  const { previews, bytes, drawn } = await renderPreviews(pack, files, join(root, '.tmp', 'pack-previews'), { require: requirePreviews });
  const dir = join(root, 'resources', authored.devOnly ? 'packs-dev' : 'packs');
  // Named after the pack, as the loader requires, inside a folder the app skips.
  const stage = join(dir, '.staging', pack.id);
  const digest = writeRelease(stage, { ...pack, previews }, files, bytes);
  // The release must load exactly as the app will load it, or it is not put in place.
  await loadPackDir(stage, { dir, source: 'bundled' }).catch((e: Error) => {
    rmSync(stage, { recursive: true, force: true });
    throw new Error(`The ${pack.id} release does not load: ${e.message}`);
  });
  rmSync(join(dir, pack.id), { recursive: true, force: true });
  renameSync(stage, join(dir, pack.id));
  rmSync(join(dir, '.staging'), { recursive: true, force: true });
  console.log(`${pack.id} ${pack.version}: ${files.size} font files, ${bytes.size} previews (${drawn} drawn), digest ${digest.slice(0, 12)}`);
}
// A release of a pack this repository no longer authors (a removed theme) must not ship with the app: both folders
// are packaged whole, and the app loads whatever valid pack it finds in them.
const authoredIds = new Set(BUILTIN_PACKS.map((a) => a.id));
for (const folder of ['packs', 'packs-dev']) {
  const dir = join(root, 'resources', folder);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) if (!name.startsWith('.') && !authoredIds.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
}
console.log(`Theme packs built in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
