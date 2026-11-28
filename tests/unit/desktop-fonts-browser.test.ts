/**
 * The WOFF2 web font the importer makes of a TrueType or OpenType file (#1460), loaded by a real browser: Chromium's
 * font sanitizer takes it, and text set in it has the font's own advance widths.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sfntToWoff2 } from '../../src/main/project/woff2';

const browserInstalled = existsSync(chromium.executablePath());
const FIXTURES = join(__dirname, 'fixtures/fonts');
// A real-world TrueType font in the dependencies: Playwright's trace viewer icons.
const CODICON_DIR = 'node_modules/playwright-core/lib/vite/traceViewer';
const codicon = existsSync(CODICON_DIR) ? readdirSync(CODICON_DIR).find((f) => /^codicon.*\.ttf$/.test(f)) : undefined;

describe.skipIf(!browserInstalled)('a desktop font converted to WOFF2, in Chromium', () => {
  let browser: Browser;
  beforeAll(async () => void (browser = await chromium.launch({ headless: true })));
  afterAll(async () => void (await browser?.close()));

  /** Load `woff2` as a web font and measure `text` at 100px in it; null when the browser refuses the font. */
  async function measure(woff2: Buffer, text: string): Promise<number | null> {
    const page = await browser.newPage();
    try {
      await page.setContent('<!doctype html><canvas></canvas>');
      return await page.evaluate(
        async ({ b64, text }) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const face = new FontFace('Converted', bytes);
          try {
            await face.load();
          } catch {
            return null;
          }
          document.fonts.add(face);
          const ctx = document.querySelector('canvas')!.getContext('2d')!;
          ctx.font = '100px Converted';
          return ctx.measureText(text).width;
        },
        { b64: woff2.toString('base64'), text }
      );
    } finally {
      await page.close();
    }
  }

  for (const file of ['fixture-sans-bold.ttf', 'fixture-sans-bold.otf']) {
    it(`loads ${file} with its own glyph widths`, async () => {
      // The fixture's "A" is 900 units wide in a 1000-unit em, its space 250.
      expect(await measure(await sfntToWoff2(readFileSync(join(FIXTURES, file))), 'A A')).toBeCloseTo(205, 0);
    });
  }

  it.skipIf(!codicon)('loads a real TrueType icon font', async () => {
    const width = await measure(await sfntToWoff2(readFileSync(join(CODICON_DIR, codicon!))), '');
    expect(width).not.toBeNull();
    expect(width!).toBeGreaterThan(0);
  });
});
