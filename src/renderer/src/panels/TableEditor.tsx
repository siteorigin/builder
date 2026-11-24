import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
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
 * A one-line value that wraps, so the whole of it can always be read: Enter still saves it (as in every single-line
 * field) and line breaks in pasted text become spaces, so a cell never gains a line the site would not show.
 */
function Wrapping({ children }: { children: ReactNode }) {
  const enter = (e: KeyboardEvent) => {
    const t = e.target;
    if (e.key !== 'Enter' || !(t instanceof HTMLTextAreaElement) || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Blur is the field's one commit path, so Enter saves exactly as it does in a single-line field.
    e.preventDefault();
    t.blur();
  };
  const paste = (e: ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    if (!(e.target instanceof HTMLTextAreaElement) || !/[\r\n]/.test(text)) return;
    e.preventDefault();
    document.execCommand('insertText', false, text.replace(/\s*[\r\n]+\s*/g, ' '));
  };
  return (
    <div className="table-wrap" onKeyDownCapture={enter} onPasteCapture={paste}>
      {children}
    </div>
  );
}

/**
 * A table property, shown as the table it is: a header over its values, each row a disclosure that opens one field
 * per column in place, and below it the columns, named, reordered, added and removed. Every change is one step
 * naming its row and column by ID (`onTable`), so a step taken right after typing in a cell never puts back what
 * the cell held before.
 */
export function TableEditor({ name, schema, value, onTable }: { name: string; schema: TableProp; value: unknown; onTable: (edit: TableEdit) => Promise<boolean> }) {
  const table = readTable(value, schema.default);
  const { columns, rows } = table;
  const [open, setOpen] = useState<string | null>(null);
  const [said, setSaid] = useState({ text: '', count: 0 });
  const after = useRef<After | null>(null);
  const wantFocus = useRef<{ key: string; from: string; until: number; owner?: Element | null } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const recheck = useRef<(() => void) | null>(null);
  // The table is a tab stop of its own only while it has something to scroll to. While it is wider than the panel,
  // its first column stays put beside the disclosures, and each side that has more to see is shaded.
  const [scrolls, setScrolls] = useState(false);
  const [edges, setEdges] = useState({ wide: false, tall: false, clipped: false, left: false, right: false });
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
    if (active && active !== document.body && active !== find(want.from) && active !== want.owner) return void (wantFocus.current = null);
    const el = find(want.key);
    if (!el) return;
    wantFocus.current = null;
    el.focus();
    if (want.key.startsWith('colname-') && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.select();
  });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => {
      // What is visible of the table, scrollbars aside: an open row's fields are this wide however far it scrolls.
      el.style.setProperty('--table-view', `${el.clientWidth}px`);
      // The sticky header's real height (a long column name wraps), so a focused control never scrolls under it.
      el.style.setProperty('--table-head', `${el.querySelector('thead')?.getBoundingClientRect().height ?? 28}px`);
      // The sideways scrollbar's height, so the shade for more columns stops above it.
      el.parentElement?.style.setProperty('--table-bar', `${el.offsetHeight - el.clientHeight}px`);
      const wide = el.scrollWidth > el.clientWidth + 1;
      const tall = el.scrollHeight > el.clientHeight + 1;
      setScrolls(wide || tall);
      // A column name cut short in the header: its whole name is in the Columns list.
      const clipped = [...el.querySelectorAll('thead .table-grid-text')].some((t) => t.scrollHeight > t.clientHeight + 1);
      const next = { wide, tall, clipped, left: wide && el.scrollLeft > 1, right: wide && el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
      setEdges((p) => (p.wide === next.wide && p.tall === next.tall && p.clipped === next.clipped && p.left === next.left && p.right === next.right ? p : next));
    };
    check();
    recheck.current = check;
    const seen = new ResizeObserver(check);
    seen.observe(el);
    if (el.firstElementChild) seen.observe(el.firstElementChild);
    el.addEventListener('scroll', check, { passive: true });
    return () => {
      seen.disconnect();
      el.removeEventListener('scroll', check);
    };
  }, []);
  // A renamed column can be cut short in the header (or no longer be) without the table changing size.
  const names = columns.map((c, i) => columnTitle(c, i)).join('\n');
  useLayoutEffect(() => recheck.current?.(), [names]);
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
  /** A click on a value opens its row with that value's field ready to type in. */
  const editCell = (rowId: string, columnId: string) => {
    if (open === rowId) return void find(`cell-${rowId}-${columnId}`)?.focus();
    // The press may have focused the scrolling frame: that is where the step left focus, so it may move on from there.
    wantFocus.current = { key: `cell-${rowId}-${columnId}`, from: `rowhead-${rowId}`, until: Date.now() + FOCUS_MS, owner: document.activeElement };
    setOpen(rowId);
  };
  const hasOpen = rows.some((r) => r.id === open);
  const frame = `table-grid-frame${edges.wide ? ' is-wide' : ''}${edges.left ? ' more-left' : ''}${edges.right ? ' more-right' : ''}${hasOpen ? ' has-open' : ''}`;
  return (
    <div className="field table-editor" role="group" aria-labelledby={key('label')} data-table={name}>
      <div className="field-label" id={key('label')}>
        <span className="grow">{schema.label}</span>
        <span className="insp-count">{tableCount(table)}</span>
      </div>

      <div className="table-editor-part" role="group" aria-labelledby={key('rows')}>
        <div className="table-editor-heading">
          <span id={key('rows')}>Rows</span>
          {/* A long table puts its columns far below, and a cut-short header has its whole name there: a way straight
              to them, past every row, landing on the first of their controls. */}
          {(edges.tall || edges.clipped) && (
            <button
              className="btn btn-sm btn-ghost table-jump"
              aria-label="Go to columns"
              title="Go to columns"
              onClick={() => {
                find('columns')?.closest('.table-editor-part')?.scrollIntoView({ block: 'start' });
                find('addcol')?.focus({ preventScroll: true });
              }}
            >
              <ArrowDown aria-hidden="true" /> Columns
            </button>
          )}
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
        </div>
        {addRowBlocked && (
          <p className="insp-note table-editor-note" id={key('addrow-note')}>
            {addRowBlocked}
          </p>
        )}
        <div className={frame}>
          <div ref={scroller} className="table-grid-scroll" role={scrolls ? 'region' : undefined} tabIndex={scrolls ? 0 : undefined} aria-labelledby={scrolls ? key('rows') : undefined}>
            {/* Six or more columns never fit the panel, so each keeps room for a short name or value on one line. */}
            <table className={`table-grid${columns.length === 1 ? ' is-single' : ''}${columns.length >= 6 ? ' is-many' : ''}`}>
              <thead>
                <tr>
                  {/* Kept when there are no rows too, so the columns start where they always do. */}
                  <th scope="col" className="table-grid-toggle">
                    <span className="sr-only">Row</span>
                  </th>
                  {columns.map((c, ci) => (
                    <th key={c.id} scope="col" title={columnTitle(c, ci)}>
                      <span className="table-grid-text">{columnTitle(c, ci)}</span>
                    </th>
                  ))}
                  {rows.length > 0 && (
                    <th scope="col" className="table-grid-actions">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td className="table-grid-span" colSpan={columns.length + 1}>
                      <p className="table-grid-empty">No rows yet. Add a row to fill in these columns.</p>
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => {
                  const title = rowTitle(table, r, i);
                  const isOpen = open === r.id;
                  const removeRow = () => step({ kind: 'removed', axis: 'row', id: r.id, order: rows.map((x) => x.id), at: Date.now(), from: `rowdel-${r.id}` }, { action: 'removeRow', rowId: r.id });
                  return (
                    <Fragment key={r.id}>
                      <tr className={`table-grid-row${isOpen ? ' is-open' : ''}`}>
                        <th scope="row" className="list-editor-head table-grid-toggle">
                          <button className="title" id={key(`rowhead-${r.id}`)} aria-expanded={isOpen} aria-controls={key(`rowbody-${r.id}`)} title={title} onClick={() => setOpen(isOpen ? null : r.id)}>
                            <ChevronRight size={14} aria-hidden="true" />
                            <span className="sr-only">{title}</span>
                          </button>
                        </th>
                        {columns.map((c, ci) => {
                          const text = cellText(r, c.id);
                          // A row with nothing in its first column still has a name there: its position.
                          const unnamed = ci === 0 && !text.trim();
                          return (
                            <td key={c.id} title={text || undefined} onClick={() => editCell(r.id, c.id)}>
                              <span className={`table-grid-text${unnamed ? ' table-grid-blank' : ''}`}>{unnamed ? `Row ${i + 1}` : text}</span>
                            </td>
                          );
                        })}
                        {/* A closed row keeps Remove in a lane of its own at the row's end (out of the tab order), so it never covers a value; an open row has it with its fields. */}
                        <td className="table-grid-actions">
                          {!isOpen && (
                            <button className="icon-btn sm table-remove" id={key(`rowdel-${r.id}`)} tabIndex={-1} aria-label={`Remove row ${title}`} title="Remove this row" onClick={removeRow}>
                              <Trash2 />
                            </button>
                          )}
                        </td>
                      </tr>
                      {/* The controlled region always exists, so aria-controls resolves while the row is closed. */}
                      <tr id={key(`rowbody-${r.id}`)} className="table-grid-body" hidden={!isOpen}>
                        <td className="table-grid-span" colSpan={columns.length + 2}>
                          {isOpen && (
                            <div className="list-editor-body table-grid-form">
                              {columns.map((c, ci) => (
                                <Wrapping key={c.id}>
                                  <Field label={columnTitle(c, ci)}>
                                    <DraftInput
                                      id={key(`cell-${r.id}-${c.id}`)}
                                      multiline
                                      rows={1}
                                      className="textarea table-text"
                                      value={cellText(r, c.id)}
                                      onCommit={(v) => void onTable({ action: 'setCell', rowId: r.id, columnId: c.id, value: v })}
                                    />
                                  </Field>
                                </Wrapping>
                              ))}
                              <div className="table-row-tools">
                                <span className="table-row-move">
                                  <span aria-hidden="true">Move</span>
                                  <span className="table-move">
                                    <button className="icon-btn sm" id={key(`rowup-${r.id}`)} aria-label={`Move row ${title} up`} title="Move up" disabled={i === 0} onClick={() => move('row', r.id, i, 'up', title)}>
                                      <ArrowUp />
                                    </button>
                                    <button className="icon-btn sm" id={key(`rowdown-${r.id}`)} aria-label={`Move row ${title} down`} title="Move down" disabled={i === rows.length - 1} onClick={() => move('row', r.id, i, 'down', title)}>
                                      <ArrowDown />
                                    </button>
                                  </span>
                                </span>
                                <button className="btn btn-sm table-remove" id={key(`rowdel-${r.id}`)} aria-label={`Remove row ${title}`} onClick={removeRow}>
                                  <Trash2 /> Remove row
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="table-editor-part" role="group" aria-labelledby={key('columns')}>
        <div className="table-editor-heading">
          <span id={key('columns')}>Columns</span>
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
        </div>
        {addColumnBlocked && (
          <p className="insp-note table-editor-note" id={key('addcol-note')}>
            {addColumnBlocked}
          </p>
        )}
        {/* Numbered in the order the site shows them, left to right. */}
        <ol className="table-cols">
          {columns.map((c, i) => {
            const title = columnTitle(c, i);
            return (
              <li key={c.id} className="table-col">
                <span className="table-col-num" aria-hidden="true">
                  {i + 1}
                </span>
                <Wrapping>
                  <DraftInput
                    id={key(`colname-${c.id}`)}
                    multiline
                    rows={1}
                    className="textarea table-text sm"
                    value={typeof c.label === 'string' ? c.label : ''}
                    placeholder={`Column ${i + 1}`}
                    ariaLabel={`Column ${i + 1} name`}
                    onCommit={(v) => void onTable({ action: 'renameColumn', columnId: c.id, value: v })}
                  />
                </Wrapping>
                <span className="table-move">
                  <button className="icon-btn sm" id={key(`colleft-${c.id}`)} aria-label={`Move column ${title} left`} title="Move left" disabled={i === 0} onClick={() => move('column', c.id, i, 'left', title)}>
                    <ArrowLeft />
                  </button>
                  <button className="icon-btn sm" id={key(`colright-${c.id}`)} aria-label={`Move column ${title} right`} title="Move right" disabled={i === columns.length - 1} onClick={() => move('column', c.id, i, 'right', title)}>
                    <ArrowRight />
                  </button>
                </span>
                <button
                  className="icon-btn sm table-remove"
                  id={key(`coldel-${c.id}`)}
                  aria-label={`Remove column ${title}`}
                  aria-disabled={removeColumnBlocked ? true : undefined}
                  aria-describedby={removeColumnBlocked ? key('removecol-note') : undefined}
                  title={removeColumnBlocked ?? 'Remove this column and its cells'}
                  onClick={() => {
                    if (removeColumnBlocked) return;
                    step({ kind: 'removed', axis: 'column', id: c.id, order: columns.map((x) => x.id), at: Date.now(), from: `coldel-${c.id}` }, { action: 'removeColumn', columnId: c.id });
                  }}
                >
                  <Trash2 />
                </button>
              </li>
            );
          })}
        </ol>
        {removeColumnBlocked && (
          <p className="insp-note table-editor-note" id={key('removecol-note')}>
            {removeColumnBlocked}
          </p>
        )}
      </div>
      <span className="sr-only" role="status">
        {said.text}
      </span>
    </div>
  );
}
