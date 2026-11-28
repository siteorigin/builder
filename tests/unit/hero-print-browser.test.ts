/**
 * Printed, the Business starter's Home begins its introduction on the first sheet (#1432). Foundation's split hero
 * stacks its copy over its picture when printed narrower than desktop. Chromium never breaks between a one-column
 * grid's rows when only the section's padding below them runs past the sheet: it moved the whole hero to the next
 * sheet, leaving the header's site name alone on the first (A4 portrait with 12 mm and 14 mm margins). The stacked
 * hero prints as a column, which breaks between the copy and the picture; the side-by-side layout stays a grid.
 *
 * Sheets are stood in for by the columns of a multi-column layout, which Chromium fragments as it does printed pages,
 * so the test reads where the heading lands from the page itself. The sheet's height is set from the hero's own
 * measurements, so the hero always just misses the first sheet whatever fonts the machine has.
 */
import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { generateProject } from '@generator/index';
import { removeRendered, serverHtml } from './generated-site';

const browserInstalled = existsSync(chromium.executablePath());
/** A4 portrait's printable width with 14 mm left and right margins, in CSS px (182 mm). */
const SHEET_WIDTH = 688;

afterAll(removeRendered);

describe.skipIf(!browserInstalled)("the split hero's printed layout", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    const clean = generateProject(createStarterState('business', 'Test Studio', true));
    const html = await serverHtml(clean, 'hero-print-browser-', 'src/routes/+page.svelte', true);
    const css = ['tokens', 'theme', 'components', 'site'].map((f) => clean.get(`src/lib/siteorigin/styles/${f}.css`) ?? '').join('\n');
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage();
    // The site's header, as tall as Foundation's, above the page; the pictures and fonts are not served.
    await page.route('**/*', (route) => route.abort());
    await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style></head><body><header style="height: 73px">Test Studio</header><main>${html}</main></body></html>`);
    await page.emulateMedia({ media: 'print' });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  it('starts the heading on the first sheet when the hero only just misses it', async () => {
    await page.setViewportSize({ width: SHEET_WIDTH, height: 1032 });
    const at = await page.evaluate<{ grid: number; hero: number; heading: number }>(
      `(() => { const box = (sel) => document.querySelector(sel).getBoundingClientRect(); return { grid: box('.hero__grid').bottom, hero: box('.hero').bottom, heading: box('.hero h1').bottom }; })()`
    );
    // The hero's copy and picture fit the sheet; the section's padding below them does not.
    expect(at.hero).toBeGreaterThan(at.grid + 8);
    const sheet = Math.round((at.grid + at.hero) / 2);
    expect(at.heading).toBeLessThan(sheet);
    await page.addStyleTag({ content: `html { columns: ${SHEET_WIDTH}px; column-gap: 0; column-fill: auto; height: ${sheet}px; }` });
    const heading = await page.evaluate<{ left: number; bottom: number }>(`document.querySelector('.hero h1').getBoundingClientRect().toJSON()`);
    // The first column is the first sheet: the heading sits on it, not one sheet along.
    expect(heading.left).toBeLessThan(SHEET_WIDTH);
    expect(heading.bottom).toBeLessThanOrEqual(sheet);
  });

  it('keeps the side-by-side layout a grid when printed at desktop width', async () => {
    const p = await browser.newPage();
    await p.setContent(await page.content());
    await p.emulateMedia({ media: 'print' });
    await p.setViewportSize({ width: 1123, height: 794 });
    const display = () => p.evaluate<string>(`getComputedStyle(document.querySelector('.hero__grid')).display`);
    expect(await display()).toBe('grid');
    await p.setViewportSize({ width: SHEET_WIDTH, height: 1032 });
    expect(await display()).toBe('flex');
    await p.close();
  });
});

describe.each(['resources/packs/foundation/pack.json', 'resources/packs-dev/foundation-alt/pack.json'])('%s', (file) => {
  it('prints the stacked split hero as a column', () => {
    const pack = JSON.parse(readFileSync(file, 'utf8')) as { id: string; components: { id: string; source: string }[] };
    const hero = pack.components.find((c) => c.id === `${pack.id}.hero.split`)!;
    expect(hero.source.replace(/\s+/g, ' ')).toContain('@media print and (not (min-width: 1024px)) { .hero__grid { display: flex; flex-direction: column; align-items: stretch; } }');
  });
});
