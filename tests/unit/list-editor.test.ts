import { describe, expect, it } from 'vitest';
import { placedItemId } from '../../src/engine/install';
import type { ProjectState } from '../../src/shared/types';
import { addLimitNote, countLabel, countText, listEditLabel, moveAnnouncement, moveFocusTarget, removeLimitNote, type ListEdit } from '../../src/renderer/src/lib/list-editor';
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

describe('History and Undo wording for a list edit', () => {
  const owner = { kind: 'page', id: 'home' } as const;
  const cards = [
    { id: 'i1', title: 'Planning & layout', text: 'a' },
    { id: 'i2', title: 'Materials & colour', text: 'b' },
    { id: 'i3', title: '', text: 'c' }
  ];
  const schema = {
    type: 'list',
    label: 'Cards',
    itemLabel: 'Card',
    titleField: 'title',
    fields: { title: { type: 'text', label: 'Title' }, text: { type: 'text', label: 'Text' } },
    default: []
  };
  const state = {
    pages: { home: { id: 'home', title: 'Home', nodes: { n1: { kind: 'instance', id: 'n1', definitionId: 'services', props: { items: cards } } } } },
    components: { services: { id: 'services', name: 'Services', properties: { items: schema } } },
    assets: { assets: {} }
  } as unknown as ProjectState;
  const label = (op: ListEdit, everywhere = false) => listEditLabel(state, owner, 'n1', 'items', op, 'Edit Cards', everywhere);

  it('names the row, the list, the section and the page for each kind of edit', () => {
    expect(label({ kind: 'insert' })).toBe('Add card 4 to Cards (Services on Home)');
    expect(label({ kind: 'remove', itemId: 'i1' })).toBe('Remove “Planning & layout” from Cards (Services on Home)');
    expect(label({ kind: 'move', itemId: 'i2', index: 0 })).toBe('Move “Materials & colour” from 2 to 1 in Cards (Services on Home)');
    expect(label({ kind: 'field', itemId: 'i1', field: 'text' })).toBe('Edit Text of “Planning & layout” in Cards (Services on Home)');
  });

  it('tells an add from a remove, a move and a field edit made close together', () => {
    const labels = [label({ kind: 'insert' }), label({ kind: 'move', itemId: 'i2', index: 0 }), label({ kind: 'insert' }), label({ kind: 'remove', itemId: 'i3' })];
    expect(new Set(labels).size).toBe(labels.length - 1);
    expect(labels).not.toContain('Edit Cards');
  });

  it('names a row with no title by its place, and a long title shortened', () => {
    expect(label({ kind: 'remove', itemId: 'i3' })).toContain('“Card 3”');
    cards[0].title = 'A very long title that goes on and on and on';
    expect(label({ kind: 'remove', itemId: 'i1' })).toContain('“A very long title that goes on…”');
    cards[0].title = 'Planning & layout';
  });

  it('names a design, not a page, for an edit made everywhere', () => {
    expect(label({ kind: 'remove', itemId: 'i1' }, true)).toBe('Remove “Planning & layout” from Cards everywhere');
  });

  it('names a default row an edit still addresses by its default id', () => {
    const copy = placedItemId(owner, 'n1', 'i1');
    cards[0].id = copy;
    expect(label({ kind: 'remove', itemId: 'i1' })).toContain('“Planning & layout”');
    cards[0].id = 'i1';
  });

  it('keeps the generic label when the row is gone or the list is not there', () => {
    expect(label({ kind: 'remove', itemId: 'gone' })).toBe('Edit Cards');
    expect(listEditLabel(state, owner, 'missing', 'items', { kind: 'insert' }, 'Edit Cards')).toBe('Edit Cards');
  });
});
