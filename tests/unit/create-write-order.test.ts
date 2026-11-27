/**
 * A new project's files written a few at a time (#961), without giving up what the order of its writes promised: the
 * manifest and the documents every page and component is read with are in place, one after another, before any page
 * is begun, and the first publication's files only once their claims are, so a project cut off part way is never one
 * that opens with a theme lock or a library made up for it.
 */
import { mkdtempSync, promises as fsp, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import type { EditOperation } from '@shared/ops';
import { ProjectSession } from '../../src/main/project/session';
import { eachAtMost } from '../../src/main/project/fsutil';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('a new project’s writes', () => {
  it('put the manifest and the documents pages are read with in place, in order, before any page is begun', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-create-order-')));
    dirs.push(dir);
    const events: string[] = [];
    const rel = (p: string) => relative(dir, p).split('\\').join('/');
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation((async (p: string, flags?: string, mode?: number) => {
      // A temporary file is where each write begins.
      if (flags === 'wx') events.push(`begin ${rel(join(p, '..'))}`);
      return open(p, flags, mode);
    }) as never);
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      events.push(`done ${rel(String(to))}`);
    });
    const s = await ProjectSession.create(dir, createStarterState('business', 'Order Studio', false));
    s.removeAllListeners();
    const done = (path: string) => events.indexOf(`done ${path}`);
    const firstPage = events.findIndex((e) => e.startsWith('begin siteorigin/pages'));
    expect(firstPage).toBeGreaterThan(0);
    const core = ['siteorigin.project.json', 'siteorigin/site.json', 'siteorigin/tokens.json', 'siteorigin/assets.json', 'siteorigin/theme-lock.json'];
    for (const path of core) {
      expect(done(path), path).toBeGreaterThanOrEqual(0);
      expect(done(path), path).toBeLessThan(firstPage);
    }
    // One after another, in that order.
    expect(core.map(done)).toEqual([...core.map(done)].sort((a, b) => a - b));
    // The first publication's own claims are written before any of its files is begun.
    const claims = done('siteorigin/generated-manifest.json');
    const generated = events.findIndex((e, i) => i > claims && e.startsWith('begin src/'));
    expect(claims).toBeGreaterThan(firstPage);
    expect(generated).toBeGreaterThan(claims);
    expect(events.slice(firstPage, claims).some((e) => e.startsWith('begin src/'))).toBe(false);
  });

  it('write a collection’s settings before its entries, and the pages and components before both', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-create-order-')));
    dirs.push(dir);
    const ops = [{ type: 'collection.create', collectionId: 'posts' }, ...[1, 2, 3].map((i) => ({ type: 'entry.create', collectionId: 'posts', entryId: `en_order${i}`, title: `Post ${i}`, publishedAt: '2026-01-0' + i, draft: false, excerpt: 'An entry.', body: ['Its body.'] }))] as EditOperation[];
    const state = applyOperations(createStarterState('business', 'Order Studio', false), ops).state;
    const events: string[] = [];
    const rel = (p: string) => relative(dir, p).split('\\').join('/');
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'open').mockImplementation((async (p: string, flags?: string, mode?: number) => {
      if (flags === 'wx') events.push(`begin ${rel(join(p, '..'))}`);
      return open(p, flags, mode);
    }) as never);
    const rename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      events.push(`done ${rel(String(to))}`);
    });
    const s = await ProjectSession.create(dir, state);
    s.removeAllListeners();
    const settings = events.findIndex((e) => /^done siteorigin\/collections\/posts\/collection\.json$/.test(e));
    const entries = events.flatMap((e, i) => (e.startsWith('begin siteorigin/collections/posts/') && !e.endsWith('/posts') ? [i] : []));
    expect(settings).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(0);
    expect(Math.min(...entries)).toBeGreaterThan(settings);
    const lastPageOrComponent = Math.max(...events.flatMap((e, i) => (/^done siteorigin\/(pages|components)\//.test(e) ? [i] : [])));
    const firstCollection = events.findIndex((e) => e.startsWith('begin siteorigin/collections'));
    expect(firstCollection).toBeGreaterThan(lastPageOrComponent);
  });
});

describe('writing a few at a time', () => {
  it('starts nothing after a failure, and throws it only once every write already started has settled', async () => {
    const log: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const run = eachAtMost(2, ['slow', 'fails', 'never'], async (name) => {
      log.push(`start ${name}`);
      if (name === 'slow') await slow;
      if (name === 'fails') throw new Error('disk full');
      log.push(`end ${name}`);
    });
    let settled = false;
    void run.catch(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    // The failure is known, but the slow write is still going: nothing more starts, and nothing is thrown yet.
    expect(settled).toBe(false);
    release();
    await expect(run).rejects.toThrow('disk full');
    expect(log).toEqual(['start slow', 'start fails', 'end slow']);
  });
});
