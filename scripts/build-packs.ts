/**
 * Put the theme releases the app loads in place: `resources/packs/<id>/` for shipped packs, `resources/packs-dev/<id>/`
 * for development fixtures. Each release is written to a staging folder, loaded back through the app's own loader,
 * and only then put in place.
 *
 * Foundation and its fixture, foundation-alt, are authored in siteorigin/builder-components (private) and committed
 * here as built releases, pinned by `resources/packs.lock.json` (scripts/packs/locked-releases.ts). With a
 * builder-components checkout (named by SITEORIGIN_BUILDER_COMPONENTS, or a `builder-components` folder beside this
 * checkout or the main one), they are built from it against this checkout's own code, and the committed releases and
 * the lock are refreshed together. Without one, or with `--committed`, the committed releases are checked against the
 * lock. Either way, a release of a pack the app no longer ships (a removed theme) is taken out of both folders.
 *
 *   npm run build:packs                   refresh from builder-components when there is a checkout, else check
 *   npm run build:packs -- --committed    never refresh: check the committed releases (dev, build, packaging)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AuthoredPack, ThemePack } from '@catalogue/pack';
import { buildPack, packTokenProblems, writeRelease } from '../src/main/packs/build';
import { loadPackDir } from '../src/main/packs/loader';
import { renderPreviews } from './packs/previews';
import { packManifestProblems } from '../src/main/codecheck';
import { LOCKED_RELEASES, LOCK_FILE, committedReleaseProblems, findCheckout, lockJson, missingPreviews, type PackLock } from './packs/locked-releases';

const root = process.cwd();
const args = process.argv.slice(2);
const committed = args.includes('--committed');
const started = Date.now();
/** This run's staging folder in each releases folder: the app skips folders named with a dot, and other runs leave it be. */
const STAGING = `.staging-${process.pid}`;

/** A release built into a staging folder beside where it goes, loaded back as the app will load it. */
async function stage(authored: AuthoredPack, fontRoot: string): Promise<{ pack: ThemePack; dir: string; digest: string; line: string }> {
  const { pack, files } = buildPack(authored, fontRoot);
  // Each code component takes exactly the properties its manifest declares, with the defaults it declares.
  const disagree = await packManifestProblems(pack.components);
  if (disagree.length) throw new Error(`The ${pack.id} pack's code does not match its manifest. ${disagree.join(' ')}`);
  const unknown = packTokenProblems(pack);
  if (unknown.length) throw new Error(`The ${pack.id} pack's code names CSS variables its theme does not define:\n${unknown.join('\n')}`);
  // A committed release ships in every package, so it always carries its thumbnails.
  const { previews, bytes, drawn } = await renderPreviews(pack, files, join(root, '.tmp', 'pack-previews'), { require: true });
  const dir = join(root, 'resources', authored.devOnly ? 'packs-dev' : 'packs');
  // Named after the pack, as the loader requires, inside a folder the app skips.
  const staged = join(dir, STAGING, pack.id);
  const digest = writeRelease(staged, { ...pack, previews }, files, bytes);
  // The release must load exactly as the app will load it, or it is not put in place.
  const loaded = await loadPackDir(staged, { dir, source: 'bundled' }).catch((e: Error) => {
    rmSync(staged, { recursive: true, force: true });
    throw new Error(`The ${pack.id} release does not load: ${e.message}`);
  });
  return { pack: loaded.pack, dir, digest, line: `${pack.id} ${pack.version}: ${files.size} font files, ${bytes.size} previews (${drawn} drawn), digest ${digest.slice(0, 12)}` };
}

/**
 * Put a staged release in place. Nothing is kept to roll back to: the committed releases are in git, and a refresh
 * that stops part way leaves releases that no longer match the lock, which the next check reports with how to restore
 * them.
 */
function promote(dir: string, id: string): void {
  rmSync(join(dir, id), { recursive: true, force: true });
  renameSync(join(dir, STAGING, id), join(dir, id));
  rmSync(join(dir, STAGING), { recursive: true, force: true });
}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Build Foundation and its fixture from a builder-components checkout, then replace the committed releases and the lock. */
async function refresh(checkout: string): Promise<void> {
  let commit: string;
  try {
    // The lock names the commit the releases came from, so they must come from exactly that commit, of that checkout
    // (not of a repository it happens to sit inside).
    if (realpathSync(git(checkout, 'rev-parse', '--show-toplevel')) !== realpathSync(checkout)) throw new Error(`${checkout} is not the top of a git checkout: ${LOCK_FILE} records the commit the releases are built from.`);
    if (git(checkout, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none')) throw new Error(`${checkout} has uncommitted changes. Commit them first: ${LOCK_FILE} records the commit the releases are built from.`);
    commit = git(checkout, 'rev-parse', 'HEAD');
  } catch (e) {
    throw new Error(`builder-components at ${checkout}: ${(e as Error).message}`);
  }
  if (!existsSync(join(checkout, 'node_modules'))) throw new Error(`builder-components at ${checkout} has no dependencies installed (its fonts come from them). Run npm ci there.`);
  console.log(`Building Foundation from builder-components at ${checkout} (${commit.slice(0, 12)}).`);
  // Its themes import this checkout's DSL and types through this run's path aliases, so they build against this code.
  const { THEMES } = (await import(pathToFileURL(join(checkout, 'themes', 'index.ts')).href)) as { THEMES: AuthoredPack[] };
  const ids = THEMES.map((t) => t.id);
  const expected: string[] = LOCKED_RELEASES.map((r) => r.id);
  if ([...ids].sort().join() !== [...expected].sort().join()) throw new Error(`builder-components builds ${ids.join(', ')}; this repository locks ${expected.join(', ')}.`);
  const staged = [];
  for (const r of LOCKED_RELEASES) {
    const authored = THEMES.find((t) => t.id === r.id)!;
    if (Boolean(authored.devOnly) !== r.devOnly) throw new Error(`builder-components' ${r.id} ${r.devOnly ? 'must' : 'must not'} be a development fixture.`);
    const s = await stage(authored, checkout);
    const missing = missingPreviews(s.pack);
    if (missing.length) throw new Error(`The ${r.id} release has no thumbnail for ${missing.join(', ')}.`);
    staged.push(s);
  }
  // Both releases built and loaded: only now is either replaced, and the lock last.
  const lock: PackLock = { builderComponentsCommit: commit, packs: Object.fromEntries(staged.map((s) => [s.pack.id, { version: s.pack.version, digest: s.digest }])) };
  for (const s of staged) promote(s.dir, s.pack.id);
  // Written whole or not at all: a lock cut short would fail every build until restored.
  const lockFile = join(root, LOCK_FILE);
  writeFileSync(`${lockFile}.${process.pid}.tmp`, lockJson(lock));
  renameSync(`${lockFile}.${process.pid}.tmp`, lockFile);
  for (const s of staged) console.log(s.line);
  console.log(`Refreshed the committed releases and ${LOCK_FILE}: commit them together.`);
}

const checkout = committed ? null : findCheckout(root);
if (checkout) await refresh(checkout);
else {
  const problems = await committedReleaseProblems(root);
  if (problems.length) {
    const releases = LOCKED_RELEASES.map((r) => `${r.dir}/${r.id}`).join(' ');
    console.error(`The committed theme releases do not match ${LOCK_FILE}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    console.error(
      `Restore them (git checkout -- ${releases} ${LOCK_FILE} && git clean -fdx -- ${releases}), or rebuild them from a builder-components checkout (CONTRIBUTING.md, "Theme releases").`
    );
    process.exit(1);
  }
  console.log(`Foundation and foundation-alt: the committed releases match ${LOCK_FILE}.`);
}

// A release of a pack the app no longer ships (a removed theme) must not ship with it: both folders are packaged
// whole, and the app loads whatever valid pack it finds in them.
// A locked release is kept only in its own folder, where it is checked: a copy in the other would ship unchecked.
for (const folder of ['resources/packs', 'resources/packs-dev']) {
  const dir = join(root, folder);
  if (!existsSync(dir)) continue;
  const shipped = new Set<string>(LOCKED_RELEASES.filter((r) => r.dir === folder).map((r) => r.id));
  for (const name of readdirSync(dir)) if (!name.startsWith('.') && !shipped.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
}
console.log(`Theme packs ready in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
