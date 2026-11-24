import { describe, expect, it } from 'vitest';
import { blocksFromDom, richDom, type RichDomNode } from '../../src/renderer/src/lib/richtext';
import { dropAt, moveIndex, rowsOf } from '../../src/renderer/src/lib/reorder';

const el = (tag: string, ...children: RichDomNode[]): RichDomNode => ({ tag, children });

describe('rich text from the canvas', () => {
  const pages = { pg_about: { id: 'pg_about', route: '/about/' } };
  const blocks = (dom: RichDomNode[]) => blocksFromDom(dom, pages).blocks;
  const p = (...spans: Array<string | Record<string, unknown>>) => ({ type: 'p', spans: spans.map((x) => (typeof x === 'string' ? { text: x } : x)) });

  it('keeps bold and italic as marks on spans', () => {
    const dom = ['\n', el('p', 'Every room starts with ', el('strong', 'every decision'), ' made ', el('em', 'together'), '.'), ' ', el('p', 'Second.')];
    expect(blocks(dom)).toEqual([p('Every room starts with ', { text: 'every decision', strong: true }, ' made ', { text: 'together', em: true }, '.'), p('Second.')]);
  });

  it('reads the browser’s own bold and italic commands', () => {
    expect(blocks([el('p', el('b', 'Bold'), ' and ', el('i', 'italic'))])).toEqual([p({ text: 'Bold', strong: true }, ' and ', { text: 'italic', em: true })]);
    // Un-bolding part of a bold run leaves a span with font-weight: normal.
    expect(blocks([el('p', el('strong', 'one ', { tag: 'span', b: false, children: ['two'] }, ' three'))])).toEqual([p({ text: 'one', strong: true }, ' two ', { text: 'three', strong: true })]);
    expect(blocks([el('p', { tag: 'span', b: true, children: ['styled'] })])).toEqual([p({ text: 'styled', strong: true })]);
  });

  it('splits blocks on block elements, and drops empty ones', () => {
    expect(blocks([el('p', 'One'), el('div', 'Two'), el('p', '  '), el('p', el('br')), el('p', el('br'), el('br'))])).toEqual([p('One'), p('Two')]);
    expect(blocks(['Loose text'])).toEqual([p('Loose text')]);
  });

  it('keeps a line break (Shift+Enter) inside its paragraph or list item', () => {
    // A three-line postal address is one paragraph, not three.
    expect(blocks([el('p', 'Harbour Lane Studio', el('br'), '12 Quay Street', el('br'), 'Port Town')])).toEqual([p('Harbour Lane Studio\n12 Quay Street\nPort Town')]);
    expect(blocks([el('ul', el('li', 'One', el('br'), 'more'), el('li', 'Two'))])).toEqual([{ type: 'ul', items: [[{ text: 'One\nmore' }], [{ text: 'Two' }]] }]);
    // Each break the writer sees is kept, at either end too. A <br> that ends a block shows no line of its own (the
    // browser's placeholder after a Shift+Enter at the end, or the one the page adds there), so it is not one.
    expect(blocks([el('p', 'A', el('br'), el('br'), 'B')])).toEqual([p('A\n\nB')]);
    expect(blocks([el('p', 'A', el('br'), el('br'))])).toEqual([p('A\n')]);
    expect(blocks([el('p', 'A', el('br'), el('br'), el('br'))])).toEqual([p('A\n\n')]);
    expect(blocks([el('p', 'A', el('br'), ' ')])).toEqual([p('A')]);
    expect(blocks([el('p', el('br'), 'B')])).toEqual([p('\nB')]);
    expect(blocks([el('ul', el('li', 'Item', el('br'), el('br')))])).toEqual([{ type: 'ul', items: [[{ text: 'Item\n' }]] }]);
    expect(blocks([el('h3', 'A', el('br'), el('br'))])).toEqual([{ type: 'h3', spans: [{ text: 'A\n' }] }]);
    expect(blocks([el('blockquote', 'A', el('br'), el('br'))])).toEqual([{ type: 'blockquote', spans: [{ text: 'A\n' }] }]);
    // A non-breaking space after the break shows a line: the break before it is the writer's.
    expect(blocks([el('p', 'A', el('br'), '\u00a0')])).toEqual([p('A\n')]);
    // Breaks go outside marks, as spaces do, and the spaces beside a break go.
    expect(blocks([el('p', el('strong', 'Bold ', el('br')), ' next')])).toEqual([p({ text: 'Bold', strong: true }, '\nnext')]);
    expect(blocks([el('p', el('strong', 'one', el('br'), 'two'))])).toEqual([p({ text: 'one\ntwo', strong: true })]);
    expect(blocks([el('p', { tag: 'a', href: '/about/', children: ['a', el('br'), 'b'] })])).toEqual([p({ text: 'a\nb', link: { type: 'page', target: 'pg_about' } })]);
  });

  it('reads a line feed in the text itself as a space, as the page shows it', () => {
    // Pasted or source markup is wrapped with line feeds that a page collapses; only <br> breaks a line.
    expect(blocks(['\n', el('p', 'One\n  Two\r\nThree\rFour\fFive'), '\n'])).toEqual([p('One Two Three Four Five')]);
  });

  it('moves spaces outside marks, merges neighbours and collapses whitespace', () => {
    expect(blocks([el('p', 'A', el('strong', ' bold '), 'word')])).toEqual([p('A ', { text: 'bold', strong: true }, ' word')]);
    expect(blocks([el('p', el('strong', 'a'), el('b', 'b'))])).toEqual([p({ text: 'ab', strong: true })]);
    expect(blocks([el('p', 'non breaking   spaces')])).toEqual([p('non breaking spaces')]);
    expect(blocks([el('p', el('strong', '   '))])).toEqual([]);
  });

  it('holds bold and italic together, and treats an asterisk as a character', () => {
    expect(blocks([el('p', el('strong', el('em', 'both')))])).toEqual([p({ text: 'both', strong: true, em: true })]);
    expect(blocks([el('p', el('em', '2 * 3'), ' = 6')])).toEqual([p({ text: '2 * 3', em: true }, ' = 6')]);
    expect(blocks([el('p', '2 * 3 ', el('strong', 'today'))])).toEqual([p('2 * 3 ', { text: 'today', strong: true })]);
    expect(blocks([el('p', '**not bold**')])).toEqual([p('**not bold**')]);
  });

  it('keeps every kind of block', () => {
    const dom: RichDomNode[] = [
      el('h3', 'Heading'),
      el('h4', 'Smaller'),
      el('blockquote', 'Quote'),
      el('ul', el('li', 'A'), el('li', el('strong', 'B'))),
      el('p', 'Between'),
      el('ol', el('li', 'One')),
      el('p', 'Then'),
      { tag: 'ul', check: true, children: [el('li', 'Done')] }
    ];
    expect(blocks(dom)).toEqual([
      { type: 'h3', spans: [{ text: 'Heading' }] },
      { type: 'h4', spans: [{ text: 'Smaller' }] },
      { type: 'blockquote', spans: [{ text: 'Quote' }] },
      { type: 'ul', items: [[{ text: 'A' }], [{ text: 'B', strong: true }]] },
      p('Between'),
      { type: 'ol', items: [[{ text: 'One' }]] },
      p('Then'),
      { type: 'check', items: [[{ text: 'Done' }]] }
    ]);
  });

  it('flattens a nested list and joins neighbouring lists of one kind', () => {
    expect(blocks([el('ul', el('li', 'A', el('ul', el('li', 'B'))), el('li', 'C'))])).toEqual([{ type: 'ul', items: [[{ text: 'A' }], [{ text: 'B' }], [{ text: 'C' }]] }]);
    expect(blocks([el('ul', el('li', 'A')), el('ul', el('li', 'B'))])).toEqual([{ type: 'ul', items: [[{ text: 'A' }], [{ text: 'B' }]] }]);
  });

  it('reads links back by destination, so a page link keeps its ID', () => {
    const a = (href: string, text: string, newTab?: boolean): RichDomNode => ({ tag: 'a', href, ...(newTab ? { newTab } : {}), children: [text] });
    expect(blocksFromDom([el('p', a('/about/', 'About'), ' ', a('/about/#team', 'Team'), ' ', a('https://example.com/', 'Web', true))], pages)).toEqual({
      droppedLinks: 0,
      blocks: [p({ text: 'About', link: { type: 'page', target: 'pg_about' } }, ' ', { text: 'Team', link: { type: 'page', target: 'pg_about', anchor: 'team' } }, ' ', { text: 'Web', link: { type: 'url', target: 'https://example.com/', newTab: true } })]
    });
  });

  it('keeps the words of a link it cannot store, and counts it', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', '/no-such-page/', '//evil.test/x', 'file:///etc/passwd']) {
      expect(blocksFromDom([el('p', { tag: 'a', href, children: ['Words'] })], pages), href).toEqual({ droppedLinks: 1, blocks: [p('Words')] });
    }
  });

  it('validates the copy the preview sends', () => {
    expect(richDom([el('p', 'ok')])).not.toBeNull();
    expect(richDom('<p>')).toBeNull();
    expect(richDom([{ tag: 'p' }])).toBeNull();
    expect(richDom([{ tag: 'p', b: 'yes', children: [] }])).toBeNull();
    expect(richDom([{ tag: 'a', href: 1, children: [] }])).toBeNull();
    expect(richDom([{ tag: 'a', href: 'x'.repeat(3000), children: [] }])).toBeNull();
    expect(richDom([{ tag: 'ul', check: 'yes', children: [] }])).toBeNull();
    expect(richDom([{ tag: 'a', href: '/', newTab: 1, children: [] }])).toBeNull();
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
