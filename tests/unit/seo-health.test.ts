/**
 * SEO and agentic readiness in Project health and the export dialog (#592): the audit's findings grouped by pillar,
 * the counts each filter choice shows, the readiness summary, the findings worth seeing before a website export, and
 * a project the audit cannot read, which never stops Project health from opening.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { SeoFinding } from '@shared/seo';
import { SEO_PILLARS } from '@shared/seo';
import { runSeoAudit } from '@engine/seo-audit';
import { auditForHealth, seoCountsText, seoFilterCounts, seoPillarGroups, seoPreflight, seoReadiness, seoSeverityChoices, SEO_PILLAR_NAMES } from '../../src/renderer/src/lib/seo-health';
import { copy, run, seoSite } from './fixtures/seo-site';

/** A finding with only what these helpers read. */
const f = (pillar: SeoFinding['pillar'], severity: SeoFinding['severity'], code = `X_${pillar}_${severity}`): SeoFinding => ({ pillar, severity, code, message: code, explanation: '', aiFixable: false });

/** The fixture site with a few things left undone: no public URL, Services without a description, no sharing image, a post picture undescribed. */
function untidy(): ProjectState {
  const { state, services, entry } = seoSite();
  const s = run(state, { type: 'site.update', baseUrl: '', socialImage: null, description: '' }, { type: 'page.update', pageId: services, description: '' });
  const body = s.collections.posts.entries[entry].body.map((b) => (b.type === 'image' && !b.decorative ? { ...b, alt: '' } : b));
  return run(s, { type: 'entry.update', collectionId: 'posts', entryId: entry, body });
}

describe('the audit as Project health reads it', () => {
  it('is the audit’s own findings', () => {
    const s = untidy();
    expect(auditForHealth(s)).toEqual({ ok: true, findings: runSeoAudit(s) });
    // Nothing found is an audit that ran, not one that failed.
    expect(auditForHealth(seoSite().state)).toEqual({ ok: true, findings: [] });
  });

  it('says why when the project cannot be audited, instead of throwing', () => {
    const s = copy(seoSite().state);
    // A site document damaged past what the audit reads.
    (s as { site: unknown }).site = null;
    const r = auditForHealth(s);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.message).toBeTruthy();
    // The audit's own words are kept, for whoever fixes the project.
    const unreadable = copy(seoSite().state);
    Object.defineProperty(unreadable, 'site', {
      get() {
        throw new Error('The site document is damaged.');
      }
    });
    expect(auditForHealth(unreadable)).toEqual({ ok: false, message: 'The site document is damaged.' });
  });
});

describe('pillars', () => {
  it('are named in the order the audit lists them', () => {
    expect(Object.keys(SEO_PILLAR_NAMES)).toEqual([...SEO_PILLARS]);
    expect(SEO_PILLARS.map((p) => SEO_PILLAR_NAMES[p])).toEqual(['Technical', 'Entity & structured data', 'Agentic readiness', 'Content & links', 'Social & performance']);
  });

  it('group the findings in that order, leaving out empty pillars and keeping the audit’s order within each', () => {
    const s = untidy();
    const findings = runSeoAudit(s);
    const groups = seoPillarGroups(findings);
    expect(groups.map((g) => g.pillar)).toEqual(['technical', 'agentic', 'content', 'social']);
    expect(groups.flatMap((g) => g.findings)).toEqual(findings);
    expect(groups.find((g) => g.pillar === 'technical')!.findings.map((x) => x.code)).toEqual(['SEO_BASE_URL_MISSING']);
    expect(groups.find((g) => g.pillar === 'agentic')!.findings.map((x) => x.code)).toEqual(['ALT_MISSING']);
    expect(groups.find((g) => g.pillar === 'content')!.findings.map((x) => x.code)).toEqual(['SEO_DESCRIPTION_MISSING']);
    expect(groups.find((g) => g.pillar === 'social')!.findings.map((x) => x.code)).toEqual(['SEO_SOCIAL_IMAGE_MISSING']);
  });

  it('filter to one pillar, one severity, or both', () => {
    const findings = [f('technical', 'warning'), f('content', 'warning'), f('content', 'info'), f('social', 'info')];
    expect(seoPillarGroups(findings, 'content').flatMap((g) => g.findings)).toEqual([findings[1], findings[2]]);
    expect(seoPillarGroups(findings, 'all', 'info').flatMap((g) => g.findings)).toEqual([findings[2], findings[3]]);
    expect(seoPillarGroups(findings, 'content', 'info').flatMap((g) => g.findings)).toEqual([findings[2]]);
    expect(seoPillarGroups(findings, 'entity')).toEqual([]);
    expect(seoPillarGroups(findings, 'all', 'warning').flatMap((g) => g.findings)).toEqual([findings[0], findings[1]]);
    expect(seoPillarGroups(findings, 'content', 'warning').flatMap((g) => g.findings)).toEqual([findings[1]]);
  });

  it('keep findings of one pillar and severity in the order they came, never by code', () => {
    const z = f('content', 'warning', 'Z');
    const a = f('content', 'warning', 'A');
    expect(seoPillarGroups([z, a])).toEqual([{ pillar: 'content', name: 'Content & links', findings: [z, a] }]);
  });
});

describe('filter counts', () => {
  const findings = [f('technical', 'warning'), f('content', 'warning'), f('content', 'info'), f('social', 'info'), f('social', 'error')];

  it('count every finding with nothing chosen', () => {
    const { pillars, severities } = seoFilterCounts(findings, 'all', 'all');
    expect(pillars).toEqual({ all: 5, technical: 1, entity: 0, agentic: 0, content: 2, social: 2 });
    expect(severities).toEqual({ all: 5, error: 1, warning: 2, info: 2 });
    expect(seoFilterCounts([f('entity', 'warning'), f('agentic', 'info')], 'all', 'all').pillars).toEqual({ all: 2, technical: 0, entity: 1, agentic: 1, content: 0, social: 0 });
  });

  it('are what pressing each choice would list, with the other filter as it is', () => {
    const { pillars, severities } = seoFilterCounts(findings, 'content', 'info');
    // The pillars, counted among the notes.
    expect(pillars).toEqual({ all: 2, technical: 0, entity: 0, agentic: 0, content: 1, social: 1 });
    // The severities, counted in Content & links.
    expect(severities).toEqual({ all: 2, error: 0, warning: 1, info: 1 });
    for (const p of ['all', ...SEO_PILLARS] as const) expect(pillars[p]).toBe(seoPillarGroups(findings, p, 'info').flatMap((g) => g.findings).length);
    for (const s of ['all', 'error', 'warning', 'info'] as const) expect(severities[s]).toBe(seoPillarGroups(findings, 'content', s).flatMap((g) => g.findings).length);
    // Warnings chosen: the pillars count their warnings alone.
    expect(seoFilterCounts(findings, 'all', 'warning').pillars).toEqual({ all: 2, technical: 1, entity: 0, agentic: 0, content: 1, social: 0 });
    // Social chosen: the severities count Social's findings alone.
    expect(seoFilterCounts(findings, 'social', 'all').severities).toEqual({ all: 2, error: 1, warning: 0, info: 1 });
  });

  it('offer problems as a severity only when there is one', () => {
    expect(seoSeverityChoices(findings)).toEqual(['all', 'error', 'warning', 'info']);
    expect(seoSeverityChoices(findings.filter((x) => x.severity !== 'error'))).toEqual(['all', 'warning', 'info']);
    expect(seoSeverityChoices([])).toEqual(['all', 'warning', 'info']);
    expect(seoSeverityChoices([f('technical', 'error')])).toEqual(['all', 'error', 'warning', 'info']);
  });
});

describe('the readiness summary', () => {
  it('says a site with no findings is ready', () => {
    expect(runSeoAudit(seoSite().state)).toEqual([]);
    expect(seoReadiness([])).toEqual({ tone: 'ok', headline: 'Ready for search and AI', detail: 'Nothing keeps search engines, link previews or AI agents from finding and reading the website.' });
  });

  it('counts what was found and names the pillars that need fixing', () => {
    expect(seoReadiness(runSeoAudit(untidy()))).toEqual({
      tone: 'warn',
      headline: '4 warnings',
      detail: 'Technical, Agentic readiness, Content & links and Social & performance need attention; 1 of 5 areas is ready.'
    });
    expect(seoReadiness([f('technical', 'warning'), f('content', 'info')])).toEqual({ tone: 'warn', headline: '1 warning and 1 note', detail: 'Technical needs attention; 4 of 5 areas are ready.' });
    // A problem needs fixing as a warning does.
    expect(seoReadiness([f('social', 'error')])).toEqual({ tone: 'warn', headline: '1 problem', detail: 'Social & performance needs attention; 4 of 5 areas are ready.' });
    expect(seoReadiness(SEO_PILLARS.map((p) => f(p, 'warning'))).detail).toBe('Technical, Entity & structured data, Agentic readiness, Content & links and Social & performance need attention; no area is ready.');
  });

  it('says notes alone are suggestions', () => {
    expect(seoReadiness([f('content', 'info'), f('social', 'info')])).toEqual({ tone: 'quiet', headline: '2 notes', detail: 'Nothing needs fixing. The notes are suggestions that help the website be found and shared.' });
    expect(seoReadiness([f('content', 'info')])).toMatchObject({ tone: 'quiet', headline: '1 note' });
  });

  it('counts problems, warnings and notes as Project health names them', () => {
    expect(seoCountsText([f('technical', 'error'), f('technical', 'warning'), f('content', 'warning'), f('content', 'info')])).toBe('1 problem, 2 warnings and 1 note');
    expect(seoCountsText([])).toBe('');
    expect(seoCountsText([f('technical', 'error'), f('social', 'error')])).toBe('2 problems');
  });
});

describe('the export preflight', () => {
  it('shows the problems and warnings, never the notes, and stops nothing', () => {
    const findings = runSeoAudit(untidy());
    const pre = seoPreflight(findings);
    expect(pre.total).toBe(4);
    expect(pre.examples.map((x) => x.code)).toEqual(['SEO_BASE_URL_MISSING', 'ALT_MISSING', 'SEO_DESCRIPTION_MISSING', 'SEO_SOCIAL_IMAGE_MISSING']);
    expect(pre.more).toBe(0);
    expect(pre.notes).toBe(0);
    expect(seoPreflight([f('content', 'info'), f('social', 'info')])).toEqual({ total: 0, examples: [], more: 0, notes: 2 });
    // Notes are counted one by one, however many share a kind.
    const warning = f('content', 'warning', 'SEO_DESCRIPTION_MISSING');
    const short = (id: string) => ({ ...f('content', 'info', 'SEO_TITLE_LENGTH'), owner: { kind: 'page' as const, id } });
    expect(seoPreflight([warning, short('one'), short('two')])).toEqual({ total: 1, examples: [warning], more: 0, notes: 2 });
  });

  it('names a problem a future rule finds before any warning, whatever its pillar', () => {
    const crawlers = f('agentic', 'error', 'SEO_CRAWLERS_BLOCKED');
    const pre = seoPreflight([f('technical', 'warning', 'SEO_BASE_URL_MISSING'), crawlers, f('content', 'info')]);
    expect(pre.examples).toEqual([crawlers, f('technical', 'warning', 'SEO_BASE_URL_MISSING')]);
    expect(pre.total).toBe(2);
    expect(pre.more).toBe(0);
    expect(pre.notes).toBe(1);
  });

  it('shows one of each kind before a second of any, and counts the rest', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...f('content', 'warning', 'SEO_DESCRIPTION_MISSING'), owner: { kind: 'page' as const, id: `pg_${i}` } }));
    const picture = f('agentic', 'warning', 'ALT_MISSING');
    const url = f('technical', 'warning', 'SEO_BASE_URL_MISSING');
    // In the audit's order: technical, agentic, content.
    const pre = seoPreflight([url, picture, ...many]);
    expect(pre.examples).toEqual([url, picture, many[0], many[1]]);
    expect(pre.more).toBe(4);
    expect(pre.total).toBe(8);
    // Kinds past the limit are still counted.
    const kinds = ['A', 'B', 'C', 'D', 'E'].map((c) => f('content', 'warning', c));
    expect(seoPreflight(kinds)).toMatchObject({ examples: kinds.slice(0, 4), more: 1 });
    // A second of a kind waits for every other kind, then the list keeps its own order.
    const page = (code: string, id: string) => ({ ...f('content', 'warning', code), owner: { kind: 'page' as const, id } });
    const [A, B1, B2, B3, C, D] = [page('A', 'a'), page('B', '1'), page('B', '2'), page('B', '3'), page('C', 'c'), page('D', 'd')];
    expect(seoPreflight([A, B1, B2, B3, C, D]).examples).toEqual([A, B1, C, D]);
    expect(seoPreflight([A, B1, B2, C, B3]).examples).toEqual([A, B1, B2, C]);
  });

  it('shows and counts a finding once for each time it is listed', () => {
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((code) => f('content', 'warning', code));
    expect(seoPreflight([a, a, b, c, d])).toEqual({ total: 5, examples: [a, b, c, d], more: 1, notes: 0 });
  });

  it('keeps the audit’s order among what it shows', () => {
    const a = f('technical', 'warning', 'A');
    const b1 = { ...f('content', 'warning', 'B'), owner: { kind: 'page' as const, id: 'one' } };
    const b2 = { ...f('content', 'warning', 'B'), owner: { kind: 'page' as const, id: 'two' } };
    const c = f('social', 'warning', 'C');
    expect(seoPreflight([a, b1, b2, c]).examples).toEqual([a, b1, b2, c]);
  });
});
