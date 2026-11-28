/**
 * The links in every page's head (the favicon, the home-screen icon and the web manifest) after the visitor moves to
 * another page, in a real headless browser. The site is published under a sub-path. SvelteKit writes the addresses
 * of the page opened first relative to it ("../manifest.webmanifest" on About), and in the browser the same
 * addresses come from the site's root. The root layout's head is never drawn again as the visitor moves on,
 * so each link must lead to the site's own file from every page, however the visitor arrived.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { generateProject } from '@generator/index';

const ORIGIN = 'https://quay.test';
const ROOT = '/archive/paper.edition_1';
const HOME = `${ROOT}/`;
const ABOUT = `${ROOT}/about/`;

/** `$app/paths` as SvelteKit gives it on the server, relative to the page rendered (`base` ".." on About), and in the browser. */
const paths = (base: string) => `export const base = ${JSON.stringify(base)}; export const resolve = (p) => base + p; export const asset = (p) => base + "/" + p;`;
const STUBS: Record<string, string> = {
  '\0$app/state': 'export const page = { route: { id: "/" }, url: new URL("https://quay.test/archive/paper.edition_1/") };',
  '\0$app/navigation': 'export function afterNavigate() {} export function onNavigate() {} export function beforeNavigate() {} export function snapshot() {}'
};

/**
 * The site's root layout around a stand-in page, bundled for the server (`render`), with SvelteKit's base for the page
 * rendered, or for the browser (`window.startSite`).
 */
async function bundleLayout(files: Map<string, string>, generate: 'server' | 'client', base = ROOT): Promise<string> {
  const src = new Map<string, string>([...files].map(([p, text]) => [`\0site/${p}`, text]));
  src.set('\0site/Entry.svelte', `<script>import Layout from './src/routes/+layout.svelte';</script><Layout><p>About</p></Layout>`);
  const entry =
    generate === 'server'
      ? "import { render } from 'svelte/server'; import Entry from '\0site/Entry.svelte'; export const renderSite = () => render(Entry);"
      : "import { flushSync, hydrate } from 'svelte'; import Entry from '\0site/Entry.svelte'; window.startSite = () => { hydrate(Entry, { target: document.getElementById('app'), recover: false }); flushSync(); window.started = true; };";
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    ...(generate === 'server' ? { ssr: { noExternal: true } } : {}),
    plugins: [
      {
        name: 'exported-site',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry') return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          if (id.startsWith('@fontsource') || id.endsWith('.css')) return '\0empty';
          if (importer?.startsWith('\0site/') && id.startsWith('.')) {
            const path = `\0${posix.join(posix.dirname(importer.slice(1)), id)}`;
            if (src.has(path)) return path;
          }
          return src.has(id) ? id : null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0empty') return '';
          if (id === '\0$app/paths') return paths(base);
          if (STUBS[id]) return STUBS[id];
          const text = src.get(id);
          if (text === undefined) return null;
          const code = id.endsWith('.svelte') ? compile(text, { filename: id.slice(1), generate, css: 'injected' }).js.code : text;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: {
      write: false,
      ...(generate === 'server' ? { ssr: true } : {}),
      minify: false,
      rolldownOptions: { input: '\0entry', output: { format: generate === 'server' ? 'esm' : 'iife', codeSplitting: false } }
    }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The exported site did not bundle');
  return chunk.code;
}

describe.skipIf(!existsSync(chromium.executablePath()))('the head links after moving to another page', () => {
  let browser: Browser;
  let script = '';
  /** Each page's head and body as the server rendered it. */
  const markup: Record<string, { head: string; body: string }> = {};
  let dir = '';

  beforeAll(async () => {
    const files = generateProject(createStarterState('business', 'Quay Paper', false));
    const [home, about, client] = await Promise.all([bundleLayout(files, 'server', '.'), bundleLayout(files, 'server', '..'), bundleLayout(files, 'client')]);
    script = client;
    dir = mkdtempSync(join(tmpdir(), 'so-head-links-'));
    for (const [path, server] of [[HOME, home], [ABOUT, about]]) {
      const file = join(dir, `server-${Object.keys(markup).length}.mjs`);
      writeFileSync(file, server);
      markup[path] = ((await import(pathToFileURL(file).href)) as { renderSite: () => { head: string; body: string } }).renderSite();
    }
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['About', ABOUT, HOME, '../manifest.webmanifest'],
    ['Home', HOME, ABOUT, './manifest.webmanifest']
  ])('lead to the site’s own files from the next page after %s was opened first', async (_, first, next, served) => {
    // As served: the head has the addresses relative to the page.
    expect(markup[first].head).toContain(`<link rel="manifest" href="${served}"/>`);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.route(`${ORIGIN}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/site.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
        if (path !== first) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html lang="en"><head><meta charset="utf-8">${markup[first].head}</head><body><div id="app" style="display: contents">${markup[first].body}</div><script src="/site.js"></script><script>startSite()</script></body></html>`
        });
      });
      await page.goto(`${ORIGIN}${first}`);
      await page.waitForFunction('window.started === true');
      const links = () =>
        page.evaluate<Record<string, string>>(
          `Object.fromEntries(['icon', 'apple-touch-icon', 'manifest'].map((rel) => [rel, document.querySelector('link[rel="' + rel + '"]').href]))`
        );
      const expected = {
        icon: `${ORIGIN}${ROOT}/favicon.svg`,
        'apple-touch-icon': `${ORIGIN}${ROOT}/apple-touch-icon.png`,
        manifest: `${ORIGIN}${ROOT}/manifest.webmanifest`
      };
      expect(await links()).toEqual(expected);
      // The site's link to the next page, as SvelteKit's router follows it: the same document at another address.
      await page.evaluate(`history.pushState({}, '', ${JSON.stringify(next)})`);
      expect(await links()).toEqual(expected);
    } finally {
      await context.close();
    }
  });
});
