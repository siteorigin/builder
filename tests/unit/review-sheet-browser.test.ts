/**
 * The offline review sheet (#1134) opened as a client opens it: the one HTML file, alone in a folder, double-clicked
 * into a browser with no network. Real headless Chromium shows every picture at the size it was taken, with the
 * pages' titles, the widths' names, the edition's ID and the note about the live preview, and asks for nothing.
 */
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readReviewEdition, writeReviewEdition } from '../../src/main/review-edition';
import { REVIEW_SHEET_NOTE, reviewSheetHtml } from '../../src/main/review-sheet';

const browserInstalled = existsSync(chromium.executablePath());
const dirs: string[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-sheet-${name}-`)));
  dirs.push(d);
  return d;
};
let browser: Browser;
beforeAll(async () => {
  if (browserInstalled) browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A picture `width` × `height` of one colour. */
const picture = (width: number, height: number, r: number) => sharp({ create: { width, height, channels: 3, background: { r, g: 80, b: 160 } } }).png().toBuffer();

describe.runIf(browserInstalled)('the offline review sheet in a browser', () => {
  it('opens from disk with no network and shows every picture, title, width and the edition ID', async () => {
    const project = temp('project');
    const site = temp('site');
    writeFileSync(join(site, 'index.html'), '<h1>Home</h1>');
    const pictures: Record<number, Buffer> = { 1440: await picture(1440, 700, 200), 390: await picture(390, 1200, 40) };
    const { manifest } = await writeReviewEdition({
      projectDir: project,
      site,
      // Never opened: the pictures come from the stand-in below.
      server: 'http://127.0.0.1:9/',
      siteName: 'Bookshop',
      basePath: '',
      revision: 4,
      pages: [
        { route: '/', title: 'Home' },
        { route: '/about/', title: 'About us' }
      ],
      widths: [
        { label: 'Desktop', width: 1440 },
        { label: 'Phone', width: 390 }
      ],
      shoot: async (url, width) => (url.endsWith('/about/') && width === 390 ? { ok: false, reason: 'fonts', detail: 'Brand Sans failed.' } : { ok: true, png: pictures[width], height: width === 1440 ? 700 : 1200 }),
      work: temp('work')
    });
    const read = await readReviewEdition(project, manifest.editionId);
    if (!read.ok) throw new Error(read.message);
    // The file alone, as it arrives in a client's Downloads.
    const downloads = temp('downloads');
    const file = join(downloads, 'review.html');
    writeFileSync(file, reviewSheetHtml(read));
    expect(readdirSync(downloads)).toEqual(['review.html']);

    const context = await browser.newContext({ offline: true, viewport: { width: 1600, height: 1000 } });
    try {
      const page = await context.newPage();
      const requests: string[] = [];
      page.on('request', (r) => requests.push(r.url()));
      const problems: string[] = [];
      page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
      page.on('pageerror', (e) => problems.push(e.message));
      const res = await page.goto(pathToFileURL(file).href);
      expect(res?.ok()).toBe(true);
      expect(await page.title()).toBe(`Bookshop – review ${manifest.editionId}`);
      const text = await page.locator('body').innerText();
      for (const words of [manifest.editionId, 'Home', 'About us', 'Desktop', 'Phone', '1440 px', '390 px', REVIEW_SHEET_NOTE, 'Not pictured. A font did not load.']) expect(text).toContain(words);
      // Every picture decoded, at the size it was taken.
      const images = await page.locator('img').evaluateAll((imgs) => (imgs as HTMLImageElement[]).map((i) => ({ complete: i.complete, w: i.naturalWidth, h: i.naturalHeight, alt: i.alt })));
      expect(images).toEqual([
        { complete: true, w: 1440, h: 700, alt: 'Home, Desktop, 1440 pixels wide' },
        { complete: true, w: 390, h: 1200, alt: 'Home, Phone, 390 pixels wide' },
        { complete: true, w: 1440, h: 700, alt: 'About us, Desktop, 1440 pixels wide' }
      ]);
      // The phone picture is shown no wider than a phone.
      expect(await page.locator('img').nth(1).evaluate((i) => i.getBoundingClientRect().width)).toBeLessThanOrEqual(390);
      // The list of pages leads to each one on the sheet itself.
      await page.getByRole('link', { name: 'About us' }).click();
      expect(page.url()).toBe(`${pathToFileURL(file).href}#page-2`);
      // Nothing was asked for but the file itself.
      expect(requests).toEqual([pathToFileURL(file).href]);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
