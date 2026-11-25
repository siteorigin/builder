import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundle, removeRendered, serverHtml } from './generated-site';
import { existsSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { chromium, type Browser, type Page } from 'playwright';
import type { ElementRef, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { listThemes } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { STYLES_DIR, generateProject, pageFile } from '@generator/index';
import { STICKY_BELOW_HEADER } from '@shared/styles';
import { layerSlots } from '../../src/renderer/src/lib/layer-drop';
import { shownSlots } from '../../src/renderer/src/lib/slot-target';
import { insertAt, insertOps } from '../../src/renderer/src/lib/insert-at';

/**
 * Foundation's Split layout (#669): two named slots side by side, whose proportions, tone and pinned Secondary column
 * each placement chooses, stacked into one column on phones, and exported as plain Svelte and CSS.
 */

function placed(themeId = 'foundation') {
  let state: ProjectState = createStarterState('blank', 'Split', false, themeId);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const run = (ops: EditOperation[]) => {
    const out = applyOperations(state, ops);
    state = out.state;
    return out.results;
  };
  const [{ nodeId, definitionId }] = run([{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.split' }]);
  return {
    owner,
    id: nodeId as string,
    definitionId: (definitionId as string | undefined) ?? (state.pages[state.site.homePageId].nodes[nodeId as string] as InstanceNode).definitionId,
    run,
    state: () => state,
    node: () => state.pages[state.site.homePageId].nodes[nodeId as string] as InstanceNode
  };
}

/** Fill both slots: a heading and a Statistics section in Primary, a paragraph and a button in Secondary. */
function fill(p: ReturnType<typeof placed>) {
  const into = (slot: string, spec: Partial<Extract<EditOperation, { type: 'node.insert' }>>) =>
    p.run([{ type: 'node.insert', owner: p.owner, parentId: p.id, slot, ...spec } as EditOperation])[0].nodeId as string;
  // Secondary first: what goes there must not depend on Primary holding anything.
  const note = into('secondary', { primitive: 'paragraph', text: 'Get the monthly newsletter' });
  const heading = into('primary', { primitive: 'heading', text: 'This season in the garden' });
  const stats = into('primary', { componentId: 'stats.row' });
  const button = into('secondary', { primitive: 'button', text: 'Sign up' });
  const callout = into('secondary', { componentId: 'cta.banner' });
  return { primary: [heading, stats], secondary: [note, button, callout] };
}

/** The stylesheet's rules for the placed definitions (the theme's own base CSS is separate), spaces run together. */
function componentCss(state: ProjectState): string {
  return [...generateProject(state)]
    .filter(([path]) => path.startsWith(STYLES_DIR) && !/(theme|tokens)\.css$/.test(path))
    .map(([, src]) => src)
    .join('\n')
    .replace(/\s+/g, ' ');
}

/** The exported Home page, and the Split's own Svelte file. */
function exported(state: ProjectState) {
  const files = generateProject(state);
  const page = files.get(pageFile(state.pages[state.site.homePageId]))!;
  const split = [...files].find(([path]) => path.endsWith('-layout-split.svelte'))![1];
  return { files, page, split };
}

/** What a column of the exported static page holds, Svelte's hydration comments left out. */
const columnHtml = (html: string, which: 'primary' | 'secondary') =>
  html.replace(/<!--.*?-->/g, '').match(new RegExp(`<div class="[^"]*__split-${which}[^"]*">([\\s\\S]*?)</div>`))?.[1];

afterAll(removeRendered);

describe('Split layout (#669)', () => {
  it('ships in every theme with two named slots and its three choices', () => {
    for (const theme of listThemes()) {
      const def = theme.components.find((c) => c.componentId === 'layout.split')!;
      expect(def, theme.id).toBeDefined();
      expect([def.name, def.kind, def.category]).toEqual(['Split layout', 'managed', 'layout']);
      expect(Object.entries(def.slots!).map(([id, s]) => [id, s.label])).toEqual([['primary', 'Primary'], ['secondary', 'Secondary']]);
      expect(Object.fromEntries(Object.entries(def.variantAxes!).map(([axis, a]) => [axis, Object.values(a.options).map((o) => o.label)]))).toEqual({
        ratio: ['Equal (1:1)', 'Wide left (2:1)', 'Wide right (1:2)'],
        tone: ['Default', 'Soft background', 'Dark'],
        sticky: ['Scrolls with the page', 'Stays in view (sticky)']
      });
    }
  });

  it('lists both slots in Layers while empty, and takes basic elements and components into each', () => {
    const p = placed();
    expect(shownSlots(p.state(), p.definitionId)).toEqual(['primary', 'secondary']);
    expect(layerSlots(p.state(), p.node()).map((s) => [s.slot, s.label, s.ids, s.shown])).toEqual([
      ['primary', 'Primary', [], true],
      ['secondary', 'Secondary', [], true]
    ]);
    const content = fill(p);
    expect(p.node().slots).toEqual(content);
    const placedIn = (slot: string) => p.node().slots![slot].map((id) => p.state().pages[p.state().site.homePageId].nodes[id]).map((n) => (n.kind === 'instance' ? n.definitionId : n.kind === 'text' ? `${n.tag} ${String(n.text)}` : n.kind));
    expect(placedIn('primary')).toEqual(['h2 This season in the garden', 'foundation.stats.row']);
    expect(placedIn('secondary')).toEqual(['p Get the monthly newsletter', 'link', 'foundation.cta.banner']);
    expect(validateState(p.state()).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('takes an element inserted with a slot picked into that slot', () => {
    const p = placed();
    const selected: ElementRef = { owner: p.owner, instancePath: [], nodeId: p.id, slot: 'secondary' } as ElementRef;
    const at = insertAt(p.state(), p.owner, 'element', selected)!;
    p.run(insertOps(at, { primitive: 'paragraph', text: 'Aside' }, 'element'));
    expect(p.node().slots?.secondary?.map((id) => p.state().pages[p.state().site.homePageId].nodes[id])).toMatchObject([{ kind: 'text', tag: 'p', text: 'Aside' }]);
    expect(p.node().slots?.primary ?? []).toEqual([]);
  });

  it('keeps one column on phones and sets each ratio from tablet up, keeping the slot content', () => {
    const p = placed();
    const content = fill(p);
    for (const [ratio, a, b] of [['equal', '1fr', '1fr'], ['wide-left', '2fr', '1fr'], ['wide-right', '1fr', '2fr'], ['equal', '1fr', '1fr']]) {
      p.run([{ type: 'instance.setVariant', owner: p.owner, nodeId: p.id, axis: 'ratio', variant: ratio }]);
      expect(p.node().slots).toEqual(content);
      expect(p.node().variants?.ratio ?? 'equal').toBe(ratio);
      const css = componentCss(p.state());
      expect(css).toMatch(new RegExp(`\\.so-foundation-layout-split__inner \\{[^}]*grid-template-columns: repeat\\(1, minmax\\(0, 1fr\\)\\)`));
      const rule = ratio === 'equal' ? '\\.so-foundation-layout-split__inner' : `\\.so-foundation-layout-split--ratio-${ratio}\\.so-foundation-layout-split__inner`;
      expect(css, ratio).toMatch(new RegExp(`@media \\(min-width: 768px\\) \\{[^@]*${rule} \\{[^}]*grid-template-columns: minmax\\(0, ${a}\\) minmax\\(0, ${b}\\)`));
      // The default needs no prop on the placement; the other ratios are passed to it.
      if (ratio !== 'equal') expect(exported(p.state()).page).toContain(`variant_ratio="${ratio}"`);
    }
  });

  it('pins Secondary below the site header from tablet up only when chosen', () => {
    const p = placed();
    const pinned = /\.so-foundation-layout-split--sticky-pin-secondary\.so-foundation-layout-split__split-secondary \{ align-self: start; inset: [^;]+; position: sticky;/g;
    p.run([{ type: 'instance.setVariant', owner: p.owner, nodeId: p.id, axis: 'sticky', variant: 'pin-secondary' }]);
    const css = componentCss(p.state());
    // One rule for tablets and one for desktops, each also clearing the header; none for phones or all sizes.
    expect(css.match(pinned)).toHaveLength(2);
    expect(css).toContain(`inset: ${STICKY_BELOW_HEADER.inset};`);
    expect(css.slice(0, css.indexOf('@media'))).not.toContain('sticky');
    expect(exported(p.state()).page).toContain('variant_sticky="pin-secondary"');
  });

  it('exports both columns as plain elements with no Builder runtime, and marks empty slots only in the editor', async () => {
    for (const themeId of ['foundation', 'editorial', 'signal']) {
      const p = placed(themeId);
      const dev = [...generateProject(p.state(), { instrument: true }).values()].join('\n');
      expect(dev.match(/data-so-slot-empty=\{"(primary|secondary)"\}/g), themeId).toHaveLength(2);

      const empty = exported(p.state());
      expect(empty.split).toMatch(/<section[\s\S]*__split-primary[\s\S]*\{@render slot_primary\?\.\(\)\}[\s\S]*__split-secondary[\s\S]*\{@render slot_secondary\?\.\(\)\}/);
      // The static page's empty columns hold nothing but comments, so `:empty` finds them.
      const bare = await serverHtml(empty.files, 'split-layout-');
      expect([columnHtml(bare, 'primary'), columnHtml(bare, 'secondary')], themeId).toEqual(['', '']);

      fill(p);
      const out = exported(p.state());
      const html = await serverHtml(out.files, 'split-layout-');
      const snippet = (slot: string) => out.page.match(new RegExp(`\\{#snippet slot_${slot}\\(\\)\\}([\\s\\S]*?)\\{/snippet\\}`))?.[1];
      expect(snippet('secondary')).toContain('Get the monthly newsletter');
      expect(snippet('secondary')).not.toContain('This season in the garden');
      expect(html.indexOf('This season in the garden')).toBeGreaterThan(html.indexOf('__split-primary'));
      expect(html.indexOf('This season in the garden')).toBeLessThan(html.indexOf('__split-secondary'));
      expect(html.indexOf('Get the monthly newsletter')).toBeGreaterThan(html.indexOf('__split-secondary'));
      for (const [path, src] of out.files) {
        if (!path.startsWith('src/')) continue;
        expect(src, path).not.toMatch(/data-so-(slot|editor|node|ctx)|so-slot-empty|siteorigin\/bridge|bridge\.client|\.siteorigin\/|so_editing/);
        if (path.endsWith('.svelte')) expect(() => compile(src, { filename: path, generate: 'client', runes: true }), path).not.toThrow();
      }
    }
  });
});

/**
 * The exported page in a real browser, server-rendered and then hydrated, with the theme's stylesheet: what the CSS
 * does, which its text cannot show.
 */
describe.skipIf(!existsSync(chromium.executablePath()))('Split layout in a browser (#669)', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function open(state: ProjectState): Promise<Page> {
    const files = generateProject(state);
    const ssr = await serverHtml(files, 'split-layout-browser-');
    const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
    const script = await bundle(files, generateProject(state, { instrument: true }));
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div id="app">${ssr}</div></body></html>`);
    await page.addScriptTag({ content: script, type: 'module' });
    await page.waitForFunction("'startSite' in window");
    await page.evaluate("window.startSite('clean')");
    return page;
  }

  /** Both columns as the browser lays them out, and the section's own colors. */
  const MEASURE = `(() => {
    const el = (suffix) => document.querySelector('#app [class*="-layout-split__' + suffix + '"]');
    const column = (which) => {
      const node = el('split-' + which);
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return { shown: style.display !== 'none', position: style.position, x: box.x, y: box.y, width: box.width, bottom: box.bottom };
    };
    return { primary: column('primary'), secondary: column('secondary'), inner: el('inner').getBoundingClientRect().width, ground: getComputedStyle(el('root')).backgroundColor };
  })()`;
  type Column = { shown: boolean; position: string; x: number; y: number; width: number; bottom: number };
  const measure = (page: Page) => page.evaluate<{ primary: Column; secondary: Column; inner: number; ground: string }>(MEASURE);
  const at = async (page: Page, width: number) => {
    await page.setViewportSize({ width, height: 800 });
    return measure(page);
  };

  it.each(['foundation', 'editorial', 'signal'])('stacks on phones and keeps each ratio from tablet up in %s', async (themeId) => {
    for (const [ratio, expected] of [['equal', 1], ['wide-left', 2], ['wide-right', 0.5]] as const) {
      const p = placed(themeId);
      fill(p);
      p.run([{ type: 'instance.setVariant', owner: p.owner, nodeId: p.id, axis: 'ratio', variant: ratio }]);
      const page = await open(p.state());
      const phone = await at(page, 390);
      expect(phone.secondary.y, ratio).toBeGreaterThan(phone.primary.bottom);
      for (const c of [phone.primary, phone.secondary]) expect(Math.abs(c.width - phone.inner), ratio).toBeLessThan(1);
      for (const width of [834, 1280]) {
        const wide = await at(page, width);
        expect(wide.secondary.x, `${ratio} at ${width}`).toBeGreaterThan(wide.primary.x + wide.primary.width);
        expect(wide.primary.width / wide.secondary.width, `${ratio} at ${width}`).toBeCloseTo(expected, 1);
      }
      await page.close();
    }
  }, 120_000);

  it.each(['primary', 'secondary'] as const)('drops an empty column on phones only, when %s is the one filled', async (filled) => {
    const p = placed();
    p.run([{ type: 'node.insert', owner: p.owner, parentId: p.id, slot: filled, primitive: 'paragraph', text: 'Only this' } as EditOperation]);
    const empty = filled === 'primary' ? 'secondary' : 'primary';
    const page = await open(p.state());
    const phone = await at(page, 390);
    expect([phone[filled].shown, phone[empty].shown]).toEqual([true, false]);
    for (const width of [834, 1280]) {
      const wide = await at(page, width);
      expect([wide.primary.shown, wide.secondary.shown]).toEqual([true, true]);
      expect(wide.secondary.x).toBeGreaterThan(wide.primary.x + wide.primary.width);
    }
    await page.close();
  }, 60_000);

  it('pins Secondary only when chosen, from tablet up, and prints it in its place', async () => {
    const p = placed();
    fill(p);
    for (const [sticky, wide] of [['flow', 'static'], ['pin-secondary', 'sticky']] as const) {
      p.run([{ type: 'instance.setVariant', owner: p.owner, nodeId: p.id, axis: 'sticky', variant: sticky }]);
      const page = await open(p.state());
      const positions = [];
      for (const width of [390, 834, 1280]) positions.push((await at(page, width)).secondary.position);
      expect(positions, sticky).toEqual(['static', wide, wide]);
      await page.emulateMedia({ media: 'print' });
      expect((await at(page, 834)).secondary.position, `${sticky} in print`).toBe('static');
      await page.close();
    }
  }, 60_000);

  it('paints each tone its own ground', async () => {
    const p = placed();
    const grounds = [];
    for (const tone of ['default', 'muted', 'inverse']) {
      p.run([{ type: 'instance.setVariant', owner: p.owner, nodeId: p.id, axis: 'tone', variant: tone }]);
      const page = await open(p.state());
      grounds.push((await measure(page)).ground);
      await page.close();
    }
    expect(new Set(grounds).size).toBe(3);
  }, 60_000);
});
