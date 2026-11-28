/**
 * Pages served as plain HTML (#1754): a page that asks for it, and shows nothing that needs scripts, has a route module
 * saying `csr = false` in the website and `csr = true` in the editor's preview, and its head carries no script; any page
 * with something that needs scripts keeps them, and its author's preference, with the first reason. Cached generation
 * gives the same files as a full run at every step.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import type { ComponentDefinition, ElementNode, InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { GenerationCache } from '@generator/cache';
import { SCRIPTS_CLASS, defFile, generateProject, pageFile } from '@generator/index';
import { HYDRATED_PAGE_JS, STATIC_CODE, STATIC_PAGE_JS, staticHtmlReason, staticHtmlVerdict, staticPageIds, staticPageModule, staticRouteIds } from '@generator/static-pages';
import { sha256Hex } from '@shared/sha256';
import { withoutCodeMarkers } from '../../src/main/codecheck';
import { ownPageModule } from '../../src/main/project/page-module';
import { ProjectSession } from '../../src/main/project/session';
import { projectDesign } from './fixtures/packs';

const LANDING = 'pg_landing';
const MARKER = `<script>document.documentElement.classList.add("${SCRIPTS_CLASS}");</script>`;
const page = (id: string) => ({ kind: 'page' as const, id });
const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;

/** The business starter with a landing page: a centred hero, the shared footer, no header, asking for plain HTML. */
function landing(): ProjectState {
  let s = createStarterState('business', 'Plain Studio', false);
  s = run(s, { type: 'page.create', pageId: LANDING, title: 'Landing', route: '/landing/' });
  s = run(s, { type: 'node.insert', owner: page(LANDING), componentId: 'hero.centered', index: 0 } as EditOperation);
  return run(s, { type: 'page.update', pageId: LANDING, showHeader: false, preferStaticHtml: true });
}

const blocked = (s: ProjectState, pageId = LANDING) => {
  const v = staticHtmlVerdict(s, pageId);
  return v.static ? null : v;
};

/** Both kinds of generation through `cache`, each checked against a full run. */
function generated(state: ProjectState, cache: GenerationCache) {
  const out = { clean: new Map<string, string>(), dev: new Map<string, string>() };
  for (const [mode, opts] of [['clean', {}], ['dev', { instrument: true }]] as const) {
    const incremental = generateProject(state, opts, cache);
    expect([...incremental]).toEqual([...generateProject(state, opts)]);
    out[mode] = incremental;
  }
  return out;
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const GEN = '\0gen:';
/** The head the website prerenders for a route: its generated layout around its page, compiled for the server. */
async function renderedHead(files: Map<string, string>, routeId: string, route: string): Promise<string> {
  const entry = `export { render } from 'svelte/server';\nexport { createRawSnippet } from 'svelte';\nexport { default as Layout } from ${JSON.stringify(GEN + 'src/routes/+layout.svelte')};\nexport { default as Page } from ${JSON.stringify(GEN + route)};`;
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'generated-route',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation' || id === '$app/env') return `\0${id}`;
          if (importer?.startsWith(GEN) && id.startsWith('.')) {
            const path = posix.join(posix.dirname(importer.slice(GEN.length)), id);
            if (files.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0$app/paths') return "export const resolve = (p) => p; export const asset = (p) => '/' + p; export const base = '';";
          if (id === '\0$app/state') return `export const page = { route: { id: ${JSON.stringify(routeId)} }, url: new URL('https://site.test${routeId}/') };`;
          if (id === '\0$app/navigation') return 'export const afterNavigate = () => {}; export const onNavigate = () => {}; export const beforeNavigate = () => {}; export const snapshot = () => {};';
          if (id === '\0$app/env') return 'export const dev = false; export const building = true;';
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          if (path.endsWith('.css')) return { code: '', moduleType: 'js' };
          const source = files.get(path)!;
          if (!path.endsWith('.svelte')) return { code: source, moduleType: 'js' };
          return { code: compile(source, { filename: path, generate: 'server', runes: true, css: 'external' }).js.code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, ssr: true, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The route did not bundle');
  const dir = mkdtempSync(join(tmpdir(), 'so-static-route-'));
  roots.push(dir);
  const file = join(dir, 'route.mjs');
  writeFileSync(file, chunk.code);
  const mod = (await import(pathToFileURL(file).href)) as { render: (c: unknown, o: { props: Record<string, unknown> }) => { head: string; body: string }; createRawSnippet: (f: () => { render: () => string }) => unknown; Layout: unknown; Page: unknown };
  const body = mod.render(mod.Page, { props: {} }).body;
  const children = mod.createRawSnippet(() => ({ render: () => `<div>${body}</div>` }));
  return mod.render(mod.Layout, { props: { children } }).head;
}

describe('a page that asks for plain HTML', () => {
  it('is served without scripts while it shows nothing that needs them, its editor preview running them as ever', async () => {
    const s = landing();
    const module = staticPageModule(s.pages[LANDING]);
    expect(module).toBe('src/routes/landing/+page.js');
    expect(staticPageIds(s)).toEqual([LANDING]);
    expect(staticRouteIds(s)).toEqual(['/landing']);
    const clean = generateProject(s);
    const dev = generateProject(s, { instrument: true });
    expect(clean.get(module)).toBe(STATIC_PAGE_JS);
    expect(STATIC_PAGE_JS).toMatch(/^export const csr = false;$/m);
    // The editor's preview loads the same route module from its own copy, which runs the page's scripts.
    expect(dev.get(module)).toBe(HYDRATED_PAGE_JS);
    expect(HYDRATED_PAGE_JS).toMatch(/^export const csr = true;$/m);
    // No other page has one, and none is written for the Home page that did not ask.
    expect([...clean.keys()].filter((p) => p.endsWith('/+page.js') && p !== module && !p.includes('404'))).toEqual([]);
    // No script in app.html: the mark that a page's scripts run is the layout's, on every other route.
    expect(clean.get('src/app.html')).not.toContain('<script');
    expect(clean.get('src/routes/+layout.svelte')).toContain('const staticRoutes = new Set(["/landing"]);');
    expect(dev.get('src/routes/+layout.svelte')).not.toContain('staticRoutes');
    expect(dev.get('src/routes/+layout.svelte')).toContain(`<svelte:head>\n\t${MARKER}`);
    // As the website prerenders them: the landing page's head has no script at all, Home's marks it first thing.
    const plain = await renderedHead(clean, '/landing', pageFile(s.pages[LANDING]));
    expect(plain).not.toContain('<script');
    const home = await renderedHead(clean, '/', pageFile(s.pages[s.site.homePageId]));
    expect(home.replace(/<!--[\s\S]*?-->/g, '').trimStart().startsWith(MARKER)).toBe(true);
  }, 60_000);

  it('keeps its scripts, and the preference, while the page shows the header, and is plain again once it does not', () => {
    const cache = new GenerationCache();
    let s = landing();
    const module = staticPageModule(s.pages[LANDING]);
    let files = generated(s, cache);
    expect(files.clean.get(module)).toBe(STATIC_PAGE_JS);

    s = run(s, { type: 'page.update', pageId: LANDING, showHeader: true });
    expect(s.pages[LANDING].preferStaticHtml).toBe(true);
    const v = blocked(s)!;
    expect(v).toMatchObject({ blocker: 'code', part: 'header' });
    expect(staticHtmlReason(v)).toContain('in the shared header');
    files = generated(s, cache);
    expect(files.clean.has(module)).toBe(false);
    expect(files.dev.has(module)).toBe(false);
    expect(files.clean.get('src/routes/+layout.svelte')).not.toContain('staticRoutes');
    expect(files.clean.get('src/routes/+layout.svelte')).toContain(`\n\t${MARKER}\n`);

    s = run(s, { type: 'page.update', pageId: LANDING, showHeader: false });
    files = generated(s, cache);
    expect(files.clean.get(module)).toBe(STATIC_PAGE_JS);
    expect(files.clean.get('src/routes/+layout.svelte')).toContain('new Set(["/landing"])');

    // Turned off, the page loads its scripts and its document no longer carries the preference.
    s = run(s, { type: 'page.update', pageId: LANDING, preferStaticHtml: false });
    expect(Object.hasOwn(s.pages[LANDING], 'preferStaticHtml')).toBe(false);
    files = generated(s, cache);
    expect(files.clean.has(module)).toBe(false);
  });

  it('follows its route when it moves, and a copy keeps the preference', () => {
    let s = run(landing(), { type: 'page.update', pageId: LANDING, route: '/welcome/' });
    expect(generateProject(s).get('src/routes/welcome/+page.js')).toBe(STATIC_PAGE_JS);
    expect(generateProject(s).has('src/routes/landing/+page.js')).toBe(false);
    const copy = applyOperations(s, [{ type: 'page.duplicate', pageId: LANDING, title: 'Welcome again' }]);
    s = copy.state;
    const id = s.site.pageOrder.find((p) => p !== LANDING && s.pages[p].title === 'Welcome again')!;
    expect(s.pages[id].preferStaticHtml).toBe(true);
    expect(staticPageIds(s)).toEqual([LANDING, id]);
  });

  it('is never served as plain HTML while it is a draft, and takes a boolean only', () => {
    const s = run(landing(), { type: 'page.update', pageId: LANDING, draft: true });
    expect(blocked(s)).toMatchObject({ blocker: 'draft' });
    expect(generateProject(s).has('src/routes/landing/+page.js')).toBe(false);
    expect(validateOperation({ type: 'page.update', pageId: LANDING, preferStaticHtml: 'false' }).ok).toBe(false);
    expect(validateOperation({ type: 'page.update', pageId: LANDING, preferStaticHtml: false }).ok).toBe(true);
  });
});

describe('what keeps a page’s scripts', () => {
  /** The landing page with one more section of the theme's. */
  const withSection = (componentId: string, props: Record<string, unknown> = {}) => run(landing(), { type: 'node.insert', owner: page(LANDING), componentId, index: 1, props } as EditOperation);

  it('passes the theme’s own heroes and footer, by their code as it ships, and nothing else of the theme’s', () => {
    for (const hero of ['hero.split', 'hero.screenshot']) expect(blocked(withSection(hero))).toBeNull();
    expect(blocked(withSection('contact.form'))).toMatchObject({ blocker: 'form' });
    expect(blocked(withSection('site.search'))).toMatchObject({ blocker: 'search' });
    expect(blocked(withSection('media.video'))).toMatchObject({ blocker: 'video' });
    expect(blocked(withSection('tabs.showcase'))).toMatchObject({ blocker: 'code' });
    expect(blocked(withSection('pricing.toggle'))).toMatchObject({ blocker: 'code' });
  });

  it('holds each checked component to the code the theme ships, with and without the editor’s markers', async () => {
    const pack = JSON.parse(readFileSync('resources/packs/foundation/pack.json', 'utf8')) as { components: ComponentDefinition[] };
    for (const [id, [shipped, unmarked]] of Object.entries(STATIC_CODE)) {
      const source = pack.components.find((c) => c.id === id)!.source!;
      // A theme update that changes one of them fails here: look at the new code again before it counts.
      expect(sha256Hex(source), id).toBe(shipped);
      expect(sha256Hex(await withoutCodeMarkers(source)), id).toBe(unmarked);
    }
  });

  it('takes any edit to checked code as code it cannot vouch for, even one that keeps its name and ID', () => {
    const s = landing();
    const hero = Object.values(s.pages[LANDING].nodes).find((n) => n.kind === 'instance') as InstanceNode;
    const def = s.components[hero.definitionId];
    const edited = { ...s, components: { ...s.components, [def.id]: { ...def, source: def.source!.replace('</script>', '\n\t$effect(() => {});\n</script>') } } };
    expect(blocked(edited)).toMatchObject({ blocker: 'code', name: def.name });
    // As both exports read it, without the editor's markers, the same code is still the theme's.
    expect(STATIC_CODE['foundation.hero.centered']).toHaveLength(2);
  });

  it('keeps every page’s scripts for the Light/Dark switch and the search the site offers AI agents', () => {
    expect(blocked(run(landing(), { type: 'token.setColorScheme', mode: 'toggle' }))).toMatchObject({ blocker: 'theme-toggle' });
    const searching = run(landing(), { type: 'site.update', webmcp: true });
    expect(blocked(searching)).toBeNull();
    const home = searching.site.homePageId;
    const offered = run(searching, { type: 'node.insert', owner: page(home), componentId: 'site.search', index: 0 } as EditOperation);
    expect(blocked(offered)).toMatchObject({ blocker: 'search-tool' });
    // The site's own head code and integrations run on a page without SvelteKit's scripts as on any other.
    expect(blocked(run(landing(), { type: 'site.update', headCode: '<script src="https://stats.example/a.js" defer></script>' }))).toBeNull();
  });

  it('finds what needs scripts anywhere in a design: nested, in a slot or its fallback, on either side of a condition', () => {
    const base = landing();
    const note = projectDesign(base, {
      componentId: 'project.note',
      name: 'Note',
      properties: {},
      parts: { root: { nodeId: 'root', label: 'Note' } },
      build: (b) => b.el('root', 'section', {}, [b.el('inner', 'div', {}, [b.el('list', 'ul', {}, [])])])
    });
    let s = run(base, { type: 'node.insert', owner: page(LANDING), definitionId: note.id, index: 1 } as EditOperation);
    expect(blocked(s)).toBeNull();
    /** The state with the Note's design changed. */
    const design = (change: (d: ComponentDefinition) => void) => {
      const d = structuredClone(s.components[note.id]);
      change(d);
      return { ...s, components: { ...s.components, [note.id]: d } };
    };
    const el = (d: ComponentDefinition, id: string) => d.tree!.nodes[id] as ElementNode;
    expect(blocked(design((d) => (el(d, 'list').carousel = true)))).toMatchObject({ blocker: 'carousel', name: 'Note' });
    expect(blocked(design((d) => (el(d, 'inner').action = 'image')))).toMatchObject({ blocker: 'image-viewer' });
    expect(blocked(design((d) => (el(d, 'inner').action = { $prop: 'open' })))).toMatchObject({ blocker: 'image-viewer' });
    expect(blocked(design((d) => (el(d, 'inner').action = 'link')))).toBeNull();
    expect(blocked(design((d) => (el(d, 'inner').appear = 'fade')))).toMatchObject({ blocker: 'appear' });
    // A condition that hides it today still leaves it in the page's code.
    expect(blocked(design((d) => Object.assign(el(d, 'inner'), { when: { $prop: 'never' }, appear: 'fade' })))).toMatchObject({ blocker: 'appear' });
    expect(blocked(design((d) => (d.state = { open: { type: 'boolean', default: false } } as ComponentDefinition['state'])))).toMatchObject({ blocker: 'state' });
    expect(blocked(design((d) => (d.tree!.nodes.list = { id: 'list', kind: 'repeat', list: { $prop: 'items' }, children: [], filter: { field: 'kind' } })))).toMatchObject({ blocker: 'filter' });
    // A slot's fallback, shown while a placement gives it nothing.
    expect(
      blocked(
        design((d) => {
          d.tree!.nodes.list = { id: 'list', kind: 'slot', slot: 'extra', children: ['late'] };
          d.tree!.nodes.late = { id: 'late', kind: 'element', tag: 'div', children: [], appear: 'lift' } as ElementNode;
        })
      )
    ).toMatchObject({ blocker: 'appear' });
    // What a placement puts in a slot is checked in the page that puts it there.
    const placed = Object.values(s.pages[LANDING].nodes).find((n) => n.kind === 'instance' && n.definitionId === note.id) as InstanceNode;
    const slotted = structuredClone(s);
    (slotted.pages[LANDING].nodes[placed.id] as InstanceNode).slots = { extra: ['given'] };
    slotted.pages[LANDING].nodes.given = { id: 'given', kind: 'element', tag: 'ul', children: [], carousel: true } as ElementNode;
    expect(blocked(slotted)).toMatchObject({ blocker: 'carousel' });
    // A placement's own entrance.
    const entering = structuredClone(s);
    (entering.pages[LANDING].nodes[placed.id] as InstanceNode).appear = 'fade';
    expect(blocked(entering)).toMatchObject({ blocker: 'appear', name: 'Note' });

    // A design inside another: the inner one's state keeps the page's scripts, named as the inner one.
    const inner = projectDesign(s, { componentId: 'project.toggle', name: 'Toggle', properties: {}, parts: { root: { nodeId: 'root', label: 'Toggle' } }, build: (b) => b.el('root', 'div', {}, []) });
    s = { ...s, components: { ...s.components, [inner.id]: { ...inner, state: { open: { type: 'boolean', default: false } } as ComponentDefinition['state'] } } };
    const nested = design((d) => (d.tree!.nodes.list = { id: 'list', kind: 'instance', definitionId: inner.id, props: {} } as InstanceNode));
    expect(blocked(nested)).toMatchObject({ blocker: 'state', name: 'Toggle' });
    // A design that places itself, and one that names a component or node the project does not have.
    expect(blocked(design((d) => (d.tree!.nodes.list = { id: 'list', kind: 'instance', definitionId: note.id, props: {} } as InstanceNode)))).toMatchObject({ blocker: 'cycle' });
    expect(blocked(design((d) => (d.tree!.nodes.list = { id: 'list', kind: 'instance', definitionId: 'gone', props: {} } as InstanceNode)))).toMatchObject({ blocker: 'missing' });
    expect(blocked(design((d) => el(d, 'inner').children.push('nowhere')))).toMatchObject({ blocker: 'missing' });
    expect(blocked(design((d) => (d.tree!.nodes.list = { id: 'list', kind: 'widget' } as unknown as ElementNode)))).toMatchObject({ blocker: 'unknown' });
  });

  it('says why in words, naming the component and the shared part it is in', () => {
    expect(staticHtmlReason({ static: false, blocker: 'form', name: 'Contact form' })).toBe('‘Contact form’ needs JavaScript to send.');
    expect(staticHtmlReason({ static: false, blocker: 'code', part: 'header', name: 'Header' })).toBe('‘Header’ in the shared header may need JavaScript.');
    expect(staticHtmlReason({ static: false, blocker: 'appear', part: 'footer' })).toBe('The shared footer needs JavaScript for its entrance.');
    expect(staticHtmlReason({ static: false, blocker: 'carousel' })).toBe('Something on this page needs JavaScript for its carousel.');
    expect(staticHtmlReason({ static: false, blocker: 'draft' })).toBe('Drafts are left out of the website.');
  });
});

describe('a project’s own route module', () => {
  it('wins over the generated one: a TypeScript one beside it, or one at its path SiteOrigin Builder did not write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-page-module-'));
    roots.push(dir);
    mkdirSync(join(dir, 'src/routes/landing'), { recursive: true });
    const path = 'src/routes/landing/+page.js';
    expect(ownPageModule(dir, path, false)).toBe(false);
    writeFileSync(join(dir, path), 'export const ssr = true;\n');
    expect(ownPageModule(dir, path, false)).toBe(true);
    expect(ownPageModule(dir, path, true)).toBe(false);
    writeFileSync(join(dir, 'src/routes/landing/+page.ts'), 'export const prerender = true;\n');
    expect(ownPageModule(dir, path, true)).toBe(true);
  });

  it('keeps a page with one of its own on its own module, and serves no page as plain HTML while generated code is edited outside the app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-static-session-'));
    roots.push(dir);
    const s = await ProjectSession.create(dir, landing());
    const module = join(dir, 'src/routes/landing/+page.js');
    try {
      expect(readFileSync(module, 'utf8')).toBe(STATIC_PAGE_JS);
      expect(readFileSync(join(dir, '.siteorigin/cache/dev/src/routes/landing/+page.js'), 'utf8')).toBe(HYDRATED_PAGE_JS);

      // A TypeScript route module of the project's own: SvelteKit takes one, and it is that one.
      const own = join(dir, 'src/routes/landing/+page.ts');
      writeFileSync(own, 'export const prerender = true;\n');
      await s.apply({ operations: [{ type: 'page.update', pageId: LANDING, title: 'Landing page' }] }, { label: 'Rename' });
      expect(existsSync(module)).toBe(false);
      expect(existsSync(join(dir, '.siteorigin/cache/dev/src/routes/landing/+page.js'))).toBe(false);
      expect(readFileSync(own, 'utf8')).toBe('export const prerender = true;\n');
      expect(s.conflicts).toEqual([]);
      rmSync(own);
      await s.apply({ operations: [{ type: 'page.update', pageId: LANDING, title: 'Landing' }] }, { label: 'Rename' });
      expect(readFileSync(module, 'utf8')).toBe(STATIC_PAGE_JS);

      // The hero's generated code edited outside the app: what the edit runs is not in the documents.
      const hero = Object.values(s.state.pages[LANDING].nodes).find((n) => n.kind === 'instance') as InstanceNode;
      const heroPath = defFile(s.state.components[hero.definitionId]);
      const heroFile = join(dir, heroPath);
      const generatedHero = readFileSync(heroFile, 'utf8');
      writeFileSync(heroFile, generatedHero.replace('</script>', "\n\timport { onMount } from 'svelte';\n\tonMount(() => console.log('hi'));\n</script>"));
      await s.apply({ operations: [{ type: 'page.update', pageId: LANDING, title: 'Landing again' }] }, { label: 'Rename' });
      expect(s.conflicts.map((c) => c.path)).toContain(heroPath);
      expect(existsSync(module)).toBe(false);
      // Restored, the page is plain again.
      writeFileSync(heroFile, generatedHero);
      await s.apply({ operations: [{ type: 'page.update', pageId: LANDING, title: 'Landing' }] }, { label: 'Rename' });
      expect(readFileSync(module, 'utf8')).toBe(STATIC_PAGE_JS);
    } finally {
      await s.close();
    }
  });
});
