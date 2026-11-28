/**
 * The performance report's findings from what a page's visit downloaded and showed (src/shared/performance.ts, #1488):
 * budgets per kind, the largest picture on the first screen and its preload, preloads the page never shows, pictures
 * whose `sizes` or file does not fit the space they show in, and the host's caching of the website's hashed files.
 */
import { describe, expect, it } from 'vitest';
import { cacheFinding, cacheValueStatus, pagePerformance, PERFORMANCE_BUDGETS, reportFindings, unmeasuredPage, bytesText, type PageSample, type SampledImage, type SampledResource, type PerformanceReport, PERFORMANCE_VIEWPORT } from '@shared/performance';

const file = (url: string, kind: SampledResource['kind'], bytes: number, preloaded = false): SampledResource => ({ url, kind, bytes, preloaded, own: true });
const image = (url: string, at: Partial<SampledImage> = {}): SampledImage => ({ url, renderedWidth: 600, renderedHeight: 400, neededWidth: 600, fileWidth: 640, slotWidth: 600, sizes: '(min-width: 48rem) 600px, 100vw', inView: true, ...at });
const sample = (over: Partial<PageSample> = {}): PageSample => ({ complete: true, resources: [file('/', 'html', 4000)], images: [], lcp: null, ...over });
const codes = (s: PageSample) => pagePerformance('/', 'Home', s).findings.map((f) => f.code);

describe('a page’s part of the performance report', () => {
  it('adds up what the visit downloaded by kind, and keeps the largest files and every font', () => {
    const page = pagePerformance('/about/', 'About', sample({ resources: [file('/about/', 'html', 4000), file('/_app/a.js', 'js', 30_000), file('/_app/b.js', 'js', 20_000), file('/_app/c.css', 'css', 9000), file('/fonts/x.woff2', 'fonts', 40_000, true), file('/assets/a.jpg', 'images', 90_000)] }));
    expect(page).toMatchObject({ route: '/about/', title: 'About', status: 'measured', complete: true, totals: { html: 4000, js: 50_000, css: 9000, fonts: 40_000, images: 90_000, other: 0 }, counts: { js: 2, fonts: 1 } });
    expect(page.largest.map((r) => r.url)).toEqual(['/assets/a.jpg', '/fonts/x.woff2', '/_app/a.js', '/_app/b.js', '/_app/c.css', '/about/']);
    expect(page.fonts).toEqual([file('/fonts/x.woff2', 'fonts', 40_000, true)]);
    expect(page.findings).toEqual([]);
  });

  it('says which kinds are over their budget, with the largest files of each', () => {
    const page = pagePerformance('/', 'Home', sample({ resources: [file('/_app/big.js', 'js', PERFORMANCE_BUDGETS.js), file('/_app/small.js', 'js', 1), file('/assets/a.jpg', 'images', PERFORMANCE_BUDGETS.images)] }));
    expect(page.findings).toEqual([expect.objectContaining({ code: 'PERF_OVER_BUDGET', kind: 'js', severity: 'warning', url: '/_app/big.js', message: expect.stringMatching(/^Scripts come to 300 KB over 2 files, past the 300 KB budget\. Largest: big\.js \(300 KB\), small\.js \(1 byte\)\.$/) })]);
  });

  it('says when the largest picture on the first screen is not preloaded, naming its library picture', () => {
    const lcp = { kind: 'image' as const, url: '/assets/hero-1280.webp', from: 'browser' as const };
    const page = pagePerformance('/', 'Home', sample({ resources: [file('/assets/hero-1280.webp', 'images', 120_000)], images: [image('/assets/hero-1280.webp', { neededWidth: 1280, fileWidth: 1280, slotWidth: 1280 })], lcp }), (url) => (url === '/assets/hero-1280.webp' ? 'asset_hero' : undefined));
    expect(page.hero).toEqual({ url: '/assets/hero-1280.webp', preloaded: false, from: 'browser', assetId: 'asset_hero' });
    expect(page.findings).toEqual([expect.objectContaining({ code: 'PERF_HERO_NOT_PRELOADED', severity: 'warning', assetId: 'asset_hero', message: expect.stringContaining('The largest thing on the first screen is the picture hero-1280.webp') })]);
    // Preloaded, it is fine; text painted largest has no picture to preload.
    const preloaded = pagePerformance('/', 'Home', sample({ resources: [file('/assets/hero-1280.webp', 'images', 120_000, true)], images: [image('/assets/hero-1280.webp', { neededWidth: 1280, fileWidth: 1280, slotWidth: 1280 })], lcp, used: ['/assets/hero-1280.webp'] }));
    expect(preloaded.hero).toMatchObject({ preloaded: true });
    expect(preloaded.findings).toEqual([]);
    expect(pagePerformance('/', 'Home', sample({ lcp: { kind: 'text' } })).hero).toBeNull();
  });

  it('says a preloaded picture the page never shows is downloaded for nothing', () => {
    const s = sample({ resources: [file('/assets/hero-640.avif', 'images', 50_000, true), file('/assets/hero-1280.webp', 'images', 120_000)], images: [image('/assets/hero-1280.webp', { neededWidth: 1280, fileWidth: 1280, slotWidth: 1280 })], lcp: { kind: 'image', url: '/assets/hero-1280.webp', from: 'estimate' }, used: ['/assets/hero-1280.webp'] });
    const page = pagePerformance('/', 'Home', s, (url) => (url.includes('hero') ? 'asset_hero' : undefined));
    expect(page.findings.map((f) => f.code)).toEqual(['PERF_HERO_NOT_PRELOADED', 'PERF_PRELOAD_UNUSED']);
    // A picture judged largest, which the browser did not report, is a note to check rather than a warning.
    expect(page.findings[0]).toMatchObject({ severity: 'info', message: expect.stringMatching(/^The largest picture on the first screen/) });
    expect(page.findings[1]).toMatchObject({ url: '/assets/hero-640.avif', assetId: 'asset_hero', message: 'The page preloads hero-640.avif (49 KB) but shows hero-1280.webp instead, so visitors download it for nothing.' });
    // Nothing is said of a preload on a page that could not be read, or of one that a drawing or the largest paint uses.
    expect(codes({ ...s, used: undefined, lcp: null })).toEqual([]);
    expect(codes({ ...s, lcp: null, used: ['/assets/hero-640.avif'] })).toEqual([]);
    expect(codes({ ...s, images: [], used: [], lcp: { kind: 'image', url: '/assets/hero-640.avif', from: 'browser' } })).toEqual([]);
  });

  it('says when a picture’s sizes asks for much more, or much less, than the space it shows in', () => {
    // 100vw for a 420px column: the browser picks a copy for the whole window.
    const wide = pagePerformance('/', 'Home', sample({ images: [image('/assets/a-1280.jpg', { neededWidth: 420, fileWidth: 1280, slotWidth: 1280, sizes: '100vw' })] })).findings;
    expect(wide).toEqual([expect.objectContaining({ code: 'PERF_SIZES_MISMATCH', message: 'a-1280.jpg shows 420px wide, but its sizes (100vw) says 1280px at a 1280px window, so browsers choose a larger copy than it needs.' })]);
    // Too small: the copy chosen is too narrow for the space.
    const narrow = codes(sample({ images: [image('/assets/a-320.jpg', { neededWidth: 900, fileWidth: 320, slotWidth: 300, sizes: '300px' })] }));
    expect(narrow).toEqual(['PERF_SIZES_MISMATCH', 'PERF_IMAGE_UNDERSIZED']);
    // Within the margin either way, or a picture with no widths to choose from, says nothing of sizes.
    expect(codes(sample({ images: [image('/assets/a.jpg', { neededWidth: 600, slotWidth: 640 })] }))).toEqual([]);
    expect(codes(sample({ images: [image('/assets/a.jpg', { neededWidth: 600, slotWidth: null, sizes: null })] }))).toEqual([]);
  });

  it('says a file far wider than its space is too large, and one far narrower may look soft, each once per file and space', () => {
    const big = image('/assets/photo.jpg', { neededWidth: 400, fileWidth: 3000, slotWidth: null, sizes: null });
    const page = pagePerformance('/', 'Home', sample({ resources: [file('/assets/photo.jpg', 'images', 900_000)], images: [big, big, { ...big, neededWidth: 1400 }] }));
    expect(page.findings.map((f) => f.code)).toEqual(['PERF_IMAGE_OVERSIZED', 'PERF_IMAGE_OVERSIZED']);
    expect(page.findings[0].message).toBe('photo.jpg (879 KB) is 3000px wide for a space 400px wide: a copy near that width would download far less.');
    expect(codes(sample({ images: [image('/assets/tiny.jpg', { neededWidth: 800, fileWidth: 400, slotWidth: null, sizes: null })] }))).toEqual(['PERF_IMAGE_UNDERSIZED']);
    // A sizes that already says it chose too large a copy is the finding; the file's width is not said again.
    expect(codes(sample({ images: [image('/assets/a.jpg', { neededWidth: 300, fileWidth: 1280, slotWidth: 1280 })] }))).toEqual(['PERF_SIZES_MISMATCH']);
    // A picture whose file width is unknown (a density-described set) says nothing of it.
    expect(codes(sample({ images: [image('/assets/a.jpg', { neededWidth: 300, fileWidth: null, slotWidth: null, sizes: null })] }))).toEqual([]);
  });

  it('shows another host’s files by their host and kind of file alone, and the website’s own without a query', () => {
    const page = pagePerformance('/', 'Home', sample({ resources: [file('https://cdn.example/token-abc123/path/hero.jpg?sig=secret', 'images', 2_000_000), file('/_app/a.js?v=2', 'js', 10)], lcp: { kind: 'image', url: 'https://cdn.example/token-abc123/path/hero.jpg?sig=secret', from: 'browser' } }));
    expect(page.largest.map((r) => r.url)).toEqual(['https://cdn.example/….jpg', '/_app/a.js']);
    expect(page.hero?.url).toBe('https://cdn.example/….jpg');
    expect(page.findings.find((f) => f.code === 'PERF_HERO_NOT_PRELOADED')?.message).toMatch(/^The largest thing on the first screen is the picture a \.jpg file from cdn\.example,/);
    // Not its path, nor its name: either can be the credential a signed address carries.
    expect(JSON.stringify(page)).not.toMatch(/secret|token-abc123|\/path\/|hero\.jpg/);
  });

  it('keeps two copies asked for by query apart, so a preload of one is not taken for the other', () => {
    const s = sample({ resources: [file('https://img.example/hero?w=640', 'images', 40_000, true), file('https://img.example/hero?w=1280', 'images', 90_000)], images: [image('https://img.example/hero?w=1280', { neededWidth: 1280, fileWidth: 1280, slotWidth: 1280 })], lcp: { kind: 'image', url: 'https://img.example/hero?w=1280', from: 'browser' }, used: ['https://img.example/hero?w=1280'] });
    const page = pagePerformance('/', 'Home', s);
    expect(page.findings.map((f) => f.code)).toEqual(['PERF_HERO_NOT_PRELOADED', 'PERF_PRELOAD_UNUSED']);
    // Measured in part, a script still on its way may yet show the preloaded copy: nothing is said of it.
    expect(pagePerformance('/', 'Home', { ...s, complete: false }).findings.map((f) => f.code)).toEqual(['PERF_HERO_NOT_PRELOADED']);
  });

  it('makes a note, not a warning, of a hero not preloaded on a page measured only in part', () => {
    const page = pagePerformance('/', 'Home', sample({ complete: false, resources: [file('/assets/a.jpg', 'images', 10)], lcp: { kind: 'image', url: '/assets/a.jpg', from: 'browser' } }));
    expect(page.findings).toEqual([expect.objectContaining({ code: 'PERF_HERO_NOT_PRELOADED', severity: 'info' })]);
  });

  it('says why a page was not measured', () => {
    expect(unmeasuredPage('/blog/', 'Blog', 'the export ran out of time to open it')).toMatchObject({ status: 'unmeasured', detail: 'the export ran out of time to open it', complete: false, findings: [{ code: 'PERF_PAGE_UNMEASURED', route: '/blog/', message: 'Not measured: the export ran out of time to open it.' }] });
  });
});

describe('the website’s caching, as the report says it', () => {
  it('reads a browser lifetime of a year as long, anything less as short', () => {
    expect(cacheValueStatus('public, max-age=31536000, immutable')).toBe('long');
    expect(cacheValueStatus('public, max-age=63072000')).toBe('long');
    expect(cacheValueStatus('public, max-age=600')).toBe('short');
    expect(cacheValueStatus('no-cache')).toBe('short');
    // Immutable sets no lifetime of its own, and keeping nothing, or checking every time, wins over any.
    expect(cacheValueStatus('immutable')).toBe('short');
    expect(cacheValueStatus('max-age=60, immutable')).toBe('short');
    expect(cacheValueStatus('no-store, max-age=31536000, immutable')).toBe('short');
    expect(cacheValueStatus('max-age=31536000, no-cache')).toBe('short');
    // A shared cache's lifetime is not a browser's.
    expect(cacheValueStatus('s-maxage=31536000')).toBe('short');
  });

  it('says there is no rule, or a short one, with where the host reads one, and nothing for a long one', () => {
    const at = { path: '/_app/immutable/entry/start.js', value: null } as const;
    expect(cacheFinding({ host: 'netlify', file: null, status: 'none', ...at })).toMatchObject({ code: 'PERF_CACHE_NO_RULE', message: expect.stringContaining('so Netlify uses its default') });
    expect(cacheFinding({ host: 'vercel', file: null, status: 'none', ...at })?.message).toContain('Vercel reads it from vercel.json.');
    expect(cacheFinding({ host: 'cloudflare', file: '_headers', status: 'short', path: at.path, value: 'max-age=600' })).toMatchObject({ code: 'PERF_CACHE_SHORT', message: expect.stringContaining('"Cache-Control: max-age=600"') });
    expect(cacheFinding({ host: 'cloudflare', file: '_headers', status: 'unknown', path: at.path, value: null })?.code).toBe('PERF_CACHE_UNKNOWN');
    expect(cacheFinding({ host: 'cloudflare', file: '_headers', status: 'long', path: at.path, value: 'immutable' })).toBeNull();
  });
});

describe('the whole report', () => {
  it('lists the website’s findings and every page’s, warnings before notes', () => {
    const report: PerformanceReport = {
      measuredAt: '2026-11-28T00:00:00.000Z',
      revision: 3,
      viewport: PERFORMANCE_VIEWPORT,
      budgets: { ...PERFORMANCE_BUDGETS },
      cache: { host: 'cloudflare', file: null, path: null, value: null, status: 'none' },
      findings: [{ code: 'PERF_CACHE_NO_RULE', severity: 'info', message: 'no rule' }],
      pages: [unmeasuredPage('/a/', 'A', 'stopped'), pagePerformance('/', 'Home', sample({ resources: [file('/_app/big.js', 'js', PERFORMANCE_BUDGETS.js + 1)] }))]
    };
    expect(reportFindings(report).map((f) => f.code)).toEqual(['PERF_OVER_BUDGET', 'PERF_CACHE_NO_RULE', 'PERF_PAGE_UNMEASURED']);
  });

  it('says sizes as people read them', () => {
    expect([bytesText(1), bytesText(812), bytesText(34 * 1024), bytesText(1.25 * 1024 * 1024)]).toEqual(['1 byte', '812 bytes', '34 KB', '1.3 MB']);
  });
});
