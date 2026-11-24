import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Braces, ChevronDown, CircleAlert, CircleDot, Hash, Image, Info, Link2, List, ListChecks, Pilcrow, Plus, Shapes, SlidersHorizontal, Table, ToggleRight, Trash2, TriangleAlert, Type, Undo2 } from 'lucide-react';
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
  schemaProblems,
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
  /** Rows added in this editor whose code name still follows their label. */
  autoNamed: Set<string>;
  /** Move focus to `selector` (inside the editor) once the next change has rendered. */
  focus: (selector: string) => void;
  /**
   * Replace a property, offering Undo with `undo` as what it says when the change threw something away. Undo
   * brings focus back to the row keyed `focusKey` (an item field), else to the property.
   */
  change: (next: SchemaRow, undo?: string, focusKey?: string) => void;
}
const RowsContext = createContext<RowsApi | null>(null);
/** Each type's glyph, from the icons Layers already uses for the same kinds of content where there is one. */
const TYPE_ICONS: Record<string, ReactNode> = {
  string: <Type />,
  richtext: <Pilcrow />,
  number: <Hash />,
  boolean: <ToggleRight />,
  enum: <CircleDot />,
  choices: <ListChecks />,
  link: <Link2 />,
  image: <Image />,
  icon: <Shapes />,
  list: <List />,
  table: <Table />
};
const typeLabel = (type: unknown) => typeOptions(type as PropType, true).find(([v]) => v === type)?.[1] ?? typeOptions(type as PropType, false).find(([v]) => v === type)?.[1] ?? 'a new type';

/** Text as a valid code name, or null when it makes none: "Hero Title" becomes heroTitle. */
function toCodeName(text: string): string | null {
  const words = text.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const joined = words
    .map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w))
    .join('')
    .replace(/^[0-9]+/, '');
  const candidate = (joined.charAt(0).toLowerCase() + joined.slice(1)).slice(0, 40);
  if (!candidate) return null;
  try {
    checkPropName(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/** The nearest valid code name to what was typed, when it differs from it. */
function camelSuggestion(name: string): string | null {
  const candidate = toCodeName(name);
  return candidate && candidate !== name ? candidate : null;
}

/**
 * The code name a row added in this editor takes from its label, until the author edits the code name. Only rows
 * added here follow their label: a saved row's placements are keyed by its code name, and a new component's
 * starter rows are read by name in the starter source.
 */
function derivedName(row: SchemaRow, label: string, siblings: string[]): string | null {
  const name = row.name.trim();
  const base = toCodeName(label);
  if (!base || base === name) return null;
  let next = base;
  for (let n = 2; siblings.includes(next); n++) next = `${base}${n}`;
  return next;
}

/** What is wrong with a code name, and the name that would fix it when there is an obvious one. */
interface NameProblem {
  message: string;
  fix?: string;
  /** Shared with another row: one problem, marked on both. */
  duplicate?: boolean;
}

function nameProblem(name: string, taken: Set<string>, label: string): NameProblem | null {
  if (!name) {
    const fromLabel = toCodeName(label);
    return fromLabel && !taken.has(fromLabel) ? { message: 'Enter a code name.', fix: fromLabel } : { message: 'Enter a code name, such as heroTitle.' };
  }
  try {
    checkPropName(name);
    return null;
  } catch (e) {
    // A suggestion another row already uses would only trade one problem for another.
    const fix = camelSuggestion(name);
    if (fix && !taken.has(fix)) return { message: 'Code names are camelCase, with no spaces or symbols.', fix };
    return { message: fix ? 'Code names are camelCase, with no spaces or symbols.' : (e as Error).message };
  }
}

/** What is wrong with each row's code name, by row key, worded for the field. Both halves of a duplicate are marked. */
function nameProblems(rows: SchemaRow[]): Map<string, NameProblem> {
  const out = new Map<string, NameProblem>();
  const taken = new Set(rows.map((r) => r.name.trim()));
  for (const r of rows) {
    const n = r.name.trim();
    const own = nameProblem(n, taken, String(r.schema.label ?? ''));
    if (own) {
      out.set(r.key, own);
      continue;
    }
    const others = rows.filter((x) => x !== r && x.name.trim() === n);
    if (!others.length) continue;
    // The fix for a clash: the name this row had before it was changed, else one made from its label.
    // Offered on the row that was just changed (or is new): renaming the untouched one can cost placed content.
    const edited = (x: SchemaRow) => x.orig === undefined || x.orig !== x.name.trim();
    const fromLabel = toCodeName(String(r.schema.label ?? ''));
    const offer = edited(r) || !others.some(edited);
    const fix = !offer ? undefined : r.orig && r.orig !== n && !taken.has(r.orig) ? r.orig : fromLabel && fromLabel !== n && !taken.has(fromLabel) ? fromLabel : undefined;
    out.set(r.key, { message: `Also used by ${others.map((x) => `“${String(x.schema.label || x.name)}”`).join(' and ')}. Choose a different code name.`, duplicate: true, fix });
  }
  return out;
}

/**
 * Problems inside a list beyond its own settings: its item fields' names and settings, and the fields its page
 * list still needs. Counted exactly as saving checks them (schemaProblems), so the two never disagree.
 */
function listProblemCount(row: SchemaRow): number {
  if (row.schema.type !== 'list') return 0;
  return schemaProblems([{ ...row, name: 'probe' }]).length - settingProblems(row).length;
}

/**
 * What a list itself still needs, as opposed to one of its fields: a first field, fewer fields, or a field its page
 * list reads. These have no field of their own to sit on, so they are shown above the item fields.
 */
function listOwnProblems(row: SchemaRow): string[] {
  if (row.schema.type !== 'list') return [];
  return schemaProblems([{ ...row, name: 'probe', drafts: undefined, fields: row.fields?.map((f) => ({ ...f, drafts: undefined })) }])
    .filter((m) => /^probe: (add at least one item field|a list can have up to|its items show pages)/.test(m))
    .map((m) => m.slice('probe: '.length).replace(/^./, (c) => c.toUpperCase()));
}

const KEPT_ON_RETYPE = new Set(['type', 'label', 'description', 'group']);
/** Whether changing this property's type would throw away something the author set. */
const holdsSettings = (s: Record<string, unknown>) => Object.entries(s).some(([k, v]) => !KEPT_ON_RETYPE.has(k) && v !== undefined && v !== '' && v !== false);

const numOrUndef = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));
const richDefault = (s: Record<string, unknown>) => (typeof s.default === 'string' ? s.default : richTextToMarkdown(toRichText(s.default as never), {}));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One part of a row's summary: a value, with what it is ("Default") when that is not obvious from the value. */
interface SummaryPart {
  key?: string;
  value: string;
  /** A free-text value (a default) that gives way first when the column is narrow, so short settings stay. */
  long?: boolean;
  /** Nothing set: said quietly, so set values stand out down the column. */
  quiet?: boolean;
  error?: boolean;
}
const summaryText = (parts: SummaryPart[]) => parts.map((p) => (p.key ? `${p.key} ${p.value}` : p.value)).join(' · ');

/** What a row's closed settings hold, so a property can be read without opening it. */
function settingsSummary(s: Record<string, unknown>, fieldCount?: number): SummaryPart[] {
  const defaultPart = (text: string): SummaryPart => {
    const line = text.trim().split('\n')[0];
    return line ? { key: 'Default', value: line, long: true } : { value: 'No default', quiet: true };
  };
  switch (s.type) {
    case 'string':
      return [defaultPart(String(s.default ?? '')), ...(s.multiline ? [{ value: 'Several lines' }] : [])];
    case 'richtext':
      return [defaultPart(richDefault(s)), ...(s.codeForm === 'blocks' ? [{ value: 'As blocks' }] : [])];
    case 'number': {
      const parts: SummaryPart[] = [s.default === undefined ? { value: 'No default', quiet: true } : { key: 'Default', value: String(s.default) }];
      if (s.min !== undefined && s.max !== undefined) parts.push({ key: 'Range', value: `${s.min}–${s.max}` });
      else if (s.min !== undefined) parts.push({ key: 'From', value: String(s.min) });
      else if (s.max !== undefined) parts.push({ key: 'Up to', value: String(s.max) });
      if (s.step !== undefined) parts.push({ key: 'Step', value: String(s.step) });
      return parts;
    }
    case 'boolean':
      return [{ value: s.default ? 'On by default' : 'Off by default' }];
    case 'enum': {
      const options = Array.isArray(s.options) ? (s.options as Array<{ value: string; label: string }>) : [];
      // With no default chosen, saving makes it the first option, so that is what the summary says.
      const chosen = options.find((o) => o.value === s.default) ?? options[0];
      return [{ value: plural(options.length, 'option') }, ...(chosen ? [{ key: 'Default', value: chosen.label, long: true }] : [])];
    }
    case 'choices':
      return [{ value: plural(Array.isArray(s.options) ? s.options.length : 0, 'option') }];
    case 'icon':
      return [defaultPart(String(s.default ?? ''))];
    case 'list':
      return [
        { key: 'Each', value: String(s.itemLabel || 'Item'), long: true },
        { value: plural(fieldCount ?? Object.keys((s.fields as object) ?? {}).length, 'field') },
        ...(Array.isArray(s.default) && s.default.length ? [{ value: plural(s.default.length, 'starting item') }] : []),
        ...(s.max !== undefined ? [{ key: 'Up to', value: String(s.max) }] : [])
      ];
    case 'table': {
      const t = s.default as { columns?: unknown[]; rows?: unknown[] } | undefined;
      if (t && Array.isArray(t.columns) && t.columns.length) return [{ key: 'Default', value: `${plural(t.columns.length, 'column')}, ${plural(Array.isArray(t.rows) ? t.rows.length : 0, 'row')}` }];
      return [{ value: 'Set on each placement', quiet: true }];
    }
    default:
      return [{ value: 'Set on each placement', quiet: true }];
  }
}

function Summary({ parts }: { parts: SummaryPart[] }) {
  return (
    <span className="schema-summary">
      {parts.map((p, i) => (
        <span key={i} className={`schema-sum-part${p.long || parts.length === 1 ? ' long' : ''}${p.error ? ' error' : p.quiet ? ' quiet' : ''}`}>
          {i > 0 && <span className="schema-sum-sep">·</span>}
          {p.key && <span className="schema-sum-key">{p.key}</span>}
          <span className="schema-sum-value">{p.value}</span>
        </span>
      ))}
    </span>
  );
}

interface RowProps {
  row: SchemaRow;
  open: boolean;
  problem?: NameProblem;
  readOnly?: boolean;
  onToggle: () => void;
  onChange: (r: SchemaRow) => void;
  onRetype: (r: SchemaRow, lostSettings: boolean) => void;
  /** Left out where the row cannot be removed (a list's only item field). */
  onRemove?: (byKeyboard: boolean) => void;
  /** The list this row is an item field of. */
  list?: string;
  /** The other rows' code names, so a name taken from the label never clashes with one. */
  siblings: string[];
}

function RowEditor({ row, open, problem, readOnly, onToggle, onChange, onRetype, onRemove, list, siblings }: RowProps) {
  const s = row.schema;
  const type = String(s.type) as PropType;
  const uid = useId();
  const typing = useContext(TypingContext);
  const rows = useContext(RowsContext);
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
  // A list's item fields can hold problems of their own; a closed list says so, since none of them shows.
  const fieldProblemCount = listProblemCount(row);
  const firstSettingProblem = settingProblems(row)[0] ?? (fieldProblemCount ? (listOwnProblems(row)[0] ?? `${plural(fieldProblemCount, 'item field problem')} to fix`) : undefined);
  const settingsError = !!firstSettingProblem;
  const expanded = open;
  const own = row.name || (list ? 'New field' : 'New property');
  const label = String(s.label ?? '').trim();
  // Controls are named by their row's label as well as its code name and column ("Introduction, intro name"), so
  // two rows sharing a code name are still told apart.
  const byLabel = label && label.toLowerCase() !== own.toLowerCase() ? `${label}, ` : '';
  const named = (what: string) => `${byLabel}${list ? `${list} ` : ''}${own} ${what}`;
  // A closed row with a problem says so in place of its summary, which would otherwise describe the last valid
  // values. Open, the problem shows on its field, so the summary stays.
  // Open, the problem shows on its field and the summary says only how many settings need fixing.
  const openProblems = settingProblems(row).length;
  const summary: SummaryPart[] = !firstSettingProblem ? settingsSummary(s, row.fields?.length) : !expanded ? [{ value: firstSettingProblem, error: true }] : openProblems ? [{ value: `${plural(openProblems, 'setting')} to fix`, error: true }] : settingsSummary(s, row.fields?.length);
  const summaryAlert = settingsError && (!expanded || openProblems > 0);
  const note = list ? itemFieldNote(row) : renameNote(row);
  const placementNote = type === 'link' || type === 'image' ? 'Set on each placement in the inspector.' : type === 'table' ? 'Each placement starts from this table and can change it in the inspector.' : type === 'choices' ? 'Its options are set in the component’s source.' : null;
  const messageId = problem ? `${uid}-name-error` : note ? `${uid}-name-note` : undefined;
  return (
    <fieldset className={`schema-row${list ? ' schema-field' : ''}${expanded ? ' open' : ''}${problem || settingsError ? ' invalid' : ''}`} disabled={readOnly} data-row-key={row.key}>
      {/* The label people know it by, then its code name: rows are told apart even when two share a code name. */}
      <legend className="sr-only">{`${list ? `${list} field ` : ''}${label && label !== own ? `${label} (${own})` : own}`}</legend>
      <div className="schema-grid">
        <DraftInput className="input sm schema-label" value={String(s.label ?? '')} onLive={live(String(s.label ?? ''))} onCommit={(label) => {
            // A new row's made-up code name follows its label, so the author names a property once.
            const name = rows?.autoNamed.has(row.key) ? derivedName(row, label, siblings) : null;
            onChange({ ...row, ...(name ? { name } : {}), schema: withSchema({ label }) });
          }} ariaLabel={named('label')} />
        <DraftInput className="input sm mono schema-name" value={row.name} onLive={live(row.name)} onCommit={(name) => {
          // Typing a code name takes it over from the label for good.
          if (name.trim() !== row.name) rows?.autoNamed.delete(row.key);
          onChange({ ...row, name: name.trim() });
        }} ariaLabel={named('name')} aria-invalid={problem ? true : undefined} aria-describedby={messageId} />
        <span className="schema-type">
          {TYPE_ICONS[type] ?? <Braces />}
          <select
            className="select sm"
            value={type}
            aria-label={named('type')}
            onChange={(e) => onRetype(retype(row, e.target.value as PropType), holdsSettings(s) || !!row.fields || !!row.drafts)}
          >
            {/* A type this editor does not offer (several choices, set in code) is still shown as what it is. */}
            {typeOptions(type, !!list).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </span>
        <button type="button" className="schema-row-toggle" aria-expanded={expanded} aria-controls={`${uid}-settings`} aria-label={`${named('settings')}: ${summaryText(summary)}`} title={summaryText(summary)} onClick={onToggle}>
          {summaryAlert && <CircleAlert className="schema-toggle-alert" aria-hidden="true" />}
          <Summary parts={summary} />
          <ChevronDown className="schema-chevron" aria-hidden="true" />
        </button>
      </div>
      {/* Messages about the code name sit under the code name column. */}
      {problem ? (
        <div className="schema-grid schema-row-msg">
          <div className="schema-row-error" id={`${uid}-name-error`}>
            <CircleAlert aria-hidden="true" />
            <span>
              {problem.message}
              {problem.fix && !readOnly && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="schema-fix"
                    onClick={() => {
                      // The button goes with the problem it fixes, so focus moves to the field it corrected.
                      rows?.focus(`[data-row-key="${row.key}"] .schema-name`);
                      rows?.autoNamed.delete(row.key);
                      onChange({ ...row, name: problem.fix! });
                    }}
                  >
                    Use <span className="mono">{problem.fix}</span>
                  </button>
                </>
              )}
            </span>
          </div>
        </div>
      ) : (
        note && (
          <div className="schema-grid schema-row-msg">
            {/* An item field's rename loses what placed items hold in it, so it reads as a warning. */}
            <div className={`schema-row-note${list ? ' warn' : ''}`} id={`${uid}-name-note`}>
              {list ? <TriangleAlert aria-hidden="true" /> : <Info aria-hidden="true" />}
              <span>{note}</span>
            </div>
          </div>
        )
      )}
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
              <select id={`${uid}-form`} className="select sm schema-narrow" value={s.codeForm === 'blocks' ? 'blocks' : 'paragraphs'} onChange={(e) => set({ codeForm: e.target.value === 'blocks' ? 'blocks' : undefined })}>
                <option value="paragraphs">Paragraph text</option>
                <option value="blocks">Blocks</option>
              </select>
            </Field>
          </>
        )}
        {type === 'number' && (
          <div className="schema-grid-4 schema-numbers">
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
              <DraftInput className="input sm" value={shown('step', s.step === undefined ? '' : String(s.step))} onLive={live(shown('step', s.step === undefined ? '' : String(s.step)))} onCommit={commitStep} ariaLabel={named('step')} placeholder="Any" />
            </Field>
          </div>
        )}
        {type === 'boolean' && (
          <label className="schema-check">
            <input type="checkbox" checked={!!s.default} onChange={(e) => set({ default: e.target.checked })} /> On by default
          </label>
        )}
        {type === 'icon' && (
          <div className="schema-pair schema-pair-icon">
            <Field label="Default icon">
              <DraftInput className="input sm mono" value={String(s.default ?? '')} onLive={live(String(s.default ?? ''))} onCommit={(v) => set({ default: v.trim() || undefined })} ariaLabel={named('default icon')} />
            </Field>
          </div>
        )}
        {type === 'enum' && (
          <div className="schema-pair schema-pair-choice">
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
              <select className="select sm" value={String(options.some((o) => o.value === s.default) ? s.default : (options[0]?.value ?? ''))} onChange={(e) => set({ default: e.target.value })} aria-label={named('default')}>
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
            <div className="schema-pair schema-pair-list">
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
            <button type="button" className="btn btn-sm btn-ghost btn-danger schema-remove" onClick={(e) => onRemove(e.detail === 0)} aria-label={list ? `Remove the ${own} field from ${list}` : `Remove ${row.name || 'property'}`}>
              <Trash2 /> {list ? 'Remove field' : 'Remove property'}
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
    const added = next.fields!.at(-1)!.key;
    rows.autoNamed.add(added);
    rows.open(added);
    rows.focus(`[data-row-key="${added}"] .schema-label`);
    onChange(next);
  };
  // Removed by keyboard, focus goes to Undo, one key away; by pointer, to the neighbouring field.
  const removeField = (i: number, byKeyboard: boolean) => {
    const after = fields.filter((_, j) => j !== i);
    const neighbour = after[i] ?? after[i - 1];
    rows.focus(byKeyboard ? '.schema-undo .btn' : neighbour ? `[data-row-key="${neighbour.key}"] .schema-row-toggle` : `[data-row-key="${row.key}"] .schema-row-toggle`);
    rows.change(removeItemField(row, i), `Removed the field “${named(fields[i])}” from “${String(row.schema.label || own)}”.`, fields[i].key);
  };
  const listProblems = listOwnProblems(row);
  return (
    <div className="schema-fields" role="group" aria-label={`${own} item fields`}>
      <div className="schema-fields-head">
        <span className="grow">
          Item fields <span className="schema-fields-count">{fields.length}</span>
        </span>
        {!readOnly && fields.length < MAX_ITEM_FIELDS && (
          <button type="button" className="btn btn-sm" onClick={add} aria-label={`Add a field to ${own}`}>
            <Plus /> Add field
          </button>
        )}
      </div>
      {listProblems.map((m) => (
        <div key={m} className="schema-row-error schema-list-problem" tabIndex={-1}>
          <CircleAlert aria-hidden="true" />
          <span>{m}</span>
        </div>
      ))}
      {fields.length > 0 && (
        <div className="schema-grid schema-cols schema-field-cols" aria-hidden="true">
          <span>Label</span>
          <span>Code name</span>
          <span>Type</span>
          <span>Settings</span>
        </div>
      )}
      {fields.map((f, i) => (
        <RowEditor
          key={f.key}
          row={f}
          list={own}
          open={rows.isOpen(f.key)}
          problem={problems.get(f.key)}
          siblings={fields.filter((x) => x !== f).map((x) => x.name.trim())}
          readOnly={readOnly}
          onToggle={() => rows.toggle(f.key)}
          onChange={(next) => onChange(setItemField(row, i, next))}
          onRetype={(next, lost) => rows.change(setItemField(row, i, next), lost ? `Changed the field “${named(next)}” of “${String(row.schema.label || own)}” to ${typeLabel(next.schema.type)}. Its earlier settings were cleared.` : undefined, f.key)}
          onRemove={fields.length > 1 ? (byKeyboard) => removeField(i, byKeyboard) : undefined}
        />
      ))}
    </div>
  );
}

/** Whether a row holds a problem saving would refuse: in its name, its settings, or a list's item fields. */
const rowHasProblem = (r: SchemaRow, names: Map<string, NameProblem>): boolean => names.has(r.key) || settingProblems(r).length > 0 || listProblemCount(r) > 0;

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
  const [undo, setUndo] = useState<{ message: string; before: SchemaRow[]; after: SchemaRow[]; key: string; parent?: string } | null>(null);
  const undoable = undo && undo.after === rows ? undo : null;
  const pendingFocus = useRef<string | null>(null);
  const autoNamed = useRef(new Set<string>()).current;
  /** Where focus goes when `pendingFocus` finds nothing: a list problem with no field of its own lands on its row. */
  const fallbackFocus = useRef<string | null>(null);
  /** Keep a focused control clear of the sticky head, however tall the head currently is. */
  const clearOfHead = (el: HTMLElement) => {
    const head = root.current?.querySelector('.schema-head');
    let scroller = root.current?.parentElement ?? null;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!head || !scroller) return;
    // A setting's label sits above its control, so it is kept clear too.
    const top = Math.min(el.getBoundingClientRect().top, el.closest<HTMLElement>('.field')?.getBoundingClientRect().top ?? Infinity);
    const covered = head.getBoundingClientRect().bottom + 4 - top;
    if (covered > 0) scroller.scrollTop -= covered;
  };
  useEffect(() => {
    const selector = pendingFocus.current;
    if (!selector) return;
    const fallback = fallbackFocus.current;
    pendingFocus.current = fallbackFocus.current = null;
    const el = root.current?.querySelector<HTMLElement>(selector) ?? (fallback ? root.current?.querySelector<HTMLElement>(fallback) : null) ?? (fallback ? root.current?.querySelector<HTMLElement>(fallback.replace('.schema-list-problem', '.schema-row-toggle')) : null);
    if (!el) return;
    // A problem is brought into view itself, since an open row can be taller than the list.
    // A setting comes into view with its label and its message.
    const target = el.matches('[aria-invalid="true"]') ? (el.closest<HTMLElement>('.field') ?? el) : (el.closest<HTMLElement>('.schema-row') ?? el);
    target.scrollIntoView({ block: 'nearest' });
    el.focus({ preventScroll: true });
    clearOfHead(target);
    if (el instanceof HTMLInputElement) el.select();
  }, [rows, open]);
  const problems = nameProblems(rows);
  // Counted exactly as saving checks them: a name three rows share is two problems, the names to change.
  const problemCount = schemaProblems(rows).length;
  /** Go to the first problem, opening its row when the field is inside the row's settings. */
  const showFirstProblem = () => {
    // Of two rows sharing a code name, the one whose name was just changed (or is new) is the one to fix.
    const edited = (r: SchemaRow) => r.orig === undefined || r.orig !== r.name.trim();
    const first = rows.find((r) => rowHasProblem(r, problems) && (!problems.get(r.key)?.duplicate || edited(r))) ?? rows.find((r) => rowHasProblem(r, problems));
    if (!first) return;
    // Inside a list, the field to go to follows the same rule: of two sharing a code name, the one just changed.
    const fieldNames = nameProblems(first.fields ?? []);
    const nameField = problems.has(first.key) || settingProblems(first).length ? undefined : (first.fields?.find((f) => fieldNames.has(f.key) && (!fieldNames.get(f.key)?.duplicate || edited(f))) ?? first.fields?.find((f) => fieldNames.has(f.key)));
    pendingFocus.current = nameField ? `[data-row-key="${nameField.key}"] [aria-invalid="true"]` : `[data-row-key="${first.key}"] [aria-invalid="true"]`;
    fallbackFocus.current = `[data-row-key="${first.key}"] .schema-list-problem`;
    // A problem in an item field's settings is inside that field too, so it opens as well.
    const field = nameField ? undefined : first.fields?.find((f) => !fieldNames.has(f.key) && settingProblems(f).length);
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
    autoNamed.add(row.key);
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
  // Removed by keyboard, focus goes to Undo, one key away; by pointer, to the neighbouring property.
  const remove = (i: number, byKeyboard: boolean) => {
    const row = rows[i];
    const after = rows.filter((_, j) => j !== i);
    const neighbour = after[i] ?? after[i - 1];
    pendingFocus.current = byKeyboard ? '.schema-undo .btn' : neighbour ? `[data-row-key="${neighbour.key}"] .schema-row-toggle` : '.schema-add';
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
    autoNamed,
    toggle,
    open: (key) => setOpen((o) => new Set(o).add(key)),
    focus: (selector) => {
      pendingFocus.current = selector;
    },
    change: (next, message, focusKey) => {
      const after = rows.map((x) => (x.key === next.key ? next : x));
      if (message) setUndo({ message, before: rows, after, key: focusKey ?? next.key, parent: focusKey ? next.key : undefined });
      onChange(after);
    }
  };
  const restore = () => {
    if (!undoable) return;
    pendingFocus.current = `[data-row-key="${undoable.key}"] .schema-row-toggle`;
    // An item field comes back inside its list, which opens if it was closed meanwhile.
    const parent = undoable.parent;
    if (parent) setOpen((o) => new Set(o).add(parent));
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
        {rows.length > 0 && (
        <div className="schema-bar">
          <p className="schema-intro">
            <strong>Label</strong> is what the inspector shows. <strong>Code name</strong> is the prop your source reads: <code className="schema-code">{'let { name } = $props()'}</code>
          </p>
          {problemCount > 0 && (
            <button type="button" className="btn btn-sm schema-problems" onClick={showFirstProblem} title="Saving waits until these are fixed. Go to the first one.">
              <CircleAlert /> {plural(problemCount, 'problem')} to fix
            </button>
          )}
          {addButton}
        </div>
        )}
        {/* The count is said aloud as it changes; the button itself is not a live region, so it is not read twice. */}
        <span className="sr-only" role="status">
          {problemCount > 0 ? `${plural(problemCount, 'problem')} to fix before saving.` : ''}
        </span>
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
          siblings={rows.filter((x) => x !== r).map((x) => x.name.trim())}
          readOnly={readOnly}
          onToggle={() => toggle(r.key)}
          onChange={(next) => onChange(rows.map((x, j) => (j === i ? next : x)))}
          onRetype={(next, lost) => retyped(i, next, lost)}
          onRemove={(byKeyboard) => remove(i, byKeyboard)}
        />
      ))}
      {!rows.length && (
        <div className="schema-empty">
          <span className="schema-empty-icon" aria-hidden="true">
            <SlidersHorizontal />
          </span>
          <p className="schema-empty-title">No properties yet</p>
          <p className="schema-empty-text">Each property gives this component a control in the inspector, such as a heading to type or an image to choose.</p>
          {addButton}
        </div>
      )}
    </div>
    </RowsContext.Provider>
    </TypingContext.Provider>
  );
}
