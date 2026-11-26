// The npm copy the packaging hook puts in the app (build/after-pack.cjs) carries no symbolic links: on the
// release runners' Node a copied link pointed back into the checkout, and the macOS signature check rejected
// the bundle ("invalid destination for symbolic link in bundle").
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyNpm, findLinks } from '../../build/copy-npm.cjs';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'so-copy-npm-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A small package shaped like npm: a CLI script, a dependency, and .bin shims linking to it. */
function fakeNpm(): string {
  const src = join(dir, 'npm');
  mkdirSync(join(src, 'bin'), { recursive: true });
  writeFileSync(join(src, 'bin', 'npm-cli.js'), 'cli');
  mkdirSync(join(src, 'node_modules', 'semver', 'bin'), { recursive: true });
  writeFileSync(join(src, 'node_modules', 'semver', 'bin', 'semver.js'), 'semver');
  mkdirSync(join(src, 'node_modules', '.bin'));
  symlinkSync('../semver/bin/semver.js', join(src, 'node_modules', '.bin', 'semver'));
  writeFileSync(join(dir, 'outside.txt'), 'outside');
  symlinkSync(join(dir, 'outside.txt'), join(src, 'node_modules', '.bin', 'outside'));
  return src;
}

describe('copyNpm', () => {
  it('copies the files and leaves every symbolic link out', () => {
    const dest = join(dir, 'Resources', 'npm');
    copyNpm(fakeNpm(), dest);

    expect(readFileSync(join(dest, 'bin', 'npm-cli.js'), 'utf8')).toBe('cli');
    expect(readFileSync(join(dest, 'node_modules', 'semver', 'bin', 'semver.js'), 'utf8')).toBe('semver');
    // Not a link, and not a dereferenced copy either: the shims are gone.
    expect(existsSync(join(dest, 'node_modules', '.bin', 'semver'))).toBe(false);
    expect(existsSync(join(dest, 'node_modules', '.bin', 'outside'))).toBe(false);
    expect(findLinks(dest)).toEqual([]);
  });

  it('copies the real npm with its CLI and no links', () => {
    const dest = join(dir, 'npm');
    copyNpm(join(__dirname, '..', '..', 'node_modules', 'npm'), dest);

    expect(lstatSync(join(dest, 'bin', 'npm-cli.js')).isFile()).toBe(true);
    expect(findLinks(dest)).toEqual([]);
  });
});

describe('findLinks', () => {
  it('finds links at any depth, and nothing else', () => {
    const src = fakeNpm();
    expect(findLinks(src).sort()).toEqual([join(src, 'node_modules', '.bin', 'outside'), join(src, 'node_modules', '.bin', 'semver')]);
  });
});
