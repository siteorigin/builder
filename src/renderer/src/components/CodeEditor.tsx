import { useEffect, useId, useRef, useState, type MutableRefObject } from 'react';
import { Annotation, Compartment, EditorState, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, closeHoverTooltips, hasHoverTooltips, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, simplifySelection } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { svelte } from '@replit/codemirror-lang-svelte';
import { tags as t } from '@lezer/highlight';
import { CircleAlert, CircleCheck, Lock, TriangleAlert, WrapText } from 'lucide-react';
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

/** Severity glyphs for the gutter, drawn as masks so they take the theme's colour: a round mark for an error, a
 *  triangle for a warning, each with the exclamation knocked out. Shape, not hue, tells them apart. */
const glyph = (path: string) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path fill-rule='evenodd' d='${path}'/></svg>`)}")`;
const ERROR_GLYPH = glyph('M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm-.95 3.4h1.9l-.32 5.1H7.37l-.32-5.1ZM8 10.55a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1Z');
const WARNING_GLYPH = glyph('M8 1.3c.42 0 .8.22 1.01.58l6.3 11.1c.44.78-.12 1.72-1.01 1.72H1.7c-.9 0-1.45-.94-1.01-1.72l6.3-11.1C7.2 1.52 7.58 1.3 8 1.3Zm-.88 4.1h1.76l-.28 4.6H7.4l-.28-4.6ZM8 10.95a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z');
const mark = (image: string) => ({ maskImage: image, maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center' });

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--code-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65', scrollbarWidth: 'thin', scrollbarColor: 'var(--border-control) transparent' },
  '.cm-content': { padding: '8px 0' },
  // A wrapped line's continuation hangs past its own indent, so it never reads as a new, unnumbered line.
  '.cm-lineWrapping .cm-line': { paddingLeft: 'calc(6px + var(--wrap-indent, 4ch))', textIndent: 'calc(-1 * var(--wrap-indent, 4ch))' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-3)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '36px', padding: '0 4px 0 12px', fontVariantNumeric: 'tabular-nums' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--code-selection) !important', boxShadow: 'inset 0 0 0 1px var(--border-control)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--red) 1.5px', textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--amber) 1.5px', textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
  // The finding being inspected gets the neutral band, not the library's yellow, so its tokens keep their contrast.
  '.cm-lintRange-active': { backgroundColor: 'var(--active)' },
  '.cm-lintPoint::after': { borderBottomColor: 'var(--red)' },
  '.cm-lintPoint-warning::after': { borderBottomColor: 'var(--amber)' },
  // Matching brackets take a neutral ring; an unmatched one the danger hue.
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--active)', boxShadow: 'inset 0 0 0 1px var(--border-control)', borderRadius: '2px' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--red-soft)', boxShadow: 'inset 0 0 0 1px var(--red)', borderRadius: '2px' },
  '.cm-gutter-lint': { width: '18px' },
  '.cm-gutter-lint .cm-gutterElement': { padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  '.cm-lint-marker': { content: 'none', width: '12px', height: '12px' },
  '.cm-lint-marker-error': { content: 'none', backgroundColor: 'var(--red)', ...mark(ERROR_GLYPH) },
  '.cm-lint-marker-warning': { content: 'none', backgroundColor: 'var(--amber)', ...mark(WARNING_GLYPH) },
  '.cm-tooltip': { backgroundColor: 'var(--raised)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-md)', overflow: 'hidden' },
  '.cm-tooltip.cm-tooltip-lint': { maxWidth: '440px' },
  '.cm-diagnostic, .cm-diagnostic-error, .cm-diagnostic-warning': { borderLeft: 'none', marginLeft: 0, padding: '8px 12px', fontFamily: 'var(--font)', fontSize: '12px', lineHeight: '1.45' },
  '.cm-diagnostic + .cm-diagnostic': { borderTop: '1px solid var(--border)' },
  '.code-diag-kind::before': { content: '""', display: 'inline-block', width: '12px', height: '12px', marginRight: '6px', verticalAlign: '-2px', backgroundColor: 'currentColor' },
  '.code-diag-kind.error::before': mark(ERROR_GLYPH),
  '.code-diag-kind.warning::before': mark(WARNING_GLYPH)
});

/** Each visible line carries its own hanging indent (its leading whitespace plus 4ch), read by the wrapping rule. */
const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.geometryChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const out = new RangeSetBuilder<Decoration>();
      const tab = view.state.tabSize;
      let last = -1;
      for (const { from, to } of view.visibleRanges) {
        for (let at = from; at <= to; ) {
          const line = view.state.doc.lineAt(at);
          if (line.number !== last) {
            let cols = 0;
            for (const ch of line.text) {
              if (ch === ' ') cols++;
              else if (ch === '\t') cols += tab - (cols % tab);
              else break;
            }
            out.add(line.from, line.from, Decoration.line({ attributes: { style: `--wrap-indent: ${Math.min(cols, 40) + 4}ch` } }));
            last = line.number;
          }
          at = line.to + 1;
        }
      }
      return out.finish();
    }
  },
  { decorations: (v) => v.decorations }
);

/** The finding the strip offers next: after the one just jumped to (so two at one spot are both reached), else the
 *  first one after the caret, wrapping round. */
function nextIndex(items: Problem[], pos: { line: number; column: number }, last: number): number {
  if (!items.length) return -1;
  const atCaret = (p: Problem) => p.line === pos.line && p.column + 1 === pos.column;
  if (last >= 0 && last < items.length && atCaret(items[last])) return (last + 1) % items.length;
  const i = items.findIndex((p) => p.line > pos.line || (p.line === pos.line && p.column + 1 > pos.column));
  return i < 0 ? 0 : i;
}

/** The finding before the caret (or before the one just jumped to), wrapping round. */
function previousIndex(items: Problem[], pos: { line: number; column: number }, last: number): number {
  if (!items.length) return -1;
  const atCaret = (p: Problem) => p.line === pos.line && p.column + 1 === pos.column;
  if (last >= 0 && last < items.length && atCaret(items[last])) return (last - 1 + items.length) % items.length;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].line < pos.line || (items[i].line === pos.line && items[i].column + 1 < pos.column)) return i;
  return items.length - 1;
}

/** Keep a couple of lines of context around the caret, so a jump never lands it against the frame's edge. */
const margins = EditorView.scrollMargins.of(() => ({ top: 24, bottom: 24 }));

/** The tooltip on a gutter mark names the severity and the line in words, before the compiler's message. */
function diagnosticMessage(severity: 'error' | 'warning', line: number, message: string) {
  return () => {
    const root = document.createElement('span');
    root.className = 'code-diag';
    const head = document.createElement('span');
    head.className = 'code-diag-head';
    const kind = document.createElement('strong');
    kind.className = `code-diag-kind ${severity}`;
    kind.textContent = severity === 'error' ? 'Error' : 'Warning';
    const at = document.createElement('span');
    at.className = 'code-diag-line';
    at.textContent = `Line ${line}`;
    head.append(kind, at);
    const text = document.createElement('span');
    text.className = 'code-diag-message';
    text.textContent = message;
    root.append(head, text);
    return root;
  };
}

/** Marks a change that came from outside the editor (revert, reload), so it is not reported back as an edit. */
const external = Annotation.define<boolean>();

export interface CodeEditorHandle {
  /** Put the cursor at a 1-based line (and 0-based column), scroll it into view and focus the editor. */
  goTo: (line: number, column?: number) => void;
  focus: () => void;
  /** True while the live check has not yet reported on the text as it stands, so its last count is stale. */
  checking: () => boolean;
}

interface Problem {
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
}

interface Lint {
  errors: number;
  warnings: number;
  /** Every finding in document order: errors and warnings both, so each one can be reached. */
  items: Problem[];
  /** The check itself could not run, so nothing is known about this code. */
  failed?: boolean;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const MOD = api.platform === 'darwin' ? '⌘' : 'Ctrl+';

/** Line wrapping is remembered per kind of view: generated source reads best wrapped, code being written does not. */
const wrapKey = (readOnly: boolean) => `code-wrap:${readOnly ? 'view' : 'edit'}`;
function savedWrap(readOnly: boolean): boolean {
  try {
    const v = localStorage.getItem(wrapKey(readOnly));
    return v === null ? readOnly : v === '1';
  } catch {
    return readOnly;
  }
}

/**
 * Svelte source editor with syntax highlighting, live compiler diagnostics and a status strip. Tab indents, so
 * Escape then Tab leaves the editor (WCAG 2.1.2); a second Escape reaches the dialog. `locked` holds the text
 * still while a save is running without losing the cursor or the undo history. Editable code sits on the input
 * surface with a control edge; read-only code is recessed, has no current-line band and says so in the strip.
 */
export function CodeEditor({
  value,
  onChange,
  readOnly,
  locked,
  label = 'Svelte source',
  height = '60vh',
  onSave,
  saveHint,
  onErrorCount,
  onChecking,
  problemsShown,
  handle
}: {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  locked?: boolean;
  label?: string;
  height?: string;
  onSave?: () => void;
  /** What Cmd/Ctrl+S does right now ("saves", "reviews errors"), for the keyboard hint; null when it does nothing. */
  saveHint?: string | null;
  /** The live error count and the line of the first error, each time the check reports. */
  onErrorCount?: (n: number, line?: number) => void;
  /** Whether the live check is still to report on the text as it stands. */
  onChecking?: (pending: boolean) => void;
  /** A list of the problems is on screen below the editor, so the strip keeps to the count. */
  problemsShown?: boolean;
  handle?: MutableRefObject<CodeEditorHandle | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lockSlot = useRef(new Compartment());
  const wrapSlot = useRef(new Compartment());
  const armed = useRef(false);
  const said = useRef('');
  const pending = useRef(!readOnly);
  const lastJump = useRef(-1);
  const found = useRef<Problem[]>([]);
  const callbacks = useRef({ onChange, onSave, onErrorCount, onChecking });
  callbacks.current = { onChange, onSave, onErrorCount, onChecking };
  const hintId = useId();
  const [pos, setPos] = useState({ line: 1, column: 1, lines: value.split('\n').length });
  const [selecting, setSelecting] = useState(false);
  const [focused, setFocused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [checking, setCheckingState] = useState(!readOnly);
  const [lint, setLint] = useState<Lint>({ errors: 0, warnings: 0, items: [] });
  const [wrap, setWrap] = useState(() => savedWrap(!!readOnly));
  // Where the last jump landed, said politely, since the strip then moves on to name the next finding.
  const [reached, setReached] = useState('');
  const setChecking = (on: boolean) => {
    if (pending.current !== on) callbacks.current.onChecking?.(on);
    pending.current = on;
    setCheckingState(on);
  };

  const stopLeaving = () => {
    if (armed.current) view.current?.setTabFocusMode(false);
    armed.current = false;
    setLeaving(false);
  };
  const goTo = (line: number, column = lint.items.find((p) => p.line === line)?.column ?? 0) => {
    const v = view.current;
    if (!v) return;
    const at = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
    const anchor = Math.min(at.from + column, at.to);
    v.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
    v.focus();
  };
  if (handle) handle.current = { goTo, focus: () => view.current?.focus(), checking: () => pending.current };
  found.current = lint.items;
  /** F8 and Shift+F8 walk the findings exactly as the strip's jump does. */
  const step = (forward: boolean) => {
    const v = view.current;
    const items = found.current;
    if (!v || !items.length) return false;
    const head = v.state.selection.main.head;
    const line = v.state.doc.lineAt(head);
    const at = { line: line.number, column: head - line.from + 1 };
    const i = forward ? nextIndex(items, at, lastJump.current) : previousIndex(items, at, lastJump.current);
    land(items, i);
    return true;
  };
  /** Go to finding `i` and say what is there: its line, severity and message, and where it sits among the rest. */
  const land = (items: Problem[], i: number) => {
    const p = items[i];
    lastJump.current = i;
    goTo(p.line, p.column);
    setReached(`Line ${p.line}, ${p.severity}: ${p.message}${items.length > 1 ? ` (${i + 1} of ${items.length})` : ''}`);
  };

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
            setLint({ errors: 0, warnings: 0, items: [], failed: true });
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
          const severity = d.severity === 'warning' ? 'warning' : 'error';
          return { from, to: Math.min(line.to, from + token), severity, message: d.message, renderMessage: diagnosticMessage(severity, line.number, d.message) };
        });
        const items = found
          .map((d): Problem => ({ line: d.line ?? 1, column: d.column ?? 0, message: d.message, severity: d.severity === 'warning' ? 'warning' : 'error' }))
          .sort((a, b) => a.line - b.line || a.column - b.column);
        const errors = items.filter((p) => p.severity === 'error');
        setLint({ errors: errors.length, warnings: items.length - errors.length, items });
        callbacks.current.onErrorCount?.(errors.length, errors[0]?.line);
        setChecking(false);
        return diagnostics;
      },
      { delay: 600 }
    );
    const editKeys = readOnly
      ? []
      : [
          { key: 'Mod-s', preventDefault: true, stopPropagation: true, run: () => (callbacks.current.onSave?.(), true) },
          // Every finding is reachable from the keyboard, in order, as in other editors.
          { key: 'F8', run: () => step(true) },
          { key: 'Shift-F8', run: () => step(false) },
          {
            key: 'Escape',
            run: (v: EditorView) => {
              // An open diagnostic is dismissed first, so Escape never acts on code it is covering.
              if (hasHoverTooltips(v.state)) {
                v.dispatch({ effects: closeHoverTooltips });
                return true;
              }
              if (simplifySelection(v)) return true;
              // The second Escape is the dialog's: it runs the same guarded close as every other way out. The way
              // out is put away once CodeMirror is done with this key: while it is still on, CodeMirror's own
              // Escape starts no two-second spell in which Tab leaves the editor, so Tab indents again at once
              // when Keep editing (or a close that cannot happen yet) leaves focus here.
              if (armed.current) {
                queueMicrotask(stopLeaving);
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
        // Read-only code has no caret line to mark: a band there reads as a place to type.
        ...(readOnly ? [] : [highlightActiveLineGutter(), highlightActiveLine()]),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        svelte(),
        syntaxHighlighting(highlight),
        theme,
        margins,
        hangingIndent,
        // Svelte's own convention, and the starter's: Tab indents with a tab.
        indentUnit.of('\t'),
        wrapSlot.current.of(wrap ? EditorView.lineWrapping : []),
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
          },
          // Leaving ends the way out at once: CodeMirror reports focus changes a moment late, and misses one
          // that comes straight back, which would leave Tab moving focus instead of indenting.
          blur: () => {
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
    // When the frame shrinks (the problems panel opens, the window gets smaller) a caret that was in view stays in
    // view with its margin of context, wherever focus is: the line being fixed never slides under the strip.
    let lastHeight = host.current!.clientHeight;
    const resize = new ResizeObserver(() => {
      const height = host.current?.clientHeight ?? 0;
      const v = view.current;
      if (v && height > 0 && height < lastHeight) {
        const top = v.lineBlockAt(v.state.selection.main.head).top - v.scrollDOM.scrollTop;
        if (v.hasFocus || (top >= 0 && top < lastHeight)) v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { y: 'nearest' }) });
      }
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

  const toggleWrap = () => {
    const next = !wrap;
    setWrap(next);
    view.current?.dispatch({ effects: wrapSlot.current.reconfigure(next ? EditorView.lineWrapping : []) });
    try {
      localStorage.setItem(wrapKey(!!readOnly), next ? '1' : '0');
    } catch {
      // Not remembered this time; the toggle still applies.
    }
  };

  const summary = lint.errors ? plural(lint.errors, 'error') + (lint.warnings ? `, ${plural(lint.warnings, 'warning')}` : '') : lint.warnings ? plural(lint.warnings, 'warning') : 'No problems';
  // Holds its last result while a check runs, so a pause in typing does not repeat it to a screen reader.
  const first = lint.items[0];
  if (!checking) said.current = lint.failed ? 'This code could not be checked.' : first ? `${summary}. Line ${first.line}: ${first.message}` : summary;
  // The strip names the next finding from the caret, wrapping round, so pressing it again walks through them all.
  // Its icon is that finding's own severity; the count beside it covers the whole file.
  const nextAt = nextIndex(lint.items, pos, lastJump.current);
  const next = nextAt >= 0 ? lint.items[nextAt] : undefined;
  const severity = problemsShown ? (lint.errors ? 'error' : 'warning') : (next?.severity ?? 'error');
  const Severity = severity === 'error' ? CircleAlert : TriangleAlert;
  return (
    <div className={`code-frame${readOnly ? ' readonly' : ''}${focused ? ' focused' : ''}${selecting ? ' selecting' : ''}`} style={{ height }} aria-busy={locked || undefined}>
      <div ref={host} className="code-editor" />
      <div className="code-status">
        {readOnly ? (
          <span className="code-status-item">
            <Lock aria-hidden="true" /> Read only
            <span className="code-status-sep" aria-hidden="true" />
            {plural(pos.lines, 'line')}
          </span>
        ) : checking ? (
          <span className="code-status-item">
            <Spinner decorative /> Checking…
          </span>
        ) : lint.failed ? (
          <span className="code-status-item unavailable">
            <TriangleAlert aria-hidden="true" /> Could not check this code
          </span>
        ) : next && problemsShown ? (
          // The list below has every problem and its line; the strip keeps to the count, and still walks them.
          <button type="button" className={`code-status-item code-status-problems ${severity}`} onClick={() => land(lint.items, nextAt)} title={`Go to the next problem, line ${next.line} (F8)`}>
            <Severity aria-hidden="true" />
            <span className="code-status-count">{summary}</span>
          </button>
        ) : next ? (
          <button
            type="button"
            className={`code-status-item code-status-problems ${severity}`}
            onClick={() => land(lint.items, nextAt)}
            title={lint.items.length > 1 ? `Go to the next problem, line ${next.line} (F8)` : `Go to line ${next.line} (F8)`}
          >
            <Severity aria-hidden="true" />
            <span className="code-status-count">{summary}</span>
            <span className="code-status-go">Line {next.line}</span>
            <span className="code-status-message">{next.message}</span>
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
            <span className="sr-only" role="status">
              {reached}
            </span>
            <span id={hintId} className="sr-only">
              Tab indents. Press Escape, then Tab, to leave the editor. F8 goes to the next problem.
            </span>
          </>
        )}
        <span className="grow" />
        {!readOnly && focused && (
          <span className={`code-status-hint${leaving ? ' active' : ''}`} aria-hidden="true">
            {leaving ? (
              <>
                Press <kbd className="kbd">Tab</kbd> to leave the editor, or <kbd className="kbd">Esc</kbd> to close
              </>
            ) : (
              <>
                {onSave && saveHint && (
                  <span className="code-status-keys save">
                    <kbd className="kbd">{MOD}S</kbd> {saveHint}
                  </span>
                )}
                <span className="code-status-keys">
                  <kbd className="kbd">Esc</kbd> then <kbd className="kbd">Tab</kbd> leaves the editor
                </span>
              </>
            )}
          </span>
        )}
        <button type="button" className="code-status-item code-status-toggle" aria-pressed={wrap} onClick={toggleWrap} title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}>
          <WrapText aria-hidden="true" /> Wrap
        </button>
        <span className="code-status-pos">
          Ln {pos.line}, Col {pos.column}
        </span>
      </div>
    </div>
  );
}
