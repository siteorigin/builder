/**
 * The "Check the alt text" note in an image's details, in a real browser (issue #869). The note is a two-column grid
 * whose wrapper has no box of its own, so its list of places is a grid item too: left alone it lands in the 14px icon
 * column and crushes every row. The list has to take the note's whole width, and each row has to read in full at the
 * right panel's default and narrowest widths.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PANEL_DEFAULTS, PANEL_LIMITS } from '../../src/renderer/src/lib/layout';

const browserInstalled = existsSync(chromium.executablePath());
const css = ['styles/tokens.css', 'styles/reset.css', 'styles/primitives.css', 'styles/layout.css', 'panels/AssetsPanel.css']
  .map((f) => readFileSync(resolve('src/renderer/src', f), 'utf8'))
  .join('\n');

const icon = (extra = '') => `<svg ${extra} viewBox="0 0 24 24" aria-hidden="true"></svg>`;

interface Row {
  where: string;
  what: string;
  alt: string;
  /** A place that can be shown is a button with a chevron; one that can't is a plain row. */
  go: boolean;
}

const ROWS: Row[] = [
  { where: 'Home', what: 'Content with image', alt: 'No alt text', go: true },
  { where: 'Header and footer on every page', what: 'Gallery with captions · Photo 12 of the renovated kitchen', alt: 'Kept its own: “A bright kitchen with oak cupboards and a long stone worktop”', go: true },
  { where: 'Testimonial with portrait and quotation', what: 'Starting value of Photograph', alt: 'No alt text', go: false },
  { where: 'NorthumberlandRiversideRenovationGallery', what: 'Image', alt: 'No alt text', go: true },
  { where: 'About', what: 'IMG_20260314_kitchen_renovation_final_export_v2', alt: 'Kept its own: “IMG_20260314_kitchen_renovation_final_export_v2”', go: true }
];

/** The note as AssetsPanel draws it, in a right panel of the given width whose body scrolls. */
const shell = (width: number) => `<!doctype html><html><head><style>@layer tokens, reset, base, primitives, layout, components;
${css}</style></head>
<body><aside class="dock" style="width: ${width}px; height: 700px"><div class="asset-host"><div class="panel-body" style="overflow-y: scroll"><div class="asset-detail">
  <div class="asset-note asset-alt-review" role="note">${icon('class="note-icon"')}<div>
    <span class="note-words"><b>Check the alt text in ${ROWS.length} places.</b> New kitchen shows there now, but the alt text there was written for this image, or is empty.</span>
    <ul>${ROWS.map((r) => {
      const inner = `${icon()}<span class="where">${r.where}</span><span class="what">${r.what}</span>${r.go ? icon('class="go"') : ''}`;
      return `<li>${r.go ? `<button class="asset-use">${inner}</button>` : `<span class="asset-use static">${inner}</span>`}<span class="asset-alt-text">${r.alt}</span></li>`;
    }).join('')}</ul>
    <div class="asset-note-actions"><button class="btn btn-sm btn-ghost">Done</button></div>
  </div></div>
</div></div></div></aside></body></html>`;

describe.skipIf(!browserInstalled)('the alt text check list in an image’s details, in a browser', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  });
  afterAll(async () => {
    await browser?.close();
  });

  for (const width of [PANEL_DEFAULTS.right, PANEL_LIMITS.right.min]) {
    describe(`in a ${width}px panel`, () => {
      beforeAll(async () => {
        await page.setContent(shell(width));
      });

      it('gives the list the note’s whole width, under the words and above Done', async () => {
        const box = (await page.evaluate(`(() => {
          const rect = (s) => document.querySelector(s).getBoundingClientRect().toJSON();
          return { note: rect('.asset-alt-review'), list: rect('.asset-alt-review ul'), words: rect('.note-words'), actions: rect('.asset-note-actions') };
        })()`)) as Record<'note' | 'list' | 'words' | 'actions', { left: number; right: number; top: number; bottom: number; width: number }>;
        // The note pads its content 10px a side; the list reaches 6px into that so its rows' icons line up.
        expect(box.list.width).toBeGreaterThanOrEqual(box.note.width - 20);
        expect(box.list.left).toBeGreaterThanOrEqual(box.note.left);
        expect(box.list.right).toBeLessThanOrEqual(box.note.right);
        expect(box.list.top).toBeGreaterThanOrEqual(box.words.bottom);
        expect(box.actions.top).toBeGreaterThanOrEqual(box.list.bottom);
      });

      it('shows every place, element and alt text in full', async () => {
        const clipped = await page.evaluate(`[...document.querySelectorAll('.asset-alt-review li :is(.where, .what, .asset-alt-text)')]
          .filter((el) => {
            const own = el.getBoundingClientRect();
            const list = el.closest('ul').getBoundingClientRect();
            return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 || own.left < list.left - 0.5 || own.right > list.right + 0.5;
          })
          .map((el) => el.textContent)`);
        expect(clipped).toEqual([]);
      });

      it('reads a short row on one line each for the place, the element and the alt text', async () => {
        const lines = await page.evaluate(`[...document.querySelector('.asset-alt-review li').querySelectorAll('.where, .what, .asset-alt-text')]
          .map((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
          })`);
        expect(lines).toEqual([1, 1, 1]);
      });
    });
  }
});
