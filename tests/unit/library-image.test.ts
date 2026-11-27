/**
 * Reading a library image for what Assets asks about it (#1046): exactly the bytes of the file at its path, never through
 * a link or past the size it had, and what it says remembered under its stat only once the file has settled.
 */
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryImageReader, readLibraryFile } from '../../src/main/project/library-image';
import { photoMetadata } from '../../src/main/project/photo-metadata';
import { sha } from '../../src/main/project/fsutil';
import type { AssetRecord } from '../../src/shared/types';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function project(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'so-library-')));
  dirs.push(d);
  mkdirSync(join(d, 'static/assets'), { recursive: true });
  return d;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A small PNG with an author's text chunk: a picture cleanPhoto reads credits from. */
function png(text: string): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from(`Author\0${text}`, 'latin1')), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1])), chunk('IEND', Buffer.alloc(0))]);
}
const record = (file: string, bytes: Buffer): AssetRecord => ({ id: 'img1', name: 'Pic', file, mime: 'image/png', bytes: bytes.length, hash: sha(bytes), kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' }) as AssetRecord;

describe('reading a library image', () => {
  it('reads exactly the file looked at, and calls it changed when it grew or was replaced meanwhile', async () => {
    const dir = project();
    const file = join(dir, 'static/assets/pic.png');
    writeFileSync(file, png('Ana'));
    const looked = lstatSync(file, { bigint: true });
    expect((await readLibraryFile(file, looked)) as Buffer).toEqual(png('Ana'));
    appendFileSync(file, 'more');
    expect(await readLibraryFile(file, looked)).toBe('changed');
    writeFileSync(file, png('Bo'));
    expect(await readLibraryFile(file, lstatSync(file, { bigint: true }))).toEqual(png('Bo'));
  });

  it('never reads through a link at the path', async () => {
    const dir = project();
    const outside = join(project(), 'secret.png');
    writeFileSync(outside, png('Secret'));
    const file = join(dir, 'static/assets/pic.png');
    symlinkSync(outside, file);
    // Refused (or, where a link cannot be refused at its opening, caught as another file than the path's).
    expect(Buffer.isBuffer(await readLibraryFile(file, lstatSync(outside, { bigint: true })))).toBe(false);
    expect(await new LibraryImageReader(() => 0).facts(dir, record('static/assets/pic.png', png('Secret')))).toBeNull();
  });

  it('remembers what a settled file says, without its credits, and reads it again once anything changes it', async () => {
    const dir = project();
    const file = join(dir, 'static/assets/pic.png');
    const bytes = png('Ana');
    writeFileSync(file, bytes);
    await sleep(20);
    let settle = 0;
    const reader = new LibraryImageReader(() => settle);
    const a = record('static/assets/pic.png', bytes);
    const read = await reader.read(dir, a);
    expect(read?.facts).toMatchObject({ hash: sha(bytes), metadata: photoMetadata(bytes) });
    expect(read?.facts.credits?.text?.length).toBe(1);
    // Remembered: the hash and what it carries, and nothing more.
    expect(await reader.remembered(dir, a)).toEqual({ hash: sha(bytes), metadata: photoMetadata(bytes) });
    // Rewritten with the same bytes: its stat changed, so nothing is remembered until it is read again.
    writeFileSync(file, bytes);
    expect(await reader.remembered(dir, a)).toBeNull();
    // Read while it has not settled: answered, but not remembered.
    settle = 60_000;
    expect((await reader.facts(dir, a))?.hash).toBe(sha(bytes));
    expect(await reader.remembered(dir, a)).toBeNull();
  });
});
