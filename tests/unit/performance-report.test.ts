/**
 * The audit_performance tool's report (src/agent/performance-report.ts, #1488): the last export's measurements as the
 * assistant reads them. Nothing measured is said plainly, with what to ask the user; a change since is said; the site
 * is a row per page, those with most warnings first; one page, named by its ID or route, is its files and findings;
 * and every result fits the room it is given, the rest in later parts.
 */
import { describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { pagePerformance, unmeasuredPage, PERFORMANCE_BUDGETS, PERFORMANCE_VIEWPORT, type PageSample, type PerformanceReport, type SampledResource } from '@shared/performance';
import { performanceReport } from '../../src/agent/performance-report';
import { asksForPerformance, toolsForRun } from '../../src/agent/tools';

const state = createStarterState('business', 'Test', false);
const about = Object.values(state.pages).find((p) => p.route === '/about/')!;
const file = (url: string, kind: SampledResource['kind'], bytes: number): SampledResource => ({ url, kind, bytes, preloaded: false, own: true });
const sample = (resources: SampledResource[], over: Partial<PageSample> = {}): PageSample => ({ complete: true, resources, images: [], lcp: null, ...over });

function report(pages = [pagePerformance('/', 'Home', sample([file('/', 'html', 3000)])), pagePerformance('/about/', 'About', sample([file('/about/', 'html', 3000), file('/_app/big.js', 'js', PERFORMANCE_BUDGETS.js + 1)])), unmeasuredPage('/posts/a/', 'A post', 'the export ran out of time to open it')]): PerformanceReport {
  return { measuredAt: '2026-11-28T10:00:00.000Z', revision: 4, viewport: PERFORMANCE_VIEWPORT, budgets: { ...PERFORMANCE_BUDGETS }, pages, cache: { host: 'cloudflare', file: null, path: '/_app/immutable/x.js', value: null, status: 'none' }, findings: [{ code: 'PERF_CACHE_NO_RULE', severity: 'info', message: 'No rule.' }] };
}

const ROOM = 60_000;

describe('who is offered the performance report', () => {
  const capabilities = { toolCalling: 'constrained-json' as const, contextWindowTokens: 8000 };
  const offered = (opts: Partial<Parameters<typeof toolsForRun>[0]>) =>
    toolsForRun({ state, selection: null, capabilities: { toolCalling: 'native', contextWindowTokens: 200_000 }, codeEnabled: false, definitionOps: false, ...opts }).tools.some((t) => t.name === 'audit_performance');

  it('is offered a large model always, a small one when the request is about speed or it only asks, and never a collaborator’s run', () => {
    expect(offered({})).toBe(true);
    expect(offered({ capabilities })).toBe(false);
    expect(offered({ capabilities, performanceRequest: true })).toBe(true);
    expect(offered({ capabilities, ask: true })).toBe(true);
    expect(offered({ delegated: true })).toBe(false);
    expect(offered({ delegated: true, performanceRequest: true })).toBe(false);
    expect(offered({ delegated: true, capabilities, performanceRequest: true })).toBe(false);
  });

  it('takes a request about speed as one, as Project health’s Improve with AI words it', () => {
    for (const text of ['Make the website load faster: work through the performance findings the last export measured', 'Why is the home page so slow?', 'Check the LCP preload', 'Are my scripts cached?']) expect(asksForPerformance(text), text).toBe(true);
    for (const text of ['Add a team page', 'Make the heading bigger']) expect(asksForPerformance(text), text).toBe(false);
  });
});

describe('the performance report the assistant reads', () => {
  it('says nothing is measured until the user exports the website, and that it cannot export', () => {
    const r = performanceReport(state, 7, null, {}, ROOM);
    expect(r).toEqual({ ok: true, content: { revision: 7, status: 'not_measured', note: expect.stringMatching(/ask the user to export the website.*You cannot export it yourself\.$/) } });
  });

  it('lists every page of the site, those with warnings first, with the website’s own findings and when it was measured', () => {
    const r = performanceReport(state, 4, { report: report(), stale: false }, {}, ROOM);
    expect(r.ok).toBe(true);
    const c = (r as { content: Record<string, unknown> }).content;
    expect(c).toMatchObject({ revision: 4, measuredRevision: 4, measuredAt: '2026-11-28T10:00:00.000Z', window: '1280x900 at 1x, nothing cached', scope: 'site', pages: 3, counts: { warning: 1, info: 2 }, byCode: { PERF_OVER_BUDGET: 1, PERF_CACHE_NO_RULE: 1, PERF_PAGE_UNMEASURED: 1 }, siteFindings: [{ code: 'PERF_CACHE_NO_RULE' }] });
    expect(c.stale).toBeUndefined();
    expect((c.rows as Array<{ route: string }>).map((row) => row.route)).toEqual(['/about/', '/', '/posts/a/']);
    expect((c.rows as unknown[])[0]).toMatchObject({ overBudget: ['js'], warnings: 1, bytes: { js: PERFORMANCE_BUDGETS.js + 1 } });
    expect((c.rows as unknown[])[2]).toEqual({ route: '/posts/a/', title: 'A post', measured: false, detail: 'the export ran out of time to open it' });
  });

  it('says the project changed since the export that measured it', () => {
    const c = (performanceReport(state, 9, { report: report(), stale: true }, {}, ROOM) as { content: Record<string, unknown> }).content;
    expect(c).toMatchObject({ revision: 9, measuredRevision: 4, stale: true, staleNote: expect.stringContaining('export it again') });
  });

  it('gives one page’s files and findings, named by its ID or route, a post or archive page by its route', () => {
    for (const route of [about.id, '/about/', 'about', '/about']) {
      const c = (performanceReport(state, 4, { report: report(), stale: false }, { route }, ROOM) as { content: Record<string, unknown> }).content;
      expect(c.scope, route).toEqual({ route: '/about/' });
      expect(c.page, route).toMatchObject({ route: '/about/', files: { js: 1, html: 1 }, largest: [{ url: '/_app/big.js', kind: 'js', bytes: PERFORMANCE_BUDGETS.js + 1 }, { url: '/about/', kind: 'html' }], fonts: [] });
      expect((c.findings as Array<{ code: string }>).map((f) => f.code), route).toEqual(['PERF_OVER_BUDGET']);
    }
    const post = (performanceReport(state, 4, { report: report(), stale: false }, { route: '/posts/a/' }, ROOM) as { content: Record<string, unknown> }).content;
    expect(post).toMatchObject({ page: { measured: false }, findings: [{ code: 'PERF_PAGE_UNMEASURED' }] });
  });

  it('finds a page by the ID it had when measured after it moved, and a route however it is spelled', () => {
    const moved = report([{ ...pagePerformance('/about-us/', 'About', sample([file('/about-us/', 'html', 3000)])), pageId: about.id }, pagePerformance('/café/', 'Café', sample([file('/café/', 'html', 10)]))]);
    // The project now has the page at /about/: the measurement was made at /about-us/.
    expect((performanceReport(state, 4, { report: moved, stale: true }, { route: about.id }, ROOM) as unknown as { content: { scope: unknown } }).content.scope).toEqual({ route: '/about-us/' });
    expect((performanceReport(state, 4, { report: moved, stale: false }, { route: '/caf%C3%A9' }, ROOM) as unknown as { content: { scope: unknown } }).content.scope).toEqual({ route: '/café/' });
    expect(performanceReport(state, 4, { report: moved, stale: false }, { route: '  ' }, ROOM)).toMatchObject({ ok: false, message: expect.stringContaining('route is empty') });
  });

  it('fits a page with many long font addresses, saying how many more it has', () => {
    const fonts = Array.from({ length: 70 }, (_, i): SampledResource => ({ ...file(`/fonts/${'x'.repeat(280)}-${i}.woff2`, 'fonts', 1000 + i), preloaded: false }));
    const heavy = report([pagePerformance('/', 'Home', sample([file('/', 'html', 3000), ...fonts]))]);
    const r = performanceReport(state, 4, { report: heavy, stale: false }, { route: '/' }, 8000);
    const c = (r as unknown as { content: { page: { fonts: unknown[]; moreFonts?: number } } }).content;
    expect(JSON.stringify(c).length).toBeLessThanOrEqual(8000);
    expect(c.page.fonts.length + (c.page.moreFonts ?? 0)).toBe(70);
    expect(c.page.moreFonts).toBeGreaterThan(0);
  });

  it('refuses a page the export did not measure, and an offset past the last', () => {
    expect(performanceReport(state, 4, { report: report(), stale: false }, { route: '/nowhere/' }, ROOM)).toEqual({ ok: false, message: 'The last export measured no page "/nowhere/". Measured: /, /about/, /posts/a/' });
    expect(performanceReport(state, 4, { report: report(), stale: false }, { offset: 3 }, ROOM)).toMatchObject({ ok: false, message: expect.stringContaining('3 pages') });
    expect(performanceReport(state, 4, { report: report(), stale: false }, { route: '/', offset: 1 }, ROOM)).toMatchObject({ ok: false });
  });

  it('fits the room it is given, and gives the rest in later parts that read on from where the last ended', () => {
    const many = Array.from({ length: 60 }, (_, i) => pagePerformance(`/page-${i}/`, `Page ${i}`, sample([file(`/page-${i}/`, 'html', 3000 + i)])));
    const room = 8000;
    const seen: string[] = [];
    let offset: number | undefined = 0;
    for (let part = 0; offset !== undefined && part < 60; part++) {
      const r = performanceReport(state, 4, { report: report(many), stale: false }, { offset }, room);
      expect(r.ok).toBe(true);
      const c = (r as { content: Record<string, unknown> }).content;
      expect(JSON.stringify(c).length).toBeLessThanOrEqual(room);
      seen.push(...(c.rows as Array<{ route: string }>).map((row) => row.route));
      offset = c.nextOffset as number | undefined;
    }
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });
});
