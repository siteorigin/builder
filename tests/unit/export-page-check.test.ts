/**
 * A website export opens each built page in a browser before it delivers anything (#1534). A code component whose
 * `$effect` writes the state it reads builds and prerenders like any other, and only in a browser does SvelteKit put
 * the site's error page in place of the page: the export stops there, naming the page, what the browser said and the
 * component, and delivers nothing. The check is the app's (src/main/page-check.ts), run here in a headless Chromium
 * through the controller's `pageCheck`, on a stand-in build whose pages start in the browser as SvelteKit's do.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  utilityProcess: { fork: () => undefined }
}));

const filesIn = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/')).sort() : [];

/** What SvelteKit adds once it has hydrated a page and run its first navigation callbacks. */
const STARTED = `const a = document.createElement('div'); a.id = 'svelte-announcer'; document.body.append(a);`;
/** A page whose code component writes what its `$effect` reads: SvelteKit's error hook logs it, then shows the error page. */
const LOOPS = `console.error(new Error('https://svelte.dev/e/effect_update_depth_exceeded')); document.title = 'Error 500'; document.querySelector('main#main').innerHTML = '<section class="so-error"><div class="so-container"><h1>Error 500</h1><p>Internal Error</p></div></section>';`;

// The website build without SvelteKit, as in review-build.test.ts: each page module becomes the HTML file a static host
// serves at its address, its source kept in the page as text. A page that imports a project code component with an
// `$effect` in it fails once its script runs; every other one starts.
vi.mock('../../src/main/runtime/manager', async (original) => ({
  ...(await original<typeof import('../../src/main/runtime/manager')>()),
  buildProject: async (dir: string) => {
    const out = join(dir, 'build');
    if (existsSync(join(dir, 'static'))) cpSync(join(dir, 'static'), out, { recursive: true });
    for (const f of filesIn(join(dir, 'src/routes')).filter((f) => f.endsWith('+page.svelte'))) {
      const html = dirname(f).endsWith('.html') ? join(out, dirname(f)) : join(out, dirname(f), 'index.html');
      mkdirSync(dirname(html), { recursive: true });
      const at = join(dir, 'src/routes', dirname(f));
      const source = readFileSync(join(dir, 'src/routes', f), 'utf8');
      const shown = [...source.matchAll(/^\s*import NotFound from '(\.[^']+\/NotFound\.svelte)';$/gm)].map((m) => readFileSync(join(at, m[1]), 'utf8'));
      const code = [...source.matchAll(/from "(\.[^"]*\/lib\/siteorigin\/custom\/[^"]+\.svelte)"/g)].map((m) => readFileSync(resolve(at, m[1]), 'utf8'));
      const loops = code.some((c) => c.includes('$effect('));
      const text = [source, ...shown].join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"></head><body><pre hidden>${text}</pre><main id="main"><section><p>Built</p></section></main><script>__sveltekit_1x2y3z = {};</script><script type="module">await new Promise((r) => setTimeout(r, 10)); ${loops ? LOOPS : ''} ${STARTED}</script></body></html>`);
    }
    return { ok: true, logs: [] };
  }
}));
vi.mock('../../src/main/runtime/stage', async (original) => ({ ...(await original<typeof import('../../src/main/runtime/stage')>()), KeptTools: class { take = async () => ({ keep: async () => undefined }); } }));

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { checkBuiltPage } = await import('../../src/main/page-check');
const { reviewPages } = await import('@shared/review-edition');
const { publishedState } = await import('@generator/index');
const { brokenPagesStop, routeCodeComponents, uncheckedPagesWarning } = await import('../../src/main/export');
type PageCheck = import('../../src/main/page-check').PageCheck;

const LOOP_SOURCE = `<script>\n\tlet { class: className = '' } = $props();\n\tlet count = $state(0);\n\t$effect(() => { count = count + 1; });\n</script>\n\n<section class={className}><p>Loop count {count}</p></section>\n`;
const FIXED_SOURCE = `<script>\n\tlet { class: className = '' } = $props();\n\tlet count = $state(0);\n</script>\n\n<section class={className}><p>Loop count {count}</p></section>\n`;

const browserInstalled = existsSync(chromium.executablePath());
let browser: Browser;
beforeAll(async () => {
  if (browserInstalled) browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

/** The app's check, in a fresh headless page of its own for each, as the app opens a hidden window for each. */
async function inChromium(url: string, signal: AbortSignal): Promise<PageCheck> {
  const context = await browser.newContext();
  try {
    const s = await context.newCDPSession(await context.newPage());
    const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
    for (const name of ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed', 'Page.loadEventFired', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown'] as const)
      s.on(name, (params: unknown) => listeners.forEach((l) => l(name, params as Record<string, unknown>)));
    return await checkBuiltPage({ send: (m, p) => s.send(m as never, p as never) as Promise<unknown>, listen: (l) => (listeners.add(l), () => void listeners.delete(l)) }, url, { signal });
  } finally {
    await context.close();
  }
}

const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-page-check-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A business site with the issue's code component on its Home page, open in a controller whose pages are checked by `check`. */
async function siteWithLoop(check: (url: string, signal: AbortSignal) => Promise<PageCheck>, opts: { base?: string; source?: string } = {}) {
  const dir = temp('project');
  let state = createStarterState('business', 'Harbour Lane', false);
  if (opts.base) state.site.baseUrl = `https://harbour.example${opts.base}`;
  state = applyOperations(state, [{ type: 'component.createCode', name: 'Visit counter', source: opts.source ?? LOOP_SOURCE, properties: {} }]).state;
  const defId = Object.values(state.components).find((d) => d.name === 'Visit counter')!.id;
  state = applyOperations(state, [{ type: 'node.insert', owner: { kind: 'page', id: state.site.homePageId }, definitionId: defId }]).state;
  await (await ProjectSession.create(dir, state)).close();
  const c = new Controller(() => null);
  c.send = () => undefined;
  c.startRuntime = async () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  const asked: string[] = [];
  c.pageCheck = (url, signal) => (asked.push(url), check(url, signal));
  return { c, dir, defId, asked };
}

describe.skipIf(!browserInstalled)('a website export opens its pages in a browser', () => {
  it('stops for a page that shows the site’s error page once it starts, naming it, the browser’s error and its code component, and delivers nothing', async () => {
    const { c, defId, asked } = await siteWithLoop(inChromium);
    const file = c.snapshot()!.state.components[defId].sourcePath!;
    const dest = join(temp('out'), 'site');
    const r = await c.buildStaticTo(dest);
    expect(r.ok).toBe(false);
    expect(r.message).toBe('“Home” (/) shows “Error 500” in place of its content once it opens in a browser, so visitors would see an error page. Fix it, then export again.');
    expect(r.warnings[0]).toBe('The browser reported: Error: https://svelte.dev/e/effect_update_depth_exceeded');
    expect(r.warnings[1]).toBe(`It shows one code component, the “Visit counter” component (${file}). Look there first: code that runs only in the browser, such as an $effect, does not run while the site is built.`);
    expect(r.details).toContain('Browser errors:');
    expect(r.details).toContain('effect_update_depth_exceeded');
    // Nothing was delivered or listed, and the build's own server is gone.
    expect(existsSync(dest)).toBe(false);
    expect(c.snapshot()!.recentExports).toEqual([]);
    expect(asked[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    await expect(fetch(asked[0])).rejects.toThrow();
  });

  it('stops a ZIP export the same way, before the file is written', async () => {
    const { c } = await siteWithLoop(inChromium);
    const dest = join(temp('out'), 'site.zip');
    const r = await c.buildStaticTo(dest, 'zip');
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('“Home” (/) shows “Error 500”') });
    expect(existsSync(dest)).toBe(false);
  });

  it('delivers the website once the component is fixed, having opened every page under the site’s base path', async () => {
    const { c, asked } = await siteWithLoop(inChromium, { base: '/harbour', source: FIXED_SOURCE });
    const dest = join(temp('out'), 'site');
    const r = await c.buildStaticTo(dest);
    expect(r).toMatchObject({ ok: true });
    expect(r.warnings.join('\n')).not.toMatch(/browser/);
    const routes = reviewPages(publishedState(c.snapshot()!.state)).map((p) => p.route);
    expect(asked.map((u) => new URL(u).pathname).sort()).toEqual(routes.map((r) => `/harbour${r}`).sort());
    expect(existsSync(join(dest, 'index.html'))).toBe(true);
  });

  it('builds a review without opening its pages', async () => {
    const { c, asked } = await siteWithLoop(inChromium);
    expect((await c.stageReviewBuild(join(temp('out'), 'review'))).ok).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe('a website export whose pages could not all be opened', () => {
  it('delivers the website with a warning naming a page that could not be checked', async () => {
    const { c } = await siteWithLoop(async (url) => (new URL(url).pathname === '/' ? { status: 'unchecked', detail: 'The page did not finish starting in time.' } : { status: 'working' }));
    const r = await c.buildStaticTo(join(temp('out'), 'site'));
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain('“Home” (/) could not be opened in a browser to check that it still shows its content once it starts: the page did not finish starting in time.');
  });

  it('delivers nothing when the project closes while its pages are being opened', async () => {
    let started!: () => void;
    const opening = new Promise<void>((r) => (started = r));
    const { c } = await siteWithLoop(
      (_url, signal) =>
        new Promise<PageCheck>((resolve) => {
          started();
          signal.addEventListener('abort', () => resolve({ status: 'unchecked', detail: 'The check was stopped.' }), { once: true });
        })
    );
    const dest = join(temp('out'), 'site');
    const exporting = c.buildStaticTo(dest);
    await opening;
    await c.close();
    const r = await exporting;
    expect(r).toMatchObject({ ok: false, message: 'The project was closed before the export finished.' });
    expect(existsSync(dest)).toBe(false);
  });
});

describe('what the export says of a page that fails in a browser', () => {
  const state = () => {
    let s = createStarterState('business', 'Harbour Lane', false);
    s = applyOperations(s, [
      { type: 'component.createCode', name: 'Visit counter', source: LOOP_SOURCE, properties: {} },
      { type: 'component.createCode', name: 'Opening hours', source: '<section class="hours"><p>Open</p></section>\n', properties: {} }
    ]).state;
    const id = (name: string) => Object.values(s.components).find((d) => d.name === name)!.id;
    const home = s.site.homePageId;
    s = applyOperations(s, [
      { type: 'node.insert', owner: { kind: 'page', id: home }, definitionId: id('Visit counter') },
      { type: 'node.insert', owner: { kind: 'page', id: home }, definitionId: id('Opening hours') }
    ]).state;
    return publishedState(s);
  };
  const failure = (cause: string | null) => ({ status: 'error-page' as const, heading: 'Error 500', cause, logged: cause ? [cause] : [] });

  it('lists the code components a page shows, by name, with their files; none for a page with none', () => {
    const live = state();
    expect(routeCodeComponents(live, '/').map((c) => c.name)).toEqual(['Opening hours', 'Visit counter']);
    expect(routeCodeComponents(live, '/').every((c) => c.file.startsWith('src/lib/siteorigin/custom/'))).toBe(true);
    expect(routeCodeComponents(live, '/contact/')).toEqual([]);
  });

  it('names every code component of the page, the first line of the browser’s error, and the other pages found failing', () => {
    const live = state();
    const stop = brokenPagesStop(live, [
      { page: { route: '/', title: 'Home' }, check: failure('Error: https://svelte.dev/e/effect_update_depth_exceeded\n    at Be (http://127.0.0.1:1/_app/immutable/chunks/a.js:1:2)') },
      { page: { route: '/about/', title: 'About' }, check: failure(null) }
    ]);
    expect(stop.warnings[0]).toBe('The browser reported: Error: https://svelte.dev/e/effect_update_depth_exceeded');
    expect(stop.warnings[1]).toMatch(/^It shows 2 code components\. .*the “Opening hours” component \(src\/lib\/siteorigin\/custom\/[^)]+\), the “Visit counter” component/);
    expect(stop.warnings[2]).toBe('“About” (/about/) shows it too.');
    expect(stop.details).toContain('Page: “About” (/about/)\nShown: Error 500\nBrowser errors: none');
  });

  it('says so when the browser was told of no error, and when the page shows no code component', () => {
    const stop = brokenPagesStop(state(), [{ page: { route: '/contact/', title: 'Contact' }, check: failure(null) }]);
    expect(stop.warnings).toEqual(['The browser was not told what went wrong.', 'It shows no code component of the project’s, so a file of the project’s own may be the cause.']);
  });

  it('sums up the pages that could not be checked', () => {
    expect(uncheckedPagesWarning([])).toBeNull();
    expect(uncheckedPagesWarning([{ page: { route: '/', title: '' }, detail: 'The window to check the page in did not open.' }, { page: { route: '/about/', title: 'About' }, detail: 'x' }])).toBe(
      '2 pages could not be opened in a browser to check that they still show their content once they start, such as /: the window to check the page in did not open.'
    );
  });
});
