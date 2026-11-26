/**
 * Required properties (#747): a value the component cannot render without is never empty, whether it comes from the
 * default, a placement or a binding. Each property type's rule for "empty" is in shared/required.ts.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState, PropSchema } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { normalizePropSchema } from '@engine/schema';
import { madeRequiredBy, requiredProblems, requiredSite } from '@engine/required';
import { blocksSaving, introducedDiagnostics, validateState } from '@engine/validate';
import { guaranteesValue, isEmptyPropValue, requiredGap } from '@shared/required';
import { checkProps, upsertToolSchema, type FieldIssue } from '../../src/agent/macros';
import { planComponentPackage } from '@engine/component-package';
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

describe('required properties: stored values each type counts as empty', () => {
  const sch = (type: string, extra: Record<string, unknown> = {}) => ({ type, label: 'X', default: undefined, ...extra }) as unknown as PropSchema;
  it.each([
    ['string', sch('string'), '\t\n ', 'a'],
    ['richtext', sch('richtext'), [{ type: 'p', spans: [{ text: '\t' }] }, { type: 'ul', items: [[{ text: ' ' }]] }], [{ type: 'p', spans: [{ text: ' ' }] }, { type: 'p', spans: [{ text: 'b' }] }]],
    ['link', sch('link'), { type: 'url', target: ' ' }, { type: 'page', target: 'pg_home' }],
    ['image', sch('image'), { assetId: '', alt: 'Words' }, { assetId: 'as_x', alt: '' }],
    ['icon', sch('icon'), '', 'leaf'],
    ['enum', sch('enum', { options: [] }), '\t', 'a'],
    ['choices', sch('choices'), [], [{ id: 'c', label: 'A', value: 'A' }]],
    ['token', sch('token', { tokenGroup: 'color' }), { token: ' ' }, { token: 'color.brand' }],
    ['number', sch('number'), Number.NaN, 0],
    ['boolean', sch('boolean'), 'yes', false],
    ['list', sch('list', { fields: {} }), [], [{ id: 'i' }]],
    ['table', sch('table'), { columns: [{ id: 'c', label: 'A' }], rows: [] }, { columns: [], rows: [{ id: 'r', cells: {} }] }],
    ['object', sch('object', { fields: { a: { type: 'string', label: 'A' }, b: { type: 'link', label: 'B' } } }), { a: ' ', b: { type: 'none', target: '' } }, { a: '', b: { type: 'url', target: 'https://x.test/' } }]
  ])('%s', (_type, schema, empty, value) => {
    expect(isEmptyPropValue(schema, empty)).toBe(true);
    expect(isEmptyPropValue(schema, value)).toBe(false);
    expect(isEmptyPropValue(schema, null)).toBe(true);
  });

  it('reads a damaged rich text block as empty, never throwing', () => {
    const rich = { type: 'richtext', label: 'Body', default: [] } as unknown as PropSchema;
    expect(isEmptyPropValue(rich, [{ type: 'p' }, { type: 'ul' }, { type: 'ul', items: [null] }, null])).toBe(true);
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
  it('makes a property required while a placement holds it empty, keeping that value and reporting the placement (#748)', () => {
    const s = project();
    const { state, definitionId, nodeId } = placed(s, { title: { type: 'string', label: 'Title', default: 'Hi' } });
    const emptied = applyOperations(state, [{ type: 'instance.setProp', owner: home(state), nodeId, prop: 'title', value: '' }]).state;
    const ops = [{ type: 'component.setPropSchema' as const, definitionId, prop: 'title', schema: { type: 'string', label: 'Title', default: 'Hi', required: true } }];
    const tightened = applyOperations(emptied, ops).state;
    expect(tightened.components[definitionId].properties.title.required).toBe(true);
    expect((tightened.pages[tightened.site.homePageId].nodes[nodeId] as InstanceNode).props.title).toBe('');
    expect(requiredProblems(tightened).map((p) => [p.nodeId, p.message])).toEqual([[nodeId, 'Home: Card → Title is required: it needs some text.']]);
    // The session lets the change through for the placement it made required, and for nothing else.
    const found = introducedDiagnostics(saving(emptied), saving(tightened));
    expect(found.map((d) => d.code)).toEqual(['PROP_REQUIRED_EMPTY']);
    expect(found.every((d) => madeRequiredBy(tightened, ops, d))).toBe(true);
    expect(found.some((d) => madeRequiredBy(tightened, [{ type: 'instance.setProp' }], d))).toBe(false);
    expect(found.some((d) => madeRequiredBy(tightened, [{ type: 'component.setPropSchema', definitionId: 'other' }], d))).toBe(false);
    // An edit beside it, or one that fills it, goes through; one that empties another value is still refused.
    const filled = applyOperations(tightened, [{ type: 'instance.setProp', owner: home(tightened), nodeId, prop: 'title', value: 'Back' }]).state;
    expect(requiredProblems(filled)).toEqual([]);
    expect(() => applyOperations(filled, [{ type: 'instance.setProp', owner: home(filled), nodeId, prop: 'title', value: ' ' }])).toThrow(/Card → Title is required/);
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

  it('never trusts a list minimum, which a binding into the list does not keep, and needs the same type field by field', () => {
    const titled = (title: PropSchema, extra: Record<string, unknown> = {}): PropSchema => ({ type: 'list', label: 'L', itemLabel: 'I', fields: { title: title as never }, default: [], ...extra }) as PropSchema;
    const str = { type: 'string', label: 'S', default: 'x' } as PropSchema;
    expect(guaranteesValue(titled(str, { min: 1 }))).toBe(false);
    expect(requiredGap(titled(str, { min: 1 }), { ...titled(str), required: true } as PropSchema)).toMatch(/can be empty/);
    const photo = { type: 'image', label: 'Photo', default: { assetId: 'a', alt: '' }, required: true } as PropSchema;
    expect(requiredGap(titled({ type: 'number', label: 'N', default: 0 }), titled(photo))).toMatch(/“N” of “L” is a number, not a image/);
    const obj = (a: PropSchema): PropSchema => ({ type: 'object', label: 'O', fields: { a: a as never }, default: {} }) as PropSchema;
    expect(requiredGap(obj(str), obj({ ...str, required: true } as PropSchema))).toMatch(/its field “S” is required/);
    expect(guaranteesValue(obj({ ...str, required: true } as PropSchema))).toBe(true);
  });

  it('says which sources always have a value, field by field for lists and objects', () => {
    const str = (required = false): PropSchema => ({ type: 'string', label: 'S', default: 'x', ...(required ? { required } : {}) });
    expect(guaranteesValue(str())).toBe(false);
    expect(guaranteesValue(str(true))).toBe(true);
    expect(guaranteesValue({ type: 'number', label: 'N', default: 0 })).toBe(true);
    expect(guaranteesValue({ type: 'enum', label: 'E', default: 'a', options: [{ value: 'a', label: 'A' }, { value: '', label: 'None' }] })).toBe(false);
    expect(guaranteesValue({ type: 'list', label: 'L', itemLabel: 'I', fields: {}, default: [], required: true })).toBe(true);
    const list = (title: PropSchema): PropSchema => ({ type: 'list', label: 'L', itemLabel: 'I', fields: { title: title as never }, default: [] });
    expect(requiredGap(list(str()), list(str(true)))).toMatch(/its field “S” is required, but “S” of “L” can be empty/);
    expect(requiredGap(list(str(true)), list(str(true)))).toBeNull();
    expect(requiredGap({ type: 'list', label: 'L', itemLabel: 'I', fields: {}, default: [] }, list(str(true)))).toMatch(/has no field “title”/);
  });
});

describe('required values a placement already leaves empty (#748)', () => {
  it('lets an item or object already missing required values be filled one field at a time, and edited beside them', () => {
    const s = project();
    const fields = { title: { type: 'string', label: 'Title', default: 'T' }, note: { type: 'string', label: 'Note', default: 'N' }, extra: { type: 'string', label: 'Extra', default: '' } };
    const list = { type: 'list', label: 'Cards', itemLabel: 'Card', fields, default: [{ title: 'One', note: 'Two' }] };
    const box = { type: 'object', label: 'Box', fields, default: { title: 'One', note: 'Two' } };
    const { state, nodeId, definitionId } = placed(s, { cards: list, box });
    const page = home(state);
    const item = ((state.pages[state.site.homePageId].nodes[nodeId] as InstanceNode).props.cards as Array<{ id: string }>)[0].id;
    // Emptied while still optional, then made required.
    let st = applyOperations(state, [
      { type: 'instance.setProp', owner: page, nodeId, prop: 'cards', itemId: item, value: { title: '', note: '' } },
      { type: 'instance.setProp', owner: page, nodeId, prop: 'box', value: { title: '', note: '', extra: '' } }
    ]).state;
    const req = { title: { ...fields.title, required: true }, note: { ...fields.note, required: true }, extra: fields.extra };
    st = applyOperations(st, [
      { type: 'component.setPropSchema', definitionId, prop: 'cards', schema: { ...list, fields: req } },
      { type: 'component.setPropSchema', definitionId, prop: 'box', schema: { ...box, fields: req } }
    ]).state;
    expect(requiredProblems(st)).toHaveLength(4);
    st = applyOperations(st, [
      { type: 'instance.setProp', owner: page, nodeId, prop: 'cards', itemId: item, field: 'extra', value: 'x' },
      { type: 'instance.setProp', owner: page, nodeId, prop: 'cards', itemId: item, field: 'title', value: 'T' },
      { type: 'instance.setProp', owner: page, nodeId, prop: 'box', field: 'extra', value: 'x' },
      { type: 'instance.setProp', owner: page, nodeId, prop: 'box', field: 'note', value: 'N' }
    ]).state;
    const node = st.pages[st.site.homePageId].nodes[nodeId] as InstanceNode;
    expect((node.props.cards as Array<Record<string, unknown>>)[0]).toMatchObject({ id: item, title: 'T', note: '', extra: 'x' });
    expect(node.props.box).toEqual({ title: '', note: 'N', extra: 'x' });
    expect(requiredProblems(st).map((p) => p.message)).toEqual(['Home: Card → Cards → Card 1 → Note is required: it needs some text.', 'Home: Card → Box → Title is required: it needs some text.']);
    // A value once filled is never emptied again.
    expect(() => applyOperations(st, [{ type: 'instance.setProp', owner: page, nodeId, prop: 'cards', itemId: item, field: 'title', value: '' }])).toThrow(/Card 1 → Title is required/);
    expect(() => applyOperations(st, [{ type: 'instance.setProp', owner: page, nodeId, prop: 'box', field: 'note', value: ' ' }])).toThrow(/Box → Note is required/);
  });

  it('judges an object that leaves fields out by the defaults it shows, so clearing the last shown one is refused', () => {
    const s = project();
    const action = { type: 'object', label: 'Action', required: true, fields: { label: { type: 'string', label: 'Label' }, note: { type: 'string', label: 'Note' } }, default: { label: 'Go', note: '' } };
    const { state, nodeId } = placed(s, { action });
    const sparse = structuredClone(state);
    (sparse.pages[sparse.site.homePageId].nodes[nodeId] as InstanceNode).props.action = { note: '' };
    expect(requiredProblems(sparse)).toEqual([]);
    expect(() => applyOperations(sparse, [{ type: 'instance.setProp', owner: home(sparse), nodeId, prop: 'action', field: 'label', value: '' }])).toThrow(/Card → Action is required: at least one of its fields needs a value/);
  });

  it('refuses a schema change that would empty what a placement holds, while keeping what was empty already', () => {
    const s = project();
    const { state, definitionId, nodeId } = placed(s, { intro: { type: 'string', label: 'Intro', default: 'Hello' }, cards: { type: 'list', label: 'Cards', itemLabel: 'Card', fields: { title: { type: 'string', label: 'Title', default: 'Card' } }, default: [{ title: 'One' }] } });
    const page = home(state);
    // A ">" alone is a quote with nothing in it once it is rich text.
    const marked = applyOperations(state, [{ type: 'instance.setProp', owner: page, nodeId, prop: 'intro', value: '>' }]).state;
    expect(() => applyOperations(marked, [{ type: 'component.setPropSchema', definitionId, prop: 'intro', schema: { type: 'richtext', label: 'Intro', default: 'Hello', required: true } }])).toThrow(/Home: Card → Intro is required: it needs some text/);
    // The same field inside list items.
    const item = ((marked.pages[marked.site.homePageId].nodes[nodeId] as InstanceNode).props.cards as Array<{ id: string }>)[0].id;
    const rows = applyOperations(marked, [{ type: 'instance.setProp', owner: page, nodeId, prop: 'cards', itemId: item, field: 'title', value: '>' }]).state;
    expect(() => applyOperations(rows, [{ type: 'component.setPropSchema', definitionId, prop: 'cards', schema: { type: 'list', label: 'Cards', itemLabel: 'Card', fields: { title: { type: 'richtext', label: 'Title', default: 'Card', required: true } }, default: [{ title: 'One' }] } }])).toThrow(/Card 1 → Title is required/);
    // Retyped without the flag, it empties as before; empty already, it stays and is reported.
    const blank = applyOperations(state, [{ type: 'instance.setProp', owner: page, nodeId, prop: 'intro', value: '' }]).state;
    const kept = applyOperations(blank, [{ type: 'component.setPropSchema', definitionId, prop: 'intro', schema: { type: 'richtext', label: 'Intro', default: 'Hello', required: true } }]).state;
    expect(requiredProblems(kept).map((p) => p.message)).toEqual(['Home: Card → Intro is required: it needs some text.']);
  });

  it('reports a placement showing a default a hand edit left empty, and reads its field back from the problem’s key', () => {
    const s = project();
    const { state, nodeId, definitionId } = placed(s, { title: { type: 'string', label: 'Title', default: 'Hi' } });
    const st = applyOperations(state, [{ type: 'component.setPropSchema', definitionId, prop: 'url', schema: { type: 'link', label: 'Address', default: 'https://example.com/', required: true } }]).state;
    expect(Object.hasOwn((st.pages[st.site.homePageId].nodes[nodeId] as InstanceNode).props, 'url')).toBe(false);
    expect(requiredProblems(st)).toEqual([]);
    const edited = structuredClone(st);
    (edited.components[definitionId].properties.url as { default: unknown }).default = { type: 'none', target: '' };
    expect(requiredProblems(edited).map((p) => [p.nodeId ?? null, p.message])).toEqual([
      [null, 'Card → Address (default) is required: it needs a destination.'],
      [nodeId, 'Home: Card → Address is required: it needs a destination.']
    ]);
    const owner = home(st);
    const key = requiredProblems(edited)[1].key;
    expect(requiredSite(key, owner, nodeId)).toEqual({ prop: 'url' });
    expect(requiredSite(`page|${owner.id}|${nodeId}|cards|a|b|title`, owner, nodeId)).toEqual({ prop: 'cards', itemId: 'a|b', field: 'title' });
    expect(requiredSite(`page|${owner.id}|${nodeId}|action|label`, owner, nodeId)).toEqual({ prop: 'action', field: 'label' });
    expect(requiredSite(`page|${owner.id}|${nodeId}|title`, owner, nodeId)).toBeNull();
    expect(requiredSite(`default|${definitionId}|title|`, owner, nodeId)).toBeNull();
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

  it('reports each empty item field on its own, so a second one emptied is a new problem', () => {
    const s = project();
    const { state, nodeId } = placed(s, { cards: { type: 'list', label: 'Cards', itemLabel: 'Card', fields: { title: { type: 'string', label: 'Title', default: 'Card', required: true } }, default: [{ title: 'One' }, { title: 'Two' }] } });
    const one = structuredClone(state);
    const items = (one.pages[one.site.homePageId].nodes[nodeId] as InstanceNode).props.cards as Array<{ title: string }>;
    items[0].title = '';
    const two = structuredClone(one);
    ((two.pages[two.site.homePageId].nodes[nodeId] as InstanceNode).props.cards as Array<{ title: string }>)[1].title = ' ';
    expect(introducedDiagnostics(saving(one), saving(two)).map((d) => d.message)).toEqual(['Home: Card → Cards → Card 2 → Title is required: it needs some text.']);
  });

  it('reads an object’s left-out fields from its defaults, and checks a field’s own default apart from the items', () => {
    const s = project();
    const { state, nodeId, definitionId } = placed(s, {
      action: { type: 'object', label: 'Action', required: true, fields: { label: { type: 'string', label: 'Label' }, note: { type: 'string', label: 'Note' } }, default: { label: 'Go', note: '' } },
      links: { type: 'list', label: 'Links', itemLabel: 'Link', fields: { to: { type: 'link', label: 'To', default: 'https://example.com/', required: true } }, default: [] }
    });
    const edited = structuredClone(state);
    (edited.pages[edited.site.homePageId].nodes[nodeId] as InstanceNode).props.action = { note: '' };
    expect(requiredProblems(edited)).toEqual([]);
    // A package import strips a field's site link: every new item would start empty.
    const stripped = structuredClone(state);
    const links = stripped.components[definitionId].properties.links as { fields: Record<string, { default: unknown }> };
    links.fields.to.default = { type: 'none', target: '' };
    expect(requiredProblems(stripped).map((p) => p.message)).toEqual(['Card → Links → To (default) is required: it needs a destination.']);
  });
});

describe('required properties in a component package', () => {
  it('refuses exporting a required link to this site’s own page, which the package would leave going nowhere', () => {
    const s = project();
    const page = { type: 'page', target: s.site.homePageId };
    const { state, definitionId } = placed(s, { links: { type: 'list', label: 'Links', itemLabel: 'Link', fields: { to: { type: 'link', label: 'To', default: page, required: true } }, default: [] } });
    expect(() => planComponentPackage(state, definitionId)).toThrow(/Card → Links → To \(default\) is required: it needs a destination\. It goes to this site's own page/);
    const web = placed(project(), { links: { type: 'list', label: 'Links', itemLabel: 'Link', fields: { to: { type: 'link', label: 'To', default: 'https://example.com/', required: true } }, default: [] } });
    expect(() => planComponentPackage(web.state, web.definitionId)).not.toThrow();
  });

  it('blames only what the export empties: a problem the component already had, or an optional link, lets it go', () => {
    const s = project();
    const { state, definitionId } = placed(s, {
      title: { type: 'string', label: 'Title', default: 'Hi', required: true },
      more: { type: 'link', label: 'More', default: { type: 'page', target: s.site.homePageId } }
    });
    const damaged = structuredClone(state);
    (damaged.components[definitionId].properties.title as { default: unknown }).default = '';
    expect(() => planComponentPackage(damaged, definitionId)).not.toThrow();
  });

  it('checks a placement in the design against the packaged copy of its component', () => {
    const s = project();
    const inner = placed(s, { action: { type: 'object', label: 'Action', required: true, fields: { label: { type: 'string', label: 'Label' }, to: { type: 'link', label: 'To' } }, default: { label: '', to: { type: 'page', target: s.site.homePageId } } } });
    const made = applyOperations(inner.state, [{ type: 'component.create', name: 'Wrapper' }]);
    const { definitionId: wrapper, rootNodeId } = made.results[0] as { definitionId: string; rootNodeId: string };
    const st = applyOperations(made.state, [{ type: 'node.insert', owner: { kind: 'component', id: wrapper }, parentId: rootNodeId, definitionId: inner.definitionId, props: { action: { label: '' } } }]).state;
    expect(() => planComponentPackage(st, wrapper)).toThrow(/Action is required: at least one of its fields needs a value\. It goes to this site's own page/);
  });

  it('reads a damaged field schema as no field, never throwing', () => {
    const s = project();
    const { state, definitionId } = placed(s, { cards: { type: 'list', label: 'Cards', itemLabel: 'Card', fields: { title: { type: 'string', label: 'Title', default: 'Card', required: true }, note: { type: 'string', label: 'Note' } }, default: [] } });
    const damaged = structuredClone(state);
    (damaged.components[definitionId].properties.cards as { fields: Record<string, unknown> }).fields.note = null;
    expect(requiredProblems(damaged)).toEqual([]);
  });
});

describe('required properties carried by a swap', () => {
  it('starts a required list from its default items when the placement had none', () => {
    const s = project();
    const fields = { title: { type: 'string', label: 'Title', default: 'Card' } };
    const from = placed(s, { cards: { type: 'list', label: 'Cards', itemLabel: 'Card', fields, default: [] } });
    const made = applyOperations(from.state, [{ type: 'component.create', name: 'Strict' }]);
    const strict = (made.results[0] as { definitionId: string }).definitionId;
    const st = applyOperations(made.state, [{ type: 'component.setPropSchema', definitionId: strict, prop: 'cards', schema: { type: 'list', label: 'Cards', itemLabel: 'Card', required: true, fields, default: [{ title: 'Kept' }] } }]).state;
    const swapped = applyOperations(st, [{ type: 'instance.swapComponent', owner: home(st), nodeId: from.nodeId, definitionId: strict }]).state;
    const node = Object.values(swapped.pages[swapped.site.homePageId].nodes).find((n) => n.kind === 'instance' && n.definitionId === strict) as InstanceNode;
    expect((node.props.cards as Array<{ title: string }>).map((i) => i.title)).toEqual(['Kept']);
    expect(introducedDiagnostics(saving(st), saving(swapped))).toEqual([]);
  });
});

describe('required properties in the AI’s value checks', () => {
  it('checks an object patch against the placement’s own value, and refuses a required link that would wait for a page', () => {
    const s = project();
    const { state, definitionId } = placed(s, {
      action: { type: 'object', label: 'Action', required: true, fields: { label: { type: 'string', label: 'Label' }, link: { type: 'link', label: 'Link' } }, default: { label: 'Go' } },
      go: { type: 'link', label: 'Go', default: 'https://example.com/', required: true }
    });
    const def = state.components[definitionId];
    const issues: FieldIssue[] = [];
    checkProps(def, { action: { label: '' } }, state, 'props', issues, { action: { label: 'Go', link: { type: 'url', target: 'https://example.com/' } } });
    expect(issues).toEqual([]);
    const r = checkProps(def, { go: '/services/' }, state, 'props', issues);
    expect(r.deferred).toEqual([]);
    expect(issues.map((i) => [i.field, i.message])).toEqual([['props.go', 'no page uses the route /services/ yet, and “Go” is required, so it cannot wait for one: create that page first, then set this link']]);
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
    expect(propsJsonSchema({ properties: { go: { type: 'link', label: 'Go', default: { type: 'url', target: 'https://x.test/' }, required: true } } }).properties).toMatchObject({ go: { description: 'Go. An internal route such as /about/, an https:// URL, mailto:, tel:, #anchor. Required: it needs a destination.' } });
    expect(full.properties.note).not.toHaveProperty('minLength');
    expect((full.properties.photo.properties as Record<string, unknown>).assetId).toMatchObject({ type: 'string', minLength: 1 });
    expect(full.properties.cards).toMatchObject({ minItems: 1, items: { properties: { title: { minLength: 1 } } } });
    const compact = compactPropsSchema(def) as { properties: Record<string, Record<string, unknown>> };
    expect(compact.properties.photo).toEqual({ $ref: '#/$defs/requiredImage' });
    // The page tool defines the required image only where one refers to it: it is sent with every constrained request.
    expect((upsertToolSchema(state) as { $defs: Record<string, unknown> }).$defs).toHaveProperty('requiredImage');
    expect((upsertToolSchema(s) as { $defs: Record<string, unknown> }).$defs).not.toHaveProperty('requiredImage');
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
    expect(() => applyOperations(put.state, [{ type: 'instance.setProp', owner: home(s), nodeId, prop: 'items', itemId: items[1].id, field: 'answer', value: ' ' }])).toThrow(/Questions → Question 2 → Answer is required/);
  });

  it.each([
    ['testimonials.grid', 'items', 'quote', /Testimonials → Testimonial 1 → Quote is required/],
    ['team.grid', 'people', 'name', /People → Person 1 → Name is required/]
  ])('refuses clearing %s %s → %s', (componentId, prop, field, message) => {
    const s = createStarterState('blank', 'People', false);
    const put = applyOperations(s, [{ type: 'node.insert', owner: home(s), parentId: null, componentId }]);
    const nodeId = put.results[0].nodeId as string;
    const items = (put.state.pages[s.site.homePageId].nodes[nodeId] as InstanceNode).props[prop] as Array<{ id: string }>;
    expect(() => applyOperations(put.state, [{ type: 'instance.setProp', owner: home(s), nodeId, prop, itemId: items[0].id, field, value: '' }])).toThrow(message);
  });
});
