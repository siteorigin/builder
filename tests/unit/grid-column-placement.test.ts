/**
 * A grid item's Column start beside its Column span (#1136). The two are set by different rules (sizes, looks, a
 * placement's changes), so where the browser puts the item is the browser's to decide: these run where Playwright's
 * Chromium is installed, on the stylesheets the generator writes.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceNode, ProjectState, ResponsiveStyles } from '@shared/types';
import { VIEWPORT_PRESETS, flattenStyles, validateStyleValue, wideOnlyStyle, type StyleLayer } from '@shared/styles';
import { createStarterState } from '@catalogue/starters';
import { generateComponentsCss, generateSiteCss, nodeClass, overrideClass, variantClass } from '@generator/index';
import { styleUnder } from '../../src/renderer/src/lib/style-source';

const SIZES = ['phone', 'tablet', 'desktop'] as const;

describe('a grid column start', () => {
  it('takes Auto or a line from 1 to 12', () => {
    for (const v of ['auto', '1', '12', 7]) expect(validateStyleValue('columnStart', v), String(v)).toBeNull();
    for (const v of ['0', '13', '-1', 'full', '2 / 5', 'span 2', 1.5]) expect(validateStyleValue('columnStart', v), String(v)).not.toBeNull();
  });

  it('keeps every line set for all sizes off phones, and lets Auto apply everywhere', () => {
    for (const v of ['1', '3', 12]) expect(wideOnlyStyle('columnStart', v), String(v)).toBe(true);
    expect(wideOnlyStyle('columnStart', 'auto')).toBe(false);
  });

  it('shows no inherited line on a phone where the design sets one for all sizes only', () => {
    const inherited: ResponsiveStyles = { base: { columnStart: '3' } };
    const under = (scope: 'phone' | 'desktop') => styleUnder({ prop: 'columnStart', scope, styles: undefined, inherited, designSizesWin: true }).value;
    expect([under('phone'), under('desktop')]).toEqual([undefined, '3']);
  });
});

const installed = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!installed)('where the browser puts a grid item', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  /** The computed `start | end` of `#item` at each size, for markup under a stylesheet. */
  async function placed(css: string, body: string): Promise<string[]> {
    const page = await browser.newPage();
    try {
      await page.setContent(`<style>${css}</style>${body}`);
      const out: string[] = [];
      for (const size of SIZES) {
        await page.setViewportSize({ width: VIEWPORT_PRESETS[size], height: 800 });
        out.push(await page.evaluate<string>(`(({ gridColumnStart, gridColumnEnd }) => gridColumnStart + ' | ' + gridColumnEnd)(getComputedStyle(document.querySelector('#item')))`));
      }
      return out;
    } finally {
      await page.close();
    }
  }

  /** A page's own element holding the item, so both are styled as the site's stylesheet writes page content. */
  function pageCss(item: ResponsiveStyles, outer: ResponsiveStyles = {}) {
    const state: ProjectState = createStarterState('blank', 'Blank', false);
    const home = state.pages[state.site.homePageId];
    home.nodes.n_outer = { id: 'n_outer', kind: 'element', tag: 'div', children: ['n_item'], styles: outer };
    home.nodes.n_item = { id: 'n_item', kind: 'element', tag: 'div', children: [], styles: item };
    home.rootIds.push('n_outer');
    return generateSiteCss(state);
  }
  const NESTED = '<div style="display:grid"><div class="so-n-n_outer" style="display:grid"><div id="item" class="so-n-n_item"></div></div></div>';

  it('composes a start with a span, on tablets and up, and leaves phones to place it', async () => {
    expect(await placed(pageCss({ base: { columnStart: '3', columnSpan: '2' } }), NESTED)).toEqual(['auto | auto', '3 | span 2', '3 | span 2']);
  });

  it('keeps a start for all sizes when one size changes the span, and a span when one size changes the start', async () => {
    expect(await placed(pageCss({ base: { columnStart: '3' }, desktop: { columnSpan: '4' } }), NESTED)).toEqual(['auto | auto', '3 | auto', '3 | span 4']);
    expect(await placed(pageCss({ base: { columnSpan: '2' }, desktop: { columnStart: '5' }, phone: { columnStart: '1' } }), NESTED)).toEqual(['1 | auto', 'auto | span 2', '5 | span 2']);
  });

  it('lets Auto and a phone value reset what a weaker rule set', async () => {
    const css = pageCss({ base: { columnStart: '3', columnSpan: 'full' }, phone: { columnStart: '2', columnSpan: '1' }, tablet: { columnSpan: '2', columnStart: 'auto' } });
    expect(await placed(css, NESTED)).toEqual(['2 | span 1', 'auto | span 2', '1 | -1']);
  });

  it('never takes the line or Full width of a grid item around it', async () => {
    const css = pageCss({ base: { columnSpan: '2' } }, { base: { columnStart: '6', columnSpan: 'full' } });
    expect((await placed(css, NESTED)).slice(1)).toEqual(['auto | span 2', 'auto | span 2']);
    const outer = pageCss({ base: { columnSpan: '2' } }, { base: { columnStart: '6', columnSpan: '2' } });
    expect((await placed(outer, NESTED)).slice(1)).toEqual(['auto | span 2', 'auto | span 2']);
    // A start alone writes no span to clear the outer item's Full width with.
    const started = pageCss({ base: { columnStart: '2' } }, { base: { columnSpan: 'full' } });
    expect((await placed(started, NESTED)).slice(1)).toEqual(['2 | auto', '2 | auto']);
  });

  it('composes the same inside a managed component: its design, a look and a placement’s change', async () => {
    const state: ProjectState = createStarterState('business', 'Test Studio', false);
    const def = Object.values(state.components).find((d) => d.componentId === 'features.grid')!;
    const [partId, part] = Object.entries(def.parts).find(([id]) => id !== 'root')!;
    const nodeId = part.nodeId;
    def.tree!.nodes[nodeId].styles = { base: { columnStart: '3' } };
    def.variantAxes = { layout: { label: 'Layout', default: 'wide', options: { wide: { label: 'Wide', styles: { [nodeId]: { base: { columnSpan: 'full' } } } } } } };
    const place = Object.values(state.pages[state.site.homePageId].nodes).find((n) => n.kind === 'instance' && n.definitionId === def.id) as InstanceNode;
    place.variants = undefined;
    const render = (overrides: InstanceNode['overrides']) => {
      place.overrides = overrides;
      const classes = [nodeClass(def, nodeId), variantClass(def, 'layout', 'wide'), overrideClass(place.id, partId)].join(' ');
      return placed(`${generateComponentsCss(state)}\n${generateSiteCss(state)}`, `<div style="display:grid"><div id="item" class="${classes}"></div></div>`);
    };
    // The look's Full width covers the design's line; the placement's own span brings the line back.
    expect((await render(undefined)).slice(1)).toEqual(['1 | -1', '1 | -1']);
    expect((await render({ [partId]: { base: { columnSpan: '2' } } })).slice(1)).toEqual(['3 | span 2', '3 | span 2']);
    expect((await render({ [partId]: { base: { columnSpan: '2' }, tablet: { columnStart: 'auto' } } })).slice(1)).toEqual(['auto | span 2', '3 | span 2']);
  });

  /** Layers as one detached element renders them: the folded styles, written as a page element's own. */
  const folded = (layers: StyleLayer[]) => placed(pageCss(flattenStyles(layers)), NESTED);

  it('keeps a start and a span from different layers when they are folded into one element (detach)', async () => {
    const layers: StyleLayer[] = [
      { styles: { base: { columnStart: '3' } }, strength: 1 },
      { styles: { base: { columnSpan: 'full' } }, strength: 2 },
      { styles: { desktop: { columnSpan: '2' } }, strength: 3, wideColumns: true }
    ];
    expect(await folded(layers)).toEqual(['1 | -1', '1 | -1', '3 | span 2']);
  });

  it('keeps the end a weaker custom grid-column set under a stronger start when folding', async () => {
    const layers: StyleLayer[] = [
      { styles: { base: { customCss: 'grid-column: 2 / 5' } }, strength: 1 },
      { styles: { base: { columnStart: '3' } }, strength: 2 }
    ];
    // On phones the line for all sizes does not apply, so the custom CSS places it alone.
    expect(await folded(layers)).toEqual(['2 | 5', '3 | 5', '3 | 5']);
  });

  const custom: StyleLayer = { styles: { base: { customCss: 'grid-column: 2 / 5' } }, strength: 1 };

  it('keeps Full width on line 1 when folding it with a start over a weaker custom grid-column', async () => {
    const layers: StyleLayer[] = [custom, { styles: { desktop: { columnStart: '3' } }, strength: 2 }, { styles: { desktop: { columnSpan: 'full' } }, strength: 3 }];
    expect(await folded(layers)).toEqual(['2 | 5', '2 | 5', '1 | -1']);
    // A Full width under the custom CSS still claims line 1 from the start above it.
    const under: StyleLayer[] = [{ styles: { base: { columnSpan: 'full' } }, strength: 1 }, { ...custom, strength: 2 }, { styles: { desktop: { columnStart: '3' } }, strength: 3 }];
    expect(await folded(under)).toEqual(['2 | 5', '2 | 5', '1 | 5']);
  });

  it('keeps a weaker start under a stronger span written again over a custom grid-column', async () => {
    const layers: StyleLayer[] = [{ styles: { desktop: { columnStart: '3' } }, strength: 1 }, { ...custom, strength: 2 }, { styles: { desktop: { columnSpan: '2' } }, strength: 3 }];
    expect(await folded(layers)).toEqual(['2 | 5', '2 | 5', '3 | span 2']);
  });

  it('leaves a start beneath the fold where it is, under a weaker span of the result', () => {
    const layers: StyleLayer[] = [{ styles: { desktop: { columnStart: '3' } }, strength: 2 }, { styles: { desktop: { columnSpan: '2' } }, strength: 1 }];
    expect(flattenStyles(layers, { beneath: 1 })).toEqual({ desktop: { columnSpan: '2' } });
  });
});
