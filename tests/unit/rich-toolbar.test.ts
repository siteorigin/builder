/**
 * The formatting toolbar shown while rich text is edited on the canvas runs the real preview bridge in a real
 * browser frame on another origin, as the editor's preview is: links and lists are made with its buttons alone,
 * from the pointer or the keyboard, each command is one step of the text's own Undo, and what the edit leaves is
 * read back into blocks the way the editor reads it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blocksFromDom, richDom } from '../../src/renderer/src/lib/richtext';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const RICH = '<p>Intro words here</p><ul class="so-rich--bullet"><li>Alpha</li><li><strong>Beta</strong> <a href="/about/">link</a></li><li>Gamma</li></ul><p>Outro</p>';
const FRAME = `<!doctype html><html><head><style>body{margin:0;padding-top:60px;font:18px/1.4 sans-serif}li{color:#333;font-weight:400}strong{font-weight:700}</style></head><body>
<main data-so-node="s" data-so-ctx="page:p">
  <div class="so-rich" data-so-node="r" data-so-ctx="page:p">${RICH}</div>
  <h1 data-so-node="h" data-so-ctx="page:p">Plain heading</h1>
</main><script type="module" src="/bridge.js"></script></body></html>`;
const pages = { pg_about: { id: 'pg_about', route: '/about/' } };

let browser: Browser;
let page: Page;
let frame: Frame;

type Message = { type: string; payload: { rich?: unknown; editId?: string } };
const messages = () => page.evaluate<Message[]>(`window.seen`);
const post = (type: string, payload: unknown) => page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
async function beginEdit(node: string) {
  await page.evaluate(`window.seen = []`);
  await post('beginTextEdit', { desc: { ctx: 'page:p', node, items: '' }, editId: `e-${node}` });
  await expect.poll(async () => (await messages()).some((m) => m.type === 'textEditStarted')).toBe(true);
}
const rich = () => frame.innerHTML('[data-so-node="r"]');
const setRich = (html: string) => frame.evaluate(`document.querySelector('[data-so-node="r"]').innerHTML = ${JSON.stringify(html)}`);
/** The toolbar button with keyboard focus, by its name. */
const focusedButton = `(() => { const a = document.activeElement; const b = a && a.shadowRoot && a.shadowRoot.activeElement; return b ? b.getAttribute('aria-label') : null; })()`;
const toolbar = () => frame.getByRole('toolbar', { name: 'Text formatting' });
const button = (name: string) => toolbar().getByRole('button', { name, exact: true });
/** Select `word` in the edited text (or put the caret `at` characters into it). In-page code is a string: it runs
 *  in the frame, outside this file's (Node) type checking. */
const select = (word: string, at?: number) =>
  frame.evaluate(`(() => {
    const word = ${JSON.stringify(word)}, at = ${JSON.stringify(at ?? null)};
    const el = document.querySelector('[data-so-node="r"]');
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue.indexOf(word);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + (at === null ? 0 : at));
      r.setEnd(n, at === null ? i + word.length : i + at);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return;
    }
    throw new Error(word + ' not found');
  })()`);
const undo = () => frame.evaluate(`document.execCommand('undo')`);
const redo = () => frame.evaluate(`document.execCommand('redo')`);
/** Hand the edit back as the editor does on save, and read what it left the way the editor reads it. */
async function committed() {
  await post('commitTextEdit', {});
  await expect.poll(async () => (await messages()).some((m) => m.type === 'textCommit' || m.type === 'textCancel')).toBe(true);
  const ends = (await messages()).filter((m) => m.type === 'textCommit' || m.type === 'textCancel');
  expect(ends).toHaveLength(1);
  const dom = richDom(ends[0].payload.rich);
  expect(dom).not.toBeNull();
  return blocksFromDom(dom!, pages).blocks;
}
const items = (...words: string[]) => words.map((text) => [{ text }]);

describe.skipIf(!browserInstalled)('the formatting toolbar while rich text is edited', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.origin === SITE && url.pathname === '/frame') return route.fulfill({ contentType: 'text/html', body: FRAME });
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}/frame" style="border:0;width:700px;height:500px"></iframe></body>` });
      return route.abort();
    });
    await page.addInitScript(`if (location.origin === '${HOST}') { window.seen = []; window.addEventListener('message', (e) => { if (e.data && e.data.sessionId === 'so-test') window.seen.push({ type: e.data.type, payload: e.data.payload }); }); }`);
    await page.goto(`${HOST}/`);
    frame = page.frames().find((f) => f.name() === 'so-test')!;
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
  }, 30000);
  beforeEach(async () => {
    // Every test starts from the same text, with nothing being edited.
    await post('commitTextEdit', {});
    await setRich(RICH);
    await page.evaluate(`document.querySelector('iframe').focus()`);
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('shows only while rich text is edited, outside the text itself', async () => {
    await expect.poll(() => toolbar().count()).toBe(0);
    await beginEdit('h');
    expect(await toolbar().count()).toBe(0);
    await post('commitTextEdit', {});
    await beginEdit('r');
    await expect.poll(() => toolbar().count()).toBe(1);
    expect(await rich()).toBe(RICH);
    await post('commitTextEdit', {});
    await expect.poll(() => toolbar().count()).toBe(0);
  });

  it('adds, changes and removes a link on selected words with the pointer alone', async () => {
    await beginEdit('r');
    await select('words');
    await button('Link').click();
    const field = frame.getByRole('textbox', { name: 'Link destination' });
    await field.fill('/about/');
    await field.press('Enter');
    await expect.poll(rich).toContain('Intro <a href="/about/">words</a> here');
    // The caret in a link: the button edits it.
    await select('words', 2);
    await button('Edit link').click();
    expect(await field.inputValue()).toBe('/about/');
    await field.fill('example.com');
    await frame.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(rich).toContain('<a href="https://example.com">words</a>');
    await select('words', 2);
    await button('Edit link').click();
    await frame.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect.poll(rich).toContain('<p>Intro words here</p>');
    expect(await frame.getAttribute('[data-so-node="r"]', 'contenteditable')).toBe('true');
    expect((await messages()).map((m) => m.type)).not.toContain('textCommit');
  });

  it('makes a paragraph a list item, numbers the list, and takes the item out again, each one Undo step', async () => {
    await beginEdit('r');
    await select('Outro', 1);
    await button('Bulleted list').click();
    // A paragraph next to a list of its kind joins it, as it would once saved.
    await expect.poll(rich).toMatch(/<li>Gamma<\/li><li>Outro<\/li><\/ul>$/);
    expect(await button('Bulleted list').getAttribute('aria-pressed')).toBe('true');
    await button('Numbered list').click();
    await expect.poll(rich).toMatch(/^<p>Intro words here<\/p><ol class="so-rich--number"><li>Alpha<\/li>.*<li>Outro<\/li><\/ol>$/);
    expect(await button('Numbered list').getAttribute('aria-pressed')).toBe('true');
    await undo();
    await expect.poll(rich).toMatch(/<li>Gamma<\/li><li>Outro<\/li><\/ul>$/);
    await redo();
    await expect.poll(rich).toMatch(/<li>Outro<\/li><\/ol>$/);
    // Redo leaves the whole list selected: with the caret in one item, only that item leaves the list.
    await select('Outro', 1);
    await button('Numbered list').click();
    await expect.poll(rich).not.toContain('<li>Outro');
    expect(await committed()).toEqual([
      { type: 'p', spans: [{ text: 'Intro words here' }] },
      { type: 'ol', items: [[{ text: 'Alpha' }], [{ text: 'Beta', strong: true }, { text: ' ' }, { text: 'link', link: { type: 'page', target: 'pg_about' } }], [{ text: 'Gamma' }]] },
      { type: 'p', spans: [{ text: 'Outro' }] }
    ]);
  });

  it('switches a whole list to the other kind with the caret in one item, and back, each one Undo step', async () => {
    await beginEdit('r');
    await select('Beta', 2);
    await button('Numbered list').click();
    await expect.poll(rich).toBe('<p>Intro words here</p><ol class="so-rich--number"><li>Alpha</li><li><strong>Beta</strong> <a href="/about/">link</a></li><li>Gamma</li></ol><p>Outro</p>');
    // The caret stays where it was, so the next command acts on the same item.
    expect(await frame.evaluate(`[getSelection().anchorNode.textContent, getSelection().anchorOffset, getSelection().isCollapsed]`)).toEqual(['Beta', 2, true]);
    expect(await button('Numbered list').getAttribute('aria-pressed')).toBe('true');
    await undo();
    await expect.poll(rich).toBe(RICH);
    await redo();
    await button('Bulleted list').click();
    await expect.poll(rich).toBe('<p>Intro words here</p><ul class="so-rich--bullet"><li>Alpha</li><li><strong>Beta</strong> <a href="/about/">link</a></li><li>Gamma</li></ul><p>Outro</p>');
  });

  it('adds, moves and removes list items, keeping their marks and links, each one Undo step', async () => {
    await beginEdit('r');
    await select('Beta', 2);
    expect(await button('Move item up').getAttribute('aria-disabled')).toBeNull();
    await button('Move item up').click();
    await expect.poll(rich).toContain('<ul class="so-rich--bullet"><li><strong>Beta</strong> <a href="/about/">link</a></li><li>Alpha</li><li>Gamma</li></ul>');
    expect(await button('Move item up').getAttribute('aria-disabled')).toBe('true');
    // The caret stays in the moved item's words, where it was in them.
    expect(await frame.evaluate(`[getSelection().anchorNode.textContent, getSelection().anchorOffset]`)).toEqual(['Beta', 2]);
    await button('Move item down').click();
    await button('Move item down').click();
    await expect.poll(rich).toContain('<ul class="so-rich--bullet"><li>Alpha</li><li>Gamma</li><li><strong>Beta</strong> <a href="/about/">link</a></li></ul>');
    expect(await button('Move item down').getAttribute('aria-disabled')).toBe('true');
    await undo();
    await expect.poll(rich).toContain('<ul class="so-rich--bullet"><li>Alpha</li><li><strong>Beta</strong> <a href="/about/">link</a></li><li>Gamma</li></ul>');
    await button('Add item').click();
    // The new item's words are selected, so typing replaces them.
    expect(await frame.evaluate(`getSelection().toString()`)).toBe('New item');
    await page.keyboard.type('Delta');
    await expect.poll(rich).toContain('<li>Delta</li><li>Gamma</li>');
    await select('Alpha', 1);
    await button('Remove item').click();
    await expect.poll(rich).toContain('<ul class="so-rich--bullet"><li><strong>Beta</strong>');
    await undo();
    await expect.poll(rich).toContain('<ul class="so-rich--bullet"><li>Alpha</li>');
    expect(await committed()).toEqual([
      { type: 'p', spans: [{ text: 'Intro words here' }] },
      { type: 'ul', items: [[{ text: 'Alpha' }], [{ text: 'Beta', strong: true }, { text: ' ' }, { text: 'link', link: { type: 'page', target: 'pg_about' } }], [{ text: 'Delta' }], [{ text: 'Gamma' }]] },
      { type: 'p', spans: [{ text: 'Outro' }] }
    ]);
  });

  it('leaves an empty item to type in when the only item is removed', async () => {
    await setRich('<p>Intro</p><ol class="so-rich--number"><li>Only</li></ol><p>Outro</p>');
    await beginEdit('r');
    await frame.evaluate(`getSelection().collapse(document.querySelector('[data-so-node="r"] li').firstChild, 2)`);
    await button('Remove item').click();
    await expect.poll(rich).toBe('<p>Intro</p><ol class="so-rich--number"><li><br></li></ol><p>Outro</p>');
    await page.keyboard.type('Again');
    await expect.poll(rich).toBe('<p>Intro</p><ol class="so-rich--number"><li>Again</li></ol><p>Outro</p>');
  });

  it('sits below the text, clear of the editor’s selection chip above it', async () => {
    await beginEdit('r');
    await expect.poll(() => toolbar().count()).toBe(1);
    const text = await frame.locator('[data-so-node="r"]').boundingBox();
    const bar = await toolbar().boundingBox();
    expect(bar!.y).toBeGreaterThanOrEqual(text!.y + text!.height);
  });

  it('shows the markers of a list it makes at once, as the site draws them from the list’s class', async () => {
    await setRich('<p>One</p><h3>Heading</h3><p>Two</p>');
    await beginEdit('r');
    await select('One', 1);
    await button('Bulleted list').click();
    // The browser puts a list made from a lone paragraph inside it; the editor reads that as the list alone.
    await expect.poll(rich).toBe('<p><ul class="so-rich--bullet"><li>One</li></ul></p><h3>Heading</h3><p>Two</p>');
    await select('Two', 1);
    await button('Numbered list').click();
    await expect.poll(rich).toBe('<p><ul class="so-rich--bullet"><li>One</li></ul></p><h3>Heading</h3><p><ol class="so-rich--number"><li>Two</li></ol></p>');
    expect(await committed()).toEqual([{ type: 'ul', items: [[{ text: 'One' }]] }, { type: 'h3', spans: [{ text: 'Heading' }] }, { type: 'ol', items: [[{ text: 'Two' }]] }]);
  });

  it('turns a whole check list into a bulleted one, keeping the paragraph after it, in one Undo step', async () => {
    const CHECK = '<p>Intro</p><ul class="so-rich--check"><li>A <a href="/about/">link</a></li><li>B</li></ul><p>Outro</p>';
    await setRich(CHECK);
    await beginEdit('r');
    await select('B', 1);
    expect(await button('Bulleted list').getAttribute('aria-pressed')).toBe('false');
    await button('Bulleted list').click();
    await expect.poll(rich).toBe('<p>Intro</p><ul class="so-rich--bullet"><li>A <a href="/about/">link</a></li><li>B</li></ul><p>Outro</p>');
    expect(await frame.evaluate(`[getSelection().anchorNode.textContent, getSelection().anchorOffset]`)).toEqual(['B', 1]);
    expect(await button('Bulleted list').getAttribute('aria-pressed')).toBe('true');
    await undo();
    await expect.poll(rich).toBe(CHECK);
  });

  it('makes a check list a numbered one with Numbered list', async () => {
    await setRich('<p>Intro</p><ul class="so-rich--check"><li>A</li><li>B</li></ul><p>Outro</p>');
    await beginEdit('r');
    await select('B', 1);
    await button('Numbered list').click();
    await expect.poll(rich).toBe('<p>Intro</p><ol class="so-rich--number"><li>A</li><li>B</li></ol><p>Outro</p>');
  });

  it('moves to the top of the window, away from the text’s top, when there is no room below the text', async () => {
    await frame.evaluate(`document.body.style.paddingTop = '430px'`);
    try {
      await beginEdit('r');
      await expect.poll(() => toolbar().count()).toBe(1);
      const text = await frame.locator('[data-so-node="r"]').boundingBox();
      const bar = await toolbar().boundingBox();
      expect(bar!.y + bar!.height).toBeLessThan(text!.y);
      expect(bar!.y).toBeLessThan(20);
    } finally {
      await post('commitTextEdit', {});
      await frame.evaluate(`document.body.style.paddingTop = ''`);
    }
  });

  it('keeps the caret on its item when the list it switches to joins a list beside it, and keeps a selection’s direction', async () => {
    await setRich('<ol class="so-rich--number"><li>First</li></ol><ul class="so-rich--bullet"><li>Target</li><li>Last</li></ul>');
    await beginEdit('r');
    await select('Target', 2);
    await button('Numbered list').click();
    await expect.poll(rich).toBe('<ol class="so-rich--number"><li>First</li><li>Target</li><li>Last</li></ol>');
    expect(await frame.evaluate(`[getSelection().anchorNode.textContent, getSelection().anchorOffset]`)).toEqual(['Target', 2]);
    await button('Remove item').click();
    await expect.poll(rich).toBe('<ol class="so-rich--number"><li>First</li><li>Last</li></ol>');
    // A selection made backwards (Shift+Left) still runs backwards after the switch.
    await frame.evaluate(`(() => { const t = [...document.querySelectorAll('[data-so-node="r"] li')].find((li) => li.textContent === 'Last').firstChild; getSelection().setBaseAndExtent(t, 3, t, 1); })()`);
    await button('Bulleted list').click();
    await expect.poll(rich).toContain('<ul');
    expect(await frame.evaluate(`[getSelection().anchorNode.textContent, getSelection().anchorOffset, getSelection().focusOffset]`)).toEqual(['Last', 3, 1]);
  });

  it('keeps two links to the same place apart when their words have the same marks', async () => {
    await setRich('<p><a href="/about/">First</a> <a href="/about/">second</a></p>');
    await beginEdit('r');
    await select('second', 2);
    await button('Edit link').click();
    await frame.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect.poll(rich).toBe('<p><a href="/about/">First</a> second</p>');
  });

  it('changes and removes a link over words with different marks as one link', async () => {
    // As the page shows it: the parts of one link, with the page's own markers between them.
    await setRich('<p>Meet <a href="/about/"><strong>local</strong></a><!----> <a href="/about/">makers</a> today</p>');
    await beginEdit('r');
    await select('makers', 2);
    await button('Edit link').click();
    const field = frame.getByRole('textbox', { name: 'Link destination' });
    await field.fill('example.com');
    await field.press('Enter');
    await expect.poll(async () => (await rich()).match(/href="https:\/\/example\.com"/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(await rich()).not.toContain('/about/');
    await select('makers', 2);
    await button('Edit link').click();
    await frame.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect.poll(rich).not.toContain('<a');
    expect(await rich()).toContain('<strong>local</strong>');
  });

  it('keeps typing after removing the only item its own Undo step', async () => {
    await setRich('<p>Intro</p><ol class="so-rich--number"><li>Only</li></ol><p>Outro</p>');
    await beginEdit('r');
    await frame.evaluate(`getSelection().collapse(document.querySelector('[data-so-node="r"] li').firstChild, 2)`);
    await button('Remove item').click();
    await page.keyboard.type('Again');
    await expect.poll(rich).toBe('<p>Intro</p><ol class="so-rich--number"><li>Again</li></ol><p>Outro</p>');
    await undo();
    await expect.poll(rich).toBe('<p>Intro</p><ol class="so-rich--number"><li><br></li></ol><p>Outro</p>');
    await undo();
    await expect.poll(rich).toBe('<p>Intro</p><ol class="so-rich--number"><li>Only</li></ol><p>Outro</p>');
  });

  it('starts no edit asked for after the page went to Preview, and tells the editor so', async () => {
    await page.evaluate(`window.seen = []`);
    await post('mode', { mode: 'preview' });
    await post('beginTextEdit', { desc: { ctx: 'page:p', node: 'r', items: '' }, editId: 'late' });
    await expect.poll(async () => (await messages()).find((m) => m.type === 'textCancel')?.payload.editId).toBe('late');
    expect(await toolbar().count()).toBe(0);
    expect(await frame.getAttribute('[data-so-node="r"]', 'contenteditable')).toBeNull();
    await post('mode', { mode: 'edit' });
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
  });

  it('works from the keyboard: Tab reaches the toolbar, its commands keep the edit, and Tab onward ends it', async () => {
    await beginEdit('r');
    await select('Gamma', 2);
    await page.keyboard.press('Tab');
    await expect.poll(() => frame.evaluate(focusedButton)).toBe('Link');
    // Arrow keys move along it; Enter runs the focused command on the text's selection and goes back to the text.
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => frame.evaluate(focusedButton)).toBe('Move item up');
    await page.keyboard.press('Enter');
    await expect.poll(rich).toContain('<ul class="so-rich--bullet"><li>Alpha</li><li>Gamma</li><li><strong>Beta</strong> <a href="/about/">link</a></li></ul>');
    expect(await frame.evaluate(`document.activeElement && document.activeElement.getAttribute('data-so-node')`)).toBe('r');
    // Shift+Tab and Escape in the toolbar go back to the text too, with the selection it had.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    expect(await frame.evaluate(`document.activeElement && document.activeElement.getAttribute('data-so-node')`)).toBe('r');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    expect(await frame.evaluate(`document.activeElement && document.activeElement.getAttribute('data-so-node')`)).toBe('r');
    expect(await frame.evaluate(`getSelection().anchorNode.textContent`)).toBe('Gamma');
    expect((await messages()).map((m) => m.type)).not.toContain('textCommit');
    // The link field from the keyboard: Enter applies it and goes back to the text.
    await select('Intro');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect.poll(() => frame.getByRole('textbox', { name: 'Link destination' }).count()).toBe(1);
    await page.keyboard.type('/about/');
    await page.keyboard.press('Enter');
    await expect.poll(rich).toContain('<p><a href="/about/">Intro</a> words here</p>');
    // Tab past the toolbar ends the edit, once.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await messages()).filter((m) => m.type === 'textCommit').length).toBe(1);
    await expect.poll(() => toolbar().count()).toBe(0);
  });

  it('is gone, with the text as it was, when the edit is cancelled', async () => {
    await beginEdit('r');
    await select('Outro', 1);
    await button('Bulleted list').click();
    await expect.poll(rich).not.toBe(RICH);
    await frame.focus('[data-so-node="r"]');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await messages()).find((m) => m.type === 'textCancel')?.payload.editId).toBe('e-r');
    expect(await rich()).toBe(RICH);
    expect(await toolbar().count()).toBe(0);
  });
});
