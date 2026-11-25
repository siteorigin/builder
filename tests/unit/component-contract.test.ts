/**
 * Edit everywhere's contract controls (#171): binding a design's fields to new or existing properties and back,
 * renaming, reordering and removing properties, exposing parts, and creating and styling variants.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, GraphNode, InstanceNode, ProjectState, TextNode } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState } from '@engine/validate';
import { requiredProblems } from '@engine/required';
import { generateProject } from '@generator/index';
import { axesOf } from '@shared/variants';
import { ProjectSession } from '../../src/main/project/session';
import { designContent } from '../../src/renderer/src/lib/design-content';
import {
  addVariantGroupOp,
  addVariantOp,
  bindChoices,
  bindExistingOp,
  bindNewProperty,
  canExposePart,
  canRequire,
  isRequired,
  placementsMissing,
  requirableFields,
  setRequiredOp,
  defaultVariantOp,
  exposePartOp,
  liveStyleTarget,
  movePropOp,
  newPropSchema,
  placementOrder,
  propertyUses,
  removeVariantOp,
  renamePartOp,
  renamePropOp,
  renameVariantGroupOp,
  renameVariantOp,
  suggestedPropLabel,
  takenPropNames,
  unbindOp,
  variantStylable
} from '../../src/renderer/src/lib/component-contract';

const home = (s: ProjectState) => s.pages[s.site.homePageId];
const pageOwner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);

/** A fresh business site with its theme's `componentId` made a project component (what Edit everywhere does first). */
function forked(componentId: string) {
  const s0 = createStarterState('business', 'Test Studio', false);
  const theme = Object.values(s0.components).find((d) => d.componentId === componentId)!;
  const r = applyOperations(s0, [{ type: 'component.fork', definitionId: theme.id }]);
  const defId = r.results[0].definitionId as string;
  return { s: r.state, defId, def: (st: ProjectState): ComponentDefinition => st.components[defId] };
}

/** The placements of a component on the home page, in page order. */
const placed = (s: ProjectState, defId: string) =>
  home(s)
    .rootIds.map((id) => home(s).nodes[id])
    .filter((n): n is InstanceNode => n.kind === 'instance' && n.definitionId === defId);

/** The split hero with a new fixed heading, paragraph, button, image and icon inside its design, placed twice on Home. */
function heroWithFixedContent() {
  const hero = forked('hero.split');
  const root = hero.def(hero.s).tree!.rootIds[0];
  const o = { kind: 'component' as const, id: hero.defId };
  let s = applyOperations(hero.s, [
    { type: 'node.insert', owner: o, parentId: root, primitive: 'heading', text: 'Summer hours', newNodeId: 'n_head01' },
    { type: 'node.insert', owner: o, parentId: root, primitive: 'paragraph', text: 'Open late\non Fridays', newNodeId: 'n_para01' },
    { type: 'node.insert', owner: o, parentId: root, primitive: 'button', text: 'Visit us', newNodeId: 'n_btn001' },
    { type: 'node.insert', owner: o, parentId: root, primitive: 'icon', newNodeId: 'n_icon01' },
    { type: 'node.insert', owner: o, parentId: root, primitive: 'richtext', newNodeId: 'n_rich01' },
    { type: 'node.insert', owner: o, parentId: root, primitive: 'image', newNodeId: 'n_img001' }
  ]).state;
  s = applyOperations(s, [{ type: 'node.duplicate', owner: pageOwner(s), nodeId: placed(s, hero.defId)[0].id }]).state;
  return { ...hero, s, node: (st: ProjectState, id: string): GraphNode => hero.def(st).tree!.nodes[id] };
}

const apply = (s: ProjectState, ops: EditOperation[]) => {
  for (const op of ops) expect(validateOperation(op)).toMatchObject({ ok: true });
  return applyOperations(s, ops).state;
};

describe('making a field of the design one each placement fills in', () => {
  it('adds a property that starts with what the design shows, and binds the field to it in one change', () => {
    const h = heroWithFixedContent();
    const before = generateProject(h.s).get('src/routes/+page.svelte')!;
    expect(before.split('Summer hours').length - 1).toBe(0); // the design's text lives in the component file
    const heading = h.node(h.s, 'n_head01');
    expect(designContent(h.def(h.s), heading)).toMatchObject([{ field: 'text', source: 'design', value: 'Summer hours' }]);

    const plan = bindNewProperty(h.s, h.def(h.s), heading, 'text', 'Opening hours')!;
    expect(plan.prop).toBe('openingHours');
    expect(plan.operations).toEqual([
      { type: 'component.setPropSchema', definitionId: h.defId, prop: 'openingHours', schema: { type: 'string', label: 'Opening hours', default: 'Summer hours' } },
      { type: 'node.setBinding', owner: { kind: 'component', id: h.defId }, nodeId: 'n_head01', field: 'text', binding: { $prop: 'openingHours' } }
    ]);
    const s = apply(h.s, plan.operations);
    expect(errors(s)).toEqual([]);
    expect((h.node(s, 'n_head01') as TextNode).text).toEqual({ $prop: 'openingHours' });
    expect(designContent(h.def(s), h.node(s, 'n_head01'))).toMatchObject([{ field: 'text', source: 'default', prop: 'openingHours', value: 'Summer hours' }]);
    // Every placement shows it through the default: none was given a value, and each placement's Content lists it.
    for (const p of placed(s, h.defId)) expect(Object.hasOwn(p.props, 'openingHours')).toBe(false);
    expect(Object.keys(h.def(s).properties)).toContain('openingHours');
    // Each placement can now give it its own value.
    const [first, second] = placed(s, h.defId);
    const t = apply(s, [{ type: 'instance.setProp', owner: pageOwner(s), nodeId: second.id, prop: 'openingHours', value: 'Winter hours' }]);
    const page = generateProject(t).get('src/routes/+page.svelte')!;
    expect(page).toContain('Winter hours');
    expect((home(t).nodes[first.id] as InstanceNode).props.openingHours).toBeUndefined();
  });

  it('gives each kind of field the property type and default that keep it as it was', () => {
    const h = heroWithFixedContent();
    const def = h.def(h.s);
    const para = h.node(h.s, 'n_para01');
    expect(newPropSchema(para, 'text', (para as TextNode).text, 'Note')).toEqual({ type: 'string', label: 'Note', default: 'Open late\non Fridays', multiline: true });
    const rich = h.node(h.s, 'n_rich01');
    expect(newPropSchema(rich, 'text', (rich as TextNode).text, 'Body')).toMatchObject({ type: 'richtext', label: 'Body' });
    // A button label with a line break keeps it.
    expect(newPropSchema(h.node(h.s, 'n_btn001'), 'label', 'Open\nFridays', 'Label')).toEqual({ type: 'string', label: 'Label', default: 'Open\nFridays', multiline: true });
    const broken = apply(h.s, [{ type: 'node.setContent', owner: { kind: 'component', id: h.defId }, nodeId: 'n_btn001', field: 'label', value: 'Open\nFridays' }]);
    const labelPlan = bindNewProperty(broken, h.def(broken), h.node(broken, 'n_btn001'), 'label', 'Label')!;
    expect(h.def(apply(broken, labelPlan.operations)).properties[labelPlan.prop].default).toBe('Open\nFridays');
    const btn = h.node(h.s, 'n_btn001');
    expect(suggestedPropLabel(def, btn, 'label')).toBe('Button label');
    expect(suggestedPropLabel(def, btn, 'link')).toBe('Button link');
    // The hero already has a property called Heading.
    expect(suggestedPropLabel(def, h.node(h.s, 'n_head01'), 'text')).toBe('Heading 2');
    expect(suggestedPropLabel(def, h.node(h.s, 'n_icon01'), 'icon')).toBe('Icon');

    // Each one binds, validates and saves.
    let s = h.s;
    for (const [id, field, type] of [
      ['n_para01', 'text', 'string'],
      ['n_rich01', 'text', 'richtext'],
      ['n_btn001', 'label', 'string'],
      ['n_btn001', 'link', 'link'],
      ['n_icon01', 'icon', 'icon'],
      ['n_img001', 'image', 'image']
    ] as const) {
      const node = h.node(s, id);
      const shown = (node as unknown as Record<string, unknown>)[field];
      const plan = bindNewProperty(s, h.def(s), node, field, suggestedPropLabel(h.def(s), node, field))!;
      s = apply(s, plan.operations);
      const schema = h.def(s).properties[plan.prop];
      expect(schema.type).toBe(type);
      // What every placement now shows is what the design showed.
      expect(schema.default).toEqual(field === 'link' ? (shown ?? { type: 'none', target: '' }) : shown);
      for (const p of placed(s, h.defId)) expect(Object.hasOwn(p.props, plan.prop)).toBe(false);
    }
    expect(errors(s)).toEqual([]);
    // A button's label and link read as one pair on each placement.
    expect(Object.values(h.def(s).properties).map((p) => p.label)).toEqual(expect.arrayContaining(['Button label', 'Button link']));
  });

  it('never takes a name a placement still stores a value under', () => {
    const h = heroWithFixedContent();
    const s = structuredClone(h.s);
    // An old value for a property removed long ago: a new "heading2" would show it instead of the design's text.
    const [first] = placed(s, h.defId);
    (home(s).nodes[first.id] as InstanceNode).props.summerHours = 'Winter hours';
    expect(takenPropNames(s, h.def(s)).has('summerHours')).toBe(true);
    const plan = bindNewProperty(s, h.def(s), h.node(s, 'n_head01'), 'text', 'Summer hours')!;
    expect(plan.prop).toBe('summerHours2');
    const t = apply(s, plan.operations);
    const page = generateProject(t).get('src/routes/+page.svelte')!;
    expect(page).not.toContain('Winter hours');
  });

  it('avoids the component’s UI state and reserved words', () => {
    const h = heroWithFixedContent();
    let s = applyOperations(h.s, [{ type: 'component.setState', definitionId: h.defId, state: 'open', schema: { type: 'boolean' } }]).state;
    expect(bindNewProperty(s, h.def(s), h.node(s, 'n_head01'), 'text', 'Open')!.prop).toBe('open2');
    expect(bindNewProperty(s, h.def(s), h.node(s, 'n_head01'), 'text', 'Class')!.prop).toBe('headingText');
    // A name every operation refuses wherever it names something.
    const proto = bindNewProperty(s, h.def(s), h.node(s, 'n_head01'), 'text', 'Prototype')!;
    expect(proto.prop).toBe('prototype2');
    // Svelte reads `slot` on a component placed in another's slot as slot syntax.
    expect(bindNewProperty(s, h.def(s), h.node(s, 'n_head01'), 'text', 'Slot')!.prop).toBe('slot2');
    for (const op of proto.operations) expect(validateOperation(op)).toMatchObject({ ok: true });
    s = apply(s, bindNewProperty(s, h.def(s), h.node(s, 'n_head01'), 'text', 'Default')!.operations);
    expect(errors(s)).toEqual([]);
  });

  it('leaves a field a property or list item already fills in alone', () => {
    const hero = forked('hero.split');
    expect(bindNewProperty(hero.s, hero.def(hero.s), hero.def(hero.s).tree!.nodes.heading, 'text', 'Heading')).toBeNull();
    const grid = forked('features.grid');
    const g = grid.def(grid.s);
    expect(bindNewProperty(grid.s, g, g.tree!.nodes['card-icon'], 'icon', 'Icon')).toBeNull();
  });

  it('refuses a new property once the component has as many as it can', () => {
    const h = heroWithFixedContent();
    const s = structuredClone(h.s);
    const def = h.def(s);
    for (let i = Object.keys(def.properties).length; i < 60; i++) def.properties[`extra${i}`] = { type: 'string', label: `Extra ${i}`, default: '' };
    expect(bindNewProperty(s, def, h.node(s, 'n_head01'), 'text', 'Heading')).toBeNull();
  });

  it('is one undo step', async () => {
    const h = heroWithFixedContent();
    const dir = mkdtempSync(join(tmpdir(), 'so-contract-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, h.s);
    try {
      const plan = bindNewProperty(session.state, h.def(session.state), h.node(session.state, 'n_head01'), 'text', 'Heading')!;
      const res = await session.apply({ operations: plan.operations }, { label: 'Fill in heading text on each placement', source: 'user' });
      expect(res.ok).toBe(true);
      expect(h.def(session.state).properties[plan.prop]).toBeTruthy();
      await session.undo();
      expect(h.def(session.state).properties[plan.prop]).toBeUndefined();
      expect((h.node(session.state, 'n_head01') as TextNode).text).toBe('Summer hours');
      await session.redo();
      expect((h.node(session.state, 'n_head01') as TextNode).text).toEqual({ $prop: plan.prop });
    } finally {
      await session.close();
    }
  });
});

describe('showing an existing property, and making a field the same everywhere again', () => {
  it('offers the properties whose type fits, and object fields, but not the one already shown', () => {
    const h = heroWithFixedContent();
    let s = apply(h.s, bindNewProperty(h.s, h.def(h.s), h.node(h.s, 'n_head01'), 'text', 'Heading text')!.operations);
    s = apply(s, [{ type: 'component.setPropSchema', definitionId: h.defId, prop: 'cta', schema: { type: 'object', label: 'Call to action', fields: { label: { type: 'string', label: 'Label' }, link: { type: 'link', label: 'Link' } } } }]);
    const def = h.def(s);
    const heading = h.node(s, 'n_head01');
    const choices = bindChoices(s, def, heading, 'text');
    const labels = choices.map((c) => c.label);
    expect(labels).toContain('Call to action → Label');
    expect(labels).not.toContain('Call to action → Link');
    expect(labels).not.toContain('Heading text');
    // No image or link property is offered for text.
    for (const c of choices) {
      const schema = def.properties[c.binding.$prop];
      const type = c.binding.field && schema.type === 'object' ? schema.fields[c.binding.field].type : schema.type;
      expect(['string', 'number', 'enum']).toContain(type);
    }
    // A rich text only takes rich text.
    expect(bindChoices(s, def, h.node(s, 'n_rich01'), 'text').every((c) => def.properties[c.binding.$prop].type === 'richtext')).toBe(true);
    // The hero's picture already shows its only image property, so there is no other to offer.
    expect(bindChoices(s, def, def.tree!.nodes.media, 'image')).toEqual([]);
    expect(bindChoices(s, def, h.node(s, 'n_img001'), 'image').map((c) => c.binding.$prop)).toEqual(['image']);
    // The hero's own text properties are offered, and showing one works.
    const lead = choices.find((c) => c.binding.$prop === 'lead' && c.binding.field === undefined)!;
    expect(lead).toBeTruthy();
    const shown = apply(s, [bindExistingOp(def, 'n_head01', 'text', lead.binding)]);
    expect((h.node(shown, 'n_head01') as TextNode).text).toEqual({ $prop: 'lead' });
    // Rich text is offered rich text properties, never a plain one.
    const withBody = apply(s, [{ type: 'component.setPropSchema', definitionId: h.defId, prop: 'body', schema: { type: 'richtext', label: 'Body' } }]);
    expect(bindChoices(withBody, h.def(withBody), h.node(withBody, 'n_rich01'), 'text').map((c) => c.binding.$prop)).toEqual(['body']);
    const field = choices.find((c) => c.binding.field === 'label')!;
    const t = apply(s, [bindExistingOp(def, 'n_head01', 'text', field.binding)]);
    expect((h.node(t, 'n_head01') as TextNode).text).toEqual({ $prop: 'cta', field: 'label' });
    expect(errors(t)).toEqual([]);
    // A field one object field fills in is not fixed in the design either.
    expect(bindNewProperty(t, h.def(t), h.node(t, 'n_head01'), 'text', 'Heading')).toBeNull();
  });

  it('makes a bound field show its property’s default in every placement, and keeps the property and placement values', () => {
    const hero = forked('hero.split');
    let s = hero.s;
    const [first] = placed(s, hero.defId);
    const own = first.props.heading;
    const def = hero.def(s);
    s = apply(s, [unbindOp(def, 'heading', 'text')]);
    expect((hero.def(s).tree!.nodes.heading as TextNode).text).toBe(def.properties.heading.default);
    expect(hero.def(s).properties.heading).toBeTruthy();
    expect((home(s).nodes[first.id] as InstanceNode).props.heading).toEqual(own);
    expect(designContent(hero.def(s), hero.def(s).tree!.nodes.heading)).toMatchObject([{ field: 'text', source: 'design' }]);
    // Binding it again shows each placement's own value once more.
    s = apply(s, [bindExistingOp(hero.def(s), 'heading', 'text', { $prop: 'heading' })]);
    expect((hero.def(s).tree!.nodes.heading as TextNode).text).toEqual({ $prop: 'heading' });
    expect(errors(s)).toEqual([]);
  });
});

describe('the component’s properties', () => {
  it('renames what authors see without touching names, bindings or a stored value a schema change would rewrite', () => {
    const hero = forked('hero.split');
    const s0 = structuredClone(hero.s);
    const [placement] = placed(s0, hero.defId);
    (home(s0).nodes[placement.id] as InstanceNode).props.lead = '- Shipping';
    const op = renamePropOp(hero.def(s0), 'lead', 'Intro')!;
    const s = apply(s0, [op]);
    expect(hero.def(s).properties.lead.label).toBe('Intro');
    expect((home(s).nodes[placement.id] as InstanceNode).props.lead).toBe('- Shipping');
    expect(hero.def(s).tree!.nodes.lead).toEqual(hero.def(s0).tree!.nodes.lead);
    expect(renamePropOp(hero.def(s), 'lead', 'Intro')).toBeNull();
    expect(renamePropOp(hero.def(s), 'lead', '  ')).toBeNull();
    // A placement holding an icon name today's list no longer has: a full schema write would refuse it.
    const h = heroWithFixedContent();
    const plan = bindNewProperty(h.s, h.def(h.s), h.node(h.s, 'n_icon01'), 'icon', 'Badge')!;
    const withIcon = apply(h.s, plan.operations);
    const [p] = placed(withIcon, h.defId);
    (home(withIcon).nodes[p.id] as InstanceNode).props[plan.prop] = 'retired-icon';
    const renamed = apply(withIcon, [renamePropOp(h.def(withIcon), plan.prop, 'Badge icon')!]);
    expect(h.def(renamed).properties[plan.prop].label).toBe('Badge icon');
    expect((home(renamed).nodes[p.id] as InstanceNode).props[plan.prop]).toBe('retired-icon');
    // Fields in another order are another schema: the full write keeps the new order.
    const withObject = apply(s, [{ type: 'component.setPropSchema', definitionId: hero.defId, prop: 'cta', schema: { type: 'object', label: 'Call to action', fields: { title: { type: 'string', label: 'Title' }, link: { type: 'link', label: 'Link' } } } }]);
    const cta = hero.def(withObject).properties.cta as unknown as { fields: Record<string, unknown> };
    const swapped = { ...cta, fields: { link: cta.fields.link, title: cta.fields.title } };
    const reordered = apply(withObject, [{ type: 'component.setPropSchema', definitionId: hero.defId, prop: 'cta', schema: swapped as Record<string, unknown> }]);
    expect(Object.keys((hero.def(reordered).properties.cta as unknown as { fields: object }).fields)).toEqual(['link', 'title']);
    // A real schema change still goes through the full checks.
    expect(() => applyOperations(s, [{ type: 'component.setPropSchema', definitionId: hero.defId, prop: 'heading', schema: { type: 'image', label: 'Heading' } }])).toThrow(/Unbind it first/);
  });

  it('reorders them, refusing an order that drops, repeats or invents one', () => {
    const hero = forked('hero.split');
    const keys = Object.keys(hero.def(hero.s).properties);
    const shown = placementOrder(hero.def(hero.s));
    const op = movePropOp(hero.def(hero.s), shown[1], -1)!;
    expect(op).toEqual({ type: 'component.orderProperties', definitionId: hero.defId, order: [shown[1], shown[0], ...shown.slice(2)] });
    const s = apply(hero.s, [op]);
    expect(Object.keys(hero.def(s).properties)).toEqual([shown[1], shown[0], ...shown.slice(2)]);
    // Each placement keeps its values.
    expect(placed(s, hero.defId)[0].props).toEqual(placed(hero.s, hero.defId)[0].props);
    expect(movePropOp(hero.def(s), shown[1], -1)).toBeNull();
    expect(movePropOp(hero.def(s), shown[shown.length - 1], 1)).toBeNull();
    const order = (o: string[]) => () => applyOperations(hero.s, [{ type: 'component.orderProperties', definitionId: hero.defId, order: o }]);
    expect(order(keys.slice(1))).toThrow(/leaves out/);
    expect(order([...keys, keys[0]])).toThrow(/twice/);
    expect(order([...keys.slice(0, -1), 'nope'])).toThrow(/no property "nope"/);
    expect(order([...keys.slice(0, -1), 'toString'])).toThrow(/no property "toString"/);
    const theme = Object.values(hero.s.components).find((d) => d.componentId === 'hero.split' && d.owner === 'theme')!;
    expect(() => applyOperations(hero.s, [{ type: 'component.orderProperties', definitionId: theme.id, order: Object.keys(theme.properties) }])).toThrow(/Fork it first/);
  });

  it('lists them as placements do, and offers only moves placements show', () => {
    const hero = forked('hero.split');
    // Listed first in the component, as a theme may list a heading's level beside it.
    const first = ['headingLevel', ...Object.keys(hero.def(hero.s).properties).filter((k) => k !== 'headingLevel')];
    const s = apply(hero.s, [{ type: 'component.orderProperties', definitionId: hero.defId, order: first }]);
    const def = hero.def(s);
    expect(Object.keys(def.properties)[0]).toBe('headingLevel');
    const shown = placementOrder(def);
    // A heading level comes after the content on every placement, wherever the component lists it.
    expect(shown.at(-1)).toBe('headingLevel');
    expect(movePropOp(def, 'headingLevel', -1)).toBeNull();
    expect(movePropOp(def, shown.at(-2)!, 1)).toBeNull();
    // A move within the content puts the properties in the order placements show, with that one moved.
    const op = movePropOp(def, shown[1], -1)!;
    expect(op).toEqual({ type: 'component.orderProperties', definitionId: hero.defId, order: [shown[1], shown[0], ...shown.slice(2)] });
    expect(placementOrder(hero.def(apply(s, [op])))).toEqual([shown[1], shown[0], ...shown.slice(2)]);
  });

  it('keeps the order through save, undo and reopen, and is the editor’s alone', async () => {
    const hero = forked('hero.split');
    const keys = Object.keys(hero.def(hero.s).properties);
    const reversed = [...keys].reverse();
    const dir = mkdtempSync(join(tmpdir(), 'so-contract-'));
    dirs.push(dir);
    const op: EditOperation = { type: 'component.orderProperties', definitionId: hero.defId, order: reversed };
    let session = await ProjectSession.create(dir, hero.s);
    try {
      expect((await session.apply({ operations: [op] }, { label: 'Reorder', source: 'ai' })).ok).toBe(false);
      expect((await session.apply({ operations: [op] }, { label: 'Reorder', source: 'user' })).ok).toBe(true);
      await session.undo();
      expect(Object.keys(session.state.components[hero.defId].properties)).toEqual(keys);
      await session.redo();
    } finally {
      await session.close();
    }
    session = await ProjectSession.open(dir, 'reopen');
    try {
      expect(Object.keys(session.state.components[hero.defId].properties)).toEqual(reversed);
    } finally {
      await session.close();
    }
  });

  it('reorders a component with more properties than a new one may have', () => {
    const hero = forked('hero.split');
    const s = structuredClone(hero.s);
    const def = hero.def(s);
    for (let i = Object.keys(def.properties).length; i < 70; i++) def.properties[`extra${i}`] = { type: 'string', label: `Extra ${i}`, default: '' };
    const op = movePropOp(def, 'extra69', -1)!;
    expect(validateOperation(op)).toMatchObject({ ok: true });
    expect(placementOrder(hero.def(apply(s, [op]))).indexOf('extra69')).toBeLessThan(placementOrder(def).indexOf('extra69'));
  });

  it('names what shows a property, so one still shown is not removed', () => {
    const hero = forked('hero.split');
    // The hero's heading shows it, and shows itself only when it is filled in.
    expect(propertyUses(hero.def(hero.s), 'heading')).toEqual(['Heading visibility', 'Heading text']);
    expect(() => applyOperations(hero.s, [{ type: 'component.removePropSchema', definitionId: hero.defId, prop: 'heading' }])).toThrow(/still shown/);
    const h = heroWithFixedContent();
    const plan = bindNewProperty(h.s, h.def(h.s), h.node(h.s, 'n_head01'), 'text', 'Hours')!;
    let s = apply(h.s, plan.operations);
    const [first] = placed(s, h.defId);
    s = apply(s, [{ type: 'instance.setProp', owner: pageOwner(s), nodeId: first.id, prop: plan.prop, value: 'Winter hours' }]);
    expect(propertyUses(h.def(s), plan.prop)).toEqual(['Heading text']);
    s = apply(s, [unbindOp(h.def(s), 'n_head01', 'text')]);
    expect(propertyUses(h.def(s), plan.prop)).toEqual([]);
    const t = apply(s, [{ type: 'component.removePropSchema', definitionId: h.defId, prop: plan.prop }]);
    expect(h.def(t).properties[plan.prop]).toBeUndefined();
    for (const p of placed(t, h.defId)) expect(Object.hasOwn(p.props, plan.prop)).toBe(false);
    expect(errors(t)).toEqual([]);
  });
});

describe('the Required switch of a property or one of its fields', () => {
  /** A new component with every kind of property, placed twice on Home: the second with its own values emptied. */
  function pricing() {
    const s0 = createStarterState('blank', 'Required', false);
    const made = applyOperations(s0, [{ type: 'component.create', name: 'Pricing switch' }]);
    const defId = made.results[0].definitionId as string;
    const properties: Record<string, Record<string, unknown>> = {
      monthly: { type: 'string', label: 'Monthly label', default: 'Monthly' },
      annual: { type: 'string', label: 'Annual label', default: 'Annual' },
      count: { type: 'number', label: 'Count', default: 1 },
      shown: { type: 'boolean', label: 'Shown', default: true },
      accent: { type: 'token', label: 'Accent', tokenGroup: 'color' },
      badge: { type: 'icon', label: 'Badge' },
      size: { type: 'enum', label: 'Size', options: ['small', 'large'], default: 'small' },
      mark: { type: 'enum', label: 'Mark', options: [{ value: '', label: 'None' }, 'star'], default: '' },
      plans: { type: 'list', label: 'Plans', itemLabel: 'Plan', fields: { name: { type: 'string', label: 'Name', default: 'Plan' }, featured: { type: 'boolean', label: 'Featured' } }, default: [{ name: 'Basic' }, { name: 'Pro' }] },
      news: { type: 'list', label: 'News', itemLabel: 'Article', feed: 'articles', fields: { title: { type: 'string', label: 'Title' } } },
      pages: { type: 'list', label: 'Pages', itemLabel: 'Card', pageTeaser: { link: 'link', title: 'title' }, fields: { link: { type: 'link', label: 'Link' }, title: { type: 'string', label: 'Title' }, note: { type: 'string', label: 'Note' } } },
      action: { type: 'object', label: 'Action', fields: { label: { type: 'string', label: 'Label', default: 'Go' }, link: { type: 'link', label: 'Link' } } },
      flagged: { type: 'object', label: 'Flagged', fields: { label: { type: 'string', label: 'Label' }, on: { type: 'boolean', label: 'On' } } }
    };
    let s = made.state;
    for (const [prop, schema] of Object.entries(properties)) s = applyOperations(s, [{ type: 'component.setPropSchema', definitionId: defId, prop, schema }]).state;
    const owner = pageOwner(s);
    s = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, definitionId: defId }]).state;
    s = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, definitionId: defId }]).state;
    const [, second] = placed(s, defId);
    const plans = second.props.plans as Array<{ id: string }>;
    s = apply(s, [
      { type: 'instance.setProp', owner, nodeId: second.id, prop: 'monthly', value: ' ' },
      { type: 'instance.setProp', owner, nodeId: second.id, prop: 'plans', itemId: plans[0].id, field: 'name', value: '' },
      { type: 'instance.setProp', owner, nodeId: second.id, prop: 'plans', itemId: plans[1].id, field: 'name', value: '' }
    ]);
    return { s, defId, def: (st: ProjectState) => st.components[defId], second: second.id };
  }

  it('is offered only where a value can be empty, and on every field of a list or an object the author fills in', () => {
    const { s, def } = pricing();
    const d = def(s);
    const offered = Object.keys(d.properties).filter((p) => canRequire(d.properties[p]));
    expect(offered).toEqual(['monthly', 'annual', 'mark', 'plans', 'action']);
    // A yes/no field, a computed list's fields and a page list's fields that follow the linked page never are.
    expect(requirableFields(d.properties.plans).map(([k]) => [k, canRequire(d.properties.plans, k)])).toEqual([['name', true], ['featured', false]]);
    expect(requirableFields(d.properties.news)).toEqual([]);
    expect(requirableFields(d.properties.pages).map(([k]) => [k, canRequire(d.properties.pages, k)])).toEqual([['link', true], ['title', false], ['note', true]]);
    expect(requirableFields(d.properties.action).map(([k]) => [k, canRequire(d.properties.action, k)])).toEqual([['label', true], ['link', true]]);
    expect(canRequire(d.properties.monthly, 'nope')).toBe(false);
    for (const p of ['count', 'shown', 'accent', 'badge', 'size', 'news', 'pages', 'flagged']) expect(setRequiredOp(d, p, undefined, true)).toBeNull();
  });

  it('plans one schema change touching only the flag, counts the placements left missing it, and never refuses them', () => {
    const { s, def, second } = pricing();
    const op = setRequiredOp(def(s), 'monthly', undefined, true)!;
    expect(op).toEqual({ type: 'component.setPropSchema', definitionId: def(s).id, prop: 'monthly', schema: { ...def(s).properties.monthly, required: true } });
    expect(placementsMissing(s, def(s), 'monthly')).toBe(1);
    const on = apply(s, [op]);
    expect(isRequired(def(on).properties.monthly)).toBe(true);
    // The emptied value stays, reported, never in the way of saving.
    expect((home(on).nodes[second] as InstanceNode).props.monthly).toBe(' ');
    expect(errors(on)).toEqual([]);
    expect(requiredProblems(on).map((p) => p.nodeId)).toEqual([second]);
    expect(setRequiredOp(def(on), 'monthly', undefined, true)).toBeNull();
    const off = apply(on, [setRequiredOp(def(on), 'monthly', undefined, false)!]);
    expect(def(off).properties.monthly).toEqual(def(s).properties.monthly);
    expect(requiredProblems(off)).toEqual([]);
  });

  it('marks one field of a list, counting a placement missing it in several items once', () => {
    const { s, def, second } = pricing();
    expect(placementsMissing(s, def(s), 'plans', 'name')).toBe(1);
    // The list itself has items everywhere.
    expect(placementsMissing(s, def(s), 'plans')).toBe(0);
    const op = setRequiredOp(def(s), 'plans', 'name', true)!;
    const plans = def(s).properties.plans as Extract<ComponentDefinition['properties'][string], { type: 'list' }>;
    expect(op).toMatchObject({ schema: { fields: { name: { ...plans.fields.name, required: true }, featured: plans.fields.featured } } });
    expect(plans.fields.name.required).toBeUndefined();
    const on = apply(s, [op]);
    expect(isRequired(def(on).properties.plans, 'name')).toBe(true);
    expect(isRequired(def(on).properties.plans)).toBe(false);
    expect(requiredProblems(on).map((p) => [p.nodeId, p.message])).toEqual([
      [second, 'Home: Pricing switch → Plans → Plan 1 → Name is required: it needs some text.'],
      [second, 'Home: Pricing switch → Plans → Plan 2 → Name is required: it needs some text.']
    ]);
    expect(setRequiredOp(def(on), 'plans', 'featured', true)).toBeNull();
    expect(setRequiredOp(def(on), 'plans', 'name', false)).toMatchObject({ schema: { fields: { name: plans.fields.name } } });
  });

  it('lets a switch already on be turned off where it could not be turned on (a hand edit)', () => {
    const { s, def } = pricing();
    const edited = structuredClone(s);
    (def(edited).properties.count as { required?: boolean }).required = true;
    expect(canRequire(def(edited).properties.count)).toBe(false);
    expect(setRequiredOp(def(edited), 'count', undefined, false)).toMatchObject({ prop: 'count', schema: { type: 'number' } });
    expect((setRequiredOp(def(edited), 'count', undefined, false) as { schema: Record<string, unknown> }).schema).not.toHaveProperty('required');
  });
});

describe('parts each placement styles', () => {
  it('exposes an element as a named part, renames it keeping its controls, and removes it', () => {
    const h = heroWithFixedContent();
    const def = h.def(h.s);
    const root = def.tree!.nodes[def.tree!.rootIds[0]];
    expect(canExposePart(def, root)).toBe(false);
    const heading = h.node(h.s, 'n_head01');
    expect(canExposePart(def, heading)).toBe(true);
    let s = apply(h.s, [exposePartOp(h.s, def, heading, 'Hours')]);
    expect(h.def(s).parts.hours).toMatchObject({ nodeId: 'n_head01', label: 'Hours' });
    expect(canExposePart(h.def(s), h.node(s, 'n_head01'))).toBe(false);
    // A second part by the same name gets a name of its own.
    const second = exposePartOp(s, h.def(s), h.node(s, 'n_para01'), 'Hours');
    expect(second).toMatchObject({ partId: 'hours2', label: 'Hours' });
    // Custom controls survive a rename.
    s = apply(s, [{ type: 'component.setPart', definitionId: h.defId, partId: 'hours', nodeId: 'n_head01', label: 'Hours', styleControls: ['color'] }]);
    s = apply(s, [renamePartOp(h.def(s), 'hours', 'Opening hours')!]);
    expect(h.def(s).parts.hours).toEqual({ nodeId: 'n_head01', label: 'Opening hours', styleControls: ['color'] });
    // A placement styles it; removing the part removes those styles with it.
    const [first] = placed(s, h.defId);
    s = apply(s, [{ type: 'node.setStyle', owner: pageOwner(s), nodeId: first.id, partId: 'hours', scope: 'base', property: 'color', value: '#ff0000' }]);
    expect((home(s).nodes[first.id] as InstanceNode).overrides?.hours).toBeTruthy();
    s = apply(s, [{ type: 'component.removePart', definitionId: h.defId, partId: 'hours' }]);
    expect(h.def(s).parts.hours).toBeUndefined();
    expect((home(s).nodes[first.id] as InstanceNode).overrides?.hours).toBeUndefined();
  });
});

describe('names older documents use', () => {
  it('renames a property, part or option whose name today’s rules would not give a new one', () => {
    const h = heroWithFixedContent();
    const s = structuredClone(h.s);
    const def = h.def(s);
    def.properties.Hero_Title = { type: 'string', label: 'Hero title', default: '' };
    def.parts['card-title'] = { nodeId: 'n_head01', label: 'Card title' };
    def.variantAxes = { ...def.variantAxes, mood: { label: 'Mood', default: '2Col', options: { '2Col': { label: 'Two columns' }, plain: { label: 'Plain' } } } };
    let t = apply(s, [renamePropOp(def, 'Hero_Title', 'Title')!, renamePartOp(def, 'card-title', 'Title')!, renameVariantOp(def, 'mood', '2Col', 'Wide')!]);
    expect(h.def(t).properties.Hero_Title.label).toBe('Title');
    expect(h.def(t).parts['card-title'].label).toBe('Title');
    expect(h.def(t).variantAxes!.mood.options['2Col'].label).toBe('Wide');
    t = apply(t, [renameVariantGroupOp(h.def(t), 'mood', 'Layout mood')!, defaultVariantOp(h.def(t), 'mood', 'plain')!]);
    expect(h.def(t).variantAxes!.mood.default).toBe('plain');
    t = apply(t, [defaultVariantOp(h.def(t), 'mood', '2Col')!]);
    expect(h.def(t).variantAxes!.mood).toMatchObject({ label: 'Layout mood', default: '2Col' });
    // A new one still needs a plain name.
    expect(() => applyOperations(t, [{ type: 'component.setPart', definitionId: h.defId, partId: 'new-part', nodeId: 'n_para01', label: 'X' }])).toThrow(/camelCase/);
    expect(() => applyOperations(t, [{ type: 'component.setVariant', definitionId: h.defId, axis: 'mood', variant: '3Col', label: 'X' }])).toThrow(/lowercase/);
  });

  it('never gives a new part or choice a name a placement still keeps styles or a choice under', () => {
    const h = heroWithFixedContent();
    const s = structuredClone(h.s);
    const [first] = placed(s, h.defId);
    const p = home(s).nodes[first.id] as InstanceNode;
    p.overrides = { ...p.overrides, badge: { base: { color: '#ff0000' } } };
    p.variants = { ...p.variants, mood: 'dark' };
    expect(exposePartOp(s, h.def(s), h.node(s, 'n_head01'), 'Badge')).toMatchObject({ partId: 'badge2' });
    p.itemOverrides = { ribbon: { list: 'items', items: {} } } as InstanceNode['itemOverrides'];
    expect(exposePartOp(s, h.def(s), h.node(s, 'n_head01'), 'Ribbon')).toMatchObject({ partId: 'ribbon2' });
    expect(addVariantGroupOp(s, h.def(s), 'Mood', 'Dark')).toMatchObject({ axis: 'mood2', variant: 'dark' });
    const t = apply(h.s, [addVariantGroupOp(h.s, h.def(h.s), 'Mood', 'Plain')]);
    const u = structuredClone(t);
    ((home(u).nodes[first.id] as InstanceNode).variants ??= {}).mood = 'dark';
    expect(addVariantOp(u, h.def(u), 'mood', 'Dark')).toMatchObject({ variant: 'dark-2' });
  });
});

describe('variants placements choose between', () => {
  it('adds a choice with a default every placement keeps, options, renames, a new default and removal', () => {
    const h = heroWithFixedContent();
    const had = axesOf(h.def(h.s)).map(([a]) => a);
    let s = apply(h.s, [addVariantGroupOp(h.s, h.def(h.s), 'Mood', 'Dark')]);
    const tone = axesOf(h.def(s)).find(([a]) => !had.includes(a))!;
    expect(tone[0]).toBe('mood');
    expect(tone[1]).toMatchObject({ label: 'Mood', default: 'default', options: { default: { label: 'Default' }, dark: { label: 'Dark' } } });
    for (const p of placed(s, h.defId)) expect(p.variants?.mood).toBeUndefined();
    s = apply(s, [addVariantOp(s, h.def(s), 'mood', 'Dark')!]);
    expect(Object.keys(h.def(s).variantAxes!.mood.options)).toEqual(['default', 'dark', 'dark-2']);
    // A styled option keeps its styles through a rename and a new default.
    s = apply(s, [{ type: 'node.setStyle', owner: { kind: 'component', id: h.defId }, nodeId: 'n_head01', variant: 'dark-2', axis: 'mood', scope: 'base', property: 'color', value: '#ffffff' }]);
    s = apply(s, [renameVariantOp(h.def(s), 'mood', 'dark-2', 'Midnight')!, renameVariantGroupOp(h.def(s), 'mood', 'Feel')!]);
    expect(h.def(s).variantAxes!.mood.options['dark-2'].styles).toEqual({ n_head01: { base: { color: '#ffffff' } } });
    expect(h.def(s).variantAxes!.mood).toMatchObject({ label: 'Feel', options: { 'dark-2': { label: 'Midnight' }, default: { label: 'Default' } } });
    s = apply(s, [defaultVariantOp(h.def(s), 'mood', 'dark-2')!, defaultVariantOp(h.def(s), 'mood', 'dark')!]);
    expect(h.def(s).variantAxes!.mood.default).toBe('dark');
    expect(h.def(s).variantAxes!.mood.options['dark-2'].styles).toEqual({ n_head01: { base: { color: '#ffffff' } } });
    // A placement that chose an option goes back to the default when it is removed.
    const [first] = placed(s, h.defId);
    s = apply(s, [{ type: 'instance.setVariant', owner: pageOwner(s), nodeId: first.id, axis: 'mood', variant: 'dark-2' }]);
    s = apply(s, [removeVariantOp(h.def(s), 'mood', 'dark-2')]);
    expect(h.def(s).variantAxes!.mood.options['dark-2']).toBeUndefined();
    expect((home(s).nodes[first.id] as InstanceNode).variants?.mood).toBeUndefined();
    expect(errors(s)).toEqual([]);
  });

  it('never names a new option "default" or an inherited key, and finds a free choice name', () => {
    const h = heroWithFixedContent();
    expect(addVariantGroupOp(h.s, h.def(h.s), 'Default', 'Default')).toMatchObject({ axis: 'style', variant: 'default-2', label: 'Default' });
    let s = apply(h.s, [addVariantGroupOp(h.s, h.def(h.s), 'Mood', 'Constructor')]);
    expect(Object.keys(h.def(s).variantAxes!.mood.options)).toContain('constructor-2');
    s = apply(s, [addVariantGroupOp(s, h.def(s), 'Mood', '123 Bold!')]);
    expect(h.def(s).variantAxes!.mood2.options).toHaveProperty('bold');
    // Not on a choice whose default option was removed either.
    s = apply(s, [removeVariantOp(h.def(s), 'mood', 'default')]);
    expect(addVariantOp(s, h.def(s), 'mood', 'Default')).toMatchObject({ variant: 'default-2' });
    expect(addVariantOp(s, h.def(s), 'mood', 'Prototype')).toMatchObject({ variant: 'prototype-2' });
    // Long names collide within 40 characters.
    const long = 'A very long option name that goes on and on';
    s = apply(s, [addVariantOp(s, h.def(s), 'mood', long)!]);
    const again = addVariantOp(s, h.def(s), 'mood', long)! as { variant: string };
    expect(again.variant.length).toBeLessThanOrEqual(40);
    expect(Object.keys(h.def(s).variantAxes!.mood.options)).not.toContain(again.variant);
    s = apply(s, [again as EditOperation]);
    expect(errors(s)).toEqual([]);
  });

  it('styles one option of one element, which only placements showing it get, and clears it', () => {
    const h = heroWithFixedContent();
    let s = apply(h.s, [addVariantGroupOp(h.s, h.def(h.s), 'Mood', 'Dark')]);
    const heading = h.node(s, 'n_head01');
    expect(variantStylable(h.def(s), heading)).toBe(true);
    const grid = forked('features.grid');
    const repeat = Object.values(grid.def(grid.s).tree!.nodes).find((n) => n.kind === 'repeat')!;
    expect(variantStylable(grid.def(grid.s), repeat)).toBe(false);
    expect(variantStylable(grid.def(grid.s), grid.def(grid.s).tree!.nodes.card)).toBe(true);
    const o = { kind: 'component' as const, id: h.defId };
    s = apply(s, [{ type: 'node.setStyle', owner: o, nodeId: 'n_head01', variant: 'dark', axis: 'mood', scope: 'base', property: 'color', value: '#ffffff' }]);
    expect(h.def(s).variantAxes!.mood.options.dark.styles).toEqual({ n_head01: { base: { color: '#ffffff' } } });
    // The base design is unchanged.
    expect(h.node(s, 'n_head01').styles?.base?.color).toBeUndefined();
    s = apply(s, [{ type: 'node.resetStyles', owner: o, nodeId: 'n_head01', variant: 'dark', axis: 'mood', scope: 'base' }]);
    expect(h.def(s).variantAxes!.mood.options.dark.styles).toBeUndefined();
  });

  it('falls back to the base design when the option styled is gone', () => {
    const h = heroWithFixedContent();
    const s = apply(h.s, [addVariantGroupOp(h.s, h.def(h.s), 'Mood', 'Dark')]);
    expect(liveStyleTarget(h.def(s), { axis: 'mood', variant: 'dark' })).toEqual({ axis: 'mood', variant: 'dark' });
    // An option of that name on another choice is not the one styled.
    expect(liveStyleTarget(h.def(s), { axis: 'tone', variant: 'dark' })).toBeNull();
    const t = apply(s, [removeVariantOp(h.def(s), 'mood', 'dark')]);
    expect(liveStyleTarget(h.def(t), { axis: 'mood', variant: 'dark' })).toBeNull();
    expect(liveStyleTarget(h.def(t), null)).toBeNull();
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
