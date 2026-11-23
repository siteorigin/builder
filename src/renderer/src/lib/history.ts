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

/** Classify the focused element (`document.activeElement`), the same way the editor's keyboard handler decides that someone is typing. */
export function focusedSurface(el: { tagName: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null | undefined): FocusedSurface {
  if (!el) return 'other';
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return 'text';
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
 * Edit → Undo or Redo. `fromKey`: this is the menu's copy of an Undo or Redo key press that the main process
 * also forwarded (a key reaches the menu only when the page left it alone). With the canvas focused in Edit
 * mode, the forwarded copy has already undone the project (see `forwardedKeyRuns`), so this one must not undo a
 * second step.
 */
export function menuHistoryOwner(c: HistoryContext, fromKey: boolean): HistoryOwner {
  const owner = historyOwner(c);
  return owner === 'project' && fromKey && c.focus === 'canvas' ? 'none' : owner;
}

/** Shortcuts that still work from a visitor's page or a field on the page: they open editor panels or save, and never change the site or its text. */
const PREVIEW_KEYS = new Set(['k', 's', 'e', '\\', '|']);

/**
 * Whether an editor shortcut forwarded by the main process (the preview frame had focus, so the editor's own
 * keydown handler could not see it) should run. In Preview the page is the visitor's, and a text field on the
 * page keeps its keys in Edit mode too: Undo, Delete and paste belong to the field, never to the project.
 */
export function forwardedKeyRuns(c: HistoryContext, key: string, mod: boolean): boolean {
  if (!c.editor || c.inlineEdit || c.focus !== 'canvas') return false;
  if (c.mode === 'edit' && !c.frameText) return true;
  return mod ? PREVIEW_KEYS.has(key.toLowerCase()) : key === 'Escape';
}
