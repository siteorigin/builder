// What a table editor shows and says, and where focus goes after a change. Plain functions, so the wording and the
// focus rules are tested without a renderer.
import type { TableColumn, TableRow, TableValue } from '@shared/types';
import { TABLE_LIMITS } from '@engine/table';

const entry = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The table a value holds, read defensively: entries that are not rows or columns are left out. */
export function readTable(value: unknown, fallback: TableValue): TableValue {
  const t = entry(value) ? value : fallback;
  const columns = (Array.isArray(t.columns) ? t.columns : []).filter((c): c is TableColumn => entry(c) && typeof c.id === 'string');
  const rows = (Array.isArray(t.rows) ? t.rows : []).filter((r): r is TableRow => entry(r) && typeof r.id === 'string');
  return { columns, rows };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The size shown beside the table's label: "3 columns · 4 rows". */
export function tableCount(t: TableValue): string {
  return `${plural(t.columns.length, 'column')} · ${plural(t.rows.length, 'row')}`;
}

/** A cell's text, or '' when the row has none for that column. */
export function cellText(row: TableRow, columnId: string): string {
  const v = entry(row.cells) ? row.cells[columnId] : undefined;
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** A row's name in the editor: its first two filled cells, else its position ("Row 2"). */
export function rowTitle(t: TableValue, row: TableRow, index: number): string {
  const filled = t.columns.map((c) => cellText(row, c.id).trim()).filter(Boolean);
  return filled.length ? filled.slice(0, 2).join(' · ') : `Row ${index + 1}`;
}

/** A column's name in the editor, or its position while it has none. */
export function columnTitle(column: TableColumn, index: number): string {
  return (typeof column.label === 'string' ? column.label.trim() : '') || `Column ${index + 1}`;
}

/** Why Add row does nothing, or null while there is room. */
export function addRowNote(rows: number): string | null {
  return rows >= TABLE_LIMITS.rows ? `Limit reached: a table holds at most ${TABLE_LIMITS.rows} rows. Remove one to add another.` : null;
}

/** Why Add column does nothing, or null while there is room. */
export function addColumnNote(columns: number): string | null {
  return columns >= TABLE_LIMITS.columns ? `Limit reached: a table holds at most ${TABLE_LIMITS.columns} columns. Remove one to add another.` : null;
}

/** Why Remove column does nothing, or null while there is more than one. */
export function removeColumnNote(columns: number): string | null {
  return columns <= 1 ? 'A table needs at least one column, so this one can’t be removed. Add another first.' : null;
}

/**
 * Which entry takes focus once `id` has gone, judged when the removal lands: the next entry of `order` (the list as
 * it was when Remove was clicked) that is still `present`, else the previous one, else none (Add).
 */
export function focusAfterRemove(order: string[], id: string, present: ReadonlySet<string>): string | null {
  const i = order.indexOf(id);
  return order.slice(i + 1).find((x) => present.has(x)) ?? order.slice(0, Math.max(i, 0)).reverse().find((x) => present.has(x)) ?? null;
}

export type TableMove = 'up' | 'down' | 'left' | 'right';

/**
 * Where focus goes after a row or column moved. It stays on the button that was used while that button still
 * works; at the end it was heading for the button is disabled, so focus goes to the row's disclosure or the
 * column's name instead.
 */
export function tableMoveFocus(direction: TableMove, newIndex: number, count: number): TableMove | 'head' {
  const back = direction === 'up' || direction === 'left';
  return (back ? newIndex > 0 : newIndex < count - 1) ? direction : 'head';
}

/** What a screen reader hears after a move: the row or column and its new place. */
export function tableMoveAnnouncement(what: 'row' | 'column', title: string, newIndex: number, count: number): string {
  return `${what === 'row' ? 'Row' : 'Column'} ${title} moved to position ${newIndex + 1} of ${count}`;
}
