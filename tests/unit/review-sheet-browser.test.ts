/**
 * The offline review sheet (#1134) opened as a client opens it: the one HTML file, alone in a folder, double-clicked
 * into a browser with no network. Real headless Chromium shows every picture at the size it was taken, with the
 * pages' titles, the widths' names, the edition's ID and the note about the live preview, and asks for nothing.
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openReviewEdition, writeReviewEdition } from '../../src/main/review-edition';
import { REVIEW_SHEET_NOTE, reviewSheet, writeReviewSheet } from '../../src/main/review-sheet';

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
    // Each page and width its own picture, told apart by colour.
    const pictures: Record<string, Buffer> = { '/ 1440': await picture(1440, 700, 200), '/ 390': await picture(390, 1200, 40), '/about/ 1440': await picture(1440, 500, 120) };
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
      shoot: async (url, width) => {
        const key = `${new URL(url).pathname} ${width}`;
        if (!pictures[key]) return { ok: false, reason: 'fonts', detail: 'Brand Sans failed.' };
        return { ok: true, png: pictures[key], height: (await sharp(pictures[key]).metadata()).height! };
      },
      work: temp('work')
    });
    const opened = await openReviewEdition(project, manifest.editionId);
    if (!opened.ok) throw new Error(opened.message);
    // The file alone, as it arrives in a client's Downloads.
    const downloads = temp('downloads');
    const file = join(downloads, 'review.html');
    expect(await writeReviewSheet(file, reviewSheet(opened.manifest, opened.picture), { fresh: true, stillOpen: () => true })).toBe('written');
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
      // Every picture decoded, at the size it was taken, each the one taken of its page at its width.
      const images = await page.evaluate<Array<{ complete: boolean; w: number; h: number; alt: string; red: number; shown: number }>>(`Promise.all([...document.images].map(async (i) => {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        const g = c.getContext('2d');
        g.drawImage(i, 0, 0, 1, 1, 0, 0, 1, 1);
        return { complete: i.complete, w: i.naturalWidth, h: i.naturalHeight, alt: i.alt, red: g.getImageData(0, 0, 1, 1).data[0], shown: Math.round(i.getBoundingClientRect().width) };
      }))`);
      expect(images.map(({ shown: _, ...rest }) => rest)).toEqual([
        { complete: true, w: 1440, h: 700, alt: 'Home, Desktop, 1440 pixels wide', red: 200 },
        { complete: true, w: 390, h: 1200, alt: 'Home, Phone, 390 pixels wide', red: 40 },
        { complete: true, w: 1440, h: 500, alt: 'About us, Desktop, 1440 pixels wide', red: 120 }
      ]);
      // The phone picture is shown no wider than a phone.
      expect(images[1].shown).toBeLessThanOrEqual(390);
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
