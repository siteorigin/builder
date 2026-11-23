import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { TableProp } from '@shared/types';
import type { TableEdit } from '@engine/table';
import { DraftInput, Field } from '../components/ui';
import { announcementText } from '../lib/announce';
import {
  addColumnNote,
  addRowNote,
  cellText,
  columnTitle,
  focusAfterRemove,
  readTable,
  removeColumnNote,
  rowTitle,
  tableCount,
  tableMoveAnnouncement,
  tableMoveFocus,
  type TableMove
} from '../lib/table-editor';

/** How long a step may take to land before it is treated as refused or overtaken (as in the list editor). */
const PENDING_MS = 3000;
/** How long focus asked for after a step waits for its control to appear. */
const FOCUS_MS = 1000;

/** A step on its way: what it was, when, and the control that took it (`from`, a focus key). */
type After = { at: number; from: string } & (
  | { kind: 'addedRow'; before: string[] }
  | { kind: 'addedColumn'; before: string[] }
  | { kind: 'removed'; axis: 'row' | 'column'; id: string; order: string[] }
  | { kind: 'moved'; axis: 'row' | 'column'; id: string; direction: TableMove; index: number; start: number; title: string }
);

/**
 * A table property: its columns, named, reordered, added and removed, and its rows, each a disclosure with one
 * field per column. Every change is one step naming its row and column by ID (`onTable`), so a step taken right
 * after typing in a cell never puts back what the cell held before.
 */
export function TableEditor({ name, schema, value, onTable }: { name: string; schema: TableProp; value: unknown; onTable: (edit: TableEdit) => Promise<boolean> }) {
  const table = readTable(value, schema.default);
  const { columns, rows } = table;
  const [open, setOpen] = useState<string | null>(null);
  const [said, setSaid] = useState({ text: '', count: 0 });
  const after = useRef<After | null>(null);
  const wantFocus = useRef<{ key: string; from: string; until: number } | null>(null);
  const uid = useId();
  const key = (k: string) => `${uid}${k}`;
  const find = (k: string) => document.getElementById(key(k));
  const focusSoon = (k: string, from: string) => (wantFocus.current = { key: k, from, until: Date.now() + FOCUS_MS });
  const shape = `${columns.map((c) => c.id).join(',')}|${rows.map((r) => r.id).join(',')}`;
  useEffect(() => {
    const a = after.current;
    if (!a) return;
    // A step that has not landed by now was refused or overtaken: it never claims a later change, such as Undo.
    if (Date.now() - a.at > PENDING_MS) return void (after.current = null);
    // Focus follows a step only from where the step left it: the control that took it, or the page body (that
    // control was removed, moved or disabled). Someone typing or working elsewhere keeps their place.
    const active = document.activeElement;
    const steer = !active || active === document.body || active === find(a.from);
    if (a.kind === 'addedRow' || a.kind === 'addedColumn') {
      const list: Array<{ id: string }> = a.kind === 'addedRow' ? rows : columns;
      const added = list.find((x) => !a.before.includes(x.id));
      if (!added) return;
      after.current = null;
      if (!steer) return;
      if (a.kind === 'addedColumn') return void focusSoon(`colname-${added.id}`, a.from);
      setOpen(added.id);
      focusSoon(columns[0] ? `cell-${added.id}-${columns[0].id}` : `rowhead-${added.id}`, a.from);
    } else if (a.kind === 'removed') {
      const list: Array<{ id: string }> = a.axis === 'row' ? rows : columns;
      if (list.some((x) => x.id === a.id)) return;
      after.current = null;
      if (!steer) return;
      const next = focusAfterRemove(a.order, a.id, new Set(list.map((x) => x.id)));
      focusSoon(next ? (a.axis === 'row' ? `rowhead-${next}` : `colname-${next}`) : a.axis === 'row' ? 'addrow' : 'addcol', a.from);
    } else {
      // A move lands with a later revision; until then the entry is still where it was.
      const list: Array<{ id: string }> = a.axis === 'row' ? rows : columns;
      const at = list.findIndex((x) => x.id === a.id);
      if (at !== a.index && at !== a.start) return void (after.current = null);
      if (at !== a.index) return;
      after.current = null;
      const prefix = a.axis === 'row' ? 'row' : 'col';
      const target = tableMoveFocus(a.direction, a.index, list.length);
      if (steer) focusSoon(target === 'head' ? (a.axis === 'row' ? `rowhead-${a.id}` : `colname-${a.id}`) : `${prefix}${target}-${a.id}`, a.from);
      setSaid((p) => announcementText(tableMoveAnnouncement(a.axis, a.title, a.index, list.length), p.count) ?? p);
    }
  }, [shape]); // eslint-disable-line react-hooks/exhaustive-deps
  // Focus asked for above lands as soon as its control is on the page (a new row's first cell, once it opens).
  useEffect(() => {
    const want = wantFocus.current;
    if (!want) return;
    if (Date.now() >= want.until) return void (wantFocus.current = null);
    // Still only from where the step left focus: the author may have moved on before the control appeared.
    const active = document.activeElement;
    if (active && active !== document.body && active !== find(want.from)) return void (wantFocus.current = null);
    const el = find(want.key);
    if (!el) return;
    wantFocus.current = null;
    el.focus();
    if (want.key.startsWith('colname-') && el instanceof HTMLInputElement) el.select();
  });
  /** Send a step, remembering it until it lands; a step the project refuses is forgotten at once. */
  const step = (pending: After, edit: TableEdit) => {
    after.current = pending;
    void onTable(edit).then((ok) => {
      if (!ok && after.current === pending) after.current = null;
    });
  };

  const addRowBlocked = addRowNote(rows.length);
  const addColumnBlocked = addColumnNote(columns.length);
  const removeColumnBlocked = removeColumnNote(columns.length);
  const move = (axis: 'row' | 'column', id: string, start: number, direction: TableMove, title: string) => {
    const index = direction === 'up' || direction === 'left' ? start - 1 : start + 1;
    const from = `${axis === 'row' ? 'row' : 'col'}${direction}-${id}`;
    step({ kind: 'moved', axis, id, direction, index, start, title, at: Date.now(), from }, axis === 'row' ? { action: 'moveRow', rowId: id, index } : { action: 'moveColumn', columnId: id, index });
  };
  return (
    <div className="field table-editor" role="group" aria-labelledby={key('label')} data-table={name}>
      <div className="field-label" id={key('label')}>
        <span className="grow">{schema.label}</span>
        <span className="insp-count">{tableCount(table)}</span>
      </div>

      <div className="table-editor-part" role="group" aria-labelledby={key('columns')}>
        <div className="table-editor-heading" id={key('columns')}>
          Columns
        </div>
        <div className="list-editor">
          {columns.map((c, i) => {
            const title = columnTitle(c, i);
            return (
              <div key={c.id} className="table-editor-col">
                <DraftInput id={key(`colname-${c.id}`)} value={typeof c.label === 'string' ? c.label : ''} ariaLabel={`Column ${i + 1} name`} onCommit={(v) => void onTable({ action: 'renameColumn', columnId: c.id, value: v })} />
                <button className="icon-btn sm" id={key(`colleft-${c.id}`)} aria-label={`Move column ${title} left`} disabled={i === 0} onClick={() => move('column', c.id, i, 'left', title)}>
                  <ArrowLeft />
                </button>
                <button className="icon-btn sm" id={key(`colright-${c.id}`)} aria-label={`Move column ${title} right`} disabled={i === columns.length - 1} onClick={() => move('column', c.id, i, 'right', title)}>
                  <ArrowRight />
                </button>
                <button
                  className="icon-btn sm"
                  id={key(`coldel-${c.id}`)}
                  aria-label={`Remove column ${title}`}
                  aria-disabled={removeColumnBlocked ? true : undefined}
                  aria-describedby={removeColumnBlocked ? key('removecol-note') : undefined}
                  title={removeColumnBlocked ?? undefined}
                  onClick={() => {
                    if (removeColumnBlocked) return;
                    step({ kind: 'removed', axis: 'column', id: c.id, order: columns.map((x) => x.id), at: Date.now(), from: `coldel-${c.id}` }, { action: 'removeColumn', columnId: c.id });
                  }}
                >
                  <Trash2 />
                </button>
              </div>
            );
          })}
          <button
            className="btn btn-sm insp-add"
            id={key('addcol')}
            aria-disabled={addColumnBlocked ? true : undefined}
            aria-describedby={addColumnBlocked ? key('addcol-note') : undefined}
            title={addColumnBlocked ?? undefined}
            onClick={() => {
              if (addColumnBlocked) return;
              step({ kind: 'addedColumn', before: columns.map((x) => x.id), at: Date.now(), from: 'addcol' }, { action: 'insertColumn' });
            }}
          >
            <Plus /> Add column
          </button>
          {addColumnBlocked && (
            <p className="insp-note muted" id={key('addcol-note')}>
              {addColumnBlocked}
            </p>
          )}
          {removeColumnBlocked && (
            <p className="insp-note muted" id={key('removecol-note')}>
              {removeColumnBlocked}
            </p>
          )}
        </div>
      </div>

      <div className="table-editor-part" role="group" aria-labelledby={key('rows')}>
        <div className="table-editor-heading" id={key('rows')}>
          Rows
        </div>
        <div className="list-editor">
          {rows.map((r, i) => {
            const title = rowTitle(table, r, i);
            const isOpen = open === r.id;
            return (
              <div key={r.id} className="list-editor-item">
                <div className="list-editor-head">
                  <button className="title" id={key(`rowhead-${r.id}`)} aria-expanded={isOpen} aria-controls={key(`rowbody-${r.id}`)} onClick={() => setOpen(isOpen ? null : r.id)}>
                    <ChevronRight size={12} className="faint" style={{ transform: isOpen ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }} />
                    <span className="ellipsis">{title}</span>
                  </button>
                  <button className="icon-btn sm" id={key(`rowup-${r.id}`)} aria-label={`Move row ${title} up`} disabled={i === 0} onClick={() => move('row', r.id, i, 'up', title)}>
                    <ArrowUp />
                  </button>
                  <button className="icon-btn sm" id={key(`rowdown-${r.id}`)} aria-label={`Move row ${title} down`} disabled={i === rows.length - 1} onClick={() => move('row', r.id, i, 'down', title)}>
                    <ArrowDown />
                  </button>
                  <button
                    className="icon-btn sm"
                    id={key(`rowdel-${r.id}`)}
                    aria-label={`Remove row ${title}`}
                    onClick={() => step({ kind: 'removed', axis: 'row', id: r.id, order: rows.map((x) => x.id), at: Date.now(), from: `rowdel-${r.id}` }, { action: 'removeRow', rowId: r.id })}
                  >
                    <Trash2 />
                  </button>
                </div>
                {/* The controlled region always exists, so aria-controls resolves while the row is closed. */}
                <div className="list-editor-body" id={key(`rowbody-${r.id}`)} hidden={!isOpen}>
                  {isOpen &&
                    columns.map((c, ci) => (
                      <Field key={c.id} label={columnTitle(c, ci)}>
                        <DraftInput id={key(`cell-${r.id}-${c.id}`)} value={cellText(r, c.id)} onCommit={(v) => void onTable({ action: 'setCell', rowId: r.id, columnId: c.id, value: v })} />
                      </Field>
                    ))}
                </div>
              </div>
            );
          })}
          <button
            className="btn btn-sm insp-add"
            id={key('addrow')}
            aria-disabled={addRowBlocked ? true : undefined}
            aria-describedby={addRowBlocked ? key('addrow-note') : undefined}
            title={addRowBlocked ?? undefined}
            onClick={() => {
              if (addRowBlocked) return;
              step({ kind: 'addedRow', before: rows.map((x) => x.id), at: Date.now(), from: 'addrow' }, { action: 'insertRow' });
            }}
          >
            <Plus /> Add row
          </button>
          {addRowBlocked && (
            <p className="insp-note muted" id={key('addrow-note')}>
              {addRowBlocked}
            </p>
          )}
        </div>
      </div>
      <span className="sr-only" role="status">
        {said.text}
      </span>
    </div>
  );
}
