/**
 * Repeat as list… (#369): a static card of a managed component's design becomes the item of a new list property, a
 * repeat over it where the card was, and each of the card's content values bound to an item field, in one change.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, InstanceNode, ListItem, ListProp, ProjectState, RepeatNode } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { blocksSaving, validateState } from '@engine/validate';
import { defFile, generateProject } from '@generator/index';
import { P, prop, type ComponentSpec } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { ProjectSession } from '../../src/main/project/session';
import { STARTER_ITEMS, planRepeatAsList, repeatAsListProblem, repeatAsListTarget, type RepeatPlan } from '../../src/renderer/src/lib/repeat-as-list';

const { managed } = FOUNDATION;
const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);

function addDef(s: ProjectState, spec: Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'>): ComponentDefinition {
  const def = { ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', ...spec }), owner: 'project' as const };
  s.components[def.id] = def;
  return def;
}

function place(s: ProjectState, def: ComponentDefinition): InstanceNode {
  const node = makeInstance(def, {});
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return node;
}

const LINK = { type: 'url' as const, target: 'https://example.com/learn', newTab: true };

/** A features section whose grid holds one static card (icon, heading, paragraph, button) between two others. */
function features(s: ProjectState, extra: Partial<Omit<ComponentSpec, 'build'>> = {}) {
  return addDef(s, {
    componentId: 'test.features',
    name: 'Features',
    properties: { heading: P.str('Heading', 'Why us'), cta: P.str('Call to action', 'Learn more') },
    parts: { root: { nodeId: 'root', label: 'Section' }, card: { nodeId: 'card', label: 'Card' } },
    ...extra,
    build: (b) =>
      b.el('root', 'section', {}, [
        b.text('heading', 'h2', prop('heading')),
        b.el('grid', 'div', { styles: { layout: 'grid', columns: 3 } }, [
          b.text('before', 'p', 'Before'),
          b.el('card', 'div', { name: 'Card', styles: { padding: { token: 'space.md' } } }, [
            b.icon('card-icon', 'sparkles'),
            b.text('card-title', 'h3', 'Fast setup'),
            b.text('card-body', 'p', 'Up and running in minutes.'),
            b.link('card-link', LINK, 'Read more', 'secondary')
          ]),
          b.text('after', 'p', 'After')
        ])
      ])
  });
}

const plan = (s: ProjectState, def: ComponentDefinition, nodeId: string, opts: Parameters<typeof planRepeatAsList>[3] = {}): RepeatPlan => {
  const p = planRepeatAsList(s, def, nodeId, opts);
  if ('problem' in p) throw new Error(p.problem);
  return p;
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('Repeat as list turns a static card into a repeated list', () => {
  it('creates the list, wraps the card in a repeat where it was, binds its content and seeds every placement', () => {
    const s = fresh();
    const def = features(s);
    const a = place(s, def);
    const b = place(s, def);
    const p = plan(s, def, 'card');

    expect(p.prop).toBe('cards');
    expect(p.label).toBe('Cards');
    expect(p.itemLabel).toBe('Card');
    expect(p.fields.map((f) => [f.nodeId, f.field, f.name])).toEqual([
      ['card-icon', 'icon', 'icon'],
      ['card-title', 'text', 'title'],
      ['card-body', 'text', 'description'],
      ['card-link', 'label', 'label'],
      ['card-link', 'link', 'link']
    ]);
    expect(p.items).toHaveLength(STARTER_ITEMS);

    const after = applyOperations(s, p.operations).state;
    expect(errors(after)).toEqual([]);
    const d = after.components[def.id];
    const tree = d.tree!;
    // The repeat takes the card's place among its siblings and holds the same card, so its part and styles stay.
    expect((tree.nodes.grid as { children: string[] }).children).toEqual(['before', p.repeatId, 'after']);
    const repeat = tree.nodes[p.repeatId] as RepeatNode;
    expect(repeat).toMatchObject({ kind: 'repeat', list: { $prop: 'cards' }, children: ['card'] });
    expect(d.parts.card.nodeId).toBe('card');
    expect(tree.nodes.card.styles).toEqual(def.tree!.nodes.card.styles);
    expect(tree.nodes['card-icon']).toMatchObject({ icon: { $item: 'icon' } });
    expect(tree.nodes['card-title']).toMatchObject({ text: { $item: 'title' }, tag: 'h3' });
    expect(tree.nodes['card-body']).toMatchObject({ text: { $item: 'description' } });
    expect(tree.nodes['card-link']).toMatchObject({ label: { $item: 'label' }, link: { $item: 'link' }, appearance: 'secondary' });

    const list = d.properties.cards as ListProp;
    expect(list).toMatchObject({ type: 'list', label: 'Cards', itemLabel: 'Card', titleField: 'title' });
    expect(Object.fromEntries(Object.entries(list.fields).map(([k, f]) => [k, f.type]))).toEqual({ icon: 'icon', title: 'string', description: 'string', label: 'string', link: 'link' });
    // Every starter item starts from the card's own content, under its own ID.
    expect(list.default).toHaveLength(STARTER_ITEMS);
    expect(new Set(list.default.map((it) => it.id)).size).toBe(STARTER_ITEMS);
    for (const it of list.default) expect(it).toMatchObject({ icon: 'sparkles', title: 'Fast setup', description: 'Up and running in minutes.', label: 'Read more', link: LINK });

    // Each existing placement has its own copy of the items, no ID shared with the defaults or the other placement.
    const itemsOf = (n: InstanceNode) => (home(after).nodes[n.id] as InstanceNode).props.cards as ListItem[];
    const ids = [...list.default, ...itemsOf(a), ...itemsOf(b)].map((it) => it.id);
    expect(itemsOf(a)).toHaveLength(STARTER_ITEMS);
    expect(itemsOf(b)).toHaveLength(STARTER_ITEMS);
    expect(new Set(ids).size).toBe(ids.length);

    // Each placement hands its own items to the component, which renders the card once per item.
    const page = generateProject(after).get('src/routes/+page.svelte')!;
    expect(page.split('Fast setup').length - 1).toBe(2 * STARTER_ITEMS);
    const component = generateProject(after).get(defFile(d))!;
    expect(component).toMatch(/\{#each [^}]*cards[^}]* as item \(item\.id\)\}/);
  });

  it('lets one placement edit one item without touching the others', () => {
    let s = fresh();
    const def = features(s);
    const a = place(s, def);
    const b = place(s, def);
    s = applyOperations(s, plan(s, def, 'card').operations).state;
    const itemsOf = (st: ProjectState, n: InstanceNode) => (home(st).nodes[n.id] as InstanceNode).props.cards as ListItem[];
    const second = itemsOf(s, a)[1];
    s = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: s.site.homePageId }, nodeId: a.id, prop: 'cards', itemId: second.id, field: 'title', value: 'Friendly support' }]).state;
    expect(itemsOf(s, a).map((it) => it.title)).toEqual(['Fast setup', 'Friendly support', 'Fast setup']);
    expect(itemsOf(s, b).map((it) => it.title)).toEqual(['Fast setup', 'Fast setup', 'Fast setup']);
    expect(errors(s)).toEqual([]);
  });

  it('undoes in one step, back to the one static card and placements without the list', async () => {
    const s = fresh();
    const def = features(s);
    const a = place(s, def);
    const dir = mkdtempSync(join(tmpdir(), 'so-repeat-list-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, s);
    try {
      const before = structuredClone(session.state);
      const p = plan(session.state, session.state.components[def.id], 'card');
      const res = await session.apply({ operations: p.operations }, { label: 'Repeat Card as list', source: 'user' });
      expect(res.ok).toBe(true);
      expect(session.state.components[def.id].tree!.nodes[p.repeatId]?.kind).toBe('repeat');
      expect(Object.hasOwn((session.state.pages[s.site.homePageId].nodes[a.id] as InstanceNode).props, 'cards')).toBe(true);
      await session.undo();
      expect(session.state.components[def.id]).toEqual(before.components[def.id]);
      expect(session.state.pages[s.site.homePageId]).toEqual(before.pages[s.site.homePageId]);
    } finally {
      await session.close();
    }
  });

  it('applies nothing when any step of the change is refused', () => {
    const s = fresh();
    const def = features(s);
    place(s, def);
    const p = plan(s, def, 'card');
    const ops = structuredClone(p.operations);
    // The last binding names a field the list doesn't have.
    (ops[ops.length - 1] as { binding: unknown }).binding = { $item: 'nope' };
    expect(() => applyOperations(s, ops)).toThrow(/no field "nope"/);
    expect(s.components[def.id].properties.cards).toBeUndefined();
    expect(s.components[def.id].tree!.nodes[p.repeatId]).toBeUndefined();
  });

  it('names fields by what they are, numbers repeats of a kind, and keeps rich text, images and card links whole', () => {
    const pic = { id: 'a_pic', name: 'Pic', file: 'static/assets/pic.png', mime: 'image/png', bytes: 10, hash: 'h', kind: 'image' as const, createdAt: 'now' };
    const s = applyOperations(fresh(), [{ type: 'asset.add', asset: pic }]).state;
    const def = addDef(s, {
      componentId: 'test.team',
      name: 'Team',
      properties: { role: P.str('Role', 'Founder') },
      parts: {},
      build: (b) =>
        b.el('root', 'section', {}, [
          b.el('row', 'div', {}, [
            b.el('member', 'article', { link: { type: 'url', target: 'https://example.com/ada' } }, [
              b.image('photo', { assetId: pic.id, alt: 'Ada at her desk' }),
              b.text('name', 'h3', 'Ada'),
              b.text('nick', 'h4', 'The Countess'),
              b.rich('bio', ['Wrote the first program.']),
              b.text('role', 'p', prop('role'))
            ])
          ])
        ])
    });
    const p = plan(s, def, 'member');
    expect(p.label).toBe('Items');
    expect(p.itemLabel).toBe('Item');
    // The rich text stays in the design: bound to an item it could hold links, inside a card that links somewhere.
    expect(p.shared).toBe(2);
    expect(p.fields.map((f) => [f.name, f.schema.type])).toEqual([
      ['link', 'link'],
      ['image', 'image'],
      ['title', 'string'],
      ['title2', 'string']
    ]);
    expect(p.fields.map((f) => f.label)).toEqual(['Link', 'Image', 'Title', 'Title 2']);
    const after = applyOperations(s, p.operations).state;
    expect(errors(after)).toEqual([]);
    const d = after.components[def.id];
    expect(d.tree!.nodes.member).toMatchObject({ link: { $item: 'link' } });
    // Content a property fills in stays the same in every item.
    expect(d.tree!.nodes.role).toMatchObject({ text: { $prop: 'role' } });
    const first = (d.properties.items as ListProp).default[0];
    expect(first.image).toMatchObject({ assetId: pic.id, alt: 'Ada at her desk' });
    expect(d.tree!.nodes.bio).toEqual(def.tree!.nodes.bio);
    expect(first.link).toMatchObject({ type: 'url', target: 'https://example.com/ada' });
  });

  it('repeats rich text as a rich text field outside a linking card', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.steps',
      name: 'Steps',
      properties: {},
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.el('step', 'div', { name: 'Step' }, [b.text('step-title', 'h3', 'Plan'), b.rich('step-body', ['Decide what to build.'])])])
    });
    const p = plan(s, def, 'step');
    expect(p.label).toBe('Steps');
    expect(p.fields.map((f) => [f.name, f.schema.type])).toEqual([
      ['title', 'string'],
      ['description', 'richtext']
    ]);
    const after = applyOperations(s, p.operations).state;
    expect(errors(after)).toEqual([]);
    const body = def.tree!.nodes['step-body'];
    expect((after.components[def.id].properties.steps as ListProp).default[0].description).toEqual(body.kind === 'text' ? body.text : null);
  });

  it('takes a name no property, UI state or placement value already holds, and the list name the author gives', () => {
    const s = fresh();
    const def = features(s, { properties: { heading: P.str('Heading', 'Why us'), cards: P.str('Old cards', '') } });
    const placed = place(s, def);
    // A value a placement kept for a property removed long ago.
    placed.props.cards2 = 'left behind';
    expect(plan(s, def, 'card').prop).toBe('cards3');
    expect(plan(s, def, 'card', { label: 'Feature cards' }).prop).toBe('featureCards');
    expect(plan(s, def, 'card', { label: 'Feature cards' }).label).toBe('Feature cards');
  });

  it('comes out the same when planned twice with the same IDs', () => {
    const s = fresh();
    const def = features(s);
    const ids = { repeatId: 'n_fixed01', itemIds: ['i_one', 'i_two', 'i_three'] };
    expect(plan(s, def, 'card', ids)).toEqual(plan(s, def, 'card', ids));
    expect(plan(s, def, 'card', ids).items.map((it) => it.id)).toEqual(ids.itemIds);
  });
});

describe('Repeat as list is offered only where it works', () => {
  const ref = (def: ComponentDefinition, nodeId: string) => ({ owner: { kind: 'component' as const, id: def.id }, instancePath: [], nodeId });

  it('refuses the root, a non-container, and anything outside a project design built in the editor', () => {
    const s = fresh();
    const def = features(s);
    expect(repeatAsListProblem(s, def, 'root')).toMatch(/whole component/);
    expect(repeatAsListProblem(s, def, 'card-title')).toMatch(/Pick a container/);
    expect(repeatAsListProblem(s, def, 'card')).toBeNull();
    expect(repeatAsListTarget({ state: s }, ref(def, 'card'))).toEqual(ref(def, 'card'));
    expect(repeatAsListTarget({ state: s, readOnly: true }, ref(def, 'card'))).toBeNull();
    // A pick through a page placement is not the design's own node.
    expect(repeatAsListTarget({ state: s }, { owner: { kind: 'page', id: s.site.homePageId }, instancePath: ['x'], nodeId: 'card' })).toBeNull();
    const theme = Object.values(s.components).find((d) => d.owner !== 'project' && d.kind === 'managed')!;
    expect(repeatAsListProblem(s, theme, theme.tree!.rootIds[0])).toMatch(/isn’t built in the editor/);
  });

  it('refuses a card already inside a list, where its item fields would change list', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.products',
      name: 'Products',
      properties: { products: P.list('Products', 'Product', { title: P.str('Title', 'Thing') }, [{ title: 'Kettle' }]) },
      parts: {},
      build: (b) =>
        b.el('root', 'section', {}, [
          b.repeat('each', 'products', [
            b.el('product', 'div', {}, [b.el('specs', 'div', {}, [b.text('specs-title', 'h4', 'Specifications'), b.text('product-title', 'p', { $item: 'title' })])])
          ])
        ])
    });
    expect(repeatAsListProblem(s, def, 'specs')).toMatch(/already repeated/);
    expect(repeatAsListProblem(s, def, 'root')).toMatch(/whole component/);
  });

  it('refuses a container holding a list, a slot, an anchor or a dialog, or with nothing of its own to repeat', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.odd',
      name: 'Odd',
      properties: { items: P.list('Items', 'Item', { title: P.str('Title', 'One') }, [{ title: 'One' }]), heading: P.str('Heading', 'Hi') },
      parts: {},
      slots: { extra: { label: 'Extra' } },
      build: (b) =>
        b.el('root', 'section', {}, [
          b.el('holds-list', 'div', {}, [b.repeat('each', 'items', [b.text('t', 'p', { $item: 'title' })])]),
          b.el('holds-slot', 'div', {}, [b.text('s-title', 'h3', 'Slot'), b.slot('slot', 'extra')]),
          b.el('holds-anchor', 'div', {}, [b.text('a-title', 'h3', 'Jump here', { anchor: 'here' })]),
          b.el('bound-only', 'div', {}, [b.text('b-title', 'h3', prop('heading'))]),
          b.el('empty', 'div', {}, [])
        ])
    });
    expect(repeatAsListProblem(s, def, 'holds-list')).toMatch(/list of its own/);
    expect(repeatAsListProblem(s, def, 'holds-slot')).toMatch(/slot’s content/);
    expect(repeatAsListProblem(s, def, 'holds-anchor')).toMatch(/anchor/);
    expect(repeatAsListProblem(s, def, 'bound-only')).toMatch(/no text, images, icons or links of its own/);
    expect(repeatAsListProblem(s, def, 'empty')).toMatch(/no text, images, icons or links of its own/);
  });

  it('refuses a conditional card in a group that hides when empty, and a component with no room for a property', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.hiding',
      name: 'Hiding',
      properties: { show: P.bool('Show', true) },
      parts: {},
      build: (b) =>
        b.el('root', 'section', {}, [
          b.el('group', 'div', { collapseEmpty: true }, [b.el('maybe', 'div', { when: prop('show') }, [b.text('m-title', 'h3', 'Maybe')]), b.el('always', 'div', {}, [b.text('al-title', 'h3', 'Always')])])
        ])
    });
    expect(repeatAsListProblem(s, def, 'maybe')).toMatch(/hides by its own conditions/);
    expect(repeatAsListProblem(s, def, 'always')).toBeNull();
    const after = applyOperations(s, plan(s, def, 'always').operations).state;
    expect(errors(after)).toEqual([]);
    const full = structuredClone(def);
    for (let i = 0; i < 60; i++) full.properties[`p${i}`] = P.str(`P ${i}`, '');
    expect(repeatAsListProblem(s, full, 'always')).toMatch(/60 properties/);
  });

  it('refuses a card in a nested component’s slot that holds a fixed number, and repeats one in an open slot', () => {
    const s = fresh();
    const box = addDef(s, {
      componentId: 'test.box',
      name: 'Box',
      properties: {},
      parts: {},
      slots: { one: { label: 'One', max: 1 }, many: { label: 'Many' } },
      build: (b) => b.el('root', 'div', {}, [b.slot('one-slot', 'one'), b.slot('many-slot', 'many')])
    });
    const outer = addDef(s, {
      componentId: 'test.outer',
      name: 'Outer',
      properties: {},
      parts: {},
      build: (b) => {
        const inner = makeInstance(box, {});
        inner.id = 'box';
        b.nodes.box = inner;
        const capped = b.el('capped', 'div', {}, [b.text('c-title', 'h3', 'Capped')]);
        const open = b.el('open', 'div', {}, [b.text('o-title', 'h3', 'Open')]);
        inner.slots = { one: [capped], many: [open] };
        return b.el('root', 'section', {}, ['box']);
      }
    });
    expect(repeatAsListProblem(s, outer, 'capped')).toMatch(/holds at most one item/);
    expect(repeatAsListProblem(s, outer, 'open')).toBeNull();
    const after = applyOperations(s, plan(s, outer, 'open').operations).state;
    expect(errors(after)).toEqual([]);
    const p = plan(s, outer, 'open');
    expect(((after.components[outer.id].tree!.nodes.box as InstanceNode).slots!.many as string[]).length).toBe(1);
    expect(p.operations[1]).toMatchObject({ type: 'node.insert', parentId: 'box', slot: 'many', index: 0 });
  });
});
