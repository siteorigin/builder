import { getHashes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** A package `npm ci` fetches: where it goes in the project, and the digest it is fetched (or found in a cache) by. */
export interface LockedPackage {
  location: string;
  integrity?: string;
  /** Built for particular platforms (a native tool): npm skips such an optional package silently when its fetch fails. */
  native?: boolean;
}

/** Whether the website tools a project needs are all in the npm caches, so setting them up needs no network. */
export interface ToolsAvailability {
  /** Every package setup installs here is already on this computer: setup downloads nothing. */
  offline: boolean;
  /** How many of those packages would be downloaded (0 when `offline`). */
  missing: number;
  /** How many packages setup installs on this computer. */
  needed: number;
}

/** A platform other than this computer's, for tests; npm judges this computer's own by default. */
export interface Platform {
  os?: string;
  cpu?: string;
  libc?: string;
}

interface IdealNode {
  location: string;
  integrity?: string | null;
  package: { os?: unknown; cpu?: unknown; libc?: unknown };
  isProjectRoot?: boolean;
  isLink?: boolean;
  inBundle?: boolean;
  inert?: boolean;
}

/**
 * The registry packages `npm ci` installs into `dir` on this computer, worked out by the npm that runs the install and
 * the way `npm ci` works them out: its ideal tree from the lock, with optional packages for other platforms (and what
 * only they need) left out. Nothing is written or run: like `npm ci` it never loads the project's `.npm-extension`, and
 * with npm's own defaults it never clones a git dependency or fetches a remote tarball. Offline, a lock that does not
 * settle the tree by itself fails here instead of asking the registry. `cache` is the npm cache folder npm will use.
 */
export async function lockedPackages(npmDir: string, dir: string, platform: Platform = {}, cache?: string): Promise<LockedPackage[]> {
  const npmRequire = createRequire(join(npmDir, 'package.json'));
  const Arborist = npmRequire('@npmcli/arborist');
  const npmVersion: string = npmRequire('./package.json').version;
  const arb = new Arborist({
    path: dir,
    offline: true,
    npmVersion,
    packageLock: true,
    save: false,
    ignoreExtension: true,
    allowGit: 'none',
    allowRemote: 'none',
    ...(cache ? { cache: join(cache, '_cacache') } : {}),
    ...platform
  });
  const tree: { inventory: Map<string, IdealNode> } = await arb.buildIdealTree();
  return [...tree.inventory.values()]
    .filter((n) => !n.isProjectRoot && !n.isLink && !n.inBundle && !n.inert)
    .map((n) => ({ location: n.location, integrity: n.integrity ?? undefined, native: !!(n.package.os || n.package.cpu || n.package.libc) }));
}

// The digest npm reads a package from is the strongest one its integrity lists that this Node can compute (ssri's
// `pickAlgorithm`, which drops the others and ranks any it does not know below these).
const PRIORITY = ['md5', 'whirlpool', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];
const HASHES = new Set(getHashes());

/**
 * Where an integrity's content lives inside an npm cache (`<cache>/_cacache`, cacache's content-v2 layout), one path
 * per digest of its strongest algorithm. npm installs a locked package from the cache by this digest alone.
 */
export function contentPaths(cache: string, integrity: string): string[] {
  const digests = integrity
    .trim()
    .split(/\s+/)
    .map((s) => /^([a-z0-9]+)-([A-Za-z0-9+/=]+)(\?.*)?$/i.exec(s))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ algorithm: m[1].toLowerCase(), hex: Buffer.from(m[2], 'base64').toString('hex') }))
    .filter((d) => HASHES.has(d.algorithm));
  if (!digests.length) return [];
  const strongest = digests.reduce((best, d) => (PRIORITY.indexOf(d.algorithm) > PRIORITY.indexOf(best.algorithm) ? d : best)).algorithm;
  return digests.filter((d) => d.algorithm === strongest && d.hex).map((d) => join(cache, '_cacache', 'content-v2', d.algorithm, d.hex.slice(0, 2), d.hex.slice(2, 4), d.hex.slice(4)));
}

/** Which of the packages are missing from every one of the given npm caches. */
export function cacheCoverage(packages: LockedPackage[], caches: string[]): ToolsAvailability {
  // A package with no integrity cannot be found in a cache: npm asks the registry for it.
  const missing = packages.filter((p) => !p.integrity || !caches.some((c) => contentPaths(c, p.integrity!).some((path) => existsSync(path)))).length;
  return { offline: missing === 0, missing, needed: packages.length };
}

/**
 * npm failures that mean the registry could not be reached: offline, no DNS, a refused, dropped or stalled connection
 * (npm reports a stalled request as `EIDLETIMEOUT`, or as `FETCH_ERROR` with "network timeout").
 */
export const NETWORK_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EIDLETIMEOUT', 'FETCH_ERROR', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ECONNABORTED'];

/**
 * Of the native tools among the packages, those npm has not put into the project: an optional package it could not
 * fetch is skipped without failing the install, and a build tool without its native part does not run.
 */
export function nativeNotInstalled(dir: string, packages: LockedPackage[]): LockedPackage[] {
  return packages.filter((p) => p.native && !existsSync(join(dir, p.location, 'package.json')));
}

/** The error code npm printed for a failed run (`npm error code ENOTFOUND`), if it printed one. */
export function npmErrorCode(stderr: string): string | undefined {
  return /^npm (?:error|ERR!) code (\S+)/m.exec(stderr)?.[1];
}

/** Setting up the website tools needed a download, and the registry could not be reached. */
export class ToolsDownloadError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = 'ToolsDownloadError';
  }
}
