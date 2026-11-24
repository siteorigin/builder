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
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { validateState } from '@engine/validate';
import { defFile, generateProject, overrideClass } from '@generator/index';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const grid = (s: ProjectState) => {
  const p = home(s);
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === 'features.grid')!;
};
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
    const def = s.components[g.definitionId];
    rejects(() => apply(s, [{ ...base, owner: { kind: 'component', id: def.id }, nodeId: def.tree!.rootIds[0], partId: 'card', itemId: item }]), /theme component|placement on a page/);
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

  it('styles a featured plan and a highlighted testimonial the same way', () => {
    let s = fresh();
    for (const componentId of ['pricing.plans', 'testimonials.grid'])
      s = applyOperations(s, [{ type: 'node.insert', owner: owner(s), parentId: null, componentId }]).state;
    const placed = (componentId: string) => home(s).rootIds.map((id) => home(s).nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
    const plan = placed('pricing.plans');
    const featured = (plan.props.plans as ListItem[])[1].id;
    const quotes = placed('testimonials.grid');
    const highlighted = (quotes.props.items as ListItem[])[0].id;
    s = apply(s, [
      { type: 'node.setStyle', owner: owner(s), nodeId: plan.id, partId: 'plan', itemId: featured, scope: 'base', property: 'border', value: { token: 'border.strong' } },
      { type: 'node.setStyle', owner: owner(s), nodeId: quotes.id, partId: 'card', itemId: highlighted, scope: 'base', property: 'background', value: { token: 'color.surface-alt' } }
    ]);
    const files = generateProject(s);
    const page = files.get('src/routes/+page.svelte')!;
    const css = files.get('src/lib/siteorigin/styles/site.css')!;
    const planCls = itemOverrideClass(plan.id, 'plan', featured);
    const quoteCls = itemOverrideClass(quotes.id, 'card', highlighted);
    expect(css).toContain(`.${planCls}.${planCls}.${planCls} {\n\tborder: var(--so-border-strong);\n}`);
    expect(css).toContain(`.${quoteCls}.${quoteCls}.${quoteCls} {\n\tbackground: var(--so-color-surface-alt);\n}`);
    expect(page).toContain(`so_oi={${JSON.stringify({ [featured]: { plan: itemOverrideClass(plan.id, 'plan', featured) } })}}`);
    expect(page).toContain(`so_oi={${JSON.stringify({ [highlighted]: { card: itemOverrideClass(quotes.id, 'card', highlighted) } })}}`);
    expect(files.get(defFile(s.components[plan.definitionId]))).toContain('so_oi?.[item.id]?.["plan"]');
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

  it('gives a new item ID with a comma an ID of its own, so a click on it selects that item', () => {
    let s = fresh();
    const list = cards(s).map((c, i) => (i === 0 ? { ...c, id: 'events,design' } : c));
    s = apply(s, [{ type: 'instance.setProp', owner: owner(s), nodeId: grid(s).id, prop: 'items', value: list }]);
    expect(cards(s)[0].id).not.toContain(',');
    expect(cards(s).slice(1).map((c) => c.id)).toEqual(list.slice(1).map((c) => c.id));
  });

  it('counts the repeats around a part placed in a nested component’s slot', () => {
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
    // Once per card through the slot; the tag sits in two repeats, so one tag ID names one tag per card.
    expect(repeatedPartList(def, 'card')).toBe('items');
    expect(repeatedPartList(def, 'tag')).toBeUndefined();
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
    expect(css).toMatch(new RegExp(`@media \\(min-width: 768px\\) and \\(max-width: 1023\\.98px\\) \\{[\\s\\S]*\\.${cls}[^{]*\\{\\s*display: none`));
    // A record that is not styles generates nothing, and a placement-wide reset gets past it.
    (grid(s).itemOverrides!.card.items as Record<string, unknown>)['i_ghost'] = null;
    expect(() => generateProject(s)).not.toThrow();
    s = applyOperations(s, [{ type: 'node.resetStyles', owner: owner(s), nodeId: grid(s).id }]).state;
    expect(grid(s).itemOverrides).toBeUndefined();
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
