/**
 * safeJoin keeps every path inside the project, links included. A path with no link below the project's folder is
 * settled by looking at its parts (#959); every other path is decided by real paths, as it always was. Each case here
 * is decided exactly as the full real-path check decides it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeJoin } from '../../src/main/project/fsutil';

/** The check as it was before the parts were looked at: real paths, always. */
function byRealPaths(root: string, rel: string): string {
  if (rel.includes('\0')) throw new Error('Invalid path.');
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) throw new Error(`Path escapes the project: ${rel}`);
  let probe = abs;
  while (!existsSync(probe) && probe !== root) probe = dirname(probe);
  const realRoot = realpathSync(root);
  const realProbe = realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) throw new Error(`Path escapes the project through a link: ${rel}`);
  return abs;
}

const outcome = (fn: () => string) => {
  try {
    return { ok: fn() };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('safeJoin (#959)', () => {
  // Through the temporary folder's own name (on macOS /var is a link to /private/var), and through its real one.
  for (const real of [false, true]) {
    it(`decides every path as the real-path check does, the project reached by ${real ? 'its real path' : 'a link above it'}`, () => {
      const base = mkdtempSync(join(tmpdir(), 'so-safejoin-'));
      dirs.push(base);
      const top = real ? realpathSync(base) : base;
      const root = join(top, 'project');
      const outside = join(top, 'outside');
      mkdirSync(join(root, 'src/routes/blog'), { recursive: true });
      mkdirSync(join(outside, 'deep'), { recursive: true });
      writeFileSync(join(root, 'src/routes/+page.svelte'), 'x');
      writeFileSync(join(root, 'file.txt'), 'x');
      writeFileSync(join(outside, 'secret.txt'), 'x');
      symlinkSync(outside, join(root, 'src/out'));
      symlinkSync(join(outside, 'secret.txt'), join(root, 'src/secret.txt'));
      symlinkSync(join(root, 'src/routes'), join(root, 'inside'));
      symlinkSync(join(outside, 'nothing-here'), join(root, 'src/dangling-out'));
      symlinkSync(join(root, 'nothing-here'), join(root, 'src/dangling-in'));
      symlinkSync(join(root, 'src/out'), join(root, 'chain'));
      const cases = [
        'src/routes/+page.svelte',
        'src/routes/blog/new/+page.svelte',
        'missing/deeper/file.json',
        'file.txt/under-a-file',
        'src/out',
        'src/out/secret.txt',
        'src/out/deep/new.txt',
        'src/out/missing/new.txt',
        'src/secret.txt',
        'inside/+page.svelte',
        'inside/new/file.txt',
        'src/dangling-out',
        'src/dangling-out/x',
        'src/dangling-in',
        'chain/secret.txt',
        '../outside/secret.txt',
        '/etc/passwd',
        'src/../../outside',
        '.',
        'a\0b'
      ];
      const decided = cases.map((rel) => [rel, outcome(() => safeJoin(root, rel))]);
      expect(decided).toEqual(cases.map((rel) => [rel, outcome(() => byRealPaths(root, rel))]));
      // And the ones that matter most, said plainly.
      for (const rel of ['src/out/secret.txt', 'src/out/missing/new.txt', 'src/secret.txt', 'chain/secret.txt']) expect(() => safeJoin(root, rel)).toThrow(/through a link/);
      expect(safeJoin(root, 'inside/+page.svelte')).toBe(join(root, 'inside/+page.svelte'));
      expect(safeJoin(root, 'missing/deeper/file.json')).toBe(join(root, 'missing/deeper/file.json'));
    });
  }

  it('refuses every path of a project folder that is not there, as before', () => {
    const base = mkdtempSync(join(tmpdir(), 'so-safejoin-'));
    dirs.push(base);
    const gone = join(base, 'gone');
    for (const rel of ['siteorigin/site.json', 'file.txt']) {
      expect(() => safeJoin(gone, rel)).toThrow();
      expect(outcome(() => safeJoin(gone, rel))).toEqual(outcome(() => byRealPaths(gone, rel)));
    }
  });
});
