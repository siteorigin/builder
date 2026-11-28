/**
 * What a first visit to a built page downloads and shows (#1488), measured in a real headless Chromium by the steps
 * the export's page check runs (src/main/page-check.ts with `measure`, src/main/page-performance.ts), on a website
 * folder served as the export serves it, under a base path: its files by kind and size, including a script only
 * another script imports, a font only its styles ask for and only the copy of each picture the browser chose; which
 * of them the head preloads; each picture's space against its file and its `sizes`; and the largest thing painted.
 * Measuring never changes whether the page works.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { chromium, type Browser, type CDPSession } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticPreviews } from '../../src/main/static-preview';
import { checkBuiltPage, type PageCheck } from '../../src/main/page-check';
import type { CdpPage } from '../../src/main/review-shot';
import type { PageSample } from '@shared/performance';

const browserInstalled = existsSync(chromium.executablePath());

let root = '';
let server = '';
let browser: Browser;
const previews = new StaticPreviews();
const sizes: Record<string, number> = {};

/** What SvelteKit adds once it has hydrated the page. */
const STARTED = `const a = document.createElement('div'); a.id = 'svelte-announcer'; document.body.append(a);`;
const head = (extra: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Page</title><link rel="stylesheet" href="/client/_app/immutable/assets/app.css"><link rel="modulepreload" href="/client/_app/immutable/entry/app.js">${extra}</head>`;
const body = (sections: string) => `<body style="margin:0"><main id="main">${sections}</main><script>{ __sveltekit_1x = { base: '/client' }; import('/client/_app/immutable/entry/start.js'); }</script></body></html>`;
const hero = (sizes = '100vw') => `<img src="/client/assets/hero-1280.png" srcset="/client/assets/hero-640.png 640w, /client/assets/hero-1280.png 1280w" sizes="${sizes}" alt="" style="display:block;width:100%;height:600px;object-fit:cover">`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'so-page-performance-'));
  const put = (rel: string, bytes: string | Buffer) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), bytes);
    sizes[rel] = Buffer.byteLength(bytes);
  };
  const png = async (rel: string, width: number, height: number) => put(rel, await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer());
  await png('assets/hero-640.png', 640, 300);
  await png('assets/hero-1280.png', 1280, 600);
  await png('assets/side-640.png', 640, 400);
  await png('assets/side-1280.png', 1280, 800);
  await png('assets/photo.png', 2400, 1600);
  put('fonts/body.woff2', Buffer.alloc(3000, 1));
  put('_app/immutable/assets/app.css', `@font-face { font-family: Body; src: url('../../../fonts/body.woff2') format('woff2'); } @font-face { font-family: Unused; src: url('../../../fonts/unused.woff2') format('woff2'); } body { font-family: Body, sans-serif; }`);
  put('_app/immutable/entry/app.js', `export const app = true;\n`);
  put('_app/immutable/chunks/nested.js', `export const nested = true;\n`);
  put('_app/immutable/entry/start.js', `await import('./app.js'); await import('../chunks/nested.js'); ${STARTED}\n`);
  // The hero, preloaded as the generator preloads it (the same set and sizes the body asks for), and a picture in a
  // 400px column whose sizes says the whole window.
  put('preloaded/index.html', head(`<link rel="preload" as="image" fetchpriority="high" imagesrcset="/client/assets/hero-640.png 640w, /client/assets/hero-1280.png 1280w" imagesizes="100vw">`) + body(`<section>${hero()}<p>Welcome</p></section><section style="width:400px"><img src="/client/assets/side-1280.png" srcset="/client/assets/side-640.png 640w, /client/assets/side-1280.png 1280w" sizes="100vw" alt="" style="display:block;width:400px"></section>`));
  // The hero with no preload, and a plain file far wider than its space.
  put('unpreloaded/index.html', head('') + body(`<section>${hero()}<p>Welcome</p></section><section><img src="/client/assets/photo.png" alt="" style="display:block;width:300px"></section>`));
  // A preload for a copy the page never shows: the body's sizes picks the other.
  put('wasted/index.html', head(`<link rel="preload" as="image" imagesrcset="/client/assets/hero-640.png 640w, /client/assets/hero-1280.png 1280w" imagesizes="400px">`) + body(`<section>${hero()}</section>`));
  // A page built without SvelteKit's script: it works at once, and is measured all the same.
  put('static/index.html', `<!doctype html><html><head><link rel="stylesheet" href="/client/_app/immutable/assets/app.css"></head><body><main id="main"><section><h1>Plain</h1></section></main></body></html>`);
  server = await previews.serve(root, '/client');
  if (browserInstalled) browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  previews.stopAll();
  rmSync(root, { recursive: true, force: true });
});

/** A fresh page and a DevTools session on it, every event of the page passed on as the app's window passes them. */
async function session(): Promise<{ cdp: CdpPage; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: null });
  const p = await context.newPage();
  const s: CDPSession = await context.newCDPSession(p);
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  const events = ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.dataReceived', 'Network.loadingFinished', 'Network.loadingFailed', 'Page.loadEventFired', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown'] as const;
  for (const name of events) s.on(name, (params: unknown) => listeners.forEach((l) => l(name, params as Record<string, unknown>)));
  return {
    cdp: { send: (method, params) => s.send(method as never, params as never) as Promise<unknown>, listen: (l) => (listeners.add(l), () => void listeners.delete(l)) },
    close: () => context.close()
  };
}

async function measure(route: string, opts: { measureUntil?: number } = { measureUntil: Date.now() + 10_000 }, wrap: (cdp: CdpPage) => CdpPage = (c) => c): Promise<PageCheck> {
  const { cdp, close } = await session();
  try {
    return await checkBuiltPage(wrap(cdp), new URL(`${route}/`, server).href, opts);
  } finally {
    await close();
  }
}

const sampleOf = (check: PageCheck): PageSample => {
  expect(check.status).toBe('working');
  return (check as { sample: PageSample }).sample;
};
const bytesOf = (s: PageSample, url: string) => s.resources.find((r) => r.url === url)?.bytes;

describe.skipIf(!browserInstalled)('measuring a built page’s first visit in a browser', () => {
  it('counts every file the visit downloaded by kind and size, scripts only another imports and only the font its styles use included', async () => {
    const s = sampleOf(await measure('preloaded'));
    expect(s.complete).toBe(true);
    const kinds = Object.fromEntries(s.resources.map((r) => [r.url, r.kind]));
    expect(kinds).toMatchObject({
      '/client/preloaded/': 'html',
      '/client/_app/immutable/assets/app.css': 'css',
      '/client/_app/immutable/entry/start.js': 'js',
      '/client/_app/immutable/entry/app.js': 'js',
      '/client/_app/immutable/chunks/nested.js': 'js',
      '/client/fonts/body.woff2': 'fonts',
      '/client/assets/hero-1280.png': 'images'
    });
    // The font nothing uses is never downloaded, and a picture's other copies neither.
    expect(kinds['/client/fonts/unused.woff2']).toBeUndefined();
    expect(kinds['/client/assets/hero-640.png']).toBeUndefined();
    // Each file once, at the size it was served.
    expect(s.resources.filter((r) => r.url === '/client/_app/immutable/entry/app.js')).toHaveLength(1);
    expect(bytesOf(s, '/client/fonts/body.woff2')).toBe(sizes['fonts/body.woff2']);
    expect(bytesOf(s, '/client/assets/hero-1280.png')).toBe(sizes['assets/hero-1280.png']);
    expect(bytesOf(s, '/client/_app/immutable/entry/start.js')).toBe(sizes['_app/immutable/entry/start.js']);
    // What the head preloads says so: the hero and the app's module.
    expect(s.resources.filter((r) => r.preloaded).map((r) => r.url).sort()).toEqual(['/client/_app/immutable/entry/app.js', '/client/assets/hero-1280.png']);
    expect(s.resources.every((r) => r.own)).toBe(true);
  });

  it('finds the hero painted largest and preloaded, and a picture whose sizes asks for the whole window in a 400px column', async () => {
    const s = sampleOf(await measure('preloaded'));
    expect(s.lcp).toEqual({ kind: 'image', url: '/client/assets/hero-1280.png', from: 'browser' });
    const heroImage = s.images.find((i) => i.url === '/client/assets/hero-1280.png');
    expect(heroImage).toMatchObject({ renderedWidth: 1280, renderedHeight: 600, neededWidth: 1280, fileWidth: 1280, slotWidth: 1280, sizes: '100vw', inView: true });
    const side = s.images.find((i) => i.url.includes('/side-'));
    expect(side).toMatchObject({ url: '/client/assets/side-1280.png', renderedWidth: 400, neededWidth: 400, fileWidth: 1280, slotWidth: 1280, sizes: '100vw' });
  });

  it('measures a picture that covers its space as needing the width the cover crops it from', async () => {
    const s = sampleOf(await measure('preloaded'));
    // 1280×600 box; a 1280×600 file covers it exactly. Narrower boxes would need it wider than they are.
    expect(s.images.find((i) => i.url.endsWith('hero-1280.png'))!.neededWidth).toBeCloseTo(1280, 0);
  });

  it('finds a hero the head does not preload, and a plain file far wider than its space', async () => {
    const s = sampleOf(await measure('unpreloaded'));
    expect(s.lcp).toMatchObject({ kind: 'image', url: '/client/assets/hero-1280.png' });
    expect(s.resources.filter((r) => r.preloaded && r.kind === 'images')).toEqual([]);
    expect(s.images.find((i) => i.url === '/client/assets/photo.png')).toMatchObject({ renderedWidth: 300, fileWidth: 2400, slotWidth: null, sizes: null });
  });

  it('finds a preloaded copy the page never shows', async () => {
    const s = sampleOf(await measure('wasted'));
    const preload = s.resources.find((r) => r.preloaded && r.kind === 'images');
    expect(preload).toMatchObject({ url: '/client/assets/hero-640.png', bytes: sizes['assets/hero-640.png'] });
    expect(s.images.map((i) => i.url)).toEqual(['/client/assets/hero-1280.png']);
    expect(s.used).toEqual(['/client/assets/hero-1280.png', '/client/assets/hero-1280.png']);
  });

  it('measures a page built without SvelteKit’s script, which works at once', async () => {
    const s = sampleOf(await measure('static'));
    // Its styles' font, as the page's text uses it.
    expect(s.resources.map((r) => r.kind).sort()).toEqual(['css', 'fonts', 'html']);
    expect(s.lcp).toEqual({ kind: 'text' });
  });

  it('measures nothing unless asked, or once the time for measuring is over, and the verdict is the same either way', async () => {
    expect(await measure('preloaded', {})).toEqual({ status: 'working' });
    expect(await measure('preloaded', { measureUntil: Date.now() - 1 })).toEqual({ status: 'working' });
  });

  it('checks a page it cannot set up to measure all the same, unmeasured', async () => {
    const refusing = (cdp: CdpPage): CdpPage => ({ ...cdp, send: (method, params) => (method === 'Emulation.setDeviceMetricsOverride' ? Promise.reject(new Error('Not allowed')) : cdp.send(method, params)) });
    expect(await measure('preloaded', undefined, refusing)).toEqual({ status: 'working' });
  });

  it('keeps what the files said of a page whose pictures cannot be read in time, without waiting past it', async () => {
    // The page never answers the read of its pictures.
    const stalled = (cdp: CdpPage): CdpPage => ({ ...cdp, send: (method, params) => (method === 'Runtime.evaluate' && String((params as { expression?: string })?.expression).includes('probe') ? new Promise(() => undefined) : cdp.send(method, params)) });
    const started = Date.now();
    const s = sampleOf(await measure('preloaded', undefined, stalled));
    expect(Date.now() - started).toBeLessThan(6000);
    expect(s.images).toEqual([]);
    expect(s.used).toBeUndefined();
    // Its pictures unread, it was measured only in part.
    expect(s.complete).toBe(false);
    expect(s.resources.some((r) => r.url === '/client/assets/hero-1280.png')).toBe(true);
  });
});
