/**
 * Interaction groups (#349): a container marked as a group (a card) shows the `groupHover` and `groupFocus` styles of
 * the elements inside it while it is hovered or holds focus. Set and cleared by the operations, checked like any
 * style, and written as selectors that follow the nearest group around an element, never an outer one.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import type { ComponentDefinition, ElementNode, IconNode, InstanceNode, LinkNode, ProjectState, TextNode } from '@shared/types';
import { STYLE_STATES, parseStyleScopeKey } from '@shared/types';
import { STATE_STYLE_PROPS, isStateStyleProp, stateStyleError } from '@shared/styles';
import { enclosingGroup, partInInteractionGroup } from '@shared/interaction-groups';
import { MIGRATIONS } from '@shared/migrations';
import { createStarterState } from '@catalogue/starters';
import { FOUNDATION } from '@catalogue/foundation/pack';
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
    s = style(s, 'n_arrow', 'phone', 'groupHover', 'opacity', null);
    expect(node(s, 'n_arrow').styles).not.toHaveProperty('phone:groupHover');
    s = apply(s, [{ type: 'node.resetStyles', owner: owner(s), nodeId: 'n_arrow', state: 'groupHover' }]);
    expect(node(s, 'n_arrow').styles).toEqual({ 'base:groupFocus': { color: '#0000ff' }, 'base:hover': { color: '#ff0000' } });
    // The element's own hover still refuses a shift; a group state refuses layout.
    rejects(() => style(s, 'n_arrow', 'base', 'hover', 'translateX', '4px'), /cannot change on hover/);
    rejects(() => style(s, 'n_arrow', 'base', 'groupHover', 'paddingBlock', '4px'), /cannot change while its group is hovered/);
  });

  it('refuses to ungroup a group, whose children would lose it', () => {
    const s = group(cards(), 'n_inner');
    rejects(() => apply(s, [{ type: 'node.unwrap', owner: owner(s), nodeIds: ['n_inner'] }]), /interaction group/);
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
    const placed = makeInstance(def, {});
    expect(partInInteractionGroup(def, 'arrow', false)).toBe(false);
    expect(partInInteractionGroup(def, 'arrow', true)).toBe(true);
    (def.tree!.nodes.root as ElementNode).interactionGroup = true;
    expect(partInInteractionGroup(def, 'arrow', false)).toBe(true);
    // The design's root is no group of its own: only one around the placement reaches it.
    expect(partInInteractionGroup(def, 'root', false)).toBe(false);
    expect(placed.definitionId).toBe(def.id);
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

describe('the document format', () => {
  it('marks interaction groups with a version-only step', () => {
    expect(MIGRATIONS.at(-1)?.id).toBe('interaction-groups');
  });
});

describe('the assistant', () => {
  it('can mark a selected container as a group, as one of its fields', async () => {
    const { nodeFields } = await import('@agent/selection');
    expect(nodeFields(el('n_box')).interactionGroup).toMatchObject({ type: 'boolean', default: false });
    expect(nodeFields({ id: 'n_t', kind: 'text', tag: 'p', text: 'x' } as TextNode)).not.toHaveProperty('interactionGroup');
  });
});
