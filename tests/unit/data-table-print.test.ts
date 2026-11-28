/**
 * Foundation's Data table printed in Chromium (#1442). On screen a wide table scrolls sideways inside its own region;
 * printed, every column is on the sheet whatever the visitor had scrolled to, in portrait and landscape. The exported
 * Home page is rendered on the server as the static site ships it, with the theme's stylesheets and the sections'
 * scoped styles, printed to an A4 PDF at 10 mm margins, and each sheet's text read back.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceNode } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { STYLES_DIR, generateProject } from '@generator/index';
import { removeRendered, serverHtml } from './generated-site';
import { scopedStyles } from './fixtures/split-layout-styles';
import { pdfPages, squash } from './pdf-text';

const CAN_PRINT = existsSync(chromium.executablePath());
const ORIGIN = 'https://table.test';

/** Twelve medium or long column names, as the issue's table had. */
const HEADERS = [
  'Reference number',
  'Customer account name',
  'Primary contact person',
  'Delivery region and zone',
  'Requested delivery window',
  'Assigned warehouse location',
  'Product category family',
  'Quantity ordered in units',
  'Unit price before tax',
  'Payment terms agreed',
  'Last reviewed by',
  'Edited status'
];
const ROWS = 60;
const pad = (i: number, width: number) => String(i).padStart(width, '0');
/** A value longer than any column is wide, with nowhere to wrap: printed, it breaks rather than running off the sheet. */
const LONG = 'https://orders.example/warehouse/northern-distribution/requested-window/0000000001';
/** Each cell's own marker, unique across the table (one cell holds the long value instead). */
const CELLS = Array.from({ length: ROWS }, (_, r) => HEADERS.map((_, c) => (r === 7 && c === 5 ? LONG : `r${pad(r + 1, 2)}c${pad(c + 1, 2)}`)));

function exportedSite() {
  const s = createStarterState('business', 'Table Studio', false);
  const home = s.pages[s.site.homePageId];
  const columns = HEADERS.map((label, c) => ({ id: `col_${c}`, label }));
  const rows = Array.from({ length: ROWS }, (_, r) => ({
    id: `row_${r}`,
    cells: Object.fromEntries(columns.map((col, c) => [col.id, CELLS[r][c]]))
  }));
  const node: InstanceNode = makeInstance(s.components[installComponent(s, 'data.table')], { table: { columns, rows }, caption: 'Open orders' });
  home.nodes[node.id] = node;
  home.rootIds = [node.id];
  return generateProject(s);
}

/** The table's scrolling region, in the page. */
const REGION = `document.querySelector('[class*="so-table__scroll"]')`;
const scrolled = (page: Page) => page.evaluate(`${REGION}.scrollLeft`) as Promise<number>;

afterAll(removeRendered);

describe.runIf(CAN_PRINT)('printing a wide Data table in chromium', () => {
  let browser: Browser;
  let body: string;

  beforeAll(async () => {
    const files = exportedSite();
    const { css, ssr } = scopedStyles(files, files, await serverHtml(files, 'data-table-print-'));
    const styles = [...['tokens', 'theme', 'components', 'site'].map((f) => files.get(`${STYLES_DIR}/${f}.css`) ?? ''), css].join('\n');
    body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body><div id="app">${ssr}</div></body></html>`;
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 30_000 });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function open(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
    await page.goto(`${ORIGIN}/`);
    return page;
  }

  it.each([
    ['portrait', false],
    ['landscape', true]
  ] as Array<[string, boolean]>)('prints every column on A4 %s, before and after the table is scrolled sideways', async (_label, landscape) => {
    const page = await open();
    try {
      // On screen at a laptop's width the table is wider than its region, which scrolls.
      const overflow = (await page.evaluate(`(() => { const el = ${REGION}; return el.scrollWidth - el.clientWidth; })()`)) as number;
      expect(overflow).toBeGreaterThan(362);
      for (const scroll of [0, 362]) {
        await page.evaluate(`${REGION}.scrollLeft = ${scroll}`);
        expect(await scrolled(page)).toBe(scroll);
        const sheets = pdfPages(await page.pdf({ format: 'A4', landscape, margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' } })).map(squash);
        const text = sheets.join('');
        const missing = [...HEADERS, ...CELLS.flat()].filter((value) => !text.includes(squash(value)));
        expect(missing, `scrolled ${scroll}px`).toEqual([]);
        // Every sheet the rows continue on starts with the column names again.
        const withRows = sheets.filter((sheet) => CELLS.some((row) => sheet.includes(row[0])));
        expect(withRows.length, `scrolled ${scroll}px`).toBeGreaterThan(1);
        for (const sheet of withRows) expect(HEADERS.filter((h) => !sheet.includes(squash(h))), `scrolled ${scroll}px`).toEqual([]);
      }
      // Back on screen, the region is where the visitor left it.
      expect(await scrolled(page)).toBe(362);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('lays every cell out inside the sheet’s width under print media, with nothing scrolled out of view', async () => {
    const page = await open();
    try {
      await page.evaluate(`${REGION}.scrollLeft = 362`);
      // A4 portrait inside 10 mm margins is 190 mm wide: 718 CSS pixels.
      await page.setViewportSize({ width: 718, height: 1000 });
      await page.emulateMedia({ media: 'print' });
      const laid = await page.evaluate(`(() => {
        const el = ${REGION};
        const box = el.getBoundingClientRect();
        const cells = [...el.querySelectorAll('th, td')].map((c) => c.getBoundingClientRect());
        return {
          overflow: el.scrollWidth - el.clientWidth,
          inside: box.left >= 0 && box.right <= document.documentElement.clientWidth,
          outside: cells.filter((c) => c.left < box.left - 0.5 || c.right > box.right + 0.5).length,
          cells: cells.length
        };
      })()`);
      expect(laid).toEqual({ overflow: 0, inside: true, outside: 0, cells: HEADERS.length * (ROWS + 1) });
    } finally {
      await page.close();
    }
  }, 60_000);
});
