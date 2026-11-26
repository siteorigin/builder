/**
 * Foundation's Tabbed showcase and Pricing with billing switch (#380) in a real browser, as the exported site runs
 * them: the server-rendered page hydrates without a mismatch; the showcase switches by pointer and by Left, Right, Home
 * and End, its tab row scrolling sideways on a phone without widening the page; the billing switch changes every
 * plan's price and note by pointer, Enter and Space; printing shows every tab's panel under its label and the plans
 * without the controls. A showcase whose chosen tab is taken away by a change to its properties (as in the editor)
 * falls back to its first tab.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { defFile, generateProject } from '@generator/index';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://showcase.test';
const GEN = '\0gen:';

/** Home with only a showcase of four tabs and a billing-switch pricing section. */
function project(): { state: ProjectState; showcase: string } {
  let s = createStarterState('business', 'Test Studio', false);
  const owner = { kind: 'page' as const, id: s.site.homePageId };
  s = applyOperations(s, s.pages[s.site.homePageId].rootIds.map((nodeId): EditOperation => ({ type: 'node.remove', owner, nodeId }))).state;
  const r = applyOperations(s, [
    { type: 'node.insert', owner, componentId: 'tabs.showcase', index: 0, props: { tab4: { label: 'Support', heading: 'Help when you need it', copy: 'Call us any weekday.' } } },
    { type: 'node.insert', owner, componentId: 'pricing.toggle', index: 1 }
  ] as EditOperation[]);
  const node = r.state.pages[r.state.site.homePageId].nodes[r.results[0].nodeId as string] as InstanceNode;
  return { state: r.state, showcase: defFile(r.state.components[node.definitionId]) };
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The exported Home page rendered on the server, hydration markers and all, as the static site ships it. */
async function serverHtml(files: Map<string, string>): Promise<string> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'foundation-interactive-browser-'));
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

/**
 * The site's page, and a stand-in for the editor's live properties: the showcase placed with a fourth tab that
 * `window.dropFourth()` takes away, as clearing its label in the Inspector does.
 */
async function bundle(files: Map<string, string>, showcase: string): Promise<string> {
  const harness = [
    '<script>',
    `\timport Showcase from ${JSON.stringify(posix.relative('src/routes', showcase))};`,
    "\tlet tab4 = $state({ label: 'Fourth', heading: 'Fourth heading', copy: [], icon: '', actionLabel: '', actionLink: { type: 'none', target: '' }, image: { assetId: null, alt: '' } });",
    "\twindow.dropFourth = () => (tab4 = { ...tab4, label: '' });",
    '</script>',
    '',
    '<Showcase {tab4} />',
    ''
  ].join('\n');
  const all = new Map<string, string>([
    ...files,
    ['src/routes/harness.svelte', harness],
    ['app/paths.js', 'export const resolve = (p) => p; export const asset = (p) => "/" + p; export const base = "";'],
    ['app/navigation.js', 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};']
  ]);
  const entry = [
    "import { hydrate, mount } from 'svelte';",
    `import Page from ${JSON.stringify(GEN + 'src/routes/+page.svelte')};`,
    `import Harness from ${JSON.stringify(GEN + 'src/routes/harness.svelte')};`,
    "window.startSite = () => hydrate(Page, { target: document.getElementById('app'), props: {} });",
    "window.startHarness = () => mount(Harness, { target: document.getElementById('harness'), props: {} });"
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
            if (all.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          const source = all.get(path);
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

describe.skipIf(!browserInstalled)('Foundation’s tabbed showcase and billing switch in a browser', () => {
  let browser: Browser;
  let script: string;
  let ssr: string;
  let css: string;
  let appHtml: string;
  beforeAll(async () => {
    const { state, showcase } = project();
    const files = generateProject(state);
    appHtml = files.get('src/app.html')!;
    ssr = await serverHtml(files);
    css = ['tokens', 'theme', 'components', 'site'].map((f) => files.get(`src/lib/siteorigin/styles/${f}.css`) ?? '').join('\n');
    script = await bundle(files, showcase);
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  /** The hydrated site at a width, with console warnings and errors, and uncaught errors, collected. */
  async function open(width = 1280): Promise<{ page: Page; problems: string[] }> {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (m) => {
      if ((m.type() === 'warning' || m.type() === 'error') && !m.text().startsWith('Failed to load resource')) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    const html = `<!doctype html><html lang="en" class="so-js"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="app">${ssr}</div><div id="harness"></div></body></html>`;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ url: '/app.js', type: 'module' });
    await page.waitForFunction('typeof window.startSite === "function"');
    await page.evaluate(`document.querySelector('[role="tablist"]').fromServer = true`);
    await page.evaluate('window.startSite()');
    return { page, problems };
  }

  /** The showcase's tabs as [label, selected, tab order], and the words of the panels showing on screen. */
  const tabsOf = (page: Page, root = '#app') =>
    page.evaluate(`(() => {
      const list = document.querySelector(${JSON.stringify(root)} + ' [role="tablist"]');
      return {
        tabs: [...list.querySelectorAll('[role="tab"]')].map((t) => [t.textContent.trim(), t.getAttribute('aria-selected'), t.getAttribute('tabindex')]),
        shown: [...document.querySelectorAll(${JSON.stringify(root)} + ' [role="tabpanel"]')].filter((p) => p.checkVisibility()).map((p) => p.querySelector('h3')?.textContent.trim())
      };
    })()`) as Promise<{ tabs: string[][]; shown: string[] }>;
  const selected = (tabs: string[][]) => tabs.filter((t) => t[1] === 'true').map((t) => t[0]);
  const focused = (page: Page) => page.evaluate(`document.activeElement?.textContent?.trim() ?? ''`) as Promise<string>;
  /** The billing buttons as [label, pressed], and the prices and notes showing. */
  const billingOf = (page: Page) =>
    page.evaluate(`({
      buttons: [...document.querySelectorAll('#app [role="group"] button')].map((b) => [b.textContent.trim(), b.getAttribute('aria-pressed')]),
      prices: [...document.querySelectorAll('#app li p')].filter((p) => p.checkVisibility()).map((p) => p.textContent.replace(/\\s+/g, ' ').trim())
    })`) as Promise<{ buttons: string[][]; prices: string[] }>;

  it('hydrates the exported page and switches the showcase by pointer and keyboard', async () => {
    const { page, problems } = await open();
    try {
      await page.waitForFunction('document.querySelectorAll("#app [role=tab]").length === 4');
      expect(await page.evaluate(`document.querySelector('[role="tablist"]').fromServer === true`)).toBe(true);
      expect(await tabsOf(page)).toEqual({
        tabs: [['Design', 'true', '0'], ['Build', 'false', '-1'], ['Care', 'false', '-1'], ['Support', 'false', '-1']],
        shown: ['Plans drawn around how you live']
      });
      await page.locator('#app').getByRole('tab', { name: 'Care' }).click();
      await expect.poll(async () => (await tabsOf(page)).shown).toEqual(['Looked after long after we leave']);
      const steps: Array<[string, string, string]> = [
        ['ArrowRight', 'Support', 'Help when you need it'],
        ['ArrowRight', 'Design', 'Plans drawn around how you live'],
        ['ArrowLeft', 'Support', 'Help when you need it'],
        ['Home', 'Design', 'Plans drawn around how you live'],
        ['End', 'Support', 'Help when you need it']
      ];
      for (const [key, to, heading] of steps) {
        await page.keyboard.press(key);
        await expect.poll(async () => selected((await tabsOf(page)).tabs)).toEqual([to]);
        expect(await focused(page)).toBe(to);
        const now = await tabsOf(page);
        expect(now.shown).toEqual([heading]);
        // Only the chosen tab is in the tab order.
        expect(now.tabs.filter((t) => t[2] === '0').map((t) => t[0])).toEqual([to]);
      }
      // Tab leaves the row for the panel showing.
      await page.keyboard.press('Tab');
      expect(await page.evaluate(`document.activeElement?.getAttribute('role')`)).toBe('tabpanel');
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('switches every plan’s price and billing note by pointer, Enter and Space', async () => {
    const { page, problems } = await open();
    try {
      const monthly = ['$29 per month', '$49 per month', '$119 per month'];
      const annual = ['$290 per year, billed once', '$490 per year, billed once', '$1,190 per year, billed once'];
      const prices = async () => (await billingOf(page)).prices.filter((p) => p.startsWith('$'));
      expect((await billingOf(page)).buttons).toEqual([['Monthly', 'true'], ['Annual', 'false']]);
      expect(await prices()).toEqual(monthly);
      const group = page.locator('#app').getByRole('group', { name: 'Billing period' });
      await group.getByRole('button', { name: 'Annual' }).click();
      await expect.poll(prices).toEqual(annual);
      expect((await billingOf(page)).buttons).toEqual([['Monthly', 'false'], ['Annual', 'true']]);
      await group.getByRole('button', { name: 'Monthly' }).press('Enter');
      await expect.poll(prices).toEqual(monthly);
      await group.getByRole('button', { name: 'Annual' }).focus();
      await page.keyboard.press('Space');
      await expect.poll(prices).toEqual(annual);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('wraps the tab row from a tablet up', async () => {
    const { page, problems } = await open(834);
    try {
      await page.waitForFunction('document.querySelectorAll("#app [role=tab]").length === 4');
      expect(await page.evaluate(`getComputedStyle(document.querySelector('#app [role="tablist"]')).flexWrap`)).toBe('wrap');
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('keeps the tab row on one line on a phone, scrolling it sideways, never widening the page', async () => {
    const { page, problems } = await open(390);
    try {
      await page.waitForFunction('document.querySelectorAll("#app [role=tab]").length === 4');
      const row = () =>
        page.evaluate(`(() => {
          const list = document.querySelector('#app [role="tablist"]');
          const tops = new Set([...list.children].map((t) => Math.round(t.getBoundingClientRect().top)));
          return { lines: tops.size, scrolls: list.scrollWidth > list.clientWidth, overflow: getComputedStyle(list).overflowX, scrollLeft: list.scrollLeft, page: document.documentElement.scrollWidth <= innerWidth };
        })()`) as Promise<{ lines: number; scrolls: boolean; overflow: string; scrollLeft: number; page: boolean }>;
      // A row a finger can scroll, never one that clips.
      expect(await row()).toMatchObject({ lines: 1, scrolls: true, overflow: 'auto', scrollLeft: 0, page: true });
      // The last tab, reached from the keyboard, is scrolled into view.
      await page.locator('#app').getByRole('tab', { name: 'Design' }).focus();
      await page.keyboard.press('End');
      await expect.poll(async () => (await row()).scrollLeft).toBeGreaterThan(0);
      const last = await page.evaluate(`(() => { const t = document.activeElement.getBoundingClientRect(); const l = document.activeElement.parentElement.getBoundingClientRect(); return t.right <= l.right + 1 && t.left >= l.left - 1; })()`);
      expect(last).toBe(true);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('prints every tab’s panel under its label and the plans without the switch', async () => {
    const { page, problems } = await open();
    try {
      // As the page loads, on the monthly prices.
      await page.emulateMedia({ media: 'print' });
      expect(await page.evaluate(`getComputedStyle(document.querySelector('#app [role="group"]')).display`)).toBe('none');
      await page.emulateMedia({ media: 'screen' });
      await page.locator('#app').getByRole('group', { name: 'Billing period' }).getByRole('button', { name: 'Annual' }).click();
      await page.emulateMedia({ media: 'print' });
      const printed = (await page.evaluate(`({
        list: getComputedStyle(document.querySelector('#app [role="tablist"]')).display,
        panels: [...document.querySelectorAll('#app [role="tabpanel"]')].map((p) => [p.checkVisibility(), getComputedStyle(p, '::before').content]),
        group: getComputedStyle(document.querySelector('#app [role="group"]')).display,
        prices: [...document.querySelectorAll('#app li p')].filter((p) => p.checkVisibility()).map((p) => p.textContent.replace(/\\s+/g, ' ').trim()).filter((p) => p.startsWith('$'))
      })`)) as { list: string; panels: Array<[boolean, string]>; group: string; prices: string[] };
      expect(printed.list).toBe('none');
      expect(printed.panels).toEqual([[true, '"Design"'], [true, '"Build"'], [true, '"Care"'], [true, '"Support"']]);
      expect(printed.group).toBe('none');
      // What the switch chose prints, each price saying its period.
      expect(printed.prices).toEqual(['$290 per year, billed once', '$490 per year, billed once', '$1,190 per year, billed once']);
      await page.emulateMedia({ media: 'screen' });
      expect((await tabsOf(page)).shown).toEqual(['Plans drawn around how you live']);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('shows every tab’s panel under its label and both billing periods where scripts never run, without the controls (#885)', async () => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      // As the site ships it: the head's script that marks the page as running scripts never runs.
      const head = /<script>document\.documentElement[^<]*<\/script>/.exec(appHtml)![0];
      await page.setContent(`<!doctype html><html lang="en"><head>${head}<style>${css}</style></head><body><div id="app">${ssr}</div></body></html>`);
      const seen = (await page.evaluate(`({
        marked: document.documentElement.classList.contains('so-js'),
        list: getComputedStyle(document.querySelector('#app [role="tablist"]')).display,
        panels: [...document.querySelectorAll('#app [role="tabpanel"]')].map((p) => [p.checkVisibility(), getComputedStyle(p, '::before').content, p.querySelector('h3')?.textContent.trim()]),
        group: getComputedStyle(document.querySelector('#app [role="group"]')).display,
        prices: [...document.querySelectorAll('#app li p')].filter((p) => p.checkVisibility()).map((p) => p.textContent.replace(/\\s+/g, ' ').trim()).filter((p) => p.startsWith('$'))
      })`)) as { marked: boolean; list: string; panels: Array<[boolean, string, string]>; group: string; prices: string[] };
      expect(seen.marked).toBe(false);
      expect(seen.list).toBe('none');
      expect(seen.panels).toEqual([
        [true, '"Design"', 'Plans drawn around how you live'],
        [true, '"Build"', 'One team from demolition to handover'],
        [true, '"Care"', 'Looked after long after we leave'],
        [true, '"Support"', 'Help when you need it']
      ]);
      expect(seen.group).toBe('none');
      // Each plan shows both periods, each price saying which it is for.
      expect(seen.prices).toEqual(['$29 per month', '$290 per year, billed once', '$49 per month', '$490 per year, billed once', '$119 per month', '$1,190 per year, billed once']);
      // The page as the browser lays it out keeps the showcase's own grid in every panel.
      expect(await page.evaluate(`[...document.querySelectorAll('#app [role="tabpanel"]')].map((p) => getComputedStyle(p).display)`)).toEqual(['grid', 'grid', 'grid', 'grid']);
    } finally {
      await context.close();
    }
  });

  it('falls back to the first tab when the chosen one is taken away by a change to its properties', async () => {
    const { page, problems } = await open();
    try {
      await page.evaluate('window.startHarness()');
      await page.waitForFunction('document.querySelectorAll("#harness [role=tab]").length === 4');
      await page.locator('#harness').getByRole('tab', { name: 'Fourth' }).click();
      await expect.poll(async () => (await tabsOf(page, '#harness')).shown).toEqual(['Fourth heading']);
      await page.evaluate('window.dropFourth()');
      await expect.poll(async () => (await tabsOf(page, '#harness')).tabs).toEqual([['Design', 'true', '0'], ['Build', 'false', '-1'], ['Care', 'false', '-1']]);
      expect((await tabsOf(page, '#harness')).shown).toEqual(['Plans drawn around how you live']);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
