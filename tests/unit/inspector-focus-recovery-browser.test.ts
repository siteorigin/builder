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
  `import * as focus from ${JSON.stringify(resolve('src/renderer/src/lib/inspector-focus'))};`,
  "window.focusLib = focus;",
  "window.stop = focus.recoverInspectorFocus(document.getElementById('dock-panel-inspect'));",
  // Takes a field out of the Inspector, as a new selection's panel does, and says where focus rests two frames later;
  // `then` runs in between, in the frame the recovery queued its focus for.
  'window.remove = (id, then) => new Promise((done) => { document.getElementById(id).remove(); then?.(); requestAnimationFrame(() => requestAnimationFrame(() => done(document.activeElement.id || document.activeElement.tagName))); });'
].join('\n');

const PAGE = `<!doctype html><meta charset="utf-8"><body>
  <div id="dock-panel-inspect"><div class="insp-name"><h3 id="name" tabindex="-1">Heading</h3></div>
    <div><input id="a" aria-label="A"><input id="b" aria-label="B"></div></div>
  <button id="outside">Outside</button>
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

  const run = (js: string) => page.evaluate<string>(js);
  const active = () => run('document.activeElement.id || document.activeElement.tagName');

  it('gives focus to the selection’s name when the focused field is taken away', async () => {
    await page.getByLabel('A').focus();
    expect(await run("remove('a')")).toBe('name');
  });

  it('leaves focus where something else put it while the name’s focus waited for its frame', async () => {
    await page.getByLabel('A').focus();
    expect(await run("remove('a', () => document.getElementById('outside').focus())")).toBe('outside');
  });

  it('leaves focus on the body when a pointer pick on the page changed the selection (#1476)', async () => {
    await page.getByLabel('A').focus();
    // A click on the status bar: focus leaves the field for the body, with no focus event for the Inspector to see.
    await run('document.activeElement.blur()');
    await run('focusLib.forgetInspectorFocus()');
    expect(await run("remove('a')")).toBe('BODY');
  });

  it('gives up a recovery already waiting for its frame when the pick is taken', async () => {
    await page.getByLabel('A').focus();
    expect(await run("remove('a', () => focusLib.forgetInspectorFocus())")).toBe('BODY');
  });

  it('leaves a field the pick did not take where it is', async () => {
    await page.getByLabel('A').focus();
    await run('focusLib.forgetInspectorFocus()');
    expect(await run("remove('b')")).toBe('a');
  });

  it('recovers focus that came to the Inspector after the click, when the pick is taken later', async () => {
    await page.getByLabel('A').focus();
    const madeAt = await page.evaluate<number>('performance.now()');
    await page.waitForTimeout(20);
    await page.getByLabel('B').focus();
    await run(`focusLib.forgetInspectorFocus(${madeAt})`);
    expect(await run("remove('b')")).toBe('name');
  });

  it('forgets focus from before the click when the pick is taken later', async () => {
    await page.getByLabel('A').focus();
    await page.waitForTimeout(20);
    const madeAt = await page.evaluate<number>('performance.now()');
    await run(`focusLib.forgetInspectorFocus(${madeAt})`);
    expect(await run("remove('a')")).toBe('BODY');
  });

  it('takes focus off the selection’s name on a pick that leaves the selection as it was, and off nothing else', async () => {
    await run("document.getElementById('name').focus()");
    await run('focusLib.releaseInspectorName()');
    expect(await active()).toBe('BODY');
    await page.getByLabel('A').focus();
    await run('focusLib.releaseInspectorName()');
    expect(await active()).toBe('a');
  });

  it('recovers nothing once it is stopped, and a later pick reaches no stopped recovery', async () => {
    await page.getByLabel('A').focus();
    await run('stop()');
    // Installed again (the Inspector mounted anew): only the new one is told, and it alone recovers.
    await run("window.stop = focusLib.recoverInspectorFocus(document.getElementById('dock-panel-inspect'))");
    await page.getByLabel('B').focus();
    expect(await run("remove('b')")).toBe('name');
    await page.getByLabel('A').focus();
    await run('stop()');
    expect(await run("remove('a')")).toBe('BODY');
  });
});
