/**
 * A field with a limit counts inside itself, so its hint stays directly under it (#1186): a box's count sits in its
 * bottom-right corner, left of the resize grip, and a single line's at its right end, each with room kept so no text
 * runs under it at any length. A description (a limit of 300 or more) opens four lines tall. Over the limit the count
 * is the error sentence under the field, as before. The real DraftInput, Field and stylesheets, in a real browser.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://field-count.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const DESCRIPTION = 'Hillside Stays: private holiday homes with pools in the countryside, ten minutes from the coast.';

const ENTRY = [
  "import { createElement as h, useState } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { DraftInput, Field } from ${renderer('components/ui')};`,
  'function Counted({ label, hint, ...props }) {',
  "  const [value, setValue] = useState(props.value ?? '');",
  '  return h(Field, { label, hint }, h(DraftInput, { ...props, value, onCommit: setValue }));',
  '}',
  'function App() {',
  "  return h('div', { style: { width: '320px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' } },",
  `    h(Counted, { label: 'Default description', hint: 'Used by pages without their own description.', multiline: true, rows: 2, limit: 320, value: ${JSON.stringify(DESCRIPTION)} }),`,
  "    h(Counted, { label: 'Excerpt', hint: 'Shown in lists of posts.', multiline: true, rows: 2, limit: 160 }),",
  "    h(Counted, { label: 'Browser title', hint: 'Shown in the browser tab.', limit: 70, value: 'Hillside Stays' }),",
  "    h(Counted, { label: 'Name', hint: 'The business name.', limit: 120, quietCount: true, value: 'Hillside' })",
  '  );',
  '}',
  "flushSync(() => createRoot(document.getElementById('root')).render(h(App)));"
].join('\n');

/** The preload bridge: every call answers nothing. */
const BRIDGE = `
  const any = () => new Proxy(function () {}, { get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any()), apply: () => any() });
  window.builder = any();
`;

const css = ['tokens', 'reset', 'primitives'].map((n) => readFileSync(resolve(`src/renderer/src/styles/${n}.css`), 'utf8')).join('\n');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'field-count',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The fields did not bundle');
  return chunk.code;
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Where a field's text may be drawn: inside its border and padding, in the page's coordinates. */
interface Geometry {
  box: Box;
  text: Box;
  lines: number;
}

describe.skipIf(!browserInstalled)('a field counts inside itself', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 600, height: 900 } });
    context.setDefaultTimeout(5_000);
    page = await context.newPage();
    errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script>${BRIDGE}</script><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
  });
  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  const field = (name: string) => page.getByRole('textbox', { name });
  const countOf = async (control: Locator) => page.locator(`[id="${await control.evaluate((el) => el.getAttribute('aria-describedby')!.split(' ').find((id) => document.getElementById(id)?.classList.contains('field-count')))}"]`);
  const hintOf = (control: Locator) => control.locator('xpath=ancestor::div[contains(@class, "field")][1]').locator('.field-hint');
  const rect = (l: Locator): Promise<Box> => l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  // A box's border is its frame's; its text may be drawn anywhere in the textarea's scroll viewport (scrolled lines
  // pass through its padding). A single line's text stays inside its padding.
  const geometry = (control: Locator): Promise<Geometry> =>
    control.evaluate((el: HTMLElement) => {
      const px = (v: string) => parseFloat(v) || 0;
      const of = (e: Element) => {
        const r = e.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const frame = el.closest('.field-frame');
      const top = r.top + px(s.borderTopWidth);
      const left = r.left + px(s.borderLeftWidth);
      const text = frame
        ? { top, left, bottom: top + el.clientHeight, right: left + el.clientWidth }
        : { top: top + px(s.paddingTop), left: left + px(s.paddingLeft), bottom: top + el.clientHeight - px(s.paddingBottom), right: left + el.clientWidth - px(s.paddingRight) };
      return { box: of(frame ?? el), text, lines: (el.clientHeight - px(s.paddingTop) - px(s.paddingBottom)) / px(s.lineHeight) };
    });
  const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const inside = (inner: Box, outer: Box) => inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;

  it('puts a box’s count in its bottom-right corner, with the hint directly under the box', async () => {
    const box = field('Default description');
    const count = await countOf(box);
    await expect.poll(() => count.textContent()).toBe(`${DESCRIPTION.length} / 320`);
    const g = await geometry(box);
    const c = await rect(count);
    expect(inside(c, g.box)).toBe(true);
    // In the bottom-right corner, left of the resize grip, and clear of where the text goes.
    expect(g.box.bottom - c.bottom).toBeLessThan(10);
    expect(g.box.right - c.right).toBeGreaterThanOrEqual(12);
    expect(g.box.right - c.right).toBeLessThan(30);
    expect(overlaps(c, g.text)).toBe(false);
    // The hint follows the box, with nothing between them.
    const hint = await rect(hintOf(box));
    expect(hint.top - g.box.bottom).toBeGreaterThanOrEqual(0);
    expect(hint.top - g.box.bottom).toBeLessThanOrEqual(6);
    expect(await count.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  });

  it('opens a description four lines tall and a shorter limit’s box three, before any typing', async () => {
    expect((await geometry(field('Default description'))).lines).toBeGreaterThanOrEqual(4);
    const excerpt = await geometry(field('Excerpt'));
    expect(excerpt.lines).toBeGreaterThanOrEqual(3);
    expect(excerpt.lines).toBeLessThan(4);
  });

  it('never lets text run under the count, at any length', async () => {
    const box = field('Default description');
    await box.fill('word '.repeat(64).trim());
    const count = await countOf(box);
    await expect.poll(() => count.textContent()).toBe('319 / 320');
    const g = await geometry(box);
    expect(overlaps(await rect(count), g.text)).toBe(false);
    // Grown to its tallest, the text scrolls, and halfway down no line can pass under the count.
    await box.fill(Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join('\n'));
    await expect.poll(() => box.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await box.evaluate((el) => (el.scrollTop = (el.scrollHeight - el.clientHeight) / 2));
    expect(overlaps(await rect(count), (await geometry(box)).text)).toBe(false);
    expect(inside(await rect(count), (await geometry(box)).box)).toBe(true);

    const line = field('Browser title');
    await line.fill('Hillside Stays: private holiday homes with pools, ten minutes away');
    const lineCount = await countOf(line);
    const lg = await geometry(line);
    const lc = await rect(lineCount);
    expect(inside(lc, lg.box)).toBe(true);
    expect(overlaps(lc, lg.text)).toBe(false);
    expect(lg.box.right - lc.right).toBeLessThan(14);
    const hint = await rect(hintOf(line));
    expect(hint.top - lg.box.bottom).toBeLessThanOrEqual(6);
  });

  it('shows a quiet count inside its field while it is being typed in', async () => {
    const name = field('Name');
    const count = await countOf(name);
    expect(await count.isVisible()).toBe(false);
    await name.focus();
    await expect.poll(() => count.isVisible()).toBe(true);
    const g = await geometry(name);
    const c = await rect(count);
    expect(inside(c, g.box)).toBe(true);
    expect(overlaps(c, g.text)).toBe(false);
  });

  it('turns the count into the error under the field once the text is over the limit, keeping focus', async () => {
    const box = field('Excerpt');
    await box.focus();
    await box.fill('x'.repeat(170));
    const count = await countOf(box);
    await expect.poll(() => count.getAttribute('class')).toContain('field-error');
    expect(await count.textContent()).toContain('Shorten it by 10 characters');
    expect(await box.evaluate((el) => el === document.activeElement)).toBe(true);
    const g = await geometry(box);
    const c = await rect(count);
    expect(c.top).toBeGreaterThanOrEqual(g.box.bottom);
    expect(c.left).toBeLessThanOrEqual(g.box.left + 1);
    const hint = await rect(hintOf(box));
    expect(hint.top).toBeGreaterThanOrEqual(c.bottom);
    // Back under the limit, the count goes back inside, with focus still in the field.
    await box.fill('x'.repeat(150));
    await expect.poll(() => count.getAttribute('class')).not.toContain('field-error');
    expect(inside(await rect(count), (await geometry(box)).box)).toBe(true);
    expect(await box.evaluate((el) => el === document.activeElement)).toBe(true);
  });
});
