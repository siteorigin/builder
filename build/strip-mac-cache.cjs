// Takes the starter's macOS-only packages out of the npm cache shipped in the Mac app (build/after-pack.cjs).
//
// Those packages hold native code (Rolldown's and Lightning CSS's bindings, fsevents) signed only by their publishers,
// and Apple's notary service looks inside the cache's tarballs and rejects the app over them. They can't be re-signed
// there: npm checks each tarball against the integrity in the project's lockfile. So the Mac app ships without them,
// and creating the first project on a Mac downloads just those; setup already handles a cache that lacks some packages
// (src/main/runtime/manager.ts), and keeps them in the user's own cache for later projects.
const { existsSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');

/** The locked packages bound to macOS: their `os` field names darwin. */
function macOnlyPackages(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([location, pkg]) => location && Array.isArray(pkg.os) && pkg.os.includes('darwin'))
    .map(([location, pkg]) => ({ location, integrity: pkg.integrity }));
}

/** Every content file an integrity string can be stored under in an npm cache (cacache's content-v2 layout). */
function contentFiles(cache, integrity) {
  return integrity
    .trim()
    .split(/\s+/)
    .map((s) => /^([a-z0-9]+)-([A-Za-z0-9+/=]+)/i.exec(s))
    .filter(Boolean)
    .map(([, algorithm, digest]) => {
      const hex = Buffer.from(digest, 'base64').toString('hex');
      return join(cache, '_cacache', 'content-v2', algorithm.toLowerCase(), hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    });
}

/**
 * Removes the macOS-only packages in `lockFile` from the npm cache at `cache`, and returns their locations. Fails when
 * one has no integrity to find it by, or is still there afterwards.
 */
function stripMacOnly(cache, lockFile) {
  const removed = [];
  for (const { location, integrity } of macOnlyPackages(JSON.parse(readFileSync(lockFile, 'utf8')))) {
    if (!integrity) throw new Error(`${location} has no integrity in ${lockFile}, so it can't be found in the npm cache`);
    const files = contentFiles(cache, integrity);
    for (const file of files) rmSync(file, { force: true });
    if (files.some((file) => existsSync(file))) throw new Error(`${location} is still in the npm cache`);
    removed.push(location);
  }
  return removed;
}

module.exports = { macOnlyPackages, contentFiles, stripMacOnly };
