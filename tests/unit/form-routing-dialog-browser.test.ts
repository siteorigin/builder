/**
 * The app's own dialog for an AI change to where contact forms send (#1130), in a real browser: the store's waiting
 * question opens it with no chat panel on screen, it shows every address whole with Keep focused, and it answers the
 * question once, Keep for Escape. A question the model asks opens nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://form-routing.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { ConfirmHost } from ${renderer('components/ConfirmDialog')};`,
  `import { FormRoutingHost, useRoutingReviewShown } from ${renderer('components/FormRoutingHost')};`,
  `import { useStore } from ${renderer('store')};`,
  // What the canvas, the chat and the toolbar read to step back while the review is open (#1322).
  "const Shown = () => h('output', { id: 'reviewing' }, String(useRoutingReviewShown()));",
  "const App = () => h('div', null, h('button', { id: 'behind' }, 'Behind'), h(Shown), h(ConfirmHost), h(FormRoutingHost));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(App)));",
  'window.so = { setState: (patch) => flushSync(() => useStore.setState(patch)) };'
].join('\n');

/** The preload bridge: every call answers nothing, except that answers to the AI are recorded and accepted. */
const BRIDGE = `
  window.answers = [];
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => {
      if (path === 'ai.answer') { window.answers.push(args.join(' | ')); return Promise.resolve(true); }
      // Main's copy of a thread, by ID, as reading it answers.
      if (path === 'ai.readConversation') return Promise.resolve({ conversation: (window.threads ?? {})[args[0]], run: null });
      return any('');
    }
  });
  window.builder = any('');
`;

const css = ['tokens', 'reset', 'primitives'].map((n) => readFileSync(resolve(`src/renderer/src/styles/${n}.css`), 'utf8')).join('\n') + readFileSync(resolve('src/renderer/src/components/ConfirmDialog.css'), 'utf8');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'form-routing',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The dialog did not bundle');
  return chunk.code;
}

const LONG = `https://forms.example.com/${'x'.repeat(160)}/inbox-at-the-end`;
const REVIEW = {
  forms: [
    {
      title: '“Contact form” on “Home”',
      rows: [
        { label: 'Form service', before: 'Form endpoint (Formspree, Basin, Getform…)', after: 'Form endpoint (Formspree, Basin, Getform…)' },
        { label: 'Sends to', before: 'https://forms.example.com/sales (Form endpoint URL)', after: `${LONG} (Form endpoint URL)` }
      ]
    }
  ]
};

/** The store as the app has it while run_1 waits on question q_1 (the app's question, unless `formRouting` is dropped). */
const waiting = (question: Record<string, unknown>) => ({
  activeRunId: 'run_1',
  runStatus: 'awaiting-input',
  conversation: {
    id: 'c_1',
    title: 'Forms',
    createdAt: '2026-11-27T09:00:00.000Z',
    messages: [
      { id: 'm_u', role: 'user', text: 'Send the form to the new inbox', time: '2026-11-27T09:00:00.000Z' },
      { id: 'm_a', role: 'assistant', text: '', time: '2026-11-27T09:00:01.000Z', runId: 'run_1', activities: [], questions: [{ id: 'q_1', text: 'Let the assistant change where your contact form sends visitors’ messages?', choices: ['Keep it as it is', 'Allow this change'], ...question }] }
    ]
  }
});

describe.skipIf(!browserInstalled)('the app’s dialog for where forms send (#1130)', { timeout: 30_000 }, () => {
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

  const setState = (patch: unknown) => page.evaluate(`so.setState(${JSON.stringify(patch)})`);
  const answers = () => page.evaluate<string[]>('window.answers');
  const dialog = () => page.getByRole('dialog', { name: 'Change where your form sends?' });

  it('opens with every address whole, Keep focused, and keeps it as it is on Escape', async () => {
    await setState(waiting({ formRouting: REVIEW }));
    await expect.poll(() => dialog().isVisible()).toBe(true);
    const text = await dialog().innerText();
    expect(text).toContain('“Contact form” on “Home”');
    expect(text).toContain('https://forms.example.com/sales (Form endpoint URL)');
    expect(text).toContain(`${LONG} (Form endpoint URL)`);
    await expect.poll(() => page.evaluate<string>('document.activeElement?.textContent ?? ""')).toBe('Keep it as it is');
    await page.keyboard.press('Escape');
    await expect.poll(answers).toEqual(['run_1 | q_1 | Keep it as it is']);
    expect(await dialog().count()).toBe(0);
  });

  it('allows the change only from Allow, once, and asks nothing again for the same question', async () => {
    await setState(waiting({ formRouting: REVIEW }));
    await dialog().getByRole('button', { name: 'Allow this change' }).click();
    await expect.poll(answers).toEqual(['run_1 | q_1 | Allow this change']);
    // The same question shown again before its answer arrives opens nothing more.
    await setState(waiting({ formRouting: REVIEW }));
    expect(await dialog().count()).toBe(0);
    expect(await answers()).toHaveLength(1);
  });

  it('is taken back, unanswered, when the question stops waiting', async () => {
    await setState(waiting({ formRouting: REVIEW }));
    await expect.poll(() => dialog().isVisible()).toBe(true);
    await setState({ runStatus: null, activeRunId: null });
    await expect.poll(() => dialog().count()).toBe(0);
    expect(await answers()).toEqual([]);
  });

  it('opens for a question waiting in another thread than the one on screen, and stays while threads switch (#1125)', async () => {
    const state = waiting({ formRouting: REVIEW });
    await page.evaluate(`window.threads = { c_1: ${JSON.stringify(state.conversation)} }`);
    const other = { id: 'c_2', title: 'Other', createdAt: '2026-11-27T09:00:00.000Z', messages: [] };
    await setState({ ...state, conversation: other, runConversationId: 'c_1' });
    await expect.poll(() => dialog().isVisible()).toBe(true);
    // Back in the thread that asked, it is the same question: nothing is withdrawn or asked again.
    await setState({ conversation: state.conversation });
    await page.waitForTimeout(100);
    expect(await dialog().count()).toBe(1);
    await dialog().getByRole('button', { name: 'Allow this change' }).click();
    await expect.poll(answers).toEqual(['run_1 | q_1 | Allow this change']);
  });

  it('tells the editor’s other prompts it is open, and that it is gone once dismissed or taken back (#1322)', async () => {
    const reviewing = () => page.locator('#reviewing').textContent();
    expect(await reviewing()).toBe('false');
    await setState(waiting({ formRouting: REVIEW }));
    await expect.poll(() => dialog().isVisible()).toBe(true);
    await expect.poll(reviewing).toBe('true');
    // Taken back with the request stopped: the prompts come back with whatever the run says next.
    await setState({ runStatus: null, activeRunId: null });
    await expect.poll(reviewing).toBe('false');
    // Waiting again and dismissed: Keep is sent and the prompts are back.
    await setState(waiting({ formRouting: REVIEW }));
    await expect.poll(reviewing).toBe('true');
    await page.keyboard.press('Escape');
    await expect.poll(answers).toEqual(['run_1 | q_1 | Keep it as it is']);
    await expect.poll(reviewing).toBe('false');
  });

  it('opens nothing for a question the model asks', async () => {
    await setState(waiting({}));
    await page.waitForTimeout(100);
    expect(await page.getByRole('dialog').count()).toBe(0);
  });
});
