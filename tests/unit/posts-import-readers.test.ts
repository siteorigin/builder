/**
 * Import posts (#399): the readers that turn a WordPress export or a Markdown file into an entry's text. Nothing in a
 * file can declare or expand an entity, run a script or embed a frame; a damaged file fails quickly with a reason.
 */
import { describe, expect, it } from 'vitest';
import type { LinkValue } from '@shared/types';
import { linkFromTarget } from '@shared/richtext';
import { XmlError, childText, parseXml, textOf } from '../../src/main/posts-import/xml';
import { autop, emptyReport, htmlToPlain, htmlToRichText, type ReadHtmlOptions } from '../../src/main/posts-import/html';

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

  it('wpautop leaves block markup and preformatted text alone', () => {
    expect(autop('<h2>Title</h2>\nText')).toBe('<h2>Title</h2>\n<p>Text</p>\n');
    expect(autop('Intro\n\n<pre>a  b\nc</pre>')).toContain('<pre>a  b\nc</pre>');
  });

  it('reads hostile text in one pass: unclosed shortcodes, tags, captions and preformatted text', () => {
    const t0 = performance.now();
    htmlToRichText('[foo a="b" c="d'.repeat(20_000), opts({ autop: true, shortcodes: true }));
    htmlToRichText('<'.repeat(200_000) + '<p><div'.repeat(20_000), opts({ autop: true, shortcodes: true }));
    htmlToRichText('[caption]x'.repeat(20_000) + '<pre>x'.repeat(20_000), opts({ autop: true, shortcodes: true }));
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('reads plain text and entities', () => {
    expect(htmlToPlain('<p>Fish &amp; chips&nbsp;&mdash; <b>fresh</b></p><p>Daily</p>')).toBe('Fish & chips — fresh Daily');
  });
});
