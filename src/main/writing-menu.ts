import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

/** What a right-click reports about the text under it. */
export type WritingTarget = Pick<ContextMenuParams, 'isEditable' | 'misspelledWord' | 'dictionarySuggestions' | 'editFlags'>;

/** The edits the menu can make, on the page the right-click came from. */
export interface WritingActions {
  replaceMisspelling(suggestion: string): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
}

/**
 * The writing menu for a right-click in text that takes typing (an inspector field, a dialog's field, site copy
 * being edited on the canvas, a visitor's form field in Preview): the spelling suggestions for a misspelled word,
 * then the ordinary editing actions. Anything else gets no menu (null). Undo and Redo stay in the Edit menu,
 * which routes them to whatever has focus.
 */
export function writingMenuTemplate(target: WritingTarget, actions: WritingActions): MenuItemConstructorOptions[] | null {
  if (!target.isEditable) return null;
  const items: MenuItemConstructorOptions[] = [];
  // A misspelled word is reported only where spelling is checked (Electron's spellcheckEnabled flag can read
  // false even then, so it is not consulted).
  if (target.misspelledWord) {
    const suggestions = target.dictionarySuggestions ?? [];
    if (suggestions.length) for (const s of suggestions) items.push({ label: s, click: () => actions.replaceMisspelling(s) });
    else items.push({ label: 'No spelling suggestions', enabled: false });
    items.push({ type: 'separator' });
  }
  const f = target.editFlags;
  items.push(
    { label: 'Cut', enabled: !!f?.canCut, click: () => actions.cut() },
    { label: 'Copy', enabled: !!f?.canCopy, click: () => actions.copy() },
    { label: 'Paste', enabled: !!f?.canPaste, click: () => actions.paste() },
    { type: 'separator' },
    { label: 'Select All', enabled: !!f?.canSelectAll, click: () => actions.selectAll() }
  );
  return items;
}
