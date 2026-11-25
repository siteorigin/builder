// A save's files reach the preview as one update (#735): the session asks the preview to hold its hot updates before
// it replaces the first file the preview watches, and hands it every file the save changed once they are all on disk.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { pageFile } from '@generator/index';
import { ProjectSession, type SessionEvent } from '../../src/main/project/session';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-hold-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Hold', false));
  s.settleMs = 0;
  return { dir, s };
}

/** What the preview's dev server watches: the project's own files, not the documents or the editor's cache. */
const watched = (rel: string) => !/^(siteorigin|\.siteorigin|node_modules|build)(\/|$)/.test(rel);

/** Steps in order: each hold, release and file replaced or removed that the preview watches. */
function record(dir: string, s: ProjectSession) {
  const steps: string[] = [];
  const name = (p: unknown) => relative(dir, String(p)).split(sep).join('/');
  const rename = fsp.rename.bind(fsp);
  const rm = fsp.rm.bind(fsp);
  const utimes = fsp.utimes.bind(fsp);
  vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    if (watched(name(to))) steps.push(`write ${name(to)}`);
  });
  vi.spyOn(fsp, 'rm').mockImplementation(async (p, o) => {
    await rm(p, o);
    if (watched(name(p)) && !name(p).endsWith('.tmp')) steps.push(`remove ${name(p)}`);
  });
  vi.spyOn(fsp, 'utimes').mockImplementation(async (p, a, m) => {
    await utimes(p, a, m);
    if (watched(name(p))) steps.push(`touch ${name(p)}`);
  });
  const released: string[][] = [];
  let holds = 0;
  s.previewHold = async () => {
    const n = ++holds;
    // The preview answers a moment later: nothing may be replaced before it does.
    await new Promise((r) => setTimeout(r, 5));
    steps.push(`held ${n}`);
    return (files) => {
      steps.push(`released ${n}`);
      released.push(files);
    };
  };
  return { steps, released };
}

describe('holding the preview while a save lands (#735)', () => {
  it('holds before the first watched file is replaced and releases with every file the save changed', async () => {
    const { dir, s } = await make();
    const about = s.state.site.pageOrder[1];
    const { steps, released } = record(dir, s);
    let event: SessionEvent | undefined;
    s.on('changed', (e: SessionEvent) => {
      event = e;
      steps.push('changed');
    });
    // A new page: its own route file, and the navigation every page shows.
    const r = await s.apply({ operations: [{ type: 'page.duplicate', pageId: about, title: 'Our team' }] }, { label: 'Duplicate page' });
    expect(r.ok).toBe(true);
    const writes = steps.filter((step) => step.startsWith('write ') || step.startsWith('remove ') || step.startsWith('touch '));
    expect(writes.length).toBeGreaterThan(1);
    // One hold for the whole save, taken before any watched file changes and released after the last, before the
    // revision is announced.
    expect(steps[0]).toBe('held 1');
    expect(steps.filter((step) => step.startsWith('held '))).toEqual(['held 1']);
    expect(steps.at(-2)).toBe('released 1');
    expect(steps.at(-1)).toBe('changed');
    // Every file the preview reloads is handed over, the new page's own among them.
    const copy = Object.values(s.state.pages).find((p) => p.title === 'Our team')!;
    expect(released[0]).toEqual(expect.arrayContaining([...event!.changedFiles, pageFile(copy)]));
    for (const step of writes) expect(released[0]).toContain(step.replace(/^\w+ /, ''));
  });

  it('releases a hold when the save stops part way', async () => {
    const { dir, s } = await make();
    const about = s.state.site.pageOrder[1];
    const { steps, released } = record(dir, s);
    const rename = fsp.rename as unknown as ReturnType<typeof vi.fn>;
    const real = rename.getMockImplementation()!;
    let n = 0;
    rename.mockImplementation(async (from: string, to: string) => {
      // The second file the save replaces that the preview watches (not a document or an editor variant).
      if (watched(relative(dir, String(to)).split(sep).join('/')) && ++n === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return real(from, to);
    });
    await expect(s.apply({ operations: [{ type: 'page.duplicate', pageId: about, title: 'Our team' }] }, { label: 'Duplicate page' })).rejects.toThrow('disk full');
    expect(steps.filter((step) => /^(held|released) /.test(step))).toEqual(['held 1', 'released 1']);
    // What did land is handed over, so the preview shows the files as they are on disk.
    const landed = steps.filter((step) => step.startsWith('write ')).map((step) => step.slice('write '.length));
    expect(landed.length).toBeGreaterThan(0);
    expect(released[0]).toEqual(expect.arrayContaining(landed));
  });

  it('saves as before with no preview to hold', async () => {
    const { s } = await make();
    const about = s.state.site.pageOrder[1];
    expect(s.previewHold).toBeNull();
    expect((await s.apply({ operations: [{ type: 'page.duplicate', pageId: about, title: 'Our team' }] }, { label: 'Duplicate page' })).ok).toBe(true);
  });
});
