/**
 * Import posts (#399): the readers that turn a WordPress export or a Markdown file into an entry's text. Nothing in a
 * file can declare or expand an entity, run a script or embed a frame; a damaged file fails quickly with a reason.
 */
import { describe, expect, it } from 'vitest';
import type { LinkValue } from '@shared/types';
import { linkFromTarget } from '@shared/richtext';
import { XmlError, childText, parseXml, textOf } from '../../src/main/posts-import/xml';
import { autop, emptyReport, htmlToPlain, htmlToRichText, type ReadHtmlOptions } from '../../src/main/posts-import/html';
import { reportNotes } from '../../src/main/posts-import/notes';
import { markdownToHtml } from '../../src/main/posts-import/markdown';

const images: string[] = [];
const opts = (extra: Partial<ReadHtmlOptions> = {}): ReadHtmlOptions => ({
  image: ({ src }) => (src.endsWith('.jpg') ? (images.push(src), `m:${src}`) : null),
  link: (href: string, newTab: boolean): LinkValue | null => linkFromTarget(href, {}, newTab),
  ...extra
});

describe('the XML reader', () => {
  it('reads elements, attributes, CDATA and the five entities', () => {
    const doc = parseXml('<?xml version="1.0"?>\n<rss a="1 &amp; 2"><title>Tom &amp; Jerry &#8217;s &#x41; &lt;b&gt; &quot;q&quot; &apos;a&apos;</title><body><![CDATA[<p>Hi & bye &amp;</p>]]><![CDATA[ more]]></body><!-- note --></rss>');
    expect(doc.name).toBe('rss');
    expect(doc.attrs.a).toBe('1 & 2');
    expect(childText(doc, 'title')).toBe('Tom & Jerry ’s A <b> "q" \'a\'');
    // CDATA is literal: a reference in it is the text as written.
    expect(childText(doc, 'body')).toBe('<p>Hi & bye &amp;</p> more');
  });

  it('never reads a document type, so no entity is declared or expanded', () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><rss>&lol2;</rss>`;
    expect(() => parseXml(laughs)).toThrow(/document type/);
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`;
    expect(() => parseXml(xxe)).toThrow(XmlError);
    expect(() => parseXml(xxe)).toThrow(/declares a document type/);
    // A name nothing declared stays as written.
    expect(textOf(parseXml('<r>&x; &nbsp;</r>'))).toBe('&x; &nbsp;');
  });

  it('fails with a reason on a damaged file', () => {
    expect(() => parseXml('<rss><channel><item></channel></rss>')).toThrow(/closed by/);
    expect(() => parseXml('<rss><channel>')).toThrow(/never closed/);
    expect(() => parseXml('<rss><title>unfinished')).toThrow(/never closed/);
    expect(() => parseXml('<rss><![CDATA[ no end</rss>')).toThrow(/CDATA section is never closed/);
    expect(() => parseXml('')).toThrow(/no XML document/);
    expect(() => parseXml('<a></a><b></b>')).toThrow(/second document/);
    expect(() => parseXml('<a x=1></a>')).toThrow(/no quotes/);
  });

  it('caps nesting, size and the number of nodes', () => {
    expect(() => parseXml('<a>'.repeat(100) + '</a>'.repeat(100))).toThrow(/nested too deeply/);
    expect(() => parseXml(`<r>${'<i/>'.repeat(50)}</r>`, { maxChars: 1e6, maxDepth: 10, maxNodes: 20 })).toThrow(/more than/);
    // Runs of text count too.
    expect(() => parseXml('<r>x<a/>y</r>', { maxChars: 1e6, maxDepth: 10, maxNodes: 3 })).toThrow(/more than/);
    expect(parseXml('<r>x<a/>y</r>', { maxChars: 1e6, maxDepth: 10, maxNodes: 4 }).children).toHaveLength(3);
    expect(() => parseXml(`<r>${'x'.repeat(200)}</r>`, { maxChars: 100, maxDepth: 10, maxNodes: 20 })).toThrow(/larger/);
  });

  it('reads a long flat file in linear time', () => {
    const big = `<r>${'<item><t>a &amp; b</t><![CDATA[x]]></item>'.repeat(50_000)}</r>`;
    const t0 = performance.now();
    expect(parseXml(big).children.length).toBe(50_000);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('the HTML reader', () => {
  it('keeps prose: paragraphs, headings, quotes, lists, marks and links', () => {
    const blocks = htmlToRichText('<h1>Big</h1><p>Hello <strong>bold <em>both</em></strong> and <a href="https://example.com/x" target="_blank">a link</a>.</p><h3>Small</h3><blockquote><p>Quoted</p></blockquote><ul><li><em>One</em><li>Two</ul><ol><li><a href="https://example.com/y">First</a></li></ol>', opts());
    expect(blocks).toEqual([
      { type: 'h2', spans: [{ text: 'Big' }] },
      { type: 'p', spans: [{ text: 'Hello ' }, { text: 'bold', strong: true }, { text: ' ' }, { text: 'both', strong: true, em: true }, { text: ' and ' }, { text: 'a link', link: { type: 'url', target: 'https://example.com/x', newTab: true } }, { text: '.' }] },
      { type: 'h3', spans: [{ text: 'Small' }] },
      { type: 'blockquote', spans: [{ text: 'Quoted' }] },
      { type: 'ul', items: [[{ text: 'One', em: true }], [{ text: 'Two' }]] },
      { type: 'ol', items: [[{ text: 'First', link: { type: 'url', target: 'https://example.com/y' } }]] }
    ]);
  });

  it('drops scripts, styles, frames, forms and event handlers, and counts them', () => {
    const report = emptyReport();
    const blocks = htmlToRichText(
      '<p onload="steal()">Safe</p><script>alert(1)</script><style>p{}</style><iframe src="https://evil.example/x"></iframe><form><input name=a>Pay</form><object data="https://x/y.swf"><p>no</p></object><p><a href="javascript:alert(1)">click</a></p><svg><script>x</script></svg>',
      opts(),
      report
    );
    expect(blocks).toEqual([{ type: 'p', spans: [{ text: 'Safe' }] }, { type: 'p', spans: [{ text: 'click' }] }]);
    expect(report).toMatchObject({ scripts: 2, forms: 1, droppedLinks: 1 });
    expect(report.embeds.sort()).toEqual(['https://evil.example/x', 'https://x/y.swf']);
  });

  it('reads an unclosed script to the end without reading what follows as markup', () => {
    expect(htmlToRichText('<p>Before</p><script>document.write("<p>after</p>")', opts())).toEqual([{ type: 'p', spans: [{ text: 'Before' }] }]);
    // An end tag never finished is no end: the rest is still the script's.
    expect(htmlToRichText('<p>Before</p><script>x("<p>after</p>")</script', opts())).toEqual([{ type: 'p', spans: [{ text: 'Before' }] }]);
  });

  it('turns pictures into the import’s keys, with captions', () => {
    // A picture not found leaves the words around it in one paragraph.
    expect(htmlToRichText('<p>Before <img src="gone.png"> after</p>', opts())).toEqual([{ type: 'p', spans: [{ text: 'Before after' }] }]);
    const blocks = htmlToRichText('<p>Text <img src="a.jpg" alt="A cat"> more</p><figure class="wp-block-image"><img src="b.jpg" alt=""><figcaption>The <em>barn</em></figcaption></figure><img src="remote.png">', opts());
    expect(blocks).toEqual([
      { type: 'p', spans: [{ text: 'Text' }] },
      { type: 'image', assetId: 'm:a.jpg', alt: 'A cat' },
      { type: 'p', spans: [{ text: 'more' }] },
      { type: 'image', assetId: 'm:b.jpg', alt: '', caption: 'The barn' }
    ]);
  });

  it('keeps an embedded video as a link to it', () => {
    const report = emptyReport();
    const blocks = htmlToRichText('<!-- wp:embed --><figure class="wp-block-embed is-type-video"><div class="wp-block-embed__wrapper">\nhttps://www.youtube.com/watch?v=abc\n</div></figure><!-- /wp:embed -->', opts(), report);
    expect(blocks).toEqual([{ type: 'p', spans: [{ text: 'https://www.youtube.com/watch?v=abc', link: { type: 'url', target: 'https://www.youtube.com/watch?v=abc' } }] }]);
    expect(report.embedLinks).toBe(1);
  });

  it('reads WordPress classic paragraphs and shortcodes', () => {
    const report = emptyReport();
    const html = 'First line\nsecond line\n\nNext <strong>para</strong>.\n\n[caption id="attachment_7" width="300"]<img src="c.jpg" alt="Cake"> A cake[/caption]\n\n[gallery ids="1,2"]\n\n[sic] stays\n\n<ul>\n<li>Item</li>\n</ul>';
    expect(htmlToRichText(html, opts({ autop: true, shortcodes: true }), report)).toEqual([
      { type: 'p', spans: [{ text: 'First line\nsecond line' }] },
      { type: 'p', spans: [{ text: 'Next ' }, { text: 'para', strong: true }, { text: '.' }] },
      { type: 'image', assetId: 'm:c.jpg', alt: 'Cake', caption: 'A cake' },
      { type: 'p', spans: [{ text: '[sic] stays' }] },
      { type: 'ul', items: [[{ text: 'Item' }]] }
    ]);
    expect(report.shortcodes).toEqual(['gallery']);
  });

  it('keeps tables and code as plain text', () => {
    const report = emptyReport();
    expect(htmlToRichText('<table><tr><th>Day</th><th>Hours</th></tr><tr><td>Mon</td><td>9-5</td></tr></table><pre>a  b\nc</pre>', opts(), report)).toEqual([
      { type: 'p', spans: [{ text: 'Day · Hours' }] },
      { type: 'p', spans: [{ text: 'Mon · 9-5' }] },
      { type: 'p', spans: [{ text: 'a b\nc' }] }
    ]);
    expect(report.tables).toBe(1);
  });

  it('finds captions and preformatted text wherever the post’s letters change length in lower case', () => {
    expect(htmlToRichText('İstanbul\n\n[caption]<img src="c.jpg" alt="C"> Cap[/caption]', opts({ autop: true, shortcodes: true }))).toEqual([
      { type: 'p', spans: [{ text: 'İstanbul' }] },
      { type: 'image', assetId: 'm:c.jpg', alt: 'C', caption: 'Cap' }
    ]);
    expect(autop('İ <prefix>x</prefix>\n\n<pre>a  b\nc</pre>')).toContain('<pre>a  b\nc</pre>');
  });

  it('wpautop leaves block markup and preformatted text alone', () => {
    expect(autop('<h2>Title</h2>\nText')).toBe('<h2>Title</h2>\n<p>Text</p>\n');
    expect(autop('Intro\n\n<pre>a  b\nc</pre>')).toContain('<pre>a  b\nc</pre>');
  });

  it('reads hostile text in one pass: unclosed shortcodes, tags, captions and preformatted text', () => {
    const t0 = performance.now();
    htmlToRichText('[foo a="b" c="d'.repeat(20_000), opts({ autop: true, shortcodes: true }));
    htmlToRichText('<'.repeat(200_000) + '<p><div'.repeat(20_000), opts({ autop: true, shortcodes: true }));
    htmlToRichText('[caption]x'.repeat(20_000) + '<pre>x'.repeat(20_000), opts({ autop: true, shortcodes: true }));
    htmlToRichText('[embed '.repeat(40_000), opts({ autop: true, shortcodes: true }));
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('reads plain text and entities', () => {
    expect(htmlToPlain('<p>Fish &amp; chips&nbsp;&mdash; <b>fresh</b></p><p>Daily</p>')).toBe('Fish & chips — fresh Daily');
  });
});

describe('formatting post text has no form for (#1506)', () => {
  const read = (html: string, extra: Partial<ReadHtmlOptions> = {}) => {
    const report = emptyReport();
    const blocks = htmlToRichText(html, opts(extra), report);
    return { text: blocks.map((b) => ('spans' in b ? b.spans.map((s) => s.text).join('') : '')), report, notes: reportNotes(report), blocks };
  };

  it('keeps superscript and subscript digits apart from the text before them', () => {
    expect(read('<p>1.2 × 10<sup>6</sup> cells, m<sup>2</sup>, CO<sub>2</sub>, H<sub>2</sub>O, October<sup>1</sup> and x<sup>n+1</sup>.</p>').text).toEqual([
      '1.2 × 10⁶ cells, m², CO₂, H₂O, October¹ and xⁿ⁺¹.'
    ]);
    // No character of its own: a mark keeps the digits apart; letters alone (an ordinal) read as they are.
    expect(read('<p>10<sup>-1.5</sup>2, x<sub>i,2</sub>, x<sup>٦</sup>7, the 19<sup>th</sup> century and <sup>[1]</sup></p>').text).toEqual(['10^(-1.5)2, x_(i,2), x^(٦)7, the 19th century and ^([1])']);
    // One inside another is bracketed (never 10²³); one with nothing to show is no superscript at all.
    const nested = read('<p>10<sup>2<sup>3</sup></sup>, e<sup>x<sub>2</sub></sup> and <strong>m<sup>2</sup></strong> and a<sup> </sup>b</p>');
    expect(nested.text).toEqual(['10^(2³), e^(x₂) and m² and a b']);
    expect(nested.blocks[0]).toMatchObject({ spans: expect.arrayContaining([{ text: 'm²', strong: true }]) });
    expect(nested.report.raised).toBe(5);
  });

  it('writes superscripts and subscripts on the line in a picture’s caption', () => {
    const { blocks, notes } = read('<figure><img src="c.jpg" alt="Gas"><figcaption>CO<sub>2</sub> at 10<sup>-1.5</sup>2 and 10<sup>2<sup>3</sup></sup>, <del>old</del></figcaption></figure>', { autop: true });
    expect(blocks).toEqual([{ type: 'image', assetId: 'm:c.jpg', alt: 'Gas', caption: 'CO₂ at 10^(-1.5)2 and 10^(2³), old' }]);
    expect(notes).toEqual(['4 superscripts and subscripts became ordinary text on the line.', 'Kept a struck-through passage as ordinary text, no longer struck through.']);
    // Pictures that share a caption show none: nothing of it is said to be kept.
    expect(read('<figure><img src="a.jpg" alt="A"><img src="b.jpg" alt="B"><figcaption>10<sup>6</sup></figcaption></figure>').notes).toEqual([]);
  });

  it('keeps a superscript’s link, as a footnote marker has', () => {
    expect(read('<p>October<sup><a href="https://example.com/#fn1">1</a></sup></p>').blocks).toEqual([
      { type: 'p', spans: [{ text: 'October' }, { text: '¹', link: { type: 'url', target: 'https://example.com/#fn1' } }] }
    ]);
    expect(read('<p>October<sup><a href="https://example.com/#fn1">1</a></sup></p>').notes).toEqual(['A superscript or subscript became ordinary text on the line.']);
    expect(read('<p>October<a href="https://example.com/#fn1"><sup>1</sup></a></p>').blocks).toEqual([
      { type: 'p', spans: [{ text: 'October' }, { text: '¹', link: { type: 'url', target: 'https://example.com/#fn1' } }] }
    ]);
  });

  it('says in the review what became ordinary text: code, superscripts and subscripts, struck text', () => {
    const { text, notes } = read(
      '<p>Text with <u>underline</u>, <s>strike</s>, H<sub>2</sub>O and m<sup>2</sup>, and <mark>highlight</mark>.</p>\n<!-- wp:code -->\n<pre class="wp-block-code"><code>model &lt;- lmer(yield ~ treatment + (1|block), data = trials)</code></pre>\n<!-- /wp:code -->',
      { autop: true }
    );
    expect(text).toEqual(['Text with underline, strike, H₂O and m², and highlight.', 'model <- lmer(yield ~ treatment + (1|block), data = trials)']);
    expect(notes).toEqual([
      'A block of code or preformatted text became ordinary text.',
      '2 superscripts and subscripts became ordinary text on the line.',
      'Kept a struck-through passage as ordinary text, no longer struck through.'
    ]);
    expect(read('<p><del>12%</del> 21%, <strike>a</strike> and <s></s></p><pre>a</pre><pre>b</pre><p><sup> </sup></p>').notes).toEqual([
      '2 blocks of code or preformatted text became ordinary text.',
      'Kept 2 struck-through passages as ordinary text, no longer struck through.'
    ]);
    expect(read('<p>Plain <strong>bold</strong> text.</p>').notes).toEqual([]);
    // Preformatted text in a table cell is still code: both are said.
    const cell = read('<table><tr><td><pre>a\nb</pre></td></tr></table>', { autop: true });
    expect(cell.text).toEqual(['a\nb']);
    expect(cell.notes).toEqual(['A table became plain lines of text.', 'A block of code or preformatted text became ordinary text.']);
  });

  it('reads Markdown strikethrough and task lists', () => {
    const md = (s: string) => read(markdownToHtml(s));
    const struck = md('A correction: ~~12%~~ 21%, `~~kept~~`, ~~ spaced ~~, ~~~three~~~ and ~~a ~ b~~.');
    expect(struck.text).toEqual(['A correction: 12% 21%, ~~kept~~, ~~ spaced ~~, ~~~three~~~ and a ~ b.']);
    expect(struck.report.struck).toBe(2);
    // A strike across bold or italic is no strike: its marks stay as written, and no words are lost.
    expect(md('**a ~~b** c~~ and ~~d *e~~ f*').blocks).toEqual([
      { type: 'p', spans: [{ text: 'a ~~b', strong: true }, { text: ' c~~ and ~~d ' }, { text: 'e~~ f', em: true }] }
    ]);
    expect(md('~~**bold** gone~~').notes).toEqual(['Kept a struck-through passage as ordinary text, no longer struck through.']);
    const tasks = md('- [ ] task\n- [x] done\n- [X] **also**\n- [ ] ---');
    expect(tasks.blocks).toEqual([{ type: 'check', items: [[{ text: 'task' }], [{ text: 'done' }], [{ text: 'also', strong: true }], [{ text: '---' }]] }]);
    expect(tasks.notes).toEqual(['Left out the tick of 2 done tasks: a check list shows every item alike.']);
    expect(md('- [ ] a\n- [ ] b').notes).toEqual([]);
    // A list with only some task items, or tasks inside a list (which join it), keep their markers as written.
    expect(md('- [ ] task\n- plain').blocks).toEqual([{ type: 'ul', items: [[{ text: '[ ] task' }], [{ text: 'plain' }]] }]);
    expect(md('- outer\n  - [x] inner').blocks).toEqual([{ type: 'ul', items: [[{ text: 'outer' }], [{ text: '[x] inner' }]] }]);
    expect(md('> - [ ] quoted').blocks).toEqual([{ type: 'check', items: [[{ text: 'quoted' }]] }]);
    expect(md('- outer\n\n  > - [x] nested').blocks).toEqual([{ type: 'ul', items: [[{ text: 'outer' }], [{ text: '[x] nested' }]] }]);
    // A marker is read from what was written: a reference named x is no task's tick, and an escaped bracket no marker.
    expect(md('- [x] done\n- [ ] [x]\n\n[x]: https://example.com/x').blocks).toEqual([
      { type: 'check', items: [[{ text: 'done' }], [{ text: 'x', link: { type: 'url', target: 'https://example.com/x' } }]] }
    ]);
    expect(md('- \\[x] literal').blocks).toEqual([{ type: 'ul', items: [[{ text: '[x] literal' }]] }]);
    expect(md('- [x]\n  done').blocks).toEqual([{ type: 'check', items: [[{ text: 'done' }]] }]);
    // GitHub's own task list markup is a form's checkboxes, not this reader's check list.
    expect(read('<ul class="contains-task-list"><li><input type="checkbox" checked>Done</li></ul>').blocks).toEqual([{ type: 'ul', items: [[{ text: 'Done' }]] }]);
    expect(md('```\nx\n```').notes).toEqual(['A block of code or preformatted text became ordinary text.']);
  });
});
