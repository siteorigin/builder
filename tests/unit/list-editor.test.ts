import { describe, expect, it } from 'vitest';
import { addLimitNote, countLabel, countText, moveAnnouncement, moveFocusTarget, removeLimitNote } from '../../src/renderer/src/lib/list-editor';
import { contact } from '../../src/catalogue/foundation/conversion';

describe('list capacity', () => {
  it('shows the maximum next to the count only when the list has one', () => {
    expect(countText(4, 8)).toBe('4 / 8');
    expect(countText(4)).toBe('4');
    expect(countLabel(4, 'Contact method', 8)).toBe('4 of 8 items');
    expect(countLabel(1, 'Card')).toBe('1 card');
    expect(countLabel(1, 'Card', 1)).toBe('1 of 1 card');
    expect(countLabel(3, 'Card')).toBe('3 items');
  });

  it('explains Add only once the maximum is reached', () => {
    expect(addLimitNote(7, 'Contact method', 8)).toBeNull();
    expect(addLimitNote(9, 'Contact method', 8)).not.toBeNull();
    expect(addLimitNote(8, 'Contact method', 8)).toContain('at most 8 items');
    expect(addLimitNote(200, 'Card')).toBeNull();
  });

  it('explains Remove only once the minimum is reached', () => {
    expect(removeLimitNote(2, 'Card', 1)).toBeNull();
    expect(removeLimitNote(0, 'Card', 1)).not.toBeNull();
    expect(removeLimitNote(1, 'Card', 1)).toContain('at least 1 card');
    expect(removeLimitNote(0, 'Card')).toBeNull();
  });

  it('gives one reason for a fixed-size list', () => {
    expect(addLimitNote(2, 'Card', 2, 2)).toBe(removeLimitNote(2, 'Card', 2, 2));
    expect(addLimitNote(2, 'Card', 2, 2)).toBe("This list is fixed at 2 items, so items can't be added or removed.");
    expect(addLimitNote(1, 'Card', 3, 1)).toBeNull();
  });

  it('reads the Contact details limit from its schema', () => {
    const list = contact.properties.items;
    expect(list.type === 'list' && list.max).toBe(8);
    if (list.type !== 'list') return;
    expect(countText(8, list.max)).toBe('8 / 8');
    expect(addLimitNote(8, list.itemLabel, list.max)).toContain('at most 8 items');
  });
});

describe('focus after a move', () => {
  it('stays on the button while it still works', () => {
    expect(moveFocusTarget('up', 2, 5)).toBe('up');
    expect(moveFocusTarget('down', 2, 5)).toBe('down');
    expect(moveFocusTarget('up', 1, 5)).toBe('up');
    expect(moveFocusTarget('down', 3, 5)).toBe('down');
  });
  it('goes to the disclosure at either boundary, in either direction', () => {
    expect(moveFocusTarget('up', 0, 5)).toBe('head');
    expect(moveFocusTarget('down', 4, 5)).toBe('head');
    expect(moveFocusTarget('up', 0, 2)).toBe('head');
    expect(moveFocusTarget('down', 1, 2)).toBe('head');
  });
  it('announces the new position', () => {
    expect(moveAnnouncement('Materials & colour', 0, 4)).toBe('Materials & colour moved to position 1 of 4');
    expect(moveAnnouncement('Planning', 2, 4)).toBe('Planning moved to position 3 of 4');
  });
});
