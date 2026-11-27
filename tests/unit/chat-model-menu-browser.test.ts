/**
 * The model button on the chat composer opens a menu in place (#954): choosing a model there switches the provider and
 * model for the next message at once, without Settings, and a provider that is not set up opens Settings at its setup.
 * The real Chat panel and store run in a real browser over a fake preload bridge that records what it is asked.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import type { ProviderStatus } from '@shared/api';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://chat-model-menu.test';
const src = (path: string) => JSON.stringify(resolve('src', path));

const hosted = (id: 'openai' | 'anthropic', configured: boolean): ProviderStatus => ({
  id,
  label: id === 'openai' ? 'OpenAI' : 'Anthropic',
  configured,
  source: configured ? 'stored' : null,
  storage: 'local-file',
  models: id === 'openai' ? [{ id: 'gpt-a', label: 'GPT A' }, { id: 'gpt-b', label: 'GPT B' }] : [{ id: 'claude-a', label: 'Claude A' }]
});
const local = (configured: boolean): ProviderStatus => ({ id: 'local', label: 'Local model', configured, source: null, storage: 'local-file', models: [] });

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { Chat } from ${src('renderer/src/panels/Chat')};`,
  `import { useStore } from ${src('renderer/src/store')};`,
  "const time = '2026-11-27T00:00:00.000Z';",
  'window.mount = (state, providers, provider) => {',
  "  const settings = { ai: { provider, models: { openai: 'gpt-a', anthropic: 'claude-a', local: '' }, local: { baseURL: 'http://127.0.0.1:9/v1', allowRemote: false, toolMode: 'native', contextWindow: null, modelsByServer: {} }, sendOnEnter: true, setupAcknowledged: true }, developerMode: false };",
  '  window.bridge.settings = settings;',
  '  window.bridge.providers = providers;',
  '  flushSync(() => useStore.setState({',
  "    screen: 'editor', snapshot: { workspaceKey: 'w', dir: '/project', state, revision: 1, history: { canUndo: false, canRedo: false, entries: [] } }, pageId: state.site.homePageId,",
  "    settings, providers, conversation: { id: 'c_m', title: 'Models', createdAt: time, messages: [] }, chatDrafts: { c_m: 'Which pages need images?' },",
  "    runStatus: null, activeRunId: null, chatMode: 'ask', dockOpen: true, rightTab: 'chat'",
  '  }));',
  "  flushSync(() => createRoot(document.getElementById('root')).render(h(Chat)));",
  '};',
  'window.so = { modal: () => useStore.getState().modal, provider: () => useStore.getState().settings.ai.provider, toasts: () => useStore.getState().toasts.map((t) => t.text) };'
].join('\n');

/**
 * The preload bridge: Settings writes wait until the test lets them through (`release`), and are applied as main
 * applies them; sends and model lists are recorded. Anything else answers a promise of nothing.
 */
const BRIDGE = `
  window.bridge = { calls: [], waiting: [], localModels: { ok: true, models: ['first-model'], server: 'http://127.0.0.1:9/v1' } };
  const b = window.bridge;
  b.release = () => b.waiting.splice(0).forEach((go) => go());
  const answers = {
    // Main takes the change in memory before writing it, so one whose write fails (b.fail) is still held there.
    'app.setSettings': (patch) => new Promise((done, refuse) => b.waiting.push(() => {
      const ai = b.settings.ai;
      b.settings = { ...b.settings, ai: { ...ai, ...patch.ai, models: { ...ai.models, ...(patch.ai.models ?? {}) }, local: ai.local } };
      if (b.fail) refuse(new Error('The settings file could not be written'));
      else done(b.settings);
    })),
    'app.getSettings': () => b.settings,
    'ai.providers': () => b.providers,
    'ai.localModels': () => b.localModels,
    'ai.send': () => ({ ok: true, runId: 'run_1' })
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
        name: 'chat-model-menu',
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

describe.skipIf(!browserInstalled)('the composer’s model menu (#954)', { timeout: 30_000 }, () => {
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

  const mount = async (providers: ProviderStatus[], provider: 'openai' | 'anthropic' | 'local') => {
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
    await page.evaluate(([state, list, p]) => (globalThis as unknown as { mount(...a: unknown[]): void }).mount(state, list, p), [createStarterState('blank', 'Models', false), providers, provider] as unknown[]);
  };
  const calls = (path: string) => page.evaluate((p) => (globalThis as unknown as { bridge: { calls: Call[] } }).bridge.calls.filter((c) => c[0] === p).map((c) => c.slice(1)), path);
  const modal = () => page.evaluate('so.modal()');
  const menu = () => page.getByRole('menu', { name: 'Model for your next message' });
  const modelButton = (name: string) => page.getByRole('button', { name: `Next message: ${name}. Change AI provider or model`, exact: true });

  beforeEach(() => {
    errors = [];
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  it('switches provider and model from the menu in two clicks, and sends nothing until the switch is saved', async () => {
    await mount([hosted('openai', true), hosted('anthropic', true), local(true)], 'openai');
    const button = modelButton('GPT A, OpenAI');
    expect(await button.getAttribute('aria-haspopup')).toBe('menu');
    await button.click();
    await menu().waitFor();
    expect(await page.getByRole('menuitemradio', { name: 'GPT A, OpenAI', exact: true }).getAttribute('aria-checked')).toBe('true');
    // The local server's models are asked as the menu opens, and listed when they come.
    await page.getByRole('menuitemradio', { name: 'first-model, Local model', exact: true }).waitFor();
    await page.getByRole('menuitemradio', { name: 'Claude A, Anthropic', exact: true }).click();
    expect(await calls('app.setSettings')).toEqual([[{ ai: { provider: 'anthropic', models: { anthropic: 'claude-a' } } }]]);
    expect(await modal()).toBeNull();
    expect(await menu().count()).toBe(0);

    // Sent before the choice is saved, the message would still name OpenAI: it waits, and the draft stays.
    const box = page.getByRole('textbox', { name: 'Message', exact: true });
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    await box.press('Enter');
    expect(await calls('ai.send')).toEqual([]);
    expect(await box.inputValue()).toBe('Which pages need images?');

    await page.evaluate('bridge.release()');
    await modelButton('Claude A, Anthropic').waitFor();
    await box.press('Enter');
    await expect.poll(async () => (await calls('ai.send')).length).toBe(1);
    expect((await calls('ai.send'))[0][3]).toEqual({ provider: 'anthropic', model: 'claude-a' });
  });

  it('goes by what main holds when a model change could not be saved', async () => {
    await mount([hosted('openai', true), hosted('anthropic', true), local(true)], 'openai');
    await page.evaluate('bridge.fail = true');
    await modelButton('GPT A, OpenAI').click();
    await page.getByRole('menuitemradio', { name: 'Claude A, Anthropic', exact: true }).click();
    await page.evaluate('bridge.release()');
    await expect.poll(() => page.evaluate('so.toasts()')).toEqual(['The model could not be changed: The settings file could not be written.']);
    // The next message names what main would send it to, so it is not refused as moved.
    await modelButton('Claude A, Anthropic').waitFor();
    expect(await page.evaluate('so.provider()')).toBe('anthropic');
  });

  it('opens from the keyboard like the composer’s other menus', async () => {
    await mount([hosted('openai', true), hosted('anthropic', true), local(true)], 'openai');
    await modelButton('GPT A, OpenAI').focus();
    await page.keyboard.press('ArrowDown');
    await menu().waitFor();
    expect(await page.evaluate<string | null>("document.activeElement?.getAttribute('role')")).toMatch(/^menuitem/);
    await page.keyboard.press('Escape');
    expect(await menu().count()).toBe(0);
  });

  it('keeps a provider with no key in the menu, opening Settings at that provider', async () => {
    await mount([hosted('openai', true), hosted('anthropic', false), local(true)], 'openai');
    await page.evaluate("bridge.localModels = { ok: false, models: [], message: 'No server' }");
    await modelButton('GPT A, OpenAI').click();
    await page.getByRole('menuitem', { name: 'Set up for Local model', exact: true }).waitFor();
    await page.getByRole('menuitem', { name: 'Add key for Anthropic', exact: true }).click();
    expect(await modal()).toEqual({ kind: 'settings', tab: 'ai', provider: 'anthropic' });
    expect(await calls('app.setSettings')).toEqual([]);
  });

  it('ends with Manage providers and keys, which opens the AI assistant settings', async () => {
    await mount([hosted('openai', true), hosted('anthropic', false), local(true)], 'openai');
    await modelButton('GPT A, OpenAI').click();
    const items = menu().locator('[role^="menuitem"]');
    await expect.poll(async () => (await items.last().innerText()).trim()).toBe('Manage providers and keys…');
    await items.last().click();
    expect(await modal()).toEqual({ kind: 'settings', tab: 'ai' });
  });

  it('switches to a provider that is set up from the chat, while the one in use has no key', async () => {
    await mount([hosted('openai', false), hosted('anthropic', true), local(false)], 'openai');
    await page.getByRole('button', { name: 'Connect an AI provider' }).waitFor();
    await modelButton('GPT A, OpenAI').click();
    await page.getByRole('menuitemradio', { name: 'Claude A, Anthropic', exact: true }).click();
    await page.evaluate('bridge.release()');
    await expect.poll(() => page.evaluate('so.provider()')).toBe('anthropic');
  });
});
