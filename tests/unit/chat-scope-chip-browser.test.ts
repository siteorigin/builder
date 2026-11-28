/**
 * A long entry title gives way inside the composer's scope chip, not the suffix that says what the scope is (#1334), in
 * a real browser with the real Chat.css: "Buying Historic Stone Houses in the Luberon · this post" keeps "this post"
 * whole, while a selection's long page name still gives way before its short "everywhere" suffix is cut.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Read, not imported: Vitest hands a stylesheet's ?raw import over empty.
const css = readFileSync(resolve("src/renderer/src/panels/Chat.css"), "utf8");
const browserInstalled = existsSync(chromium.executablePath());
const TITLE = "Buying Historic Stone Houses in the Luberon";

const chip = (extra: string, name: string, where: string) =>
  `<span class="chip scope-chip${extra}"><svg></svg><span class="ellipsis">${name}</span><span class="scope-where ellipsis">${where}</span></span>`;
const page = (width: number) => `<!doctype html><style>${css}
  body { margin: 0; font: 13px/1.5 sans-serif; }
  .ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .composer { width: ${width}px; } .composer-context { display: flex; }
</style><div class="composer"><div class="composer-context">${chip(" keep-where", TITLE, "this post")}</div>
<div class="composer-context">${chip("", "Selected heading", "A page with a very long name that cannot fit anywhere")}</div></div>`;

describe.skipIf(!browserInstalled)("composer scope chip, in a browser", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: chromium.executablePath(),
    });
  });
  afterAll(async () => {
    await browser?.close();
  });

  for (const width of [200, 240, 280])
    it(`keeps the suffix whole beside a long title at ${width}px`, async () => {
      const tab = await browser.newPage();
      try {
        await tab.setContent(page(width));
        const r = await tab.evaluate<{
          whereClipped: boolean;
          nameClipped: boolean;
          otherWhereWidth: number;
          fits: boolean;
        }>(`(() => {
          const [post, sel] = [...document.querySelectorAll('.scope-chip')];
          const where = post.querySelector('.scope-where'), name = post.querySelector('.ellipsis');
          return {
            whereClipped: where.scrollWidth > where.clientWidth,
            nameClipped: name.scrollWidth > name.clientWidth,
            otherWhereWidth: sel.querySelector('.scope-where').getBoundingClientRect().width,
            fits: post.getBoundingClientRect().right <= document.querySelector('.composer').getBoundingClientRect().right + 0.5,
          };
        })()`);
        expect(r.whereClipped).toBe(false);
        expect(r.nameClipped).toBe(true);
        expect(r.fits).toBe(true);
        // Unchanged for every other chip: its secondary text still gives way first, down to its floor.
        expect(r.otherWhereWidth).toBeGreaterThan(0);
      } finally {
        await tab.close();
      }
    });
});
