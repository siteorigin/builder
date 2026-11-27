/**
 * WebMCP (#590): the contact forms and site search of the exported website declared as tools to AI agents in the
 * visitor's browser, only while the author turns it on, and the audit's suggestion to turn it on.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Route } from 'playwright';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { installComponent } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { runSeoAudit } from '@engine/seo-audit';
import { RUNTIME_DIR, defFile, generateProject, webMcpFormFile } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { SEARCH_HELPER_FILE, SEARCH_INDEX_FILE } from '@generator/search';
import { adaptFormSource, formToolDescription, showsFormTool, WEBMCP_SEARCH_FILE } from '@generator/webmcp';
import { uniqueToolNames, webMcpText, webMcpToolName, WEBMCP_NAME_MAX } from '@shared/webmcp';
import { describeOps } from '@agent/report';
import { compactNode, projectSummary } from '@agent/context';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { compileProject } from '../../src/main/compile';
import { bundle, removeRendered, serverHtml } from './generated-site';
import { projectDesign } from './fixtures/packs';
import { HERO } from './fixtures/appear-designs';
import { SUPPORTED_FORM_SOURCE, withSupportedForm } from './fixtures/webmcp-designs';

/** A new project, as the release makes it. */
const release = () => createStarterState('business', 'Test Studio', false);
/**
 * A new project whose contact form is written as the adapter reads it (fixtures/webmcp-designs.ts): what WebMCP does
 * with a form that declares a tool is tested on it, while the release's own form declares none (see the Release gap).
 */
const fresh = () => withSupportedForm(release());
/** The contact form code, as such a project installs it. */
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
    expect(uniqueToolNames(['contact', 'search_site'], ['Contact'])).toEqual(['contact_2', 'search_site']);
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
    expect(cut.startsWith('word word word word word word')).toBe(true);
    expect(webMcpText(null)).toBe('');
  });
});

describe('the contact form’s code', () => {
  it('takes the tool attributes on the form and on every field, never autosubmitting', () => {
    const adapted = adaptFormSource(FORM_SOURCE_FOR_TESTS)!;
    expect(adapted).not.toBeNull();
    expect(adapted).toContain('toolname={so_webmcpName}');
    expect(adapted).toContain('tooldescription={so_webmcp?.description}');
    expect(adapted).not.toContain('toolautosubmit');
    // Short text, long text, a single-choice question's answers and its group, and a checkbox: each from its label.
    expect(adapted.match(/toolparamdescription=\{so_webmcp \? String\(field\.label/g)).toHaveLength(5);
    expect(adapted).toMatch(/<fieldset class="so-form__field so-form__field--wide so-form__choices" toolparamdescription=\{so_webmcp \? String\(field\.label/);
    // The spam trap tells agents to leave it empty. The service's hidden fields get no description, which keeps them out
    // of what agents may fill in (an access key decides whose inbox a message reaches).
    expect(adapted.match(/name=\{honeypot\} toolparamdescription=\{so_webmcp \? 'A spam trap: always leave it empty\. Filling it in discards the message\.' : undefined\}/g)).toHaveLength(FORM_SOURCE_FOR_TESTS.match(/name=\{honeypot\}/g)!.length);
    expect(adapted).toMatch(/name="form-name" value/);
    expect(adapted).toMatch(/name="access_key" value/);
    // A field the browser sees change would change the tool under it: they stay as they are while an agent waits.
    expect(adapted.match(/readonly=\{status === 'sending' && !so_answering\}/g)).toHaveLength(2);
    expect(adapted.match(/disabled=\{status === 'sending' && !so_answering\}/g)).toHaveLength(2);
    expect(adapted).not.toMatch(/(?:readonly|disabled)=\{status === 'sending'\}/);
    // Sending tells the agent how it went, and empties the form only after that.
    expect(adapted).toContain('\tfunction submit(event) {');
    expect(adapted).toContain('\tasync function so_send(event) {\n\t\tevent.preventDefault();');
    expect(adapted.match(/so_reset\(form\);/g)!.length).toBe(FORM_SOURCE_FOR_TESTS.match(/HTMLFormElement\.prototype\.reset\.call\(form\);/g)!.length);
    // The one place left that empties the form, inside so_reset.
    expect(adapted.match(/HTMLFormElement\.prototype\.reset\.call\(form\)/g)).toHaveLength(1);
  });

  it('adapts the first forms too, whose fields are named by fieldName', () => {
    const first = FORM_SOURCE_FOR_TESTS.replace(/name=\{names\[i\]\}/g, 'name={fieldName(field, i)}');
    expect(adaptFormSource(first)?.match(/name=\{fieldName\(field, i\)\}\n\t+toolparamdescription=/g)).toHaveLength(4);
  });

  it('leaves code that no longer reads as the theme’s form alone', () => {
    // The form these changes start from is one it adapts.
    expect(adaptFormSource(FORM_SOURCE_FOR_TESTS)).not.toBeNull();
    const changed = (from: string | RegExp, to: string) => {
      const source = FORM_SOURCE_FOR_TESTS.replace(from, to);
      expect(source).not.toBe(FORM_SOURCE_FOR_TESTS);
      return adaptFormSource(source);
    };
    expect(changed('class="so-form__form"', 'class="my-form"')).toBeNull();
    expect(changed(/name=\{names\[i\]\}/g, 'name={field.name}')).toBeNull();
    // One field's name moved onto another line would leave that field undescribed.
    expect(changed(/\n\t+name=\{names\[i\]\}/, ' name={names[i]}')).toBeNull();
    // A file beside it, however it is imported, would not be beside the copy.
    expect(changed("import { visitorText } from '../runtime/visitor-text.js';", "import { visitorText } from './visitor-text.js';")).toBeNull();
    expect(changed("import { visitorText } from '../runtime/visitor-text.js';", "import { visitorText } from'./visitor-text.js';")).toBeNull();
    expect(changed('const uid = $props.id();', "const uid = $props.id();\n\tconst extra = import('./Note.svelte');")).toBeNull();
    // A tool attribute of its own (an autosubmit would send without the visitor) leaves the form as the author made it.
    expect(changed('\t\t\tclass="so-form__form"', '\t\t\tclass="so-form__form"\n\t\t\ttoolautosubmit')).toBeNull();
    expect(changed('\t\t\tclass="so-form__form"', '\t\t\tclass="so-form__form"\n\t\t\ttooldescription="Contact us"')).toBeNull();
    expect(changed('\t\t\tclass="so-form__form"', '\t\t\tclass="so-form__form"\n\t\t\ttoolname="mine"')).toBeNull();
    expect(changed('async function submit(event) {', 'async function submit(e) {\n\t\tconst event = e;')).toBeNull();
    // Attributes spread from elsewhere might carry an autosubmit of their own.
    expect(changed('\t\t\tclass="so-form__form"', '\t\t\tclass="so-form__form"\n\t\t\t{...formAttributes}')).toBeNull();
    // A sibling named in any but the plainest way.
    expect(changed("import { visitorText } from '../runtime/visitor-text.js';", "import { visitorText } from '../runtime/visitor-text.js';\n\timport Helper from '\\x2e/Helper.svelte';")).toBeNull();
    // A field named some other way would go undescribed.
    expect(changed(/name=\{names\[i\]\}/, "name={names[i] ?? 'message'}")).toBeNull();
    // The sending state the agent's answer reads, under another name.
    expect(changed(/\bstatus\b/g, 'sendStatus')).toBeNull();
    expect(changed("import { visitorText } from '../runtime/visitor-text.js';", "import { visitorText } from '../runtime/visitor-text.js';\n\timport /* helper */ '\\x2e/Helper.svelte';")).toBeNull();
    // A field that locks itself some other way while sending would change under an agent.
    expect(changed("readonly={status === 'sending'}", 'readonly={busy}')).toBeNull();
  });

  it('changes only the form’s markup and code, whatever else the code says, and either quote', () => {
    const quoted = FORM_SOURCE_FOR_TESTS.replace("readonly={status === 'sending'}", 'readonly={status === "sending"}');
    expect(adaptFormSource(quoted)).toContain('readonly={status === "sending" && !so_answering}');
    const said = FORM_SOURCE_FOR_TESTS.replace('\tconst uid = $props.id();', "\tconst uid = $props.id();\n\tconst note = 'name={honeypot}';");
    const adapted = adaptFormSource(said)!;
    expect(adapted).toContain("\tconst note = 'name={honeypot}';");
  });
});

describe('the release’s contact form', () => {
  const s = release();
  const def = s.components[installComponent(s, 'contact.form')];

  it('is not the code the other tests adapt', () => {
    expect(def.source).not.toBe(SUPPORTED_FORM_SOURCE);
  });

  // Release gap: adaptFormSource (src/generator/webmcp.ts) reads the form as Builder's own copy of Foundation wrote it; the release's contact form opens its <form> at another indentation, writes its text fields in a `control` snippet outside the field loop, and drops `so-form__field--wide` from its choices, so it declares no tool and gets no WebMCP copy.
  it.fails('takes the tool attributes, and a site placing it declares a tool', () => {
    expect(adaptFormSource(def.source!)).not.toBeNull();
    expect(showsFormTool(on(withForms(release(), 1)))).toBe(true);
  });
});

describe('the exported website with WebMCP off', () => {
  it('is exactly what it was, whatever forms and searches it has and whatever names its forms were given', () => {
    const plain = withSearch(withForms(withForms(fresh(), 2), 1, header));
    const node = forms(plain, home(plain))[0];
    const named = setTool(setTool(plain, home(plain), node.id, 'webmcpToolName', 'Book a call'), home(plain), node.id, 'webmcpToolDescription', 'Book.');
    const off = run(on(named), { type: 'site.update', webmcp: false });
    expect(Object.hasOwn(off.site, 'webmcp')).toBe(false);
    // The names typed stay for when it is turned on again.
    expect(forms(off, home(off))[0].webmcp).toEqual({ toolName: 'Book a call', toolDescription: 'Book.' });
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
    // The spam trap is in the agent's view too, told to stay empty.
    expect(html).toMatch(/name="_gotcha" toolparamdescription="A spam trap: always leave it empty\./);
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
    // One the header has already is numbered.
    const plain = generateProject(on(setTool(s, home(s), a.id, 'webmcpToolName', '')));
    expect(toolsIn(plain.get('src/routes/+page.svelte')!).map((t) => t.name)).toEqual(['contact_2', 'search_site_2', 'contact_v2']);
  });

  it('names a header’s and a footer’s forms apart even when they share a node ID', () => {
    let s = withForms(withForms(fresh(), 1, header), 1, { kind: 'shell', id: 'footer' });
    const h = s.site.shell.header;
    const f = s.site.shell.footer;
    const hid = h.rootIds.at(-1)!;
    const fid = f.rootIds.at(-1)!;
    // A hand-edited footer that reuses the header form's ID.
    f.nodes = Object.fromEntries(Object.entries(f.nodes).map(([k, n]) => (k === fid ? [hid, { ...n, id: hid }] : [k, n])));
    f.rootIds = f.rootIds.map((id) => (id === fid ? hid : id));
    s = on(s);
    expect(toolsIn(generateProject(s).get('src/routes/+layout.svelte')!).map((t) => t.name)).toEqual(['contact', 'contact_2']);
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

  it('makes again exactly the files a change of the switch, a name or the shell’s forms touches, in a cached run', () => {
    const cache = new GenerationCache();
    let s = withSearch(withForms(fresh(), 2));
    const same = (state: ProjectState) => {
      for (const opts of [{}, { instrument: true }]) expect([...generateProject(state, opts, cache)]).toEqual([...generateProject(state, opts)]);
    };
    same(s);
    s = on(s);
    same(s);
    s = setTool(s, home(s), forms(s, home(s))[1].id, 'webmcpToolName', 'Quote');
    same(s);
    // A form added to the header takes "contact", and the page's first form is numbered around it.
    s = withForms(s, 1, header);
    same(s);
    expect(toolsIn(generateProject(s, {}, cache).get('src/routes/+page.svelte')!).map((t) => t.name)).toEqual(['contact_2', 'Quote']);
    s = run(s, { type: 'site.update', webmcp: false });
    same(s);
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
    expect(files(draft).get('src/routes/+layout.svelte')).not.toContain('offerSearch');
    // The file is there whenever the search code is, so leaving drafts out of an export never leaves the layout naming
    // a file the copy lacks.
    expect(files(draft).has(`${RUNTIME_DIR}/${WEBMCP_SEARCH_FILE}`)).toBe(true);
    expect(files(run(draft, { type: 'site.update', webmcp: false })).has(`${RUNTIME_DIR}/${WEBMCP_SEARCH_FILE}`)).toBe(false);
  });

  it('starts the entrances and the search tool from one onMount import', async () => {
    let s = on(withSearch(fresh()));
    // A section of the editor's own design, which takes an entrance (the theme's code sections take none).
    const hero = projectDesign(s, HERO);
    s = run(s, { type: 'node.insert', newNodeId: 'n_hero', owner: home(s), parentId: null, index: 0, definitionId: hero.id });
    s = run(s, { type: 'node.setContent', owner: home(s), nodeId: 'n_hero', field: 'appear', value: 'fade' });
    const layout = generateProject(s).get('src/routes/+layout.svelte')!;
    expect(layout).toContain('onMount(observeAppear);');
    expect(layout).toContain('onMount(() => offerSearch(resolve));');
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
    expect(await t.execute({ query: 'welcome' })).toEqual({ total: 1, results: [{ title: 'Home', excerpt: 'Welcome', url: 'https://example.com/studio/' }] });
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
    await new Promise((r) => setTimeout(r, 20));
    expect((globalThis as { __soIndexLoads?: number }).__soIndexLoads ?? 0).toBe(loads);
    expect(registered).toHaveLength(1);
  });

  it('stops the tool by its name where the browser takes no signal', async () => {
    const { offerSearch } = await tool();
    const calls: string[] = [];
    (globalThis as { document?: unknown }).document = { modelContext: { registerTool: (t: { name: string }) => calls.push(`register ${t.name}`), unregisterTool: (name: string) => calls.push(`unregister ${name}`) }, baseURI: 'https://example.com/' };
    offerSearch((r) => r)();
    expect(calls).toEqual(['register search_site', 'unregister search_site']);
    // A name another script offered first is never stopped here.
    calls.length = 0;
    (globalThis as { document?: unknown }).document = {
      modelContext: {
        registerTool: () => {
          throw Object.assign(new Error('Duplicate'), { name: 'InvalidStateError' });
        },
        unregisterTool: (name: string) => calls.push(`unregister ${name}`)
      },
      baseURI: 'https://example.com/'
    };
    offerSearch((r) => r)();
    expect(calls).toEqual([]);
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
    // Site search is code too, and no form.
    const searching = withSearch(s);
    fails({ type: 'node.setContent', owner: home(s), nodeId: searching.pages[s.site.homePageId].rootIds.at(-1)!, field: 'webmcpToolName', value: 'find' } as EditOperation);
    expect(() => applyOperations(searching, [{ type: 'node.setContent', owner: home(s), nodeId: searching.pages[s.site.homePageId].rootIds.at(-1)!, field: 'webmcpToolName', value: 'find' }])).toThrow(/contact form/);
    // At the limits, accepted.
    const at = setTool(setTool(s, home(s), id, 'webmcpToolName', 'a'.repeat(128)), home(s), id, 'webmcpToolDescription', 'b'.repeat(500));
    expect(forms(at, home(at))[0].webmcp).toEqual({ toolName: 'a'.repeat(128), toolDescription: 'b'.repeat(500) });
  });

  it('drops the tool when the form becomes another kind of component, and says so first', () => {
    let s = withForms(fresh(), 1);
    const id = forms(s, home(s))[0].id;
    s = setTool(s, home(s), id, 'webmcpToolDescription', 'Book.');
    expect(() => applyOperations(s, [{ type: 'instance.swapComponent', owner: home(s), nodeId: id, componentId: 'content.text' }])).toThrow(/Agent tool name and description/);
    s = run(s, { type: 'instance.swapComponent', owner: home(s), nodeId: id, componentId: 'content.text', allowDrops: true });
    expect(Object.hasOwn(s.pages[s.site.homePageId].nodes[id], 'webmcp')).toBe(false);
  });

  it('tells the AI the site’s WebMCP choice and a form’s own names, and describes the edits', () => {
    const s = on(fresh());
    expect(projectSummary(s, 1).site).toMatchObject({ agentDiscovery: { webmcp: true } });
    const named = withForms(fresh(), 1);
    const node = forms(named, home(named))[0];
    const withName = setTool(named, home(named), node.id, 'webmcpToolName', 'Book');
    const page = withName.pages[withName.site.homePageId];
    expect(compactNode(withName, page, node.id)).toMatchObject({ webmcp: { toolName: 'Book' } });
    expect(compactNode(named, named.pages[named.site.homePageId], node.id)).not.toHaveProperty('webmcp');
    const labels = (ops: EditOperation[], before: ProjectState) => {
      const r = applyOperations(before, ops);
      return describeOps(ops, before, r.state, r.results).map((c) => c.label).join(' ');
    };
    expect(labels([{ type: 'node.setContent', owner: home(named), nodeId: node.id, field: 'webmcpToolName', value: 'Book' }], named)).toContain('agent tool name');
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

  it('counts what collection pages show: the shell they always show, and each entry’s page as its layout shows it', () => {
    // The header is hidden on every page, but entries show it.
    let s = withForms(fresh(), 1, header);
    for (const id of s.site.pageOrder) s = run(s, { type: 'page.update', pageId: id, showHeader: false } as EditOperation);
    expect(finding(s)).toEqual([]);
    s = run(s, { type: 'collection.create', collectionId: 'projects', name: 'Projects', route: '/projects/' } as EditOperation, { type: 'entry.create', collectionId: 'projects', entryId: 'en_first', title: 'First', publishedAt: '2026-01-01', draft: false, body: ['First.'] } as EditOperation);
    expect(finding(s)[0]?.message).toContain('a contact form');
  });

  it('counts a form in a collection’s layout only while an entry shows it', () => {
    const posts = run(fresh(), { type: 'collection.create', collectionId: 'projects', name: 'Projects', route: '/projects/' } as EditOperation, { type: 'entry.create', collectionId: 'projects', entryId: 'en_first', title: 'First', publishedAt: '2026-01-01', draft: true, body: ['First.'] } as EditOperation);
    const layout: OwnerRef = { kind: 'template', id: 'projects' };
    const placed = withForms(posts, 1, layout);
    expect(finding(placed)).toEqual([]);
    const published = run(placed, { type: 'entry.update', collectionId: 'projects', entryId: 'en_first', draft: false } as EditOperation);
    expect(finding(published)[0]?.message).toContain('a contact form');
  });

  it('says nothing for a form whose code declares no tool', () => {
    const s = withForms(fresh(), 1);
    const def = formDef(s);
    def.source = def.source!.replace('class="so-form__form"', 'class="my-form"');
    expect(finding(s)).toEqual([]);
  });

  it('says nothing once WebMCP is on, or for a form only on a draft', () => {
    expect(finding(on(withSearch(withForms(fresh(), 1))))).toEqual([]);
    let s = run(fresh(), { type: 'page.create', pageId: 'pg_draft', title: 'Later', route: '/later/' }, { type: 'page.update', pageId: 'pg_draft', draft: true });
    s = withForms(s, 1, { kind: 'page', id: 'pg_draft' });
    expect(finding(s)).toEqual([]);
  });
});

describe.skipIf(!existsSync(chromium.executablePath()))('a contact form an agent filled in, sent by the visitor', () => {
  const ORIGIN = 'https://site.test';
  const ENDPOINT = 'https://forms.test/f/abc';
  afterAll(removeRendered);

  /** The exported Home page with one connected form, served, hydrated, and its POSTs held for the test to answer. */
  async function open() {
    let s = on(withForms(fresh(), 1));
    const node = forms(s, home(s))[0];
    s = run(s, { type: 'instance.setProp', owner: home(s), nodeId: node.id, prop: 'endpoint', value: ENDPOINT });
    const files = generateProject(s);
    const [html, script] = await Promise.all([serverHtml(files, 'webmcp-agent-'), bundle(files, files)]);
    const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const page = await (await browser.newContext()).newPage();
    const posts: Route[] = [];
    await page.route(`${ORIGIN}/**`, (route) =>
      new URL(route.request().url()).pathname === '/site.js'
        ? route.fulfill({ contentType: 'text/javascript', body: script })
        : route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app">${html}</div><script type="module" src="/site.js"></script></body></html>` })
    );
    await page.route(`${ENDPOINT}**`, (route) => void posts.push(route));
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction("typeof window.startSite === 'function'");
    await page.evaluate("window.startSite('clean')");
    await page.fill('input[name="name"]', 'Ana');
    await page.fill('input[name="email"]', 'ana@example.com');
    await page.fill('textarea[name="message"]', 'Hello');
    return { browser, page, posts };
  }

  /**
   * Submits the form as the browser does once the visitor sends what an agent filled in (or, with `agent` false, as
   * the visitor's own send), holding what the page tells the agent. Evaluates to whether the page took the send over.
   */
  const agentSubmit = (agent: boolean) => `(() => {
    const form = document.querySelector('form');
    const event = new SubmitEvent('submit', { bubbles: true, cancelable: true });
    window.told = undefined;
    window.claimed = false;
    if (${agent}) {
      Object.defineProperty(event, 'agentInvoked', { value: true });
      Object.defineProperty(event, 'respondWith', {
        value: (answer) => {
          // Claimed while the event is still being dispatched, after the page took the submission over.
          window.claimed = event.defaultPrevented;
          answer.then((value) => {
            window.told = value;
            window.nameWhenTold = document.querySelector('input[name="name"]').value;
          });
        }
      });
    }
    form.dispatchEvent(event);
    return event.defaultPrevented;
  })()`;
  const told = "window.told !== undefined";

  it('tells the agent the message was sent, and empties the form only after that', async () => {
    const { browser, page, posts } = await open();
    try {
      expect(await page.evaluate(agentSubmit(true))).toBe(true);
      expect(await page.evaluate('window.claimed')).toBe(true);
      await expect.poll(() => posts.length).toBe(1);
      expect(await page.evaluate('window.told')).toBeUndefined();
      await posts[0].fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      await page.waitForFunction(told);
      expect(await page.evaluate('window.told')).toEqual({ sent: true, message: 'The message was sent.' });
      // Still filled in when the agent was told; emptied right after.
      expect(await page.evaluate('window.nameWhenTold')).toBe('Ana');
      await expect.poll(() => page.inputValue('input[name="name"]')).toBe('');
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('tells the agent when the service refuses the message, and keeps what was typed', async () => {
    const { browser, page, posts } = await open();
    try {
      await page.evaluate(agentSubmit(true));
      await expect.poll(() => posts.length).toBe(1);
      await posts[0].fulfill({ status: 500, body: 'no' });
      await page.waitForFunction(told);
      expect(await page.evaluate('window.told')).toEqual({ sent: false, message: expect.stringContaining('could not be sent') });
      expect(await page.inputValue('input[name="name"]')).toBe('Ana');
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('keeps the fields as they are while the agent waits, and answers a second request without sending again', async () => {
    const { browser, page, posts } = await open();
    try {
      await page.evaluate(agentSubmit(true));
      await expect.poll(() => posts.length).toBe(1);
      expect(await page.evaluate("document.querySelector('input[name=\"name\"]').readOnly")).toBe(false);
      // Another agent request while the message is on its way is told so, and leaves the first one's answer alone.
      await page.evaluate(agentSubmit(true));
      await page.waitForFunction(told);
      expect(await page.evaluate('window.told')).toEqual({ sent: false, message: 'The form is already sending a message.' });
      expect(posts).toHaveLength(1);
      await page.evaluate('window.told = undefined');
      await posts[0].fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      await expect.poll(() => page.inputValue('input[name="name"]')).toBe('');
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('keeps what the visitor typed while the agent waited', async () => {
    const { browser, page, posts } = await open();
    try {
      await page.evaluate("document.addEventListener('reset', () => (window.heardReset = true))");
      await page.evaluate(agentSubmit(true));
      await expect.poll(() => posts.length).toBe(1);
      await page.fill('input[name="name"]', 'Bo');
      await posts[0].fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      await page.waitForFunction(told);
      expect(await page.evaluate('window.told')).toEqual({ sent: true, message: 'The message was sent.' });
      await new Promise((r) => setTimeout(r, 100));
      expect(await page.inputValue('input[name="name"]')).toBe('Bo');
      // The message that went is the one the agent filled in.
      expect(posts[0].request().postDataBuffer()?.toString()).toContain('Ana');
      // The page heard the sent message was done with, as from a reset, though nothing was emptied.
      expect(await page.evaluate('window.heardReset')).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('tells the agent a message caught by the spam trap was discarded, sending nothing', async () => {
    const { browser, page, posts } = await open();
    try {
      await page.evaluate("document.querySelector('input[name=\"_gotcha\"]').value = 'spam'");
      await page.evaluate(agentSubmit(true));
      await page.waitForFunction(told);
      expect(await page.evaluate('window.told')).toEqual({ sent: false, message: expect.stringContaining('spam trap') });
      expect(await page.evaluate('window.nameWhenTold')).toBe('Ana');
      await expect.poll(() => page.inputValue('input[name="name"]')).toBe('');
      expect(posts).toHaveLength(0);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('sends as before when the visitor sends without an agent', async () => {
    const { browser, page, posts } = await open();
    try {
      expect(await page.evaluate(agentSubmit(false))).toBe(true);
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0].request().postDataBuffer()?.toString()).toContain('Ana');
      await posts[0].fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      await expect.poll(() => page.inputValue('input[name="name"]')).toBe('');
      expect(await page.evaluate('window.claimed')).toBe(false);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
