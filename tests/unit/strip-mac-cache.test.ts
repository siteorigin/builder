// The Mac app's npm cache leaves out the starter's macOS-only native packages, which Apple's notary rejected
// ("The binary is not signed with a valid Developer ID certificate"), and keeps everything else. The packages are
// found in the cache the way the app itself looks for them, so setup sees them as missing and downloads them.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentFiles, findMachO, isMachO, macOnlyPackages, stripMacOnly } from '../../build/strip-mac-cache.cjs';
import { contentPaths } from '../../src/main/runtime/availability';

const STARTER_LOCK = join(__dirname, '..', '..', 'templates', 'sveltekit-brochure', 'files', 'package-lock.json');
const lock = JSON.parse(readFileSync(STARTER_LOCK, 'utf8')) as { packages: Record<string, { os?: string[]; cpu?: string[]; integrity?: string }> };

let cache: string;
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'so-mac-cache-'));
});
afterEach(() => rmSync(cache, { recursive: true, force: true }));

/** A cache holding a content file for every locked package, at the path the app reads it from. */
function fillCache(): void {
  for (const pkg of Object.values(lock.packages)) {
    if (!pkg.integrity) continue;
    for (const file of contentPaths(cache, pkg.integrity)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'tarball');
    }
  }
}

describe('stripMacOnly', () => {
  it("removes the starter's macOS-only packages, as the app finds them, and nothing else", () => {
    fillCache();
    const removed = stripMacOnly(cache, STARTER_LOCK);

    expect(removed.length).toBeGreaterThan(0);
    for (const [location, pkg] of Object.entries(lock.packages)) {
      if (!location || !pkg.integrity) continue;
      const present = contentPaths(cache, pkg.integrity).some((file) => existsSync(file));
      expect(present, location).toBe(!pkg.os?.includes('darwin'));
    }
  });

  it("covers every one of the starter's native macOS binaries", () => {
    const macOnly = new Set(macOnlyPackages(lock).map((p) => p.location));
    const nativeForMac = Object.entries(lock.packages).filter(([, pkg]) => pkg.cpu && pkg.os?.includes('darwin'));
    expect(nativeForMac.length).toBeGreaterThan(0);
    for (const [location] of nativeForMac) expect(macOnly.has(location), location).toBe(true);
  });

  it('removes the content stored under every digest a package lists', () => {
    const file = join(cache, 'package-lock.json');
    const integrity = `sha1-${Buffer.from('one').toString('base64')} sha512-${Buffer.from('two').toString('base64')}`;
    writeFileSync(file, JSON.stringify({ packages: { '': {}, 'node_modules/fsevents': { os: ['darwin'], integrity } } }));
    const files = contentFiles(cache, integrity);
    expect(files).toHaveLength(2);
    for (const f of files) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, 'tarball');
    }
    expect(stripMacOnly(cache, file)).toEqual(['node_modules/fsevents']);
    for (const f of files) expect(existsSync(f), f).toBe(false);
  });

  it('fails on a macOS-only package with no integrity to find it by', () => {
    const file = join(cache, 'package-lock.json');
    writeFileSync(file, JSON.stringify({ packages: { '': {}, 'node_modules/fsevents': { os: ['darwin'] } } }));
    expect(() => stripMacOnly(cache, file)).toThrow(/node_modules\/fsevents has no integrity/);
  });
});

describe('contentFiles', () => {
  it('names the same files the app looks a package up by', () => {
    const integrity = Object.values(lock.packages).find((p) => p.integrity)!.integrity!;
    expect(contentFiles(cache, integrity)).toEqual(contentPaths(cache, integrity));
  });
});

/** A gzipped npm tarball in the cache's content folder holding the given files (name to contents). */
function cachedTarball(name: string, files: Record<string, Buffer>): void {
  const src = mkdtempSync(join(tmpdir(), 'so-tarball-'));
  for (const [file, data] of Object.entries(files)) {
    mkdirSync(dirname(join(src, 'package', file)), { recursive: true });
    writeFileSync(join(src, 'package', file), data);
  }
  const out = join(cache, '_cacache', 'content-v2', 'sha512', 'aa', 'bb', name);
  mkdirSync(dirname(out), { recursive: true });
  execFileSync('tar', ['-czf', out, '-C', src, 'package']);
  rmSync(src, { recursive: true, force: true });
}

const thin = Buffer.concat([Buffer.from('cffaedfe0c000001', 'hex'), Buffer.alloc(56)]);
const fat = Buffer.concat([Buffer.from('cafebabe00000002', 'hex'), Buffer.alloc(56)]);
const javaClass = Buffer.concat([Buffer.from('cafebabe00000034', 'hex'), Buffer.alloc(56)]);

describe('findMachO', () => {
  it('finds thin and universal Mac binaries inside cached tarballs, by member', () => {
    cachedTarball('native', { 'index.js': Buffer.from('js'), 'thin.node': thin, 'deep/dir/fat.node': fat });
    cachedTarball('plain', { 'index.js': Buffer.from('module.exports = 1'), 'README.md': Buffer.from('# hi') });
    writeFileSync(join(cache, '_cacache', 'content-v2', 'sha512', 'aa', 'bb', 'packument'), '{"name":"x"}');

    expect(findMachO(cache).map((f) => f.member).sort()).toEqual(['package/deep/dir/fat.node', 'package/thin.node']);
  });

  it('finds nothing in a cache without native code, or with no content at all', () => {
    expect(findMachO(cache)).toEqual([]);
    cachedTarball('plain', { 'index.js': Buffer.from('js'), 'Main.class': javaClass });
    expect(findMachO(cache)).toEqual([]);
  });
});

describe('isMachO', () => {
  it('knows Mach-O headers from a Java class file and short files', () => {
    expect(isMachO(thin)).toBe(true);
    expect(isMachO(fat)).toBe(true);
    expect(isMachO(javaClass)).toBe(false);
    expect(isMachO(Buffer.from('cffa', 'hex'))).toBe(false);
  });
});
