/**
 * Same-titled places in Find and replace (#1539): each says its address, in its group's heading, its checkbox and its
 * jump chip. The helper is checked against real projects; the dialog itself runs in a real browser with its own styles.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { contentFields, findContent, placeKey, placeQualifiers, type ContentField } from '../../src/renderer/src/lib/find-content';

const SENTENCE = 'Bring your photo card to the desk.';
const REGIONS = ['regional-services-and-community-programmes/north-point', 'regional-services-and-community-programmes/south-point', 'east-quay'];

/** A page called "Intake checklist" under each region, with the same two sentences. */
function handbook(): ProjectState {
  let s = createStarterState('business', 'Test Studio', false);
  REGIONS.forEach((region, i) => {
    const pageId = `pg_intake000${i}`;
    s = applyOperations(s, [{ type: 'page.create', pageId, title: 'Intake checklist', route: `/${region}/intake-checklist/` }]).state;
    for (const n of [1, 2]) {
      const node: GraphNode = { id: `n_intake_${i}_${n}`, kind: 'text', tag: 'p', text: SENTENCE };
      s.pages[pageId].nodes[node.id] = node;
      s.pages[pageId].rootIds.push(node.id);
    }
  });
  return s;
}

const field = (owner: ContentField['owner'], where: string): ContentField => ({ key: `${owner.kind}:${owner.id}:${where}`, owner, nodeId: owner.id, kind: 'text', value: where, rich: false, richLinks: false, direct: false, where, section: where, label: 'Title' });

describe('qualifying places that share a title', () => {
  it('gives each of the same-titled pages its full address, and a page with a title of its own none', () => {
    const s = handbook();
    const fields = [...findContent(s, 'photo card').map((m) => m.field), ...contentFields(s).filter((f) => f.where === 'About')];
    expect([...placeQualifiers(s, fields)]).toEqual(REGIONS.map((r, i) => [`page:pg_intake000${i}`, `/${r}/intake-checklist/`]));
  });

  it('counts places, not fields', () => {
    const s = handbook();
    const one = findContent(s, 'photo card').filter((m) => m.field.owner.id === 'pg_intake0000');
    expect(one).toHaveLength(2);
    expect(placeQualifiers(s, one.map((m) => m.field)).size).toBe(0);
  });

  it('compares titles without their spacing or capitals', () => {
    const s = handbook();
    const out = placeQualifiers(s, [field({ kind: 'page', id: 'pg_intake0000' }, 'Intake  checklist '), field({ kind: 'page', id: 'pg_intake0001' }, 'intake CHECKLIST')]);
    expect(out.size).toBe(2);
  });

  it('says which is the shared part or the site’s details when a page takes their name', () => {
    const s = handbook();
    const out = placeQualifiers(s, [
      field({ kind: 'shell', id: 'footer' }, 'Footer'),
      field({ kind: 'page', id: 'pg_intake0000' }, 'Footer'),
      field({ kind: 'site', id: 'site' }, 'Site details'),
      field({ kind: 'page', id: 'pg_intake0001' }, 'Site details')
    ]);
    expect(out.get('shell:footer')).toBe('Shared');
    expect(out.get('page:pg_intake0000')).toBe(s.pages.pg_intake0000.route);
    expect(out.get('site:site')).toBe('Whole site');
  });

  it('gives an entry its address, or without a page its collection and slug, and the collection’s ID where those match too', () => {
    let s = createStarterState('business', 'Test Studio', false);
    const entry = (collectionId: string, entryId: string) => ({ type: 'entry.create' as const, collectionId, entryId, title: 'Intake checklist', slug: 'intake-checklist' });
    s = applyOperations(s, [
      { type: 'collection.create', collectionId: 'guides', name: 'Guides' },
      { type: 'collection.create', collectionId: 'notes', name: 'Notes', pages: { detail: false, archive: false } },
      { type: 'collection.create', collectionId: 'old-notes', name: 'Notes', pages: { detail: false, archive: false } },
      entry('guides', 'en_guide0001'),
      entry('notes', 'en_note00001')
    ]).state;
    const fields = () => findContent(s, 'Intake checklist').map((m) => m.field);
    expect([...placeQualifiers(s, fields()).values()].sort()).toEqual(['/guides/intake-checklist/', 'Notes · intake-checklist']);
    s = applyOperations(s, [entry('old-notes', 'en_note00002')]).state;
    const out = placeQualifiers(s, fields());
    expect(out.get(placeKey(fields().find((f) => f.owner.id === 'en_note00001')!))).toBe('Notes · intake-checklist · notes');
    expect(out.get('entry:en_note00002')).toBe('Notes · intake-checklist · old-notes');
    expect(out.get('entry:en_guide0001')).toBe('/guides/intake-checklist/');
  });
});

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://find-places.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { FindReplaceModal } from ${renderer('panels/FindReplace')};`,
  `import { useStore } from ${renderer('store')};`,
  "flushSync(() => useStore.setState({ snapshot: { workspaceKey: 'w', revision: 1, state: window.project }, modal: { kind: 'find' } }));",
  "flushSync(() => createRoot(document.getElementById('root')).render(h(FindReplaceModal, { initial: 'photo card' })));"
].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = (path) => new Proxy(function () {}, {
    get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any(path ? path + '.' + key : key)),
    apply: () => any('')
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
        name: 'find-places',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Find and replace did not bundle');
  return chunk.code;
}

/** The app's own styles, so a chip that clips its address shows it. */
const STYLES = [
  '@layer tokens, reset, base, primitives, layout, components;',
  ...['styles/tokens.css', 'styles/reset.css', 'styles/primitives.css', 'styles/layout.css', 'panels/FindReplace.css'].map((f) => readFileSync(resolve('src/renderer/src', f), 'utf8'))
].join('\n');

describe.skipIf(!browserInstalled)('Find and replace with same-titled pages (#1539)', { timeout: 30_000 }, () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const routes = REGIONS.map((r) => `/${r}/intake-checklist/`);

  beforeAll(async () => {
    const [script, launched] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
    browser = launched;
    // The narrowest window the dialog is designed for.
    page = await browser.newPage({ viewport: { width: 900, height: 640 } });
    page.setDefaultTimeout(5_000);
    page.on('pageerror', (e) => errors.push(e.message));
    const state = JSON.stringify(handbook()).replace(/</g, '\\u003c');
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${STYLES}</style><body><div id="root"></div><script>${BRIDGE};window.project=${state}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
    await page.getByRole('dialog').waitFor();
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    expect(errors).toEqual([]);
  }, 60_000);

  it('names each jump chip by its page’s address, all of it on screen', async () => {
    // Six matches on three pages: the strip needs more than ten.
    const chips = page.getByRole('navigation', { name: 'Places with matches' });
    if (!(await chips.count())) await page.getByLabel('Find', { exact: true }).fill('o');
    for (const route of routes) {
      const chip = chips.getByRole('button', { name: new RegExp(`^Intake checklist, ${route}, \\d+ match`) });
      await chip.waitFor();
      const cut = await chip.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return [...el.querySelectorAll<HTMLElement>('span')].filter((s) => s.scrollWidth > s.clientWidth + 1 || s.getBoundingClientRect().right > box.right + 1).map((s) => s.textContent);
      });
      expect(cut).toEqual([]);
    }
    await page.getByLabel('Find', { exact: true }).fill('photo card');
  });

  it('names each group, and its checkbox, by its address, so one page can be chosen alone', async () => {
    for (const route of routes) await expect.poll(() => page.getByRole('button', { name: `Intake checklist ${route} 2 matches` }).count()).toBe(1);
    await page.getByRole('button', { name: 'Replace…' }).click();
    await page.getByRole('button', { name: 'Choose none' }).click();
    await page.getByRole('checkbox', { name: `Choose all matches in Intake checklist, ${routes[0]}` }).check();
    await expect.poll(() => page.getByRole('region', { name: `Intake checklist, ${routes[0]}, this page only` }).locator('li input:checked').count()).toBe(2);
    expect(await page.locator('li input:checked').count()).toBe(2);
  });
});
