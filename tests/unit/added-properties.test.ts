/**
 * Adding properties or variants to a component that is already placed (#190): a new list's default items become
 * each placement's own items with IDs of their own on the first edit, a nested component's bound property is never
 * overwritten by a value, and a component's first variant leaves its placements as they were.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, LinkValue, ListItem, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { installComponent, makeInstance, placedDefaultItems } from '@engine/install';
import { EngineError } from '@engine/tree';
import { blocksSaving, validateState } from '@engine/validate';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const pageOwner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);
const text = (label: string, extra: Record<string, unknown> = {}) => ({ type: 'string', label, default: '', ...extra });
const links = {
  type: 'list',
  label: 'Links',
  itemLabel: 'Link',
  fields: { label: { type: 'string', label: 'Label', default: '' } },
  default: [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }]
};

/** A code component placed on Home `count` times, before it has any list property. */
function placedNote(count: number) {
  let s = fresh();
  const c = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties: { title: text('Title', { default: 'Hi' }) } }]);
  s = c.state;
  const noteId = c.results[0].definitionId as string;
  const nodeIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = applyOperations(s, [{ type: 'node.insert', owner: pageOwner(s), definitionId: noteId }]);
    s = r.state;
    nodeIds.push(r.results[0].nodeId as string);
  }
  return { s, noteId, nodeIds };
}

const placement = (s: ProjectState, nodeId: string) => home(s).nodes[nodeId] as InstanceNode;
const items = (s: ProjectState, nodeId: string) => placement(s, nodeId).props.links as ListItem[] | undefined;
const items0 = (s: ProjectState, nodeId: string) => placement(s, nodeId).props.items as ListItem[];

describe('a list property added to a placed component', () => {
  function withLinks() {
    const p = placedNote(3);
    const s = applyOperations(p.s, [{ type: 'component.setPropSchema', definitionId: p.noteId, prop: 'links', schema: links }]).state;
    const defaults = s.components[p.noteId].properties.links.default as ListItem[];
    return { ...p, s, defaults };
  }
  /** Every item ID in the definition's defaults and in each placement's own list, once each. */
  const allIds = (s: ProjectState, defaults: ListItem[], nodeIds: string[]) => [...defaults, ...nodeIds.flatMap((id) => items(s, id) ?? [])].map((i) => i.id);

  it('gives each placement already there its own copy of the default items, with IDs of its own', () => {
    const { s, nodeIds, defaults } = withLinks();
    expect(defaults.map((d) => d.label)).toEqual(['One', 'Two', 'Three']);
    for (const id of nodeIds) expect(items(s, id)!.map((i) => i.label)).toEqual(['One', 'Two', 'Three']);
    const ids = allIds(s, defaults, nodeIds);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(ids.length);
    expect(errors(s)).toEqual([]);
  });

  it('edits, removes and reorders the items each placement shows, one placement at a time', () => {
    const { s: added, noteId, nodeIds, defaults } = withLinks();
    const [a, b, c] = nodeIds;
    const own = pageOwner(added);
    const shown = (id: string) => items(added, id)!.map((i) => i.id as string);
    const s = applyOperations(added, [
      { type: 'instance.setProp', owner: own, nodeId: a, prop: 'links', itemId: shown(a)[1], field: 'label', value: 'Changed' },
      { type: 'instance.setProp', owner: own, nodeId: a, prop: 'links', itemId: shown(a)[1], field: 'label', value: 'Changed again' },
      { type: 'instance.listRemove', owner: own, nodeId: b, prop: 'links', itemId: shown(b)[0] },
      { type: 'instance.listMove', owner: own, nodeId: c, prop: 'links', itemId: shown(c)[2], index: 0 }
    ]).state;
    expect(items(s, a)!.map((i) => i.label)).toEqual(['One', 'Changed again', 'Three']);
    expect(items(s, b)!.map((i) => i.label)).toEqual(['Two', 'Three']);
    expect(items(s, c)!.map((i) => i.label)).toEqual(['Three', 'One', 'Two']);
    expect(s.components[noteId].properties.links.default).toEqual(defaults);
    // An item added to a filled-in list takes a new ID and leaves the others' alone.
    const before = items(s, c)!.map((i) => i.id);
    const ins = applyOperations(s, [{ type: 'instance.listInsert', owner: own, nodeId: c, prop: 'links', index: 1, item: { label: 'New' } }]);
    const after = items(ins.state, c)!;
    expect(after.map((i) => i.label)).toEqual(['Three', 'New', 'One', 'Two']);
    expect(after[1].id).toBe(ins.results[0].itemId);
    expect(after.filter((_, i) => i !== 1).map((i) => i.id)).toEqual(before);
    expect(new Set(after.map((i) => i.id)).size).toBe(4);
    const ids = allIds(s, defaults, nodeIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(errors(s)).toEqual([]);
  });

  it('still finds an item by the ID the definition gave it, in the same batch and after a reorder', () => {
    const p = placedNote(2);
    const [a, b] = p.nodeIds;
    const own = pageOwner(p.s);
    const named = { ...links, default: [{ id: 'i_one', label: 'One' }, { id: 'i_two', label: 'Two' }, { id: 'i_three', label: 'Three' }] };
    const s = applyOperations(p.s, [
      { type: 'component.setPropSchema', definitionId: p.noteId, prop: 'links', schema: named },
      { type: 'instance.listMove', owner: own, nodeId: a, prop: 'links', itemId: 'i_three', index: 0 },
      { type: 'instance.setProp', owner: own, nodeId: a, prop: 'links', itemId: 'i_three', field: 'label', value: 'Third, first' },
      { type: 'instance.setProp', owner: own, nodeId: b, prop: 'links', itemId: 'i_two', value: { label: 'Second' } },
      { type: 'instance.listRemove', owner: own, nodeId: b, prop: 'links', itemId: 'i_one' }
    ]).state;
    expect(items(s, a)!.map((i) => i.label)).toEqual(['Third, first', 'One', 'Two']);
    expect(items(s, b)!.map((i) => i.label)).toEqual(['Second', 'Three']);
    expect([...items(s, a)!, ...items(s, b)!].some((i) => ['i_one', 'i_two', 'i_three'].includes(i.id))).toBe(false);
    // An item that has gone is not found again through the definition's ID.
    expect(() => applyOperations(s, [{ type: 'instance.setProp', owner: own, nodeId: b, prop: 'links', itemId: 'i_one', field: 'label', value: 'x' }])).toThrow(/Item "i_one" not found/);
  });

  it('moves styles kept for the default items onto the placement’s copies when the list comes back', () => {
    const p = placedNote(1);
    const [a] = p.nodeIds;
    const named = { ...links, default: [{ id: 'i_one', label: 'One' }, { id: 'i_two', label: 'Two' }] };
    const styles = { color: '#ff0000' };
    // Kept from when the placement still showed the default items, before the property was removed.
    placement(p.s, a).itemOverrides = { root: { list: 'links', items: { i_two: { base: styles }, i_other: { base: styles } } } };
    const s = applyOperations(p.s, [{ type: 'component.setPropSchema', definitionId: p.noteId, prop: 'links', schema: named }]).state;
    const copy = items(s, a)![1];
    expect(copy.label).toBe('Two');
    expect(placement(s, a).itemOverrides?.root?.items?.[copy.id]).toEqual({ base: styles });
    expect(placement(s, a).itemOverrides?.root?.items).not.toHaveProperty('i_two');
  });

  it('fills in a list added by saving a code component’s properties, and one a property becomes', () => {
    const p = placedNote(2);
    const [a, b] = p.nodeIds;
    // Placement b never had a title of its own; a keeps the untouched default it was given.
    delete placement(p.s, b).props.title;
    const saved = applyOperations(p.s, [{ type: 'component.updateSource', definitionId: p.noteId, source: '<p>y</p>\n', properties: { title: text('Title', { default: 'Hi' }), links } }]).state;
    const defaults = saved.components[p.noteId].properties.links.default as ListItem[];
    for (const id of p.nodeIds) expect(items(saved, id)!.map((i) => i.label)).toEqual(['One', 'Two', 'Three']);
    expect(new Set(allIds(saved, defaults, p.nodeIds)).size).toBe(9);
    // Retyped from text to a list: the untouched default and the missing value both become items of their own.
    const retyped = applyOperations(saved, [{ type: 'component.setPropSchema', definitionId: p.noteId, prop: 'title', schema: { ...links, label: 'Titles' } }]).state;
    const titles = (id: string) => placement(retyped, id).props.title as ListItem[];
    expect(titles(a).map((i) => i.label)).toEqual(['One', 'Two', 'Three']);
    expect(titles(b).map((i) => i.label)).toEqual(['One', 'Two', 'Three']);
    const titleDefaults = retyped.components[p.noteId].properties.title.default as ListItem[];
    const ids = [...titleDefaults, ...titles(a), ...titles(b)].map((i) => i.id);
    expect(new Set(ids).size).toBe(9);
    expect(errors(retyped)).toEqual([]);
  });

  it('fills in a placement inside another component’s design, and leaves a bound one bound', () => {
    let s = fresh();
    const o = pageOwner(s);
    const c = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties: { title: text('Title') } }]);
    s = c.state;
    const noteId = c.results[0].definitionId as string;
    s = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: null, index: 0, primitive: 'stack' }]).state;
    const stack = home(s).rootIds[0];
    s = applyOperations(s, [
      { type: 'node.insert', owner: o, parentId: stack, definitionId: noteId },
      { type: 'node.insert', owner: o, parentId: stack, definitionId: noteId }
    ]).state;
    const outer = applyOperations(s, [{ type: 'component.createFromNode', owner: o, nodeId: stack, name: 'Outer' }]);
    s = outer.state;
    const outerId = outer.results[0].definitionId as string;
    const [first, second] = Object.values(s.components[outerId].tree!.nodes).filter((n) => n.kind === 'instance' && n.definitionId === noteId) as InstanceNode[];
    s = applyOperations(s, [
      { type: 'component.setPropSchema', definitionId: noteId, prop: 'links', schema: links },
      { type: 'component.setPropSchema', definitionId: outerId, prop: 'entries', schema: { ...links, label: 'Entries' } },
      { type: 'node.setBinding', owner: { kind: 'component', id: outerId }, nodeId: second.id, field: 'prop', prop: 'links', binding: { $prop: 'entries' } }
    ]).state;
    const nested = (id: string) => (s.components[outerId].tree!.nodes[id] as InstanceNode).props.links;
    expect((nested(first.id) as ListItem[]).map((i) => i.label)).toEqual(['One', 'Two', 'Three']);
    expect(nested(second.id)).toEqual({ $prop: 'entries' });
    const defaults = s.components[noteId].properties.links.default as ListItem[];
    expect((nested(first.id) as ListItem[]).some((i) => defaults.some((d) => d.id === i.id))).toBe(false);
    // Edited in the design by the ID the definition gives the item.
    const defOwner = { kind: 'component' as const, id: outerId };
    const edited = applyOperations(s, [{ type: 'instance.setProp', owner: defOwner, nodeId: first.id, prop: 'links', itemId: defaults[2].id as string, field: 'label', value: 'Last' }]).state;
    expect(((edited.components[outerId].tree!.nodes[first.id] as InstanceNode).props.links as ListItem[]).map((i) => i.label)).toEqual(['One', 'Two', 'Last']);
    // Changing the list's fields afterwards keeps the binding, and never refills it.
    s = applyOperations(s, [{ type: 'component.setPropSchema', definitionId: noteId, prop: 'links', schema: { ...links, fields: { ...links.fields, note: { type: 'string', label: 'Note', default: '' } } } }]).state;
    expect(nested(second.id)).toEqual({ $prop: 'entries' });
    expect(errors(s)).toEqual([]);
  });

  it('styles and resets one copied item by the ID the definition gives it', () => {
    const s0 = fresh();
    const id = installComponent(s0, 'contact.details');
    const node = makeInstance(s0.components[id], {});
    home(s0).nodes[node.id] = node;
    home(s0).rootIds.push(node.id);
    const own = pageOwner(s0);
    const defaults = s0.components[id].properties.items.default as ListItem[];
    // As a list filled in when the property was added holds it.
    node.props.items = placedDefaultItems(own, node, defaults);
    const copy = (node.props.items as ListItem[])[1].id;
    const style = (value: string): EditOperation => ({ type: 'node.setStyle', owner: own, nodeId: node.id, partId: 'method', itemId: defaults[1].id as string, scope: 'base', property: 'background', value });
    const s1 = applyOperations(s0, [style('#ff0000')]).state;
    expect(placement(s1, node.id).itemOverrides?.method?.items).toEqual({ [copy]: { base: { background: '#ff0000' } } });
    const s2 = applyOperations(s1, [{ type: 'node.resetStyles', owner: own, nodeId: node.id, partId: 'method', itemId: defaults[1].id as string }]).state;
    expect(placement(s2, node.id).itemOverrides).toBeUndefined();
  });

  it('keeps a link the batch sets itself, whichever ID it names the copied item by', () => {
    const s0 = fresh();
    const id = installComponent(s0, 'contact.details');
    const node = makeInstance(s0.components[id], {});
    home(s0).nodes[node.id] = node;
    home(s0).rootIds.push(node.id);
    const own = pageOwner(s0);
    const defaults = s0.components[id].properties.items.default as ListItem[];
    node.props.items = placedDefaultItems(own, node, defaults);
    const at = defaults.findIndex((d) => (d.link as LinkValue | undefined)?.type === 'email');
    const copy = (node.props.items as ListItem[])[at];
    const was = copy.link as LinkValue;
    const set = (itemId: string, field: string, value: unknown): EditOperation => ({ type: 'instance.setProp', owner: own, nodeId: node.id, prop: 'items', itemId, field, value });
    // Unasked, the link follows the new address.
    const followed = applyOperations(s0, [set(copy.id, 'value', 'new@example.com')]);
    expect(followed.results[0].followed).toEqual(['link']);
    expect((items0(followed.state, node.id)[at].link as LinkValue).target).toBe('new@example.com');
    for (const [linkId, textId] of [
      [defaults[at].id, copy.id],
      [copy.id, defaults[at].id]
    ] as const) {
      // The link written as it was, then the text: the link the batch named stays.
      const kept = applyOperations(s0, [set(linkId as string, 'link', was), set(textId as string, 'value', 'new@example.com')]);
      expect(kept.results[1].followed).toBeUndefined();
      expect(items0(kept.state, node.id)[at].link).toEqual(was);
      // The text first: it does not move a link the batch sets after it.
      const later = applyOperations(s0, [set(textId as string, 'value', 'new@example.com'), set(linkId as string, 'link', was)]);
      expect(later.results[0].followed).toBeUndefined();
    }
    // The definition's defaults have changed since (and one is damaged): the old default's ID still names the copy.
    s0.components[id].properties.items.default = [null, ...defaults.map((d) => ({ ...d, id: `${d.id}-new` }))] as never;
    const renamed = applyOperations(s0, [set(defaults[at].id as string, 'link', was), set(defaults[at].id as string, 'value', 'new@example.com')]);
    expect(renamed.results[1].followed).toBeUndefined();
    expect(items0(renamed.state, node.id)[at].link).toEqual(was);
    expect(applyOperations(s0, [set(copy.id, 'value', 'new@example.com')]).results[0].followed).toEqual(['link']);
  });

  it('settles a copied form field’s key when its name is cleared by the ID the definition gives it', () => {
    const s0 = fresh();
    const id = installComponent(s0, 'contact.form');
    const node = makeInstance(s0.components[id], {});
    home(s0).nodes[node.id] = node;
    home(s0).rootIds.push(node.id);
    const own = pageOwner(s0);
    const defaults = s0.components[id].properties.fields.default as ListItem[];
    node.props.fields = placedDefaultItems(own, node, defaults);
    const phone = defaults.findIndex((f) => f.label === 'Phone');
    const set = (field: string, value: unknown): EditOperation => ({ type: 'instance.setProp', owner: own, nodeId: node.id, prop: 'fields', itemId: defaults[phone].id as string, field, value });
    const relabelled = applyOperations(s0, [set('label', 'Company')]).state;
    expect((placement(relabelled, node.id).props.fields as ListItem[])[phone].name).toBe(defaults[phone].name || 'phone');
    const cleared = applyOperations(relabelled, [set('name', '')]).state;
    expect((placement(cleared, node.id).props.fields as ListItem[])[phone]).toMatchObject({ label: 'Company', name: 'company' });
  });

  it('refuses an item edit whose value is not the item’s fields', () => {
    const { s, nodeIds } = withLinks();
    const first = items(s, nodeIds[0])![0].id as string;
    const err = (() => {
      try {
        applyOperations(s, [{ type: 'instance.setProp', owner: pageOwner(s), nodeId: nodeIds[0], prop: 'links', itemId: first, value: true }]);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(EngineError);
  });

  it('stores nothing for a computed list, and still edits a placement showing the defaults it never stored', () => {
    const p = placedNote(1);
    const [a] = p.nodeIds;
    const feed = applyOperations(p.s, [{ type: 'component.setPropSchema', definitionId: p.noteId, prop: 'news', schema: { type: 'list', label: 'News', itemLabel: 'Story', feed: 'articles', fields: { title: { type: 'string', label: 'Title' } } } }]).state;
    expect(Object.hasOwn(placement(feed, a).props, 'news')).toBe(false);
    // Once it stores items, every placement gets the defaults, even one that held an empty list the feed ignored.
    const held = a;
    placement(feed, held).props.news = [];
    // A second placement holds rows of its own (written outside the editor): they are kept.
    const r = applyOperations(feed, [{ type: 'node.insert', owner: pageOwner(feed), definitionId: p.noteId }]);
    const kept = r.results[0].nodeId as string;
    placement(r.state, kept).props.news = [{ id: 'i_mine', title: 'Mine' }];
    const stored = applyOperations(r.state, [{ type: 'component.setPropSchema', definitionId: p.noteId, prop: 'news', schema: { type: 'list', label: 'News', itemLabel: 'Story', min: 1, fields: { title: { type: 'string', label: 'Title' } }, default: [{ title: 'First' }] } }]).state;
    expect((placement(stored, held).props.news as ListItem[]).map((i) => i.title)).toEqual(['First']);
    expect(placement(stored, kept).props.news).toEqual([{ id: 'i_mine', title: 'Mine' }]);
    // A placement whose list came later another way (a document written elsewhere) still edits from the defaults.
    const added = applyOperations(p.s, [{ type: 'component.setPropSchema', definitionId: p.noteId, prop: 'links', schema: links }]).state;
    delete placement(added, a).props.links;
    const defaults = added.components[p.noteId].properties.links.default as ListItem[];
    const s = applyOperations(added, [{ type: 'instance.setProp', owner: pageOwner(added), nodeId: a, prop: 'links', itemId: defaults[0].id as string, field: 'label', value: 'Edited' }]).state;
    expect(items(s, a)!.map((i) => i.label)).toEqual(['Edited', 'Two', 'Three']);
  });
});

describe('editing a nested component’s bound property', () => {
  /** A Note with a label, a list of links and a tone, placed inside an Outer component that passes all three down from its own properties. */
  function nested() {
    let s = fresh();
    const o = pageOwner(s);
    const c = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties: { label: text('Label', { default: 'Hi' }), links } }]);
    s = c.state;
    const noteId = c.results[0].definitionId as string;
    s = applyOperations(s, [{ type: 'component.setVariant', definitionId: noteId, axis: 'tone', variant: 'loud', label: 'Loud' }]).state;
    s = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: null, index: 0, primitive: 'stack' }]).state;
    const stack = home(s).rootIds[0];
    s = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: stack, definitionId: noteId }]).state;
    const outer = applyOperations(s, [{ type: 'component.createFromNode', owner: o, nodeId: stack, name: 'Outer' }]);
    s = outer.state;
    const outerId = outer.results[0].definitionId as string;
    const defOwner = { kind: 'component' as const, id: outerId };
    const boundNote = Object.values(s.components[outerId].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === noteId)!.id;
    s = applyOperations(s, [
      { type: 'component.setPropSchema', definitionId: outerId, prop: 'title', schema: { type: 'string', label: 'Heading text', default: 'Welcome' } },
      { type: 'component.setPropSchema', definitionId: outerId, prop: 'entries', schema: { ...links, label: 'Link list' } },
      { type: 'component.setPropSchema', definitionId: outerId, prop: 'mood', schema: { type: 'enum', label: 'Mood', options: [{ value: 'default', label: 'Default' }, { value: 'loud', label: 'Loud' }], default: 'default' } },
      { type: 'node.setBinding', owner: defOwner, nodeId: boundNote, field: 'prop', prop: 'label', binding: { $prop: 'title' } },
      { type: 'node.setBinding', owner: defOwner, nodeId: boundNote, field: 'prop', prop: 'links', binding: { $prop: 'entries' } },
      { type: 'node.setBinding', owner: defOwner, nodeId: boundNote, field: 'variant', axis: 'tone', binding: { $prop: 'mood' } }
    ]).state;
    const node = (st: ProjectState) => st.components[outerId].tree!.nodes[boundNote] as InstanceNode;
    const item = (s.components[noteId].properties.links.default as ListItem[])[0].id as string;
    return { s, noteId, outerId, defOwner, boundNote, node, item };
  }

  /** The error an operation is refused with. */
  function refusal(run: () => unknown): Error {
    try {
      run();
    } catch (e) {
      return e as Error;
    }
    throw new Error('The operation was not refused.');
  }

  it('refuses a value for a property passed down from the enclosing component, naming that property', () => {
    const p = nested();
    expect(p.node(p.s).props).toMatchObject({ label: { $prop: 'title' }, links: { $prop: 'entries' } });
    expect(p.node(p.s).variants).toEqual({ tone: { $prop: 'mood' } });
    expect(errors(p.s)).toEqual([]);
    const at = { owner: p.defOwner, nodeId: p.boundNote };
    const ops: Array<[EditOperation, RegExp]> = [
      [{ type: 'instance.setProp', ...at, prop: 'label', value: 'Overwritten' }, /^Label comes from the enclosing component's "Heading text" property\. Change it there, or unbind it/],
      [{ type: 'instance.setProp', ...at, prop: 'links', value: [{ label: 'Mine' }] }, /^Links comes from the enclosing component's "Link list" property/],
      [{ type: 'instance.setProp', ...at, prop: 'links', itemId: p.item, field: 'label', value: 'x' }, /"Link list" property/],
      [{ type: 'instance.listInsert', ...at, prop: 'links', item: { label: 'x' } }, /"Link list" property/],
      [{ type: 'instance.listRemove', ...at, prop: 'links', itemId: p.item }, /"Link list" property/],
      [{ type: 'instance.listMove', ...at, prop: 'links', itemId: p.item, index: 1 }, /"Link list" property/],
      [{ type: 'instance.setVariant', ...at, axis: 'tone', variant: 'loud' }, /^Tone comes from the enclosing component's "Mood" property/]
    ];
    for (const [op, message] of ops) {
      const err = refusal(() => applyOperations(p.s, [op]));
      expect(err).toBeInstanceOf(EngineError);
      expect(err.message).toMatch(message);
    }
    expect(p.node(p.s).props).toMatchObject({ label: { $prop: 'title' }, links: { $prop: 'entries' } });
    expect(p.node(p.s).variants).toEqual({ tone: { $prop: 'mood' } });
  });

  it('refuses a value for a property filled from each item of a repeated list', () => {
    const p = nested();
    // As a design that repeats the note over a list binds it.
    p.node(p.s).props.label = { $item: 'label' };
    const err = refusal(() => applyOperations(p.s, [{ type: 'instance.setProp', owner: p.defOwner, nodeId: p.boundNote, prop: 'label', value: 'Overwritten' }]));
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toMatch(/^Label is filled in from each item of the list the design repeats/);
    expect(p.node(p.s).props.label).toEqual({ $item: 'label' });
  });

  it('still sets a nested property or variant that is not bound', () => {
    const p = nested();
    const s = applyOperations(p.s, [
      { type: 'node.setBinding', owner: p.defOwner, nodeId: p.boundNote, field: 'prop', prop: 'label', binding: null },
      { type: 'node.setBinding', owner: p.defOwner, nodeId: p.boundNote, field: 'variant', axis: 'tone', binding: null },
      { type: 'instance.setProp', owner: p.defOwner, nodeId: p.boundNote, prop: 'label', value: 'Own words' },
      { type: 'instance.setVariant', owner: p.defOwner, nodeId: p.boundNote, axis: 'tone', variant: 'loud' }
    ]).state;
    expect(p.node(s).props.label).toBe('Own words');
    expect(p.node(s).variants).toEqual({ tone: 'loud' });
  });
});

describe('a component’s first variant', () => {
  function placedWithVariant(op: Record<string, unknown>) {
    const p = placedNote(2);
    const s = applyOperations(p.s, [{ type: 'component.setVariant', definitionId: p.noteId, ...op } as never]).state;
    return { ...p, s, def: s.components[p.noteId] };
  }

  it('keeps a base option as the default, so placements look as they did and can choose the new one', () => {
    const { s, def, nodeIds } = placedWithVariant({ variant: 'dark', label: 'Dark' });
    expect(def.variantAxes!.style.default).toBe('default');
    expect(Object.keys(def.variantAxes!.style.options)).toEqual(['default', 'dark']);
    expect(def.variantAxes!.style.options.dark.label).toBe('Dark');
    for (const id of nodeIds) expect(placement(s, id).variants).toBeUndefined();
    expect(errors(s)).toEqual([]);
    // A second option joins the same axis and leaves the default alone.
    const more = applyOperations(s, [{ type: 'component.setVariant', definitionId: def.id, variant: 'light', label: 'Light' }]).state.components[def.id];
    expect(Object.keys(more.variantAxes!.style.options)).toEqual(['default', 'dark', 'light']);
    expect(more.variantAxes!.style.default).toBe('default');
  });

  it('makes the new option the default only when asked, still keeping the base option to go back to', () => {
    const { def } = placedWithVariant({ variant: 'dark', label: 'Dark', makeDefault: true });
    expect(def.variantAxes!.style.default).toBe('dark');
    expect(Object.keys(def.variantAxes!.style.options)).toEqual(['default', 'dark']);
  });

  it('adds no second option when the first one is the base option itself', () => {
    const { def } = placedWithVariant({ axis: 'tone', variant: 'default', label: 'Plain' });
    // A code component's new axis arrives in a property named as the axis.
    expect(def.variantAxes!.tone).toEqual({ label: 'Tone', default: 'default', options: { default: { label: 'Plain' } }, prop: 'tone' });
  });
});
