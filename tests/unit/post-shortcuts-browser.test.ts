/**
 * The Posts writer's Markdown shortcuts (#895), typed with a real keyboard in a real browser: `## `, `### `, `#### `,
 * `> `, `- `, `* `, `+ `, `1. ` and `[ ] ` at the start of a paragraph make it a heading, a quote or a list, as the
 * writer's own input listener (PostWriter) runs them; anywhere else the space is only a space.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());

let browser: Browser;
let page: Page;
let script = '';

/** The writer's text, shown fresh as `html`, with the caret at its end. */
async function writer(html = '<p><br></p>') {
  await page.setContent(`<!doctype html><div id="body" contenteditable="true">${html}</div><script>${script}</script>
<script>
{
  const el = document.getElementById('body');
  document.execCommand('defaultParagraphSeparator', false, 'p');
  // As PostWriter's listener: a space that ends a marker runs the shortcut in place of being typed.
  el.addEventListener('beforeinput', (e) => {
    const shortcut = postDom.spaceShortcut(el, e);
    if (shortcut) (e.preventDefault(), shortcut());
  });
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el.lastElementChild);
  r.collapse(false);
  if (el.lastElementChild.lastChild?.nodeName === 'BR') r.setStartBefore(el.lastElementChild.lastChild);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
}
</script>`);
}
const html = () => page.evaluate<string>(`document.getElementById('body').innerHTML`);

describe.skipIf(!browserInstalled)('Markdown shortcuts in the post writer', () => {
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
  beforeEach(async () => {
    await writer();
  });

  it('starts a heading, a quote or a list from the marker typed at the start of a paragraph', async () => {
    const made: Record<string, string> = {
      '## ': '<h2>Opening hours</h2>',
      '### ': '<h3>Opening hours</h3>',
      '#### ': '<h4>Opening hours</h4>',
      '> ': '<blockquote>Opening hours</blockquote>',
      '- ': '<ul><li>Opening hours</li></ul>',
      '* ': '<ul><li>Opening hours</li></ul>',
      '+ ': '<ul><li>Opening hours</li></ul>',
      '1. ': '<ol><li>Opening hours</li></ol>',
      '[ ] ': '<ul class="so-rich--check"><li>Opening hours</li></ul>'
    };
    for (const [marker, want] of Object.entries(made)) {
      await writer();
      await page.keyboard.type(`${marker}Opening hours`);
      expect(await html(), marker).toBe(want);
    }
  });

  it('goes on with the list on the next line, and joins a list of the same kind just above', async () => {
    await page.keyboard.type('- Bread');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Cake');
    expect(await html()).toBe('<ul><li>Bread</li><li>Cake</li></ul>');
    await writer('<ul><li>Bread</li></ul><p><br></p>');
    await page.keyboard.type('- Cake');
    expect(await html()).toBe('<ul><li>Bread</li><li>Cake</li></ul>');
    // A list of another kind above is not joined.
    await writer('<ol><li>Bread</li></ol><p><br></p>');
    await page.keyboard.type('- Cake');
    expect(await html()).toBe('<ol><li>Bread</li></ol><ul><li>Cake</li></ul>');
  });

  it('keeps the words after the caret when the marker is typed in front of them', async () => {
    await writer('<p>Opening hours</p>');
    await page.evaluate(`getSelection().collapse(document.querySelector('#body p').firstChild, 0)`);
    await page.keyboard.type('## ');
    expect(await html()).toBe('<h2>Opening hours</h2>');
    // The caret stays in front of the words.
    await page.keyboard.type('Our ');
    expect((await html()).replace(/&nbsp;/g, ' ')).toBe('<h2>Our Opening hours</h2>');
  });

  it('leaves the space a space anywhere else', async () => {
    const kept: Array<[string, string, string]> = [
      // After other words, a first-level heading's marker (the title is the post's), and a marker with no space.
      ['<p><br></p>', 'See ## below', '<p>See ## below</p>'],
      ['<p><br></p>', '# Title', '<p># Title</p>'],
      ['<p><br></p>', '-1 degrees', '<p>-1 degrees</p>'],
      // In a heading, a list item or a quote.
      ['<h2><br></h2>', '- Not a list', '<h2>- Not a list</h2>'],
      ['<ul><li><br></li></ul>', '## Not a heading', '<ul><li>## Not a heading</li></ul>'],
      ['<blockquote><br></blockquote>', '- Said', '<blockquote>- Said</blockquote>']
    ];
    for (const [start, typed, want] of kept) {
      await writer(start);
      await page.keyboard.type(typed);
      expect((await html()).replace(/&nbsp;/g, ' '), typed).toBe(want);
    }
    // A word an object has of its own (Object.prototype's), never a marker.
    for (const word of ['constructor', 'toString', '__proto__']) {
      await writer();
      await page.keyboard.type(`${word} x`);
      expect((await html()).replace(/&nbsp;/g, ' '), word).toBe(`<p>${word} x</p>`);
    }
    // On a paragraph's second line, after a line break.
    await writer('<p>First line<br><br></p>');
    await page.keyboard.type('- Second');
    expect((await html()).replace(/&nbsp;/g, ' ')).toBe('<p>First line<br>- Second</p>');
  });

  it('types the space when words are selected', async () => {
    await writer('<p>##Words</p>');
    // Backwards as well as forwards.
    await page.evaluate(`(() => { const t = document.querySelector('#body p').firstChild; getSelection().setBaseAndExtent(t, 7, t, 2); })()`);
    await page.keyboard.type(' ');
    expect((await html()).replace(/&nbsp;/g, ' ')).toBe('<p>## </p>');
  });
});
