/**
 * The source editor of a code component whose file was edited outside the app into code with errors (#1533), in a real
 * browser: it says it shows the last version that loaded and why the file was not, offers the file, and saving waits
 * for the file to be put right instead of writing over the outside edit.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, sourceHash } from '@engine/apply';
import { EXTERNAL_SOURCE_REFUSED } from '@shared/api';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://source-refused.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { SourceModal } from ${renderer('panels/SourceModal')};`,
  `import { useStore } from ${renderer('store')};`,
  "flushSync(() => useStore.setState({ screen: 'editor', modal: { kind: 'source', definitionId: window.__id }, settings: { ai: {} }, providers: [], snapshot: { dir: '/projects/site', state: window.__project, revision: 1, workspaceKey: 'w1', conflicts: [], diagnostics: window.__diagnostics } }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(SourceModal, { definitionId: window.__id })));",
  // The file put right: the refusal goes, as the next snapshot brings it; or the refusal changes.
  "window.__settle = (diagnostics = []) => flushSync(() => useStore.setState((s) => ({ snapshot: { ...s.snapshot, diagnostics } })));"
].join('\n');

/**
 * The preload bridge: the component's source is read, its code checks clean, and each file revealed and each edit
 * applied is recorded; every other call answers nothing.
 */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.__revealed = [];
  window.__applied = [];
  const answers = {
    readSource: async () => window.__source,
    validateSource: async () => ({ ok: true, errors: [], diagnostics: [], props: null }),
    apply: async (batch) => (window.__applied.push(batch), { ok: true, revision: 2 })
  };
  const project = new Proxy({}, { get: (_, key) => answers[key] ?? any('project.' + String(key)) });
  const projects = new Proxy({}, { get: (_, key) => (key === 'reveal' ? async (p) => void window.__revealed.push(p) : any('projects.' + String(key))) });
  window.builder = new Proxy({}, { get: (_, key) => (key === 'project' ? project : key === 'projects' ? projects : key === 'then' ? undefined : any(String(key))) });
`;

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'source-refused', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the source editor did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('the source editor of a component whose outside edit was refused (#1533)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;
  let errors: string[];
  const source = '<p>Hello</p>\n';
  const { state } = applyOperations(createStarterState('blank', 'Test Studio', false), [{ type: 'component.createCode', name: 'Greeting', source }]);
  const def = Object.values(state.components).find((d) => d.name === 'Greeting')!;
  const path = def.sourcePath!;
  const message = `The edited code for "Greeting" has problems, so it was not loaded (${path}, line 3): Unexpected token`;
  const refusal = { severity: 'error', code: EXTERNAL_SOURCE_REFUSED, message, owner: { kind: 'component', id: def.id }, site: path };
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

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

  const open = async (diagnostics: unknown[] = [refusal]) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const globals = `window.__project = ${json(state)}; window.__id = ${json(def.id)}; window.__diagnostics = ${json(diagnostics)}; window.__source = ${json({ source, hash: sourceHash(source), path, editable: true })};`;
    await page.route(`${SITE}/**`, (route) => {
      if (new URL(route.request().url()).pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}${globals}</script><script src="/app.js"></script>` });
    });
    await page.goto(`${SITE}/`);
    await page.locator('.cm-content').waitFor();
  };

  it('says it shows the last version that loaded, offers the file, and holds saving until the file is put right', async () => {
    await open();
    const notice = page.getByRole('alert').filter({ hasText: 'The file on disk has an edit that was not loaded.' });
    await notice.waitFor();
    expect(await notice.textContent()).toContain(message);
    expect(await notice.textContent()).toContain('This is the last version that loaded.');
    expect(await page.locator('.code-foot-note').textContent()).toBe('Showing the last version that loaded. Saving waits until the file on disk is fixed.');
    await notice.getByRole('button', { name: 'Show file' }).click();
    expect(await page.evaluate('window.__revealed')).toEqual([`/projects/site/${path}`]);
    // An edit made here waits too: it is based on the version that loaded, and saving it would write over the file.
    await page.locator('.cm-content').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' typed');
    await page.getByText('This is the last version that loaded, and your edits are based on it.', { exact: false }).waitFor();
    expect(await page.locator('button.code-save').isDisabled()).toBe(true);
    // Past the live check (which reads the code a moment after it changes), saving still waits, and nothing is written.
    await page.waitForTimeout(900);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    expect(await page.locator('button.code-save').isDisabled()).toBe(true);
    expect(await page.evaluate('window.__applied')).toEqual([]);
    // The file put right: the notice goes, and the edit can be saved.
    await page.evaluate('window.__settle()');
    await notice.waitFor({ state: 'detached' });
    await page.waitForFunction(`!document.querySelector('button.code-save').disabled`);
  });

  it('says a fixed file waits on the others refused with it', async () => {
    const held = { ...refusal, severity: 'warning', message: `The edited code for "Greeting" (${path}) has not loaded yet: it waits, because other edited code has problems.` };
    await open([held]);
    const notice = page.getByRole('alert').filter({ hasText: 'The file on disk has an edit that is waiting to load.' });
    await notice.waitFor();
    expect(await notice.textContent()).toContain(held.message);
    expect(await page.locator('.code-foot-note').textContent()).toBe('Showing the last version that loaded. Saving waits until the file on disk loads.');
  });
});
