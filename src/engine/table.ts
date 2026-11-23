/**
 * Data tables: named columns and rows of plain text (`TableValue` in shared/types.ts).
 *
 * Cells are keyed by column ID, so a column moved or removed keeps every other cell where it was. Whole tables
 * are checked here on every write, and the editor changes them one step at a time by ID (`editTable`), so a
 * change made from an older copy of the table can never put back text that was changed since.
 */
import type { TableColumn, TableRow, TableValue } from '@shared/types';
import { newId } from '@shared/ids';
import { fail } from './tree';

export const TABLE_LIMITS = { columns: 12, rows: 60, label: 80, cell: 300 } as const;

const COLUMN_ID = /^col_[a-z0-9]{1,32}$/;
const ROW_ID = /^row_[a-z0-9]{1,32}$/;

/** What a model or caller can send in place of a table, shown with every refusal. */
const TABLE_SHAPE = '{ columns: ["Day", "Workshop"], rows: [["Monday", "Clay basics"]] }';

/** One line of text: numbers become text and line breaks become spaces. */
function line(v: unknown, max: number, what: string): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') fail(`${what}: expected text.`);
  const s = String(v).replace(/\s*\n\s*/g, ' ');
  if (s.length > max) fail(`${what}: text is longer than ${max} characters.`);
  return s;
}

/** A column's name. Every column has one, so a reader can always tell what its cells are. */
function columnName(v: unknown, what: string): string {
  const s = line(v, TABLE_LIMITS.label, what).trim();
  if (!s) fail(`${what}: every column needs a name, so readers know what its cells are.`);
  return s;
}

/** IDs for a list of entries: each one given is checked and kept, and the rest are new. */
function settleIds(given: unknown[], pattern: RegExp, prefix: string, what: (i: number) => string): string[] {
  const taken = new Set<string>();
  given.forEach((id, i) => {
    if (id === undefined || id === null || id === '') return;
    if (typeof id !== 'string' || !pattern.test(id)) fail(`${what(i)}: "${String(id).slice(0, 40)}" is not a valid ID (${prefix}_ and letters or digits).`);
    if (taken.has(id)) fail(`${what(i)}: the ID "${id}" is used twice.`);
    taken.add(id);
  });
  return given.map((id) => {
    if (typeof id === 'string' && id) return id;
    let fresh = newId(prefix);
    while (taken.has(fresh)) fresh = newId(prefix);
    taken.add(fresh);
    return fresh;
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A row's cells for these columns, from a list in column order or a map by column ID. */
function cellsFor(raw: unknown, columns: TableColumn[], what: string): Record<string, string> {
  let byId: Record<string, unknown>;
  if (raw === undefined || raw === null) byId = {};
  else if (Array.isArray(raw)) {
    if (raw.length > columns.length) fail(`${what}: has ${raw.length} cells, but the table has ${columns.length} column${columns.length === 1 ? '' : 's'}.`);
    byId = Object.fromEntries(raw.map((v, i) => [columns[i].id, v]));
  } else if (isRecord(raw)) {
    // A cell under a column the table does not have would be lost, so it is refused rather than dropped.
    for (const k of Object.keys(raw)) if (!columns.some((c) => c.id === k)) fail(`${what}: no column has the ID "${k.slice(0, 40)}".`);
    byId = raw;
  } else return fail(`${what}: cells are a list of texts in column order, or { columnId: text }.`);
  return Object.fromEntries(columns.map((c) => [c.id, line(Object.hasOwn(byId, c.id) ? byId[c.id] : '', TABLE_LIMITS.cell, `${what} → ${c.label}`)]));
}

/**
 * A table in its stored form, from the stored form itself or the short form models write
 * (`{ columns: ["Day", …], rows: [["Monday", …], …] }`). IDs given are kept; missing ones are made.
 */
export function normalizeTable(v: unknown, label: string): TableValue {
  if (!isRecord(v)) fail(`${label}: expected a table such as ${TABLE_SHAPE}.`);
  const { columns: colsIn, rows: rowsIn = [] } = v as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(colsIn) || !colsIn.length) fail(`${label}: a table needs at least one column, as in ${TABLE_SHAPE}.`);
  if (colsIn.length > TABLE_LIMITS.columns) fail(`${label}: a table has at most ${TABLE_LIMITS.columns} columns.`);
  if (!Array.isArray(rowsIn)) fail(`${label}: rows are a list, as in ${TABLE_SHAPE}.`);
  if (rowsIn.length > TABLE_LIMITS.rows) fail(`${label}: a table has at most ${TABLE_LIMITS.rows} rows.`);
  const cols: Array<Record<string, unknown>> = colsIn.map((c) => (isRecord(c) ? c : { label: c }));
  const colIds = settleIds(cols.map((c) => c.id), COLUMN_ID, 'col', (i) => `${label} → column ${i + 1}`);
  const columns = cols.map((c, i) => ({ id: colIds[i], label: columnName(c.label, `${label} → column ${i + 1}`) }));
  for (const [i, r] of rowsIn.entries()) if (!Array.isArray(r) && !isRecord(r)) fail(`${label} → row ${i + 1}: expected a list of cell texts or { id, cells }.`);
  const rowIds = settleIds(rowsIn.map((r) => (isRecord(r) ? r.id : undefined)), ROW_ID, 'row', (i) => `${label} → row ${i + 1}`);
  const rows: TableRow[] = rowsIn.map((r, i) => ({ id: rowIds[i], cells: cellsFor(Array.isArray(r) ? r : (r as Record<string, unknown>).cells, columns, `${label} → row ${i + 1}`) }));
  return { columns, rows };
}

export type TableAction = 'setCell' | 'renameColumn' | 'insertRow' | 'removeRow' | 'moveRow' | 'insertColumn' | 'removeColumn' | 'moveColumn';
export const TABLE_ACTIONS: readonly TableAction[] = ['setCell', 'renameColumn', 'insertRow', 'removeRow', 'moveRow', 'insertColumn', 'removeColumn', 'moveColumn'];

/** One step of an edit, naming the row and column it changes by ID (see `instance.editTable`). */
export interface TableEdit {
  action: TableAction;
  rowId?: string;
  columnId?: string;
  index?: number;
  /** The cell's text (setCell) or the column's name (renameColumn, insertColumn). */
  value?: string;
  /** insertRow: the new row's cells in column order. */
  cells?: string[];
}

function moveTo<T>(list: T[], from: number, index: number): T[] {
  const out = [...list];
  const [it] = out.splice(from, 1);
  out.splice(Math.min(Math.max(index, 0), out.length), 0, it);
  return out;
}

/**
 * Apply one step to `current` (a stored table) and return the table it makes. A new row or column also returns
 * its ID. Steps that name a row or column the table no longer has are refused, never applied somewhere else.
 */
export function editTable(current: unknown, edit: TableEdit, label: string): { value: TableValue; rowId?: string; columnId?: string } {
  const table = normalizeTable(current, label);
  const rowAt = () => {
    if (!edit.rowId) fail(`${label}: ${edit.action} needs a rowId.`);
    const i = table.rows.findIndex((r) => r.id === edit.rowId);
    if (i < 0) fail(`${label}: no row has the ID "${edit.rowId}". It may have been removed.`);
    return i;
  };
  const columnAt = () => {
    if (!edit.columnId) fail(`${label}: ${edit.action} needs a columnId.`);
    const i = table.columns.findIndex((c) => c.id === edit.columnId);
    if (i < 0) fail(`${label}: no column has the ID "${edit.columnId}". It may have been removed.`);
    return i;
  };
  const index = (max: number) => (edit.index === undefined ? max : Math.min(Math.max(edit.index, 0), max));
  switch (edit.action) {
    case 'setCell': {
      const r = rowAt();
      const c = columnAt();
      const column = table.columns[c];
      const rows = [...table.rows];
      rows[r] = { ...rows[r], cells: { ...rows[r].cells, [column.id]: line(edit.value ?? '', TABLE_LIMITS.cell, `${label} → row ${r + 1} → ${column.label}`) } };
      return { value: { ...table, rows } };
    }
    case 'renameColumn': {
      const c = columnAt();
      const columns = [...table.columns];
      columns[c] = { ...columns[c], label: columnName(edit.value, `${label} → column ${c + 1}`) };
      return { value: { ...table, columns } };
    }
    case 'insertRow': {
      if (table.rows.length >= TABLE_LIMITS.rows) fail(`${label}: a table has at most ${TABLE_LIMITS.rows} rows.`);
      let rowId = newId('row');
      while (table.rows.some((r) => r.id === rowId)) rowId = newId('row');
      const rows = [...table.rows];
      rows.splice(index(rows.length), 0, { id: rowId, cells: cellsFor(edit.cells ?? [], table.columns, `${label} → new row`) });
      return { value: { ...table, rows }, rowId };
    }
    case 'removeRow': {
      const r = rowAt();
      return { value: { ...table, rows: table.rows.filter((_, i) => i !== r) } };
    }
    case 'moveRow': {
      const r = rowAt();
      if (edit.index === undefined) fail(`${label}: moveRow needs an index.`);
      return { value: { ...table, rows: moveTo(table.rows, r, edit.index) } };
    }
    case 'insertColumn': {
      if (table.columns.length >= TABLE_LIMITS.columns) fail(`${label}: a table has at most ${TABLE_LIMITS.columns} columns.`);
      let columnId = newId('col');
      while (table.columns.some((c) => c.id === columnId)) columnId = newId('col');
      const name = edit.value === undefined || !String(edit.value).trim() ? `Column ${table.columns.length + 1}` : columnName(edit.value, `${label} → new column`);
      const columns = [...table.columns];
      columns.splice(index(columns.length), 0, { id: columnId, label: name });
      return { value: { columns, rows: table.rows.map((r) => ({ ...r, cells: { ...r.cells, [columnId]: '' } })) }, columnId };
    }
    case 'removeColumn': {
      const c = columnAt();
      if (table.columns.length <= 1) fail(`${label}: a table needs at least one column.`);
      const id = table.columns[c].id;
      return {
        value: {
          columns: table.columns.filter((_, i) => i !== c),
          rows: table.rows.map((r) => ({ ...r, cells: Object.fromEntries(Object.entries(r.cells).filter(([k]) => k !== id)) }))
        }
      };
    }
    case 'moveColumn': {
      const c = columnAt();
      if (edit.index === undefined) fail(`${label}: moveColumn needs an index.`);
      return { value: { ...table, columns: moveTo(table.columns, c, edit.index) } };
    }
    default:
      return fail(`${label}: unknown table action "${String((edit as { action?: unknown }).action)}". Use one of ${TABLE_ACTIONS.join(', ')}.`);
  }
}

/** A column-name for the next column a person adds, as `editTable` names it. */
export const nextColumnName = (table: TableValue) => `Column ${table.columns.length + 1}`;
