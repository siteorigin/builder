import { describe, expect, it } from 'vitest';
import { paragraphsFromDom, richDom, sameParagraphs, type RichDomNode } from '../../src/renderer/src/lib/richtext';
import { dropAt, moveIndex, rowsOf } from '../../src/renderer/src/lib/reorder';

const el = (tag: string, ...children: RichDomNode[]): RichDomNode => ({ tag, children });

describe('rich text from the canvas', () => {
  it('keeps bold and italic as ** and * marks', () => {
    // What SoRichText renders for ["Every room starts with **every decision** made *together*.", "Second."]
    const dom = ['\n', el('p', 'Every room starts with ', el('strong', 'every decision'), ' made ', el('em', 'together'), '.'), ' ', el('p', 'Second.')];
    expect(paragraphsFromDom(dom)).toEqual(['Every room starts with **every decision** made *together*.', 'Second.']);
  });

  it('reads the browser’s own bold and italic commands', () => {
    expect(paragraphsFromDom([el('p', el('b', 'Bold'), ' and ', el('i', 'italic'))])).toEqual(['**Bold** and *italic*']);
    // Un-bolding part of a bold run leaves a span with font-weight: normal.
    expect(paragraphsFromDom([el('p', el('strong', 'one ', { tag: 'span', b: false, children: ['two'] }, ' three'))])).toEqual(['**one** two **three**']);
    expect(paragraphsFromDom([el('p', { tag: 'span', b: true, children: ['styled'] })])).toEqual(['**styled**']);
  });

  it('splits paragraphs on blocks and line breaks, and drops empty ones', () => {
    expect(paragraphsFromDom([el('p', 'One', el('br'), 'Two'), el('div', 'Three'), el('p', '  '), el('p', el('br'))])).toEqual(['One', 'Two', 'Three']);
    expect(paragraphsFromDom(['Loose text'])).toEqual(['Loose text']);
    expect(paragraphsFromDom([el('ul', el('li', 'A'), el('li', el('strong', 'B')))])).toEqual(['A', '**B**']);
  });

  it('moves spaces outside marks, merges neighbours and collapses whitespace', () => {
    expect(paragraphsFromDom([el('p', 'A', el('strong', ' bold '), 'word')])).toEqual(['A **bold** word']);
    expect(paragraphsFromDom([el('p', el('strong', 'a'), el('b', 'b'))])).toEqual(['**ab**']);
    expect(paragraphsFromDom([el('p', 'non breaking   spaces')])).toEqual(['non breaking spaces']);
    expect(paragraphsFromDom([el('p', el('strong', '   '))])).toEqual([]);
  });

  it('never writes marks it cannot express', () => {
    // Nested marks keep the strongest; a literal asterisk anywhere in the paragraph could pair with a mark, so
    // that paragraph keeps its words without marks.
    expect(paragraphsFromDom([el('p', el('strong', el('em', 'both')))])).toEqual(['**both**']);
    expect(paragraphsFromDom([el('p', el('em', '2 * 3'), ' = 6')])).toEqual(['2 * 3 = 6']);
    expect(paragraphsFromDom([el('p', '2 * 3 ', el('strong', 'today'))])).toEqual(['2 * 3 today']);
    expect(paragraphsFromDom([el('p', 'Plain'), el('p', 'a*b ', el('em', 'c'))])).toEqual(['Plain', 'a*b c']);
  });

  it('renders back to the same marks (the RichText component’s own reading of the format)', () => {
    // The generated RichText component's segment regex, applied to what the serializer writes.
    const segments = (text: string) => [...text.matchAll(/(\*\*[^*]+\*\*|\*[^*]+\*)/g)].map((m) => m[0]);
    const out = paragraphsFromDom([el('p', 'A ', el('strong', 'bold'), ' and ', el('em', 'em'), ' and ', el('b', 'more'))]);
    expect(segments(out[0])).toEqual(['**bold**', '*em*', '**more**']);
  });

  it('round-trips without change', () => {
    const value = ['Plain', 'With **bold** and *em*'];
    expect(sameParagraphs(value, paragraphsFromDom([el('p', 'Plain'), el('p', 'With ', el('strong', 'bold'), ' and ', el('em', 'em'))]))).toBe(true);
    expect(sameParagraphs('Plain', ['Plain'])).toBe(true);
    expect(sameParagraphs(['a'], ['a', 'b'])).toBe(false);
  });

  it('validates the copy the preview sends', () => {
    expect(richDom([el('p', 'ok')])).not.toBeNull();
    expect(richDom('<p>')).toBeNull();
    expect(richDom([{ tag: 'p' }])).toBeNull();
    expect(richDom([{ tag: 'p', b: 'yes', children: [] }])).toBeNull();
    let deep: RichDomNode = 'x';
    for (let i = 0; i < 30; i++) deep = el('span', deep);
    expect(richDom([deep])).toBeNull();
    expect(richDom(new Array(6000).fill('x'))).toBeNull();
    // Holes are not nodes.
    expect(richDom(new Array(2))).toBeNull();
    expect(richDom([{ tag: 'p', children: new Array(1) }])).toBeNull();
  });
});

describe('drag to reorder', () => {
  const box = (x: number, y: number, width = 100, height = 50) => ({ x, y, width, height });
  const column = [box(0, 0), box(0, 60), box(0, 120)];
  const row = [box(0, 0), box(110, 0), box(220, 0)];
  const grid = [box(0, 0), box(110, 0), box(220, 0), box(0, 60), box(110, 60)];

  it('groups boxes into visual rows', () => {
    expect(rowsOf(column)).toEqual([[0], [1], [2]]);
    expect(rowsOf(row)).toEqual([[0, 1, 2]]);
    expect(rowsOf(grid)).toEqual([[0, 1, 2], [3, 4]]);
    // Side by side but of different heights (top aligned) is still one row.
    expect(rowsOf([box(0, 0, 100, 20), box(110, 0, 100, 150)])).toEqual([[0, 1]]);
    expect(dropAt([box(0, 0, 100, 20), box(110, 0, 100, 150)], 200, 100).to).toBe(2);
  });

  it('reads a column by height and a row by width', () => {
    expect(dropAt(column, 50, 10).to).toBe(0);
    expect(dropAt(column, 50, 40).to).toBe(1);
    expect(dropAt(column, 50, 500).to).toBe(3);
    expect(dropAt(row, 10, 25).to).toBe(0);
    expect(dropAt(row, 170, 25).to).toBe(2);
    expect(dropAt(row, 400, 25).to).toBe(3);
  });

  it('reads a grid row by row', () => {
    expect(dropAt(grid, 200, 25).to).toBe(2);
    expect(dropAt(grid, 10, 80).to).toBe(3);
    expect(dropAt(grid, 170, 80).to).toBe(5);
    expect(dropAt(grid, 10, 400).to).toBe(5);
    // Before an item in a row: a vertical bar on its left edge; at a column's end: under the last item.
    expect(dropAt(grid, 10, 80).line).toEqual({ x: -2, y: 60, width: 3, height: 50 });
    expect(dropAt(column, 50, 500).line).toEqual({ x: 0, y: 169, width: 100, height: 3 });
  });

  it('maps a drop among visible siblings onto the full list', () => {
    // Full list [A, H, B, C] with H hidden: visible are 0, 2, 3.
    expect(moveIndex([0, 2, 3], 0, 0)).toBeNull();
    expect(moveIndex([0, 2, 3], 0, 1)).toBeNull();
    expect(moveIndex([0, 2, 3], 0, 2)).toBe(2); // A after B: [H, B, A, C]
    expect(moveIndex([0, 2, 3], 0, 3)).toBe(3); // A last
    expect(moveIndex([0, 2, 3], 3, 0)).toBe(0); // C first
    expect(moveIndex([0, 2, 3], 3, 1)).toBe(2); // C before B: [A, H, C, B]
    expect(moveIndex([0, 2, 3], 1, 0)).toBeNull(); // a hidden item is never the one dragged
  });
});
