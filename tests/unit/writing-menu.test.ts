import { describe, expect, it, vi } from 'vitest';
import type { EditFlags } from 'electron';
import { writingMenuTemplate, type WritingActions, type WritingTarget } from '../../src/main/writing-menu';

const flags = (over: Partial<EditFlags> = {}): EditFlags => ({ canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false, ...over });
const target = (over: Partial<WritingTarget> = {}): WritingTarget => ({ isEditable: true, misspelledWord: '', dictionarySuggestions: [], editFlags: flags(), ...over });
const actions = () => ({ replaceMisspelling: vi.fn<(s: string) => void>(), cut: vi.fn<() => void>(), copy: vi.fn<() => void>(), paste: vi.fn<() => void>(), selectAll: vi.fn<() => void>() }) satisfies WritingActions;
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

  it('gives a word spelled correctly only the editing actions', () => {
    expect(labels(writingMenuTemplate(target(), actions()))).toEqual(['Cut', 'Copy', 'Paste', '—', 'Select All']);
  });

  it.each([
    { canCut: true, canCopy: false, canPaste: true, canSelectAll: false },
    { canCut: false, canCopy: true, canPaste: false, canSelectAll: true }
  ])('enables each editing action only when the page can do it, and runs it on the page (%o)', (can) => {
    const a = actions();
    const t = writingMenuTemplate(target({ editFlags: flags(can) }), a);
    const each = [
      ['Cut', can.canCut, a.cut],
      ['Copy', can.canCopy, a.copy],
      ['Paste', can.canPaste, a.paste],
      ['Select All', can.canSelectAll, a.selectAll]
    ] as const;
    for (const [label, enabled] of each) expect(item(t, label).enabled, label).toBe(enabled);
    for (const [label, enabled] of each) if (enabled) choose(t, label);
    for (const [label, enabled, fn] of each) expect(fn, label).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(a.replaceMisspelling).not.toHaveBeenCalled();
  });

  it('shows nothing for text that does not take typing', () => {
    expect(writingMenuTemplate(target({ isEditable: false, misspelledWord: 'recieve', dictionarySuggestions: ['receive'] }), actions())).toBeNull();
  });
});
