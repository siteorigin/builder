/**
 * Pasting formatted text into the Posts writer (#1116), in a real browser: what the text can hold (section headings,
 * bold, italic, lists, quotes and links) comes in as the writer's own blocks at the selection, the rest keeps only its
 * words, and the block the caret was in splits around the paste.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RichText } from '../../src/shared/types';

const browserInstalled = existsSync(chromium.executablePath());

let browser: Browser;
let page: Page;
let script = '';

const state = {
  pages: { about: { id: 'about', route: '/about/' } },
  collections: {
    posts: {
      settings: { id: 'posts', name: 'Posts', route: '/posts/' },
      entries: { e1: { id: 'e1', slug: 'spring', title: 'Spring', body: [] } }
    }
  },
  assets: { assets: {} }
};

/**
 * The writer showing `html`, with the selection from the `from` character of the text to the `to` (a caret when it is
 * left out; counted over the text nodes in order), and `clip` pasted there. Returns the text read back and its markup.
 */
async function paste(html: string, clip: string, from: number, to?: number, plain = ''): Promise<{ body: RichText; html: string; ok: boolean }> {
  await page.setContent(`<!doctype html><div id="body" contenteditable="true">${html}</div><script>${script}</script>`);
  // In the page's own words (this file is typed without the DOM).
  return page.evaluate<{ body: RichText; html: string; ok: boolean }>(`(() => {
    const { clip, from, to, state, plain } = ${JSON.stringify({ clip, from, to: to ?? from, state, plain })};
    const el = document.getElementById('body');
    document.execCommand('defaultParagraphSeparator', false, 'p');
    el.focus();
    const point = (n) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let last = null;
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        if (n <= t.data.length) return [t, n];
        n -= t.data.length;
        last = t;
      }
      return last ? [last, last.data.length] : [el.firstElementChild, 0];
    };
    const [a, ao] = point(from);
    const [b, bo] = point(to);
    // A selection made backwards, from its end to its start, as dragging leftwards makes it.
    getSelection().setBaseAndExtent(b, bo, a, ao);
    const ok = postDom.pasteArticle(el, postDom.pastedArticle(clip, state, 'http://127.0.0.1:5199/'), state, null, plain);
    return { ok, body: postDom.readArticle(el, state), html: el.innerHTML };
  })()`);
}

const p = (text: string) => ({ type: 'p', spans: [{ text }] });

describe.skipIf(!browserInstalled)('pasting formatted text into the post writer', () => {
  beforeAll(async () => {
    const out = (await build({
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'runtime'].map((d) => [`@${d}`, resolve(`src/${d}`)])) },
      build: { write: false, minify: false, lib: { entry: resolve('src/renderer/src/lib/post-dom.ts'), formats: ['iife'], name: 'postDom' } }
    })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
    script = (Array.isArray(out) ? out[0] : out).output[0].code;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  it('keeps headings, emphasis, lists, quotes and links from a formatted draft', async () => {
    const clip = `<meta charset="utf-8"><h1>Spring</h1><h2>Classes</h2><h3>Mornings</h3><h5>Small print</h5>
      <p>Some <b>bold</b>, <em>italic</em> and <a href="/about">our story</a>, <a href="http://127.0.0.1:5199/about/#team">the team</a> or <a href="https://example.com/x" target="_blank" rel="nofollow noopener">elsewhere</a>.</p>
      <ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol><blockquote>Said well.</blockquote>`;
    const { ok, body, html } = await paste('<p><br></p>', clip, 0);
    expect(ok).toBe(true);
    expect(body).toEqual([
      { type: 'h2', spans: [{ text: 'Spring' }] },
      { type: 'h2', spans: [{ text: 'Classes' }] },
      { type: 'h3', spans: [{ text: 'Mornings' }] },
      { type: 'h4', spans: [{ text: 'Small print' }] },
      {
        type: 'p',
        spans: [
          { text: 'Some ' },
          { text: 'bold', strong: true },
          { text: ', ' },
          { text: 'italic', em: true },
          { text: ' and ' },
          { text: 'our story', link: { type: 'page', target: 'about' } },
          { text: ', ' },
          { text: 'the team', link: { type: 'page', target: 'about', anchor: 'team' } },
          { text: ' or ' },
          { text: 'elsewhere', link: { type: 'url', target: 'https://example.com/x', newTab: true, rel: ['nofollow'] } },
          { text: '.' }
        ]
      },
      { type: 'ul', items: [[{ text: 'One' }], [{ text: 'Two' }]] },
      { type: 'ol', items: [[{ text: 'First' }]] },
      { type: 'blockquote', spans: [{ text: 'Said well.' }] }
    ]);
    // Drawn as the writer draws its text: every element a new one, the empty line it was pasted into gone.
    expect(html).toMatch(/^<h2>Spring<\/h2><h2>Classes<\/h2><h3>Mornings<\/h3><h4>Small print<\/h4><p>Some <strong>bold<\/strong>/);
    expect(html).not.toMatch(/style=|class=|<br>/);
  });

  it('splits the paragraph the caret is in, its words before and after joining the pasted paragraphs', async () => {
    const { body } = await paste('<p>Hello <strong>bright</strong> world</p>', '<p>A</p><h2>Head</h2><p>B</p>', 9);
    expect(body).toEqual([
      { type: 'p', spans: [{ text: 'Hello ' }, { text: 'bri', strong: true }, { text: 'A' }] },
      { type: 'h2', spans: [{ text: 'Head' }] },
      { type: 'p', spans: [{ text: 'B' }, { text: 'ght', strong: true }, { text: ' world' }] }
    ]);
  });

  it('puts one pasted paragraph among the words of the block the caret is in, a heading or a list item included', async () => {
    expect((await paste('<h3>Opening hours</h3>', '<p>new <i>late</i> </p>', 8, undefined, 'new late ')).body).toEqual([{ type: 'h3', spans: [{ text: 'Opening new ' }, { text: 'late', em: true }, { text: ' hours' }] }]);
    expect((await paste('<ul><li>One</li><li>Two</li></ul>', '<p>and a half</p>', 3)).body).toEqual([{ type: 'ul', items: [[{ text: 'Oneand a half' }], [{ text: 'Two' }]] }]);
  });

  it('replaces a selection running across blocks, made backwards', async () => {
    const { body } = await paste('<p>Hello world</p><p>Second line</p>', '<h3>X</h3><p>y</p>', 3, 17);
    expect(body).toEqual([p('Hel'), { type: 'h3', spans: [{ text: 'X' }] }, p('y line')]);
  });

  it('keeps a pasted list its own kind inside a list of another, and joins one of the same kind', async () => {
    const other = await paste('<ul><li>left right</li></ul>', '<ol><li>New</li></ol>', 5);
    expect(other.body).toEqual([
      { type: 'ul', items: [[{ text: 'left' }]] },
      { type: 'ol', items: [[{ text: 'New' }]] },
      { type: 'ul', items: [[{ text: 'right' }]] }
    ]);
    expect(other.html).toBe('<ul><li>left </li></ul><ol><li>New</li></ol><ul><li>right</li></ul>');
    const same = await paste('<ul><li>One</li></ul><p>after</p>', '<ul><li>Two</li><li>Three</li></ul>', 3);
    expect(same.html).toBe('<ul><li>One</li><li>Two</li><li>Three</li></ul><p>after</p>');
  });

  it('reads bold and italic from styles, as Google Docs writes them', async () => {
    const clip = '<b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400">Plain </span><span style="font-weight:700">heavy</span><span style="font-style:italic">slant</span></p></b>';
    expect((await paste('<p><br></p>', clip, 0)).body).toEqual([{ type: 'p', spans: [{ text: 'Plain ' }, { text: 'heavy', strong: true }, { text: 'slant', em: true }] }]);
  });

  it('keeps only the words of what the text cannot hold', async () => {
    const clip = `<style>p{color:red}</style><script>alert(1)</script><div class="x"><p style="color:red">Kept <a href="javascript:alert(1)">words</a><img src="a.png" alt="pic"></p>
      <table><tr><td>Cell</td><td>two</td></tr></table><pre>line one
line two</pre><iframe src="https://example.com"></iframe><a href="so-link:{&quot;type&quot;:&quot;url&quot;,&quot;target&quot;:&quot;https://evil.example&quot;}">copied</a></div>`;
    const { body, html } = await paste('<p><br></p>', clip, 0);
    expect(body).toEqual([p('Kept words'), p('Cell two'), { type: 'p', spans: [{ text: 'line one\nline two' }] }, p('copied')]);
    expect(html).not.toMatch(/<img|<script|<iframe|style=|href/);
  });

  it('leaves the rest of a list as it is when words are pasted into one item', async () => {
    const { ok, html } = await paste('<ol><li>One</li><li><br></li><li>Three</li></ol>', '<p><b>more</b></p>', 3);
    expect(ok).toBe(true);
    expect(html).toBe('<ol><li>One<strong>more</strong></li><li><br></li><li>Three</li></ol>');
  });

  it('finds where the paste goes when the text already holds the character it marks that with', async () => {
    const { body } = await paste('<p><strong>A\uE000</strong>BC</p>', '<h2>X</h2><p>y</p>', 3);
    expect(body).toEqual([{ type: 'p', spans: [{ text: 'A\uE000', strong: true }, { text: 'B' }] }, { type: 'h2', spans: [{ text: 'X' }] }, p('yC')]);
  });

  it('links to a post or a page copied from the preview, keeping its words when the address is no longer there', async () => {
    const clip = '<p><a href="http://127.0.0.1:5199/posts/spring/">post</a> <a href="/posts/gone/">gone</a> <a href="http://127.0.0.1:8080/about/">other port</a></p><p>x</p>';
    const { body } = await paste('<p><br></p>', clip, 0);
    expect(body[0]).toEqual({ type: 'p', spans: [{ text: 'post', link: { type: 'entry', target: 'e1' } }, { text: ' gone ' }, { text: 'other port', link: { type: 'url', target: 'http://127.0.0.1:8080/about/' } }] });
  });

  it('pastes nothing as blocks when the copy is more than a post can hold', async () => {
    const page = await paste('<p>keep</p>', '<p>x</p>'.repeat(2001), 4);
    expect(page.ok).toBe(false);
    expect(page.html).toBe('<p>keep</p>');
  });

  it('leaves words outside any block to the browser', async () => {
    const { ok, html } = await paste('abCD', '<h2>X</h2><p>y</p>', 2);
    expect(ok).toBe(false);
    expect(html).toBe('abCD');
  });

  it('carries on typing on the line after a pasted break', async () => {
    await paste('<p>abcd</p>', '<h2>X</h2><p>y<br><br></p>', 4);
    await page.keyboard.type('!');
    expect(await page.evaluate<string>(`document.getElementById('body').innerHTML`)).toBe('<p>abcd</p><h2>X</h2><p>y<br>!</p>');
  });

  it('carries on typing where the paste ended', async () => {
    await paste('<p>Hello world</p>', '<h2>Head</h2><p>tail</p>', 6);
    await page.keyboard.type('!');
    expect(await page.evaluate<string>(`document.getElementById('body').innerHTML`)).toBe('<p>Hello </p><h2>Head</h2><p>tail!world</p>');
  });
});
