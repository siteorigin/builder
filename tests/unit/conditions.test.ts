/**
 * Visibility rules made in the Inspector (#368): what a condition at a node can read, how each source compares,
 * the operations the controls send, how the rules read in Layers, and typed comparison values held while the AI
 * works. The engine stays the judge: every choice offered here is one it accepts.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState } from '@engine/validate';
import { P, eq, item, prop, type ComponentSpec } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { comparisonInput, conditionSources, describeConditions, readRule, ruleOp, startValue } from '../../src/renderer/src/lib/conditions';
import { checkHeld, fieldKey, readFields, shownField, typedText } from '../../src/renderer/src/lib/held';

const { managed } = FOUNDATION;
const fresh = () => createStarterState('business', 'Test Studio', false);
const owner = (def: ComponentDefinition) => ({ kind: 'component' as const, id: def.id });
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);

function addDef(s: ProjectState, spec: Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'>): ComponentDefinition {
  const def = { ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', ...spec }), owner: 'project' as const };
  s.components[def.id] = def;
  return def;
}

const planFields = () => ({ title: P.str('Title', 'Plan'), seats: P.num('Seats', 1), perks: P.choice('Perks', 'none', [['none', 'None'], ['some', 'Some']]) });

/** A design with a property of every kind, a repeated list, and item fields named like properties. */
function cardsDef(s: ProjectState) {
  return addDef(s, {
    componentId: 'test.conditions',
    name: 'Cards',
    properties: {
      title: P.str('Title', 'Our plans'),
      featured: P.bool('Featured', false),
      media: P.choice('Media', 'video', [['image', 'Picture'], ['video', 'Film']]),
      columns: P.num('Columns', 3),
      intro: P.rich('Intro', ['Hello']),
      cta: P.link('Call to action'),
      plans: P.list('Plans', 'Plan', planFields(), [
        { title: 'Basic', seats: 1, perks: 'none' },
        { title: 'Pro', seats: 5, perks: 'some' }
      ]),
      // The same fields as plans: a repeat can be moved from one list to the other.
      offers: P.list('Offers', 'Offer', planFields(), [{ title: 'Trial', seats: 1, perks: 'none' }])
    },
    parts: {},
    build: (b) =>
      b.el('root', 'section', {}, [
        b.text('heading', 'h2', prop('title'), { when: prop('title') }),
        b.text('note', 'p', 'Watch it', { when: eq(prop('media'), 'video') }),
        b.el('grid', 'ul', {}, [
          b.repeat('cards', 'plans', [
            b.el('card', 'li', {}, [
              b.text('card-title', 'h3', item('title')),
              b.el('badge-wrap', 'div', {}, [b.text('badge', 'span', 'Team plan', { unless: eq(item('seats'), 1) })])
            ])
          ])
        ])
      ])
  });
}

describe('what a condition can read (#368)', () => {
  it('offers the component’s properties everywhere, and the item’s fields only inside its repeat', () => {
    const s = fresh();
    const def = cardsDef(s);
    const outside = conditionSources(def, 'heading');
    expect(outside.props.map((x) => x.key)).toEqual(['prop:title', 'prop:featured', 'prop:media', 'prop:columns', 'prop:intro', 'prop:cta', 'prop:plans', 'prop:offers']);
    expect(outside.item).toEqual([]);
    const inside = conditionSources(def, 'badge');
    expect(inside.item.map((x) => x.key)).toEqual(['item:title', 'item:seats', 'item:perks']);
    expect(inside.itemLabel).toBe('Plan');
    // A property and an item field of the same name are two sources.
    expect(inside.props.find((x) => x.key === 'prop:title')!.binding).toEqual({ $prop: 'title' });
    expect(inside.item.find((x) => x.key === 'item:title')!.binding).toEqual({ $item: 'title' });
    // The repeat's own condition is decided outside it, so it reads no item.
    expect(conditionSources(def, 'cards').item).toEqual([]);
  });

  it('reads the item around a repeat inside another, and its own item inside it, as the engine does', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.nested',
      name: 'Nested',
      properties: { groups: P.list('Groups', 'Group', { name: P.str('Name', 'Group') }, [{ name: 'One' }]), tags: P.list('Tags', 'Tag', { weight: P.num('Weight', 1) }, [{ weight: 2 }]) },
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.repeat('outer', 'groups', [b.el('group', 'div', {}, [b.repeat('inner', 'tags', [b.text('tag', 'span', 'Tag')])])])])
    });
    expect(conditionSources(def, 'inner')).toMatchObject({ itemLabel: 'Group', item: [{ key: 'item:name', schema: { type: 'string' } }] });
    expect(conditionSources(def, 'tag')).toMatchObject({ itemLabel: 'Tag', item: [{ key: 'item:weight', schema: { type: 'number' } }] });
    expect(conditionSources(def, 'tag').item).toHaveLength(1);
    // What is offered is what the engine takes, and nothing else.
    const set = (nodeId: string, $item: string) => applyOperations(s, [ruleOp(owner(def), nodeId, 'when', { binding: { $item }, test: 'set' })]);
    expect(errors(set('inner', 'name').state)).toEqual([]);
    expect(errors(set('tag', 'weight').state)).toEqual([]);
    expect(() => set('inner', 'weight')).toThrow(/no field "weight"/);
    expect(() => set('tag', 'name')).toThrow(/no field "name"/);
  });

  it('compares yes/no, numbers, text and choices, and only tests the rest for a value', () => {
    const s = fresh();
    const def = cardsDef(s);
    const p = def.properties;
    expect(comparisonInput(p.featured)).toEqual({ kind: 'boolean' });
    expect(comparisonInput(p.columns)).toEqual({ kind: 'number' });
    expect(comparisonInput(p.title)).toEqual({ kind: 'text' });
    expect(comparisonInput(p.media)).toEqual({ kind: 'choice', options: [{ value: 'image', label: 'Picture' }, { value: 'video', label: 'Film' }] });
    for (const k of ['intro', 'cta', 'plans']) expect(comparisonInput(p[k])).toBeNull();
    expect(startValue(p.featured)).toBe(true);
    expect(startValue(p.columns)).toBe(3);
    expect(startValue(p.title)).toBe('Our plans');
    expect(startValue(p.media)).toBe('video');
    expect(startValue(p.intro)).toBeUndefined();
    // Other defaults: each kind starts from its own, a choice whose default has gone from its first option.
    expect(startValue(P.num('Count', 0))).toBe(0);
    expect(startValue(P.num('Count', 7))).toBe(7);
    expect(startValue(P.bool('Shown', false))).toBe(true);
    expect(comparisonInput(P.icon('Icon', 'star'))).toEqual({ kind: 'text' });
    expect(startValue(P.icon('Icon', 'star'))).toBe('star');
    expect(startValue(P.str('Name', ''))).toBe('');
    expect(startValue(P.choice('Size', 'gone', [['small', 'Small'], ['large', 'Large']]))).toBe('small');
    expect(comparisonInput({ type: 'enum', label: 'Empty', default: '', options: [] })).toBeNull();
  });

  it('sends only choices the engine accepts, for every source and test the controls offer', () => {
    const s = fresh();
    const def = cardsDef(s);
    for (const nodeId of ['heading', 'badge-wrap']) {
      const { props, item: fields } = conditionSources(def, nodeId);
      for (const source of [...props, ...fields])
        for (const field of ['when', 'unless'] as const) {
          const tests = comparisonInput(source.schema) ? (['set', 'eq', 'ne'] as const) : (['set'] as const);
          for (const test of tests) {
            const op = ruleOp(owner(def), nodeId, field, { binding: source.binding, test, value: test === 'set' ? undefined : startValue(source.schema) });
            const r = applyOperations(s, [op]);
            expect(errors(r.state), `${nodeId} ${field} ${source.key} ${test}`).toEqual([]);
            const saved = readRule(r.state.components[def.id], r.state.components[def.id].tree!.nodes[nodeId], field);
            expect(saved).toMatchObject({ binding: source.binding, test, ...(test === 'set' ? {} : { value: startValue(source.schema) }) });
          }
        }
    }
  });
});

describe('rules set, changed and cleared from the controls (#368)', () => {
  it('reads the saved rules back the way they were written, both at once', () => {
    const s = fresh();
    const def = cardsDef(s);
    const nodes = def.tree!.nodes;
    expect(readRule(def, nodes.heading, 'when')).toMatchObject({ binding: { $prop: 'title' }, test: 'set' });
    expect(readRule(def, nodes.note, 'when')).toMatchObject({ test: 'eq', value: 'video' });
    expect(readRule(def, nodes.badge, 'unless')).toMatchObject({ binding: { $item: 'seats' }, test: 'eq', value: 1 });
    expect(readRule(def, nodes.badge, 'when')).toBeNull();
    // Show and hide rules are independent: setting one keeps the other.
    const r = applyOperations(s, [ruleOp(owner(def), 'badge', 'when', { binding: { $item: 'perks' }, test: 'ne', value: 'none' })]).state;
    const badge = r.components[def.id].tree!.nodes.badge;
    expect(badge.when).toEqual({ ref: { $item: 'perks' }, ne: 'none' });
    expect(badge.unless).toEqual({ ref: { $item: 'seats' }, eq: 1 });
    const d = r.components[def.id];
    expect(readRule(d, badge, 'when')).toEqual({ binding: { $item: 'perks' }, test: 'ne', value: 'none', source: conditionSources(d, 'badge').item[2] });
    expect(readRule(d, badge, 'unless')).toEqual({ binding: { $item: 'seats' }, test: 'eq', value: 1, source: conditionSources(d, 'badge').item[1] });
    // Cleared, only that rule goes.
    const cleared = applyOperations(r, [ruleOp(owner(def), 'badge', 'unless', null)]).state.components[def.id].tree!.nodes.badge;
    expect(cleared.unless).toBeUndefined();
    expect(cleared.when).toEqual({ ref: { $item: 'perks' }, ne: 'none' });
  });

  it('says what each rule does for Layers, naming the item a field belongs to', () => {
    const s = fresh();
    const def = cardsDef(s);
    const r = applyOperations(s, [
      { type: 'node.setContent', owner: owner(def), nodeId: 'badge-wrap', field: 'collapseEmpty', value: true },
      ruleOp(owner(def), 'badge', 'when', { binding: { $item: 'perks' }, test: 'ne', value: 'none' }),
      ruleOp(owner(def), 'grid', 'unless', { binding: { $prop: 'featured' }, test: 'eq', value: false })
    ]).state;
    const d = r.components[def.id];
    expect(describeConditions(d, d.tree!.nodes.heading)).toEqual(['Show when Title has a value']);
    expect(describeConditions(d, d.tree!.nodes.note)).toEqual(['Show when Media is Film']);
    expect(describeConditions(d, d.tree!.nodes.badge)).toEqual(['Show when Plan perks is not None', 'Hide when Plan seats is 1']);
    expect(describeConditions(d, d.tree!.nodes['badge-wrap'])).toEqual(['Hidden when every item inside is hidden']);
    expect(describeConditions(d, d.tree!.nodes.grid)).toEqual(['Hide when Featured is off']);
    expect(describeConditions(d, d.tree!.nodes['card-title'])).toEqual([]);
    // A container with all three says all three.
    const all = applyOperations(r, [
      { type: 'node.setContent', owner: owner(def), nodeId: 'grid', field: 'collapseEmpty', value: true },
      ruleOp(owner(def), 'grid', 'when', { binding: { $prop: 'columns' }, test: 'ne', value: 0 })
    ]).state.components[def.id];
    expect(describeConditions(all, all.tree!.nodes.grid)).toEqual(['Show when Columns is not 0', 'Hide when Featured is off', 'Hidden when every item inside is hidden']);
  });

  it('keeps a rule whose source has gone readable, so it can be cleared', () => {
    const s = fresh();
    const def = cardsDef(s);
    def.tree!.nodes.heading.when = { $prop: 'gone' };
    const rule = readRule(def, def.tree!.nodes.heading, 'when');
    expect(rule).toMatchObject({ binding: { $prop: 'gone' }, test: 'set' });
    expect(rule!.source).toBeUndefined();
    const r = applyOperations(s, [ruleOp(owner(def), 'heading', 'when', null)]).state;
    expect(r.components[def.id].tree!.nodes.heading.when).toBeUndefined();
    // A comparison with an item field the list no longer has, likewise.
    def.tree!.nodes.badge.unless = { ref: { $item: 'gone' }, ne: 4 };
    const compared = readRule(def, def.tree!.nodes.badge, 'unless');
    expect(compared).toEqual({ binding: { $item: 'gone' }, test: 'ne', value: 4, source: undefined });
    expect(describeConditions(def, def.tree!.nodes.badge)).toEqual(['Hide when gone is not 4']);
    expect(applyOperations(s, [ruleOp(owner(def), 'badge', 'unless', null)]).state.components[def.id].tree!.nodes.badge.unless).toBeUndefined();
  });
});

describe('a typed comparison value made while the AI works (#368)', () => {
  const typed = (def: ComponentDefinition, value: string | number): EditOperation => ruleOp(owner(def), 'heading', 'when', { binding: { $prop: 'title' }, test: 'eq', value });

  it('is held, and applies when the rule is still what the author changed', () => {
    const s = fresh();
    const def = cardsDef(s);
    const base = applyOperations(s, [typed(def, 'Draft')]).state;
    const op = typed(def, 'Ready');
    const reads = readFields(base, [op]);
    expect(reads?.[0].found).toBe(true);
    expect(checkHeld(base, [op], reads!.map((r) => (r.found ? r.value : undefined)))).toEqual({ kind: 'apply' });
    expect(typedText(op)).toBe('Ready');
    expect(shownField(op, reads![0].found ? reads![0].value : undefined)).toBe('title is Draft');
    // A newer value typed for the same rule replaces the held one, whether it compares with "is" or "is not"; the
    // other rule of the node, and the same rule of another node, are other fields.
    const isNot = ruleOp(owner(def), 'heading', 'when', { binding: { $prop: 'title' }, test: 'ne', value: 'Other' });
    expect(fieldKey([isNot])).toBe(fieldKey([op]));
    expect(fieldKey([ruleOp(owner(def), 'heading', 'unless', { binding: { $prop: 'title' }, test: 'eq', value: 'Ready' })])).not.toBe(fieldKey([op]));
    expect(fieldKey([ruleOp(owner(def), 'note', 'when', { binding: { $prop: 'title' }, test: 'eq', value: 'Ready' })])).not.toBe(fieldKey([op]));
  });

  it('shows the rule an edit would replace, never as nothing', () => {
    const s = fresh();
    const def = cardsDef(s);
    const op = typed(def, 'Ready');
    const shown = (state: ProjectState) => {
      const r = readFields(state, [op])![0];
      return shownField(op, r.found ? r.value : undefined);
    };
    expect(shown(s)).toBe('title has a value');
    expect(shown(applyOperations(s, [ruleOp(owner(def), 'heading', 'when', { binding: { $prop: 'columns' }, test: 'ne', value: 2 })]).state)).toBe('columns is not 2');
    expect(shown(applyOperations(s, [ruleOp(owner(def), 'heading', 'when', null)]).state)).toBe('');
  });

  it('reads an item field together with the list around it, and a property without it', () => {
    const s = fresh();
    const def = cardsDef(s);
    const item = ruleOp(owner(def), 'badge', 'when', { binding: { $item: 'title' }, test: 'eq', value: 'Pro' });
    const read = readFields(s, [item])![0];
    expect(read.found && read.value).toMatchObject({ list: 'plans', schema: { type: 'string', label: 'Title' } });
    const prop = ruleOp(owner(def), 'badge', 'when', { binding: { $prop: 'title' }, test: 'eq', value: 'Pro' });
    const propRead = readFields(s, [prop])![0];
    expect(propRead.found && propRead.value).not.toHaveProperty('list');
  });

  it('is checked again when the rule, or the list the node repeats for, changed meanwhile', () => {
    const s = fresh();
    const def = cardsDef(s);
    const base = applyOperations(s, [typed(def, 'Draft')]).state;
    const op = typed(def, 'Ready');
    const reads = readFields(base, [op])!.map((r) => (r.found ? r.value : undefined));
    const changed = applyOperations(base, [typed(def, 'Elsewhere')]).state;
    expect(checkHeld(changed, [op], reads).kind).toBe('changed');
    const unbound = applyOperations(base, [{ type: 'node.remove', owner: owner(def), nodeId: 'heading' }]).state;
    expect(checkHeld(unbound, [op], reads)).toEqual({ kind: 'gone', what: 'element' });
    // The property it reads changed: a different label is a different field to the author.
    const renamed = applyOperations(base, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'title', schema: { type: 'string', label: 'Headline', default: 'Our plans' } }]).state;
    expect(readRule(renamed.components[def.id], renamed.components[def.id].tree!.nodes.heading, 'when')).toMatchObject({ test: 'eq', value: 'Draft' });
    expect(checkHeld(renamed, [op], reads).kind).toBe('changed');
    // Or it has gone.
    const without = structuredClone(base);
    delete without.components[def.id].properties.title;
    expect(checkHeld(without, [op], reads)).toEqual({ kind: 'gone', what: 'property' });
  });

  it('is checked again when the list a field of the same name belongs to changed', () => {
    const s = fresh();
    const def = cardsDef(s);
    const op = ruleOp(owner(def), 'badge', 'when', { binding: { $item: 'title' }, test: 'eq', value: 'Pro' });
    const reads = readFields(s, [op])!.map((r) => (r.found ? r.value : undefined));
    expect(checkHeld(s, [op], reads)).toEqual({ kind: 'apply' });
    // The cards now repeat the offers, whose items have a title too: the same rule now reads another list.
    const moved = applyOperations(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'cards', field: 'list', binding: { $prop: 'offers' } }]).state;
    expect(errors(moved)).toEqual([]);
    expect(checkHeld(moved, [op], reads).kind).toBe('changed');
    // A number compared with is held too, and read the same way.
    const seats = ruleOp(owner(def), 'badge', 'unless', { binding: { $item: 'seats' }, test: 'ne', value: 3 });
    expect(readFields(s, [seats])![0]).toEqual({ found: true, value: { value: { ref: { $item: 'seats' }, eq: 1 }, list: 'plans', schema: def.properties.plans.type === 'list' && def.properties.plans.fields.seats } });
  });

  it('leaves choosing what a rule reads, or how it compares, a gesture that is never held', () => {
    const s = fresh();
    const def = cardsDef(s);
    expect(readFields(s, [ruleOp(owner(def), 'heading', 'when', { binding: { $prop: 'title' }, test: 'set' })])).toBeNull();
    expect(readFields(s, [ruleOp(owner(def), 'heading', 'when', null)])).toBeNull();
    expect(readFields(s, [ruleOp(owner(def), 'heading', 'when', { binding: { $prop: 'featured' }, test: 'eq', value: true })])).toBeNull();
    expect(readFields(s, [{ type: 'node.setBinding', owner: owner(def), nodeId: 'heading', field: 'text', binding: { $prop: 'title' } }])).toBeNull();
  });
});
