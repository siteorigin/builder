// Copies the npm package into the packaged app (build/after-pack.cjs) without its symbolic links.
//
// npm's own node_modules/.bin holds symlinks to its dependencies' scripts. Copied as links they break the
// macOS signature: Node 24's cpSync keeps a nested link even with `dereference`, rewritten to an absolute
// path into the build machine's checkout, and `codesign --verify --strict` rejects a bundle with a link
// that points outside it. The app runs npm through bin/npm-cli.js, so the .bin shims are not needed.
const { cpSync, lstatSync, readdirSync } = require('node:fs');
const { join, relative } = require('node:path');

/** Copies `src` to `dest`, leaving out every symbolic link, and fails if one is still there afterwards. */
function copyNpm(src, dest) {
  cpSync(src, dest, { recursive: true, filter: (path) => !lstatSync(path).isSymbolicLink() });
  const links = findLinks(dest);
  if (links.length) throw new Error(`The copied npm still holds symbolic links: ${links.map((l) => relative(dest, l)).join(', ')}`);
}

/** Every symbolic link under `dir`. */
function findLinks(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) found.push(path);
    else if (entry.isDirectory()) found.push(...findLinks(path));
  }
  return found;
}

module.exports = { copyNpm, findLinks };
