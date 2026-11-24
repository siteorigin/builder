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

/** A design with a property of every kind, a list repeated inside another, and fields named like properties. */
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
      plans: P.list('Plans', 'Plan', { title: P.str('Title', 'Plan'), seats: P.num('Seats', 1), perks: P.choice('Perks', 'none', [['none', 'None'], ['some', 'Some']]) }, [
        { title: 'Basic', seats: 1, perks: 'none' },
        { title: 'Pro', seats: 5, perks: 'some' }
      ])
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
    expect(outside.props.map((x) => x.key)).toEqual(['prop:title', 'prop:featured', 'prop:media', 'prop:columns', 'prop:intro', 'prop:cta', 'prop:plans']);
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
    expect(shownField(op, reads![0].found ? reads![0].value : undefined)).toBe('Draft');
    // A newer value typed for the same rule replaces the held one.
    expect(fieldKey([op])).toBe(fieldKey([typed(def, 'Other')]));
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
