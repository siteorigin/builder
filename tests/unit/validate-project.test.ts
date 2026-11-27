import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent } from '@catalogue/index';
import { executeTool, toolDefinitions, toolsForRun, type ToolHost } from '@agent/tools';
import { validateState, type Diagnostic } from '@engine/validate';
import { makeInstance } from '@engine/install';
import { compileProject } from '../../src/main/compile';
import { projectDesign } from './fixtures/packs';
import { HERO } from './fixtures/appear-designs';

type Shown = { code: string; message: string; owner?: { kind: string; id: string }; nodeId?: string };
type Result = {
  ok: boolean;
  /** A failure, as every tool gives one; a failed preview check keeps what it found in details. */
  error?: { code: string; message: string; recoverable: boolean; details?: Omit<Result, 'ok' | 'revision' | 'error'> };
  revision: number;
  profile: string;
  narrowedTo?: { pageIds?: string[]; nodeIds?: string[]; componentIds?: string[] };
  outsideNarrowing?: { errors: number; warnings: number; note: string };
  errors: Shown[];
  warnings: Shown[];
  omittedWarnings?: number;
  omittedErrors?: number;
  componentWarnings?: Array<{ definitionId: string; nodeId?: string }>;
  omittedComponentWarnings?: number;
  routes?: Array<{ route: string; kind: string; pageId?: string; draft?: boolean }>;
  omittedRoutes?: number;
  routesOutsideNarrowing?: number;
  preview?: { viewport: string; width: number; pages: Array<Record<string, unknown> & { pageId: string; ok: boolean }>; unmeasuredPages?: number };
  nextOffset?: Array<{ list: string; offset: number }>;
  more?: string;
};

const warn = (code: string, message: string, owner?: { kind: string; id: string }, nodeId?: string): Diagnostic => ({ severity: 'warning', code, message, ...(owner ? { owner } : {}), ...(nodeId ? { nodeId } : {}) });

/** A project with a page per route, and a host over it whose diagnostics, compile results and preview are given. */
function fixture(opts: { pages?: string[]; diagnostics?: Diagnostic[]; compiled?: Diagnostic[]; files?: Diagnostic[]; inspect?: (pageId: string, width: number) => Promise<unknown>; changed?: string[]; prepare?: (s: ProjectState) => void } = {}) {
  const s = createStarterState('business', 'Test Studio', false);
  for (const route of opts.pages ?? []) {
    const id = `pg_${route.replace(/\W+/g, '')}`;
    const home = s.pages[s.site.homePageId];
    s.pages[id] = { ...structuredClone(home), id, route: `/${route}/`, title: route };
    s.site.pageOrder.push(id);
  }
  opts.prepare?.(s);
  let revision = 7;
  const calls = { compile: 0, inspected: [] as Array<[string, number]>, focus: [] as Array<string[] | undefined> };
  const host = {
    state: () => s,
    revision: () => revision,
    diagnostics: () => opts.diagnostics ?? [],
    compileAll: async () => {
      calls.compile++;
      return opts.compiled ?? [];
    },
    inspectLayout: async (pageId: string, width: number, asked?: { focus?: string[] }) => {
      calls.inspected.push([pageId, width]);
      calls.focus.push(asked?.focus);
      return opts.inspect ? opts.inspect(pageId, width) : { previewRevision: revision, issues: [], runtimeErrors: [] };
    },
    changedPageIds: () => opts.changed ?? [],
    fileDiagnostics: async () => opts.files ?? [],
    ask: async () => ''
  } as unknown as ToolHost;
  const validate = async (args: Record<string, unknown> = {}) => {
    const out = await executeTool('validate_project', JSON.stringify(args), host, 'v');
    return { ok: out.ok, content: out.content as Result };
  };
  return { s, host, calls, validate, bump: () => revision++ };
}

const pid = (route: string) => `pg_${route.replace(/\W+/g, '')}`;
// The starter has its own Contact, About and other pages: the fixture's are told apart by these routes.

describe('validate_project schema profile (#756)', () => {
  it('reads the session diagnostics without compiling, each with where it is', async () => {
    const { validate, calls } = fixture({ pages: ['vcontact'], diagnostics: [warn('IMG_ALT', 'Missing alt.', { kind: 'page', id: pid('vcontact') }, 'n1'), { severity: 'error', code: 'X', message: 'Broken.' }, { severity: 'info', code: 'I', message: 'Fyi.' }] });
    const { ok, content } = await validate();
    expect(ok).toBe(true);
    expect(calls.compile).toBe(0);
    expect(content.profile).toBe('schema');
    expect(content.errors).toEqual([{ code: 'X', message: 'Broken.' }]);
    expect(content.warnings).toEqual([{ code: 'IMG_ALT', message: 'Missing alt.', owner: { kind: 'page', id: pid('vcontact') }, nodeId: 'n1' }]);
    expect(content.outsideNarrowing).toBeUndefined();
    expect(content.more).toBeUndefined();
  });

  it('refuses arguments it does not know, rather than validating the whole project silently', async () => {
    const { validate } = fixture();
    const { ok, content } = await validate({ pages: ['/vcontact/'] });
    expect(ok).toBe(false);
    expect(content.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('says how many warnings a long list leaves out, and how to see them', async () => {
    const diags = Array.from({ length: 35 }, (_, i) => warn('IMG_ALT', `Blog image ${i} has no alt text.`, { kind: 'page', id: pid('blog') }, `n${i}`));
    const { validate } = fixture({ pages: ['blog'], diagnostics: diags });
    const first = (await validate()).content;
    expect(first.warnings).toHaveLength(20);
    expect(first.omittedWarnings).toBe(15);
    expect(first.nextOffset).toEqual([{ list: 'warnings', offset: 20 }]);
    expect(first.more).toMatch(/15 warnings not listed \(these are 1–20 of 35\): call again with list "warnings" and offset 20, or narrow with pageIds, nodeIds or componentIds/);
    const rest = (await validate({ offset: 20 })).content;
    expect(rest.warnings.map((w) => w.nodeId)).toEqual(Array.from({ length: 15 }, (_, i) => `n${i + 20}`));
    expect(rest.omittedWarnings).toBe(20);
    expect(rest.nextOffset).toBeUndefined();
    expect(rest.more).toMatch(/these are 21–35 of 35/);
  });
});

describe('validate_project narrowing by affected IDs (#756)', () => {
  // The issue's example: 35 warnings on the blog, then one on the Contact page the model just changed.
  const blog = Array.from({ length: 35 }, (_, i) => warn('IMG_ALT', `Blog image ${i} has no alt text.`, { kind: 'page', id: pid('blog') }, `b${i}`));

  it('reports a page’s own problems, and counts the rest outside the narrowing', async () => {
    const contact = warn('IMG_ALT', 'Contact image has no alt text.', { kind: 'page', id: pid('vcontact') }, 'c1');
    const { validate } = fixture({ pages: ['blog', 'vcontact'], diagnostics: [...blog, contact, { severity: 'error', code: 'E', message: 'Elsewhere.', owner: { kind: 'shell', id: 'header' } }] });
    const { ok, content } = await validate({ pageIds: ['/vcontact/'] });
    expect(ok).toBe(true);
    expect(content.narrowedTo).toEqual({ pageIds: [pid('vcontact')] });
    expect(content.warnings).toEqual([expect.objectContaining({ message: 'Contact image has no alt text.' })]);
    expect(content.errors).toEqual([]);
    expect(content.outsideNarrowing).toMatchObject({ errors: 1, warnings: 35 });
    expect(content.outsideNarrowing!.note).toMatch(/not clean/);
  });

  it('places an ownerless problem on the page whose tree holds its element', async () => {
    const diags = [warn('W', 'On contact.', undefined, 'only_here'), warn('W', 'On Other.', undefined, 'other_here'), warn('W', 'On both.', undefined, 'both'), warn('W', 'Nowhere.', undefined, 'not_a_node')];
    const { validate } = fixture({
      pages: ['vcontact', 'vother'],
      diagnostics: diags,
      prepare: (st) => {
        st.pages[pid('vcontact')].nodes.only_here = { id: 'only_here', kind: 'text', tag: 'p', text: 'x' } as never;
        st.pages[pid('vother')].nodes.other_here = { id: 'other_here', kind: 'text', tag: 'p', text: 'x' } as never;
        for (const id of [pid('vcontact'), pid('vother')]) st.pages[id].nodes.both = { id: 'both', kind: 'text', tag: 'p', text: 'x' } as never;
      }
    });
    const { content } = await validate({ pageIds: [pid('vcontact')] });
    // Another page's element, and one two pages have, is not this page's to claim.
    expect(content.warnings.map((w) => w.message)).toEqual(['On contact.']);
    expect(content.outsideNarrowing).toMatchObject({ errors: 0, warnings: 3 });
  });

  it('narrows to an element and what is inside it, in its own tree', async () => {
    const prepare = (st: ProjectState) => {
      for (const id of [pid('vcontact'), st.site.homePageId]) {
        st.pages[id].nodes.sec = { id: 'sec', kind: 'element', tag: 'section', children: ['kid'] } as never;
        st.pages[id].nodes.kid = { id: 'kid', kind: 'text', tag: 'p', text: 'x' } as never;
      }
      st.pages[pid('vcontact')].nodes.sibling = { id: 'sibling', kind: 'text', tag: 'p', text: 'y' } as never;
    };
    const diags = [
      warn('W', 'On the section.', { kind: 'page', id: pid('vcontact') }, 'sec'),
      warn('W', 'Inside it.', { kind: 'page', id: pid('vcontact') }, 'kid'),
      warn('W', 'Beside it.', { kind: 'page', id: pid('vcontact') }, 'sibling'),
      warn('W', 'Page-wide.', { kind: 'page', id: pid('vcontact') })
    ];
    const { validate } = fixture({ pages: ['vcontact'], diagnostics: diags, prepare });
    // Narrowed to an element: its own finding, never another element's or a page-wide one.
    const { content } = await validate({ nodeIds: ['sibling'] });
    expect(content.warnings.map((w) => w.message)).toEqual(['Beside it.']);
    const inSection = (await validate({ nodeIds: ['sec'] })).content;
    expect(inSection.narrowedTo).toEqual({ nodeIds: ['sec'] });
    expect(inSection.warnings.map((w) => w.message).sort()).toEqual(['Inside it.', 'On the section.']);
    expect(inSection.outsideNarrowing!.warnings).toBe(2);
    // The same element ID on Home is a different element: a finding there is Home's only.
    const onHome = fixture({ pages: ['vcontact'], diagnostics: [], prepare });
    (onHome.host as unknown as { diagnostics: () => Diagnostic[] }).diagnostics = () => [warn('W', 'On Home.', { kind: 'page', id: onHome.s.site.homePageId }, 'kid')];
    const both = (await onHome.validate({ nodeIds: ['kid'] })).content;
    expect(both.warnings.map((w) => w.message)).toEqual(['On Home.']);
    // A finding owned by a tree without the named element is outside, whatever its element is called.
    (onHome.host as unknown as { diagnostics: () => Diagnostic[] }).diagnostics = () => [warn('W', 'On the header.', { kind: 'shell', id: 'header' }, 'kid')];
    expect((await onHome.validate({ nodeIds: ['kid'] })).content.warnings).toEqual([]);
    const contactOnly = (await onHome.validate({ pageIds: [pid('vcontact')] })).content;
    expect(contactOnly.warnings).toEqual([]);
  });

  it('narrows to a component: its own problems and only its compile results', async () => {
    const prepare = (st: ProjectState) => {
      const hero = structuredClone(catalogueComponent('foundation', 'hero.centered')!);
      st.components['proj.a'] = { ...hero, id: 'proj.a', name: 'A', owner: 'project' };
      st.components['proj.b'] = { ...structuredClone(hero), id: 'proj.b', name: 'B', owner: 'project' };
    };
    const compiled: Diagnostic[] = [
      { severity: 'error', code: 'COMPILE', message: 'A: bad.', owner: { kind: 'component', id: 'proj.a' } },
      { severity: 'error', code: 'COMPILE', message: 'B: bad.', owner: { kind: 'component', id: 'proj.b' } },
      { severity: 'error', code: 'COMPILE', message: 'src/routes/+layout.svelte: bad.' }
    ];
    const { s, validate } = fixture({ prepare, compiled, diagnostics: [warn('W', 'A warns.', { kind: 'component', id: 'proj.a' }), warn('W', 'B warns.', { kind: 'page', id: 'proj.a' })] });
    const { content } = await validate({ profile: 'component', componentIds: ['proj.a'] });
    expect(content.errors.map((e) => e.message)).toEqual(['A: bad.']);
    // A page that happens to share the component's ID is not the component.
    expect(content.warnings.map((e) => e.message)).toEqual(['A warns.']);
    expect(content.outsideNarrowing).toMatchObject({ errors: 2, warnings: 1 });
    // Narrowed to a page, compile results stay out: they are only for the components named.
    const home = s.site.homePageId;
    const paged = fixture({ prepare, compiled: [{ severity: 'error', code: 'COMPILE', message: 'Home: bad.', owner: { kind: 'page', id: home } }] });
    (paged.host as unknown as { state: () => ProjectState }).state = () => s;
    const onPage = (await paged.validate({ profile: 'component', pageIds: [home] })).content;
    expect(onPage.errors).toEqual([]);
    expect(onPage.outsideNarrowing).toMatchObject({ errors: 1 });
  });

  it('refuses an ID that names nothing, before compiling or measuring', async () => {
    const { validate, calls } = fixture();
    for (const profile of ['project', 'preview'])
      for (const args of [{ pageIds: ['/nowhere/'] }, { nodeIds: ['no_such_node'] }, { componentIds: ['no.such'] }]) {
        const { ok, content } = await validate({ profile, ...args });
        expect(ok).toBe(false);
        expect(content.error?.code).toBe('INVALID_ARGUMENT');
      }
    expect(calls.compile).toBe(0);
    expect(calls.inspected).toEqual([]);
  });

  it('pages through the component warnings with their own list, so a ninth is reachable', async () => {
    const s = createStarterState('business', 'Test Studio', false);
    // A hero of the project's own design, with ten headings fixed in it rather than bound to its properties.
    const def = projectDesign(s, HERO);
    const root = def.tree!.rootIds[0];
    for (let i = 0; i < 10; i++) {
      def.tree!.nodes[`fixed${i}`] = { id: `fixed${i}`, kind: 'text', tag: 'h2', text: `Spring offers ${i}` };
      (def.tree!.nodes[root] as { children: string[] }).children.push(`fixed${i}`);
    }
    s.components[def.id] = def;
    const diags = validateState(s).filter((d) => d.code === 'COMPONENT_UNBOUND_CONTENT');
    expect(diags.length).toBeGreaterThan(8);
    const { validate } = fixture({ diagnostics: diags, prepare: (st) => void (st.components[def.id] = def) });
    const first = (await validate()).content;
    expect(first.componentWarnings).toHaveLength(8);
    expect(first.omittedComponentWarnings).toBe(diags.length - 8);
    expect(first.nextOffset).toEqual([{ list: 'componentWarnings', offset: 8 }]);
    const rest = (await validate({ list: 'componentWarnings', offset: 8 })).content;
    expect(rest.componentWarnings).toHaveLength(diags.length - 8);
    const firstNodes = new Set(first.componentWarnings!.map((w) => `${w.definitionId}|${w.nodeId}`));
    expect(rest.componentWarnings!.some((w) => firstNodes.has(`${w.definitionId}|${w.nodeId}`))).toBe(false);
  });
});

describe('validate_project component and project profiles (#756)', () => {
  it('component compiles', async () => {
    const { validate, calls } = fixture({ compiled: [{ severity: 'error', code: 'COMPILE', message: 'Broken.' }], diagnostics: [{ severity: 'error', code: 'SCHEMA', message: 'Bad reference.' }] });
    const { content } = await validate({ profile: 'component' });
    expect(calls.compile).toBe(1);
    expect(content.errors.map((e) => e.code)).toEqual(['SCHEMA', 'COMPILE']);
    expect(content.routes).toBeUndefined();
  });

  it('project adds missing files, dangling image references and the route inventory', async () => {
    const { validate, calls, s } = fixture({
      pages: ['vcontact', 'draft'],
      compiled: [{ severity: 'error', code: 'COMPILE', message: 'Broken.' }],
      files: [{ severity: 'warning', code: 'ASSET_FILE_MISSING', message: 'Photo is missing its original file.', owner: { kind: 'asset', id: 'a1' } }],
      prepare: (st) => {
        st.pages[pid('draft')].draft = true;
        st.pages[pid('vcontact')].seo = { ...(st.pages[pid('vcontact')].seo ?? {}), socialImage: 'gone' } as never;
        st.site.redirects = [{ from: '/old-vcontact/', pageId: pid('vcontact') }, { from: '/older-vcontact/', to: '/vcontact/' }] as never;
        st.site.favicon = 'no-such-icon';
      }
    });
    const { content } = await validate({ profile: 'project' });
    expect(calls.compile).toBe(1);
    expect(content.errors.map((e) => e.code).sort()).toEqual(['ASSET_MISSING', 'ASSET_MISSING', 'COMPILE']);
    expect(content.errors.some((e) => e.message.startsWith('The site icon'))).toBe(true);
    expect(content.errors.find((e) => e.code === 'ASSET_MISSING' && e.message.includes('sharing image'))).toMatchObject({ owner: { kind: 'page', id: pid('vcontact') } });
    expect(content.warnings.map((e) => e.code)).toContain('ASSET_FILE_MISSING');
    expect(content.routes).toEqual(
      expect.arrayContaining([
        { route: '/', kind: 'page', pageId: s.site.homePageId },
        { route: '/vcontact/', kind: 'page', pageId: pid('vcontact') },
        { route: '/draft/', kind: 'page', pageId: pid('draft'), draft: true },
        { route: '/old-vcontact/', kind: 'redirect', pageId: pid('vcontact') },
        { route: '/older-vcontact/', kind: 'redirect', to: '/vcontact/', pageId: pid('vcontact') }
      ])
    );
    expect(content.omittedRoutes).toBeUndefined();
    // Narrowed to a page, the inventory keeps that page's addresses and counts the rest.
    const narrowed = (await validate({ profile: 'project', pageIds: ['/vcontact/'] })).content;
    expect(narrowed.routes!.map((r) => r.route).sort()).toEqual(['/old-vcontact/', '/older-vcontact/', '/vcontact/']);
    expect(narrowed.routesOutsideNarrowing).toBe(content.routes!.length - 3);
    expect(narrowed.errors.map((e) => e.code)).toEqual(['ASSET_MISSING']);
    expect(narrowed.outsideNarrowing).toMatchObject({ errors: 2 });
  });

  it('caps a long route inventory and says how to see the rest', async () => {
    const routes = Array.from({ length: 60 }, (_, i) => `p${i}`);
    const { validate } = fixture({ pages: routes });
    const { content } = await validate({ profile: 'project' });
    expect(content.routes).toHaveLength(50);
    expect(content.omittedRoutes).toBeGreaterThan(10);
    expect(content.nextOffset).toEqual([{ list: 'routes', offset: 50 }]);
    expect(content.more).toMatch(/call again with list "routes" and offset 50, or narrow with pageIds/);
    const rest = (await validate({ profile: 'project', list: 'routes', offset: 50 })).content;
    expect(rest.routes!.length).toBe(content.omittedRoutes);
    const seen = new Set(content.routes!.map((r) => r.route));
    expect(rest.routes!.some((r) => seen.has(r.route))).toBe(false);
    expect(rest.routes!.map((r) => r.route)).toContain('/p59/');
    // The routes list belongs to the project profile alone.
    expect((await validate({ list: 'routes', offset: 50 })).ok).toBe(false);
  });

  it('attributes compile errors to the page or component whose file failed', async () => {
    const s = createStarterState('business', 'Test Studio', false);
    s.components['proj.broken'] = { id: 'proj.broken', name: 'Broken', kind: 'code', owner: 'project', sourcePath: 'src/lib/siteorigin/custom/Broken.svelte', source: '<div>{#if}</div>', properties: {}, defaults: {} } as never;
    s.components['proj.brokenx'] = { id: 'proj.brokenx', name: 'Broken X', kind: 'code', owner: 'project', sourcePath: 'src/lib/siteorigin/custom/BrokenX.svelte', source: '<p>fine</p>', properties: {}, defaults: {} } as never;
    const diags = await compileProject(s);
    const mine = diags.filter((d) => d.message.startsWith('Broken'));
    expect(mine).toHaveLength(1);
    expect(mine[0].owner).toEqual({ kind: 'component', id: 'proj.broken' });
  });
});

describe('validate_project preview profile (#756)', () => {
  const overflow = { kind: 'element-overflow', message: 'Extends beyond the viewport.', ref: { owner: { kind: 'page', id: 'pg_vcontact' }, nodeId: 'n2' } };
  const alt = { kind: 'missing-alt', message: 'No alt.' };

  it('measures the pages the run changed at phone width, with revision, runtime errors and geometry', async () => {
    const { validate, calls } = fixture({
      pages: ['vcontact', 'about'],
      changed: ['pg_vcontact'],
      inspect: async () => ({ previewRevision: 7, documentWidth: 390, issues: [overflow, alt], runtimeErrors: ['TypeError: x is undefined'], checks: { overlaps: { checked: 3, failed: 0, unverified: 0 }, clippedText: { checked: 1, failed: 0, unverified: 0 }, tapTargets: { checked: 2, failed: 0, unverified: 0 }, contrast: { checked: 9, failed: 0, unverified: 0 } } })
    });
    const { ok, content } = await validate({ profile: 'preview' });
    expect(ok).toBe(true);
    expect(calls.inspected).toEqual([['pg_vcontact', 390]]);
    expect(content.preview).toMatchObject({ viewport: 'phone', width: 390 });
    const page = content.preview!.pages[0];
    expect(page).toMatchObject({ pageId: 'pg_vcontact', ok: true, previewRevision: 7, runtimeErrors: ['TypeError: x is undefined'] });
    // Geometry only: the missing alt text is the schema's and inspect_layout's.
    expect(page.issues).toEqual([{ kind: 'element-overflow', message: 'Extends beyond the viewport.', ref: overflow.ref }]);
    expect(Object.keys(page.checks as object)).toEqual(['overlaps', 'clippedText', 'tapTargets']);
    // The diagnostics are the measured pages', with the rest counted.
    expect(content.narrowedTo).toEqual({ pageIds: ['pg_vcontact'] });
    expect(content.outsideNarrowing).toBeDefined();
  });

  it('is a failed check, never a clean one, when the preview is not running', async () => {
    const { validate } = fixture({ pages: ['vcontact', 'vabout'], inspect: async (pageId) => (pageId === 'pg_vcontact' ? { error: 'The preview is not running.' } : { previewRevision: 7, issues: [] }) });
    const { ok, content } = await validate({ profile: 'preview', pageIds: ['/vcontact/', '/vabout/'] });
    expect(ok).toBe(false);
    expect(content.error?.code).toBe('VALIDATION_FAILED');
    expect(content.error!.details!.preview!.pages).toEqual([{ pageId: 'pg_vcontact', ok: false, error: 'The preview could not be measured: The preview is not running.' }, expect.objectContaining({ pageId: 'pg_vabout', ok: true })]);
  });

  it('fails when the preview shows another revision, says none, or the project changes while it measures', async () => {
    const stale = fixture({ pages: ['vcontact'], inspect: async () => ({ previewRevision: 6, issues: [] }) });
    const r1 = await stale.validate({ profile: 'preview', pageIds: ['pg_vcontact'] });
    expect(r1.ok).toBe(false);
    expect(r1.content.error!.details!.preview!.pages[0].error).toMatch(/serves revision 6, not the current 7/);
    const ahead = fixture({ pages: ['vcontact'], inspect: async () => ({ previewRevision: 8, issues: [] }) });
    expect((await ahead.validate({ profile: 'preview', pageIds: ['pg_vcontact'] })).content.error!.details!.preview!.pages[0].error).toMatch(/serves revision 8, not the current 7/);

    const silent = fixture({ pages: ['vcontact'], inspect: async () => ({ issues: [] }) });
    const r2 = await silent.validate({ profile: 'preview', pageIds: ['pg_vcontact'] });
    expect(r2.ok).toBe(false);
    expect(r2.content.error!.details!.preview!.pages[0].error).toMatch(/did not say which revision it serves/);

    const moving = fixture({ pages: ['vcontact'] });
    const host = moving.host as unknown as { inspectLayout: (p: string, w: number) => Promise<unknown> };
    host.inspectLayout = async () => {
      moving.bump();
      return { previewRevision: 7, issues: [] };
    };
    const r3 = await moving.validate({ profile: 'preview', pageIds: ['pg_vcontact'] });
    expect(r3.ok).toBe(false);
    expect(r3.content.error!.details!.preview!.pages[0].error).toMatch(/changed while the page was measured/);

    const thrown = fixture({ pages: ['vcontact'], inspect: async () => Promise.reject(new Error('The preview did not respond in time.')) });
    const r4 = await thrown.validate({ profile: 'preview', pageIds: ['pg_vcontact'] });
    expect(r4.ok).toBe(false);
    expect(r4.content.error!.details!.preview!.pages[0].error).toBe('The preview could not be measured: The preview did not respond in time.');
  });

  it('asks for pages when the run changed none and none are named', async () => {
    const { validate, calls } = fixture({ changed: [] });
    const { ok, content } = await validate({ profile: 'preview' });
    expect(ok).toBe(false);
    expect(content.error?.code).toBe('INVALID_ARGUMENT');
    expect(content.error?.message).toMatch(/pageIds/);
    expect(calls.inspected).toEqual([]);
    // Named pages win over the pages the run changed.
    const named = fixture({ pages: ['vcontact', 'vabout'], changed: ['pg_vabout'] });
    await named.validate({ profile: 'preview', pageIds: ['/vcontact/'] });
    expect(named.calls.inspected).toEqual([['pg_vcontact', 390]]);
  });

  it('measures at most three pages a call, and continues with the same selection', async () => {
    const order = ['pg_a', 'pg_b', 'pg_c', 'pg_d', 'pg_e', 'pg_f', 'pg_g'];
    const { validate, calls } = fixture({ pages: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], changed: [...order, 'pg_gone'] });
    const first = (await validate({ profile: 'preview' })).content;
    expect(calls.inspected.map(([p]) => p)).toEqual(order.slice(0, 3));
    expect(first.preview!.unmeasuredPages).toBe(4);
    expect(first.nextOffset).toEqual([{ list: 'pages', offset: 3 }]);
    expect(first.more).toMatch(/4 pages not listed \(these are 1–3 of 7\): call again with list "pages" and offset 3/);
    const second = (await validate({ profile: 'preview', list: 'pages', offset: 3 })).content;
    expect(calls.inspected.map(([p]) => p).slice(3)).toEqual(order.slice(3, 6));
    expect(second.nextOffset).toEqual([{ list: 'pages', offset: 6 }]);
    const last = (await validate({ profile: 'preview', list: 'pages', offset: 6 })).content;
    expect(calls.inspected.map(([p]) => p).slice(6)).toEqual(['pg_g']);
    expect(last.nextOffset).toBeUndefined();
    // Past the last page, nothing is measured and nothing reads as clean.
    const past = await validate({ profile: 'preview', list: 'pages', offset: 7 });
    expect(past.ok).toBe(false);
    expect(past.content.error?.code).toBe('INVALID_ARGUMENT');
    expect(calls.inspected).toHaveLength(7);
  });

  it('stops measuring when the run is stopped, without waiting for a page being measured', async () => {
    const { validate, host, calls } = fixture({ pages: ['a', 'b'], changed: ['pg_a', 'pg_b'] });
    const stop = new AbortController();
    (host as unknown as { signal: AbortSignal }).signal = stop.signal;
    (host as unknown as { inspectLayout: (p: string, w: number) => Promise<unknown> }).inspectLayout = (p: string) => {
      calls.inspected.push([p, 390]);
      setTimeout(() => stop.abort(), 5);
      // An unresponsive preview: it never answers.
      return new Promise(() => undefined);
    };
    const { ok, content } = await validate({ profile: 'preview' });
    expect(ok).toBe(false);
    expect(content.error?.code).toBe('CANCELLED');
    expect(calls.inspected).toHaveLength(1);
  });

  it('is cancelled when stopped during the last page, even once it was measured', async () => {
    const { validate, host } = fixture({ pages: ['a'], changed: ['pg_a'] });
    const stop = new AbortController();
    (host as unknown as { signal: AbortSignal }).signal = stop.signal;
    (host as unknown as { inspectLayout: () => Promise<unknown> }).inspectLayout = async () => {
      stop.abort();
      return { previewRevision: 7, issues: [] };
    };
    expect((await validate({ profile: 'preview' })).content.error?.code).toBe('CANCELLED');
  });

  it('keeps only the named element’s findings, asks the preview for them before it caps its list, and says what it left out', async () => {
    const other = { kind: 'text-overflow', message: 'Text is wider than its box.', ref: { owner: { kind: 'page', id: 'pg_vcontact' }, nodeId: 'n9' } };
    // An overlap whose second box is the named element.
    const overlap = { kind: 'overlap', message: 'Overlaps.', ref: { owner: { kind: 'page', id: 'pg_vcontact' }, nodeId: 'n9' }, with: { ref: { owner: { kind: 'page', id: 'pg_vcontact' }, nodeId: 'n2' } } };
    const { validate, calls } = fixture({
      pages: ['vcontact'],
      prepare: (st) => {
        st.pages.pg_vcontact.nodes.n2 = { id: 'n2', kind: 'element', tag: 'div', children: ['n3'] } as never;
        st.pages.pg_vcontact.nodes.n3 = { id: 'n3', kind: 'text', tag: 'p', text: 'x' } as never;
        st.pages.pg_vcontact.nodes.n9 = { id: 'n9', kind: 'text', tag: 'p', text: 'y' } as never;
      },
      inspect: async () => ({ previewRevision: 7, issues: [overflow, other, overlap], issueCount: 45, runtimeErrors: [] })
    });
    const { content } = await validate({ profile: 'preview', nodeIds: ['n2'] });
    // The preview is told which elements to keep findings on: the element and what is inside it.
    expect(calls.focus[0]!.sort()).toEqual(['n2', 'n3']);
    const page = content.preview!.pages[0];
    expect(page.pageId).toBe('pg_vcontact');
    expect(page.issues).toEqual([expect.objectContaining({ kind: 'element-overflow' }), expect.objectContaining({ kind: 'overlap' })]);
    expect(page.issuesOutsideNarrowing).toBe(1);
    expect(page.unlistedFindings).toBe(42);
    expect(page.more).toMatch(/found 45 findings on the named elements and components and lists 3; 42 were left out/);
    expect(content.more).toMatch(/A measured page left findings out/);
  });

  it('keeps the findings on a named component’s placements, and measures the pages that show it', async () => {
    const f = fixture({ pages: ['vcontact'] });
    const placement = Object.values(f.s.pages.pg_vcontact.nodes).find((x) => x.kind === 'instance') as { id: string; definitionId: string };
    const onPlacement = { kind: 'element-overflow', message: 'Too wide.', ref: { owner: { kind: 'page', id: 'pg_vcontact' }, nodeId: placement.id, partId: 'root' } };
    const elsewhere = { kind: 'element-overflow', message: 'Elsewhere.', ref: { owner: { kind: 'shell', id: 'header' }, nodeId: 'x' } };
    (f.host as unknown as { inspectLayout: (p: string, w: number, opts?: { focus?: string[] }) => Promise<unknown> }).inspectLayout = async (p, w, opts) => {
      f.calls.inspected.push([p, w]);
      f.calls.focus.push(opts?.focus);
      return { previewRevision: 7, issues: [onPlacement, elsewhere] };
    };
    const { content } = await f.validate({ profile: 'preview', componentIds: [placement.definitionId] });
    expect(f.calls.inspected.map(([p]) => p)).toContain('pg_vcontact');
    const measured = content.preview!.pages.find((p) => p.pageId === 'pg_vcontact')!;
    expect(measured.issues).toEqual([expect.objectContaining({ message: 'Too wide.' })]);
    expect(f.calls.focus[0]).toContain(placement.id);
    // Its design's own node IDs are left to the placement: other designs use the same ones.
    const design = Object.keys(f.s.components[placement.definitionId].tree?.nodes ?? {});
    expect(f.calls.focus[0]!.some((id) => design.includes(id) && id !== placement.id)).toBe(false);
  });

  it('measures an element of a component’s design on the pages that show it, and a header element on a page with the header', async () => {
    // A component of its own, placed on this page alone.
    const f = fixture({
      pages: ['vcontact'],
      prepare: (st) => {
        const inst = Object.values(st.pages.pg_vcontact.nodes).find((x) => x.kind === 'instance') as { definitionId: string };
        // Its design's root has an ID of its own, which no other design names.
        const own = projectDesign(st, { componentId: 'project.only', name: 'Only here', properties: {}, parts: {}, build: (b) => b.el('only_root', 'section', { name: 'Section' }, [b.text('only_text', 'p', 'Only here')]) });
        inst.definitionId = own.id;
      }
    });
    const placement = Object.values(f.s.pages.pg_vcontact.nodes).find((x) => x.kind === 'instance') as { id: string; definitionId: string };
    const def = f.s.components[placement.definitionId];
    const designNode = def.tree!.rootIds[0];
    expect(def.id).toBe('foundation.project.only');
    (f.host as unknown as { inspectLayout: (p: string, w: number, opts?: { focus?: string[] }) => Promise<unknown> }).inspectLayout = async (p, w, opts) => {
      f.calls.inspected.push([p, w]);
      f.calls.focus.push(opts?.focus);
      // The preview can place it only on the placement.
      return { previewRevision: 7, issues: [{ kind: 'element-overflow', message: 'Too wide.', ref: { owner: { kind: 'page', id: p }, nodeId: placement.id } }] };
    };
    const { content } = await f.validate({ profile: 'preview', nodeIds: [designNode] });
    expect(f.calls.inspected.map(([p]) => p)).toEqual(['pg_vcontact']);
    expect(f.calls.focus[0]).toContain(placement.id);
    // The design's own node IDs are never sent bare: other placements' elements share them.
    expect(f.calls.focus[0]!.some((id) => Object.hasOwn(def.tree!.nodes, id))).toBe(false);
    expect(content.preview!.pages.find((p) => p.pageId === 'pg_vcontact')!.issues).toHaveLength(1);

    const shell = fixture({
      pages: ['vcontact'],
      prepare: (st) => {
        for (const id of st.site.pageOrder) if (id !== 'pg_vcontact') st.pages[id].showHeader = false;
      }
    });
    const headerNode = shell.s.site.shell.header.rootIds[0];
    await shell.validate({ profile: 'preview', nodeIds: [headerNode] });
    expect(shell.calls.inspected.map(([p]) => p)).toEqual(['pg_vcontact']);
  });

  it('counts every runtime error the page had, not only those it lists', async () => {
    const { validate } = fixture({ pages: ['vcontact'], inspect: async () => ({ previewRevision: 7, issues: [], runtimeErrors: Array.from({ length: 10 }, (_, i) => `Error ${i + 3}`), runtimeErrorCount: 12 }) });
    const page = (await validate({ profile: 'preview', pageIds: ['pg_vcontact'] })).content.preview!.pages[0];
    expect(page.runtimeErrors).toEqual(['Error 8', 'Error 9', 'Error 10', 'Error 11', 'Error 12']);
    expect(page.omittedRuntimeErrors).toBe(7);
    expect(page.more).toMatch(/7 earlier runtime errors not listed/);
  });
});

describe('validate_project preview of nested and shared components (#756)', () => {
  /** A card component, a wrapper whose design is that card, and the wrapper placed on the page; or the card in the header. */
  const nested = (where: 'page' | 'header') => (st: ProjectState) => {
    const base = structuredClone(catalogueComponent('foundation', 'hero.centered')!);
    st.components['proj.card'] = { ...base, id: 'proj.card', name: 'Card', owner: 'project' };
    const inner = makeInstance(st.components['proj.card'], {});
    st.components['proj.wrapper'] = { ...structuredClone(base), id: 'proj.wrapper', name: 'Wrapper', owner: 'project', tree: { rootIds: [inner.id], nodes: { [inner.id]: inner } } } as never;
    if (where === 'page') {
      const outer = makeInstance(st.components['proj.wrapper'], {});
      st.pages.pg_vcontact.nodes[outer.id] = outer;
      st.pages.pg_vcontact.rootIds.push(outer.id);
    } else {
      const inHeader = makeInstance(st.components['proj.card'], {});
      st.site.shell.header.nodes[inHeader.id] = inHeader;
      for (const id of st.site.pageOrder) if (id !== 'pg_vcontact') st.pages[id].showHeader = false;
    }
  };

  it('keeps a finding the preview could place only on the wrapper of a named component', async () => {
    const f = fixture({ pages: ['vcontact'], prepare: nested('page') });
    const outer = Object.values(f.s.pages.pg_vcontact.nodes).find((x) => x.kind === 'instance' && x.definitionId === 'proj.wrapper')!;
    (f.host as unknown as { inspectLayout: (p: string, w: number, opts?: { focus?: string[] }) => Promise<unknown> }).inspectLayout = async (p, w, opts) => {
      f.calls.inspected.push([p, w]);
      f.calls.focus.push(opts?.focus);
      return { previewRevision: 7, issues: [{ kind: 'element-overflow', message: 'Too wide.', ref: { owner: { kind: 'page', id: p }, nodeId: outer.id } }] };
    };
    const { ok, content } = await f.validate({ profile: 'preview', componentIds: ['proj.card'] });
    expect(ok).toBe(true);
    expect(f.calls.inspected.map(([p]) => p)).toEqual(['pg_vcontact']);
    expect(content.preview!.pages[0].issues).toEqual([expect.objectContaining({ message: 'Too wide.' })]);
  });

  it('measures a component in the header on a page that shows the header', async () => {
    const f = fixture({ pages: ['vcontact'], prepare: nested('header') });
    await f.validate({ profile: 'preview', componentIds: ['proj.card'] });
    expect(f.calls.inspected.map(([p]) => p)).toEqual(['pg_vcontact']);
  });

  it('keeps a finding of every kind when a page has more than it lists', async () => {
    const wide = Array.from({ length: 20 }, (_, i) => ({ kind: 'element-overflow', message: `Wide ${i}.` }));
    const { validate } = fixture({ pages: ['vcontact'], inspect: async () => ({ previewRevision: 7, issues: [...wide, { kind: 'small-tap-target', message: 'Small.' }] }) });
    const page = (await validate({ profile: 'preview', pageIds: ['pg_vcontact'] })).content.preview!.pages[0];
    expect((page.issues as Array<{ kind: string }>).map((i) => i.kind)).toContain('small-tap-target');
    expect(page.issues).toHaveLength(20);
    expect(page.omittedIssues).toBe(1);
  });

  it('does not wait for a slow file check once the run is stopped', async () => {
    const { validate, host } = fixture();
    const stop = new AbortController();
    (host as unknown as { signal: AbortSignal; fileDiagnostics: () => Promise<Diagnostic[]> }).signal = stop.signal;
    (host as unknown as { fileDiagnostics: () => Promise<Diagnostic[]> }).fileDiagnostics = () => {
      setTimeout(() => stop.abort(), 5);
      return new Promise(() => undefined);
    };
    const { ok, content } = await validate({ profile: 'project' });
    expect(ok).toBe(false);
    expect(content.error?.code).toBe('CANCELLED');
  });
});

describe('validate_project result size (#756)', () => {
  it('fits long lists of long problems into one result, saying what it left out and how to see it', async () => {
    const long = (i: number) => `${'x'.repeat(390)} ${i}`;
    const errors: Diagnostic[] = Array.from({ length: 100 }, (_, i) => ({ severity: 'error', code: 'E', message: long(i), owner: { kind: 'page', id: pid('vcontact') }, nodeId: `n${i}` }));
    const warnings = Array.from({ length: 30 }, (_, i) => warn('W', long(i), { kind: 'page', id: pid('vcontact') }, `w${i}`));
    const { validate } = fixture({ pages: ['vcontact'], diagnostics: [...errors, ...warnings] });
    const { content } = await validate({ pageIds: ['/vcontact/'] });
    expect(JSON.stringify(content).length).toBeLessThanOrEqual(24000);
    // Shorter than at full size: the whole result was made to fit.
    expect(content.errors.length).toBeLessThan(40);
    expect(content.omittedErrors).toBe(100 - content.errors.length);
    expect(content.nextOffset).toEqual(expect.arrayContaining([{ list: 'errors', offset: content.errors.length }]));
    const next = (await validate({ pageIds: ['/vcontact/'], list: 'errors', offset: content.errors.length })).content;
    expect(next.errors[0].message).toMatch(new RegExp(` ${content.errors.length}$`));
  });

  it('fits three measured pages with long runtime errors and many findings', async () => {
    const control = '\u0001'.repeat(300);
    const findings = Array.from({ length: 40 }, (_, i) => ({ kind: 'element-overflow', message: `${'m'.repeat(280)} ${i}`, ref: { owner: { kind: 'page', id: 'pg_a' }, nodeId: `n${i}`, partId: 'root' } }));
    const { validate } = fixture({ pages: ['a', 'b', 'c'], changed: ['pg_a', 'pg_b', 'pg_c'], inspect: async () => ({ previewRevision: 7, issues: findings, runtimeErrors: Array.from({ length: 10 }, () => control), runtimeErrorCount: 10 }) });
    const { content } = await validate({ profile: 'preview' });
    expect(JSON.stringify(content).length).toBeLessThanOrEqual(24000);
    for (const p of content.preview!.pages) {
      expect(Number(p.omittedIssues ?? 0) + (p.issues as unknown[]).length).toBe(40);
      expect(p.more).toMatch(/more findings? on this page are not listed/);
    }
  });
});

describe('validate_project tool definition (#756)', () => {
  it('offers the four profiles and the affected IDs, and describes them', () => {
    const def = toolDefinitions().find((t) => t.name === 'validate_project')!;
    const props = (def.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.profile.enum).toEqual(['schema', 'component', 'preview', 'project']);
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['pageIds', 'nodeIds', 'componentIds', 'list', 'offset']));
    for (const text of [def.description, def.brief!]) for (const word of ['preview', 'project', 'pageIds', 'nodeIds', 'componentIds', 'outsideNarrowing', 'nextOffset']) expect(text).toContain(word);
  });

  it('keeps a small window’s validation to the two document profiles, and gives a larger one all of it', () => {
    const state = createStarterState('business', 'Test Studio', false);
    const caps = (contextWindowTokens: number) => ({ toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens, maxOutputTokens: 4000 });
    const tool = (window: number) => toolsForRun({ state, selection: null, codeEnabled: false, definitionOps: false, capabilities: caps(window) }).tools.find((t) => t.name === 'validate_project')!;
    const small = tool(12_288);
    const props = (t: ReturnType<typeof tool>) => (t.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(Object.keys(props(small))).toEqual(['profile']);
    expect(props(small).profile.enum).toEqual(['schema', 'component']);
    expect(small.description).not.toContain('preview');
    const grammar = toolsForRun({ state, selection: null, codeEnabled: false, definitionOps: false, capabilities: { ...caps(200_000), toolCalling: 'constrained-json' } }).tools.find((t) => t.name === 'validate_project')!;
    expect(Object.keys(props(grammar))).toEqual(['profile']);
    const large = tool(200_000);
    expect(props(large).profile.enum).toEqual(['schema', 'component', 'preview', 'project']);
    expect(Object.keys(props(large))).toEqual(expect.arrayContaining(['pageIds', 'nodeIds', 'componentIds']));
  });
});
