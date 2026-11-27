/**
 * The theme releases built from siteorigin/builder-components (private) and committed here, so this public repository
 * builds, tests and packages without it: Foundation in `resources/packs/foundation/` and its development fixture in
 * `resources/packs-dev/foundation-alt/`. `resources/packs.lock.json` pins each release by version and digest (the
 * SHA-256 of its `pack.json`, which lists the hash of every other file in it) and names the builder-components commit
 * they were built from. `npm run build:packs` refreshes them from a builder-components checkout, or checks them
 * against the lock when there is none.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PACK_MANIFEST, type ThemePack } from '@catalogue/pack';
import { loadPackDir } from '../../src/main/packs/loader';

/**
 * Each committed release: its pack ID and the folder it is committed in, as the app's resources lay them out. Paths
 * here are repository paths, written with `/` on every platform for messages; `join` takes them as they are.
 */
export const LOCKED_RELEASES = [
  { id: 'foundation', dir: 'resources/packs', devOnly: false },
  { id: 'foundation-alt', dir: 'resources/packs-dev', devOnly: true }
] as const;

export const LOCK_FILE = 'resources/packs.lock.json';

/** The environment variable naming a builder-components checkout to build the locked releases from. */
export const CHECKOUT_ENV = 'SITEORIGIN_BUILDER_COMPONENTS';

export interface PackLock {
  /** The builder-components commit the releases were built from. */
  builderComponentsCommit: string;
  packs: Record<string, { version: string; digest: string }>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The lock as committed, checked for shape: exactly the locked releases, each with a version and a digest. */
export function readLock(root: string): PackLock {
  const file = join(root, LOCK_FILE);
  if (!existsSync(file)) throw new Error(`${LOCK_FILE} is missing.`);
  const lock = JSON.parse(readFileSync(file, 'utf8')) as PackLock;
  if (typeof lock?.builderComponentsCommit !== 'string' || !COMMIT.test(lock.builderComponentsCommit)) throw new Error(`${LOCK_FILE} names no builder-components commit.`);
  const ids = Object.keys(lock.packs ?? {}).sort();
  const expected = LOCKED_RELEASES.map((r) => r.id).sort();
  if (ids.join() !== expected.join()) throw new Error(`${LOCK_FILE} must pin exactly ${expected.join(', ')} (it pins ${ids.join(', ') || 'nothing'}).`);
  for (const id of ids) {
    const p = lock.packs[id];
    if (typeof p?.version !== 'string' || !p.version || typeof p.digest !== 'string' || !SHA256.test(p.digest)) throw new Error(`${LOCK_FILE}: ${id} needs a version and a SHA-256 digest.`);
  }
  return lock;
}

/** The lock, serialized as it is committed. */
export function lockJson(lock: PackLock): string {
  const packs = Object.fromEntries(LOCKED_RELEASES.map(({ id }) => [id, { version: lock.packs[id].version, digest: lock.packs[id].digest }]));
  return JSON.stringify({ builderComponentsCommit: lock.builderComponentsCommit, packs }, null, '\t') + '\n';
}

/**
 * The thumbnails a release lacks: every component the Insert panel offers (all but the shell) needs one of its
 * defaults and one per option of each variant axis other than the default, as the pack build draws them.
 */
export function missingPreviews(pack: ThemePack): string[] {
  const out: string[] = [];
  for (const def of pack.components) {
    if (def.category === 'shell') continue;
    const p = pack.previews?.[def.componentId];
    if (!p?.default) out.push(def.componentId);
    for (const [axis, a] of Object.entries(def.variantAxes ?? {}))
      for (const option of Object.keys(a.options)) if (option !== a.default && !p?.variants?.[axis]?.[option]) out.push(`${def.componentId} ${axis}=${option}`);
  }
  return out;
}

/**
 * What is wrong with the committed releases under `root`: each must load as the app loads it, be the release the
 * lock pins (its ID, version and digest), sit where the app looks for it, carry every thumbnail, and hold nothing its
 * pack.json doesn't list (the loader reads only what it lists, but packaging copies the whole folder).
 */
export async function committedReleaseProblems(root: string): Promise<string[]> {
  let lock: PackLock;
  try {
    lock = readLock(root);
  } catch (e) {
    return [(e as Error).message];
  }
  const problems: string[] = [];
  for (const r of LOCKED_RELEASES) {
    const dir = join(root, r.dir, r.id);
    const where = `${r.dir}/${r.id}`;
    const loaded = await loadPackDir(dir, { dir: join(root, r.dir), source: 'bundled' }).catch((e: Error) => e);
    if (loaded instanceof Error) {
      problems.push(`${where} does not load: ${loaded.message}`);
      continue;
    }
    const { pack, files } = loaded;
    const extra = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => !e.isDirectory())
      .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
      .filter((rel) => rel !== PACK_MANIFEST && !files.has(rel))
      .sort();
    if (extra.length) problems.push(`${where} holds ${extra.join(', ')}, which its ${PACK_MANIFEST} does not list.`);
    const want = lock.packs[r.id];
    if (pack.version !== want.version) problems.push(`${where} is version ${pack.version}; ${LOCK_FILE} pins ${want.version}.`);
    if (pack.digest !== want.digest) problems.push(`${where} has digest ${pack.digest}; ${LOCK_FILE} pins ${want.digest}.`);
    if (Boolean(pack.devOnly) !== r.devOnly) problems.push(`${where} ${r.devOnly ? 'must' : 'must not'} be a development fixture.`);
    const missing = missingPreviews(pack);
    if (missing.length) problems.push(`${where} has no thumbnail for ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`);
  }
  return problems;
}

const isCheckout = (dir: string) => existsSync(join(dir, 'themes', 'index.ts'));

/** The first worktree git lists for this checkout, its main one; null outside git. */
function mainWorktree(root: string): string | null {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split('\0').find((l) => l.startsWith('worktree '));
    return first ? first.slice('worktree '.length) : null;
  } catch {
    return null;
  }
}

/**
 * The builder-components checkout to build the locked releases from: the one the environment names, else a
 * `builder-components` folder beside this checkout, or beside the main checkout when this is one of its worktrees.
 * Null when there is none. A checkout the environment names that is not one is an error, never a silent fallback.
 */
export function findCheckout(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env[CHECKOUT_ENV]?.trim();
  if (named) {
    const dir = isAbsolute(named) ? named : resolve(root, named);
    if (!isCheckout(dir)) throw new Error(`${CHECKOUT_ENV} names ${dir}, which is not a builder-components checkout (it has no themes/index.ts).`);
    return dir;
  }
  const main = mainWorktree(root);
  for (const dir of [join(root, '..', 'builder-components'), ...(main ? [join(dirname(main), 'builder-components')] : [])]) {
    if (isCheckout(dir)) return resolve(dir);
  }
  return null;
}
