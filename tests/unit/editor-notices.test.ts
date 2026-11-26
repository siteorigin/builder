/**
 * Notices (#827): an error stays until it is dismissed, information goes after four seconds, every notice can be
 * dismissed by pointer and keyboard (over a dialog too), and at most three show. The real notice stack, store and
 * dialogs run in a real browser, on a clock the test moves.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://notices.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Modal, Toasts } from ${renderer('components/ui')};`,
  `import { ConfirmHost } from ${renderer('components/ConfirmDialog')};`,
  `import { applyOps, confirmDialog, markDraft, toast, useStore } from ${renderer('store')};`,
  'function App() {',
  '  const [open, setOpen] = useState(false);',
  '  window.openModal = (on) => flushSync(() => setOpen(on));',
  "  return h('div', null, h('button', { id: 'behind' }, 'Behind'), h(ConfirmHost), h(Toasts),",
  "    open ? h(Modal, { title: 'A dialog', onClose: () => setOpen(false), footer: h('button', { id: 'done' }, 'Done') }, h('input', { id: 'field', 'aria-label': 'Field' })) : null);",
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(App)));",
  'const sync = (fn) => (...args) => { let out; flushSync(() => { out = fn(...args); }); return out; };',
  'window.so = {',
  '  toast: sync((text, kind, label, more) => toast(text, kind, label ? { label, run: () => window.ran.push(label), ...more } : undefined)),',
  '  setState: sync((patch) => useStore.setState(patch)),',
  '  draft: sync((on) => markDraft("field", on)),',
  '  ask: sync(() => void confirmDialog({ title: "Delete it?", body: "It goes.", confirmLabel: "Delete" })),',
  '  edit: () => applyOps([{ type: "page.remove", pageId: "p" }], "Delete page")',
  '};'
].join('\n');

/** The preload bridge: every call answers nothing, except that stopping the AI is recorded. */
const BRIDGE = `
  window.ran = [];
  window.stopped = [];
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => { if (path === 'ai.stop') window.stopped.push(args[0] ?? null); return any(''); }
  });
  window.builder = any('');
`;

const css = ['tokens', 'reset', 'primitives'].map((n) => readFileSync(resolve(`src/renderer/src/styles/${n}.css`), 'utf8')).join('\n');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'notices',
        enforce: 'pre',
        // Stylesheets are left out (the page loads the shared ones); a module merely named *.css.ts is code.
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The notices did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('notices (#827)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.clock.install();
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const say = (text: string, kind = 'error', label?: string, more: Record<string, string> = {}) => page.evaluate(`so.toast(${[text, kind, label ?? null, more].map((a) => JSON.stringify(a)).join(', ')})`);
  const shown = () => page.locator('.toast .toast-text').allTextContents();
  const notice = (text: string) => page.locator('.toast', { hasText: text });
  const dismiss = (text: string) => notice(text).getByRole('button', { name: 'Dismiss notice' });
  /** The text of the notice focus is in, else the focused element's ID or name. */
  const focus = () =>
    page.evaluate<string>(`(() => { const a = document.activeElement; return a.closest('.toast')?.querySelector('.toast-text').textContent ?? (a.id || a.getAttribute('aria-label') || a.textContent || a.tagName); })()`);
  const wait = (ms: number) => page.clock.runFor(ms);
  const awayFromNotices = () => page.mouse.move(2, 2);

  it('keeps an error until it is dismissed, and lets information go after four seconds', async () => {
    const long = `Could not open the project: ${'the manifest is damaged. '.repeat(12)}`;
    await say(long);
    await say('Copied Gallery', 'info');
    await say('Saved', 'success');
    // The installed clock also moves with real time, so the checks leave most of a second to spare.
    await wait(3_000);
    expect(await shown()).toEqual([long, 'Copied Gallery', 'Saved']);
    await wait(1_100);
    await expect.poll(shown).toEqual([long]);
    await say('An error with an action', 'error', 'Copy text');
    await wait(10 * 60_000);
    expect(await shown()).toEqual([long, 'An error with an action']);
    await dismiss('An error with an action').click();
    await dismiss('Could not open').click();
    expect(await shown()).toEqual([]);
  });

  it('shows at most three, and brings an earlier error back as later ones are dismissed', async () => {
    for (const n of [1, 2, 3, 4, 5]) await say(`Error ${n}`);
    expect(await shown()).toEqual(['Error 3', 'Error 4', 'Error 5']);
    // The one under the pointer keeps its place, and still only three show.
    await notice('Error 3').hover();
    await say('Error 6');
    expect(await shown()).toEqual(['Error 3', 'Error 5', 'Error 6']);
    await dismiss('Error 6').click();
    await dismiss('Error 5').click();
    expect(await shown()).toEqual(['Error 2', 'Error 3', 'Error 4']);
  });

  it('says a repeated error once, but keeps the ones whose actions may differ', async () => {
    await say('The project could not be read');
    await say('The project could not be read');
    expect(await shown()).toEqual(['The project could not be read']);
    await say('What you were typing was not saved', 'error', 'Copy text');
    await say('What you were typing was not saved', 'error', 'Copy text');
    expect(await shown()).toHaveLength(3);
  });

  it('dismisses from the keyboard, moving focus to the next notice and then back where it was', async () => {
    await say('First');
    await say('Second');
    await page.locator('#behind').focus();
    await page.keyboard.press('Tab');
    expect(await focus()).toBe('First');
    await page.keyboard.press('Enter');
    expect(await shown()).toEqual(['Second']);
    expect(await focus()).toBe('Second');
    await page.keyboard.press('Space');
    expect(await shown()).toEqual([]);
    expect(await focus()).toBe('behind');
  });

  it('leaves focus where it is when the pointer dismisses', async () => {
    await say('First');
    await say('Second', 'info');
    await page.locator('#behind').focus();
    await dismiss('First').click();
    expect(await shown()).toEqual(['Second']);
    expect(await focus()).toBe('behind');
  });

  it('holds information while focus is in it, until two seconds after it leaves', async () => {
    await say('Copied Gallery', 'info');
    await dismiss('Copied Gallery').focus();
    await wait(60_000);
    expect(await shown()).toEqual(['Copied Gallery']);
    expect(await focus()).toBe('Copied Gallery');
    await page.locator('#behind').focus();
    await wait(1_000);
    expect(await shown()).toEqual(['Copied Gallery']);
    await wait(1_100);
    await expect.poll(shown).toEqual([]);
  });

  it('holds a notice while the pointer is still on it after focus has left', async () => {
    await say('Copied Gallery', 'info');
    await notice('Copied Gallery').hover();
    await dismiss('Copied Gallery').focus();
    await page.locator('#behind').focus();
    await wait(60_000);
    expect(await shown()).toEqual(['Copied Gallery']);
  });

  it('keeps the focused notice in its place when newer ones arrive', async () => {
    await say('First');
    await dismiss('First').focus();
    for (const n of [2, 3, 4]) await say(`Error ${n}`);
    expect(await shown()).toEqual(['First', 'Error 3', 'Error 4']);
  });

  it('moves focus to the earlier notice when the last one is dismissed', async () => {
    await say('First');
    await say('Saved', 'success');
    await dismiss('Saved').focus();
    await page.keyboard.press('Enter');
    expect(await shown()).toEqual(['First']);
    expect(await focus()).toBe('First');
  });

  it('moves focus on when the dismissed notice had it on its action', async () => {
    await say('First');
    await say('Second', 'error', 'Copy text');
    await page.getByRole('button', { name: 'Copy text' }).focus();
    await dismiss('Second').click();
    expect(await focus()).toBe('First');
  });

  it('shows a focused error once when it is raised again', async () => {
    await say('The project could not be read');
    await dismiss('The project could not be read').focus();
    await say('The project could not be read');
    await expect.poll(shown).toEqual(['The project could not be read']);
  });

  it('does not bring expired information back after a dialog', async () => {
    await say('Copied Gallery', 'info');
    await notice('Copied Gallery').hover();
    await page.evaluate(`openModal(true)`);
    await awayFromNotices();
    await wait(10_000);
    await page.evaluate(`openModal(false)`);
    await wait(500);
    expect(await shown()).toEqual([]);
  });

  it('offers a held Undo again after a dialog', async () => {
    await say('Deleted Section', 'info', 'Undo');
    await page.evaluate(`openModal(true)`);
    await wait(10_000);
    expect(await shown()).toEqual([]);
    await page.evaluate(`openModal(false)`);
    await expect.poll(shown).toEqual(['Deleted Section']);
  });

  it('returns focus to what opened a dialog that Escape closed from a notice', async () => {
    await say('First');
    await page.locator('#behind').focus();
    await page.evaluate(`openModal(true)`);
    await page.locator('#done').focus();
    await page.keyboard.press('Tab');
    expect(await focus()).toBe('First');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await wait(100);
    await expect.poll(focus).toBe('behind');
  });

  it('does not keep a held "saved" notice once a new draft begins', async () => {
    await say('Saved', 'success');
    await notice('Saved').hover();
    await page.evaluate(`so.draft(true)`);
    await expect.poll(shown).toEqual([]);
  });

  it('is dismissed over a dialog by keyboard and pointer, leaving the dialog open', async () => {
    await say('First');
    await say('Second');
    await say('Third');
    await page.evaluate(`openModal(true)`);
    expect(await focus()).toBe('field');
    // After the dialog's last control come the notices, then the dialog again.
    await page.locator('#done').focus();
    await page.keyboard.press('Tab');
    expect(await focus()).toBe('First');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect(await focus()).toBe('Third');
    await page.keyboard.press('Tab');
    expect(await focus()).toBe('Close');
    await page.keyboard.press('Shift+Tab');
    expect(await focus()).toBe('Third');
    await page.keyboard.press('Shift+Tab');
    expect(await focus()).toBe('Second');
    await page.keyboard.press('Enter');
    expect(await shown()).toEqual(['First', 'Third']);
    expect(await focus()).toBe('Third');
    await dismiss('First').click();
    expect(await shown()).toEqual(['Third']);
    await page.keyboard.press('Enter');
    expect(await shown()).toEqual([]);
    expect(await focus()).toBe('Close');
    expect(await page.getByRole('dialog').count()).toBe(1);
  });

  it('is dismissed from the keyboard over a question, which keeps other outside keys for its safe choice', async () => {
    await say('First');
    await page.evaluate(`so.ask()`);
    await wait(500);
    await expect.poll(focus).toBe('Cancel');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect(await focus()).toBe('First');
    await page.keyboard.press('Space');
    expect(await shown()).toEqual([]);
    expect(await page.getByRole('dialog').count()).toBe(1);
  });

  it('never brings back a notice dismissed while a dialog held its action', async () => {
    await say('Deleted Section', 'info', 'Undo');
    await page.evaluate(`openModal(true)`);
    await dismiss('Deleted Section').click();
    await wait(10_000);
    await page.evaluate(`openModal(false)`);
    await awayFromNotices();
    await wait(1_000);
    expect(await shown()).toEqual([]);
  });

  it('keeps information focus is in over a dialog', async () => {
    await page.evaluate(`openModal(true)`);
    await say('Copied Gallery', 'info');
    await dismiss('Copied Gallery').focus();
    await wait(60_000);
    expect(await shown()).toEqual(['Copied Gallery']);
  });

  const snapshot = (workspaceKey: string, aiRunId: string | null) =>
    page.evaluate(`so.setState({ snapshot: { dir: 'd', workspaceKey: ${JSON.stringify(workspaceKey)}, revision: 1, aiBusy: ${aiRunId !== null}, aiRunId: ${JSON.stringify(aiRunId)}, conflicts: [], state: { site: { pageOrder: [] }, pages: {}, components: {}, collections: {} } } })`);

  it('withdraws an action into another project once that one opens, keeping its notice', async () => {
    await snapshot('one', null);
    await say('Part of the post is not saved', 'error', 'Open SEO view', { opening: 'one' });
    const open = page.getByRole('button', { name: 'Open SEO view' });
    expect(await open.count()).toBe(1);
    await snapshot('two', null);
    await expect.poll(() => open.count()).toBe(0);
    expect(await shown()).toEqual(['Part of the post is not saved']);
  });

  it('offers Stop AI only for the request it was raised during', async () => {
    const running = (aiRunId: string) => snapshot('k', aiRunId);
    await running('a');
    await page.evaluate(`so.edit()`);
    await page.evaluate(`so.edit()`);
    const stop = page.getByRole('button', { name: 'Stop AI' });
    await expect.poll(() => stop.count()).toBe(1);
    expect(await shown()).toHaveLength(1);
    await running('b');
    await expect.poll(() => stop.count()).toBe(0);
    expect(await shown()).toHaveLength(1);
    await running('a');
    await stop.click();
    expect(await page.evaluate(`stopped`)).toEqual(['a']);
  });
});
