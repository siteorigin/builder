/**
 * Opening a list item in the inspector reveals it on the page: the real preview bridge, in a real browser frame,
 * opens the item's disclosure (an FAQ answer), outlines it and follows the item the inspector has open, by item
 * id and placement, never by label or position. It only ever closes again what it opened itself, and shows typed
 * text without taking the page's own text away from it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

/** One FAQ question as the generator instruments it: every element of the item carries its item ids. */
const item = (ctx: string, id: string, question: string, answer: string, open = false) =>
  `<details data-so-ctx="${ctx}" data-so-node="item" data-so-items="${id}"${open ? ' open' : ''}>` +
  `<summary data-so-ctx="${ctx}" data-so-node="summary" data-so-items="${id}"><span data-so-ctx="${ctx}" data-so-node="question" data-so-items="${id}">${question}</span></summary>` +
  `<p data-so-ctx="${ctx}" data-so-node="answer" data-so-items="${id}">${answer}</p></details>` +
  `<hr data-so-ctx="${ctx}" data-so-node="item-divider" data-so-items="${id}">`;

// faq: two questions share a label, the third is already open (as a visitor would find it). faq2: a second placement
// reuses an item id. faq3: the list is repeated inside another list's rows. faq4: one item's id contains the other's
// after a comma, and another list of the section reuses an id. faq5: a design that wraps each question's disclosure in a row of its own, all inside a disclosure.
const FRAME = `<!doctype html><html><head><style>body{margin:0}.spacer{height:1500px}</style></head><body>
<section data-so-ctx="page:p" data-so-node="faq"><div class="spacer"></div>
${item('page:p|faq', 'a', 'Same question?', 'Answer A')}
${item('page:p|faq', 'b', 'Same question?', 'Answer B')}
${item('page:p|faq', 'c', 'Other question?', 'Answer C', true)}
</section>
<section data-so-ctx="page:p" data-so-node="faq2">${item('page:p|faq2', 'b', 'Same question?', 'Answer B, second placement')}</section>
<section data-so-ctx="page:p" data-so-node="faq3">${item('page:p|faq3', 'o1,e', 'Nested?', 'Under the first row')}${item('page:p|faq3', 'o1,f', 'Other nested?', 'Not this one')}${item('page:p|faq3', 'o2,e', 'Nested?', 'Under the second row')}</section>
<section data-so-ctx="page:p" data-so-node="faq4">${item('page:p|faq4', 'e', 'Plain id?', 'E')}${item('page:p|faq4', 'x,e', 'Comma id?', 'X, E')}<details data-so-ctx="page:p|faq4" data-so-node="links-item" data-so-items="e"><summary>Another list, same id</summary></details></section>
<section data-so-ctx="page:p" data-so-node="faq5"><details data-so-ctx="page:p|faq5" data-so-node="outer"><summary>More questions</summary><div data-so-ctx="page:p|faq5" data-so-node="row" data-so-items="w">${item('page:p|faq5', 'w', 'Wrapped?', 'Inside a row')}</div></details></section>
<script type="module" src="/bridge.js"></script></body></html>`;

const HOST = `<!doctype html><title>host</title><input id="field" value="Answer B">
<iframe name="so-test" src="/frame" style="width:600px;height:400px;border:0"></iframe>
<script>
  window.replies = [];
  window.addEventListener('message', (e) => window.replies.push(e.data));
  window.post = (type, payload) => frames[0].postMessage({ protocolVersion: 1, sessionId: 'so-test', type, payload }, '*');
</script>`;

interface State {
  /** The first two placements' disclosures, by placement and item. */
  open: Record<string, boolean>;
  /** The other placements' disclosures. */
  other: Record<string, boolean>;
  scrollY: number;
  focused: string | null;
  revealed: number;
}

describe.skipIf(!browserInstalled)('revealing the list item being edited', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    // Scrolls are instant, so where the page ends up is known when a step ends.
    page = await browser.newPage({ reducedMotion: 'reduce' });
    const origin = 'http://reveal.test';
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (path === '/frame') return route.fulfill({ contentType: 'text/html', body: FRAME });
      return route.fulfill({ contentType: 'text/html', body: HOST });
    });
    await page.goto(`${origin}/`);
    await page.waitForFunction(`window.replies.some((m) => m.type === 'ready')`);
    await page.focus('#field');
  }, 20000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Sends a command, then waits two frames in the page so its effects and the next outline report have landed. */
  const send = async (type: string, payload: unknown) => {
    // Runs in the browser, so it is passed as text (the Node project has no DOM types).
    await page.evaluate(`window.post(${JSON.stringify(type)}, ${JSON.stringify(payload)})`);
    await settle();
  };
  const settle = () => page.frames()[1].evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))`);
  const inFrame = <T>(code: string) => page.evaluate<T>(`(() => { const doc = frames[0].document; ${code} })()`);
  /** Reveal an item, as the editor asks for it: what the FAQ's repeat renders for each item, and where the repeat sits. */
  const FAQ_NODES = ['item', 'summary', 'question', 'answer', 'item-divider'];
  const reveal = (items: string | null, ctx = 'page:p|faq', opts: { text?: string; textNodes?: string[]; nodes?: string[]; within?: string[]; depths?: number[]; restore?: string[] } = {}) =>
    send('reveal', {
      target:
        items === null
          ? null
          : {
              ctx,
              items,
              nodes: opts.nodes ?? ['item', 'item-divider'],
              depths: opts.depths ?? [0],
              within: opts.within ?? FAQ_NODES,
              ...(opts.text === undefined ? {} : { text: { nodes: opts.textNodes ?? ['answer'], value: opts.text } }),
              ...(opts.restore ? { restore: opts.restore } : {})
            }
    });

  /** Which disclosures are open, how far the page is scrolled, what has focus and how many items are outlined. */
  const state = () =>
    inFrame<State>(`
      const open = {};
      const other = {};
      for (const d of doc.querySelectorAll('details')) {
        const at = d.getAttribute('data-so-ctx').split('|')[1];
        const node = d.getAttribute('data-so-node');
        (at === 'faq' || at === 'faq2' ? open : other)[at + ':' + (node === 'item' ? '' : node + ':') + d.getAttribute('data-so-items')] = d.open;
      }
      const rects = window.replies.filter((m) => m.type === 'rects');
      const last = rects[rects.length - 1];
      return { open, other, scrollY: frames[0].scrollY, focused: document.activeElement && document.activeElement.id, revealed: last && Array.isArray(last.payload.revealed) ? last.payload.revealed.length : -1 };
    `);
  const details = (ctx: string, id: string) => `doc.querySelector('details[data-so-ctx="${ctx}"][data-so-items="${id}"]')`;
  const answer = (id: string) => `doc.querySelector('p[data-so-ctx="page:p|faq"][data-so-items="${id}"]')`;
  /** Re-render a question as a fresh, closed element, as a hot update re-mounting the section does. */
  const rerender = async (id: string) => {
    await inFrame(`const old = ${details('page:p|faq', id)}; const fresh = old.cloneNode(true); fresh.open = false; old.replaceWith(fresh);`);
    await settle();
  };

  it('opens the matching disclosure, outlines it and scrolls to it without taking focus', async () => {
    await reveal('b');
    const s = await state();
    expect(s.open).toEqual({ 'faq:a': false, 'faq:b': true, 'faq:c': true, 'faq2:b': false });
    expect(s.scrollY).toBeGreaterThan(0);
    // One outline, around the question: the divider after it is not part of it.
    expect(s.revealed).toBe(1);
    const [outline, box] = await inFrame<unknown[]>(`
      const r = ${details('page:p|faq', 'b')}.getBoundingClientRect();
      const rects = window.replies.filter((m) => m.type === 'rects');
      return [rects[rects.length - 1].payload.revealed[0], { x: r.left, y: r.top, width: r.width, height: r.height }];
    `);
    expect(outline).toEqual(box);
    expect(await inFrame(`const r = ${details('page:p|faq', 'b')}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= frames[0].innerHeight;`)).toBe(true);
    expect(s.focused).toBe('field');
  });

  it('brings the item back into view when the page changes width, and only then', async () => {
    await inFrame(`frames[0].scrollTo(0, 0);`);
    await settle();
    await page.evaluate(`document.querySelector('iframe').style.height = '380px'`);
    await settle();
    await settle();
    expect((await state()).scrollY).toBe(0);
    await page.evaluate(`document.querySelector('iframe').style.width = '420px'`);
    await settle();
    await settle();
    expect((await state()).scrollY).toBeGreaterThan(0);
    expect(await inFrame(`const r = ${details('page:p|faq', 'b')}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= frames[0].innerHeight;`)).toBe(true);
    await page.evaluate(`Object.assign(document.querySelector('iframe').style, { width: '600px', height: '400px' })`);
    await settle();
  });

  it('follows the item the inspector moves to, closing only what it opened itself', async () => {
    await reveal('a');
    expect((await state()).open).toEqual({ 'faq:a': true, 'faq:b': false, 'faq:c': true, 'faq2:b': false });
    // The third question was already open: moving away from it leaves it as it was.
    await reveal('c');
    expect((await state()).open).toEqual({ 'faq:a': false, 'faq:b': false, 'faq:c': true, 'faq2:b': false });
    await reveal('a');
    expect((await state()).open).toEqual({ 'faq:a': true, 'faq:b': false, 'faq:c': true, 'faq2:b': false });
  });

  it('reveals the item in the placement asked for, by id', async () => {
    await reveal('b', 'page:p|faq2');
    expect((await state()).open).toEqual({ 'faq:a': false, 'faq:b': false, 'faq:c': true, 'faq2:b': true });
    await reveal(null);
  });

  it('matches an item id exactly, even one that another id ends with after a comma, and only in its own list', async () => {
    await reveal('e', 'page:p|faq4');
    expect((await state()).other).toMatchObject({ 'faq4:e': true, 'faq4:x,e': false, 'faq4:links-item:e': false });
    await reveal('x,e', 'page:p|faq4');
    expect((await state()).other).toMatchObject({ 'faq4:e': false, 'faq4:x,e': true });
    await reveal(null);
  });

  it('reveals every row an item shows in when its list is repeated inside another list', async () => {
    await reveal('e', 'page:p|faq3', { depths: [1] });
    const s = await state();
    expect(s.other).toMatchObject({ 'faq3:o1,e': true, 'faq3:o1,f': false, 'faq3:o2,e': true });
    expect(s.revealed).toBe(2);
    await reveal(null);
    expect((await state()).other).toMatchObject({ 'faq3:o1,e': false, 'faq3:o1,f': false, 'faq3:o2,e': false });
  });

  it('opens the disclosures the item sits in, whatever the design wraps them in', async () => {
    await reveal('w', 'page:p|faq5', { nodes: ['row'], within: ['row', ...FAQ_NODES] });
    const s = await state();
    expect(s.other).toMatchObject({ 'faq5:outer:null': true, 'faq5:w': true });
    expect(s.revealed).toBe(1);
    await reveal(null);
    expect((await state()).other).toMatchObject({ 'faq5:outer:null': false, 'faq5:w': false });
  });

  it('opens it again when the page re-renders it, without scrolling back to it', async () => {
    await reveal('b');
    await inFrame(`frames[0].scrollTo(0, 0);`);
    await rerender('b');
    const s = await state();
    expect(s.open['faq:b']).toBe(true);
    expect(s.scrollY).toBe(0);
    expect(s.focused).toBe('field');
    // A question the bridge opened, taken out of the page and put back after the reveal ended, comes back closed.
    await inFrame(`window.held = ${details('page:p|faq', 'b')}; window.spot = window.held.nextSibling; window.held.remove();`);
    await settle();
    await reveal(null);
    await inFrame(`window.spot.before(window.held);`);
    await settle();
    expect((await state()).open['faq:b']).toBe(false);
  });

  it('leaves Preview with the disclosures as visitors find them, and reveals again back in editing', async () => {
    await reveal('b');
    await send('mode', { mode: 'preview' });
    let s = await state();
    expect(s.open).toEqual({ 'faq:a': false, 'faq:b': false, 'faq:c': true, 'faq2:b': false });
    expect(s.revealed).toBe(0);
    await send('mode', { mode: 'edit' });
    s = await state();
    expect(s.open['faq:b']).toBe(true);
    expect(s.revealed).toBe(1);
  });

  it('closes what it opened once no item is open in the inspector', async () => {
    await reveal('b');
    await reveal(null);
    const s = await state();
    expect(s.open).toEqual({ 'faq:a': false, 'faq:b': false, 'faq:c': true, 'faq2:b': false });
    expect(s.revealed).toBe(0);
  });

  const answerText = () => inFrame<string>(`return ${answer('a')}.textContent;`);
  const ownNodeBack = () => inFrame<boolean>(`return ${answer('a')}.firstChild === window.own && ${answer('a')}.childNodes.length === 1;`);

  it('shows the answer being typed in place of the saved one, and gives the page its own text back once the save arrives', async () => {
    await inFrame(`window.own = ${answer('a')}.firstChild;`);
    await reveal('a', 'page:p|faq', { text: 'A longer answer, typed but not saved yet' });
    expect(await answerText()).toBe('A longer answer, typed but not saved yet');
    expect((await state()).focused).toBe('field');
    await reveal('a', 'page:p|faq', { text: 'A longer answer, typed but not saved yet!' });
    expect(await answerText()).toBe('A longer answer, typed but not saved yet!');
    // Typing ends (the field was left): the typed text stays while the save is on its way, so the old answer never
    // flashes back...
    await reveal('a');
    await page.waitForTimeout(400);
    expect(await answerText()).toBe('A longer answer, typed but not saved yet!');
    expect(await ownNodeBack()).toBe(false);
    // ...and the page's own text node is back as soon as the page has updated it to the saved text.
    await inFrame(`window.own.nodeValue = 'A longer answer, typed but not saved yet!';`);
    await page.waitForTimeout(400);
    expect(await ownNodeBack()).toBe(true);
    expect(await answerText()).toBe('A longer answer, typed but not saved yet!');
  });

  it('gives the page its own text back in the end when the typed text is never saved', async () => {
    await reveal('a', 'page:p|faq', { text: 'Refused' });
    await reveal('a');
    await page.waitForTimeout(4500);
    expect(await ownNodeBack()).toBe(true);
    expect(await answerText()).toBe('A longer answer, typed but not saved yet!');
  }, 10000);

  it('shows an emptied answer as empty, and only for the item being edited', async () => {
    await reveal('a', 'page:p|faq', { text: '' });
    expect(await answerText()).toBe('');
    expect(await inFrame(`return ${answer('b')}.textContent;`)).toBe('Answer B');
    expect(await inFrame(`return ${details('page:p|faq2', 'b')}.querySelector('p').textContent;`)).toBe('Answer B, second placement');
    await inFrame(`window.own.nodeValue = '';`);
    await reveal('a');
    await page.waitForTimeout(400);
    expect(await ownNodeBack()).toBe(true);
    await inFrame(`window.own.nodeValue = 'Answer A';`);
  });

  it('gives the page its own text back at once in Preview, and where typing is cancelled', async () => {
    await reveal('a', 'page:p|faq', { text: 'Typed, then previewed' });
    await send('mode', { mode: 'preview' });
    expect(await ownNodeBack()).toBe(true);
    await send('mode', { mode: 'edit' });
    expect(await answerText()).toBe('Typed, then previewed');
    // The question was typed in and left (its save on the way), then the answer typed and cancelled: only the
    // answer gives up its typed text at once.
    const question = `${details('page:p|faq', 'a')}.querySelector('span')`;
    await inFrame(`window.ownQuestion = ${question}.firstChild;`);
    await reveal('a', 'page:p|faq', { text: 'Typed question?', textNodes: ['question'] });
    await reveal('a');
    await reveal('a', 'page:p|faq', { text: 'Typed, then cancelled' });
    expect(await answerText()).toBe('Typed, then cancelled');
    await reveal('a', 'page:p|faq', { restore: ['answer'] });
    expect(await ownNodeBack()).toBe(true);
    expect(await answerText()).toBe('Answer A');
    expect(await inFrame(`return ${question}.textContent;`)).toBe('Typed question?');
    await inFrame(`window.ownQuestion.nodeValue = 'Typed question?';`);
    await page.waitForTimeout(400);
    expect(await inFrame(`return ${question}.firstChild === window.ownQuestion;`)).toBe(true);
    await inFrame(`window.ownQuestion.nodeValue = 'Same question?';`);
  });

  it('hands the page its own text before the answer is edited on the page itself', async () => {
    await reveal('a', 'page:p|faq', { text: 'Typed in the inspector' });
    await reveal('a');
    await send('beginTextEdit', { desc: { ctx: 'page:p|faq', node: 'answer', items: 'a' }, editId: 'e1' });
    expect(await ownNodeBack()).toBe(true);
    // Left untouched, the edit ends without a save; an update the page makes to its own text still shows.
    await send('commitTextEdit', {});
    await inFrame(`window.own.nodeValue = 'Answer A, updated';`);
    expect(await answerText()).toBe('Answer A, updated');
    await page.waitForTimeout(400);
    expect(await ownNodeBack()).toBe(true);
    await page.focus('#field');
  });

  it('keeps a question the author closed on the page closed, even re-rendered, until its answer is typed again', async () => {
    await reveal('a');
    await reveal('b');
    expect((await state()).open['faq:b']).toBe(true);
    await page.frames()[1].click('details[data-so-ctx="page:p|faq"][data-so-items="b"] > summary');
    await settle();
    expect((await state()).open['faq:b']).toBe(false);
    await rerender('b');
    expect((await state()).open['faq:b']).toBe(false);
    await reveal('b');
    expect((await state()).open['faq:b']).toBe(false);
    // Typing its answer again opens it, so what is typed can be seen.
    await reveal('b', 'page:p|faq', { text: 'Answer B, again' });
    expect((await state()).open['faq:b']).toBe(true);
    await reveal(null);
    expect((await state()).open).toEqual({ 'faq:a': false, 'faq:b': false, 'faq:c': true, 'faq2:b': false });
  });
});
