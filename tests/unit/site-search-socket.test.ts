/**
 * Site search through SearchSocket (#1403): the site's settings, the search code bound to the service they name, run
 * here as generated against a fake service, and what the website tells services that index it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { RUNTIME_DIR, defFile, generateNotFound, generateProject, generateRedirect } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { SEARCH_HELPER_FILE, SEARCH_INDEX_FILE, SEARCH_JS, searchJs } from '@generator/search';
import { WEBMCP_SEARCH_FILE } from '@generator/webmcp';
import { SEARCHSOCKET_CONFIG, SEARCHSOCKET_CONFIG_FILE, finishExportedSource } from '../../src/main/export';
import { checkSearchEndpoint, checkSearchPathPrefix, searchService } from '@shared/site-search';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { P, prop } from '@catalogue/dsl';
import { fieldKey, readField } from '../../src/renderer/src/lib/held';
import { projectDesign } from './fixtures/packs';

const HELPER = `${RUNTIME_DIR}/${SEARCH_HELPER_FILE}`;
const ENDPOINT = 'https://search.example.com/api/search';
const fresh = () => createStarterState('business', 'Test Studio', false);
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const home = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const withSearch = (s: ProjectState = fresh()) => apply(s, [{ type: 'node.insert', owner: home(s), componentId: 'site.search' }]);
const socket = (s: ProjectState, search: Record<string, unknown> = {}) => apply(s, [{ type: 'site.update', search: { provider: 'searchsocket', endpoint: ENDPOINT, ...search } } as EditOperation]);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

interface Part {
  text: string;
  mark: boolean;
}
interface Found {
  total: number;
  results: Array<{ route: string; hash: string; reload?: boolean; title: Part[]; excerpt: Part[] }>;
}
const read = (parts: Part[]) => parts.map((p) => p.text).join('');

/** The search code as generated, imported as a module beside an index that must never be loaded for the service. */
async function runtime(helper: string): Promise<{ searchSite: (q: string, opts?: { signal?: AbortSignal; limit?: number }) => Promise<Found> }> {
  const dir = mkdtempSync(join(tmpdir(), 'so-socket-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dir, SEARCH_HELPER_FILE), helper);
  writeFileSync(join(dir, SEARCH_INDEX_FILE), `throw new Error('The site index was loaded');\n`);
  return import(/* @vite-ignore */ pathToFileURL(join(dir, SEARCH_HELPER_FILE)).href);
}

/** A fake service that answers every request with `results` (or the response `answer` makes), recording each request. */
function service(answer: unknown[] | (() => Response)) {
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init, body: JSON.parse(String(init.body)) });
    if (typeof answer === 'function') return answer();
    return new Response(JSON.stringify({ q: 'x', scope: 'main', results: answer, meta: { timingsMs: { search: 1, total: 2 } } }), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('location', { origin: 'https://www.example.com' });
  return requests;
}

describe('the site search settings', () => {
  it('are none until SearchSocket is chosen, and keep its address for a switch back', () => {
    let s = fresh();
    expect(searchService(s.site)).toBeNull();
    s = socket(s, { pathPrefix: 'docs/', scrollToText: false });
    expect(s.site.search).toEqual({ provider: 'searchsocket', endpoint: ENDPOINT, pathPrefix: '/docs/', scrollToText: false });
    expect(searchService(s.site)).toEqual({ endpoint: ENDPOINT, pathPrefix: '/docs/', scrollToText: false });
    s = apply(s, [{ type: 'site.update', search: { provider: 'builtin' } }]);
    expect(searchService(s.site)).toBeNull();
    expect(s.site.search).toEqual({ endpoint: ENDPOINT, pathPrefix: '/docs/', scrollToText: false });
    s = apply(s, [{ type: 'site.update', search: { endpoint: '', pathPrefix: '/', scrollToText: true } }]);
    expect(s.site.search).toBeUndefined();
    s = apply(socket(s), [{ type: 'site.update', search: null }]);
    expect(s.site.search).toBeUndefined();
  });

  it('refuse an address visitors’ browsers could not ask from the published site', () => {
    const s = fresh();
    for (const endpoint of ['http://search.example.com/api/search', 'search.example.com', 'https://user:pw@search.example.com/', 'https://search.example.com/a b']) {
      expect(() => applyOperations(s, [{ type: 'site.update', search: { endpoint } }])).toThrow(/search address/);
      expect(checkSearchEndpoint(endpoint).ok).toBe(false);
    }
    for (const pathPrefix of ['//evil.example/', 'https://example.com/docs', '/docs?x', '/docs#a']) expect(checkSearchPathPrefix(pathPrefix).ok).toBe(false);
    // An address the parser would repair here, but that a page asking it reads as a path on its own site.
    expect(() => applyOperations(s, [{ type: 'site.update', search: { endpoint: 'https:search.example.com/api/search' } }])).toThrow(/https:\/\/ and a host name/);
    expect(() => applyOperations(s, [{ type: 'site.update', search: { pathPrefix: '/docs?x' } }])).toThrow(/address on this site/);
  });

  it('store an address as the website asks it, and a section no longer than it can be kept', () => {
    let s = apply(fresh(), [{ type: 'site.update', search: { endpoint: ' https://Search.Example.com/api/search ' } }]);
    expect(s.site.search?.endpoint).toBe(ENDPOINT);
    // Counted with the slash it is stored with, so whatever is saved is read back as saved.
    expect(checkSearchPathPrefix('d'.repeat(200)).ok).toBe(false);
    s = apply(s, [{ type: 'site.update', search: { pathPrefix: 'd'.repeat(199) } }]);
    expect(s.site.search?.pathPrefix).toBe('/' + 'd'.repeat(199));
    expect(searchService({ ...s.site, search: { ...s.site.search, provider: 'searchsocket' } })?.pathPrefix).toBe('/' + 'd'.repeat(199));
  });

  it('are held setting by setting while an AI turn runs, so an address and a section never replace each other', () => {
    const s = socket(fresh(), { pathPrefix: '/docs/' });
    const endpoint: EditOperation = { type: 'site.update', search: { endpoint: 'https://other.example.com/api/search' } };
    const prefix: EditOperation = { type: 'site.update', search: { pathPrefix: '/guides/' } };
    expect(fieldKey([endpoint])).not.toBe(fieldKey([prefix]));
    expect(fieldKey([endpoint])).toBe(fieldKey([{ type: 'site.update', search: { endpoint: 'https://third.example.com/' } }]));
    expect(readField(s, endpoint)).toEqual({ found: true, value: { search: ENDPOINT } });
    expect(readField(s, prefix)).toEqual({ found: true, value: { search: '/docs/' } });
    expect(readField(s, { type: 'site.update', search: null })).toEqual({ found: true, value: { search: s.site.search } });
  });
});

describe('the search code bound to SearchSocket', () => {
  it('is the plain search code for a site searching its own index, and in the editor’s preview', () => {
    const s = withSearch();
    expect(searchJs(s)).toBe(SEARCH_JS);
    const bound = socket(s);
    expect(generateProject(bound).get(HELPER)).toContain(JSON.stringify(ENDPOINT));
    expect(generateProject(bound, { instrument: true }).get(HELPER)).toBe(SEARCH_JS);
  });

  it('asks the service with what was typed and the section, never loading the site’s own index, and links each page found', async () => {
    const s = socket(withSearch(), { pathPrefix: '/library/' });
    const requests = service([
      { url: '/library/reading-room/', title: 'Reading room', sectionTitle: 'A quiet corner', snippet: 'Shelves of oak and linen, lit from the north.', score: 0.9 },
      // The same page again, another website, a link that runs code, and one with no address are left out.
      { url: '/library/reading-room/#shelves', title: 'Reading room', snippet: 'Again', score: 0.8 },
      { url: 'https://elsewhere.example/library/', title: 'Elsewhere', snippet: 'x', score: 0.7 },
      { url: '//elsewhere.example/library/', title: 'Elsewhere', snippet: 'x', score: 0.7 },
      { url: 'javascript:alert(1)', title: 'Bad', snippet: 'x', score: 0.7 },
      { title: 'No address', snippet: 'x', score: 0.7 },
      null,
      { url: '/library/garden/', title: 'Garden room', snippet: 'Seeds and **soil**, quiet in winter.', score: 0.6 }
    ]);
    const { searchSite } = await runtime(generateProject(s).get(HELPER)!);
    const found = await searchSite('  quiet workspace ');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(ENDPOINT);
    expect(requests[0].init).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect(requests[0].body).toEqual({ q: 'quiet workspace', topK: 20, groupBy: 'page', pathPrefix: '/library/' });
    expect(found.total).toBe(2);
    expect(found.results.map((r) => [r.route, r.hash, r.reload, read(r.title)])).toEqual([
      ['/library/reading-room/', '#:~:text=A%20quiet%20corner', true, 'Reading room'],
      // A passage in Markdown is no text the page shows, so the page opens at its top.
      ['/library/garden/', '', false, 'Garden room']
    ]);
    expect(read(found.results[0].excerpt)).toBe('Shelves of oak and linen, lit from the north.');
    expect(found.results[1].excerpt.filter((p) => p.mark).map((p) => p.text)).toEqual(['quiet']);
  });

  it('takes a full address on this website, under its sub-path, and opens results at the top when told to', async () => {
    const s = socket(apply(withSearch(), [{ type: 'site.update', baseUrl: 'https://www.example.com/studio' }]), { scrollToText: false });
    service([
      { url: 'https://www.example.com/studio/about/#team', title: 'About us', snippet: 'x', sectionTitle: 'Team', score: 1 },
      { url: 'https://www.example.com/elsewhere/', title: 'Outside the site', snippet: 'x', score: 1 },
      { url: 'https://www.example.com/studio-two/', title: 'A neighbour', snippet: 'x', score: 1 }
    ]);
    const { searchSite } = await runtime(generateProject(s).get(HELPER)!);
    const found = await searchSite('about');
    expect(found.results.map((r) => [r.route, r.hash, r.reload])).toEqual([['/about/', '#team', false]]);
  });

  it('leaves out an address no link to the site can take, and gives each page its closing slash once', async () => {
    const s = socket(apply(withSearch(), [{ type: 'site.update', baseUrl: 'https://www.example.com/studio' }]));
    service([
      // Read by SvelteKit's resolve as a route's parameter and group, or refused by it.
      { url: '/docs/[edition]/', title: 'Parameter', snippet: 'x', score: 1 },
      { url: '/docs/(group)/', title: 'Group', snippet: 'x', score: 1 },
      { url: 'https://www.example.com/studio//elsewhere/', title: 'Double slash', snippet: 'x', score: 1 },
      { url: '/docs/a%2Fb/', title: 'Encoded slash', snippet: 'x', score: 1 },
      { url: '/docs/a%zz/', title: 'Broken escape', snippet: 'x', score: 1 },
      { url: '/docs/%FF/', title: 'No text', snippet: 'x', score: 1 },
      { url: '/docs/a%5Cb/', title: 'Encoded backslash', snippet: 'x', score: 1 },
      { url: '/docs/intro', title: 'Intro', snippet: 'x', score: 1 },
      { url: '/docs/intro/', title: 'Intro again', snippet: 'x', score: 1 },
      { url: '/files/guide.pdf', title: 'Guide', snippet: 'x', score: 1 },
      { url: '/caf%C3%A9/', title: 'Café', snippet: 'x', score: 1 }
    ]);
    const { searchSite } = await runtime(generateProject(s).get(HELPER)!);
    const found = await searchSite('docs');
    expect(found.results.map((r) => r.route)).toEqual(['/docs/intro/', '/files/guide.pdf', '/caf%C3%A9/']);
  });

  it('opens a page at a heading the page shows, else at a run of the passage it found', async () => {
    const s = socket(withSearch());
    service([
      { url: '/a/', title: 'A', snippet: 'x', chunks: [{ sectionTitle: 'Installation', snippet: 'Run **npm** install', score: 1 }], score: 1 },
      { url: '/b/', title: 'B', sectionTitle: 'Wait… what?', snippet: 'one two … three four five six seven', score: 1 },
      { url: '/c/', title: 'C', snippet: '', score: 1 },
      // A heading no link can carry: the page still opens, and the other results stay.
      { url: '/d/', title: 'D', snippet: 'Plain words here', chunks: [{ sectionTitle: 'Broken \ud800 heading', snippet: 'Plain words here', score: 1 }], score: 1 }
    ]);
    const { searchSite } = await runtime(generateProject(s).get(HELPER)!);
    const found = await searchSite('install');
    expect(found.results.map((r) => [r.route, r.hash, r.reload])).toEqual([
      ['/a/', '#:~:text=Installation', true],
      ['/b/', '#:~:text=three%20four%20five%20six%20seven', true],
      ['/c/', '', false],
      ['/d/', '', false]
    ]);
  });

  it('asks for as many pages as it is to show', async () => {
    const s = socket(withSearch());
    const requests = service(Array.from({ length: 9 }, (_, i) => ({ url: `/p${i}/`, title: `P${i}`, snippet: 'x', score: 1 })));
    const { searchSite } = await runtime(generateProject(s).get(HELPER)!);
    const found = await searchSite('oak', { limit: 5 });
    expect(requests[0].body.topK).toBe(5);
    expect(found.results).toHaveLength(5);
  });

  it('sends no request for an empty search, and fails a search the service cannot answer rather than finding nothing', async () => {
    const s = socket(withSearch());
    let respond = () => new Response('busy', { status: 429 });
    const requests = service(() => respond());
    const { searchSite } = await runtime(generateProject(s).get(HELPER)!);
    await expect(searchSite('   ')).resolves.toEqual({ total: 0, results: [] });
    expect(requests).toHaveLength(0);
    await expect(searchSite('oak')).rejects.toThrow(/429/);
    respond = () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
    await expect(searchSite('oak')).rejects.toThrow(/500/);
    respond = () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    await expect(searchSite('oak')).rejects.toThrow(/did not answer with results/);
    respond = () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
    await expect(searchSite('oak')).rejects.toThrow();
  });

  it('fails every search while SearchSocket is chosen with no address, never searching the site’s own index instead', async () => {
    const s = apply(withSearch(), [{ type: 'site.update', search: { provider: 'searchsocket' } }]);
    const requests = service([]);
    const { searchSite } = await runtime(generateProject(s).get(HELPER)!);
    await expect(searchSite('oak')).rejects.toThrow(/no SearchSocket address/);
    expect(requests).toHaveLength(0);
  });

  it('follows the settings through incremental generation', () => {
    const cache = new GenerationCache();
    let s = socket(withSearch());
    for (const opts of [{}, { instrument: true }]) generateProject(s, opts, cache);
    expect(generateProject(s, {}, cache).get(HELPER)).toBe(generateProject(s).get(HELPER));
    s = apply(s, [{ type: 'site.update', search: { endpoint: 'https://other.example.com/api/search', pathPrefix: '/docs/' } }]);
    const helper = generateProject(s, {}, cache).get(HELPER)!;
    expect(helper).toBe(generateProject(s).get(HELPER));
    expect(helper).toContain('"https://other.example.com/api/search"');
    expect(helper).toContain('"/docs/"');
    s = apply(s, [{ type: 'site.update', search: { provider: 'builtin' } }]);
    expect(generateProject(s, {}, cache).get(HELPER)).toBe(SEARCH_JS);
  });

  it('hands the request the signal that stops it', async () => {
    const s = socket(withSearch());
    const requests = service([]);
    const { searchSite } = await runtime(generateProject(s).get(HELPER)!);
    const controller = new AbortController();
    await searchSite('oak', { signal: controller.signal });
    expect(requests[0].init.signal).toBe(controller.signal);
  });

  it('is what the WebMCP search tool searches with', () => {
    const s = apply(socket(withSearch()), [{ type: 'site.update', webmcp: true }]);
    const tool = generateProject(s).get(`${RUNTIME_DIR}/${WEBMCP_SEARCH_FILE}`)!;
    expect(tool).toContain(`import { searchSite, SHOWN } from './site-search.js';`);
    expect(tool).toContain('searchSite(query, { signal: controller.signal, limit: SHOWN })');
  });
});

describe('what the website tells services that index it', () => {
  it('leaves out each page and post hidden from site search, and only those', () => {
    let s = fresh();
    const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
    s = apply(s, [{ type: 'page.update', pageId: about.id, searchHidden: true }]);
    const files = generateProject(s);
    const marker = '<meta name="searchsocket:noindex" content="true" data-search-noindex />';
    const pageFile = (route: string) => [...files.entries()].find(([k]) => k === `src/routes${route}+page.svelte`)?.[1] ?? '';
    expect(pageFile('/about/')).toContain(marker);
    expect(pageFile('/')).not.toContain('data-search-noindex');
  });

  it('leaves out only what site search leaves out: a page search engines are not to list stays in', () => {
    let s = fresh();
    const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
    s = apply(s, [{ type: 'page.update', pageId: about.id, noindex: true } as EditOperation]);
    const page = generateProject(s).get('src/routes/about/+page.svelte')!;
    expect(page).toContain('<meta name="robots" content="noindex" />');
    expect(page).not.toContain('data-search-noindex');
    // The configuration a Source export starts with reads the site's own switch, not robots noindex.
    expect(SEARCHSOCKET_CONFIG).toContain('respectRobotsNoindex: false');
    // Which leaves the pages robots noindex kept out to say so themselves: old addresses and the not-found page.
    const marker = 'data-search-noindex';
    expect(generateRedirect(s, '/old/', { route: '/about/' })).toContain(marker);
    expect(generateNotFound(s)).toContain(marker);
  });

  it('marks a page’s layer hidden at every size as no content of the page, and a layer shown somewhere as content', () => {
    let s = withSearch();
    s = apply(s, [
      { type: 'node.insert', owner: home(s), primitive: 'container', newNodeId: 'n_box1' },
      { type: 'node.insert', owner: home(s), parentId: 'n_box1', primitive: 'paragraph', text: 'Only for screen captures', newNodeId: 'n_gone1' },
      { type: 'node.insert', owner: home(s), parentId: 'n_box1', primitive: 'paragraph', text: 'Shown on a desktop', newNodeId: 'n_desk1' }
    ] as EditOperation[]);
    s = structuredClone(s);
    const nodes = s.pages[s.site.homePageId].nodes as Record<string, { styles?: unknown }>;
    nodes.n_gone1.styles = { base: { hidden: true } };
    nodes.n_desk1.styles = { base: { hidden: true }, desktop: { hidden: false } };
    nodes.n_box1.styles = { phone: { hidden: true }, tablet: { hidden: true }, desktop: { hidden: true } };
    const out = generateProject(s).get('src/routes/+page.svelte')!;
    // The container hidden at each size in its own rule, and the paragraph hidden at every size; not the one shown on a desktop.
    expect(out.match(/data-search-ignore/g)).toHaveLength(2);
    expect(out).toMatch(/<div [^>]*data-search-ignore[^>]*>/);
  });

  it('never marks a design’s own layer, which a placement or a variant can show again', () => {
    const s = structuredClone(withSearch());
    const def = projectDesign(s, {
      componentId: 'project.note',
      name: 'Note',
      properties: { heading: P.str('Heading', 'Heading'), body: P.text('Text', '') },
      parts: { root: { nodeId: 'root', label: 'Note' } },
      build: (b) => b.el('root', 'section', { name: 'Note' }, [b.text('heading', 'h2', prop('heading'), { name: 'Heading' }), b.text('body', 'p', prop('body'), { name: 'Text' })])
    });
    def.tree!.nodes.body.styles = { base: { hidden: true } };
    def.tree!.nodes.heading.styles = { base: { hidden: true }, desktop: { hidden: false } };
    const out = generateProject(apply(s, [{ type: 'node.insert', owner: home(s), definitionId: def.id }])).get(defFile(def))!;
    expect(out).not.toContain('data-search-ignore');
  });

  it('marks the shared header and footer, the skip link and the search form as no content of a page', () => {
    const files = generateProject(withSearch());
    const layout = files.get('src/routes/+layout.svelte')!;
    expect(layout).toMatch(/<a class="so-skip-link"[^>]* data-search-ignore>/);
    const sources = [...files.entries()].filter(([k]) => k.endsWith('.svelte')).map(([, v]) => v);
    expect(sources.some((v) => /<header class=\{\['so-header'[^>]* data-search-ignore /.test(v))).toBe(true);
    expect(sources.some((v) => /<footer class=\{\['footer'[^>]* data-search-ignore>/.test(v))).toBe(true);
    expect(sources.some((v) => v.includes('<div class="so-search__body" data-search-ignore>'))).toBe(true);
  });

  it('adds a SearchSocket configuration to a Source export of a site that asks SearchSocket, keeping the owner’s own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-socket-export-'));
    dirs.push(dir);
    const notice = join(dir, 'missing-notice.md');
    await finishExportedSource(dir, withSearch(), notice);
    expect(existsSync(join(dir, SEARCHSOCKET_CONFIG_FILE))).toBe(false);
    await finishExportedSource(dir, socket(withSearch()), notice);
    const written = readFileSync(join(dir, SEARCHSOCKET_CONFIG_FILE), 'utf8');
    expect(written).toBe(SEARCHSOCKET_CONFIG);
    expect(written).toContain(`mode: 'static-output'`);
    expect(written).toContain(`staticOutputDir: 'build'`);
    expect(written).not.toMatch(/https:\/\/search\.example\.com|TOKEN\s*[:=]/);
    writeFileSync(join(dir, SEARCHSOCKET_CONFIG_FILE), 'export default { mine: true };\n');
    await finishExportedSource(dir, socket(withSearch()), notice);
    expect(readFileSync(join(dir, SEARCHSOCKET_CONFIG_FILE), 'utf8')).toBe('export default { mine: true };\n');
  });
});
