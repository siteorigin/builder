/**
 * WebMCP (#590): the contact forms and site search of the exported website declared as tools to AI agents in the
 * visitor's browser, only while the author turns it on, and the audit's suggestion to turn it on.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { installComponent } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { runSeoAudit } from '@engine/seo-audit';
import { RUNTIME_DIR, defFile, generateProject, webMcpFormFile } from '@generator/index';
import { SEARCH_HELPER_FILE, SEARCH_INDEX_FILE } from '@generator/search';
import { adaptFormSource, formToolDescription, WEBMCP_SEARCH_FILE } from '@generator/webmcp';
import { uniqueToolNames, webMcpText, webMcpToolName, WEBMCP_NAME_MAX } from '@shared/webmcp';
import { describeOps } from '@agent/report';
import { projectSummary } from '@agent/context';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { compileProject } from '../../src/main/compile';
import { removeRendered, serverHtml } from './generated-site';

const fresh = () => createStarterState('business', 'Test Studio', false);
/** The theme's contact form code, as a new project installs it. */
const FORM_SOURCE_FOR_TESTS = (() => {
  const s = fresh();
  return s.components[installComponent(s, 'contact.form')].source!;
})();
const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const home = (s: ProjectState): OwnerRef => ({ kind: 'page', id: s.site.homePageId });
const header: OwnerRef = { kind: 'shell', id: 'header' };
const on = (s: ProjectState) => run(s, { type: 'site.update', webmcp: true });

/** The placements of the contact form on a page or in the shell, in the order the tree shows them. */
function forms(s: ProjectState, owner: OwnerRef): InstanceNode[] {
  const tree = owner.kind === 'page' ? s.pages[owner.id] : s.site.shell[owner.id as 'header' | 'footer'];
  return tree.rootIds.map((id) => tree.nodes[id]).filter((n): n is InstanceNode => n?.kind === 'instance' && s.components[n.definitionId]?.componentId === 'contact.form');
}

/** `n` contact forms added to the end of a page or shell part (the Home page when none is named). */
function withForms(s: ProjectState, n: number, owner: OwnerRef = home(s)): ProjectState {
  return run(s, ...Array.from({ length: n }, () => ({ type: 'node.insert' as const, owner, componentId: 'contact.form' })));
}

const withSearch = (s: ProjectState) => run(s, { type: 'node.insert', owner: home(s), componentId: 'site.search' });
const formDef = (s: ProjectState) => Object.values(s.components).find((d) => d.componentId === 'contact.form')!;
const setTool = (s: ProjectState, owner: OwnerRef, nodeId: string, field: 'webmcpToolName' | 'webmcpToolDescription', value: unknown) => run(s, { type: 'node.setContent', owner, nodeId, field, value });
/** The tools a generated page's or layout's markup hands its contact forms, in order. */
const toolsIn = (source: string): Array<{ name: string; description: string; unique?: true }> => [...source.matchAll(/so_webmcp=\{(\{.*?\})\}\n/g)].map((m) => JSON.parse(m[1]));

describe('tool names and descriptions', () => {
  it('keeps letters without accents, digits, "_", "-" and "." and joins the rest with "_"', () => {
    expect(webMcpToolName('Book a call')).toBe('Book_a_call');
    expect(webMcpToolName('  Café “quotes” & </script> ')).toBe('Cafe_quotes_script');
    expect(webMcpToolName('order.v2-form')).toBe('order.v2-form');
    expect(webMcpToolName('__--..')).toBe('');
    expect(webMcpToolName('询问 🙂')).toBe('');
    expect(webMcpToolName(42)).toBe('');
    expect(webMcpToolName('a'.repeat(200))).toHaveLength(WEBMCP_NAME_MAX);
    // A cut never leaves a separator at the end.
    expect(webMcpToolName(`${'a'.repeat(WEBMCP_NAME_MAX - 1)} b`)).toBe('a'.repeat(WEBMCP_NAME_MAX - 1));
  });

  it('gives each name its own number after the first, whatever its case, and never search_site', () => {
    expect(uniqueToolNames(['contact', 'contact', 'Contact', 'search_site'])).toEqual(['contact', 'contact_2', 'Contact_3', 'search_site_2']);
    expect(uniqueToolNames(['contact', 'contact_2', 'contact'])).toEqual(['contact', 'contact_2', 'contact_3']);
    const long = 'x'.repeat(WEBMCP_NAME_MAX);
    const [a, b] = uniqueToolNames([long, long]);
    expect(a).toBe(long);
    expect(b).toHaveLength(WEBMCP_NAME_MAX);
    expect(b.endsWith('_2')).toBe(true);
  });

  it('puts descriptions on one line and cuts them at a word', () => {
    expect(webMcpText('  Ask\n\tus  anything ')).toBe('Ask us anything');
    const cut = webMcpText(`${'word '.repeat(200)}end`, 50);
    expect([...cut].length).toBeLessThanOrEqual(50);
    expect(cut.endsWith('word…')).toBe(true);
    expect(webMcpText(null)).toBe('');
  });
});

describe('the contact form’s code', () => {
  it('takes the tool attributes on the form and on every field the visitor fills in, never autosubmitting', () => {
    const adapted = adaptFormSource(FORM_SOURCE_FOR_TESTS)!;
    expect(adapted).not.toBeNull();
    expect(adapted).toContain('toolname={so_webmcpName}');
    expect(adapted).toContain('tooldescription={so_webmcp?.description}');
    // Short text, long text, a single-choice question's answers and a checkbox.
    expect(adapted.match(/toolparamdescription=/g)).toHaveLength(4);
    expect(adapted).not.toContain('toolautosubmit');
    // The hidden service fields and the spam trap are no parameters.
    expect(adapted.match(/name=\{honeypot\}/g)?.length).toBe(FORM_SOURCE_FOR_TESTS.match(/name=\{honeypot\}/g)?.length);
    for (const line of adapted.split('\n').filter((l) => /name=\{honeypot\}|name="form-name"|name="access_key"/.test(l))) expect(line).not.toContain('toolparam');
    // Everything else is the form as it was.
    expect(adapted.replace(/\n\t*(toolname|tooldescription|toolparamdescription)=\{[^\n]*/g, '').replace(",\n\t\tso_webmcp = null", '').replace(/\n\t\/\/ The tool the form is[^\n]*\n\t\/\/[^\n]*\n\tconst so_webmcpName[^\n]*/, '')).toBe(FORM_SOURCE_FOR_TESTS);
  });

  it('leaves code that no longer reads as the theme’s form alone', () => {
    expect(adaptFormSource(FORM_SOURCE_FOR_TESTS.replace('class="so-form__form"', 'class="my-form"'))).toBeNull();
    expect(adaptFormSource(FORM_SOURCE_FOR_TESTS.replace(/name=\{names\[i\]\}/g, 'name={field.name}'))).toBeNull();
    expect(adaptFormSource(FORM_SOURCE_FOR_TESTS.replace("import { visitorText } from '../runtime/visitor-text.js';", "import { visitorText } from './visitor-text.js';"))).toBeNull();
    expect(adaptFormSource(FORM_SOURCE_FOR_TESTS.replace('<form', '<form toolname="mine"'))).toBeNull();
  });
});

describe('the exported website with WebMCP off', () => {
  it('is exactly what it was, whatever forms and searches it has and whatever names its forms were given', () => {
    const plain = withSearch(withForms(withForms(fresh(), 2), 1, header));
    const node = forms(plain, home(plain))[0];
    const named = setTool(setTool(plain, home(plain), node.id, 'webmcpToolName', 'Book a call'), home(plain), node.id, 'webmcpToolDescription', 'Book.');
    const off = run(on(named), { type: 'site.update', webmcp: false });
    expect(Object.hasOwn(off.site, 'webmcp')).toBe(false);
    const before = generateProject(plain);
    for (const s of [named, off]) {
      const after = generateProject(s);
      expect([...after.keys()]).toEqual([...before.keys()]);
      for (const [path, content] of before) expect(after.get(path), path).toBe(content);
    }
    for (const [path, content] of before) expect(/toolname|so_webmcp|modelContext/.test(content), path).toBe(false);
  });
});

describe('the exported website with WebMCP on', () => {
  afterAll(removeRendered);

  it('places the form’s declaring copy, gives each direct form on a page its own name, and keeps the form’s own code', async () => {
    const s = on(withForms(fresh(), 2));
    const def = formDef(s);
    const files = generateProject(s);
    expect(files.get(defFile(def))).toBe(def.source);
    expect(files.get(webMcpFormFile(def))).toBe(adaptFormSource(def.source!));
    const page = files.get('src/routes/+page.svelte')!;
    expect(page).toContain(`/${webMcpFormFile(def).split('/').pop()}"`);
    expect(page).not.toContain(`/${defFile(def).split('/').pop()}"`);
    expect(toolsIn(page).map((t) => t.name)).toEqual(['contact', 'contact_2']);
    expect(await compileProject(s)).toEqual([]);
  });

  it('declares the tool in the prerendered HTML, with every value escaped', async () => {
    let s = on(withForms(fresh(), 1));
    const node = forms(s, home(s))[0];
    s = setTool(s, home(s), node.id, 'webmcpToolDescription', 'Quotes " & <b>braces</b> {x} </script> 🙂');
    s = run(s, { type: 'instance.setProp', owner: home(s), nodeId: node.id, prop: 'fields', value: [{ id: 'f1', label: 'Your "name" {here}', name: 'name', type: 'text', required: true, placeholder: '' }, { id: 'f2', label: 'Topic', name: 'topic', type: 'choice', options: [{ label: 'Sales' }, { label: 'Support' }], required: false, placeholder: '' }] });
    const html = await serverHtml(generateProject(s), 'webmcp-');
    // The form's opening tag, whose quoted values may hold ">".
    const form = /<form(?:[^>"]|"[^"]*")*>/.exec(html)![0];
    expect(form).toContain('toolname="contact"');
    expect(form).toContain('tooldescription="Quotes &quot; &amp; &lt;b>braces&lt;/b> {x} &lt;/script> 🙂"');
    expect(form).not.toContain('toolautosubmit');
    expect(html).toContain('toolparamdescription="Your &quot;name&quot; {here}"');
    // Each answer of a single-choice question is described by the question it answers.
    expect(html.match(/type="radio"[^>]*toolparamdescription="Topic"|toolparamdescription="Topic"[^>]*type="radio"/g)).toHaveLength(2);
    expect(html).not.toMatch(/name="(?:_gotcha|form-name|access_key)"[^>]*toolparam/);
  });

  it('names the header’s forms first, and each page’s around them; a name given is kept, made a tool name', () => {
    let s = withForms(withForms(fresh(), 1, header), 3);
    const [a, b, c] = forms(s, home(s));
    s = setTool(s, home(s), a.id, 'webmcpToolName', 'Book a call!');
    s = setTool(s, home(s), b.id, 'webmcpToolName', 'search_site');
    s = setTool(s, home(s), c.id, 'webmcpToolName', 'contact.v2');
    const files = generateProject(on(s));
    expect(toolsIn(files.get('src/routes/+layout.svelte')!).map((t) => t.name)).toEqual(['contact']);
    // "." is kept for the forms inside designs, which add their own ID after it.
    expect(toolsIn(files.get('src/routes/+page.svelte')!).map((t) => t.name)).toEqual(['Book_a_call', 'search_site_2', 'contact_v2']);
  });

  it('has a form inside a design name itself from its own ID, so two placements of the design never share a name', async () => {
    let s = fresh();
    s = run(s, { type: 'component.create', definitionId: 'proj.enquiry-a1b2c', name: 'Enquiry' });
    const root = s.components['proj.enquiry-a1b2c'].tree!.rootIds[0];
    s = run(s, { type: 'node.insert', owner: { kind: 'component', id: 'proj.enquiry-a1b2c' }, parentId: root, componentId: 'contact.form' } as EditOperation);
    s = run(s, { type: 'node.insert', owner: home(s), definitionId: 'proj.enquiry-a1b2c' } as EditOperation, { type: 'node.insert', owner: home(s), definitionId: 'proj.enquiry-a1b2c' } as EditOperation);
    const files = generateProject(on(s));
    const design = [...files].find(([p]) => p.endsWith('proj-enquiry-a1b2c.svelte'))![1];
    expect(toolsIn(design)).toEqual([expect.objectContaining({ name: 'contact', unique: true })]);
    const html = await serverHtml(files, 'webmcp-nested-');
    const names = [...html.matchAll(/toolname="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const n of names) expect(n).toMatch(/^contact\.[A-Za-z0-9_-]+$/);
    expect(await compileProject(on(s))).toEqual([]);
  });

  it('never reaches the editor’s preview', () => {
    const s = on(withSearch(withForms(fresh(), 1)));
    for (const [path, content] of generateProject(s, { instrument: true })) {
      expect(path).not.toMatch(/webmcp/);
      expect(/toolname|so_webmcp|offerSearch/.test(content), path).toBe(false);
    }
  });

  it('offers search_site from the layout only while a published page shows Site search', async () => {
    const files = (s: ProjectState) => generateProject(s);
    const searching = on(withSearch(fresh()));
    const layout = files(searching).get('src/routes/+layout.svelte')!;
    expect(layout).toContain("import { asset, resolve } from '$app/paths';");
    expect(layout).toContain('onMount(() => offerSearch(resolve));');
    expect(files(searching).has(`${RUNTIME_DIR}/${WEBMCP_SEARCH_FILE}`)).toBe(true);
    expect(await compileProject(searching)).toEqual([]);
    // Not while the search box is only on a draft.
    let draft = run(on(fresh()), { type: 'page.create', pageId: 'pg_find', title: 'Find', route: '/find/' }, { type: 'page.update', pageId: 'pg_find', draft: true });
    draft = run(draft, { type: 'node.insert', owner: { kind: 'page', id: 'pg_find' }, componentId: 'site.search' });
    expect(files(draft).has(`${RUNTIME_DIR}/${WEBMCP_SEARCH_FILE}`)).toBe(false);
    expect(files(draft).get('src/routes/+layout.svelte')).not.toContain('offerSearch');
  });

  it('starts the entrances and the search tool from one onMount import', async () => {
    let s = on(withSearch(fresh()));
    const section = s.pages[s.site.homePageId].rootIds[0];
    s = run(s, { type: 'node.setContent', owner: home(s), nodeId: section, field: 'appear', value: 'fade' });
    const layout = generateProject(s).get('src/routes/+layout.svelte')!;
    expect(layout).toContain('onMount(observeAppear);');
    expect(layout.match(/import \{ onMount \} from 'svelte';/g)).toHaveLength(1);
    expect(await compileProject(s)).toEqual([]);
  });
});

describe('the search_site tool in the visitor’s browser', () => {
  const dirs: string[] = [];
  const saved = { document: (globalThis as { document?: unknown }).document, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  afterEach(() => {
    (globalThis as { document?: unknown }).document = saved.document;
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
  });
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  /** The generated registration with the search code beside it, and an index whose loads are counted. */
  async function tool(index = '[{"route":"/about/","title":"About the studio","text":"We make oak furniture."},{"route":"/","title":"Home","text":"Welcome"}]') {
    const files = generateProject(on(withSearch(fresh())));
    const dir = mkdtempSync(join(tmpdir(), 'so-webmcp-'));
    dirs.push(dir);
    writeFileSync(join(dir, SEARCH_HELPER_FILE), files.get(`${RUNTIME_DIR}/${SEARCH_HELPER_FILE}`)!);
    writeFileSync(join(dir, SEARCH_INDEX_FILE), `globalThis.__soIndexLoads = (globalThis.__soIndexLoads ?? 0) + 1;\nexport default ${index};\n`);
    writeFileSync(join(dir, WEBMCP_SEARCH_FILE), files.get(`${RUNTIME_DIR}/${WEBMCP_SEARCH_FILE}`)!);
    return (await import(/* @vite-ignore */ pathToFileURL(join(dir, WEBMCP_SEARCH_FILE)).href)) as { offerSearch: (resolve: (route: string) => string) => () => void };
  }

  type Registered = { tool: { name: string; inputSchema: unknown; annotations: { readOnlyHint: boolean }; execute: (input: unknown) => Promise<unknown> }; signal: AbortSignal };
  const context = (registered: Registered[], fail?: unknown) => ({
    registerTool(t: Registered['tool'], opts: { signal: AbortSignal }) {
      if (fail) throw fail;
      registered.push({ tool: t, signal: opts.signal });
    }
  });

  it('registers once through document.modelContext, read-only, and finds pages at their full addresses', async () => {
    const { offerSearch } = await tool();
    const registered: Registered[] = [];
    (globalThis as { document?: unknown }).document = { modelContext: context(registered), baseURI: 'https://example.com/studio/about/' };
    const stop = offerSearch((route) => `/studio${route}`);
    expect(registered).toHaveLength(1);
    const { tool: t, signal } = registered[0];
    expect(t.name).toBe('search_site');
    expect(t.annotations.readOnlyHint).toBe(true);
    expect(t.inputSchema).toMatchObject({ required: ['query'] });
    const loads = (globalThis as { __soIndexLoads?: number }).__soIndexLoads ?? 0;
    expect(await t.execute({ query: 'oak' })).toEqual({ total: 1, results: [{ title: 'About the studio', excerpt: 'We make oak furniture.', url: 'https://example.com/studio/about/' }] });
    expect((globalThis as { __soIndexLoads?: number }).__soIndexLoads).toBe(loads + 1);
    expect(await t.execute({ query: ' ' })).toEqual({ error: expect.any(String) });
    expect(await t.execute(null)).toEqual({ error: expect.any(String) });
    expect(signal.aborted).toBe(false);
    stop();
    expect(signal.aborted).toBe(true);
  });

  it('falls back to navigator.modelContext, and does nothing (loading nothing) in a browser without WebMCP', async () => {
    const { offerSearch } = await tool();
    const registered: Registered[] = [];
    (globalThis as { document?: unknown }).document = { baseURI: 'https://example.com/' };
    Object.defineProperty(globalThis, 'navigator', { value: { modelContext: context(registered) }, configurable: true });
    offerSearch((r) => r)();
    expect(registered).toHaveLength(1);
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const loads = (globalThis as { __soIndexLoads?: number }).__soIndexLoads ?? 0;
    const stop = offerSearch((r) => r);
    expect(typeof stop).toBe('function');
    stop();
    expect((globalThis as { __soIndexLoads?: number }).__soIndexLoads ?? 0).toBe(loads);
  });

  it('leaves a name already offered alone, whether the refusal is thrown or rejected', async () => {
    const { offerSearch } = await tool();
    const refusal = Object.assign(new Error('Duplicate'), { name: 'InvalidStateError' });
    (globalThis as { document?: unknown }).document = { modelContext: context([], refusal), baseURI: 'https://example.com/' };
    expect(() => offerSearch((r) => r)()).not.toThrow();
    (globalThis as { document?: unknown }).document = { modelContext: { registerTool: () => Promise.reject(refusal) }, baseURI: 'https://example.com/' };
    expect(() => offerSearch((r) => r)()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('says so when the index cannot be loaded', async () => {
    const { offerSearch } = await tool('(() => { throw new Error("gone"); })()');
    const registered: Registered[] = [];
    (globalThis as { document?: unknown }).document = { modelContext: context(registered), baseURI: 'https://example.com/' };
    offerSearch((r) => r);
    expect(await registered[0].tool.execute({ query: 'oak' })).toEqual({ error: expect.stringContaining('could not be loaded') });
  });
});

describe('editing a form’s tool', () => {
  it('keeps each of the name and description on its own, and clears them back to the default', () => {
    let s = withForms(fresh(), 1);
    const node = () => forms(s, home(s))[0];
    s = setTool(s, home(s), node().id, 'webmcpToolName', '  Book   a call ');
    s = setTool(s, home(s), node().id, 'webmcpToolDescription', 'Book a free call.');
    expect(node().webmcp).toEqual({ toolName: 'Book a call', toolDescription: 'Book a free call.' });
    s = setTool(s, home(s), node().id, 'webmcpToolName', '');
    expect(node().webmcp).toEqual({ toolDescription: 'Book a free call.' });
    s = setTool(s, home(s), node().id, 'webmcpToolDescription', null);
    expect(Object.hasOwn(node(), 'webmcp')).toBe(false);
    expect(formToolDescription(s, node())).toBe('Send us a message. Contact Test Studio: fills in this form with a message, which the visitor checks and sends.');
  });

  it('refuses a name with nothing usable in it, text too long, and anything but a contact form', () => {
    const s = withForms(fresh(), 1);
    const id = forms(s, home(s))[0].id;
    const fails = (op: EditOperation) => expect(() => applyOperations(s, [op])).toThrow();
    fails({ type: 'node.setContent', owner: home(s), nodeId: id, field: 'webmcpToolName', value: '🙂 ?' });
    fails({ type: 'node.setContent', owner: home(s), nodeId: id, field: 'webmcpToolName', value: 'a'.repeat(129) });
    fails({ type: 'node.setContent', owner: home(s), nodeId: id, field: 'webmcpToolDescription', value: 'a'.repeat(501) });
    fails({ type: 'node.setContent', owner: home(s), nodeId: id, field: 'webmcpToolName', value: 7 });
    fails({ type: 'node.setContent', owner: home(s), nodeId: s.pages[s.site.homePageId].rootIds[0], field: 'webmcpToolName', value: 'hero' });
  });

  it('drops the tool when the form becomes another kind of component', () => {
    let s = withForms(fresh(), 1);
    const id = forms(s, home(s))[0].id;
    s = setTool(s, home(s), id, 'webmcpToolName', 'Book');
    s = run(s, { type: 'instance.swapComponent', owner: home(s), nodeId: id, componentId: 'content.text', allowDrops: true });
    expect(Object.hasOwn(s.pages[s.site.homePageId].nodes[id], 'webmcp')).toBe(false);
  });

  it('tells the AI the site’s WebMCP choice, and describes the edits', () => {
    const s = on(fresh());
    expect(projectSummary(s, 1).site).toMatchObject({ agentDiscovery: { webmcp: true } });
    expect(projectSummary(fresh(), 1).site).not.toHaveProperty('agentDiscovery');
    const ops: EditOperation[] = [{ type: 'site.update', webmcp: true }];
    const r = applyOperations(fresh(), ops);
    expect(describeOps(ops, fresh(), r.state, r.results).map((c) => c.label).join(' ')).toContain('WebMCP');
  });
});

describe('the WebMCP readiness suggestion', () => {
  const finding = (s: ProjectState) => runSeoAudit(s).filter((f) => f.code === 'SEO_WEBMCP_OFF');

  it('suggests WebMCP once for a site showing a contact form or site search, and points at the switch', () => {
    expect(finding(fresh())).toEqual([]);
    const both = finding(withSearch(withForms(fresh(), 2)));
    expect(both).toEqual([
      expect.objectContaining({ pillar: 'agentic', severity: 'info', site: 'webmcp', aiFixable: true, destination: { kind: 'site', field: 'webmcp' }, message: expect.stringContaining('a contact form and site search') })
    ]);
    expect(finding(withForms(fresh(), 1, header))[0].message).toContain('has a contact form but');
    expect(finding(withSearch(fresh()))[0].message).toContain('has site search but');
  });

  it('says nothing once WebMCP is on, or for a form only on a draft', () => {
    expect(finding(on(withSearch(withForms(fresh(), 1))))).toEqual([]);
    let s = run(fresh(), { type: 'page.create', pageId: 'pg_draft', title: 'Later', route: '/later/' }, { type: 'page.update', pageId: 'pg_draft', draft: true });
    s = withForms(s, 1, { kind: 'page', id: 'pg_draft' });
    expect(finding(s)).toEqual([]);
  });
});
