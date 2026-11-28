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
import { auditForHealth, seoCountsText, seoFilterCounts, seoPillarGroups, seoReadiness, seoSeverityChoices, SEO_PILLAR_NAMES } from '../../src/renderer/src/lib/seo-health';
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
      detail: '4 of 5 areas need attention.'
    });
    expect(seoReadiness([f('technical', 'warning'), f('content', 'info')])).toEqual({ tone: 'warn', headline: '1 warning and 1 note', detail: '1 of 5 areas needs attention.' });
    // A problem needs fixing as a warning does.
    expect(seoReadiness([f('social', 'error')])).toEqual({ tone: 'warn', headline: '1 problem', detail: '1 of 5 areas needs attention.' });
    expect(seoReadiness(SEO_PILLARS.map((p) => f(p, 'warning'))).detail).toBe('All 5 areas need attention.');
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
