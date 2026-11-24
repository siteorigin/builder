/**
 * A Button placed straight into a Section or a Stack (#566). Both are column flex containers whose children stretch
 * across the row, so a button with no Width of its own filled the whole container. The Foundation theme now sizes a
 * button to its label and padding, and anything the page says about its width, or its parent says about where it sits,
 * still applies. The layout is the browser's to decide, so those cases run where Playwright's Chromium is installed.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { FOUNDATION_BASE_CSS } from '@catalogue/foundation/base.css';
import { applyOperations } from '@engine/apply';
import { STYLES_DIR, generateProject } from '@generator/index';

const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

/** A blank page with a Section that holds a Button, and a Stack that holds another. */
function page() {
  const base = createStarterState('blank', 'Blank', false);
  const o = owner(base);
  const run = (state: ProjectState, operations: Parameters<typeof applyOperations>[1]) => {
    const r = applyOperations(state, operations);
    return { state: r.state, id: r.results[0]?.nodeId as string };
  };
  let r = run(base, [{ type: 'node.insert', owner: o, parentId: null, componentId: 'layout.section' }]);
  const section = r.id;
  r = run(r.state, [{ type: 'node.insert', owner: o, parentId: section, slot: 'content', primitive: 'button', text: 'Go' }]);
  const direct = r.id;
  r = run(r.state, [{ type: 'node.insert', owner: o, parentId: section, slot: 'content', primitive: 'stack' }]);
  const stack = r.id;
  r = run(r.state, [{ type: 'node.insert', owner: o, parentId: stack, primitive: 'button', text: 'Go' }]);
  return { state: r.state, owner: o, section, direct, stack, inStack: r.id };
}

type Built = ReturnType<typeof page>;
const style = (b: Built, nodeId: string, property: string, value: unknown, scope = 'base') =>
  ({ type: 'node.setStyle', owner: b.owner, nodeId, scope, property, value }) as Parameters<typeof applyOperations>[1][number];

/** The stylesheets a site loads, in the order its layout imports them. */
function sheets(s: ProjectState) {
  const files = generateProject(s);
  const css = (name: string) => files.get(`${STYLES_DIR}/${name}.css`)!;
  return { theme: css('theme'), site: css('site'), all: ['tokens', 'theme', 'components', 'site'].map(css).join('\n') };
}
const nodeClass = (id: string) => `so-n-${id}`;
/** The declarations of a node's own rules, at every size. */
const ownRules = (site: string, id: string) => [...site.matchAll(new RegExp(`\\.${nodeClass(id)}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join('\n');

describe('the default width of a button', () => {
  it('is set by the theme at no specificity, so any width a page sets wins at every size', () => {
    const { theme } = sheets(page().state);
    expect(theme).toContain(':where(.so-btn:not(.so-header__cta)) { width: fit-content; }');
    // The base styles have the same rule, ahead of the button's own variants and states.
    expect(FOUNDATION_BASE_CSS).toContain(':where(.so-btn:not(.so-header__cta)) { width: fit-content; }');
  });

  it('leaves a freshly inserted button without a width of its own, and writes one only when it is set', () => {
    const b = page();
    const none = sheets(b.state).site;
    expect(ownRules(none, b.direct)).not.toContain('width');
    expect(ownRules(none, b.inStack)).not.toContain('width');
    const set = applyOperations(b.state, [style(b, b.direct, 'width', 'fill'), style(b, b.inStack, 'width', '240px', 'phone')]).state;
    expect(ownRules(sheets(set).site, b.direct)).toContain('width: 100%');
    expect(sheets(set).site).toMatch(new RegExp(`@media[^{]*\\{[^}]*\\.${nodeClass(b.inStack)} \\{[^}]*width: 240px`));
  });
});

const BROWSER = existsSync(chromium.executablePath());
let browser: Browser | undefined;
beforeAll(async () => {
  if (BROWSER) browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

describe.runIf(BROWSER)('a button in a browser', () => {
  /** What the page generated for the Section looks like: the container is the column flex box its slot renders into. */
  const markup = (b: Built, buttons: string) =>
    `<section class="so-foundation-layout-section__root so-foundation-layout-section--tone-default"><div class="so-foundation-layout-section__inner" id="inner">${buttons}</div></section>`;
  const button = (id: string, label = 'Go') => `<a class="so-btn so-btn--primary ${nodeClass(id)}" href="#x" id="${id}">${label}</a>`;
  const withStack = (b: Built) =>
    markup(b, `${button(b.direct)}<div class="${nodeClass(b.stack)}" id="stack">${button(b.inStack)}</div>`);

  type Box = { width: number; left: number };
  /** Each element's width and its left edge relative to its container, in a page this wide. */
  async function measure(s: ProjectState, html: string, viewport: number, ids: string[]): Promise<Record<string, Box> & { inner: Box; stack: Box }> {
    const tab = await browser!.newPage({ viewport: { width: viewport, height: 800 } });
    try {
      await tab.setContent(`<!doctype html><html><head><style>${sheets(s).all}</style></head><body>${html}</body></html>`);
      return await tab.evaluate(
        ([names]) => {
          const box = (el: Element | null, within: Element | null): Box => {
            const r = el!.getBoundingClientRect();
            return { width: Math.round(r.width), left: Math.round(r.left - (within ? within.getBoundingClientRect().left : 0)) };
          };
          const inner = document.getElementById('inner');
          const out: Record<string, Box> = { inner: box(inner, null) };
          const stack = document.getElementById('stack');
          if (stack) out.stack = box(stack, inner);
          for (const id of names) out[id] = box(document.getElementById(id), document.getElementById(id)!.parentElement);
          return out;
        },
        [ids]
      ) as Record<string, Box> & { inner: Box; stack: Box };
    } finally {
      await tab.close();
    }
  }

  it('is as wide as its label inside a Section or a Stack, not the whole container', async () => {
    const b = page();
    const m = await measure(b.state, withStack(b), 1280, [b.direct, b.inStack]);
    expect(m.inner.width).toBeGreaterThan(900);
    for (const id of [b.direct, b.inStack]) {
      expect(m[id].width, `the button ${id}`).toBeGreaterThan(40);
      expect(m[id].width, `the button ${id}`).toBeLessThan(160);
      expect(m[id].left).toBe(0);
    }
  });

  it('is as wide as its label inside a grid, where it used to fill its cell', async () => {
    const b = page();
    const s = applyOperations(b.state, [style(b, b.stack, 'layout', 'grid')]).state;
    const m = await measure(s, withStack(b), 1280, [b.inStack]);
    expect(m[b.inStack].width).toBeLessThan(160);
  });

  it('keeps the width a page gives it: Fill, a length, and a width for one size only', async () => {
    const b = page();
    const s = applyOperations(b.state, [
      style(b, b.direct, 'width', 'fill'),
      style(b, b.inStack, 'width', '240px')
    ]).state;
    const wide = await measure(s, withStack(b), 1280, [b.direct, b.inStack]);
    expect(wide[b.direct].width).toBe(wide.inner.width);
    expect(wide[b.inStack].width).toBe(240);
    // Phone only: the theme's default applies at the other sizes.
    const phoneOnly = applyOperations(b.state, [style(b, b.direct, 'width', 'fill', 'phone')]).state;
    const onPhone = await measure(phoneOnly, withStack(b), 390, [b.direct]);
    expect(onPhone[b.direct].width).toBe(onPhone.inner.width);
    expect((await measure(phoneOnly, withStack(b), 1280, [b.direct]))[b.direct].width).toBeLessThan(160);
    // "Auto" hands the width back to the parent, which stretches it as before.
    const auto = applyOperations(b.state, [style(b, b.direct, 'width', 'auto')]).state;
    const m = await measure(auto, withStack(b), 1280, [b.direct]);
    expect(m[b.direct].width).toBe(m.inner.width);
  });

  it('still follows its parent’s alignment: centred or at the end', async () => {
    const b = page();
    for (const [align, where] of [['center', 'middle'], ['end', 'end'], ['start', 'start']] as const) {
      const s = applyOperations(b.state, [style(b, b.stack, 'align', align)]).state;
      const m = await measure(s, withStack(b), 1280, [b.inStack]);
      const { width, left } = m[b.inStack];
      expect(width, align).toBeLessThan(160);
      const free = m.stack.width - width;
      if (where === 'middle') expect(Math.abs(left - free / 2)).toBeLessThanOrEqual(1);
      if (where === 'end') expect(Math.abs(left - free)).toBeLessThanOrEqual(1);
      if (where === 'start') expect(left).toBe(0);
    }
  });

  it('keeps the header’s call to action stretched across a menu that stretches its items', async () => {
    const b = page();
    const menu = `<nav style="display:flex;flex-direction:column;align-items:stretch;width:320px" id="inner"><a class="so-btn so-btn--primary so-header__cta" id="cta" href="#x">Book a call</a></nav>`;
    const m = await measure(b.state, menu, 390, ['cta']);
    expect(m.cta.width).toBe(320);
  });
});
