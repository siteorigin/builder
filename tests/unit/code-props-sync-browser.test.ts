/**
 * New code component with pasted code that takes other props than the starter's (#1527), in a real browser: the dialog
 * says the properties don't match the code, one action declares what the code takes (and drops the starter properties
 * it never reads), the result shows in the Properties tab, and creating the component saves those properties.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://code-props-sync.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { NewCodeComponentModal } from ${renderer('panels/SourceModal')};`,
  `import { useStore } from ${renderer('store')};`,
  "flushSync(() => useStore.setState({ screen: 'editor', modal: { kind: 'newCode' }, settings: { ai: {} }, providers: [] }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(NewCodeComponentModal)));"
].join('\n');

/**
 * The preload bridge: the code checks clean and takes what `window.__taken` says (the pricing component's props),
 * and each edit applied is recorded; every other call answers nothing.
 */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.__applied = [];
  const answers = {
    validateSource: async () => ({ ok: true, errors: [], diagnostics: [], props: window.__taken }),
    apply: async (batch) => (window.__applied.push(batch), { ok: true, revision: 2 })
  };
  const project = new Proxy({}, { get: (_, key) => answers[key] ?? any('project.' + String(key)) });
  window.builder = new Proxy({}, { get: (_, key) => (key === 'project' ? project : key === 'then' ? undefined : any(String(key))) });
`;

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'code-props-sync', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the new component dialog did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('declaring a new code component’s properties from its code (#1527)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;
  let errors: string[];
  const taken = { props: [{ name: 'heading', default: { value: 'Simple pricing' } }, { name: 'monthly', default: { value: 29 } }, { name: 'discount', default: { value: 20 } }], handed: false, axes: [] };

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  it('declares the props the code takes, drops the unread starter property, and creates the component with them', async () => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) => {
      if (new URL(route.request().url()).pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}window.__taken = ${JSON.stringify(taken)};</script><script src="/app.js"></script>` });
    });
    await page.goto(`${SITE}/`);
    await page.locator('.cm-content').waitFor();
    const note = page.locator('.code-props-sync');
    await note.waitFor();
    expect(await note.textContent()).toContain('The code takes monthly and discount, which are not properties.');
    expect(await note.textContent()).toContain('It writes “Simple pricing” as the default for “Heading”, which has “Hello”.');
    expect(await note.textContent()).toContain('Declaring removes “Text”, which it never reads.');
    await note.getByRole('button', { name: 'Declare from code' }).click();
    // The result is shown to review, and once it matches the code the note goes.
    await page.getByRole('tab', { name: /Properties \(3\)/, selected: true }).waitFor();
    await note.waitFor({ state: 'detached' });
    await page.getByLabel('Name', { exact: true }).fill('Pricing');
    await page.locator('button.code-save').click();
    await page.waitForFunction('window.__applied.length > 0');
    const [batch] = (await page.evaluate('window.__applied')) as Array<{ operations: Array<{ properties: Record<string, { type: string; default: unknown }> }> }>;
    const properties = batch.operations[0].properties;
    expect(Object.keys(properties)).toEqual(['heading', 'monthly', 'discount']);
    expect(properties.heading.default).toBe('Simple pricing');
    expect(properties.monthly).toMatchObject({ type: 'number', label: 'Monthly', default: 29 });
  });
});
