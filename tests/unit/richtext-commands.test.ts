import { describe, expect, it } from 'vitest';
import { addItem, applyTextEdit, linkAt, listState, moveItem, removeItem, removeLink, setLink, toggleList, typedLink, type TextAt, type TextEdit } from '../../src/renderer/src/lib/richtext-commands';
import { linkFromTarget, parseRichText, type RichPages } from '../../src/shared/richtext';

const pages: RichPages = { pg_about: { id: 'pg_about', route: '/about/' } };

/** Text with the selection marked: `[` and `]` around it, or `|` for a caret. */
function at(marked: string, plainAs?: TextAt['plainAs']): TextAt {
  const caret = marked.indexOf('|');
  if (caret >= 0) return { text: marked.replace('|', ''), start: caret, end: caret, plainAs };
  const start = marked.indexOf('«');
  const end = marked.indexOf('»') - 1;
  return { text: marked.replace('«', '').replace('»', ''), start, end, plainAs };
}
/** The text after the edit, with its selection marked the same way. */
function after(a: TextAt, e: TextEdit | string | null): string {
  if (!e || typeof e === 'string') throw new Error(`no edit: ${e}`);
  const t = applyTextEdit(a.text, e);
  return e.start === e.end ? t.slice(0, e.start) + '|' + t.slice(e.start) : t.slice(0, e.start) + '«' + t.slice(e.start, e.end) + '»' + t.slice(e.end);
}
const blocks = (text: string, plainAs?: TextAt['plainAs']) => parseRichText(text, { markdown: true, link: (t, n) => linkFromTarget(t, pages, n), plainAs });

describe('Inspector list commands', () => {
  it('turns the selected paragraphs into a bulleted list, keeping their marks and links', () => {
    const a = at('«One **bold**\n\nTwo [link](/about/)»\n\nAfter');
    const out = after(a, toggleList(a, 'ul'));
    // Items are one line each, and the list stays apart from the paragraph after it, as the field saves it.
    expect(out).toBe('- «One **bold**\n- Two [link](/about/)»\n\nAfter');
    expect(blocks(out.replace(/[«»]/g, ''))).toEqual([
      { type: 'ul', items: [[{ text: 'One ' }, { text: 'bold', strong: true }], [{ text: 'Two ' }, { text: 'link', link: { type: 'page', target: 'pg_about' } }]] },
      { type: 'p', spans: [{ text: 'After' }] }
    ]);
  });

  it('switches a whole list to the other kind, and turns items of its own kind back into paragraphs', () => {
    const a = at('Intro\n\n- One\n- T|wo\n- Three\n\nAfter');
    expect(after(a, toggleList(a, 'ol'))).toBe('Intro\n\n1. One\n2. T|wo\n3. Three\n\nAfter');
    const b = at('«- One\n- Two»');
    expect(after(b, toggleList(b, 'ol'))).toBe('1. «One\n2. Two»');
    // The numbered list split in two starts again at 1, as the field saves it.
    const c = at('1. One\n2. T|wo\n3. Three');
    expect(after(c, toggleList(c, 'ol'))).toBe('1. One\n\nT|wo\n\n1. Three');
    expect(blocks('1. One\n\nTwo\n\n1. Three')).toEqual([{ type: 'ol', items: [[{ text: 'One' }]] }, { type: 'p', spans: [{ text: 'Two' }] }, { type: 'ol', items: [[{ text: 'Three' }]] }]);
    // A list that joins a numbered list before it is numbered on from it.
    const joins = at('1. A\n- B|');
    expect(after(joins, toggleList(joins, 'ol'))).toBe('1. A\n2. B|');
    // A selection that reaches outside the list makes all of it the one kind.
    const d = at('«Intro\n- One»\n- Two');
    expect(after(d, toggleList(d, 'ol'))).toBe('1. «Intro\n2. One»\n\n- Two');
    // A selection that ends at the very start of a line leaves that line as it is.
    const e = at('«One\n»Two');
    expect(after(e, toggleList(e, 'ul'))).toBe('- «One\n\n»Two');
  });

  it('keeps words that look like a marker literal when they leave a list', () => {
    const a = at('- |### not a heading');
    const e = toggleList(a, 'ul')!;
    const out = applyTextEdit(a.text, e);
    expect(out).toBe('\\### not a heading');
    expect(e.start).toBe(1);
    expect(blocks(out)).toEqual([{ type: 'p', spans: [{ text: '### not a heading' }] }]);
  });

  it('marks a paragraph as one where plain lines are list items', () => {
    const a = at('- One\n- T|wo', 'ul');
    const out = applyTextEdit(a.text, toggleList(a, 'ul')!);
    expect(out).toBe('- One\n\n\\|Two');
    expect(blocks(out, 'ul')).toEqual([{ type: 'ul', items: [[{ text: 'One' }]] }, { type: 'p', spans: [{ text: 'Two' }] }]);
    // Plain lines there are already items.
    expect(listState(at('Plain |item', 'ul'))).toMatchObject({ kind: 'ul', item: true });
  });

  it('starts a list on an empty line with a first item to type over, which is saved as a list', () => {
    const a = at('Intro\n|');
    const out = after(a, toggleList(a, 'ol'));
    expect(out).toBe('Intro\n\n1. «New item»');
    expect(blocks(out.replace(/[«»]/g, ''))).toEqual([{ type: 'p', spans: [{ text: 'Intro' }] }, { type: 'ol', items: [[{ text: 'New item' }]] }]);
    const empty = at('|');
    expect(after(empty, toggleList(empty, 'ul'))).toBe('- «New item»');
  });

  it('moves and lists a block that goes on after a line break as one', () => {
    // A line ending in a backslash goes on in the next line: an item with an address in it.
    const a = at('- Studio\\\n12 Harbour La|ne\n- Shop');
    expect(listState(a)).toEqual({ kind: 'ul', item: true, up: false, down: true });
    expect(after(a, moveItem(a, 1))).toBe('- Shop\n- Studio\\\n12 Harbour La|ne');
    const p = at('Studio\\\n12 Harbour La|ne');
    const out = applyTextEdit(p.text, toggleList(p, 'ol')!);
    expect(out).toBe('1. Studio\\\n12 Harbour Lane');
    expect(blocks(out)).toEqual([{ type: 'ol', items: [[{ text: 'Studio\n12 Harbour Lane' }]] }]);
  });

  it('reads items with a blank line between them as one list, as the field saves them', () => {
    const a = at('- One|\n\n- Two');
    expect(listState(a)).toEqual({ kind: 'ul', item: true, up: false, down: true });
    expect(after(a, moveItem(a, 1))).toBe('- Two\n- One|');
  });

  it('adds an item after the current one with its words selected, numbering the list again', () => {
    const a = at('1. One|\n2. Two\n\nAfter');
    expect(after(a, addItem(a))).toBe('1. One\n2. «New item»\n3. Two\n\nAfter');
    const b = at('- [x] Done|');
    expect(after(b, addItem(b))).toBe('- [x] Done\n- [x] «New item»');
    expect(addItem(at('Not a list|'))).toBeNull();
  });

  it('removes the current item, leaving the caret in the one before or the one after', () => {
    const a = at('1. One\n2. Tw|o\n3. Three');
    expect(after(a, removeItem(a))).toBe('1. One|\n2. Three');
    const b = at('- O|ne\n- Two');
    expect(after(b, removeItem(b))).toBe('- |Two');
    const only = at('Intro\n\n- O|nly\n\nOutro');
    expect(after(only, removeItem(only))).toBe('Intro\n|\n\nOutro');
  });

  it('keeps the caret in the words of an item whose number grows a digit', () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. Item ${i + 1}`);
    const a = at(items.join('\n').replace('9. Item 9', '9. It|em 9'));
    expect(after(a, moveItem(a, 1)).split('\n').slice(8)).toEqual(['9. Item 10', '10. It|em 9']);
  });

  it('moves an item up and down inside its list, keeping the caret in its words', () => {
    const a = at('Intro\n\n1. One\n2. Tw|o **bold**\n3. Three');
    expect(after(a, moveItem(a, -1))).toBe('Intro\n\n1. Tw|o **bold**\n2. One\n3. Three');
    expect(after(a, moveItem(a, 1))).toBe('Intro\n\n1. One\n2. Three\n3. Tw|o **bold**');
    // Not past the list's ends, and not out of it.
    expect(moveItem(at('Intro\n- F|irst\n- Second'), -1)).toBeNull();
    expect(moveItem(at('- First\n- Se|cond\n\nOutro'), 1)).toBeNull();
    expect(listState(at('- First\n- Se|cond\n- Third'))).toEqual({ kind: 'ul', item: true, up: true, down: true });
    expect(listState(at('- Fi|rst\n- Second'))).toEqual({ kind: 'ul', item: true, up: false, down: true });
  });
});

describe('Inspector link commands', () => {
  it('links the selected words, trimming the spaces around them', () => {
    const a = at('Read «about us »today');
    const e = setLink(a, pages, typedLink('/about/', pages)!);
    expect(after(a, e)).toBe('Read «[about us](/about/)» today');
    expect(blocks('Read [about us](/about/) today')).toEqual([{ type: 'p', spans: [{ text: 'Read ' }, { text: 'about us', link: { type: 'page', target: 'pg_about' } }, { text: ' today' }] }]);
  });

  it('links words inside bold, and refuses a selection that cuts through it', () => {
    const a = at('Meet **«local makers»** here');
    expect(after(a, setLink(a, pages, typedLink('example.com', pages)!))).toBe('Meet **«[local makers](https://example.com)»** here');
    const cut = at('Meet **lo«cal makers** he»re');
    expect(setLink(cut, pages, typedLink('example.com', pages)!)).toMatch(/cutting through bold or italic/);
  });

  it('never takes a list marker into the link', () => {
    const a = at('«- First item»');
    expect(after(a, setLink(a, pages, typedLink('hello@example.com', pages)!))).toBe('- «[First item](mailto:hello@example.com)»');
  });

  it('changes and removes the link the caret is in, keeping its words, marks and new tab', () => {
    const a = at('See [**the** te|am](/about/ "new tab") now');
    expect(linkAt(a, pages)).toMatchObject({ kind: 'link', tokens: [{ target: '/about/', newTab: true }] });
    expect(after(a, setLink(a, pages, typedLink('https://example.com/a_(b)', pages)!))).toBe('See «[**the** team](<https://example.com/a_(b)> "new tab")» now');
    expect(after(a, removeLink(a, pages))).toBe('See «**the** team» now');
  });

  it('reads escaped brackets as text, not as a link', () => {
    const a = at('A \\[no|t\\](/about/) link');
    expect(linkAt(a, pages)).toBeNull();
    expect(removeLink(a, pages)).toBeNull();
    // Only the opening bracket escaped: still no link.
    expect(linkAt(at('A \\[no|t](/about/) link'), pages)).toBeNull();
  });

  it('keeps two links to the same place apart when their words have the same marks', () => {
    const a = at('[First](/about/) [sec|ond](/about/)');
    expect(linkAt(a, pages)).toMatchObject({ kind: 'link', tokens: [{ labelStart: 18 }] });
    expect(after(a, setLink(a, pages, typedLink('example.com', pages)!))).toBe('[First](/about/) «[second](https://example.com)»');
  });

  it('removes a link over touching words with different marks', () => {
    const a = at('[**A**](/about/)[***|B***](/about/)');
    const out = applyTextEdit(a.text, removeLink(a, pages)!);
    expect(out).toBe('**A**\\|***B***');
    expect(blocks(out)).toEqual([{ type: 'p', spans: [{ text: 'A', strong: true }, { text: 'B', strong: true, em: true }] }]);
  });

  it('changes and removes a link over words with different marks as one link', () => {
    // Saved, a link over "local makers" with "local" bold is one link per run of marks.
    const a = at('Meet [**local**](/about/) [mak|ers](/about/) today');
    expect(linkAt(a, pages)).toMatchObject({ kind: 'link', tokens: [{ target: '/about/' }, { target: '/about/' }] });
    expect(after(a, setLink(a, pages, typedLink('example.com', pages)!))).toBe('Meet «[**local**](https://example.com) [makers](https://example.com)» today');
    expect(after(a, removeLink(a, pages))).toBe('Meet «**local** makers» today');
  });

  it('removes a link without changing how its words read', () => {
    // At the start of a paragraph, words that look like a heading marker stay words.
    const heading = at('[### Ne|ws](/about/) today');
    const out = applyTextEdit(heading.text, removeLink(heading, pages)!);
    expect(out).toBe('\\### News today');
    expect(blocks(out)).toEqual([{ type: 'p', spans: [{ text: '### News today' }] }]);
    // Bold words that now touch bold words beside them stay two runs, as the field writes them.
    const touching = at('**A**[**|B**](/about/)');
    const joined = applyTextEdit(touching.text, removeLink(touching, pages)!);
    expect(joined).toBe('**A**\\|**B**');
    expect(blocks(joined)).toEqual([{ type: 'p', spans: [{ text: 'AB', strong: true }] }]);
  });

  it('refuses to edit a link the field does not read as one', () => {
    // The italic closes inside the brackets, so the field reads no link here.
    const a = at('*See [gu|ide*](/about/)');
    expect(setLink(a, pages, typedLink('example.com', pages)!)).toMatch(/can’t be changed/);
    expect(removeLink(a, pages)).toBeNull();
  });

  it('reads a typed phone number as one, and a dotted address as a web address', () => {
    expect(typedLink('+1 555 0134', pages)).toEqual({ type: 'tel', target: '+1 555 0134' });
    expect(typedLink('(02) 9876 5432', pages)).toEqual({ type: 'tel', target: '(02) 9876 5432' });
    expect(typedLink('192.168.1.1', pages)).toEqual({ type: 'url', target: 'https://192.168.1.1' });
    expect(typedLink('212.555.0123', pages)).toEqual({ type: 'tel', target: '212.555.0123' });
  });

  it('reads only destinations a link can go to', () => {
    expect(typedLink('javascript:alert(1)', pages)).toBeNull();
    expect(typedLink('/missing/', pages)).toBeNull();
    expect(typedLink('example.com/x', pages)).toEqual({ type: 'url', target: 'https://example.com/x' });
    expect(typedLink('/about/#team', pages)).toEqual({ type: 'page', target: 'pg_about', anchor: 'team' });
    expect(setLink(at('No selection|'), pages, typedLink('/about/', pages)!)).toMatch(/Select the words/);
  });
});
