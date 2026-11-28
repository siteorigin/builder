/**
 * The website export's check of each built page in a real headless Chromium (#1534): the steps the app's hidden window
 * runs (src/main/page-check.ts), driven through a DevTools session on pages of a website folder served as the export
 * serves it, under a base path. Each page starts as SvelteKit's do: its script loads another, then either says it has
 * started (the announcer SvelteKit adds) or, as when a code component's `$effect` writes the state it reads, logs the
 * error and puts the site's error page in place of the page's content.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type CDPSession } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_SECTION_CLASS } from '@generator/index';
import { StaticPreviews } from '../../src/main/static-preview';
import { checkBuiltPage, type PageCheck } from '../../src/main/page-check';
import type { CdpPage } from '../../src/main/review-shot';

const browserInstalled = existsSync(chromium.executablePath());
const LOOP = 'https://svelte.dev/e/effect_update_depth_exceeded';

let root = '';
let server = '';
let browser: Browser;
const previews = new StaticPreviews();

/** A built page: its sections in the layout's main element, and the script that starts it from /client/<name>.js. */
const page = (name: string, sections = '<section class="hero"><h1>Welcome</h1></section><section class="loop"><p>Loop count 0</p></section>') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><div style="display: contents"><a href="#main">Skip</a><header>Site</header><main id="main">${sections}</main><footer>Footer</footer></div><script>import('/client/${name}.js');</script></body></html>`;

/** What SvelteKit adds once it has hydrated the page and run its first navigation callbacks. */
const STARTED = `const a = document.createElement('div'); a.id = 'svelte-announcer'; a.setAttribute('aria-live', 'assertive'); document.body.append(a);`;
/** The site's error page in place of the page's content, as the generated +error.svelte renders it. */
const ERROR_PAGE = `document.title = 'Error 500'; document.querySelector('main#main').innerHTML = '<section class="${ERROR_SECTION_CLASS}"><div class="so-container"><h1>Error 500</h1><p>Internal Error</p></div></section>';`;
/** The page's own script: it loads its app first, as SvelteKit's does, then runs `then`. */
const script = (then: string) => `await import('/client/app.js');\n${then}\n`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'so-page-check-'));
  const put = (rel: string, body: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  put('app.js', 'export const app = true;\n');
  const route = (name: string, then: string, sections?: string) => {
    put(`${name}/index.html`, page(name, sections));
    put(`${name}.js`, script(then));
  };
  route('working', STARTED);
  // Hydration fails: SvelteKit's error hook logs the error, then the error page takes the page's place.
  route('loop', `console.error(new Error(${JSON.stringify(LOOP)})); ${ERROR_PAGE} ${STARTED}`);
  // SvelteKit has said it started before an awaited error hook answers and the error page is shown.
  route('late', `${STARTED} setTimeout(() => { console.error(new Error('A late failure')); ${ERROR_PAGE} }, 60);`);
  // A page that logs an error of its own (a fetch it could not make) and goes on showing its content.
  route('noisy', `console.error('Could not load the opening hours'); ${STARTED}`);
  // An earlier error of the page's own is not what broke it: the one logged last before the error page is.
  route('earlier', `console.error('Could not load the opening hours'); await new Promise((r) => setTimeout(r, 30)); console.error(new Error(${JSON.stringify(LOOP)})); ${ERROR_PAGE} ${STARTED}`);
  // An error the browser is never told of (the project's own error hook keeps it to itself).
  route('silent', `${ERROR_PAGE} ${STARTED}`);
  // A page whose own content is a section of that class, among others, still fails when the error page takes its place.
  route('own-class', `console.error(new Error('Broken')); ${ERROR_PAGE} ${STARTED}`, `<section class="${ERROR_SECTION_CLASS}"><p>Our own</p></section><section class="hero"><h1>Welcome</h1></section>`);
  // A page built showing nothing but a section of that class cannot be told from one that failed: it is not failed.
  route('built-so', STARTED, `<section class="${ERROR_SECTION_CLASS}"><div><h1>Error 500</h1></div></section>`);
  // A page whose script never says it has started.
  route('stuck', 'void 0;');
  server = await previews.serve(root, '/client');
  if (browserInstalled) browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  previews.stopAll();
  rmSync(root, { recursive: true, force: true });
});

/** A fresh page and a DevTools session on it, as the app opens a fresh hidden window for each check. */
async function session(): Promise<{ cdp: CdpPage; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: null });
  const p = await context.newPage();
  const s: CDPSession = await context.newCDPSession(p);
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  const events = ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed', 'Page.loadEventFired', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown'] as const;
  for (const name of events) s.on(name, (params: unknown) => listeners.forEach((l) => l(name, params as Record<string, unknown>)));
  return {
    cdp: {
      send: (method, params) => s.send(method as never, params as never) as Promise<unknown>,
      listen: (l) => (listeners.add(l), () => void listeners.delete(l))
    },
    close: () => context.close()
  };
}

async function check(route: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PageCheck> {
  const { cdp, close } = await session();
  try {
    return await checkBuiltPage(cdp, new URL(`${route}/`, server).href, opts);
  } finally {
    await close();
  }
}

describe.skipIf(!browserInstalled)('opening a built page in a browser', () => {
  it('finds a page whose content the site’s error page took the place of once it started, with the error the browser was told of', async () => {
    const r = await check('loop');
    expect(r).toMatchObject({ status: 'error-page', heading: 'Error 500' });
    if (r.status !== 'error-page') return;
    expect(r.cause?.split('\n')[0]).toBe(`Error: ${LOOP}`);
    expect(r.logged).toHaveLength(1);
  });

  it('takes a page that still shows what was built once it started as working', async () => {
    expect(await check('working')).toEqual({ status: 'working' });
  });

  it('watches a page a moment after it says it started, for an error page an awaited error hook brings', async () => {
    expect(await check('late')).toMatchObject({ status: 'error-page', heading: 'Error 500', cause: expect.stringContaining('A late failure') });
  });

  it('takes a page that logs an error of its own and goes on showing its content as working', async () => {
    expect(await check('noisy')).toEqual({ status: 'working' });
  });

  it('gives the error logged last before the error page appeared as the cause, and keeps every one', async () => {
    const r = await check('earlier');
    expect(r).toMatchObject({ status: 'error-page' });
    if (r.status !== 'error-page') return;
    expect(r.cause).toContain(LOOP);
    expect(r.logged.map((l) => l.split('\n')[0])).toEqual(['Could not load the opening hours', `Error: ${LOOP}`]);
  });

  it('finds the error page when the browser was told of no error', async () => {
    expect(await check('silent')).toEqual({ status: 'error-page', heading: 'Error 500', cause: null, logged: [] });
  });

  it('finds the error page on a page whose own content has a section of its class among others', async () => {
    expect(await check('own-class')).toMatchObject({ status: 'error-page', cause: expect.stringContaining('Broken') });
  });

  it('takes a page built showing only a section of the error page’s class as working', async () => {
    expect(await check('built-so')).toEqual({ status: 'working' });
  });

  it('says a page that never starts could not be checked, rather than working or failed', async () => {
    expect(await check('stuck', { timeoutMs: 1500 })).toEqual({ status: 'unchecked', detail: 'The page did not finish starting in time.' });
  });

  it('says a page the server does not have could not be checked', async () => {
    expect(await check('missing')).toMatchObject({ status: 'unchecked', detail: expect.stringContaining('404') });
  });

  it('stops when called off', async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await check('working', { signal: stop.signal })).toEqual({ status: 'unchecked', detail: 'The check was stopped.' });
  });
});
