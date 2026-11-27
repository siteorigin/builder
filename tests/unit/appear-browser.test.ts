/**
 * Entrances (issue #355) in real headless browsers: the Home page of a site with entrances as an exported site
 * prerenders it (its generated route compiled for the server and rendered), its generated stylesheets, and the
 * generated observer started as the layout starts it. Checks what a visitor sees: everything without JavaScript, in
 * print, with reduced motion and in the editor's Edit mode, and otherwise only what is below the screen waiting, then
 * coming in as it scrolls into view, items of a staggered list one after another, each keeping its own shift.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { chromium, webkit, type Browser, type BrowserContextOptions, type BrowserType, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComponentDefinition, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { makeInstance } from '@engine/install';
import { P, item, prop, tok } from '@catalogue/dsl';
import { projectDesign } from './fixtures/packs';
import { STYLES_DIR, generateProject, pageFile } from '@generator/index';
import { appearJs } from '@generator/appear';

const ENGINES = ([['chromium', chromium], ['webkit', webkit]] as Array<[string, BrowserType]>).filter(([, engine]) => existsSync(engine.executablePath()));
const GEN = '\0gen:';

const CARD = { layout: 'stack', gap: tok('space.md'), paddingBlock: tok('space.xl'), paddingInline: tok('space.xl'), border: tok('border.default'), radius: tok('radius.lg') } as const;

/**
 * The business starter with entrances: the hero (on screen at once) lifts, the testimonials scale and the closing
 * banner fades in; the features design lifts each card, staggered, and shifts each card 6px down. Entrances are set
 * on sections built in the editor, and Foundation's are code components, so each of these is a design of the
 * project's own placed where the starter has Foundation's, between the starter's other sections.
 */
function site(): ProjectState {
  let s = createStarterState('business', 'Entrance Studio', false);
  const home = s.pages[s.site.homePageId];
  const o: OwnerRef = { kind: 'page', id: home.id };
  const section = (componentId: string) => home.rootIds.map((id) => s.pages[home.id].nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
  const features = projectDesign(s, {
    componentId: 'project.features',
    name: 'Features',
    properties: {
      items: P.list('Cards', 'Card', { title: P.str('Title', 'Card'), description: P.text('Description', '') }, [
        { title: 'Planning', description: 'We help you settle the brief, the budget and the schedule before any work starts.' },
        { title: 'Design', description: 'Drawings and finishes you can see and change before anything is built.' },
        { title: 'Delivery', description: 'We coordinate trusted specialists and keep you informed at every stage of the build.' }
      ])
    },
    parts: { root: { nodeId: 'root', label: 'Features' } },
    build: (b) =>
      b.el('root', 'section', { name: 'Features', styles: { base: { paddingBlock: tok('space.3xl'), paddingInline: tok('space.lg') } } }, [
        b.el('grid', 'ul', { name: 'Card grid', styles: { base: { layout: 'grid', columns: 1, gap: tok('space.lg') }, tablet: { columns: 2 }, desktop: { columns: 3 } } }, [
          b.repeat('cards', 'items', [
            b.el('card', 'li', { name: 'Card', styles: { base: CARD } }, [
              b.text('card-title', 'h3', item('title'), { name: 'Title', styles: { base: { textStyle: tok('text.h3') } } }),
              b.text('card-text', 'p', item('description'), { name: 'Description' })
            ])
          ])
        ])
      ])
  });
  const banner = projectDesign(s, {
    componentId: 'project.banner',
    name: 'Banner',
    properties: { heading: P.str('Heading', 'Ready to start?'), lead: P.text('Text', 'Tell us about your project and we will be in touch within a day.') },
    parts: { root: { nodeId: 'root', label: 'Banner' } },
    build: (b) =>
      b.el('root', 'section', { name: 'Banner', styles: { base: { layout: 'stack', gap: tok('space.md'), paddingBlock: tok('space.3xl'), paddingInline: tok('space.lg') } } }, [
        b.text('heading', 'h2', prop('heading'), { name: 'Heading' }),
        b.text('lead', 'p', prop('lead'), { name: 'Text' })
      ])
  });
  // As tall as the screen, as a hero is, so the cards after it start below the screen.
  const heroDesign = projectDesign(s, {
    componentId: 'project.hero',
    name: 'Hero',
    properties: { heading: P.str('Heading', 'Homes built around the way you live') },
    parts: { root: { nodeId: 'root', label: 'Hero' } },
    build: (b) => b.el('root', 'section', { name: 'Hero', styles: { base: { minHeight: '720px', paddingBlock: tok('space.3xl'), paddingInline: tok('space.lg') } } }, [b.text('heading', 'h1', prop('heading'), { name: 'Heading' })])
  });
  /** Put a placement of the design where the starter placed the theme's section, and return it. */
  const replace = (componentId: string, def: ComponentDefinition): InstanceNode => {
    const old = section(componentId);
    const placed = makeInstance(def, {});
    home.nodes[placed.id] = placed;
    home.rootIds[home.rootIds.indexOf(old.id)] = placed.id;
    delete home.nodes[old.id];
    return placed;
  };
  const hero = replace('hero.split', heroDesign);
  replace('features.grid', features);
  const testimonials = replace('testimonials.grid', banner);
  const closing = replace('cta.banner', banner);
  const design: OwnerRef = { kind: 'component', id: features.id };
  const set = (owner: OwnerRef, nodeId: string, field: 'appear' | 'appearStagger', value: unknown): EditOperation => ({ type: 'node.setContent', owner, nodeId, field, value });
  return applyOperations(s, [
    set(o, hero.id, 'appear', 'lift'),
    set(o, testimonials.id, 'appear', 'scale-subtle'),
    set(o, closing.id, 'appear', 'fade'),
    set(design, 'card', 'appear', 'lift'),
    set(design, 'cards', 'appearStagger', true),
    { type: 'node.setStyle', owner: design, nodeId: 'card', scope: 'base', property: 'translateY', value: '6px' }
  ]).state;
}

/** The page's body HTML as the exported site prerenders it, without hydration comments. */
async function renderRoute(files: Map<string, string>, route: string): Promise<string> {
  const entry = `export { render } from 'svelte/server';\nexport { default as Page } from ${JSON.stringify(GEN + route)};`;
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'generated-route',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          if (importer?.startsWith(GEN) && id.startsWith('.')) {
            const path = posix.join(posix.dirname(importer.slice(GEN.length)), id);
            if (files.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0$app/paths') return "export const resolve = (p) => p; export const asset = (p) => '/' + p; export const base = '';";
          if (id === '\0$app/state') return "export const page = { route: { id: '/' }, url: new URL('https://site.test/') };";
          if (id === '\0$app/navigation') return 'export const afterNavigate = () => {}; export const beforeNavigate = () => {};';
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          const source = files.get(path)!;
          const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, ssr: true, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The route did not bundle');
  const dir = mkdtempSync(join(tmpdir(), 'so-appear-route-'));
  try {
    const file = join(dir, 'route.mjs');
    writeFileSync(file, chunk.code);
    const mod = (await import(pathToFileURL(file).href)) as { render: (c: unknown, o: { props: Record<string, unknown> }) => { body: string }; Page: unknown };
    return mod.render(mod.Page, { props: {} }).body.replace(/<!--[\s\S]*?-->/g, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let body = '';
let css = '';

beforeAll(async () => {
  const s = site();
  const files = generateProject(s);
  css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  body = await renderRoute(files, pageFile(s.pages[s.site.homePageId]));
}, 60_000);

if (!ENGINES.length) describe.skip('entrances in a browser (needs Chromium or WebKit)', () => it('runs in a browser', () => {}));

/*
 * What runs in the page is written as source, as in motion.test.ts: these tests compile without the DOM's types.
 */
type Read = { state: string | null; step: string | null; opacity: string; animation: string; transform: string; translate: string; top: number };
const q = (sel: string) => `document.querySelector(${JSON.stringify(sel)})`;
/** The entrance state, opacity, animation and shifts of the element a selector finds. */
const READ = (sel: string) =>
  `(() => { const el = ${q(sel)}; const cs = getComputedStyle(el); return { state: el.getAttribute('data-appear-state'), step: el.getAttribute('data-appear-step'), opacity: cs.opacity, animation: cs.animationName, transform: cs.transform, translate: cs.translate, top: el.getBoundingClientRect().top }; })()`;
const stateOf = (sel: string) => `${q(sel)}.getAttribute('data-appear-state')`;
const ARMED = `document.querySelectorAll('[data-appear-state]').length`;
const HERO = '[data-appear="lift"]:not([data-appear-stagger])';
const BANNER = '[data-appear="fade"]';
const CARDS = '[data-appear-stagger]';

describe.each(ENGINES)('entrances in %s', { timeout: 20_000 }, (name, engine) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await engine.launch({ headless: true, executablePath: engine.executablePath(), timeout: 30_000 });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** The page with the observer started as the generated layout starts it, or without it (`script: false`). */
  async function open(options: BrowserContextOptions & { instrument?: boolean; before?: string; extraCss?: string; script?: boolean } = {}): Promise<{ page: Page; close: () => Promise<void> }> {
    const { instrument, before = '', extraCss = '', script: run = true, ...contextOptions } = options;
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...contextOptions });
    const page = await context.newPage();
    const script = run ? `<script type="module">${before}\n${appearJs(instrument)}\nwindow.__stop = observeAppear();\nwindow.__ready = true;</script>` : '';
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}\n${extraCss}</style></head><body><main id="main">${body}</main>${script}</body></html>`, { waitUntil: 'domcontentloaded' });
    if (run) await page.waitForFunction('window.__ready === true');
    return { page, close: () => context.close() };
  }
  const read = (page: Page, sel: string) => page.evaluate<Read>(READ(sel));
  const armed = (page: Page) => page.evaluate<number>(ARMED);

  it('renders the presets on the sections and cards they belong to', () => {
    expect(body).toMatch(/<section [^>]*data-appear="lift"/);
    expect(body).toMatch(/data-appear="scale-subtle"/);
    expect(body).toMatch(/data-appear="fade"/);
    expect(body.match(/data-appear="lift" data-appear-stagger="[^"]+"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(body).not.toContain('data-appear-state');
  });

  it('shows everything without JavaScript', async () => {
    // WebKit cannot open a page with JavaScript turned off here; leaving the observer out is the same page to it.
    const { page, close } = await open({ script: false, ...(name === 'webkit' ? {} : { javaScriptEnabled: false }) });
    try {
      for (const sel of [HERO, BANNER, CARDS]) expect(await read(page, sel)).toMatchObject({ state: null, opacity: '1', animation: 'none' });
    } finally {
      await close();
    }
  });

  it('leaves what is on screen alone and brings the rest in as it scrolls into view', async () => {
    const { page, close } = await open();
    try {
      expect(await read(page, HERO)).toMatchObject({ state: null, opacity: '1', animation: 'none' });
      const waiting = await read(page, BANNER);
      expect(waiting.top).toBeGreaterThan(720);
      expect(waiting).toMatchObject({ state: 'waiting', opacity: '0' });
      await page.evaluate(`${q(BANNER)}.scrollIntoView({ block: 'center' })`);
      await page.waitForFunction(`${stateOf(BANNER)} === 'running'`);
      // Once in, nothing of the entrance is left behind.
      await page.waitForFunction(`${stateOf(BANNER)} === null`, undefined, { timeout: 5_000 });
      expect(await read(page, BANNER)).toMatchObject({ state: null, opacity: '1', animation: 'none', transform: 'none' });
    } finally {
      await close();
    }
  });

  it('starts list items that enter together one after another, each keeping its own shift', async () => {
    // Slowed down, so every card is caught while it comes in.
    const { page, close } = await open({ extraCss: '[data-appear-state="running"] { animation-duration: 20s !important; }' });
    try {
      const count = await page.evaluate<number>(`document.querySelectorAll(${JSON.stringify(CARDS)}).length`);
      const cards = Array.from({ length: count }, (_, i) => `${CARDS}:nth-child(${i + 1} of ${CARDS})`);
      expect((await read(page, cards[0])).state).toBe('waiting');
      await page.evaluate(`${q(CARDS)}.parentElement.scrollIntoView({ block: 'center' })`);
      await page.waitForFunction(`[...document.querySelectorAll(${JSON.stringify(CARDS)})].every((el) => el.getAttribute('data-appear-state') === 'running')`);
      const now = await Promise.all(cards.map((c) => read(page, c)));
      expect(now.map((c) => c.step)).toEqual(now.map((_, i) => (i ? String(Math.min(i, 4)) : null)));
      // The first is on its way up; the others wait out their delay at the start, unseen.
      expect(now[0].transform).not.toBe('none');
      expect(now.slice(1).every((c) => parseFloat(c.opacity) < 0.1)).toBe(true);
      // The lift moves `transform`; the card's own shift stays as designed throughout.
      expect(now.every((c) => c.translate === '0px 6px')).toBe(true);
      // Past every delay, each card is still on its way in, none cut short.
      await page.waitForTimeout(600);
      const later = await Promise.all(cards.map((c) => read(page, c)));
      expect(later.map((c) => c.state)).toEqual(cards.map(() => 'running'));
      expect(later.every((c) => c.transform !== 'none' && parseFloat(c.opacity) < 1)).toBe(true);
    } finally {
      await close();
    }
  });

  it('prints everything, even what is still waiting', async () => {
    const { page, close } = await open();
    try {
      expect(await read(page, BANNER)).toMatchObject({ state: 'waiting', opacity: '0' });
      await page.emulateMedia({ media: 'print' });
      expect(await read(page, BANNER)).toMatchObject({ opacity: '1', animation: 'none' });
      expect(await read(page, CARDS)).toMatchObject({ opacity: '1', animation: 'none', transform: 'none' });
      await page.emulateMedia({ media: 'screen' });
      expect(await read(page, BANNER)).toMatchObject({ state: 'waiting', opacity: '0' });
    } finally {
      await close();
    }
  });

  it('arms nothing for a visitor who asks for reduced motion, and lets go when they ask mid-visit', async () => {
    const reduced = await open({ reducedMotion: 'reduce' });
    try {
      expect(await armed(reduced.page)).toBe(0);
      for (const sel of [BANNER, CARDS]) expect(await read(reduced.page, sel)).toMatchObject({ opacity: '1', animation: 'none' });
    } finally {
      await reduced.close();
    }
    const { page, close } = await open();
    try {
      expect((await read(page, BANNER)).state).toBe('waiting');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(`${ARMED} === 0`);
      expect(await read(page, BANNER)).toMatchObject({ opacity: '1', animation: 'none' });
    } finally {
      await close();
    }
  });

  it('arms content that arrives later, and lets everything go when stopped', async () => {
    const { page, close } = await open();
    try {
      await page.evaluate(`(() => {
        const late = document.createElement('div');
        late.id = 'late';
        late.setAttribute('data-appear', 'fade');
        late.textContent = 'Late arrival';
        document.querySelector('main').append(late);
      })()`);
      await page.waitForFunction(`${stateOf('#late')} === 'waiting'`);
      // A preset taken away lets go at once; given back, it counts afresh.
      await page.evaluate(`${q('#late')}.removeAttribute('data-appear')`);
      await page.waitForFunction(`${stateOf('#late')} === null`);
      await page.evaluate(`${q('#late')}.setAttribute('data-appear', 'lift')`);
      await page.waitForFunction(`${stateOf('#late')} === 'waiting'`);
      // Stopping lets go of everything, even an element taken out of the page in the same moment.
      const reinserted = await page.evaluate(`(() => {
        const el = ${q('#late')};
        el.remove();
        window.__stop();
        document.querySelector('main').append(el);
        return el.getAttribute('data-appear-state');
      })()`);
      expect(reinserted).toBe(null);
      expect(await armed(page)).toBe(0);
      expect(await read(page, BANNER)).toMatchObject({ opacity: '1', animation: 'none' });
    } finally {
      await close();
    }
  });

  it('measures a page a visitor moves to where it starts, not where the last one was scrolled to', async () => {
    const { page, close } = await open();
    try {
      // As a client-side navigation does: the new page's content arrives while the old scroll position holds, and
      // the page goes back to its top only after that, gliding there (the theme scrolls smoothly).
      await page.evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
      await page.evaluate(`(() => {
        document.querySelector('main').innerHTML = '<div style="height: 1400px"></div><div id="next" data-appear="fade" style="height: 200px">Next page</div><div style="height: 200px"></div>';
        queueMicrotask(() => window.scrollTo(0, 0));
      })()`);
      await page.waitForFunction(`${stateOf('#next')} === 'waiting'`);
      expect((await read(page, '#next')).top).toBeGreaterThan(720);
    } finally {
      await close();
    }
  });

  it('shows an element at once, and for good, when keyboard focus moves inside it', async () => {
    const { page, close } = await open();
    try {
      await page.evaluate(`(() => {
        const box = document.createElement('div');
        box.id = 'focusable';
        box.setAttribute('data-appear', 'lift');
        box.innerHTML = '<a href="#x">A link</a>';
        document.querySelector('main').append(box);
      })()`);
      await page.waitForFunction(`${stateOf('#focusable')} === 'waiting'`);
      await page.focus('#focusable a');
      await page.waitForFunction(`${stateOf('#focusable')} === null`);
      expect(await read(page, '#focusable')).toMatchObject({ opacity: '1', animation: 'none' });
      // Leaving it plays nothing afterwards.
      await page.evaluate(`document.activeElement.blur()`);
      await page.waitForTimeout(50);
      expect(await read(page, '#focusable')).toMatchObject({ state: null, opacity: '1', animation: 'none' });
    } finally {
      await close();
    }
  });

  it('hides nothing in a browser without IntersectionObserver', async () => {
    const { page, close } = await open({ before: 'delete window.IntersectionObserver;' });
    try {
      expect(await armed(page)).toBe(0);
      expect(await read(page, BANNER)).toMatchObject({ opacity: '1', animation: 'none' });
    } finally {
      await close();
    }
  });

  it('in the editor, arms nothing until Preview, and shows everything again in Edit', async () => {
    const { page, close } = await open({ instrument: true });
    try {
      // Before the editor's bridge runs, and once it starts in Edit.
      expect(await armed(page)).toBe(0);
      await page.evaluate(`window.__siteoriginBridge = true; document.documentElement.setAttribute('data-so-editing', '')`);
      expect(await armed(page)).toBe(0);
      // Preview.
      await page.evaluate(`document.documentElement.removeAttribute('data-so-editing')`);
      await page.waitForFunction(`${stateOf(BANNER)} === 'waiting'`);
      expect((await read(page, HERO)).state).toBe(null);
      // Back to Edit.
      await page.evaluate(`document.documentElement.setAttribute('data-so-editing', '')`);
      await page.waitForFunction(`${ARMED} === 0`);
      expect(await read(page, BANNER)).toMatchObject({ opacity: '1', animation: 'none' });
    } finally {
      await close();
    }
  });
});
