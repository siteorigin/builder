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
import { STARTER_ITEMS, planRepeatAsList, repeatAsListPreflight, repeatAsListProblem, repeatAsListTarget, type RepeatPlan } from '../../src/renderer/src/lib/repeat-as-list';

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
    expect(STARTER_ITEMS).toBe(3);
    expect(p.items).toHaveLength(3);

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
    const content = { icon: 'sparkles', title: 'Fast setup', description: 'Up and running in minutes.', label: 'Read more', link: LINK };
    expect(list.default).toHaveLength(3);
    expect(new Set(list.default.map((it) => it.id)).size).toBe(3);
    for (const it of list.default) expect(it).toMatchObject(content);

    // Each existing placement has its own copy of the items, no ID shared with the defaults or the other placement.
    const itemsOf = (n: InstanceNode) => (home(after).nodes[n.id] as InstanceNode).props.cards as ListItem[];
    const ids = [...list.default, ...itemsOf(a), ...itemsOf(b)].map((it) => it.id);
    expect(itemsOf(a)).toHaveLength(3);
    expect(itemsOf(b)).toHaveLength(3);
    for (const it of [...itemsOf(a), ...itemsOf(b)]) expect(it).toMatchObject(content);
    expect(new Set(ids).size).toBe(ids.length);

    // Each placement hands its own items to the component, which renders the card once per item.
    const page = generateProject(after).get('src/routes/+page.svelte')!;
    expect(page.split('Fast setup').length - 1).toBe(2 * STARTER_ITEMS);
    const component = generateProject(after).get(defFile(d))!;
    expect(component).toContain('{#each cards ?? [] as item (item.id)}');
  });

  it('lets one placement edit one item without touching the others', () => {
    let s = fresh();
    const def = features(s);
    const a = place(s, def);
    const b = place(s, def);
    s = applyOperations(s, plan(s, def, 'card').operations).state;
    const itemsOf = (st: ProjectState, n: InstanceNode) => (home(st).nodes[n.id] as InstanceNode).props.cards as ListItem[];
    const second = itemsOf(s, a)[1];
    const defaults = structuredClone(s.components[def.id].properties.cards.default);
    s = applyOperations(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: s.site.homePageId }, nodeId: a.id, prop: 'cards', itemId: second.id, field: 'title', value: 'Friendly support' }]).state;
    expect(itemsOf(s, a).map((it) => it.title)).toEqual(['Fast setup', 'Friendly support', 'Fast setup']);
    expect(itemsOf(s, b).map((it) => it.title)).toEqual(['Fast setup', 'Fast setup', 'Fast setup']);
    // The design's starting items are not where a placement's edit goes.
    expect(s.components[def.id].properties.cards.default).toEqual(defaults);
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
      expect(session.state).toEqual(before);
    } finally {
      await session.close();
    }
  });

  it('applies nothing when any step of the change is refused', () => {
    const s = fresh();
    const def = features(s);
    place(s, def);
    const p = plan(s, def, 'card');
    const before = structuredClone(s);
    const ops = structuredClone(p.operations);
    // The last binding names a field the list doesn't have.
    (ops[ops.length - 1] as { binding: unknown }).binding = { $item: 'nope' };
    expect(() => applyOperations(s, ops)).toThrow(/no field "nope"/);
    expect(s).toEqual(before);
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
    expect(d.tree!.nodes.photo).toMatchObject({ image: { $item: 'image' } });
    expect(d.tree!.nodes.name).toMatchObject({ text: { $item: 'title' } });
    expect(d.tree!.nodes.nick).toMatchObject({ text: { $item: 'title2' } });
    // Content a property fills in stays the same in every item.
    expect(d.tree!.nodes.role).toMatchObject({ text: { $prop: 'role' } });
    const first = (d.properties.items as ListProp).default[0];
    expect(first.image).toMatchObject({ assetId: pic.id, alt: 'Ada at her desk' });
    expect(first).toMatchObject({ title: 'Ada', title2: 'The Countess' });
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
    expect(after.components[def.id].tree!.nodes['step-body']).toMatchObject({ text: { $item: 'description' } });
    const body = def.tree!.nodes['step-body'];
    expect((after.components[def.id].properties.steps as ListProp).default[0].description).toEqual(body.kind === 'text' ? body.text : null);
  });

  it('takes a name no property, UI state or placement value already holds, and the list name the author gives', () => {
    const s = fresh();
    const def = features(s, {
      properties: { heading: P.str('Heading', 'Why us'), cards: P.str('Old cards', '') },
      state: { cards3: { type: 'boolean', label: 'Cards open', initial: false } },
      examples: [{ description: 'Older example', props: { cards4: 'kept' } }]
    });
    const placed = place(s, def);
    // A value a placement kept for a property removed long ago.
    placed.props.cards2 = 'left behind';
    // Not a property, a UI state, a placement's leftover value or an example's.
    expect(plan(s, def, 'card').prop).toBe('cards5');
    expect(plan(s, def, 'card', { label: 'Feature cards' }).prop).toBe('featureCards');
    expect(plan(s, def, 'card', { label: 'Feature cards' }).label).toBe('Feature cards');
  });

  it('comes out the same when planned twice with the same IDs', () => {
    const s = fresh();
    const def = features(s);
    const ids = { repeatId: 'n_fixed01', itemIds: ['i_one', 'i_two', 'i_three'] };
    const other = { repeatId: 'n_fixed02', itemIds: ['i_four', 'i_five', 'i_six'] };
    expect(plan(s, def, 'card', ids)).toEqual(plan(s, def, 'card', ids));
    expect(plan(s, def, 'card', ids).items.map((it) => it.id)).toEqual(ids.itemIds);
    const p = plan(s, def, 'card', other);
    expect(p.repeatId).toBe('n_fixed02');
    expect(p.items.map((it) => it.id)).toEqual(other.itemIds);
    expect(p.operations[1]).toMatchObject({ type: 'node.insert', newNodeId: 'n_fixed02' });
    expect(p.operations[2]).toMatchObject({ type: 'node.move', nodeId: 'card', parentId: 'n_fixed02', index: 0 });
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
    expect(repeatAsListTarget({ state: s }, { ...ref(def, 'card'), instancePath: ['x'] })).toBeNull();
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
          b.el('group', 'div', { collapseEmpty: true }, [b.el('maybe', 'div', { when: prop('show') }, [b.text('m-title', 'h3', 'Maybe')]), b.el('always', 'div', {}, [b.text('al-title', 'h3', 'Always')])]),
          b.el('plain', 'div', {}, [b.el('shown', 'div', { when: prop('show') }, [b.text('s-title', 'h3', 'Shown')])])
        ])
    });
    expect(repeatAsListProblem(s, def, 'maybe')).toMatch(/hides by its own conditions/);
    expect(repeatAsListProblem(s, def, 'always')).toBeNull();
    // The same conditional card in a group that doesn't hide is repeated, keeping its condition.
    expect(repeatAsListProblem(s, def, 'shown')).toBeNull();
    const after = applyOperations(s, plan(s, def, 'always').operations).state;
    expect(errors(after)).toEqual([]);
    // One property already (show): 59 leave room for the list, 60 don't.
    const room = structuredClone(def);
    for (let i = 0; i < 58; i++) room.properties[`p${i}`] = P.str(`P ${i}`, '');
    expect(Object.keys(room.properties)).toHaveLength(59);
    expect(repeatAsListProblem(s, room, 'always')).toBeNull();
    room.properties.p58 = P.str('P 58', '');
    expect(repeatAsListProblem(s, room, 'always')).toMatch(/60 properties/);
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
        inner.slots = { one: [capped], many: [b.text('lead', 'p', 'Lead'), open, b.text('tail', 'p', 'Tail')] };
        return b.el('root', 'section', {}, ['box']);
      }
    });
    expect(repeatAsListProblem(s, outer, 'capped')).toMatch(/holds at most one item/);
    expect(repeatAsListProblem(s, outer, 'open')).toBeNull();
    const p = plan(s, outer, 'open');
    expect(p.operations[1]).toMatchObject({ type: 'node.insert', parentId: 'box', slot: 'many', index: 1 });
    const after = applyOperations(s, p.operations).state;
    expect(errors(after)).toEqual([]);
    const tree = after.components[outer.id].tree!;
    expect((tree.nodes.box as InstanceNode).slots!.many).toEqual(['lead', p.repeatId, 'tail']);
    expect(tree.nodes[p.repeatId]).toMatchObject({ kind: 'repeat', children: ['open'] });
  });
  it('refuses a dialog, tabs and panels the component’s UI state shows, which work only outside a list', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.tabs',
      name: 'Tabs',
      properties: {},
      parts: {},
      state: { open: { type: 'boolean', label: 'Open', initial: false }, tab: { type: 'enum', label: 'Tab', options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }], initial: 'one' } },
      build: (b) =>
        b.el('root', 'section', {}, [
          b.el('holds-dialog', 'div', {}, [b.text('d-title', 'h3', 'More'), b.el('dlg', 'div', { overlay: 'dialog', when: { $state: 'open' } }, [b.text('d-body', 'p', 'Details')])]),
          b.el('tab-list', 'div', {}, [
            b.text('t-title', 'h3', 'Pick one'),
            b.link('tab-one', { type: 'none', target: '' }, 'One', 'secondary', { stateAction: { op: 'set', state: 'tab', value: 'one' } }),
            b.link('tab-two', { type: 'none', target: '' }, 'Two', 'secondary', { stateAction: { op: 'set', state: 'tab', value: 'two' } })
          ]),
          b.el('panel', 'div', { when: { ref: { $state: 'tab' }, eq: 'one' } }, [b.text('p-title', 'h3', 'First panel')]),
          b.el('other-panel', 'div', { unless: { ref: { $state: 'tab' }, eq: 'one' } }, [b.text('o-title', 'h3', 'Second panel')]),
          b.el('plain', 'div', {}, [b.text('pl-title', 'h3', 'Plain')])
        ])
    });
    expect(repeatAsListProblem(s, def, 'holds-dialog')).toMatch(/dialog or drawer/);
    expect(repeatAsListProblem(s, def, 'tab-list')).toMatch(/tabs, panels or buttons/);
    expect(repeatAsListProblem(s, def, 'panel')).toMatch(/tabs, panels or buttons/);
    expect(repeatAsListProblem(s, def, 'other-panel')).toMatch(/tabs, panels or buttons/);
    expect(repeatAsListProblem(s, def, 'plain')).toBeNull();
  });

  it('refuses the image a container around it opens full size, which it can’t find inside a list', () => {
    const pic = { id: 'a_pic', name: 'Pic', file: 'static/assets/pic.png', mime: 'image/png', bytes: 10, hash: 'h', kind: 'image' as const, createdAt: 'now' };
    const s = applyOperations(fresh(), [{ type: 'asset.add', asset: pic }]).state;
    const def = addDef(s, {
      componentId: 'test.viewer',
      name: 'Viewer',
      properties: {},
      parts: {},
      build: (b) =>
        b.el('root', 'section', {}, [
          b.el('viewer', 'div', { name: 'Viewer', action: 'image' }, [b.el('frame', 'div', {}, [b.image('shot', { assetId: pic.id, alt: 'Shot' }), b.text('caption', 'p', 'Caption')])]),
          b.el('gallery', 'div', {}, [b.el('tile', 'div', {}, [b.image('tile-shot', { assetId: pic.id, alt: 'Tile' })])])
        ])
    });
    expect(repeatAsListProblem(s, def, 'frame')).toMatch(/holds the image that “Viewer” opens full size/);
    expect(repeatAsListProblem(s, def, 'tile')).toBeNull();
  });

  it('refuses a card holding a component whose design has an anchor, which every item would repeat', () => {
    const s = fresh();
    const badge = addDef(s, { componentId: 'test.badge', name: 'Badge', properties: {}, parts: {}, build: (b) => b.el('root', 'div', {}, [b.text('b-text', 'span', 'New', { anchor: 'badge' })]) });
    const def = addDef(s, {
      componentId: 'test.cards',
      name: 'Cards',
      properties: {},
      parts: {},
      build: (b) => {
        const inner = makeInstance(badge, {});
        inner.id = 'badge';
        b.nodes.badge = inner;
        return b.el('root', 'section', {}, [b.el('card', 'div', {}, [b.text('c-title', 'h3', 'Card'), 'badge'])]);
      }
    });
    expect(repeatAsListProblem(s, def, 'card')).toMatch(/anchor/);
  });

  it('keeps rich text in the design where a placement shows the component inside a card that links somewhere', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.notes',
      name: 'Notes',
      properties: {},
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.el('note', 'div', {}, [b.text('n-title', 'h3', 'Note'), b.rich('n-body', ['Plain words.'])])])
    });
    // The page's own card links somewhere, and holds a placement of the component.
    const inst = makeInstance(def, {});
    const page = home(s);
    page.nodes[inst.id] = inst;
    page.nodes.pcard = { id: 'pcard', kind: 'element', tag: 'div', link: { type: 'url', target: 'https://example.com' }, children: [inst.id] };
    page.rootIds.push('pcard');
    const p = plan(s, def, 'note');
    expect(p.fields.map((f) => f.name)).toEqual(['title']);
    expect(p.shared).toBe(1);
    expect(repeatAsListPreflight(s, p)).toBeNull();
    // Bound, the rich text would be content that can hold links inside the page's card, which the project refuses.
    const bound: RepeatPlan = structuredClone(p);
    (bound.operations[0] as unknown as { schema: { fields: Record<string, unknown> } }).schema.fields.body = { type: 'richtext', label: 'Body', default: [] };
    bound.operations.push({ type: 'node.setBinding', owner: { kind: 'component', id: def.id }, nodeId: 'n-body', field: 'text', binding: { $item: 'body' } });
    expect(repeatAsListPreflight(s, bound)).toMatch(/can hold links/);
  });

  it('says before confirming why the project would refuse the change: text longer than a field holds', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.long',
      name: 'Long',
      properties: {},
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.el('card', 'div', {}, [b.text('l-title', 'h3', 'Long'), b.text('l-body', 'p', 'x'.repeat(2001))])])
    });
    expect(repeatAsListProblem(s, def, 'card')).toBeNull();
    expect(repeatAsListPreflight(s, plan(s, def, 'card'))).toMatch(/longer than 2000 characters/);
    expect(repeatAsListPreflight(s, plan(s, features(s), 'card'))).toBeNull();
  });
  it('keeps rich text shared through a nested slot or a component placed in a linking card, not through a slot never shown', () => {
    const s = fresh();
    const notes = addDef(s, {
      componentId: 'test.notes2',
      name: 'Notes',
      properties: {},
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.el('note', 'div', {}, [b.text('n-title', 'h3', 'Note'), b.rich('n-body', ['Plain words.'])])])
    });
    const richShared = () => plan(s, s.components[notes.id], 'note').fields.every((f) => f.name !== 'description');
    expect(richShared()).toBe(false);
    // Placed in another component's design, which a page shows inside its own linking card.
    const wrapper = addDef(s, {
      componentId: 'test.wrapper2',
      name: 'Wrapper',
      properties: {},
      parts: {},
      build: (b) => {
        const inner = makeInstance(notes, {});
        inner.id = 'notes';
        b.nodes.notes = inner;
        return b.el('root', 'section', {}, ['notes']);
      }
    });
    const placed = makeInstance(wrapper, {});
    home(s).nodes[placed.id] = placed;
    home(s).nodes.pcard = { id: 'pcard', kind: 'element', tag: 'div', link: { type: 'url', target: 'https://example.com' }, children: [placed.id] };
    home(s).rootIds.push('pcard');
    expect(richShared()).toBe(true);

    // Content of a nested component's slot that its design shows inside a linking card.
    const t = fresh();
    const box = addDef(t, {
      componentId: 'test.linkbox',
      name: 'Link box',
      properties: {},
      parts: {},
      slots: { body: { label: 'Body' }, hidden: { label: 'Hidden' } },
      build: (b) => b.el('root', 'div', {}, [b.el('box-card', 'div', { link: { type: 'url', target: 'https://example.com' } }, [b.slot('body-slot', 'body')])])
    });
    const outer = addDef(t, {
      componentId: 'test.outer2',
      name: 'Outer',
      properties: {},
      parts: {},
      build: (b) => {
        const inner = makeInstance(box, {});
        inner.id = 'box';
        b.nodes.box = inner;
        const shown = b.el('shown', 'div', {}, [b.text('s-title', 'h3', 'Shown'), b.rich('s-body', ['Words.'])]);
        const unshown = b.el('unshown', 'div', {}, [b.text('u-title', 'h3', 'Unshown'), b.rich('u-body', ['Words.'])]);
        inner.slots = { body: [shown], hidden: [unshown] };
        return b.el('root', 'section', { link: { type: 'url', target: 'https://example.com/outer' } }, ['box']);
      }
    });
    expect(plan(t, outer, 'shown').fields.map((f) => f.name)).toEqual(['title']);
    // A slot the nested design never shows puts its content nowhere, so no card holds it: nothing is held back.
    expect(plan(t, outer, 'unshown').fields.map((f) => f.name)).toEqual(['title', 'description']);
  });

  it('repeats a card whose image sits in a nested component’s slot, which the container around it never opens', () => {
    const pic = { id: 'a_pic', name: 'Pic', file: 'static/assets/pic.png', mime: 'image/png', bytes: 10, hash: 'h', kind: 'image' as const, createdAt: 'now' };
    const s = applyOperations(fresh(), [{ type: 'asset.add', asset: pic }]).state;
    const frame = addDef(s, { componentId: 'test.frame', name: 'Frame', properties: {}, parts: {}, slots: { body: { label: 'Body' } }, build: (b) => b.el('root', 'div', {}, [b.slot('f-slot', 'body')]) });
    const def = addDef(s, {
      componentId: 'test.viewer2',
      name: 'Viewer',
      properties: {},
      parts: {},
      build: (b) => {
        const inner = makeInstance(frame, {});
        inner.id = 'frame';
        b.nodes.frame = inner;
        inner.slots = { body: [b.image('slotted', { assetId: pic.id, alt: 'Slotted' })] };
        return b.el('root', 'section', {}, [b.el('viewer', 'div', { name: 'Viewer', action: 'image' }, [b.image('own', { assetId: pic.id, alt: 'Own' }), b.el('card', 'div', {}, [b.text('c-title', 'h3', 'Card'), 'frame'])])]);
      }
    });
    expect(repeatAsListProblem(s, def, 'card')).toBeNull();
  });

  it('plans and checks a change in a design a hand edit left with a node listed under itself', () => {
    const s = fresh();
    const def = features(s);
    // Detached, and its own child: the design still opens, with a warning.
    s.components[def.id].tree!.nodes.loop = { id: 'loop', kind: 'element', tag: 'div', children: ['loop'], when: { $item: 'title' } };
    const p = plan(s, s.components[def.id], 'card');
    expect(typeof (repeatAsListPreflight(s, p) ?? '')).toBe('string');
    expect(() => applyOperations(s, [{ type: 'component.setPropSchema', definitionId: def.id, prop: 'extra', schema: { type: 'string', label: 'Extra', default: '' } }])).not.toThrow();
  });
  it('repeats a card whose nested component takes its look from the UI state, the same in every item', () => {
    const s = fresh();
    const chip = addDef(s, {
      componentId: 'test.chip',
      name: 'Chip',
      properties: {},
      parts: {},
      variantAxes: { tone: { label: 'Tone', default: 'one', options: { one: { label: 'One' }, two: { label: 'Two' } } } },
      build: (b) => b.el('root', 'span', {}, [b.text('c-text', 'span', 'Chip')])
    });
    const def = addDef(s, {
      componentId: 'test.looks',
      name: 'Looks',
      properties: {},
      parts: {},
      state: { tab: { type: 'enum', label: 'Tab', options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }], initial: 'one' } },
      build: (b) => {
        const inner = makeInstance(chip, {});
        inner.id = 'chip';
        inner.variants = { tone: { $state: 'tab' } as unknown as string };
        b.nodes.chip = inner;
        return b.el('root', 'section', {}, [b.el('card', 'div', {}, [b.text('l-title', 'h3', 'Look'), 'chip'])]);
      }
    });
    expect(repeatAsListProblem(s, def, 'card')).toBeNull();
  });

  it('looks for an outer viewer’s image only up to a nested component’s slot, and follows a viewer chosen by a property', () => {
    const pic = { id: 'a_pic', name: 'Pic', file: 'static/assets/pic.png', mime: 'image/png', bytes: 10, hash: 'h', kind: 'image' as const, createdAt: 'now' };
    const s = applyOperations(fresh(), [{ type: 'asset.add', asset: pic }]).state;
    const frame = addDef(s, { componentId: 'test.frame2', name: 'Frame', properties: {}, parts: {}, slots: { body: { label: 'Body' } }, build: (b) => b.el('root', 'div', {}, [b.slot('f-slot', 'body')]) });
    const def = addDef(s, {
      componentId: 'test.viewer3',
      name: 'Viewer',
      properties: { opens: P.choice('Opens', 'image', [['none', 'Nothing'], ['image', 'Image']]) },
      parts: {},
      build: (b) => {
        const inner = makeInstance(frame, {});
        inner.id = 'frame';
        b.nodes.frame = inner;
        inner.slots = { body: [b.el('slotted-card', 'div', {}, [b.image('slotted', { assetId: pic.id, alt: 'Slotted' }), b.text('s-title', 'h3', 'Slotted')])] };
        return b.el('root', 'section', {}, [
          b.el('viewer', 'div', { name: 'Viewer', action: 'image' }, [b.image('own', { assetId: pic.id, alt: 'Own' }), 'frame']),
          b.el('chosen', 'div', { name: 'Chosen', action: prop('opens') }, [b.el('chosen-card', 'div', {}, [b.image('c-shot', { assetId: pic.id, alt: 'Chosen' }), b.text('c-title', 'h3', 'Chosen')])])
        ]);
      }
    });
    expect(repeatAsListProblem(s, def, 'slotted-card')).toBeNull();
    expect(repeatAsListProblem(s, def, 'chosen-card')).toMatch(/holds the image that “Chosen” opens full size/);
  });

  it('binds rich text of a design placed only in a slot its holder never shows, wherever that holder is placed', () => {
    const s = fresh();
    const notes = addDef(s, {
      componentId: 'test.notes3',
      name: 'Notes',
      properties: {},
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.el('note', 'div', {}, [b.text('n-title', 'h3', 'Note'), b.rich('n-body', ['Plain words.'])])])
    });
    const holder = addDef(s, {
      componentId: 'test.holder',
      name: 'Holder',
      properties: {},
      parts: {},
      slots: { unused: { label: 'Unused' } },
      build: (b) => b.el('root', 'section', {}, [b.text('h-title', 'h2', 'Holder')])
    });
    const wrapper = addDef(s, {
      componentId: 'test.wrapper3',
      name: 'Wrapper',
      properties: {},
      parts: {},
      build: (b) => {
        const h = makeInstance(holder, {});
        h.id = 'holder';
        const n = makeInstance(notes, {});
        n.id = 'notes';
        b.nodes.holder = h;
        b.nodes.notes = n;
        h.slots = { unused: ['notes'] };
        return b.el('root', 'section', {}, ['holder']);
      }
    });
    const placed = makeInstance(wrapper, {});
    home(s).nodes[placed.id] = placed;
    home(s).nodes.pcard = { id: 'pcard', kind: 'element', tag: 'div', link: { type: 'url', target: 'https://example.com' }, children: [placed.id] };
    home(s).rootIds.push('pcard');
    place(s, notes);
    expect(plan(s, s.components[notes.id], 'note').fields.map((f) => f.name)).toEqual(['title', 'description']);
  });
});
