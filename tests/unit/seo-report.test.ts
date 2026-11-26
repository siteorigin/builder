/**
 * The assistant's SEO audit (#593): the audit_seo tool over the shared audit (#580), for the whole site or one page,
 * one pillar or all, fitted whole to a tool result, in every kind of run that may read the site; and the search
 * settings the project summary says the site and each page have.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { executeTool, MUTATING_TOOLS, REVISION_BOUND_TOOLS, toolsForRun, type ToolHost } from '@agent/tools';
import { projectSummary } from '@agent/context';
import { FINDINGS_PER_PART } from '@agent/seo-report';
import { findForbiddenShapes, toStrictSchema } from '@agent/strict-schema';
import { selectionTarget } from '@agent/selection';
import { runSeoAudit } from '@engine/seo-audit';
import { copy, run, seoSite } from './fixtures/seo-site';

const MAX_RESULT_CHARS = 24000;

const host = (s: ProjectState, revision = 7) => ({ state: () => s, revision: () => revision }) as unknown as ToolHost;

/** The tool's answer, as the model reads it: the result serialized, which must be the report itself and never cut short. */
async function audit(s: ProjectState, args: Record<string, unknown> = {}, revision = 7) {
  const out = await executeTool('audit_seo', JSON.stringify(args), host(s, revision), 'call_1');
  const content = out.content as Record<string, any>;
  if (out.ok) expect(JSON.stringify(content).length).toBeLessThanOrEqual(MAX_RESULT_CHARS - 200);
  expect(out.mutated).toBeUndefined();
  return { ok: out.ok, content };
}

describe('audit_seo', () => {
  it('reports a well set-up site as clean, with the links between its pages', async () => {
    const { state, home, services } = seoSite();
    const { ok, content } = await audit(state);
    expect(ok).toBe(true);
    expect(content).toMatchObject({ revision: 7, scope: {}, total: 0, counts: { error: 0, warning: 0, info: 0 }, byPillar: {}, findings: [] });
    expect(content.nextOffset).toBeUndefined();
    expect(content.reasons).toBeUndefined();
    expect(content.links.pages).toBe(2);
    expect(content.links.orphans).toBe(0);
    expect(content.links.rows.map((r: { pageId: string }) => r.pageId)).toEqual([home, services]);
    // The header's link to Services is seen from Home and the post, so it reaches Services.
    expect(content.links.rows.find((r: { pageId: string }) => r.pageId === services)).toMatchObject({ incoming: expect.any(Number), outgoing: 0 });
    expect(content.links.rows.find((r: { pageId: string }) => r.pageId === services).incoming).toBeGreaterThan(0);
    expect(content.links.rows.some((r: { orphan?: boolean }) => r.orphan)).toBe(false);
  });

  it('lists findings most serious first, counted whole, each with where it is fixed and why its code matters', async () => {
    const { state, services } = seoSite();
    // No public URL (a site-wide warning), a Services title Home already has (a warning on each) and a short one (info).
    const s = run(state, { type: 'site.update', baseUrl: '' }, { type: 'page.update', pageId: services, seoTitle: 'Riverside Studio · Pottery classes and handmade work', description: `Weekly wheel classes, private lessons and commissions. ${'More words about the classes. '.repeat(6)}` }, { type: 'page.update', pageId: state.site.homePageId, description: 'Too short.' });
    const all = runSeoAudit(s);
    const { content } = await audit(s);
    expect(content.total).toBe(all.length);
    expect(content.counts).toEqual({ error: 0, warning: all.filter((f) => f.severity === 'warning').length, info: all.filter((f) => f.severity === 'info').length });
    expect(content.findings.map((f: { code: string }) => f.code)).toEqual([...all.filter((f) => f.severity === 'warning'), ...all.filter((f) => f.severity === 'info')].map((f) => f.code));
    expect(content.byPillar).toEqual({ technical: 1, content: all.filter((f) => f.pillar === 'content').length });
    const duplicate = content.findings.find((f: { code: string; owner?: { id: string } }) => f.code === 'SEO_TITLE_DUPLICATE' && f.owner?.id === services);
    expect(duplicate).toMatchObject({ severity: 'warning', pillar: 'content', aiFixable: true, owner: { kind: 'page', id: services }, fix: { kind: 'pageSeo', pageId: services, field: 'title' } });
    expect(duplicate.explanation).toBeUndefined();
    expect(content.reasons[duplicate.reason]).toMatch(/compete with each other/);
    // Each reason is said once, and each finding's is its own: a title too short and one too long are told apart.
    expect(new Set(content.reasons).size).toBe(content.reasons.length);
    for (const f of content.findings) expect(content.reasons[f.reason]).toBe(all.find((g) => g.code === f.code && g.owner?.id === f.owner?.id)!.explanation);
    const lengths = content.findings.filter((f: { code: string }) => f.code === 'SEO_DESCRIPTION_LENGTH');
    expect(lengths).toHaveLength(2);
    expect(lengths[0].reason).not.toBe(lengths[1].reason);
    expect(content.findings.find((f: { code: string }) => f.code === 'SEO_BASE_URL_MISSING')).toMatchObject({ fix: { kind: 'site', field: 'baseUrl' }, aiFixable: false });
  });

  it('narrows to one page, by its ID or its route, leaving the site-wide findings and the other page’s out', async () => {
    const { state, home, services } = seoSite();
    const s = run(state, { type: 'site.update', baseUrl: '' }, { type: 'page.update', pageId: services, seoTitle: 'Riverside Studio · Pottery classes and handmade work' });
    const byId = await audit(s, { pageId: services });
    const byRoute = await audit(s, { pageId: 'services' });
    expect(byRoute.content).toEqual(byId.content);
    expect(byId.content.scope).toEqual({ pageId: services });
    expect(byId.content.findings).toEqual([expect.objectContaining({ code: 'SEO_TITLE_DUPLICATE', owner: { kind: 'page', id: services } })]);
    expect(byId.content.total).toBe(1);
    // Home's side of the same duplicate is Home's.
    const atHome = await audit(s, { pageId: '/' });
    expect(atHome.content.scope).toEqual({ pageId: home });
    expect(atHome.content.findings).toEqual([expect.objectContaining({ code: 'SEO_TITLE_DUPLICATE', owner: { kind: 'page', id: home } })]);
  });

  it('narrows to one pillar, alone or with a page, and says so when it has nothing', async () => {
    const { state, home, services } = seoSite();
    // A content finding on Home too, which a narrower scope leaves out.
    const s = run(state, { type: 'site.update', baseUrl: '', favicon: null }, { type: 'page.update', pageId: services, seoTitle: 'Short' }, { type: 'page.update', pageId: home, description: 'Too short.' });
    const technical = await audit(s, { pillar: 'technical' });
    expect(technical.content.scope).toEqual({ pillar: 'technical' });
    expect(technical.content.findings.map((f: { code: string }) => f.code)).toEqual(['SEO_BASE_URL_MISSING']);
    const social = await audit(s, { pillar: 'social' });
    expect(social.content.findings.map((f: { code: string }) => f.code)).toEqual(['SEO_FAVICON_MISSING']);
    const content = await audit(s, { pillar: 'content' });
    expect(content.content.findings.map((f: { code: string; owner?: { id: string } }) => `${f.code} ${f.owner?.id}`).sort()).toEqual([`SEO_DESCRIPTION_LENGTH ${home}`, `SEO_TITLE_LENGTH ${services}`]);
    const both = await audit(s, { pageId: services, pillar: 'content' });
    expect(both.content.findings.map((f: { code: string }) => f.code)).toEqual(['SEO_TITLE_LENGTH']);
    expect(both.content).toMatchObject({ total: 1, byPillar: { content: 1 } });
    const none = await audit(s, { pageId: services, pillar: 'agentic' });
    expect(none.content).toMatchObject({ scope: { pageId: services, pillar: 'agentic' }, total: 0, findings: [] });
    // The link overview is the page's whatever the pillar.
    expect(none.content.links).toMatchObject({ pageId: services });
  });

  it('says which pages, shared parts and entries link to one page, and counts a header only that page shows as none', async () => {
    const { state, services } = seoSite();
    // A site of pages alone, where only Services shows the header with its link to Services.
    const s = copy(state);
    s.collections = {};
    for (const id of s.site.pageOrder) s.pages[id].showHeader = id === services;
    const alone = await audit(s, { pageId: '/services/' }, 8);
    expect(alone.content.links).toMatchObject({ pageId: services, incoming: 0, orphan: true, from: [] });
    expect(alone.content.findings.map((f: { code: string }) => f.code)).toEqual(['SEO_PAGE_UNLINKED']);
    // Shown on Home too, the header's link brings visitors there.
    s.pages[s.site.homePageId].showHeader = true;
    const shown = await audit(s, { pageId: services }, 9);
    expect(shown.content.links).toEqual({ pageId: services, incoming: 1, outgoing: 0, from: [{ kind: 'shell', id: 'header', count: 1 }] });
    expect(shown.content.total).toBe(0);
    // The whole site's view of the same thing.
    const site = await audit(s, {}, 9);
    expect(site.content.links).toMatchObject({ pages: 2, orphans: 0 });
  });

  it('flags orphan pages in the whole site’s overview, and counts a link from another page into and out of each', async () => {
    const { state, home } = seoSite();
    const s = run(
      state,
      { type: 'page.create', pageId: 'pg_kilns', title: 'Kiln hire', route: '/kiln-hire/', starter: 'intro' },
      { type: 'page.update', pageId: 'pg_kilns', seoTitle: 'Kiln hire for potters · Riverside Studio', description: 'Hire the studio kilns by the shelf or the whole firing, for bisque and glaze firings alike, any week.' },
      { type: 'page.create', pageId: 'pg_gallery', title: 'Gallery', route: '/gallery/', starter: 'intro' },
      { type: 'page.update', pageId: 'pg_gallery', seoTitle: 'Gallery of student work · Riverside Studio', description: 'Bowls, cups and plates made by students in the studio this year, from first pots to finished sets.' }
    );
    const { content } = await audit(s);
    expect(content.links).toMatchObject({ pages: 4, orphans: 2 });
    expect(content.links.rows.find((r: { pageId: string }) => r.pageId === 'pg_kilns')).toEqual({ pageId: 'pg_kilns', incoming: 0, outgoing: 0, orphan: true });
    expect(content.findings.map((f: { code: string; owner?: { id: string } }) => `${f.code} ${f.owner?.id}`)).toEqual(['SEO_PAGE_UNLINKED pg_kilns', 'SEO_PAGE_UNLINKED pg_gallery']);
    // Nothing the AI can edit links a page in from the right place, so it says it cannot fix one.
    expect(content.findings[0]).toMatchObject({ aiFixable: false, owner: { kind: 'page', id: 'pg_kilns' } });
    // A link on Home to Kiln hire is one out of Home and one into Kiln hire, from Home.
    const linked = copy(s);
    linked.pages[home].nodes.kiln_link = { id: 'kiln_link', kind: 'link', label: 'Kiln hire prices', link: { type: 'page', target: 'pg_kilns' }, appearance: 'primary' } as never;
    linked.pages[home].rootIds.push('kiln_link');
    linked.pages[home].nodes.kiln_link_2 = { id: 'kiln_link_2', kind: 'link', label: 'Book a firing', link: { type: 'page', target: 'pg_kilns' }, appearance: 'secondary' } as never;
    linked.pages[home].rootIds.push('kiln_link_2');
    const after = await audit(linked);
    expect(after.content.links).toMatchObject({ pages: 4, orphans: 1 });
    expect(after.content.links.rows.find((r: { pageId: string }) => r.pageId === 'pg_kilns')).toEqual({ pageId: 'pg_kilns', incoming: 2, outgoing: 0 });
    expect(after.content.links.rows.find((r: { pageId: string }) => r.pageId === home)).toMatchObject({ outgoing: 2 });
    const kilns = await audit(linked, { pageId: '/kiln-hire/' });
    expect(kilns.content.links).toEqual({ pageId: 'pg_kilns', incoming: 2, outgoing: 0, from: [{ kind: 'page', id: home, count: 2 }] });
  });

  it('has nothing to audit on a draft, and refuses a page the project does not have', async () => {
    const { state } = seoSite();
    const s = run(state, { type: 'page.create', pageId: 'pg_draft', title: 'Coming soon', route: '/soon/' }, { type: 'page.update', pageId: 'pg_draft', draft: true });
    const draft = await audit(s, { pageId: 'pg_draft' });
    expect(draft).toMatchObject({ ok: true, content: { scope: { pageId: 'pg_draft' }, published: false, total: 0 } });
    expect((await audit(s, { pageId: '/soon/' })).content).toEqual(draft.content);
    const missing = await audit(s, { pageId: '/nowhere/' });
    expect(missing).toMatchObject({ ok: false, content: { error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('No page "/nowhere/"') } } });
    expect((await audit(s, { pageId: '   ' })).ok).toBe(false);
    expect((await audit(s, { pillar: 'speed' })).content).toMatchObject({ error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('pillar') } });
  });

  it('reads a project with a page too damaged to read, and never reports on that page', async () => {
    const { state } = seoSite();
    const s = copy(state);
    (s.pages as Record<string, unknown>).pg_broken = null;
    (s.pages as Record<string, unknown>).pg_lost = { ...structuredClone(s.pages[s.site.homePageId]), id: 'pg_lost', route: undefined };
    s.site.pageOrder.push('pg_broken', 'pg_lost');
    expect((await audit(s)).ok).toBe(true);
    expect((await audit(s, { pageId: 'pg_broken' })).ok).toBe(false);
    expect((await audit(s, { pageId: 'pg_lost' })).ok).toBe(false);
    expect((await audit(s, { pageId: '/services/' })).ok).toBe(true);
  });

  it('fits a large site into parts that each fit a result whole, with every finding in exactly one part', async () => {
    const { state } = seoSite();
    let s = state;
    const words = (i: number) => `Página ${i} “${'ü'.repeat(200)}” \\ ${'"quoted" '.repeat(20)}`;
    // Pages with the same long title and description: each repeats the others, runs long, and nothing links to it.
    for (let i = 0; i < 150; i++) s = run(s, { type: 'page.create', pageId: `pg_${i}`, title: words(i), route: `/p-${i}/` }, { type: 'page.update', pageId: `pg_${i}`, seoTitle: words(0), description: words(0) });
    const all = runSeoAudit(s);
    expect(all.length).toBeGreaterThan(FINDINGS_PER_PART * 4);
    const seen: string[] = [];
    let offset: number | undefined = 0;
    let parts = 0;
    let cut = false;
    while (offset !== undefined) {
      const { ok, content } = await audit(s, offset ? { offset } : {});
      expect(ok).toBe(true);
      expect(content.total).toBe(all.length);
      expect(content.counts.warning + content.counts.info + content.counts.error).toBe(all.length);
      expect(content.findings.length).toBeGreaterThan(0);
      expect(content.findings.length).toBeLessThanOrEqual(FINDINGS_PER_PART);
      for (const f of content.findings) expect([...f.message].length).toBeLessThanOrEqual(300);
      seen.push(...content.findings.map((f: { code: string; owner?: { id: string } }) => `${f.code}|${f.owner?.id ?? ''}`));
      // A part holds fewer than its most when the findings would not fit the result whole.
      if (content.nextOffset !== undefined && content.findings.length < FINDINGS_PER_PART) cut = true;
      // A part that is not the last says how to read on, and to start again after a change.
      if (content.nextOffset !== undefined) expect(content.more).toMatch(/offset set to nextOffset.*start/);
      offset = content.nextOffset;
      parts++;
    }
    expect(cut).toBe(true);
    expect(parts).toBeGreaterThan(4);
    expect(seen.length).toBe(all.length);
    expect(new Set(seen).size).toBe(new Set(all.map((f) => `${f.code}|${f.owner?.id ?? ''}`)).size);
    // The link overview comes in parts of its own.
    const first = await audit(s);
    expect(first.content.links.pages).toBe(152);
    const rows = [...first.content.links.rows];
    let linkOffset = first.content.links.nextLinkOffset;
    expect(linkOffset).toBeGreaterThan(0);
    while (linkOffset !== undefined) {
      const next = await audit(s, { linkOffset });
      rows.push(...next.content.links.rows);
      linkOffset = next.content.links.nextLinkOffset;
    }
    expect(rows.map((r: { pageId: string }) => r.pageId)).toEqual(s.site.pageOrder);
    expect(rows.filter((r: { orphan?: boolean }) => r.orphan).length).toBe(first.content.links.orphans);
    // Past the end is an error, never an empty report that reads as a clean one.
    expect(await audit(s, { offset: all.length })).toMatchObject({ ok: false, content: { ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('past the last') } } });
    expect(await audit(s, { linkOffset: 152 })).toMatchObject({ ok: false, content: { ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('past the last') } } });
  });

  it('leaves out an ID too long to show rather than the rest of the report', async () => {
    const { state, home } = seoSite();
    const s = copy(state);
    // A hand-edited file: a "Read more" link whose node ID alone is longer than a result, and a page whose ID is too.
    const longNode = `n_${'x'.repeat(30000)}`;
    s.pages[home].nodes[longNode] = { id: longNode, kind: 'link', label: 'Read more', link: { type: 'url', target: 'https://example.org/' }, appearance: 'primary' } as never;
    s.pages[home].rootIds.push(longNode);
    const longPage = `pg_${'y'.repeat(30000)}`;
    s.pages[longPage] = { ...structuredClone(s.pages[s.site.homePageId]), id: longPage, route: '/long/', title: 'Long', seo: {}, rootIds: [], nodes: {} };
    s.site.pageOrder.push(longPage);
    const { ok, content } = await audit(s);
    expect(ok).toBe(true);
    expect(content.truncated).toBeUndefined();
    const generic = content.findings.find((f: { code: string }) => f.code === 'SEO_LINK_TEXT_GENERIC');
    expect(generic).toMatchObject({ locatorOmitted: true, message: 'A link says only “Read more”.' });
    expect(generic.nodeId).toBeUndefined();
    expect(content.findings.filter((f: { locatorOmitted?: boolean }) => f.locatorOmitted).length).toBeGreaterThan(1);
    expect(content.links.rows).toContainEqual(expect.objectContaining({ idOmitted: true, orphan: true }));
    expect(content.links.rows.filter((r: { pageId?: string }) => r.pageId).length).toBe(2);
    // That page audited on its own, by its address: the report is whole, without the ID.
    const one = await audit(s, { pageId: '/long/' });
    expect(one.ok).toBe(true);
    expect(one.content.scope).toEqual({ idOmitted: true });
    expect(one.content.links).toMatchObject({ idOmitted: true, incoming: 0, orphan: true, from: [] });
    expect(one.content.links.pageId).toBeUndefined();
    expect(one.content.total).toBeGreaterThan(0);
  });

  it('is offered to every run that may read the whole site, for every model, and changes nothing', () => {
    const state = createStarterState('business', 'Audit', false);
    const names = (r: ReturnType<typeof toolsForRun>) => r.tools.map((t) => t.name);
    const home = state.pages[state.site.homePageId];
    const selection = selectionTarget({ owner: { kind: 'page', id: home.id }, instancePath: [], nodeId: home.rootIds[0] });
    const def = state.components[(home.nodes[home.rootIds[0]] as InstanceNode).definitionId];
    for (const capabilities of [
      { toolCalling: 'native' as const, contextWindowTokens: 200000 },
      { toolCalling: 'native' as const, contextWindowTokens: 32000 },
      { toolCalling: 'constrained-json' as const, contextWindowTokens: 32000 }
    ]) {
      const base = { state, selection: null, capabilities, codeEnabled: false, definitionOps: true };
      const label = `${capabilities.toolCalling} ${capabilities.contextWindowTokens}`;
      expect(names(toolsForRun({ ...base, ask: true })), label).toContain('audit_seo');
      expect(names(toolsForRun({ ...base, ask: true, selection })), label).toContain('audit_seo');
      expect(names(toolsForRun(base)), label).toContain('audit_seo');
      expect(names(toolsForRun({ ...base, page: { route: '/' } })), label).toContain('audit_seo');
      expect(names(toolsForRun({ ...base, definition: true })), label).toContain('audit_seo');
      expect(names(toolsForRun({ ...base, codeEnabled: true, ask: true })), label).toContain('audit_seo');
      // A small model's own sets stay small: one element, one design, one new component.
      if (capabilities.contextWindowTokens < 64000) {
        expect(names(toolsForRun({ ...base, selection })), label).not.toContain('audit_seo');
        expect(names(toolsForRun({ ...base, definitionTarget: { definitionId: def.id } })), label).not.toContain('audit_seo');
        expect(names(toolsForRun({ ...base, task: 'component' })), label).not.toContain('audit_seo');
      }
      for (const run of [toolsForRun({ ...base, ask: true }), toolsForRun(base), toolsForRun({ ...base, page: { route: '/' } })]) {
        const tool = run.tools.find((t) => t.name === 'audit_seo')!;
        expect(findForbiddenShapes(toStrictSchema(tool.parameters)), label).toEqual([]);
        expect(tool.parameters).toMatchObject({ type: 'object', properties: { pillar: { enum: ['technical', 'entity', 'agentic', 'content', 'social'] } } });
        // What a constrained model's grammar is built from keeps every argument and pillar.
        const strict = toStrictSchema(tool.parameters) as { properties: Record<string, { enum?: string[] }> };
        expect(Object.keys(strict.properties).sort(), label).toEqual(['linkOffset', 'offset', 'pageId', 'pillar']);
        expect(JSON.stringify(strict.properties.pillar), label).toMatch(/"technical","entity","agentic","content","social"/);
      }
    }
    expect(MUTATING_TOOLS.has('audit_seo')).toBe(false);
    expect(REVISION_BOUND_TOOLS.has('audit_seo')).toBe(false);
  });
});

describe('projectSummary search settings', () => {
  it('says whether the site has its sharing image and icon, and which of its own settings each page has', () => {
    const { state, home, services } = seoSite();
    const s = run(
      state,
      { type: 'page.create', pageId: 'pg_plain', title: 'Plain', route: '/plain/' },
      { type: 'page.create', pageId: 'pg_hidden', title: 'Hidden', route: '/hidden/' },
      { type: 'page.update', pageId: services, noindex: true },
      { type: 'page.update', pageId: 'pg_hidden', searchHidden: true }
    );
    const summary = projectSummary(s, 3);
    expect(summary.site.seo).toEqual({ socialImageSet: true, faviconSet: true });
    const page = (id: string) => summary.pages.find((p) => p.id === id) as Record<string, unknown>;
    expect(page(home).seo).toEqual({ titleSet: true, descriptionSet: true });
    expect(page(services).seo).toEqual({ titleSet: true, descriptionSet: true, noindex: true });
    expect(page('pg_hidden').seo).toEqual({ searchHidden: true });
    // A page with none of its own settings says nothing.
    expect('seo' in page('pg_plain')).toBe(false);
  });

  it('counts only what is really there, and reads a search setting as the website does', () => {
    const { state, home } = seoSite();
    const s = copy(state);
    // Blank text and a value that is not text are no title or description; any value kept from search keeps it out.
    s.pages[home].seo = { title: '   ', description: 42 as never, noindex: 'yes' as never, searchHidden: 1 as never };
    s.site.favicon = 'img_gone';
    s.site.socialImage = 'font_x';
    s.assets.assets.font_x = { ...s.assets.assets.img_icon, id: 'font_x', kind: 'font' } as never;
    s.site.redirects = [
      { from: '/old/', to: { kind: 'page', pageId: home } },
      { from: '/older/', to: { kind: 'page', pageId: home } }
    ] as never;
    const summary = projectSummary(s, 3);
    expect(summary.site.seo).toEqual({ socialImageSet: false, faviconSet: false, redirectCount: 2 });
    expect((summary.pages.find((p) => p.id === home) as Record<string, unknown>).seo).toEqual({ noindex: true, searchHidden: true });
    expect(runSeoAudit(s).map((f) => f.code)).toContain('SEO_HOME_NOINDEX');
    s.site.redirects = 'two' as never;
    expect(projectSummary(s, 3).site.seo).toEqual({ socialImageSet: false, faviconSet: false });
    (s.pages[home] as { seo?: unknown }).seo = undefined;
    expect('seo' in (projectSummary(s, 3).pages.find((p) => p.id === home) as object)).toBe(false);
  });

  it('stays the same size however long a page’s own title and description are', () => {
    const { state, home } = seoSite();
    const short = JSON.stringify(projectSummary(state, 3)).length;
    const long = run(state, { type: 'page.update', pageId: home, seoTitle: 'T'.repeat(2000), description: 'D'.repeat(5000) });
    expect(JSON.stringify(projectSummary(long, 3)).length).toBe(short);
  });
});
