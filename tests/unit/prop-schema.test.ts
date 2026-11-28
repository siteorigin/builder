import { describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { normalizeProperties } from '@engine/schema';
import {
  addItemField,
  hiddenEdits,
  propertiesFromRows,
  removeItemField,
  renameNote,
  renamesFromRows,
  retype,
  rowsFromProperties,
  schemaProblems,
  setItemField,
  itemFieldNote,
  typeOptions,
  codePropsSync,
  declareFromCode,
  labelFromCodeName,
  removeProperties,
  starterUntouched,
  type SchemaRow
} from '../../src/renderer/src/lib/prop-schema';
import type { CodePropsTaken } from '@shared/api';
import { CODE_STARTER_PROPERTIES } from '@shared/code-starter';

const cards = {
  type: 'list',
  label: 'Cards',
  itemLabel: 'Card',
  titleField: 'title',
  fields: { title: { type: 'string', label: 'Title', default: '' }, count: { type: 'number', label: 'Count', default: 0 } },
  default: [{ id: 'i_one', title: 'First', count: 2 }]
};
const stored = { heading: { type: 'string', label: 'Heading', default: 'Hi' }, cards };
const named = (rows: SchemaRow[], name: string) => rows.find((r) => r.name === name)!;
const rename = (row: SchemaRow, name: string): SchemaRow => ({ ...row, name });

describe('property schema rows', () => {
  it('round-trips a schema, holding a list’s item fields as rows of their own', () => {
    const rows = rowsFromProperties(stored);
    // Exactly, key order included: the editor compares this text to tell an edited schema from the saved one.
    expect(JSON.stringify(propertiesFromRows(rows))).toBe(JSON.stringify(stored));
    const list = named(rows, 'cards');
    expect(list.fields!.map((f) => [f.name, f.orig])).toEqual([
      ['title', 'title'],
      ['count', 'count']
    ]);
    // Default items as written, not as the engine would write them, are kept exactly while the fields are unedited.
    const odd = { cards: { ...cards, default: [{ count: 2, id: 'i_one', title: 'First', note: 'extra' }] } };
    expect(JSON.stringify(propertiesFromRows(rowsFromProperties(odd)))).toBe(JSON.stringify(odd));
    // A schema that was never saved has nothing to rename.
    expect(rowsFromProperties(stored, false).every((r) => r.orig === undefined && r.fields?.every((f) => f.orig === undefined) !== false)).toBe(true);
  });

  it('names every stored property saved under a new name, including swaps and a new property reusing a name', () => {
    const rows = rowsFromProperties({ a: stored.heading, b: stored.heading, c: stored.heading });
    expect(renamesFromRows(rows)).toEqual([]);
    const edited = [rename(rows[0], 'b'), rename(rows[1], 'a'), rename(rows[2], ' d ')];
    // A property added in the editor has no stored name, so it is never a rename, even under a vacated name.
    const added: SchemaRow = { key: 'added', name: 'c', schema: { ...stored.heading } };
    expect(renamesFromRows([...edited, added])).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'c', to: 'd' }
    ]);
    expect(renameNote(edited[2])).toContain('update the source to read d');
    expect(renameNote(rows[0])).toBeNull();
    expect(renamesFromRows(rowsFromProperties({ a: stored.heading }, false).map((r) => rename(r, 'z')))).toEqual([]);
  });

  it('carries the content of placements through an edited schema with a rename', () => {
    let s: ProjectState = createStarterState('business', 'Test Studio', false);
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const c = applyOperations(s, [{ type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties: stored }]);
    s = c.state;
    const id = c.results[0].definitionId as string;
    const ins = applyOperations(s, [{ type: 'node.insert', owner, definitionId: id, props: { heading: 'Authored', cards: [{ id: 'i_mine', title: 'Mine', count: 7 }] } }]);
    s = ins.state;
    const rows = rowsFromProperties(s.components[id].properties);
    const edited = rows.map((r) => (r.name === 'heading' ? rename(r, 'title') : rename(r, 'items')));
    s = applyOperations(s, [{ type: 'component.updateSource', definitionId: id, source: '<p>y</p>\n', properties: propertiesFromRows(edited), renames: renamesFromRows(edited) }]).state;
    const props = (s.pages[s.site.homePageId].nodes[ins.results[0].nodeId as string] as InstanceNode).props;
    expect(props).toEqual({ title: 'Authored', items: [{ id: 'i_mine', title: 'Mine', count: 7 }] });
  });
});

describe('list item fields', () => {
  const state = () => createStarterState('blank', 'Blank', false);
  const listRow = () => named(rowsFromProperties(stored), 'cards');

  it('starts a new list with one text field and adds fields with unused names', () => {
    let row = retype(rowsFromProperties({ p: stored.heading })[0], 'list');
    expect(row.fields!.map((f) => [f.name, f.schema.type])).toEqual([['title', 'string']]);
    row = addItemField(addItemField(row));
    expect(row.fields!.map((f) => f.name)).toEqual(['title', 'field2', 'field3']);
    expect(normalizeProperties(propertiesFromRows([row]), state()).p).toMatchObject({ type: 'list', itemLabel: 'Item', fields: { title: { type: 'string' }, field2: { type: 'string' }, field3: { type: 'string' } } });
    // Leaving the list type leaves its fields behind.
    expect(retype(row, 'string').fields).toBeUndefined();
  });

  /** The list as saving would send it, checked by the engine. */
  const saved = (row: SchemaRow) => normalizeProperties(propertiesFromRows([row]), state())[row.name] as unknown as { titleField?: string; default: unknown[]; fields: Record<string, unknown>; pageTeaser?: unknown };

  it('keeps the title field and default items with a renamed field', () => {
    const row = listRow();
    const renamed = setItemField(row, 0, rename(row.fields![0], 'heading'));
    expect(itemFieldNote(renamed.fields![0])).toContain('“title”');
    expect(itemFieldNote(renamed.fields![1])).toBeNull();
    const out = saved(renamed);
    expect(Object.keys(out.fields)).toEqual(['heading', 'count']);
    expect(out.titleField).toBe('heading');
    expect(out.default).toEqual([{ id: 'i_one', heading: 'First', count: 2 }]);
    // A label change keeps the default items as they are.
    const relabelled = setItemField(row, 1, { ...row.fields![1], schema: { ...row.fields![1].schema, label: 'How many' } });
    expect((propertiesFromRows([relabelled]).cards as { default: unknown }).default).toEqual(cards.default);
  });

  it('moves values by the name each field was stored under, whatever names were typed in between', () => {
    const row = listRow();
    // count is renamed to title while title is still there, then corrected to total: title keeps its value.
    const typo = setItemField(row, 1, rename(row.fields![1], 'title'));
    const corrected = setItemField(typo, 1, rename(typo.fields![1], 'total'));
    expect(saved(corrected).default).toEqual([{ id: 'i_one', title: 'First', total: 2 }]);
    // A blank name on the way loses nothing either.
    const blank = setItemField(row, 0, rename(row.fields![0], ''));
    expect(saved(setItemField(blank, 0, rename(blank.fields![0], 'name'))).default).toEqual([{ id: 'i_one', name: 'First', count: 2 }]);
    // The same two fields swapped with their types: both values follow.
    const swapped = setItemField(setItemField(row, 0, rename(row.fields![0], 'count')), 1, rename(row.fields![1], 'title'));
    expect(swapped.fields!.map((f) => [f.name, f.schema.type])).toEqual([
      ['count', 'string'],
      ['title', 'number']
    ]);
    expect(saved(swapped).default).toEqual([{ id: 'i_one', count: 'First', title: 2 }]);
    expect(saved(swapped).titleField).toBe('count');
    // Renamed back again, the schema reads exactly as stored.
    const back = setItemField(swapped, 0, rename(swapped.fields![0], 'title'));
    expect(JSON.stringify(propertiesFromRows([setItemField(back, 1, rename(back.fields![1], 'count'))]))).toBe(JSON.stringify({ cards }));
  });

  it('drops a retyped or removed field, and a default value its field no longer offers', () => {
    const row = listRow();
    const retyped = setItemField(row, 1, retype(row.fields![1], 'boolean'));
    expect(retyped.fields![1].schema).toEqual({ type: 'boolean', label: 'Count' });
    expect(saved(retyped).default).toEqual([{ id: 'i_one', title: 'First', count: false }]);
    // Any field can title an item, so the title follows its field through a retype.
    expect(saved(setItemField(row, 0, retype(row.fields![0], 'icon'))).titleField).toBe('title');
    const removed = removeItemField(row, 0);
    expect(removed.fields!.map((f) => f.name)).toEqual(['count']);
    expect(saved(removed).titleField).toBeUndefined();
    expect(saved(removed).default).toEqual([{ id: 'i_one', count: 2 }]);
    // A new field with a removed field's name starts from its own default.
    const readded = setItemField(addItemField(removed), 1, rename(addItemField(removed).fields![1], 'title'));
    expect(saved(readded).default).toEqual([{ id: 'i_one', count: 2, title: '' }]);
    const tones = rowsFromProperties({
      tones: { type: 'list', label: 'Tones', fields: { tone: { type: 'enum', label: 'Tone', options: [{ value: 'old', label: 'Old' }, { value: 'new', label: 'New' }], default: 'new' }, size: { type: 'number', label: 'Size', default: 1 } }, default: [{ id: 'i_t', tone: 'old', size: 9 }] }
    })[0];
    const narrowed = setItemField(setItemField(tones, 0, { ...tones.fields![0], schema: { ...tones.fields![0].schema, options: [{ value: 'new', label: 'New' }] } }), 1, { ...tones.fields![1], schema: { ...tones.fields![1].schema, max: 5 } });
    expect(saved(narrowed).default).toEqual([{ id: 'i_t', tone: 'new', size: 1 }]);
  });

  it('keeps a page list’s mapping with its fields, and explains one it can no longer keep', () => {
    const pages = rowsFromProperties({
      pages: {
        type: 'list',
        label: 'Pages',
        fields: { url: { type: 'link', label: 'Link' }, name: { type: 'string', label: 'Name', default: '' }, photo: { type: 'image', label: 'Photo' } },
        pageTeaser: { link: 'url', title: 'name', image: 'photo' }
      }
    })[0];
    expect(saved(setItemField(pages, 1, rename(pages.fields![1], 'heading'))).pageTeaser).toEqual({ link: 'url', title: 'heading', image: 'photo' });
    // An optional mapping to a removed or retyped field is dropped; a required one is explained.
    expect(saved(removeItemField(pages, 2)).pageTeaser).toEqual({ link: 'url', title: 'name' });
    expect(saved(setItemField(pages, 2, retype(pages.fields![2], 'string'))).pageTeaser).toEqual({ link: 'url', title: 'name' });
    expect(schemaProblems([removeItemField(pages, 0)])).toEqual(['pages: its items show pages, using the field "url" as the link. Keep that field as it was, or revert.']);
  });
});

describe('schema problems', () => {
  it('reports what a row would otherwise lose before it is saved', () => {
    const row = named(rowsFromProperties(stored), 'cards');
    expect(schemaProblems([row])).toEqual([]);
    // Two fields with one name would collapse into one when the schema is built.
    const twice = setItemField(row, 1, rename(row.fields![1], 'title'));
    expect(Object.keys((propertiesFromRows([twice]).cards as { fields: object }).fields)).toEqual(['title']);
    expect(schemaProblems([twice])).toEqual(['cards: the field name "title" is used twice.']);
    expect(schemaProblems([removeItemField(removeItemField(row, 0), 0)])).toEqual(['cards: add at least one item field.']);
    let many = row;
    for (let i = 0; i < 19; i++) many = addItemField(many);
    expect(many.fields).toHaveLength(21);
    expect(schemaProblems([many])).toEqual(['cards: a list can have up to 20 item fields.']);
    expect(schemaProblems([setItemField(row, 0, rename(row.fields![0], 'Bad name'))])[0]).toMatch(/^cards: Field names must be camelCase/);
    expect(schemaProblems([setItemField(row, 0, rename(row.fields![0], 'item2'))])[0]).toMatch(/reserved/);
    const number = { key: 'n', name: 'size', schema: { type: 'number', label: 'Size', default: 0, min: 5, max: 1 } };
    expect(schemaProblems([number])).toEqual(['size: Maximum must be at least the minimum.']);
    const same = [rowsFromProperties({ a: stored.heading })[0], rowsFromProperties({ a: stored.heading })[0]];
    expect(schemaProblems(same)).toEqual(['The property name "a" is used twice.']);
    // The built schema keeps one of the two, so the edit is one it cannot show: it counts as unsaved.
    expect(JSON.stringify(propertiesFromRows(same))).toBe(JSON.stringify({ a: stored.heading }));
    expect(hiddenEdits(same)).toBe(true);
    expect(hiddenEdits([twice])).toBe(true);
    expect(hiddenEdits(rowsFromProperties(stored))).toBe(false);
  });

  it('holds text an item field refused, as for a property, so it is unsaved and blocks saving', () => {
    const list = named(rowsFromProperties(stored), 'cards');
    const refused = { default: { text: 'x', message: 'Default must be a number.' } };
    const bad = setItemField(list, 1, { ...list.fields![1], drafts: refused });
    expect(schemaProblems([bad])).toEqual(['cards → count: Default must be a number.']);
    // The marker makes the built schema differ from the stored one, so the edit reads as unsaved.
    expect(JSON.stringify(propertiesFromRows([bad]))).not.toBe(JSON.stringify({ cards }));
    expect(schemaProblems([{ ...list, drafts: { max: { text: 'lots', message: 'Most items must be a whole number from 0 to 1000.' } } }])).toEqual(['cards: Most items must be a whole number from 0 to 1000.']);
  });

  it('shows a stored type the editor does not offer, so it is not mistaken for another', () => {
    // An item field can be several choices; a property shows it only when it already is one.
    expect(typeOptions('string', true)).toContainEqual(['choices', 'Multiple choice']);
    expect(typeOptions('string', false).map(([t]) => t)).not.toContain('choices');
    expect(typeOptions('choices', false)[0]).toEqual(['choices', 'Multiple choice']);
    expect(typeOptions('string', true).map(([t]) => t)).not.toContain('list');
    expect(typeOptions('list', false).map(([t]) => t)).toContain('table');
  });
});

describe('properties from the props the code takes (#1527)', () => {
  const taken = (props: CodePropsTaken['props'], handed = false, axes: string[] = []): CodePropsTaken => ({ props, handed, axes });

  it('types each new property from the default the code writes, falsy ones included, and text for none', () => {
    const sync = codePropsSync([], taken([{ name: 'count', default: { value: 0 } }, { name: 'open', default: { value: false } }, { name: 'note', default: { value: '' } }, { name: 'ctaURL' }, { name: 'image', default: { value: null } }]));
    expect(sync.add).toEqual([
      { name: 'count', schema: { type: 'number', label: 'Count', default: 0 } },
      { name: 'open', schema: { type: 'boolean', label: 'Open', default: false } },
      { name: 'note', schema: { type: 'string', label: 'Note', default: '' } },
      { name: 'ctaURL', schema: { type: 'string', label: 'Cta url', default: '' } },
      { name: 'image', schema: { type: 'string', label: 'Image', default: '' } }
    ]);
    expect(sync.manual).toEqual([]);
  });

  it('leaves a list, an object or a worked-out default to declare by hand, and skips a name no property can have', () => {
    const sync = codePropsSync([], taken([{ name: 'tiers', default: { value: [] } }, { name: 'meta', default: { value: { a: 1 } } }, { name: 'total', computed: true }, { name: 'snake_case', default: { value: 'x' } }]));
    expect(sync.add).toEqual([]);
    expect(sync.manual).toEqual(['tiers', 'meta', 'total']);
  });

  it('takes the code’s default only where the property’s type and range take it', () => {
    const rows = rowsFromProperties({
      title: { type: 'string', label: 'Title', default: 'Hi' },
      price: { type: 'number', label: 'Price', default: 5, min: 0, max: 10 },
      body: { type: 'richtext', label: 'Body', default: '' },
      same: { type: 'boolean', label: 'Same', default: true }
    });
    const sync = codePropsSync(rows, taken([{ name: 'title', default: { value: 'Hello' } }, { name: 'price', default: { value: 50 } }, { name: 'body', default: { value: 'x' } }, { name: 'same', default: { value: true } }]));
    expect(sync.defaults).toEqual([{ name: 'title', was: 'Hi', value: 'Hello' }]);
    const next = declareFromCode(rows, sync);
    expect(next.map((r) => r.key)).toEqual(rows.map((r) => r.key));
    expect((propertiesFromRows(next).title as { default: unknown }).default).toBe('Hello');
  });

  it('matches a renamed row by its code name now, keeping it a rename', () => {
    const rows = rowsFromProperties({ title: { type: 'string', label: 'Title', default: 'Hi' } }).map((r) => ({ ...r, name: 'heading' }));
    const sync = codePropsSync(rows, taken([{ name: 'heading', default: { value: 'Hi' } }]));
    expect(sync).toEqual({ add: [], defaults: [], manual: [], unread: [] });
    expect(renamesFromRows(declareFromCode(rows, sync))).toEqual([{ from: 'title', to: 'heading' }]);
  });

  it('lists the properties the code never reads, but not its axes’ or any while it hands its props on', () => {
    const rows = rowsFromProperties({ a: { type: 'string', label: 'A', default: '' }, tone: { type: 'string', label: 'Tone', default: '' } });
    expect(codePropsSync(rows, taken([])).unread).toEqual(['a', 'tone']);
    expect(codePropsSync(rows, taken([], false, ['tone'])).unread).toEqual(['a']);
    expect(codePropsSync(rows, taken([], true)).unread).toEqual([]);
    expect(removeProperties(rows, ['a']).map((r) => r.name)).toEqual(['tone']);
  });

  it('tells an untouched starter property from one that was edited or saved', () => {
    const starter = rowsFromProperties(structuredClone(CODE_STARTER_PROPERTIES) as Record<string, unknown>, false);
    expect(starter.map(starterUntouched)).toEqual([true, true]);
    expect(starterUntouched({ ...starter[0], schema: { ...starter[0].schema, label: 'Title' } })).toBe(false);
    expect(starterUntouched({ ...starter[0], drafts: { default: { text: 'x', message: 'no' } } })).toBe(false);
    expect(rowsFromProperties(structuredClone(CODE_STARTER_PROPERTIES) as Record<string, unknown>).map(starterUntouched)).toEqual([false, false]);
  });

  it('labels a code name in words', () => {
    expect(labelFromCodeName('monthlyPrice')).toBe('Monthly price');
    expect(labelFromCodeName('heroCTALabel')).toBe('Hero cta label');
  });
});
