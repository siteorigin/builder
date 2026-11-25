import { describe, expect, it } from 'vitest';
import { focusedSurface, forwardedKeyRuns, historyOwner, menuHistoryOwner, type HistoryContext } from '../../src/renderer/src/lib/history';
import { menuKeyCopy } from '../../src/main/history-keys';

const ctx = (over: Partial<HistoryContext> = {}): HistoryContext => ({ editor: true, mode: 'edit', inlineEdit: false, frameText: false, overlay: false, focus: 'other', ...over });
const visitor = ctx({ mode: 'preview', focus: 'canvas' });
/** What Edit → Undo does, chosen from the menu (`click`) and reached by its key (`key`). */
const menu = (c: HistoryContext) => ({ click: menuHistoryOwner(c, false), key: menuHistoryOwner(c, true) });

describe('undo and redo routing', () => {
  it('leaves a visitor’s typing in Preview to the page, from the forwarded key and from the Edit menu', () => {
    // The reported bug: Cmd+Z in a Preview form field undid the project (and removed the form).
    for (const key of ['z', 'Z', 'y']) expect(forwardedKeyRuns(visitor, key, true)).toBe(false);
    expect(menu(visitor)).toEqual({ click: 'text', key: 'text' });
    // Whatever on the page has focus: a field, a button, the page itself.
    expect(menu({ ...visitor, frameText: true })).toEqual({ click: 'text', key: 'text' });
  });

  it('never lets a visitor’s keys edit the project in Preview, but keeps the editor-wide shortcuts', () => {
    for (const page of [visitor, { ...visitor, frameText: true }]) {
      for (const key of ['Delete', 'Backspace']) expect(forwardedKeyRuns(page, key, false)).toBe(false);
      for (const key of ['z', 'd', 'c', 'v', 'ArrowUp', 'ArrowDown']) expect(forwardedKeyRuns(page, key, true)).toBe(false);
    }
    for (const key of ['k', 'K', 's', 'S', 'e', '\\', '|']) expect(forwardedKeyRuns(visitor, key, true)).toBe(true);
    expect(forwardedKeyRuns(visitor, 'Escape', false)).toBe(true);
  });

  it('runs Ask AI from a visitor’s page or a field on it on whatever key it has, and no longer on J once moved (#750)', () => {
    for (const page of [visitor, { ...visitor, frameText: true }, ctx({ focus: 'canvas', overlay: true })]) {
      for (const key of ['L', '7', 'q']) expect(forwardedKeyRuns(page, key, true, true)).toBe(true);
      expect(forwardedKeyRuns(page, 'j', true, false)).toBe(false);
    }
    // Typing on the page keeps its keys: only Save runs while site copy is edited. Off the canvas, nothing forwarded runs.
    expect(forwardedKeyRuns(ctx({ focus: 'canvas', inlineEdit: true }), 'L', true, true)).toBe(false);
    expect(forwardedKeyRuns(ctx({ focus: 'other' }), 'L', true, true)).toBe(false);
    expect(forwardedKeyRuns(ctx({ editor: false, focus: 'canvas' }), 'L', true, true)).toBe(false);
  });

  it('undoes the project from the canvas in Edit mode exactly once', () => {
    const canvas = ctx({ focus: 'canvas' });
    for (const key of ['z', 'y']) expect(forwardedKeyRuns(canvas, key, true)).toBe(true);
    for (const key of ['Delete', 'Backspace']) expect(forwardedKeyRuns(canvas, key, false)).toBe(true);
    // The forwarded key undoes the project; the menu's copy of that key press must not undo a second step.
    expect(menu(canvas)).toEqual({ click: 'project', key: 'none' });
  });

  it('keeps inline site copy’s own history while it is being edited', () => {
    const inline = ctx({ focus: 'canvas', inlineEdit: true });
    for (const key of ['z', 'y', 'c', 'v', 'd']) expect(forwardedKeyRuns(inline, key, true)).toBe(false);
    for (const key of ['Delete', 'Backspace']) expect(forwardedKeyRuns(inline, key, false)).toBe(false);
    expect(menu(inline)).toEqual({ click: 'text', key: 'text' });
    // Save still runs: it hands the text being edited back and saves it. Nothing else of the editor's does.
    for (const key of ['s', 'S']) expect(forwardedKeyRuns(inline, key, true)).toBe(true);
    for (const key of ['k', 'e', 'j', '\\']) expect(forwardedKeyRuns(inline, key, true)).toBe(false);
    expect(forwardedKeyRuns(inline, 's', false)).toBe(false);
    expect(forwardedKeyRuns(inline, 'Escape', false)).toBe(false);
  });

  it('leaves a field on the canvas its own history in Edit mode too, whichever way Undo arrives', () => {
    // A field reached with Tab while editing: Edit → Undo clicked with the mouse used to undo its typing, and must not undo the project.
    const field = ctx({ focus: 'canvas', frameText: true });
    expect(menu(field)).toEqual({ click: 'text', key: 'text' });
    for (const key of ['z', 'y', 'v', 'd']) expect(forwardedKeyRuns(field, key, true)).toBe(false);
    for (const key of ['Delete', 'Backspace']) expect(forwardedKeyRuns(field, key, false)).toBe(false);
    expect(forwardedKeyRuns(field, 'k', true)).toBe(true);
    // The page's report only ever withholds project history; it never grants it.
    expect(historyOwner(ctx({ focus: 'other', frameText: true }))).toBe('project');
    expect(historyOwner(ctx({ focus: 'frame', frameText: true }))).toBe('none');
  });

  it('undoes the project from Layers and the rest of the editor from the Edit menu; their keys are the editor’s own', () => {
    for (const mode of ['edit', 'preview'] as const) {
      // Cmd+Z there is handled by the editor's keydown handler, so the menu's copy of a key press does nothing more.
      expect(menu(ctx({ mode }))).toEqual({ click: 'project', key: 'none' });
      // A field on the page reported earlier has no say once the canvas has lost focus.
      expect(menu(ctx({ mode, frameText: true }))).toEqual({ click: 'project', key: 'none' });
    }
  });

  it('keeps text history in the editor’s own fields, a dialog’s and Welcome’s', () => {
    for (const c of [ctx({ focus: 'text' }), ctx({ focus: 'text', overlay: true }), ctx({ focus: 'text', editor: false })]) expect(menu(c)).toEqual({ click: 'text', key: 'text' });
  });

  it('does nothing where neither history applies', () => {
    for (const c of [ctx({ overlay: true }), ctx({ focus: 'frame' }), ctx({ editor: false }), ctx({ editor: false, focus: 'canvas' })]) expect(menu(c)).toEqual({ click: 'none', key: 'none' });
    expect(forwardedKeyRuns(ctx({ focus: 'other' }), 'z', true)).toBe(false);
    expect(forwardedKeyRuns(ctx({ editor: false, focus: 'canvas' }), 'z', true)).toBe(false);
  });

  it('keeps an open editor menu or dialog in charge of keys forwarded from the canvas', () => {
    const covered = ctx({ focus: 'canvas', overlay: true });
    for (const key of ['z', 'y', 'd', 'v', 'ArrowUp']) expect(forwardedKeyRuns(covered, key, true)).toBe(false);
    expect(forwardedKeyRuns(covered, 'Backspace', false)).toBe(false);
    expect(forwardedKeyRuns(covered, 'k', true)).toBe(true);
    expect(forwardedKeyRuns(covered, 'Escape', false)).toBe(true);
  });

  it('gives text history only to controls that take typing', () => {
    const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra });
    expect(focusedSurface(null)).toBe('other');
    expect(focusedSurface(undefined)).toBe('other');
    for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number', undefined]) expect(focusedSurface(el('INPUT', { type }))).toBe('text');
    expect(focusedSurface(el('TEXTAREA'))).toBe('text');
    expect(focusedSurface(el('DIV', { isContentEditable: true }))).toBe('text');
    // A select, a checkbox or a colour well is an authoring control: Undo there is the project's.
    expect(focusedSurface(el('SELECT'))).toBe('other');
    for (const type of ['checkbox', 'radio', 'color', 'range', 'button']) expect(focusedSurface(el('INPUT', { type }))).toBe('other');
    expect(focusedSurface(el('DIV', { isContentEditable: false }))).toBe('other');
    expect(focusedSurface(el('IFRAME', { closest: (s: string) => (s === '.frame-box' ? {} : null) }))).toBe('canvas');
    expect(focusedSurface(el('IFRAME', { closest: () => null }))).toBe('frame');
    expect(focusedSurface(el('IFRAME'))).toBe('frame');
  });
});

describe('telling the Edit menu’s key from a choice in the menu', () => {
  it('counts an activation as the key only while the accelerator’s modifier is held', () => {
    expect(menuKeyCopy({ triggeredByAccelerator: true, metaKey: true }, true)).toBe(true);
    expect(menuKeyCopy({ triggeredByAccelerator: true, ctrlKey: true }, false)).toBe(true);
    // Return in a menu worked with the keyboard is reported as an accelerator, with no modifier held.
    expect(menuKeyCopy({ triggeredByAccelerator: true }, true)).toBe(false);
    expect(menuKeyCopy({ triggeredByAccelerator: true }, false)).toBe(false);
    // Control on macOS and Meta elsewhere are not the accelerator's modifier.
    expect(menuKeyCopy({ triggeredByAccelerator: true, ctrlKey: true }, true)).toBe(false);
    expect(menuKeyCopy({ triggeredByAccelerator: true, metaKey: true }, false)).toBe(false);
  });

  it('counts a mouse choice as a choice, whatever is held', () => {
    expect(menuKeyCopy({ triggeredByAccelerator: false, metaKey: true, ctrlKey: true }, true)).toBe(false);
    expect(menuKeyCopy({}, false)).toBe(false);
    expect(menuKeyCopy(undefined, true)).toBe(false);
  });
});
