/**
 * The Inspector's focus recovery in a real browser (#1476). A control taken out of the Inspector with focus on it hands
 * focus to the selection's name, but not when a press of the pointer on the page made the selection: the click reached
 * only the page's frame, so the name would be ringed as if the keyboard had moved there, and the body would lose the
 * keyboard the selection's keys need (#1361). Focus that comes back to the Inspector after such a pick is recovered.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://inspector-focus.test';

const ENTRY = [
  `import { forgetInspectorFocus, recoverInspectorFocus } from ${JSON.stringify(resolve('src/renderer/src/lib/inspector-focus'))};`,
  "window.stop = recoverInspectorFocus(document.getElementById('dock-panel-inspect'));",
  'window.forget = forgetInspectorFocus;'
].join('\n');

const PAGE = `<!doctype html><meta charset="utf-8"><body>
  <div id="dock-panel-inspect"><div class="insp-name"><h3 tabindex="-1">Heading</h3></div>
    <div id="fields"><input id="a" aria-label="A"><input id="b" aria-label="B"></div></div>
  <script src="/app.js"></script>`;

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [{ name: 'inspector-focus', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The recovery did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('Inspector focus recovery', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  beforeEach(async () => {
    page = await (await browser.newContext()).newPage();
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js' ? route.fulfill({ contentType: 'text/javascript', body: script }) : route.fulfill({ contentType: 'text/html', body: PAGE })
    );
    await page.goto(`${SITE}/`);
  });

  /** Take a field out of the Inspector, as a new selection's panel does, and say where focus rests two frames later. */
  const remove = (id: string) =>
    page.evaluate(
      (id) =>
        new Promise<string>((done) => {
          document.getElementById(id)!.remove();
          requestAnimationFrame(() => requestAnimationFrame(() => done(document.activeElement?.tagName ?? 'none')));
        }),
      id
    );

  it('gives focus to the selection’s name when the focused field is taken away', async () => {
    await page.getByLabel('A').focus();
    expect(await remove('a')).toBe('H3');
  });

  it('leaves focus on the body when a pointer pick on the page took the field away (#1476)', async () => {
    await page.getByLabel('A').focus();
    // A click on the status bar: focus leaves the field for the body, with no focus event for the Inspector to see.
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.evaluate(() => (window as unknown as { forget: () => void }).forget());
    expect(await remove('a')).toBe('BODY');
  });

  it('leaves a field the pick did not take where it is', async () => {
    await page.getByLabel('A').focus();
    await page.evaluate(() => (window as unknown as { forget: () => void }).forget());
    expect(await remove('b')).toBe('INPUT');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('a');
  });

  it('recovers focus that came to the Inspector after the pick', async () => {
    await page.getByLabel('A').focus();
    await page.evaluate(() => (window as unknown as { forget: () => void }).forget());
    await page.getByLabel('B').focus();
    expect(await remove('b')).toBe('H3');
  });

  it('recovers nothing once it is stopped', async () => {
    await page.getByLabel('A').focus();
    await page.evaluate(() => (window as unknown as { stop: () => void }).stop());
    expect(await remove('a')).toBe('BODY');
  });
});
