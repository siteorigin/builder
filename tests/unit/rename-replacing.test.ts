import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, renameReplacing } from '../../src/main/project/fsutil';

const dirs: string[] = [];
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', realPlatform);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const fail = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

/** A rename that fails with each of `codes` in turn, then succeeds; and a clock that only moves when slept on. */
function harness(codes: string[], platform: NodeJS.Platform = 'win32') {
  let t = 0;
  const calls: string[] = [];
  const waits: number[] = [];
  const opts = {
    platform,
    rename: async (from: string, to: string) => {
      calls.push(`${from}->${to}`);
      const code = codes.shift();
      if (code) throw fail(code);
    },
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    }
  };
  return { opts, calls, waits, elapsed: () => t };
}

describe('renameReplacing', () => {
  it('retries a rename Windows refuses for a moment, then succeeds', async () => {
    const h = harness(['EPERM', 'EACCES', 'EBUSY']);
    await renameReplacing('a.tmp', 'a.json', h.opts);
    expect(h.calls).toEqual(['a.tmp->a.json', 'a.tmp->a.json', 'a.tmp->a.json', 'a.tmp->a.json']);
    // A short wait that grows each time.
    expect(h.waits).toHaveLength(3);
    expect(h.waits[0]).toBeLessThanOrEqual(20);
    expect(h.waits[1]).toBeGreaterThan(h.waits[0]);
    expect(h.waits[2]).toBeGreaterThan(h.waits[1]);
  });

  it('fails at once on other platforms, which do not refuse a rename for a moment', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const h = harness(['EPERM', 'EPERM'], platform);
      await expect(renameReplacing('a.tmp', 'a.json', h.opts)).rejects.toMatchObject({ code: 'EPERM' });
      expect(h.calls).toHaveLength(1);
      expect(h.waits).toEqual([]);
    }
  });

  it('fails at once on Windows for an error that waiting cannot fix', async () => {
    for (const code of ['ENOENT', 'EIO', 'EXDEV', 'ENOSPC']) {
      const h = harness([code, code]);
      await expect(renameReplacing('a.tmp', 'a.json', h.opts)).rejects.toMatchObject({ code });
      expect(h.calls).toHaveLength(1);
      expect(h.waits).toEqual([]);
    }
  });

  it('gives up with the last error once its budget is spent', async () => {
    const h = harness(Array(1000).fill('EPERM'));
    await expect(renameReplacing('a.tmp', 'a.json', { ...h.opts, budgetMs: 2000 })).rejects.toMatchObject({ code: 'EPERM' });
    expect(h.elapsed()).toBe(2000);
    expect(h.calls.length).toBeGreaterThan(3);
    expect(h.calls.length).toBeLessThan(30);
    // The default budget is a few seconds, not the minute some libraries wait.
    const d = harness(Array(1000).fill('EBUSY'));
    await expect(renameReplacing('a.tmp', 'a.json', d.opts)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(d.elapsed()).toBeGreaterThanOrEqual(1000);
    expect(d.elapsed()).toBeLessThanOrEqual(5000);
  });

  it('renames onto an existing file, replacing it, by default through fs.rename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-rename-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'new.tmp'), 'new');
    writeFileSync(join(dir, 'file.json'), 'old');
    await renameReplacing(join(dir, 'new.tmp'), join(dir, 'file.json'));
    expect(readdirSync(dir)).toEqual(['file.json']);
    expect(readFileSync(join(dir, 'file.json'), 'utf8')).toBe('new');
  });
});

describe('a durable write on Windows', () => {
  it('lands when something holds the file open for a moment as it is replaced', async () => {
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
    const dir = mkdtempSync(join(tmpdir(), 'so-rename-'));
    dirs.push(dir);
    const path = join(dir, 'generated-manifest.json');
    writeFileSync(path, 'old');
    const rename = fsp.rename.bind(fsp);
    let refused = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      // OneDrive, Defender or the indexer has the file open for the first two attempts.
      if (refused < 2) {
        refused++;
        throw fail('EPERM');
      }
      return rename(from, to);
    });
    expect(await atomicWrite(path, 'new')).toBe(true);
    expect(refused).toBe(2);
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['generated-manifest.json']);
  });
});
