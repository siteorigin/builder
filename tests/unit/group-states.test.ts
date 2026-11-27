/**
 * Interaction groups (#349): a container marked as a group (a card) shows the `groupHover` and `groupFocus` styles of
 * the elements inside it while it is hovered or holds focus. Set and cleared by the operations, checked like any
 * style, and written as selectors that follow the nearest group around an element, never an outer one.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import type { ComponentDefinition, ElementNode, IconNode, InstanceNode, LinkNode, NodeTree, ProjectState, ResponsiveStyles, TextNode } from '@shared/types';
import { STYLE_STATES, parseStyleScopeKey } from '@shared/types';
import { STATE_STYLE_PROPS, flattenStates, isStateStyleProp, stateStyleError } from '@shared/styles';
import { enclosingGroup, partInInteractionGroup } from '@shared/interaction-groups';
import { createStarterState } from '@catalogue/starters';
import { FOUNDATION_AUTHOR as FOUNDATION, projectDesign } from './fixtures/packs';
import { P, item } from '@catalogue/dsl';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { validateState } from '@engine/validate';
import { makeInstance } from '@engine/install';
import { generateComponentsCss, generateProject, generateSiteCss, groupStateSelector, nodeClass, overrideClass, pageFile } from '@generator/index';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

function apply(s: ProjectState, ops: unknown[]): ProjectState {
  const parsed = ops.map((o) => {
    const v = validateOperation(o);
    if (!v.ok) throw new Error(v.message);
    return v.op;
  });
  return applyOperations(s, parsed as EditOperation[]).state;
}
const rejects = (fn: () => unknown, msg: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as Error).message).toMatch(msg);
    return;
  }
  throw new Error('expected the operation to be rejected');
};

const el = (id: string, children: string[] = [], extra: Partial<ElementNode> = {}): ElementNode => ({ id, kind: 'element', tag: 'div', children, ...extra });
/**
 * Home with an outer card (`n_card`, not yet a group) holding an arrow (`n_arrow`), a heading and an inner card
 * (`n_inner`) with its own arrow (`n_inner_arrow`), and a loose arrow (`n_loose`) outside every card.
 */
function cards(): ProjectState {
  const s = fresh();
  const page = home(s);
  const add = (n: ElementNode | TextNode | IconNode) => (page.nodes[n.id] = n);
  add(el('n_card', ['n_title', 'n_arrow', 'n_inner']));
  add({ id: 'n_title', kind: 'text', tag: 'h3', text: 'Card' } as TextNode);
  add({ id: 'n_arrow', kind: 'icon', icon: 'arrow-right' } as IconNode);
  add(el('n_inner', ['n_inner_arrow']));
  add({ id: 'n_inner_arrow', kind: 'icon', icon: 'arrow-right' } as IconNode);
  add({ id: 'n_loose', kind: 'icon', icon: 'arrow-right' } as IconNode);
  page.rootIds.push('n_card', 'n_loose');
  return s;
}
const node = (s: ProjectState, id: string) => home(s).nodes[id];
const group = (s: ProjectState, nodeId: string, value: unknown = true) => apply(s, [{ type: 'node.setContent', owner: owner(s), nodeId, field: 'interactionGroup', value }]);
const style = (s: ProjectState, nodeId: string, scope: string, state: string | undefined, property: string, value: unknown) =>
  apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId, scope, ...(state ? { state } : {}), property, value }]);
const warnings = (s: ProjectState, code: string) => validateState(s).filter((d) => d.code === code);

describe('group states in the style map', () => {
  it('are two more states, written before the element’s own', () => {
    expect(STYLE_STATES).toEqual(['groupHover', 'groupFocus', 'hover', 'focus', 'active']);
    expect(parseStyleScopeKey('phone:groupHover')).toEqual({ scope: 'phone', state: 'groupHover' });
    expect(parseStyleScopeKey('base:groupFocus')).toEqual({ scope: 'base', state: 'groupFocus' });
    expect(parseStyleScopeKey('base:group')).toBeNull();
  });

  it('may also shift, scale and turn the element, which its own states may not', () => {
    for (const p of ['translateX', 'translateY', 'scale', 'rotate']) {
      expect(isStateStyleProp(p, 'groupHover'), p).toBe(true);
      expect(isStateStyleProp(p, 'groupFocus'), p).toBe(true);
      expect(isStateStyleProp(p, 'hover'), p).toBe(false);
      expect(isStateStyleProp(p), p).toBe(false);
    }
    for (const p of STATE_STYLE_PROPS) expect(isStateStyleProp(p, 'groupHover'), p).toBe(true);
    for (const p of ['paddingBlock', 'transition', 'transformOrigin', 'hidden', 'customCss']) expect(isStateStyleProp(p, 'groupHover'), p).toBe(false);
    expect(stateStyleError('translateX', 'hover')).toMatch(/group state .* can change it/);
    expect(stateStyleError('paddingBlock', 'groupFocus')).toMatch(/cannot change while its group has focus/);
  });
});

describe('marking a group and styling what is inside it', () => {
  it('marks and unmarks a container, and refuses anything but a container', () => {
    let s = group(cards(), 'n_card');
    expect((node(s, 'n_card') as ElementNode).interactionGroup).toBe(true);
    s = group(s, 'n_card', false);
    expect(node(s, 'n_card')).not.toHaveProperty('interactionGroup');
    rejects(() => group(cards(), 'n_title'), /Only containers can be interaction groups/);
    rejects(() => group(cards(), 'n_card', 'yes'), /true or false/);
  });

  it('sets and clears group hover and group focus values, and resets one state', () => {
    let s = group(cards(), 'n_card');
    s = style(s, 'n_arrow', 'base', 'groupHover', 'translateX', '4px');
    s = style(s, 'n_arrow', 'phone', 'groupHover', 'opacity', 0.5);
    s = style(s, 'n_arrow', 'base', 'groupFocus', 'color', '#0000ff');
    s = style(s, 'n_arrow', 'base', 'hover', 'color', '#ff0000');
    expect(node(s, 'n_arrow').styles).toEqual({
      'base:groupHover': { translateX: '4px' },
      'phone:groupHover': { opacity: 0.5 },
      'base:groupFocus': { color: '#0000ff' },
      'base:hover': { color: '#ff0000' }
    });
    expect(style(s, 'n_arrow', 'phone', 'groupHover', 'opacity', null).pages[s.site.homePageId].nodes.n_arrow.styles).not.toHaveProperty('phone:groupHover');
    // A reset of one state clears it at every size, and leaves the others.
    s = apply(s, [{ type: 'node.resetStyles', owner: owner(s), nodeId: 'n_arrow', state: 'groupHover' }]);
    expect(node(s, 'n_arrow').styles).toEqual({ 'base:groupFocus': { color: '#0000ff' }, 'base:hover': { color: '#ff0000' } });
    // The element's own hover still refuses a shift; a group state refuses layout.
    rejects(() => style(s, 'n_arrow', 'base', 'hover', 'translateX', '4px'), /cannot change on hover/);
    rejects(() => style(s, 'n_arrow', 'base', 'groupHover', 'paddingBlock', '4px'), /cannot change while its group is hovered/);
  });

  it('refuses to ungroup a group, whose children would lose it', () => {
    const plain = cards();
    expect(home(apply(plain, [{ type: 'node.unwrap', owner: owner(plain), nodeIds: ['n_inner'] }])).nodes).not.toHaveProperty('n_inner');
    const s = group(cards(), 'n_inner');
    rejects(() => apply(s, [{ type: 'node.unwrap', owner: owner(s), nodeIds: ['n_inner'] }]), /interaction group/);
  });

  it('refuses group styles on a list or a slot, which render no element of their own', () => {
    const s = fresh();
    const def = {
      ...FOUNDATION.managed({
        componentId: 'project.list',
        name: 'List',
        category: 'content',
        tags: [],
        icon: 'sparkles',
        description: '',
        properties: { items: P.list('Items', 'Item', { label: P.str('Label', 'Item') }, [{ label: 'One' }]) },
        parts: { root: { nodeId: 'root', label: 'List' } },
        build: (b) => b.el('root', 'ul', { name: 'List', interactionGroup: true }, [b.repeat('rows', 'items', [b.el('row', 'li', { name: 'Row' }, [b.text('label', 'span', item('label'))])])])
      }),
      owner: 'project' as const
    } as ComponentDefinition;
    s.components[def.id] = def;
    const list = def.tree!.nodes.rows;
    const at = { owner: { kind: 'component' as const, id: def.id }, nodeId: list.id, scope: 'base' };
    rejects(() => apply(s, [{ type: 'node.setStyle', ...at, state: 'groupHover', property: 'opacity', value: 0.5 }]), /no element of its own/);
    // Clearing one a hand edit left there is still allowed.
    expect(() => apply(s, [{ type: 'node.setStyle', ...at, state: 'groupHover', property: 'opacity', value: null }])).not.toThrow();
  });
});

describe('which group an element follows', () => {
  it('is the nearest group strictly around it, through slots and repeats too', () => {
    let s = group(cards(), 'n_card');
    expect(enclosingGroup(home(s), 'n_inner_arrow')).toBe('n_card');
    expect(enclosingGroup(home(s), 'n_card')).toBeNull();
    s = group(s, 'n_inner');
    expect(enclosingGroup(home(s), 'n_inner_arrow')).toBe('n_inner');
    // A group is never its own.
    expect(enclosingGroup(home(s), 'n_inner')).toBe('n_card');
    expect(enclosingGroup(home(s), 'n_loose')).toBeNull();
    // Content placed in a placement's slot is inside it, and a repeat passes its group on to what it repeats.
    const tree = {
      rootIds: ['g'],
      nodes: {
        g: el('g', ['place', 'list'], { interactionGroup: true }),
        place: { id: 'place', kind: 'instance', definitionId: 'x', props: {}, slots: { content: ['slotted'] } },
        slotted: { id: 'slotted', kind: 'icon', icon: 'star' },
        list: { id: 'list', kind: 'repeat', list: { $prop: 'items' }, children: ['row'] },
        row: { id: 'row', kind: 'icon', icon: 'star' }
      }
    } as unknown as NodeTree;
    expect(enclosingGroup(tree, 'slotted')).toBe('g');
    expect(enclosingGroup(tree, 'row')).toBe('g');
    (tree.nodes.g as ElementNode).interactionGroup = undefined;
    expect(enclosingGroup(tree, 'slotted')).toBeNull();
  });

  it('warns about group styles no group can show, and about a group flag on what cannot be one', () => {
    let s = style(cards(), 'n_arrow', 'base', 'groupHover', 'opacity', 0.5);
    expect(warnings(s, 'STYLE_GROUP_MISSING')).toMatchObject([{ severity: 'warning', nodeId: 'n_arrow' }]);
    // Marking the card turns them on, and the warning goes; turning it off again keeps them.
    s = group(s, 'n_card');
    expect(warnings(s, 'STYLE_GROUP_MISSING')).toEqual([]);
    s = group(s, 'n_card', false);
    expect(node(s, 'n_arrow').styles).toEqual({ 'base:groupHover': { opacity: 0.5 } });
    expect(warnings(s, 'STYLE_GROUP_MISSING')).toHaveLength(1);
    // A group's own group styles need a group around it.
    s = group(s, 'n_inner');
    s = style(s, 'n_inner', 'base', 'groupFocus', 'border', '1px solid #000000');
    expect(warnings(s, 'STYLE_GROUP_MISSING').map((d) => d.nodeId).sort()).toEqual(['n_arrow', 'n_inner']);
    // A hand edit: a group flag on text, or one that is not true.
    (node(s, 'n_title') as unknown as Record<string, unknown>).interactionGroup = true;
    (node(s, 'n_card') as unknown as Record<string, unknown>).interactionGroup = 'yes';
    expect(warnings(s, 'GROUP_INVALID').map((d) => [d.severity, d.nodeId])).toEqual([
      ['error', 'n_card'],
      ['error', 'n_title']
    ]);
  });

  it('reaches a placement’s part through a group in its design, or around the placement', () => {
    const s = fresh();
    const def = cardDef(s, false);
    expect(partInInteractionGroup(def, 'arrow', false)).toBe(false);
    expect(partInInteractionGroup(def, 'arrow', true)).toBe(true);
    (def.tree!.nodes.root as ElementNode).interactionGroup = true;
    expect(partInInteractionGroup(def, 'arrow', false)).toBe(true);
    // The design's root is no group of its own: only one around the placement reaches it.
    expect(partInInteractionGroup(def, 'root', false)).toBe(false);
  });

  it('reaches a code component’s parts while its code renders a group, as a design converted to code keeps', () => {
    let s = fresh();
    const def = cardDef(s);
    const placed = makeInstance(def, {}) as InstanceNode;
    home(s).nodes[placed.id] = placed;
    home(s).rootIds.push(placed.id);
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: placed.id, partId: 'arrow', scope: 'base', state: 'groupFocus', property: 'color', value: '#00aa00' }]);
    const cls = overrideClass(placed.id, 'arrow');
    expect(generateSiteCss(s)).toContain(`:where(${FOCUS_ON}) .${cls}.${cls}:not(`);
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId: placed.id, name: 'Card code' }]);
    const code = r.state.components[r.results[0].definitionId as string];
    expect(code.kind).toBe('code');
    expect(code.source).toContain('"so-group"');
    expect(generateSiteCss(r.state)).toMatch(new RegExp(`:where\\(${FOCUS_ON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\) \\.${cls}\\.${cls}\\.${cls}:not\\(`));
    expect(warnings(r.state, 'STYLE_GROUP_MISSING')).toEqual([]);
    // Code with no group of its own reaches nothing through its own markup.
    expect(partInInteractionGroup({ ...code, source: code.source!.replaceAll('so-group', 'so-card') }, 'arrow', false)).toBe(false);
  });
});

describe('moving elements between documents', () => {
  it('refuses to make a component of an element whose group effect comes from a card outside it', () => {
    let s = group(cards(), 'n_card');
    s = style(s, 'n_arrow', 'base', 'groupHover', 'translateX', '4px');
    rejects(() => apply(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: 'n_arrow', name: 'Arrow' }]), /“[^”]+” has styles for while its card is hovered/);
    // Made from the card itself, the group goes with it and keeps working.
    const t = apply(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: 'n_card', name: 'Card' }]);
    const made = Object.values(t.components).find((d) => d.name === 'Card')!;
    const arrow = Object.values(made.tree!.nodes).find((n) => n.styles?.['base:groupHover'])!;
    expect(warnings(t, 'STYLE_GROUP_MISSING')).toEqual([]);
    expect(generateComponentsCss(t)).toContain(`:where(${HOVER_ON}) .${nodeClass(made, arrow.id)}:not(`);
  });

  it('keeps a detached design’s dormant group styles dormant, and its working ones working', () => {
    let s = fresh();
    // The same card twice: as designed, a group, and a plain copy whose arrow's group styles no group of its own shows.
    const plain = cardDef(s, false);
    const dormant = { ...plain, id: `${plain.id}-plain`, componentId: 'project.plain-card', name: 'Plain card' } as ComponentDefinition;
    s.components[dormant.id] = dormant;
    const live = cardDef(s);
    const wrap = el('n_wrap', [], { interactionGroup: true });
    home(s).nodes[wrap.id] = wrap;
    home(s).rootIds.push(wrap.id);
    const placements = [live, dormant].map((d) => {
      const p = makeInstance(d, {}) as InstanceNode;
      home(s).nodes[p.id] = p;
      wrap.children.push(p.id);
      return p;
    });
    s = apply(s, []);
    // The plain card's arrow has group styles and no group in its own design: warned, and never shown.
    expect(warnings(s, 'STYLE_GROUP_MISSING').map((d) => d.nodeId)).toEqual(['arrow']);
    for (const p of placements) s = apply(s, [{ type: 'component.detachInstance', owner: owner(s), nodeId: p.id }]);
    const arrows = Object.values(home(s).nodes).filter((n) => n.detachedFrom?.node === 'arrow');
    expect(arrows).toHaveLength(2);
    // The working card's arrow keeps its group states; the plain one's, which no group showed, are left behind, so
    // the page's group around both does not start showing them.
    const [kept, left] = [...arrows].sort((a) => (a.styles?.['base:groupHover'] ? -1 : 1));
    expect(kept.styles).toEqual({ 'base:groupHover': { translateX: '4px' }, 'base:groupFocus': { color: '#0000ff' } });
    expect(left.styles?.['base:groupHover']).toBeUndefined();
    expect(left.styles?.['base:groupFocus']).toBeUndefined();
    // The detached card is still a group; with the page's own, two.
    expect(Object.values(home(s).nodes).filter((n) => (n as ElementNode).interactionGroup).length).toBe(2);
    // Only the plain design itself still holds styles no group shows; nothing on the page does.
    expect(warnings(s, 'STYLE_GROUP_MISSING').map((d) => d.owner)).toEqual([{ kind: 'component', id: dormant.id }]);
  });

  it('folds a shift on one axis with a stronger shift on the other, which never override each other', () => {
    const layers = [
      { styles: { 'base:groupHover': { translateX: '4px' } } as ResponsiveStyles, strength: 1 },
      { styles: { base: { translateY: '8px' } } as ResponsiveStyles, strength: 3 }
    ];
    expect(flattenStates(layers)).toEqual({ 'base:groupHover': { translateX: '4px' } });
    expect(flattenStates([{ styles: { 'base:groupFocus': { translateY: '-2px' } } as ResponsiveStyles, strength: 1 }, { styles: { base: { translateX: '6px' } } as ResponsiveStyles, strength: 3 }])).toEqual({
      'base:groupFocus': { translateY: '-2px' }
    });
    // Custom CSS that writes translate itself still conflicts.
    expect(flattenStates([layers[0], { styles: { base: { customCss: 'translate: 0 8px' } } as ResponsiveStyles, strength: 3 }])).toBeNull();
  });
});

describe('detaching around nested placements and slots', () => {
  /** A host design whose root holds a placement of `inner` and then its slot; a group around both when `grouped`. */
  function host(s: ProjectState, inner: ComponentDefinition, grouped: boolean, componentId = 'project.host') {
    const def = {
      ...FOUNDATION.managed({
        componentId,
        name: 'Host',
        category: 'content',
        tags: [],
        icon: 'sparkles',
        description: '',
        properties: {},
        parts: { root: { nodeId: 'root', label: 'Host' } },
        slots: { content: { label: 'Content' } },
        build: (b) => b.el('root', 'div', { name: 'Host', ...(grouped ? { interactionGroup: true as const } : {}) }, [b.slot('content-slot', 'content')])
      }),
      owner: 'project' as const
    } as ComponentDefinition;
    const nestedInst = makeInstance(inner, {}) as InstanceNode;
    def.tree!.nodes[nestedInst.id] = nestedInst;
    (def.tree!.nodes.root as ElementNode).children.unshift(nestedInst.id);
    s.components[def.id] = def;
    return { def, nestedInst };
  }
  const placeIn = (s: ProjectState, def: ComponentDefinition, wrapped: boolean) => {
    const p = makeInstance(def, {}) as InstanceNode;
    home(s).nodes[p.id] = p;
    if (wrapped) {
      home(s).nodes.n_page_card = el('n_page_card', [p.id], { interactionGroup: true });
      home(s).rootIds.push('n_page_card');
    } else home(s).rootIds.push(p.id);
    return p;
  };
  const detach = (s: ProjectState, nodeId: string) => apply(s, [{ type: 'component.detachInstance', owner: owner(s), nodeId }]);

  it('keeps a design’s working group style on a placement inside it, over a dormant one of the placed design', () => {
    const s = fresh();
    // The placed card's own root has a group hover its design never shows (a root has no group of its own design).
    const inner = cardDef(s, false);
    inner.tree!.nodes.root.styles = { 'base:groupHover': { color: '#ff0000' } };
    // The host, sorted before it so the card's block is the later one, colours that placement blue on its group's
    // hover: the card's dormant red, though later, is never written, and must not win the fold either.
    const { def, nestedInst } = host(s, inner, true, 'project.a-host');
    expect(inner.id.localeCompare(def.id)).toBeGreaterThan(0);
    nestedInst.styles = { 'base:groupHover': { color: '#0000ff' } };
    const p = placeIn(s, def, false);
    const t = detach(apply(s, []), p.id);
    const detached = Object.values(home(t).nodes).find((n) => n.kind === 'instance' && n.definitionId === inner.id) as InstanceNode;
    expect(detached.overrides?.root?.['base:groupHover']).toEqual({ color: '#0000ff' });
  });

  it('leaves dormant group styles of a nested placement and of slot content unshown under the groups they move into', () => {
    let s = fresh();
    const inner = cardDef(s, false);
    // The host has no group around the nested card; the card's design has none either, so its arrow's override is dormant.
    const { def, nestedInst } = host(s, inner, false);
    nestedInst.overrides = { arrow: { 'base:groupHover': { scale: 1.2 } } };
    const p = placeIn(s, def, true);
    s = apply(s, []);
    let t = detach(s, p.id);
    const nested = Object.values(home(t).nodes).find((n) => n.kind === 'instance' && n.definitionId === inner.id) as InstanceNode;
    expect(nested.overrides?.arrow?.['base:groupHover']).toBeUndefined();
    // Slot content of a grouped host, placed where no page group reaches it: its group hover never showed.
    s = fresh();
    const plain = cardDef(s, false);
    const grouped = host(s, plain, true).def;
    const q = placeIn(s, grouped, false);
    home(s).nodes.n_slotted = { id: 'n_slotted', kind: 'icon', icon: 'star', styles: { base: { opacity: 0.5 }, 'base:groupHover': { opacity: 1 } } } as IconNode;
    q.slots = { content: ['n_slotted'] };
    t = detach(apply(s, []), q.id);
    expect(home(t).nodes.n_slotted.styles).toEqual({ base: { opacity: 0.5 } });
    expect(enclosingGroup(home(t), 'n_slotted')).not.toBeNull();
  });
});

describe('a code component’s own markup', () => {
  const code = (source: string) => ({ id: 'cd_x', kind: 'code', source, parts: {} }) as unknown as ComponentDefinition;
  it('counts a group it renders, not one its stylesheet or a comment names', () => {
    expect(partInInteractionGroup(code('<div class="card so-group"><span class={so_o?.arrow}></span></div>'), 'arrow', false)).toBe(true);
    expect(partInInteractionGroup(code('<div class="card"></div><style>:global(.so-group:hover) .card { color: red }</style>'), 'arrow', false)).toBe(false);
    expect(partInInteractionGroup(code('<!-- so-group --><div class="card"></div>'), 'arrow', false)).toBe(false);
    // A comment that mentions a stylesheet's tag hides nothing after it.
    expect(partInInteractionGroup(code('<!-- The <style> block comes below. --><div class="so-group"><b class={so_o?.arrow}></b></div><style>.x { color: red }</style>'), 'arrow', false)).toBe(true);
    // Its root is reached only by a group around the placement, as a design's root is.
    expect(partInInteractionGroup(code('<div class="so-group"></div>'), 'root', false)).toBe(false);
    expect(partInInteractionGroup(code('<div class="so-group"></div>'), 'root', true)).toBe(true);
  });
});

/** A card component: its root (a group when `grouped`) holds a title and an arrow, both parts. */
function cardDef(s: ProjectState, grouped = true): ComponentDefinition {
  const def = {
    ...FOUNDATION.managed({
      componentId: 'project.card',
      name: 'Card',
      category: 'content',
      tags: [],
      icon: 'sparkles',
      description: '',
      properties: {},
      parts: { root: { nodeId: 'root', label: 'Card' }, arrow: { nodeId: 'arrow', label: 'Arrow' } },
      build: (b) =>
        b.el('root', 'article', { name: 'Card', ...(grouped ? { interactionGroup: true as const } : {}) }, [
          b.text('title', 'h3', 'Card'),
          b.el('arrow', 'span', { name: 'Arrow', styles: { 'base:groupHover': { translateX: '4px' }, 'base:groupFocus': { color: '#0000ff' } } }, [])
        ])
    }),
    owner: 'project' as const
  } as ComponentDefinition;
  s.components[def.id] = def;
  return def;
}

const HOVER_ON = '.so-group:is(:hover, .so-action:hover > *)';
const HOVER_OFF = '.so-group:not(:hover, .so-action:hover > *)';
const FOCUS_ON = '.so-group:is(:focus-within, .so-action:focus-within > *)';
const FOCUS_OFF = '.so-group:not(:focus-within, .so-action:focus-within > *)';

describe('the stylesheet', () => {
  it('writes a group hover behind a hover-capable pointer, and group focus for keyboard focus inside', () => {
    let s = group(cards(), 'n_card');
    s = style(s, 'n_arrow', 'base', 'groupHover', 'opacity', 1);
    s = style(s, 'n_arrow', 'phone', 'groupHover', 'opacity', 0.75);
    s = style(s, 'n_arrow', 'base', 'groupFocus', 'color', '#0000ff');
    const css = generateSiteCss(s);
    const sel = (on: string, off: string) => `:where(${on}) .so-n-n_arrow:not(:where(${on} ${off} *))`;
    expect(groupStateSelector('.so-n-n_arrow', 'groupHover')).toBe(sel(HOVER_ON, HOVER_OFF));
    expect(css).toContain(`@media (hover: hover) {\n\t${sel(HOVER_ON, HOVER_OFF)} {\n\t\topacity: 1;\n\t}\n}`);
    expect(css).toContain(`@media (max-width: 767.98px) and (hover: hover) {\n\t${sel(HOVER_ON, HOVER_OFF)} {\n\t\topacity: 0.75;\n\t}\n}`);
    // Focus has no pointer guard: a keyboard reaches it on every device.
    expect(css).toContain(`\n${sel(FOCUS_ON, FOCUS_OFF)} {\n\tcolor: #0000ff;\n}`);
  });

  it('writes the element’s own states after its group’s, so its own wins while both hold', () => {
    let s = group(cards(), 'n_card');
    s = style(s, 'n_arrow', 'base', 'hover', 'color', '#ff0000');
    s = style(s, 'n_arrow', 'base', 'groupHover', 'color', '#00ff00');
    s = style(s, 'n_arrow', 'base', 'groupFocus', 'color', '#0000ff');
    const css = generateSiteCss(s);
    const groupHover = css.indexOf('color: #00ff00');
    const groupFocus = css.indexOf('color: #0000ff');
    const own = css.indexOf('color: #ff0000');
    expect(groupHover).toBeGreaterThan(-1);
    expect(groupHover).toBeLessThan(groupFocus);
    expect(groupFocus).toBeLessThan(own);
  });

  it('writes nothing for group styles no group can show', () => {
    const s = style(cards(), 'n_loose', 'base', 'groupHover', 'opacity', 0.5);
    expect(generateSiteCss(s)).not.toContain('so-group');
  });

  it('keeps a one-axis group shift off the inherited other axis', () => {
    let s = group(cards(), 'n_card');
    s = style(s, 'n_arrow', 'base', 'groupHover', 'translateX', '4px');
    const css = generateSiteCss(s);
    expect(css).toContain(':where(.so-n-n_arrow) {\n\t--_so-translate-x: 0px;\n\t--_so-translate-y: 0px;\n}');
    expect(css).toContain('--_so-translate-x: 4px;');
  });

  it('marks the group in the markup, so its rules can find it', () => {
    const s = group(cards(), 'n_card');
    const page = generateProject(s).get(pageFile(home(s)))!;
    expect(page).toMatch(/class=\{\["so-n-n_card", "so-group"\]\}/);
    expect(page).not.toMatch(/"so-n-n_inner", "so-group"/);
  });

  it('writes a design’s group states on its nodes, and a placement’s on its part', () => {
    const s = fresh();
    const def = cardDef(s);
    const css = generateComponentsCss(s);
    const arrow = `.${nodeClass(def, 'arrow')}`;
    expect(css).toContain(`@media (hover: hover) {\n\t:where(${HOVER_ON}) ${arrow}:not(:where(${HOVER_ON} ${HOVER_OFF} *)) {\n\t\t--_so-translate-x: 4px;`);
    expect(css).toContain(`:where(${FOCUS_ON}) ${arrow}:not(:where(${FOCUS_ON} ${FOCUS_OFF} *)) {\n\tcolor: #0000ff;`);
    // A placement restyles the arrow on hover of its card; its root is in no group, so a group state there is dormant.
    const placed = makeInstance(def, {}) as InstanceNode;
    home(s).nodes[placed.id] = placed;
    home(s).rootIds.push(placed.id);
    let t = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: placed.id, partId: 'arrow', scope: 'base', state: 'groupHover', property: 'scale', value: 1.1 },
      { type: 'node.setStyle', owner: owner(s), nodeId: placed.id, partId: 'root', scope: 'base', state: 'groupHover', property: 'opacity', value: 0.9 }
    ]);
    const cls = overrideClass(placed.id, 'arrow');
    const site = generateSiteCss(t);
    expect(site).toContain(`:where(${HOVER_ON}) .${cls}.${cls}:not(:where(${HOVER_ON} ${HOVER_OFF} *)) {\n\t\tscale: 1.1;`);
    expect(site).not.toContain('opacity: 0.9');
    expect(warnings(t, 'STYLE_GROUP_MISSING')).toMatchObject([{ nodeId: placed.id, site: `${placed.id}|part:root|group` }]);
    // Inside a page card, the placement's root can follow it.
    const wrap = el('n_wrap', [placed.id], { interactionGroup: true });
    home(t).nodes[wrap.id] = wrap;
    home(t).rootIds = home(t).rootIds.filter((id) => id !== placed.id).concat(wrap.id);
    t = apply(t, []);
    expect(generateSiteCss(t)).toContain('opacity: 0.9');
    expect(warnings(t, 'STYLE_GROUP_MISSING')).toEqual([]);
  });

  it('matches a subject reached through another whole', () => {
    expect(groupStateSelector('.a.a .b', 'groupFocus')).toBe(`:where(${FOCUS_ON}) :is(.a.a .b):not(:where(${FOCUS_ON} ${FOCUS_OFF} *))`);
    expect(groupStateSelector(':is(.a, .b).c', 'groupHover')).toBe(`:where(${HOVER_ON}) :is(.a, .b).c:not(:where(${HOVER_ON} ${HOVER_OFF} *))`);
  });
});

describe('a button inside a group', () => {
  it('keeps its own link variables in group states', () => {
    let s = group(cards(), 'n_card');
    home(s).nodes.n_btn = { id: 'n_btn', kind: 'link', link: { type: 'url', target: 'https://example.com/' }, label: 'More', appearance: 'primary' } as LinkNode;
    (home(s).nodes.n_card as ElementNode).children.push('n_btn');
    s = style(s, 'n_btn', 'base', 'groupHover', 'background', '#123456');
    expect(generateSiteCss(s)).toMatch(/so-n-n_btn:not\([^{]+\) \{\n\t\t--so-btn-bg: #123456;\n\t\t--so-btn-bg-hover: #123456;\n\t\tbackground: var\(--so-btn-bg\);/);
  });
});

describe('the assistant', () => {
  it('can mark a selected container as a group, as one of its fields', async () => {
    const { nodeFields } = await import('@agent/selection');
    expect(nodeFields(el('n_box')).interactionGroup).toMatchObject({ type: 'boolean', default: false });
    expect(nodeFields({ id: 'n_t', kind: 'text', tag: 'p', text: 'x' } as TextNode)).not.toHaveProperty('interactionGroup');
  });

  /** The states, and whether the description names the group ones, that style_selected_element offers a selection. */
  async function offered(s: ProjectState, nodeId: string, partId?: string) {
    const { selectionTools } = await import('@agent/selection');
    const tools = selectionTools(s, { owner: owner(s), instancePath: partId ? [nodeId] : [], nodeId, ...(partId ? { partId } : {}) } as Parameters<typeof selectionTools>[1]);
    const tool = tools?.find((t) => t.name === 'style_selected_element');
    const state = (tool?.parameters as { properties: { state: { enum: string[]; description: string } } }).properties.state;
    return { states: state.enum, named: tool!.description.includes('groupHover') || state.description.includes('groupHover') };
  }
  const OWN = ['hover', 'focus', 'active'];
  const ALL = ['groupHover', 'groupFocus', 'hover', 'focus', 'active'];

  it('offers the group states only to a selection a group can reach', async () => {
    let s = cards();
    // No group anywhere: a small model is offered exactly the element's own states, and never reads of groups.
    expect(await offered(s, 'n_title')).toEqual({ states: OWN, named: false });
    s = group(s, 'n_card');
    // Inside a group in its document.
    expect(await offered(s, 'n_title')).toEqual({ states: ALL, named: true });
    expect(await offered(s, 'n_inner_arrow')).toEqual({ states: ALL, named: true });
    // Outside every group.
    expect(await offered(s, 'n_loose')).toEqual({ states: OWN, named: false });
  });

  it('offers them to a placement whose design holds a group, or that sits inside one', async () => {
    const s = fresh();
    // A managed hero of the project's own (Foundation's sections are code), placed first on Home.
    const def = projectDesign(s, {
      componentId: 'project.hero',
      name: 'Hero',
      properties: { heading: P.str('Heading', 'Welcome') },
      parts: { root: { nodeId: 'root', label: 'Hero' }, heading: { nodeId: 'heading', label: 'Heading' } },
      build: (b) => b.el('root', 'section', { name: 'Hero' }, [b.text('heading', 'h1', { $prop: 'heading' }, { name: 'Heading' })])
    });
    const hero = makeInstance(def, {}) as InstanceNode;
    const heroId = hero.id;
    home(s).nodes[heroId] = hero;
    home(s).rootIds.unshift(heroId);
    expect(await offered(s, heroId)).toEqual({ states: OWN, named: false });
    // A placement of the same design inside a page group: what it shows follows that group.
    const placed = makeInstance(def, {}) as InstanceNode;
    home(s).nodes[placed.id] = placed;
    home(s).nodes.n_box = el('n_box', [placed.id], { interactionGroup: true });
    home(s).rootIds.push('n_box');
    expect(await offered(s, placed.id)).toEqual({ states: ALL, named: true });
    expect(await offered(s, heroId)).toEqual({ states: OWN, named: false });
    // The design itself holding a group: its parts inside follow it, wherever it is placed.
    (def.tree!.nodes[def.tree!.rootIds[0]] as ElementNode).interactionGroup = true;
    expect(await offered(s, heroId)).toEqual({ states: ALL, named: true });
    expect(await offered(s, heroId, 'heading')).toEqual({ states: ALL, named: true });
  });
});
