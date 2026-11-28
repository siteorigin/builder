/**
 * The audit_performance tool's report (#1488): the performance report the last website export measured
 * (shared/performance.ts), as the assistant reads it. It reads what Project health shows and measures nothing itself,
 * so a site that has not been exported since it was opened has no report, and one that changed since says so. The
 * whole site is a row per page, worst first; one page is its breakdown and findings. It always fits one tool result
 * whole: what does not fit comes in later parts.
 */
import { z } from 'zod';
import type { ProjectState } from '@shared/types';
import { BUDGETED_KINDS, PERFORMANCE_BUDGETS, reportFindings, type PagePerformance, type PerformanceFinding, type PerformanceStatus, type SampledResource } from '@shared/performance';
import { pageIdFor } from './context';

export const AUDIT_PERFORMANCE_ARGS = z.object({
  route: z.string().optional().describe("One page: a page's ID or route, or a post's or archive page's route. Leave out for the whole site."),
  offset: z.number().int().min(0).optional().describe('More, from the nextOffset a previous call returned.')
});

export type AuditPerformanceArgs = z.infer<typeof AUDIT_PERFORMANCE_ARGS>;

/** The most page rows, or one page's findings, a part shows. Fewer when they would not fit the result. */
export const PERFORMANCE_ROWS_PER_PART = 20;
/**
 * The most room a part takes, whatever the result may hold: a small model's window, which keeps the latest results
 * whole, reads a long report part after part without filling up.
 */
export const PERFORMANCE_PART_CHARS = 6000;
/** The longest address or message a row shows. */
const TEXT_CHARS = 300;

const NOT_MEASURED =
  'No website export has measured the site since the project was opened. Each page is measured as a website export opens it (what a first visit downloads at a 1280px window, and the pictures it shows), so ask the user to export the website (Export, then Website files) and audit again. You cannot export it yourself.';
const STALE = 'The project has changed since the version this export was built from, so those changes are not in these numbers: after changing the site, ask the user to export it again to measure the result.';
const CONTINUE = 'Call again with offset set to nextOffset for the next part.';
/** What a finding's fix usually is, so the assistant acts on it rather than guessing. */
const HOW = [
  'Bytes are uncompressed, as the website serves them before its host compresses them.',
  'These are download sizes and picture checks, not load times.',
  'PERF_HERO_NOT_PRELOADED: the website preloads the first eagerly loaded library picture of a page\'s first section, so move the picture into the first section, or make it the first picture there. As a note (judged, not reported by the browser), check the page before acting on it.',
  'PERF_SIZES_MISMATCH: the sizes the website writes for a picture come from its component\'s layout, so a picture shown narrower than that (by custom styles, or a code component\'s own sizes) downloads a copy for the wider space; fix the styles or code that narrow it, or the sizes a code component writes. PERF_IMAGE_OVERSIZED: a library picture far wider than its space and with no smaller copies; a smaller picture (search_assets) downloads less. PERF_IMAGE_UNDERSIZED: a larger picture shows sharply.',
  'PERF_OVER_BUDGET on images: fewer or smaller pictures above the fold; on scripts: fewer code components or interactive parts on the page.',
  'PERF_CACHE_*: the host\'s headers are set outside the editor, in a file of the project\'s; tell the user what to add.'
].join(' ');

const clip = (text: string) => {
  const chars = [...text];
  return chars.length > TEXT_CHARS ? `${chars.slice(0, TEXT_CHARS - 1).join('')}…` : text;
};

/** The most fonts one page lists. */
const FONTS_SHOWN = 20;

const finding = (f: PerformanceFinding) => ({ code: f.code, severity: f.severity, message: clip(f.message), ...(f.url ? { url: clip(f.url) } : {}), ...(f.assetId ? { assetId: f.assetId } : {}) });
const file = (r: SampledResource) => ({ url: clip(r.url), kind: r.kind, bytes: r.bytes, ...(r.preloaded ? { preloaded: true } : {}), ...(r.own ? {} : { otherHost: true }) });
const overBudget = (p: PagePerformance) => BUDGETED_KINDS.filter((k) => p.totals[k] > PERFORMANCE_BUDGETS[k]);
const warnings = (p: PagePerformance) => p.findings.filter((f) => f.severity === 'warning').length;

/** A page as the whole site's list shows it. */
function row(p: PagePerformance) {
  if (p.status === 'unmeasured') return { route: clip(p.route), title: clip(p.title), measured: false, detail: clip(p.detail ?? '') };
  const over = overBudget(p);
  return {
    route: clip(p.route),
    title: clip(p.title),
    bytes: p.totals,
    ...(over.length ? { overBudget: over } : {}),
    ...(p.complete ? {} : { incomplete: true }),
    hero: p.hero ? { url: clip(p.hero.url), preloaded: p.hero.preloaded, ...(p.hero.from === 'estimate' ? { judged: true } : {}) } : null,
    warnings: warnings(p),
    notes: p.findings.length - warnings(p)
  };
}

export type PerformanceReportResult = { ok: true; content: Record<string, unknown> } | { ok: false; message: string };

/**
 * The page of `report` that `ref` names: a page by the ID it had when measured, or by its route now, or any measured page
 * by its route, with or without its slashes, percent-encoded or not.
 */
function pageFor(state: ProjectState, pages: readonly PagePerformance[], ref: string): PagePerformance | undefined {
  const byId = pages.find((p) => p.pageId === ref);
  if (byId) return byId;
  const id = pageIdFor(state, ref);
  const now = id ? state.pages[id]?.route : undefined;
  const plain = (r: string) => {
    let decoded = r;
    try {
      decoded = decodeURI(r);
    } catch {
      // A route that is not percent-encoded as a whole is read as written.
    }
    return `/${decoded.trim().replace(/^\/+|\/+$/g, '')}`.replace(/\/+$/, '') || '/';
  };
  return (now ? pages.find((p) => p.route === now) : undefined) ?? pages.find((p) => plain(p.route) === plain(ref));
}

/** The report for `args`, fitted to `room` characters of JSON, from the session's last measurement (`status`). */
export function performanceReport(state: ProjectState, revision: number, status: PerformanceStatus | null, args: AuditPerformanceArgs, allowed: number): PerformanceReportResult {
  const room = Math.min(allowed, PERFORMANCE_PART_CHARS);
  if (!status) return { ok: true, content: { revision, status: 'not_measured', note: NOT_MEASURED } };
  const { report, stale } = status;
  const head = {
    revision,
    measuredRevision: report.revision,
    measuredAt: report.measuredAt,
    ...(stale ? { stale: true, staleNote: STALE } : {}),
    window: `${report.viewport.width}x${report.viewport.height} at ${report.viewport.deviceScaleFactor}x, nothing cached`,
    budgets: report.budgets
  };
  const offset = args.offset ?? 0;

  if (args.route !== undefined) {
    if (!args.route.trim()) return { ok: false, message: 'route is empty: name a page by its ID or route, or leave route out for the whole site.' };
    const page = pageFor(state, report.pages, args.route);
    if (!page) {
      const routes = report.pages.map((p) => p.route);
      return { ok: false, message: `The last export measured no page "${args.route}". Measured: ${routes.slice(0, 20).join(', ')}${routes.length > 20 ? `, and ${routes.length - 20} more` : ''}` };
    }
    const all = [...page.findings.filter((f) => f.severity === 'warning'), ...page.findings.filter((f) => f.severity === 'info')];
    if (offset > 0 && offset >= all.length) return { ok: false, message: `This page has ${all.length} findings; offset ${offset} is past the last.` };
    let shown = all.slice(offset, offset + PERFORMANCE_ROWS_PER_PART);
    let largest = page.largest.length;
    let fonts = Math.min(page.fonts.length, FONTS_SHOWN);
    const build = () => {
      const nextOffset = offset + shown.length < all.length ? offset + shown.length : null;
      return {
        ...head,
        scope: { route: clip(page.route) },
        page: {
          ...row(page),
          ...(page.status === 'measured' ? { files: page.counts, largest: page.largest.slice(0, largest).map(file), fonts: page.fonts.slice(0, fonts).map(file), ...(fonts < page.fonts.length ? { moreFonts: page.fonts.length - fonts } : {}) } : {})
        },
        total: all.length,
        findings: shown.map(finding),
        ...(nextOffset !== null ? { nextOffset, more: CONTINUE } : {}),
        how: HOW
      };
    };
    for (let content = build(); JSON.stringify(content).length > room; content = build()) {
      if (shown.length > 1) shown = shown.slice(0, -1);
      else if (fonts > 0) fonts--;
      else if (largest > 1) largest--;
      else break;
    }
    return { ok: true, content: build() };
  }

  // The site: every page, those with the most warnings first (then the heaviest), and the website's own findings.
  const ranked = report.pages
    .map((p, i) => ({ p, i }))
    .sort((a, b) => warnings(b.p) - warnings(a.p) || BUDGETED_KINDS.reduce((n, k) => n + b.p.totals[k], 0) - BUDGETED_KINDS.reduce((n, k) => n + a.p.totals[k], 0) || a.i - b.i)
    .map(({ p }) => p);
  if (offset > 0 && offset >= ranked.length) return { ok: false, message: `The report has ${ranked.length} pages; offset ${offset} is past the last.` };
  const all = reportFindings(report);
  const counts = { warning: all.filter((f) => f.severity === 'warning').length, info: all.filter((f) => f.severity === 'info').length };
  const byCode: Record<string, number> = {};
  for (const f of all) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  let rows = ranked.slice(offset, offset + PERFORMANCE_ROWS_PER_PART);
  const build = () => {
    const nextOffset = offset + rows.length < ranked.length ? offset + rows.length : null;
    return {
      ...head,
      scope: 'site',
      cache: { ...report.cache, path: report.cache.path && clip(report.cache.path), value: report.cache.value && clip(report.cache.value) },
      siteFindings: report.findings.map(finding),
      counts,
      byCode,
      pages: report.pages.length,
      rows: rows.map(row),
      ...(nextOffset !== null ? { nextOffset, more: CONTINUE } : {}),
      note: "Each row's findings are read with route.",
      how: HOW
    };
  };
  for (let content = build(); JSON.stringify(content).length > room; content = build()) {
    if (rows.length > 1) rows = rows.slice(0, -1);
    else break;
  }
  return { ok: true, content: build() };
}
