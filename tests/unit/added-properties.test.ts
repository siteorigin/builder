/**
 * Adding properties or variants to a component that is already placed (#190): a new list's default items become
 * each placement's own items with IDs of their own on the first edit, a nested component's bound property is never
 * overwritten by a value, and a component's first variant leaves its placements as they were.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, ListItem, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
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

describe('a list property added to a placed component', () => {
  function withLinks() {
    const p = placedNote(3);
    const s = applyOperations(p.s, [{ type: 'component.setPropSchema', definitionId: p.noteId, prop: 'links', schema: links }]).state;
    const defaults = s.components[p.noteId].properties.links.default as ListItem[];
    return { ...p, s, defaults };
  }

  it('gives each placement its own copy of the default items, with IDs of its own, on the first edit, reorder or removal', () => {
    const { s: added, nodeIds, defaults } = withLinks();
    const [a, b, c] = nodeIds;
    expect(defaults.map((d) => d.label)).toEqual(['One', 'Two', 'Three']);
    // Placed before the list existed: each shows the definition's items until it is edited.
    for (const id of nodeIds) expect(items(added, id)).toBeUndefined();
    const own = pageOwner(added);
    const s = applyOperations(added, [
      { type: 'instance.setProp', owner: own, nodeId: a, prop: 'links', itemId: defaults[1].id as string, field: 'label', value: 'Changed' },
      { type: 'instance.listRemove', owner: own, nodeId: b, prop: 'links', itemId: defaults[0].id as string },
      { type: 'instance.listMove', owner: own, nodeId: c, prop: 'links', itemId: defaults[2].id as string, index: 0 }
    ]).state;
    expect(items(s, a)!.map((i) => i.label)).toEqual(['One', 'Changed', 'Three']);
    expect(items(s, b)!.map((i) => i.label)).toEqual(['Two', 'Three']);
    expect(items(s, c)!.map((i) => i.label)).toEqual(['Three', 'One', 'Two']);
    // No item shares an ID with the definition's defaults or with an item of another placement.
    const ids = [...defaults, ...nodeIds.flatMap((id) => items(s, id)!)].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The definition's own defaults are untouched.
    expect(s.components[Object.keys(s.components).find((k) => s.components[k].properties.links)!].properties.links.default).toEqual(defaults);
    expect(errors(s)).toEqual([]);
  });

  it('keeps editing the same item after its first edit gave the placement its own items', () => {
    const { s: added, nodeIds, defaults } = withLinks();
    const [a] = nodeIds;
    const own = pageOwner(added);
    let s = applyOperations(added, [{ type: 'instance.setProp', owner: own, nodeId: a, prop: 'links', itemId: defaults[0].id as string, field: 'label', value: 'O' }]).state;
    const first = items(s, a)![0];
    s = applyOperations(s, [{ type: 'instance.setProp', owner: own, nodeId: a, prop: 'links', itemId: first.id as string, field: 'label', value: 'On' }]).state;
    expect(items(s, a)!.map((i) => i.label)).toEqual(['On', 'Two', 'Three']);
    expect(items(s, a)![0].id).toBe(first.id);
  });

  it('refuses an item that is in neither the placement’s list nor the definition’s', () => {
    const { s, nodeIds } = withLinks();
    expect(() => applyOperations(s, [{ type: 'instance.setProp', owner: pageOwner(s), nodeId: nodeIds[0], prop: 'links', itemId: 'i-nowhere', field: 'label', value: 'x' }])).toThrow(/Item "i-nowhere" not found/);
    expect(() => applyOperations(s, [{ type: 'instance.listRemove', owner: pageOwner(s), nodeId: nodeIds[0], prop: 'links', itemId: 'i-nowhere' }])).toThrow(/Item "i-nowhere" not found/);
  });
});

describe('editing a nested component’s bound property', () => {
  /** A Note with a title and a list of links, placed inside an Outer component that passes both down from its own properties. */
  function nested() {
    let s = fresh();
    const o = pageOwner(s);
    const c = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties: { label: text('Label', { default: 'Hi' }), links } }]);
    s = c.state;
    const noteId = c.results[0].definitionId as string;
    s = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: null, index: 0, primitive: 'stack' }]).state;
    const stack = home(s).rootIds[0];
    s = applyOperations(s, [{ type: 'node.insert', owner: o, parentId: stack, definitionId: noteId }]).state;
    const outer = applyOperations(s, [{ type: 'component.createFromNode', owner: o, nodeId: stack, name: 'Outer' }]);
    s = outer.state;
    const outerId = outer.results[0].definitionId as string;
    const defOwner = { kind: 'component' as const, id: outerId };
    const boundNote = Object.values(s.components[outerId].tree!.nodes).find((n) => n.kind === 'instance' && n.definitionId === noteId)!.id;
    s = applyOperations(s, [
      { type: 'component.setPropSchema', definitionId: outerId, prop: 'title', schema: { type: 'string', label: 'Title', default: 'Welcome' } },
      { type: 'component.setPropSchema', definitionId: outerId, prop: 'entries', schema: { ...links, label: 'Entries' } },
      { type: 'node.setBinding', owner: defOwner, nodeId: boundNote, field: 'prop', prop: 'label', binding: { $prop: 'title' } },
      { type: 'node.setBinding', owner: defOwner, nodeId: boundNote, field: 'prop', prop: 'links', binding: { $prop: 'entries' } }
    ]).state;
    const bound = (st: ProjectState) => (st.components[outerId].tree!.nodes[boundNote] as InstanceNode).props;
    return { s, outerId, defOwner, boundNote, bound };
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

  it('refuses a value for a property passed down from the enclosing component, and keeps the binding', () => {
    const p = nested();
    expect(p.bound(p.s)).toMatchObject({ label: { $prop: 'title' }, links: { $prop: 'entries' } });
    expect(errors(p.s)).toEqual([]);
    const value = refusal(() => applyOperations(p.s, [{ type: 'instance.setProp', owner: p.defOwner, nodeId: p.boundNote, prop: 'label', value: 'Overwritten' }]));
    expect(value).toBeInstanceOf(EngineError);
    expect(value.message).toMatch(/Title/);
    const list = refusal(() => applyOperations(p.s, [{ type: 'instance.setProp', owner: p.defOwner, nodeId: p.boundNote, prop: 'links', value: [{ label: 'Mine' }] }]));
    expect(list).toBeInstanceOf(EngineError);
    const item = refusal(() => applyOperations(p.s, [{ type: 'instance.setProp', owner: p.defOwner, nodeId: p.boundNote, prop: 'links', itemId: 'i-any', field: 'label', value: 'x' }]));
    expect(item).toBeInstanceOf(EngineError);
    expect(p.bound(p.s)).toMatchObject({ label: { $prop: 'title' }, links: { $prop: 'entries' } });
  });

  it('refuses a value for a property filled from each item of a repeated list', () => {
    const p = nested();
    // As a design that repeats the note over a list binds it.
    p.bound(p.s).label = { $item: 'label' };
    const err = refusal(() => applyOperations(p.s, [{ type: 'instance.setProp', owner: p.defOwner, nodeId: p.boundNote, prop: 'label', value: 'Overwritten' }]));
    expect(err).toBeInstanceOf(EngineError);
    expect(p.bound(p.s).label).toEqual({ $item: 'label' });
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
    expect(def.variantAxes!.tone).toEqual({ label: 'Tone', default: 'default', options: { default: { label: 'Plain' } } });
  });
});
