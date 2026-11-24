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
        n('root', { kind: 'element', tag: 'section', name: 'Showcase root', children: ['heading', 'lead', 'badge', 'grid', 'extra', 'actions'], styles: { base: { paddingBlock: '32px' } } }),
        n('heading', { kind: 'text', tag: { $prop: 'level' }, text: { $prop: 'heading' }, styles: { base: { color: '#222222' }, phone: { color: '#333333' } } }),
        n('lead', { kind: 'text', tag: 'p', text: { $prop: 'lead' }, when: { $prop: 'lead' } }),
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

  it('names what replaces an unnamed placement after its component', () => {
    const { s } = project();
    const r = detach(s, 'n_other');
    expect(home(r.state).nodes[r.results[0].nodeId as string]).toMatchObject({ name: 'Showcase', tag: 'section' });
    expect(home(r.state).nodes[r.results[0].nodeId as string].anchor).toBeUndefined();
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
      return [...html.matchAll(/data-viewer-group="([^"]*)"/g)].map((m) => (seen.includes(m[1]) ? seen : seen.push(m[1]) && seen).indexOf(m[1]));
    };
    const was = grouping(await renderHome(state));
    expect(was).toEqual([0, 0, 0, 1, 1, 1]);
    const detached = applyOperations(state, [{ type: 'component.detachInstance', owner: owner(state), nodeId: first }]).state;
    expect(grouping(await renderHome(detached))).toEqual(was);
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

  it('keeps a grid template off phones, as a single rule would not', () => {
    const layers: StyleLayer[] = [{ styles: { base: { layout: 'grid', columns: 1 } }, strength: 1 }, { styles: { base: { gridTemplate: '2fr 1fr' } }, strength: 2, wideColumns: true }];
    const flat = flattenStyles(layers);
    expect(flat.base?.gridTemplate).toBeUndefined();
    expect(cascadeStyles([{ styles: flat, strength: 1 }])).toMatchObject({ phone: { columns: 1 }, tablet: { gridTemplate: '2fr 1fr' }, desktop: { gridTemplate: '2fr 1fr' } });
  });
});

const sessions: string[] = [];
afterEach(() => sessions.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
