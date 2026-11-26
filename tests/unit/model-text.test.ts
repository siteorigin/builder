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
const link = (href: string, ...spans: TextSpan[]): TextSpan => ({ kind: 'link', href, spans });

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
    expect(textBlocks('##   ')).toEqual([]);
    expect(textBlocks('> One\n>\n> Two')).toEqual([{ kind: 'quote', blocks: [p('One'), p('Two')] }]);
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

  it('reads a fence, quote or table that starts on an item’s own line', () => {
    expect(textBlocks('- Parent\n  - ```js\n    x()\n    ```\n- Next\n\nDone.')).toEqual([
      ul(item('Parent', ul({ lines: [], blocks: [code('x()')] })), item('Next')),
      p('Done.')
    ]);
    expect(textBlocks('- > Approved\n  > by the owner')).toEqual([ul({ lines: [], blocks: [{ kind: 'quote', blocks: [p('Approved', 'by the owner')] }] })]);
    expect(textBlocks('- | A |\n  | - |')).toEqual([ul({ lines: [], blocks: [{ kind: 'table', head: ['A'], rows: [] }] })]);
    expect(textBlocks('- > 100 visitors')).toEqual([ul(item('> 100 visitors'))]);
    for (const amount of ['>= 100 visitors', '>100 visitors']) expect(textBlocks(`- ${amount}`)).toEqual([ul(item(amount))]);
    // The closing line is found at the same place however far the code under the marker stands out, tabs included.
    expect(textBlocks('1. ```js\nx()\n    ```\n   Continue.\n2. Next')).toEqual([ol({ lines: [], blocks: [code('x()'), p('Continue.')] }, item('Next'))]);
    expect(textBlocks('-\t```js\n\tx()\n       ```\n- Next\nDone.')).toEqual([ul({ lines: [], blocks: [code('x()')] }, item('Next')), p('Done.')]);
    // Only a fence the list reader would open is held.
    expect(textBlocks('- Parent\n  - - ```js\n- Next\nDone.')).toEqual([ul(item('Parent', ul(item('- ```js'))), item('Next')), p('Done.')]);
  });

  it('closes a fence only with a line that is not indented well past it, and leaves a tab’s other columns', () => {
    expect(textBlocks('```md\n    ```\nKeep this line\n````\nAfter')).toEqual([code('    ```', 'Keep this line'), p('After')]);
    expect(textBlocks('  ```py\n  if ok:\n\tpass  \n  ```')).toEqual([code('if ok:', '  pass  ')]);
    expect(textBlocks('- Card\n\t- Body\n    - Title')).toEqual([ul(item('Card', ul(item('Body'), item('Title'))))]);
    expect(textBlocks('~~~sh\nx')).toEqual([code('x')]);
    expect(textBlocks('```\n   ```\nAfter')).toEqual([code(), p('After')]);
  });

  it('keeps a paragraph after a blank line apart from its item’s words, and a very long item whole', () => {
    expect(textBlocks('- Note\n\n  More.')).toEqual([ul(item('Note', p('More.')))]);
    expect(textBlocks('7. Seven')).toEqual([{ kind: 'ol', start: 7, items: [item('Seven')] }]);
    const [list] = textBlocks(`- Root\n${'  x\n'.repeat(150_000)}  end`);
    expect(list.kind === 'ul' && list.items[0].lines.at(-1)).toBe('end');
  });

  it('reads a table as its cells, without its dashes', () => {
    expect(textBlocks('Pages:\n| Page | Sections |\n| :--- | ---: |\n| Home | 4 |\n| About \\| us |\n\nDone.')).toEqual([
      p('Pages:'),
      { kind: 'table', head: ['Page', 'Sections'], rows: [['Home', '4'], ['About | us']] },
      p('Done.')
    ]);
    // Each row keeps the cells it has, so no words are lost and a long row costs only itself.
    expect(textBlocks('Page | Sections\n--- | ---\nHome | 4 | extra\nAbout |')).toEqual([
      { kind: 'table', head: ['Page', 'Sections'], rows: [['Home', '4', 'extra'], ['About']] }
    ]);
    // A pipe that is escaped or in code divides nothing, so it makes no table and no further row.
    expect(textBlocks('| Mode |\n| --- |\n| Auto |\nUse `on | off`.')).toEqual([{ kind: 'table', head: ['Mode'], rows: [['Auto']] }, p('Use `on | off`.')]);
    expect(textBlocks('A \\| B\n| --- |')).toEqual([p('A \\| B', '| --- |')]);
    expect(textBlocks('| Type | Meaning |\n| --- | --- |\n| ``a | b`` | union |')).toEqual([
      { kind: 'table', head: ['Type', 'Meaning'], rows: [['``a | b``', 'union']] }
    ]);
    expect(textBlocks('a | b\nc | d')).toEqual([p('a | b', 'c | d')]);
    expect(textBlocks('a | b\n| --- |')).toEqual([p('a | b', '| --- |')]);
    expect(textBlocks('| A |\n| - |\n> a | b')).toEqual([{ kind: 'table', head: ['A'], rows: [] }, { kind: 'quote', blocks: [p('a | b')] }]);
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
    expect(textSpans('Use __Important__ here')).toEqual(['Use ', strong('Important'), ' here']);
    expect(textSpans('~~old **copy**~~')).toEqual([del('old ', strong('copy'))]);
    expect(textSpans('*a _b* c_')).toEqual([em('a _b'), ' c_']);
    expect(textSpans('(**`Hero`**)')).toEqual(['(', strong(mono('Hero')), ')']);
    expect(textSpans('*across\nlines*')).toEqual([em('across\nlines')]);
  });

  it('keeps code as typed, marks and all', () => {
    expect(textSpans('Swap `a_*b*_` and `` x ` y ``')).toEqual(['Swap ', mono('a_*b*_'), ' and ', mono('x ` y')]);
    expect(textSpans('`items[0](x)`')).toEqual([mono('items[0](x)')]);
    expect(textSpans('```npm run dev``` starts it')).toEqual([mono('npm run dev'), ' starts it']);
    expect(textSpans('a `lone backtick')).toEqual(['a `lone backtick']);
    // One space comes off each side only when both sides have one.
    expect(textSpans('` a` `  b  ` `  `')).toEqual([mono(' a'), ' ', mono(' b '), ' ', mono('  ')]);
  });

  it('keeps a link to a web page as a link, its words and its address both (issue #889)', () => {
    expect(textSpans('See [the **docs**](https://example.com/a_(b)) and ![a photo](x.jpg).')).toEqual(['See ', link('https://example.com/a_(b)', 'the ', strong('docs')), ' and a photo.']);
    expect(textSpans('[Docs](https://example.com/docs "The docs")')).toEqual([link('https://example.com/docs', 'Docs')]);
    expect(textSpans('**[Docs](HTTP://Example.com)**')).toEqual([strong(link('http://example.com/', 'Docs'))]);
    expect(textSpans('[](https://example.com/a)')).toEqual([link('https://example.com/a', 'https://example.com/a')]);
    // A link's words never hold another link.
    expect(textSpans('[https://a.example](https://b.example)')).toEqual([link('https://b.example/', 'https://a.example')]);
  });

  it('shows a link to anything but a web page, and an image, as its words', () => {
    expect(textSpans('[`a[0]`](u) [slug]')).toEqual([mono('a[0]'), ' [slug]']);
    expect(textSpans('[A](u) and [B](v); ![](hero.jpg)')).toEqual(['A and B; hero.jpg']);
    expect(textSpans('[run](javascript:alert(1)) [file](file:///etc/passwd) [mail](mailto:a@b.example) [me](https://user:pw@example.com)')).toEqual(['run file mail me']);
    expect(textSpans('![logo](https://example.com/logo.png)')).toEqual(['logo']);
  });

  it('makes an address written out a link, leaving the punctuation after it to the sentence (issue #889)', () => {
    expect(textSpans('Go to https://example.com/pricing.')).toEqual(['Go to ', link('https://example.com/pricing', 'https://example.com/pricing'), '.']);
    expect(textSpans('(see https://en.wikipedia.org/wiki/Foo_(bar)), then')).toEqual(['(see ', link('https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'), '), then']);
    expect(textSpans('**https://example.com/a_b_c**!')).toEqual([strong(link('https://example.com/a_b_c', 'https://example.com/a_b_c')), '!']);
    expect(textSpans('Try http://localhost:5173/?q=a*b, or not')).toEqual(['Try ', link('http://localhost:5173/?q=a*b', 'http://localhost:5173/?q=a*b'), ', or not']);
    expect(textSpans('"https://example.com"')).toEqual(['"', link('https://example.com/', 'https://example.com'), '"']);
    expect(textSpans('“https://example.com/a”, and Source:https://example.com/b')).toEqual(['“', link('https://example.com/a', 'https://example.com/a'), '”, and Source:', link('https://example.com/b', 'https://example.com/b')]);
    // A mark closes emphasis only when one is open; otherwise it is part of the address.
    expect(textSpans('**https://example.com/docs**,” and https://example.com/user_ or _https://example.com/x_')).toEqual([
      strong(link('https://example.com/docs', 'https://example.com/docs')),
      ',” and ',
      link('https://example.com/user_', 'https://example.com/user_'),
      ' or ',
      em(link('https://example.com/x', 'https://example.com/x'))
    ]);
    expect(textSpans('https://example.com/a\\`b` and [x](https://example.com/a)]')).toEqual([link('https://example.com/a', 'https://example.com/a'), '`b` and ', link('https://example.com/a', 'x'), ']']);
  });

  it('leaves an address in code, in a word or without a host as typed', () => {
    expect(textSpans('Run `curl https://example.com` first')).toEqual(['Run ', mono('curl https://example.com'), ' first']);
    expect(textSpans('xhttps://example.com and https:// and https://user:pw@example.com and git+https://example.com')).toEqual(['xhttps://example.com and https:// and https://user:pw@example.com and git+https://example.com']);
    expect(textSpans('𝒳https://example.com')).toEqual(['𝒳https://example.com']);
    // Too long to open once the browser writes it out in full, so not a link at all.
    expect(textSpans(`[long](https://example.com/${'é'.repeat(350)})`)).toEqual(['long']);
    expect(textBlocks('```\nhttps://example.com\n```')).toEqual([code('https://example.com')]);
  });

  it('leaves marks that are not emphasis as typed', () => {
    for (const text of [
      'snake_case_name and __dirname and __init__',
      '2 * 3 * 4, 2*3*4 and 1200*800*2',
      'src/**/*.ts and tests/**/*.ts',
      '*.ts and *.tsx',
      "Use '*.jpg' and '*.png'.",
      '(*.jpg or *.png)',
      "match '*' or '*'",
      'width*height*scale',
      '**kwargs and **args',
      'about ~5 min or ~10 min',
      'an unfinished **bold',
      '_blank'
    ])
      expect(textSpans(text)).toEqual([text]);
  });

  it('shows an escaped mark as the mark', () => {
    expect(textSpans('\\*not italic\\* in C:\\Users')).toEqual(['*not italic* in C:\\Users']);
    expect(textSpans('\\_x\\_ and \\[y]')).toEqual(['_x_ and [y]']);
  });

  it('bounds how deeply emphasis nests', () => {
    const depth = (spans: TextSpan[]): number => Math.max(0, ...spans.map((s) => (typeof s === 'string' || s.kind === 'code' ? 0 : 1 + depth(s.spans))));
    expect(depth(textSpans(`${'_a '.repeat(5_000)}${'a_ '.repeat(5_000)}`))).toBeLessThanOrEqual(8);
  });

  it('reads a long run of unpartnered marks quickly', () => {
    const started = performance.now();
    for (const text of ['*a '.repeat(20_000), ' a_'.repeat(20_000), '['.repeat(20_000), '`a``b'.repeat(10_000), '[a]('.repeat(5_000), `https://example.com/${')'.repeat(2_000)} `.repeat(30), `https://a.example/${'.)'.repeat(2_000)}`, `\` ${'a '.repeat(50_000)}b\``, `a${'__b'.repeat(30_000)}`]) textSpans(text);
    textBlocks(`| ${' '.repeat(50_000)}x\n|${' '.repeat(50_000)}x`);
    expect(performance.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
