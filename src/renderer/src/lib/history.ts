/**
 * Who Undo and Redo belong to, from what has focus and the editor's mode.
 *
 * A text field keeps its own text history: a field in the editor or a dialog, a visitor's form field in
 * Preview, and site copy being edited on the canvas. Authoring surfaces (Layers, the toolbar, the canvas in
 * Edit mode) undo the project. Where neither applies (a dialog's button, an open menu, another frame), nothing
 * happens, so the browser never undoes a field that no longer has focus.
 */
export type HistoryOwner = 'project' | 'text' | 'none';

/**
 * What has focus in the editor window. `text`: a control in the editor document that takes typing.
 * `canvas`: the site preview frame. `frame`: any other frame. `other`: anything else (a Layers row, a button,
 * the page itself).
 */
export type FocusedSurface = 'text' | 'canvas' | 'frame' | 'other';

export interface HistoryContext {
  /** A project is open in the editor (not the Welcome screen). */
  editor: boolean;
  mode: 'edit' | 'preview';
  /** Site copy is being edited on the canvas. */
  inlineEdit: boolean;
  /** A text field inside the preview frame has focus, as the page reports it. It can only keep history in that field, never start a project change. */
  frameText: boolean;
  /** A dialog or menu is open. */
  overlay: boolean;
  focus: FocusedSurface;
}

/** Input types that take typing, and so have a text history of their own. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);

/**
 * Classify the focused element (`document.activeElement`, or a key's target). Only controls that take typing
 * are `text`: a select, a checkbox or a colour well has no text history, so Undo there is the project's.
 */
export function focusedSurface(el: { tagName: string; type?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null | undefined): FocusedSurface {
  if (!el) return 'other';
  if (el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(el.type ?? 'text'))) return 'text';
  if (el.tagName === 'IFRAME') return el.closest?.('.frame-box') ? 'canvas' : 'frame';
  return 'other';
}

export function historyOwner(c: HistoryContext): HistoryOwner {
  if (c.focus === 'text') return 'text';
  if (!c.editor || c.overlay || c.focus === 'frame') return 'none';
  // The preview frame is the visitor's in Preview, the edit's while site copy is being edited, and a field's
  // while one on the page has focus.
  if (c.focus === 'canvas') return c.mode === 'preview' || c.inlineEdit || c.frameText ? 'text' : 'project';
  return 'project';
}

/**
 * Edit → Undo or Redo. `fromKey`: the menu was reached by its key (Cmd/Ctrl+Z and so on), which happens only
 * when nothing on the page took the key. Every key press that undoes the project is already run by a keyboard
 * handler (the editor's own, or the main process's forwarded copy while the canvas has focus), so the menu's copy
 * of a key press only ever undoes text, never a second project step.
 */
export function menuHistoryOwner(c: HistoryContext, fromKey: boolean): HistoryOwner {
  const owner = historyOwner(c);
  return owner === 'project' && fromKey ? 'none' : owner;
}

/** Shortcuts that still work from a visitor's page or a field on the page: they open editor panels or save, and never change the site or its text. */
const PREVIEW_KEYS = new Set(['k', 's', 'e', 'j', '\\', '|']);

/**
 * Whether an editor shortcut forwarded by the main process (the preview frame had focus, so the editor's own
 * keydown handler could not see it) should run. In Preview the page is the visitor's, and a text field on the
 * page keeps its keys in Edit mode too: Undo, Delete and paste belong to the field, never to the project. While
 * an editor menu or dialog is open, only the editor-wide shortcuts run, as from the editor itself.
 */
export function forwardedKeyRuns(c: HistoryContext, key: string, mod: boolean): boolean {
  if (!c.editor || c.inlineEdit || c.focus !== 'canvas') return false;
  if (c.mode === 'edit' && !c.frameText && !c.overlay) return true;
  return mod ? PREVIEW_KEYS.has(key.toLowerCase()) : key === 'Escape';
}
