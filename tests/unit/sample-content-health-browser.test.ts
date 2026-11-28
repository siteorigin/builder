/**
 * Sample content in Project health, in a real browser (#1640): each finding leads to its field and can be kept as it
 * is, which this project's workspace state remembers for that finding alone; a read-only project offers no keeping.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { validateState } from '@engine/validate';
import { keptSampleKey } from '@engine/sample-content';
import { sampleDiagnostics, sampleGroups } from '../../src/renderer/src/lib/sample-review';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://sample-health.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  `import ${renderer('styles/index.css')};`,
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { HealthModal } from ${renderer('panels/StatusBar')};`,
  `import { useStore } from ${renderer('store')};`,
  'const snapshot = (diagnostics) => ({ state: window.__project, revision: 1, workspaceKey: "w1", conflicts: [], recentExports: [], savedCopies: [], assetUsage: {}, diagnostics, ...(window.__readOnly ? { readOnly: { reason: "Another copy has it open." } } : {}) });',
  "flushSync(() => useStore.setState({ screen: 'editor', modal: { kind: 'health' }, keptSampleContent: [], snapshot: snapshot(window.__diagnostics) }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(HealthModal)));",
  // The project as main sends it again, without what was kept.
  'window.__send = (diagnostics) => flushSync(() => useStore.setState({ snapshot: snapshot(diagnostics) }));',
  'window.__kept = () => useStore.getState().keptSampleContent;'
].join('\n');

/** The preload bridge: every call answers nothing, and each workspace state saved is recorded on window.__saved. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.__saved = [];
  const project = new Proxy({}, { get: (_, key) => (key === 'saveLocalState' ? async (state, key) => void window.__saved.push([state, key]) : any('project.' + String(key))) });
  window.builder = new Proxy({}, { get: (_, key) => (key === 'project' ? project : key === 'then' ? undefined : any(String(key))) });
`;

async function bundle(): Promise<{ script: string; styles: string }> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'sample-health', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const files = (Array.isArray(out) ? out[0] : out).output;
  const chunk = files.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Project health did not bundle');
  return { script: chunk.code, styles: files.map((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? String(o.source) : '')).join('\n') };
}

describe.skipIf(!browserInstalled)('sample content in Project health (#1640)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let built: { script: string; styles: string };
  let page: Page;
  let errors: string[];
  const state = createStarterState('business', 'Test Studio', false);
  const found = validateState(state).filter((d) => d.code.startsWith('SAMPLE_'));
  // The starter's sample contact details (#1633), which Project health lists beside them with their own choices.
  const contacts = sampleDiagnostics(sampleGroups(state), []);
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

  beforeAll(async () => {
    [built, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);
  afterEach(async () => {
    await page.context().close();
    expect(errors).toEqual([]);
  });

  const open = async (readOnly = false) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: built.script });
      if (path === '/app.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: built.styles });
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script>${BRIDGE}window.__project = ${json(state)}; window.__diagnostics = ${json(found)}; window.__readOnly = ${readOnly};</script><script src="/app.js"></script>`
      });
    });
    await page.goto(`${SITE}/`);
    await page.locator('[data-group="warnings"] .health-row').first().waitFor();
  };

  const warnings = () => page.locator('[data-group="warnings"] .health-row');
  const row = (text: string) => warnings().filter({ hasText: text });

  it('lists each finding with the way to its field and a way to keep it, and remembers the one kept', async () => {
    await open();
    expect(contacts.map((d) => d.code)).toEqual(['SAMPLE_CONTACT', 'SAMPLE_CONTACT', 'SAMPLE_CONTACT']);
    expect(await warnings().count()).toBe(found.length + contacts.length);
    expect(await page.getByRole('button', { name: 'Keep as is' }).count()).toBe(found.length);
    const heading = 'Calm, considered spaces for everyday life';
    const kept = found.find((d) => d.message.includes(heading))!;
    await expect.poll(() => row(heading).getByRole('button').allTextContents()).toEqual(['Go to field', 'Keep as is']);
    expect(await row('The site description is still sample text').getByRole('button').allTextContents()).toEqual(['Go to Default description', 'Keep as is']);
    await row(heading).getByRole('button', { name: 'Keep as is' }).click();
    expect(await page.evaluate('window.__saved')).toEqual([[{ keptSampleContent: [keptSampleKey(kept)] }, 'w1']]);
    expect(await page.evaluate('window.__kept()')).toEqual([keptSampleKey(kept)]);
    // Main sends the project again without it: its row goes, the others stay, and what happened is said.
    await page.evaluate(`window.__send(${json(found.filter((d) => d !== kept))})`);
    await expect.poll(() => warnings().count()).toBe(found.length + contacts.length - 1);
    expect(await row(heading).count()).toBe(0);
    await expect.poll(() => page.getByText('Kept as it is. Project health no longer lists it.').count()).toBeGreaterThan(0);
  });

  it('offers no keeping in a project open read-only', async () => {
    await open(true);
    expect(await warnings().filter({ hasText: 'still' }).count()).toBe(found.length + contacts.length);
    expect(await page.getByRole('button', { name: 'Keep as is' }).count()).toBe(0);
  });
});
