/**
 * The code workspace (#1483) in a real browser: it lists the project's code components and its own files, edits a
 * project file and saves it only over what was read, asks before unsaved edits are left, offers the choice when the
 * file changed on disk, previews in a frame that never speaks for the canvas, hands files to the developer's editor
 * and runs the project's checks.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations, sourceHash } from '@engine/apply';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://workspace.test';
const PREVIEW = 'http://127.0.0.1:47123';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h, Fragment } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { CodeWorkspace } from ${renderer('panels/CodeWorkspace')};`,
  `import { ConfirmHost } from ${renderer('components/ConfirmDialog')};`,
  `import { useStore } from ${renderer('store')};`,
  "flushSync(() => useStore.setState({ screen: 'editor', modal: { kind: 'code-workspace' }, pageId: window.__pageId, runtime: { state: 'ready', url: window.__preview }, settings: { developerMode: window.__dev !== false, ai: {}, externalEditor: { kind: 'system' } }, providers: [], snapshot: { dir: '/projects/site', state: window.__project, revision: 1, workspaceKey: 'w1', conflicts: [], diagnostics: [] } }));",
  'flushSync(() => createRoot(document.getElementById(\'root\')).render(h(Fragment, null, h(CodeWorkspace, window.__start ? { start: window.__start } : {}), h(ConfirmHost, {}))));',
  // A change to the project from elsewhere (an undo, the AI): the component removed.
  "window.__remove = (id) => flushSync(() => useStore.setState((s) => { const components = { ...s.snapshot.state.components }; delete components[id]; return { snapshot: { ...s.snapshot, revision: 2, state: { ...s.snapshot.state, components } } }; }));"
].join('\n');

/**
 * The preload bridge: the project's files as `window.__files` holds them (an outside edit changes that), each call
 * recorded in `window.__calls`, events sent with `window.__emit`, and every other call answering nothing.
 */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
  });
  window.__calls = [];
  window.__listeners = {};
  window.__emit = (channel, payload) => (window.__listeners[channel] || []).forEach((cb) => cb(payload));
  let saves = 0;
  const answers = {
    codeFiles: async () => ({ ok: true, files: Object.keys(window.__files).sort().map((path) => ({ path, size: window.__files[path].text.length })), truncated: false, readOnly: null }),
    readCodeFile: async (opening, path) => {
      window.__calls.push(['read', path, opening]);
      const f = window.__files[path];
      return f ? { ok: true, path, text: f.text, hash: f.hash, readOnly: null } : { ok: false, reason: 'gone', message: path + ' is no longer in the project.' };
    },
    saveCodeFile: async (opening, path, text, hash) => {
      window.__calls.push(['save', path, text, hash]);
      const f = window.__files[path];
      if (f.hash !== hash) return { ok: false, reason: 'changed', message: path + ' changed on disk since it was opened, so it was not saved.' };
      f.text = text;
      f.hash = 'saved-' + ++saves;
      return { ok: true, hash: f.hash };
    },
    readSource: async () => window.__source,
    validateSource: async () => (window.__calls.push(['validate']), { ok: true, errors: [], diagnostics: [], props: null }),
    prepareComponentPreview: async (spec) => (window.__calls.push(['prepare', spec.definitionId]), { ok: true, key: 'k-' + spec.definitionId, path: '/__preview/' + spec.definitionId, definitionId: spec.definitionId }),
    releaseComponentPreview: async (key) => void window.__calls.push(['release', key]),
    openInEditor: async (opening, target) => (window.__calls.push(['editor', target, opening]), { ok: true }),
    checks: async () => [],
    runCheck: async (opening, task) => (window.__calls.push(['run', task]), { ok: true, run: { runId: 'r1', task, opening, status: 'running', lines: [], problems: [], startedAt: 1 } }),
    previewLog: async () => []
  };
  const project = new Proxy({}, { get: (_, key) => answers[key] ?? any('project.' + String(key)) });
  const on = (channel, cb) => ((window.__listeners[channel] = [...(window.__listeners[channel] || []), cb]), () => (window.__listeners[channel] = window.__listeners[channel].filter((c) => c !== cb)));
  window.builder = new Proxy({}, { get: (_, key) => (key === 'project' ? project : key === 'on' ? on : key === 'platform' ? 'darwin' : key === 'then' ? undefined : any(String(key))) });
`;

/** A page of the preview's server: it says it is ready as the editor's bridge does, then throws. */
const PREVIEW_PAGE = `<!doctype html><meta charset="utf-8"><body><p>Preview</p><script>
  const say = (type, payload) => parent.postMessage({ protocolVersion: 1, sessionId: window.name, navigationId: 'doc.1', revision: 1, type, payload }, '*');
  say('ready', { path: location.pathname });
  setTimeout(() => say('runtimeError', { message: 'boom: helper threw', file: '/src/lib/util.js' }), 50);
</script>`;

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'code-workspace', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the code workspace did not bundle');
  return chunk.code;
}

const save = (page: Page) => page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');

describe.skipIf(!browserInstalled)('the code workspace (#1483)', { timeout: 60_000 }, () => {
  let browser: Browser;
  let script: string;
  let page: Page;
  let errors: string[];
  const source = '<p>Hello</p>\n';
  const { state } = applyOperations(createStarterState('blank', 'Test Studio', false), [{ type: 'component.createCode', name: 'Greeting', source }]);
  const def = Object.values(state.components).find((d) => d.name === 'Greeting')!;
  const home = Object.values(state.pages)[0];
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  const calls = async () => (await page.evaluate('window.__calls')) as unknown[][];

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

  const open = async (setup: { dev?: boolean; start?: unknown } = {}) => {
    page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })).newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const files = { 'src/lib/util.js': { text: 'export const a = 1;\n', hash: 'h-util' }, 'src/lib/Card.svelte': { text: '<p>card</p>\n', hash: 'h-card' }, 'src/routes/api/hello/+server.js': { text: 'export function GET() {}\n', hash: 'h-server' } };
    const globals = `window.__dev = ${json(setup.dev ?? true)}; window.__start = ${json(setup.start ?? null)}; window.__project = ${json(state)}; window.__pageId = ${json(home.id)}; window.__preview = ${json(PREVIEW)}; window.__files = ${json(files)}; window.__source = ${json({ source, hash: sourceHash(source), path: def.sourcePath, editable: true })};`;
    await page.route(`${SITE}/**`, (route) => {
      if (new URL(route.request().url()).pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><body><div id="root"></div><script>${BRIDGE}${globals}</script><script src="/app.js"></script>` });
    });
    await page.route(`${PREVIEW}/**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: PREVIEW_PAGE }));
    await page.goto(`${SITE}/`);
    if (setup.dev === false) await page.locator('.cm-content').waitFor();
    else await page.getByRole('navigation', { name: 'Project code' }).waitFor();
  };
  const openFile = async (name: string) => {
    await page.locator('.cw-file', { hasText: name }).click();
    await page.locator('.code-title-name', { hasText: name }).waitFor();
    await page.locator('.cm-content').waitFor();
  };

  it('lists the components and the project’s own files, and saves a file over what was read', async () => {
    await open();
    const list = page.getByRole('navigation', { name: 'Project code' });
    expect(await list.getByRole('group', { name: 'Code components' }).textContent()).toContain('Greeting');
    expect(await list.getByRole('group', { name: 'src/lib/' }).textContent()).toContain('util.js');
    expect(await list.getByRole('group', { name: 'src/routes/api/hello/' }).textContent()).toContain('+server.js');
    await openFile('util.js');
    // Highlighted, not checked as a component would be: the strip says what the file is.
    expect(await page.locator('.code-status').textContent()).toContain('JavaScript');
    await page.locator('.cm-content').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
    await page.keyboard.type('export const b = 2;');
    await page.locator('.code-chip.unsaved').waitFor();
    await save(page);
    await page.getByText('Saved to the file. The preview shows it.').waitFor();
    expect((await calls()).filter((c) => c[0] === 'save')).toEqual([['save', 'src/lib/util.js', 'export const a = 1;\nexport const b = 2;', 'h-util']]);
    expect((await calls()).some((c) => c[0] === 'validate')).toBe(false);
  });

  it('asks before leaving unsaved edits, and keeps them when asked to', async () => {
    await open();
    await openFile('util.js');
    await page.locator('.cm-content').click();
    await page.keyboard.type('// mine ');
    await page.locator('.cw-file', { hasText: '+server.js' }).click();
    const ask = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'Discard your changes?' }));
    await ask.getByRole('button', { name: 'Keep editing' }).click();
    expect(await page.locator('.code-title-name').textContent()).toBe('util.js');
    expect(await page.locator('.cm-content').textContent()).toContain('// mine');
    await page.locator('.cw-file', { hasText: '+server.js' }).click();
    await ask.getByRole('button', { name: 'Discard changes' }).click();
    await page.locator('.code-title-name', { hasText: '+server.js' }).waitFor();
  });

  it('offers the newer version when the file changed on disk, with Undo back to the edits', async () => {
    await open();
    await openFile('util.js');
    await page.locator('.cm-content').click();
    await page.keyboard.type('// mine ');
    // Saved by another editor meanwhile.
    await page.evaluate(`window.__files['src/lib/util.js'] = { text: 'export const theirs = true;\\n', hash: 'h-theirs' }`);
    await save(page);
    const notice = page.getByRole('alert').filter({ hasText: 'This file changed on disk since you started editing it.' });
    await notice.waitFor();
    expect(await page.locator('button.code-save').isDisabled()).toBe(true);
    await notice.getByRole('button', { name: 'Use the newer version' }).click();
    await page.waitForFunction(`document.querySelector('.cm-content').textContent.includes('theirs')`);
    // Nothing was written over the newer version.
    expect((await calls()).filter((c) => c[0] === 'save')).toHaveLength(1);
    expect(await page.evaluate(`window.__files['src/lib/util.js'].text`)).toBe('export const theirs = true;\n');
  });

  it('keeps edits over a newer version on disk when asked: Revert then shows that version, and Save replaces only it', async () => {
    await open();
    await openFile('util.js');
    await page.locator('.cm-content').click();
    await page.keyboard.type('// mine ');
    await page.evaluate(`window.__files['src/lib/util.js'] = { text: 'export const theirs = true;\\n', hash: 'h-theirs' }`);
    await save(page);
    const notice = page.getByRole('alert').filter({ hasText: 'This file changed on disk since you started editing it.' });
    await notice.getByRole('button', { name: 'Keep my edits' }).click();
    // The choice made, focus is back in the code.
    await page.waitForFunction(`document.activeElement?.classList.contains('cm-content')`);
    await save(page);
    await page.getByText('Saved to the file. The preview shows it.').waitFor();
    // Saved over the newer version it was shown, never over the one first read.
    expect((await calls()).filter((c) => c[0] === 'save').map((c) => c[3])).toEqual(['h-util', 'h-theirs']);
    // Another round: kept again, then reverted, shows what is on disk, with nothing left to save.
    await page.locator('.cm-content').click();
    await page.keyboard.type('// again ');
    await page.evaluate(`window.__files['src/lib/util.js'] = { text: 'export const third = 3;\\n', hash: 'h-third' }`);
    await save(page);
    await notice.getByRole('button', { name: 'Keep my edits' }).click();
    await page.getByRole('button', { name: 'Revert' }).click();
    await page.getByRole('button', { name: 'Revert changes' }).click();
    await page.waitForFunction(`document.querySelector('.cm-content').textContent.includes('third')`);
    expect(await page.locator('button.code-save').isDisabled()).toBe(true);
  });

  it('brings the edits back with Undo after taking the newer version', async () => {
    await open();
    await openFile('util.js');
    await page.locator('.cm-content').click();
    await page.keyboard.type('// mine ');
    await page.evaluate(`window.__files['src/lib/util.js'] = { text: 'export const theirs = true;\\n', hash: 'h-theirs' }`);
    await save(page);
    await page.getByRole('button', { name: 'Use the newer version' }).click();
    await page.waitForFunction(`document.querySelector('.cm-content').textContent.includes('theirs')`);
    await page.locator('.cm-content').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForFunction(`document.querySelector('.cm-content').textContent.includes('// mine')`);
    await page.locator('.code-chip.unsaved').waitFor();
  });

  it('keeps the dialog, its preview and its checks as files are opened', async () => {
    await open();
    await page.getByRole('button', { name: 'Checks' }).click();
    await page.getByRole('tab', { name: 'Tests' }).click();
    await page.locator('.cw-file', { hasText: 'Greeting' }).click();
    await page.locator('.code-title-name', { hasText: 'Greeting' }).waitFor();
    await openFile('util.js');
    await page.evaluate(`document.querySelector('.cw-preview iframe').dataset.kept = 'yes'`);
    await openFile('+server.js');
    expect(await page.getByRole('tab', { name: 'Tests' }).getAttribute('aria-selected')).toBe('true');
    expect(await page.locator('.cw-preview iframe').getAttribute('data-kept')).toBe('yes');
  });

  it('keeps a removed component’s code on screen to copy, and asks before it goes', async () => {
    await open();
    await page.locator('.cw-file', { hasText: 'Greeting' }).click();
    await page.locator('.cm-content').waitFor();
    await page.locator('.cm-content').click();
    await page.keyboard.type('<b>draft</b>');
    await page.evaluate(`window.__remove(${json(def.id)})`);
    await page.locator('.code-title-name', { hasText: 'Component removed' }).waitFor();
    expect(await page.locator('.cm-content').textContent()).toContain('<b>draft</b>');
    // Nothing is left to save it to: the save key checks and writes nothing.
    const checked = (await calls()).filter((c) => c[0] === 'validate').length;
    await page.locator('.cm-content').click();
    await save(page);
    await page.waitForTimeout(800);
    expect((await calls()).filter((c) => c[0] === 'validate').length).toBe(checked);
    await page.locator('.cw-file', { hasText: 'util.js' }).click();
    const ask = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'Discard the changes you were making?' }));
    await ask.getByRole('button', { name: 'Keep it open' }).click();
    expect(await page.locator('.code-title-name').textContent()).toBe('Component removed');
  });

  it('is only the component’s editor without Developer mode', async () => {
    await open({ dev: false, start: { kind: 'component', definitionId: def.id } });
    expect(await page.locator('.code-title-name').textContent()).toBe('Greeting');
    expect(await page.getByRole('navigation', { name: 'Project code' }).count()).toBe(0);
    expect(await page.getByRole('toolbar', { name: 'Code workspace' }).count()).toBe(0);
    expect(await page.locator('.cw-preview').count()).toBe(0);
    expect((await calls()).some((c) => c[0] === 'prepare')).toBe(false);
  });

  it('previews in a frame that never speaks for the canvas, a page or a component on its own', async () => {
    await open();
    const frame = page.locator('.cw-preview iframe');
    await frame.waitFor();
    expect(await frame.getAttribute('name')).toMatch(/^so-measure-/);
    expect(await frame.getAttribute('src')).toBe(PREVIEW + home.route);
    await page.locator('.cw-file', { hasText: 'Greeting' }).click();
    await page.waitForFunction(`document.querySelector('.cw-preview iframe')?.getAttribute('src') === ${json(`${PREVIEW}/__preview/${def.id}`)}`);
    expect(await calls()).toContainEqual(['prepare', def.id]);
    // Leaving the component lets go of its preview's files.
    await page.locator('.cw-file', { hasText: 'util.js' }).click();
    await page.waitForFunction(`window.__calls.some((c) => c[0] === 'release' && c[1] === ${json(`k-${def.id}`)})`);
    // What the page threw is listed with the checks.
    await page.getByRole('button', { name: 'Checks' }).click();
    await page.getByRole('tab', { name: /Preview log/ }).click();
    await page.getByText('The page threw: boom: helper threw').waitFor();
  });

  it('hands the open file and the project’s folder to the developer’s editor', async () => {
    await open();
    await openFile('util.js');
    await page.getByRole('button', { name: 'Open in editor' }).click();
    await page.getByRole('button', { name: 'Open project folder' }).click();
    await page.waitForFunction(`window.__calls.filter((c) => c[0] === 'editor').length === 2`);
    expect((await calls()).filter((c) => c[0] === 'editor')).toEqual([
      ['editor', { kind: 'file', path: 'src/lib/util.js' }, 'w1'],
      ['editor', { kind: 'project' }, 'w1']
    ]);
    expect((await calls()).filter((c) => c[0] === 'read').every((c) => c[2] === 'w1')).toBe(true);
  });

  it('runs the Svelte check and opens the file a problem is in', async () => {
    await open();
    await page.getByRole('button', { name: 'Checks' }).click();
    await page.getByRole('button', { name: 'Check Svelte files' }).click();
    await page.waitForFunction(`window.__calls.some((c) => c[0] === 'run' && c[1] === 'svelte')`);
    await page.evaluate(`window.__emit('project-check:update', { runId: 'r1', task: 'svelte', opening: 'w1', status: 'failed', lines: [], problems: [{ file: 'src/lib/Card.svelte', line: 1, message: 'Unexpected token' }, { file: 'src/routes/+page.svelte', line: 4, message: 'Generated' }], summary: '2 of 9 Svelte files did not compile.', startedAt: 1, endedAt: 2 })`);
    await page.getByText('2 of 9 Svelte files did not compile.').waitFor();
    // A generated file is named, not opened: it is the app's.
    expect(await page.locator('span.cw-problem', { hasText: 'src/routes/+page.svelte' }).count()).toBe(1);
    await page.getByRole('button', { name: /src\/lib\/Card\.svelte:1/ }).click();
    await page.locator('.code-title-name', { hasText: 'Card.svelte' }).waitFor();
  });
});
