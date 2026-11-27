/**
 * Connect external source (#678): where a collection's entries are synced from (a REST or GraphQL API, Contentful,
 * Sanity, Strapi or WordPress), the secrets it signs in with (kept on this computer, never in the project), and how
 * each record becomes an entry: by path, detail by detail, or by the author's own converter.mjs. Test & Fetch Sample
 * reads the source as a sync would and shows the first records as it sent them and as entries, writing nothing. Save
 * is offered once the settings as they are now have passed that Test, and the main process tests them again as it saves.
 *
 * The form is cut into headed sections in the order the task runs (the source, where its records are, signing in,
 * how records become entries, records that go away), and the footer always says where the Test stands, so its result
 * is seen wherever the form is scrolled to.
 */
import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, nextDiagnostic, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { javascript } from '@codemirror/lang-javascript';
import { tags as t } from '@lezer/highlight';
import { Check, KeyRound, Plug, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { SourceSampleResult } from '@shared/api';
import { SOURCE_ADAPTERS, SOURCE_REMOVALS, effectiveMapping, isBuiltInAdapter, isSecretName, sourceFingerprint } from '@shared/sources';
import { api, toast, useStore } from '../store';
import { ChoiceField, Disclosure, Field, Modal } from '../components/ui';
import { ADAPTER_IDS, MAPPED_DETAILS, draftSecretNames, sourceDraft, sourceForm, sourceOfCollection, type PairRow, type SourceForm } from '../lib/sources';
// The app's code frame and syntax colours, as the Svelte editor draws them.
import './SourceModal.css';
import './SourceDialog.css';

const REMOVAL_LABELS = { unpublish: 'Make it a draft (links keep working)', remove: 'Delete it', keep: 'Keep it as it is' } as const;

/** A list of name and value pairs (headers, query parameters): its heading and Add on one line, then labelled rows. */
function Pairs({ label, addLabel, hint, rows, onChange, namePlaceholder, valuePlaceholder }: { label: string; addLabel: string; hint?: ReactNode; rows: PairRow[]; onChange: (rows: PairRow[]) => void; namePlaceholder: string; valuePlaceholder: string }) {
  const id = useId();
  return (
    <div className="sd-pairs" role="group" aria-labelledby={`${id}-l`} aria-describedby={hint ? `${id}-h` : undefined}>
      <div className="sd-pairs-head">
        <span className="field-label grow" id={`${id}-l`}>
          {label}
        </span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...rows, { name: '', value: '' }])}>
          <Plus aria-hidden="true" /> {addLabel}
        </button>
      </div>
      {rows.length > 0 && (
        <div className="sd-pair sd-pair-cols" aria-hidden="true">
          <span>Name</span>
          <span>Value</span>
        </div>
      )}
      {rows.map((r, i) => (
        <div className="sd-pair" key={i}>
          <input className="input" aria-label={`${label} ${i + 1} name`} placeholder={namePlaceholder} value={r.name} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input className="input" aria-label={`${label} ${i + 1} value`} placeholder={valuePlaceholder} value={r.value} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <button type="button" className="icon-btn sm" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 />
          </button>
        </div>
      ))}
      {hint && (
        <div className="field-hint" id={`${id}-h`}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** A secret the source names: whether this computer keeps it, and a place to keep (or replace) its value. */
function SecretRow({ id, name, saved, opening, onSaved }: { id: string; name: string; saved: boolean; opening: string; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!value || busy) return;
    setBusy(true);
    const r = await api.project.setSourceSecret(name, value, opening);
    setBusy(false);
    if (!r.ok) return toast(r.message ?? 'The secret could not be saved.', 'error');
    setValue('');
    onSaved();
  };
  return (
    <div className="sd-secret">
      <label htmlFor={id} className="sd-secret-name">
        <KeyRound aria-hidden="true" />
        <span className="sd-secret-key">{name}</span>
        <span className={`badge ${saved ? 'green' : 'amber'}`}>{saved ? 'Saved on this computer' : 'Not saved yet'}</span>
      </label>
      <div className="sd-secret-entry">
        <input
          id={id}
          className="input"
          type="password"
          autoComplete="off"
          aria-label={`Value of the secret ${name}`}
          placeholder={saved ? 'A new value replaces the saved one' : 'Its value'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            }
          }}
        />
        <button type="button" className="btn" disabled={!value || busy} onClick={() => void save()}>
          Keep on this computer
        </button>
      </div>
    </div>
  );
}

/** A headed part of the form. */
function Part({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="sd-part" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {hint && <p className="sd-part-hint">{hint}</p>}
      {children}
    </section>
  );
}

/** A problem a failed Test found in the conversion script: its line when the message names one. */
interface ScriptProblem {
  line?: number;
  text: string;
  /** convert stopped on the records it was given: the records are what to read to fix it. */
  ran?: boolean;
}

/**
 * The script's problems, read from a failed Test's message: the check before it runs gives one "Line N: …" per line
 * under its first, and a run that stopped is said as "Its convert failed (line N): …" inside the failure's reason.
 * Null when the failure was not the script's.
 */
export function scriptProblems(message: string): ScriptProblem[] | null {
  const [first, ...rest] = message.split('\n');
  if (/converter cannot be run/i.test(first) && rest.length) {
    return rest.map((l) => {
      const m = /^Line (\d+):\s*(.*)$/.exec(l.trim());
      if (!m) return { text: l.trim() };
      // The parser stops at the first thing it cannot read, which is often just after the slip (a missing comma).
      const unread = /^It cannot be read as JavaScript:\s*(.*?)\.?$/.exec(m[2]);
      const text = unread ? `This can’t be read as JavaScript (${unread[1].charAt(0).toLowerCase()}${unread[1].slice(1)}).${Number(m[1]) > 1 ? ' The slip may be at the end of the line before.' : ''}` : m[2];
      return { line: Number(m[1]), text };
    });
  }
  const reason = /its converter could not put its records in shape \(([\s\S]*)\)\.?$/i.exec(message)?.[1];
  if (reason === undefined) return null;
  const ran = /^Its (\w+) (failed|took longer than [^:]*?)(?: \(line (\d+)\))?(?::\s*([\s\S]*))?$/.exec(reason);
  if (!ran) return [{ text: reason }];
  const [, fn, how, line, why] = ran;
  // Only convert is given records: a module or fetchAll that stops has none to read.
  return [{ ...(fn === 'convert' ? { ran: true } : {}), ...(line ? { line: Number(line) } : {}), text: how === 'failed' ? `${fn} stopped with “${(why ?? 'an error').trim()}”.` : `${fn} ${how}.` }];
}

const scriptHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.moduleKeyword], color: 'var(--cm-kw)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--cm-str)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--cm-num)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--cm-fn)' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--cm-attr)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--text-3)', fontStyle: 'italic' }
]);

/** The script editor drawn as the app's code editor draws code: its frame, type, gutter and marks. */
const scriptTheme = EditorView.theme({
  '&': { fontSize: '12.5px', backgroundColor: 'var(--code-bg)', color: 'var(--text)', maxHeight: 'min(440px, 52vh)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65', minHeight: 'calc(14 * 1.65em + 16px)', overflow: 'auto', scrollbarWidth: 'thin', scrollbarColor: 'var(--border-control) transparent' },
  '.cm-content': { padding: '8px 0', fontVariantLigatures: 'none' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-3)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '30px', padding: '0 4px 0 10px', fontVariantNumeric: 'tabular-nums' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--code-selection) !important', boxShadow: 'inset 0 0 0 1px var(--border-control)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--active)', boxShadow: 'inset 0 0 0 1px var(--border-control)', borderRadius: '2px' },
  '.cm-lintRange-error': { backgroundImage: 'none', backgroundColor: 'var(--red-soft)', textDecoration: 'underline wavy var(--red) 1.5px', textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
  // In the editor the band gives way to the caret line and the selection, so no two tints stack under the code; the
  // underline, the gutter mark and the written error stay.
  '&.cm-focused .cm-lintRange-error': { backgroundColor: 'transparent' },
  '.cm-gutter-lint': { width: '18px' },
  '.cm-gutter-lint .cm-gutterElement': { padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  '.cm-lint-marker': { content: 'none', width: '12px', height: '12px' },
  '.cm-tooltip': { backgroundColor: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-md)' },
  '.cm-diagnostic, .cm-diagnostic-error': { borderLeft: 'none', marginLeft: 0, padding: '8px 12px', fontFamily: 'var(--font)', fontSize: '12px', lineHeight: '1.45' }
});

/** Where the dialog puts the editor's caret: a line, with the lines around it in view. */
interface ScriptHandle {
  goTo: (line: number) => void;
  focus: () => void;
}

/**
 * The conversion script, in a JavaScript code editor of its own: line numbers to match a failure's line, the app's
 * syntax colours, and the failing lines marked. Tab is left to the form, so the editor is never a place focus cannot
 * leave; Escape reaches the dialog.
 */
function ScriptEditor({ value, onChange, locked, labelledBy, describedBy, problems, handle }: { value: string; onChange: (v: string) => void; locked: boolean; labelledBy: string; describedBy: string; problems: ScriptProblem[]; handle: MutableRefObject<ScriptHandle | null> }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lockSlot = useRef(new Compartment());
  const attrSlot = useRef(new Compartment());
  const changed = useRef(onChange);
  changed.current = onChange;
  const [focused, setFocused] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const invalid = problems.length > 0;
  const attrs = () => EditorView.contentAttributes.of({ 'aria-labelledby': labelledBy, 'aria-describedby': describedBy, ...(invalid ? { 'aria-invalid': 'true' } : {}) });
  handle.current = {
    goTo: (n) => {
      const v = view.current;
      if (!v) return;
      const line = v.state.doc.line(Math.min(Math.max(1, n), v.state.doc.lines));
      v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
      v.focus();
    },
    focus: () => {
      host.current?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
      view.current?.focus();
    }
  };
  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          lintGutter(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          javascript(),
          syntaxHighlighting(scriptHighlight),
          scriptTheme,
          indentUnit.of('  '),
          // Every finding is reached from the keyboard; Tab is not taken, so it still moves through the form.
          // Escape leaves the editor (to its frame) rather than closing the dialog round a script being written; a
          // second Escape is the dialog's.
          keymap.of([{ key: 'F8', run: nextDiagnostic }, { key: 'Escape', run: () => (host.current?.focus(), true) }, ...defaultKeymap, ...historyKeymap]),
          EditorView.scrollMargins.of(() => ({ top: 24, bottom: 24 })),
          lockSlot.current.of([EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]),
          attrSlot.current.of(attrs()),
          EditorView.updateListener.of((u) => {
            if (u.focusChanged) setFocused(u.view.hasFocus);
            if (u.selectionSet) setSelecting(!u.state.selection.main.empty);
            if (u.docChanged) changed.current(u.state.doc.toString());
          })
        ]
      })
    });
    return () => view.current?.destroy();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({ effects: [lockSlot.current.reconfigure([EditorState.readOnly.of(locked), EditorView.editable.of(!locked)]), attrSlot.current.reconfigure(attrs())] });
  }, [locked, labelledBy, describedBy, invalid]); // eslint-disable-line react-hooks/exhaustive-deps
  // A failing line is marked across its text and in the gutter, with the problem as its tooltip.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const marks = problems.flatMap((p): Diagnostic[] => {
      if (!p.line || p.line > doc.lines) return [];
      const line = doc.line(p.line);
      const start = line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0);
      return [{ from: start, to: Math.max(start, line.to), severity: 'error', message: `Line ${p.line}: ${p.text}` }];
    });
    v.dispatch(setDiagnostics(v.state, marks));
  }, [JSON.stringify(problems)]); // eslint-disable-line react-hooks/exhaustive-deps
  // The frame takes focus on Escape, and is named by the field's label there too.
  return <div ref={host} tabIndex={-1} role="group" aria-labelledby={labelledBy} className={`code-frame sd-script${invalid ? ' invalid' : ''}${focused ? ' focused' : ''}${selecting ? ' selecting' : ''}${locked ? ' locked' : ''}`} data-testid="source-script" />;
}

const NO_PROBLEMS: ScriptProblem[] = [];
const INDENT_KEYS = api.platform === 'darwin' ? '⌘] and ⌘[' : 'Ctrl+] and Ctrl+[';
const json = (v: unknown) => JSON.stringify(v, null, 2);
/** The words in formatted text, each block's on a line of its own. */
function richWords(v: unknown[]): string {
  const words = (x: unknown): string =>
    Array.isArray(x) ? x.map(words).join('') : x && typeof x === 'object' ? (typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : words((x as { spans?: unknown }).spans ?? (x as { items?: unknown }).items ?? '')) : '';
  return v.map(words).filter(Boolean).join(' ¶ ');
}
/** A value in an entry as text: a picture by its address, formatted text by its words and size, anything else as written. */
function shown(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
  if (v && typeof v === 'object' && '$image' in v) return String((v as { $image?: { url?: unknown } }).$image?.url ?? '');
  if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? `${richWords(v)} (formatted, ${v.length} ${v.length === 1 ? 'block' : 'blocks'})` : v.join(', ');
  return JSON.stringify(v);
}
const imageOf = (v: unknown) => (v && typeof v === 'object' && '$image' in v ? ((v as { $image?: { url?: unknown; alt?: unknown } }).$image ?? {}) : {});
/** Each detail an entry has, in the form's order and words: how to read it from an entry, and the mapping key it is read by. */
const ENTRY_DETAILS: ReadonlyArray<{ key: string; label: string; from: string; get: (e: Record<string, unknown>) => unknown }> = [
  ...(['externalId', 'title', 'slug', 'publishedAt', 'updatedAt', 'draft', 'author', 'excerpt'] as const).map((k) => ({ key: k, label: MAPPED_DETAILS.find((d) => d.key === k)!.label, from: k, get: (e: Record<string, unknown>) => e[k] })),
  { key: 'featuredImage', label: 'Featured image', from: 'featuredImageUrl', get: (e) => imageOf(e.featuredImage).url },
  { key: 'featuredImageAlt', label: 'Featured image description', from: 'featuredImageAlt', get: (e) => imageOf(e.featuredImage).alt },
  { key: 'body', label: 'Text', from: 'body', get: (e) => e.body }
];
const entryTitle = (e: unknown) => {
  const v = e && typeof e === 'object' ? (e as { title?: unknown }).title : undefined;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};

/** How many details this one entry leaves empty that the sample's empty-field group does not already name. */
function emptiesIn(entry: unknown, paths: Record<string, string> | undefined, fields: [string, unknown][], named: ReadonlySet<string>, given: ReadonlySet<string>): number {
  const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
  const values = (e.values && typeof e.values === 'object' ? e.values : {}) as Record<string, unknown>;
  const details = ENTRY_DETAILS.filter((d) => (paths?.[d.from] || given.has(d.key)) && isEmpty(d.get(e))).length;
  return details + fields.filter(([name]) => !named.has(name) && isEmpty(values[name])).length;
}

/** The details any of these entries has: each is then a row of every entry's table, empty where that one lacks it. */
const givenDetails = (entries: unknown[]): ReadonlySet<string> =>
  new Set(ENTRY_DETAILS.filter((d) => entries.some((e) => e && typeof e === 'object' && !isEmpty(d.get(e as Record<string, unknown>)))).map((d) => d.key));

/** A fold's summary: what it holds, then how many of its details are empty, said with a glyph and words. */
const FoldHead = ({ title, name, empty, more }: { title: string; name?: string; empty: number; more?: boolean }) => (
  <>
    {title}
    {name && <span className="sd-fold-name">{name}</span>}
    {empty > 0 && (
      <span className="sd-fold-note">
        <TriangleAlert aria-hidden="true" />
        {empty} {more ? 'more ' : ''}empty
      </span>
    )}
  </>
);

/**
 * One entry as a table of its details, in the form's order and words: what each holds, and (for details read by
 * path) the key in the record it came from. Every field of the collection is listed, so an empty one is seen.
 */
function EntryTable({ entry, paths, given, named, fields, caption }: { entry: unknown; paths?: Record<string, string>; given: ReadonlySet<string>; named: ReadonlySet<string>; fields: [string, { label: string }][]; caption: string }) {
  const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
  const values = (e.values && typeof e.values === 'object' ? e.values : {}) as Record<string, unknown>;
  const rows = [
    ...ENTRY_DETAILS.filter((d) => given.has(d.key) || paths?.[d.from]).map((d) => ({ key: d.key, label: d.label, from: paths?.[d.from], value: d.get(e) })),
    ...fields.map(([name, f]) => ({ key: `values.${name}`, label: f.label, from: paths?.[`values.${name}`], value: values[name], shared: named.has(name) }))
  ];
  return (
    <table className="sd-entry">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Detail</th>
          {paths && <th scope="col">Read from</th>}
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const text = isEmpty(r.value) ? '' : shown(r.value);
          return (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              {paths && <td className="sd-entry-from">{r.from ? <code>{r.from}</code> : <span className="sd-entry-none">Not read</span>}</td>}
              <td className="sd-entry-value">
                {text ? (
                  text
                ) : 'shared' in r && r.shared ? (
                  <span className="sd-entry-none">Empty</span>
                ) : (
                  // Empty in this entry alone: what its fold head counts.
                  <span className="sd-entry-none only">
                    <TriangleAlert aria-hidden="true" />
                    Empty
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A fold in the sample: the house row fold, in the sample's bordered card. */
function Fold({ open, summary, label, children }: { open?: boolean; summary: ReactNode; label?: string; children: ReactNode }) {
  return (
    <Disclosure row className="sd-fold" open={open} summary={summary} summaryLabel={label}>
      {children}
    </Disclosure>
  );
}

/** A record as the source sent it: scrolled by itself, and reached by Tab so it can be scrolled from the keyboard. */
const Raw = ({ value, label }: { value: unknown; label: string }) => (
  <pre className="sd-raw" tabIndex={0} role="region" aria-label={label}>
    {json(value)}
  </pre>
);
/** How a scroll the dialog makes moves: at once when the person asks for less motion. */
const scrollBehavior = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
/** Each required setting as the footer asks for it, by the words the form labels it with. */
const REQUIRED_WORDS: Record<string, (adapter: SourceForm['adapter']) => string> = {
  url: (a) => (a === 'strapi' || a === 'wordpress' ? 'the site address' : 'the address'),
  graphql: () => 'the query',
  groq: () => 'the query',
  spaceId: () => 'the space ID',
  contentType: () => 'the content type ID',
  projectId: () => 'the project ID',
  dataset: () => 'the dataset',
  resource: (a) => (a === 'strapi' ? 'the collection’s API name' : 'the type of post')
};
/** Everything that decides which records a Test reads (not how they become entries), with the secrets kept, as one key. */
const whereOf = ({ mapping: _m, bodyFormat: _b, converter: _c, shape: _s, removal: _r, name: _n, ...where }: SourceForm, secrets: number) => JSON.stringify([where, secrets]);
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

export function SourceDialog({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const snap = useStore((s) => s.snapshot);
  const [opening] = useState(() => snap?.workspaceKey ?? '');
  const collection = snap && Object.hasOwn(snap.state.collections, collectionId) ? snap.state.collections[collectionId] : undefined;
  const existing = snap ? sourceOfCollection(snap.state, collectionId) : undefined;
  const [form, setForm] = useState<SourceForm | null>(() => (snap && collection ? sourceForm(snap.state, collection.settings, existing) : null));
  /** The settings as the dialog was opened on them: Save never writes over a later change. */
  const [base] = useState(() => (existing ? sourceFingerprint(existing) : null));
  const [saved, setSaved] = useState<string[]>([]);
  const [secretsRead, setSecretsRead] = useState(0);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  /** The last Test: what it read, and the paths each detail was read from as it ran (by mapping key). */
  const [sample, setSample] = useState<{ key: string; shape: SourceForm['shape']; where: string; paths?: Record<string, string>; result: SourceSampleResult } | null>(null);
  /** What the source sent at the last Test that passed: kept to read beside a script that then stops on a record. */
  const [lastRaw, setLastRaw] = useState<{ raw: unknown[]; where: string } | null>(null);
  /** The last Test stopped inside the script: those records stay on show while it is fixed, until a Test passes. */
  const [checkAgainst, setCheckAgainst] = useState(false);
  const recordsHead = useRef<HTMLHeadingElement>(null);
  const scriptHandle = useRef<ScriptHandle | null>(null);
  const sampleRef = useRef<HTMLElement>(null);
  const sampleHead = useRef<HTMLHeadingElement>(null);
  const testButton = useRef<HTMLButtonElement>(null);
  /** The secrets the settings named when they last made sense: a slip elsewhere in the form never takes away a secret's row (and what is typed in it). */
  const lastSecrets = useRef<string[]>([]);
  const uid = useId();
  useEffect(() => {
    let live = true;
    void api.project.sourceSecretNames(opening).then((names) => live && setSaved(names));
    return () => {
      live = false;
    };
  }, [opening, secretsRead]);
  const draft = useMemo(() => (form && collection ? sourceDraft(form, collectionId) : null), [form, collection, collectionId]);
  // A passing Test brings its sample into view, so what it read is seen without hunting for it.
  useEffect(() => {
    if (sample?.result.ok) sampleRef.current?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
  }, [sample]);
  if (!snap || !collection || !form || snap.workspaceKey !== opening) return null;
  const set = (patch: Partial<SourceForm>) => setForm({ ...form, ...patch });
  const spec = SOURCE_ADAPTERS[form.adapter];
  // A kind this version cannot read is never shown as another, nor saved as one.
  const unknownKind = !!existing && !isBuiltInAdapter(existing.adapter);
  // What a Test read also depends on: the secrets' values (each save of one counts) and the collection's fields.
  const key = typeof draft === 'string' || !draft || unknownKind ? null : JSON.stringify([draft, secretsRead, collection.settings.fields]);
  const tested = sample && sample.key === key && sample.result.ok;
  /** The last Test was of the settings as they are now. */
  const current = !!sample && sample.key === key;
  const secretNames = typeof draft === 'object' && draft ? (lastSecrets.current = draftSecretNames(draft).filter(isSecretName)) : lastSecrets.current;
  const missingSecrets = secretNames.filter((n) => !saved.includes(n));
  /** The first required setting left empty, by its form key: a Test would only fail without it. */
  const missingSetting = spec.required.find((k) => Object.hasOwn(form, k) && !String(form[k as keyof SourceForm] ?? '').trim());
  /** Takes the person to the control a prerequisite names. */
  const goTo = (id: string) => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    el?.focus({ preventScroll: true });
  };
  const missingToken = spec.credentials.token === 'required' && !form.token.trim();
  const ask = (target: string, words: ReactNode) => (
    <>
      <button type="button" className="link-btn" onClick={() => goTo(target)}>
        {words}
      </button>{' '}
      to test the settings.
    </>
  );
  const prerequisite: ReactNode = !form.name.trim() ? (
    ask(`${uid}-name`, 'Give the source a name')
  ) : missingSetting ? (
    <>
      <button type="button" className="link-btn" onClick={() => goTo(`${uid}-${missingSetting}`)}>
        Give {REQUIRED_WORDS[missingSetting]?.(form.adapter) ?? missingSetting}
      </button>{' '}
      to test the settings.
    </>
  ) : missingToken ? (
    ask(`${uid}-token`, 'Give the access token a name')
  ) : missingSecrets.length ? (
    <>
      <button type="button" className="link-btn" onClick={() => goTo(`${uid}-secret-${missingSecrets[0]}`)}>
        Keep the secret {missingSecrets[0]} on this computer
      </button>{' '}
      to test the settings.
    </>
  ) : null;
  const defaults = effectiveMapping(form.adapter, undefined);
  const fields = Object.entries(collection.settings.fields ?? {});
  const text = (k: keyof SourceForm, label: string, placeholder?: string, hint?: ReactNode) => (
    <Field label={label} controlId={`${uid}-${k}`} hint={hint}>
      <input id={`${uid}-${k}`} className="input" placeholder={placeholder} value={form[k] as string} onChange={(e) => set({ [k]: e.target.value } as Partial<SourceForm>)} />
    </Field>
  );
  const area = (k: keyof SourceForm, label: string, placeholder?: string, rows = 4, hint?: ReactNode) => (
    <Field label={label} controlId={`${uid}-${k}`} hint={hint}>
      <textarea id={`${uid}-${k}`} className="textarea sd-code" spellCheck={false} rows={rows} placeholder={placeholder} value={form[k] as string} onChange={(e) => set({ [k]: e.target.value } as Partial<SourceForm>)} />
    </Field>
  );
  /** The paths each detail is read from as the form stands: the box's own, else the kind of source's default. */
  const pathsNow = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const d of MAPPED_DETAILS) {
      const p = (form.mapping[d.key] ?? '').trim() || defaults[d.key];
      if (typeof p === 'string' && p) out[d.key] = p;
    }
    for (const [name] of fields) {
      const p = (form.mapping[`values.${name}`] ?? '').trim() || defaults.values?.[name];
      if (p) out[`values.${name}`] = p;
    }
    return out;
  };

  const test = async () => {
    if (typeof draft !== 'object' || !draft || busy) return;
    setBusy('test');
    const tested = key;
    const result = await api.project.testSource(draft, opening).catch((e: Error) => ({ ok: false as const, message: e.message }));
    setBusy(null);
    setSample({ key: tested ?? '', shape: form.shape, where: whereOf(form, secretsRead), ...(form.shape === 'mapping' ? { paths: pathsNow() } : {}), result });
    if (result.ok) setLastRaw({ raw: result.raw, where: whereOf(form, secretsRead) });
    // Kept through repair attempts (a slip while fixing it included), replaced by the next pass.
    const stopped = !result.ok && form.shape === 'converter' && !!scriptProblems(result.message)?.some((p) => p.ran);
    setCheckAgainst((was) => (result.ok ? false : stopped || was));
    // The Test button was disabled while it ran, which dropped keyboard focus: it goes to the sample a pass shows, or
    // back to Test after a failure, so Tab carries on from where the person was.
    const lost = !document.activeElement || document.activeElement === document.body || document.activeElement === testButton.current;
    if (lost) requestAnimationFrame(() => (result.ok ? sampleHead.current?.focus({ preventScroll: true }) : testButton.current?.focus()));
  };
  const save = async () => {
    if (typeof draft !== 'object' || !draft || !tested || busy) return;
    setBusy('save');
    const r = await api.project.saveSource(draft, opening, base).catch((e: Error) => ({ ok: false as const, message: e.message }));
    setBusy(null);
    if (!r.ok) return setSample({ key: key ?? '', shape: form.shape, where: whereOf(form, secretsRead), result: { ok: false, message: r.message } });
    toast(`Saved “${draft.name}”. Sync now to bring its entries in.`, 'info');
    onClose();
  };

  /**
   * The collection's fields no entry the Test made has a value for, each with why: not read from the records at all
   * (and the key in them that looks like it, to read it from), or read from a path no record had.
   */
  const gaps =
    sample?.result.ok && sample.result.records.length
      ? fields
          .filter(([name]) => sample.result.ok && sample.result.records.every((r) => isEmpty((r as { values?: Record<string, unknown> })?.values?.[name])))
          .map(([name, f]) => {
            const path = sample.paths?.[`values.${name}`] ?? '';
            const raw = sample.result.ok ? sample.result.raw : [];
            // A key the records fill, named like the field: offered instead, whether a path was tried or not.
            const filled = [...new Set(raw.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r).filter((k) => !isEmpty((r as Record<string, unknown>)[k])) : [])))];
            const like = [name, f.label].map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''));
            // Offered only while the form reads this field, and the records, as the Test did: a suggestion from older
            // records, or one that would undo a later edit of the field, is not a click away.
            const now = (form.mapping[`values.${name}`] ?? '').trim() || defaults.values?.[name] || '';
            const same = sample.shape === 'mapping' && form.shape === 'mapping' && sample.where === whereOf(form, secretsRead) && now === path;
            const suggestion = same ? filled.find((k) => k !== path && like.includes(k.toLowerCase().replace(/[^a-z0-9]/g, ''))) : undefined;
            return { name, label: f.label, path, suggestion };
          })
      : [];
  const named = new Set(gaps.map((g) => g.name));
  const given = givenDetails(sample?.result.ok ? sample.result.records : []);
  /** The sample's repairs act on the form only while it reads records the way the sample did. */
  const repairable = !!sample && sample.shape === form.shape;
  /** The script's problems, while the failed Test is of the settings as they are now. */
  const problems = sample && current && !sample.result.ok && sample.shape === 'converter' ? scriptProblems(sample.result.message) : null;
  const problemLine = problems?.find((p) => p.line)?.line;
  const showRecords = checkAgainst && form.shape === 'converter' && !!lastRaw?.raw.length && !sample?.result.ok;
  const seeRecords = () => {
    recordsHead.current?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    recordsHead.current?.focus({ preventScroll: true });
  };
  const showScript = (line?: number) => {
    if (line) scriptHandle.current?.goTo(line);
    else scriptHandle.current?.focus();
  };

  // Where the Test stands, said in the footer beside its button: seen at any scroll position.
  const failed = !!sample && current && !sample.result.ok;
  const status: ReactNode =
    busy === 'test' ? (
      <span className="muted">Reading the source…</span>
    ) : busy === 'save' ? (
      <span className="muted">Testing again and saving…</span>
    ) : prerequisite ? (
      <span className="muted">{prerequisite}</span>
    ) : typeof draft === 'string' ? (
      <span className="field-error">{draft}</span>
    ) : problems ? (
      // The script's own problem is said under the script; the footer says where, and takes the person there.
      <span className="field-error">
        {problemLine ? `The script failed on line ${problemLine}: ` : 'The script failed: '}
        {(problems.find((p) => p.line === problemLine) ?? problems[0])?.text}{' '}
        <button type="button" className="link-btn" onClick={() => showScript(problemLine)}>
          {problemLine ? `Go to line ${problemLine}` : 'Show the script'}
        </button>
      </span>
    ) : sample && failed && !sample.result.ok ? (
      <span className="field-error">{sample.result.message}</span>
    ) : sample && current && sample.result.ok ? (
      <span className="sd-status-ok">
        <span className="badge green">
          <Check aria-hidden="true" />
          Test passed
        </span>
        <span>
          {sample.result.total} {sample.result.total === 1 ? 'record' : 'records'} read.{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              sampleRef.current?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
              sampleHead.current?.focus({ preventScroll: true });
            }}
          >
            Show the sample
          </button>
        </span>
      </span>
    ) : sample ? (
      <span className="muted">The settings changed since the last test. Test them again to save them.</span>
    ) : (
      <span className="muted">Test these settings to save them.</span>
    );

  const method = (
    <ChoiceField<'GET' | 'POST'>
      label="Asked with"
      hint={form.method === 'GET' ? 'GET reads an address, as most APIs expect.' : 'POST sends a JSON body with each request, as some search APIs expect.'}
      value={form.method}
      onChange={(method) => set({ method })}
      options={[
        { value: 'GET', label: 'GET' },
        { value: 'POST', label: 'POST' }
      ]}
    />
  );
  const headers = (
    <Pairs
      label="Headers"
      addLabel="Add a header"
      rows={form.headers}
      onChange={(headers) => set({ headers })}
      namePlaceholder="Authorization"
      valuePlaceholder="Bearer ${secret:api-token}"
      hint={
        <>
          Where a token goes, write <code>{'${secret:api-token}'}</code> and keep its value on this computer below.
        </>
      }
    />
  );

  return (
    <Modal
      wide
      title={existing ? `${existing.name}: source settings` : `Connect ${collection.settings.name} to an external source`}
      icon={<Plug aria-hidden="true" />}
      onClose={onClose}
      busy={busy !== null}
      dismissOnBackdrop={false}
      footer={
        <>
          {/* A failure is said at once; everything else waits its turn. */}
          <div className="sd-status grow" aria-live={failed ? 'assertive' : 'polite'} data-testid="source-status">
            {status}
          </div>
          <button className="btn" onClick={onClose} disabled={busy !== null}>
            Cancel
          </button>
          <button ref={testButton} className={`btn${tested ? '' : ' btn-primary'}`} disabled={typeof draft !== 'object' || !draft || busy !== null || unknownKind || !!prerequisite} onClick={() => void test()} data-testid="source-test">
            {busy === 'test' ? 'Testing…' : 'Test and fetch a sample'}
          </button>
          <button className={`btn${tested ? ' btn-primary' : ''}`} disabled={!tested || busy !== null} onClick={() => void save()} data-testid="source-save">
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {/* Nothing changes while it is tested or saved: what is saved is what was tested. */}
      <fieldset className="sd" disabled={busy !== null}>
        <p className="sd-intro">Its entries are read from the source and are read-only here. Nothing is ever sent back to it.</p>
        {unknownKind && <p className="field-error">This source is of a kind ({existing!.adapter}) this version of the app cannot read, so its settings cannot be changed here.</p>}

        <Part title="The source">
          <div className="sd-row">
            {text('name', 'Name')}
            <Field label="Kind of source" controlId={`${uid}-adapter`} hint={existing && collection.settings.sourceId !== undefined ? 'A connected source keeps its kind. Detach it to connect another.' : undefined}>
              <select id={`${uid}-adapter`} className="select" value={form.adapter} disabled={!!existing && collection.settings.sourceId !== undefined} onChange={(e) => set({ adapter: e.target.value as SourceForm['adapter'] })}>
                {ADAPTER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {SOURCE_ADAPTERS[id].label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Part>

        <Part title="Where the records are">
          {form.adapter === 'rest' && (
            <>
              {text('url', 'Address', 'https://api.example.com/team')}
              {method}
              {form.method === 'POST' && area('body', 'JSON sent', '{ "query": "…" }', 3)}
              {headers}
              <Pairs label="Query parameters" addLabel="Add a parameter" rows={form.query} onChange={(query) => set({ query })} namePlaceholder="status" valuePlaceholder="published" hint={form.query.length ? 'Added to the address as ?name=value.' : undefined} />
              {text('itemsPath', 'Where the records are in a reply', 'data.items', 'The path to the list, such as data.items. Leave empty when the reply is the list.')}
              <Field label="How it sends long lists" controlId={`${uid}-paging`}>
                <select id={`${uid}-paging`} className="select" value={form.paging} onChange={(e) => set({ paging: e.target.value as SourceForm['paging'] })}>
                  <option value="none">All at once</option>
                  <option value="page">In pages, by page number</option>
                  <option value="offset">In pages, by offset</option>
                  <option value="cursor">In pages, by cursor</option>
                  <option value="nextLink">In pages, each giving the next page’s address</option>
                </select>
              </Field>
              {(form.paging === 'page' || form.paging === 'offset' || form.paging === 'cursor') && (
                <div className="sd-row">
                  {text('pageParam', form.paging === 'cursor' ? 'Cursor parameter' : form.paging === 'page' ? 'Page parameter' : 'Offset parameter', form.paging === 'cursor' ? 'cursor' : form.paging === 'page' ? 'page' : 'offset')}
                  {(form.paging === 'page' || form.paging === 'offset') && text('pageSizeParam', 'Page size parameter (optional)', form.paging === 'page' ? 'per_page' : 'limit')}
                </div>
              )}
              {(form.paging === 'page' || form.paging === 'offset') && (
                <div className="sd-row">
                  {text('pageSize', 'Records per page', '100')}
                  {form.paging === 'page' && text('pageStart', 'First page’s number', '1')}
                </div>
              )}
              {form.paging === 'cursor' && text('cursorPath', 'Where a reply gives the next cursor', 'meta.next_cursor')}
              {form.paging === 'nextLink' && text('nextPath', 'Where a reply gives the next page’s address', 'links.next', 'Leave empty to follow its Link header.')}
            </>
          )}
          {form.adapter === 'graphql' && (
            <>
              {text('url', 'Address', 'https://api.example.com/graphql')}
              {headers}
              {area('graphql', 'Query', 'query { people { id name } }', 6, 'The GraphQL query that asks for the records.')}
              {area('variables', 'Variables (JSON)', '{ "first": 100 }', 3)}
              {text('itemsPath', 'Where the records are in a reply', 'data.people', 'Leave empty to read the first list under data.')}
            </>
          )}
          {form.adapter === 'contentful' && (
            <div className="sd-row sd-row-3">
              {text('spaceId', 'Space ID', undefined, 'In Contentful under Settings → General settings.')}
              {text('environment', 'Environment', 'master')}
              {text('contentType', 'Content type ID', 'teamMember', 'Shown beside the content type’s name.')}
            </div>
          )}
          {form.adapter === 'sanity' && (
            <>
              <div className="sd-row">
                {text('projectId', 'Project ID', undefined, 'In sanity.io/manage, under the project’s name.')}
                {text('dataset', 'Dataset', undefined, 'Usually production.')}
              </div>
              {area('groq', 'Query (GROQ)', '*[_type == "person"]{ _id, name, "photo": photo.asset->url }', 4, 'Which documents to read, in Sanity’s query language. *[_type == "person"] reads every person.')}
            </>
          )}
          {(form.adapter === 'strapi' || form.adapter === 'wordpress') && (
            <div className="sd-row">
              {text('url', 'Site address', form.adapter === 'strapi' ? 'https://cms.example.com' : 'https://blog.example.com')}
              {form.adapter === 'strapi'
                ? text('resource', 'Collection’s API name', 'articles', 'The plural name in its address: /api/articles is articles.')
                : text('resource', 'Type of post', 'posts', 'posts, pages, or a custom post type’s REST name.')}
            </div>
          )}
        </Part>

        {(Object.hasOwn(spec.credentials, 'token') || secretNames.length > 0) && (
          <Part title="Signing in" hint="Tokens and passwords are kept on this computer, never in the project.">
            {Object.hasOwn(spec.credentials, 'token') && (
              <Field
                label={`Access token’s name${spec.credentials.token === 'optional' ? ' (optional)' : ''}`}
                controlId={`${uid}-token`}
                hint={spec.credentials.token === 'optional' ? 'Leave it empty for a public source. Otherwise give the token any name, such as cms-token; its value is asked for below.' : 'Any name, such as cms-token: its value is asked for below.'}
              >
                <input id={`${uid}-token`} className="input" placeholder="cms-token" value={form.token} onChange={(e) => set({ token: e.target.value })} />
              </Field>
            )}
            {secretNames.length > 0 && (
              <div className="sd-secrets" role="group" aria-label="Secrets">
                {secretNames.map((name) => (
                  <SecretRow key={name} id={`${uid}-secret-${name}`} name={name} saved={saved.includes(name)} opening={opening} onSaved={() => setSecretsRead((n) => n + 1)} />
                ))}
              </div>
            )}
          </Part>
        )}

        <Part title="How records become entries">
          <ChoiceField<SourceForm['shape']>
            label="Each record is read"
            value={form.shape}
            onChange={(shape) => set({ shape })}
            options={[
              { value: 'mapping', label: 'Detail by detail' },
              { value: 'converter', label: 'By a script you write' }
            ]}
          />
          {form.shape === 'mapping' ? (
            <>
              <p className="sd-part-hint">
                For each detail, the name it has in a record, such as <code>name</code> or <code>author.name</code>. Leave a box empty to use the default shown in it.
              </p>
              <div className="sd-map" role="group" aria-label="Where each detail is read from">
                {MAPPED_DETAILS.filter((d) => d.key !== 'body' || collection.settings.hasBody !== false).map((d) => (
                  <Field key={d.key} label={d.label} controlId={`${uid}-map-${d.key}`}>
                    <input id={`${uid}-map-${d.key}`} className="input" placeholder={defaults[d.key] ?? 'Not read'} value={form.mapping[d.key] ?? ''} onChange={(e) => set({ mapping: { ...form.mapping, [d.key]: e.target.value } })} />
                  </Field>
                ))}
                {collection.settings.hasBody !== false && (
                  <Field label="Text is written in" controlId={`${uid}-format`}>
                    <select id={`${uid}-format`} className="select" value={form.bodyFormat} onChange={(e) => set({ bodyFormat: e.target.value as SourceForm['bodyFormat'] })}>
                      <option value="">{defaults.bodyFormat ? `As the source writes it (${defaults.bodyFormat})` : 'Plain text'}</option>
                      <option value="text">Plain text</option>
                      <option value="html">HTML</option>
                      <option value="markdown">Markdown</option>
                      <option value="contentful">Contentful Rich Text</option>
                    </select>
                  </Field>
                )}
              </div>
              {(fields.length > 0 || Object.keys(form.mapping).some((k) => k.startsWith('values.'))) && (
                <>
                  <h4 className="sd-subhead">{collection.settings.name}’s fields</h4>
                  <div className="sd-map" role="group" aria-label={`Where each of ${collection.settings.name}’s fields is read from`}>
                    {fields.map(([name, f]) => (
                      <Field key={name} label={f.label} controlId={`${uid}-map-values-${name}`}>
                        <input id={`${uid}-map-values-${name}`} className="input" placeholder="Not read" value={form.mapping[`values.${name}`] ?? ''} onChange={(e) => set({ mapping: { ...form.mapping, [`values.${name}`]: e.target.value } })} />
                      </Field>
                    ))}
                    {/* A field the collection no longer has, which its sync would refuse: shown so it can be cleared. */}
                    {Object.keys(form.mapping)
                      .filter((k) => k.startsWith('values.') && form.mapping[k].trim() && !Object.hasOwn(collection.settings.fields ?? {}, k.slice(7)))
                      .map((k) => (
                        <Field key={k} label={`${k.slice(7)} (a field the collection no longer has)`} controlId={`${uid}-map-${k}`} error="Clear it, or add the field again.">
                          <input id={`${uid}-map-${k}`} className="input" value={form.mapping[k]} onChange={(e) => set({ mapping: { ...form.mapping, [k]: e.target.value } })} />
                        </Field>
                      ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="field sd-script-field">
              <div className="field-label" id={`${uid}-script-label`} onClick={() => scriptHandle.current?.focus()}>
                Conversion script (JavaScript)
              </div>
              <ScriptEditor
                value={form.converter}
                onChange={(converter) => set({ converter })}
                locked={busy !== null}
                labelledBy={`${uid}-script-label`}
                describedBy={problems ? `${uid}-script-error ${uid}-script-hint` : `${uid}-script-hint`}
                problems={problems ?? NO_PROBLEMS}
                handle={scriptHandle}
              />
              {problems && (
                <div className="field-error sd-script-error" id={`${uid}-script-error`}>
                  {problems.map((p, i) => (
                    <span className="sd-script-problem" key={i}>
                      {p.line ? (
                        <button type="button" className="link-btn" onClick={() => scriptHandle.current?.goTo(p.line!)}>
                          Line {p.line}
                        </button>
                      ) : null}
                      {p.line ? ': ' : ''}
                      {p.text}
                    </span>
                  ))}
                  {showRecords && (
                    <span>
                      <button type="button" className="link-btn sd-records-link" onClick={seeRecords}>
                        See records from the last passing test
                      </button>
                    </span>
                  )}
                </div>
              )}
              <div className="field-hint" id={`${uid}-script-hint`}>
                Saved beside the project as converter.mjs. It receives the records the source sent and returns the entries to sync. Tab moves on to the next setting; {INDENT_KEYS} indent the lines the cursor is on.
              </div>
              {showRecords && !problems && (
                <div className="field-hint">
                  <button type="button" className="link-btn" onClick={seeRecords}>
                    See records from the last passing test
                  </button>
                </div>
              )}
            </div>
          )}
        </Part>

        <Part title="When a record goes away">
          <Field label="When the source no longer has a record" controlId={`${uid}-removal`}>
            <select id={`${uid}-removal`} className="select" value={form.removal} onChange={(e) => set({ removal: e.target.value as SourceForm['removal'] })}>
              {SOURCE_REMOVALS.map((r) => (
                <option key={r} value={r}>
                  {REMOVAL_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
        </Part>

        {showRecords && lastRaw && (
          // A script that stopped on a record is fixed by reading the records: those the last passing Test read.
          <section className="sd-part sd-sample stale" aria-labelledby={`${uid}-sample`} data-testid="source-sample-last">
            <div className="sd-sample-head">
              <h3 id={`${uid}-sample`} ref={recordsHead} tabIndex={-1}>
                Records to check the script against
              </h3>
              <button type="button" className="link-btn" onClick={() => scriptHandle.current?.focus()}>
                Back to the script
              </button>
            </div>
            <p className="sd-sample-stale">
              <TriangleAlert aria-hidden="true" />
              <span>
                What the source sent at the last test that passed, each open. The record the script stopped on may not be among them.
                {lastRaw.where !== whereOf(form, secretsRead) && ' They were read with earlier settings for the source.'}
              </span>
            </p>
            <div className="sd-records">
              {lastRaw.raw.map((raw, i) => (
                <Fold key={i} open summary={<FoldHead title={`Record ${i + 1}`} empty={0} />}>
                  <Raw value={raw} label={`Record ${i + 1} as the source sent it`} />
                </Fold>
              ))}
            </div>
          </section>
        )}
        {sample?.result.ok && (
          <section className={`sd-part sd-sample${current ? '' : ' stale'}`} ref={sampleRef} aria-labelledby={`${uid}-sample`} data-testid="source-sample">
            <h3 id={`${uid}-sample`} ref={sampleHead} tabIndex={-1}>
              Sample
            </h3>
            {!current && (
              <p className="sd-sample-stale">
                <TriangleAlert aria-hidden="true" />
                <span>
                  From the previous test: the settings have changed since.{' '}
                  <button type="button" className="link-btn" disabled={typeof draft !== 'object' || !draft || !!prerequisite || unknownKind} onClick={() => void test()}>
                    Test them again
                  </button>
                </span>
              </p>
            )}
            {/* What was read, then what a sync would do with it: figures first, so they are taken in at a glance. */}
            <div className="sd-sample-counts">
              <span className="sd-count-read">
                {sample.result.total} {sample.result.total === 1 ? 'record' : 'records'} read
              </span>
              <span className="sd-count-sep" aria-hidden="true" />
              <ul aria-label="What a sync would do">
                {(
                  [
                    [sample.result.created, 'to add'],
                    [sample.result.updated, 'to change'],
                    [sample.result.unchanged, 'unchanged'],
                    ...(sample.result.unpublished ? ([[sample.result.unpublished, 'to make drafts']] as const) : []),
                    ...(sample.result.removed ? ([[sample.result.removed, 'to delete']] as const) : [])
                  ] as const
                ).map(([n, what]) => (
                  <li key={what} className={n ? undefined : 'zero'}>
                    <strong>{n}</strong> {what}
                  </li>
                ))}
              </ul>
            </div>
            {sample.result.raw.length < sample.result.total && (
              <p className="sd-part-hint sd-sample-first">
                The first {sample.result.raw.length} are shown below; the counts are for all {sample.result.total}.
              </p>
            )}
            {sample.result.total === 0 && <p className="sd-part-hint">The source has no records, so nothing shows these settings make entries it can hold.</p>}
            {gaps.length > 0 && (
              <div className="sd-gaps" role="group" aria-labelledby={`${uid}-gaps`}>
                <p className="sd-gaps-head" id={`${uid}-gaps`}>
                  <TriangleAlert aria-hidden="true" />
                  {gaps.length === 1 ? 'A field is' : `${gaps.length} fields are`} empty in{' '}
                  {sample.shape === 'converter' ? `all ${sample.result.records.length} sampled ${sample.result.records.length === 1 ? 'entry' : 'entries'}` : sample.result.records.length < sample.result.total ? `these ${sample.result.records.length} records` : 'every record'}
                </p>
                <ul>
                  {gaps.map((g) => (
                    <li key={g.name}>
                      <span className="sd-gap-name">{g.label}</span>
                      <span className="sd-gap-why">
                        {sample.shape === 'converter' ? (
                          <>The script gave it no value in any of them.</>
                        ) : g.path ? (
                          <>
                            No sampled record had a value at <code>{g.path}</code>.
                          </>
                        ) : (
                          <>It isn’t read from the records.</>
                        )}
                      </span>
                      {!repairable ? (
                        <span />
                      ) : g.suggestion ? (
                        <button
                          type="button"
                          className="link-btn sd-gap-fix"
                          onClick={() => {
                            set({ mapping: { ...form.mapping, [`values.${g.name}`]: g.suggestion! } });
                            // The warning goes with the change: Test takes focus, to check it.
                            requestAnimationFrame(() => testButton.current?.focus());
                          }}
                        >
                          Read it from <code>{g.suggestion}</code>
                          <span className="sr-only">, for {g.label}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="link-btn sd-gap-fix"
                          onClick={() => (sample.shape === 'converter' ? showScript() : goTo(`${uid}-map-values-${g.name}`))}
                        >
                          {sample.shape === 'converter' ? 'Edit the script' : 'Say where it is'}
                          <span className="sr-only">, for {g.label}</span>
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {sample.shape === 'mapping' ? (
              // Each record beside the entry it became, detail by detail, with the key each detail was read from.
              <div className="sd-records">
                {sample.result.raw.map((raw, i) => {
                  const entry = sample.result.ok ? sample.result.records[i] : undefined;
                  const name = entryTitle(entry);
                  return (
                    <Fold
                      key={i}
                      open={i === 0}
                      summary={<FoldHead title={`Record ${i + 1}`} name={name} empty={emptiesIn(entry, sample.paths, fields, named, given)} more={named.size > 0} />}
                    >
                      <div className="sd-record">
                        <div className="sd-record-side">
                          <p className="sd-record-head">As the source sent it</p>
                          <Raw value={raw} label={`Record ${i + 1} as the source sent it`} />
                        </div>
                        <div className="sd-record-side">
                          <p className="sd-record-head">As an entry</p>
                          <EntryTable entry={entry} paths={sample.paths ?? {}} given={given} named={named} fields={fields} caption={`Record ${i + 1} as an entry`} />
                        </div>
                      </div>
                    </Fold>
                  );
                })}
              </div>
            ) : (
              // A script may leave records out or reorder them: what it gave and what it was given, each in its own order.
              <div className="sd-record sd-converted">
                <div className="sd-record-side">
                  <p className="sd-record-head">
                    What the source sent <span className="sd-record-count">{sample.result.raw.length}</span>
                  </p>
                  {sample.result.raw.map((raw, i) => (
                    <Fold key={i} open={i === 0} summary={<>Record {i + 1}</>}>
                      <Raw value={raw} label={`Record ${i + 1} as the source sent it`} />
                    </Fold>
                  ))}
                </div>
                <div className="sd-record-side">
                  <p className="sd-record-head">
                    What the script gave <span className="sd-record-count">{sample.result.records.length}</span>
                  </p>
                  {sample.result.records.map((entry, i) => (
                    <Fold
                      key={i}
                      open={i === 0}
                      summary={<FoldHead title={`Entry ${i + 1}`} name={entryTitle(entry)} empty={emptiesIn(entry, undefined, fields, named, given)} more={named.size > 0} />}
                    >
                      <EntryTable entry={entry} given={given} named={named} fields={fields} caption={`Entry ${i + 1}`} />
                    </Fold>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </fieldset>
    </Modal>
  );
}
