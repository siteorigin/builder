/**
 * The data table (issue #179): its stored value, the one-step edits the inspector and the AI make by row and column
 * ID, the Foundation section that shows it, and what the agent and the held-edit check read of it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, InstanceNode, ProjectState, TableValue } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent, getTheme, searchCatalogue } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { normalizePropSchema } from '@engine/schema';
import { TABLE_LIMITS, editTable, normalizeTable } from '@engine/table';
import { validateState } from '@engine/validate';
import { generateProject, defFile } from '@generator/index';
import { compactPropsSchema, hasOpenSchema, propJsonSchema } from '@agent/propschema';
import { findForbiddenShapes, toStrictSchema } from '@agent/strict-schema';
import { selectionTools } from '@agent/selection';
import { agentProps, compactNode, catalogueIndex } from '@agent/context';
import { OP_REACH } from '@agent/scope';
import { checkHeld, fieldKey, readField, shownField, typedText } from '../../src/renderer/src/lib/held';
import { addColumnNote, addRowNote, focusAfterRemove, readTable, removeColumnNote, rowTitle, tableCount, tableMoveAnnouncement, tableMoveFocus } from '../../src/renderer/src/lib/table-editor';
import { checkSvelteSource } from '../../src/main/codecheck';
import { ProjectSession } from '../../src/main/project/session';

const TIMETABLE = {
  columns: [
    { id: 'col_day', label: 'Day' },
    { id: 'col_workshop', label: 'Workshop' },
    { id: 'col_time', label: 'Start time' }
  ],
  rows: [
    { id: 'row_1', cells: { col_day: 'Monday', col_workshop: 'Wheel throwing', col_time: '10:00' } },
    { id: 'row_2', cells: { col_day: 'Wednesday', col_workshop: 'Hand building', col_time: '18:30' } },
    { id: 'row_3', cells: { col_day: 'Saturday', col_workshop: 'Glazing', col_time: '09:30' } }
  ]
} satisfies TableValue;

const refused = (run: () => unknown) => {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return (e as Error).message;
  }
  throw new Error('Expected the engine to refuse this');
};

/** A business starter with a Data table placed on the About page, through the same operation Insert uses. */
function withTable(): { s: ProjectState; owner: { kind: 'page'; id: string }; nodeId: string } {
  const s0 = createStarterState('business', 'Clay Studio', false);
  const about = Object.values(s0.pages).find((p) => p.route === '/about/')!;
  const owner = { kind: 'page' as const, id: about.id };
  const r = applyOperations(s0, [{ type: 'node.insert', owner, componentId: 'data.table' }]);
  return { s: r.state, owner, nodeId: r.results[0].nodeId as string };
}

const tableOf = (s: ProjectState, owner: { id: string }, nodeId: string) => (s.pages[owner.id].nodes[nodeId] as InstanceNode).props.table as TableValue;
const edit = (nodeId: string, owner: { kind: 'page'; id: string }, step: Omit<Extract<EditOperation, { type: 'instance.editTable' }>, 'type' | 'owner' | 'nodeId' | 'prop'>): EditOperation => ({
  type: 'instance.editTable',
  owner,
  nodeId,
  prop: 'table',
  ...step
});

describe('table values', () => {
  it('stores the short form models write with an ID for every column and row, and cells keyed by column', () => {
    const t = normalizeTable({ columns: ['Day', 'Workshop'], rows: [['Monday', 'Clay'], ['Friday']] }, 'Table');
    expect(t.columns.map((c) => c.label)).toEqual(['Day', 'Workshop']);
    expect(t.columns.every((c) => /^col_[a-z0-9]+$/.test(c.id))).toBe(true);
    expect(t.rows.every((r) => /^row_[a-z0-9]+$/.test(r.id))).toBe(true);
    expect(new Set(t.columns.map((c) => c.id)).size).toBe(2);
    expect(new Set(t.rows.map((r) => r.id)).size).toBe(2);
    const [day, workshop] = t.columns.map((c) => c.id);
    expect(t.rows.map((r) => r.cells)).toEqual([
      { [day]: 'Monday', [workshop]: 'Clay' },
      { [day]: 'Friday', [workshop]: '' }
    ]);
  });

  it('keeps the IDs it is given, and is unchanged when normalized again', () => {
    expect(normalizeTable(TIMETABLE, 'Table')).toEqual(TIMETABLE);
    expect(normalizeTable(normalizeTable(TIMETABLE, 'Table'), 'Table')).toEqual(TIMETABLE);
  });

  it('turns numbers into text and line breaks into spaces', () => {
    const t = normalizeTable({ columns: ['Size'], rows: [[12], ['two\nlines']] }, 'Table');
    expect(t.rows.map((r) => Object.values(r.cells)[0])).toEqual(['12', 'two lines']);
  });

  it.each([
    ['no columns', { columns: [], rows: [] }, 'at least one column'],
    ['a column with no name', { columns: ['Day', '  '], rows: [] }, 'every column needs a name'],
    ['a row with more cells than columns', { columns: ['Day'], rows: [['Monday', 'extra']] }, 'has 2 cells, but the table has 1 column'],
    ['a cell under a column the table does not have', { columns: [{ id: 'col_a', label: 'A' }], rows: [{ id: 'row_1', cells: { col_b: 'lost' } }] }, 'no column has the ID "col_b"'],
    ['a column ID used twice', { columns: [{ id: 'col_a', label: 'A' }, { id: 'col_a', label: 'B' }], rows: [] }, 'used twice'],
    ['a row ID used twice', { columns: ['A'], rows: [{ id: 'row_1', cells: {} }, { id: 'row_1', cells: {} }] }, 'used twice'],
    ['an ID in the wrong form', { columns: [{ id: 'assetId', label: 'A' }], rows: [] }, 'is not a valid ID'],
    ['too many columns', { columns: Array.from({ length: TABLE_LIMITS.columns + 1 }, (_, i) => `C${i}`), rows: [] }, `at most ${TABLE_LIMITS.columns} columns`],
    ['far too many columns', { columns: Array.from({ length: TABLE_LIMITS.columns + 5 }, (_, i) => `C${i}`), rows: [] }, `at most ${TABLE_LIMITS.columns} columns`],
    ['a cell that is not text', { columns: ['A'], rows: [[{ text: 'x' }]] }, 'expected text'],
    ['a row object with keys a row does not have', { columns: ['Day'], rows: [{ Day: 'Friday' }] }, '"Day" is not part of a row'],
    ['a column object with keys a column does not have', { columns: [{ label: 'Day', width: 2 }], rows: [] }, '"width" is not part of a column'],
    ['a table with keys a table does not have', { columns: ['Day'], rows: [], caption: 'x' }, '"caption" is not part of a table'],
    ['a shortened view written back as the whole table', { columns: [{ id: 'col_a', label: 'A' }], rows: [{ id: 'row_1', cells: ['x…'] }], cellsClipped: true, note: 'Long cells are shortened' }, 'shortened view'],
    ['too many rows', { columns: ['A'], rows: Array.from({ length: TABLE_LIMITS.rows + 1 }, () => ['x']) }, `at most ${TABLE_LIMITS.rows} rows`],
    ['a cell that is too long', { columns: ['A'], rows: [['x'.repeat(TABLE_LIMITS.cell + 1)]] }, `longer than ${TABLE_LIMITS.cell}`],
    ['something that is not a table', ['Day', 'Workshop'], 'expected a table']
  ])('refuses %s, losing nothing silently', (_name, value, message) => {
    expect(refused(() => normalizeTable(value, 'Table'))).toContain(message);
  });
});

describe('table edits by ID', () => {
  it('builds the timetable from Insert, then adds, renames, reorders and removes while every other cell stays put', () => {
    const { s: s0, owner, nodeId } = withTable();
    expect(tableOf(s0, owner, nodeId)).toEqual(TIMETABLE);
    const added = applyOperations(s0, [edit(nodeId, owner, { action: 'insertRow', cells: ['Friday', 'Raku', '17:00'] })]);
    const rowId = added.results[0].rowId as string;
    expect(rowId).toMatch(/^row_/);
    let s = added.state;
    expect(tableOf(s, owner, nodeId).rows.at(-1)).toEqual({ id: rowId, cells: { col_day: 'Friday', col_workshop: 'Raku', col_time: '17:00' } });
    s = applyOperations(s, [edit(nodeId, owner, { action: 'renameColumn', columnId: 'col_time', value: 'Starts' })]).state;
    s = applyOperations(s, [edit(nodeId, owner, { action: 'moveColumn', columnId: 'col_time', index: 0 })]).state;
    s = applyOperations(s, [edit(nodeId, owner, { action: 'moveRow', rowId, index: 0 })]).state;
    s = applyOperations(s, [edit(nodeId, owner, { action: 'removeColumn', columnId: 'col_workshop' })]).state;
    const t = tableOf(s, owner, nodeId);
    expect(t.columns).toEqual([
      { id: 'col_time', label: 'Starts' },
      { id: 'col_day', label: 'Day' }
    ]);
    expect(t.rows).toEqual([
      { id: rowId, cells: { col_day: 'Friday', col_time: '17:00' } },
      { id: 'row_1', cells: { col_day: 'Monday', col_time: '10:00' } },
      { id: 'row_2', cells: { col_day: 'Wednesday', col_time: '18:30' } },
      { id: 'row_3', cells: { col_day: 'Saturday', col_time: '09:30' } }
    ]);
    const withColumn = applyOperations(s, [edit(nodeId, owner, { action: 'insertColumn', index: 1 })]);
    const columnId = withColumn.results[0].columnId as string;
    expect(columnId).toMatch(/^col_/);
    const grown = tableOf(withColumn.state, owner, nodeId);
    expect(grown.columns.map((c) => c.label)).toEqual(['Starts', 'Column 3', 'Day']);
    expect(grown.rows.every((r) => r.cells[columnId] === '' && r.cells.col_day && r.cells.col_time)).toBe(true);
    const removed = applyOperations(withColumn.state, [edit(nodeId, owner, { action: 'removeRow', rowId: 'row_2' })]).state;
    expect(tableOf(removed, owner, nodeId).rows.map((r) => r.id)).toEqual([rowId, 'row_1', 'row_3']);
    expect(validateState(removed).filter((d) => d.severity !== 'info')).toEqual([]);
  });

  it('keeps a cell typed just before its column was moved: each step names its cell, never the whole table', () => {
    const { s: s0, owner, nodeId } = withTable();
    // The inspector sends the blur's cell edit, then the click's move, each built from the same older view.
    const s = applyOperations(s0, [edit(nodeId, owner, { action: 'setCell', rowId: 'row_2', columnId: 'col_time', value: '19:00' })]).state;
    const after = applyOperations(s, [edit(nodeId, owner, { action: 'moveColumn', columnId: 'col_time', index: 0 })]).state;
    const t = tableOf(after, owner, nodeId);
    expect(t.columns[0].id).toBe('col_time');
    expect(t.rows[1].cells).toEqual({ col_day: 'Wednesday', col_workshop: 'Hand building', col_time: '19:00' });
    expect(t.rows[0].cells).toEqual(TIMETABLE.rows[0].cells);
  });

  it('refuses a step whose row or column has gone, instead of bringing it back', () => {
    const { s: s0, owner, nodeId } = withTable();
    const s = applyOperations(s0, [edit(nodeId, owner, { action: 'removeColumn', columnId: 'col_time' })]).state;
    expect(refused(() => applyOperations(s, [edit(nodeId, owner, { action: 'setCell', rowId: 'row_1', columnId: 'col_time', value: '11:00' })]))).toContain('no column has the ID "col_time"');
    expect(refused(() => applyOperations(s, [edit(nodeId, owner, { action: 'removeRow', rowId: 'row_9' })]))).toContain('no row has the ID "row_9"');
    expect(tableOf(s, owner, nodeId).columns.map((c) => c.id)).toEqual(['col_day', 'col_workshop']);
  });

  it('keeps one column, the size limits and named columns', () => {
    const { s: s0, owner, nodeId } = withTable();
    let s = applyOperations(s0, [edit(nodeId, owner, { action: 'removeColumn', columnId: 'col_time' }), edit(nodeId, owner, { action: 'removeColumn', columnId: 'col_workshop' })]).state;
    expect(refused(() => applyOperations(s, [edit(nodeId, owner, { action: 'removeColumn', columnId: 'col_day' })]))).toContain('at least one column');
    expect(refused(() => applyOperations(s, [edit(nodeId, owner, { action: 'renameColumn', columnId: 'col_day', value: '' })]))).toContain('needs a name');
    const wide = { columns: Array.from({ length: TABLE_LIMITS.columns }, (_, i) => `C${i}`), rows: [] };
    const sWide = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'table', value: wide }]).state;
    expect(refused(() => applyOperations(sWide, [edit(nodeId, owner, { action: 'insertColumn' })]))).toContain(`at most ${TABLE_LIMITS.columns} columns`);
    const full = { columns: ['A'], rows: Array.from({ length: TABLE_LIMITS.rows }, () => ['x']) };
    s = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'table', value: full }]).state;
    expect(refused(() => applyOperations(s, [edit(nodeId, owner, { action: 'insertRow' })]))).toContain(`at most ${TABLE_LIMITS.rows} rows`);
  });

  it('edits the definition’s table for a placement that has none of its own', () => {
    const { s: s0, owner, nodeId } = withTable();
    delete (s0.pages[owner.id].nodes[nodeId] as InstanceNode).props.table;
    const s = applyOperations(s0, [edit(nodeId, owner, { action: 'setCell', rowId: 'row_3', columnId: 'col_workshop', value: 'Raku' })]).state;
    expect(tableOf(s, owner, nodeId).rows.map((r) => r.cells.col_workshop)).toEqual(['Wheel throwing', 'Hand building', 'Raku']);
    // The definition's own table, which other placements show, is unchanged.
    const def = s.components[(s.pages[owner.id].nodes[nodeId] as InstanceNode).definitionId];
    expect(def.properties.table.default).toEqual(TIMETABLE);
  });

  it('needs the text it writes: a missing value never clears a cell, and "" does', () => {
    const { s, owner, nodeId } = withTable();
    expect(refused(() => applyOperations(s, [edit(nodeId, owner, { action: 'setCell', rowId: 'row_2', columnId: 'col_time' })]))).toContain('setCell needs a value');
    expect(refused(() => applyOperations(s, [edit(nodeId, owner, { action: 'renameColumn', columnId: 'col_time' })]))).toContain('renameColumn needs a value');
    const cleared = applyOperations(s, [edit(nodeId, owner, { action: 'setCell', rowId: 'row_2', columnId: 'col_time', value: '' })]).state;
    expect(tableOf(cleared, owner, nodeId).rows[1].cells.col_time).toBe('');
  });

  it('reports a damaged saved table, and editing it keeps what can be read', () => {
    const { s: s0, owner, nodeId } = withTable();
    const node = s0.pages[owner.id].nodes[nodeId] as InstanceNode;
    node.props.table = { ...TIMETABLE, columns: [...TIMETABLE.columns, null], rows: [TIMETABLE.rows[0], null, { ...TIMETABLE.rows[1], cells: { ...TIMETABLE.rows[1].cells, col_gone: 'x' } }] };
    expect(validateState(s0).filter((d) => d.code === 'TABLE_DAMAGED').map((d) => d.nodeId)).toEqual([nodeId]);
    const s = applyOperations(s0, [edit(nodeId, owner, { action: 'setCell', rowId: 'row_2', columnId: 'col_time', value: '19:00' })]).state;
    expect(tableOf(s, owner, nodeId)).toEqual({ columns: TIMETABLE.columns, rows: [TIMETABLE.rows[0], { ...TIMETABLE.rows[1], cells: { ...TIMETABLE.rows[1].cells, col_time: '19:00' } }] });
    expect(validateState(s).filter((d) => d.code === 'TABLE_DAMAGED')).toEqual([]);
  });

  it('refuses a table step on a property that is not a table', () => {
    const { s, owner, nodeId } = withTable();
    expect(refused(() => applyOperations(s, [{ ...edit(nodeId, owner, { action: 'insertRow' }), prop: 'caption' } as EditOperation]))).toContain('not a table property');
  });

  it('applies the same pure step the engine uses', () => {
    const r = editTable(TIMETABLE, { action: 'moveRow', rowId: 'row_3', index: 0 }, 'Table');
    expect(r.value.rows.map((x) => x.id)).toEqual(['row_3', 'row_1', 'row_2']);
    expect(editTable(TIMETABLE, { action: 'moveRow', rowId: 'row_1', index: 1 }, 'Table').value.rows.map((x) => x.id)).toEqual(['row_2', 'row_1', 'row_3']);
    expect(editTable(TIMETABLE, { action: 'moveColumn', columnId: 'col_day', index: 9 }, 'Table').value.columns.map((x) => x.id)).toEqual(['col_workshop', 'col_time', 'col_day']);
    expect(TIMETABLE.rows.map((x) => x.id)).toEqual(['row_1', 'row_2', 'row_3']);
  });

  it('is an operation the run authority treats as a change to one element', () => {
    expect(OP_REACH['instance.editTable']).toBe('node');
    expect(validateOperation({ type: 'instance.editTable', owner: { kind: 'page', id: 'p' }, nodeId: 'n', prop: 'table', action: 'explode' }).ok).toBe(false);
    expect(validateOperation({ type: 'instance.editTable', owner: { kind: 'page', id: 'p' }, nodeId: 'n', prop: 'table', action: 'insertRow', cells: ['a'] }).ok).toBe(true);
    expect(validateOperation({ type: 'instance.editTable', owner: { kind: 'page', id: 'p' }, nodeId: 'n', prop: 'table', action: 'moveRow', rowId: 'row_1', index: -1 }).ok).toBe(false);
  });
});

describe('the Data table section', () => {
  it('is found in Insert search by "table", "timetable" and "comparison"', () => {
    for (const q of ['table', 'timetable', 'comparison']) expect(searchCatalogue('foundation', q)[0]?.componentId, q).toBe('data.table');
  });

  it('has the same contract in every theme', () => {
    const a = catalogueComponent('foundation', 'data.table')!;
    const b = catalogueComponent('foundation-alt', 'data.table')!;
    expect(b.properties).toEqual(a.properties);
    expect(Object.keys(getTheme('foundation-alt').components.find((c) => c.componentId === 'data.table')!.variantAxes!.tone.options)).toEqual(['default', 'muted', 'inverse']);
  });

  it('ships source the code check accepts', async () => {
    const def = catalogueComponent('foundation', 'data.table')!;
    expect((await checkSvelteSource(def.source!)).filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('exports the table value into the page, the same bytes every time, with no editor attributes', () => {
    const { s: s0, owner, nodeId } = withTable();
    const s = applyOperations(s0, [edit(nodeId, owner, { action: 'setCell', rowId: 'row_1', columnId: 'col_workshop', value: 'Raku firing' })]).state;
    const files = generateProject(s);
    const def = s.components[(s.pages[owner.id].nodes[nodeId] as InstanceNode).definitionId];
    expect(files.get(defFile(def))).toContain('<th scope="col">');
    const page = files.get('src/routes/about/+page.svelte')!;
    expect(page).toContain('"col_workshop"');
    expect(page).toContain('Raku firing');
    expect(page).not.toContain('Wheel throwing');
    expect(page).not.toContain('data-so-');
    expect([...generateProject(structuredClone(s)).entries()]).toEqual([...files.entries()]);
  });

  it('keeps the table, IDs and all, when the theme is switched', () => {
    const { s: s0, owner, nodeId } = withTable();
    const edited = applyOperations(s0, [edit(nodeId, owner, { action: 'insertRow', cells: ['Friday', 'Raku', '17:00'] })]);
    const before = tableOf(edited.state, owner, nodeId);
    const s = applyOperations(edited.state, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state;
    const node = s.pages[owner.id].nodes[nodeId] as InstanceNode;
    expect(s.components[node.definitionId].provenance?.pack).toBe('foundation-alt');
    expect(s.components[node.definitionId].parts.root).toEqual(catalogueComponent('foundation', 'data.table')!.parts.root);
    expect(node.props.table).toEqual(before);
    expect(before.rows).toHaveLength(4);
  });
});

describe('table properties in component schemas', () => {
  const state = createStarterState('business', 'Test', false);
  it('allows a table property with a valid default, and keeps one it is given', () => {
    const schema = normalizePropSchema({ type: 'table', label: 'Prices' }, state, 'prices');
    expect(schema.type).toBe('table');
    expect((schema.default as TableValue).columns.map((c) => c.label)).toEqual(['Column 1', 'Column 2']);
    expect(normalizePropSchema({ type: 'table', label: 'Hours', default: TIMETABLE }, state, 'hours').default).toEqual(TIMETABLE);
  });
  it('refuses a table inside a list item', () => {
    expect(refused(() => normalizePropSchema({ type: 'list', fields: { grid: { type: 'table' } } }, state, 'items'))).toContain('needs a type of');
  });
});

describe('the AI’s view of a table', () => {
  it('writes a whole table through a closed, strict schema in both forms', () => {
    const def = catalogueComponent('foundation', 'data.table')!;
    const full = propJsonSchema(def.properties.table);
    expect(full).toMatchObject({ type: 'object', required: ['columns', 'rows'], additionalProperties: false });
    expect((full.properties as Record<string, { items: unknown }>).rows.items).toMatchObject({ type: 'array', items: { type: 'string' } });
    const compact = compactPropsSchema(def);
    expect((compact.properties as Record<string, unknown>).table).toMatchObject({ type: 'object', additionalProperties: false });
    expect(hasOpenSchema(full)).toBe(false);
    expect(hasOpenSchema(compact)).toBe(false);
  });

  it('offers a focused tool for one cell, row or column of a selected table', () => {
    const { s, owner, nodeId } = withTable();
    const tools = selectionTools(s, { owner, nodeId })!;
    const tool = tools.find((t) => t.name === 'edit_selected_table')!;
    expect((tool.parameters.properties as Record<string, { enum?: string[] }>).prop.enum).toEqual(['table']);
    for (const t of tools) {
      expect(hasOpenSchema(t.parameters), t.name).toBe(false);
      expect(findForbiddenShapes(toStrictSchema(t.parameters)), t.name).toEqual([]);
    }
  });

  it('describes the type in the catalogue index', () => {
    const entry = catalogueIndex('foundation').find((e) => e.componentId === 'data.table')!;
    expect(entry.props.table).toContain('table{columns:string[], rows:string[][]}');
  });

  it('shows every row and column ID, and says when it shortens cells, even for the largest table', () => {
    const { s: s0, owner, nodeId } = withTable();
    type Summary = { columns: Array<{ id: string; label: string }>; rows: Array<{ id: string; cells: string[] }>; cellsClipped?: boolean; note?: string };
    const columns = Array.from({ length: TABLE_LIMITS.columns }, (_, i) => `Column ${i + 1}`);
    const rows = Array.from({ length: TABLE_LIMITS.rows }, (_, r) => columns.map((_, c) => `${r + 1}.${c + 1} ${'x'.repeat(200)}`));
    const s = applyOperations(s0, [{ type: 'instance.setProp', owner, nodeId, prop: 'table', value: { columns, rows } }]).state;
    const stored = tableOf(s, owner, nodeId);
    const props = compactNode(s, s.pages[owner.id], nodeId).props as { table: Summary };
    expect(props.table.columns.map((c) => c.id)).toEqual(stored.columns.map((c) => c.id));
    expect(props.table.rows.map((r) => r.id)).toEqual(stored.rows.map((r) => r.id));
    expect(props.table.rows[59].cells[11]).toMatch(/^60\.12 x+…$/);
    expect(props.table.cellsClipped).toBe(true);
    expect(props.table.note).toContain('instance.editTable');
    expect(JSON.stringify(props).length).toBeLessThan(20000);
    // Full props (inspect_element) shorten only a table too large to show whole, and it can never be written back.
    const full = agentProps(s.components[(s.pages[owner.id].nodes[nodeId] as InstanceNode).definitionId], (s.pages[owner.id].nodes[nodeId] as InstanceNode).props, s.pages, true);
    expect((full.table as Summary).rows).toHaveLength(TABLE_LIMITS.rows);
    expect(refused(() => applyOperations(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'table', value: full.table }]))).toContain('shortened view');
    // A table shown whole reads back as exactly the stored table.
    const small = compactNode(s0, s0.pages[owner.id], nodeId).props as { table: Summary };
    expect(small.table).not.toHaveProperty('note');
    expect(normalizeTable(small.table, 'Table')).toEqual(TIMETABLE);
  });

  it('shows a table a placement takes from its definition, and never mistakes other props for one', () => {
    const { s, owner, nodeId } = withTable();
    const node = s.pages[owner.id].nodes[nodeId] as InstanceNode;
    delete node.props.table;
    expect((compactNode(s, s.pages[owner.id], nodeId).props as { table: { rows: Array<{ id: string }> } }).table.rows.map((r) => r.id)).toEqual(['row_1', 'row_2', 'row_3']);
    const lists = { properties: { columns: { type: 'list', label: 'Columns', itemLabel: 'Column', fields: { title: { type: 'string', label: 'Title', default: '' } }, default: [] }, rows: { type: 'list', label: 'Rows', itemLabel: 'Row', fields: { title: { type: 'string', label: 'Title', default: '' } }, default: [] } } } as unknown as ComponentDefinition;
    const props = { columns: [{ id: 'i_1', title: 'Plans' }], rows: [{ id: 'i_2', title: 'Monthly' }] };
    expect(agentProps(lists, props, s.pages)).toEqual(props);
  });
});

describe('typed table edits held while the AI works', () => {
  it('reads a cell and a column name as fields, and leaves gestures to be refused', () => {
    const { s, owner, nodeId } = withTable();
    const cell = edit(nodeId, owner, { action: 'setCell', rowId: 'row_2', columnId: 'col_time', value: '19:00' });
    const name = edit(nodeId, owner, { action: 'renameColumn', columnId: 'col_day', value: 'When' });
    expect(readField(s, cell)).toMatchObject({ found: true, value: { value: '18:30' } });
    expect(readField(s, name)).toMatchObject({ found: true, value: { value: 'Day' } });
    expect(shownField(cell, (readField(s, cell) as { value: unknown }).value)).toBe('18:30');
    expect(typedText(cell)).toBe('19:00');
    expect(readField(s, edit(nodeId, owner, { action: 'insertRow' }))).toBeNull();
    // Two cells are two fields; the same cell typed again is the same field.
    const other = edit(nodeId, owner, { action: 'setCell', rowId: 'row_1', columnId: 'col_time', value: '19:00' });
    const sameRow = edit(nodeId, owner, { action: 'setCell', rowId: 'row_2', columnId: 'col_day', value: '19:00' });
    expect(fieldKey([cell])).not.toBe(fieldKey([other]));
    expect(fieldKey([cell])).not.toBe(fieldKey([sameRow]));
    expect(fieldKey([cell])).toBe(fieldKey([{ ...cell, value: '20:00' } as EditOperation]));
  });

  it('notices a row given other content under the same ID, even when the edited cell reads the same', () => {
    const { s, owner, nodeId } = withTable();
    const cell = edit(nodeId, owner, { action: 'setCell', rowId: 'row_1', columnId: 'col_time', value: '11:00' });
    const base = [(readField(s, cell) as { value: unknown }).value];
    const replaced = { ...TIMETABLE, rows: [{ id: 'row_1', cells: { col_day: 'Sunday', col_workshop: 'Raku', col_time: '10:00' } }, ...TIMETABLE.rows.slice(1)] };
    const after = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'table', value: replaced }]).state;
    expect(checkHeld(after, [cell], base).kind).toBe('changed');
    expect(checkHeld(s, [cell], base).kind).toBe('apply');
  });

  it('reports a removed row or column as gone', () => {
    const { s: s0, owner, nodeId } = withTable();
    const s = applyOperations(s0, [edit(nodeId, owner, { action: 'removeRow', rowId: 'row_2' })]).state;
    expect(readField(s, edit(nodeId, owner, { action: 'setCell', rowId: 'row_2', columnId: 'col_time', value: 'x' }))).toEqual({ found: false, what: 'table row' });
    expect(readField(s, edit(nodeId, owner, { action: 'renameColumn', columnId: 'col_nope', value: 'x' }))).toEqual({ found: false, what: 'table column' });
  });
});

describe('the table editor’s wording and focus', () => {
  it('names rows by their first cells, and counts the table', () => {
    expect(rowTitle(TIMETABLE, TIMETABLE.rows[0], 0)).toBe('Monday · Wheel throwing');
    expect(rowTitle(TIMETABLE, { id: 'row_x', cells: { col_day: '', col_workshop: 'Raku', col_time: '17:00' } }, 0)).toBe('Raku · 17:00');
    expect(rowTitle(TIMETABLE, { id: 'row_x', cells: {} }, 3)).toBe('Row 4');
    expect(tableCount(TIMETABLE)).toBe('3 columns · 3 rows');
    expect(tableCount({ columns: [TIMETABLE.columns[0]], rows: [TIMETABLE.rows[0]] })).toBe('1 column · 1 row');
  });

  it('reads an odd value without failing', () => {
    expect(readTable({ columns: [null, { id: 'col_a', label: 'A' }], rows: 'x' }, TIMETABLE)).toEqual({ columns: [{ id: 'col_a', label: 'A' }], rows: [] });
    expect(readTable(undefined, TIMETABLE)).toEqual(TIMETABLE);
  });

  it('says why Add or Remove does nothing at a limit', () => {
    expect(addRowNote(TABLE_LIMITS.rows - 1)).toBeNull();
    expect(addRowNote(TABLE_LIMITS.rows)).toContain(`at most ${TABLE_LIMITS.rows} rows`);
    expect(addColumnNote(TABLE_LIMITS.columns)).toContain(`at most ${TABLE_LIMITS.columns} columns`);
    expect(addColumnNote(TABLE_LIMITS.columns - 1)).toBeNull();
    expect(removeColumnNote(1)).toContain('at least one column');
    expect(removeColumnNote(2)).toBeNull();
  });

  it('moves focus to the next entry still there, then the previous, then Add, judged when the removal lands', () => {
    expect(focusAfterRemove(['a', 'b', 'c'], 'b', new Set(['a', 'c']))).toBe('c');
    expect(focusAfterRemove(['a', 'b', 'c'], 'a', new Set(['b', 'c']))).toBe('b');
    expect(focusAfterRemove(['a', 'b', 'c'], 'c', new Set(['a', 'b']))).toBe('b');
    expect(focusAfterRemove(['a'], 'a', new Set())).toBeNull();
    // Two quick removals: B, then A (whose next was B) once B has gone too.
    expect(focusAfterRemove(['a', 'b', 'c'], 'a', new Set(['c']))).toBe('c');
  });

  it('keeps focus on a move button while it still works, and announces the new place', () => {
    expect(tableMoveFocus('left', 1, 3)).toBe('left');
    expect(tableMoveFocus('left', 0, 3)).toBe('head');
    expect(tableMoveFocus('down', 1, 3)).toBe('down');
    expect(tableMoveFocus('right', 2, 3)).toBe('head');
    expect(tableMoveAnnouncement('column', 'Start time', 0, 3)).toBe('Column Start time moved to position 1 of 3');
    expect(tableMoveAnnouncement('row', 'Monday · Clay', 2, 4)).toBe('Row Monday · Clay moved to position 3 of 4');
  });
});

describe('a table in a saved project (issue #179)', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('adds a fourth workshop, undoes it, and reopens with the same table and IDs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-table-'));
    dirs.push(dir);
    const { s: start, owner, nodeId } = withTable();
    const s = await ProjectSession.create(dir, start);
    const added = await s.apply({ operations: [edit(nodeId, owner, { action: 'insertRow' })] }, { label: 'Edit Table' });
    const rowId = added.results![0].rowId as string;
    // Typing in one cell is one step, however many times it is saved; another cell is another step.
    const cell = (columnId: string, value: string) => s.apply({ operations: [edit(nodeId, owner, { action: 'setCell', rowId, columnId, value })] }, { label: 'Edit Table', coalesceKey: `${nodeId}:table:${rowId}:${columnId}` });
    await cell('col_day', 'Fri');
    await cell('col_day', 'Friday');
    await cell('col_workshop', 'Raku');
    expect(tableOf(s.state, owner, nodeId).rows.at(-1)!.cells).toEqual({ col_day: 'Friday', col_workshop: 'Raku', col_time: '' });
    await s.undo();
    expect(tableOf(s.state, owner, nodeId).rows.at(-1)!.cells).toEqual({ col_day: 'Friday', col_workshop: '', col_time: '' });
    await s.undo();
    expect(tableOf(s.state, owner, nodeId).rows.at(-1)!.cells.col_day).toBe('');
    await s.undo();
    expect(tableOf(s.state, owner, nodeId)).toEqual(TIMETABLE);
    await s.redo();
    await s.close();
    const again = await ProjectSession.open(dir, 'test');
    const t = tableOf(again.state, owner, nodeId);
    expect(t.rows.map((r) => r.id)).toEqual(['row_1', 'row_2', 'row_3', rowId]);
    expect(t.columns).toEqual(TIMETABLE.columns);
    expect(again.historyInfo().canUndo).toBe(true);
    await again.undo();
    expect(tableOf(again.state, owner, nodeId)).toEqual(TIMETABLE);
    await again.close();
  });
});
