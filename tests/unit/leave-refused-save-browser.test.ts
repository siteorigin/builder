/**
 * Leaving a project whose save is refused (its folder moved, so it turned read-only while a field was being typed in)
 * asks before the typed text goes, every time (#1383). Keep editing returns to the field with its text; leaving again
 * sends it again and, refused again, asks again, rather than closing as if nothing were left. Leaving the field after
 * Keep editing keeps the text too, for the next leave to ask about. The real DraftInput, store and leave run in a real
 * browser, against a project that refuses every save, or (for a save that lands) one whose copy catches up when told.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://leave-refused.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

// The Heading field, locked once the project turns read-only, as the Inspector's are.
const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { DraftInput } from ${renderer('components/ui')};`,
  `import { applyOps, getConfirm, markDraft, useStore } from ${renderer('store')};`,
  `import { prepareToLeave } from ${renderer('lib/leave')};`,
  'function App() {',
  "  const [value, setValue] = useState('Saved heading');",
  '  const [locked, setLocked] = useState(false);',
  '  window.lock = () => flushSync(() => setLocked(true));',
  '  window.setSaved = (v) => flushSync(() => setValue(v));',
  "  return h(DraftInput, { className: 'input', ariaLabel: 'Heading', value, readOnly: locked, onCommit: (v) => applyOps([{ type: 'instance.setProp', owner: { kind: 'page', id: 'home' }, nodeId: 'hero', prop: 'heading', value: v }], 'Edit Heading', 'hero:heading') });",
  '}',
  // A page being added and not created yet: something else left open, so leaving asks.
  "window.addingPage = (on) => markDraft('page-add', on);",
  'window.leave = () => {',
  '  window.left = undefined;',
  '  void prepareToLeave(() => undefined).then((ok) => (window.left = ok));',
  '};',
  'window.question = () => getConfirm()?.title ?? null;',
  'window.answer = (ok) => getConfirm().resolve(ok);',
  'window.drafting = () => useStore.getState().drafting;',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(App)));"
].join('\n');

/** The preload bridge: every call answers nothing, except a save. The project refuses it as the main process does once
 *  the folder has moved, or (\`window.saving\`) takes it, its copy catching up only when \`window.catchUp()\` says. */
const BRIDGE = `
  window.saves = [];
  window.saving = false;
  let unseen = null;
  window.catchUp = () => window.setSaved(unseen);
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => {
      if (path !== 'project.apply') return any('');
      const value = args[0].operations[0].value;
      window.saves.push(value);
      if (!window.saving) return Promise.resolve({ ok: false, error: { code: 'SCOPE_MISMATCH', message: 'The project folder was moved or renamed, so changes can’t be saved here.', recoverable: false } });
      unseen = value;
      return Promise.resolve({ ok: true, revision: 1, results: [{}] });
    }
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
        name: 'leave-refused',
        enforce: 'pre',
        // Stylesheets are left out (the page loads the shared ones); a module merely named *.css.ts is code.
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The field did not bundle');
  return chunk.code;
}

const LEAVE_QUESTION = 'Leave without your last change?';

describe.skipIf(!browserInstalled)('leaving a project that refuses its save asks every time', { timeout: 30_000 }, () => {
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
    context = await browser.newContext({ viewport: { width: 600, height: 400 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
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

  const field = () => page.getByRole('textbox', { name: 'Heading' });
  const question = () => page.evaluate<string | null>('window.question()');
  const left = () => page.evaluate<boolean | undefined>('window.left');
  const saves = () => page.evaluate<string[]>('window.saves');
  const focused = () => field().evaluate((el) => el === document.activeElement);
  const drafting = () => page.evaluate<number>('window.drafting()');
  /** Try to leave, and answer the question it asks: Keep editing (false) or Leave without it (true). */
  const leaveAnswering = async (ok: boolean) => {
    await page.evaluate('window.leave()');
    await expect.poll(question).toBe(LEAVE_QUESTION);
    await page.evaluate(`window.answer(${ok})`);
    await expect.poll(left).toBe(ok);
  };

  it('asks again on the next leave after Keep editing, and leaves only when told to', async () => {
    await field().fill('Moved heading');
    // The folder moved: the project is read-only now, and the field with it.
    await page.evaluate('window.lock()');
    await leaveAnswering(false);
    expect(await field().inputValue()).toBe('Moved heading');
    await expect.poll(focused).toBe(true);
    expect(await drafting()).toBe(1);
    // Longer than a field waits before it puts the saved value back once its change is refused.
    await page.waitForTimeout(1_000);
    expect(await field().inputValue()).toBe('Moved heading');
    // Leaving again sends the text again, hears it refused again, and asks again.
    await leaveAnswering(false);
    expect(await saves()).toEqual(['Moved heading', 'Moved heading']);
    expect(await field().inputValue()).toBe('Moved heading');
    expect(await drafting()).toBe(1);
    await page.waitForTimeout(1_000);
    // And once more, this time leaving without it.
    await leaveAnswering(true);
    expect(await saves()).toHaveLength(3);
  });

  it('keeps the text when the field is left after Keep editing, and asks on the next leave', async () => {
    await field().fill('Moved heading');
    await page.evaluate('window.lock()');
    await leaveAnswering(false);
    await expect.poll(focused).toBe(true);
    // Clicking somewhere else sends it again, refused again: the text stays, not saved, past the field's wait.
    await field().evaluate((el) => (el as HTMLElement).blur());
    await expect.poll(saves).toHaveLength(2);
    await page.waitForTimeout(1_000);
    expect(await field().inputValue()).toBe('Moved heading');
    expect(await drafting()).toBe(1);
    // Leaving now, with nothing focused, asks about it, and Keep editing goes back to it.
    await leaveAnswering(false);
    expect(await saves()).toHaveLength(2);
    await expect.poll(focused).toBe(true);
    expect(await field().inputValue()).toBe('Moved heading');
  });

  it('sends a saved edit only once when something else made leaving ask', async () => {
    await page.evaluate('window.saving = true');
    await field().fill('New heading');
    await page.evaluate("window.addingPage(true)");
    await leaveAnswering(false);
    expect(await saves()).toEqual(['New heading']);
    await expect.poll(focused).toBe(true);
    // The project's copy of the saved heading arrives after Keep editing has put focus back.
    await page.evaluate('window.catchUp()');
    await page.evaluate("window.addingPage(false)");
    await page.evaluate('window.leave()');
    await expect.poll(left).toBe(true);
    expect(await question()).toBe(null);
    expect(await saves()).toEqual(['New heading']);
  });
});
