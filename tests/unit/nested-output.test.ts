/**
 * Generated output for nested components, forms and fonts (#94): each case is checked in the generated site as
 * visitors get it (server-rendered, and in a browser where the cascade decides), or in the editor's variant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { chromium, type Browser } from 'playwright';
import type { ComponentDefinition, InstanceNode, ListItem, ListProp, PageDoc, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState } from '@engine/validate';
import { formNameWarnings, runtimeFontWarnings } from '../../src/main/export';
import { choosesFontAtRunTime, installedFonts } from '@catalogue/fonts';
import { generateProject, nodeClass, pageFile } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { codeImportantProps } from '@engine/tree';
import { definitionPick, descOf, selectionFromChain, shownValue, type BridgeDesc } from '../../src/renderer/src/lib/model';
import { P, item, prop, type ComponentSpec } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';

const { managed } = FOUNDATION;
const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const pageOwner = (s: ProjectState, pageId = s.site.homePageId) => ({ kind: 'page' as const, id: pageId });
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);

/** A project component built with the catalogue helpers, installed into the project. */
function addDef(s: ProjectState, spec: Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'>): ComponentDefinition {
  const def = { ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', ...spec }), owner: 'project' as const };
  s.components[def.id] = def;
  return def;
}

/** Place a component at the end of a page's own content (Home by default). */
function place(s: ProjectState, def: ComponentDefinition, props: Record<string, unknown> = {}, page: PageDoc = home(s)): InstanceNode {
  const node = makeInstance(def, props);
  page.nodes[node.id] = node;
  page.rootIds.push(node.id);
  return node;
}

/** Put a component inside a design, as the last child of one of its elements. */
function nest(def: ComponentDefinition, parentId: string, child: ComponentDefinition, props: Record<string, unknown> = {}): InstanceNode {
  const node = makeInstance(child, props);
  def.tree!.nodes[node.id] = node;
  const parent = def.tree!.nodes[parentId];
  if (parent.kind !== 'element' && parent.kind !== 'repeat') throw new Error(`${parentId} holds no children`);
  parent.children.push(node.id);
  return node;
}

function compileErrors(s: ProjectState): string[] {
  const out: string[] = [];
  for (const instrument of [false, true]) {
    for (const [path, source] of generateProject(s, { instrument })) {
      if (!path.endsWith('.svelte')) continue;
      for (const generate of ['server', 'client'] as const) {
        try {
          compile(source, { filename: path, generate, runes: true });
        } catch (e) {
          out.push(`${path} (${generate}${instrument ? ', editor' : ''}): ${(e as Error).message}`);
        }
      }
    }
  }
  return out;
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The cascade is the browser's to decide: cases that depend on it run where Playwright's Chromium is installed. */
const BROWSER = existsSync(chromium.executablePath());
let browser: Browser | undefined;
beforeAll(async () => {
  if (BROWSER) browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** Computed styles of the elements a selector finds, in a browser at the given width, on a rendered page. */
async function computed(page: { body: string; css: string }, selector: string, props: string[], width = 1200): Promise<Array<Record<string, string>>> {
  const tab = await browser!.newPage({ viewport: { width, height: 800 } });
  try {
    await tab.setContent(`<!doctype html><html><head><style>${page.css}</style></head><body>${page.body}</body></html>`);
    // A string, as the browser runs it: these tests compile without the DOM's types.
    return (await tab.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => Object.fromEntries(${JSON.stringify(props)}.map((n) => [n, getComputedStyle(el).getPropertyValue(n)])))`)) as Array<Record<string, string>>;
  } finally {
    await tab.close();
  }
}

/**
 * Server-render one page of the generated site (the exported one, or the editor's variant): its head, its body,
 * and the stylesheets a visitor gets with it (the site's sheets, then each component's own scoped styles).
 */
async function renderPage(s: ProjectState, page: PageDoc = home(s), opts: { instrument?: boolean } = {}): Promise<{ head: string; body: string; css: string }> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'nested-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  const files = generateProject(s, { instrument: !!opts.instrument });
  const sheets: string[] = [];
  for (const [path, source] of files) {
    if (/^src\/lib\/siteorigin\/styles\/.+\.css$/.test(path)) sheets.push(source);
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    let code = source;
    if (path.endsWith('.svelte')) {
      const result = compile(source, { filename: path, generate: 'server', runes: true, css: 'external' });
      code = result.js.code;
      if (result.css?.code) sheets.push(result.css.code);
    }
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
        .replace(/^\s*import\s+['"][^'"]+\.css['"];?\s*$/gm, '')
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, `${pageFile(page)}.js`))).default as Component<Record<string, unknown>>;
  const { head, body } = render(Page, { props: {} });
  const clean = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');
  return { head: clean(head), body: clean(body), css: sheets.join('\n') };
}

// ---------------------------------------------------------------------------
// Convert to code: a property named `class`
// ---------------------------------------------------------------------------

/** An older project component with a property named `class` (new ones cannot have one), shown and tested. */
function classDef(s: ProjectState) {
  return addDef(s, {
    componentId: 'project.badge',
    name: 'Badge',
    properties: { class: P.str('Class', 'Standard'), note: P.str('Note', 'Note') },
    parts: { root: { nodeId: 'root', label: 'Badge' } },
    build: (b) => b.el('root', 'div', { name: 'Badge' }, [b.text('value', 'p', prop('class'), { name: 'Value', when: prop('class') }), b.text('note', 'p', prop('note'))])
  });
}

describe('converting a component with a property named class to code', () => {
  it('renames a list field named class too, so the converted manifest can be saved again', async () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'project.tags',
      name: 'Tags',
      properties: { tags: P.list('Tags', 'Tag', { class: P.str('Class', 'Plain'), label: P.str('Label', 'Tag') }, [{ class: 'Gold', label: 'One' }], { titleField: 'class' }) },
      parts: { root: { nodeId: 'root', label: 'Tags' } },
      build: (b) => b.el('root', 'ul', { name: 'Tags' }, [b.repeat('tag-items', 'tags', [b.text('tag', 'span', item('class'), { name: 'Tag', when: item('class') })])])
    });
    // A saved item still holds a stale key the new name must not take.
    const node = place(s, def);
    node.props = { tags: [{ id: 't1', class: 'Silver', label: 'A', classValue: 'Old' }] };
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: pageOwner(s), nodeId: node.id, name: 'Tags code' }]);
    const code = r.state.components[r.results[0].definitionId as string];
    const tags = code.properties.tags as ListProp;
    expect(Object.keys(tags.fields)).toEqual(['classValue2', 'label']);
    expect(tags.titleField).toBe('classValue2');
    expect((tags.default as ListItem[]).map((t) => t.classValue2)).toEqual(['Gold']);
    expect((home(r.state).nodes[node.id] as InstanceNode).props.tags).toEqual([{ id: 't1', classValue2: 'Silver', label: 'A', classValue: 'Old' }]);
    expect(compileErrors(r.state)).toEqual([]);
    expect((await renderPage(r.state)).body).toMatch(/<span[^>]*>Silver<\/span>/);
    // Saving the manifest again, with a label changed, is accepted.
    const relabelled = { ...code.properties, tags: { ...tags, label: 'Labels' } };
    expect(() => applyOperations(r.state, [{ type: 'component.updateSource', definitionId: code.id, source: code.source!, properties: relabelled as Record<string, unknown> }])).not.toThrow();
  });

  it('leaves the fields of a list the design around it hands on, whose rows keep their keys', async () => {
    const s = fresh();
    const tags = addDef(s, {
      componentId: 'project.tags',
      name: 'Tags',
      properties: { tags: P.list('Tags', 'Tag', { class: P.str('Class', 'Plain') }, [{ class: 'Plain' }]) },
      parts: { root: { nodeId: 'root', label: 'Tags' } },
      build: (b) => b.el('root', 'div', { name: 'Tags' }, [b.repeat('tag-items', 'tags', [b.text('tag', 'span', item('class'), { name: 'Tag', when: item('class') })])])
    });
    const outer = addDef(s, {
      componentId: 'project.shelf',
      name: 'Shelf',
      properties: { rows: P.list('Rows', 'Row', { class: P.str('Class', 'Plain') }, [{ class: 'Gold' }]) },
      parts: { root: { nodeId: 'root', label: 'Shelf' } },
      build: (b) => b.el('root', 'section', { name: 'Shelf' }, [])
    });
    const inner = nest(outer, 'root', tags, { tags: prop('rows') });
    place(s, outer);
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'component', id: outer.id }, nodeId: inner.id, name: 'Tags code' }]);
    expect(Object.keys((r.state.components[r.results[0].definitionId as string].properties.tags as ListProp).fields)).toEqual(['class']);
    expect(compileErrors(r.state)).toEqual([]);
    expect((await renderPage(r.state)).body).toMatch(/<span[^>]*>Gold<\/span>/);
  });

  it('leaves the fields of a list it hands whole to a component inside it, which reads their keys', async () => {
    const s = fresh();
    const tags = addDef(s, {
      componentId: 'project.tags',
      name: 'Tags',
      properties: { tags: P.list('Tags', 'Tag', { class: P.str('Class', 'Plain') }, [{ class: 'Plain' }]) },
      parts: { root: { nodeId: 'root', label: 'Tags' } },
      build: (b) => b.el('root', 'div', { name: 'Tags' }, [b.repeat('tag-items', 'tags', [b.text('tag', 'span', item('class'), { name: 'Tag', when: item('class') })])])
    });
    const outer = addDef(s, {
      componentId: 'project.shelf',
      name: 'Shelf',
      properties: { rows: P.list('Rows', 'Row', { class: P.str('Class', 'Plain') }, [{ class: 'Gold' }]) },
      parts: { root: { nodeId: 'root', label: 'Shelf' } },
      build: (b) => b.el('root', 'section', { name: 'Shelf' }, [])
    });
    nest(outer, 'root', tags, { tags: prop('rows') });
    const placed = place(s, outer);
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: pageOwner(s), nodeId: placed.id, name: 'Shelf code' }]);
    expect(Object.keys((r.state.components[r.results[0].definitionId as string].properties.rows as ListProp).fields)).toEqual(['class']);
    expect(compileErrors(r.state)).toEqual([]);
    expect((await renderPage(r.state)).body).toMatch(/<span[^>]*>Gold<\/span>/);
  });

  it('keeps the value a placement gives, whatever stale key its saved values hold', async () => {
    const s = fresh();
    const def = classDef(s);
    const node = place(s, def, { class: 'Premium' });
    node.props = { class: 'Premium', classValue: 'Old', note: 'Note' };
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: pageOwner(s), nodeId: node.id, name: 'Badge code' }]);
    expect(Object.keys(r.state.components[r.results[0].definitionId as string].properties)).toEqual(['classValue2', 'note']);
    expect((await renderPage(r.state)).body).toMatch(/<p[^>]*>Premium<\/p>/);
  });

  it('moves the property to a name of its own, so the site compiles and still shows the value', async () => {
    const s = fresh();
    const def = classDef(s);
    const node = place(s, def, { class: 'Premium' });
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: pageOwner(s), nodeId: node.id, name: 'Badge code' }]);
    const t = r.state;
    const code = t.components[r.results[0].definitionId as string];
    expect(Object.keys(code.properties)).toEqual(['classValue', 'note']);
    expect(code.properties.classValue).toEqual(def.properties.class);
    expect((home(t).nodes[node.id] as InstanceNode).props).toEqual({ classValue: 'Premium', note: 'Note' });
    // The original keeps its own property for its other placements.
    expect(Object.keys(t.components[def.id].properties)).toEqual(['class', 'note']);
    expect(compileErrors(t)).toEqual([]);
    expect(errors(t)).toEqual([]);
    const { body } = await renderPage(t);
    expect(body).toMatch(/<p[^>]*>Premium<\/p>/);
    // A placement style still reaches the root through `class`, beside the value.
    const styled = applyOperations(t, [{ type: 'node.setStyle', owner: pageOwner(t), nodeId: node.id, scope: 'base', property: 'color', value: '#123456' }]).state;
    expect(compileErrors(styled)).toEqual([]);
    const after = await renderPage(styled);
    expect(after.body).toMatch(/<p[^>]*>Premium<\/p>/);
    expect(after.body).toMatch(/class="[^"]*so-o-/);
  });

  it('rebinds a design that hands the property on, and avoids a name another property has', async () => {
    const s = fresh();
    const def = classDef(s);
    def.properties.classValue = P.str('Taken', 'Taken');
    const outer = addDef(s, {
      componentId: 'project.panel',
      name: 'Panel',
      properties: { label: P.str('Label', 'Gold') },
      parts: { root: { nodeId: 'root', label: 'Panel' } },
      build: (b) => b.el('root', 'section', { name: 'Panel' }, [])
    });
    const inner = nest(outer, 'root', def, { class: prop('label'), note: 'Inside' });
    place(s, outer, { label: 'Gold' });
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'component', id: outer.id }, nodeId: inner.id, name: 'Badge code' }]);
    const t = r.state;
    const code = t.components[r.results[0].definitionId as string];
    expect(Object.keys(code.properties).sort()).toEqual(['classValue', 'classValue2', 'note']);
    expect(t.components[outer.id].tree!.nodes[inner.id]).toMatchObject({ props: { classValue2: { $prop: 'label' }, note: 'Inside' } });
    expect(code.source).toContain('classValue2');
    expect(compileErrors(t)).toEqual([]);
    expect(errors(t)).toEqual([]);
    expect((await renderPage(t)).body).toMatch(/<p[^>]*>Gold<\/p>/);
  });
});

// ---------------------------------------------------------------------------
// Variant styles and a placement of the same component inside
// ---------------------------------------------------------------------------

/** A component with a slot whose "Loud" tone styles an inner text, not its root. */
function tonedDef(s: ProjectState) {
  return addDef(s, {
    componentId: 'project.toned',
    name: 'Toned',
    properties: { lead: P.str('Lead', 'Lead') },
    parts: { root: { nodeId: 'root', label: 'Box' }, lead: { nodeId: 'lead', label: 'Lead' } },
    slots: { content: { label: 'Content' } },
    variantAxes: {
      tone: { label: 'Tone', default: 'plain', options: { plain: { label: 'Plain' }, loud: { label: 'Loud', styles: { lead: { base: { color: '#ff0000', opacity: 0.5 } } } } } },
      size: { label: 'Size', default: 'regular', options: { regular: { label: 'Regular' }, big: { label: 'Big', styles: { lead: { base: { fontSize: '40px' } } } } } }
    },
    build: (b) => b.el('root', 'div', { name: 'Box' }, [b.text('lead', 'p', prop('lead'), { name: 'Lead' }), b.slot('content-slot', 'content')])
  });
}

/** The selector of the toned component's inner text, in every placement. */
const leadsOf = (def: ComponentDefinition) => `.${nodeClass(def, 'lead')}`;

/** Placements of a component one inside another's slot, outermost first, each with its own options. */
function nested(s: ProjectState, def: ComponentDefinition, options: Array<Record<string, string>>): InstanceNode[] {
  const nodes = options.map((variants, i) => {
    const n = makeInstance(def, { lead: `Lead ${i + 1}` });
    n.variants = variants;
    home(s).nodes[n.id] = n;
    return n;
  });
  home(s).rootIds.push(nodes[0].id);
  nodes.forEach((n, i) => nodes[i + 1] && (n.slots = { content: [nodes[i + 1].id] }));
  return nodes;
}

describe.runIf(BROWSER)('variant styles of a component placed inside itself', () => {
  it('keeps each placement to its own options, whichever way round they are', async () => {
    const s = fresh();
    const def = tonedDef(s);
    nested(s, def, [{ tone: 'loud', size: 'big' }, { tone: 'plain', size: 'regular' }, { tone: 'loud', size: 'regular' }]);
    expect(compileErrors(s)).toEqual([]);
    const page = await renderPage(s);
    const leads = await computed(page, leadsOf(def), ['color', 'opacity', 'font-size']);
    expect(page.body.match(/>Lead \d</g)).toEqual(['>Lead 1<', '>Lead 2<', '>Lead 3<']);
    expect(leads[0]).toMatchObject({ color: 'rgb(255, 0, 0)', opacity: '0.5', 'font-size': '40px' });
    expect(leads[1].color).not.toBe('rgb(255, 0, 0)');
    expect(leads[1].opacity).toBe('1');
    expect(leads[1]['font-size']).not.toBe('40px');
    expect(leads[2]).toMatchObject({ color: 'rgb(255, 0, 0)', opacity: '0.5' });
    expect(leads[2]['font-size']).not.toBe('40px');
  });

  it('keeps them apart in a copy converted to code, which carries its own styles', async () => {
    const s = fresh();
    const def = tonedDef(s);
    const [outer, inner] = nested(s, def, [{ tone: 'loud' }, { tone: 'plain' }]);
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: pageOwner(s), nodeId: outer.id, name: 'Toned code' }]);
    const code = r.state.components[r.results[0].definitionId as string];
    // The copy placed inside itself, too.
    (home(r.state).nodes[inner.id] as InstanceNode).definitionId = code.id;
    expect(compileErrors(r.state)).toEqual([]);
    const leads = await computed(await renderPage(r.state), leadsOf(code), ['color', 'opacity']);
    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatchObject({ color: 'rgb(255, 0, 0)', opacity: '0.5' });
    expect(leads[1].color).not.toBe('rgb(255, 0, 0)');
    expect(leads[1].opacity).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Overrides of what a code component renders
// ---------------------------------------------------------------------------

/** A code component whose own styles use an id and a descendant chain, with a Title part. */
const FANCY_SOURCE = `<script>
	let { title = 'Title', so_o = undefined, class: className = '' } = $props();
</script>

<div id="box" class={['fancy', className]}>
	<h3 class={['title', so_o?.title]}>{title}</h3>
</div>

<style>
	#box.fancy .title { color: rgb(255, 0, 0); }
	#box.fancy { background-color: rgb(0, 0, 255); }
</style>
`;

function fancyDef(s: ProjectState): { state: ProjectState; def: ComponentDefinition } {
  const r = applyOperations(s, [{ type: 'component.createCode', name: 'Fancy', source: FANCY_SOURCE, properties: { title: { type: 'string', label: 'Title', default: 'Title' } } }]);
  const def = r.state.components[r.results[0].definitionId as string];
  def.parts.title = { nodeId: 'title', label: 'Title', styleControls: ['color', 'textStyle'] };
  return { state: r.state, def };
}

/** A project design that places the given code component, under the same node ID every such design uses. */
function holder(s: ProjectState, name: string, code: ComponentDefinition, overrides: InstanceNode['overrides']): ComponentDefinition {
  const def = addDef(s, {
    componentId: `project.${name.toLowerCase()}`,
    name,
    properties: {},
    parts: { root: { nodeId: 'root', label: name } },
    build: (b) => b.el('root', 'section', { name }, [])
  });
  const inner = { ...makeInstance(code, { title: `${name} title` }), id: 'n_fancy', overrides };
  def.tree!.nodes[inner.id] = inner;
  (def.tree!.nodes.root as { children: string[] }).children.push(inner.id);
  return def;
}

describe.runIf(BROWSER)('overrides of a code component', () => {
  it('win over its own scoped styles however specific they are, at every size', async () => {
    const { state: s, def } = fancyDef(fresh());
    const node = place(s, def, { title: 'Placed' });
    const t = applyOperations(s, [
      { type: 'node.setStyle', owner: pageOwner(s), nodeId: node.id, partId: 'title', scope: 'base', property: 'color', value: '#00ff00' },
      { type: 'node.setStyle', owner: pageOwner(s), nodeId: node.id, partId: 'title', scope: 'phone', property: 'color', value: '#ffff00' },
      { type: 'node.setStyle', owner: pageOwner(s), nodeId: node.id, partId: 'root', scope: 'base', property: 'background', value: '#00ff00' }
    ]).state;
    expect(compileErrors(t)).toEqual([]);
    const page = await renderPage(t);
    expect(await computed(page, '#box', ['background-color'])).toEqual([{ 'background-color': 'rgb(0, 255, 0)' }]);
    expect(await computed(page, '#box .title', ['color'])).toEqual([{ color: 'rgb(0, 255, 0)' }]);
    expect(await computed(page, '#box .title', ['color'], 390)).toEqual([{ color: 'rgb(255, 255, 0)' }]);
    // The editor's canvas gets the same rules.
    const dev = await renderPage(t, home(t), { instrument: true });
    expect(await computed(dev, '#box .title', ['color'])).toEqual([{ color: 'rgb(0, 255, 0)' }]);
  });

  it('reach its inner parts where it sits in another design, each design its own', async () => {
    const { state: s, def: code } = fancyDef(fresh());
    const green = holder(s, 'Green', code, { title: { base: { color: '#00ff00' } }, root: { base: { background: '#00ff00' } } });
    const blue = holder(s, 'Blue', code, { title: { base: { color: '#0000ff' } } });
    place(s, green);
    place(s, blue);
    expect(compileErrors(s)).toEqual([]);
    expect(errors(s)).toEqual([]);
    for (const instrument of [false, true]) {
      const page = await renderPage(s, home(s), { instrument });
      expect(await computed(page, '#box .title', ['color'])).toEqual([{ color: 'rgb(0, 255, 0)' }, { color: 'rgb(0, 0, 255)' }]);
      expect((await computed(page, '#box', ['background-color'])).map((c) => c['background-color'])).toEqual(['rgb(0, 255, 0)', 'rgb(0, 0, 255)']);
    }
    // A design converted to code keeps its override of the part.
    const placed = Object.values(home(s).nodes).find((n) => n.kind === 'instance' && n.definitionId === green.id)!;
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: pageOwner(s), nodeId: placed.id, name: 'Green code' }]);
    expect(compileErrors(r.state)).toEqual([]);
    expect((await computed(await renderPage(r.state), '#box .title', ['color']))[0]).toEqual({ color: 'rgb(0, 255, 0)' });
  });

  it('win from the page over the design, through a design whose root places the code component', async () => {
    const { state: s, def: code } = fancyDef(fresh());
    const wrapper = holder(s, 'Wrapper', code, { root: { base: { background: '#0000ff' } } });
    // The wrapper's root is the placed code component itself.
    wrapper.tree = { rootIds: ['n_fancy'], nodes: { n_fancy: wrapper.tree!.nodes.n_fancy } };
    const panel = addDef(s, { componentId: 'project.panel2', name: 'Panel', properties: {}, parts: { root: { nodeId: 'root', label: 'Panel' }, wrapper: { nodeId: 'n_wrap', label: 'Wrapper' } }, build: (b) => b.el('root', 'section', { name: 'Panel' }, []) });
    const inner = { ...makeInstance(wrapper, {}), id: 'n_wrap' };
    panel.tree!.nodes[inner.id] = inner;
    (panel.tree!.nodes.root as { children: string[] }).children.push(inner.id);
    place(s, panel).overrides = { wrapper: { base: { background: '#ff0000' } } };
    expect(compileErrors(s)).toEqual([]);
    expect(await computed(await renderPage(s), '#box', ['background-color'])).toEqual([{ 'background-color': 'rgb(255, 0, 0)' }]);
  });

  it('leave the theme’s print rules their say, whose weighting ids no anchor may take', async () => {
    const t = fresh();
    const hero = home(t).rootIds[0];
    for (const id of ['so-print', 'so-motion', 'so-editor'])
      expect(() => applyOperations(t, [{ type: 'node.setContent', owner: pageOwner(t), nodeId: hero, field: 'anchor', value: id }])).toThrow(/used by the site itself/);
    const files = generateProject(t);
    const css = `${files.get('src/lib/siteorigin/styles/theme.css')}\n.so-o-a.so-o-a.so-o-a.so-o-a.so-o-a { display: flex !important; position: sticky !important; }`;
    const tab = await browser!.newPage();
    try {
      await tab.setContent(`<!doctype html><html><head><style>${css}</style></head><body><header class="so-header so-o-a"><nav class="so-header__nav so-o-a">Menu</nav></header></body></html>`);
      await tab.emulateMedia({ media: 'print' });
      expect(await tab.evaluate(`[getComputedStyle(document.querySelector('nav')).display, getComputedStyle(document.querySelector('header')).position]`)).toEqual(['none', 'static']);
    } finally {
      await tab.close();
    }
  });

  it('give way to a visitor who asks for less motion, delay included', async () => {
    const { state: s, def } = fancyDef(fresh());
    const node = place(s, def, { title: 'Placed' });
    node.overrides = { title: { base: { transition: 'common', transitionDuration: 2000, customCss: 'transition-delay: 2s' } } };
    const page = await renderPage(s);
    const tab = await browser!.newPage();
    try {
      await tab.emulateMedia({ reducedMotion: 'reduce' });
      await tab.setContent(`<!doctype html><html><head><style>${page.css}</style></head><body>${page.body}</body></html>`);
      const [duration, delay] = (await tab.evaluate(`[getComputedStyle(document.querySelector('#box .title')).transitionDuration, getComputedStyle(document.querySelector('#box .title')).transitionDelay]`)) as string[];
      expect(parseFloat(duration)).toBeLessThan(0.001);
      expect(delay).toBe('0s');
    } finally {
      await tab.close();
    }
  });

  it('can be set on the inner part of one placed in a design', () => {
    const { state: s, def: code } = fancyDef(fresh());
    const green = holder(s, 'Green', code, undefined);
    const t = applyOperations(s, [{ type: 'node.setStyle', owner: { kind: 'component', id: green.id }, nodeId: 'n_fancy', partId: 'title', scope: 'base', property: 'color', value: '#00ff00' }]).state;
    const css = generateProject(t).get('src/lib/siteorigin/styles/components.css')!;
    expect(css).toMatch(/\.so-o-[^{]*--n_fancy-title[^{]*\{\n\tcolor: #00ff00 !important;/);
  });
});

describe.runIf(BROWSER)('styles of one item for a code component placed in a list', () => {
  it('beat the styles every item shares, which are important too', async () => {
    const { s, placed } = team();
    const people = placed.props.people as Array<{ id: string }>;
    placed.overrides = { chip: { base: { color: '#00ff00' } } };
    placed.itemOverrides = { chip: { list: 'people', items: { [people[1].id]: { base: { color: '#0000ff' } } } } };
    expect(compileErrors(s)).toEqual([]);
    const chips = await computed(await renderPage(s), '.chip', ['color']);
    expect(chips.map((c) => c.color)).toEqual(['rgb(0, 255, 0)', 'rgb(0, 0, 255)', 'rgb(0, 255, 0)']);
  });
});

describe('what an override of a code component cannot beat', () => {
  it('names the properties its own styles mark important, for the Inspector to explain', () => {
    const { def } = fancyDef(fresh());
    expect(codeImportantProps(def)).toEqual([]);
    const strong = { ...def, source: `${def.source}<style>\n\t/* color: blue !important */\n\ta:hover { Color: red !important; background: url(x:y) ! important }\n\t.b { padding: 0 }\n</style>\n` };
    expect(codeImportantProps(strong)).toEqual(['background', 'color']);
    expect(codeImportantProps({ ...def, source: '<style>p { font-family: "A", serif !important; }</style>' })).toEqual(['font-family']);
    // Inline styles in its markup count; its scripts do not.
    expect(codeImportantProps({ ...def, source: `<script>const x = 'margin: 0 !important';</script>\n<div style="padding: 4px !important">x</div>` })).toEqual(['padding']);
    expect(codeImportantProps({ ...strong, kind: 'managed' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Components placed in a repeated list, on the editor's canvas
// ---------------------------------------------------------------------------

/** A "Team" design that repeats a managed Badge and a code Chip once per person, both declared as its parts. */
function team() {
  const base = fresh();
  const r = applyOperations(base, [{ type: 'component.createCode', name: 'Chip', source: '<script>\n\tlet { label = \'\', class: className = \'\' } = $props();\n</script>\n\n<span class={[\'chip\', className]}>{label}</span>\n', properties: { label: { type: 'string', label: 'Label', default: '' } } }]);
  const s = r.state;
  const chip = s.components[r.results[0].definitionId as string];
  const badge = addDef(s, {
    componentId: 'project.badge',
    name: 'Badge',
    properties: { label: P.str('Label', 'Label') },
    parts: { root: { nodeId: 'root', label: 'Badge' } },
    build: (b) => b.el('root', 'div', { name: 'Badge' }, [b.text('label', 'span', prop('label'), { name: 'Label' })])
  });
  const people = [{ id: 'p1', name: 'Ann' }, { id: 'p2', name: 'Bo' }, { id: 'p3', name: 'Cy' }];
  const def = addDef(s, {
    componentId: 'project.team',
    name: 'Team',
    properties: { people: P.list('People', 'Person', { name: P.str('Name', 'Name') }, people) },
    parts: { root: { nodeId: 'root', label: 'Team' }, card: { nodeId: 'card', label: 'Card' }, badge: { nodeId: 'badge', label: 'Badge' }, chip: { nodeId: 'chip', label: 'Chip' } },
    build: (b) => b.el('root', 'ul', { name: 'Team' }, [b.repeat('people-items', 'people', [b.el('card', 'li', { name: 'Card' }, [])])])
  });
  for (const [id, child] of [['badge', badge], ['chip', chip]] as const) {
    const n = { ...makeInstance(child, { label: item('name') }), id };
    def.tree!.nodes[id] = n;
    (def.tree!.nodes.card as { children: string[] }).children.push(id);
  }
  const placed = place(s, def, { people });
  return { s, def, badge, placed, owner: pageOwner(s) };
}

/** What the bridge reports for a click: every marked element from the one hit up, innermost first. */
const CHAIN = `(el) => { const out = []; for (let e = el; e && e !== document.documentElement; e = e.parentElement) if (e.hasAttribute('data-so-node')) out.push({ ctx: e.getAttribute('data-so-ctx') || '', node: e.getAttribute('data-so-node') || '', items: e.getAttribute('data-so-items') || '', code: e.hasAttribute('data-so-code') }); return out; }`;
/** The bridge's own lookup of the elements a descriptor names (bridge.client.js findAll), with their text. */
const FIND = `(desc) => [...document.querySelectorAll('[data-so-ctx="' + CSS.escape(desc.ctx) + '"][data-so-node="' + CSS.escape(desc.node) + '"]')].filter((el) => !desc.items || (el.getAttribute('data-so-items') || '') === desc.items).map((el) => el.textContent.trim())`;

describe('a component placed in a repeated list, in the editor', () => {
  it('passes each item to the placement only in the editor variant', () => {
    const { s, def, badge } = team();
    // A design whose root is itself a placement hands on the items it was placed in.
    const wrap = addDef(s, { componentId: 'project.wrap', name: 'Wrap', properties: {}, parts: { root: { nodeId: 'root', label: 'Wrap' } }, build: (b) => b.el('scratch', 'div', {}, []) });
    const inner = { ...makeInstance(badge, {}), id: 'root' };
    wrap.tree = { rootIds: ['root'], nodes: { root: inner } };
    expect([...generateProject(s, { instrument: true }).entries()].find(([k]) => k.includes('project-wrap'))![1]).toContain('__so_at={__so_at}');
    delete s.components[wrap.id];
    const dev = generateProject(s, { instrument: true });
    const team_ = dev.get(`src/lib/siteorigin/generated/${def.id.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.svelte`) ?? [...dev.entries()].find(([k]) => k.includes('project-team'))![1];
    // Item IDs are escaped as the rest of the editor's item paths are, so one with a comma stays one item.
    const at = "[(item.id + '').replaceAll('%', '%25').replaceAll(',', '%2C')].join(',')";
    expect(team_).toContain(`__so_at={${at}}`);
    expect(team_).toContain(`data-so-node="chip" data-so-items={${at}} data-so-code="true"`);
    const badgeFile = [...dev.entries()].find(([k]) => k.includes('project-badge'))![1];
    expect(badgeFile).toContain('data-so-items={__so_at || undefined}');
    for (const [path, content] of generateProject(s)) expect(content.includes('__so_at'), path).toBe(false);
    expect(compileErrors(s)).toEqual([]);
  });

  it.runIf(BROWSER)('selects the placement in the item clicked, and finds only that one', async () => {
    const { s, def, placed, owner } = team();
    const second = (placed.props.people as Array<{ id: string }>)[1].id;
    const page = await renderPage(s, home(s), { instrument: true });
    const tab = await browser!.newPage();
    try {
      await tab.setContent(`<!doctype html><html><body>${page.body}</body></html>`);
      const chainAt = async (selector: string) => (await tab.$$eval(selector, (els, fn) => (0, eval)(fn)(els[1]), CHAIN)) as BridgeDesc[];
      const find = async (desc: BridgeDesc) => (await tab.evaluate(`(${FIND})(${JSON.stringify(desc)})`)) as string[];
      for (const [selector, part] of [[`[data-so-node="label"][data-so-ctx$="|badge"]`, 'badge'], [`[data-so-node="root"][data-so-ctx$="|badge"]`, 'badge'], ['.chip', 'chip']] as const) {
        const chain = await chainAt(selector);
        // Straight to the innermost level, or one level per click: the section, the card, then the component.
        const click1 = selectionFromChain(s, chain, null, false)!;
        expect(click1).toEqual({ owner, instancePath: [], nodeId: placed.id });
        const click2 = selectionFromChain(s, chain, click1, false)!;
        expect(click2).toMatchObject({ nodeId: 'card', itemPath: [second] });
        const deep = selectionFromChain(s, chain, click2, false);
        expect(deep).toEqual({ owner, instancePath: [placed.id], nodeId: part, partId: part, itemPath: [second] });
        // Editing the design everywhere, the click picks the component in that item too.
        expect(definitionPick(s, def.id, chain)?.ref).toEqual({ owner: { kind: 'component', id: def.id }, instancePath: [], nodeId: part, partId: part, itemPath: [second] });
        // The canvas outlines that one placement, and the Inspector reads that item's values.
        expect(await find(descOf(s, deep!))).toEqual(['Bo']);
        expect(shownValue(s, deep!, { $item: 'name' })).toBe('Bo');
      }
    } finally {
      await tab.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Netlify contact forms that share a form name
// ---------------------------------------------------------------------------

const byTitle = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;
const nameClashes = (s: ProjectState) => validateState(s).filter((d) => d.code === 'FORM_NAME_DUPLICATE');

/** A contact form placed at the end of a page (or tree), sending with the given settings. */
function form(s: ProjectState, tree: { nodes: Record<string, unknown>; rootIds: string[] }, props: Record<string, unknown>): InstanceNode {
  const def = s.components[installComponent(s, 'contact.form')];
  const node = makeInstance(def, props);
  tree.nodes[node.id] = node;
  tree.rootIds.push(node.id);
  return node;
}

describe('contact forms that send to Netlify under one name', () => {
  it('flags each of them before export, naming where they are', () => {
    const s = fresh();
    const a = form(s, home(s), { provider: 'netlify' });
    const b = form(s, byTitle(s, 'Contact'), { provider: 'netlify' });
    const found = nameClashes(s);
    expect(found.map((d) => [d.owner, d.nodeId, d.severity])).toEqual([
      [{ kind: 'page', id: s.site.homePageId }, a.id, 'warning'],
      [{ kind: 'page', id: byTitle(s, 'Contact').id }, b.id, 'warning']
    ]);
    expect(found[0].message).toBe('Home: 2 contact forms send to the Netlify form “contact” (Home and Contact), so Netlify files their messages together. Give each form its own Netlify form name.');
    expect(formNameWarnings(s)).toEqual(['2 contact forms send to the Netlify form “contact” (Home and Contact), so Netlify files their messages together. Give each form its own Netlify form name.']);
    expect(errors(s)).toEqual([]);
    // A name of its own clears it.
    const t = applyOperations(s, [{ type: 'instance.setProp', owner: pageOwner(s, byTitle(s, 'Contact').id), nodeId: b.id, prop: 'formName', value: 'enquiries' }]).state;
    expect(nameClashes(t)).toEqual([]);
  });

  it('reads the name a form inside a design is given, trimmed, and counts a design placed twice twice', () => {
    const s = fresh();
    const def = s.components[installComponent(s, 'contact.form')];
    const wrapper = addDef(s, {
      componentId: 'project.enquiry',
      name: 'Enquiry',
      properties: { name: P.str('Form name', ' contact ') },
      parts: { root: { nodeId: 'root', label: 'Enquiry' } },
      build: (b) => b.el('root', 'section', { name: 'Enquiry' }, [])
    });
    nest(wrapper, 'root', def, { provider: 'netlify', formName: prop('name') });
    const about = byTitle(s, 'About');
    const placedWrapper = place(s, wrapper, {}, about);
    const own = form(s, home(s), { provider: 'netlify' });
    // Each form is flagged where it is on its page: the one inside the design, at the design's placement.
    expect(nameClashes(s).map((d) => [d.owner?.id, d.nodeId])).toEqual([[s.site.homePageId, own.id], [about.id, placedWrapper.id]]);
    // Two placements of the design on one page, with their own name, clash with each other only.
    const other = fresh();
    const w2 = { ...wrapper, id: 'project.enquiry2' };
    other.components[w2.id] = w2;
    other.components[def.id] = def;
    place(other, w2, { name: 'quotes' });
    place(other, w2, { name: 'quotes' });
    expect(nameClashes(other)).toHaveLength(2);
    expect(nameClashes(other)[0].message).toContain('(2 on Home)');
  });

  it('flags every form of a clash, once each, and lists the clash once among export warnings', () => {
    const s = fresh();
    const contact = byTitle(s, 'Contact');
    contact.title = 'Sales: Europe';
    const forms = [form(s, home(s), { provider: 'netlify' }), form(s, contact, { provider: 'netlify' }), form(s, contact, { provider: 'netlify' })];
    expect(nameClashes(s).map((d) => d.nodeId)).toEqual(forms.map((f) => f.id));
    expect(formNameWarnings(s)).toEqual(['3 contact forms send to the Netlify form “contact” (Home and 2 on Sales: Europe), so Netlify files their messages together. Give each form its own Netlify form name.']);
  });

  it('counts a form shown in each item of a list, and a copy of the form whose code was edited', () => {
    const s = fresh();
    const rows = addDef(s, {
      componentId: 'project.rows',
      name: 'Rows',
      properties: { rows: P.list('Rows', 'Row', { title: P.str('Title', 'Row') }, [{ title: 'One' }, { title: 'Two' }]) },
      parts: { root: { nodeId: 'root', label: 'Rows' } },
      slots: { content: { label: 'Content' } },
      build: (b) => b.el('root', 'div', { name: 'Rows' }, [b.repeat('row-items', 'rows', [b.el('row', 'div', { name: 'Row' }, [b.slot('content-slot', 'content')])])])
    });
    const holder = place(s, rows);
    const inside = form(s, { nodes: home(s).nodes, rootIds: [] }, { provider: 'netlify', formName: 'quotes' });
    holder.slots = { content: [inside.id] };
    expect(nameClashes(s).map((d) => [d.nodeId, d.message.includes('2 contact forms send to the Netlify form “quotes” (2 on Home)')])).toEqual([[inside.id, true]]);
    // A project copy of the form, with its code changed, still sends to Netlify under its name.
    const t = fresh();
    const a = form(t, home(t), { provider: 'netlify', formName: 'quotes' });
    const copy = applyOperations(t, [{ type: 'component.makeUnique', owner: pageOwner(t), nodeId: a.id, name: 'Quote form' }]);
    const u = copy.state;
    const id = copy.results[0].definitionId as string;
    u.components[id] = { ...u.components[id], source: u.components[id].source!.replace(/\t/g, '  ') };
    place(u, u.components[id], { provider: 'netlify', formName: 'quotes' });
    expect(nameClashes(u)).toHaveLength(2);
  });

  it('counts a form handed on from one design’s slot into another that shows it in each of its rows', () => {
    const s = fresh();
    const rows = addDef(s, {
      componentId: 'project.rows',
      name: 'Rows',
      properties: { rows: P.list('Rows', 'Row', { title: P.str('Title', 'Row') }, [{ title: 'One' }, { title: 'Two' }]) },
      parts: { root: { nodeId: 'root', label: 'Rows' } },
      slots: { content: { label: 'Content' } },
      build: (b) => b.el('root', 'div', { name: 'Rows' }, [b.repeat('row-items', 'rows', [b.el('row', 'div', { name: 'Row' }, [b.slot('content-slot', 'content')])])])
    });
    const frame = addDef(s, { componentId: 'project.frame', name: 'Frame', properties: {}, parts: { root: { nodeId: 'root', label: 'Frame' } }, slots: { content: { label: 'Content' } }, build: (b) => b.el('root', 'section', { name: 'Frame' }, [b.slot('through', 'content')]) });
    // Frame shows its slot inside Rows' slot, so what is placed in Frame shows once per row.
    const tree = frame.tree!;
    const passOn = tree.nodes.through;
    delete tree.nodes.through;
    (tree.nodes.root as { children: string[] }).children = [];
    const inRows = nest(frame, 'root', rows);
    tree.nodes.through = passOn;
    inRows.slots = { content: ['through'] };
    const holder = place(s, frame);
    const inside = form(s, { nodes: home(s).nodes, rootIds: [] }, { provider: 'netlify', formName: 'quotes' });
    holder.slots = { content: [inside.id] };
    expect(nameClashes(s).map((d) => d.message.includes('2 contact forms send to the Netlify form “quotes”'))).toEqual([true]);
  });

  it('counts a slot shown twice in one row of a list, and not the other rows’ forms with it', () => {
    const s = fresh();
    const def = s.components[installComponent(s, 'contact.form')];
    const receiver = addDef(s, {
      componentId: 'project.receiver',
      name: 'Receiver',
      properties: { twice: P.bool('Twice', false) },
      parts: { root: { nodeId: 'root', label: 'Receiver' } },
      slots: { content: { label: 'Content' } },
      build: (b) => b.el('root', 'div', { name: 'Receiver' }, [b.slot('once', 'content'), b.slot('again', 'content', { when: prop('twice') })])
    });
    const groups = addDef(s, {
      componentId: 'project.groups',
      name: 'Groups',
      properties: { groups: P.list('Groups', 'Group', { name: P.str('Name', 'a'), twice: P.bool('Twice', false) }, [{ name: 'a', twice: false }, { name: 'b', twice: true }]) },
      parts: { root: { nodeId: 'root', label: 'Groups' } },
      build: (b) => b.el('root', 'div', { name: 'Groups' }, [b.repeat('group-items', 'groups', [b.el('group', 'div', { name: 'Group' }, [])])])
    });
    const inner = nest(groups, 'group', receiver, { twice: item('twice') });
    const supplied = makeInstance(def, { provider: 'netlify', formName: item('name') });
    groups.tree!.nodes[supplied.id] = supplied;
    inner.slots = { content: [supplied.id] };
    place(s, groups);
    expect(nameClashes(s).map((d) => d.message.match(/Netlify form “(\w+)”/)?.[1])).toEqual(['b']);
  });

  it('counts a form in the shared footer once, and leaves out drafts, other services and forms with no name', () => {
    const s = fresh();
    form(s, s.site.shell.footer, { provider: 'netlify' });
    form(s, home(s), { provider: 'netlify', formName: 'newsletter' });
    form(s, home(s), { provider: 'endpoint', formName: 'contact' });
    form(s, home(s), { provider: 'netlify', formName: '   ' });
    const draft = byTitle(s, 'About');
    draft.draft = true;
    form(s, draft, { provider: 'netlify' });
    expect(nameClashes(s)).toEqual([]);
    form(s, byTitle(s, 'Contact'), { provider: 'netlify', formName: 'contact' });
    expect(nameClashes(s).map((d) => d.owner)).toEqual([{ kind: 'page', id: byTitle(s, 'Contact').id }, { kind: 'shell', id: 'footer' }]);
    expect(nameClashes(s)[1].message).toMatch(/^Footer: 2 contact forms send to the Netlify form “contact” \(Contact and the shared footer\)/);
    // A footer no published page shows is not on the site.
    for (const p of Object.values(s.pages)) p.showFooter = false;
    expect(nameClashes(s)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fonts a code component names while it runs
// ---------------------------------------------------------------------------

/** A placed code component that builds a theme font's family name in code. */
function computedFont(s: ProjectState, body: string): { state: ProjectState; def: ComponentDefinition } {
  const source = `<script>\n\tconst family = ['Lo', 'ra Variable'].join('');\n</script>\n\n${body}\n`;
  const r = applyOperations(s, [{ type: 'component.createCode', name: 'Quote', source }]);
  const def = r.state.components[r.results[0].definitionId as string];
  return { state: r.state, def };
}
const fontWarnings = (s: ProjectState) => validateState(s).filter((d) => d.code === 'FONT_USAGE_UNVERIFIED');
const servedFonts = (s: ProjectState) => [...generateProject(s).get('src/lib/siteorigin/styles/tokens.css')!.matchAll(/font-family: '([^']+)'/g)].map((m) => m[1]);

describe('a code component that names its font while it runs', () => {
  it('is flagged before export while a theme font is left out, naming the remedy', () => {
    const { state: s, def } = computedFont(fresh(), '<p style="--quote-font: {family}" class="q">Quote</p>\n\n<style>\n\t.q { font-family: var(--quote-font), serif; }\n</style>');
    // Not placed anywhere: nothing it does reaches the site.
    expect(fontWarnings(s)).toEqual([]);
    place(s, def);
    expect(servedFonts(s)).not.toContain('Lora Variable');
    const found = fontWarnings(s);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning', owner: { kind: 'component', id: def.id } });
    expect(found[0].message).toMatch(/^Quote sets a font in its code, where the export cannot tell which family it is, so a theme font it shows \([^)]*Lora[^)]*\) may be left out of the site\./);
    expect(runtimeFontWarnings(s)).toEqual([found[0].message]);
    expect(errors(s)).toEqual([]);
    // A family its source happens to name says nothing about the one it computes.
    s.components[def.id] = { ...def, source: `<!-- Body text: Inter Variable -->\n${def.source}` };
    expect(fontWarnings(s)).toHaveLength(1);
    // A Fonts comment that names no theme font says nothing.
    s.components[def.id] = { ...def, source: `<!-- Fonts: -->\n${def.source}` };
    expect(fontWarnings(s)).toHaveLength(1);
    // Saying which theme fonts it uses, in a Fonts comment, ships them and settles it.
    s.components[def.id] = { ...def, source: `<!-- Fonts: Lora Variable -->\n${def.source}` };
    expect(servedFonts(s)).toContain('Lora Variable');
    expect(fontWarnings(s)).toEqual([]);
  });

  it('is not flagged once every theme font ships anyway', () => {
    const { state: s, def } = computedFont(fresh(), '<p style:font-family={family}>Quote</p>');
    place(s, def);
    expect(fontWarnings(s)).toHaveLength(1);
    // Every theme font named somewhere in the site's documents (here, a page's description) ships, so none is missing.
    const page = home(s);
    page.seo = { ...page.seo, description: installedFonts(s).map((f) => f.family).join(', ') };
    expect(fontWarnings(s)).toEqual([]);
  });

  it('follows the code that renders it: imported by placed code, but not placed only in a design no page uses', () => {
    const { state: s, def } = computedFont(fresh(), '<p style:font-family={family}>Quote</p>');
    const r = applyOperations(s, [{ type: 'component.createCode', name: 'Card', source: '<p>Card</p>\n' }]);
    const t = r.state;
    const card = t.components[r.results[0].definitionId as string];
    card.dependencies = [def.id];
    expect(fontWarnings(t)).toEqual([]);
    place(t, card);
    expect(fontWarnings(t).map((d) => d.owner?.id)).toEqual([def.id]);
    const u = computedFont(fresh(), '<p style:font-family={family}>Quote</p>');
    const unused = addDef(u.state, { componentId: 'project.unused', name: 'Unused', properties: {}, parts: { root: { nodeId: 'root', label: 'Unused' } }, build: (b) => b.el('root', 'div', {}, []) });
    nest(unused, 'root', u.def);
    expect(fontWarnings(u.state)).toEqual([]);
    place(u.state, unused);
    expect(fontWarnings(u.state)).toHaveLength(1);
  });

  it('tells a font chosen in code from one written out or taken from a site style', () => {
    for (const source of ['<p style:font-family={family}>x</p>', '<p style="font-family: {family}">x</p>', '<p style={`font: 1rem ${family}`}>x</p>', '<script>el.style.fontFamily = family;</script>', "<script>el.style.font = '16px ' + family;</script>", "<script>el.style.setProperty('font-family', family);</script>", '<script>el.style.setProperty("font", family);</script>', '<style>p { font-family: var(--brand-font); }</style>'])
      expect(choosesFontAtRunTime(source), source).toBe(true);
    for (const source of ["<style>p { font-family: 'Lora Variable', serif; }</style>", '<script>if (a.font == b.font) go();</script>', '<style>p { font-family: var(--so-font-display); }\n.a { font: inherit }\n.b { color: red; }</style>', '<p style="font-weight: {weight}">x</p>', "<script>const font = { name: 'x' };</script>"])
      expect(choosesFontAtRunTime(source), source).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structured data for a business's contact details and FAQ
// ---------------------------------------------------------------------------

/** Every JSON-LD object a rendered head carries, parsed as a search engine would. */
const jsonLd = (head: string) => [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]) as Record<string, unknown>);
const ofType = (head: string, type: string) => jsonLd(head).filter((ld) => ld['@type'] === type);
const firstOf = (s: ProjectState, page: PageDoc, componentId: string) => Object.values(page.nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === componentId) as InstanceNode;
/** Text as the page shows it, with tags dropped and entities read. */
const shownText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

describe('structured data on a page with contact details and an FAQ', () => {
  it('leaves out an FAQ whose questions the placement hides, and reads each rendering of one placed in a list', async () => {
    const s = fresh();
    const contact = byTitle(s, 'Contact');
    const faq = firstOf(s, contact, 'faq.list');
    faq.overrides = { item: { base: { hidden: true } } };
    expect(ofType((await renderPage(s, contact)).head, 'FAQPage')).toEqual([]);
    faq.overrides = { item: { base: { hidden: true }, desktop: { hidden: false } } };
    expect(ofType((await renderPage(s, contact)).head, 'FAQPage')).toHaveLength(1);
    // The design showing it on phones loses to the placement hiding it at every size.
    s.components[faq.definitionId].tree!.nodes.item.styles = { phone: { layout: 'stack' } };
    faq.overrides = { item: { base: { hidden: true } } };
    expect(ofType((await renderPage(s, contact)).head, 'FAQPage')).toEqual([]);
    // A design that shows the same FAQ once in each of its two rows: each rendering's questions count.
    const t = fresh();
    const faqDef = t.components[installComponent(t, 'faq.list')];
    const twice = addDef(t, {
      componentId: 'project.twice',
      name: 'Twice',
      properties: { rows: P.list('Rows', 'Row', { title: P.str('Title', 'Row') }, [{ title: 'One' }, { title: 'Two' }]) },
      parts: { root: { nodeId: 'root', label: 'Twice' } },
      build: (b) => b.el('root', 'div', { name: 'Twice' }, [b.repeat('row-items', 'rows', [b.el('row', 'div', { name: 'Row' }, [])])])
    });
    nest(twice, 'row', faqDef);
    place(t, twice);
    const [page] = ofType((await renderPage(t)).head, 'FAQPage');
    expect((page.mainEntity as unknown[]).length).toBe(2 * (faqDef.properties.items.default as unknown[]).length);
  });

  it('reads visibility as the stylesheet decides it, size by size through every element around the question', async () => {
    const s = fresh();
    const contact = byTitle(s, 'Contact');
    const faq = firstOf(s, contact, 'faq.list');
    const faqDef = s.components[faq.definitionId];
    const root = faqDef.tree!.rootIds[0];
    // The design hides its root, and the placement gives it a layout: shown.
    faqDef.tree!.nodes[root].styles = { ...faqDef.tree!.nodes[root].styles, base: { ...faqDef.tree!.nodes[root].styles?.base, hidden: true } };
    faq.overrides = { root: { base: { layout: 'stack' } } };
    expect(ofType((await renderPage(s, contact)).head, 'FAQPage')).toHaveLength(1);
    // Shown only on desktop, with the answers hidden on desktop: no answer is ever seen.
    faqDef.tree!.nodes[root].styles = { ...faqDef.tree!.nodes[root].styles, base: { ...faqDef.tree!.nodes[root].styles?.base, hidden: false } };
    faq.overrides = { root: { base: { hidden: true }, desktop: { hidden: false } }, answer: { desktop: { hidden: true } } };
    expect(ofType((await renderPage(s, contact)).head, 'FAQPage')).toEqual([]);
  });

  it('reads an FAQ placed in a design with the options and styles that design gives it', async () => {
    const s = fresh();
    const faqDef = s.components[installComponent(s, 'faq.list')];
    faqDef.variantAxes!.tone.options.quiet = { label: 'Quiet', styles: { item: { base: { hidden: true } } } };
    const wrap = addDef(s, { componentId: 'project.help', name: 'Help', properties: {}, parts: { root: { nodeId: 'root', label: 'Help' } }, build: (b) => b.el('root', 'section', { name: 'Help' }, []) });
    const inner = nest(wrap, 'root', faqDef);
    place(s, wrap);
    expect(ofType((await renderPage(s)).head, 'FAQPage')).toHaveLength(1);
    inner.variants = { tone: 'quiet' };
    expect(ofType((await renderPage(s)).head, 'FAQPage')).toEqual([]);
    inner.variants = {};
    inner.overrides = { item: { base: { hidden: true } } };
    expect(ofType((await renderPage(s)).head, 'FAQPage')).toEqual([]);
  });

  it('reads contact details in the shared footer the page shows, and names no business for a site with no name', async () => {
    const s = fresh();
    const about = byTitle(s, 'About');
    const details = makeInstance(s.components[installComponent(s, 'contact.details')], {});
    s.site.shell.footer.nodes[details.id] = details;
    s.site.shell.footer.rootIds.push(details.id);
    expect(ofType((await renderPage(s, about)).head, 'LocalBusiness')).toHaveLength(1);
    // A cached run follows what the footer shows into every page, and an edit elsewhere in it changes no page.
    const cache = new GenerationCache();
    const page = pageFile(about);
    const before = generateProject(s, {}, cache).get(page)!;
    expect(before).toContain('hello@example.com');
    const t = structuredClone(s);
    (t.site.shell.footer.nodes[details.id] as InstanceNode).props.heading = 'Visit us';
    expect(generateProject(t, {}, cache).get(page)).toBe(before);
    const u = structuredClone(t);
    ((u.site.shell.footer.nodes[details.id] as InstanceNode).props.items as Array<{ value: string; link: { type: string; target: string } }>)[0].link.target = 'studio@example.com';
    expect(generateProject(u, {}, cache).get(page)).toContain('studio@example.com');
    expect(generateProject(u, {}, cache).get(page)).toBe(generateProject(u).get(page));
    about.showFooter = false;
    expect(ofType((await renderPage(s, about)).head, 'LocalBusiness')).toEqual([]);
    s.site.name = '  ';
    expect(ofType((await renderPage(s, byTitle(s, 'Contact'))).head, 'LocalBusiness')).toEqual([]);
  });

  it('describes the business and the questions as the page shows them', async () => {
    const s = fresh();
    s.site.baseUrl = 'https://studio.example';
    const contact = byTitle(s, 'Contact');
    const { head, body } = await renderPage(s, contact);
    expect(ofType(head, 'LocalBusiness')).toEqual([
      { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Test Studio', url: 'https://studio.example/', email: 'hello@example.com', telephone: '+1 555 0134', address: '12 Harbour Lane, Millbrook' }
    ]);
    const [faqPage, ...more] = ofType(head, 'FAQPage');
    expect(more).toEqual([]);
    const faq = firstOf(s, contact, 'faq.list');
    const items = faq.props.items as Array<{ question: string; answer: string }>;
    expect(faqPage).toEqual({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: items.map((i) => ({ '@type': 'Question', name: i.question, acceptedAnswer: { '@type': 'Answer', text: i.answer } }))
    });
    // Each question and answer is one the page shows, in the order it shows them.
    const text = shownText(body);
    let at = 0;
    for (const i of items) for (const words of [i.question, i.answer]) {
      const found = text.indexOf(words, at);
      expect(found, words).toBeGreaterThanOrEqual(at);
      at = found;
    }
    // Other pages have neither.
    const about = await renderPage(s, byTitle(s, 'About'));
    expect(ofType(about.head, 'LocalBusiness')).toEqual([]);
    expect(ofType(about.head, 'FAQPage')).toEqual([]);
  });

  it('reads an FAQ placed in a section, leaves out empty and hidden ones, and keeps hostile text inside its script', async () => {
    const s = fresh();
    const contact = byTitle(s, 'Contact');
    const faq = firstOf(s, contact, 'faq.list');
    const items = faq.props.items as Array<{ id: string; question: string; answer: string }>;
    items[0].answer = 'Yes </script><script>alert(1)</script> & “quoted”\nacross lines';
    items[1].answer = '   ';
    // A second FAQ inside a section's slot on the same page, and a third hidden at every size.
    const r = applyOperations(s, [{ type: 'node.insert', owner: pageOwner(s, contact.id), parentId: null, index: 0, componentId: 'layout.section' }]);
    let t = r.state;
    const section = byTitle(t, 'Contact').rootIds[0];
    t = applyOperations(t, [{ type: 'node.insert', owner: pageOwner(t, contact.id), parentId: section, slot: 'content', componentId: 'faq.list' }]).state;
    const page = byTitle(t, 'Contact');
    const inner = (page.nodes[section] as InstanceNode).slots!.content.map((id) => page.nodes[id] as InstanceNode)[0];
    const hidden = makeInstance(t.components[inner.definitionId], {});
    hidden.overrides = { root: { base: { hidden: true } } };
    page.nodes[hidden.id] = hidden;
    page.rootIds.push(hidden.id);
    const { head } = await renderPage(t, page);
    expect(head.match(/<script/g)).toHaveLength(2);
    const [faqPage] = ofType(head, 'FAQPage');
    const entries = faqPage.mainEntity as Array<{ name: string; acceptedAnswer: { text: string } }>;
    const innerItems = inner.props.items as Array<{ question: string; answer: string }>;
    const outerItems = (byTitle(t, 'Contact').nodes[faq.id] as InstanceNode).props.items as Array<{ question: string; answer: string }>;
    expect(entries.map((e) => e.name)).toEqual([...innerItems.map((i) => i.question), outerItems[0].question, ...outerItems.slice(2).map((i) => i.question)]);
    expect(entries[innerItems.length].acceptedAnswer.text).toBe('Yes </script><script>alert(1)</script> & “quoted” across lines');
    // No public address yet: the business has no URL, and nothing else is missing.
    expect(ofType(head, 'LocalBusiness')[0]).not.toHaveProperty('url');
  });

  it('leaves a page out when it asks search engines not to list it', async () => {
    const s = fresh();
    s.site.baseUrl = 'https://studio.example';
    const contact = byTitle(s, 'Contact');
    contact.seo = { ...contact.seo, noindex: true };
    expect(jsonLd((await renderPage(s, contact)).head)).toEqual([]);
  });

  it('reads a project copy of the FAQ and keeps each contact section’s facts together', async () => {
    const s = fresh();
    const contact = byTitle(s, 'Contact');
    const faq = firstOf(s, contact, 'faq.list');
    const details = firstOf(s, contact, 'contact.details');
    let t = applyOperations(s, [{ type: 'component.makeUnique', owner: pageOwner(s, contact.id), nodeId: faq.id, name: 'Our FAQ' }]).state;
    const second = makeInstance(t.components[details.definitionId], {
      items: [
        { icon: 'phone', label: 'Depot', value: '+1 555 0199', link: { type: 'tel', target: '+15550199' } },
        { icon: 'phone', label: 'Reception', value: 'Call reception', link: { type: 'tel', target: '+15550100' } },
        { icon: 'building', label: 'Depot', value: '4 Mill Road', link: { type: 'none', target: '' } },
        { icon: 'map-pin', label: 'Map', value: 'Get directions', link: { type: 'url', target: 'https://maps.example/depot' } },
        { icon: 'mail', label: 'Email', value: 'depot@example.com', link: { type: 'email', target: 'depot@example.com' } },
        { icon: 'mail', label: 'Sales', value: 'sales@example.com', link: { type: 'email', target: 'sales@example.com?subject=Quote' } }
      ]
    });
    byTitle(t, 'Contact').nodes[second.id] = second;
    byTitle(t, 'Contact').rootIds.push(second.id);
    const { head } = await renderPage(t, byTitle(t, 'Contact'));
    const copied = firstOf(t, byTitle(t, 'Contact'), t.components[(byTitle(t, 'Contact').nodes[faq.id] as InstanceNode).definitionId].componentId);
    const [faqPage, ...more] = ofType(head, 'FAQPage');
    expect(more).toEqual([]);
    expect((faqPage.mainEntity as Array<{ name: string }>).map((e) => e.name)).toEqual((copied.props.items as Array<{ question: string }>).map((i) => i.question));
    // A number shown as words gives the number it dials; words beside a map icon are not an address.
    expect(ofType(head, 'LocalBusiness').map((b) => [b.email, b.telephone, b.address])).toEqual([
      ['hello@example.com', '+1 555 0134', '12 Harbour Lane, Millbrook'],
      [['depot@example.com', 'sales@example.com'], ['+1 555 0199', '+15550100'], '4 Mill Road']
    ]);
  });
});
