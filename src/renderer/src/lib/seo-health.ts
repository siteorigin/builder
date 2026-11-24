/**
 * The SEO and agentic readiness audit (engine/seo-audit.ts) as Project health and the export dialog show it: its
 * findings by pillar, the counts its filters show, a one-line readiness summary, and the findings worth seeing before
 * a website export. Everything here only reads the findings, so the dialogs and their tests read one answer.
 */
import type { ProjectState } from '@shared/types';
import type { SeoFinding, SeoPillar } from '@shared/seo';
import { SEO_PILLARS } from '@shared/seo';
import { runSeoAudit } from '@engine/seo-audit';

/** Each pillar by the name the author reads, in SEO_PILLARS order. */
export const SEO_PILLAR_NAMES: Record<SeoPillar, string> = {
  technical: 'Technical',
  entity: 'Entity & structured data',
  agentic: 'Agentic readiness',
  content: 'Content & links',
  social: 'Social & performance'
};

export type SeoSeverity = SeoFinding['severity'];
export type SeoPillarFilter = SeoPillar | 'all';
export type SeoSeverityFilter = SeoSeverity | 'all';

/** The audit's findings, or why it could not read the project: a damaged project is Project health's to report, never a reason it cannot open. */
export type SeoAuditResult = { ok: true; findings: SeoFinding[] } | { ok: false; message: string };

export function auditForHealth(state: ProjectState): SeoAuditResult {
  try {
    return { ok: true, findings: runSeoAudit(state) };
  } catch (e) {
    return { ok: false, message: (e as Error)?.message || String(e) };
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** How each severity is counted, as Project health names its own lists. */
const SEVERITY_WORDS: Record<SeoSeverity, string> = { error: 'problem', warning: 'warning', info: 'note' };

/** "2 warnings and 3 notes", or whichever of them there are; empty when there are none. */
export function seoCountsText(findings: readonly SeoFinding[]): string {
  const parts = (['error', 'warning', 'info'] as const).map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
  const words = parts.map(([s, n]) => plural(n, SEVERITY_WORDS[s]));
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Whether a finding keeps the website from being found or shared, as against a suggestion. */
export const needsFixing = (f: SeoFinding) => f.severity !== 'info';

export function matchesSeoFilter(f: SeoFinding, pillar: SeoPillarFilter, severity: SeoSeverityFilter): boolean {
  return (pillar === 'all' || f.pillar === pillar) && (severity === 'all' || f.severity === severity);
}

/**
 * What each filter choice would show, with the other filter as it is: a pillar's count reads the chosen severity, and
 * a severity's count the chosen pillar, so every number is what pressing it lists.
 */
export function seoFilterCounts(findings: readonly SeoFinding[], pillar: SeoPillarFilter, severity: SeoSeverityFilter) {
  const pillars = { all: 0 } as Record<SeoPillarFilter, number>;
  for (const p of SEO_PILLARS) pillars[p] = 0;
  const severities: Record<SeoSeverityFilter, number> = { all: 0, error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    if (matchesSeoFilter(f, 'all', severity)) (pillars.all++, pillars[f.pillar]++);
    if (matchesSeoFilter(f, pillar, 'all')) (severities.all++, severities[f.severity]++);
  }
  return { pillars, severities };
}

/** The severities the severity filter offers: all of them, then each one the audit can name. A problem only when there is one. */
export function seoSeverityChoices(findings: readonly SeoFinding[]): SeoSeverityFilter[] {
  return ['all', ...(findings.some((f) => f.severity === 'error') ? (['error'] as const) : []), 'warning', 'info'];
}

/** The findings the filters show, grouped by pillar in SEO_PILLARS order, each group in the audit's own order. Empty pillars are left out. */
export function seoPillarGroups(findings: readonly SeoFinding[], pillar: SeoPillarFilter = 'all', severity: SeoSeverityFilter = 'all') {
  return SEO_PILLARS.map((p) => ({ pillar: p, name: SEO_PILLAR_NAMES[p], findings: findings.filter((f) => f.pillar === p && matchesSeoFilter(f, pillar, severity)) })).filter((g) => g.findings.length > 0);
}

/** "Technical and Social & performance": a list of names as a sentence reads it. */
function namesText(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * How ready the website is for search engines, link previews and AI agents, in a headline and a line: what was found,
 * and the pillars that need fixing (any with a problem or a warning), or that the rest are suggestions.
 */
export function seoReadiness(findings: readonly SeoFinding[]): { tone: 'warn' | 'quiet' | 'ok'; headline: string; detail: string } {
  if (!findings.length) return { tone: 'ok', headline: 'Ready for search and AI', detail: 'Nothing keeps search engines, link previews or AI agents from finding and reading the website.' };
  const attention = SEO_PILLARS.filter((p) => findings.some((f) => f.pillar === p && needsFixing(f)));
  const ready = SEO_PILLARS.length - attention.length;
  if (!attention.length) return { tone: 'quiet', headline: seoCountsText(findings), detail: 'Nothing needs fixing. The notes are suggestions that help the website be found and shared.' };
  return {
    tone: 'warn',
    headline: seoCountsText(findings),
    detail: `${namesText(attention.map((p) => SEO_PILLAR_NAMES[p]))} ${attention.length === 1 ? 'needs' : 'need'} attention; ${ready === 0 ? 'no area is' : `${ready} of ${SEO_PILLARS.length} areas ${ready === 1 ? 'is' : 'are'}`} ready.`
  };
}

/** How many findings the export dialog shows before it counts the rest. */
export const PREFLIGHT_EXAMPLES = 4;

/**
 * The findings worth seeing before a website export: every problem and warning (a suggestion waits for Project
 * health), problems first, each severity in the audit's order. Up to `limit` are shown, one of each kind first, so many
 * pages without a description never hide a picture without one; the rest are counted. None of them stops the export.
 */
export function seoPreflight(findings: readonly SeoFinding[], limit = PREFLIGHT_EXAMPLES): { total: number; examples: SeoFinding[]; more: number; notes: number } {
  const due = [...findings.filter((f) => f.severity === 'error'), ...findings.filter((f) => f.severity === 'warning')];
  const picked = new Set<SeoFinding>();
  const codes = new Set<string>();
  for (const f of due) if (picked.size < limit && !codes.has(f.code)) (codes.add(f.code), picked.add(f));
  for (const f of due) if (picked.size < limit) picked.add(f);
  return { total: due.length, examples: due.filter((f) => picked.has(f)), more: due.length - picked.size, notes: findings.length - due.length };
}
