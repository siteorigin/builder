/**
 * Layout guardrails (#668): a sticky element inside a container that hides overflow, a grid child spanning more
 * columns than its grid has, and an absolutely positioned element with nothing positioned around it, each reported
 * as a plain warning at the screen sizes where it happens. They never block a save, go as soon as the layout is
 * fixed, and stay quiet on the layouts that work: sticky headers and sidebars, Bento grids, anchored overlays, and
 * every starter in every theme.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, ElementNode, GraphNode, InstanceNode, ProjectState, ResponsiveStyles, StyleProps, TextNode } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { STARTERS, createStarterState } from '@catalogue/starters';
import { listThemes } from '@catalogue/index';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { blocksSaving, introducedDiagnostics, validateState, type Diagnostic } from '@engine/validate';

const fresh = () => createStarterState('blank', 'Blank', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

const el = (id: string, name: string, styles?: ResponsiveStyles, children: string[] = [], extra: Partial<ElementNode> = {}): ElementNode =>
  ({ id, kind: 'element', tag: 'div', name, children, ...(styles ? { styles } : {}), ...extra }) as ElementNode;
const text = (id: string, name: string, styles?: ResponsiveStyles): TextNode => ({ id, kind: 'text', tag: 'p', text: 'Hello', name, ...(styles ? { styles } : {}) }) as TextNode;

/** Home holding these nodes, with the first one placed at the top of the page. */
function page(nodes: GraphNode[], s = fresh()): ProjectState {
  const p = home(s);
  for (const n of nodes) p.nodes[n.id] = n;
  p.rootIds.push(nodes[0].id);
  return s;
}

const guardrails = (s: ProjectState, code?: string): Diagnostic[] => validateState(s).filter((d) => d.code.startsWith('LAYOUT_') && (code === undefined || d.code === code));
const STICKY = 'LAYOUT_STICKY_CLIPPED';
const SPAN = 'LAYOUT_SPAN_OVERFLOW';
const ABSOLUTE = 'LAYOUT_ABSOLUTE_UNANCHORED';

const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const setStyle = (s: ProjectState, nodeId: string, scope: string, property: string, value: unknown, extra: Record<string, unknown> = {}) =>
  apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId, scope, property, value, ...extra } as EditOperation]);

/** A project design of hand-built nodes, its root and `n_inner` declared as parts, with a `content` slot unless told otherwise. */
function addDesign(s: ProjectState, id: string, nodes: GraphNode[], extra: Partial<ComponentDefinition> = {}): ComponentDefinition {
  const def = {
    schemaVersion: SCHEMA_VERSION,
    id,
    componentId: id,
    contractVersion: 1,
    kind: 'managed',
    owner: 'project',
    name: 'Card',
    description: '',
    category: 'content',
    tags: [],
    properties: {},
    parts: nodes.length ? { root: { nodeId: nodes[0].id, label: 'Card' }, inner: { nodeId: 'n_inner', label: 'Inside' } } : {},
    slots: { content: { label: 'Content' } },
    ...(nodes.length ? { tree: { rootIds: [nodes[0].id], nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) } } : {}),
    ...extra
  } as ComponentDefinition;
  s.components[id] = def;
  return def;
}
const placement = (id: string, definitionId: string, extra: Partial<InstanceNode> = {}): InstanceNode => ({ id, kind: 'instance', definitionId, props: {}, ...extra }) as InstanceNode;
const slotNode = (id: string, slot = 'content'): GraphNode => ({ id, kind: 'slot', slot }) as GraphNode;

describe('a sticky element inside a container that hides overflow', () => {
  /** Card › wrapper › a sticky sidebar, with the card hiding overflow on tablets. */
  const clipped = (card: ResponsiveStyles = { base: { layout: 'stack' }, tablet: { overflow: 'hidden' } }) =>
    page([el('n_card', 'Card', card, ['n_wrap']), el('n_wrap', 'Column', undefined, ['n_side']), el('n_side', 'Sidebar', { base: { position: 'sticky', inset: '0 auto auto auto' } })]);

  it('is a warning on the sticky element, at the sizes the container hides overflow, with a one-step fix to Clip', () => {
    const s = clipped();
    const [d, ...rest] = guardrails(s);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ severity: 'warning', code: STICKY, owner: owner(s), nodeId: 'n_side' });
    expect(d.message).toBe(
      `${home(s).title}: on tablets, “Sidebar” is set to stick while the page scrolls, but “Card” around it hides overflow, so it scrolls away with everything else. Set the Overflow of “Card” to Clip: it still trims what spills over its edges, and lets “Sidebar” stick.`
    );
    expect(d.fix).toEqual({ label: 'Set Overflow to Clip', operations: [{ type: 'node.setStyle', owner: owner(s), nodeId: 'n_card', scope: 'tablet', property: 'overflow', value: 'clip' }] });
    expect(blocksSaving(d)).toBe(false);

    // The fix goes through the ordinary edit, which keeps the card's other styles, and the warning goes with it.
    const fixed = apply(s, d.fix!.operations);
    expect(home(fixed).nodes.n_card.styles).toEqual({ base: { layout: 'stack' }, tablet: { overflow: 'clip' } });
    expect(guardrails(fixed)).toEqual([]);
  });

  it('names every size the container hides overflow at, and skips the sizes the sticky element is hidden at', () => {
    expect(guardrails(clipped({ base: { layout: 'grid', overflow: 'hidden' } }))[0].message).toMatch(/: “Sidebar” is set to stick/);
    let s = clipped({ base: { layout: 'grid', overflow: 'hidden' } });
    s = setStyle(s, 'n_side', 'phone', 'hidden', true);
    expect(guardrails(s)[0].message).toMatch(/: on tablets and desktops, “Sidebar” is set to stick/);
    // Inside a container hidden on every size, it never shows to go wrong.
    s = setStyle(s, 'n_wrap', 'base', 'hidden', true);
    expect(guardrails(s)).toEqual([]);
  });

  it('fixes the scope the hidden overflow comes from, and only where the container is a stack or grid there', () => {
    const fixOf = (card: ResponsiveStyles) => {
      const s = clipped(card);
      const fix = guardrails(s)[0]?.fix;
      return fix && fix.operations.map((o) => ({ ...o, owner: (o as { owner: unknown }).owner === undefined ? undefined : 'home' }));
    };
    const clip = (scope: string) => ({ type: 'node.setStyle', owner: 'home', nodeId: 'n_card', scope, property: 'overflow', value: 'clip' });
    // Set for all sizes: changed for all sizes.
    expect(fixOf({ base: { layout: 'grid', overflow: 'hidden' } })).toEqual([clip('base')]);
    // One size of its own, and all sizes for the rest: both are changed.
    expect(fixOf({ base: { layout: 'row', overflow: 'hidden' }, tablet: { overflow: 'hidden' } })).toEqual([clip('base'), clip('tablet')]);
    // A container laid out as flow would also stop holding its children's margins in: advice only.
    expect(fixOf({ base: { overflow: 'hidden' } })).toBeUndefined();
    expect(fixOf({ base: { layout: 'stack', overflow: 'hidden' }, phone: { layout: 'block' } })).toBeUndefined();
    // Flow only where the scope being changed does not reach: still safe.
    expect(fixOf({ base: { layout: 'stack' }, phone: { layout: 'block' }, tablet: { overflow: 'hidden' } })).toEqual([clip('tablet')]);
  });

  it('offers no one-step fix where Clip could change more than the sticking', () => {
    const sidebar = el('n_side', 'Sidebar', { base: { position: 'sticky', inset: '0' } });
    // In a row, a box that no longer scrolls takes its content's width as its least, and may widen.
    let s = page([el('n_row', 'Row', { base: { layout: 'row' } }, ['n_card']), el('n_card', 'Card', { base: { layout: 'stack', overflow: 'hidden' } }, ['n_side']), sidebar]);
    expect(guardrails(s).map((d) => [d.code, d.fix])).toEqual([[STICKY, undefined]]);
    // In flow, or a stack free to grow, it can only stay as wide as it was.
    s = setStyle(s, 'n_row', 'base', 'layout', 'stack');
    expect(guardrails(s)[0].fix?.operations).toHaveLength(1);
    s = setStyle(s, 'n_row', 'base', 'maxHeight', '30rem');
    expect(guardrails(s)[0].fix).toBeUndefined();
    // Another box further out hides overflow too: one step would only hand the job to it.
    s = page([el('n_outer', 'Outer', { base: { layout: 'stack', overflow: 'hidden' } }, ['n_card']), el('n_card', 'Card', { base: { layout: 'stack', overflow: 'hidden' } }, ['n_side']), sidebar]);
    expect(guardrails(s).map((d) => [d.message.includes('“Card” around it'), d.fix])).toEqual([[true, undefined]]);
    // A project component's design is every placement's, though the same box on a page would take the fix.
    const t = fresh();
    addDesign(t, 'c_panel', [el('n_root', 'Panel', undefined, ['n_card']), el('n_card', 'Card', { base: { layout: 'stack', overflow: 'hidden' } }, ['n_side']), sidebar], { parts: {}, slots: {} });
    expect(guardrails(t).map((d) => [d.code, d.owner, d.fix])).toEqual([[STICKY, { kind: 'component', id: 'c_panel' }, undefined]]);
    const onPage = page([el('n_root', 'Panel', undefined, ['n_card']), el('n_card', 'Card', { base: { layout: 'stack', overflow: 'hidden' } }, ['n_side']), sidebar]);
    expect(guardrails(onPage)[0].fix?.operations).toHaveLength(1);
  });

  it('stays quiet for sticky headers and sidebars that work', () => {
    // Clip, visible, or nothing set on every container around it.
    expect(guardrails(clipped({ base: { layout: 'stack', overflow: 'clip' } }))).toEqual([]);
    expect(guardrails(clipped({ base: { layout: 'stack', overflow: 'visible' } }))).toEqual([]);
    expect(guardrails(clipped({ base: { layout: 'stack' } }))).toEqual([]);
    // Its own overflow is its own business.
    let s = clipped({ base: { layout: 'stack' } });
    s = setStyle(s, 'n_side', 'base', 'overflow', 'hidden');
    expect(guardrails(s)).toEqual([]);
    // A sticky header straight on the page.
    expect(guardrails(page([el('n_head', 'Header', { base: { position: 'sticky', inset: '0 auto auto auto' } })]))).toEqual([]);
    // With no offset from the top or bottom it never sticks, so the card takes nothing from it.
    for (const inset of [undefined, 'auto', '0 auto auto auto'.replace('0', 'auto'), 'auto 0']) {
      s = clipped({ base: { layout: 'stack', overflow: 'hidden' } });
      s = setStyle(s, 'n_side', 'base', 'inset', inset ?? null);
      expect(guardrails(s), String(inset)).toEqual([]);
    }
    // A bottom offset sticks as surely as a top one: `top inline bottom`.
    s = setStyle(clipped({ base: { layout: 'stack', overflow: 'hidden' } }), 'n_side', 'base', 'inset', 'auto 0 1rem');
    expect(guardrails(s, STICKY)).toHaveLength(1);
    // A box displayed some other way may be no box at all (contents): it is not read.
    s = clipped({ base: { layout: 'stack', overflow: 'hidden', customCss: 'display: contents' } });
    expect(guardrails(s)).toEqual([]);
    // Overflow applies to no inline box: a hidden span around it is passed over.
    s = page([el('n_card', 'Card', { base: { layout: 'stack' } }, ['n_wrap']), el('n_wrap', 'Words', { base: { overflow: 'hidden' } }, ['n_side'], { tag: 'span' }), el('n_side', 'Sidebar', { base: { position: 'sticky', inset: '0' } })]);
    expect(guardrails(s)).toEqual([]);
    // A panel that scrolls on purpose, nearer than the hidden card: it sticks inside that panel.
    s = clipped({ base: { layout: 'stack', overflow: 'hidden' } });
    s = setStyle(s, 'n_wrap', 'base', 'customCss', 'overflow-y: auto; max-height: 20rem');
    expect(guardrails(s)).toEqual([]);
    // Words that wrap anywhere decide nothing about scrolling: the hidden card is still found.
    s = clipped({ base: { layout: 'stack', overflow: 'hidden' } });
    s = setStyle(s, 'n_wrap', 'base', 'customCss', 'overflow-wrap: anywhere');
    expect(guardrails(s, STICKY)).toHaveLength(1);
  });

  it('is found through a placed component, with advice only for the component’s own styles', () => {
    const s = fresh();
    addDesign(s, 'c_card', [el('n_root', 'Frame', { base: { layout: 'stack', overflow: 'hidden' } }, ['n_inner']), el('n_inner', 'Inner', undefined, ['n_slot']), slotNode('n_slot')]);
    page([placement('n_place', 'c_card', { slots: { content: ['n_side'] } }), el('n_side', 'Sidebar', { base: { position: 'sticky', inset: '1rem auto auto auto' } })], s);
    const [d, ...rest] = guardrails(s);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ code: STICKY, nodeId: 'n_side' });
    expect(d.message).toMatch(/: “Sidebar” is set to stick while the page scrolls, but “Card” around it hides overflow/);
    // The design's own styles are every placement's: no one-step change here.
    expect(d.fix).toBeUndefined();
    // The placement's own change to its root wins over the design's.
    home(s).nodes.n_place = placement('n_place', 'c_card', { slots: { content: ['n_side'] }, overrides: { root: { base: { overflow: 'clip' } } } });
    expect(guardrails(s)).toEqual([]);
  });
});

describe('a grid child spanning more columns than its grid has', () => {
  /** A three-column Bento grid that drops to two columns on tablets, with a wide feature card and a two-column one. */
  const bento = (feature: ResponsiveStyles = { base: { columnSpan: '3' } }, grid: ResponsiveStyles = { base: { layout: 'grid', columns: 3 }, tablet: { columns: 2 } }) =>
    page([el('n_grid', 'Bento', grid, ['n_feature', 'n_wide', 'n_small']), el('n_feature', 'Feature', feature), el('n_wide', 'Wide', { base: { columnSpan: '2' } }), el('n_small', 'Small')]);

  it('is a warning at the size the grid has fewer columns', () => {
    const s = bento();
    const [d, ...rest] = guardrails(s);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ severity: 'warning', code: SPAN, owner: owner(s), nodeId: 'n_feature' });
    expect(d.message).toBe(
      `${home(s).title}: on tablets, “Feature” spans 3 columns, but its grid has only 2 columns, so the grid adds a column of its own to fit it, squeezing the others. Lower its Column span to 2, or give the grid more columns.`
    );
    expect(d.fix).toBeUndefined();
  });

  it('leaves phones out of a span set for all sizes, whatever the phone grid', () => {
    const s = bento(undefined, { base: { layout: 'grid', columns: 3 }, phone: { columns: 2 }, tablet: { columns: 2 } });
    expect(guardrails(s).map((d) => d.message.match(/: (on [a-z ]+),/)?.[1])).toEqual(['on tablets']);
  });

  it('reads a span set for phones, which a span for all sizes leaves alone', () => {
    // For all sizes a span applies from tablet up; a phone value applies on phones, here against three columns.
    const s = bento({ base: { columnSpan: '3' }, phone: { columnSpan: '5' } });
    expect(guardrails(s).map((d) => d.message.replace(/^[^:]+: /, ''))).toEqual([
      'on phones, “Feature” spans 5 columns, but its grid has only 3 columns, so the grid adds 2 columns of its own to fit it, squeezing the others. Lower its Column span to 3, or give the grid more columns.',
      'on tablets, “Feature” spans 3 columns, but its grid has only 2 columns, so the grid adds a column of its own to fit it, squeezing the others. Lower its Column span to 2, or give the grid more columns.'
    ]);
  });

  it('goes once the span fits or the grid widens', () => {
    expect(guardrails(setStyle(bento(), 'n_feature', 'tablet', 'columnSpan', '2'))).toEqual([]);
    expect(guardrails(setStyle(bento(), 'n_grid', 'tablet', 'columns', 3))).toEqual([]);
    expect(guardrails(setStyle(bento(), 'n_feature', 'base', 'columnSpan', 'full'))).toEqual([]);
  });

  it('counts the columns column sizes make', () => {
    const at = (gridTemplate: string, columnSpan: string) =>
      guardrails(bento({ base: { columnSpan } }, { base: { layout: 'grid', gridTemplate } }), SPAN).map((d) => d.message.match(/: (on [a-z ]+, )?“Feature” spans \d+ columns, but its grid has only (\d+)/)?.slice(1));
    // Column sizes for all sizes apply from tablet up, like the span; phones keep their own (here, none).
    expect(at('16rem 1fr 14rem', '4')).toEqual([['on tablets and desktops, ', '3']]);
    expect(at('16rem 1fr 14rem', '3')).toEqual([]);
    expect(at('repeat(2, 12rem 1fr)', '4')).toEqual([]);
    expect(at('repeat(2, 12rem 1fr)', '5')).toEqual([['on tablets and desktops, ', '4']]);
    // As many as fit: how many there are is up to the screen.
    expect(at('auto-fit-md', '6')).toEqual([]);
    expect(at('repeat(auto-fill, minmax(10rem, 1fr))', '6')).toEqual([]);
  });

  it('stays quiet for valid Bento spans, a grid with no columns set, and children out of its flow', () => {
    expect(guardrails(bento({ base: { columnSpan: '2' } }))).toEqual([]);
    expect(guardrails(bento({ base: { columnSpan: 3 } }, { base: { layout: 'grid', columns: 3 } }))).toEqual([]);
    // Not a grid at that size: a span means nothing in a stack.
    expect(guardrails(bento(undefined, { base: { layout: 'grid', columns: 3 }, tablet: { layout: 'stack', columns: 2 } }))).toEqual([]);
    // A numeric span is read like the Inspector's text one.
    expect(guardrails(bento({ base: { columnSpan: 3 } })).map((d) => d.code)).toEqual([SPAN]);
    // A disclosure lays out what it holds in a box of its own, not in its grid's columns.
    expect(guardrails(page([el('n_more', 'More', { base: { layout: 'grid', columns: 2 } }, ['n_body'], { tag: 'details' }), el('n_body', 'Body', { base: { columnSpan: '3' } })]))).toEqual([]);
    // A grid with no column count lays everything out in columns of its own making.
    expect(guardrails(bento(undefined, { base: { layout: 'grid' } }))).toEqual([]);
    // Placed absolutely, it makes no columns (whatever else is said about it).
    expect(guardrails(bento({ base: { columnSpan: '3', position: 'absolute' } }), SPAN)).toEqual([]);
    // Custom CSS on either may place it some other way.
    expect(guardrails(bento({ base: { columnSpan: '3', customCss: 'grid-column: 1 / -1' } }))).toEqual([]);
    expect(guardrails(bento(undefined, { base: { layout: 'grid', columns: 3, customCss: 'grid-template-columns: repeat(4, 1fr)' }, tablet: { columns: 2 } }))).toEqual([]);
  });

  it('reads a text element as a grid child, but not rich text, which the runtime renders', () => {
    const s = page([el('n_grid', 'Grid', { base: { layout: 'grid', columns: 2 } }, ['n_title']), text('n_title', 'Title', { base: { columnSpan: '4' } })]);
    expect(guardrails(s).map((d) => [d.code, d.nodeId])).toEqual([[SPAN, 'n_title']]);
    home(s).nodes.n_title = { ...home(s).nodes.n_title, rich: true, text: [] } as GraphNode;
    expect(guardrails(s)).toEqual([]);
  });

  it('reads the grid a placed component wraps its slot in, and a placement as a grid child', () => {
    const s = fresh();
    const sectionId = installComponent(s, 'layout.section');
    const section = makeInstance(s.components[sectionId], {});
    section.overrides = { container: { base: { layout: 'grid', columns: 2 } } };
    section.slots = { content: ['n_feature'] };
    page([section, el('n_feature', 'Feature', { base: { columnSpan: '3' } })], s);
    // A placement's column count for all sizes applies from tablet up: on phones its grid has no count to exceed.
    const [d, ...rest] = guardrails(s);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ code: SPAN, nodeId: 'n_feature' });
    expect(d.message).toMatch(/: on tablets and desktops, “Feature” spans 3 columns, but its grid has only 2 columns/);

    // A section placed in an authored grid, spanning through its own change to its root.
    const t = fresh();
    const inner = makeInstance(t.components[installComponent(t, 'layout.section')], {});
    inner.overrides = { root: { base: { columnSpan: '3' } } };
    page([el('n_grid', 'Grid', { base: { layout: 'grid', columns: 2 } }, [inner.id]), inner], t);
    expect(guardrails(t).map((x) => [x.code, x.nodeId])).toEqual([[SPAN, inner.id]]);
  });

  it('reads only the parts a design declares, and nothing a condition may leave out', () => {
    // A change to a part the design does not declare reaches no element.
    const s = fresh();
    addDesign(s, 'c_tile', [el('n_root', 'Tile')], { parts: {}, slots: {} });
    page([el('n_grid', 'Grid', { base: { layout: 'grid', columns: 2 } }, ['n_place']), placement('n_place', 'c_tile', { overrides: { root: { base: { columnSpan: '3' } } } })], s);
    expect(guardrails(s)).toEqual([]);
    s.components.c_tile.parts = { root: { nodeId: 'n_root', label: 'Tile' } };
    expect(guardrails(s).map((d) => [d.code, d.nodeId])).toEqual([[SPAN, 'n_place']]);
    // A change that shows it again gets a display the generator picks from the options in its own order: not read.
    home(s).nodes.n_place = placement('n_place', 'c_tile', { overrides: { root: { base: { columnSpan: '3', hidden: false } } } });
    expect(guardrails(s)).toEqual([]);
    // A slot inside a container its design shows only under a condition: what is placed there may never show.
    const t = fresh();
    addDesign(t, 'c_card', [el('n_root', 'Frame', undefined, ['n_inner']), el('n_inner', 'Inner', undefined, ['n_slot'], { when: { $prop: 'open' } } as Partial<ElementNode>), slotNode('n_slot')]);
    page([placement('n_place', 'c_card', { slots: { content: ['n_badge'] } }), el('n_badge', 'Badge', { base: { position: 'absolute' } })], t);
    expect(guardrails(t)).toEqual([]);
    // Inside a code component's slot, a section's grid may be styled by the component's own stylesheet.
    const u = fresh();
    addDesign(u, 'c_code', [], { kind: 'code' });
    const section = makeInstance(u.components[installComponent(u, 'layout.section')], {});
    section.overrides = { container: { base: { layout: 'grid', columns: 2 } } };
    section.slots = { content: ['n_feature'] };
    page([placement('n_code', 'c_code', { slots: { content: [section.id] } }), section, el('n_feature', 'Feature', { base: { columnSpan: '3' } })], u);
    expect(guardrails(u)).toEqual([]);
  });

  it('says nothing where the theme’s own rules may place a detached copy of its design', () => {
    // Editorial gives a text section's heading the whole row when it is alone, detached copies included.
    const loneHeading = (detachedFrom?: unknown) => {
      const s = createStarterState('blank', 'Blank', false, 'editorial');
      return page([el('n_grid', 'Grid', { base: { layout: 'grid', columns: 2 } }, ['n_heading']), el('n_heading', 'Heading', { base: { columnSpan: '3' } }, [], detachedFrom ? ({ detachedFrom } as Partial<ElementNode>) : {})], s);
    };
    expect(guardrails(loneHeading()).map((d) => d.code)).toEqual([SPAN]);
    expect(guardrails(loneHeading({ component: 'editorial-content-text', node: 'heading' }))).toEqual([]);
    // A copy of a node no theme rule hooks is read as usual.
    expect(guardrails(loneHeading({ component: 'editorial-content-text', node: 'nothing-hooks-this' })).map((d) => d.code)).toEqual([SPAN]);
  });

  it('reads a repeat’s items as the grid’s own children, in a project component’s design', () => {
    const s = fresh();
    const def = addDesign(s, 'c_cards', [
      el('n_root', 'Cards', { base: { layout: 'grid', columns: 2 } }, ['n_each']),
      { id: 'n_each', kind: 'repeat', list: { $prop: 'items' }, children: ['n_item'] } as GraphNode,
      el('n_item', 'Card', { base: { columnSpan: '3' } })
    ], { parts: {}, slots: {}, properties: { items: { type: 'list', label: 'Items', fields: {}, default: [{ id: 'i_one' }] } } as ComponentDefinition['properties'] });
    expect(guardrails(s).map((d) => [d.code, d.owner, d.nodeId])).toEqual([[SPAN, { kind: 'component', id: def.id }, 'n_item']]);
  });
});

describe('an absolutely positioned element with nothing positioned around it', () => {
  /** Section › card › an absolutely positioned badge. */
  const loose = (card: ResponsiveStyles = { base: { layout: 'stack' } }, section: ResponsiveStyles = {}) =>
    page([el('n_section', 'Section', section, ['n_card']), el('n_card', 'Card', card, ['n_badge']), el('n_badge', 'Badge', { base: { position: 'absolute', inset: '1rem 1rem auto auto' } })]);

  it('is a warning naming the container to make Relative', () => {
    const s = loose();
    const [d, ...rest] = guardrails(s);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ severity: 'warning', code: ABSOLUTE, owner: owner(s), nodeId: 'n_badge' });
    expect(d.message).toBe(
      `${home(s).title}: “Badge” is positioned absolutely, but no container around it is Relative, Sticky or Absolute, so it is placed against the whole page instead of inside “Card”. Set the Position of “Card” to Relative.`
    );
    expect(blocksSaving(d)).toBe(false);
    expect(d.fix).toBeUndefined();
    expect(guardrails(setStyle(s, 'n_card', 'base', 'position', 'relative'))).toEqual([]);
  });

  it('suggests a container for one placed straight on the page', () => {
    const s = page([el('n_badge', 'Badge', { base: { position: 'absolute' } })]);
    expect(guardrails(s).map((d) => [d.code, d.nodeId])).toEqual([[ABSOLUTE, 'n_badge']]);
    expect(guardrails(s)[0].message).toBe(`${home(s).title}: “Badge” is positioned absolutely with no container around it, so it is placed against the whole page. Put it inside a container, and set that container’s Position to Relative.`);
  });

  it('is anchored by any positioned container around it, at the sizes it is positioned', () => {
    // (A section placed absolutely is loose itself, straight on the page; the badge inside it is not.)
    for (const position of ['relative', 'sticky', 'absolute']) expect(guardrails(loose(undefined, { base: { position } })).filter((d) => d.nodeId === 'n_badge'), position).toEqual([]);
    // Normal is no position at all.
    expect(guardrails(loose(undefined, { base: { position: 'static' } })).map((d) => d.nodeId)).toEqual(['n_badge']);
    expect(guardrails(loose({ base: { layout: 'stack' }, tablet: { position: 'relative' } }))[0].message).toMatch(/: on phones and desktops, “Badge” is positioned absolutely/);
    // Hidden on phones, it is placed nowhere there.
    let s = loose({ base: { layout: 'stack' }, tablet: { position: 'relative' } });
    s = setStyle(s, 'n_badge', 'phone', 'hidden', true);
    expect(guardrails(s)[0].message).toMatch(/: on desktops, “Badge” is positioned absolutely/);
  });

  it('is anchored by a shift, scale, turn or blur on a container, even one that changes nothing', () => {
    for (const styles of [{ translateY: '0px' }, { translateX: '-4px' }, { scale: 1 }, { rotate: 0 }, { backdropBlur: '12px' }, { customCss: 'filter: saturate(1.2)' }] as StyleProps[])
      expect(guardrails(loose({ base: { layout: 'stack', ...styles } })), JSON.stringify(styles)).toEqual([]);
    // Neither a zero blur, opacity, a layer, a turning point nor custom CSS that only paints makes one.
    for (const styles of [{ backdropBlur: '0' }, { opacity: 0.9 }, { zIndex: 2 }, { transformOrigin: 'top left' }, { customCss: 'color: red' }] as StyleProps[])
      expect(guardrails(loose({ base: { layout: 'stack', ...styles } })).map((d) => d.code), JSON.stringify(styles)).toEqual([ABSOLUTE]);
    // A shift only on hover leaves it loose while resting.
    expect(guardrails(loose({ base: { layout: 'stack' }, 'base:hover': { translateY: '-4px' } })).map((d) => d.code)).toEqual([ABSOLUTE]);
  });

  it('follows the box a placed component wraps its slot in, as the options chosen style it', () => {
    const s = fresh();
    const tone = { label: 'Tone', default: 'plain', options: { plain: { label: 'Plain' }, framed: { label: 'Framed', styles: { n_inner: { base: { position: 'relative' } } } } } };
    addDesign(s, 'c_card', [el('n_root', 'Frame', { base: { layout: 'stack' } }, ['n_inner']), el('n_inner', 'Inner', undefined, ['n_slot']), slotNode('n_slot')], { variantAxes: { tone } });
    page([placement('n_place', 'c_card', { slots: { content: ['n_badge'] } }), el('n_badge', 'Badge', { base: { position: 'absolute' } })], s);
    const [d, ...rest] = guardrails(s);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ code: ABSOLUTE, nodeId: 'n_badge' });
    expect(d.message).toMatch(/instead of inside “Inside” in “Card”\. Set the Position of “Inside” in “Card” to Relative\.$/);
    // The option that positions the box around the slot anchors it; the root, which the page shows, never changed.
    home(s).nodes.n_place = placement('n_place', 'c_card', { slots: { content: ['n_badge'] }, variants: { tone: 'framed' } });
    expect(guardrails(s)).toEqual([]);
    // So does the placement's own change to that part, which also beats the option's.
    home(s).nodes.n_place = placement('n_place', 'c_card', { slots: { content: ['n_badge'] }, overrides: { inner: { base: { position: 'sticky' } } } });
    expect(guardrails(s)).toEqual([]);
    home(s).nodes.n_place = placement('n_place', 'c_card', { slots: { content: ['n_badge'] }, variants: { tone: 'framed' }, overrides: { inner: { base: { position: 'static' } } } });
    expect(guardrails(s).map((x) => x.nodeId)).toEqual(['n_badge']);
  });

  it('says nothing where what is around it is not known', () => {
    // Inside a project component's design, which may be placed in a positioned box.
    const s = fresh();
    addDesign(s, 'c_badge', [el('n_root', 'Frame', undefined, ['n_mark']), el('n_mark', 'Mark', { base: { position: 'absolute' } })], { parts: {}, slots: {} });
    expect(guardrails(s)).toEqual([]);
    // Inside a container with an action, which the runtime may wrap in a link of its own (positioned, to open an image).
    expect(guardrails(page([el('n_card', 'Card', undefined, ['n_badge'], { action: 'image' }), el('n_badge', 'Badge', { base: { position: 'absolute' } })]))).toEqual([]);
    // Inside a carousel, whose frame is the runtime's.
    expect(guardrails(page([el('n_track', 'Track', undefined, ['n_slide'], { tag: 'ul', carousel: true }), el('n_slide', 'Slide', { base: { position: 'absolute' } }, [], { tag: 'li' })]))).toEqual([]);
    // Inside a design's slot rendered in two places.
    const t = fresh();
    addDesign(t, 'c_twice', [el('n_root', 'Frame', undefined, ['n_a', 'n_b']), slotNode('n_a'), slotNode('n_b')], { parts: {} });
    page([placement('n_place', 'c_twice', { slots: { content: ['n_badge'] } }), el('n_badge', 'Badge', { base: { position: 'absolute' } })], t);
    expect(guardrails(t)).toEqual([]);
  });
});

describe('the guardrails as diagnostics', () => {
  it('keep their identity through renames, so a rename brings in nothing new', () => {
    const s = page([
      el('n_card', 'Card', { base: { layout: 'stack', overflow: 'hidden' } }, ['n_side', 'n_note', 'n_badge']),
      el('n_side', 'Sidebar', { base: { position: 'sticky', inset: '0' } }),
      el('n_note', 'Note', { base: { position: 'sticky', inset: '0' } }),
      el('n_badge', 'Badge', { base: { position: 'absolute' } })
    ]);
    const before = guardrails(s);
    expect(before.map((d) => d.code).sort()).toEqual([ABSOLUTE, STICKY, STICKY]);
    // Two of a kind in one page are two problems: the second one made again is new.
    expect(introducedDiagnostics(before.filter((d) => d.nodeId !== 'n_note'), before).map((d) => d.nodeId)).toEqual(['n_note']);
    const renamed = apply(s, [
      { type: 'page.update', pageId: s.site.homePageId, title: 'Start' },
      { type: 'node.rename', owner: owner(s), nodeId: 'n_side', name: 'Contents' }
    ] as EditOperation[]);
    const after = guardrails(renamed);
    expect(after.map((d) => d.message)).not.toEqual(before.map((d) => d.message));
    expect(introducedDiagnostics(before, after)).toEqual([]);
  });

  it('never block a save or an edit', () => {
    const before = page([el('n_card', 'Card', { base: { layout: 'stack', overflow: 'visible' } }, ['n_side']), el('n_side', 'Sidebar', { base: { position: 'sticky', inset: '0' } })]);
    expect(guardrails(before)).toEqual([]);
    // The edit that brings the problem in goes through, and saving reads none of it.
    const s = setStyle(before, 'n_card', 'base', 'overflow', 'hidden');
    expect(guardrails(s).map((d) => d.code)).toEqual([STICKY]);
    expect(validateState(s).filter(blocksSaving)).toEqual([]);
    expect(validateState(s, { sectionLinks: false }).filter((d) => d.code.startsWith('LAYOUT_'))).toEqual([]);
  });

  it('find nothing in any starter of any theme, or in any of a theme’s components placed on a page', () => {
    for (const theme of listThemes())
      for (const starter of STARTERS) {
        const s = createStarterState(starter.id, 'Site', false, theme.id);
        expect(guardrails(s), `${theme.id} ${starter.id}`).toEqual([]);
        if (starter.id !== 'business') continue;
        // Each design placed straight on the page, as it comes.
        for (const c of theme.components.filter((x) => x.kind === 'managed')) {
          const id = installComponent(s, c.componentId);
          const node = makeInstance(s.components[id], {});
          home(s).nodes[node.id] = node;
          home(s).rootIds.push(node.id);
        }
        expect(guardrails(s), `${theme.id} components`).toEqual([]);
        // The theme's own stylesheet positions nothing a page sits in: a loose badge is still found.
        page([el('n_badge', 'Badge', { base: { position: 'absolute' } })], s);
        expect(guardrails(s).map((d) => d.code), `${theme.id} badge`).toEqual([ABSOLUTE]);
      }
  });
});
