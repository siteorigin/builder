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
  defaultVariantOp,
  exposePartOp,
  liveStyleTarget,
  movePropOp,
  newPropSchema,
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
    { type: 'node.insert', owner: o, parentId: root, primitive: 'richtext', newNodeId: 'n_rich01' }
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
    const btn = h.node(h.s, 'n_btn001');
    expect(suggestedPropLabel(def, btn, 'label')).toBe('Button label');
    expect(suggestedPropLabel(def, btn, 'link')).toBe('Button link');
    // The hero already has a property called Heading.
    expect(suggestedPropLabel(def, h.node(h.s, 'n_head01'), 'text')).toBe('Heading 2');
    expect(suggestedPropLabel(def, h.node(h.s, 'n_icon01'), 'icon')).toBe('Icon');

    // Each one binds, validates and saves.
    let s = h.s;
    for (const [id, field] of [
      ['n_para01', 'text'],
      ['n_rich01', 'text'],
      ['n_btn001', 'label'],
      ['n_btn001', 'link'],
      ['n_icon01', 'icon']
    ] as const) {
      const node = h.node(s, id);
      const shown = (node as unknown as Record<string, unknown>)[field];
      const plan = bindNewProperty(s, h.def(s), node, field, suggestedPropLabel(h.def(s), node, field))!;
      s = apply(s, plan.operations);
      const schema = h.def(s).properties[plan.prop];
      if (field === 'text' && id === 'n_rich01') expect(schema.type).toBe('richtext');
      else if (field === 'link') expect(schema.default).toEqual(shown ?? { type: 'none', target: '' });
      else expect(schema.default).toEqual(shown);
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
    s = apply(s, bindNewProperty(s, h.def(s), h.node(s, 'n_head01'), 'text', 'Default')!.operations);
    expect(errors(s)).toEqual([]);
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
    // The image field of the hero offers its image property.
    expect(bindChoices(s, def, def.tree!.nodes.media, 'image')).toEqual([]);
    const lead = bindChoices(s, def, heading, 'text').find((c) => c.binding.$prop === 'lead');
    if (lead) {
      const t = apply(s, [bindExistingOp(def, 'n_head01', 'text', lead.binding)]);
      expect((h.node(t, 'n_head01') as TextNode).text).toEqual({ $prop: 'lead' });
    }
    const field = choices.find((c) => c.binding.field === 'label')!;
    const t = apply(s, [bindExistingOp(def, 'n_head01', 'text', field.binding)]);
    expect((h.node(t, 'n_head01') as TextNode).text).toEqual({ $prop: 'cta', field: 'label' });
    expect(errors(t)).toEqual([]);
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
    // A real schema change still goes through the full checks.
    expect(() => applyOperations(s, [{ type: 'component.setPropSchema', definitionId: hero.defId, prop: 'heading', schema: { type: 'image', label: 'Heading' } }])).toThrow(/Unbind it first/);
  });

  it('reorders them, refusing an order that drops, repeats or invents one', () => {
    const hero = forked('hero.split');
    const keys = Object.keys(hero.def(hero.s).properties);
    const op = movePropOp(hero.def(hero.s), keys[1], -1)!;
    expect(op).toEqual({ type: 'component.orderProperties', definitionId: hero.defId, order: [keys[1], keys[0], ...keys.slice(2)] });
    const s = apply(hero.s, [op]);
    expect(Object.keys(hero.def(s).properties)).toEqual([keys[1], keys[0], ...keys.slice(2)]);
    // Each placement keeps its values.
    expect(placed(s, hero.defId)[0].props).toEqual(placed(hero.s, hero.defId)[0].props);
    expect(movePropOp(hero.def(s), keys[1], -1)).toBeNull();
    expect(movePropOp(hero.def(s), keys[keys.length - 1], 1)).toBeNull();
    const order = (o: string[]) => () => applyOperations(hero.s, [{ type: 'component.orderProperties', definitionId: hero.defId, order: o }]);
    expect(order(keys.slice(1))).toThrow(/leaves out/);
    expect(order([...keys, keys[0]])).toThrow(/twice/);
    expect(order([...keys.slice(0, -1), 'nope'])).toThrow(/no property "nope"/);
    expect(order([...keys.slice(0, -1), 'toString'])).toThrow(/no property "toString"/);
    const theme = Object.values(hero.s.components).find((d) => d.componentId === 'hero.split' && d.owner === 'theme')!;
    expect(() => applyOperations(hero.s, [{ type: 'component.orderProperties', definitionId: theme.id, order: Object.keys(theme.properties) }])).toThrow(/Fork it first/);
  });

  it('keeps the order through save and reopen', () => {
    const hero = forked('hero.split');
    const keys = Object.keys(hero.def(hero.s).properties);
    const reversed = [...keys].reverse();
    const s = apply(hero.s, [{ type: 'component.orderProperties', definitionId: hero.defId, order: reversed }]);
    expect(Object.keys(JSON.parse(JSON.stringify(hero.def(s))).properties)).toEqual(reversed);
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

describe('parts each placement styles', () => {
  it('exposes an element as a named part, renames it keeping its controls, and removes it', () => {
    const h = heroWithFixedContent();
    const def = h.def(h.s);
    const root = def.tree!.nodes[def.tree!.rootIds[0]];
    expect(canExposePart(def, root)).toBe(false);
    const heading = h.node(h.s, 'n_head01');
    expect(canExposePart(def, heading)).toBe(true);
    let s = apply(h.s, [exposePartOp(def, heading, 'Hours')]);
    expect(h.def(s).parts.hours).toMatchObject({ nodeId: 'n_head01', label: 'Hours' });
    expect(canExposePart(h.def(s), h.node(s, 'n_head01'))).toBe(false);
    // A second part by the same name gets a name of its own.
    const second = exposePartOp(h.def(s), h.node(s, 'n_para01'), 'Hours');
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

describe('variants placements choose between', () => {
  it('adds a choice with a default every placement keeps, options, renames, a new default and removal', () => {
    const h = heroWithFixedContent();
    const had = axesOf(h.def(h.s)).map(([a]) => a);
    let s = apply(h.s, [addVariantGroupOp(h.def(h.s), 'Mood', 'Dark')]);
    const tone = axesOf(h.def(s)).find(([a]) => !had.includes(a))!;
    expect(tone[0]).toBe('mood');
    expect(tone[1]).toMatchObject({ label: 'Mood', default: 'default', options: { default: { label: 'Default' }, dark: { label: 'Dark' } } });
    for (const p of placed(s, h.defId)) expect(p.variants?.mood).toBeUndefined();
    s = apply(s, [addVariantOp(h.def(s), 'mood', 'Dark')!]);
    expect(Object.keys(h.def(s).variantAxes!.mood.options)).toEqual(['default', 'dark', 'dark-2']);
    s = apply(s, [renameVariantOp(h.def(s), 'mood', 'dark-2', 'Midnight')!, renameVariantGroupOp(h.def(s), 'mood', 'Feel')!]);
    expect(h.def(s).variantAxes!.mood).toMatchObject({ label: 'Feel', options: { 'dark-2': { label: 'Midnight' }, default: { label: 'Default' } } });
    s = apply(s, [defaultVariantOp(h.def(s), 'mood', 'dark')!]);
    expect(h.def(s).variantAxes!.mood.default).toBe('dark');
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
    expect(addVariantGroupOp(h.def(h.s), 'Default', 'Default')).toMatchObject({ axis: 'style', variant: 'default-2', label: 'Default' });
    let s = apply(h.s, [addVariantGroupOp(h.def(h.s), 'Mood', 'Constructor')]);
    expect(Object.keys(h.def(s).variantAxes!.mood.options)).toContain('constructor-2');
    s = apply(s, [addVariantGroupOp(h.def(s), 'Mood', '123 Bold!')]);
    expect(h.def(s).variantAxes!.mood2.options).toHaveProperty('bold');
    expect(errors(s)).toEqual([]);
  });

  it('styles one option of one element, which only placements showing it get, and clears it', () => {
    const h = heroWithFixedContent();
    let s = apply(h.s, [addVariantGroupOp(h.def(h.s), 'Mood', 'Dark')]);
    const heading = h.node(s, 'n_head01');
    expect(variantStylable(h.def(s), heading)).toBe(true);
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
    const s = apply(h.s, [addVariantGroupOp(h.def(h.s), 'Mood', 'Dark')]);
    expect(liveStyleTarget(h.def(s), { axis: 'mood', variant: 'dark' })).toEqual({ axis: 'mood', variant: 'dark' });
    const t = apply(s, [removeVariantOp(h.def(s), 'mood', 'dark')]);
    expect(liveStyleTarget(h.def(t), { axis: 'mood', variant: 'dark' })).toBeNull();
    expect(liveStyleTarget(h.def(t), null)).toBeNull();
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
