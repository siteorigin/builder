/**
 * Required properties (#747): a value the component cannot render without is never empty, whether it comes from the
 * default, a placement or a binding. Each property type's rule for "empty" is in shared/required.ts.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState, PropSchema } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { normalizePropSchema } from '@engine/schema';
import { requiredProblems } from '@engine/required';
import { blocksSaving, introducedDiagnostics, validateState } from '@engine/validate';
import { guaranteesValue, isEmptyPropValue, requiredGap } from '@shared/required';
import { compactPropsSchema, propsJsonSchema } from '../../src/agent/propschema';
import { catalogueIndex, propSchemaSummary } from '../../src/agent/context';
import { planComponentInspection } from '../../src/agent/component-inspection';

const PHOTO = 'as_photo';
function project(): ProjectState {
  const s = createStarterState('blank', 'Required', false);
  s.assets.assets[PHOTO] = { id: PHOTO, name: 'Photo', file: `static/assets/${PHOTO}.jpg`, mime: 'image/jpeg', bytes: 1, width: 10, height: 10, hash: 'x', kind: 'image', createdAt: '' };
  return s;
}
const home = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const saving = (s: ProjectState) => validateState(s, { sectionLinks: false }).filter(blocksSaving);

/** A project component with the given properties, placed once on the home page. */
function placed(s: ProjectState, properties: Record<string, unknown>) {
  const made = applyOperations(s, [{ type: 'component.create', name: 'Card' }]);
  const { definitionId } = made.results[0] as { definitionId: string };
  let st = made.state;
  for (const [prop, schema] of Object.entries(properties)) st = applyOperations(st, [{ type: 'component.setPropSchema', definitionId, prop, schema: schema as Record<string, unknown> }]).state;
  const put = applyOperations(st, [{ type: 'node.insert', owner: home(st), parentId: null, definitionId }]);
  return { state: put.state, definitionId, nodeId: put.results[0].nodeId as string };
}

/** Each type: a required schema whose default is empty, one whose default is not, and a value that empties it. */
const TYPES: Array<{ type: string; schema: Record<string, unknown>; empty?: unknown; value: unknown; cleared?: unknown }> = [
  { type: 'string', schema: { type: 'string', label: 'Title' }, empty: '   ', value: 'Hello', cleared: ' ' },
  { type: 'richtext', schema: { type: 'richtext', label: 'Body' }, empty: [{ type: 'ul', items: [[{ text: ' ' }]] }], value: 'Some words', cleared: '' },
  { type: 'link', schema: { type: 'link', label: 'Link' }, empty: { type: 'none', target: '' }, value: 'https://example.com/', cleared: '' },
  { type: 'image', schema: { type: 'image', label: 'Photo' }, empty: { assetId: null, alt: 'Only words' }, value: { assetId: PHOTO, alt: 'A photo', decorative: true }, cleared: { assetId: null, alt: '' } },
  { type: 'icon', schema: { type: 'icon', label: 'Icon' }, value: 'leaf' },
  { type: 'enum', schema: { type: 'enum', label: 'Mark', options: [{ value: '', label: 'None' }, 'star', { value: '  ', label: 'Blank' }] }, empty: '', value: 'star', cleared: '  ' },
  { type: 'choices', schema: { type: 'choices', label: 'Options' }, empty: [], value: ['Kitchen'], cleared: [] },
  { type: 'list', schema: { type: 'list', label: 'Cards', itemLabel: 'Card', fields: { title: { type: 'string', label: 'Title', default: 'Card' } } }, empty: [], value: [{ title: 'One' }], cleared: [] },
  { type: 'table', schema: { type: 'table', label: 'Prices' }, empty: { columns: ['Item'], rows: [] }, value: { columns: ['Item'], rows: [['Tea']] }, cleared: { columns: ['Item'], rows: [] } },
  { type: 'object', schema: { type: 'object', label: 'Action', fields: { label: { type: 'string', label: 'Label' }, link: { type: 'link', label: 'Link' } } }, empty: { label: '', link: '' }, value: { label: 'Go' }, cleared: { label: ' ' } },
  { type: 'number', schema: { type: 'number', label: 'Count' }, value: 0, cleared: '' },
  { type: 'boolean', schema: { type: 'boolean', label: 'Shown' }, value: false },
  { type: 'token', schema: { type: 'token', label: 'Accent', tokenGroup: 'color' }, value: 'color.brand' }
];

describe('required properties: what counts as empty', () => {
  it.each(TYPES)('$type: an empty default is refused, a value is kept, and clearing a placement fails with its path', ({ schema, empty, value, cleared }) => {
    const s = project();
    const required = { ...schema, required: true };
    if (empty !== undefined) expect(() => normalizePropSchema({ ...required, default: empty }, s, 'p')).toThrow(/Property "p" default is required/);
    const kept = normalizePropSchema({ ...required, default: value }, s, 'p');
    expect(kept.required).toBe(true);
    expect(isEmptyPropValue(kept, kept.default)).toBe(false);
    // The same value is fine where the property is optional, and the flag is only written when it is set.
    expect(normalizePropSchema({ ...schema, ...(empty !== undefined ? { default: empty } : {}) }, s, 'p')).not.toHaveProperty('required');
    const { state, nodeId } = placed(s, { p: { ...required, default: value } });
    if (cleared === undefined) return;
    expect(() => applyOperations(state, [{ type: 'instance.setProp', owner: home(state), nodeId, prop: 'p', value: cleared }])).toThrow(new RegExp(`Card → ${String(schema.label)} is required`));
  });

  it('counts 0 and false as values, and refuses clearing a required number to nothing', () => {
    const s = project();
    const { state, nodeId } = placed(s, { n: { type: 'number', label: 'Count', required: true }, b: { type: 'boolean', label: 'Shown', required: true } });
    const set = applyOperations(state, [
      { type: 'instance.setProp', owner: home(state), nodeId, prop: 'n', value: 0 },
      { type: 'instance.setProp', owner: home(state), nodeId, prop: 'b', value: false }
    ]).state;
    expect((set.pages[set.site.homePageId].nodes[nodeId] as InstanceNode).props).toMatchObject({ n: 0, b: false });
    for (const cleared of [null, '', '  ']) expect(() => applyOperations(set, [{ type: 'instance.setProp', owner: home(set), nodeId, prop: 'n', value: cleared }])).toThrow(/Count is required: it needs a value/);
  });

  it('refuses the flag where a value comes from elsewhere: a computed list, and page-list fields that follow the page', () => {
    const s = project();
    expect(() => normalizePropSchema({ type: 'list', label: 'News', itemLabel: 'Article', feed: 'articles', required: true, fields: { title: { type: 'string', label: 'Title' } } }, s, 'news')).toThrow(/computed list cannot be required/);
    expect(() => normalizePropSchema({ type: 'list', label: 'News', itemLabel: 'Article', feed: 'articles', fields: { title: { type: 'string', label: 'Title', default: 'A', required: true } } }, s, 'news')).toThrow(/field "title" of a computed list cannot be required/);
    const pages = { type: 'list', label: 'Pages', itemLabel: 'Card', pageTeaser: { link: 'link', title: 'title' }, fields: { link: { type: 'link', label: 'Link' }, title: { type: 'string', label: 'Title' }, note: { type: 'string', label: 'Note', default: 'New', required: true } } };
    expect(normalizePropSchema(pages, s, 'pages').type).toBe('list');
    expect(() => normalizePropSchema({ ...pages, fields: { ...pages.fields, title: { type: 'string', label: 'Title', default: 'T', required: true } } }, s, 'pages')).toThrow(/"title" shows the linked page's title while it is empty, so it cannot be required/);
    expect(() => normalizePropSchema({ ...pages, required: true }, s, 'pages')).toThrow(/page list cannot be required/);
    expect(() => normalizePropSchema({ type: 'string', label: 'T', required: 'yes' }, s, 'p')).toThrow(/required must be true or false/);
  });
});

describe('required fields of list items and objects', () => {
  const cards = { type: 'list', label: 'Cards', itemLabel: 'Card', fields: { title: { type: 'string', label: 'Title', default: 'Card', required: true }, note: { type: 'string', label: 'Note' } }, default: [{ title: 'One' }, { title: 'Two' }] };

  it('refuses a field default or default item that leaves a required field empty', () => {
    const s = project();
    expect(() => normalizePropSchema({ ...cards, fields: { ...cards.fields, title: { type: 'string', label: 'Title', required: true } } }, s, 'cards')).toThrow(/Property "cards.title" default is required/);
    expect(() => normalizePropSchema({ ...cards, default: [{ title: 'One' }, { title: '' }] }, s, 'cards')).toThrow(/Card 2 → Title is required: it needs some text/);
  });

  it('checks every item, whether the list is required or not, and names the item', () => {
    const s = project();
    const { state, nodeId } = placed(s, { cards });
    const items = (state.pages[state.site.homePageId].nodes[nodeId] as InstanceNode).props.cards as Array<{ id: string }>;
    const page = home(state);
    expect(() => applyOperations(state, [{ type: 'instance.setProp', owner: page, nodeId, prop: 'cards', itemId: items[1].id, field: 'title', value: '' }])).toThrow(/Card → Cards → Card 2 → Title is required/);
    expect(() => applyOperations(state, [{ type: 'instance.setProp', owner: page, nodeId, prop: 'cards', itemId: items[0].id, value: { title: ' ', note: 'x' } }])).toThrow(/Cards → Card 1 → Title is required/);
    expect(() => applyOperations(state, [{ type: 'instance.setProp', owner: page, nodeId, prop: 'cards', value: [{ title: 'A' }, { title: 'B' }, { note: 'no title', title: '' }] }])).toThrow(/Cards → Card 3 → Title is required/);
    expect(() => applyOperations(state, [{ type: 'instance.listInsert', owner: page, nodeId, prop: 'cards', index: 0, item: { title: '' } }])).toThrow(/Cards → Card 1 → Title is required/);
    // A new item left to its defaults takes the field's own default, which is never empty.
    const added = applyOperations(state, [{ type: 'instance.listInsert', owner: page, nodeId, prop: 'cards', item: {} }]).state;
    expect(((added.pages[added.site.homePageId].nodes[nodeId] as InstanceNode).props.cards as Array<{ title: string }>).at(-1)!.title).toBe('Card');
    // An optional list may still be emptied.
    let st = state;
    for (const it of items) st = applyOperations(st, [{ type: 'instance.listRemove', owner: page, nodeId, prop: 'cards', itemId: it.id }]).state;
    expect((st.pages[st.site.homePageId].nodes[nodeId] as InstanceNode).props.cards).toEqual([]);
  });

  it('keeps the last item of a required list and the last row of a required table', () => {
    const s = project();
    const { state, nodeId } = placed(s, { cards: { ...cards, required: true, default: [{ title: 'Only' }] }, prices: { type: 'table', label: 'Prices', required: true, default: { columns: ['Item'], rows: [['Tea']] } } });
    const node = state.pages[state.site.homePageId].nodes[nodeId] as InstanceNode;
    const only = (node.props.cards as Array<{ id: string }>)[0].id;
    expect(() => applyOperations(state, [{ type: 'instance.listRemove', owner: home(state), nodeId, prop: 'cards', itemId: only }])).toThrow(/Card → Cards is required: it needs at least one card/);
    const row = (node.props.prices as { rows: Array<{ id: string }> }).rows[0].id;
    expect(() => applyOperations(state, [{ type: 'instance.editTable', owner: home(state), nodeId, prop: 'prices', action: 'removeRow', rowId: row }])).toThrow(/Card → Prices is required: it needs at least one row/);
  });

  it('checks an object’s required field when one other field changes', () => {
    const s = project();
    const action = { type: 'object', label: 'Action', fields: { label: { type: 'string', label: 'Label', default: 'Go', required: true }, link: { type: 'link', label: 'Link' } } };
    const { state, nodeId } = placed(s, { action });
    expect(() => applyOperations(state, [{ type: 'instance.setProp', owner: home(state), nodeId, prop: 'action', field: 'label', value: '' }])).toThrow(/Card → Action → Label is required/);
    const linked = applyOperations(state, [{ type: 'instance.setProp', owner: home(state), nodeId, prop: 'action', field: 'link', value: 'https://example.com/' }]).state;
    expect((linked.pages[linked.site.homePageId].nodes[nodeId] as InstanceNode).props.action).toMatchObject({ label: 'Go' });
  });
});

describe('required properties: schema edits and bindings', () => {
  it('refuses making a property required while a placement holds it empty, naming the placement', () => {
    const s = project();
    const { state, definitionId, nodeId } = placed(s, { title: { type: 'string', label: 'Title', default: 'Hi' } });
    const emptied = applyOperations(state, [{ type: 'instance.setProp', owner: home(state), nodeId, prop: 'title', value: '' }]).state;
    expect(() => applyOperations(emptied, [{ type: 'component.setPropSchema', definitionId, prop: 'title', schema: { type: 'string', label: 'Title', default: 'Hi', required: true } }])).toThrow(/Home: Card → Title is required: it needs some text/);
    // A placement that only shows the default is fine.
    const ok = applyOperations(state, [{ type: 'component.setPropSchema', definitionId, prop: 'title', schema: { type: 'string', label: 'Title', default: 'Hi', required: true } }]).state;
    expect(ok.components[definitionId].properties.title.required).toBe(true);
    expect(() => applyOperations(ok, [{ type: 'component.setPropDefault', definitionId, prop: 'title', value: '' }])).toThrow(/Card → Title is required/);
  });

  /** An outer component placing the inner one, whose `title` is required, and passing its own `heading` to it. */
  function nested(headingRequired: boolean) {
    const s = project();
    const inner = placed(s, { title: { type: 'string', label: 'Title', default: 'Hi', required: true } });
    const outer = applyOperations(inner.state, [{ type: 'component.create', name: 'Wrapper' }]);
    const { definitionId: wrapper, rootNodeId } = outer.results[0] as { definitionId: string; rootNodeId: string };
    const owner = { kind: 'component' as const, id: wrapper };
    let st = applyOperations(outer.state, [{ type: 'component.setPropSchema', definitionId: wrapper, prop: 'heading', schema: { type: 'string', label: 'Heading', default: 'Welcome', ...(headingRequired ? { required: true } : {}) } }]).state;
    const put = applyOperations(st, [{ type: 'node.insert', owner, parentId: rootNodeId, definitionId: inner.definitionId }]);
    st = put.state;
    return { state: st, owner, wrapper, inner: inner.definitionId, nodeId: put.results[0].nodeId as string };
  }

  it('refuses binding a required property to one that can be empty, and accepts a required source', () => {
    const loose = nested(false);
    expect(() => applyOperations(loose.state, [{ type: 'node.setBinding', owner: loose.owner, nodeId: loose.nodeId, field: 'prop', prop: 'title', binding: { $prop: 'heading' } }])).toThrow(/“Title” is required, but “Heading” can be empty/);
    const strict = nested(true);
    const bound = applyOperations(strict.state, [{ type: 'node.setBinding', owner: strict.owner, nodeId: strict.nodeId, field: 'prop', prop: 'title', binding: { $prop: 'heading' } }]).state;
    expect(saving(bound)).toEqual([]);
    // The source can no longer stop being required, and the destination cannot be tightened past an optional source.
    expect(() => applyOperations(bound, [{ type: 'component.setPropSchema', definitionId: strict.wrapper, prop: 'heading', schema: { type: 'string', label: 'Heading', default: 'Welcome' } }])).toThrow(/can be empty/);
  });

  it('refuses tightening a nested property that an optional binding feeds', () => {
    const s = project();
    const inner = placed(s, { title: { type: 'string', label: 'Title', default: 'Hi' } });
    const outer = applyOperations(inner.state, [{ type: 'component.create', name: 'Wrapper' }]);
    const { definitionId: wrapper, rootNodeId } = outer.results[0] as { definitionId: string; rootNodeId: string };
    const owner = { kind: 'component' as const, id: wrapper };
    let st = applyOperations(outer.state, [{ type: 'component.setPropSchema', definitionId: wrapper, prop: 'heading', schema: { type: 'string', label: 'Heading', default: 'Welcome' } }]).state;
    const put = applyOperations(st, [{ type: 'node.insert', owner, parentId: rootNodeId, definitionId: inner.definitionId }]);
    st = applyOperations(put.state, [{ type: 'node.setBinding', owner, nodeId: put.results[0].nodeId as string, field: 'prop', prop: 'title', binding: { $prop: 'heading' } }]).state;
    expect(() => applyOperations(st, [{ type: 'component.setPropSchema', definitionId: inner.definitionId, prop: 'title', schema: { type: 'string', label: 'Title', default: 'Hi', required: true } }])).toThrow(/takes “Heading” as “Title”: “Title” is required, but “Heading” can be empty/);
  });

  it('says which sources always have a value, field by field for lists and objects', () => {
    const str = (required = false): PropSchema => ({ type: 'string', label: 'S', default: 'x', ...(required ? { required } : {}) });
    expect(guaranteesValue(str())).toBe(false);
    expect(guaranteesValue(str(true))).toBe(true);
    expect(guaranteesValue({ type: 'number', label: 'N', default: 0 })).toBe(true);
    expect(guaranteesValue({ type: 'enum', label: 'E', default: 'a', options: [{ value: 'a', label: 'A' }, { value: '', label: 'None' }] })).toBe(false);
    expect(guaranteesValue({ type: 'list', label: 'L', itemLabel: 'I', fields: {}, default: [], min: 1 })).toBe(true);
    const list = (title: PropSchema): PropSchema => ({ type: 'list', label: 'L', itemLabel: 'I', fields: { title: title as never }, default: [] });
    expect(requiredGap(list(str()), list(str(true)))).toMatch(/its field “S” is required, but “S” of “L” can be empty/);
    expect(requiredGap(list(str(true)), list(str(true)))).toBeNull();
    expect(requiredGap({ type: 'list', label: 'L', itemLabel: 'I', fields: {}, default: [] }, list(str(true)))).toMatch(/has no field “title”/);
  });
});

describe('required properties: validation of stored values', () => {
  it('reports a required value a hand edit left empty, and refuses a change that introduces one', () => {
    const s = project();
    const { state, nodeId } = placed(s, { title: { type: 'string', label: 'Title', default: 'Hi', required: true } });
    expect(saving(state)).toEqual([]);
    const edited = structuredClone(state);
    (edited.pages[edited.site.homePageId].nodes[nodeId] as InstanceNode).props.title = '';
    const found = introducedDiagnostics(saving(state), saving(edited));
    expect(found.map((d) => [d.code, d.message])).toEqual([['PROP_REQUIRED_EMPTY', 'Home: Card → Title is required: it needs some text.']]);
    expect(requiredProblems(edited)).toHaveLength(1);
  });
});

describe('required properties: what the AI reads', () => {
  it('marks required values in descriptions and tool schemas, keeping patch keys optional', () => {
    const s = project();
    const { state, definitionId } = placed(s, {
      title: { type: 'string', label: 'Title', default: 'Hi', required: true },
      photo: { type: 'image', label: 'Photo', default: { assetId: PHOTO, alt: '' }, required: true },
      note: { type: 'string', label: 'Note' },
      cards: { type: 'list', label: 'Cards', itemLabel: 'Card', required: true, fields: { title: { type: 'string', label: 'Title', default: 'Card', required: true } }, default: [{ title: 'One' }] }
    });
    const def = state.components[definitionId];
    const full = propsJsonSchema(def) as { properties: Record<string, Record<string, unknown>>; required?: string[] };
    expect(full.required).toBeUndefined();
    expect(full.properties.title).toMatchObject({ type: 'string', minLength: 1 });
    expect(full.properties.title.description).toMatch(/Required: it needs some text/);
    expect(full.properties.note).not.toHaveProperty('minLength');
    expect((full.properties.photo.properties as Record<string, unknown>).assetId).toMatchObject({ type: 'string', minLength: 1 });
    expect(full.properties.cards).toMatchObject({ minItems: 1, items: { properties: { title: { minLength: 1 } } } });
    const compact = compactPropsSchema(def) as { properties: Record<string, Record<string, unknown>> };
    expect(compact.properties.photo).toEqual({ $ref: '#/$defs/requiredImage' });
    expect(compact.properties.title).toEqual({ type: 'string', minLength: 1 });
    const summary = propSchemaSummary(def.properties) as Record<string, Record<string, unknown>>;
    expect(summary.title).toMatchObject({ required: true, requires: 'it needs some text' });
    expect(summary.note).not.toHaveProperty('required');
    expect(summary.cards).toMatchObject({ required: true, itemFields: { title: { type: 'string', required: true } } });
  });
});

describe('required properties in a design inspection', () => {
  it('never measures a case that empties a required link, which no placement can show', () => {
    const s = project();
    const { state, definitionId } = placed(s, { go: { type: 'link', label: 'Go', default: 'https://example.com/', required: true }, more: { type: 'link', label: 'More', default: 'https://example.com/more' } });
    const def = state.components[definitionId];
    const values = { go: def.properties.go.default, more: def.properties.more.default };
    const empty = planComponentInspection({ def, select: { definitionId }, values, variants: {}, notes: [] }).find((c) => c.label.split(' + ').includes('empty'))!;
    expect(empty.props).toMatchObject({ go: { type: 'url' }, more: { type: 'none' } });
  });
});

describe('required properties in Foundation', () => {
  it('marks what its sections cannot render without, and every starter fills them', () => {
    const index = new Map(catalogueIndex('foundation').map((e) => [e.componentId, e.props]));
    expect(index.get('faq.list')!.items).toMatch(/question:required string, answer:required string/);
    expect(index.get('testimonials.grid')!.items).toMatch(/quote:required string/);
    expect(index.get('team.grid')!.people).toMatch(/name:required string/);
    for (const kind of ['business', 'blank'] as const)
      for (const images of [true, false]) expect(requiredProblems(createStarterState(kind, 'Starter', images)).map((p) => p.message)).toEqual([]);
  });

  it('refuses clearing a question of a placed FAQ', () => {
    const s = createStarterState('blank', 'FAQ', false);
    const put = applyOperations(s, [{ type: 'node.insert', owner: home(s), parentId: null, componentId: 'faq.list' }]);
    const nodeId = put.results[0].nodeId as string;
    const items = (put.state.pages[s.site.homePageId].nodes[nodeId] as InstanceNode).props.items as Array<{ id: string }>;
    expect(() => applyOperations(put.state, [{ type: 'instance.setProp', owner: home(s), nodeId, prop: 'items', itemId: items[0].id, field: 'question', value: '' }])).toThrow(/Questions → Question 1 → Question is required/);
  });
});
