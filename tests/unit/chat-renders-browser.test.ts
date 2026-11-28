/**
 * A message that did not change is not rendered again (#974): while a reply streams, only the message it streams into
 * renders at each piece, and typing in the composer renders none of them, however long the conversation is. The real
 * Chat panel and store run in a real browser, counting message renders with the editor's own counter
 * (`chat.messageRenders`, which counts only while marks are on: the page offers the perf bridge, as the preload does).
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://chat-renders.test';
const src = (path: string) => JSON.stringify(resolve('src', path));
/** Earlier turns in the conversation: the request and reply of each. */
const TURNS = 20;
/** The local server, set up: what the editor shows and what main answers when it is asked again after a run. */
const PROVIDERS = JSON.stringify([{ id: 'local', label: 'Local model', configured: true, source: 'stored', storage: 'local-file', models: [{ id: 'test-model', label: 'Test model' }] }]);

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Chat } from ${src('renderer/src/panels/Chat')};`,
  `import { applyAiEvent, getConfirm, useStore } from ${src('renderer/src/store')};`,
  "const time = '2026-11-24T00:00:00.000Z';",
  'window.mount = (state) => {',
  "const context = { pageId: state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, mode: 'ask' };",
  'const messages = [];',
  `for (let i = 0; i < ${TURNS}; i++) {`,
  "  messages.push({ id: 'm_u' + i, role: 'user', text: 'Question ' + i, time, context, runId: 'run_' + i });",
  "  const summary = 'The **answer** to question ' + i + '.\\n\\n- One point\\n- Another point';",
  "  messages.push({ id: 'm_a' + i, role: 'assistant', text: summary, time, runId: 'run_' + i, result: { status: 'no-changes', summary, changes: [], validation: [], checks: [], canUndo: false, ask: true } });",
  '}',
  "messages.push({ id: 'm_q', role: 'user', text: 'And the last one?', time, context, runId: 'run_live' });",
  "messages.push({ id: 'm_live', role: 'assistant', text: '', time, runId: 'run_live' });",
  "const settings = { ai: { provider: 'local', models: { local: 'test-model' }, local: { baseURL: 'http://127.0.0.1:9/v1', allowRemote: false, toolMode: 'native', contextWindow: null, modelsByServer: {} }, sendOnEnter: true }, developerMode: false };",
  `const providers = ${PROVIDERS};`,
  'flushSync(() => useStore.setState({',
  "  screen: 'editor', snapshot: { workspaceKey: 'w', dir: '/project', state, revision: 1, history: { canUndo: false, canRedo: false, entries: [] } }, pageId: state.site.homePageId,",
  "  settings, providers, conversation: { id: 'c_r', title: 'Renders', createdAt: time, messages },",
  "  runStatus: 'running', activeRunId: 'run_live', runMode: 'ask', runConversationId: 'c_r', chatMode: 'ask', dockOpen: true, rightTab: 'chat'",
  '}));',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Chat)));",
  '};',
  'window.so = {',
  // The editor's counters as they stand, read from a mark (they travel on every one).
  "  renders: () => { window.__siteoriginPerf.mark('probe'); return window.perfRecords.at(-1).c['chat.messageRenders'] ?? 0; },",
  "  draft: (id = 'c_r') => useStore.getState().chatDrafts[id] ?? '',",
  "  stream: (text, at) => flushSync(() => applyAiEvent({ runId: 'run_live', conversationId: 'c_r', kind: 'text', text, ...(at === undefined ? {} : { at }) })),",
  "  done: () => flushSync(() => applyAiEvent({ runId: 'run_live', conversationId: '', kind: 'status', status: 'no-changes', mode: 'ask' })),",
  // The run asks the author a question and waits for the answer.
  "  ask: () => flushSync(() => {",
  "    applyAiEvent({ runId: 'run_live', conversationId: 'c_r', kind: 'message', message: { ...useStore.getState().conversation.messages.at(-1), questions: [{ id: 'q1', text: 'Which page should it go on?', choices: [] }] } });",
  "    applyAiEvent({ runId: 'run_live', conversationId: 'c_r', kind: 'status', status: 'awaiting-input', mode: 'ask' });",
  '  }),',
  // Another thread on screen while the running request, filed in this one, asks its question here.
  "  elsewhere: () => flushSync(() => {",
  // Main's copy of the run's thread, as opening it answers: its turn asks its question.
  "    const live = useStore.getState().conversation;",
  "    if (live.id === 'c_r') window.liveConv = { ...live, messages: [...live.messages.slice(0, -1), { ...live.messages.at(-1), questions: [{ id: 'q1', text: 'Which page should it go on?', choices: [] }] }] };",
  "    useStore.setState({ conversation: { id: 'c_other', title: 'Other', createdAt: time, messages: [] } });",
  "    applyAiEvent({ runId: 'run_live', conversationId: 'c_r', kind: 'status', status: 'awaiting-input', mode: 'ask' });",
  '  }),',
  "  calls: (path) => window.calls.filter((c) => c[0] === path).map((c) => c[1]),",
  // The app's own question, as the dialog host shows it, and the answer given to it.
  "  confirming: () => getConfirm()?.title ?? null,",
  "  confirm: (ok) => getConfirm()?.resolve(ok),",
  "  toasts: () => useStore.getState().toasts.map((t) => t.text),",
  "  shown: () => useStore.getState().conversation?.id,",
  '};'
].join('\n');

/**
 * The preload bridge: every call answers a promise of nothing, but for what Chat asks the local server, and the perf
 * bridge keeps what the editor sends it.
 */
const BRIDGE = `
  window.perfRecords = [];
  window.calls = [];
  window.builderPerf = { send: (record) => window.perfRecords.push(record) };
  const answers = { 'ai.localContext': { server: 'http://127.0.0.1:9/v1', reportedWindow: null }, 'ai.localModels': { ok: true, models: ['test-model'] }, 'ai.providers': ${PROVIDERS}, 'ai.newConversation': { id: 'c_new', title: 'New conversation', createdAt: '2026-11-24T00:00:00.000Z', messages: [] } };
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: (_, __, args) => (window.calls.push([path, args]), path === 'on' ? () => {} : Promise.resolve(path === 'ai.openConversation' ? structuredClone(window.liveConv) : answers[path]))
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
        name: 'chat-renders',
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

describe.skipIf(!browserInstalled)('chat messages render only when they change (#974)', { timeout: 30_000 }, () => {
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
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
    // A project as the editor has it open; made here, where the theme packs are loaded.
    await page.evaluate((state) => (globalThis as unknown as { mount(s: unknown): void }).mount(state), createStarterState('blank', 'Renders', false) as unknown);
    await page.locator('[data-message-id="m_live"]').waitFor();
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const renders = () => page.evaluate<number>('so.renders()');
  const live = () => page.locator('[data-message-id="m_live"]').innerText();

  it('renders only the streaming message at each piece of a reply', async () => {
    expect(await page.locator('.chat-log [data-message-id]').count()).toBe(2 * TURNS + 2);
    // Each message rendered as the panel opened, so the counter counts.
    const before = await renders();
    expect(before).toBeGreaterThanOrEqual(2 * TURNS + 2);
    // One render per piece, of the message that changed: none of the 41 others.
    let at = 0;
    for (const [i, piece] of ['Here is', ' what I', ' found.'].entries()) {
      await page.evaluate(([p, a]) => (globalThis as unknown as { so: { stream(t: string, at?: number): void } }).so.stream(p as string, a === 0 ? undefined : (a as number)), [piece, at]);
      at += piece.length;
      expect(await live()).toContain('Here is what I found.'.slice(0, at));
      expect((await renders()) - before).toBe(i + 1);
    }
  });

  it('renders no message while the composer is typed in', async () => {
    await page.evaluate('so.done()');
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.click();
    const before = await renders();
    await box.pressSequentially('Which pages need images?');
    expect(await box.inputValue()).toBe('Which pages need images?');
    expect(await page.evaluate<string>('so.draft()')).toBe('Which pages need images?');
    expect((await renders()) - before).toBe(0);
  });

  it('grows the composer as text is added and shrinks it as text goes, measuring it afresh only once it has grown', async () => {
    await page.evaluate('so.done()');
    // The composer's own sizing rules (the bundle leaves the stylesheets out).
    await page.addStyleTag({ content: '.composer textarea { display: block; box-sizing: border-box; width: 320px; min-height: 56px; max-height: 240px; overflow-y: auto; padding: 10px 12px 4px; border: 0; font: 14px/1.45 sans-serif; resize: none; }' });
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    await box.click();
    await box.pressSequentially('A');
    type Box = { getBoundingClientRect(): { height: number }; scrollHeight: number; clientHeight: number };
    const size = () =>
      box.evaluate((el) => {
        const ta = el as unknown as Box;
        return { height: ta.getBoundingClientRect().height, fits: ta.scrollHeight <= ta.clientHeight };
      });
    const one = await size();
    expect(one.fits).toBe(true);
    // Each time the box's size is set (a reset to measure it is one more), while it is at its least height: text added
    // or taken away there leaves it as it is.
    await page.evaluate("window.styleSets = 0; new MutationObserver((r) => (window.styleSets += r.length)).observe(document.querySelector('.composer textarea'), { attributes: true, attributeFilter: ['style'] })");
    await box.pressSequentially(' short line');
    for (let i = 0; i < 5; i++) await box.press('Backspace');
    expect(await page.evaluate<number>('styleSets')).toBe(0);
    expect(await size()).toEqual(one);
    // Lines added grow it to fit, up to its cap, and then it scrolls.
    await box.pressSequentially(' and then a good deal more, which wraps onto the lines below it in a box this narrow.');
    const grownText = await box.inputValue();
    const grown = await size();
    expect(grown.height).toBeGreaterThan(one.height);
    expect(grown.fits).toBe(true);
    await box.fill(`${grownText}${' And more again, line after line.'.repeat(40)}`);
    expect(await size()).toEqual({ height: 240, fits: false });
    // Text taken away gives the room back, and text replaced by less (typed over a selection) does too.
    await box.fill(grownText);
    expect(await size()).toEqual(grown);
    await box.selectText();
    await box.pressSequentially('A');
    expect(await size()).toEqual(one);
    expect(await page.evaluate<string>('so.draft()')).toBe('A');
  });

  it('shows another thread’s request as running elsewhere, stopped and answered by going back to its thread (#1124, #1125)', async () => {
    expect(await page.locator('.run-strip').getAttribute('data-run-id')).toBe('run_live');
    // In its own thread it is stopped by its ID: a request that ended meanwhile is not followed by another being stopped.
    await page.getByRole('button', { name: /Stop/ }).click();
    expect(await page.evaluate("so.calls('ai.stop')")).toEqual([['run_live']]);
    await page.evaluate('so.elsewhere()');
    // The note says where the request is and that it waits for an answer; this thread has no answer box of its own.
    const strip = page.locator('.run-strip.elsewhere');
    expect(await strip.innerText()).toContain('The AI needs your answer in another conversation');
    expect(await page.locator('.run-strip[data-run-id]').count()).toBe(0);
    expect(await page.getByRole('textbox', { name: 'Your answer', exact: true }).count()).toBe(0);
    expect(await page.locator('.chat-log').getAttribute('aria-busy')).not.toBe('true');
    // It still holds the app: nothing is sent until it ends, though a message is written.
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Next, the footer');
    expect(await page.getByRole('button', { name: /^Send/ }).isDisabled()).toBe(true);
    // Other conversations can be read meanwhile; this one is empty, so a new one has nothing to leave behind.
    expect(await page.getByRole('button', { name: 'Earlier conversations' }).isDisabled()).toBe(false);
    expect(await page.getByRole('button', { name: 'New conversation' }).isDisabled()).toBe(true);
    // Answer goes back to the thread that asked, to its question and the answer box; the message written in the other
    // thread stays there.
    await strip.getByRole('button', { name: 'Answer' }).click();
    expect(await page.evaluate("so.calls('ai.openConversation')")).toEqual([['c_r']]);
    const answer = page.getByRole('textbox', { name: 'Your answer', exact: true });
    await answer.waitFor();
    expect(await page.locator('.question-card').innerText()).toContain('Which page should it go on?');
    await page.waitForFunction("document.activeElement?.getAttribute('aria-label') === 'Your answer'");
    expect(await page.locator('.run-strip.elsewhere').count()).toBe(0);
    expect(await page.evaluate("so.draft('c_other')")).toBe('Next, the footer');
    // Stop, from another thread again, stops that request by its ID and goes back to it too.
    await page.evaluate('so.elsewhere()');
    await page.locator('.run-strip.elsewhere').getByRole('button', { name: /Stop/ }).click();
    expect(await page.evaluate("so.calls('ai.stop')")).toEqual([['run_live'], ['run_live']]);
    expect(await page.evaluate("so.calls('ai.openConversation')")).toEqual([['c_r'], ['c_r']]);
    await page.locator('.run-strip[data-run-id="run_live"]').waitFor();
  });

  it('never sends `/clear` to the AI: it starts a new conversation once confirmed, and says why while a request runs (#1356)', async () => {
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    // While the request runs, nothing is cleared or asked, and the chat says why; the text stays in the box.
    await box.fill('/clear');
    await box.press('Enter');
    expect(await page.evaluate('so.confirming()')).toBeNull();
    expect(await page.evaluate<string[]>('so.toasts()')).toContainEqual(expect.stringContaining('once the AI finishes'));
    expect(await page.evaluate("so.draft('c_r')")).toBe('/clear');
    await page.evaluate('so.done()');
    // Cancelled: the chat and the box are as they were.
    await box.press('Enter');
    await page.waitForFunction('so.confirming() !== null');
    await page.evaluate('so.confirm(false)');
    await page.waitForFunction('so.confirming() === null');
    expect(await page.evaluate('so.shown()')).toBe('c_r');
    expect(await page.evaluate("so.draft('c_r')")).toBe('/clear');
    // Confirmed, from the Send button: a new conversation, with the earlier one left without the command as its draft.
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction('so.confirming() !== null');
    await page.evaluate('so.confirm(true)');
    await page.waitForFunction("so.shown() === 'c_new'");
    expect(await page.evaluate("so.draft('c_r')")).toBe('');
    expect(await page.evaluate("so.calls('ai.newConversation')")).toEqual([[]]);
    expect(await page.evaluate("so.calls('ai.send')")).toEqual([]);
    expect(await page.locator('[data-message-id]').count()).toBe(0);
    // Nothing sent yet in the new one: the chat says there is nothing to clear.
    await box.fill(' /clear ');
    await box.press('Enter');
    expect(await page.evaluate<string[]>('so.toasts()')).toContainEqual(expect.stringContaining('already empty'));
    expect(await page.evaluate('so.confirming()')).toBeNull();
    expect(await page.evaluate("so.calls('ai.send')")).toEqual([]);
  });

  it('renders no message while an answer to the AI’s question is typed', async () => {
    await page.evaluate('so.ask()');
    const box = page.getByRole('textbox', { name: 'Your answer', exact: true });
    await box.click();
    const before = await renders();
    await box.pressSequentially('The Services page');
    expect(await box.inputValue()).toBe('The Services page');
    expect((await renders()) - before).toBe(0);
  });
});
