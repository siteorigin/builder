import { useEffect, useId, useRef, useState, type MutableRefObject } from 'react';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import { EditorView, closeHoverTooltips, hasHoverTooltips, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, simplifySelection } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { svelte } from '@replit/codemirror-lang-svelte';
import { tags as t } from '@lezer/highlight';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { api } from '../store';
import { Spinner } from './ui';

const highlight = HighlightStyle.define([
  { tag: [t.tagName, t.angleBracket], color: 'var(--cm-tag)' },
  { tag: [t.attributeName, t.propertyName], color: 'var(--cm-attr)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--cm-str)' },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: 'var(--cm-kw)' },
  { tag: [t.comment, t.blockComment, t.lineComment], color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null], color: 'var(--cm-num)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--cm-fn)' }
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: 'var(--panel-2)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--panel-2)', color: 'var(--text-3)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '34px', padding: '0 6px 0 10px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--code-selection) !important', boxShadow: 'inset 0 0 0 1px var(--border-control)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--red) 1.5px', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--amber) 1.5px', textUnderlineOffset: '3px' },
  '.cm-lint-marker': { content: 'none', width: '8px', height: '8px', margin: '5px 3px', borderRadius: '50%' },
  '.cm-lint-marker-error': { content: 'none', backgroundColor: 'var(--red)' },
  '.cm-lint-marker-warning': { content: 'none', backgroundColor: 'var(--amber)' },
  '.cm-tooltip': { backgroundColor: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', boxShadow: 'var(--shadow-md)', overflow: 'hidden' },
  '.cm-diagnostic, .cm-diagnostic-error, .cm-diagnostic-warning': { borderLeft: 'none', marginLeft: 0, padding: '6px 10px', fontFamily: 'var(--font)', fontSize: '12px', lineHeight: '1.45' }
});

/** Marks a change that came from outside the editor (revert, reload), so it is not reported back as an edit. */
const external = Annotation.define<boolean>();

export interface CodeEditorHandle {
  /** Put the cursor at a 1-based line (and 0-based column), scroll it into view and focus the editor. */
  goTo: (line: number, column?: number) => void;
  focus: () => void;
}

interface Lint {
  errors: number;
  warnings: number;
  first: { line: number; column: number; message: string } | null;
  /** The check itself could not run, so nothing is known about this code. */
  failed?: boolean;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Svelte source editor with syntax highlighting, live compiler diagnostics and a status strip. Tab indents, so
 * Escape then Tab leaves the editor (WCAG 2.1.2); a second Escape reaches the dialog. `locked` holds the text
 * still while a save is running without losing the cursor or the undo history.
 */
export function CodeEditor({
  value,
  onChange,
  readOnly,
  locked,
  label = 'Svelte source',
  height = '60vh',
  onSave,
  onErrorCount,
  handle
}: {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  locked?: boolean;
  label?: string;
  height?: string;
  onSave?: () => void;
  onErrorCount?: (n: number) => void;
  handle?: MutableRefObject<CodeEditorHandle | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lockSlot = useRef(new Compartment());
  const armed = useRef(false);
  const said = useRef('');
  const callbacks = useRef({ onChange, onSave, onErrorCount });
  callbacks.current = { onChange, onSave, onErrorCount };
  const hintId = useId();
  const [pos, setPos] = useState({ line: 1, column: 1, lines: value.split('\n').length });
  const [selecting, setSelecting] = useState(false);
  const [focused, setFocused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [checking, setChecking] = useState(!readOnly);
  const [lint, setLint] = useState<Lint>({ errors: 0, warnings: 0, first: null });

  const stopLeaving = () => {
    if (armed.current) view.current?.setTabFocusMode(false);
    armed.current = false;
    setLeaving(false);
  };
  const goTo = (line: number, column = lint.first?.line === line ? lint.first.column : 0) => {
    const v = view.current;
    if (!v) return;
    const at = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
    const anchor = Math.min(at.from + column, at.to);
    v.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
    v.focus();
  };
  if (handle) handle.current = { goTo, focus: () => view.current?.focus() };

  useEffect(() => {
    const svelteLint = linter(
      async (v) => {
        const doc = v.state.doc;
        let found: Awaited<ReturnType<typeof api.project.validateSource>>['diagnostics'] = [];
        try {
          found = (await api.project.validateSource(doc.toString())).diagnostics;
        } catch {
          // The check itself failed: say nothing about the code rather than leave "Checking" on screen.
          if (doc.eq(v.state.doc)) {
            setLint({ errors: 0, warnings: 0, first: null, failed: true });
            callbacks.current.onErrorCount?.(0);
            setChecking(false);
          }
          return [];
        }
        // The text moved on while this ran; the next run reports on it.
        if (!doc.eq(v.state.doc)) return [];
        const diagnostics = found.map((d): Diagnostic => {
          const line = doc.line(Math.min(Math.max(1, d.line ?? 1), doc.lines));
          const from = Math.min(line.from + (d.column ?? 0), line.to);
          // Underline the whole word or token, so the mark can be seen and hovered.
          const token = /^[\w$-]+|^\S/.exec(doc.sliceString(from, line.to))?.[0].length ?? 1;
          return { from, to: Math.min(line.to, from + token), severity: d.severity === 'warning' ? 'warning' : 'error', message: d.message };
        });
        const errors = found.filter((d) => d.severity !== 'warning');
        const firstProblem = errors[0] ?? found[0];
        setLint({ errors: errors.length, warnings: found.length - errors.length, first: firstProblem ? { line: firstProblem.line ?? 1, column: firstProblem.column ?? 0, message: firstProblem.message } : null });
        callbacks.current.onErrorCount?.(errors.length);
        setChecking(false);
        return diagnostics;
      },
      { delay: 600 }
    );
    const editKeys = readOnly
      ? []
      : [
          { key: 'Mod-s', preventDefault: true, stopPropagation: true, run: () => (callbacks.current.onSave?.(), true) },
          {
            key: 'Escape',
            run: (v: EditorView) => {
              // An open diagnostic is dismissed first, so Escape never acts on code it is covering.
              if (hasHoverTooltips(v.state)) {
                v.dispatch({ effects: closeHoverTooltips });
                return true;
              }
              if (simplifySelection(v)) return true;
              // The second Escape is the dialog's: it runs the same guarded close as every other way out.
              if (armed.current) {
                stopLeaving();
                return false;
              }
              // Stays armed until Tab, another key, a click or blur, so the instruction can be read first.
              armed.current = true;
              v.setTabFocusMode(true);
              setLeaving(true);
              return true;
            }
          }
        ];
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        svelte(),
        syntaxHighlighting(highlight),
        theme,
        EditorView.domEventHandlers({
          keydown: (e) => {
            // A held Escape is one press: it must not run straight through to closing the dialog.
            if (e.key === 'Escape' && e.repeat && !readOnly) {
              e.preventDefault();
              return true;
            }
            if (!['Escape', 'Tab', 'Shift', 'Meta', 'Control', 'Alt'].includes(e.key) && armed.current) stopLeaving();
            return false;
          },
          mousedown: () => {
            if (armed.current) stopLeaving();
            return false;
          }
        }),
        keymap.of([...editKeys, indentWithTab, ...defaultKeymap, ...historyKeymap]),
        // Read-only code stays focusable, so it can be scrolled, selected and copied from the keyboard.
        lockSlot.current.of(EditorState.readOnly.of(!!readOnly || !!locked)),
        EditorView.contentAttributes.of({ 'aria-label': label, ...(readOnly ? { 'aria-readonly': 'true' } : { 'aria-describedby': hintId }) }),
        // The gutter is there in read-only code too, so code starts at the same column in every view.
        lintGutter(),
        ...(readOnly ? [] : [svelteLint]),
        EditorView.updateListener.of((u) => {
          if (u.focusChanged) {
            setFocused(u.view.hasFocus);
            if (!u.view.hasFocus) stopLeaving();
          }
          if (u.docChanged || u.selectionSet) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            setPos({ line: line.number, column: head - line.from + 1, lines: u.state.doc.lines });
            setSelecting(!u.state.selection.main.empty);
          }
          if (!u.docChanged) return;
          if (!readOnly) setChecking(true);
          if (!u.transactions.some((tr) => tr.annotation(external))) callbacks.current.onChange?.(u.state.doc.toString());
        })
      ]
    });
    view.current = new EditorView({ state, parent: host.current! });
    // When the frame shrinks (the problems panel opens, the window gets smaller) the caret stays in view.
    let lastHeight = host.current!.clientHeight;
    const resize = new ResizeObserver(() => {
      const height = host.current?.clientHeight ?? 0;
      const v = view.current;
      if (v?.hasFocus && height > 0 && height < lastHeight) v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { y: 'nearest' }) });
      lastHeight = height;
    });
    resize.observe(host.current!);
    return () => {
      resize.disconnect();
      view.current?.destroy();
    };
  }, [readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Replace the document when the value changes from outside (revert, reload, a repaired save).
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value }, selection: { anchor: Math.min(v.state.selection.main.head, value.length) }, annotations: external.of(true) });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: lockSlot.current.reconfigure(EditorState.readOnly.of(!!readOnly || !!locked)) });
  }, [readOnly, locked]);

  const summary = lint.errors ? plural(lint.errors, 'error') + (lint.warnings ? `, ${plural(lint.warnings, 'warning')}` : '') : lint.warnings ? plural(lint.warnings, 'warning') : 'No problems';
  // Holds its last result while a check runs, so a pause in typing does not repeat it to a screen reader.
  if (!checking) said.current = lint.failed ? 'This code could not be checked.' : lint.first ? `${summary}. Line ${lint.first.line}: ${lint.first.message}` : summary;
  return (
    <div className={`code-frame${focused ? ' focused' : ''}${selecting ? ' selecting' : ''}`} style={{ height }}>
      <div ref={host} className="code-editor" />
      <div className="code-status">
        {readOnly ? (
          <span className="code-status-item">{plural(pos.lines, 'line')}</span>
        ) : checking ? (
          <span className="code-status-item">
            <Spinner decorative /> Checking…
          </span>
        ) : lint.failed ? (
          <span className="code-status-item unavailable">
            <TriangleAlert aria-hidden="true" /> Could not check this code
          </span>
        ) : lint.first ? (
          <button type="button" className={`code-status-item code-status-problems${lint.errors ? ' error' : ' warning'}`} onClick={() => goTo(lint.first!.line, lint.first!.column)} title={`Go to line ${lint.first.line}: ${lint.first.message}`}>
            {lint.errors ? <CircleAlert aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
            <span className="code-status-count">{summary}</span>
            <span className="code-status-go">Line {lint.first.line}</span>
            <span className="code-status-message">{lint.first.message}</span>
          </button>
        ) : (
          <span className="code-status-item">
            <CircleCheck aria-hidden="true" /> No problems
          </span>
        )}
        {!readOnly && (
          <>
            <span className="sr-only" role="status">
              {said.current}
            </span>
            <span className="sr-only" role="status">
              {leaving ? 'Press Tab to leave the editor, or Escape to close.' : ''}
            </span>
            <span id={hintId} className="sr-only">
              Tab indents. Press Escape, then Tab, to leave the editor.
            </span>
          </>
        )}
        <span className="grow" />
        {!readOnly && focused && <span className={`code-status-hint${leaving ? ' active' : ''}`}>{leaving ? 'Press Tab to leave the editor, or Esc to close' : 'Esc then Tab leaves the editor'}</span>}
        <span className="code-status-pos">
          Ln {pos.line}, Col {pos.column}
        </span>
      </div>
    </div>
  );
}
