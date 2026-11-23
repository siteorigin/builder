/**
 * Whether creating a project downloads anything: the packages npm would install are worked out by npm itself, and
 * looked up in the npm caches the way npm finds them, so the New project dialog and setup agree on it.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheCoverage, contentPaths, lockedPackages, npmErrorCode } from '../../src/main/runtime/availability';

const require = createRequire(import.meta.url);
const npmDir = dirname(require.resolve('npm/package.json'));
/** npm's own cache layout, from the npm the app installs with. */
const cacachePath: (cache: string, integrity: string) => string = require(join(npmDir, 'node_modules', 'cacache', 'lib', 'content', 'path.js'));
const starter = join(__dirname, '../../templates/sveltekit-brochure/files');

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-npm-cache-'));
  dirs.push(d);
  return d;
};

/** Put a package's content where npm's cache keeps it (as `npm ci --cache` leaves it). */
const store = (cache: string, integrity: string) => {
  const p = cacachePath(join(cache, '_cacache'), integrity);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'tarball');
};
const sri = (text: string, algorithm = 'sha512') => `${algorithm}-${createHash(algorithm).update(text).digest('base64')}`;

const macArm = { os: 'darwin', cpu: 'arm64' };

describe('the website tools setup installs', () => {
  it('are the starter packages npm installs on this platform, without another platform’s native tools or what only they need', async () => {
    const packages = await lockedPackages(npmDir, starter, macArm);
    const mac = packages.map((p) => p.location);
    expect(mac).not.toContain('');
    expect(mac).toContain('node_modules/@sveltejs/kit');
    const lock = JSON.parse(readFileSync(join(starter, 'package-lock.json'), 'utf8'));
    expect(packages.find((p) => p.location === 'node_modules/@sveltejs/kit')?.integrity).toBe(lock.packages['node_modules/@sveltejs/kit'].integrity);
    // Native tools are told apart: npm skips one it could not fetch without failing.
    expect(packages.find((p) => p.location === 'node_modules/@rolldown/binding-darwin-arm64')?.native).toBe(true);
    expect(packages.find((p) => p.location === 'node_modules/@sveltejs/kit')?.native).toBe(false);
    expect(packages.find((p) => p.location === 'node_modules/fsevents')?.native).toBe(false);
    expect(mac).toContain('node_modules/@rolldown/binding-darwin-arm64');
    expect(mac).not.toContain('node_modules/@rolldown/binding-linux-x64-gnu');
    // The WebAssembly binding is optional and for another CPU; its own dependencies have no platform of their own but
    // are needed by nothing else, so npm skips them too.
    expect(mac).not.toContain('node_modules/@rolldown/binding-wasm32-wasi');
    expect(mac).not.toContain('node_modules/@emnapi/core');
    expect(mac).not.toContain('node_modules/tslib');

    const linux = (await lockedPackages(npmDir, starter, { os: 'linux', cpu: 'x64', libc: 'glibc' })).map((p) => p.location);
    expect(linux).toContain('node_modules/@rolldown/binding-linux-x64-gnu');
    expect(linux).not.toContain('node_modules/@rolldown/binding-linux-x64-musl');
    expect(linux).not.toContain('node_modules/@rolldown/binding-darwin-arm64');
    expect(new Set(linux).size).toBe(linux.length);
  });

  it('are the same for a new project, whose lock carries its own name', async () => {
    const dir = tempDir();
    const pkg = JSON.parse(readFileSync(join(starter, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(starter, 'package-lock.json'), 'utf8'));
    pkg.name = lock.name = lock.packages[''].name = 'meadow-studio';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
    expect(await lockedPackages(npmDir, dir, macArm)).toEqual(await lockedPackages(npmDir, starter, macArm));
  });

  it('never runs a project’s own npm extension, as npm ci never does', async () => {
    const dir = tempDir();
    for (const f of ['package.json', 'package-lock.json']) writeFileSync(join(dir, f), readFileSync(join(starter, f)));
    const ran = join(dir, 'ran');
    writeFileSync(join(dir, '.npm-extension.cjs'), `require('fs').writeFileSync(${JSON.stringify(ran)}, 'ran'); module.exports = { transformManifest: (p) => p };`);
    expect((await lockedPackages(npmDir, dir, macArm)).length).toBeGreaterThan(40);
    expect(existsSync(ran)).toBe(false);
  });

  it('never fetches a git dependency the lock does not settle, as npm’s own defaults never do', async () => {
    const dir = tempDir();
    const deps = { y: 'git+https://example.invalid/y.git' };
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', dependencies: deps } } }));
    await expect(lockedPackages(npmDir, dir, macArm, tempDir())).rejects.toMatchObject({ code: 'EALLOWGIT' });
  });

  it('never fetches a remote tarball the lock does not settle, as npm’s own defaults never do', async () => {
    const dir = tempDir();
    const deps = { z: 'https://example.invalid/z-1.0.0.tgz' };
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', dependencies: deps } } }));
    await expect(lockedPackages(npmDir, dir, macArm, tempDir())).rejects.toMatchObject({ code: 'EALLOWREMOTE' });
  });

  it('cannot be told from a project whose lock does not settle them, without asking the registry', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.3.0' } }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', dependencies: { 'left-pad': '1.3.0' } } } }));
    await expect(lockedPackages(npmDir, dir, macArm)).rejects.toThrow();
  });
});

describe('website tools availability', () => {
  it('finds a package where npm’s own cache keeps it', () => {
    const integrity = sri('svelte');
    expect(contentPaths('/c', integrity)).toEqual([cacachePath('/c/_cacache', integrity)]);
    // Several digests: npm reads the strongest algorithm only, in whatever order they come.
    expect(contentPaths('/c', `${sri('svelte', 'sha1')} ${integrity}`)).toEqual([cacachePath('/c/_cacache', integrity)]);
    expect(contentPaths('/c', `${integrity} ${sri('svelte', 'sha1')}`)).toEqual([cacachePath('/c/_cacache', integrity)]);
    // Two of the strongest: npm takes either copy.
    expect(contentPaths('/c', `${integrity} ${sri('kit')}`)).toEqual([cacachePath('/c/_cacache', integrity), cacachePath('/c/_cacache', sri('kit'))]);
    // An algorithm this Node cannot compute is passed over, as npm passes it over; one it can but npm does not rank
    // is still used when it is the only one.
    expect(contentPaths('/c', `whirlpool-${Buffer.from('x').toString('base64')} ${sri('svelte', 'md5')}`)).toEqual([cacachePath('/c/_cacache', sri('svelte', 'md5'))]);
    expect(contentPaths('/c', sri('svelte', 'blake2b512'))).toEqual([cacachePath('/c/_cacache', sri('svelte', 'blake2b512'))]);
  });

  it('says nothing is downloaded when every package this computer needs is in the cache, and counts what is not', async () => {
    const cache = tempDir();
    const needed = await lockedPackages(npmDir, starter, macArm);
    expect(cacheCoverage(needed, [cache])).toEqual({ offline: false, missing: needed.length, needed: needed.length });
    for (const p of needed) store(cache, p.integrity!);
    expect(cacheCoverage(needed, [cache])).toEqual({ offline: true, missing: 0, needed: needed.length });
    // Another computer's native tools are not in this cache: there, setup downloads them.
    const linux = cacheCoverage(await lockedPackages(npmDir, starter, { os: 'linux', cpu: 'x64', libc: 'glibc' }), [cache]);
    expect(linux.offline).toBe(false);
    expect(linux.missing).toBeGreaterThan(0);
  });

  it('finds packages in either the shipped or the user cache, and treats one with no integrity as a download', () => {
    const [shipped, user] = [tempDir(), tempDir()];
    const packages = [
      { location: 'node_modules/a', integrity: sri('a') },
      { location: 'node_modules/b', integrity: sri('b') }
    ];
    store(shipped, sri('a'));
    expect(cacheCoverage(packages, [shipped, user])).toEqual({ offline: false, missing: 1, needed: 2 });
    store(user, sri('b'));
    expect(cacheCoverage(packages, [shipped, user])).toEqual({ offline: true, missing: 0, needed: 2 });
    expect(cacheCoverage([...packages, { location: 'node_modules/from-git' }], [shipped, user])).toEqual({ offline: false, missing: 1, needed: 3 });
  });

  it('reads the code npm reports a failure with', () => {
    expect(npmErrorCode('npm error code ENOTFOUND\nnpm error network request failed')).toBe('ENOTFOUND');
    expect(npmErrorCode('npm WARN x\nnpm ERR! code ENOTCACHED\n')).toBe('ENOTCACHED');
    expect(npmErrorCode('Segmentation fault')).toBeUndefined();
    // Only npm's own error line counts, not a mention of one inside other output.
    expect(npmErrorCode('a log line quoting "npm error code ENOTFOUND"')).toBeUndefined();
  });
});
