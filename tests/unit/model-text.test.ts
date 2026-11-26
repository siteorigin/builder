/** Model text read as written: paragraphs, lists, code, tables, quotes, rules and emphasis, never the raw marks. */
import { describe, expect, it } from 'vitest';
import { textBlocks, textSpans, type ListItem, type TextSpan } from '../../src/renderer/src/lib/model-text';

const item = (text: string, ...blocks: ListItem['blocks']): ListItem => ({ lines: [text], blocks });
const p = (...lines: string[]) => ({ kind: 'p' as const, lines });
const ul = (...items: ListItem[]) => ({ kind: 'ul' as const, items });
const ol = (...items: ListItem[]) => ({ kind: 'ol' as const, start: 1, items });
const code = (...lines: string[]) => ({ kind: 'code' as const, lines });

const strong = (...spans: TextSpan[]): TextSpan => ({ kind: 'strong', spans });
const em = (...spans: TextSpan[]): TextSpan => ({ kind: 'em', spans });
const del = (...spans: TextSpan[]): TextSpan => ({ kind: 'del', spans });
const mono = (text: string): TextSpan => ({ kind: 'code', text });

describe('model text blocks', () => {
  it('keeps a plain reply as one paragraph, single line breaks and all', () => {
    expect(textBlocks('I left the button as it is.')).toEqual([p('I left the button as it is.')]);
    expect(textBlocks('First line\nsecond line')).toEqual([p('First line', 'second line')]);
    expect(textBlocks('\r\n  First line\r\nsecond line  \r\n\r\n')).toEqual([p('First line', 'second line')]);
  });

  it('splits paragraphs at blank lines and reads bulleted and numbered lists as lists', () => {
    const advice = 'It’s in good shape.\n\nTwo things I’d consider:\n\n- Add your **service area**.\n- Swap `team-2.jpg`.\n\n1. First\n2) Second\n\nThat’s all.';
    expect(textBlocks(advice)).toEqual([
      p('It’s in good shape.'),
      p('Two things I’d consider:'),
      ul(item('Add your **service area**.'), item('Swap `team-2.jpg`.')),
      ol(item('First'), item('Second')),
      p('That’s all.')
    ]);
  });

  it('keeps a list whole across blank lines between items, and starts one right after a sentence', () => {
    expect(textBlocks('Consider:\n- One\n\n- Two\n• Three')).toEqual([p('Consider:'), ul(item('One'), item('Two'), item('Three'))]);
    expect(textBlocks('  - One\n  - Two')).toEqual([ul(item('One'), item('Two'))]);
  });

  it('turns a heading it should not have written into a lead line, and leaves nothing empty', () => {
    expect(textBlocks('## Summary\nAll done.\n\n\n')).toEqual([{ kind: 'lead', lines: ['Summary'] }, p('All done.')]);
    expect(textBlocks('   ')).toEqual([]);
    expect(textBlocks('>')).toEqual([]);
  });

  it('reads a fenced block as code, without its backticks or language tag, exactly as indented', () => {
    const answer = 'The card:\n```svelte\n<script>\n  let { title } = $props();\n</script>\n\n# not a heading\n| not | a table |\n- not a list\n```\nThat’s it.';
    expect(textBlocks(answer)).toEqual([
      p('The card:'),
      code('<script>', '  let { title } = $props();', '</script>', '', '# not a heading', '| not | a table |', '- not a list'),
      p('That’s it.')
    ]);
    expect(textBlocks('~~~\na\n~~~')).toEqual([code('a')]);
    // A longer fence holds a shorter one, and a line with words after the backticks does not close it.
    expect(textBlocks('````md\n```js\nx\n```\n````')).toEqual([code('```js', 'x', '```')]);
    expect(textBlocks('```\n``` not the end\n```')).toEqual([code('``` not the end')]);
    // Backticks that open and close on one line are inline code, not a fence.
    expect(textBlocks('```npm run dev``` starts it')).toEqual([p('```npm run dev``` starts it')]);
  });

  it('keeps the tabs and trailing spaces in code, which a reader may copy', () => {
    expect(textBlocks('```\n\tif (a) {\n\t\tb();  \n\t}\n```')).toEqual([code('\tif (a) {', '\t\tb();  ', '\t}')]);
    expect(textBlocks('- One\n\t- Under\n\t  ```\n\t  \tx\n\t  ```')).toEqual([ul(item('One', ul(item('Under', code('\tx')))))]);
  });

  it('reads every part of a fenced answer, as it streams in, without its backticks showing outside code', () => {
    const answer = 'Here:\n\n```svelte\n<h1>Hi</h1>\n```\n\nDone.';
    for (let end = answer.indexOf('```') + 3; end <= answer.length; end++) {
      const outside = textBlocks(answer.slice(0, end)).filter((b) => b.kind !== 'code');
      expect(JSON.stringify(outside)).not.toContain('```');
    }
  });

  it('reads a fence that is still streaming in as code', () => {
    expect(textBlocks('```sve')).toEqual([code()]);
    expect(textBlocks('Here:\n```svelte\n<h1>')).toEqual([p('Here:'), code('<h1>')]);
  });

  it('keeps nested items, and what else is indented under an item, with their parent', () => {
    expect(textBlocks('1. Header\n  - logo\n  - menu\n2. Footer\n   - links\n      1. deeper')).toEqual([
      ol(item('Header', ul(item('logo'), item('menu'))), item('Footer', ul(item('links', ol(item('deeper')))))),
    ]);
    expect(textBlocks('- One\n\n    - Under one\n\n- Two\n  carried on\n\n  A second paragraph.')).toEqual([
      ul(item('One', ul(item('Under one'))), { lines: ['Two', 'carried on'], blocks: [p('A second paragraph.')] })
    ]);
  });

  it('keeps code under its item, however the code is indented, and carries the numbering on', () => {
    expect(textBlocks('1. Install:\n   ```sh\n   npm ci\n     --prefer-offline\n   ```\n2. Run')).toEqual([
      ol(item('Install:', code('npm ci', '  --prefer-offline')), item('Run'))
    ]);
    expect(textBlocks('1. Install:\n   ```sh\nnpm ci\n   ```\n2. Run')).toEqual([ol(item('Install:', code('npm ci')), item('Run'))]);
    expect(textBlocks('- ```js\n  a()\n  ```\n- Two')).toEqual([ul({ lines: [], blocks: [code('a()')] }, item('Two'))]);
    // Code that was not indented stands on its own, and the list after it goes on from its number.
    expect(textBlocks('1. One\n```\nx\n```\n2. Two')).toEqual([ol(item('One')), code('x'), { kind: 'ol', start: 2, items: [item('Two')] }]);
  });

  it('reads a table as its cells, without its dashes', () => {
    expect(textBlocks('Pages:\n| Page | Sections |\n| :--- | ---: |\n| Home | 4 |\n| About \\| us |\n\nDone.')).toEqual([
      p('Pages:'),
      { kind: 'table', head: ['Page', 'Sections'], rows: [['Home', '4'], ['About | us', '']] },
      p('Done.')
    ]);
    expect(textBlocks('Page | Sections\n--- | ---\nHome | 4 | extra')).toEqual([
      { kind: 'table', head: ['Page', 'Sections', ''], rows: [['Home', '4', 'extra']] }
    ]);
    expect(textBlocks('| Type |\n| --- |\n| `string | null` |\n- a | b')).toEqual([
      { kind: 'table', head: ['Type'], rows: [['`string | null`']] },
      ul(item('a | b'))
    ]);
    // A line with a pipe in it is not a table without the line of dashes.
    expect(textBlocks('Use a | b\nor c')).toEqual([p('Use a | b', 'or c')]);
  });

  it('reads quoted lines as a quote, with whatever is quoted read the same way', () => {
    expect(textBlocks('You said:\n> quoted\n> - one\n>\n> > inner\nBack.')).toEqual([
      p('You said:'),
      { kind: 'quote', blocks: [p('quoted'), ul(item('one')), { kind: 'quote', blocks: [p('inner')] }] },
      p('Back.')
    ]);
  });

  it('reads a line of three or more dashes, stars or underscores as a rule', () => {
    for (const rule of ['---', '***', '___', '- - -', '* * *']) expect(textBlocks(`A\n\n${rule}\n\nB`)).toEqual([p('A'), { kind: 'hr' }, p('B')]);
  });

  it('stops nesting, however deeply a reply nests', () => {
    expect(() => textBlocks(`${'>'.repeat(20_000)} deep`)).not.toThrow();
    expect(() => textBlocks(Array.from({ length: 500 }, (_, n) => `${' '.repeat(n * 2)}- x`).join('\n'))).not.toThrow();
  });
});

describe('model text spans', () => {
  it('reads bold, italic and struck-through words, one inside another too', () => {
    expect(textSpans('A **bold** and __bold too__ word')).toEqual(['A ', strong('bold'), ' and ', strong('bold too'), ' word']);
    expect(textSpans('*italic* and _italic_.')).toEqual([em('italic'), ' and ', em('italic'), '.']);
    expect(textSpans('~~struck~~ out')).toEqual([del('struck'), ' out']);
    expect(textSpans('**very _much_ so** and ***both***')).toEqual([strong('very ', em('much'), ' so'), ' and ', em(strong('both'))]);
    expect(textSpans('(**`Hero`**)')).toEqual(['(', strong(mono('Hero')), ')']);
    expect(textSpans('*across\nlines*')).toEqual([em('across\nlines')]);
  });

  it('keeps code as typed, marks and all', () => {
    expect(textSpans('Swap `a_*b*_` and `` x ` y ``')).toEqual(['Swap ', mono('a_*b*_'), ' and ', mono('x ` y')]);
    expect(textSpans('`items[0](x)`')).toEqual([mono('items[0](x)')]);
    expect(textSpans('```npm run dev``` starts it')).toEqual([mono('npm run dev'), ' starts it']);
    expect(textSpans('a `lone backtick')).toEqual(['a `lone backtick']);
  });

  it('shows a link or image as its words', () => {
    expect(textSpans('See [the **docs**](https://example.com/a_(b)) and ![a photo](x.jpg).')).toEqual(['See the ', strong('docs'), ' and a photo.']);
    expect(textSpans('[`a[0]`](u) [slug]')).toEqual([mono('a[0]'), ' [slug]']);
  });

  it('leaves marks that are not emphasis as typed', () => {
    for (const text of [
      'snake_case_name and __dirname and __init__',
      '2 * 3 * 4, 2*3*4 and 1200*800*2',
      'src/**/*.ts and tests/**/*.ts',
      '*.ts and *.tsx',
      '**kwargs and **args',
      'about ~5 min or ~10 min',
      'an unfinished **bold',
      '_blank'
    ])
      expect(textSpans(text)).toEqual([text]);
  });

  it('shows an escaped mark as the mark', () => {
    expect(textSpans('\\*not italic\\* in C:\\Users')).toEqual(['*not italic* in C:\\Users']);
  });

  it('bounds how deeply emphasis nests', () => {
    const depth = (spans: TextSpan[]): number => Math.max(0, ...spans.map((s) => (typeof s === 'string' || s.kind === 'code' ? 0 : 1 + depth(s.spans))));
    expect(depth(textSpans(`${'_a '.repeat(5_000)}${'a_ '.repeat(5_000)}`))).toBeLessThanOrEqual(8);
  });

  it('reads a long run of unpartnered marks quickly', () => {
    const started = performance.now();
    for (const text of ['*a '.repeat(20_000), ' a_'.repeat(20_000), '['.repeat(20_000), '`a``b'.repeat(10_000), '[a]('.repeat(5_000)]) textSpans(text);
    textBlocks(`| ${' '.repeat(50_000)}x\n|${' '.repeat(50_000)}x`);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
