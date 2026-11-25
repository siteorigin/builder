// Column span and Row span show in the Layout group itself when the styled element sits directly in a grid (#666):
// which box that is, as the site renders it, and which style rows the Inspector then shows with every group closed.
import { describe, expect, it, vi } from 'vitest';
import type { ComponentDefinition, ElementNode, ElementRef, InstanceNode, OwnerRef, ProjectState, ResponsiveScope } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { STYLE_PROPS, STYLE_PROP_MAP, partStyleControls, placementStyleControls, styleSetFor } from '@shared/styles';
import { designGridRef, isGridChild, styleRowGroups, withGridChildProps } from '../../src/renderer/src/lib/grid-child';
import { captureStyle, planStylePaste } from '../../src/renderer/src/lib/style-copy';

vi.stubGlobal('window', { builder: { project: { saveLocalState: async () => {} }, ai: { stop: async () => {} }, platform: 'darwin' } });

type Insert = Record<string, unknown>;

/** A blank site's home page with one Section, and helpers to build inside it. */
function site() {
  let state: ProjectState = createStarterState('blank', 'Blank', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const apply = (...ops: unknown[]) => {
    const r = applyOperations(state, ops as never);
    state = r.state;
    return r.results;
  };
  const insert = (at: Insert) => apply({ type: 'node.insert', owner, ...at })[0].nodeId as string;
  const section = insert({ parentId: null, componentId: 'layout.section' });
  const style = (nodeId: string, property: string, value: unknown, scope: ResponsiveScope = 'base', extra: Insert = {}) => apply({ type: 'node.setStyle', owner, nodeId, scope, property, value, ...extra });
  const ref = (nodeId: string, extra: Partial<ElementRef> = {}): ElementRef => ({ owner, instancePath: [], nodeId, ...extra });
  const placed = (id: string) => state.pages[owner.id].nodes[id] as InstanceNode;
  const defOf = (id: string): ComponentDefinition => state.components[placed(id).definitionId];
  return { get state() { return state; }, set state(s: ProjectState) { state = s; }, owner, apply, insert, section, style, ref, placed, defOf };
}

describe('whether an element is a grid item', () => {
  it('is one directly in a Grid, and not one deeper in a stack inside it', () => {
    const s = site();
    const grid = s.insert({ parentId: s.section, slot: 'content', primitive: 'grid' });
    const cell = s.insert({ parentId: grid, primitive: 'stack' });
    const text = s.insert({ parentId: cell, primitive: 'heading' });
    expect(isGridChild(s.state, s.ref(cell), 'base')).toBe(true);
    expect(isGridChild(s.state, s.ref(text), 'base')).toBe(false);
    // The Grid itself sits in the Section's flow.
    expect(isGridChild(s.state, s.ref(grid), 'base')).toBe(false);
  });

  it('follows the grid’s layout at the size edited, and any screen size under All sizes', () => {
    const s = site();
    const grid = s.insert({ parentId: s.section, slot: 'content', primitive: 'grid' });
    const cell = s.insert({ parentId: grid, primitive: 'stack' });
    s.style(grid, 'layout', 'stack', 'phone');
    expect(isGridChild(s.state, s.ref(cell), 'phone')).toBe(false);
    expect(isGridChild(s.state, s.ref(cell), 'tablet')).toBe(true);
    expect(isGridChild(s.state, s.ref(cell), 'base')).toBe(true);
    s.style(grid, 'layout', 'stack');
    s.style(grid, 'layout', null, 'phone');
    expect(isGridChild(s.state, s.ref(cell), 'base')).toBe(false);
    s.style(grid, 'layout', 'grid', 'desktop');
    expect(isGridChild(s.state, s.ref(cell), 'desktop')).toBe(true);
    expect(isGridChild(s.state, s.ref(cell), 'tablet')).toBe(false);
    expect(isGridChild(s.state, s.ref(cell), 'base')).toBe(true);
  });

  it('reads content in a Section’s slot through the design, with the placement’s own Container layout', () => {
    const s = site();
    const card = s.insert({ parentId: s.section, slot: 'content', primitive: 'stack' });
    const other = s.insert({ parentId: null, componentId: 'layout.section' });
    const plain = s.insert({ parentId: other, slot: 'content', primitive: 'stack' });
    expect(isGridChild(s.state, s.ref(card), 'base')).toBe(false);
    s.style(s.section, 'layout', 'grid', 'base', { partId: 'container' });
    expect(isGridChild(s.state, s.ref(card), 'base')).toBe(true);
    expect(isGridChild(s.state, s.ref(plain), 'base')).toBe(false);
  });

  it('is told for a component placed in a grid, whose Layout controls then offer its spans', () => {
    const s = site();
    const grid = s.insert({ parentId: s.section, slot: 'content', primitive: 'grid' });
    const nested = s.insert({ parentId: grid, componentId: 'layout.section' });
    expect(isGridChild(s.state, s.ref(nested), 'base')).toBe(true);
    // Its root part, selected by name, renders in the same place.
    const def = s.defOf(nested);
    const root = def.tree!.rootIds[0];
    expect(isGridChild(s.state, s.ref(root, { instancePath: [nested], partId: 'root' }), 'base')).toBe(true);
    const list = placementStyleControls(def, 'root', false)!;
    expect(list).not.toContain('columnSpan');
    expect(withGridChildProps(list, true)).toEqual([...list, 'columnSpan', 'rowSpan']);
    expect(withGridChildProps(list, false)).toBe(list);
    expect(withGridChildProps(undefined, true)).toBeUndefined();
    // A section of the page itself has no grid around it.
    expect(isGridChild(s.state, s.ref(s.section), 'base')).toBe(false);
  });

  it('reads past a repeat to the grid its items render in, for a part of a placement', () => {
    const s = site();
    const cards = s.insert({ parentId: null, componentId: 'features.grid' });
    const def = s.defOf(cards);
    const tree = def.tree!;
    const repeat = Object.values(tree.nodes).find((n) => n.kind === 'repeat')!;
    const card = (repeat as { children: string[] }).children[0];
    expect(isGridChild(s.state, s.ref(card, { instancePath: [cards] }), 'base')).toBe(true);
    // Inside the card, the card is the box around it.
    const inner = (tree.nodes[card] as ElementNode).children[0];
    expect(isGridChild(s.state, s.ref(inner, { instancePath: [cards] }), 'base')).toBe(false);
    // In the design on its own the same card is a grid item, and the design's root has no box to tell.
    const editing: OwnerRef = { kind: 'component', id: def.id };
    expect(isGridChild(s.state, { owner: editing, instancePath: [], nodeId: card }, 'base')).toBe(true);
    expect(isGridChild(s.state, { owner: editing, instancePath: [], nodeId: tree.rootIds[0] }, 'base')).toBe(false);
  });

  it('counts the look being styled when the look is what makes the box a grid', () => {
    const s = site();
    const cards = s.insert({ parentId: null, componentId: 'features.grid' });
    const state = structuredClone(s.state);
    const def = state.components[s.placed(cards).definitionId];
    const repeat = Object.values(def.tree!.nodes).find((n) => n.kind === 'repeat')!;
    const card = (repeat as { children: string[] }).children[0];
    const grid = Object.values(def.tree!.nodes).find((n) => n.kind === 'element' && n.children.includes(repeat.id))!;
    grid.styles = { base: { layout: 'stack' } };
    def.variantAxes = { shape: { label: 'Shape', default: 'list', options: { list: { label: 'List' }, bento: { label: 'Bento', styles: { [grid.id]: { base: { layout: 'grid' } } } } } } };
    const at: ElementRef = { owner: { kind: 'component', id: def.id }, instancePath: [], nodeId: card };
    expect(isGridChild(state, at, 'base')).toBe(false);
    expect(isGridChild(state, at, 'base', { axis: 'shape', variant: 'bento' })).toBe(true);
    // A placement that chose the look shows its items in a grid.
    expect(isGridChild(state, s.ref(card, { instancePath: [cards] }), 'base')).toBe(false);
    (state.pages[s.owner.id].nodes[cards] as InstanceNode).variants = { shape: 'bento' };
    expect(isGridChild(state, s.ref(card, { instancePath: [cards] }), 'base')).toBe(true);
  });

  it('reads a slot’s fallback where the slot renders', () => {
    const s = site();
    const state = structuredClone(s.state);
    const def = state.components[s.placed(s.section).definitionId];
    const slot = Object.values(def.tree!.nodes).find((n) => n.kind === 'slot')!;
    def.tree!.nodes.fallback = { id: 'fallback', kind: 'element', tag: 'div', children: [] } as never;
    (slot as { children?: string[] }).children = ['fallback'];
    const at: ElementRef = { owner: s.owner, instancePath: [s.section], nodeId: 'fallback' };
    expect(isGridChild(state, at, 'base')).toBe(false);
    (state.pages[s.owner.id].nodes[s.section] as InstanceNode).overrides = { container: { base: { layout: 'grid' } } };
    expect(isGridChild(state, at, 'base')).toBe(true);
  });

  it('counts a grid that only one screen size makes, whichever it is', () => {
    const s = site();
    const box = s.insert({ parentId: s.section, slot: 'content', primitive: 'stack' });
    const cell = s.insert({ parentId: box, primitive: 'stack' });
    for (const size of ['phone', 'tablet', 'desktop'] as const) {
      s.style(box, 'layout', 'grid', size);
      expect(isGridChild(s.state, s.ref(cell), 'base'), size).toBe(true);
      expect(isGridChild(s.state, s.ref(cell), size), size).toBe(true);
      s.style(box, 'layout', null, size);
    }
    expect(isGridChild(s.state, s.ref(cell), 'base')).toBe(false);
  });

  it('is not claimed for an element another box wraps: a card’s action link takes the cell', () => {
    const s = site();
    const grid = s.insert({ parentId: s.section, slot: 'content', primitive: 'grid' });
    const cell = s.insert({ parentId: grid, primitive: 'stack' });
    s.insert({ parentId: cell, primitive: 'image' });
    const state = structuredClone(s.state);
    (state.pages[s.owner.id].nodes[cell] as ElementNode).action = 'image';
    expect(isGridChild(state, s.ref(cell), 'base')).toBe(false);
  });

  it('keeps the cell for an element whose action has no picture to open, so no link goes around it', () => {
    const s = site();
    const grid = s.insert({ parentId: s.section, slot: 'content', primitive: 'grid' });
    const cell = s.insert({ parentId: grid, primitive: 'stack' });
    const state = structuredClone(s.state);
    (state.pages[s.owner.id].nodes[cell] as ElementNode).action = 'image';
    expect(isGridChild(state, s.ref(cell), 'base')).toBe(true);
  });

  it('is not claimed inside a code component, or for a node that is not there', () => {
    const s = site();
    expect(isGridChild(s.state, s.ref('nowhere'), 'base')).toBe(false);
    expect(isGridChild(s.state, s.ref('nowhere', { instancePath: ['gone'] }), 'base')).toBe(false);
    const grid = s.insert({ parentId: s.section, slot: 'content', primitive: 'grid' });
    const nested = s.insert({ parentId: grid, componentId: 'layout.section' });
    const state = structuredClone(s.state);
    const def = state.components[(state.pages[s.owner.id].nodes[nested] as InstanceNode).definitionId];
    state.components[def.id] = { ...def, kind: 'code', tree: undefined, source: '' } as ComponentDefinition;
    expect(isGridChild(state, s.ref('anything', { instancePath: [nested] }), 'base')).toBe(false);
    // The placement itself is still the grid's item.
    expect(isGridChild(state, s.ref(nested), 'base')).toBe(true);
  });
});

describe('whether content is a grid item through designs nested in one another', () => {
  /**
   * A page placing "outer", whose root places "inner" and gives its slot a tile. Inner is a root holding a box that
   * holds the slot, and a second slot in a grid beside it.
   */
  const nested = () => {
    const element = (id: string, children: string[], extra: object = {}) => ({ id, kind: 'element', tag: 'div', children, ...extra });
    const design = (id: string, nodes: Record<string, unknown>, root: string, parts: Record<string, string>, extra: object = {}) =>
      ({ id, componentId: id, kind: 'managed', owner: 'project', name: id, properties: {}, parts: Object.fromEntries(Object.entries(parts).map(([p, nodeId]) => [p, { nodeId, label: p }])), tree: { rootIds: [root], nodes }, ...extra }) as unknown as ComponentDefinition;
    const inner = design(
      'a.inner',
      {
        root: element('root', ['holder', 'side']),
        holder: { id: 'holder', kind: 'slot', slot: 'content' },
        side: element('side', ['aside'], { styles: { base: { layout: 'grid' } } }),
        aside: { id: 'aside', kind: 'slot', slot: 'aside' }
      },
      'root',
      { root: 'root' },
      { variantAxes: { shape: { label: 'Shape', default: 'list', options: { list: { label: 'List' }, bento: { label: 'Bento', styles: { root: { base: { layout: 'grid' } } } } } } } }
    );
    const outer = design(
      'z.outer',
      {
        wrap: element('wrap', ['nest']),
        nest: { id: 'nest', kind: 'instance', definitionId: 'a.inner', props: {}, slots: { content: ['tile'], aside: ['note'] } },
        tile: element('tile', []),
        note: element('note', [])
      },
      'wrap',
      { root: 'wrap', box: 'nest' }
    );
    const state = structuredClone(createStarterState('blank', 'Blank', false));
    const home = state.pages[state.site.homePageId];
    state.components = { ...state.components, [inner.id]: inner, [outer.id]: outer };
    home.rootIds = ['placed'];
    home.nodes = { placed: { id: 'placed', kind: 'instance', definitionId: 'z.outer', props: {} } as InstanceNode };
    const owner: OwnerRef = { kind: 'page', id: home.id };
    const at = (nodeId: string): ElementRef => ({ owner, instancePath: ['placed'], nodeId });
    return {
      state,
      at,
      outer: state.components['z.outer'],
      placed: home.nodes.placed as InstanceNode,
      nest: state.components['z.outer'].tree!.nodes.nest as InstanceNode
    };
  };

  it('reads each slot where its own outlet shows it', () => {
    const s = nested();
    expect(isGridChild(s.state, s.at('tile'), 'base')).toBe(false);
    expect(isGridChild(s.state, s.at('note'), 'base')).toBe(true);
  });

  it('lets the page’s change to a part that is a placed component beat that placement’s own', () => {
    const s = nested();
    s.nest.overrides = { root: { base: { layout: 'stack' } } };
    expect(isGridChild(s.state, s.at('tile'), 'base')).toBe(false);
    s.placed.overrides = { box: { base: { layout: 'grid' } } };
    expect(isGridChild(s.state, s.at('tile'), 'base')).toBe(true);
    s.nest.overrides = { root: { base: { layout: 'grid' } } };
    s.placed.overrides = { box: { base: { layout: 'stack' } } };
    expect(isGridChild(s.state, s.at('tile'), 'base')).toBe(false);
  });

  it('counts the outer design’s own rules for the placement, which land on the nested root', () => {
    const s = nested();
    s.outer.variantAxes = { dense: { label: 'Dense', default: 'on', options: { on: { label: 'On', styles: { nest: { base: { layout: 'grid' } } } } } } };
    expect(isGridChild(s.state, s.at('tile'), 'base')).toBe(true);
  });

  it('gives the later design’s block the say between two designs, whatever size the earlier one’s rule is for', () => {
    const s = nested();
    // The outer design's stylesheet block comes after the inner's, so its rule for All sizes beats a desktop one there.
    s.state.components['a.inner'].tree!.nodes.root.styles = { desktop: { layout: 'stack' } };
    s.outer.tree!.nodes.nest.styles = { base: { layout: 'grid' } };
    expect(isGridChild(s.state, s.at('tile'), 'desktop')).toBe(true);
  });

  it('weighs changes made inside designs alike, a part that is a placed component or not', () => {
    const s = nested();
    const top = { ...structuredClone(s.outer), id: 'b.top', componentId: 'b.top', parts: {}, tree: { rootIds: ['q'], nodes: { q: { id: 'q', kind: 'instance', definitionId: 'z.outer', props: {}, overrides: { box: { base: { layout: 'stack' } } } } } } } as unknown as ComponentDefinition;
    s.state.components['b.top'] = top;
    s.placed.definitionId = 'b.top';
    s.nest.overrides = { root: { base: { layout: 'grid' } } };
    // Both are three classes; the later design's block (z.outer after b.top) wins.
    expect(isGridChild(s.state, { ...s.at('tile'), instancePath: ['placed', 'q'] }, 'base')).toBe(true);
  });

  it('reads the property’s default in the design edited on its own', () => {
    const s = nested();
    s.outer.properties = { shape: { type: 'enum', label: 'Shape', default: 'bento', options: [{ value: 'list', label: 'List' }, { value: 'bento', label: 'Bento' }] } };
    s.nest.variants = { shape: { $prop: 'shape' } };
    expect(isGridChild(s.state, { owner: { kind: 'component', id: 'z.outer' }, instancePath: [], nodeId: 'tile' }, 'base')).toBe(true);
  });

  it('reads a property a design takes from the selected list item', () => {
    const s = nested();
    const shape = { type: 'enum', label: 'Shape', default: 'list', options: [{ value: 'list', label: 'List' }, { value: 'bento', label: 'Bento' }] };
    s.outer.properties = { shape } as ComponentDefinition['properties'];
    s.nest.variants = { shape: { $prop: 'shape' } };
    const top = {
      ...structuredClone(s.outer),
      id: 'b.top',
      componentId: 'b.top',
      parts: {},
      properties: { rows: { type: 'list', label: 'Rows', itemLabel: 'Row', fields: { kind: shape }, default: [{ id: 'one', kind: 'bento' }, { id: 'two', kind: 'list' }] } },
      tree: { rootIds: ['wrap'], nodes: { wrap: { id: 'wrap', kind: 'element', tag: 'div', children: ['each'] }, each: { id: 'each', kind: 'repeat', list: { $prop: 'rows' }, children: ['q'] }, q: { id: 'q', kind: 'instance', definitionId: 'z.outer', props: { shape: { $item: 'kind' } } } } }
    } as unknown as ComponentDefinition;
    s.state.components['b.top'] = top;
    s.placed.definitionId = 'b.top';
    const tile = { ...s.at('tile'), instancePath: ['placed', 'q'] };
    expect(isGridChild(s.state, { ...tile, itemPath: ['one'] }, 'base')).toBe(true);
    expect(isGridChild(s.state, { ...tile, itemPath: ['two'] }, 'base')).toBe(false);
  });

  it('reads the item of the list that repeats the placement, not another list’s item with the same ID', () => {
    const s = nested();
    const shape = { type: 'enum', label: 'Shape', default: 'list', options: [{ value: 'list', label: 'List' }, { value: 'bento', label: 'Bento' }] };
    s.outer.properties = {
      groups: { type: 'list', label: 'Groups', itemLabel: 'Group', fields: {}, default: [{ id: 'one' }] },
      rows: { type: 'list', label: 'Rows', itemLabel: 'Row', fields: { kind: shape }, default: [{ id: 'one', kind: 'bento' }, { id: 'two', kind: 'list' }] }
    } as unknown as ComponentDefinition['properties'];
    const nodes = s.outer.tree!.nodes as Record<string, unknown>;
    nodes.groups = { id: 'groups', kind: 'repeat', list: { $prop: 'groups' }, children: ['rows'] };
    nodes.rows = { id: 'rows', kind: 'repeat', list: { $prop: 'rows' }, children: ['nest'] };
    (nodes.wrap as ElementNode).children = ['groups'];
    // A nested placement's variant can read the item's field directly.
    s.nest.variants = { shape: { $item: 'kind' } };
    const tile = s.at('tile');
    expect(isGridChild(s.state, { ...tile, itemPath: ['one', 'one'] }, 'base')).toBe(true);
    expect(isGridChild(s.state, { ...tile, itemPath: ['one', 'two'] }, 'base')).toBe(false);
    // The design edited on its own keeps the item selected in it.
    const design: OwnerRef = { kind: 'component', id: 'z.outer' };
    const selected: ElementRef = { owner: design, instancePath: [], nodeId: 'tile', itemPath: ['one', 'one'] };
    expect(isGridChild(s.state, designGridRef(selected, design, 'tile', true), 'base')).toBe(true);
  });

  it('asks about the placement a design is edited through, and the design alone in Component Studio or a look', () => {
    const s = nested();
    s.outer.properties = { shape: { type: 'enum', label: 'Shape', default: 'bento', options: [{ value: 'list', label: 'List' }, { value: 'bento', label: 'Bento' }] } };
    s.nest.variants = { shape: { $prop: 'shape' } };
    s.placed.props = { shape: 'list' };
    const design: OwnerRef = { kind: 'component', id: 'z.outer' };
    const through = s.at('tile');
    expect(isGridChild(s.state, designGridRef(through, design, 'tile', false), 'base')).toBe(false);
    expect(isGridChild(s.state, designGridRef(through, design, 'tile', true), 'base')).toBe(true);
    expect(isGridChild(s.state, designGridRef(null, design, 'tile', false), 'base')).toBe(true);
    // A selection of some other node says nothing about this one.
    expect(designGridRef({ ...through, itemPath: ['one'] }, design, 'wrap', false)).toEqual({ owner: design, instancePath: [], nodeId: 'wrap', itemPath: undefined });
  });

  it('reads a variant a nested placement takes from a property of the design around it', () => {
    const s = nested();
    s.outer.properties = { shape: { type: 'enum', label: 'Shape', default: 'list', options: [{ value: 'list', label: 'List' }, { value: 'bento', label: 'Bento' }] } };
    s.nest.variants = { shape: { $prop: 'shape' } };
    expect(isGridChild(s.state, s.at('tile'), 'base')).toBe(false);
    s.placed.props = { shape: 'bento' };
    expect(isGridChild(s.state, s.at('tile'), 'base')).toBe(true);
    s.placed.props = {};
    (s.outer.properties.shape as { default: string }).default = 'bento';
    expect(isGridChild(s.state, s.at('tile'), 'base')).toBe(true);
  });
});

describe('whether a list item’s own part style makes the box around its content a grid', () => {
  it('counts it for that item alone', () => {
    const s = site();
    const cards = s.insert({ parentId: null, componentId: 'features.grid' });
    const def = s.defOf(cards);
    const [partId, part] = Object.entries(def.parts).find(([, p]) => {
      const n = def.tree!.nodes[p.nodeId];
      return n.kind === 'element' && n.children.length > 0 && Object.values(def.tree!.nodes).some((r) => r.kind === 'repeat' && r.children.includes(p.nodeId));
    })!;
    const inner = (def.tree!.nodes[part.nodeId] as ElementNode).children[0];
    const items = (s.placed(cards).props.items ?? (def.properties.items as { default: unknown }).default) as Array<{ id: string }>;
    s.apply({ type: 'node.setStyle', owner: s.owner, nodeId: cards, partId, itemId: items[0].id, scope: 'base', property: 'layout', value: 'grid' });
    const at = s.ref(inner, { instancePath: [cards] });
    expect(isGridChild(s.state, { ...at, itemPath: [items[0].id] }, 'base')).toBe(true);
    expect(isGridChild(s.state, { ...at, itemPath: [items[1].id] }, 'base')).toBe(false);
    expect(isGridChild(s.state, at, 'base')).toBe(false);
  });
});

describe('the Inspector’s style rows for a grid item', () => {
  const rows = (allowed: string[] | undefined, gridChild: boolean, set: string[] = []) => {
    const list = withGridChildProps(allowed, gridChild);
    const props = list ? list.map((id) => STYLE_PROP_MAP[id]) : STYLE_PROPS;
    // As the Inspector decides what means something on an element that is no stack or grid itself.
    const containerOnly = ['columns', 'gridTemplate', 'gridAutoFlow', 'gridAutoRows', 'align', 'justify', 'gap', 'wrap', 'rowGap', 'columnGap', 'order', 'inset'];
    return styleRowGroups(props, { relevant: (id) => set.includes(id) || !containerOnly.includes(id), setAnywhere: (id) => set.includes(id), gridChild });
  };
  const layout = (groups: ReturnType<typeof rows>) => groups.find((g) => g.g === 'layout')?.visible.map((p) => p.id) ?? [];

  it('shows Column span and Row span in the closed Layout group of every kind of element', () => {
    for (const kind of ['text', 'image', 'link', 'icon', 'element']) {
      const list = styleSetFor({ kind })!;
      expect(layout(rows(list, true)), kind).toEqual(expect.arrayContaining(['columnSpan', 'rowSpan']));
      expect(layout(rows(list, false)), kind).not.toContain('columnSpan');
      expect(layout(rows(list, false)), kind).not.toContain('rowSpan');
      // They stay one click away outside a grid.
      expect(rows(list, false).find((g) => g.g === 'layout')!.rel.map((p) => p.id), kind).toEqual(expect.arrayContaining(['columnSpan', 'rowSpan']));
    }
  });

  it('shows a long list’s common rows of its first two groups, and any row with a value', () => {
    const text = styleSetFor({ kind: 'text' })!;
    const plain = rows(text, false);
    expect(plain.map((g) => g.g).slice(0, 2)).toEqual(['typography', 'size']);
    expect(layout(plain)).toEqual([]);
    expect(plain.find((g) => g.g === 'typography')!.visible.map((p) => p.id)).toEqual(['textStyle', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign']);
    expect(layout(rows(text, false, ['rowSpan']))).toEqual(['rowSpan']);
    expect(layout(rows(text, true))).toEqual(['columnSpan', 'rowSpan']);
  });

  it('tucks and shows every other row as it would outside a grid', () => {
    for (const kind of ['text', 'image', 'link', 'icon', 'element']) {
      const shown = (gridChild: boolean) => rows(styleSetFor({ kind }), gridChild).flatMap((g) => g.visible.map((p) => p.id)).filter((id) => id !== 'columnSpan' && id !== 'rowSpan');
      expect(shown(true), kind).toEqual(shown(false));
    }
  });

  it('adds them first, under Layout, to a design’s short list, without making it long', () => {
    const groups = rows(['paddingBlock', 'background', 'hidden'], true);
    expect(groups.map((g) => g.g)).toEqual(['layout', 'spacing', 'appearance', 'visibility']);
    expect(groups.every((g) => g.hidden === 0)).toBe(true);
    // Ten rows stay all shown with the two spans beside them.
    const ten = ['paddingBlock', 'paddingInline', 'marginBlockStart', 'marginBlockEnd', 'maxWidth', 'color', 'background', 'radius', 'shadow', 'opacity'];
    expect(rows(ten, true).every((g) => g.hidden === 0)).toBe(true);
  });

  it('shows them for a part of a placed design that lists only its own controls', () => {
    const s = site();
    const cards = s.insert({ parentId: null, componentId: 'features.grid' });
    const def = s.defOf(cards);
    const part = Object.keys(def.parts).find((p) => p !== 'root' && partStyleControls(def, p)?.length && !partStyleControls(def, p)!.includes('columnSpan'))!;
    expect(layout(rows(partStyleControls(def, part), true))).toEqual(expect.arrayContaining(['columnSpan', 'rowSpan']));
  });

  it('pastes spans onto a placement whose design lists other controls, as a grid item’s Inspector offers them', () => {
    const s = site();
    const grid = s.insert({ parentId: s.section, slot: 'content', primitive: 'grid' });
    const cell = s.insert({ parentId: grid, primitive: 'stack' });
    const nested = s.insert({ parentId: grid, componentId: 'layout.section' });
    const outside = s.insert({ parentId: null, componentId: 'layout.section' });
    s.style(cell, 'columnSpan', '2');
    s.style(cell, 'rowSpan', '3', 'desktop');
    const copy = captureStyle(s.state, s.ref(cell))!;
    for (const target of [nested, outside]) {
      const plan = planStylePaste(s.state, copy, s.ref(target), 'every');
      expect(plan.rows.filter((r) => r.property.endsWith('Span')).map((r) => [r.property, r.status])).toEqual([['columnSpan', 'change'], ['rowSpan', 'change']]);
      expect(plan.operations).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: target, partId: 'root', scope: 'desktop', property: 'rowSpan', value: '3' })]));
    }
    expect(planStylePaste(s.state, copy, s.ref(nested), 'desktop').operations.map((o) => (o as { property: string }).property)).toEqual(['rowSpan']);
  });
});
