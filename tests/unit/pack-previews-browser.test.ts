/**
 * Insert's theme thumbnails, drawn as a pack build draws them (scripts/packs/previews.ts), in a real browser
 * (#905): a block such as a Stat card is shown at the width of the column it goes in and framed around what it
 * paints, and the Article header is shown with an article's date, byline and excerpt, so each fills its tile
 * rather than leaving a speck of content in the corner of a whole desktop window.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { getTheme } from '@catalogue/index';
import { generateProject, pageFile } from '@generator/index';
import { packFileInfo } from '../../src/main/packs/files';
import { frameOf, inkBoundsSource, previewHtml, previewProject, renderPreviews } from '../../scripts/packs/previews';
import { restorePacks } from './fixtures/packs';

const browserInstalled = existsSync(chromium.executablePath());
const dirs: string[] = [];
afterAll(async () => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  // Drawing thumbnails registers the pack it draws alone.
  await restorePacks();
});

/** Foundation as the app loads it, and where its font files are, as a pack build hands them to the drawing. */
function foundation() {
  const pack = getTheme('foundation');
  const files = new Map(pack.fonts.flatMap((f) => f.faces).map((face) => [face.file, packFileInfo(pack.id, face.file)!.abs]));
  return { pack, files };
}

/** The share of the thumbnail's width and height that its content covers: what differs from the corner's colour. */
async function coverage(webp: Buffer): Promise<{ width: number; height: number }> {
  const { data, info } = await sharp(webp).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => (y * info.width + x) * info.channels;
  const bg = [data[0], data[1], data[2]];
  let [x0, y0, x1, y1] = [info.width, info.height, -1, -1];
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = at(x, y);
      if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) <= 24) continue;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  return x1 < 0 ? { width: 0, height: 0 } : { width: (x1 - x0 + 1) / info.width, height: (y1 - y0 + 1) / info.height };
}

describe('the pages theme thumbnails are drawn from', () => {
  it('give the Article header an article to show, kept out of the post lists beside it', () => {
    const { pack } = foundation();
    const { state, cases } = previewProject(pack);
    const header = cases.find((c) => c.componentId === 'content.article' && !c.axis)!;
    expect(state.pages[header.pageId].article).toMatchObject({ byline: expect.any(String), excerpt: expect.any(String), hidden: true });
    const html = generateProject(state).get(pageFile(state.pages[header.pageId]))!;
    expect(html).toContain('By the studio team');
    // Blocks are marked so they are shown at a column's width; sections are not.
    expect(cases.find((c) => c.componentId === 'block.stat')?.block).toBe(true);
    expect(header.block).toBe(false);
    // Post sections list a few published posts, and news lists a few listed articles.
    const list = cases.find((c) => c.componentId === 'blog.list' && !c.axis)!;
    expect(generateProject(state).get(pageFile(state.pages[list.pageId]))).toContain('How we plan a first visit');
    const news = cases.find((c) => c.componentId === 'content.news' && !c.axis)!;
    expect(generateProject(state).get(pageFile(state.pages[news.pageId]))).toContain('A season of new projects');
  });
});

describe.skipIf(!browserInstalled)('theme thumbnails', () => {
  it('frame a tall block whole, from its top to its last button', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 1 });
      for (const height of [180, 520, 760]) {
        await page.setContent(previewHtml('', '', `<div id="block" style="height:${height}px;border:1px solid #333;background:#eee"></div>`, true));
        const block: { y: number; bottom: number } = await page.evaluate(`document.getElementById('block').getBoundingClientRect().toJSON()`);
        const frame = await frameOf(page, inkBoundsSource(), true);
        expect(frame.y, `${height}px tall`).toBeLessThanOrEqual(block.y);
        expect(frame.y + frame.height, `${height}px tall`).toBeGreaterThanOrEqual(block.bottom);
        expect(frame.width / frame.height).toBeCloseTo(1.6, 1);
      }
    } finally {
      await browser.close();
    }
  });

  it('fill the frame with a block and with a short section', async () => {
    const { pack, files } = foundation();
    const shown = new Set(['block.stat', 'block.feature', 'block.signup', 'content.article', 'blog.list']);
    const small = { ...pack, components: pack.components.filter((c) => shown.has(c.componentId!) || c.category === 'shell') };
    const cache = mkdtempSync(join(tmpdir(), 'so-pack-previews-test-'));
    dirs.push(cache);
    const { previews, bytes } = await renderPreviews(small, files, cache, { require: true });
    for (const id of shown) {
      const file = previews[id]?.default;
      expect(file, id).toBeTruthy();
      const meta = await sharp(bytes.get(file)!).metadata();
      expect([meta.width, meta.height], id).toEqual([320, 200]);
      const c = await coverage(bytes.get(file)!);
      // Before, a Stat card covered the window's width and a tenth of its height, and the Article header a third.
      expect(c.width, `${id} across: ${JSON.stringify(c)}`).toBeGreaterThan(0.5);
      expect(c.height, `${id} down: ${JSON.stringify(c)}`).toBeGreaterThan(0.4);
    }
  }, 120_000);
});
