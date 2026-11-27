/**
 * Styling one repeated item (one card of a grid, one plan, one testimonial) without restyling its siblings (#81):
 * the operation, its lifetime alongside the item, and what the export makes of it.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import type { InstanceNode, ListItem, ProjectState } from '@shared/types';
import { itemOverrideClass, repeatedPartList } from '@shared/item-styles';
import type { ComponentDefinition } from '@shared/types';
import { contractConflicts } from '@engine/theme-updates';
import { SELECTION_ARGS } from '@agent/selection';
import { describeSelection } from '@agent/context';
import { descOf, selectionFromChain } from '../../src/renderer/src/lib/model';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { validateState } from '@engine/validate';
import { defFile, generateProject, overrideClass } from '@generator/index';
import { makeInstance } from '@engine/install';
import { P, item, prop, tok } from '@catalogue/dsl';
import { projectDesign } from './fixtures/packs';

/**
 * A services grid built in the editor, the slice of the one Foundation used to ship as a tree: a heading, and a card
 * per item (a stack, with an icon, a title and a description) in a grid. Foundation's grid is code now, whose item
 * classes are its own code's to place (see the test of it below); the export of a design's item styles is the
 * generator's, so most of these tests style this one.
 */
const servicesGrid = (s: ProjectState) =>
  projectDesign(s, {
    componentId: 'test.services',
    name: 'Services grid',
    properties: {
      heading: P.str('Heading', 'Services shaped around your project'),
      items: P.list(
        'Cards',
        'Card',
        { icon: P.icon('Icon', 'sparkles'), title: P.str('Title', 'Service'), description: P.text('Description', 'Describe what this service includes.') },
        [
          { icon: 'compass', title: 'Planning', description: 'Clear priorities and a realistic budget.' },
          { icon: 'pen-tool', title: 'Design', description: 'Drawings your builder can price.' },
          { icon: 'hammer', title: 'Build', description: 'We stay on site until it is done.' }
        ],
        { titleField: 'title' }
      )
    },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['textStyle', 'color'] },
      grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['columns', 'gap'] },
      card: { nodeId: 'card', label: 'Card', styleControls: ['background', 'border', 'radius', 'shadow', 'paddingBlock', 'paddingInline'] },
      cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: ['textStyle', 'color'] }
    },
    build: (b) =>
      b.el('root', 'section', { name: 'Section', styles: { paddingBlock: tok('space.section') } }, [
        b.text('heading', 'h2', prop('heading'), { name: 'Heading' }),
        b.el('grid', 'ul', { name: 'Card grid', styles: { layout: 'grid', columns: 1, gap: tok('space.lg') } }, [
          b.repeat('cards', 'items', [
            b.el('card', 'li', { name: 'Card', styles: { layout: 'stack', gap: tok('space.md'), paddingBlock: tok('space.xl'), background: tok('color.surface') } }, [
              b.icon('card-icon', item('icon'), { name: 'Icon' }),
              b.text('card-title', 'h3', item('title'), { name: 'Title' }),
              b.text('card-text', 'p', item('description'), { name: 'Description' })
            ])
          ])
        ])
      ])
  });

/** The business starter, with Home's services grid built in the editor in place of Foundation's. */
const fresh = () => {
  const s = createStarterState('business', 'Test Studio', false);
  const p = home(s);
  const at = p.rootIds.findIndex((id) => s.components[(p.nodes[id] as InstanceNode).definitionId]?.componentId === 'features.grid');
  const placed = makeInstance(servicesGrid(s));
  delete p.nodes[p.rootIds[at]];
  p.nodes[placed.id] = placed;
  p.rootIds[at] = placed.id;
  return s;
};
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const placedOf = (s: ProjectState, componentId: string) => {
  const p = home(s);
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
};
const grid = (s: ProjectState) => placedOf(s, 'test.services');
const cards = (s: ProjectState) => grid(s).props.items as ListItem[];
const otherPage = (s: ProjectState) => s.site.pageOrder.find((id) => id !== s.site.homePageId)!;
const siteCss = (s: ProjectState) => generateProject(s).get('src/lib/siteorigin/styles/site.css')!;

/** Applies operations the way the session does: each one parsed by its schema first, then applied as one batch. */
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

/** The issue's grid: shared yellow fill, green border and 48px padding on every card. */
function styledGrid(): ProjectState {
  const s = fresh();
  const at = { owner: owner(s), nodeId: grid(s).id, partId: 'card', scope: 'base' };
  return apply(s, [
    { type: 'node.setStyle', ...at, property: 'background', value: '#fff5cc' },
    { type: 'node.setStyle', ...at, property: 'border', value: '2px solid #1f5f3a' },
    { type: 'node.setStyle', ...at, property: 'paddingBlock', value: '48px' }
  ]);
}

const blue = (s: ProjectState, itemId: string) => apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: grid(s).id, partId: 'card', itemId, scope: 'base', property: 'background', value: '#dbeeff' }]);

describe('styling one repeated item', () => {
  it('styles one card without restyling its siblings or their content (#81)', () => {
    let s = styledGrid();
    const before = structuredClone(cards(s));
    const poetry = before[1].id;
    s = blue(s, poetry);
    const g = grid(s);
    // The shared card style is untouched; the item keeps only its own difference.
    expect(g.overrides?.card?.base).toMatchObject({ background: '#fff5cc', border: '2px solid #1f5f3a', paddingBlock: '48px' });
    expect(g.itemOverrides).toEqual({ card: { list: 'items', items: { [poetry]: { base: { background: '#dbeeff' } } } } });
    expect(cards(s)).toEqual(before);
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);

    const files = generateProject(s);
    const cls = itemOverrideClass(g.id, 'card', poetry);
    const css = files.get('src/lib/siteorigin/styles/site.css')!;
    // One class more than the shared override, so the item's fill wins over the shared one at every size.
    expect(css).toContain(`.${cls}.${cls}.${cls} {\n\tbackground: #dbeeff;\n}`);
    expect(css).toContain(`.${overrideClass(g.id, 'card')}.${overrideClass(g.id, 'card')} {`);
    // Only that item is handed the class; the grid's card takes it by the item's ID.
    expect(files.get('src/routes/+page.svelte')).toContain(`so_oi={${JSON.stringify({ [poetry]: { card: cls } })}}`);
    const comp = files.get(defFile(s.components[g.definitionId]))!;
    expect(comp).toContain('so_oi?.[item.id]?.["card"]');
    expect(comp).toContain('so_oi = undefined,');
    // The editor's instrumented copy renders the same classes, and its page hands over the same map.
    const dev = generateProject(s, { instrument: true });
    expect(dev.get(defFile(s.components[g.definitionId]))).toContain('so_oi?.[item.id]?.["card"]');
    expect(dev.get('src/routes/+page.svelte')).toContain(`so_oi={${JSON.stringify({ [poetry]: { card: cls } })}}`);
  });

  it('keeps the item style on the same card after reordering', () => {
    let s = styledGrid();
    const poetry = cards(s)[1].id;
    s = blue(s, poetry);
    const css = siteCss(s);
    s = apply(s, [{ type: 'instance.listMove', owner: owner(s), nodeId: grid(s).id, prop: 'items', itemId: poetry, index: 0 }]);
    expect(cards(s)[0].id).toBe(poetry);
    expect(grid(s).itemOverrides?.card.items[poetry]?.base?.background).toBe('#dbeeff');
    expect(siteCss(s)).toBe(css);
  });

  it('resets the item to the shared style, which then follows later shared changes', () => {
    let s = styledGrid();
    const poetry = cards(s)[1].id;
    s = blue(s, poetry);
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: grid(s).id, partId: 'card', itemId: poetry, scope: 'phone', property: 'radius', value: '0px' }]);
    // A range reset leaves the item's other ranges.
    s = apply(s, [{ type: 'node.resetStyles', owner: owner(s), nodeId: grid(s).id, partId: 'card', itemId: poetry, scope: 'phone' }]);
    expect(grid(s).itemOverrides?.card.items[poetry]).toEqual({ base: { background: '#dbeeff' } });
    // Resetting the shared part style keeps the item's own.
    const kept = apply(s, [{ type: 'node.resetStyles', owner: owner(s), nodeId: grid(s).id, partId: 'card' }]);
    expect(grid(kept).overrides).toBeUndefined();
    expect(grid(kept).itemOverrides?.card.items[poetry]).toBeDefined();
    s = apply(s, [{ type: 'node.resetStyles', owner: owner(s), nodeId: grid(s).id, partId: 'card', itemId: poetry }]);
    expect(grid(s).itemOverrides).toBeUndefined();
    expect(grid(s).overrides?.card?.base?.background).toBe('#fff5cc');
    expect(siteCss(s)).not.toContain('so-oi-');
    // Resetting every part of the placement takes item styles with it.
    s = blue(s, poetry);
    s = apply(s, [{ type: 'node.resetStyles', owner: owner(s), nodeId: grid(s).id }]);
    expect(grid(s).itemOverrides).toBeUndefined();
  });

  it('removing a property value with null leaves the item on the shared value', () => {
    let s = styledGrid();
    const first = cards(s)[0].id;
    s = blue(s, first);
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: grid(s).id, partId: 'card', itemId: first, scope: 'base', property: 'radius', value: '0px' }]);
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: grid(s).id, partId: 'card', itemId: first, scope: 'base', property: 'background', value: null }]);
    expect(grid(s).itemOverrides?.card.items[first]).toEqual({ base: { radius: '0px' } });
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: grid(s).id, partId: 'card', itemId: first, scope: 'base', property: 'radius', value: null }]);
    expect(grid(s).itemOverrides).toBeUndefined();
  });

  it('drops an item style with its item, in time for later operations in the same batch', () => {
    let s = styledGrid();
    s = applyOperations(s, [{ type: 'token.create', group: 'color', label: 'Pale blue', value: '#dbeeff' }]).state;
    const token = s.tokens.custom[s.tokens.custom.length - 1].id;
    const poetry = cards(s)[1].id;
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: grid(s).id, partId: 'card', itemId: poetry, scope: 'base', property: 'background', value: { token } }]);
    // The item's style is the token's only use: once the item is gone, the token can go in the same batch.
    expect(() => applyOperations(s, [{ type: 'token.remove', tokenId: token }])).toThrow(/used/);
    s = apply(s, [
      { type: 'instance.listRemove', owner: owner(s), nodeId: grid(s).id, prop: 'items', itemId: poetry },
      { type: 'token.remove', tokenId: token }
    ]);
    expect(grid(s).itemOverrides).toBeUndefined();
    expect(s.tokens.custom.some((t) => t.id === token)).toBe(false);
  });

  it('drops item styles when the whole list is replaced without the item, and keeps them for kept items', () => {
    let s = styledGrid();
    const [a, b, c] = cards(s);
    for (const it of [a, b, c]) s = blue(s, it.id);
    s = apply(s, [{ type: 'instance.setProp', owner: owner(s), nodeId: grid(s).id, prop: 'items', value: [{ ...b }, { title: 'New card' }] }]);
    expect(Object.keys(grid(s).itemOverrides!.card.items)).toEqual([b.id]);
  });

  it('refuses targets that are not one repeated item', () => {
    const s = styledGrid();
    const g = grid(s);
    const item = cards(s)[0].id;
    const base = { type: 'node.setStyle', owner: owner(s), nodeId: g.id, scope: 'base', property: 'background', value: '#dbeeff' };
    rejects(() => apply(s, [{ ...base, itemId: item }]), /needs a "partId"/);
    rejects(() => apply(s, [{ ...base, partId: 'heading', itemId: item }]), /not shown once per list item/);
    rejects(() => apply(s, [{ ...base, partId: 'card', itemId: 'i_missing' }]), /has no item "i_missing"/);
    rejects(() => apply(s, [{ ...base, partId: 'nope', itemId: item }]), /has no part "nope"/);
    rejects(() => apply(s, [{ type: 'node.resetStyles', owner: owner(s), nodeId: g.id, partId: 'heading', itemId: item }]), /not shown once per list item/);
    // Inside a design, where the grid is placed for every placement of that design to share.
    const made = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: g.id, name: 'Services band' }]);
    const band = made.state.components[made.results[0].definitionId as string];
    const placedGrid = band.tree!.nodes[band.tree!.rootIds[0]];
    expect(placedGrid).toMatchObject({ kind: 'instance', definitionId: g.definitionId });
    rejects(() => apply(made.state, [{ ...base, owner: { kind: 'component', id: band.id }, nodeId: placedGrid.id, partId: 'card', itemId: item }]), /placement on a page/);
  });

  it('moves item styles to the new item IDs of a copy, and keeps the original', () => {
    let s = styledGrid();
    const poetry = cards(s)[1].id;
    s = blue(s, poetry);
    const to = otherPage(s);
    const r = applyOperations(s, [{ type: 'node.copy', owner: owner(s), nodeId: grid(s).id, toOwner: { kind: 'page', id: to }, parentId: null, index: 0 }]);
    const copy = r.state.pages[to].nodes[r.results[0].nodeId as string] as InstanceNode;
    const copied = (copy.props.items as ListItem[])[1].id;
    expect(copied).not.toBe(poetry);
    expect(copy.itemOverrides).toEqual({ card: { list: 'items', items: { [copied]: { base: { background: '#dbeeff' } } } } });
    expect(grid(r.state).itemOverrides?.card.items[poetry]).toBeDefined();
    const dup = applyOperations(s, [{ type: 'node.duplicate', owner: owner(s), nodeId: grid(s).id }]);
    const twin = home(dup.state).nodes[dup.results[0].nodeId as string] as InstanceNode;
    expect(Object.keys(twin.itemOverrides!.card.items)).toEqual([(twin.props.items as ListItem[])[1].id]);
    // A placement showing the definition's default items keeps their IDs in a copy, and so keeps their styles.
    const inherited = structuredClone(s);
    const g = grid(inherited);
    delete g.props.items;
    const defaultId = (inherited.components[g.definitionId].properties.items as { default: ListItem[] }).default[0].id;
    g.itemOverrides = { card: { list: 'items', items: { [defaultId]: { base: { background: '#dbeeff' } } } } };
    const copied2 = applyOperations(inherited, [{ type: 'node.duplicate', owner: owner(inherited), nodeId: g.id }]);
    expect((home(copied2.state).nodes[copied2.results[0].nodeId as string] as InstanceNode).itemOverrides?.card.items[defaultId]).toBeDefined();
  });

  it('refuses to move item styles into a component, where every placement shares its items', () => {
    let s = styledGrid();
    s = blue(s, cards(s)[1].id);
    rejects(() => applyOperations(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId: grid(s).id }]), /styled on its own/);
    rejects(() => applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: grid(s).id, name: 'Event cards' }]), /styled on its own/);
  });

  it('keeps item styles through make unique, and stops applying them when the part no longer repeats over their list', () => {
    let s = styledGrid();
    const poetry = cards(s)[1].id;
    s = blue(s, poetry);
    const id = grid(s).id;
    s = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: id }]).state;
    const g = home(s).nodes[id] as InstanceNode;
    expect(s.components[g.definitionId].owner).toBe('project');
    expect(g.itemOverrides?.card.items[poetry]).toBeDefined();
    const cls = itemOverrideClass(g.id, 'card', poetry);
    expect(siteCss(s)).toContain(cls);
    // Hand-edited so the styles name another list: they style nothing, and generation leaves them out.
    g.itemOverrides!.card.list = 'other';
    expect(siteCss(s)).not.toContain(cls);
    expect(generateProject(s).get('src/routes/+page.svelte')).not.toContain('so_oi=');
  });

  it('styles one card of Foundation’s services grid, whose code places the class the page hands that card (#81)', () => {
    let s = createStarterState('business', 'Test Studio', false);
    const g = placedOf(s, 'features.grid');
    const def = s.components[g.definitionId];
    expect(def.kind).toBe('code');
    const poetry = (g.props.items as ListItem[])[1].id;
    s = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', scope: 'base', property: 'background', value: '#fff5cc' },
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', itemId: poetry, scope: 'base', property: 'background', value: '#dbeeff' }
    ]);
    expect(placedOf(s, 'features.grid').itemOverrides).toEqual({ card: { list: 'items', items: { [poetry]: { base: { background: '#dbeeff' } } } } });
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateProject(s);
    const cls = itemOverrideClass(g.id, 'card', poetry);
    const css = files.get('src/lib/siteorigin/styles/site.css')!;
    // The item's rule outranks the shared one, which itself outranks the code's own scoped styles.
    const shared = `.${overrideClass(g.id, 'card')}`.repeat(3);
    expect(css).toContain(`${shared} {\n\tbackground: #fff5cc !important;\n}`);
    expect(css).toContain(`${`.${cls}`.repeat(4)} {\n\tbackground: #dbeeff !important;\n}`);
    expect(files.get('src/routes/+page.svelte')).toContain(`so_oi={${JSON.stringify({ [poetry]: { card: cls } })}}`);
    // The theme's code gives each card the class the page hands it by the card's ID.
    expect(files.get(defFile(def))).toContain('so_oi?.[item.id]?.card');
  });

  it('styles a featured plan and a highlighted testimonial the same way', () => {
    let s = fresh();
    for (const componentId of ['pricing.plans', 'testimonials.grid'])
      s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, componentId }]).state;
    const plan = placedOf(s, 'pricing.plans');
    const featured = (plan.props.plans as ListItem[])[1].id;
    const quotes = placedOf(s, 'testimonials.grid');
    const highlighted = (quotes.props.items as ListItem[])[0].id;
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: plan.id, partId: 'plan', itemId: featured, scope: 'base', property: 'border', value: { token: 'border.strong' } }]);
    let files = generateProject(s);
    const planCls = itemOverrideClass(plan.id, 'plan', featured);
    expect(files.get('src/lib/siteorigin/styles/site.css')).toContain(`${`.${planCls}`.repeat(4)} {\n\tborder: var(--so-border-strong) !important;\n}`);
    expect(files.get('src/routes/+page.svelte')).toContain(`so_oi={${JSON.stringify({ [featured]: { plan: planCls } })}}`);
    expect(files.get(defFile(s.components[plan.definitionId]))).toContain('so_oi?.[plan.id]?.plan');
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: quotes.id, partId: 'card', itemId: highlighted, scope: 'base', property: 'background', value: { token: 'color.surface-alt' } }]);
    files = generateProject(s);
    const quoteCls = itemOverrideClass(quotes.id, 'card', highlighted);
    expect(files.get('src/lib/siteorigin/styles/site.css')).toContain(`${`.${quoteCls}`.repeat(4)} {\n\tbackground: var(--so-color-surface-alt) !important;\n}`);
    expect(files.get('src/routes/+page.svelte')).toContain(`so_oi={${JSON.stringify({ [highlighted]: { card: quoteCls } })}}`);
  });

  it('shows the item again where the shared style hides it, with the display its layout gives it', () => {
    let s = fresh();
    const g = grid(s);
    const item = cards(s)[0].id;
    s = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', scope: 'phone', property: 'hidden', value: true },
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', itemId: item, scope: 'phone', property: 'hidden', value: false }
    ]);
    const cls = itemOverrideClass(g.id, 'card', item);
    const css = siteCss(s);
    const phone = css.slice(css.indexOf('@media (max-width: 767.98px)'));
    // The card is a stack, so showing it again means flex, not the browser's default display.
    expect(phone).toContain(`.${cls}.${cls}.${cls} {\n\t\tdisplay: flex;\n\t}`);
  });

  it('keeps an item hidden where the shared style hides every card, even when the item sets its own layout', () => {
    let s = fresh();
    const g = grid(s);
    const item = cards(s)[0].id;
    s = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', scope: 'phone', property: 'hidden', value: true },
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', itemId: item, scope: 'base', property: 'layout', value: 'grid' }
    ]);
    const cls = itemOverrideClass(g.id, 'card', item);
    const css = siteCss(s);
    const phone = css.slice(css.indexOf('@media (max-width: 767.98px)'));
    expect(css).toContain(`.${cls}.${cls}.${cls} {\n\tdisplay: grid;`);
    expect(phone).toContain(`.${cls}.${cls}.${cls} {\n\t\tdisplay: none;\n\t}`);
  });

  it('keeps styles kept for another list when clearing a value the item does not have', () => {
    let s = styledGrid();
    const poetry = cards(s)[1].id;
    s = blue(s, poetry);
    // As if the repeat had been pointed at another list since: the styles are for "items", which the part left.
    grid(s).itemOverrides!.card.list = 'archived';
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: grid(s).id, partId: 'card', itemId: poetry, scope: 'base', property: 'background', value: null }]);
    expect(grid(s).itemOverrides?.card).toEqual({ list: 'archived', items: { [poetry]: { base: { background: '#dbeeff' } } } });
  });

  it('styles an item whose ID is an Object member name, and survives a malformed record', () => {
    let s = styledGrid();
    const list = cards(s).map((c, i) => (i === 1 ? { ...c, id: 'toString' } : c));
    s = apply(s, [{ type: 'instance.setProp', owner: owner(s), nodeId: grid(s).id, prop: 'items', value: list }]);
    expect(cards(s)[1].id).toBe('toString');
    s = blue(s, 'toString');
    expect(Object.hasOwn(grid(s).itemOverrides!.card.items, 'toString')).toBe(true);
    expect(generateProject(s).get('src/routes/+page.svelte')).toContain(`so_oi={${JSON.stringify({ toString: { card: itemOverrideClass(grid(s).id, 'card', 'toString') } })}}`);
    // A hand-edited record that is not styles is reported, and never blocks other edits.
    (grid(s).itemOverrides!.card.items as Record<string, unknown>)['toString'] = null;
    expect(validateState(s).some((d) => d.code === 'ITEM_STYLES_INVALID')).toBe(true);
    s = apply(s, [{ type: 'node.rename', owner: owner(s), nodeId: grid(s).id, name: 'Events' }]);
    expect(grid(s).itemOverrides).toBeUndefined();
  });

  it('selects the clicked item even when its ID holds a comma, and a sibling has the rest of it', () => {
    let s = fresh();
    const list = cards(s).map((c, i) => (i === 0 ? { ...c, id: 'events,design' } : i === 1 ? { ...c, id: 'design' } : c));
    s = apply(s, [{ type: 'instance.setProp', owner: owner(s), nodeId: grid(s).id, prop: 'items', value: list }]);
    expect(cards(s).slice(0, 2).map((c) => c.id)).toEqual(['events,design', 'design']);
    const g = grid(s);
    const def = s.components[g.definitionId];
    // The preview writes each item ID encoded; the editor reads the same item back from what was clicked.
    expect(generateProject(s, { instrument: true }).get(defFile(def))).toContain("data-so-items={[(item.id + '').replaceAll('%', '%25').replaceAll(',', '%2C')].join(',')}");
    const ref = { owner: owner(s), instancePath: [g.id], nodeId: def.parts.card.nodeId, partId: 'card', itemPath: ['events,design'] };
    expect(descOf(s, ref).items).toBe('events%2Cdesign');
    expect(selectionFromChain(s, [descOf(s, ref)], null, true)?.itemPath).toEqual(['events,design']);
    // Only "%" and "," are escaped: other characters, an unpaired surrogate included, pass through and come back.
    for (const id of ['50%,off', '\uD800', 'café ✨']) expect(selectionFromChain(s, [descOf(s, { ...ref, itemPath: [id] })], null, true)?.itemPath).toEqual([id]);
  });

  it('styles a part in a nested component’s slot for every item only', () => {
    const def = {
      kind: 'managed',
      properties: { items: { type: 'list', label: 'Cards', itemLabel: 'Card', fields: {}, default: [] }, tags: { type: 'list', label: 'Tags', itemLabel: 'Tag', fields: {}, default: [] } },
      parts: { card: { nodeId: 'card', label: 'Card' }, tag: { nodeId: 'tag', label: 'Tag' } },
      tree: {
        rootIds: ['root'],
        nodes: {
          root: { id: 'root', kind: 'element', tag: 'ul', children: ['cards'] },
          cards: { id: 'cards', kind: 'repeat', list: { $prop: 'items' }, children: ['wrap'] },
          wrap: { id: 'wrap', kind: 'instance', definitionId: 'x', props: {}, slots: { content: ['card'] } },
          card: { id: 'card', kind: 'element', tag: 'li', children: ['tags'] },
          tags: { id: 'tags', kind: 'repeat', list: { $prop: 'tags' }, children: ['tag'] },
          tag: { id: 'tag', kind: 'element', tag: 'span', children: [] }
        }
      }
    } as unknown as ComponentDefinition;
    // In a nested component's slot the card renders as often as that component renders the slot, which this
    // definition cannot see, so it is styled for every item; the tag besides sits in two repeats.
    expect(repeatedPartList(def, 'card')).toBeUndefined();
    expect(repeatedPartList(def, 'tag')).toBeUndefined();
    // Outside the slot the same card is one per item.
    const plain = structuredClone(def);
    (plain.tree!.nodes.cards as { children: string[] }).children = ['card'];
    delete (plain.tree!.nodes as Record<string, unknown>).wrap;
    expect(repeatedPartList(plain, 'card')).toBe('items');
  });

  it('refuses a theme change that would stop showing an item’s own style', () => {
    let s = styledGrid();
    const poetry = cards(s)[1].id;
    s = blue(s, poetry);
    const def = s.components[grid(s).definitionId];
    expect(contractConflicts(s, def, def)).toEqual([]);
    // The card no longer repeated per item.
    const moved = structuredClone(def);
    moved.parts.card = { ...moved.parts.card, nodeId: def.parts.heading.nodeId };
    expect(contractConflicts(s, def, moved).join(' ')).toMatch(/single item of its "card" part/);
    // A placement showing the default items: their IDs must stay.
    const inherited = structuredClone(s);
    const g = grid(inherited);
    delete g.props.items;
    const defaults = (def.properties.items as { default: ListItem[] }).default;
    g.itemOverrides = { card: { list: 'items', items: { [defaults[0].id]: { base: { background: '#dbeeff' } } } } };
    const renumbered = structuredClone(def);
    (renumbered.properties.items as { default: ListItem[] }).default = defaults.map((d, i) => ({ ...d, id: `i_new${i}` }));
    expect(contractConflicts(inherited, def, def)).toEqual([]);
    expect(contractConflicts(inherited, def, renumbered).join(' ')).toMatch(/single item/);
    // And a theme change that keeps them does not prune them as departed items.
    expect(grid(applyOperations(inherited, [{ type: 'node.rename', owner: owner(inherited), nodeId: g.id, name: 'Events' }]).state).itemOverrides?.card.items[defaults[0].id]).toBeDefined();
  });

  it('refuses a misspelled item argument from the AI rather than styling every card', () => {
    const args = SELECTION_ARGS.style_selected_element;
    expect(args.safeParse({ itemId: 'i_1', scope: 'base', styles: [{ property: 'background', value: '#fff' }] }).success).toBe(true);
    expect(args.safeParse({ itemID: 'i_1', scope: 'base', styles: [{ property: 'background', value: '#fff' }] }).success).toBe(false);
  });

  it('tells the AI which items have their own style, and no item once the selected one is gone', () => {
    let s = styledGrid();
    const [first, poetry] = cards(s).map((c) => c.id);
    s = blue(s, poetry);
    const g = grid(s);
    const def = s.components[g.definitionId];
    const ref = { owner: owner(s), instancePath: [g.id], nodeId: def.parts.card.nodeId, partId: 'card', itemPath: [poetry] };
    expect(describeSelection(s, ref)!.styleReach).toEqual({
      list: 'items',
      sharedStyles: g.overrides!.card,
      itemStyles: { [poetry]: { base: { background: '#dbeeff' } } },
      itemId: poetry,
      itemOwnStyles: { base: { background: '#dbeeff' } }
    });
    const without = apply(s, [{ type: 'instance.listRemove', owner: owner(s), nodeId: g.id, prop: 'items', itemId: poetry }]);
    const reach = describeSelection(without, ref)!.styleReach as Record<string, unknown>;
    expect(reach.itemId).toBeUndefined();
    expect(reach.itemStyles).toEqual({});
    expect(describeSelection(s, { ...ref, itemPath: [first] })!.styleReach).toMatchObject({ itemId: first, itemOwnStyles: null });
  });

  it('does not hide an item where the shared style shows every card through its layout, and survives null records in generation', () => {
    let s = fresh();
    const g = grid(s);
    const item = cards(s)[0].id;
    s = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', scope: 'base', property: 'hidden', value: true },
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', scope: 'phone', property: 'layout', value: 'grid' },
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', itemId: item, scope: 'base', property: 'background', value: '#dbeeff' }
    ]);
    const cls = itemOverrideClass(g.id, 'card', item);
    const css = siteCss(s);
    // Phones show every card (their layout writes a display), so this one too: only tablet and desktop hide it.
    const at = css.indexOf('@media (max-width: 767.98px)');
    const phone = css.slice(at, css.indexOf('\n}', at));
    expect(phone).toContain(`.${overrideClass(g.id, 'card')}`);
    expect(phone).not.toMatch(new RegExp(`\\.${cls}[^{]*\\{\\s*display: none`));
    const tabletAt = css.indexOf('@media (min-width: 768px) and (max-width: 1023.98px)');
    expect(css.slice(tabletAt, css.indexOf('\n}', tabletAt))).toMatch(new RegExp(`\\.${cls}[^{]*\\{\\s*display: none`));
    // A record that is not styles generates nothing, and a placement-wide reset gets past it.
    (grid(s).itemOverrides!.card.items as Record<string, unknown>)['i_ghost'] = null;
    expect(() => generateProject(s)).not.toThrow();
    s = applyOperations(s, [{ type: 'node.resetStyles', owner: owner(s), nodeId: grid(s).id }]).state;
    expect(grid(s).itemOverrides).toBeUndefined();
  });

  it('reads the shared hide as the stylesheet writes it, folding all-sizes hidden with a size shown again', () => {
    let s = fresh();
    const g = grid(s);
    const item = cards(s)[0].id;
    // Hidden at all sizes but tablet: the phone rule hides too, whatever layout it also sets.
    s = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', scope: 'base', property: 'hidden', value: true },
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', scope: 'phone', property: 'layout', value: 'grid' },
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', scope: 'tablet', property: 'hidden', value: false },
      { type: 'node.setStyle', owner: owner(s), nodeId: g.id, partId: 'card', itemId: item, scope: 'base', property: 'layout', value: 'row' }
    ]);
    const cls = itemOverrideClass(g.id, 'card', item);
    const css = siteCss(s);
    const at = css.indexOf('@media (max-width: 767.98px)');
    expect(css.slice(at, css.indexOf('\n}', at))).toMatch(new RegExp(`\\.${cls}[^{]*\\{\\s*display: none`));
  });

  it('keeps an item shown where the shared style shows again what the design hides', () => {
    let s = fresh();
    const id = grid(s).id;
    s = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: id }]).state;
    const g = home(s).nodes[id] as InstanceNode;
    const def = s.components[g.definitionId];
    def.tree!.nodes[def.parts.card.nodeId].styles = { ...def.tree!.nodes[def.parts.card.nodeId].styles, phone: { hidden: true } };
    const item = (g.props.items as ListItem[])[0].id;
    s = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: id, partId: 'card', scope: 'phone', property: 'hidden', value: false },
      { type: 'node.setStyle', owner: owner(s), nodeId: id, partId: 'card', itemId: item, scope: 'base', property: 'background', value: '#dbeeff' }
    ]);
    const cls = itemOverrideClass(id, 'card', item);
    const css = siteCss(s);
    expect(css).not.toMatch(new RegExp(`\\.${cls}[^{]*\\{\\s*display: none`));
  });

  it('keeps a stored item ID with a comma, and its style, when the list schema is edited', () => {
    let s = styledGrid();
    const id = grid(s).id;
    s = applyOperations(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: id }]).state;
    const node = home(s).nodes[id] as InstanceNode;
    (node.props.items as ListItem[])[0].id = 'events,design';
    s = apply(s, [{ type: 'node.setStyle', owner: owner(s), nodeId: id, partId: 'card', itemId: 'events,design', scope: 'base', property: 'background', value: '#dbeeff' }]);
    const def = s.components[(home(s).nodes[id] as InstanceNode).definitionId];
    s = applyOperations(s, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'items', schema: { ...def.properties.items, label: 'Events' } }]).state;
    const after = home(s).nodes[id] as InstanceNode;
    expect((after.props.items as ListItem[])[0].id).toBe('events,design');
    expect(after.itemOverrides?.card.items['events,design']).toEqual({ base: { background: '#dbeeff' } });
  });
});
