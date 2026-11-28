/**
 * Allowing the AI to change the whole site holds for the rest of the conversation (#1412): once the author answers a
 * scope question Yes (clicked or typed), the composer's scope chip stays on Whole site for that conversation's later
 * requests, which are sent with it, so the next request that reaches past the page does not ask again. Another
 * conversation keeps its own scope, a No grants nothing, and choosing the page by hand narrows it again for good.
 * The real Chat panel and store run in a real browser over a fake preload bridge that records what it is asked.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://chat-site-grant.test';
const src = (path: string) => JSON.stringify(resolve('src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Chat } from ${src('renderer/src/panels/Chat')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  "const time = '2026-11-28T00:00:00.000Z';",
  "const provider = { id: 'openai', label: 'OpenAI', configured: true, source: 'stored', storage: 'local-file', models: [{ id: 'gpt-a', label: 'GPT A' }] };",
  // A conversation whose request on Home waits on the AI's scope question.
  'const asking = (id, opts = {}) => ({ id, title: "Site", createdAt: time, messages: [',
  "  { id: id + '_u', role: 'user', text: 'Build the site', time, context: { pageId: window.home, pageTitle: 'Home', selection: null, selectionLabel: null, scope: 'page', viewport: 1280 }, ...(opts.guest ? { guest: { name: 'Sam', id: 'g_1' } } : {}) },",
  "  { id: id + '_a', role: 'assistant', text: '', time, runId: 'run_' + id, activities: [], ...(opts.guest ? { guest: { name: 'Sam', id: 'g_1' } } : {}), questions: [opts.plain ? { id: 'q_1', text: 'Should the hero say “Welcome”?', choices: ['Yes', 'No'] } : { id: 'q_1', text: 'May I add the other pages?', choices: ['Yes, allow changes across the whole site', 'No, only change Home'], widen: true }] }",
  '] });',
  'window.mount = (state, opts) => {',
  '  window.home = state.site.homePageId;',
  "  const settings = { ai: { provider: 'openai', models: { openai: 'gpt-a', anthropic: '', local: '' }, local: { baseURL: 'http://127.0.0.1:9/v1', allowRemote: false, toolMode: 'native', contextWindow: null, modelsByServer: {} }, sendOnEnter: true, setupAcknowledged: true }, developerMode: false };",
  '  window.bridge.settings = settings;',
  '  window.bridge.providers = [provider];',
  '  flushSync(() => useStore.setState({',
  "    screen: 'editor', snapshot: { workspaceKey: 'w', dir: '/project', state, revision: 1, history: { canUndo: false, canRedo: false, entries: [] } }, pageId: state.site.homePageId, selection: null,",
  "    settings, providers: [provider], conversation: asking('c_1', opts), runStatus: 'awaiting-input', activeRunId: 'run_c_1', runConversationId: 'c_1', runMode: 'edit',",
  "    chatMode: 'edit', dockOpen: true, rightTab: 'chat', chatContextEnabled: { page: true, scope: opts.scope ?? 'selection' }",
  '  }));',
  "  flushSync(() => createRoot(document.getElementById('root')).render(h(Chat)));",
  '};',
  'window.so = {',
  // The run goes on and finishes; the conversation keeps its answered question.
  "  finish: () => { const c = useStore.getState().conversation; flushSync(() => useStore.setState({ runStatus: null, activeRunId: null, runConversationId: null, runMode: null, conversation: { ...c, messages: c.messages.map((m) => m.role === 'assistant' ? { ...m, result: { status: 'success', summary: 'Done.', changes: [], validation: [], canUndo: false } } : m) } })); },",
  "  show: (id) => flushSync(() => useStore.setState({ conversation: id === 'c_1' ? window.kept : { id, title: 'Other', createdAt: time, messages: [] } })),",
  "  keep: () => { window.kept = useStore.getState().conversation; },",
  '  grants: () => useStore.getState().chatSiteGrants,',
  // The question settles in the transcript (the run's own update) before the answer's reply comes back.
  "  settle: () => { const c = useStore.getState().conversation; flushSync(() => useStore.setState({ runStatus: 'running', conversation: { ...c, messages: c.messages.map((m) => m.role === 'assistant' ? { ...m, questions: m.questions.map((q) => ({ ...q, answered: q.choices[0] })) } : m) } })); },",
  "  scope: () => useStore.getState().chatContextEnabled.scope,",
  "  toasts: () => useStore.getState().toasts.map((t) => t.text)",
  '};'
].join('\n');

/** The preload bridge: answers and sends are recorded; anything else answers a promise of nothing. */
const BRIDGE = `
  window.bridge = { calls: [] };
  const b = window.bridge;
  const answers = {
    'app.getSettings': () => b.settings,
    'ai.providers': () => b.providers,
    // Held while the test holds it (b.hold), refused while b.refuse is set.
    'ai.answer': () => (b.refuse ? false : b.hold ? new Promise((done) => (b.release = () => done(true))) : true),
    'ai.send': () => ({ ok: true, runId: 'run_next' })
  };
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => {
      if (path === 'on') return () => {};
      b.calls.push([path, ...args]);
      return Promise.resolve(answers[path] ? answers[path](...args) : undefined);
    }
  });
  window.builder = any('');
`;

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'chat-site-grant',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The chat panel did not bundle');
  return chunk.code;
}

type Call = [string, ...unknown[]];

describe.skipIf(!browserInstalled)('a whole site allowed for the rest of the conversation (#1412)', { timeout: 30_000 }, () => {
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

  const mount = async (opts: { guest?: boolean; plain?: boolean; scope?: 'page' } = {}) => {
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
    await page.evaluate(([state, o]) => (globalThis as unknown as { mount(s: unknown, o: unknown): void }).mount(state, o), [createStarterState('blank', 'Site', false), opts] as unknown[]);
  };
  const calls = (path: string) => page.evaluate((p) => (globalThis as unknown as { bridge: { calls: Call[] } }).bridge.calls.filter((c) => c[0] === p).map((c) => c.slice(1)), path);
  const chip = () => page.locator('.composer .scope-chip');
  const box = () => page.getByRole('textbox', { name: 'Message', exact: true });
  /** Sends a message and returns the scope it went with. */
  const sendNext = async (text: string) => {
    const before = (await calls('ai.send')).length;
    await box().fill(text);
    await box().press('Enter');
    await expect.poll(async () => (await calls('ai.send')).length).toBe(before + 1);
    return ((await calls('ai.send')).at(-1)![1] as { scope?: string }).scope;
  };
  const answerWith = async (how: 'click yes' | 'click no' | 'type ok' | 'click plain yes') => {
    if (how === 'click plain yes') await page.getByRole('button', { name: 'Yes', exact: true }).click();
    else if (how === 'type ok') {
      const answerBox = page.getByRole('textbox', { name: 'Your answer', exact: true });
      await answerBox.fill('ok');
      await answerBox.press('Enter');
    } else await page.getByRole('button', { name: how === 'click yes' ? 'Yes, allow changes across the whole site' : 'No, only change Home', exact: true }).click();
    await expect.poll(async () => (await calls('ai.answer')).length).toBe(1);
    expect((await calls('ai.answer'))[0]).toEqual(['run_c_1', 'q_1', how === 'type ok' ? 'ok' : how === 'click plain yes' ? 'Yes' : how === 'click yes' ? 'Yes, allow changes across the whole site' : 'No, only change Home']);
  };
  const narrowToPage = async () => {
    await chip().click();
    await page.getByRole('menuitemradio', { name: /^This page/ }).click();
    await expect.poll(async () => chip().getAttribute('aria-label')).toMatch(/^What the AI may change: Home/);
  };

  beforeEach(() => {
    errors = [];
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  it('keeps Whole site on the chip and in the next request once Yes is clicked', async () => {
    await mount();
    await page.locator('#ai-question-scope', { hasText: 'later requests in this conversation start from Whole site' }).waitFor();
    await answerWith('click yes');
    await page.evaluate('so.finish()');
    await expect.poll(async () => chip().getAttribute('aria-label')).toMatch(/^What the AI may change: Whole site/);
    expect(await sendNext('Proofread the Our Story page')).toBe('site');
  });

  it('takes a typed yes as the same answer', async () => {
    await mount();
    await answerWith('type ok');
    expect(await page.evaluate('so.grants()')).toEqual({ c_1: true });
    await page.evaluate('so.finish()');
    expect(await sendNext('Add a quiz page')).toBe('site');
  });

  it('grants nothing on No: the next request starts on the page again', async () => {
    await mount();
    await answerWith('click no');
    await page.evaluate('so.finish()');
    await expect.poll(async () => chip().getAttribute('aria-label')).toMatch(/^What the AI may change: Home/);
    expect(await page.evaluate('so.grants()')).toEqual({});
    expect(await sendNext('Add a quiz page')).toBe('page');
  });

  it('keeps it to its own conversation, and narrows for good when the page is chosen by hand', async () => {
    await mount();
    await answerWith('click yes');
    await page.evaluate('so.finish()');
    await page.evaluate('so.keep()');
    // Another conversation starts on the page, as always, and This page chosen there is its own.
    await page.evaluate("so.show('c_2')");
    await expect.poll(async () => chip().getAttribute('aria-label')).toMatch(/^What the AI may change: Home/);
    await narrowToPage();
    expect(await page.evaluate('so.grants()')).toEqual({ c_1: true });
    // Back in the one that allowed it, Whole site again.
    await page.evaluate("so.show('c_1')");
    await expect.poll(async () => chip().getAttribute('aria-label')).toMatch(/^What the AI may change: Whole site/);
    // The author narrows it from the chip's menu: the page, and it stays narrowed.
    await narrowToPage();
    expect(await page.evaluate('so.grants()')).toEqual({});
    expect(await sendNext('Change the heading')).toBe('page');
    // Shown again after another conversation, it stays narrowed: the page.
    await page.evaluate("so.show('c_2')");
    await page.evaluate("so.show('c_1')");
    expect(await page.evaluate('so.scope()')).toBe('page');
  });

  it('lets a Yes win over This page chosen before it', async () => {
    await mount({ scope: 'page' });
    await answerWith('click yes');
    await page.evaluate('so.finish()');
    await expect.poll(async () => chip().getAttribute('aria-label')).toMatch(/^What the AI may change: Whole site/);
    expect(await sendNext('Add a page about prices')).toBe('site');
  });

  it('grants nothing for an answer that never reached the AI, or a yes to a question that is not about scope', async () => {
    await mount();
    await page.evaluate('bridge.refuse = true');
    await answerWith('click yes');
    await expect.poll(() => page.evaluate('so.toasts()')).toEqual(['Your answer could not be sent. Try again.']);
    expect(await page.evaluate('so.grants()')).toEqual({});
    await context.close();
    await mount({ plain: true });
    await answerWith('click plain yes');
    await page.evaluate('so.finish()');
    expect(await page.evaluate('so.grants()')).toEqual({});
    expect(await sendNext('Add a page about prices')).toBe('page');
  });

  it('keeps This page chosen while the Yes was on its way, and is not undone by another conversation narrowing', async () => {
    await mount();
    await page.evaluate('bridge.hold = true');
    await answerWith('click yes');
    // The run takes the answer and goes on before its reply comes back; the author narrows to the page meanwhile.
    await page.evaluate('so.settle()');
    await narrowToPage();
    await page.evaluate('bridge.release()');
    await page.evaluate('so.finish()');
    await expect.poll(async () => (await page.evaluate('so.grants()')) as object).toEqual({});
    expect(await sendNext('Add a page about prices')).toBe('page');
    await context.close();
    // Narrowing another conversation meanwhile leaves this one's Yes standing.
    await mount();
    await page.evaluate('bridge.hold = true');
    await answerWith('click yes');
    await page.evaluate('so.settle()');
    await page.evaluate("so.show('c_2')");
    await narrowToPage();
    await page.evaluate('bridge.release()');
    await expect.poll(async () => (await page.evaluate('so.grants()')) as object).toEqual({ c_1: true });
  });

  it('widens a live-session guest’s turn alone: the host’s later requests keep their scope', async () => {
    await mount({ guest: true });
    await page.locator('#ai-question-scope', { hasText: 'Allowing it lets this request change the whole site.' }).waitFor();
    expect(await page.locator('#ai-question-scope', { hasText: 'later requests' }).count()).toBe(0);
    await answerWith('click yes');
    await page.evaluate('so.finish()');
    expect(await page.evaluate('so.grants()')).toEqual({});
    expect(await sendNext('Add a page about prices')).toBe('page');
  });
});
