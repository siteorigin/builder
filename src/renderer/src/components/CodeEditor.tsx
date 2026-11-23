import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { svelte } from '@replit/codemirror-lang-svelte';
import { tags as t } from '@lezer/highlight';
import { api } from '../store';

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
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-soft) !important' }
});

/** Svelte source editor with syntax highlighting and live compiler diagnostics. */
export function CodeEditor({ value, onChange, readOnly, height = '60vh' }: { value: string; onChange?: (v: string) => void; readOnly?: boolean; height?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    const svelteLint = linter(async (v) => {
      const r = await api.project.validateSource(v.state.doc.toString());
      return r.diagnostics.map((d): Diagnostic => {
        const line = v.state.doc.line(Math.min(Math.max(1, d.line ?? 1), v.state.doc.lines));
        const from = Math.min(line.from + (d.column ?? 0), line.to);
        return { from, to: Math.max(from, Math.min(line.to, from + 1)), severity: d.severity === 'warning' ? 'warning' : 'error', message: d.message };
      });
    }, { delay: 600 });
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
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorState.readOnly.of(!!readOnly),
        EditorView.editable.of(!readOnly),
        ...(readOnly ? [] : [lintGutter(), svelteLint]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) changeRef.current?.(u.state.doc.toString());
        })
      ]
    });
    view.current = new EditorView({ state, parent: host.current! });
    return () => view.current?.destroy();
  }, [readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Replace the document when the value changes from outside (revert, reload).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="code-editor" style={{ height }} />;
}
