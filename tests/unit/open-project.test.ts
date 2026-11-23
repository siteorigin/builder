/**
 * Opening a received project must always come back as a structured result: a truncated manifest names the file
 * and folder, leaves the folder untouched, and never rejects the call (which left the Open button disabled).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {},
  shell: {}
}));

import { Controller, readManifestSummary } from '../../src/main/controller';

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
const fingerprint = (d: string) =>
  readdirSync(d)
    .filter((f) => statSync(join(d, f)).isFile())
    .sort()
    .map((f) => `${f}:${createHash('sha256').update(readFileSync(join(d, f))).digest('hex')}`)
    .join('|');

beforeEach(() => {
  state.userData = tmp('so-userdata-');
});
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const truncated = '{"schemaVersion": 1, "projectId": "abc", "name": "Half a sit';

describe('opening a received project', () => {
  it('reports a truncated manifest by file and folder, for the chooser path and the recent path alike', async () => {
    const dir = tmp('so-truncated-');
    writeFileSync(join(dir, 'siteorigin.project.json'), truncated);
    const before = fingerprint(dir);
    const c = new Controller(() => null);
    const r = await c.open(dir);
    expect(r.ok).toBe(false);
    expect(r.needsTrust).toBeUndefined();
    expect(r.message).toContain('siteorigin.project.json');
    expect(r.message).toContain(dir);
    expect(fingerprint(dir)).toBe(before);
    // The same project reached again (the recent-project entry) behaves the same way, and a trust attempt is refused too.
    expect((await c.open(dir)).message).toBe(r.message);
    const t = await c.trustAndOpen(dir);
    expect(t.ok).toBe(false);
    expect(t.message).toContain(dir);
    expect(fingerprint(dir)).toBe(before);
  });

  it('answers a missing project folder with a normal message, not a rejection', async () => {
    const dir = tmp('so-empty-');
    const r = await new Controller(() => null).open(dir);
    expect(r).toEqual({ ok: false, message: expect.stringContaining('not a SiteOrigin Builder project') });
    const gone = join(dir, 'deleted');
    expect((await new Controller(() => null).open(gone)).ok).toBe(false);
  });

  it('still asks for trust on a healthy manifest, naming the project', async () => {
    const dir = tmp('so-healthy-');
    writeFileSync(join(dir, 'siteorigin.project.json'), JSON.stringify({ name: 'Cafe' }));
    const r = await new Controller(() => null).open(dir);
    expect(r.needsTrust).toEqual({ dir, name: 'Cafe' });
  });
});

describe('a trusted project with a truncated manifest', () => {
  it('names the file and folder and leaves the manifest as received, so another project can be opened', async () => {
    const dir = tmp('so-trusted-');
    const file = join(dir, 'siteorigin.project.json');
    writeFileSync(file, truncated);
    const c = new Controller(() => null);
    const t = await c.trustAndOpen(dir);
    expect(t.ok).toBe(false);
    expect(t.message).toContain('siteorigin.project.json');
    expect(t.message).toContain(dir);
    // Now trusted, the recent-project entry takes the trusted path and gets the same structured answer.
    const r = await c.open(dir);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(t.message);
    expect(readFileSync(file, 'utf8')).toBe(truncated);
    expect(c.session).toBeNull();
  });
});

describe('readManifestSummary', () => {
  it.each([['empty', ''], ['truncated', truncated], ['a JSON null', 'null'], ['an array', '[]']])('rejects %s', async (_n, text) => {
    const dir = tmp('so-manifest-');
    writeFileSync(join(dir, 'siteorigin.project.json'), text);
    const r = await readManifestSummary(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(dir);
  });

  it('falls back to the folder name when the manifest has none', async () => {
    const dir = tmp('so-noname-');
    mkdirSync(join(dir, 'x'));
    writeFileSync(join(dir, 'siteorigin.project.json'), '{}');
    const r = await readManifestSummary(dir);
    expect(r.ok && r.name).toBe(dir.split('/').pop());
  });
});
