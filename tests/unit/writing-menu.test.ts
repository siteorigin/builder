import { describe, expect, it, vi } from 'vitest';
import type { EditFlags } from 'electron';
import { writingMenuTemplate, type WritingActions, type WritingTarget } from '../../src/main/writing-menu';

const flags = (over: Partial<EditFlags> = {}): EditFlags => ({ canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false, ...over });
const target = (over: Partial<WritingTarget> = {}): WritingTarget => ({ isEditable: true, misspelledWord: '', dictionarySuggestions: [], spellcheckEnabled: true, editFlags: flags(), ...over });
const actions = (): WritingActions & { [K in keyof WritingActions]: ReturnType<typeof vi.fn> } => ({ replaceMisspelling: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn() });
const labels = (t: ReturnType<typeof writingMenuTemplate>) => t?.map((i) => (i.type === 'separator' ? '—' : i.label));
const item = (t: ReturnType<typeof writingMenuTemplate>, label: string) => {
  const found = t?.find((i) => i.label === label);
  if (!found) throw new Error(`No ${label} item`);
  return found;
};
const choose = (t: ReturnType<typeof writingMenuTemplate>, label: string) => (item(t, label).click as () => void)();

describe('writing menu', () => {
  it('offers the suggestions for a misspelled word, in order, before the editing actions', () => {
    const a = actions();
    const t = writingMenuTemplate(target({ misspelledWord: 'recieve', dictionarySuggestions: ['receive', 'relieve'] }), a);
    expect(labels(t)).toEqual(['receive', 'relieve', '—', 'Cut', 'Copy', 'Paste', '—', 'Select All']);
    choose(t, 'relieve');
    expect(a.replaceMisspelling).toHaveBeenCalledTimes(1);
    expect(a.replaceMisspelling).toHaveBeenCalledWith('relieve');
  });

  it('says so when a misspelled word has no suggestions', () => {
    const t = writingMenuTemplate(target({ misspelledWord: 'xrecieve' }), actions());
    expect(labels(t)).toEqual(['No spelling suggestions', '—', 'Cut', 'Copy', 'Paste', '—', 'Select All']);
    expect(item(t, 'No spelling suggestions').enabled).toBe(false);
  });

  it('gives a word spelled correctly, or text with spelling checks off, only the editing actions', () => {
    expect(labels(writingMenuTemplate(target(), actions()))).toEqual(['Cut', 'Copy', 'Paste', '—', 'Select All']);
    expect(labels(writingMenuTemplate(target({ spellcheckEnabled: false, misspelledWord: 'recieve', dictionarySuggestions: ['receive'] }), actions()))).toEqual(['Cut', 'Copy', 'Paste', '—', 'Select All']);
  });

  it('enables each editing action only when the page can do it, and runs it on the page', () => {
    const a = actions();
    const t = writingMenuTemplate(target({ editFlags: flags({ canCut: false, canCopy: false, canPaste: true, canSelectAll: true }) }), a);
    expect(item(t, 'Cut').enabled).toBe(false);
    expect(item(t, 'Copy').enabled).toBe(false);
    expect(item(t, 'Paste').enabled).toBe(true);
    expect(item(t, 'Select All').enabled).toBe(true);
    choose(t, 'Paste');
    choose(t, 'Select All');
    expect(a.paste).toHaveBeenCalledTimes(1);
    expect(a.selectAll).toHaveBeenCalledTimes(1);
    expect(a.cut).not.toHaveBeenCalled();
  });

  it('shows nothing for text that does not take typing', () => {
    expect(writingMenuTemplate(target({ isEditable: false, misspelledWord: 'recieve', dictionarySuggestions: ['receive'] }), actions())).toBeNull();
  });
});
