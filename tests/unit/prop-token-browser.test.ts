/**
 * Theme token properties in a code component's Properties tab (#1536), in a real browser: the Type list offers the
 * site's token groups by name, and a token row shows its group and lets its default token be chosen.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://prop-token.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const TOKENS = [
  { id: 'color.brand', group: 'color', label: 'Brand', value: '#123456' },
  { id: 'color.accent', group: 'color', label: 'Accent', value: '#654321' },
  { id: 'space.md', group: 'space', label: 'Medium', value: '24px' }
];

const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  "import { registerPacks } from '@catalogue/index';",
  `import { PropSchemaEditor, propertiesFromRows, rowsFromProperties } from ${renderer('panels/PropSchemaEditor')};`,
  `import { useStore } from ${renderer('store')};`,
  `registerPacks([{ id: 'test', tokens: ${JSON.stringify(TOKENS)} }]);`,
  "flushSync(() => useStore.setState({ snapshot: { state: { site: { themeId: 'test' }, tokens: { custom: [] } } } }));",
  "const Host = () => {",
  "  const [rows, setRows] = useState(() => rowsFromProperties({ tint: { type: 'token', label: 'Tint', tokenGroup: 'color', default: { token: 'color.brand' } }, heading: { type: 'string', label: 'Heading', default: '' } }));",
  "  window.__properties = propertiesFromRows(rows);",
  "  return h(PropSchemaEditor, { rows, onChange: setRows });",
  "};",
  "createRoot(document.getElementById('root')).render(h(Host));"
].join('\n');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'prop-token', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the Properties tab did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('theme token properties in the Properties tab (#1536)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    const [script, launched] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
    browser = launched;
    page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) => {
      if (new URL(route.request().url()).pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><body><div id="root"></div><script src="/app.js"></script>' });
    });
    await page.goto(`${SITE}/`);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  const properties = () => page.evaluate('window.__properties') as Promise<Record<string, unknown>>;

  it('names a token row’s group, chooses its default and makes another property a token', async () => {
    const tint = page.getByRole('combobox', { name: 'tint type' });
    await tint.waitFor();
    expect(await tint.locator('option:checked').textContent()).toBe('Theme color');
    await page.getByRole('button', { name: 'tint settings: Default Brand' }).click();
    const chosen = page.getByRole('combobox', { name: 'tint default' });
    expect(await chosen.locator('option').allTextContents()).toEqual(['Brand', 'Accent']);
    await chosen.selectOption({ label: 'Accent' });
    await page.getByRole('button', { name: 'tint settings: Default Accent' }).waitFor();
    expect((await properties()).tint).toEqual({ type: 'token', label: 'Tint', tokenGroup: 'color', default: { token: 'color.accent' } });

    const heading = page.getByRole('combobox', { name: 'heading type' });
    // Only the groups the site has tokens of are offered.
    expect((await heading.locator('option').allTextContents()).slice(-2)).toEqual(['Theme color', 'Spacing']);
    await heading.selectOption({ label: 'Spacing' });
    await page.getByRole('button', { name: 'heading settings: Default Medium' }).waitFor();
    expect((await properties()).heading).toEqual({ type: 'token', label: 'Heading', tokenGroup: 'space', default: { token: 'space.md' } });
    expect(errors).toEqual([]);
  });
});
