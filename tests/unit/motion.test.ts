/**
 * Typed transforms and transitions in real headless browsers: the theme, component and site stylesheets exactly as
 * an exported site ships them, applied to a small hand-built page whose elements carry the classes those rules
 * target (a definition's node class, a placement's override class). Checks what the browser computes, so each shift
 * axis, preset and timing composes across sizes and layers as the editor says, no element takes an axis from its
 * parent, and transitions stop for visitors who ask for reduced motion, with or without the theme's own rule.
 */
import { existsSync } from 'node:fs';
import { chromium, webkit, type Browser, type BrowserType } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { P, item, prop } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { STYLES_DIR, generateProject } from '@generator/index';
import { projectDesign } from './fixtures/packs';

const ENGINES = ([['chromium', chromium], ['webkit', webkit]] as Array<[string, BrowserType]>).filter(([, engine]) => existsSync(engine.executablePath()));

const instanceOf = (s: ProjectState, componentId: string) =>
  Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === componentId) as InstanceNode;

/**
 * A hero placement shifted 80px sideways and 10px down holds the cases. A card grid of the project's own (a managed
 * design, whose elements carry design styles) shifts its grid 12px sideways and animates colors over 600ms linear;
 * its placement lifts the grid 4px on phones and animates the shadow there instead. The placement's cards are lifted
 * 6px, and its heading picks a preset and shifts 3px sideways on phones only.
 */
function site() {
  const s = createStarterState('business', 'Motion Studio', false);
  const hero = instanceOf(s, 'hero.split');
  hero.overrides = { root: { base: { translateX: '80px', translateY: '10px' } } };
  const def = projectDesign(s, {
    componentId: 'motion.grid',
    name: 'Card grid',
    properties: { heading: P.str('Heading', 'Services'), items: P.list('Cards', 'Card', { title: P.str('Title', 'Service') }, [{ title: 'Planning' }]) },
    parts: {
      root: { nodeId: 'root', label: 'Section', styleControls: ['background'] },
      heading: { nodeId: 'heading', label: 'Heading', styleControls: ['color'] },
      grid: { nodeId: 'grid', label: 'Card grid', styleControls: ['gap'] },
      card: { nodeId: 'card', label: 'Card', styleControls: ['background'] }
    },
    build: (b) =>
      b.el('root', 'section', {}, [
        b.text('heading', 'h2', prop('heading')),
        b.el('grid', 'ul', { styles: { base: { translateX: '12px', transition: 'colors', transitionDuration: 600, transitionEasing: 'linear' } } }, [
          b.repeat('cards', 'items', [b.el('card', 'li', {}, [b.text('card-title', 'h3', item('title'))])])
        ])
      ])
  });
  const grid = makeInstance(def);
  const home = s.pages[s.site.homePageId];
  home.nodes[grid.id] = grid;
  home.rootIds.splice(1, 0, grid.id);
  grid.overrides = { grid: { phone: { translateY: '-4px', transition: 'shadow' } }, card: { base: { translateY: '6px' } }, heading: { base: { transition: 'opacity' }, phone: { translateX: '3px' } } };
  const files = generateProject(s);
  const sheets = (names: string[]) => names.map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  const css = sheets(['tokens', 'theme', 'components', 'site']);
  // The same site under a theme without a reduced-motion rule of its own.
  const themeless = sheets(['tokens', 'components', 'site']);
  const o = (part: string) => `so-o-${grid.id}-${part}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const heroClass = `so-o-${hero.id}-root`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const body = `<div id="parent" class="${heroClass}">
    <div id="placed" class="so-foundation-motion-grid__grid ${o('grid')}"></div>
    <div id="design" class="so-foundation-motion-grid__grid"></div>
    <div id="lifted" class="so-foundation-motion-grid__card ${o('card')}"></div>
    <div id="faded" class="${o('heading')}"></div>
    <div id="plain"></div>
  </div>`;
  return { css, themeless, body };
}

if (!ENGINES.length) describe.skip('typed motion in a browser (needs Chromium or WebKit)', () => it('runs in a browser', () => {}));

describe.each(ENGINES)('typed motion in %s', (_name, engine) => {
  let browser: Browser;
  const { css, themeless, body } = site();

  beforeAll(async () => {
    browser = await engine.launch({ headless: true, executablePath: engine.executablePath(), timeout: 30_000 });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  type Computed = { translate: string; property: string; duration: number; easing: string };
  /** Each element's computed shift and transition, by id; durations in milliseconds. */
  const READ = `(() => {
    const out = {};
    for (const el of document.querySelectorAll('[id]')) {
      const cs = getComputedStyle(el);
      out[el.id] = { translate: cs.translate, property: cs.transitionProperty, duration: parseFloat(cs.transitionDuration) * 1000, easing: cs.transitionTimingFunction };
    }
    return out;
  })()`;
  async function computed(width: number, reducedMotion: 'reduce' | 'no-preference' = 'no-preference', sheet = css): Promise<Record<string, Computed>> {
    const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion });
    try {
      const page = await context.newPage();
      await page.setContent(`<!doctype html><html><head><style>${sheet}</style></head><body>${body}</body></html>`);
      return await page.evaluate<Record<string, Computed>>(READ);
    } finally {
      await context.close();
    }
  }
  /** Both axes in px, from a computed translate ("none", "12px" or "12px -4px"). */
  const axes = (t: string) => {
    const [x = '0px', y = '0px'] = t === 'none' ? [] : t.split(' ');
    return [parseFloat(x), parseFloat(y)];
  };

  it('keeps the design’s sideways shift and timing under a placement that lifts on phones', async () => {
    const phone = await computed(390);
    expect(axes(phone.placed.translate)).toEqual([12, -4]);
    expect(phone.placed.property).toBe('box-shadow');
    expect(phone.placed.duration).toBeCloseTo(600);
    expect(phone.placed.easing).toBe('linear');
    const desktop = await computed(1280);
    expect(axes(desktop.placed.translate)).toEqual([12, 0]);
    expect(desktop.placed.property).toBe('color, background-color, border-color, text-decoration-color, fill, stroke');
    expect(desktop.placed.duration).toBeCloseTo(600);
    expect(desktop.placed.easing).toBe('linear');
    expect(axes(desktop.design.translate)).toEqual([12, 0]);
    expect(desktop.design.easing).toBe('linear');
  });

  it('never takes an axis from the parent', async () => {
    const desktop = await computed(1280);
    expect(axes(desktop.parent.translate)).toEqual([80, 10]);
    // Each sets one axis of its own: the other is its own 0, not the hero's 80px or 10px.
    expect(axes(desktop.lifted.translate)).toEqual([0, 6]);
    expect(axes(desktop.design.translate)).toEqual([12, 0]);
    // An element that sets neither has no shift at all, inherited variables or not.
    expect(desktop.plain.translate).toBe('none');
    expect(desktop.faded.translate).toBe('none');
    // An axis set for phones only starts from its own zero there too.
    expect(axes((await computed(390)).faded.translate)).toEqual([3, 0]);
  });

  it('gives a preset on its own a working duration', async () => {
    const desktop = await computed(1280);
    expect(desktop.faded.property).toBe('opacity');
    expect(desktop.faded.duration).toBeCloseTo(200);
    expect(desktop.lifted.duration).toBe(0);
    expect(desktop.plain.duration).toBe(0);
  });

  it('turns transitions off for visitors who ask for reduced motion, at every size, with or without the theme', async () => {
    for (const [width, sheet] of [[1280, css], [390, css], [1280, themeless], [390, themeless]] as const) {
      const reduced = await computed(width, 'reduce', sheet);
      const label = `${width}px${sheet === themeless ? ' without the theme' : ''}`;
      // 0.01ms beats the design's 600ms and the preset's own 200ms; the shift itself stays.
      for (const id of ['placed', 'design', 'faded']) {
        expect(reduced[id].duration, `${label}: ${id}`).toBeGreaterThan(0);
        expect(reduced[id].duration, `${label}: ${id}`).toBeLessThan(0.1);
      }
      expect(axes(reduced.placed.translate), label).toEqual(width === 390 ? [12, -4] : [12, 0]);
    }
    // Without the request, the same sheet keeps its timing.
    expect((await computed(1280, 'no-preference', themeless)).placed.duration).toBeCloseTo(600);
  });
});
