/**
 * The audit_seo tool's report: the SEO and agentic readiness audit (engine/seo-audit.ts) as the assistant reads it,
 * for the whole site or one page, all findings or one pillar's, most serious first, with the links that join the
 * site's pages. It reads the saved project only, so the same project always gives the same report, and it always fits
 * one tool result whole: what does not fit comes in later parts, and the counts always describe every finding.
 */
import { z } from 'zod';
import type { ProjectState } from '@shared/types';
import { SEO_PILLARS, type SeoFinding, type SeoPillar } from '@shared/seo';
import { auditSeo } from '@engine/seo-audit';
import { incomingLinks } from '@engine/seo-rules';
import { pageIdFor } from './context';

export const AUDIT_SEO_ARGS = z.object({
  pageId: z.string().optional().describe('One page, by its ID or route: its own findings and what links to it. Leave out for the whole site.'),
  pillar: z.enum(SEO_PILLARS).optional().describe('Only this kind of finding: technical (public URL, search settings), entity, agentic (what AI agents read), content (titles, descriptions, links) or social (sharing image, icon).'),
  offset: z.number().int().min(0).optional().describe('More findings, from the nextOffset a previous call returned.'),
  linkOffset: z.number().int().min(0).optional().describe('More of the link overview, from the nextLinkOffset a previous call returned.')
});

export type AuditSeoArgs = z.infer<typeof AUDIT_SEO_ARGS>;

/** The most findings, and link overview rows, one part shows. Fewer when they would not fit the result. */
export const FINDINGS_PER_PART = 40;
export const LINK_ROWS_PER_PART = 100;
/** The longest message a finding shows: one quoting a long description is cut. */
const MESSAGE_CHARS = 300;
/**
 * The most room the IDs that place one finding or row may take. Longer ones (a hand-edited file's) are left out, and
 * said to be, never cut into an ID that names something else: the rest of the report still fits around them.
 */
const LOCATOR_CHARS = 1000;

const SEVERITY = { error: 0, warning: 1, info: 2 } as const;

/** How a report in parts is read on: each part counts on the project being as it was, so a change starts it again. */
const CONTINUE = 'Call again with offset set to nextOffset, or linkOffset set to links.nextLinkOffset, for the next part. After a change to the site, audit again from the start.';

const clip = (text: string) => {
  const chars = [...text];
  return chars.length > MESSAGE_CHARS ? `${chars.slice(0, MESSAGE_CHARS - 1).join('')}…` : text;
};

/**
 * A finding as the assistant acts on it: what it is, how serious, and where it is fixed. Why it matters is said once in
 * the report's reasons, which `reason` indexes: findings of one code may differ (a title too long, or too short).
 */
function compact(f: SeoFinding, reason: number) {
  const at = { ...(f.owner ? { owner: f.owner } : {}), ...(f.nodeId ? { nodeId: f.nodeId } : {}), ...(f.destination ? { fix: f.destination } : {}) };
  return { code: f.code, severity: f.severity, pillar: f.pillar, message: clip(f.message), reason, aiFixable: f.aiFixable, ...(JSON.stringify(at).length > LOCATOR_CHARS ? { locatorOmitted: true } : at) };
}

/** A link overview row with an ID too long to show (see LOCATOR_CHARS) said to have one, and the rest of it kept. */
function shownRow(row: Record<string, unknown>, key: 'pageId' | 'id'): Record<string, unknown> {
  if (JSON.stringify(row[key] ?? '').length <= LOCATOR_CHARS) return row;
  const { [key]: _id, ...rest } = row;
  return { ...rest, idOmitted: true };
}

/** Whether a finding is about one page itself: its own settings, or something on it. A site-wide finding is not. */
function onPage(f: SeoFinding, pageId: string): boolean {
  if (f.owner?.kind === 'page' && f.owner.id === pageId) return true;
  const d = f.destination;
  return (d?.kind === 'pageSeo' && d.pageId === pageId) || (d?.kind === 'element' && d.owner.kind === 'page' && d.owner.id === pageId);
}

export type SeoReport = { ok: true; content: Record<string, unknown> } | { ok: false; message: string };

/**
 * The report for `args`, fitted to `room` characters of JSON. A page is named by its ID or route; one the project
 * does not have (or cannot read) is an error, and a draft has nothing to audit until it is published.
 */
export function seoReport(project: ProjectState, revision: number, args: AuditSeoArgs, room: number): SeoReport {
  const { context, findings } = auditSeo(project);
  const { state, documents } = context;
  let pageId: string | undefined;
  if (args.pageId !== undefined) {
    // Resolved on the project as the audit reads it: a page too damaged to read is not one it can report on.
    const resolved = pageIdFor(state, args.pageId);
    if (!resolved) {
      const pages = state.site.pageOrder.filter((id) => Object.hasOwn(state.pages, id));
      return { ok: false, message: `No page "${args.pageId}". Pages: ${pages.slice(0, 20).join(', ')}${pages.length > 20 ? `, and ${pages.length - 20} more` : ''}` };
    }
    pageId = resolved;
  }
  // A page whose own ID is too long to show (see LOCATOR_CHARS) is reported on without it, as a row of it would be.
  const scope = { ...(pageId ? shownRow({ pageId }, 'pageId') : {}), ...(args.pillar ? { pillar: args.pillar } : {}) };
  const publishedPages = documents.flatMap((d) => (d.subject.kind === 'page' ? [d.subject.pageId] : []));
  const published = new Set(publishedPages);
  if (pageId && !published.has(pageId)) return { ok: true, content: { revision, scope, published: false, total: 0, note: 'This page is not on the website (a draft is not published), so there is nothing to audit until it is.' } };

  const scoped = findings.filter((f) => (!pageId || onPage(f, pageId)) && (!args.pillar || f.pillar === args.pillar));
  // Most serious first; within a severity, the audit's own order (by pillar, then the site's order).
  const ordered = scoped.map((f, i) => ({ f, i })).sort((a, b) => SEVERITY[a.f.severity] - SEVERITY[b.f.severity] || a.i - b.i).map(({ f }) => f);
  const counts = { error: 0, warning: 0, info: 0 };
  const byPillar: Partial<Record<SeoPillar, number>> = {};
  for (const f of ordered) {
    counts[f.severity]++;
    byPillar[f.pillar] = (byPillar[f.pillar] ?? 0) + 1;
  }

  // The links that join the published pages: into each from anywhere else on the website (the audit's own judgement
  // of what reaches a page), and out of each page's own content to another published page.
  const into = new Map<string, number>();
  const from = new Map<string, { kind: string; id: string; count: number }>();
  for (const l of incomingLinks(context)) {
    into.set(l.pageId, (into.get(l.pageId) ?? 0) + 1);
    if (l.pageId !== pageId) continue;
    const key = `${l.owner.kind}:${l.owner.id}`;
    from.set(key, { kind: l.owner.kind, id: l.owner.id, count: (from.get(key)?.count ?? 0) + 1 });
  }
  const outOf = new Map<string, number>();
  for (const l of context.links()) if (l.owner.kind === 'page' && l.pageId && l.pageId !== l.owner.id && published.has(l.pageId)) outOf.set(l.owner.id, (outOf.get(l.owner.id) ?? 0) + 1);
  const orphans = new Set(findings.flatMap((f) => (f.code === 'SEO_PAGE_UNLINKED' && f.owner?.kind === 'page' ? [f.owner.id] : [])));
  const row = (id: string) => ({ pageId: id, incoming: into.get(id) ?? 0, outgoing: outOf.get(id) ?? 0, ...(orphans.has(id) ? { orphan: true } : {}) });
  // One page lists where the links to it are, a page, shared part or entry at a time; the site lists its pages.
  const rows: unknown[] = pageId ? [...from.values()].map((r) => shownRow(r, 'id')) : publishedPages.map((id) => shownRow(row(id), 'pageId'));

  const offset = args.offset ?? 0;
  const linkOffset = args.linkOffset ?? 0;
  if (offset > 0 && offset >= ordered.length) return { ok: false, message: `There are ${ordered.length} findings; offset ${offset} is past the last.` };
  if (linkOffset > 0 && linkOffset >= rows.length) return { ok: false, message: `There are ${rows.length} link overview rows; linkOffset ${linkOffset} is past the last.` };

  let shown = ordered.slice(offset, offset + FINDINGS_PER_PART);
  let rowsShown = rows.slice(linkOffset, linkOffset + LINK_ROWS_PER_PART);
  const build = () => {
    const reasons = [...new Set(shown.map((f) => f.explanation))];
    const nextOffset = offset + shown.length < ordered.length ? offset + shown.length : null;
    const nextLinkOffset = linkOffset + rowsShown.length < rows.length ? linkOffset + rowsShown.length : null;
    const links = pageId
      ? { ...shownRow(row(pageId), 'pageId'), from: rowsShown, ...(nextLinkOffset !== null ? { nextLinkOffset } : {}) }
      : { pages: publishedPages.length, orphans: publishedPages.filter((id) => orphans.has(id)).length, rows: rowsShown, ...(nextLinkOffset !== null ? { nextLinkOffset } : {}) };
    return {
      revision,
      scope,
      total: ordered.length,
      counts,
      byPillar,
      findings: shown.map((f) => compact(f, reasons.indexOf(f.explanation))),
      ...(nextOffset !== null ? { nextOffset } : {}),
      ...(nextOffset !== null || nextLinkOffset !== null ? { more: CONTINUE } : {}),
      ...(reasons.length ? { reasons } : {}),
      links
    };
  };
  // Cut from whichever list takes more room, a row at a time, keeping one of each so neither reads as empty.
  for (let content = build(); JSON.stringify(content).length > room; content = build()) {
    const findingsSize = JSON.stringify(content.findings).length;
    const rowsSize = JSON.stringify(rowsShown).length;
    if (shown.length > 1 && (findingsSize >= rowsSize || rowsShown.length <= 1)) shown = shown.slice(0, -1);
    else if (rowsShown.length > 1) rowsShown = rowsShown.slice(0, -1);
    else break;
  }
  return { ok: true, content: build() };
}
