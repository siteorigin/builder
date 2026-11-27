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
// Imported only so a change to the field or its styles reaches this test through the import graph (CI runs the tests
// a pull request's changes reach). Vitest imports a stylesheet as nothing, so the page reads them from disk below, and
// the field itself is bundled for the browser.
import '../../src/renderer/src/styles/tokens.css?raw';
import '../../src/renderer/src/styles/reset.css?raw';
import '../../src/renderer/src/styles/primitives.css?raw';
import fieldSource from '../../src/renderer/src/components/ui.tsx?raw';

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
  "    h(Counted, { label: 'Excerpt', hint: 'Shown in lists of posts.', multiline: true, rows: 2, limit: 299 }),",
  "    h(Counted, { label: 'Image description', hint: 'Read aloud in place of the picture.', multiline: true, rows: 2, limit: 300 }),",
  "    h(Counted, { label: 'Notes', hint: 'For you and the AI.', multiline: true, limit: 500, quietCount: true }),",
  "    h(Counted, { label: 'Message', hint: 'Shown on the not-found page.', wrap: true, className: 'textarea', limit: 400 }),",
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
if (!fieldSource.includes('field-counted')) throw new Error('DraftInput no longer wraps a counted field');

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
    context = await browser.newContext({ viewport: { width: 600, height: 1600 } });
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
  // Page code is passed as text, as in the other browser tests: the unit tests' tsconfig has no DOM types.
  /** Run `fn`, the source of a function of the element, on the element. */
  const on = <R>(l: Locator, fn: string): Promise<R> => l.evaluate(new Function('el', `return (${fn})(el);`) as (el: unknown) => R);
  const countOf = async (control: Locator) =>
    page.locator(`[id="${await on<string>(control, "(el) => el.getAttribute('aria-describedby').split(' ').find((id) => document.getElementById(id)?.classList.contains('field-count'))")}"]`);
  const hintOf = (control: Locator) => control.locator('xpath=ancestor::div[contains(@class, "field")][1]').locator('.field-hint');
  const rect = (l: Locator) => on<Box>(l, '(el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }');
  const focused = (l: Locator) => on<boolean>(l, '(el) => el === document.activeElement');
  // A box's border is its frame's; its text may be drawn anywhere in the textarea's scroll viewport (scrolled lines
  // pass through its padding). A single line's text stays inside its padding.
  const geometry = (control: Locator) =>
    on<Geometry>(
      control,
      `(el) => {
        const px = (v) => parseFloat(v) || 0;
        const of = (e) => {
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
      }`
    );
  // Rectangles that share an edge, up to rounding (an element's client size is whole pixels), do not overlap.
  const overlaps = (a: Box, b: Box) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
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
    expect(await on(box, "(el) => el.closest('.field-counted').nextElementSibling.classList.contains('field-hint')")).toBe(true);
    expect(await on(count, "(el) => el.parentElement.classList.contains('field-frame') && getComputedStyle(el).visibility === 'visible'")).toBe(true);
    expect(await on(count, '(el) => getComputedStyle(el).pointerEvents')).toBe('none');
    // The border is the frame's; the text inside it has none of its own.
    expect(await on(box, '(el) => getComputedStyle(el).borderTopWidth')).toBe('0px');
  });

  it('keeps the caret in the box when its footer is pressed, rather than leaving (and saving) the field', async () => {
    const box = field('Default description');
    await box.click();
    await on(box, '(el) => el.setSelectionRange(el.value.length, el.value.length)');
    await page.keyboard.type(' Book direct.');
    const c = await rect(await countOf(box));
    // Beside the count, inside the border, below the text.
    await page.mouse.click(c.left - 40, (c.top + c.bottom) / 2);
    expect(await focused(box)).toBe(true);
    expect(await box.inputValue()).toBe(`${DESCRIPTION} Book direct.`);
    // Where the box cannot be resized, its corner holds the caret too.
    await on(box, "(el) => { el.closest('.field-frame').style.resize = 'none'; }");
    const f = (await geometry(box)).box;
    await page.mouse.click(f.right - 6, f.bottom - 6);
    expect(await focused(box)).toBe(true);
  });

  it('opens a box four lines tall from a limit of 300, and three below it, before any typing', async () => {
    for (const [name, lines] of [['Default description', 4], ['Image description', 4], ['Excerpt', 3]] as const) {
      const g = await geometry(field(name));
      expect(g.lines, name).toBeGreaterThanOrEqual(lines - 0.05);
      expect(g.lines, name).toBeLessThan(lines + 0.5);
    }
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
    await expect.poll(() => on(box, '(el) => el.scrollHeight > el.clientHeight')).toBe(true);
    await on(box, '(el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; }');
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
    expect(hint.top - lg.box.bottom).toBeGreaterThanOrEqual(0);
    expect(hint.top - lg.box.bottom).toBeLessThanOrEqual(6);

    // A line that wraps keeps its count at its right end, its words wrapping clear of it, and grows rather than
    // scrolling, so no scrollbar runs under the count.
    const message = field('Message');
    await message.fill('Ｗ '.repeat(199).trim());
    const mc = await countOf(message);
    await expect.poll(() => mc.textContent()).toBe('397 / 400');
    const mg = await geometry(message);
    expect(mg.box.bottom - mg.box.top).toBeGreaterThan(300);
    expect(await on(message, '(el) => el.scrollHeight <= el.clientHeight')).toBe(true);
    const mr = await rect(mc);
    expect(inside(mr, mg.box)).toBe(true);
    expect(overlaps(mr, mg.text)).toBe(false);
    expect(mg.box.bottom - mr.bottom).toBeLessThan(10);
    expect((await rect(hintOf(message))).top - mg.box.bottom).toBeLessThanOrEqual(6);
  });

  it('resizes the box by the grip at its corner, the count staying inside it', async () => {
    const box = field('Default description');
    const before = await geometry(box);
    // The grip is the frame's bottom-right corner.
    await page.mouse.move(before.box.right - 3, before.box.bottom - 3);
    await page.mouse.down();
    await page.mouse.move(before.box.right - 3, before.box.bottom + 57, { steps: 4 });
    await page.mouse.up();
    const after = await geometry(box);
    expect(after.box.bottom - before.box.bottom).toBeGreaterThan(40);
    // The text takes the new height, and the count keeps its corner below it.
    expect(after.text.bottom - before.text.bottom).toBeGreaterThan(40);
    const c = await rect(await countOf(box));
    expect(inside(c, after.box)).toBe(true);
    expect(after.box.bottom - c.bottom).toBeLessThan(10);
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
    await name.blur();
    await expect.poll(() => count.isVisible()).toBe(false);
    // Near the limit it shows whether or not the field is being typed in.
    await name.fill('n'.repeat(96));
    await expect.poll(() => count.isVisible()).toBe(true);
    expect(await count.textContent()).toBe('96 / 120');

    // In a box, the quiet count keeps its place in the footer, so the box never changes height as focus comes and goes.
    const notes = field('Notes');
    const quiet = await countOf(notes);
    const height = (await geometry(notes)).box;
    expect(await on(quiet, '(el) => getComputedStyle(el).visibility')).toBe('hidden');
    await notes.focus();
    await expect.poll(() => on(quiet, '(el) => getComputedStyle(el).visibility')).toBe('visible');
    expect((await geometry(notes)).box).toEqual(height);
    expect(inside(await rect(quiet), height)).toBe(true);
  });

  it('turns the count into the error under the field once the text is over the limit, keeping focus', async () => {
    const box = field('Excerpt');
    await box.focus();
    await on(box, '(el) => { window.excerptNode = el; }');
    await box.fill('x'.repeat(310));
    const count = await countOf(box);
    await expect.poll(() => count.getAttribute('class')).toContain('field-error');
    expect(await count.textContent()).toBe('310 / 299. Shorten it by 11 characters to save it.');
    expect(await on(count, "(el) => el.previousElementSibling.classList.contains('field-frame') && el.nextElementSibling === null")).toBe(true);
    expect(await focused(box)).toBe(true);
    const g = await geometry(box);
    const c = await rect(count);
    expect(c.top).toBeGreaterThanOrEqual(g.box.bottom);
    expect(c.left).toBeLessThanOrEqual(g.box.left + 1);
    const hint = await rect(hintOf(box));
    expect(hint.top).toBeGreaterThanOrEqual(c.bottom);
    // The box, not the borderless text inside it, takes the red edge.
    const edge = (sel: string) => on<string>(page.locator(sel).first(), '(el) => getComputedStyle(el).borderTopColor');
    const red = await page.evaluate<string>(`(() => {
      const probe = document.body.appendChild(document.createElement('i'));
      probe.style.color = 'var(--red)';
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    })()`);
    await expect.poll(() => edge('.field-frame:has(textarea[aria-invalid="true"])')).toBe(red);
    // Back under the limit, the count goes back inside, with focus still in the field.
    await box.fill('x'.repeat(290));
    await expect.poll(() => count.getAttribute('class')).not.toContain('field-error');
    expect(await count.textContent()).toBe('290 / 299');
    expect(inside(await rect(count), (await geometry(box)).box)).toBe(true);
    expect(await focused(box)).toBe(true);
    // The same textarea throughout: never remounted as the count moved out and back.
    expect(await on(box, '(el) => el === window.excerptNode')).toBe(true);

    // Over the limit, a line that wraps scrolls in the usual height rather than growing with all of the paste.
    const message = field('Message');
    await message.fill('Ｗ '.repeat(1000).trim());
    await expect.poll(() => countOf(message).then((c) => c.getAttribute('class'))).toContain('field-error');
    expect((await geometry(message)).box.bottom - (await geometry(message)).box.top).toBeLessThanOrEqual(260);
  });
});
