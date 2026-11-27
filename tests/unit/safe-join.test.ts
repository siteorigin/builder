/**
 * safeJoin keeps every path inside the project, links included. A path with no link below the project's folder is
 * settled by looking at its parts (#959); every other path is decided by real paths, as it always was. Each case here
 * is decided exactly as the full real-path check decides it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FolderPass, safeJoin, safeJoinLooking } from '../../src/main/project/fsutil';
import { stampOf } from '../../src/main/project/stable-read';

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
        'a\0b',
        // Written other ways than plainly: each is resolved, and decided as before.
        './src/routes/+page.svelte',
        'src//routes/+page.svelte',
        'src/./routes/+page.svelte',
        'src/routes/',
        'src/routes/../out/secret.txt',
        '..hidden/file',
        '.hidden/file',
        'src/...',
        'src\\routes',
        'C:file',
        ''
      ];
      const decided = cases.map((rel) => [rel, outcome(() => safeJoin(root, rel))]);
      expect(decided).toEqual(cases.map((rel) => [rel, outcome(() => byRealPaths(root, rel))]));
      // Checked together in one pass, each is decided the same.
      const pass = new FolderPass();
      expect(cases.map((rel) => [rel, outcome(() => safeJoinLooking(root, rel, pass).abs)])).toEqual(decided);
      // And the ones that matter most, said plainly.
      for (const rel of ['src/out/secret.txt', 'src/out/missing/new.txt', 'src/secret.txt', 'chain/secret.txt']) expect(() => safeJoin(root, rel)).toThrow(/through a link/);
      expect(safeJoin(root, 'inside/+page.svelte')).toBe(join(root, 'inside/+page.svelte'));
      expect(safeJoin(root, 'missing/deeper/file.json')).toBe(join(root, 'missing/deeper/file.json'));
    });
  }

  it('says what it saw at a regular file reached with no link, and nothing it did not see for itself (#964)', () => {
    const base = mkdtempSync(join(tmpdir(), 'so-safejoin-'));
    dirs.push(base);
    const root = join(base, 'project');
    const outside = join(base, 'outside');
    mkdirSync(join(root, 'src/routes/blog'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, 'src/routes/+page.svelte'), 'x');
    writeFileSync(join(root, 'file.txt'), 'x');
    writeFileSync(join(outside, 'secret.txt'), 'x');
    symlinkSync(join(root, 'src/routes'), join(root, 'inside'));
    symlinkSync(join(root, 'file.txt'), join(root, 'src/linked.txt'));
    symlinkSync(outside, join(root, 'src/out'));
    const looked = (rel: string) => {
      const { abs, st } = safeJoinLooking(root, rel);
      expect(abs).toBe(safeJoin(root, rel));
      return st === undefined || st === null ? st : stampOf(st);
    };
    // The file's own stat, the same as a stat by its path says.
    expect(looked('src/routes/+page.svelte')).toBe(stampOf(statSync(join(root, 'src/routes/+page.svelte'), { bigint: true })));
    expect(looked('file.txt')).toBe(stampOf(statSync(join(root, 'file.txt'), { bigint: true })));
    // Nothing there, below a folder that is.
    expect(looked('src/routes/blog/new/+page.svelte')).toBeNull();
    expect(looked('src/routes/missing.svelte')).toBeNull();
    // Anything it cannot vouch for is left to the caller: a link on the way or at the end, a folder, a file in the way.
    for (const rel of ['inside/+page.svelte', 'src/linked.txt', 'src/routes', 'missing/deeper/file.json']) expect(looked(rel), rel).toBeUndefined();
    // A file in the way: macOS and Linux say ENOTDIR, which it leaves to the caller. Windows says plainly that nothing
    // is there (ENOENT), and nothing can be.
    expect(looked('file.txt/under-a-file')).toBe(process.platform === 'win32' ? null : undefined);
    // And a path out through a link is refused exactly as safeJoin refuses it.
    expect(() => safeJoinLooking(root, 'src/out/secret.txt')).toThrow(/through a link/);
    expect(() => safeJoinLooking(root, '../outside/secret.txt')).toThrow(/escapes the project/);
  });

  it('reads a folder many paths go through once, and still finds every link among its entries (#964)', () => {
    const base = mkdtempSync(join(tmpdir(), 'so-safejoin-'));
    dirs.push(base);
    const root = join(base, 'project');
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, '+page.svelte'), 'x');
    const blog = join(root, 'src/routes/blog');
    const rels: string[] = [];
    for (let i = 0; i < 20; i++) {
      mkdirSync(join(blog, `post-${i}`), { recursive: true });
      writeFileSync(join(blog, `post-${i}`, '+page.svelte'), 'x');
      rels.push(`src/routes/blog/post-${i}/+page.svelte`);
    }
    // Among the folders read whole: a link out of the project, a link to a folder inside it, a file where a folder
    // should be, one not there yet, and one whose name is written in another case than on disk.
    symlinkSync(outside, join(blog, 'linked-out'));
    symlinkSync(join(blog, 'post-0'), join(blog, 'linked-in'));
    writeFileSync(join(blog, 'a-file'), 'x');
    const odd = ['linked-out', 'linked-in', 'a-file', 'missing', 'POST-1'].map((name) => `src/routes/blog/${name}/+page.svelte`);
    const all = [...rels, ...odd];
    const pass = new FolderPass();
    const decided = all.map((rel) => [rel, outcome(() => safeJoinLooking(root, rel, pass).abs)]);
    expect(decided).toEqual(all.map((rel) => [rel, outcome(() => byRealPaths(root, rel))]));
    expect(() => safeJoinLooking(root, 'src/routes/blog/linked-out/+page.svelte', pass)).toThrow(/through a link/);
    // What the pass says of each file is what a look of its own says.
    const own = (rel: string) => {
      const st = safeJoinLooking(root, rel).st;
      return st ? stampOf(st) : st;
    };
    // Including through the pass that has read the folder whole by now.
    for (const rel of all) if (!rel.includes('linked-out')) expect(((st) => (st ? stampOf(st) : st))(safeJoinLooking(root, rel, pass).st), rel).toEqual(own(rel));
  });

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
