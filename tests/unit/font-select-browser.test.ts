/**
 * The font select in a real browser (#1490): an imported font whose files say what kind of face it is ends in a
 * fallback of that kind, and one whose files do not lets the author choose it, kept in the stack itself.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { findTheme } from '@catalogue/index';
import type { AssetRecord } from '@shared/types';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://font-select.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  `import { FontSelect } from ${renderer('panels/FontSelect')};`,
  // The built-in fonts the select lists come from the site's theme.
  "import { registerPacks } from '@catalogue/index';",
  'registerPacks([window.__theme]);',
  'const state = window.__project;',
  'window.chosen = [];',
  'function Host() {',
  '  const [stack, setStack] = useState(window.__stack);',
  '  window.setStack = setStack;',
  "  return h(FontSelect, { id: 'font', label: 'Display font', state, stack, onChoose: (next) => { window.chosen.push(next); setStack(next); } });",
  '}',
  "createRoot(document.getElementById('root')).render(h(Host));"
].join('\n');

const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
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
        name: 'font-select',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('FontSelect did not bundle');
  return chunk.code;
}

const face = (id: string, family: string, category?: 'serif' | 'monospace'): AssetRecord => ({
  id,
  name: family,
  file: `static/assets/${id}-1a2b3c4d.woff2`,
  mime: 'font/woff2',
  bytes: 1000,
  hash: `hash-${id}`,
  kind: 'font',
  createdAt: '2026-01-01T00:00:00.000Z',
  font: { family, weight: '400', style: 'normal', ...(category ? { category } : {}) }
});

describe.skipIf(!browserInstalled)("FontSelect's fallback for imported fonts (#1490)", { timeout: 60_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;
  let errors: string[];
  const state = createStarterState('business', 'Fonts', false);
  for (const a of [face('lora', 'Lora'), face('serif4', 'Source Serif 4', 'serif'), face('plex', 'IBM Plex Mono', 'monospace')]) state.assets.assets[a.id] = a;
  const project = JSON.stringify(state).replace(/</g, '\\u003c');
  const theme = JSON.stringify(findTheme(state.site.themeId)).replace(/</g, '\\u003c');

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  const open = async (stack: string) => {
    page = await (await browser.newContext()).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}window.__theme = ${theme}; window.__project = ${project}; window.__stack = ${JSON.stringify(stack)};</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
    await page.locator('#font').waitFor();
  };
  beforeEach(() => {
    errors = [];
  });
  afterEach(async () => {
    await page?.context().close();
    expect(errors).toEqual([]);
  });

  const chosen = () => page.evaluate<string[]>('window.chosen');
  const fallback = () => page.getByLabel('Fallback');

  it('offers each imported font with a fallback of its kind, and asks for none when the kind is known', async () => {
    await open("'Source Serif 4', Georgia, 'Times New Roman', serif");
    const values = await page.locator('#font optgroup[label="Imported fonts"] option').evaluateAll((os) => os.map((o) => [o.textContent, (o as HTMLOptionElement).value]));
    expect(values).toEqual([
      ['IBM Plex Mono', "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"],
      ['Lora', "'Lora', system-ui, sans-serif"],
      ['Source Serif 4', "'Source Serif 4', Georgia, 'Times New Roman', serif"]
    ]);
    expect(await fallback().count()).toBe(0);
    await page.locator('#font').selectOption({ label: 'IBM Plex Mono' });
    expect(await chosen()).toEqual(["'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"]);
    expect(await fallback().count()).toBe(0);
  });

  it('lets the author choose the fallback of a font whose files do not say its kind, kept in the stack', async () => {
    await open("'Lora', system-ui, sans-serif");
    // Showing it writes nothing.
    expect(await fallback().inputValue()).toBe('sans-serif');
    expect(await chosen()).toEqual([]);
    await fallback().selectOption({ label: 'Serif' });
    expect(await chosen()).toEqual(["'Lora', Georgia, 'Times New Roman', serif"]);
    // The font is still the one chosen, and the fallback reads back from the stack.
    expect(await page.locator('#font').inputValue()).toBe("'Lora', system-ui, sans-serif");
    expect(await fallback().inputValue()).toBe('serif');
    // A tail of the author's own shows as such until a standard one is chosen.
    await page.evaluate(`window.setStack("'Lora', Arial, serif")`);
    expect(await fallback().inputValue()).toBe('');
    expect(await fallback().locator('option:checked').textContent()).toBe('Custom fallback');
    await fallback().selectOption({ label: 'Monospace' });
    expect((await chosen()).at(-1)).toBe("'Lora', ui-monospace, 'SF Mono', Menlo, Consolas, monospace");
    // A built-in font asks for no fallback.
    await page.locator('#font').selectOption({ label: 'Georgia (serif)' });
    expect(await fallback().count()).toBe(0);
  });
});
