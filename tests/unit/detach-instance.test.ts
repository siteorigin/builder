/**
 * Detaching a placement (#373): one managed component placed on a page becomes the page elements it renders, looking
 * the same, while the component and its other placements stay as they were, and one Undo brings it back.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, GraphNode, InstanceNode, ProjectState, ResponsiveStyles, StyleProps, TextNode } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { cascadeStyles, flattenStyles, type StyleLayer } from '@shared/styles';
import { designLayers } from '@shared/variants';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { introducedDiagnostics, validateState } from '@engine/validate';
import { defKey, generateProject, generateSiteCss } from '@generator/index';
import { ProjectSession } from '../../src/main/project/session';

const DEF = 'proj.showcase-ab12c';
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const SIZES = ['phone', 'tablet', 'desktop'] as const;

/** A project component that uses every way a design varies with its placement. */
function showcase(): ComponentDefinition {
  const n = (id: string, node: Record<string, unknown>) => [id, { id, ...node }];
  return {
    schemaVersion: SCHEMA_VERSION,
    id: DEF,
    componentId: 'project.showcase',
    contractVersion: 1,
    kind: 'managed',
    owner: 'project',
    name: 'Showcase',
    description: 'Test component.',
    category: 'custom',
    tags: ['custom'],
    icon: 'component',
    properties: {
      heading: { type: 'string', label: 'Heading', default: 'Default heading' },
      level: { type: 'enum', label: 'Level', default: 'h2', options: [{ value: 'h2', label: 'H2' }, { value: 'h3', label: 'H3' }] },
      lead: { type: 'string', label: 'Lead', default: '' },
      showBadge: { type: 'boolean', label: 'Badge', default: false },
      items: {
        type: 'list',
        label: 'Items',
        itemLabel: 'Card',
        fields: { title: { type: 'string', label: 'Title', default: '' }, featured: { type: 'boolean', label: 'Featured', default: false } },
        default: [{ id: 'd1', title: 'Default card', featured: false }]
      },
      cta: { type: 'link', label: 'Link', default: { type: 'url', target: 'https://example.com/default' } },
      ctaLabel: { type: 'string', label: 'Button', default: '' },
      look: { type: 'enum', label: 'Look', default: 'primary', options: [{ value: 'primary', label: 'Primary' }, { value: 'secondary', label: 'Secondary' }] }
    },
    parts: {
      root: { nodeId: 'root', label: 'Root' },
      heading: { nodeId: 'heading', label: 'Heading' },
      card: { nodeId: 'card', label: 'Card' },
      title: { nodeId: 'title', label: 'Title' }
    },
    slots: { extra: { label: 'Extra' } },
    variantAxes: {
      tone: {
        label: 'Tone',
        default: 'default',
        options: {
          default: { label: 'Default', styles: { root: { base: { background: '#ffffff' } } } },
          inverse: { label: 'Inverse', styles: { root: { base: { background: '#111111', color: '#ffffff' } }, title: { base: { color: '#eeeeee' } } } }
        }
      },
      layout: {
        label: 'Layout',
        default: 'stack',
        options: {
          stack: { label: 'Stack' },
          grid: { label: 'Grid', styles: { grid: { base: { columns: 3 }, phone: { gap: '8px' } } } }
        }
      }
    },
    tree: {
      rootIds: ['root'],
      nodes: Object.fromEntries([
        n('root', { kind: 'element', tag: 'section', name: 'Showcase root', children: ['heading', 'lead', 'nolead', 'badge', 'grid', 'extra', 'actions'], styles: { base: { paddingBlock: '32px' } } }),
        n('heading', { kind: 'text', tag: { $prop: 'level' }, text: { $prop: 'heading' }, styles: { base: { color: '#222222' }, phone: { color: '#333333' } } }),
        n('lead', { kind: 'text', tag: 'p', text: { $prop: 'lead' }, when: { $prop: 'lead' } }),
        n('nolead', { kind: 'text', tag: 'p', text: 'No lead', unless: { $prop: 'lead' } }),
        n('badge', { kind: 'text', tag: 'span', text: 'New', when: { $prop: 'showBadge' } }),
        n('grid', { kind: 'element', tag: 'div', children: ['rep'], styles: { base: { layout: 'grid', columns: 1 } } }),
        n('rep', { kind: 'repeat', list: { $prop: 'items' }, children: ['card'] }),
        n('card', { kind: 'element', tag: 'article', children: ['title', 'flag'], styles: { base: { padding: '16px' } } }),
        n('title', { kind: 'text', tag: 'h3', text: { $item: 'title' } }),
        n('flag', { kind: 'text', tag: 'span', text: 'Featured', when: { ref: { $item: 'featured' }, eq: true } }),
        n('extra', { kind: 'slot', slot: 'extra' }),
        n('actions', { kind: 'element', tag: 'div', collapseEmpty: true, children: ['cta'] }),
        n('cta', { kind: 'link', link: { $prop: 'cta' }, label: { $prop: 'ctaLabel' }, appearance: { $prop: 'look' }, when: { $prop: 'ctaLabel' } })
      ])
    },
    provenance: { createdBy: 'user' },
    license: 'Project'
  } as unknown as ComponentDefinition;
}

/** A blank site whose Home holds a paragraph, the placement to detach, a paragraph, and a second placement. */
function project() {
  const s = createStarterState('blank', 'Detach', false);
  const page = home(s);
  page.rootIds = [];
  page.nodes = {};
  s.components[DEF] = showcase();
  const add = (node: GraphNode) => {
    page.nodes[node.id] = node;
    page.rootIds.push(node.id);
    return node;
  };
  add({ id: 'n_before', kind: 'text', tag: 'p', text: 'Before' } as TextNode);
  page.nodes.n_slotted = { id: 'n_slotted', kind: 'text', tag: 'p', text: 'Slotted words' } as TextNode;
  const target = add({
    id: 'n_target',
    kind: 'instance',
    definitionId: DEF,
    name: 'Our showcase',
    anchor: 'work',
    props: {
      heading: 'Our work',
      level: 'h3',
      lead: 'A short lead',
      items: [
        { id: 'i1', title: 'One', featured: false },
        { id: 'i2', title: 'Two', featured: true }
      ],
      cta: { type: 'url', target: 'https://example.com/talk' },
      ctaLabel: 'Talk to us',
      look: 'secondary'
    },
    variants: { tone: 'inverse', layout: 'grid' },
    overrides: { heading: { base: { color: '#ff0000' } }, card: { phone: { hidden: true } } },
    itemOverrides: { card: { list: 'items', items: { i2: { phone: { hidden: false } } } } },
    slots: { extra: ['n_slotted'] }
  } as InstanceNode);
  add({ id: 'n_after', kind: 'text', tag: 'p', text: 'After' } as TextNode);
  add({ id: 'n_other', kind: 'instance', definitionId: DEF, props: {} } as InstanceNode);
  return { s, target: target as InstanceNode };
}

const detach = (s: ProjectState, nodeId = 'n_target') => applyOperations(s, [{ type: 'component.detachInstance', owner: owner(s), nodeId } as EditOperation]);

/** The page nodes under one, depth first. */
function descendants(s: ProjectState, id: string): GraphNode[] {
  const n = home(s).nodes[id];
  if (!n) return [];
  return [n, ...(n.kind === 'element' ? n.children.flatMap((c) => descendants(s, c)) : [])];
}
const byText = (s: ProjectState, root: string, text: string) => descendants(s, root).find((n) => n.kind === 'text' && n.text === text) as TextNode;
const parentOf = (s: ProjectState, id: string) => Object.values(home(s).nodes).find((n) => n.kind === 'element' && n.children.includes(id))!;
/** What a single rule of these styles gives each size. */
const perSize = (styles: ResponsiveStyles | undefined) => {
  const c = cascadeStyles([{ styles, strength: 1 }]);
  return Object.fromEntries(SIZES.map((sz) => [sz, c[sz] ?? {}]));
};

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Server-render the exported Home page, whitespace between tags removed. */
async function renderHome(s: ProjectState): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'detach-render-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => p; export const base = "";\n');
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
  return render(Page, { props: {} })
    .body.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><');
}
/** Markup with the generated class names left out: what a visitor gets apart from how the stylesheet finds it. */
const unclassed = (html: string) => html.replace(/\sclass="[^"]*"/g, '');

describe('component.detachInstance (#373)', () => {
  it('detaches one placement at its index with the content, branches, repeats and slot content it showed', () => {
    const { s } = project();
    const before = structuredClone(s);
    const r = detach(s);
    const after = r.state;
    const page = home(after);
    const rootId = r.results[0].nodeId as string;
    // In the placement's place, between the same siblings; the second placement is untouched.
    expect(page.rootIds).toEqual(['n_before', rootId, 'n_after', 'n_other']);
    expect(page.nodes.n_target).toBeUndefined();
    expect(page.nodes.n_other).toEqual(home(before).nodes.n_other);
    expect(after.components).toEqual(before.components);
    for (const [id, p] of Object.entries(after.pages)) if (id !== after.site.homePageId) expect(p).toEqual(before.pages[id]);

    const root = page.nodes[rootId];
    expect(root).toMatchObject({ kind: 'element', tag: 'section', name: 'Our showcase', anchor: 'work', detachedFrom: { component: defKey(DEF), node: 'root', options: { tone: 'inverse', layout: 'grid' } } });
    const nodes = descendants(after, rootId);
    // Nothing of the design's machinery is left: no bindings, conditions, repeats or slots.
    const json = JSON.stringify(nodes);
    expect(json).not.toMatch(/"\$prop"|"\$item"|"when"|"unless"|"collapseEmpty"/);
    expect(nodes.some((n) => n.kind === 'repeat' || n.kind === 'slot' || n.kind === 'instance')).toBe(false);
    // Fresh IDs for everything made; the slot content keeps its own.
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    expect(nodes.filter((n) => n.id !== 'n_slotted').every((n) => !Object.hasOwn(home(before).nodes, n.id))).toBe(true);

    // Properties as their values: the bound tag, the lead it shows, no badge it hides.
    expect(byText(after, rootId, 'Our work')).toMatchObject({ kind: 'text', tag: 'h3' });
    expect(byText(after, rootId, 'A short lead')).toMatchObject({ tag: 'p' });
    expect(byText(after, rootId, 'New')).toBeUndefined();
    expect(byText(after, rootId, 'No lead')).toBeUndefined();
    // One card per item, in order, each with its own title, and the flag only where the item is featured.
    const cards = descendants(after, rootId).filter((n) => n.kind === 'element' && n.tag === 'article');
    expect(cards.map((c) => descendants(after, c.id).filter((n) => n.kind === 'text').map((t) => (t as TextNode).text))).toEqual([['One'], ['Two', 'Featured']]);
    // The slot content in the slot's place, after the grid; the button with its link, label and look.
    const kids = (root as GraphNode & { kind: 'element' }).children;
    expect(kids.indexOf('n_slotted')).toBe(kids.indexOf(parentOf(after, cards[0].id).id) + 1);
    expect(page.nodes.n_slotted).toEqual(home(before).nodes.n_slotted);
    const cta = nodes.find((n) => n.kind === 'link');
    expect(cta).toMatchObject({ link: { type: 'url', target: 'https://example.com/talk' }, label: 'Talk to us', appearance: 'secondary' });
    expect(Object.keys(page.nodes).sort()).toEqual([...nodes.map((n) => n.id), 'n_after', 'n_before', 'n_other'].sort());

    // A valid page: nothing new to report.
    expect(introducedDiagnostics(validateState(before), validateState(after))).toEqual([]);
  });

  it('keeps the cascade the design, options and placement gave each element, at every size', () => {
    const { s, target } = project();
    const def = s.components[DEF];
    const r = detach(s);
    const after = r.state;
    const rootId = r.results[0].nodeId as string;
    const layers = (nodeId: string, partId?: string, item?: string): StyleLayer[] => {
      const design = designLayers(def, nodeId, target.variants);
      const out: StyleLayer[] = [...design];
      if (partId && target.overrides?.[partId]) out.push({ styles: target.overrides[partId], strength: 3, wideColumns: true, unhides: design.map((l) => l.styles) });
      if (partId && item) out.push({ styles: target.itemOverrides?.[partId]?.items[item], strength: 4, wideColumns: true, unhides: [...design.map((l) => l.styles), target.overrides?.[partId]] });
      return out;
    };
    const expectSame = (node: GraphNode, want: StyleLayer[]) => {
      const was = cascadeStyles(want);
      const now = perSize(node.styles);
      for (const sz of SIZES) {
        const { hidden, ...rest } = was[sz] ?? {};
        // Shown again over a hide: the detached element has none to undo, so it simply shows.
        const expected: StyleProps = hidden === true ? { ...rest, hidden } : rest;
        const { customCss: _shown, ...got } = now[sz];
        expect(got, `${node.id} at ${sz}`).toEqual(expected);
      }
    };
    const root = home(after).nodes[rootId];
    expectSame(root, layers('root', 'root'));
    // A stronger value for all sizes beats a weaker one for phones.
    const heading = byText(after, rootId, 'Our work');
    expectSame(heading, layers('heading', 'heading'));
    expect(heading.styles).toEqual({ base: { color: '#ff0000' } });
    // A multi-column option keeps the design's phone column; its phone gap stays on phones.
    const cards = descendants(after, rootId).filter((n) => n.kind === 'element' && n.tag === 'article');
    const grid = parentOf(after, cards[0].id);
    expectSame(grid, layers('grid'));
    expect(perSize(grid.styles)).toMatchObject({ phone: { columns: 1, gap: '8px' }, tablet: { columns: 3 }, desktop: { columns: 3 } });
    expect(perSize(grid.styles).tablet.gap).toBeUndefined();
    // The shared phone hide stays on the first card; the second card's own styles show it again.
    expectSame(cards[0], layers('card', 'card', 'i1'));
    expectSame(cards[1], layers('card', 'card', 'i2'));
    expect(perSize(cards[0].styles).phone.hidden).toBe(true);
    expect(perSize(cards[1].styles).phone.hidden).toBeUndefined();
    // ...with the display the stylesheet gave it there (an article: the browser's own).
    expect(cards[1].styles?.phone?.customCss).toBe('display: revert');
    // The selected option's colour on each repeated title.
    for (const c of cards) expect(descendants(after, c.id)[1].styles).toEqual({ base: { color: '#eeeeee' } });
  });

  it('renders the same markup, and its stylesheet styles the new elements', async () => {
    const { s } = project();
    const r = detach(s);
    const was = await renderHome(s);
    const now = await renderHome(r.state);
    expect(unclassed(now)).toBe(unclassed(was));
    expect(now).toContain(`so--d-${defKey(DEF)}--tone-inverse`);
    const css = generateSiteCss(r.state);
    const heading = byText(r.state, r.results[0].nodeId as string, 'Our work');
    expect(css).toMatch(new RegExp(`\\.so-n-${heading.id} \\{\\n\\tcolor: #ff0000;`));
  });

  it('undoes in one step, back to the placement as it was, and redoes with the same elements', async () => {
    const { s } = project();
    const dir = mkdtempSync(join(tmpdir(), 'so-detach-'));
    sessions.push(dir);
    const session = await ProjectSession.create(dir, s);
    const before = structuredClone(session.state);
    const r = await session.apply({ operations: [{ type: 'component.detachInstance', owner: owner(s), nodeId: 'n_target' }] }, { label: 'Detach component' });
    expect(r.ok).toBe(true);
    const detached = structuredClone(session.state);
    expect(session.historyInfo().undoLabel).toBe('Detach component');
    await session.undo();
    expect(home(session.state)).toEqual(home(before));
    expect(session.state.components).toEqual(before.components);
    await session.redo();
    expect(home(session.state)).toEqual(home(detached));
  });

  it('names what replaces an unnamed placement after its component, with the branches its defaults pick', () => {
    const { s } = project();
    const r = detach(s, 'n_other');
    const rootId = r.results[0].nodeId as string;
    expect(home(r.state).nodes[rootId]).toMatchObject({ name: 'Showcase', tag: 'section' });
    expect(home(r.state).nodes[rootId].anchor).toBeUndefined();
    // No lead: the lead goes and the words shown without one stay; the default tag and the default card.
    expect(byText(r.state, rootId, 'Default heading')).toMatchObject({ tag: 'h2' });
    expect(byText(r.state, rootId, 'No lead')).toBeDefined();
    expect(byText(r.state, rootId, 'Default card')).toBeDefined();
    // No button label: the button goes, and the container that holds only it collapses with it.
    const nodes = descendants(r.state, rootId);
    expect(nodes.some((n) => n.kind === 'link')).toBe(false);
    // Heading, the words shown without a lead, and the grid: the empty slot adds nothing.
    expect((home(r.state).nodes[rootId] as GraphNode & { kind: 'element' }).children).toHaveLength(3);
  });

  it('keeps words, looks and object fields as they rendered', () => {
    const { s } = project();
    const def = s.components[DEF];
    def.properties.look2 = { type: 'string', label: 'Look 2', default: '' };
    def.properties.box = { type: 'object', label: 'Box', fields: { label: { type: 'string', label: 'Label', default: '' } }, default: { label: 'From the object' } } as never;
    const root = def.tree!.nodes.root as GraphNode & { kind: 'element' };
    root.children = ['hours', 'plain', 'boxed', 'extra'];
    def.tree!.nodes.hours = { id: 'hours', kind: 'text', tag: 'p', text: [{ type: 'p', spans: [{ text: 'Hours' }] }] } as unknown as GraphNode;
    def.tree!.nodes.plain = { id: 'plain', kind: 'link', link: { type: 'url', target: 'https://example.com' }, label: 'Plain words', appearance: { $prop: 'look2' } } as unknown as GraphNode;
    def.tree!.nodes.boxed = { id: 'boxed', kind: 'text', tag: 'p', text: { $prop: 'box', field: 'label' } } as unknown as GraphNode;
    (home(s).nodes.n_target as InstanceNode).props.box = {};
    const r = detach(s);
    const nodes = descendants(r.state, r.results[0].nodeId as string);
    expect(nodes.find((n) => n.kind === 'text' && n.text === 'Hours')).toBeDefined();
    expect(nodes.find((n) => n.kind === 'link')).toMatchObject({ label: 'Plain words', appearance: '' });
    expect(nodes.find((n) => n.kind === 'text' && n.text === 'From the object')).toBeDefined();
  });

  it('names a navigation landmark as its heading did', () => {
    const { s } = project();
    const def = s.components[DEF];
    def.properties.navTitle = { type: 'string', label: 'Nav title', default: 'Sections' };
    (def.tree!.nodes.root as GraphNode & { kind: 'element' }).children = ['nav', 'extra'];
    def.tree!.nodes.nav = { id: 'nav', kind: 'element', tag: 'nav', children: ['navHeading', 'cta'] } as GraphNode;
    def.tree!.nodes.navHeading = { id: 'navHeading', kind: 'text', tag: 'h2', text: { $prop: 'navTitle' }, when: { $prop: 'navTitle' } } as GraphNode;
    (home(s).nodes.n_target as InstanceNode).props.navTitle = 'On this page';
    let r = detach(s);
    expect(descendants(r.state, r.results[0].nodeId as string).find((n) => n.kind === 'element' && n.tag === 'nav')).toMatchObject({ ariaLabel: 'On this page' });
    // A hidden heading: the landmark keeps the heading's default name, as the generated page gives it.
    (home(s).nodes.n_target as InstanceNode).props.navTitle = '';
    r = detach(s);
    expect(descendants(r.state, r.results[0].nodeId as string).find((n) => n.kind === 'element' && n.tag === 'nav')).toMatchObject({ ariaLabel: 'Sections' });
  });

  it('refuses to leave elements in a slot that takes only components', () => {
    const { s } = project();
    s.components['proj.holder-aa1aa'] = {
      ...showcase(),
      id: 'proj.holder-aa1aa',
      name: 'Holder',
      properties: {},
      parts: { root: { nodeId: 'h', label: 'Holder' } },
      variantAxes: undefined,
      slots: { main: { label: 'Main', categories: ['custom'] } },
      tree: { rootIds: ['h'], nodes: { h: { id: 'h', kind: 'element', tag: 'div', children: ['m'] }, m: { id: 'm', kind: 'slot', slot: 'main' } } as Record<string, GraphNode> }
    } as unknown as ComponentDefinition;
    const page = home(s);
    page.nodes.n_holder = { id: 'n_holder', kind: 'instance', definitionId: 'proj.holder-aa1aa', props: {}, slots: { main: ['n_target'] } } as InstanceNode;
    page.rootIds = page.rootIds.map((id) => (id === 'n_target' ? 'n_holder' : id));
    expect(() => detach(s)).toThrow(/takes custom components, not a container\. Detaching “Our showcase” there/);
  });

  it('copies slot content the design shows more than once, and refuses to drop content it does not show', () => {
    const { s } = project();
    const def = s.components[DEF];
    // The slot inside each card: once per item.
    def.tree!.nodes.root = { ...def.tree!.nodes.root, children: ['heading', 'grid', 'actions'] } as GraphNode;
    def.tree!.nodes.card = { ...def.tree!.nodes.card, children: ['title', 'extra'] } as GraphNode;
    const r = detach(s);
    const rootId = r.results[0].nodeId as string;
    const slotted = descendants(r.state, rootId).filter((n) => n.kind === 'text' && n.text === 'Slotted words');
    expect(slotted.map((n) => n.id)).toEqual(['n_slotted', expect.not.stringMatching(/^n_slotted$/)]);

    const hidden = project().s;
    hidden.components[DEF].tree!.nodes.extra = { id: 'extra', kind: 'slot', slot: 'extra', when: { $prop: 'showBadge' } } as GraphNode;
    expect(() => detach(hidden)).toThrow(/content in its Extra that its current settings do not show/);
  });

  it('refuses what it cannot detach: the shared header and footer, code components, a design inside a design', () => {
    const { s } = project();
    expect(() => applyOperations(s, [{ type: 'component.detachInstance', owner: { kind: 'shell', id: 'header' }, nodeId: s.site.shell.header.rootIds[0] }])).toThrow(EngineError);
    expect(() => applyOperations(s, [{ type: 'component.detachInstance', owner: { kind: 'component', id: DEF }, nodeId: 'heading' }])).toThrow(/inside another component/);
    s.components[DEF] = { ...s.components[DEF], kind: 'code', tree: undefined, source: '<section></section>' } as ComponentDefinition;
    expect(() => detach(s)).toThrow(/code component/);
    // A placement whose settings show nothing has nothing to detach.
    const empty = project().s;
    empty.components[DEF].tree!.nodes.root.when = { $prop: 'showBadge' };
    expect(() => detach(empty)).toThrow(/shows nothing/);
  });

  it('keeps a component placed inside the design as a placement, given its values and what beat its own design', () => {
    const { s } = project();
    const inner: ComponentDefinition = {
      ...showcase(),
      id: 'proj.badge-zz9zz',
      componentId: 'project.badge',
      name: 'Badge',
      properties: { label: { type: 'string', label: 'Label', default: 'Badge' } },
      parts: { root: { nodeId: 'b', label: 'Badge' } },
      slots: undefined,
      variantAxes: { size: { label: 'Size', default: 'small', options: { small: { label: 'Small', styles: { b: { base: { fontSize: '12px' } } } }, large: { label: 'Large', styles: { b: { base: { fontSize: '20px' } } } } } } },
      tree: { rootIds: ['b'], nodes: { b: { id: 'b', kind: 'text', tag: 'span', text: { $prop: 'label' }, styles: { base: { color: '#000000' } } } as GraphNode } }
    } as ComponentDefinition;
    s.components[inner.id] = inner;
    const def = s.components[DEF];
    def.properties.size = { type: 'enum', label: 'Size', default: 'large', options: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }] };
    // Placed in each card, labelled with the item's title and sized from the outer placement.
    def.tree!.nodes.pill = { id: 'pill', kind: 'instance', definitionId: inner.id, props: { label: { $item: 'title' } }, variants: { size: { $prop: 'size' } }, styles: { base: { color: '#00aa00', fontSize: '14px' } } } as unknown as GraphNode;
    def.tree!.nodes.card = { ...def.tree!.nodes.card, children: ['title', 'pill'] } as GraphNode;
    def.parts.pill = { nodeId: 'pill', label: 'Pill' };
    (home(s).nodes.n_target as InstanceNode).overrides!.pill = { phone: { color: '#0000ff' } };
    const r = detach(s);
    const pills = descendants(r.state, r.results[0].nodeId as string).filter((n): n is InstanceNode => n.kind === 'instance');
    expect(pills.map((p) => [p.definitionId, p.props.label, p.variants?.size])).toEqual([
      [inner.id, 'One', 'large'],
      [inner.id, 'Two', 'large']
    ]);
    // Its own colour lost to the design's (one class each, the design's later) and the placement's phone colour beats
    // both; the large option's size (two classes) beat the design's one-class size, so it is left to that option.
    expect(pills[0].overrides).toEqual({ root: { base: { color: '#00aa00' }, phone: { color: '#0000ff' } } });
    // Pills carry the design's classes for the theme, as the root it was forwarded to did.
    expect(pills[0].detachedFrom).toEqual({ component: defKey(DEF), node: 'pill' });

    // The same design, but the placed component's own block comes later in the stylesheet: its colour won, and stays its own.
    const later = structuredClone(s);
    const moved = { ...later.components[inner.id], id: 'proj.zz-badge-zz9zz' } as ComponentDefinition;
    delete later.components[inner.id];
    later.components[moved.id] = moved;
    (later.components[DEF].tree!.nodes.pill as InstanceNode).definitionId = moved.id;
    const r2 = detach(later);
    const pills2 = descendants(r2.state, r2.results[0].nodeId as string).filter((n): n is InstanceNode => n.kind === 'instance');
    expect(pills2[0].overrides).toEqual({ root: { phone: { color: '#0000ff' } } });
  });

  it('keeps a detached gallery one group in the image viewer, apart from another gallery', async () => {
    const s = createStarterState('blank', 'Gallery', false);
    const page = home(s);
    page.rootIds = [];
    page.nodes = {};
    const ids = ['a_one', 'a_two', 'a_three'];
    for (const id of ids) s.assets.assets[id] = { id, name: id, file: `static/assets/${id}.jpg`, mime: 'image/jpeg', bytes: 1, width: 10, height: 10, hash: 'x', kind: 'image', createdAt: '' } as never;
    const images = (prefix: string) => ids.map((id, i) => ({ id: `${prefix}${i}`, image: { assetId: id, alt: `Photo ${i}` }, caption: `Caption ${i}`, action: 'image', link: { type: 'none', target: '' } }));
    let placed = applyOperations(s, [{ type: 'node.insert', owner: owner(s), componentId: 'media.gallery' }]);
    let state = placed.state;
    const first = placed.results[0].nodeId as string;
    state = applyOperations(state, [{ type: 'instance.setProp', owner: owner(state), nodeId: first, prop: 'images', value: images('x') }]).state;
    placed = applyOperations(state, [{ type: 'node.insert', owner: owner(state), componentId: 'media.gallery' }]);
    state = placed.state;
    const second = placed.results[0].nodeId as string;
    state = applyOperations(state, [{ type: 'instance.setProp', owner: owner(state), nodeId: second, prop: 'images', value: images('y') }]).state;
    /** Each viewer link's group, numbered in order of first appearance: which images move through together. */
    const grouping = (html: string) => {
      const seen: string[] = [];
      return [...html.matchAll(/data-viewer-group="([^"]*)"/g)].map((m) => {
        if (!seen.includes(m[1])) seen.push(m[1]);
        return seen.indexOf(m[1]);
      });
    };
    const was = grouping(await renderHome(state));
    expect(was).toEqual([0, 0, 0, 1, 1, 1]);
    const r = applyOperations(state, [{ type: 'component.detachInstance', owner: owner(state), nodeId: first }]);
    expect(grouping(await renderHome(r.state))).toEqual(was);
    // A copy of the detached gallery is a gallery of its own.
    const copied = applyOperations(r.state, [{ type: 'node.duplicate', owner: owner(r.state), nodeId: r.results[0].nodeId as string }]).state;
    expect(grouping(await renderHome(copied))).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  });

  it('decides a field of an object property the placement leaves out by the object default, conditions included', () => {
    const { s } = project();
    const def = s.components[DEF];
    def.properties.box = { type: 'object', label: 'Box', fields: { label: { type: 'string', label: 'Label', default: '' } }, default: { label: 'Boxed' } } as never;
    (def.tree!.nodes.root as GraphNode & { kind: 'element' }).children = ['guarded', 'extra'];
    def.tree!.nodes.guarded = { id: 'guarded', kind: 'text', tag: 'p', text: 'Has a label', when: { $prop: 'box', field: 'label' } } as unknown as GraphNode;
    (home(s).nodes.n_target as InstanceNode).props.box = {};
    const r = detach(s);
    expect(descendants(r.state, r.results[0].nodeId as string).some((n) => n.kind === 'text' && n.text === 'Has a label')).toBe(true);
  });

  it('chooses the options of components deeper in a placed component as their own values do', () => {
    const { s } = project();
    const base = showcase();
    // C: sized by an option; only its default (small) sets a size.
    s.components['proj.c-cc1cc'] = { ...base, id: 'proj.c-cc1cc', name: 'C', properties: { label: { type: 'string', label: 'Label', default: 'C' } }, parts: { root: { nodeId: 'c', label: 'C' } }, slots: undefined, variantAxes: { size: { label: 'Size', default: 'small', options: { small: { label: 'Small', styles: { c: { base: { fontSize: '12px' } } } }, large: { label: 'Large' } } } }, tree: { rootIds: ['c'], nodes: { c: { id: 'c', kind: 'text', tag: 'span', text: { $prop: 'label' } } as GraphNode } } } as ComponentDefinition;
    // B: places C at its root, large by its own property.
    s.components['proj.b-bb1bb'] = { ...base, id: 'proj.b-bb1bb', name: 'B', properties: { sz: { type: 'enum', label: 'Size', default: 'large', options: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }] } }, parts: { root: { nodeId: 'b', label: 'B' } }, slots: undefined, variantAxes: undefined, tree: { rootIds: ['b'], nodes: { b: { id: 'b', kind: 'instance', definitionId: 'proj.c-cc1cc', props: {}, variants: { size: { $prop: 'sz' } } } as unknown as GraphNode } } } as ComponentDefinition;
    const def = s.components[DEF];
    (def.tree!.nodes.root as GraphNode & { kind: 'element' }).children = ['pill', 'extra'];
    def.tree!.nodes.pill = { id: 'pill', kind: 'instance', definitionId: 'proj.b-bb1bb', props: {}, styles: { base: { fontSize: '14px' } } } as unknown as GraphNode;
    const r = detach(s);
    const pill = descendants(r.state, r.results[0].nodeId as string).find((n): n is InstanceNode => n.kind === 'instance')!;
    // Large sets no size, so the design's own 14px was what showed.
    expect(pill.overrides?.root).toEqual({ base: { fontSize: '14px' } });
  });

  it('fills an object field the placement and the object leave out from the field’s own default', () => {
    const { s } = project();
    const def = s.components[DEF];
    def.properties.box = { type: 'object', label: 'Box', fields: { label: { type: 'string', label: 'Label', default: 'Field default' } }, default: {} } as never;
    (def.tree!.nodes.root as GraphNode & { kind: 'element' }).children = ['guarded', 'extra'];
    def.tree!.nodes.guarded = { id: 'guarded', kind: 'text', tag: 'p', text: { $prop: 'box', field: 'label' }, when: { $prop: 'box', field: 'label' } } as unknown as GraphNode;
    (home(s).nodes.n_target as InstanceNode).props.box = {};
    const r = detach(s);
    expect(descendants(r.state, r.results[0].nodeId as string).some((n) => n.kind === 'text' && n.text === 'Field default')).toBe(true);
    // A stored value that is not an object shows the defaults too.
    (home(s).nodes.n_target as InstanceNode).props.box = null;
    const none = detach(s);
    expect(descendants(none.state, none.results[0].nodeId as string).some((n) => n.kind === 'text' && n.text === 'Field default')).toBe(true);
  });

  it('keeps a page duplicate’s copy of a detached gallery one viewer group across its sections', () => {
    const { s } = project();
    const page = home(s);
    const card = (id: string) => ({ id, kind: 'element', tag: 'figure', action: 'image', children: [], detachedFrom: { component: 'x', node: 'photo', group: 'g_one|photos' } }) as unknown as GraphNode;
    page.nodes.n_c1 = card('n_c1');
    page.nodes.n_c2 = card('n_c2');
    page.rootIds.push('n_c1', 'n_c2');
    const r = applyOperations(s, [{ type: 'page.duplicate', pageId: page.id }]);
    const copy = r.state.pages[r.results[0].pageId as string];
    const groups = copy.rootIds.map((id) => copy.nodes[id].detachedFrom?.group).filter(Boolean);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toBe(groups[1]);
    expect(groups[0]).not.toBe('g_one|photos');
    expect(groups[0]).toMatch(/\|photos$/);
  });

  it('keeps a code component’s shown marker when a design shows its root again', () => {
    const { s } = project();
    s.components['proj.code-dd1dd'] = { ...showcase(), id: 'proj.code-dd1dd', name: 'Code', kind: 'code', properties: {}, parts: { root: { nodeId: 'root', label: 'Root' } }, slots: undefined, variantAxes: undefined, tree: undefined, source: '<div class={className}></div>' } as unknown as ComponentDefinition;
    const def = s.components[DEF];
    (def.tree!.nodes.root as GraphNode & { kind: 'element' }).children = ['coded', 'extra'];
    def.tree!.nodes.coded = { id: 'coded', kind: 'instance', definitionId: 'proj.code-dd1dd', props: {}, overrides: { root: { base: { hidden: false } } } } as unknown as GraphNode;
    const r = detach(s);
    const coded = descendants(r.state, r.results[0].nodeId as string).find((n): n is InstanceNode => n.kind === 'instance')!;
    expect(coded.overrides?.root?.base?.hidden).toBe(false);
    // Shown again on phones only: the marker for phones stays too.
    (s.components[DEF].tree!.nodes.coded as InstanceNode).overrides = { root: { phone: { hidden: false } } };
    const phone = detach(s);
    const codedPhone = descendants(phone.state, phone.results[0].nodeId as string).find((n): n is InstanceNode => n.kind === 'instance')!;
    expect(codedPhone.overrides?.root?.phone?.hidden).toBe(false);
    // The page placement's own show on that part gave the code no marker: it gives none after detaching either.
    (s.components[DEF].tree!.nodes.coded as InstanceNode).overrides = undefined;
    s.components[DEF].parts.coded = { nodeId: 'coded', label: 'Coded' };
    (home(s).nodes.n_target as InstanceNode).overrides = { coded: { phone: { hidden: false } } };
    const page = detach(s);
    const codedPage = descendants(page.state, page.results[0].nodeId as string).find((n): n is InstanceNode => n.kind === 'instance')!;
    expect(codedPage.overrides?.root?.phone?.hidden).toBeUndefined();
    // Over the design's own hide of that part, the placement's show wrote the browser's display there: it still does.
    (s.components[DEF].tree!.nodes.coded as InstanceNode).styles = { base: { hidden: true } };
    const shown = detach(s);
    const codedShown = descendants(shown.state, shown.results[0].nodeId as string).find((n): n is InstanceNode => n.kind === 'instance')!;
    expect(codedShown.overrides?.root).toEqual({ phone: { customCss: 'display: revert' }, tablet: { hidden: true }, desktop: { hidden: true } });
  });

  it('refuses a component with UI state, and leaves a page button no state to change', () => {
    const { s } = project();
    const def = s.components[DEF];
    def.state = { open: { type: 'boolean', label: 'Open', initial: true } };
    expect(() => detach(s)).toThrow(/UI state/);
    // A button still naming state its design no longer declares changes nothing once it is on the page.
    delete def.state;
    (def.tree!.nodes.cta as GraphNode & { kind: 'link' }).stateAction = { state: 'open', op: 'toggle' };
    const r = detach(s);
    const cta = descendants(r.state, r.results[0].nodeId as string).find((n) => n.kind === 'link')!;
    expect(cta).toMatchObject({ label: 'Talk to us' });
    expect(Object.hasOwn(cta, 'stateAction')).toBe(false);
  });

  it('chooses an option bound to a deeper design’s UI state at the value it starts at', () => {
    const { s } = project();
    const base = showcase();
    s.components['proj.c-cc1cc'] = { ...base, id: 'proj.c-cc1cc', name: 'C', properties: { label: { type: 'string', label: 'Label', default: 'C' } }, parts: { root: { nodeId: 'c', label: 'C' } }, slots: undefined, variantAxes: { size: { label: 'Size', default: 'small', options: { small: { label: 'Small', styles: { c: { base: { fontSize: '12px' } } } }, large: { label: 'Large' } } } }, tree: { rootIds: ['c'], nodes: { c: { id: 'c', kind: 'text', tag: 'span', text: { $prop: 'label' } } as GraphNode } } } as ComponentDefinition;
    // B places C at its root, sized by B's own UI state, which starts large.
    s.components['proj.b-bb1bb'] = { ...base, id: 'proj.b-bb1bb', name: 'B', properties: {}, state: { sz: { type: 'enum', label: 'Size', options: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }], initial: 'large' } }, parts: { root: { nodeId: 'b', label: 'B' } }, slots: undefined, variantAxes: undefined, tree: { rootIds: ['b'], nodes: { b: { id: 'b', kind: 'instance', definitionId: 'proj.c-cc1cc', props: {}, variants: { size: { $state: 'sz' } } } as unknown as GraphNode } } } as ComponentDefinition;
    const def = s.components[DEF];
    (def.tree!.nodes.root as GraphNode & { kind: 'element' }).children = ['pill', 'extra'];
    def.tree!.nodes.pill = { id: 'pill', kind: 'instance', definitionId: 'proj.b-bb1bb', props: {}, styles: { base: { fontSize: '14px' } } } as unknown as GraphNode;
    const r = detach(s);
    const pill = descendants(r.state, r.results[0].nodeId as string).find((n): n is InstanceNode => n.kind === 'instance')!;
    // Large sets no size, so the design's own 14px was what showed.
    expect(pill.overrides?.root).toEqual({ base: { fontSize: '14px' } });
  });

  it('gives the placement’s entrance to what replaces it, and turns the design’s own off where it chose none', () => {
    const { s } = project();
    const rootOf = (r: ReturnType<typeof detach>) => home(r.state).nodes[r.results[0].nodeId as string];
    const target = home(s).nodes.n_target as InstanceNode;
    target.appear = 'lift';
    expect(rootOf(detach(s))).toMatchObject({ kind: 'element', appear: 'lift' });
    // The design's own entrance shows where the placement chose none of its own, and `none` turns it off.
    (s.components[DEF].tree!.nodes.root as GraphNode & { kind: 'element' }).appear = 'fade';
    delete target.appear;
    expect(rootOf(detach(s))).toMatchObject({ appear: 'fade' });
    target.appear = 'none';
    expect(Object.hasOwn(rootOf(detach(s)), 'appear')).toBe(false);
    // A design whose root places another design: that placement takes the choice, `none` included.
    const inner = { ...showcase(), id: 'proj.inner-ee1ee', name: 'Inner', properties: {}, parts: { root: { nodeId: 'in', label: 'Root' } }, slots: undefined, variantAxes: undefined, tree: { rootIds: ['in'], nodes: { in: { id: 'in', kind: 'element', tag: 'div', children: [], appear: 'fade' } } } } as unknown as ComponentDefinition;
    s.components[inner.id] = inner;
    s.components[DEF].tree = { rootIds: ['wrap'], nodes: { wrap: { id: 'wrap', kind: 'instance', definitionId: inner.id, props: {} } as unknown as GraphNode } };
    s.components[DEF].parts = { root: { nodeId: 'wrap', label: 'Root' } };
    s.components[DEF].slots = undefined;
    s.components[DEF].variantAxes = undefined;
    target.slots = undefined;
    target.overrides = undefined;
    target.itemOverrides = undefined;
    target.variants = undefined;
    expect(rootOf(detach(s))).toMatchObject({ kind: 'instance', definitionId: inner.id, appear: 'none' });
  });

  it('is offered to the AI for the placement it may change', async () => {
    const { checkAuthority } = await import('../../src/agent/scope');
    const { s } = project();
    const op = { type: 'component.detachInstance', owner: owner(s), nodeId: 'n_target' } as EditOperation;
    expect(checkAuthority(s, [op], { kind: 'selection', owner: owner(s), nodeId: 'n_target', label: 'the showcase' })).toBeNull();
    expect(checkAuthority(s, [op], { kind: 'selection', owner: owner(s), nodeId: 'n_other', label: 'the other showcase' })).not.toBeNull();
  });
});

describe('flattenStyles', () => {
  it('drops a longhand its stronger shorthand overrides, and keeps one that beats it', () => {
    const weakGap: StyleLayer[] = [
      { styles: { base: { columnGap: '4px' } }, strength: 1 },
      { styles: { base: { gap: '20px' } }, strength: 3, wideColumns: true }
    ];
    expect(flattenStyles(weakGap)).toEqual({ base: { gap: '20px' } });
    const strongGap: StyleLayer[] = [
      { styles: { base: { gap: '20px' } }, strength: 1 },
      { styles: { base: { columnGap: '4px' } }, strength: 3, wideColumns: true }
    ];
    expect(flattenStyles(strongGap)).toEqual({ base: { gap: '20px', columnGap: '4px' } });
  });

  it("keeps every layer's custom CSS in cascade order, less what a stronger property sets", () => {
    const layers: StyleLayer[] = [
      { styles: { base: { customCss: 'outline-width: 2px; color: red' } }, strength: 1 },
      { styles: { base: { color: '#0000ff', customCss: 'outline-style: dashed' } }, strength: 3, wideColumns: true }
    ];
    expect(flattenStyles(layers)).toEqual({ base: { color: '#0000ff', customCss: 'outline-width: 2px; outline-style: dashed' } });
  });

  it('packs properties that set the same CSS property together, so one rule keeps their order', () => {
    // A placement's hide beats the design's phone layout; written apart, the phone layout's display would show it.
    const hide: StyleLayer[] = [
      { styles: { phone: { layout: 'grid' } }, strength: 1 },
      { styles: { base: { hidden: true } }, strength: 3, wideColumns: true }
    ];
    const hidden = flattenStyles(hide);
    expect(hidden.base?.hidden).toBeUndefined();
    for (const sz of SIZES) expect(perSize(hidden)[sz].hidden, sz).toBe(true);
    // A placement's row gap beats the design's tablet gap; written apart, the tablet gap would set the rows again.
    const gaps: StyleLayer[] = [
      { styles: { base: { gap: '8px' }, tablet: { gap: '20px' } }, strength: 1 },
      { styles: { base: { rowGap: '4px' } }, strength: 3, wideColumns: true }
    ];
    expect(flattenStyles(gaps)).toEqual({ phone: { gap: '8px', rowGap: '4px' }, tablet: { gap: '20px', rowGap: '4px' }, desktop: { gap: '8px', rowGap: '4px' } });
  });

  it('writes what stays beneath again only where nothing of its own beats it', () => {
    // The component's own option hides its root; the design's weaker layout and the placement's custom display show it.
    const layers: StyleLayer[] = [
      { styles: { base: { hidden: true } }, strength: 2 },
      { styles: { base: { layout: 'row' } }, strength: 1 },
      { styles: { base: { customCss: 'display: block' } }, strength: 4, wideColumns: true }
    ];
    expect(flattenStyles(layers, { beneath: 1, wideColumns: true })).toEqual({ base: { layout: 'row', customCss: 'display: block' } });
  });

  it('decides display once, by the declaration that sets it last across every layer', () => {
    // A stronger hide beneath beats the result's own custom display: nothing of its own shows it.
    expect(flattenStyles([{ styles: { base: { hidden: true } }, strength: 2 }, { styles: { base: { customCss: 'display: grid' } }, strength: 1 }], { beneath: 1, wideColumns: true })).toEqual({});
    // The placement's custom display after the show's restoring display, in the same rule: it stays hidden on phones.
    const hiddenAgain = flattenStyles([{ styles: { base: { hidden: true } }, strength: 1 }, { styles: { phone: { hidden: false, customCss: 'display: none' } }, strength: 3, wideColumns: true, unhides: [{ base: { hidden: true } }] }], { shownDisplay: () => 'revert' });
    for (const sz of SIZES) expect(perSize(hiddenAgain)[sz].hidden, sz).toBe(true);
    // A stronger custom display beats a weaker hide: shown, with that display.
    const block = flattenStyles([{ styles: { base: { hidden: true } }, strength: 1 }, { styles: { base: { customCss: 'display: block' } }, strength: 3, wideColumns: true }]);
    expect(block).toEqual({ base: { customCss: 'display: block' } });
    // A template the stylesheet does not write makes no tablet-and-up rule: the later layout still shows it.
    const invalid = flattenStyles([{ styles: { base: { gridTemplate: 'garbage', customCss: 'display: none' } }, strength: 2, wideColumns: true }, { styles: { base: { layout: 'block' } }, strength: 2, wideColumns: true }]);
    for (const sz of SIZES) expect(perSize(invalid)[sz].hidden, sz).toBeUndefined();
    // A display value the browser does not take leaves the one before it in force.
    const bogus = flattenStyles([{ styles: { base: { customCss: 'display: none; display: bogus' } }, strength: 1 }]);
    for (const sz of SIZES) expect(perSize(bogus)[sz].hidden, sz).toBe(true);
    // Two keywords are one display value.
    expect(flattenStyles([{ styles: { base: { customCss: 'display: none; display: inline flex' } }, strength: 1 }])).toEqual({ base: { customCss: 'display: inline flex' } });
  });

  it('refuses custom CSS that one element cannot hold, rather than dropping some of it', () => {
    const many = (prefix: string) => Array.from({ length: 13 }, (_, i) => `${prefix}: ${i + 1}px`).join('; ');
    const layers: StyleLayer[] = [
      { styles: { base: { customCss: many('outline-width') } }, strength: 1 },
      { styles: { base: { customCss: many('outline-offset') } }, strength: 3, wideColumns: true }
    ];
    expect(() => flattenStyles(layers, { tooMuch: () => { throw new Error('too much'); } })).toThrow('too much');
  });

  it('leaves a link’s custom background colour to it, as its background goes through the button variable', () => {
    const layers: StyleLayer[] = [
      { styles: { base: { customCss: 'background-color: red' } }, strength: 1 },
      { styles: { base: { background: '#0000ff' } }, strength: 3, wideColumns: true }
    ];
    expect(flattenStyles(layers, { link: true })).toEqual({ base: { background: '#0000ff', customCss: 'background-color: red' } });
  });

  it('writes the display a show wrote, even over a hide of an option not chosen', () => {
    const own = { base: { customCss: 'display: grid' } };
    const layers: StyleLayer[] = [
      { styles: own, strength: 1 },
      { styles: { base: { hidden: false } }, strength: 2, wideColumns: true, unhides: [own, { base: { hidden: true } }] }
    ];
    const flat = flattenStyles(layers, { shownDisplay: () => 'revert' });
    expect(flat.base?.customCss).toMatch(/display: revert$/);
  });

  it('writes the most common value for all sizes and the others as exceptions', () => {
    expect(flattenStyles([{ styles: { phone: { opacity: 0.4 }, tablet: { opacity: 0.4 }, desktop: { opacity: 1 } }, strength: 1 }])).toEqual({ base: { opacity: 0.4 }, desktop: { opacity: 1 } });
    expect(flattenStyles([{ styles: { phone: { opacity: 0.5 }, tablet: { opacity: 1 }, desktop: { opacity: 1 } }, strength: 1 }])).toEqual({ base: { opacity: 1 }, phone: { opacity: 0.5 } });
    expect(flattenStyles([{ styles: { phone: { opacity: 0.2 }, tablet: { opacity: 0.5 }, desktop: { opacity: 0.8 } }, strength: 1 }])).toEqual({ base: { opacity: 0.8 }, phone: { opacity: 0.2 }, tablet: { opacity: 0.5 } });
  });

  it('drops custom CSS a stronger shorthand sets, and keeps a custom shorthand a stronger property narrows', () => {
    const background: StyleLayer[] = [
      { styles: { base: { customCss: 'background-color: red' } }, strength: 1 },
      { styles: { base: { background: '#0000ff' } }, strength: 3, wideColumns: true }
    ];
    expect(flattenStyles(background)).toEqual({ base: { background: '#0000ff' } });
    const padding: StyleLayer[] = [
      { styles: { base: { customCss: 'padding: 20px' } }, strength: 1 },
      { styles: { base: { paddingInlineStart: '4px' } }, strength: 3, wideColumns: true }
    ];
    expect(flattenStyles(padding)).toEqual({ base: { paddingInlineStart: '4px', customCss: 'padding: 20px; padding-inline-start: 4px' } });
    // Several stronger properties are written again in rule order: the shorthand before its longhand.
    const both: StyleLayer[] = [
      { styles: { base: { customCss: 'padding: 20px' } }, strength: 1 },
      { styles: { base: { paddingInlineStart: '4px', paddingInline: '12px' } }, strength: 3, wideColumns: true }
    ];
    expect(flattenStyles(both).base?.customCss).toBe('padding: 20px; padding-inline: 12px; padding-inline-start: 4px');
    // A shorthand that leaves a property alone does not take it away; one not named after its longhands still covers them.
    const blend: StyleLayer[] = [
      { styles: { base: { customCss: 'background-blend-mode: multiply; place-items: center' } }, strength: 1 },
      { styles: { base: { background: '#0000ff', align: 'start' } }, strength: 3, wideColumns: true }
    ];
    expect(flattenStyles(blend).base?.customCss).toMatch(/^background-blend-mode: multiply; place-items: center; align-items: /);
  });

  it('lets a layer’s custom CSS win its own tablet-and-up values, as its rule writes it again there', () => {
    const flat = flattenStyles([{ styles: { base: { layout: 'grid', columns: 3, customCss: 'grid-template-columns: 2fr 1fr' } }, strength: 2, wideColumns: true }]);
    for (const sz of ['tablet', 'desktop'] as const) expect(perSize(flat)[sz].customCss, sz).toBe('grid-template-columns: 2fr 1fr');
  });

  it('writes no display for a show that undid no hide', () => {
    expect(flattenStyles([{ styles: { base: { padding: '4px' } }, strength: 1 }, { styles: { base: { hidden: false } }, strength: 3, wideColumns: true, unhides: [{ base: { padding: '4px' } }] }], { shownDisplay: () => 'revert' })).toEqual({ base: { padding: '4px' } });
  });

  it('keeps a grid template off phones, as a single rule would not', () => {
    const layers: StyleLayer[] = [{ styles: { base: { layout: 'grid', columns: 1 } }, strength: 1 }, { styles: { base: { gridTemplate: '2fr 1fr' } }, strength: 2, wideColumns: true }];
    const flat = flattenStyles(layers);
    expect(flat.base?.gridTemplate).toBeUndefined();
    expect(cascadeStyles([{ styles: flat, strength: 1 }])).toMatchObject({ phone: { columns: 1 }, tablet: { gridTemplate: '2fr 1fr' }, desktop: { gridTemplate: '2fr 1fr' } });
  });
});

const sessions: string[] = [];
afterEach(() => sessions.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
