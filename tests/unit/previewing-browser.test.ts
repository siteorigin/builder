/**
 * What the editor says on the body for its stylesheets instead of a `:has()` there (#971), in a real browser with the
 * editor's own stylesheets: the notices stand above the canvas's foot exactly while it holds something and is not inert
 * (src/renderer/src/lib/canvas-foot.ts), and the preview page takes no pointer events while a seam is lit.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://previewing.test';

const ENTRY = [
  `import { canvasFoot } from ${JSON.stringify(resolve('src/renderer/src/lib/canvas-foot'))};`,
  'let stop = null;',
  'let foot = null;',
  // A foot 82px tall whose bottom is 46px above the window's: its top is 128px up, so the notices stand at 140px.
  "window.show = () => { foot = document.createElement('div'); foot.style.cssText = 'position: fixed; bottom: 46px; left: 0; width: 200px; height: 82px'; document.getElementById('holder').append(foot); stop = canvasFoot(foot); };",
  // A bar arriving lifts the foot's top, and the notices with it.
  "window.grow = () => { foot.style.height = '128px'; };",
  // Everything gone from it: it stands at nothing, and the notices take their own place.
  "window.empty = () => { foot.style.height = '0px'; };",
  'window.hide = () => { stop?.(); foot?.remove(); stop = foot = null; };',
  // Let go of the foot while it is still in the page: what follows the page after that is the observer, if it is left.
  'window.letGo = () => { stop?.(); stop = null; };'
].join('\n');

/** The editor's stylesheets that hold the rules: the notices', the seams', the canvas frame's. */
const STYLES = ['styles/primitives.css', 'styles/layout.css', 'panels/Canvas.css'].map((f) => readFileSync(resolve('src/renderer/src', f), 'utf8')).join('\n');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [{ name: 'previewing', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The preview bar did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('the editor’s state on the body', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  beforeEach(async () => {
    page = await (await browser.newContext()).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><meta charset="utf-8"><style>${STYLES}</style><body><div id="root"><div class="editor" id="editor"><div class="canvas-holder" id="holder"></div><div class="frame-box"><iframe></iframe></div></div><div class="toasts"></div></div><script src="/app.js"></script>`
          })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  /** Where the notices sit, once the page (and the foot's observers) have taken in the last change. */
  const notices = () => page.evaluate<string>("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(getComputedStyle(document.querySelector('.toasts')).bottom))))");
  const inert = (id: string, on: boolean) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).inert = ${on}`);

  it('keeps the notices above the canvas’s foot exactly while it holds something and is not inert', async () => {
    expect(await notices()).toBe('40px');
    await page.evaluate('show()');
    expect(await notices()).toBe('140px');
    // A bar arriving (or one wrapping) lifts the foot's top, and the notices follow it.
    await page.evaluate('grow()');
    expect(await notices()).toBe('186px');
    // Under the post writer or the SEO view, in a project being left, behind a dialog: the foot is inert.
    for (const id of ['holder', 'editor', 'root']) {
      await inert(id, true);
      expect(await notices(), `${id} inert`).toBe('40px');
      await inert(id, false);
      expect(await notices(), `${id} live again`).toBe('186px');
    }
    await page.evaluate('empty()');
    expect(await notices()).toBe('40px');
    await page.evaluate('grow()');
    await page.evaluate('hide()');
    expect(await notices()).toBe('40px');
    // Gone, it no longer follows the page: an inert change after it says nothing.
    await inert('holder', true);
    await inert('holder', false);
    expect(await notices()).toBe('40px');
  });

  it('starts from whether the foot is inert when it appears, and stops following the page when let go', async () => {
    await inert('editor', true);
    await page.evaluate('show()');
    expect(await notices()).toBe('40px');
    await inert('editor', false);
    expect(await notices()).toBe('140px');
    // Let go while still in the page: an inert change after it no longer puts the offset back.
    await page.evaluate('letGo()');
    expect(await notices()).toBe('40px');
    await inert('holder', true);
    await inert('holder', false);
    expect(await notices()).toBe('40px');
  });

  it('turns the preview page’s pointer events off while either seam is lit', async () => {
    const events = () => page.evaluate<string>("getComputedStyle(document.querySelector('.frame-box iframe')).pointerEvents");
    expect(await events()).toBe('auto');
    for (const side of ['left', 'right']) {
      await page.evaluate(`document.body.classList.add('splitting-${side}')`);
      expect(await events(), side).toBe('none');
      await page.evaluate(`document.body.classList.remove('splitting-${side}')`);
      expect(await events(), side).toBe('auto');
    }
    // Both lit (one dragged while the other's menu is open): off until neither is.
    await page.evaluate("document.body.classList.add('splitting-left', 'splitting-right')");
    expect(await events()).toBe('none');
    await page.evaluate("document.body.classList.remove('splitting-left')");
    expect(await events()).toBe('none');
    await page.evaluate("document.body.classList.remove('splitting-right')");
    expect(await events()).toBe('auto');
  });
});
