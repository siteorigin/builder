import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, promises as fsp, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFileAt } from '../../src/main/project/stable-read';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('hashing a file through one handle', () => {
  it('hashes every byte of files smaller than, as large as and larger than the pieces it reads in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stable-read-'));
    dirs.push(dir);
    const MiB = 1 << 20;
    for (const size of [0, 1, 1023, 1024, 1025, 5000, MiB - 1, MiB, MiB + 17, 3 * MiB + 5]) {
      const bytes = randomBytes(size);
      const file = join(dir, `f-${size}`);
      writeFileSync(file, bytes);
      let counted = 0;
      const got = await hashFileAt(file, (n) => (counted += n));
      expect(typeof got === 'object' && got.hash, `a file of ${size} bytes`).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(counted, `a file of ${size} bytes`).toBe(size);
    }
  });

  it('reads into a piece the size of the file, at least 1 KiB and at most 1 MiB, never a fresh 1 MiB for a small file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stable-read-'));
    dirs.push(dir);
    const pieces: number[] = [];
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle) as (buffer: Buffer, ...rest: unknown[]) => Promise<unknown>;
      (handle as unknown as { read: typeof read }).read = (buffer: Buffer, ...rest: unknown[]) => {
        pieces.push(buffer.length);
        return read(buffer, ...rest);
      };
      return handle;
    });
    const MiB = 1 << 20;
    const sizes: Array<[number, number]> = [
      [0, 1024],
      [100, 1024],
      [5000, 5000],
      [3 * MiB + 5, MiB]
    ];
    for (const [size, piece] of sizes) {
      writeFileSync(join(dir, `p-${size}`), randomBytes(size));
      pieces.length = 0;
      expect(typeof (await hashFileAt(join(dir, `p-${size}`), () => undefined))).toBe('object');
      expect(new Set(pieces), `a file of ${size} bytes`).toEqual(new Set([piece]));
    }
  });
});
