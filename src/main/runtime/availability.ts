import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** A package `npm ci` fetches: where it goes in the project, and the digest it is fetched (or found in a cache) by. */
export interface LockedPackage {
  location: string;
  integrity?: string;
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
  isProjectRoot?: boolean;
  isLink?: boolean;
  inBundle?: boolean;
  inert?: boolean;
}

/**
 * The registry packages `npm ci` installs into `dir` on this computer, worked out by the npm that runs the install: its
 * ideal tree from the lock, with optional packages for other platforms (and what only they need) left out. Nothing is
 * written, and offline a lock that does not settle the tree by itself fails here instead of asking the registry.
 */
export async function lockedPackages(npmDir: string, dir: string, platform: Platform = {}): Promise<LockedPackage[]> {
  const npmRequire = createRequire(join(npmDir, 'package.json'));
  const Arborist = npmRequire('@npmcli/arborist');
  const npmVersion: string = npmRequire('./package.json').version;
  const arb = new Arborist({ path: dir, offline: true, npmVersion, ...platform });
  const tree: { inventory: Map<string, IdealNode> } = await arb.buildIdealTree();
  return [...tree.inventory.values()]
    .filter((n) => !n.isProjectRoot && !n.isLink && !n.inBundle && !n.inert)
    .map((n) => ({ location: n.location, integrity: n.integrity ?? undefined }));
}

// The digest npm reads a package from is the strongest one its integrity lists (ssri's `pickAlgorithm`).
const PRIORITY = ['md5', 'whirlpool', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];

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
    .map((m) => ({ algorithm: m[1].toLowerCase(), hex: Buffer.from(m[2], 'base64').toString('hex') }));
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

/** npm failures that mean the registry could not be reached: offline, no DNS, a refused or dropped connection. */
export const NETWORK_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ECONNABORTED'];

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
