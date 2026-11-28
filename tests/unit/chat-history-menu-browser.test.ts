/**
 * The Recent conversations menu (#1326): the history menu clamps its labels to two lines, which must not flatten a
 * row's reason (the disabled Clear history… while the AI runs) onto its label's line.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://chat-history-menu.test';
const CSS = ['styles/tokens.css', 'styles/reset.css', 'styles/primitives.css', 'panels/Chat.css'].map((f) => readFileSync(resolve('src/renderer/src', f), 'utf8')).join('\n');

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { useMenu } from ${JSON.stringify(resolve('src/renderer/src/components/ui'))};`,
  'function Host() {',
  '  const menu = useMenu();',
  '  const rows = [',
  '    { heading: "Recent conversations" },',
  '    { label: "Build a custom interactive Svelte 5 Sourdough Formula calculator", hint: "22:02", checked: true, onSelect: () => {} },',
  '    { separator: true },',
  '    { label: "Clear history…", danger: true, disabled: true, description: "Available when the AI finishes.", onSelect: () => {} }',
  '  ];',
  '  return h("div", null, h("button", { id: "a", ...menu.triggerProps("a"), onClick: (e) => menu.openAt(e.currentTarget, rows, "Conversations") }, "A"), menu.node);',
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(Host)));"
].join('\n');

const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: () => any('')
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
        name: 'chat-history-menu',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The menu did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('the Recent conversations menu', { timeout: 30_000 }, () => {
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
    page = await (await browser.newContext({ viewport: { width: 600, height: 500 } })).newPage();
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>@layer tokens, reset, base, primitives, layout, components;\n${CSS}</style><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script></body>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await page.context().close();
  });

  it('puts a disabled row’s reason on its own line under the label', async () => {
    await page.click('#a');
    await page.getByRole('menu').waitFor();
    const box = await page.evaluate<{ label: { top: number; bottom: number }; desc: { top: number; bottom: number } }>(`(() => {
      const row = [...document.querySelectorAll('.menu-item')].find((r) => r.textContent.includes('Clear history'));
      const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
      return { label: r(row.querySelector('.menu-text > :first-child')), desc: r(row.querySelector('.menu-desc')) };
    })()`);
    expect(box.desc.top).toBeGreaterThanOrEqual(box.label.bottom - 0.5);
  });
});
