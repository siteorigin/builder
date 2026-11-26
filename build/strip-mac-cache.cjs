// Takes the starter's macOS-only packages out of the npm cache shipped in the Mac app (build/after-pack.cjs).
//
// Those packages hold native code (Rolldown's and Lightning CSS's bindings, fsevents) signed only by their publishers,
// and Apple's notary service looks inside the cache's tarballs and rejects the app over them. They can't be re-signed
// there: npm checks each tarball against the integrity in the project's lockfile. So the Mac app ships without them,
// and creating the first project on a Mac downloads just those; setup already handles a cache that lacks some packages
// (src/main/runtime/manager.ts), and keeps them in the user's own cache for later projects.
const { existsSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const { join, relative } = require('node:path');
const { gunzipSync } = require('node:zlib');

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

/**
 * Whether `head` starts a Mach-O file: a thin binary of either byte order or word size, or a fat (universal) one. A fat
 * header shares its magic with Java class files, which carry a version of 45 or more where a fat binary counts its
 * architectures, so only a small count is taken as Mach-O.
 */
function isMachO(head) {
  if (head.length < 8) return false;
  const magic = head.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true;
  return (magic === 0xcafebabe || magic === 0xcafebabf) && head.readUInt32BE(4) > 0 && head.readUInt32BE(4) < 30;
}

/** The members of a tar archive whose content is Mach-O. Handles ustar names and pax/GNU long names. */
function machOMembers(tar) {
  const found = [];
  let longName = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const body = tar.subarray(at + 512, at + 512 + size);
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') longName = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null;
    else if ((type === '0' || type === '' || type === '7') && isMachO(body.subarray(0, 8))) found.push(name);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

/** Every Mach-O file inside the gzipped tarballs of the npm cache at `cache`, by cache file and archive member. */
function findMachO(cache) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const data = readFileSync(path);
        if (data[0] !== 0x1f || data[1] !== 0x8b) continue;
        for (const member of machOMembers(gunzipSync(data))) found.push({ file: relative(cache, path), member });
      }
    }
  };
  const content = join(cache, '_cacache', 'content-v2');
  if (existsSync(content)) visit(content);
  return found;
}

module.exports = { macOnlyPackages, contentFiles, stripMacOnly, isMachO, machOMembers, findMachO };
