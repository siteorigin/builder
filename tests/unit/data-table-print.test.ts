/**
 * Foundation's Data table printed in Chromium (#1442). On screen a wide table scrolls sideways inside its own region;
 * printed, every column is on the sheet whatever the visitor had scrolled to, in portrait and landscape. The exported
 * Home page is rendered on the server as the static site ships it, with the theme's stylesheets and the sections'
 * scoped styles, printed to an A4 PDF at 10 mm margins, and each sheet's text read back.
 */
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InstanceNode } from "@shared/types";
import { createStarterState } from "@catalogue/starters";
import { installComponent, makeInstance } from "@engine/install";
import { STYLES_DIR, generateProject } from "@generator/index";
import { removeRendered, serverHtml } from "./generated-site";
import { scopedStyles } from "./fixtures/split-layout-styles";
import { pdfPages, squash } from "./pdf-text";

const CAN_PRINT = existsSync(chromium.executablePath());
const ORIGIN = "https://table.test";

/** Twelve medium or long column names, as the issue's table had. */
const HEADERS = [
  "Reference number",
  "Customer account name",
  "Primary contact person",
  "Delivery region and zone",
  "Requested delivery window",
  "Assigned warehouse location",
  "Product category family",
  "Quantity ordered in units",
  "Unit price before tax",
  "Payment terms agreed",
  "Last reviewed by",
  "Edited status",
];
const ROWS = 60;
const n = (i: number) => String(i + 1).padStart(3, "0");
/** Each row's marker in the first column and in the last, unique across the table. */
const FIRST = Array.from({ length: ROWS }, (_, i) => `ID${n(i)}`);
const LAST = Array.from({ length: ROWS }, (_, i) => `ED${n(i)}`);

function exportedSite() {
  const s = createStarterState("business", "Table Studio", false);
  const home = s.pages[s.site.homePageId];
  const columns = HEADERS.map((label, c) => ({ id: `col_${c}`, label }));
  const rows = Array.from({ length: ROWS }, (_, r) => ({
    id: `row_${r}`,
    cells: Object.fromEntries(
      columns.map((col, c) => [
        col.id,
        c === 0
          ? FIRST[r]
          : c === columns.length - 1
            ? LAST[r]
            : `Sample value ${c}`,
      ]),
    ),
  }));
  const node: InstanceNode = makeInstance(
    s.components[installComponent(s, "data.table")],
    { table: { columns, rows }, caption: "Open orders" },
  );
  home.nodes[node.id] = node;
  home.rootIds = [node.id];
  return generateProject(s);
}

afterAll(removeRendered);

describe.runIf(CAN_PRINT)("printing a wide Data table in chromium", () => {
  let browser: Browser;
  let body: string;

  beforeAll(async () => {
    const files = exportedSite();
    const { css, ssr } = scopedStyles(
      files,
      files,
      await serverHtml(files, "data-table-print-"),
    );
    const styles = [
      ...["tokens", "theme", "components", "site"].map(
        (f) => files.get(`${STYLES_DIR}/${f}.css`) ?? "",
      ),
      css,
    ].join("\n");
    body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body><div id="app">${ssr}</div></body></html>`;
    browser = await chromium.launch({
      headless: true,
      executablePath: chromium.executablePath(),
      timeout: 30_000,
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function open(): Promise<Page> {
    const page = await browser.newPage({
      viewport: { width: 1024, height: 800 },
    });
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body }),
    );
    await page.goto(`${ORIGIN}/`);
    return page;
  }

  it.each([
    ["portrait", false],
    ["landscape", true],
  ] as Array<[string, boolean]>)(
    "prints every column on A4 %s, before and after the table is scrolled sideways",
    async (_label, landscape) => {
      const page = await open();
      try {
        // On screen at a laptop's width the table is wider than its region, which scrolls.
        const region = page.locator('[class*="so-table__scroll"]');
        const overflow = await region.evaluate(
          (el) => el.scrollWidth - el.clientWidth,
        );
        expect(overflow).toBeGreaterThan(362);
        for (const scroll of [0, 362]) {
          await region.evaluate((el, left) => (el.scrollLeft = left), scroll);
          expect(await region.evaluate((el) => el.scrollLeft)).toBe(scroll);
          const text = squash(
            pdfPages(
              await page.pdf({
                format: "A4",
                landscape,
                margin: {
                  top: "10mm",
                  right: "10mm",
                  bottom: "10mm",
                  left: "10mm",
                },
              }),
            ).join("\n"),
          );
          const missing = [...HEADERS, ...FIRST, ...LAST].filter(
            (value) => !text.includes(squash(value)),
          );
          expect(missing, `scrolled ${scroll}px`).toEqual([]);
        }
        // Back on screen, the region is where the visitor left it.
        expect(await region.evaluate((el) => el.scrollLeft)).toBe(362);
      } finally {
        await page.close();
      }
    },
    60_000,
  );
});
