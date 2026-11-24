/**
 * Writing in site copy on the canvas, with the real preview bridge in a real browser frame on another origin, as the
 * editor's preview is: a double-click starts the edit at the word clicked (not the whole text), a paste brings the
 * formatting the text can hold (Paste and Match Style brings words alone), and Shift+Enter is a line break inside
 * the paragraph, all the way to the blocks the editor stores. The browser's clipboard is its own, never the system's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type CDPSession, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blocksFromDom, richDom } from '../../src/renderer/src/lib/richtext';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

// Both are secure contexts, so the host page can put HTML on the browser's clipboard; they are different sites.
const HOST = 'http://localhost:4717';
const SITE = 'http://127.0.0.1:4717';
const HEADING = 'Harbour Lane Studio';
const PARAGRAPHS = ['First paragraph stays.', 'The second paragraph has a word to change.', 'Teams co<strong>oper</strong>ate on the third.', 'Fourth paragraph stays too.'];
const FRAME = `<!doctype html><html><head><style>body{margin:0;font:20px/1.4 sans-serif}h1,p,div{margin:0;padding:6px}</style></head><body>
<main data-so-node="s" data-so-ctx="page:p">
  <h1 data-so-node="h" data-so-ctx="page:p">${HEADING}</h1>
  <div class="so-rich" data-so-node="r" data-so-ctx="page:p">${PARAGRAPHS.map((t) => `<p>${t}</p>`).join('')}</div>
</main><script type="module" src="/bridge.js"></script></body></html>`;

interface Message {
  type: string;
  payload: { chain?: { ctx: string; node: string; items: string }[]; hit?: string; rich?: unknown; text?: string; editId?: string };
}

/** Messages between frames can take a moment on a busy machine. */
const WAIT = { timeout: 10000 };

let browser: Browser;
let page: Page;
let frame: Frame;
let cdp: CDPSession;

const messages = () => page.evaluate<Message[]>(`window.seen`);
/** Whether an edit started or not, out of everything else the bridge reports meanwhile (geometry, focus). */
const EDIT_MESSAGES = new Set(['textEditStarted', 'textCancel', 'textCommit']);
const editMessages = (ms: Message[]) => ms.filter((m) => EDIT_MESSAGES.has(m.type)).map((m) => m.type);
const selected = () => frame.evaluate<{ text: string; collapsed: boolean }>(`({ text: getSelection().toString(), collapsed: getSelection().isCollapsed })`);
const html = (node: string) => frame.innerHTML(`[data-so-node="${node}"]`);
const editable = (node: string) => frame.getAttribute(`[data-so-node="${node}"]`, 'contenteditable');

/** Where to point at `word` inside the element with this node id: the middle of the character `at` letters in. */
async function pointAt(node: string, word: string, at = 2) {
  return frame.evaluate<{ x: number; y: number }>(`(() => {
    const el = document.querySelector('[data-so-node="${node}"]');
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue.indexOf(${JSON.stringify(word)});
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + ${at});
      r.setEnd(n, i + ${at} + 1);
      const box = r.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    throw new Error('word not found');
  })()`);
}

/** Double-click with real mouse input, and the double-click message the bridge sent the editor. */
async function doubleClick(node: string, word: string, at = 2): Promise<Message> {
  const p = await pointAt(node, word, at);
  // Keys reach the frame once the author has double-clicked into it.
  await page.evaluate(`document.querySelector('iframe').focus()`);
  const before = (await messages()).length;
  await page.mouse.dblclick(p.x, p.y);
  await expect.poll(async () => (await messages()).slice(before).some((m) => m.type === 'dblclick'), WAIT).toBe(true);
  return (await messages()).slice(before).find((m) => m.type === 'dblclick')!;
}

/** The editor's answer to a double-click on text it lets the author edit there (Canvas.tsx does the same). */
async function answer(dbl: Message, hit: string | null = dbl.payload.hit ?? null) {
  const desc = dbl.payload.chain![0];
  const editId = `e-${Math.random().toString(36).slice(2)}`;
  const before = (await messages()).length;
  await post('beginTextEdit', { desc: { ctx: desc.ctx, node: desc.node, items: desc.items }, editId, hit });
  await expect.poll(async () => (await messages()).slice(before).some((m) => m.type === 'textEditStarted' || m.type === 'textCancel'), WAIT).toBe(true);
  return editId;
}

/** Double-click a word and start editing there, as the editor does. */
async function editAt(node: string, word: string, at = 2) {
  const dbl = await doubleClick(node, word, at);
  await answer(dbl);
  await expect.poll(() => editable(node), WAIT).not.toBeNull();
}

/** Commits with ⌘Enter (Control+Enter elsewhere) and returns what the editor would store. */
async function commit() {
  const before = (await messages()).length;
  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => (await messages()).slice(before).some((m) => m.type === 'textCommit'), WAIT).toBe(true);
  const sent = (await messages()).slice(before).find((m) => m.type === 'textCommit')!;
  if (sent.payload.rich === undefined) return sent.payload.text;
  return blocksFromDom(richDom(sent.payload.rich)!, PAGES).blocks;
}

/** Puts HTML and its plain text on the browser's own clipboard. */
async function copy(htmlText: string, plain: string) {
  await page.evaluate(`navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([${JSON.stringify(htmlText)}], { type: 'text/html' }), 'text/plain': new Blob([${JSON.stringify(plain)}], { type: 'text/plain' }) })])`);
}

/** A message from the editor to the frame. */
async function post(type: string, payload: unknown) {
  await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
}

/** Pastes markup straight from another app: a paste event no browser clipboard has cleaned. */
async function pasteRaw(htmlText: string, plain: string) {
  await frame.evaluate(`(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', ${JSON.stringify(htmlText)});
    dt.setData('text/plain', ${JSON.stringify(plain)});
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
}

/** An editing command as the app's Edit menu or its shortcut runs it in the focused frame (paste, pasteAndMatchStyle, undo, redo). */
async function command(name: string) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, commands: [name] });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
}

/** The site's pages, as the editor reads a link's route back to its page. */
const PAGES = { pg_about: { id: 'pg_about', route: '/about/' } };
const p = (...spans: Array<string | Record<string, unknown>>) => ({ type: 'p', spans: spans.map((x) => (typeof x === 'string' ? { text: x } : x)) });
const untouched = [p('First paragraph stays.'), p('The second paragraph has a word to change.'), p('Teams co', { text: 'oper', strong: true }, 'ate on the third.'), p('Fourth paragraph stays too.')];

describe.skipIf(!browserInstalled)('writing in site copy on the canvas', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE && url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.origin === SITE && url.pathname === '/frame') return route.fulfill({ contentType: 'text/html', body: FRAME });
      if (url.origin === HOST) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>host</title><body style="margin:0"><iframe name="so-test" src="${SITE}/frame" style="border:0;width:900px;height:500px"></iframe></body>` });
      return route.abort();
    });
    await page.addInitScript(`if (location.origin === '${HOST}') { window.seen = []; window.addEventListener('message', (e) => { if (e.data && e.data.sessionId === 'so-test') window.seen.push({ type: e.data.type, payload: e.data.payload }); }); }`);
    cdp = await context.newCDPSession(page);
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    await page.goto(`${HOST}/`);
    frame = page.frames().find((f) => f.name() === 'so-test')!;
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
    // A frame on another site takes no input for a moment after it loads: wait until the pointer reaches it.
    const box = (await frame.locator('h1').boundingBox())!;
    await expect
      .poll(async () => {
        await page.mouse.move(box.x + 5 + Math.random() * 20, box.y + box.height / 2);
        return (await messages()).some((m) => m.type === 'hover');
      }, WAIT)
      .toBe(true);
  });

  describe('starting an edit', () => {
    it('selects the word double-clicked, so typing replaces that word and nothing else', async () => {
      await editAt('r', 'word');
      expect(await selected()).toEqual({ text: 'word', collapsed: false });
      await page.keyboard.type('phrase');
      expect(await commit()).toEqual([untouched[0], p('The second paragraph has a phrase to change.'), untouched[2], untouched[3]]);
    });

    it('selects a word that runs across bold letters', async () => {
      await editAt('r', 'oper', 1);
      expect((await selected()).text).toBe('cooperate');
    });

    it('selects the word in a one-line heading too', async () => {
      await editAt('h', 'Lane', 1);
      expect(await selected()).toEqual({ text: 'Lane', collapsed: false });
      expect(await editable('h')).toBe('plaintext-only');
    });

    it('puts a caret, not a selection, where the double-click is on a space', async () => {
      await editAt('h', ' Lane', 0);
      expect((await selected()).collapsed).toBe(true);
      await page.keyboard.type('x');
      expect(await commit()).toMatch(/^Harbour ?x ?Lane Studio$/);
    });

    it('leaves the whole text to Select All', async () => {
      await editAt('r', 'word');
      expect((await selected()).text).toBe('word');
      await page.keyboard.press('ControlOrMeta+A');
      expect((await selected()).text.replace(/\s+/g, ' ').trim()).toBe(PARAGRAPHS.join(' ').replace(/<\/?strong>/g, ''));
    });

    it('leaves a heading’s whole text to Select All too', async () => {
      await editAt('h', 'Lane', 1);
      expect((await selected()).text).toBe('Lane');
      await page.keyboard.press('ControlOrMeta+A');
      expect((await selected()).text).toBe(HEADING);
    });

    it('starts nothing for a double-click the author has since moved on from, and still starts the newer one', async () => {
      const first = await doubleClick('r', 'word');
      const second = await doubleClick('h', 'Studio');
      const before = (await messages()).length;
      const stale = await answer(first);
      expect((await messages()).slice(before).filter((m) => EDIT_MESSAGES.has(m.type)).map((m) => [m.type, m.payload.editId])).toEqual([['textCancel', stale]]);
      expect(await editable('r')).toBeNull();
      await answer(second);
      await expect.poll(() => editable('h'), WAIT).toBe('plaintext-only');
      expect((await selected()).text).toBe('Studio');
    });

    it('starts nothing when the text double-clicked was replaced before the editor answered', async () => {
      const dbl = await doubleClick('r', 'word');
      // The page updates in between: the same text, rendered anew.
      await frame.evaluate(`(() => { const el = document.querySelector('[data-so-node="r"]'); el.replaceWith(el.cloneNode(true)); })()`);
      const before = (await messages()).length;
      await answer(dbl);
      expect(editMessages((await messages()).slice(before))).toEqual(['textCancel']);
      expect(await editable('r')).toBeNull();
    });

    it('starts nothing once the editor has gone to Preview', async () => {
      const dbl = await doubleClick('r', 'word');
      await post('mode', { mode: 'preview' });
      const before = (await messages()).length;
      await answer(dbl);
      expect(editMessages((await messages()).slice(before))).toEqual(['textCancel']);
      expect(await editable('r')).toBeNull();
    });

    it('puts a caret, not the last word, where the double-click is in blank space beside the text', async () => {
      const box = (await frame.locator('h1').boundingBox())!;
      await page.evaluate(`document.querySelector('iframe').focus()`);
      const before = (await messages()).length;
      await page.mouse.dblclick(box.x + box.width - 20, box.y + box.height / 2);
      await expect.poll(async () => (await messages()).slice(before).some((m) => m.type === 'dblclick'), WAIT).toBe(true);
      await answer((await messages()).slice(before).find((m) => m.type === 'dblclick')!);
      await expect.poll(() => editable('h'), WAIT).toBe('plaintext-only');
      expect((await selected()).collapsed).toBe(true);
      await page.keyboard.type(' now');
      expect(await commit()).toBe('Harbour Lane Studio now');
    });

    it('starts at the end of the text when there is no double-click to start from', async () => {
      await page.evaluate(`document.querySelector('iframe').focus()`);
      await answer({ type: 'dblclick', payload: { chain: [{ ctx: 'page:p', node: 'r', items: '' }] } }, null);
      await expect.poll(() => editable('r'), WAIT).toBe('true');
      expect((await selected()).collapsed).toBe(true);
      await page.keyboard.type(' More.');
      expect(await commit()).toEqual([untouched[0], untouched[1], untouched[2], p('Fourth paragraph stays too. More.')]);
    });
  });

  describe('pasting', () => {
    const COPIED = '<meta charset="utf-8"><p>See <b>our studio</b> or <a href="https://example.com/shop" target="_blank">the shop</a>.</p><ul><li>One</li><li>Two</li></ul>';

    it('brings bold words, links and lists from formatted text', async () => {
      await copy(COPIED, 'See our studio or the shop.\nOne\nTwo');
      await editAt('r', 'Fourth');
      await page.keyboard.press('ControlOrMeta+A');
      await command('paste');
      expect(await commit()).toEqual([
        p('See ', { text: 'our studio', strong: true }, ' or ', { text: 'the shop', link: { type: 'url', target: 'https://example.com/shop', newTab: true } }, '.'),
        { type: 'ul', items: [[{ text: 'One' }], [{ text: 'Two' }]] }
      ]);
    });

    it('brings headings, quotes, numbered lists and line breaks', async () => {
      await copy('<meta charset="utf-8"><h2>Title</h2><h5>Small</h5><blockquote>A quote</blockquote><ol><li>First</li><li>Second</li></ol><p>12 Quay Street<br>Port Town</p>', 'Title');
      await editAt('r', 'Fourth');
      await page.keyboard.press('ControlOrMeta+A');
      await command('paste');
      expect(await commit()).toEqual([
        { type: 'h3', spans: [{ text: 'Title' }] },
        { type: 'h4', spans: [{ text: 'Small' }] },
        { type: 'blockquote', spans: [{ text: 'A quote' }] },
        { type: 'ol', items: [[{ text: 'First' }], [{ text: 'Second' }]] },
        p('12 Quay Street\nPort Town')
      ]);
    });

    it('puts a formatted phrase in place of the selected word, inside its paragraph', async () => {
      await copy('<meta charset="utf-8"><span style="font-weight:600">bold</span> <span style="font-style:italic">words</span>', 'bold words');
      await editAt('r', 'word');
      await command('paste');
      expect(await commit()).toEqual([untouched[0], p('The second paragraph has a ', { text: 'bold', strong: true }, ' ', { text: 'words', em: true }, ' to change.'), untouched[2], untouched[3]]);
    });

    it('reads Google Docs’ bold, which it marks with a style inside a wrapper that is not bold', async () => {
      await copy('<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400">Plain then </span><span style="font-weight:700">bold</span></p><ul><li dir="ltr"><p dir="ltr"><span>Item</span></p></li></ul></b>', 'Plain then bold\nItem');
      await editAt('r', 'Fourth');
      await page.keyboard.press('ControlOrMeta+A');
      await command('paste');
      expect(await commit()).toEqual([p('Plain then ', { text: 'bold', strong: true }), { type: 'ul', items: [[{ text: 'Item' }]] }]);
    });

    it('keeps out everything the text cannot hold', async () => {
      await copy(
        '<div class="x" style="color:red"><p>A <a href="javascript:steal()">trap</a> <a href="ftp://example.com/f">near</a> <span class="c" style="color:blue">end</span><img src="/x.png"></p><table><tr><td>Day</td><td>Workshop</td></tr></table></div>',
        'A trap near end'
      );
      await editAt('r', 'Fourth');
      await page.keyboard.press('ControlOrMeta+A');
      await command('paste');
      expect(await html('r')).not.toMatch(/<(img|table|td|span|div)\b|class=|style=|href=/);
      expect(await commit()).toEqual([p('A trap near end'), p('Day Workshop')]);
    });

    it('rebuilds markup the browser has not cleaned, keeping only what the text can hold', async () => {
      // A paste event can carry markup straight from another app, unsanitized.
      await editAt('r', 'word');
      await pasteRaw(
        '<p onclick="steal()">Safe <b onmouseover="steal()">bold</b><img src="/x.png" onerror="steal()"><script>steal()</script><style>p{}</style><iframe src="/x"></iframe><button>Buy now</button><svg><title>Company logo</title></svg><math><mi>Formula</mi></math><a href="javascript:steal()" style="x">plain</a> <a href="file:///etc/hosts">file</a> <a href="//example.com/x">far</a> <a href="tel:office">call</a></p>',
        'Safe bold plain'
      );
      const inserted = await html('r');
      expect(inserted).toContain('<strong>bold</strong>');
      expect(inserted).not.toMatch(/<(img|script|style|iframe|a|button|svg|math)\b|steal|on\w+=|style=|Buy now|Company logo|Formula/);
      expect(await commit()).toEqual([untouched[0], p('The second paragraph has a Safe ', { text: 'bold', strong: true }, 'plain file far call to change.'), untouched[2], untouched[3]]);
    });

    it('keeps a quote’s paragraphs and a nested list’s items apart, in reading order, and a link to the site’s own page', async () => {
      await editAt('r', 'Fourth');
      await page.keyboard.press('ControlOrMeta+A');
      await pasteRaw(
        `<blockquote>\n  <p>First<br></p>Second</blockquote><ul><li>One<ul><li>Inner<ol><li>Deeper</li></ol></li></ul>after</li><li>Two</li></ul><p><a href="${SITE}/about/#team">Our team</a></p>`,
        'First Second'
      );
      expect(await commit()).toEqual([
        { type: 'blockquote', spans: [{ text: 'First' }] },
        { type: 'blockquote', spans: [{ text: 'Second' }] },
        // Lifted out in reading order: what followed the nested list stays after it.
        { type: 'ul', items: [[{ text: 'One' }], [{ text: 'Inner' }], [{ text: 'Deeper' }], [{ text: 'after' }], [{ text: 'Two' }]] },
        p({ text: 'Our team', link: { type: 'page', target: 'pg_about', anchor: 'team' } })
      ]);
    });

    it('reads blocks inside quotes and list items line by line, breaks included', async () => {
      await editAt('r', 'Fourth');
      await page.keyboard.press('ControlOrMeta+A');
      await pasteRaw('<blockquote><p>A</p><p></p>B</blockquote><blockquote><p>Ends<br><br></p></blockquote><ul><li>One<blockquote><ul><li>Inner</li></ul>after</blockquote>tail</li></ul>', 'A B');
      expect(await commit()).toEqual([
        { type: 'blockquote', spans: [{ text: 'A' }] },
        { type: 'blockquote', spans: [{ text: 'B' }] },
        { type: 'blockquote', spans: [{ text: 'Ends\n' }] },
        { type: 'ul', items: [[{ text: 'One' }], [{ text: 'Inner' }], [{ text: 'after' }], [{ text: 'tail' }]] }
      ]);
    });

    it('reads a paste of many nested lists in one pass', async () => {
      await editAt('r', 'word');
      const started = Date.now();
      await pasteRaw('<ul><li>Many' + '<ul></ul>'.repeat(150_000) + '</li></ul>', 'Many');
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await html('r')).toContain('Many');
    }, 20000);

    it('pastes words alone with Paste and Match Style', async () => {
      await copy(COPIED, 'See our studio or the shop.');
      await editAt('r', 'word');
      await command('pasteAndMatchStyle');
      expect(await commit()).toEqual([untouched[0], p('The second paragraph has a See our studio or the shop. to change.'), untouched[2], untouched[3]]);
    });

    it('pastes words alone, on one line, into plain text', async () => {
      await copy(COPIED, 'Bright\nRooms');
      await editAt('h', 'Lane', 1);
      await command('paste');
      expect(await commit()).toBe('Harbour Bright Rooms Studio');
    });

    it('undoes and redoes a formatted paste in one step', async () => {
      await copy(COPIED, 'See our studio or the shop.\nOne\nTwo');
      await editAt('r', 'word');
      const before = await html('r');
      await command('paste');
      const pasted = await html('r');
      expect(pasted).toContain('<strong>our studio</strong>');
      expect(pasted).toContain('<a href="https://example.com/shop" target="_blank">the shop</a>');
      await command('undo');
      expect(await html('r')).toBe(before);
      await command('redo');
      expect(await html('r')).toBe(pasted);
    });

    it('pastes the plain words when the copied markup holds none', async () => {
      await copy('<img src="/x.png">', 'picture caption');
      await editAt('r', 'word');
      await command('paste');
      expect(await commit()).toEqual([untouched[0], p('The second paragraph has a picture caption to change.'), untouched[2], untouched[3]]);
    });

    it('leaves the selection alone when there is nothing to paste', async () => {
      await copy('<img src="/x.png">', '');
      await editAt('r', 'word');
      await command('paste');
      expect(await selected()).toEqual({ text: 'word', collapsed: false });
    });
  });

  describe('line breaks', () => {
    it('keeps Shift+Enter a line break inside the paragraph, apart from Enter’s new paragraph', async () => {
      await editAt('r', 'Fourth');
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('Harbour Lane Studio');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('12 Quay Street');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('Port Town');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Open daily.');
      expect(await commit()).toEqual([p('Harbour Lane Studio\n12 Quay Street\nPort Town'), p('Open daily.')]);
    });

    it('stores one break for one Shift+Enter at the end, not the browser’s placeholder for the empty line', async () => {
      await editAt('r', 'Fourth');
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('A');
      await page.keyboard.press('Shift+Enter');
      expect(await commit()).toEqual([p('A\n')]);
    });

    it('stores two breaks for two Shift+Enters at the end', async () => {
      await editAt('r', 'Fourth');
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type('A');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.press('Shift+Enter');
      expect(await commit()).toEqual([p('A\n\n')]);
    });
  });
});
