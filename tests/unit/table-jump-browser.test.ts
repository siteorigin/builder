/**
 * The Data table's Columns shortcut lands its target below the Inspector's sticky heading (issue #1398). It scrolled
 * the Columns part to the very top of the panel and then focused Add column without scrolling, so in a short window
 * the focused button sat wholly behind the heading.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://table-jump.test';
const css = [
  '@layer tokens, reset, base, primitives, layout, components;',
  ...[...['tokens', 'reset', 'primitives', 'layout'].map((f) => `styles/${f}.css`), 'panels/Inspector.css', 'panels/TableEditor.css'].map((f) => readFileSync(resolve('src/renderer/src', f), 'utf8'))
].join('\n');
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const columns = ['Day', 'Central library', 'Riverside room', 'Children’s desk', 'Step-free entry', 'Quiet desks', 'Hearing loop'].map((label, i) => ({ id: `c${i}`, label }));
/** Enough rows that the grid scrolls in its own frame, which is what offers the shortcut. */
const table = { columns, rows: Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, cells: { c0: `Day ${i + 1}` } })) };

/** The Inspector in small: its sticky heading over the real table editor. The heading is tall, as one that wraps is, so only an allowance that follows its height clears it. */
const ENTRY = [
  "import { createElement as h, useEffect, useRef } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  `import { TableEditor } from ${renderer('panels/TableEditor')};`,
  `const value = ${JSON.stringify(table)};`,
  'function Panel() {',
  '  const head = useRef(null);',
  // As Header does in Inspector.tsx: the panel allows for the heading's height and the room above a field.
  "  useEffect(() => head.current.parentElement.style.setProperty('--insp-head-h', Math.ceil(head.current.offsetHeight) + 32 + 'px'), []);",
  '  return h("div", { className: "panel-body insp", style: { height: "460px" } },',
  '    h("div", { className: "insp-head insp-sel", ref: head, style: { height: "200px", boxSizing: "border-box" } }, "Data table"),',
  '    h("div", { style: { padding: "0 14px" } }, h(TableEditor, { name: "table", schema: { type: "table", label: "Table", default: value }, value, onTable: async () => true })),',
  '    h("div", { style: { height: "600px" } }));',
  '}',
  "createRoot(document.getElementById('root')).render(h(Panel));"
].join('\n');

async function bundle(): Promise<string> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [
      {
        name: 'table-jump',
        enforce: 'pre',
        resolveId: (id, importer) => (id === '\0entry' ? id : id.endsWith('.css') && importer && existsSync(resolve(dirname(importer), id)) ? '\0empty' : null),
        load: (id) => (id === '\0entry' ? ENTRY : id === '\0empty' ? '' : null)
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The table editor did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('the table’s Columns shortcut in a browser', { timeout: 30_000 }, () => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    [script, browser] = await Promise.all([bundle(), chromium.launch({ headless: true, executablePath: chromium.executablePath() })]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  it('focuses Add column in view, with the Columns heading, below the sticky Inspector heading', async () => {
    const context = await browser.newContext({ viewport: { width: 340, height: 480 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) =>
      new URL(route.request().url()).pathname === '/app.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script })
        : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>${css}</style><body><div id="root"></div><script src="/app.js"></script>` })
    );
    await page.goto(`${SITE}/`);
    const jump = page.getByRole('button', { name: 'Go to columns' });
    await jump.focus();
    await page.keyboard.press('Enter');
    const landed = await page.evaluate<{ focused: string; headBottom: number; headingTop: number; top: number; bottom: number; panelBottom: number; hit: boolean }>(`(() => {
      const add = document.activeElement;
      const box = add.getBoundingClientRect();
      const heading = add.closest('.table-editor-heading')?.querySelector('span');
      return {
        focused: add.textContent.trim(),
        headBottom: document.querySelector('.insp-head').getBoundingClientRect().bottom,
        headingTop: heading?.getBoundingClientRect().top ?? -1,
        top: box.top,
        bottom: box.bottom,
        panelBottom: document.querySelector('.panel-body').getBoundingClientRect().bottom,
        hit: add.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
      };
    })()`);
    expect(landed.focused).toBe('Add column');
    expect(landed.headingTop).toBeGreaterThanOrEqual(landed.headBottom);
    expect(landed.top).toBeGreaterThanOrEqual(landed.headBottom);
    expect(landed.bottom).toBeLessThanOrEqual(landed.panelBottom);
    expect(landed.hit).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });
});
