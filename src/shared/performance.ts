/**
 * The website's performance report (#1488): what a first visit to each published page downloads, measured from the
 * built website as the export opens it in a browser (main/page-performance.ts), and what that says about the page's
 * speed: transfer budgets for its scripts, styles, fonts and pictures, whether the largest picture on its first screen
 * is preloaded, pictures whose `sizes` or file width does not fit the space they show in, and how the website asks
 * browsers to cache the hashed files every page shares. Project health shows it and the assistant reads it
 * (agent/performance-report.ts), so both say the same thing. Everything here is plain data and pure functions.
 */
import type { RedirectHost } from './types';

/** What a downloaded file is, for the page's breakdown. */
export type PerformanceKind = 'html' | 'js' | 'css' | 'fonts' | 'images' | 'other';
export const PERFORMANCE_KINDS: readonly PerformanceKind[] = ['html', 'js', 'css', 'fonts', 'images', 'other'];
/** The kinds a page has a transfer budget for. */
export type BudgetedKind = 'js' | 'css' | 'fonts' | 'images';
export const BUDGETED_KINDS: readonly BudgetedKind[] = ['js', 'css', 'fonts', 'images'];

const KB = 1024;
/**
 * How much of each kind a first visit to one page may download, uncompressed, before the report says it is too much:
 * advice for a brochure site on a phone connection, never a reason to stop an export.
 */
export const PERFORMANCE_BUDGETS: Readonly<Record<BudgetedKind, number>> = { js: 300 * KB, css: 100 * KB, fonts: 200 * KB, images: 1024 * KB };

/** How each page is opened to measure it: a laptop's window, one device pixel to each CSS pixel, nothing cached. */
export const PERFORMANCE_VIEWPORT = { width: 1280, height: 900, deviceScaleFactor: 1 } as const;

/** The kinds' names, as the report says them. */
export const KIND_NAMES: Readonly<Record<PerformanceKind, string>> = { html: 'HTML', js: 'Scripts', css: 'Styles', fonts: 'Fonts', images: 'Images', other: 'Other' };

/** One file a visit downloaded: its address (from the site's root for the website's own files), kind and size. */
export interface SampledResource {
  url: string;
  kind: PerformanceKind;
  /** Bytes of the file as the website's preview served it: uncompressed, as it is before a host compresses it. */
  bytes: number;
  /** Asked for by a `<link rel="preload">` (or `modulepreload`) in the page's head. */
  preloaded: boolean;
  /** Served by the website itself, not another host. */
  own: boolean;
}

/** A picture the visit showed, as the page laid it out. */
export interface SampledImage {
  /** The file the browser chose (its currentSrc), from the site's root for the website's own. */
  url: string;
  /** The space it shows in, in CSS pixels. */
  renderedWidth: number;
  renderedHeight: number;
  /** How wide the picture must be to fill that space: wider than the space when it is cropped to cover it. */
  neededWidth: number;
  /** The width of the file chosen, in pixels, when the page says it (a srcset width) or the file is a plain one. */
  fileWidth: number | null;
  /** How wide the image's `sizes` says it shows at this window, in CSS pixels; null for an image without widths to choose from. */
  slotWidth: number | null;
  /** The `sizes` the browser chose by, as the page wrote it. */
  sizes: string | null;
  /** Some of it is on the first screen. */
  inView: boolean;
}

/**
 * The largest thing the first screen painted (its Largest Contentful Paint), as the browser reported it, or, when it
 * reported none, the largest picture on the first screen. Null when there was neither.
 */
export type SampledLcp = { kind: 'image'; url: string; from: 'browser' | 'estimate' } | { kind: 'text' } | null;

/** What one visit to a page downloaded and showed. */
export interface PageSample {
  /** Every file the page asked for arrived before the measurement ended. */
  complete: boolean;
  resources: SampledResource[];
  images: SampledImage[];
  lcp: SampledLcp;
  /**
   * Every file a picture of the page shows (a drawing's and the largest paint's included), as the page was read; absent
   * when it could not be read, and then nothing is said of preloads it does not use.
   */
  used?: string[];
}

export type PerformanceCode =
  | 'PERF_OVER_BUDGET'
  | 'PERF_HERO_NOT_PRELOADED'
  | 'PERF_PRELOAD_UNUSED'
  | 'PERF_SIZES_MISMATCH'
  | 'PERF_IMAGE_OVERSIZED'
  | 'PERF_IMAGE_UNDERSIZED'
  | 'PERF_PAGE_UNMEASURED'
  | 'PERF_CACHE_NO_RULE'
  | 'PERF_CACHE_SHORT'
  | 'PERF_CACHE_UNKNOWN';

/** Something the report found, on one page or for the whole website. */
export interface PerformanceFinding {
  code: PerformanceCode;
  severity: 'warning' | 'info';
  message: string;
  /** The page it is on; none for the whole website. */
  route?: string;
  /** The file it is about. */
  url?: string;
  /** The library picture that file is, or is a copy of. */
  assetId?: string;
  kind?: BudgetedKind;
}

/** A page's own part of the report. */
export interface PagePerformance {
  route: string;
  /** The page's ID, for a page of the site's own (not a post or an archive page). */
  pageId?: string;
  title: string;
  /** measured: opened and measured (complete says whether everything arrived); unmeasured: why it could not be. */
  status: 'measured' | 'unmeasured';
  detail?: string;
  complete: boolean;
  /** Bytes by kind, and how many files of each. */
  totals: Record<PerformanceKind, number>;
  counts: Record<PerformanceKind, number>;
  /** The largest files, largest first (at most LARGEST_FILES), and every font, with whether each was preloaded. */
  largest: SampledResource[];
  fonts: SampledResource[];
  /** The largest picture on its first screen, whether the page preloads it, and whether the browser said so or the report judged it. */
  hero: { url: string; preloaded: boolean; from: 'browser' | 'estimate'; assetId?: string } | null;
  findings: PerformanceFinding[];
}

/** How the website's hashed files (SvelteKit's /_app/immutable/) are cached, as the exported files ask the host to. */
export interface CachePolicy {
  host: RedirectHost;
  /** The file holding the rule: `_headers` (Cloudflare Pages, Netlify) or `vercel.json` (Vercel). Null when there is none. */
  file: string | null;
  /** The address the rule was looked up for: one of the website's hashed files. */
  path: string | null;
  /** The Cache-Control the rule gives that address, or null when no rule does. */
  value: string | null;
  /** long: a year or immutable. short: a shorter one. none: no rule (the host's default). unknown: rules the report cannot read. */
  status: 'long' | 'short' | 'none' | 'unknown';
}

/** The whole report: when it was measured, from which revision, how, and what it found. */
export interface PerformanceReport {
  measuredAt: string;
  /** The project revision the measured website was built from. */
  revision: number;
  viewport: typeof PERFORMANCE_VIEWPORT;
  budgets: Record<BudgetedKind, number>;
  pages: PagePerformance[];
  cache: CachePolicy;
  /** The website's own findings (its caching), apart from any page's. */
  findings: PerformanceFinding[];
}

/** The last report, and whether the project has changed since the website it measured was built. */
export interface PerformanceStatus {
  report: PerformanceReport;
  stale: boolean;
}

/** How many of a page's largest files the report keeps. */
export const LARGEST_FILES = 8;

/** A size as the report says it: "812 bytes", "34 KB", "1.2 MB". */
export function bytesText(b: number): string {
  if (b < KB) return `${b} ${b === 1 ? 'byte' : 'bytes'}`;
  if (b < KB * KB) return `${Math.round(b / KB)} KB`;
  return `${(b / (KB * KB)).toFixed(1)} MB`;
}

const px = (n: number) => `${Math.round(n)}px`;
/**
 * A file's address as the report shows it: the website's own by its path, another host's by its host and file name
 * alone, since the rest of its address (a query, or a path a CDN signs) can carry a credential.
 */
export function shownAddress(url: string): string {
  const path = url.split(/[?#]/)[0];
  if (path.startsWith('/')) return path;
  const m = /^(https?:\/\/[^/]+)(\/.*)?$/.exec(path);
  if (!m) return '…';
  const ext = /\.([a-z0-9]{1,5})$/i.exec(m[2] ?? '');
  return `${m[1]}/…${ext ? `.${ext[1].toLowerCase()}` : ''}`;
}

/**
 * A file's address as a message shows it: the website's own by its name, which is what tells them apart; another
 * host's by its kind of file and the host alone (see shownAddress).
 */
const fileName = (url: string) => {
  const path = url.split(/[?#]/)[0];
  const other = /^https?:\/\/([^/]+)(\/.*)?$/.exec(path);
  if (other) {
    const ext = /\.([a-z0-9]{1,5})$/i.exec(other[2] ?? '');
    return `a ${ext ? `.${ext[1].toLowerCase()} ` : ''}file from ${other[1]}`;
  }
  return path.slice(path.lastIndexOf('/') + 1) || path;
};

/** How far `sizes` may say an image is wider than it shows, or narrower, before the report says it does not fit. */
const SIZES_OVER = 1.5;
const SIZES_UNDER = 0.75;
/** A file this many times as wide as its space needs, and this many pixels wider, is too large for it. */
const OVERSIZED = 2;
const OVERSIZED_PX = 200;
/** A file narrower than this share of its space, and this many pixels narrower, is too small for it: it looks soft. */
const UNDERSIZED = 0.75;
const UNDERSIZED_PX = 100;
/** A difference of fewer pixels than this between sizes and the space is never worth a finding. */
const SIZES_PX = 64;

/** Bytes of each kind, and how many files, of a visit. */
function tally(resources: readonly SampledResource[]) {
  const totals = Object.fromEntries(PERFORMANCE_KINDS.map((k) => [k, 0])) as Record<PerformanceKind, number>;
  const counts = { ...totals };
  for (const r of resources) {
    totals[r.kind] += r.bytes;
    counts[r.kind]++;
  }
  return { totals, counts };
}

/**
 * A page's part of the report from what its visit downloaded and showed. `assetFor` names the library picture a file
 * of the website's is (or is a copy of), so a finding can say which picture to change.
 */
export function pagePerformance(route: string, title: string, sample: PageSample, assetFor: (url: string) => string | undefined = () => undefined): PagePerformance {
  const { totals, counts } = tally(sample.resources);
  const findings: PerformanceFinding[] = [];
  const at = (url: string) => {
    const assetId = assetFor(url.split(/[?#]/)[0]);
    return { url: shownAddress(url), ...(assetId ? { assetId } : {}) };
  };
  const shown = (r: SampledResource): SampledResource => ({ ...r, url: shownAddress(r.url) });
  const largestOf = (kind: PerformanceKind) => [...sample.resources].filter((r) => r.kind === kind).sort((a, b) => b.bytes - a.bytes);

  for (const kind of BUDGETED_KINDS) {
    const budget = PERFORMANCE_BUDGETS[kind];
    if (totals[kind] <= budget) continue;
    const top = largestOf(kind).slice(0, 3);
    findings.push({
      code: 'PERF_OVER_BUDGET',
      severity: 'warning',
      kind,
      route,
      message: `${KIND_NAMES[kind]} come to ${bytesText(totals[kind])} over ${counts[kind]} ${counts[kind] === 1 ? 'file' : 'files'}, past the ${bytesText(budget)} budget. Largest: ${top.map((r) => `${fileName(r.url)} (${bytesText(r.bytes)})`).join(', ')}.`,
      ...(top[0] ? at(top[0].url) : {})
    });
  }

  const preloadedImages = sample.resources.filter((r) => r.kind === 'images' && r.preloaded);
  let hero: PagePerformance['hero'] = null;
  if (sample.lcp?.kind === 'image' && sample.lcp.url) {
    const url = sample.lcp.url;
    const preloaded = preloadedImages.some((r) => r.url === url);
    const from = sample.lcp.from;
    hero = { ...at(url), preloaded, from };
    const largest = from === 'browser' ? 'The largest thing on the first screen' : 'The largest picture on the first screen';
    // Only what the browser said it painted largest, once every file was in, is worth a warning: a judged one may be
    // smaller than the page's text, and a larger picture may still have been on its way.
    if (!preloaded)
      findings.push({
        code: 'PERF_HERO_NOT_PRELOADED',
        severity: from === 'browser' && sample.complete ? 'warning' : 'info',
        route,
        message: `${largest} is the picture ${fileName(url)}, and the page does not preload it, so it starts downloading only once the browser reaches it in the page.`,
        ...at(url)
      });
  }
  // A preload of a picture the page then shows another file of (another width or format) is downloaded for nothing.
  // Said only of a page that was read: one that could not be shows nothing, which is not the same.
  const usedUrls = new Set([...(sample.used ?? []), ...sample.images.map((i) => i.url), ...(sample.lcp?.kind === 'image' ? [sample.lcp.url] : [])]);
  // Said only once every file was in, too: a script still on its way may yet show it.
  for (const r of sample.used && sample.complete ? preloadedImages : []) {
    if (usedUrls.has(r.url)) continue;
    findings.push({
      code: 'PERF_PRELOAD_UNUSED',
      severity: 'warning',
      route,
      message: `The page preloads ${fileName(r.url)} (${bytesText(r.bytes)}) but shows ${sample.lcp?.kind === 'image' && sample.lcp.url !== r.url ? `${fileName(sample.lcp.url)} instead` : 'no picture from that file'}, so visitors download it for nothing.`,
      ...at(r.url)
    });
  }

  const bytesOf = new Map(sample.resources.map((r) => [r.url, r.bytes] as const));
  const seen = new Set<string>();
  for (const img of sample.images) {
    // One finding for each file and space: the same picture repeated in a list is said once.
    const key = `${img.url} ${Math.round(img.neededWidth)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const size = bytesOf.has(img.url) ? ` (${bytesText(bytesOf.get(img.url)!)})` : '';
    const name = fileName(img.url);
    let sizesTooWide = false;
    if (img.slotWidth !== null && Math.abs(img.slotWidth - img.neededWidth) >= SIZES_PX) {
      const ratio = img.slotWidth / img.neededWidth;
      if (ratio > SIZES_OVER || ratio < SIZES_UNDER) {
        sizesTooWide = ratio > SIZES_OVER;
        findings.push({
          code: 'PERF_SIZES_MISMATCH',
          severity: 'warning',
          route,
          message: `${name} shows ${px(img.neededWidth)} wide, but its sizes${img.sizes ? ` (${img.sizes.slice(0, 120)})` : ''} says ${px(img.slotWidth)} at a ${PERFORMANCE_VIEWPORT.width}px window, so browsers choose a ${sizesTooWide ? 'larger copy than it needs' : 'copy too small for it'}.`,
          ...at(img.url)
        });
      }
    }
    if (img.fileWidth === null) continue;
    const needed = img.neededWidth * PERFORMANCE_VIEWPORT.deviceScaleFactor;
    if (!sizesTooWide && img.fileWidth > needed * OVERSIZED && img.fileWidth - needed >= OVERSIZED_PX)
      findings.push({
        code: 'PERF_IMAGE_OVERSIZED',
        severity: 'warning',
        route,
        message: `${name}${size} is ${px(img.fileWidth)} wide for a space ${px(needed)} wide: a copy near that width would download far less.`,
        ...at(img.url)
      });
    else if (img.fileWidth < needed * UNDERSIZED && needed - img.fileWidth >= UNDERSIZED_PX)
      findings.push({
        code: 'PERF_IMAGE_UNDERSIZED',
        severity: 'info',
        route,
        message: `${name} is ${px(img.fileWidth)} wide for a space ${px(needed)} wide, so it may look soft. A larger picture would fill it sharply.`,
        ...at(img.url)
      });
  }

  const ranked = [...sample.resources].sort((a, b) => b.bytes - a.bytes);
  return {
    route,
    title,
    status: 'measured',
    complete: sample.complete,
    totals,
    counts,
    largest: ranked.slice(0, LARGEST_FILES).map(shown),
    fonts: largestOf('fonts').map(shown),
    hero,
    findings
  };
}

/** A page that could not be measured, and why. */
export function unmeasuredPage(route: string, title: string, detail: string): PagePerformance {
  const { totals, counts } = tally([]);
  return {
    route,
    title,
    status: 'unmeasured',
    detail,
    complete: false,
    totals,
    counts,
    largest: [],
    fonts: [],
    hero: null,
    findings: [{ code: 'PERF_PAGE_UNMEASURED', severity: 'info', route, message: `Not measured: ${detail.replace(/\.$/, '')}.` }]
  };
}

/** The hosts' names, as the report says them. */
export const HOST_NAMES: Readonly<Record<RedirectHost, string>> = { cloudflare: 'Cloudflare Pages', netlify: 'Netlify', vercel: 'Vercel' };

/** The rule the report suggests for the website's hashed files. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/** What the website's caching says, as a finding, or null when its hashed files are cached for a long time. */
export function cacheFinding(cache: CachePolicy): PerformanceFinding | null {
  const host = HOST_NAMES[cache.host];
  const advice = `Their names change whenever their content does, so a rule giving /_app/immutable/* "Cache-Control: ${IMMUTABLE_CACHE}" lets repeat visits use the copy they have.`;
  if (cache.status === 'none')
    return {
      code: 'PERF_CACHE_NO_RULE',
      severity: 'info',
      message: `No caching rule the website sets covers its hashed scripts and styles (/_app/immutable/)${cache.path ? `, such as ${cache.path}` : ''}, so ${host} uses its default for them, which has browsers check each one again on every visit. ${advice} ${cache.host === 'vercel' ? 'Vercel reads it from vercel.json.' : `${host} reads it from a _headers file in the project's static folder.`}`
    };
  if (cache.status === 'short')
    return { code: 'PERF_CACHE_SHORT', severity: 'info', message: `${cache.file} gives the website's hashed scripts and styles "Cache-Control: ${cache.value}", which keeps them for less than a year. ${advice}` };
  if (cache.status === 'unknown') return { code: 'PERF_CACHE_UNKNOWN', severity: 'info', message: `${cache.file} has caching rules the report cannot read, so how the website's hashed scripts and styles are cached is not known.` };
  return null;
}

/**
 * A Cache-Control value's verdict for a browser: long when it may keep the file a year (max-age), and nothing stops it
 * from keeping it (no-store) or has it ask again each time (no-cache). Immutable alone sets no lifetime.
 */
export function cacheValueStatus(value: string): 'long' | 'short' {
  const directives = value.toLowerCase().split(',').map((d) => d.trim());
  if (directives.some((d) => d === 'no-store' || d === 'no-cache' || d.startsWith('no-cache='))) return 'short';
  const age = directives.map((d) => /^max-age\s*=\s*"?(\d+)"?$/.exec(d)).find(Boolean);
  return age && Number(age[1]) >= 31536000 ? 'long' : 'short';
}

/** Every finding of a report, the website's first, then each page's in the site's order, warnings before notes. */
export function reportFindings(report: PerformanceReport): PerformanceFinding[] {
  const all = [...report.findings, ...report.pages.flatMap((p) => p.findings)];
  return [...all.filter((f) => f.severity === 'warning'), ...all.filter((f) => f.severity === 'info')];
}
