/**
 * What the Connect external source dialog says happens to a record the source no longer has (#1389): drafting keeps the
 * entry and the links to it in the project but takes it off the next exported website, where a link to it on a
 * published page stops the export, and each choice says whether the record stays on the website. The real dialog runs
 * in a real browser.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { run } from './fixtures/seo-site';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://source-removal-copy.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { SourceDialog } from ${renderer('panels/SourceDialog')};`,
  `import { useStore } from ${renderer('store')};`,
  "flushSync(() => useStore.setState({ screen: 'editor', snapshot: { dir: '/projects/site', state: window.__project, revision: 1, workspaceKey: 'w1', conflicts: [], diagnostics: [] } }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(SourceDialog, { collectionId: 'team', onClose: () => {} })));"
].join('\n');

/** The preload bridge: no secrets are kept, and every other call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'platform' ? 'darwin' : any(path ? path + '.' + key : key)),
    apply: () => Promise.resolve(path === 'project.sourceSecretNames' ? [] : path === 'on' ? () => {} : undefined)
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
        name: 'source-removal-copy',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The source dialog did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('what the source dialog says of a record that goes away (#1389)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const state = run(createStarterState('blank', 'Test Studio', false), { type: 'collection.create', collectionId: 'team', name: 'Team', kind: 'structured' });
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

  beforeAll(async () => {
    const [script, launched] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
    browser = launched;
    page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>window.__project=${json(state)};${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  const select = () => page.getByLabel('When the source no longer has a record');
  /** What the select is described by: the note a screen reader reads with it. */
  const note = () => select().evaluate((el) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));

  it('says in each choice whether the record stays on the website', async () => {
    expect(await select().locator('option').allTextContents()).toEqual(['Make it a draft (comes off the website)', 'Delete it (comes off the website)', 'Keep it as last synced (stays on the website if published)']);
    expect(errors).toEqual([]);
  });

  it('says a draft keeps its links in the project, and that one on a published page stops the website export', async () => {
    await select().selectOption('unpublish');
    expect(await note()).toBe(
      'Its entry stays in the project as a draft and comes off the next exported website. Links and references to it stay in the editor. Reference fields leave it off the website, but a link to it on a published page or post stops the website export until that link changes.'
    );
  });

  it('says when deleting stops the sync, and that keeping leaves the entry as it was', async () => {
    await select().selectOption('remove');
    expect(await note()).toBe('Its entry is deleted from the project and comes off the next exported website. While a link or reference field elsewhere in the project points to it, or a redirect you added goes to it, the whole sync stops.');
    await select().selectOption('keep');
    expect(await note()).toBe('Its entry stays as it was last synced. A published one stays on the website, and a draft stays a draft.');
    expect(errors).toEqual([]);
  });
});
