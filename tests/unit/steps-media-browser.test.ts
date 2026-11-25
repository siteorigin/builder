/**
 * Foundation's Steps with pictures and the Services grid's pinned heading (#383), exported and run in a real browser.
 * The page rendered on the server hydrates without a mismatch; choosing a step, by pointer or keyboard, opens its
 * description and shows its own picture in that placement only, and every step names content that is there. From
 * tablet width up the pinned column stays below the sticky header (whatever height the header publishes as
 * --so-header-offset) while the cards scroll past, and lets go at the end of its section; phones and print show one
 * plain column with every step's description and picture. The editor's layout inspection finds no overlapping boxes at
 * phone, tablet or desktop width.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { makeInstance } from '@engine/install';
import { generateProject } from '@generator/index';
import { FOUNDATION_PACK } from '@catalogue/builtin';
import { bundle, removeRendered, serverHtml } from './generated-site';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://steps.test';
const SESSION = 'so-test';
/** The header height the stand-in header publishes, and the gap the pinned column keeps below it (1.5rem). */
const HEADER = 100;
const GAP = 24;

/** Home with Steps with pictures placed twice and a Services grid of eight cards with its heading pinned beside them. */
function project(): ProjectState {
  const s = createStarterState('business', 'Steps Studio', false);
  const home = s.pages[s.site.homePageId];
  const add = (componentId: string, props: Record<string, unknown> = {}, variants?: Record<string, string>) => {
    const def = structuredClone(FOUNDATION_PACK.components.find((d) => d.componentId === componentId)!);
    s.components[def.id] = def;
    const node: InstanceNode = { ...makeInstance(def, props), ...(variants ? { variants } : {}) };
    home.nodes[node.id] = node;
    return node.id;
  };
  const cards = Array.from({ length: 8 }, (_, i) => ({ id: `card-${i + 1}`, icon: 'sparkles', title: `Service ${i + 1}`, description: 'A considered service, described in a sentence or two so the card has some height.', linkLabel: '', link: { type: 'none', target: '' } }));
  const after = home.rootIds.slice(-1);
  home.rootIds = [add('content.steps-media'), add('content.steps-media'), add('features.grid', { items: cards }, { layout: 'sticky-split' }), ...after];
  return s;
}

afterAll(removeRendered);

describe.skipIf(!browserInstalled)('Steps with pictures and the pinned heading in a browser', () => {
  let browser: Browser;
  let script: string;
  let ssr: string;
  let css: string;
  beforeAll(async () => {
    const s = project();
    const clean = generateProject(s);
    const dev = generateProject(s, { instrument: true });
    ssr = await serverHtml(clean, 'steps-media-browser-');
    css = ['tokens', 'theme', 'components', 'site'].map((f) => clean.get(`src/lib/siteorigin/styles/${f}.css`) ?? '').join('\n');
    script = await bundle(clean, dev);
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  interface Opened {
    page: Page;
    site: Frame;
    problems: string[];
  }

  /**
   * The server-rendered page hydrated (`clean`), under a stand-in sticky header that publishes its height as the real
   * one does; or the editor's variant in a frame of a stand-in editor with the real preview bridge (`dev`).
   */
  async function open(variant: 'clean' | 'dev', width = 1280): Promise<Opened> {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (m) => {
      if ((m.type() === 'warning' || m.type() === 'error') && !m.text().startsWith('Failed to load resource')) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    const header = `<div id="stand-in-header" style="position:fixed;inset:0 0 auto 0;height:var(--so-header-offset);background:#111;z-index:50"></div>`;
    const site = `<!doctype html><html lang="en" style="--so-header-offset:${HEADER}px"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${variant === 'clean' ? header : ''}<div id="app">${variant === 'clean' ? ssr : ''}</div></body></html>`;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.pathname === '/site') return route.fulfill({ contentType: 'text/html', body: site });
      if (url.pathname === '/') {
        const editor = `<!doctype html><title>Editor</title><script>window.sent = []; addEventListener('message', (e) => window.sent.push(e.data));</script><iframe name="${SESSION}" src="/site" style="width:${width}px;height:900px;border:0"></iframe>`;
        return route.fulfill({ contentType: 'text/html', body: variant === 'dev' ? editor : site });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.setViewportSize({ width: variant === 'dev' ? Math.max(width, 1300) + 20 : width, height: 800 });
    await page.goto(`${ORIGIN}/`);
    let frame = page.mainFrame();
    if (variant === 'dev') {
      await expect.poll(() => page.frame({ name: SESSION })?.url()).toBe(`${ORIGIN}/site`);
      frame = page.frame({ name: SESSION })!;
      await frame.waitForLoadState();
    }
    await frame.addScriptTag({ url: '/app.js', type: 'module' });
    await frame.waitForFunction('typeof window.startSite === "function"');
    if (variant === 'clean') await frame.evaluate(`document.querySelector('ol').fromServer = true`);
    await frame.evaluate(`window.startSite(${JSON.stringify(variant)})`);
    if (variant === 'dev') {
      await frame.addScriptTag({ url: '/bridge.js', type: 'module' });
      await frame.waitForFunction('window.__siteoriginBridge === true && document.documentElement.hasAttribute("data-so-editing")');
    }
    return { page, site: frame, problems };
  }

  /** Each Steps with pictures placement: its step buttons as [title, expanded], and the descriptions and pictures on screen. */
  const steps = (site: Frame) =>
    site.evaluate(`[...document.querySelectorAll('[class*="steps-media__steps-layout"]')].map((layout) => ({
      buttons: [...layout.querySelectorAll('button')].map((b) => [b.textContent.trim(), b.getAttribute('aria-expanded')]),
      shown: [...layout.querySelectorAll('[class*="__step-details"]')].filter((d) => getComputedStyle(d).display !== 'none').map((d) => d.textContent.trim().slice(0, 20)),
      pictures: [...layout.querySelectorAll('figure')].filter((f) => getComputedStyle(f).display !== 'none').map((f) => f.querySelector('[role="img"], img')?.getAttribute('aria-label') ?? f.querySelector('img')?.alt)
    }))`) as Promise<Array<{ buttons: string[][]; shown: string[]; pictures: string[] }>>;
  const expanded = (buttons: string[][]) => buttons.filter((b) => b[1] === 'true').map((b) => b[0]);

  it('hydrates the exported page, and a step’s button opens its description and shows its picture in its placement only', async () => {
    const { page, site, problems } = await open('clean');
    try {
      expect(await site.evaluate(`document.querySelector('ol').fromServer === true`)).toBe(true);
      const start = { buttons: [['Plan together', 'true'], ['Design the details', 'false'], ['Build and hand over', 'false']], shown: ['We walk the site wit'], pictures: ['Planning a project at a table'] };
      expect(await steps(site)).toEqual([start, start]);
      const first = site.locator('[class*="steps-media__steps-layout"]').first();
      await first.getByRole('button', { name: 'Design the details' }).click();
      await expect.poll(async () => (await steps(site))[0]).toEqual({ buttons: [['Plan together', 'false'], ['Design the details', 'true'], ['Build and hand over', 'false']], shown: ['Layouts, materials a'], pictures: ['Material samples laid out for review'] });
      expect((await steps(site))[1]).toEqual(start);
      // From the keyboard: Enter and Space on a step's button choose it, as a click does.
      await first.getByRole('button', { name: 'Build and hand over' }).focus();
      await page.keyboard.press('Enter');
      await expect.poll(async () => expanded((await steps(site))[0].buttons)).toEqual(['Build and hand over']);
      expect((await steps(site))[0].pictures).toEqual(['A finished room ready for handover']);
      await first.getByRole('button', { name: 'Plan together' }).focus();
      await page.keyboard.press('Space');
      await expect.poll(async () => expanded((await steps(site))[0].buttons)).toEqual(['Plan together']);
      // Every step names its own description and picture, once each, in its own placement.
      const named = (await site.evaluate(`[...document.querySelectorAll('[class*="steps-media__steps-layout"] button')].map((b) => b.getAttribute('aria-controls').split(' ').map((id) => {
        const found = [...document.querySelectorAll('[id]')].filter((e) => e.id === id);
        return found.length === 1 && b.closest('section').contains(found[0]) ? found[0].tagName : 'missing';
      }))`)) as string[][];
      expect(named).toEqual(Array(6).fill(['DIV', 'FIGURE']));
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  /** Where the pinned heading and the first card are, and the header's bottom, in the viewport. */
  const pinned = (site: Frame) =>
    site.evaluate(`(() => {
      const root = document.querySelector('[class*="features-grid--layout-sticky-split"][class*="__root"]');
      const box = (sel) => root.querySelector(sel).getBoundingClientRect();
      const intro = box('[class*="features-grid__intro"]');
      return { introTop: intro.top, introBottom: intro.bottom, cardTop: box('li').top, innerBottom: box('[class*="features-grid__inner"]').bottom, header: document.getElementById('stand-in-header')?.getBoundingClientRect().bottom ?? 0, position: getComputedStyle(root.querySelector('[class*="features-grid__intro"]')).position, columns: getComputedStyle(root.querySelector('[class*="features-grid__inner"]')).gridTemplateColumns, sectionTop: root.getBoundingClientRect().top + scrollY, sectionHeight: root.offsetHeight };
    })()`) as Promise<{ introTop: number; introBottom: number; cardTop: number; innerBottom: number; header: number; position: string; columns: string; sectionTop: number; sectionHeight: number }>;
  const scrollTo = (site: Frame, y: number) => site.evaluate(`new Promise((done) => { scrollTo({ top: ${y}, behavior: 'instant' }); requestAnimationFrame(() => requestAnimationFrame(done)); })`);

  it('pins the Services heading below whatever height the sticky header publishes while the cards scroll past, and lets go at the section’s end', async () => {
    const { page, site } = await open('clean', 1280);
    try {
      const at = await pinned(site);
      expect(at.position).toBe('sticky');
      expect(at.columns.split(' ')).toHaveLength(2);
      // Partway down the section: the cards have moved up past the heading, which holds 1.5rem below the header.
      await scrollTo(site, at.sectionTop + 400);
      let now = await pinned(site);
      expect(now.introTop).toBeCloseTo(HEADER + GAP, 0);
      expect(now.introTop).toBeGreaterThanOrEqual(now.header);
      expect(now.cardTop).toBeLessThan(now.introTop);
      // A shorter header (or one that does not stick, which publishes 0): the heading follows it up.
      await site.evaluate(`document.documentElement.style.setProperty('--so-header-offset', '0px')`);
      await scrollTo(site, at.sectionTop + 420);
      expect((await pinned(site)).introTop).toBeCloseTo(GAP, 0);
      await site.evaluate(`document.documentElement.style.setProperty('--so-header-offset', '${HEADER}px')`);
      // Near the end of the section it goes with it, never past its container.
      await scrollTo(site, at.sectionTop + at.sectionHeight - 200);
      now = await pinned(site);
      expect(now.introBottom).toBeLessThanOrEqual(now.innerBottom + 1);
      expect(now.introTop).toBeLessThan(HEADER + GAP);
    } finally {
      await page.close();
    }
  });

  it('shows one plain column below 768px and pins from 768px, the picture too', async () => {
    for (const [width, sticky] of [[390, false], [767, false], [768, true]] as const) {
      const { page, site } = await open('clean', width);
      try {
        const at = await pinned(site);
        expect([width, at.position]).toEqual([width, sticky ? 'sticky' : 'static']);
        const stack = (await site.evaluate(`(() => {
          const layout = document.querySelector('[class*="steps-media__steps-layout"]');
          const list = layout.querySelector('ol').getBoundingClientRect();
          const stage = layout.querySelector('[class*="__media-stage"]');
          return { position: getComputedStyle(stage).position, below: stage.getBoundingClientRect().top >= list.bottom - 1 };
        })()`)) as { position: string; below: boolean };
        expect([width, stack.position, stack.below]).toEqual([width, sticky ? 'sticky' : 'static', !sticky]);
        if (!sticky) expect(at.cardTop).toBeGreaterThanOrEqual(at.introBottom - 1);
      } finally {
        await page.close();
      }
    }
  });

  it('prints every step’s description and picture, and each pinned column in its place, one after the other', async () => {
    const { page, site } = await open('clean', 1280);
    try {
      await site.locator('[class*="steps-media__steps-layout"]').first().getByRole('button', { name: 'Design the details' }).click();
      await page.emulateMedia({ media: 'print' });
      const printed = (await site.evaluate(`(() => {
        const shown = (sel) => [...document.querySelectorAll(sel)].filter((e) => getComputedStyle(e).display !== 'none').length;
        const layout = document.querySelector('[class*="steps-media__steps-layout"]');
        const stage = layout.querySelector('[class*="__media-stage"]');
        const root = document.querySelector('[class*="features-grid--layout-sticky-split"][class*="__root"]');
        const intro = root.querySelector('[class*="features-grid__intro"]');
        return {
          details: shown('[class*="__step-details"]'),
          figures: shown('[class*="steps-media__media-stage"] figure'),
          stage: [getComputedStyle(stage).position, stage.getBoundingClientRect().top >= layout.querySelector('ol').getBoundingClientRect().bottom - 1],
          intro: [getComputedStyle(intro).position, getComputedStyle(root.querySelector('[class*="features-grid__inner"]')).gridTemplateColumns.split(' ').length, root.querySelector('li').getBoundingClientRect().top >= intro.getBoundingClientRect().bottom - 1]
        };
      })()`)) as { details: number; figures: number; stage: [string, boolean]; intro: [string, number, boolean] };
      expect(printed).toEqual({ details: 6, figures: 6, stage: ['static', true], intro: ['static', 1, true] });
      // Back on screen, the step chosen before printing is still the one showing.
      await page.emulateMedia({ media: 'screen' });
      expect((await steps(site))[0].shown).toEqual(['Layouts, materials a']);
    } finally {
      await page.close();
    }
  });

  it('passes the editor’s layout inspection with no overlapping boxes at phone, tablet and desktop width', async () => {
    for (const width of [390, 834, 1280]) {
      const { page, site, problems } = await open('dev', width);
      try {
        await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ protocolVersion: 1, sessionId: SESSION, type: 'inspect', payload: { requestId: 'r' } })}, '*')`);
        await page.waitForFunction(`window.sent.some((m) => m?.type === 'inspectResult')`, undefined, { timeout: 30_000 });
        const report = (await page.evaluate(`window.sent.find((m) => m?.type === 'inspectResult').payload.report`)) as { viewportWidth: number; checks: { overlaps: { checked: number; failed: number; incomplete?: boolean } }; issues: Array<{ kind: string }> };
        expect(report.viewportWidth).toBe(width);
        expect(report.checks.overlaps.checked).toBeGreaterThan(0);
        expect(report.checks.overlaps.incomplete).toBeFalsy();
        expect([width, report.checks.overlaps.failed, report.issues.filter((i) => i.kind === 'overlap')]).toEqual([width, 0, []]);
        // In Edit, the editor's variant shows the first step, as a placement starts.
        expect((await steps(site))[0].shown).toEqual(['We walk the site wit']);
        expect(problems).toEqual([]);
      } finally {
        await page.close();
      }
    }
  }, 120_000);
});
