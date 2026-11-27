import { describe, expect, it } from 'vitest';
import type { PerfRecord } from '../../src/shared/perf';
import type { ProjectState } from '../../src/shared/types';
import { Trace } from '../../scripts/perf/results';
import type { MemoryReading } from '../../scripts/perf/memory';
import { FIXTURES } from '../../scripts/perf/fixtures';
import { chainFor, type FixtureFacts, importedPostsDigest, POSTS_IMPORT_READINGS, postsImport } from '../../scripts/perf/scenarios';
import { WP_DRAFT_EVERY, WP_DRAFTS, WP_PICTURES, WP_POSTS, wpContent, wpExport, wpPost } from '../../scripts/perf/wordpress';

let seq = 0;
const m = (name: string, t: number, extra: Partial<PerfRecord> = {}): PerfRecord => ({ kind: 'mark', name, t, proc: 'main', pid: 1, seq: ++seq, ...extra });
const span = (name: string, t: number, ms: number, extra: Partial<PerfRecord> = {}) => m(name, t, { kind: 'span', ms, ...extra });
const facts: FixtureFacts = { spec: FIXTURES.small, pages: 3, entries: 0, assets: 0, projectComponents: 0, homePageId: 'pg_home', homeRoute: '/', heroId: 'n_hero', heading: 'Welcome' };
const MiB = 2 ** 20;

const reading = (label: string, kind: 'rest' | 'peak', roles: Record<string, number>, heapMain?: number): MemoryReading => {
  const r = Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, { processes: 1, bytes: v * MiB }]));
  const total = Object.values(r).reduce((n, x) => n + x.bytes, 0);
  return { label, kind, at: 0, processes: [], roles: r, total, count: Object.keys(r).length, ...(heapMain !== undefined ? { heap: { main: heapMain * MiB, editor: 40 * MiB } } : {}), how: {} as MemoryReading['how'] };
};

const scenario = (name: string, t: number, extra: Record<string, unknown> = {}) => m(name, t, { attrs: { scenario: 'postsImport', ...extra } });

describe('postsImport', () => {
  it('is a memory scenario run on its own after the launch', () => {
    expect([postsImport.memory, postsImport.after]).toEqual([true, 'launch']);
    expect(chainFor(['postsImport']).map((s) => s.name)).toEqual(['launch', 'postsImport']);
    expect(() => chainFor(['postsImport', 'open'])).toThrow('Memory scenarios (postsImport) are run on their own');
    expect(POSTS_IMPORT_READINGS.map(([l, k]) => `${l}:${k}`)).toEqual(['canvas:rest', 'read:peak', 'review:rest', 'cancelled:rest', 'commit:peak', 'imported:rest']);
  });

  it('reports every reading, what the review, a cancelled review and the import left, the reader’s own peak and the review’s and import’s times', () => {
    const readings = [
      reading('canvas', 'rest', { main: 200, editor: 150, devServer: 300 }, 60),
      reading('read', 'peak', { main: 420, editor: 170, devServer: 300, importReader: 260 }),
      reading('review', 'rest', { main: 280, editor: 160, devServer: 300 }, 110),
      reading('cancelled', 'rest', { main: 205, editor: 152, devServer: 300 }, 61),
      reading('commit', 'peak', { main: 600, editor: 300, devServer: 500, media: 90 }),
      reading('imported', 'rest', { main: 330, editor: 220, devServer: 380 }, 140)
    ];
    const trace = new Trace([
      scenario('scenario.start', 100),
      scenario('postsImport.read', 110),
      // Another read's marks, before the scenario's: never taken for its own.
      m('posts.reader', 105, { attrs: { ms: 1, peakRss: 1 } }),
      m('posts.reader', 900, { attrs: { ms: 700, peakRss: 310 * MiB } }),
      span('posts.read', 1000, 850),
      span('main.stall', 1500, 420),
      span('posts.review', 2400, 2250),
      scenario('postsImport.reviewed', 2500, { digest: 1234 }),
      // The second read, before the commit: not the first review's.
      m('posts.reader', 4000, { attrs: { ms: 900, peakRss: 320 * MiB } }),
      scenario('postsImport.commit', 5000),
      span('main.stall', 6000, 90),
      span('controller.commitPostImport', 9000, 3900),
      scenario('postsImport.imported', 9100, { digest: 5678 })
    ]);
    const got = postsImport.measure(trace, facts, readings);
    expect(got.missing).toEqual([]);
    const v = (k: string) => got.metrics[k].value / (got.metrics[k].unit === 'memory' ? MiB : 1);
    expect([v('memory.read.peak.mem.importReader'), v('memory.read.peak.mem.main'), v('memory.review.heap.main'), v('memory.commit.peak.mem.media')]).toEqual([260, 420, 110, 90]);
    expect([v('memory.review.growth.heap.main'), v('memory.review.growth.mem.main'), v('memory.cancel.growth.heap.main'), v('memory.cancel.growth.mem.main'), v('memory.import.growth.heap.main')]).toEqual([50, 80, 1, 5, 80]);
    expect([v('postsImport.readerPeakRss'), v('postsImport.readerMs'), v('postsImport.readMs'), v('postsImport.reviewMs'), v('postsImport.afterReadMs'), v('postsImport.reviewStallMax')]).toEqual([310, 700, 850, 2250, 1400, 420]);
    expect([v('postsImport.commitMs'), v('postsImport.commitStallMax'), v('postsImport.reviewDigest'), v('postsImport.importedDigest')]).toEqual([3900, 90, 1234, 5678]);
    // A build whose reader never reported what it cost, or a reading not taken, is missing, never a zero.
    const lacking = postsImport.measure(new Trace(trace.records.filter((r) => r.name !== 'posts.reader')), facts, readings.slice(0, 5));
    expect(lacking.missing).toEqual(['memory reading imported', 'posts.reader']);
    expect(Object.keys(lacking.metrics).some((k) => k.startsWith('memory.import.'))).toBe(false);
  });

  it('digests the posts an import added the same whatever IDs it gave them, and tells a different import apart', () => {
    const state = (entryIds: [string, string], assetId: string, title = 'Second'): ProjectState =>
      ({
        site: { redirects: [{ from: '/old/a/', entryId: entryIds[0] }] },
        assets: { assets: { [assetId]: { id: assetId, hash: 'h1' } } },
        collections: {
          posts: {
            settings: { taxonomies: { tags: { label: 'Tags', terms: { bread: { label: 'Bread' } } } } },
            entries: {
              old: { id: 'old', slug: 'kept', title: 'Kept', body: [] },
              [entryIds[0]]: { id: entryIds[0], slug: 'a', title: 'First', body: [{ type: 'image', assetId, alt: '' }] },
              [entryIds[1]]: { id: entryIds[1], slug: 'b', title, body: [{ type: 'p', spans: [{ text: 'see', link: { type: 'entry', target: entryIds[0] } }] }] }
            }
          }
        }
      }) as unknown as ProjectState;
    const before = { site: {}, assets: { assets: {} }, collections: { posts: { settings: {}, entries: { old: { id: 'old' } } } } } as unknown as ProjectState;
    const one = importedPostsDigest(before, state(['en_1', 'en_2'], 'img_1'));
    expect(importedPostsDigest(before, state(['en_9', 'en_8'], 'img_7'))).toBe(one);
    expect(importedPostsDigest(before, state(['en_1', 'en_2'], 'img_1', 'Changed'))).not.toBe(one);
  });

  it('draws the same export every time: 1,000 posts, every 20th a draft, each linking only to posts before it', () => {
    expect([WP_POSTS, WP_DRAFTS, WP_PICTURES]).toEqual([1000, 50, 10]);
    expect(wpContent(7)).toBe(wpContent(7));
    expect(wpPost(WP_DRAFT_EVERY).draft).toBe(true);
    expect(wpPost(WP_DRAFT_EVERY + 1).draft).toBe(false);
    for (let i = 1; i <= WP_POSTS; i++) for (const j of wpPost(i).links) expect(j >= 1 && j < i).toBe(true);
    const xml = wpExport();
    expect(xml.length).toBeGreaterThan(15 * 1_000_000);
    expect(xml.match(/<wp:post_type><!\[CDATA\[post\]\]><\/wp:post_type>/g)?.length).toBe(WP_POSTS);
  });
});
