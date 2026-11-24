/**
 * Tabs and disclosures generated from a design's UI state, in a real browser (#376). The exported page, rendered on the
 * server, hydrates without a mismatch; its tabs switch by pointer and by Left, Right, Home and End (the other way
 * round in right-to-left text), each placement on its own; a disclosure opens and closes its content; printing shows
 * every panel with its own layout, under its tab's label. In the editor, with the real preview bridge, a click on a
 * tab in Edit selects it and changes nothing, nor do the arrow keys, while Preview runs the tabs as visitors do.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectState, UiStateSchema } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { makeInstance } from '@engine/install';
import { generateProject } from '@generator/index';
import { eq, uiState } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://tabs.test';
const SESSION = 'so-test';
const GEN = '\0gen:';
const NONE = { type: 'none' as const, target: '' };
const PLAN: UiStateSchema = { type: 'enum', label: 'Plan', options: [{ value: 'a', label: 'Starter' }, { value: 'b', label: 'Team' }, { value: 'c', label: 'Studio' }], initial: 'b' };

/**
 * A project whose Home places, twice, a design with a tab list over a three-option choice that starts on its middle
 * option (tabs in the page's order Starter, Studio, Team), grid panels, a Next button and a disclosure.
 */
function project(): ProjectState {
  const s = createStarterState('business', 'Test Studio', false);
  const label = { a: 'Starter', b: 'Team', c: 'Studio' } as const;
  const def = {
    ...FOUNDATION.managed({
      componentId: 'test.tabs',
      name: 'Plan tabs',
      category: 'content',
      tags: [],
      icon: 'sparkles',
      description: '',
      properties: {},
      parts: {},
      state: { plan: PLAN, open: { type: 'boolean', label: 'Open', initial: false } },
      build: (b) =>
        b.el('root', 'section', {}, [
          b.el('list', 'div', {}, (['a', 'c', 'b'] as const).map((v) => b.link(`tab-${v}`, NONE, label[v], 'secondary', { stateAction: { state: 'plan', op: 'set', value: v } }))),
          ...(['a', 'b', 'c'] as const).map((v) => b.el(`panel-${v}`, 'div', { when: eq(uiState('plan'), v), styles: { layout: 'grid' } }, [b.text(`text-${v}`, 'p', `${label[v]} plan details`)])),
          b.link('next', NONE, 'Next plan', 'text', { stateAction: { state: 'plan', op: 'next', wrap: true } }),
          b.link('more', NONE, 'More', 'secondary', { stateAction: { state: 'open', op: 'toggle' } }),
          b.el('wrap', 'div', { collapseEmpty: true }, [b.el('details', 'div', { when: uiState('open') }, [b.text('details-text', 'p', 'Cancel any time')])])
        ])
    }),
    owner: 'project' as const
  };
  s.components[def.id] = def;
  const home = s.pages[s.site.homePageId];
  for (let i = 0; i < 2; i++) {
    const node = makeInstance(def, {});
    home.nodes[node.id] = node;
    home.rootIds.push(node.id);
  }
  return s;
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The exported Home page rendered on the server, hydration markers and all, as the static site ships it. */
async function serverHtml(files: Map<string, string>): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'ui-state-browser-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of files) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, 'src/routes/+page.svelte.js'))).default as Component<Record<string, unknown>>;
  return render(Page, { props: {} }).body;
}

/** The site's page and the editor's variant of it, compiled for the browser into one script. */
async function bundle(clean: Map<string, string>, dev: Map<string, string>): Promise<string> {
  const files = new Map<string, string>([
    ...[...clean].map(([p, src]) => [`clean/${p}`, src] as [string, string]),
    ...[...dev].map(([p, src]) => [`dev/${p}`, src] as [string, string]),
    ['app/paths.js', 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";'],
    ['app/navigation.js', 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};']
  ]);
  const entry = [
    "import { hydrate, mount } from 'svelte';",
    `import Clean from ${JSON.stringify(GEN + 'clean/src/routes/+page.svelte')};`,
    `import Dev from ${JSON.stringify(GEN + 'dev/src/routes/+page.svelte')};`,
    "window.startSite = (variant) => (variant === 'dev' ? mount(Dev, { target: document.getElementById('app'), props: {} }) : hydrate(Clean, { target: document.getElementById('app'), props: {} }));"
  ].join('\n');
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'generated-site',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths' || id === '$app/navigation') return GEN + id.slice(1) + '.js';
          if (importer?.startsWith(GEN) && id.startsWith('.')) {
            const path = posix.join(posix.dirname(importer.slice(GEN.length)), id);
            if (files.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          const source = files.get(path);
          if (source === undefined) throw new Error(`Not generated: ${path}`);
          const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'client', runes: true }).js.code : source;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The site did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('generated tabs and disclosures in a browser', () => {
  let browser: Browser;
  let script: string;
  let ssr: string;
  let css: string;
  beforeAll(async () => {
    const s = project();
    const clean = generateProject(s);
    const dev = generateProject(s, { instrument: true });
    ssr = await serverHtml(clean);
    css = ['tokens', 'theme', 'components', 'site'].map((f) => clean.get(`src/lib/siteorigin/styles/${f}.css`) ?? '').join('\n');
    script = await bundle(clean, dev);
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  interface Opened {
    page: Page;
    /** The document the site is in: the page itself, or the preview frame inside the stand-in editor. */
    site: Frame;
    /** Console warnings and errors, and uncaught errors. */
    problems: string[];
  }

  /**
   * The site: the server-rendered page hydrated (`clean`), or the editor's variant mounted in a frame of a stand-in
   * editor with the real preview bridge (`dev`), which starts it in Edit.
   */
  async function open(variant: 'clean' | 'dev'): Promise<Opened> {
    const page = await browser.newPage();
    const problems: string[] = [];
    // A hydration mismatch or a script error shows here. The theme's font files are not served here: those misses are not.
    page.on('console', (m) => {
      if ((m.type() === 'warning' || m.type() === 'error') && !m.text().startsWith('Failed to load resource')) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    const site = `<!doctype html><html lang="en"><head><style>${css}</style></head><body><div id="app">${variant === 'clean' ? ssr : ''}</div></body></html>`;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.pathname === '/site') return route.fulfill({ contentType: 'text/html', body: site });
      if (url.pathname === '/') {
        const editor = `<!doctype html><title>Editor</title><script>window.sent = []; addEventListener('message', (e) => window.sent.push(e.data));</script><iframe name="${SESSION}" src="/site" style="width:1000px;height:700px;border:0"></iframe>`;
        return route.fulfill({ contentType: 'text/html', body: variant === 'dev' ? editor : site });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`${ORIGIN}/`);
    let frame = page.mainFrame();
    if (variant === 'dev') {
      await expect.poll(() => page.frame({ name: SESSION })?.url()).toBe(`${ORIGIN}/site`);
      frame = page.frame({ name: SESSION })!;
      await frame.waitForLoadState();
    }
    await frame.addScriptTag({ url: '/app.js', type: 'module' });
    await frame.waitForFunction('typeof window.startSite === "function"');
    // Marks the server's first tab list, so a test can tell hydration kept the server's elements.
    if (variant === 'clean') await frame.evaluate(`document.querySelector('[role="tablist"]').fromServer = true`);
    await frame.evaluate(`window.startSite(${JSON.stringify(variant)})`);
    if (variant === 'dev') {
      await frame.addScriptTag({ url: '/bridge.js', type: 'module' });
      await frame.waitForFunction('window.__siteoriginBridge === true && document.documentElement.hasAttribute("data-so-editing")');
    }
    return { page, site: frame, problems };
  }

  /** Switches the preview between Edit and Preview, as the editor does. */
  async function mode({ page, site }: Opened, to: 'edit' | 'preview') {
    await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ protocolVersion: 1, sessionId: SESSION, type: 'mode', payload: { mode: to } })}, '*')`);
    await site.waitForFunction(`document.documentElement.hasAttribute('data-so-editing') === ${to === 'edit'}`);
  }

  /**
   * Each placement's tabs as [label, selected, tab order] and the words of the panels showing on screen. (Scripts run
   * in the page are written as strings: this file is type-checked without the DOM's types.)
   */
  const state = (site: Frame) =>
    site.evaluate(`[...document.querySelectorAll('[role="tablist"]')].map((list) => ({
      tabs: [...list.querySelectorAll('[role="tab"]')].map((t) => [t.textContent.trim(), t.getAttribute('aria-selected'), t.getAttribute('tabindex')]),
      shown: [...list.parentElement.querySelectorAll('[role="tabpanel"]')].filter((p) => getComputedStyle(p).display !== 'none').map((p) => p.textContent.trim())
    }))`) as Promise<Array<{ tabs: string[][]; shown: string[] }>>;
  const selected = (tabs: string[][]) => tabs.filter((t) => t[1] === 'true').map((t) => t[0]);
  const focused = (site: Frame) => site.evaluate(`document.activeElement?.textContent?.trim() ?? ''`) as Promise<string>;

  it('hydrates the exported page and switches each placement’s tabs by pointer and keyboard', async () => {
    const opened = await open('clean');
    const { page, site, problems } = opened;
    try {
      // The server's markup, hydrated in place: Team chosen in both placements, its panel the only one on screen.
      await site.waitForFunction('document.querySelectorAll("[role=tab]").length === 6');
      expect(await site.evaluate(`document.querySelector('[role="tablist"]').fromServer === true`)).toBe(true);
      expect(await state(site)).toEqual([...Array(2)].map(() => ({ tabs: [['Starter', 'false', '-1'], ['Studio', 'false', '-1'], ['Team', 'true', '0']], shown: ['Team plan details'] })));
      const [first, second] = [0, 1].map((i) => site.locator('[role="tablist"]').nth(i));
      await first.getByRole('tab', { name: 'Starter' }).click();
      await expect.poll(async () => (await state(site))[0]).toEqual({ tabs: [['Starter', 'true', '0'], ['Studio', 'false', '-1'], ['Team', 'false', '-1']], shown: ['Starter plan details'] });
      // The other placement keeps its own choice.
      expect((await state(site))[1].shown).toEqual(['Team plan details']);
      // Right and Left follow the tabs on the page, round the ends; Home and End go to the first and last.
      const steps: Array<[string, string]> = [['ArrowRight', 'Studio'], ['ArrowRight', 'Team'], ['ArrowRight', 'Starter'], ['ArrowLeft', 'Team'], ['Home', 'Starter'], ['End', 'Team']];
      for (const [key, to] of steps) {
        await page.keyboard.press(key);
        await expect.poll(async () => selected((await state(site))[0].tabs)).toEqual([to]);
        expect(await focused(site)).toBe(to);
        expect((await state(site))[0].shown).toEqual([`${to} plan details`]);
      }
      // Tab leaves the list for the chosen panel; the second placement never moved.
      await page.keyboard.press('Tab');
      expect(await site.evaluate(`document.activeElement?.getAttribute('role')`)).toBe('tabpanel');
      expect((await state(site))[1].tabs.map((t) => t[1])).toEqual(['false', 'false', 'true']);
      // Right to left, Right goes back.
      await site.evaluate(`document.documentElement.setAttribute('dir', 'rtl')`);
      await second.getByRole('tab', { name: 'Team' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () => selected((await state(site))[1].tabs)).toEqual(['Studio']);
      // Next steps through the options in their own order, round to the first.
      const next = site.getByRole('button', { name: 'Next plan' }).nth(1);
      await next.click();
      await expect.poll(async () => selected((await state(site))[1].tabs)).toEqual(['Starter']);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('opens and closes a disclosure, and prints every panel with its layout and closed content too', async () => {
    const { page, site, problems } = await open('clean');
    try {
      await site.waitForFunction('document.querySelectorAll("[role=tab]").length === 6');
      const more = site.getByRole('button', { name: 'More' }).first();
      const details = site.getByText('Cancel any time').first();
      expect(await more.getAttribute('aria-expanded')).toBe('false');
      expect(await details.isVisible()).toBe(false);
      await more.click();
      await expect.poll(() => more.getAttribute('aria-expanded')).toBe('true');
      expect(await details.isVisible()).toBe(true);
      await more.press('Enter');
      await expect.poll(() => more.getAttribute('aria-expanded')).toBe('false');
      expect(await details.isVisible()).toBe(false);
      // Printed: every panel in its own grid, under its tab's label, the row of tabs left out, the closed content shown.
      await page.emulateMedia({ media: 'print' });
      const printed = (await site.evaluate(`({
        panels: [...document.querySelectorAll('[role="tabpanel"]')].map((p) => [getComputedStyle(p).display, getComputedStyle(p, '::before').content, getComputedStyle(p, '::before').gridColumn]),
        lists: [...document.querySelectorAll('[role="tablist"]')].map((l) => getComputedStyle(l).display),
        details: [...document.querySelectorAll('p')].filter((p) => p.textContent === 'Cancel any time').map((p) => p.checkVisibility())
      })`)) as { panels: string[][]; lists: string[]; details: boolean[] };
      // The label spans the panel's whole grid, above its content.
      expect(printed.panels).toEqual([...Array(2)].flatMap(() => [['grid', '"Starter"', '1 / -1'], ['grid', '"Team"', '1 / -1'], ['grid', '"Studio"', '1 / -1']]));
      expect(printed.lists).toEqual(['none', 'none']);
      expect(printed.details).toEqual([true, true]);
      // Back on screen, nothing has changed.
      await page.emulateMedia({ media: 'screen' });
      expect((await state(site)).map((p) => p.shown)).toEqual([['Team plan details'], ['Team plan details']]);
      expect(await details.isVisible()).toBe(false);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('in Edit selects a tab that is clicked and changes nothing, keys included; Preview runs the tabs', async () => {
    const opened = await open('dev');
    const { page, site } = opened;
    try {
      const starter = site.locator('[role="tablist"]').first().getByRole('tab', { name: 'Starter' });
      const selects = () => page.evaluate(`window.sent.filter((m) => m.type === 'select').map((m) => m.payload.chain?.[0]?.node)`) as Promise<string[]>;
      await starter.click();
      // The editor is told to select the tab, and the canvas still shows Team.
      await expect.poll(selects).toEqual(['tab-a']);
      expect(selected((await state(site))[0].tabs)).toEqual(['Team']);
      // A tab focused from the keyboard stays where it is with the arrows, Home and End: nothing switches, the focus
      // does not move to another tab, and nothing else is selected.
      await starter.focus();
      for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) await page.keyboard.press(key);
      expect(await focused(site)).toBe('Starter');
      expect(await selects()).toEqual(['tab-a']);
      expect((await state(site)).map((p) => p.shown)).toEqual([['Team plan details'], ['Team plan details']]);
      // The disclosure stays closed in Edit too, also while its label is being edited, where a click places the caret.
      const more = site.locator('[data-so-node="more"]').first();
      await more.click();
      expect(await more.getAttribute('aria-expanded')).toBe('false');
      const ctx = await more.getAttribute('data-so-ctx');
      const begin = { protocolVersion: 1, sessionId: SESSION, type: 'beginTextEdit', payload: { desc: { ctx, node: 'more', items: '' }, editId: 'edit-1' } };
      await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify(begin)}, '*')`);
      await site.waitForFunction(`document.querySelector('[data-so-node="more"][contenteditable]') !== null`);
      await more.click();
      expect(await more.getAttribute('aria-expanded')).toBe('false');
      await page.keyboard.press('Escape');
      await site.waitForFunction(`document.querySelector('[contenteditable]') === null`);
      await mode(opened, 'preview');
      await starter.click();
      await expect.poll(async () => (await state(site))[0].shown).toEqual(['Starter plan details']);
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () => selected((await state(site))[0].tabs)).toEqual(['Studio']);
      await site.getByRole('button', { name: 'More' }).first().click();
      await expect.poll(() => site.getByRole('button', { name: 'More' }).first().getAttribute('aria-expanded')).toBe('true');
    } finally {
      await page.close();
    }
  });
});
