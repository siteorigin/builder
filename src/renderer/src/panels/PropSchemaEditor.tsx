import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, CircleAlert, Plus, SlidersHorizontal, Trash2, Undo2 } from 'lucide-react';
import { checkPropName } from '@engine/schema';
import { richTextToMarkdown, toRichText } from '@shared/richtext';
import { DraftInput, Field } from '../components/ui';
import {
  MAX_ITEM_FIELDS,
  addItemField,
  itemFieldNote,
  optionsText,
  parseOptions,
  removeItemField,
  renameNote,
  retype,
  rowKey,
  setItemField,
  settingProblems,
  typeOptions,
  type PropType,
  type SchemaRow
} from '../lib/prop-schema';

export { hiddenEdits, propertiesFromRows, renamesFromRows, rowsFromProperties, schemaProblems, type SchemaRow } from '../lib/prop-schema';

/**
 * The editable property schema (manifest) of a code component. Each row is one property: its label, code name and
 * type stay in view, with the default and the settings that type takes behind the row's disclosure. A list's item
 * fields are rows of the same kind inside it. The engine validates the whole schema when it is saved.
 */

/** Told whether a text setting holds typed text it has not committed yet, so Save is ready before the field is left. */
const TypingContext = createContext<(typing: boolean) => void>(() => {});

/** The editor's open rows and its Undo, for a list's item fields: they open, close and undo like the properties. */
interface RowsApi {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  open: (key: string) => void;
  /** Replace a property, offering Undo with `undo` as what it says when the change threw something away. */
  change: (next: SchemaRow, undo?: string) => void;
}
const RowsContext = createContext<RowsApi | null>(null);
const typeLabel = (type: unknown) => typeOptions(type as PropType, true).find(([v]) => v === type)?.[1] ?? typeOptions(type as PropType, false).find(([v]) => v === type)?.[1] ?? 'a new type';

/** The nearest valid code name to what was typed: "Hero Title" becomes heroTitle. */
function camelSuggestion(name: string): string | null {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const joined = words
    .map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w))
    .join('')
    .replace(/^[0-9]+/, '');
  const candidate = (joined.charAt(0).toLowerCase() + joined.slice(1)).slice(0, 40);
  if (!candidate || candidate === name) return null;
  try {
    checkPropName(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function nameProblem(name: string): string | null {
  if (!name) return 'Enter a code name, such as heroTitle.';
  try {
    checkPropName(name);
    return null;
  } catch (e) {
    const better = camelSuggestion(name);
    return better ? `Use camelCase with no spaces, such as ${better}.` : (e as Error).message;
  }
}

/** What is wrong with each row's code name, by row key, worded for the field. Both halves of a duplicate are marked. */
function nameProblems(rows: SchemaRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const n = r.name.trim();
    const own = nameProblem(n);
    if (own) {
      out.set(r.key, own);
      continue;
    }
    const others = rows.filter((x) => x !== r && x.name.trim() === n);
    if (others.length) out.set(r.key, `Also used by ${others.map((x) => `“${String(x.schema.label || x.name)}”`).join(' and ')}. Choose a different code name.`);
  }
  return out;
}

const KEPT_ON_RETYPE = new Set(['type', 'label', 'description', 'group']);
/** Whether changing this property's type would throw away something the author set. */
const holdsSettings = (s: Record<string, unknown>) => Object.entries(s).some(([k, v]) => !KEPT_ON_RETYPE.has(k) && v !== undefined && v !== '' && v !== false);

const numOrUndef = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));
const richDefault = (s: Record<string, unknown>) => (typeof s.default === 'string' ? s.default : richTextToMarkdown(toRichText(s.default as never), {}));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line saying what a row's closed settings hold, so a property can be read without opening it. */
function settingsSummary(s: Record<string, unknown>, fieldCount?: number): string {
  const defaultLine = (text: string) => {
    const line = text.trim().split('\n')[0];
    return line ? `Default: ${line}` : 'No default';
  };
  switch (s.type) {
    case 'string':
      return defaultLine(String(s.default ?? ''));
    case 'richtext':
      return defaultLine(richDefault(s));
    case 'number': {
      const range = s.min !== undefined || s.max !== undefined ? ` · ${s.min ?? 'any'} to ${s.max ?? 'any'}` : '';
      return `${s.default === undefined ? 'No default' : `Default: ${s.default}`}${range}`;
    }
    case 'boolean':
      return s.default ? 'On by default' : 'Off by default';
    case 'enum': {
      const options = Array.isArray(s.options) ? (s.options as Array<{ value: string; label: string }>) : [];
      const chosen = options.find((o) => o.value === s.default);
      return `${plural(options.length, 'option')}${chosen ? ` · ${chosen.label}` : ''}`;
    }
    case 'choices':
      return plural(Array.isArray(s.options) ? s.options.length : 0, 'option');
    case 'icon':
      return defaultLine(String(s.default ?? ''));
    case 'list':
      return `${String(s.itemLabel || 'Item')} · ${plural(fieldCount ?? Object.keys((s.fields as object) ?? {}).length, 'field')}`;
    default:
      return 'Set on each placement';
  }
}

interface RowProps {
  row: SchemaRow;
  open: boolean;
  problem?: string;
  readOnly?: boolean;
  onToggle: () => void;
  onChange: (r: SchemaRow) => void;
  onRetype: (r: SchemaRow, lostSettings: boolean) => void;
  /** Left out where the row cannot be removed (a list's only item field). */
  onRemove?: () => void;
  /** The list this row is an item field of. */
  list?: string;
}

function RowEditor({ row, open, problem, readOnly, onToggle, onChange, onRetype, onRemove, list }: RowProps) {
  const s = row.schema;
  const type = String(s.type) as PropType;
  const uid = useId();
  const typing = useContext(TypingContext);
  /** onLive for a text setting showing `value`: typing counts until the text matches it again. */
  const live = (value: string) => (text: string) => typing(text !== value);
  const options = Array.isArray(s.options) ? (s.options as Array<{ value: string; label: string }>) : [];
  const drafts = row.drafts ?? {};
  const withSchema = (patch: Record<string, unknown>) => {
    const next = { ...s, ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
    return next;
  };
  const set = (patch: Record<string, unknown>) => onChange({ ...row, schema: withSchema(patch) });
  const withoutDraft = (key: string) => {
    const { [key]: _fixed, ...rest } = drafts;
    return Object.keys(rest).length ? rest : undefined;
  };
  /** Text a setting cannot take stays in the field with its reason, so it can be corrected rather than retyped. */
  const refuse = (key: string, text: string, message: string) => onChange({ ...row, drafts: { ...drafts, [key]: { text, message } } });
  const accept = (key: string, patch: Record<string, unknown>) => onChange({ ...row, schema: withSchema(patch), drafts: withoutDraft(key) });
  const shown = (key: string, value: string) => drafts[key]?.text ?? value;
  const commitNumber = (key: string, label: string) => (v: string) => {
    if (v.trim() !== '' && !Number.isFinite(Number(v))) return refuse(key, v, `${label} must be a number.`);
    accept(key, { [key]: numOrUndef(v) });
  };
  const commitStep = (v: string) => {
    const n = Number(v.trim());
    if (v.trim() !== '' && (!Number.isFinite(n) || n <= 0)) return refuse('step', v, 'Step must be a number greater than 0.');
    accept('step', { step: numOrUndef(v) });
  };
  const commitCount = (key: string, label: string) => (v: string) => {
    const n = Number(v.trim());
    if (v.trim() !== '' && (!Number.isInteger(n) || n < 0 || n > 1000)) return refuse(key, v, `${label} must be a whole number from 0 to 1000.`);
    accept(key, { [key]: numOrUndef(v) });
  };
  const rangeError = settingProblems({ ...row, drafts: undefined })[0] ?? null;
  const firstSettingProblem = settingProblems(row)[0];
  const settingsError = !!firstSettingProblem;
  const expanded = open;
  const own = row.name || (list ? 'New field' : 'New property');
  const named = (what: string) => `${list ? `${list} ` : ''}${own} ${what}`;
  // A row with a problem says so in place of its summary, which would otherwise describe the last valid values.
  const summary = firstSettingProblem ?? settingsSummary(s, row.fields?.length);
  const note = list ? itemFieldNote(row) : renameNote(row);
  const placementNote = type === 'link' || type === 'image' || type === 'table' ? 'Set on each placement in the inspector.' : type === 'choices' ? 'Its options are set in the component’s source.' : null;
  return (
    <fieldset className={`schema-row${list ? ' schema-field' : ''}${expanded ? ' open' : ''}${problem || (settingsError && !expanded) ? ' invalid' : ''}`} disabled={readOnly} data-row-key={row.key}>
      <legend className="sr-only">{list ? `${list} field ${own}` : own}</legend>
      <div className="schema-grid">
        <DraftInput className="input sm schema-label" value={String(s.label ?? '')} onLive={live(String(s.label ?? ''))} onCommit={(label) => set({ label })} ariaLabel={named('label')} />
        <DraftInput className="input sm mono schema-name" value={row.name} onLive={live(row.name)} onCommit={(name) => onChange({ ...row, name: name.trim() })} ariaLabel={named('name')} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${uid}-name-error` : undefined} />
        <select
          className="select sm"
          value={type}
          aria-label={named('type')}
          onChange={(e) => onRetype(retype(row, e.target.value as PropType), holdsSettings(s) || !!row.fields)}
        >
          {/* A type this editor does not offer (several choices, set in code) is still shown as what it is. */}
          {typeOptions(type, !!list).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button type="button" className="schema-row-toggle" aria-expanded={expanded} aria-controls={`${uid}-settings`} aria-label={`${named('settings')}: ${summary}`} title={summary} onClick={onToggle}>
          {settingsError && <CircleAlert className="schema-toggle-alert" aria-hidden="true" />}
          <span className="ellipsis">{summary}</span>
          <ChevronDown className="schema-chevron" aria-hidden="true" />
        </button>
      </div>
      {problem && (
        <div className="schema-row-error" id={`${uid}-name-error`}>
          <CircleAlert aria-hidden="true" />
          <span>{problem}</span>
        </div>
      )}
      {!problem && note && <div className="schema-row-note">{note}</div>}
      <div className="schema-row-settings" id={`${uid}-settings`} hidden={!expanded}>
        {type === 'string' && (
          <>
            <Field label="Default">
              <DraftInput className={s.multiline ? 'textarea' : 'input sm'} multiline={!!s.multiline} rows={2} value={String(s.default ?? '')} onLive={live(String(s.default ?? ''))} onCommit={(v) => set({ default: v })} ariaLabel={named('default')} />
            </Field>
            <label className="schema-check">
              <input type="checkbox" checked={!!s.multiline} onChange={(e) => set({ multiline: e.target.checked || undefined })} /> Allow several lines
            </label>
          </>
        )}
        {type === 'richtext' && (
          <>
            <Field label="Default" hint="One paragraph per line; end a line with \ to break it inside the paragraph.">
              <DraftInput multiline rows={2} value={richDefault(s)} onLive={live(richDefault(s))} onCommit={(v) => set({ default: v as never })} ariaLabel={named('default')} />
            </Field>
            <Field label="Your code receives" controlId={`${uid}-form`} hint="Blocks keep links, lists and headings: render them with RichText.svelte. Paragraph text is one string per paragraph, with **bold** and *italic*.">
              <select id={`${uid}-form`} className="select sm" value={s.codeForm === 'blocks' ? 'blocks' : 'paragraphs'} onChange={(e) => set({ codeForm: e.target.value === 'blocks' ? 'blocks' : undefined })}>
                <option value="paragraphs">Paragraph text</option>
                <option value="blocks">Blocks</option>
              </select>
            </Field>
          </>
        )}
        {type === 'number' && (
          <div className="schema-grid-4">
            <Field label="Default" error={drafts.default?.message}>
              <DraftInput className="input sm" value={shown('default', s.default === undefined ? '' : String(s.default))} onLive={live(shown('default', s.default === undefined ? '' : String(s.default)))} onCommit={commitNumber('default', 'Default')} ariaLabel={named('default')} />
            </Field>
            <Field label="Minimum" error={drafts.min?.message}>
              <DraftInput className="input sm" value={shown('min', s.min === undefined ? '' : String(s.min))} onLive={live(shown('min', s.min === undefined ? '' : String(s.min)))} onCommit={commitNumber('min', 'Minimum')} ariaLabel={named('minimum')} />
            </Field>
            <Field label="Maximum" error={drafts.max?.message ?? rangeError}>
              <DraftInput className="input sm" value={shown('max', s.max === undefined ? '' : String(s.max))} onLive={live(shown('max', s.max === undefined ? '' : String(s.max)))} onCommit={commitNumber('max', 'Maximum')} ariaLabel={named('maximum')} />
            </Field>
            <Field label="Step" error={drafts.step?.message}>
              <DraftInput className="input sm" value={shown('step', s.step === undefined ? '' : String(s.step))} onLive={live(shown('step', s.step === undefined ? '' : String(s.step)))} onCommit={commitStep} ariaLabel={named('step')} />
            </Field>
          </div>
        )}
        {type === 'boolean' && (
          <label className="schema-check">
            <input type="checkbox" checked={!!s.default} onChange={(e) => set({ default: e.target.checked })} /> On by default
          </label>
        )}
        {type === 'icon' && (
          <div className="grid-2">
            <Field label="Default icon">
              <DraftInput className="input sm mono" value={String(s.default ?? '')} onLive={live(String(s.default ?? ''))} onCommit={(v) => set({ default: v.trim() || undefined })} ariaLabel={named('default icon')} />
            </Field>
          </div>
        )}
        {type === 'enum' && (
          <div className="grid-2">
            <Field label="Options" hint={'One per line, as value or value | Label.'} error={drafts.options?.message}>
              <DraftInput
                multiline
                rows={3}
                className="textarea mono"
                value={shown('options', optionsText(s.options))}
                onLive={live(shown('options', optionsText(s.options)))}
                onCommit={(v) => {
                  const options = parseOptions(v);
                  if (!options.length) return refuse('options', v, 'Add at least one option.');
                  if (options.length > 50) return refuse('options', v, 'A choice can have up to 50 options.');
                  if (options.some((o) => !o.value)) return refuse('options', v, 'Each option needs a value before its | Label.');
                  const long = options.find((o) => o.value.length > 60);
                  if (long) return refuse('options', v, `“${long.value.slice(0, 24)}…” is too long. Option values can be up to 60 characters.`);
                  const repeated = options.find((o, i) => options.findIndex((x) => x.value === o.value) !== i);
                  if (repeated) return refuse('options', v, `“${repeated.value}” is listed twice. Each option needs its own value.`);
                  accept('options', { options, default: options.some((o) => o.value === s.default) ? s.default : options[0]?.value });
                }}
                ariaLabel={named('options')}
              />
            </Field>
            <Field label="Default">
              <select className="select sm" value={String(s.default ?? '')} onChange={(e) => set({ default: e.target.value })} aria-label={named('default')}>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
        {type === 'list' && (
          <>
            <div className="grid-2">
              <Field label="Item name">
                <DraftInput className="input sm" value={String(s.itemLabel ?? '')} onLive={live(String(s.itemLabel ?? ''))} onCommit={(v) => set({ itemLabel: v })} ariaLabel={named('item name')} />
              </Field>
              <Field label="Most items" error={drafts.max?.message}>
                <DraftInput className="input sm" value={shown('max', s.max === undefined ? '' : String(s.max))} onLive={live(shown('max', s.max === undefined ? '' : String(s.max)))} onCommit={commitCount('max', 'Most items')} ariaLabel={named('most items')} />
              </Field>
            </div>
            <ItemFields row={row} onChange={onChange} readOnly={readOnly} />
          </>
        )}
        <div className="schema-row-foot">
          <span className="field-hint grow">{placementNote}</span>
          {!readOnly && onRemove && (
            <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={onRemove} aria-label={list ? `Remove the ${own} field from ${list}` : `Remove ${row.name || 'property'}`}>
              <Trash2 /> Remove
            </button>
          )}
        </div>
      </div>
    </fieldset>
  );
}

/** A list's item fields, edited as rows of their own: name, label, type and the settings that type takes. */
function ItemFields({ row, onChange, readOnly }: { row: SchemaRow; onChange: (r: SchemaRow) => void; readOnly?: boolean }) {
  const rows = useContext(RowsContext)!;
  const fields = row.fields ?? [];
  const own = row.name || 'New property';
  const problems = nameProblems(fields);
  const named = (f: SchemaRow) => String(f.schema.label || f.name);
  const add = () => {
    const next = addItemField(row);
    rows.open(next.fields!.at(-1)!.key);
    onChange(next);
  };
  return (
    <div className="schema-fields" role="group" aria-label={`${own} item fields`}>
      <div className="schema-fields-head">
        <span className="grow">Item fields</span>
        {!readOnly && fields.length < MAX_ITEM_FIELDS && (
          <button type="button" className="btn btn-sm" onClick={add} aria-label={`Add a field to ${own}`}>
            <Plus /> Add field
          </button>
        )}
      </div>
      {fields.map((f, i) => (
        <RowEditor
          key={f.key}
          row={f}
          list={own}
          open={rows.isOpen(f.key)}
          problem={problems.get(f.key)}
          readOnly={readOnly}
          onToggle={() => rows.toggle(f.key)}
          onChange={(next) => onChange(setItemField(row, i, next))}
          onRetype={(next, lost) => rows.change(setItemField(row, i, next), lost ? `Changed the field “${named(next)}” of “${String(row.schema.label || own)}” to ${typeLabel(next.schema.type)}. Its earlier settings were cleared.` : undefined)}
          onRemove={fields.length > 1 ? () => rows.change(removeItemField(row, i), `Removed the field “${named(f)}” from “${String(row.schema.label || own)}”.`) : undefined}
        />
      ))}
    </div>
  );
}

/** Problems inside a row: its settings, and for a list, its item fields' names and settings. */
const rowProblemCount = (r: SchemaRow): number => settingProblems(r).length + (r.fields ? nameProblems(r.fields).size + r.fields.reduce((n, f) => n + rowProblemCount(f), 0) : 0);

const ignore = () => {};

/**
 * `onTyping` hears whether a text setting holds typed text that is not committed yet: the text commits when the
 * field is left, which pressing Save does first, so Save can be enabled while the author is still typing.
 */
export function PropSchemaEditor({ rows, onChange, readOnly, onTyping }: { rows: SchemaRow[]; onChange: (rows: SchemaRow[]) => void; readOnly?: boolean; onTyping?: (typing: boolean) => void }) {
  const typing = onTyping ?? ignore;
  // Leaving the tab or closing the editor ends any typing it reported.
  useEffect(() => () => onTyping?.(false), [onTyping]);
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // The last change that threw something away. It can be undone until the next edit, so undoing never loses work.
  const [undo, setUndo] = useState<{ message: string; before: SchemaRow[]; after: SchemaRow[]; key: string } | null>(null);
  const undoable = undo && undo.after === rows ? undo : null;
  const pendingFocus = useRef<string | null>(null);
  /** Keep a focused control clear of the sticky head, however tall the head currently is. */
  const clearOfHead = (el: HTMLElement) => {
    const head = root.current?.querySelector('.schema-head');
    let scroller = root.current?.parentElement ?? null;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!head || !scroller) return;
    const covered = head.getBoundingClientRect().bottom + 4 - el.getBoundingClientRect().top;
    if (covered > 0) scroller.scrollTop -= covered;
  };
  useEffect(() => {
    const selector = pendingFocus.current;
    if (!selector) return;
    pendingFocus.current = null;
    const el = root.current?.querySelector<HTMLElement>(selector);
    if (!el) return;
    // A problem is brought into view itself, since an open row can be taller than the list.
    const target = el.matches('[aria-invalid="true"]') ? el : (el.closest<HTMLElement>('.schema-row') ?? el);
    target.scrollIntoView({ block: 'nearest' });
    el.focus({ preventScroll: true });
    clearOfHead(target);
    if (el instanceof HTMLInputElement) el.select();
  }, [rows, open]);
  const problems = nameProblems(rows);
  const problemCount = problems.size + rows.reduce((n, r) => n + rowProblemCount(r), 0);
  /** Go to the first problem, opening its row when the field is inside the row's settings. */
  const showFirstProblem = () => {
    const first = rows.find((r) => problems.has(r.key) || rowProblemCount(r));
    if (!first) return;
    pendingFocus.current = `[data-row-key="${first.key}"] [aria-invalid="true"]`;
    // A problem in an item field's settings is inside that field too, so it opens as well.
    const fieldNames = nameProblems(first.fields ?? []);
    const field = first.fields?.find((f) => !fieldNames.has(f.key) && settingProblems(f).length);
    setOpen((o) => {
      const next = new Set(o);
      if (!problems.has(first.key)) next.add(first.key);
      if (field) next.add(field.key);
      return next;
    });
  };
  const add = () => {
    const used = new Set(rows.map((r) => r.name));
    let n = 1;
    while (used.has(`prop${n}`)) n++;
    const row: SchemaRow = { key: rowKey(), name: `prop${n}`, schema: { type: 'string', label: `Property ${n}`, default: '' } };
    setOpen((o) => new Set(o).add(row.key));
    pendingFocus.current = `[data-row-key="${row.key}"] .schema-label`;
    onChange([...rows, row]);
  };
  const toggle = (key: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const remove = (i: number) => {
    const row = rows[i];
    const after = rows.filter((_, j) => j !== i);
    const neighbour = after[i] ?? after[i - 1];
    pendingFocus.current = neighbour ? `[data-row-key="${neighbour.key}"] .schema-row-toggle` : '.schema-add';
    setUndo({ message: `Removed “${String(row.schema.label || row.name)}”.`, before: rows, after, key: row.key });
    onChange(after);
  };
  const retyped = (i: number, next: SchemaRow, lost: boolean) => {
    const after = rows.map((x, j) => (j === i ? next : x));
    if (lost) setUndo({ message: `Changed “${String(next.schema.label || next.name)}” to ${typeLabel(next.schema.type)}. Its earlier settings were cleared.`, before: rows, after, key: next.key });
    onChange(after);
  };
  const rowsApi: RowsApi = {
    isOpen: (key) => open.has(key),
    toggle,
    open: (key) => setOpen((o) => new Set(o).add(key)),
    change: (next, message) => {
      const after = rows.map((x) => (x.key === next.key ? next : x));
      if (message) setUndo({ message, before: rows, after, key: next.key });
      onChange(after);
    }
  };
  const restore = () => {
    if (!undoable) return;
    pendingFocus.current = `[data-row-key="${undoable.key}"] .schema-row-toggle`;
    onChange(undoable.before);
    setUndo(null);
  };
  const addButton = !readOnly && (
    <button type="button" className="btn btn-sm schema-add" onClick={add}>
      <Plus /> Add property
    </button>
  );
  return (
    <TypingContext.Provider value={typing}>
    <RowsContext.Provider value={rowsApi}>
    {/* Leaving a field commits it (or, after Escape, abandons it), so its typing is over either way. */}
    <div className="schema-editor" ref={root} onFocus={(e) => (e.target as HTMLElement).closest('.schema-row') && clearOfHead(e.target as HTMLElement)} onBlur={() => typing(false)}>
      <div className="schema-head">
        <div className="schema-bar">
          <p className="schema-intro">
            Label appears in the inspector. Code name is the prop in your source: <span className="mono">{'let { name } = $props()'}</span>
          </p>
          {problemCount > 0 && (
            <button type="button" className="btn btn-sm schema-problems" onClick={showFirstProblem}>
              <CircleAlert /> {plural(problemCount, 'problem')} to fix
            </button>
          )}
          {rows.length > 0 && addButton}
        </div>
        <div role="status">
          {undoable && (
            <div className="schema-undo">
              <span className="grow">{undoable.message}</span>
              <button type="button" className="btn btn-sm" onClick={restore}>
                <Undo2 /> Undo
              </button>
            </div>
          )}
        </div>
        {rows.length > 0 && (
          <div className="schema-grid schema-cols" aria-hidden="true">
            <span>Label</span>
            <span>Code name</span>
            <span>Type</span>
            <span>Settings</span>
          </div>
        )}
      </div>
      {rows.map((r, i) => (
        <RowEditor
          key={r.key}
          row={r}
          open={open.has(r.key)}
          problem={problems.get(r.key)}
          readOnly={readOnly}
          onToggle={() => toggle(r.key)}
          onChange={(next) => onChange(rows.map((x, j) => (j === i ? next : x)))}
          onRetype={(next, lost) => retyped(i, next, lost)}
          onRemove={() => remove(i)}
        />
      ))}
      {!rows.length && (
        <div className="empty-insp schema-empty">
          <SlidersHorizontal aria-hidden="true" />
          <span>No properties yet. Add one to give this component a control in the inspector.</span>
          {addButton}
        </div>
      )}
    </div>
    </RowsContext.Provider>
    </TypingContext.Provider>
  );
}
