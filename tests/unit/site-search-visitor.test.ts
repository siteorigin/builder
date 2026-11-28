/**
 * Site search as a visitor uses it, in a real headless browser at phone width: the generated component, the
 * generated search code and the generated index of a 150-page portfolio, compiled for the client and bundled with
 * Svelte's browser runtime, mounted on a page nested two levels deep of a site published under /my-site/.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { compile, compileModule } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { RUNTIME_DIR, defFile, generateProject } from '@generator/index';
import { SEARCH_HELPER_FILE, SEARCH_INDEX_FILE } from '@generator/search';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { P, prop } from '@catalogue/dsl';
import { projectDesign } from './fixtures/packs';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'https://site.test';
const BASE = '/my-site';
const AT = `${BASE}/portfolio/find/`;

/**
 * The exported site of a portfolio of 150 project pages, with Site search on a page of its own. Each page's words are
 * in a text section designed in the editor: the index reads none of Foundation's sections but its forms, tables and
 * videos (see the Release gap test in site-search.test.ts).
 */
function exportedSite() {
  let s: ProjectState = createStarterState('business', 'Test Studio', false);
  const apply = (ops: EditOperation[]) => (s = applyOperations(s, ops).state);
  const text = projectDesign(s, {
    componentId: 'project.text',
    name: 'Text',
    properties: { heading: P.str('Heading', 'Heading'), body: P.text('Text', '') },
    parts: { root: { nodeId: 'root', label: 'Text' } },
    build: (b) => b.el('root', 'section', { name: 'Text' }, [b.text('heading', 'h2', prop('heading'), { name: 'Heading' }), b.text('body', 'p', prop('body'), { name: 'Text' })])
  });
  apply([
    { type: 'page.create', pageId: 'pg_find', title: 'Find a project', route: '/portfolio/find/' },
    { type: 'node.insert', owner: { kind: 'page', id: 'pg_find' }, componentId: 'site.search', props: { heading: 'Find a project' } }
  ]);
  for (let n = 1; n <= 150; n++) {
    const id = `pg_p${n}`;
    apply([
      { type: 'page.create', pageId: id, title: `Workshop commission ${n}`, route: `/portfolio/workshop-commission-${n}/` },
      { type: 'node.insert', owner: { kind: 'page', id }, definitionId: text.id, props: { heading: `Commission ${n}`, body: `A piece in oak and linen, number ${n} of the series.` } }
    ]);
  }
  const files = generateProject(s);
  const def = Object.values(s.components).find((d) => d.componentId === 'site.search')!;
  return { files, searchFile: defFile(def) };
}

/** `$app/state`: the page the router is on, which a test can move as a client-side navigation does. */
const STATE_STUB = `let path = $state(location.pathname);
export const page = {
	get url() {
		return new URL(path, location.href);
	}
};
window.navigateTo = (to) => {
	history.pushState({}, '', to);
	path = to;
};`;

/**
 * `$app/navigation`'s snapshot(), as SvelteKit keeps one for each history entry: captured as the visitor leaves the
 * entry and given back as it is shown again, across a full load through the tab's session storage. A test can also
 * capture and restore by hand, as a client-side Back does for a search that stays on screen.
 */
const NAVIGATION_STUB = `import { onMount } from 'svelte';
const KEY = 'test-snapshots';
const registrations = new Set();
function entry() {
	if (!history.state?.entry) history.replaceState({ ...history.state, entry: String(Math.random()) }, '');
	return history.state.entry;
}
const capture = () => Object.fromEntries([...registrations].map((r) => [r.id, JSON.stringify(r.capture())]));
const restore = (kept) => {
	for (const r of registrations) if (kept && r.id in kept) r.restore(JSON.parse(kept[r.id]));
};
addEventListener('pagehide', () => {
	const all = JSON.parse(sessionStorage.getItem(KEY) ?? '{}');
	all[entry()] = capture();
	sessionStorage.setItem(KEY, JSON.stringify(all));
});
window.captureSnapshots = capture;
window.restoreSnapshots = restore;
export function snapshot(options) {
	onMount(() => {
		const kept = JSON.parse(sessionStorage.getItem(KEY) ?? '{}')[entry()];
		if (kept && options.id in kept) options.restore(JSON.parse(kept[options.id]));
		registrations.add(options);
		return () => registrations.delete(options);
	});
}`;

/** The root layout's part in search: it keeps every search on the page for Back, around the searches it shows. */
const LAYOUT = `<script>
	import { keepSearches } from '../runtime/search-history.js';
	import Search from 'site-search-component';
	let { searches } = $props();
	keepSearches();
</script>
{#each searches as props}<Search {...props} />{/each}`;

/** `$app/paths` for a site published under a sub-path. */
const PATHS_STUB = `export const base = ${JSON.stringify(BASE)};
export const resolve = (path) => base + path;
export const asset = (path) => base + path;`;

async function bundle(): Promise<string> {
  const { files, searchFile } = exportedSite();
  const modules: Record<string, string> = {
    '\0entry': `import { flushSync, mount } from 'svelte'; import Layout from '\0layout';
window.mountSearch = (searches) => {
	mount(Layout, { target: document.getElementById('app'), props: { searches } });
	flushSync();
};`,
    '\0layout': compile(LAYOUT, { filename: 'Layout.svelte', generate: 'client', runes: true }).js.code,
    'site-search-component': compile(files.get(searchFile)!, { filename: 'SiteSearch.svelte', generate: 'client', css: 'injected', runes: true }).js.code,
    '\0helper': files.get(`${RUNTIME_DIR}/${SEARCH_HELPER_FILE}`)!,
    '\0index': files.get(`${RUNTIME_DIR}/${SEARCH_INDEX_FILE}`)!,
    '../runtime/visitor-text.js': files.get(`${RUNTIME_DIR}/visitor-text.js`)!,
    '../runtime/util.js': files.get(`${RUNTIME_DIR}/util.js`)!,
    '../runtime/search-history.js': files.get(`${RUNTIME_DIR}/search-history.js`)!,
    '$app/state': compileModule(STATE_STUB, { filename: 'state.svelte.js', generate: 'client' }).js.code,
    '$app/paths': PATHS_STUB,
    '$app/navigation': NAVIGATION_STUB
  };
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'site-search',
        resolveId: (id) => (id in modules ? id : id === `../runtime/${SEARCH_HELPER_FILE}` ? '\0helper' : id === `./${SEARCH_INDEX_FILE}` ? '\0index' : null),
        load: (id) => modules[id] ?? null
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The search did not bundle');
  return chunk.code;
}

/** A page of the site, marked as running scripts as its app.html marks it (see generateAppHtml). */
const PAGE = `<!doctype html><html lang="en" class="so-js"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0"><main id="app"></main><script src="${BASE}/search.js"></script></body></html>`;

describe.skipIf(!browserInstalled)('site search for a visitor', () => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    const [bundled, launched] = await Promise.allSettled([bundle(), chromium.launch({ headless: true, executablePath: chromium.executablePath() })]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (bundled.status === 'rejected') throw bundled.reason;
    if (launched.status === 'rejected') throw launched.reason;
    script = bundled.value;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function withSearch(body: (page: Page, visited: string[]) => Promise<void>, at = AT, searches?: Record<string, string>[]) {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
    const visited: string[] = [];
    try {
      const page = await context.newPage();
      await page.route(`${ORIGIN}/**`, (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === `${BASE}/search.js`) return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
        visited.push(url.pathname);
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE });
      });
      await page.goto(`${ORIGIN}${at}`);
      await mount(page, searches);
      await body(page, visited);
    } finally {
      await context.close();
    }
  }

  /** Starts the search on the page as the page's scripts do, as a visit or a Back to it does. */
  const mount = (page: Page, searches: Record<string, string>[] = [{ heading: 'Find a project' }]) => page.evaluate(`window.mountSearch(${JSON.stringify(searches)})`);
  const box = (page: Page) => page.getByRole('searchbox', { name: 'Search for' });
  const status = (page: Page) => page.getByRole('status');
  const results = (page: Page) => page.locator('.so-search__result');

  it('is left out of a page whose scripts never ran, where it could find nothing (#885)', async () => {
    await withSearch(async (page) => {
      expect(await page.getByRole('search', { name: 'Find a project' }).count()).toBe(1);
      expect(await page.evaluate(`getComputedStyle(document.querySelector('.so-search')).display`)).not.toBe('none');
      // The same page without the mark its head's script sets.
      await page.evaluate(`document.documentElement.classList.remove('so-js')`);
      expect(await page.evaluate(`getComputedStyle(document.querySelector('.so-search')).display`)).toBe('none');
      expect(await page.getByRole('search').count()).toBe(0);
    });
  });

  it('finds a project by name with the keyboard and goes to it from a nested address', async () => {
    await withSearch(async (page, visited) => {
      await expect(page.getByRole('search', { name: 'Find a project' }).count()).resolves.toBe(1);
      await box(page).focus();
      await page.keyboard.type('Workshop commission 105');
      await page.keyboard.press('Enter');
      await expect.poll(() => status(page).innerText()).toBe('1 page matches “Workshop commission 105”.');
      const link = results(page).first().getByRole('link');
      await expect(link.innerText()).resolves.toBe('Workshop commission 105');
      await expect(link.getAttribute('href')).resolves.toBe(`${BASE}/portfolio/workshop-commission-105/`);
      await expect(results(page).first().locator('.so-search__excerpt').innerText()).resolves.toContain('number 105 of the series');
      // From the box, Tab reaches the button that clears it, the Search button and then the result; Enter follows it.
      await page.keyboard.press('Tab');
      await expect(page.evaluate('document.activeElement.getAttribute("aria-label")')).resolves.toBe('Clear search');
      await page.keyboard.press('Tab');
      await expect(page.evaluate('document.activeElement.textContent.trim()')).resolves.toBe('Search');
      await page.keyboard.press('Tab');
      await expect(page.evaluate('document.activeElement.getAttribute("href")')).resolves.toBe(`${BASE}/portfolio/workshop-commission-105/`);
      await page.keyboard.press('Enter');
      await page.waitForURL(`${ORIGIN}${BASE}/portfolio/workshop-commission-105/`);
      expect(visited.at(-1)).toBe(`${BASE}/portfolio/workshop-commission-105/`);
    });
  });

  it('says what to do with an empty search and when nothing matches', async () => {
    await withSearch(async (page) => {
      await page.getByRole('button', { name: 'Search', exact: true }).tap();
      await expect.poll(() => status(page).innerText()).toBe('Type a word or phrase to search for.');
      await expect(results(page).count()).resolves.toBe(0);
      await box(page).fill('commission');
      await box(page).press('Enter');
      await expect.poll(() => results(page).count()).toBe(20);
      // Spaces alone are no search either, and the results of the last one go.
      await box(page).fill('   ');
      await box(page).press('Enter');
      await expect.poll(() => status(page).innerText()).toBe('Type a word or phrase to search for.');
      await expect(results(page).count()).resolves.toBe(0);
      await box(page).fill('zeppelin');
      await box(page).press('Enter');
      await expect.poll(() => status(page).innerText()).toBe('No pages match “zeppelin”. Try fewer or different words.');
      await expect(results(page).count()).resolves.toBe(0);
    });
  });

  it('shows the first 20 of many matches and says how many there are', async () => {
    await withSearch(async (page) => {
      await box(page).fill('workshop');
      await box(page).press('Enter');
      await expect.poll(() => status(page).innerText()).toBe('150 pages match “workshop”. The first 20 are shown; add words to narrow the search.');
      await expect(results(page).count()).resolves.toBe(20);
      await expect(results(page).first().locator('mark').first().innerText()).resolves.toBe('Workshop');
      // Part of the title marked, its words still read apart.
      await expect(results(page).first().getByRole('link').innerText()).resolves.toBe('Workshop commission 1');
    });
  });

  it('clears with Escape, keeping the focus in the box', async () => {
    await withSearch(async (page) => {
      await box(page).fill('commission 7');
      await box(page).press('Enter');
      await expect.poll(() => results(page).count()).toBeGreaterThan(0);
      await box(page).press('Escape');
      await expect(box(page).inputValue()).resolves.toBe('');
      await expect(results(page).count()).resolves.toBe(0);
      await expect(status(page).innerText()).resolves.toBe('');
      await expect(page.evaluate('document.activeElement === document.querySelector(".so-search__input")')).resolves.toBe(true);
    });
  });

  it('starts afresh on the next page when it stays on screen', async () => {
    await withSearch(async (page) => {
      await box(page).fill('commission 9');
      await box(page).press('Enter');
      await expect.poll(() => results(page).count()).toBeGreaterThan(0);
      await page.evaluate(`window.navigateTo(${JSON.stringify(`${BASE}/about/`)})`);
      await expect.poll(() => results(page).count()).toBe(0);
      await expect(box(page).inputValue()).resolves.toBe('');
    });
  });

  it('runs a search that arrives in the address, as one sent before the page started does', async () => {
    await withSearch(async (page) => {
      await expect.poll(() => status(page).innerText()).toBe('1 page matches “commission 105”.');
      await expect(box(page).inputValue()).resolves.toBe('commission 105');
      await expect(results(page).first().getByRole('link').getAttribute('href')).resolves.toBe(`${BASE}/portfolio/workshop-commission-105/`);
    }, `${AT}?q=commission+105`);
  });

  it('brings the search and its results back when the visitor returns with Back from a result (#1436)', async () => {
    await withSearch(async (page) => {
      await box(page).fill('commission 105');
      await box(page).press('Enter');
      await expect.poll(() => status(page).innerText()).toBe('1 page matches “commission 105”.');
      await results(page).first().getByRole('link').click();
      await page.waitForURL(`${ORIGIN}${BASE}/portfolio/workshop-commission-105/`);
      await page.goBack();
      await page.waitForURL((url) => url.pathname === AT);
      await mount(page);
      await expect.poll(() => status(page).innerText()).toBe('1 page matches “commission 105”.');
      await expect(box(page).inputValue()).resolves.toBe('commission 105');
      await expect(results(page).first().getByRole('link').getAttribute('href')).resolves.toBe(`${BASE}/portfolio/workshop-commission-105/`);
    });
  });

  it('forgets a cleared search, so Back from the next page finds the box empty', async () => {
    await withSearch(async (page) => {
      await box(page).fill('commission 105');
      await box(page).press('Enter');
      await expect.poll(() => results(page).count()).toBe(1);
      await box(page).press('Escape');
      await expect(box(page).inputValue()).resolves.toBe('');
      await page.goto(`${ORIGIN}${BASE}/about/`);
      await page.goBack();
      await page.waitForURL((url) => url.pathname === AT);
      await mount(page);
      await expect(box(page).inputValue()).resolves.toBe('');
      await expect(results(page).count()).resolves.toBe(0);
      await expect(status(page).innerText()).resolves.toBe('');
    });
  });

  it('brings back what each search on the page held, and words typed after the last search beside its results', async () => {
    const two = [{ heading: 'Find a project' }, { heading: 'Search again', label: 'Search the series' }];
    await withSearch(
      async (page) => {
        const second = page.getByRole('searchbox', { name: 'Search the series' });
        await box(page).fill('commission 105');
        await box(page).press('Enter');
        await second.fill('zeppelin');
        await second.press('Enter');
        await expect.poll(() => page.getByRole('status').nth(1).innerText()).toBe('No pages match “zeppelin”. Try fewer or different words.');
        await expect.poll(() => results(page).count()).toBe(1);
        // Words typed into the first box after its search, not sent: Back keeps them and the list that was followed.
        await box(page).fill('commission 10');
        await results(page).first().getByRole('link').click();
        await page.waitForURL(`${ORIGIN}${BASE}/portfolio/workshop-commission-105/`);
        await page.goBack();
        await page.waitForURL((url) => url.pathname === AT);
        await mount(page, two);
        await expect.poll(() => page.getByRole('status').first().innerText()).toBe('1 page matches “commission 105”.');
        await expect(box(page).inputValue()).resolves.toBe('commission 10');
        await expect(results(page).count()).resolves.toBe(1);
        await expect(second.inputValue()).resolves.toBe('zeppelin');
        await expect(page.getByRole('status').nth(1).innerText()).resolves.toBe('No pages match “zeppelin”. Try fewer or different words.');
      },
      AT,
      two
    );
  });

  it('brings a search that stays on screen back on a client-side Back, after starting afresh on the next page', async () => {
    await withSearch(async (page) => {
      await box(page).fill('commission 9');
      await box(page).press('Enter');
      await expect.poll(() => results(page).count()).toBeGreaterThan(0);
      const found = await results(page).count();
      const kept = await page.evaluate('window.captureSnapshots()');
      await page.evaluate(`window.navigateTo(${JSON.stringify(`${BASE}/about/`)})`);
      await expect.poll(() => results(page).count()).toBe(0);
      // Back: the router moves the page back, then gives the entry's snapshot back once it is in place.
      await page.evaluate(`window.navigateTo(${JSON.stringify(AT)})`);
      await expect.poll(() => box(page).inputValue()).toBe('');
      await page.evaluate(`window.restoreSnapshots(${JSON.stringify(kept)})`);
      await expect.poll(() => results(page).count()).toBe(found);
      await expect(box(page).inputValue()).resolves.toBe('commission 9');
      await expect(status(page).innerText()).resolves.toMatch(/“commission 9”/);
    });
  });

  it('fits a phone screen with targets big enough to tap', async () => {
    await withSearch(async (page) => {
      await box(page).fill('workshop');
      await box(page).press('Enter');
      await expect.poll(() => results(page).count()).toBe(20);
      await expect(page.evaluate('document.documentElement.scrollWidth')).resolves.toBeLessThanOrEqual(360);
      // The box, its Search and Clear search buttons, and a result.
      for (const target of [box(page), page.getByRole('button', { name: 'Search', exact: true }), page.getByRole('button', { name: 'Clear search' }), results(page).first().getByRole('link')]) {
        const size = await target.boundingBox();
        expect(size!.height).toBeGreaterThanOrEqual(44);
      }
      await expect(box(page).getAttribute('enterkeyhint')).resolves.toBe('search');
    });
  });
});
