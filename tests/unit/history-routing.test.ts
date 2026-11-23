import { describe, expect, it } from 'vitest';
import { focusedSurface, forwardedKeyRuns, historyOwner, menuHistoryOwner, type HistoryContext } from '../../src/renderer/src/lib/history';
import { HistoryKeyPairing } from '../../src/main/history-keys';

const ctx = (over: Partial<HistoryContext> = {}): HistoryContext => ({ editor: true, mode: 'edit', inlineEdit: false, frameText: false, overlay: false, focus: 'other', ...over });
const visitor = ctx({ mode: 'preview', focus: 'canvas' });

describe('undo and redo routing', () => {
  it('leaves a visitor’s typing in Preview to the field, from the forwarded key and from the Edit menu', () => {
    // The reported bug: Cmd+Z in a Preview form field undid the project (and removed the form).
    for (const key of ['z', 'Z', 'y']) expect(forwardedKeyRuns(visitor, key, true)).toBe(false);
    expect(historyOwner(visitor)).toBe('text');
    expect(menuHistoryOwner(visitor, true)).toBe('text');
    expect(menuHistoryOwner(visitor, false)).toBe('text');
  });

  it('never lets a visitor’s keys edit the project in Preview, but keeps the editor-wide shortcuts', () => {
    for (const key of ['Delete', 'Backspace']) expect(forwardedKeyRuns(visitor, key, false)).toBe(false);
    for (const key of ['d', 'c', 'v', 'j', 'ArrowUp', 'ArrowDown']) expect(forwardedKeyRuns(visitor, key, true)).toBe(false);
    for (const key of ['k', 's', 'e', '\\', '|']) expect(forwardedKeyRuns(visitor, key, true)).toBe(true);
    expect(forwardedKeyRuns(visitor, 'Escape', false)).toBe(true);
  });

  it('undoes the project from the canvas in Edit mode exactly once', () => {
    const canvas = ctx({ focus: 'canvas' });
    expect(forwardedKeyRuns(canvas, 'z', true)).toBe(true);
    expect(historyOwner(canvas)).toBe('project');
    // A menu click undoes the project; the menu's copy of a key press does not, because the forwarded copy already did.
    expect(menuHistoryOwner(canvas, false)).toBe('project');
    expect(menuHistoryOwner(canvas, true)).toBe('none');
  });

  it('keeps inline site copy’s own history while it is being edited', () => {
    const inline = ctx({ focus: 'canvas', inlineEdit: true });
    expect(forwardedKeyRuns(inline, 'z', true)).toBe(false);
    expect(menuHistoryOwner(inline, true)).toBe('text');
    expect(menuHistoryOwner(inline, false)).toBe('text');
  });

  it('leaves a form field on the canvas its own history in Edit mode too, whichever way Undo arrives', () => {
    // A field reached with Tab while editing: Edit → Undo clicked with the mouse used to undo its typing, and must not undo the project.
    const field = ctx({ focus: 'canvas', frameText: true });
    expect(menuHistoryOwner(field, false)).toBe('text');
    expect(menuHistoryOwner(field, true)).toBe('text');
    for (const key of ['z', 'y', 'v', 'd']) expect(forwardedKeyRuns(field, key, true)).toBe(false);
    for (const key of ['Delete', 'Backspace']) expect(forwardedKeyRuns(field, key, false)).toBe(false);
    expect(forwardedKeyRuns(field, 'k', true)).toBe(true);
    // The page's report only ever withholds project history; it never grants it.
    expect(historyOwner(ctx({ focus: 'other', frameText: true }))).toBe('project');
    expect(historyOwner(ctx({ focus: 'frame', frameText: true }))).toBe('none');
  });

  it('undoes the project from Layers and the rest of the editor, from the Edit menu as from the keyboard', () => {
    for (const mode of ['edit', 'preview'] as const) {
      expect(menuHistoryOwner(ctx({ mode }), false)).toBe('project');
      expect(menuHistoryOwner(ctx({ mode }), true)).toBe('project');
    }
  });

  it('keeps text history in the editor’s own fields and in a dialog’s', () => {
    expect(menuHistoryOwner(ctx({ focus: 'text' }), true)).toBe('text');
    expect(menuHistoryOwner(ctx({ focus: 'text', overlay: true }), false)).toBe('text');
    expect(menuHistoryOwner(ctx({ focus: 'text', editor: false }), false)).toBe('text');
  });

  it('does nothing where neither history applies', () => {
    expect(historyOwner(ctx({ overlay: true }))).toBe('none');
    expect(historyOwner(ctx({ focus: 'frame' }))).toBe('none');
    expect(historyOwner(ctx({ editor: false }))).toBe('none');
    expect(forwardedKeyRuns(ctx({ focus: 'other' }), 'z', true)).toBe(false);
    expect(forwardedKeyRuns(ctx({ editor: false, focus: 'canvas' }), 'z', true)).toBe(false);
  });

  it('classifies what has focus', () => {
    const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra });
    expect(focusedSurface(null)).toBe('other');
    expect(focusedSurface(el('INPUT'))).toBe('text');
    expect(focusedSurface(el('TEXTAREA'))).toBe('text');
    expect(focusedSurface(el('SELECT'))).toBe('text');
    expect(focusedSurface(el('DIV', { isContentEditable: true }))).toBe('text');
    expect(focusedSurface(el('DIV', { isContentEditable: false }))).toBe('other');
    expect(focusedSurface(el('IFRAME', { closest: (s: string) => (s === '.frame-box' ? {} : null) }))).toBe('canvas');
    expect(focusedSurface(el('IFRAME', { closest: () => null }))).toBe('frame');
  });
});

describe('pairing Edit menu activations with forwarded key presses', () => {
  const clock = () => {
    let t = 1000;
    return { now: () => t, tick: (ms: number) => (t += ms) };
  };

  it('treats the accelerator that follows a forwarded Undo or Redo key as that key press, once', () => {
    const c = clock();
    const keys = new HistoryKeyPairing(c.now);
    keys.keyDown(true);
    c.tick(5);
    expect(keys.menuActivated(true)).toBe(true);
    // The same press never pairs twice.
    expect(keys.menuActivated(true)).toBe(false);
  });

  it('runs a menu click, and a menu worked with the keyboard, as a menu command', () => {
    const c = clock();
    // Return in the open menu is reported as an accelerator, but no Undo key was pressed for it.
    expect(new HistoryKeyPairing(c.now).menuActivated(true)).toBe(false);
    const keys = new HistoryKeyPairing(c.now);
    keys.keyDown(false);
    expect(keys.menuActivated(true)).toBe(false);
    // A mouse click right after an Undo key press is still a click.
    keys.keyDown(true);
    expect(keys.menuActivated(false)).toBe(false);
  });

  it('does not pair with an Undo key the page handled earlier', () => {
    const c = clock();
    const keys = new HistoryKeyPairing(c.now);
    keys.keyDown(true);
    c.tick(5000);
    expect(keys.menuActivated(true)).toBe(false);
    keys.keyDown(true);
    keys.keyDown(false);
    expect(keys.menuActivated(true)).toBe(false);
  });
});
