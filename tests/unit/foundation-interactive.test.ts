/**
 * Foundation's interactive sections (#380): the Tabbed showcase, two to six tabs over an image, heading, text and action
 * each, and Pricing with billing switch, plans whose prices follow a Monthly / Annual switch. Both are offered where
 * sections are (Insert's catalogue, search_components, upsert_page_with_sections), placed as the theme ships them,
 * rendered as an exported site prerenders them, in every tone, and printed without the controls that only work on
 * screen. Both are Svelte code in the release, so what is checked is what their placements render and the rules the
 * theme and their own styles ship.
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
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState } from '@engine/validate';
import { CHOICE_GROUP_CLASS, CHOICE_OFF_CLASS, SCRIPTS_CLASS, STATE_OFF_CLASS, defFile, generateProject } from '@generator/index';
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

/** The showcase's sample tabs, each changed by the matching entry of `edits`. */
const sampleTabs = (...edits: Array<Record<string, unknown>>) =>
  (structuredClone(catalogueComponent('foundation', SHOWCASE)!.properties.tabs.default) as Array<Record<string, unknown>>).map((tab, i) => ({ ...tab, ...edits[i] }));

/** A shipped section's own styles, as the Svelte compiler scopes them. */
const ownCss = (componentId: string) => compile(catalogueComponent('foundation', componentId)!.source!, { filename: `${componentId}.svelte`, generate: 'server', runes: true }).css?.code ?? '';

/** Every stylesheet the exported site ships. */
const siteCss = (s: ProjectState) => [...generateProject(s)].filter(([path]) => path.startsWith('src/lib/siteorigin/styles/')).map(([, css]) => css).join('\n');

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
    expect(Object.keys(branch(SHOWCASE))).toEqual(['eyebrow', 'heading', 'headingLevel', 'lead', 'tabs']);
    expect(Object.keys(branch(BILLING))).toEqual(['eyebrow', 'heading', 'headingLevel', 'lead', 'monthlyLabel', 'annualLabel', 'switchLabel', 'plans']);
    // Two to six tabs, each of its own fields, its icon one of the offered names or "" for none.
    expect(branch(SHOWCASE).tabs).toMatchObject({ type: 'array', minItems: 2, maxItems: 6, items: { type: 'object', properties: { label: { type: 'string' }, icon: { enum: expect.arrayContaining(['', 'compass']) }, copy: { type: 'string' } } } });
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
              tabs: [
                { label: 'Classes', icon: 'users', heading: 'Thirty classes a week', copy: 'Strength, mobility and cardio.\n\nBook from the app.' },
                { label: 'Open gym', heading: 'Your own pace' },
                { label: 'Coaching', icon: 'target', heading: 'A plan made for you', actionLabel: 'Meet a coach', actionLink: '/contact/' }
              ]
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
    expect((showcase.props.tabs as unknown[])[2]).toMatchObject({ label: 'Coaching', icon: 'target', heading: 'A plan made for you', actionLink: { type: 'page' } });
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
    const linked = await renderHome(inserted(SHOWCASE, { tabs: sampleTabs({ actionLink: { type: 'url', target: 'https://example.com/work' } }) }).state);
    expect(linked).toMatch(/<a href="https:\/\/example\.com\/work"[^>]*>See recent projects<\/a>/);
  });

  it('has a tab for each of its two to six tabs, each with only its own panel, and names a blank one by its place', async () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => ({ label: `Stage ${n}`, heading: `Stage ${n} heading` }));
    const { state } = inserted(SHOWCASE, { tabs: six });
    let html = await renderHome(state);
    expect(tagsWith(html, 'role', 'tab').map((t) => textAfter(html, t))).toEqual(['Stage 1', 'Stage 2', 'Stage 3', 'Stage 4', 'Stage 5', 'Stage 6']);
    expect(tagsWith(html, 'role', 'tabpanel').map((p) => html.slice(html.indexOf(p)).match(/<h3[^>]*>([^<]*)</)?.[1])).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Stage ${n} heading`));
    // Removing a tab leaves it out with its panel; two always stay.
    const two = inserted(SHOWCASE, { tabs: sampleTabs().slice(0, 2) }).state;
    html = await renderHome(two);
    expect(tagsWith(html, 'role', 'tab').map((t) => textAfter(html, t))).toEqual(['Design', 'Build']);
    expect(tagsWith(html, 'role', 'tabpanel')).toHaveLength(2);
    expect(html).not.toContain('Looked after long after we leave');
    const list = catalogueComponent('foundation', SHOWCASE)!.properties.tabs;
    expect(list.type === 'list' && [list.min, list.max]).toEqual([2, 6]);
    // A blank first label still names its tab.
    html = await renderHome(inserted(SHOWCASE, { tabs: sampleTabs({ label: ' ' }) }).state);
    expect(textAfter(html, tagsWith(html, 'role', 'tab')[0])).toBe('Tab 1');
  });

  it('follows the tone a placement chooses', async () => {
    for (const tone of ['muted', 'inverse']) {
      const { state, def: placed } = inserted(SHOWCASE, undefined, fresh());
      const r = apply(state, [{ type: 'instance.setVariant', owner: owner(state), nodeId: home(state).rootIds[0], axis: 'tone', variant: tone }]).state;
      expect(compileWarnings(r, placed)).toEqual([]);
      // The showcase is the page's first section.
      const root = tagsWith(await renderHome(r), 'class').find((t) => t.startsWith('<section'))!;
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
    expect(html.match(/per month/g)).toHaveLength(3);
    // Every plan's annual price is in the page too, its row hidden while scripts run: a page whose scripts never run
    // (whose switch does nothing) shows both periods (#885).
    // Each plan's rows, by the price each shows: the monthly one on, the annual one off.
    const rows = (prices: string[]) => prices.map((price) => html.slice(0, html.indexOf(`>${price}<`) + 1).match(/<[a-z]+\b[^>]*\sclass="([^"]*)"[^>]*>\s*<[^>]*>$/)?.[1].split(' ').includes(CHOICE_OFF_CLASS));
    expect(rows(['$29', '$49', '$119'])).toEqual([false, false, false]);
    expect(rows(['$290', '$490', '$1,190'])).toEqual([true, true, true]);
    for (const price of ['$290', '$490', '$1,190']) expect(html).toContain(`>${price}<`);
    expect(html.match(/per year, billed once/g)).toHaveLength(3);
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
    // With neither a price nor a note for the period, the row leaves nothing behind: nothing is left to hide.
    expect(html).not.toContain(CHOICE_OFF_CLASS);
  });

  it('is its own section beside the plain one, which keeps its fixed prices', () => {
    const fields = (componentId: string) => {
      const plans = catalogueComponent('foundation', componentId)!.properties.plans;
      return plans.type === 'list' ? Object.keys(plans.fields) : [];
    };
    expect(fields('pricing.plans')).toContain('price');
    expect(fields('pricing.plans')).not.toContain('annualPrice');
    expect(fields(BILLING)).toEqual(expect.arrayContaining(['monthlyPrice', 'monthlyNote', 'annualPrice', 'annualNote']));
  });
});

describe('a copy of the showcase', () => {
  it('keeps its schema through the schema edits a copy takes, its icon’s None included', () => {
    const { state, def } = inserted(SHOWCASE);
    const forked = applyOperations(state, [{ type: 'component.fork', definitionId: def.id }]);
    const copy = forked.results[0].definitionId as string;
    const schema = forked.state.components[copy].properties.tabs;
    const again = applyOperations(forked.state, [{ type: 'component.setPropSchema', definitionId: copy, prop: 'tabs', schema: structuredClone(schema) as unknown as Record<string, unknown> }]);
    expect((again.state.components[copy].properties.tabs as { fields: Record<string, { options?: Array<{ value: string }> }> }).fields.icon.options![0]).toEqual({ value: '', label: 'None' });
    expect(validateState(again.state).filter(blocksSaving)).toEqual([]);
    // An empty choice needs a name to be offered by.
    const unnamed = { ...schema, fields: { ...(schema as { fields: Record<string, unknown> }).fields, icon: { type: 'enum', label: 'Tab icon', options: ['', 'compass'] } } };
    expect(() => applyOperations(forked.state, [{ type: 'component.setPropSchema', definitionId: copy, prop: 'tabs', schema: unnamed }])).toThrow(/an empty one \(""\) needs a label/);
    const unlabelled = { ...unnamed, fields: { ...unnamed.fields, icon: { type: 'enum', label: 'Tab icon', options: [{ value: '' }, 'compass'] } } };
    expect(() => applyOperations(forked.state, [{ type: 'component.setPropSchema', definitionId: copy, prop: 'tabs', schema: unlabelled }])).toThrow(/an empty one \(""\) needs a label/);
  });
});

describe('print', () => {
  it('prints every present tab’s panel under its label without the tab row, and the plans without the switch', () => {
    const { state } = inserted(BILLING, undefined, inserted(SHOWCASE).state);
    const css = siteCss(state);
    expect(css).toMatch(new RegExp(`@media not print \\{\\s*\\.${SCRIPTS_CLASS} \\.${STATE_OFF_CLASS}:not\\(#so-print\\) \\{ display: none !important; \\}`));
    // The billing period not chosen is left out of print as well, while scripts run.
    expect(css).toMatch(new RegExp(`\\n\\.${SCRIPTS_CLASS} \\.${CHOICE_OFF_CLASS}:not\\(#so-print\\) \\{ display: none !important; \\}`));
    const print = getTheme('foundation').baseCss.slice(getTheme('foundation').baseCss.indexOf('@media print'));
    expect(print).toContain('.so-tablist:not(#so-print) { display: none !important; }');
    // Only the billing switch of Foundation's pricing, in its own styles: other groups of buttons print.
    expect(print).not.toMatch(new RegExp(`\\.${CHOICE_GROUP_CLASS}[^{}]*\\{[^}]*display: none`));
    expect(ownCss(BILLING)).toMatch(/@media print \{\s*\.billing__switch\.svelte-[a-z0-9]+ \{\s*display: none;/);
    expect(print).toContain("[role='tabpanel'][data-tab-label]:not([data-tab-label=''])::before");
  });
});

describe('without scripts (#885)', () => {
  it('shows every tab’s panel under its label and both billing periods, without the controls that would do nothing', async () => {
    const { state } = inserted(SHOWCASE);
    const files = generateProject(state);
    // The page marks itself as running scripts in <head>, before the body shows; without that mark nothing a state
    // hides is hidden.
    expect(files.get('src/app.html')).toMatch(new RegExp(`<script>document\\.documentElement\\.classList\\.add\\("${SCRIPTS_CLASS}"\\);</script>\\n\\t\\t%sveltekit\\.head%`));
    const css = siteCss(state);
    // No rule hides it whether or not scripts run.
    expect(css).not.toMatch(new RegExp(`^\\s*\\.${STATE_OFF_CLASS}`, 'm'));
    // Every panel is in the page, with its content, and the ones not chosen carry only the class that hides them.
    const html = await renderHome(state);
    const panels = tagsWith(html, 'role', 'tabpanel');
    expect(panels).toHaveLength(3);
    expect(panels.map((p) => attrOf(p, 'class')!.split(' ').includes(STATE_OFF_CLASS))).toEqual([false, true, true]);
    for (const words of ['Plans drawn around how you live', 'One team from demolition to handover', 'Looked after long after we leave']) expect(html).toContain(words);
    expect(attrOf(tagsWith(html, 'role', 'tablist')[0], 'class')!.split(' ')).toContain('so-tablist');
    // On screen without scripts, the theme lays them out as printed: each under its tab's label, the tab row and
    // Pricing's switch left out.
    const screen = getTheme('foundation').baseCss.slice(getTheme('foundation').baseCss.indexOf('@media not print {'), getTheme('foundation').baseCss.indexOf('@media print'));
    const off = `:root:not(.${SCRIPTS_CLASS})`;
    expect(screen).toContain(`${off} .so-tablist:not(#so-print) { display: none !important; }`);
    expect(ownCss(BILLING)).toMatch(/:where\(:root:not\(\.so-js\)\) \.billing__switch\.svelte-[a-z0-9]+ \{\s*display: none;/);
    expect(screen).toContain(`${off} [role='tabpanel'][data-tab-label]:not([data-tab-label=''])::before {\n    content: attr(data-tab-label);`);
    expect(screen).toContain(`${off} [role='tabpanel'] + [role='tabpanel'] { margin-block-start: 1.5em; }`);
  });

  it('leaves the site search out, as nothing could search', () => {
    const search = catalogueComponent('foundation', 'site.search')!;
    const source = (search.kind === 'code' ? search.source : undefined) ?? '';
    expect(source).toContain('<form class="so-search__form"');
    const { css } = compile(source, { filename: 'SiteSearch.svelte', generate: 'server', runes: true });
    expect(css?.code).toMatch(new RegExp(`:where\\(:root:not\\(\\.${SCRIPTS_CLASS}\\)\\) \\.so-search\\.svelte-[a-z0-9]+:not\\(#so-no-js\\) \\{\\s*display: none !important;`));
  });
});
