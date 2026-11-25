/**
 * The Inspector's state switcher (issue #350) shows the selected element hovered, focused or pressed on the canvas
 * while the pointer is in the dock. This runs the real preview bridge in a real browser frame on another origin, as
 * the editor's preview is, and checks what the page paints: the page's own state rules apply to the selected element
 * as they would under a real hover (keeping the cascade they have), follow a stylesheet the dev server replaces and an
 * element the page re-renders, and stop when the editor clears the state or switches to Preview.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { groupStateSelector } from '@generator/index';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());

const HOST = 'http://host.test';
const SITE = 'http://bridge.test';
const WHITE = 'rgb(255, 255, 255)';
const RED = 'rgb(255, 0, 0)';
const BLUE = 'rgb(0, 0, 255)';
const GREEN = 'rgb(0, 128, 0)';
// Rules as the generator writes them (`:where()` around the state, hover behind a hover-capable pointer), a theme's
// own hover, and a resting rule as heavy as a state rule written after it, which beats it as it does under a real hover.
const CSS = `body { margin: 0; font: 16px/1.4 sans-serif }
.card { background: rgb(255, 255, 255); padding: 10px }
@media (hover: hover) { .card:where(:hover) { background: rgb(255, 0, 0) } }
.card:where(:focus-visible, .so-action:focus-visible > *) { background: rgb(0, 0, 255) }
.card:where(:active, .so-action:active > *) { background: rgb(0, 128, 0) }
.keep { background: rgb(255, 255, 255) }
.linked { background: rgb(255, 255, 255) }
.linked:where(.so-action:focus-visible > *) { background: rgb(0, 0, 255) }
.linked:where(.so-action:active > *) { background: rgb(0, 128, 0) }
.btn { color: rgb(0, 0, 0) }
.btn:hover::after { content: ' +' }
.btn:hover { color: rgb(0, 0, 255) }
.title { color: rgb(0, 0, 0) }
.so-o-k-title:where(:hover) { color: rgb(0, 128, 0) }
.fancy { background: rgb(255, 255, 255) }
.fancy:where(:hover) { background: rgb(255, 0, 0) }
.quoted { color: rgb(0, 0, 0) }
.quoted:hover, [title=":hover"] { color: rgb(255, 0, 0) }
.garrow { color: rgb(0, 0, 0) }
@media (hover: hover) { ${groupStateSelector('.garrow', 'groupHover')} { color: rgb(255, 0, 0) } }
${groupStateSelector('.garrow', 'groupFocus')} { color: rgb(0, 0, 255) }`;
const FRAME = `<!doctype html><html><head><style id="site">${CSS}</style></head><body>
<main data-so-node="s" data-so-ctx="page:p">
  <div class="card" data-so-node="c" data-so-ctx="page:p">Card</div>
  <div class="card" data-so-node="d" data-so-ctx="page:p">Other card</div>
  <div class="card keep" data-so-node="e" data-so-ctx="page:p">Kept card</div>
  <a class="so-action" href="#go"><div class="linked" data-so-node="l" data-so-ctx="page:p">Linked card</div></a>
  <a class="btn" href="#b" data-so-node="b" data-so-ctx="page:p">Button</a>
  <div style="display: contents" data-so-node="k" data-so-ctx="page:p" data-so-code="true"><div class="fancy"><h3 class="title so-o-k-title so-part--title" id="own-title">Title</h3>
    <div style="display: contents" data-so-node="n" data-so-ctx="page:p" data-so-code="true"><h3 class="title so-part--title" id="nested-title">Nested</h3></div></div></div>
  <h3 class="title" id="loose-title">Loose title</h3>
  <p class="quoted" data-so-node="q" data-so-ctx="page:p">Quoted</p>
  <p class="adopt" data-so-node="a" data-so-ctx="page:p">Adopted</p>
  <div class="so-group" data-so-node="g1" data-so-ctx="page:p"><span class="garrow" data-so-node="ga" data-so-ctx="page:p">Outer arrow</span>
    <div class="so-group" data-so-node="g2" data-so-ctx="page:p"><span class="garrow" data-so-node="gb" data-so-ctx="page:p">Inner arrow</span></div></div>
</main><script type="module" src="/bridge.js"></script></body></html>`;

let browser: Browser;
let page: Page;
let frame: Frame;

const desc = (node: string) => ({ ctx: 'page:p', node, items: '' });
// Page code goes in as text: this test project's types have no DOM.
const post = (type: string, payload: unknown) =>
  page.evaluate(`document.querySelector('iframe').contentWindow.postMessage({ protocolVersion: 1, sessionId: 'so-test', type: ${JSON.stringify(type)}, payload: ${JSON.stringify(payload)} }, '*')`);
const force = (state: string | null, node?: string, part?: string) => post('forceState', state && node ? { state, desc: desc(node), ...(part ? { part } : {}) } : { state: null });
const paint = (sel: string, prop = 'backgroundColor', pseudo?: string) => frame.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(sel)}), ${JSON.stringify(pseudo ?? null)})[${JSON.stringify(prop)}]`);
const at = (node: string) => `[data-so-node="${node}"]`;
const marked = () => frame.evaluate<string[]>(`[...document.querySelectorAll('[data-so-force-state]')].map((el) => (el.getAttribute('data-so-node') ?? el.className) + '=' + el.getAttribute('data-so-force-state'))`);

describe.skipIf(!browserInstalled)('showing the selected element in a hover, focus or pressed state', () => {
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
    await page.goto(`${HOST}/`);
    frame = page.frames().find((f) => f.name() === 'so-test')!;
    await frame.waitForSelector('html[data-so-editing]', { state: 'attached' });
    // The pointer stays outside the frame, as it does while the author types in the Inspector.
    await page.mouse.move(690, 495);
    expect(await frame.evaluate<boolean>(`matchMedia('(hover: hover)').matches`)).toBe(true);
  }, 30000);
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    await post('mode', { mode: 'edit' });
    await force(null);
    await expect.poll(marked).toEqual([]);
  });

  it('paints the selected element’s hover rules on it alone, and stops when the state is cleared', async () => {
    expect(await paint(at('c'))).toBe(WHITE);
    await force('hover', 'c');
    await expect.poll(() => paint(at('c'))).toBe(RED);
    expect(await paint(at('d'))).toBe(WHITE);
    expect(await marked()).toEqual(['c=hover']);
    await force(null);
    await expect.poll(() => paint(at('c'))).toBe(WHITE);
    expect(await marked()).toEqual([]);
  });

  it('keeps the cascade a real hover has: a resting rule written later, as heavy, still wins', async () => {
    await force('hover', 'e');
    await expect.poll(marked).toEqual(['e=hover']);
    expect(await paint(at('e'))).toBe(WHITE);
    // Without that rule, the same card shows its hover.
    await frame.evaluate(`document.querySelector('[data-so-node="e"]').classList.remove('keep')`);
    await expect.poll(() => paint(at('e'))).toBe(RED);
    await frame.evaluate(`document.querySelector('[data-so-node="e"]').classList.add('keep')`);
  });

  it('shows focus and pressing on a card through the action link that wraps it', async () => {
    // The card's rules here reach it through its link alone.
    expect(await paint(at('l'))).toBe(WHITE);
    await force('focus', 'l');
    await expect.poll(() => paint(at('l'))).toBe(BLUE);
    expect((await marked()).sort()).toEqual(['l=focus', 'so-action=focus']);
    await force('active', 'l');
    await expect.poll(() => paint(at('l'))).toBe(GREEN);
    expect((await marked()).sort()).toEqual(['l=active', 'so-action=active']);
    // Another selection moves the state to it.
    await force('hover', 'c');
    await expect.poll(marked).toEqual(['c=hover']);
    expect(await paint(at('l'))).toBe(WHITE);
  });

  it('applies a theme’s own hover, pseudo-elements included', async () => {
    expect(await paint(at('b'), 'color')).toBe('rgb(0, 0, 0)');
    expect(await paint(at('b'), 'content', '::after')).toBe('none');
    await force('hover', 'b');
    await expect.poll(() => paint(at('b'), 'color')).toBe(BLUE);
    expect(await paint(at('b'), 'content', '::after')).toBe('" +"');
  });

  it('shows the part of a code component being styled, by the class the editor gives it, and its root for the whole', async () => {
    await force('hover', 'k', 'title');
    await expect.poll(() => paint('#own-title', 'color')).toBe(GREEN);
    // Not the same class inside a code component placed within it, nor a title outside it.
    expect(await marked()).toEqual(['title so-o-k-title so-part--title=hover']);
    expect(await paint('#nested-title', 'color')).toBe('rgb(0, 0, 0)');
    expect(await paint('#loose-title', 'color')).toBe('rgb(0, 0, 0)');
    // A part with no change of its own yet is found by the class the preview gives it all the same.
    await force('hover', 'n', 'title');
    await expect.poll(() => marked()).toEqual(['title so-part--title=hover']);
    await force('hover', 'k', 'title');
    await expect.poll(() => marked()).toEqual(['title so-o-k-title so-part--title=hover']);
    // The whole component: its own root stands in for the wrapper, which lays nothing out.
    expect(await paint('.fancy')).toBe(WHITE);
    await force('hover', 'k');
    await expect.poll(() => paint('.fancy')).toBe(RED);
    expect(await marked()).toEqual(['fancy=hover']);
  });

  it('shows a group state through the interaction groups around the selected element, never on it', async () => {
    expect(await paint(at('gb'), 'color')).toBe('rgb(0, 0, 0)');
    // The inner arrow: its card and the card around that one count as hovered, as a real pointer makes them.
    await force('groupHover', 'gb');
    await expect.poll(marked).toEqual(['g1=hover', 'g2=hover']);
    expect(await paint(at('gb'), 'color')).toBe(RED);
    expect(await paint(at('ga'), 'color')).toBe(RED);
    // The outer arrow: its card alone, so the inner card's arrow stays as it is.
    await force('groupHover', 'ga');
    await expect.poll(marked).toEqual(['g1=hover']);
    expect(await paint(at('ga'), 'color')).toBe(RED);
    expect(await paint(at('gb'), 'color')).toBe('rgb(0, 0, 0)');
    // Focus inside a group has a mark of its own, which an element's own focus never sets.
    await force('groupFocus', 'gb');
    await expect.poll(marked).toEqual(['g1=within', 'g2=within']);
    expect(await paint(at('gb'), 'color')).toBe(BLUE);
    await force('focus', 'gb');
    await expect.poll(marked).toEqual(['gb=focus']);
    expect(await paint(at('gb'), 'color')).toBe('rgb(0, 0, 0)');
    await force(null);
    await expect.poll(marked).toEqual([]);
  });

  it('leaves a quoted state in an attribute value alone, and rewrites the rule around it', async () => {
    await force('hover', 'q');
    await expect.poll(() => paint(at('q'), 'color')).toBe(RED);
    const sel = await frame.evaluate<string>(`[...document.getElementById('site').sheet.cssRules].find((r) => r.selectorText && r.selectorText.includes('title=')).selectorText`);
    expect(sel).toContain('[title=":hover"]');
    expect(sel).toContain('.quoted:is(:hover, [data-so-force-state="hover"])');
  });

  it('rewrites each rule once, however often the state is shown again', async () => {
    const selectors = () =>
      frame.evaluate<string[]>(`[...document.getElementById('site').sheet.cssRules].flatMap((r) => (r instanceof CSSStyleRule ? [r] : [...r.cssRules])).map((r) => r.selectorText)`);
    await force('hover', 'c');
    await expect.poll(() => paint(at('c'))).toBe(RED);
    const once = await selectors();
    expect(once.filter((sel) => sel.includes('data-so-force-state')).length).toBeGreaterThan(5);
    await force('focus', 'c');
    await force('hover', 'c');
    // Another stylesheet arriving and leaving sets the watcher off again.
    await frame.evaluate(`document.head.append(Object.assign(document.createElement('style'), { id: 'blip' }))`);
    await frame.evaluate(`document.getElementById('blip').remove()`);
    await expect.poll(marked).toEqual(['c=hover']);
    expect(await selectors()).toEqual(once);
  });

  it('reaches a stylesheet a script adopts', async () => {
    await frame.evaluate(`(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('.adopt { background: rgb(255, 255, 255) } .adopt:hover { background: rgb(0, 0, 255) }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    })()`);
    expect(await paint(at('a'))).toBe(WHITE);
    await force('hover', 'a');
    await expect.poll(() => paint(at('a'))).toBe(BLUE);
  });

  it('follows a stylesheet the dev server replaces or adds while the state is shown', async () => {
    await force('hover', 'c');
    await expect.poll(() => paint(at('c'))).toBe(RED);
    // A hot update replaces the text of the page's <style>: the hover colour changes.
    await frame.evaluate(`document.getElementById('site').textContent = ${JSON.stringify(CSS.replace('.card:where(:hover) { background: rgb(255, 0, 0) }', '.card:where(:hover) { background: rgb(0, 0, 255) }'))}`);
    await expect.poll(() => paint(at('c'))).toBe(BLUE);
    // A new stylesheet arrives with a stronger hover rule.
    await frame.evaluate(`(() => {
      const style = document.createElement('style');
      style.id = 'added';
      style.textContent = 'main .card:hover { background: rgb(0, 128, 0) }';
      document.head.append(style);
    })()`);
    await expect.poll(() => paint(at('c'))).toBe(GREEN);
    await frame.evaluate(`document.getElementById('added').remove(); document.getElementById('site').textContent = ${JSON.stringify(CSS)}`);
    await expect.poll(() => paint(at('c'))).toBe(RED);
  });

  it('marks the element again when the page re-renders it', async () => {
    await force('hover', 'c');
    await expect.poll(() => paint(at('c'))).toBe(RED);
    await frame.evaluate(`(() => {
      const old = document.querySelector('[data-so-node="c"]');
      const next = old.cloneNode(true);
      next.removeAttribute('data-so-force-state');
      old.replaceWith(next);
    })()`);
    await expect.poll(() => paint(at('c'))).toBe(RED);
    expect(await marked()).toEqual(['c=hover']);
    // A copy the page makes of the marked element, as another element, is not shown in the state.
    await frame.evaluate(`(() => {
      const copy = document.querySelector('[data-so-node="c"]').cloneNode(true);
      copy.setAttribute('data-so-node', 'z');
      document.querySelector('main').append(copy);
    })()`);
    await expect.poll(marked).toEqual(['c=hover']);
    expect(await paint(at('z'))).toBe(WHITE);
    await frame.evaluate(`document.querySelector('[data-so-node="z"]').remove()`);
  });

  it('shows nothing in a state in Preview, and takes no state while it is shown', async () => {
    await force('hover', 'c');
    await expect.poll(() => paint(at('c'))).toBe(RED);
    await post('mode', { mode: 'preview' });
    await expect.poll(() => paint(at('c'))).toBe(WHITE);
    expect(await marked()).toEqual([]);
    await force('hover', 'c');
    await page.waitForTimeout(100);
    expect(await marked()).toEqual([]);
  });

  it('leaves a real hover working on every other element', async () => {
    await force('focus', 'c');
    await expect.poll(marked).toEqual(['c=focus']);
    const box = await (await frame.$(at('d')))!.boundingBox();
    await page.mouse.move(box!.x + 5, box!.y + 5);
    await expect.poll(() => paint(at('d'))).toBe(RED);
    await page.mouse.move(690, 495);
    await expect.poll(() => paint(at('d'))).toBe(WHITE);
  });
});
