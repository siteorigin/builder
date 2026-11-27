/**
 * A Button placed straight into a Section or a Stack (#566). Both are column flex containers whose children stretch
 * across the row, so a button with no Width of its own filled the whole container. The Foundation theme now sizes a
 * button to its label and padding, and anything the page says about its width, or its parent says about where it sits,
 * still applies. The layout is the browser's to decide, so those cases run where Playwright's Chromium is installed,
 * on the page the generator writes (server-rendered, with the stylesheets the site loads, in the order it loads them).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { MEDIA_QUERIES } from '@shared/styles';
import { createStarterState } from '@catalogue/starters';
import { getTheme } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { STYLES_DIR, generateProject } from '@generator/index';

type Op = Parameters<typeof applyOperations>[1][number];

const DIRECT = 'Section button';
const STACKED = 'Stack button';
const RULE = ':where(.so-btn:not(.so-header__cta)) { width: fit-content; }';

/** A blank page with a Section that holds a linked Button, and a Stack that holds another. */
function page() {
  const base = createStarterState('blank', 'Blank', false);
  const owner = { kind: 'page' as const, id: base.site.homePageId };
  const run = (state: ProjectState, operations: Op[]) => {
    const r = applyOperations(state, operations);
    return { state: r.state, id: r.results.at(-1)?.nodeId as string };
  };
  // A button with nowhere to go is left out of the site, so each one links to the page itself.
  const link = (nodeId: string): Op => ({ type: 'node.setContent', owner, nodeId, field: 'link', value: { type: 'page', target: owner.id } });
  let r = run(base, [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
  const section = r.id;
  r = run(r.state, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'button', text: DIRECT }]);
  const direct = r.id;
  r = run(r.state, [link(direct), { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'stack' }]);
  const stack = r.id;
  r = run(r.state, [{ type: 'node.insert', owner, parentId: stack, primitive: 'button', text: STACKED }]);
  const inStack = r.id;
  r = run(r.state, [link(inStack)]);
  return { state: r.state, owner, section, direct, stack, inStack };
}

type Built = ReturnType<typeof page>;
const style = (b: Built, nodeId: string, property: string, value: unknown, scope = 'base') =>
  ({ type: 'node.setStyle', owner: b.owner, nodeId, scope, property, value }) as Op;
const restyle = (b: Built, ...operations: Op[]) => applyOperations(b.state, operations).state;

/** The stylesheets a site loads, in the order its layout imports them. */
function sheets(s: ProjectState) {
  const files = generateProject(s);
  const css = (name: string) => files.get(`${STYLES_DIR}/${name}.css`)!;
  return { theme: css('theme'), site: css('site'), all: ['tokens', 'theme', 'components', 'site'].map(css).join('\n') };
}
const nodeClass = (id: string) => `so-n-${id}`;
/** The declarations of a node's own rules, at every size. */
const ownRules = (site: string, id: string) => [...site.matchAll(new RegExp(`\\.${nodeClass(id)}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join('\n');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('the default width of a button', () => {
  it('is set by the theme at no specificity, so any width a page sets wins at every size', () => {
    expect(sheets(page().state).theme).toContain(RULE);
    // The base styles have the same rule, ahead of the button's own variants and states.
    expect(getTheme('foundation').baseCss).toContain(RULE);
  });

  it('leaves a freshly inserted button without a width of its own, and writes one only when it is set', () => {
    const b = page();
    const none = sheets(b.state).site;
    expect(ownRules(none, b.direct)).not.toContain('width');
    expect(ownRules(none, b.inStack)).not.toContain('width');
    const set = sheets(restyle(b, style(b, b.direct, 'width', 'fill'), style(b, b.inStack, 'width', '240px', 'phone'))).site;
    expect(ownRules(set, b.direct)).toContain('width: 100%');
    expect(set).toMatch(new RegExp(`@media ${escape(MEDIA_QUERIES.phone)} \\{[^}]*\\.${nodeClass(b.inStack)} \\{[^}]*width: 240px`));
  });
});

const BROWSER = existsSync(chromium.executablePath());
let browser: Browser | undefined;
const roots: string[] = [];
beforeAll(async () => {
  if (BROWSER) browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 30_000 });
}, 60_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    roots.forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

/**
 * Server-render the generated Home page the way the exported site renders it: every generated Svelte file compiled
 * for the server, with SvelteKit's `$app/paths` and `$app/navigation` stubbed. The theme's sections are Svelte
 * components with styles of their own, which the site's build bundles: here each component's styles come back in the
 * head, to load after the site's stylesheets.
 */
async function renderHome(s: ProjectState): Promise<{ head: string; body: string }> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'button-width-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => p; export const asset = (p) => p; export const base = "";\n');
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {};\n');
  for (const [path, source] of generateProject(s)) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true, css: 'injected' }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
    );
  }
  const Page = (await import(/* @vite-ignore */ join(dir, 'src/routes/+page.svelte.js'))).default as Component<Record<string, unknown>>;
  const { head, body } = render(Page, { props: {} });
  return { head, body: body.replace(/<!--[\s\S]*?-->/g, '') };
}

/** `fit` is the element's own max-content width: as wide as its label and padding, in whatever font the system has. */
type Box = { width: number; left: number; fit: number };
type Measured = { inner: Box; innerLayout: string; stack: Box; stackDisplay: string; [label: string]: Box | string };
const box = (m: Measured, key: string) => m[key] as Box;

describe.runIf(BROWSER)('a button in a browser', () => {
  /** One page for every case: its markup is the same whatever its styles say, so it is written once. */
  const b = page();
  let html = { head: '', body: '' };
  beforeAll(async () => {
    html = await renderHome(b.state);
  }, 60_000);

  /** Each button's width and left edge within its parent, the Stack's within the Section, in a page this wide. */
  async function measure(s: ProjectState, viewport: number): Promise<Measured> {
    const tab = await browser!.newPage({ viewport: { width: viewport, height: 800 } });
    try {
      await tab.setContent(`<!doctype html><html><head><style>${sheets(s).all}</style>${html.head}</head><body>${html.body}</body></html>`);
      // As a string: the Node projects have no DOM types, and the other browser tests read the page the same way.
      return (await tab.evaluate(`(() => {
        const box = (el, within) => {
          const r = el.getBoundingClientRect();
          const width = el.style.width;
          el.style.width = 'max-content';
          const fit = Math.round(el.getBoundingClientRect().width);
          el.style.width = width;
          return { width: Math.round(r.width), left: Math.round(r.left - (within ? within.getBoundingClientRect().left : 0)), fit };
        };
        const find = (text) => [...document.querySelectorAll('a.so-btn')].find((a) => a.textContent.trim() === text);
        const inner = document.querySelector('.section__inner');
        const stacked = find(${JSON.stringify(STACKED)});
        const stack = stacked.parentElement;
        const out = { inner: box(inner, null), innerLayout: getComputedStyle(inner).display + ' ' + getComputedStyle(inner).flexDirection, stack: box(stack, inner), stackDisplay: getComputedStyle(stack).display };
        out[${JSON.stringify(DIRECT)}] = box(find(${JSON.stringify(DIRECT)}), inner);
        out[${JSON.stringify(STACKED)}] = box(stacked, stack);
        return out;
      })()`)) as Measured;
    } finally {
      await tab.close();
    }
  }

  it('is as wide as its label inside a Section or a Stack, not the whole container', async () => {
    const m = await measure(b.state, 1280);
    // The Section holds its content in a column that stretches what it holds, as its own styles say.
    expect(m.innerLayout).toBe('flex column');
    expect(m.inner.width).toBeGreaterThan(900);
    for (const label of [DIRECT, STACKED]) {
      expect(box(m, label).width, label).toBeGreaterThan(40);
      expect(box(m, label).width, label).toBe(box(m, label).fit);
      expect(box(m, label).left, label).toBe(0);
    }
  });

  it('is as wide as its label inside a grid, where it used to fill its cell', async () => {
    const m = await measure(restyle(b, style(b, b.stack, 'layout', 'grid')), 1280);
    expect(m.stackDisplay).toBe('grid');
    expect(box(m, STACKED).width).toBe(box(m, STACKED).fit);
  });

  it('keeps the width a page gives it: Fill, a length, Auto, and a width for one size only', async () => {
    const wide = await measure(restyle(b, style(b, b.direct, 'width', 'fill'), style(b, b.inStack, 'width', '240px')), 1280);
    expect(box(wide, DIRECT).width).toBe(wide.inner.width);
    expect(box(wide, STACKED).width).toBe(240);
    // "Auto" hands the width back to the parent, which stretches it as it always did.
    const auto = await measure(restyle(b, style(b, b.direct, 'width', 'auto')), 1280);
    expect(box(auto, DIRECT).width).toBe(auto.inner.width);
    // Phone only: the theme's default applies at the other sizes.
    const phoneOnly = restyle(b, style(b, b.direct, 'width', 'fill', 'phone'));
    const onPhone = await measure(phoneOnly, 390);
    expect(box(onPhone, DIRECT).width).toBe(onPhone.inner.width);
    const onDesktop = box(await measure(phoneOnly, 1280), DIRECT);
    expect(onDesktop.width).toBe(onDesktop.fit);
  });

  it('still follows its parent’s alignment: centred or at the end', async () => {
    for (const align of ['center', 'end', 'start'] as const) {
      const m = await measure(restyle(b, style(b, b.stack, 'align', align)), 1280);
      const { width, left, fit } = box(m, STACKED);
      expect(width, align).toBe(fit);
      const free = m.stack.width - width;
      if (align === 'center') expect(Math.abs(left - free / 2)).toBeLessThanOrEqual(1);
      if (align === 'end') expect(Math.abs(left - free)).toBeLessThanOrEqual(1);
      if (align === 'start') expect(left).toBe(0);
    }
  });

  it('keeps the header’s call to action stretched across a menu that stretches its items', async () => {
    // The phone menu is a column that stretches what it holds (see the header's own styles): a stand-in with the same layout.
    const tab = await browser!.newPage({ viewport: { width: 390, height: 800 } });
    try {
      await tab.setContent(
        `<!doctype html><html><head><style>${sheets(b.state).all}</style></head><body><nav style="display:flex;flex-direction:column;align-items:stretch;width:320px"><a class="so-btn so-btn--primary so-header__cta" href="#x">Book a call</a></nav></body></html>`
      );
      expect(await tab.evaluate(`document.querySelector('.so-header__cta').getBoundingClientRect().width`)).toBe(320);
    } finally {
      await tab.close();
    }
  });
});
