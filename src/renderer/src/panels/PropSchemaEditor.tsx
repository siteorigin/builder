import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, CircleAlert, Plus, SlidersHorizontal, Trash2, Undo2 } from 'lucide-react';
import type { PropSchema } from '@shared/types';
import { checkPropName } from '@engine/schema';
import { richTextToMarkdown, toRichText } from '@shared/richtext';
import { DraftInput, Field } from '../components/ui';

/**
 * The editable property schema (manifest) of a code component. Each row is one property: its label, code name and
 * type stay in view, with the default and the settings that type takes behind the row's disclosure. The engine
 * validates the whole schema when it is saved.
 */
export interface SchemaRow {
  key: string;
  name: string;
  /** The name the property was stored under, to tell a rename from a new property. */
  orig?: string;
  schema: Record<string, unknown>;
  /** Text a setting refused, by setting, kept so it can be corrected. Saving is held until it is fixed. */
  drafts?: Record<string, { text: string; message: string }>;
}

const RANGE_PROBLEM = 'Maximum must be at least the minimum.';

/** What is wrong with a row's settings: text they refused, and a range that cannot hold a value. */
function settingProblems(row: SchemaRow): string[] {
  const s = row.schema;
  const out = Object.values(row.drafts ?? {}).map((d) => d.message);
  if (s.type === 'number' && typeof s.min === 'number' && typeof s.max === 'number' && s.min > s.max) out.push(RANGE_PROBLEM);
  return out;
}

const TYPES: Array<[PropSchema['type'], string]> = [
  ['string', 'Text'],
  ['richtext', 'Rich text'],
  ['number', 'Number'],
  ['boolean', 'On/off'],
  ['enum', 'Choice'],
  ['link', 'Link'],
  ['image', 'Image'],
  ['icon', 'Icon'],
  ['list', 'List'],
  ['table', 'Table']
];

let rowSeq = 0;
const rowKey = () => `r${++rowSeq}`;

export function rowsFromProperties(props: Record<string, PropSchema>): SchemaRow[] {
  return Object.entries(props).map(([name, schema]) => ({ key: rowKey(), name, orig: name, schema: structuredClone(schema) as unknown as Record<string, unknown> }));
}

export function propertiesFromRows(rows: SchemaRow[]): Record<string, unknown> {
  // Refused text counts as an unsaved change, so a host's dirty check and its schemaProblems gate both see it. That
  // gate stops any save while it is there, so the marker never reaches the engine.
  return Object.fromEntries(rows.map((r) => [r.name.trim(), r.drafts ? { ...r.schema, refusedDrafts: r.drafts } : r.schema]));
}

/** Problems the person can fix before saving; the engine checks everything else. */
export function schemaProblems(rows: SchemaRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const n = r.name.trim();
    try {
      checkPropName(n);
      if (seen.has(n)) out.push(`The property name "${n}" is used twice.`);
    } catch (e) {
      out.push((e as Error).message);
    }
    seen.add(n);
    for (const message of settingProblems(r)) out.push(`${n}: ${message}`);
  }
  return out;
}

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

/** Defaults that make sense when a property changes type, so the engine never receives a mismatched default. */
function retype(schema: Record<string, unknown>, type: PropSchema['type']): Record<string, unknown> {
  const base: Record<string, unknown> = { type, label: schema.label };
  if (schema.description) base.description = schema.description;
  if (schema.group) base.group = schema.group;
  if (type === 'enum') base.options = [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }];
  if (type === 'list') Object.assign(base, { itemLabel: 'Item', fields: { title: { type: 'string', label: 'Title', default: '' } } });
  return base;
}

const KEPT_ON_RETYPE = new Set(['type', 'label', 'description', 'group']);
/** Whether changing this property's type would throw away something the author set. */
const holdsSettings = (s: Record<string, unknown>) => Object.entries(s).some(([k, v]) => !KEPT_ON_RETYPE.has(k) && v !== undefined && v !== '' && v !== false);

const optionsText = (o: unknown) => (Array.isArray(o) ? o.map((x: { value: string; label: string }) => (x.label && x.label !== x.value ? `${x.value} | ${x.label}` : x.value)).join('\n') : '');
const parseOptions = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [value, ...rest] = l.split('|');
      return { value: value.trim(), label: rest.join('|').trim() || value.trim() };
    });
const numOrUndef = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));
const richDefault = (s: Record<string, unknown>) => (typeof s.default === 'string' ? s.default : richTextToMarkdown(toRichText(s.default as never), {}));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line saying what a row's closed settings hold, so a property can be read without opening it. */
function settingsSummary(s: Record<string, unknown>): string {
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
      return `${String(s.itemLabel || 'Item')} · ${plural(Object.keys((s.fields as object) ?? {}).length, 'field')}`;
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
  onRemove: () => void;
}

function RowEditor({ row, open, problem, readOnly, onToggle, onChange, onRetype, onRemove }: RowProps) {
  const s = row.schema;
  const type = String(s.type) as PropSchema['type'];
  const uid = useId();
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
  const commitCount = (key: string, label: string) => (v: string) => {
    const n = Number(v.trim());
    if (v.trim() !== '' && (!Number.isInteger(n) || n < 0 || n > 1000)) return refuse(key, v, `${label} must be a whole number from 0 to 1000.`);
    accept(key, { [key]: numOrUndef(v) });
  };
  const rangeError = settingProblems({ ...row, drafts: undefined })[0] ?? null;
  const firstSettingProblem = settingProblems(row)[0];
  const settingsError = !!firstSettingProblem;
  const expanded = open;
  const named = (what: string) => `${row.name || 'New property'} ${what}`;
  // A row with a problem says so in place of its summary, which would otherwise describe the last valid values.
  const summary = firstSettingProblem ?? settingsSummary(s);
  const placementNote = type === 'link' || type === 'image' || type === 'table' ? 'Set on each placement in the inspector.' : type === 'choices' ? 'Its options are set in the component’s source.' : null;
  return (
    <fieldset className={`schema-row${expanded ? ' open' : ''}${problem || (settingsError && !expanded) ? ' invalid' : ''}`} disabled={readOnly} data-row-key={row.key}>
      <legend className="sr-only">{row.name || 'New property'}</legend>
      <div className="schema-grid">
        <DraftInput className="input sm schema-label" value={String(s.label ?? '')} onCommit={(label) => set({ label })} ariaLabel={named('label')} />
        <DraftInput className="input sm mono schema-name" value={row.name} onCommit={(name) => onChange({ ...row, name: name.trim() })} ariaLabel={named('name')} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${uid}-name-error` : undefined} />
        <select
          className="select sm"
          value={type}
          aria-label={named('type')}
          onChange={(e) => onRetype({ ...row, drafts: undefined, schema: retype(s, e.target.value as PropSchema['type']) }, holdsSettings(s))}
        >
          {/* A type this editor does not offer (several choices, set in code) is still shown as what it is. */}
          {!TYPES.some(([v]) => v === type) && <option value={type}>{type === 'choices' ? 'Multiple choice' : type}</option>}
          {TYPES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button type="button" className="schema-row-toggle" aria-expanded={expanded} aria-controls={`${uid}-settings`} aria-label={`${row.name || 'New property'} settings: ${summary}`} title={summary} onClick={onToggle}>
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
      <div className="schema-row-settings" id={`${uid}-settings`} hidden={!expanded}>
        {type === 'string' && (
          <>
            <Field label="Default">
              <DraftInput className={s.multiline ? 'textarea' : 'input sm'} multiline={!!s.multiline} rows={2} value={String(s.default ?? '')} onCommit={(v) => set({ default: v })} ariaLabel={named('default')} />
            </Field>
            <label className="schema-check">
              <input type="checkbox" checked={!!s.multiline} onChange={(e) => set({ multiline: e.target.checked || undefined })} /> Allow several lines
            </label>
          </>
        )}
        {type === 'richtext' && (
          <Field label="Default" hint="One paragraph per line.">
            <DraftInput multiline rows={2} value={richDefault(s)} onCommit={(v) => set({ default: v as never })} ariaLabel={named('default')} />
          </Field>
        )}
        {type === 'number' && (
          <div className="schema-grid-3">
            <Field label="Default" error={drafts.default?.message}>
              <DraftInput className="input sm" value={shown('default', s.default === undefined ? '' : String(s.default))} onCommit={commitNumber('default', 'Default')} ariaLabel={named('default')} />
            </Field>
            <Field label="Minimum" error={drafts.min?.message}>
              <DraftInput className="input sm" value={shown('min', s.min === undefined ? '' : String(s.min))} onCommit={commitNumber('min', 'Minimum')} ariaLabel={named('minimum')} />
            </Field>
            <Field label="Maximum" error={drafts.max?.message ?? rangeError}>
              <DraftInput className="input sm" value={shown('max', s.max === undefined ? '' : String(s.max))} onCommit={commitNumber('max', 'Maximum')} ariaLabel={named('maximum')} />
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
              <DraftInput className="input sm mono" value={String(s.default ?? '')} onCommit={(v) => set({ default: v.trim() || undefined })} ariaLabel={named('default icon')} />
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
                <DraftInput className="input sm" value={String(s.itemLabel ?? '')} onCommit={(v) => set({ itemLabel: v })} ariaLabel={named('item name')} />
              </Field>
              <Field label="Most items" error={drafts.max?.message}>
                <DraftInput className="input sm" value={shown('max', s.max === undefined ? '' : String(s.max))} onCommit={commitCount('max', 'Most items')} ariaLabel={named('most items')} />
              </Field>
            </div>
            <Field label="Item fields" hint={'JSON: { "title": { "type": "string", "label": "Title" } }'} error={drafts.fields?.message}>
              <DraftInput
                multiline
                rows={4}
                className="textarea mono"
                value={shown('fields', JSON.stringify(s.fields ?? {}, null, 2))}
                onCommit={(v) => {
                  let fields: Record<string, unknown>;
                  try {
                    fields = JSON.parse(v);
                  } catch (e) {
                    return refuse('fields', v, `Not valid JSON: ${(e as Error).message}`);
                  }
                  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) return refuse('fields', v, 'Item fields must be a JSON object with at least one field.');
                  if (Object.keys(fields).length > 20) return refuse('fields', v, 'A list can have up to 20 item fields.');
                  const malformed = Object.entries(fields).find(([, f]) => !f || typeof f !== 'object' || Array.isArray(f));
                  if (malformed) return refuse('fields', v, `“${malformed[0]}” must be an object with a type and a label.`);
                  if (JSON.stringify(fields) === JSON.stringify(s.fields ?? {})) return onChange({ ...row, drafts: withoutDraft('fields') });
                  // New fields mean new default items; a title field that is gone is dropped.
                  const titleField = typeof s.titleField === 'string' && Object.hasOwn(fields, s.titleField) ? s.titleField : undefined;
                  accept('fields', { fields, default: undefined, titleField });
                }}
                ariaLabel={named('item fields')}
              />
            </Field>
          </>
        )}
        <div className="schema-row-foot">
          <span className="field-hint grow">{placementNote}</span>
          {!readOnly && (
            <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={onRemove} aria-label={`Remove ${row.name || 'property'}`}>
              <Trash2 /> Remove
            </button>
          )}
        </div>
      </div>
    </fieldset>
  );
}

export function PropSchemaEditor({ rows, onChange, readOnly }: { rows: SchemaRow[]; onChange: (rows: SchemaRow[]) => void; readOnly?: boolean }) {
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
  const problemCount = problems.size + rows.reduce((n, r) => n + settingProblems(r).length, 0);
  /** Go to the first problem, opening its row when the field is inside the row's settings. */
  const showFirstProblem = () => {
    const first = rows.find((r) => problems.has(r.key) || settingProblems(r).length);
    if (!first) return;
    pendingFocus.current = `[data-row-key="${first.key}"] [aria-invalid="true"]`;
    setOpen((o) => {
      const next = new Set(o);
      if (!problems.has(first.key)) next.add(first.key);
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
    if (lost) setUndo({ message: `Changed “${String(next.schema.label || next.name)}” to ${TYPES.find(([v]) => v === next.schema.type)?.[1] ?? 'a new type'}. Its earlier settings were cleared.`, before: rows, after, key: next.key });
    onChange(after);
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
    <div className="schema-editor" ref={root} onFocus={(e) => (e.target as HTMLElement).closest('.schema-row') && clearOfHead(e.target as HTMLElement)}>
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
  );
}
