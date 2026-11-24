/**
 * Foundation's interactive sections (#380): the Tabbed showcase, two to six tabs over an image, heading, text and action
 * each, and Pricing with billing switch, plans whose prices follow a Monthly / Annual switch. Both are offered where
 * sections are (Insert's catalogue, search_components, upsert_page_with_sections), placed as the theme ships them,
 * rendered as an exported site prerenders them, in every tone, and printed without the controls that only work on
 * screen.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent, catalogueEntries, getTheme, searchCatalogue } from '@catalogue/index';
import { FOUNDATION_BASE_CSS } from '@catalogue/foundation/base.css';
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState } from '@engine/validate';
import { CHOICE_GROUP_CLASS, STATE_OFF_CLASS, defFile, generateProject, nodeClass } from '@generator/index';
import { newMacroMemory, runUpsert, upsertToolSchema } from '@agent/macros';
import { executeTool, type ToolHost } from '@agent/tools';

const SHOWCASE = 'tabs.showcase';
const BILLING = 'pricing.toggle';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops);

/** The project with the section inserted at the top of Home, as Insert places it, and its placement and design. */
function inserted(componentId: string, props?: Record<string, unknown>, s = fresh()) {
  const r = apply(s, [{ type: 'node.insert', owner: owner(s), componentId, index: 0, ...(props ? { props } : {}) } as EditOperation]);
  const nodeId = r.results[0].nodeId as string;
  const node = home(r.state).nodes[nodeId] as InstanceNode;
  return { state: r.state, node, def: r.state.components[node.definitionId] };
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Server-render the exported Home page, as the static site prerenders it. */
async function renderHome(s: ProjectState): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'foundation-interactive-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of generateProject(s)) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, 'src/routes/+page.svelte.js'))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} }).body.replace(/<!--[\s\S]*?-->/g, '');
}

/** Every opening tag carrying this attribute set to this value (any value when it is undefined). */
const tagsWith = (html: string, attr: string, value?: string) => [...html.matchAll(new RegExp(`<[a-z0-9]+\\b[^>]*\\s${attr}="${value ?? '[^"]*'}"[^>]*>`, 'g'))].map((m) => m[0]);
const attrOf = (tag: string, attr: string) => new RegExp(`\\s${attr}="([^"]*)"`).exec(tag)?.[1];
/** The words right after an opening tag, up to the next tag. */
const textAfter = (html: string, tag: string) => html.slice(html.indexOf(tag) + tag.length).replace(/^(\s*<[^>]+>)*/, '').split('<')[0].trim();

/** Compiler warnings, accessibility ones included, for a design's generated file, for the server and the browser. */
function compileWarnings(s: ProjectState, def: ComponentDefinition): string[] {
  const out: string[] = [];
  for (const instrument of [false, true]) {
    const source = generateProject(s, { instrument }).get(defFile(def))!;
    for (const generate of ['server', 'client'] as const) out.push(...compile(source, { filename: defFile(def), generate, runes: true }).warnings.map((w) => `${generate}${instrument ? ' (editor)' : ''}: ${w.code}`));
  }
  return out;
}

describe('where the sections are offered', () => {
  it('lists both in the catalogue, with the three Foundation tones, and finds them by what people ask for', () => {
    const entries = catalogueEntries('foundation');
    for (const id of [SHOWCASE, BILLING]) expect(entries.find((e) => e.componentId === id)?.axes).toEqual({ tone: ['default', 'muted', 'inverse'] });
    expect(searchCatalogue('foundation', 'tabs').map((e) => e.componentId)[0]).toBe(SHOWCASE);
    expect(searchCatalogue('foundation', 'tabbed services showcase').map((e) => e.componentId)[0]).toBe(SHOWCASE);
    expect(searchCatalogue('foundation', 'monthly annual pricing').map((e) => e.componentId)[0]).toBe(BILLING);
    // Plain pricing still finds both pricing sections.
    expect(searchCatalogue('foundation', 'pricing').map((e) => e.componentId)).toEqual(expect.arrayContaining(['pricing.plans', BILLING]));
  });

  it('offers both through search_components, as the assistant asks for them', async () => {
    const s = fresh();
    const host = { state: () => s, revision: () => 1 } as unknown as ToolHost;
    const found = async (query: string) => JSON.stringify((await executeTool('search_components', JSON.stringify({ query }), host, 'c1')).content);
    expect(await found('tabbed showcase')).toContain(SHOWCASE);
    expect(await found('monthly annual billing')).toContain(BILLING);
  });

  it('types both in upsert_page_with_sections, and builds a page from them', async () => {
    const schema = upsertToolSchema(fresh()) as { properties: { sections: { items: { oneOf: Array<{ properties: { componentId: { enum: string[] }; props: { properties: Record<string, unknown> } } }> } } } };
    const branch = (id: string) => schema.properties.sections.items.oneOf.find((b) => b.properties.componentId.enum[0] === id)!.properties.props.properties;
    expect(Object.keys(branch(SHOWCASE))).toEqual(['eyebrow', 'heading', 'headingLevel', 'lead', 'tab1', 'tab2', 'tab3', 'tab4', 'tab5', 'tab6']);
    expect(Object.keys(branch(BILLING))).toEqual(['eyebrow', 'heading', 'headingLevel', 'lead', 'monthlyLabel', 'annualLabel', 'switchLabel', 'plans']);
    // Each tab is an object of its own fields, its icon one of the offered names or "" for none.
    expect(branch(SHOWCASE).tab4).toMatchObject({ type: 'object', properties: { label: { type: 'string' }, icon: { enum: expect.arrayContaining(['', 'compass']) }, copy: { type: 'string' } } });
    let state = fresh();
    const host = {
      state: () => state,
      revision: () => 0,
      diagnostics: () => [],
      apply: async (ops: EditOperation[]) => {
        const r = applyOperations(state, ops);
        state = r.state;
        return { ok: true, revision: 1, results: r.results };
      },
      compileAll: async () => [],
      inspectLayout: async () => ({}),
      ask: async () => '',
      pageLimit: () => null
    } as unknown as ToolHost;
    const out = await runUpsert(
      {
        slug: 'memberships',
        title: 'Memberships',
        sections: [
          {
            componentId: SHOWCASE,
            props: {
              heading: 'Three ways to train',
              tab1: { label: 'Classes', icon: 'users', heading: 'Thirty classes a week', copy: 'Strength, mobility and cardio.\n\nBook from the app.' },
              tab2: { label: 'Open gym', heading: 'Your own pace' },
              tab3: { label: 'Coaching', icon: 'target', heading: 'A plan made for you', actionLabel: 'Meet a coach', actionLink: '/contact/' }
            }
          },
          {
            componentId: BILLING,
            variant: 'inverse',
            props: { annualLabel: 'Yearly', plans: [{ name: 'Anytime', monthlyPrice: '$49', monthlyNote: 'per month', annualPrice: '$490', annualNote: 'per year', features: 'Every class' }] }
          }
        ]
      },
      host,
      'c1',
      newMacroMemory()
    );
    expect(out.ok, JSON.stringify(out.content)).toBe(true);
    const page = Object.values(state.pages).find((p) => p.route === '/memberships/')!;
    const [showcase, billing] = page.rootIds.map((id) => page.nodes[id] as InstanceNode);
    expect(state.components[showcase.definitionId].componentId).toBe(SHOWCASE);
    expect(showcase.props.tab3).toMatchObject({ label: 'Coaching', icon: 'target', heading: 'A plan made for you', actionLink: { type: 'page' } });
    expect(state.components[billing.definitionId].componentId).toBe(BILLING);
    expect(billing.variants).toEqual({ tone: 'inverse' });
    expect(validateState(state).filter(blocksSaving)).toEqual([]);
  });
});

describe('Tabbed showcase', () => {
  it('opens on its first tab, with the three sample tabs in a named tab list, each naming its panel', async () => {
    const { state, def } = inserted(SHOWCASE);
    expect(validateState(state).filter(blocksSaving)).toEqual([]);
    expect(compileWarnings(state, def)).toEqual([]);
    const html = await renderHome(state);
    const [list] = tagsWith(html, 'role', 'tablist');
    expect(attrOf(list, 'aria-label')).toBe('From first sketch to finished room');
    const tabs = tagsWith(html, 'role', 'tab');
    expect(tabs.map((t) => textAfter(html, t))).toEqual(['Design', 'Build', 'Care']);
    expect(tabs.map((t) => [attrOf(t, 'aria-selected'), attrOf(t, 'tabindex')])).toEqual([['true', '0'], ['false', '-1'], ['false', '-1']]);
    const panels = tagsWith(html, 'role', 'tabpanel');
    expect(panels.map((p) => attrOf(p, 'data-tab-label'))).toEqual(['Design', 'Build', 'Care']);
    for (const [i, tab] of tabs.entries()) {
      expect(attrOf(panels[i], 'id')).toBe(attrOf(tab, 'aria-controls'));
      expect(attrOf(panels[i], 'aria-labelledby')).toBe(attrOf(tab, 'id'));
      // Only the first shows on screen; the others are in the page, for print.
      expect(attrOf(panels[i], 'class')!.split(' ').includes(STATE_OFF_CLASS)).toBe(i > 0);
    }
    for (const words of ['Plans drawn around how you live', 'One team from demolition to handover', 'Looked after long after we leave']) expect(html).toContain(words);
    // The sample's icons sit beside the labels. The first tab's action waits for somewhere to go, then shows.
    expect(html.match(/so-link__icon so-link__icon--start/g)).toHaveLength(3);
    expect(html).not.toContain('See recent projects');
    const linked = await renderHome(inserted(SHOWCASE, { tab1: { actionLink: { type: 'url', target: 'https://example.com/work' } } }).state);
    expect(linked).toMatch(/<a href="https:\/\/example\.com\/work"[^>]*>See recent projects<\/a>/);
  });

  it('has as many tabs as labels: two at least, six at most, each with only its own panel', async () => {
    const six = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`tab${n}`, { label: `Stage ${n}`, heading: `Stage ${n} heading` }]));
    const { state } = inserted(SHOWCASE, six);
    let html = await renderHome(state);
    expect(tagsWith(html, 'role', 'tab').map((t) => textAfter(html, t))).toEqual(['Stage 1', 'Stage 2', 'Stage 3', 'Stage 4', 'Stage 5', 'Stage 6']);
    expect(tagsWith(html, 'role', 'tabpanel').map((p) => html.slice(html.indexOf(p)).match(/<h3[^>]*>([^<]*)</)?.[1])).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Stage ${n} heading`));
    // Clearing a label leaves its tab out with its panel, whichever it is; the first two always stay.
    const two = inserted(SHOWCASE, { tab3: { label: '' } }).state;
    html = await renderHome(two);
    expect(tagsWith(html, 'role', 'tab').map((t) => textAfter(html, t))).toEqual(['Design', 'Build']);
    expect(tagsWith(html, 'role', 'tabpanel')).toHaveLength(2);
    expect(html).not.toContain('Looked after long after we leave');
    const gap = inserted(SHOWCASE, { tab3: { label: '' }, tab5: { label: 'Extras', heading: 'Odds and ends' } }).state;
    html = await renderHome(gap);
    expect(tagsWith(html, 'role', 'tab').map((t) => textAfter(html, t))).toEqual(['Design', 'Build', 'Extras']);
    expect(tagsWith(html, 'role', 'tabpanel').map((p) => attrOf(p, 'data-tab-label'))).toEqual(['Design', 'Build', 'Extras']);
    // A blank first label still names its tab.
    html = await renderHome(inserted(SHOWCASE, { tab1: { label: ' ' } }).state);
    expect(textAfter(html, tagsWith(html, 'role', 'tab')[0])).toBe('Tab 1');
  });

  it('keeps the tab row on one line that scrolls sideways on a phone, and wraps it from a tablet up', () => {
    const def = catalogueComponent('foundation', SHOWCASE)!;
    const list = def.tree!.nodes['tab-list'];
    expect(list.styles).toMatchObject({ base: { layout: 'row', wrap: false, customCss: 'overflow-x: auto' }, tablet: { wrap: true }, desktop: { wrap: true } });
    for (let n = 1; n <= 6; n++) expect(def.tree!.nodes[`tab-${n}`].styles?.base).toMatchObject({ flexShrink: 0 });
  });

  it('follows the tone: on the dark tone its supporting text and every tab’s text turn light', async () => {
    const def = catalogueComponent('foundation', SHOWCASE)!;
    const inverse = def.variantAxes!.tone.options.inverse.styles!;
    for (const id of ['root', 'eyebrow', 'lead', 'copy-1', 'copy-2', 'copy-3', 'copy-4', 'copy-5', 'copy-6']) expect(inverse[id], id).toBeTruthy();
    for (const id of ['lead', 'copy-1', 'copy-6']) expect(inverse[id].base).toMatchObject({ color: { token: 'color.on-inverse' } });
    expect(inverse.root.base).toMatchObject({ background: { token: 'color.inverse' }, color: { token: 'color.on-inverse' } });
    for (const tone of ['muted', 'inverse']) {
      const { state, def: placed } = inserted(SHOWCASE, undefined, fresh());
      const r = apply(state, [{ type: 'instance.setVariant', owner: owner(state), nodeId: home(state).rootIds[0], axis: 'tone', variant: tone }]).state;
      expect(compileWarnings(r, placed)).toEqual([]);
      const root = tagsWith(await renderHome(r), 'class').find((t) => attrOf(t, 'class')!.includes(nodeClass(placed, 'root')))!;
      expect(attrOf(root, 'class')).toContain(`--tone-${tone}`);
    }
  });
});

describe('Pricing with billing switch', () => {
  it('shows monthly prices at first, under a named group of two buttons that say which period is on', async () => {
    const { state, def } = inserted(BILLING);
    expect(validateState(state).filter(blocksSaving)).toEqual([]);
    expect(compileWarnings(state, def)).toEqual([]);
    const html = await renderHome(state);
    const [group] = tagsWith(html, 'role', 'group');
    expect(attrOf(group, 'aria-label')).toBe('Billing period');
    expect(attrOf(group, 'class')!.split(' ')).toContain(CHOICE_GROUP_CLASS);
    const buttons = tagsWith(html, 'aria-pressed');
    expect(buttons.map((b) => [b.slice(0, 7), textAfter(html, b), attrOf(b, 'aria-pressed')])).toEqual([
      ['<button', 'Monthly', 'true'],
      ['<button', 'Annual', 'false']
    ]);
    for (const price of ['$29', '$49', '$119']) expect(html).toContain(`>${price}<`);
    for (const price of ['$290', '$490', '$1,190']) expect(html).not.toContain(`>${price}<`);
    expect(html.match(/per month/g)).toHaveLength(3);
    expect(html).not.toContain('billed once');
    // Its own name for the switch, in the site's language.
    const named = await renderHome(inserted(BILLING, { switchLabel: 'Période de facturation' }).state);
    expect(attrOf(tagsWith(named, 'role', 'group')[0], 'aria-label')).toBe('Période de facturation');
    // A button whose label is cleared is still named, by its period.
    const blank = await renderHome(inserted(BILLING, { monthlyLabel: ' ', annualLabel: '' }).state);
    expect(tagsWith(blank, 'aria-pressed').map((b) => textAfter(blank, b))).toEqual(['Monthly', 'Annual']);
  });

  it('never shows a price a plan does not have', async () => {
    const { state, node } = inserted(BILLING, { plans: [{ name: 'Day pass', monthlyPrice: '$15', monthlyNote: 'per visit', annualNote: '' }] });
    expect((node.props.plans as Array<Record<string, unknown>>)[0]).toMatchObject({ monthlyPrice: '$15', annualPrice: '' });
    const html = await renderHome(state);
    expect(html).toContain('>$15<');
    expect(html).not.toContain('$0');
    // With neither a price nor a note for the period, the row leaves nothing behind.
    const def = catalogueComponent('foundation', BILLING)!;
    expect(def.tree!.nodes['annual-price-row']).toMatchObject({ collapseEmpty: true });
    expect(def.tree!.nodes['annual-price'].when).toEqual({ $item: 'annualPrice' });
  });

  it('switches every plan’s price and billing note together from the state, with no script of its own', () => {
    const { state, def } = inserted(BILLING);
    const source = generateProject(state).get(defFile(def))!;
    expect(source).toContain('let so_state_billing = $state("monthly");');
    expect(source).toContain('onclick={() => (so_state_billing = "annual")}');
    // Each period's price and note show together, inside every plan.
    expect(source).toMatch(/\{#each[\s\S]*\{#if so_state_billing === "monthly"\}[\s\S]*monthlyPrice[\s\S]*monthlyNote[\s\S]*\{#if so_state_billing === "annual"\}[\s\S]*annualPrice[\s\S]*annualNote[\s\S]*\{\/each\}/);
    expect(source).not.toMatch(/\$effect|addEventListener|document\./);
  });

  it('is its own section beside the plain one, which keeps its fixed prices', () => {
    const plain = catalogueComponent('foundation', 'pricing.plans')!;
    expect(plain.state).toBeUndefined();
    expect(Object.keys(getTheme('foundation').components.find((c) => c.componentId === BILLING)!.state!)).toEqual(['billing']);
  });
});

describe('a copy of the showcase', () => {
  it('keeps its schema through the schema edits a copy takes, its icon’s None included', () => {
    const { state, def } = inserted(SHOWCASE);
    const forked = applyOperations(state, [{ type: 'component.fork', definitionId: def.id }]);
    const copy = forked.results[0].definitionId as string;
    const schema = forked.state.components[copy].properties.tab1;
    const again = applyOperations(forked.state, [{ type: 'component.setPropSchema', definitionId: copy, prop: 'tab1', schema: structuredClone(schema) as unknown as Record<string, unknown> }]);
    expect((again.state.components[copy].properties.tab1 as { fields: Record<string, { options?: Array<{ value: string }> }> }).fields.icon.options![0]).toEqual({ value: '', label: 'None' });
    expect(validateState(again.state).filter(blocksSaving)).toEqual([]);
    // An empty choice needs a name to be offered by.
    const unnamed = { ...schema, fields: { ...(schema as { fields: Record<string, unknown> }).fields, icon: { type: 'enum', label: 'Tab icon', options: ['', 'compass'] } } };
    expect(() => applyOperations(forked.state, [{ type: 'component.setPropSchema', definitionId: copy, prop: 'tab1', schema: unnamed }])).toThrow(/an empty one \(""\) needs a label/);
    const unlabelled = { ...unnamed, fields: { ...unnamed.fields, icon: { type: 'enum', label: 'Tab icon', options: [{ value: '' }, 'compass'] } } };
    expect(() => applyOperations(forked.state, [{ type: 'component.setPropSchema', definitionId: copy, prop: 'tab1', schema: unlabelled }])).toThrow(/an empty one \(""\) needs a label/);
  });
});

describe('print', () => {
  it('prints every present tab’s panel under its label without the tab row, and the plans without the switch', () => {
    const { state } = inserted(BILLING, undefined, inserted(SHOWCASE).state);
    const css = generateProject(state).get('src/lib/siteorigin/styles/components.css')!;
    expect(css).toMatch(new RegExp(`@media not print \\{\\s*\\.${STATE_OFF_CLASS}:not\\(#so-print\\) \\{ display: none !important; \\}`));
    const print = FOUNDATION_BASE_CSS.slice(FOUNDATION_BASE_CSS.indexOf('@media print'));
    expect(print).toContain('.so-tablist:not(#so-print) { display: none !important; }');
    // Only the billing switch of Foundation's pricing, in any copy of it: other groups of buttons print.
    expect(css).not.toContain(CHOICE_GROUP_CLASS);
    expect(print).toContain(`section:has([class*='__annual-price-row']) .${CHOICE_GROUP_CLASS}:is([class$='__switch'], [class*='__switch ']):not(#so-print) { display: none !important; }`);
    expect(print.match(new RegExp(`\\.${CHOICE_GROUP_CLASS}\\b`, 'g'))).toHaveLength(1);
    expect(print).toContain("[role='tabpanel'][data-tab-label]:not([data-tab-label=''])::before");
  });
});
