/**
 * The keyboard focus ring inside Foundation's phone and compact menus (#1379), in a real headless browser: the
 * showcase's exported header with no action button, so the list of links is the menu's last child. The open
 * menu never scrolls sideways, and every control in it keeps its whole focus outline inside the menu's box.
 */
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStarterState } from "@catalogue/starters";
import { generateProject } from "@generator/index";
import { bundle } from "./generated-site";

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = "http://menu-focus.test";
const THEMES = ["foundation", "foundation-alt"];

/** The exported layout around the Pricing page, as one component, with no action in the header. */
function sitePage(
  files: Map<string, string>,
  compact: boolean,
): Map<string, string> {
  let layout = files
    .get("src/routes/+layout.svelte")!
    .replace(/^\s*import '[^']+\.css';\n/gm, "")
    .replace(/^.*keepDrafts.*\n/gm, "")
    .replace(
      "import { page } from '$app/state';",
      `import Body from './pricing/+page.svelte';\n\timport { page } from '$app/state';`,
    )
    .replace("{@render children()}", "<Body />")
    .replace("let { children } = $props();", "");
  layout = layout.replace(/ctaLabel=\{"[^"]*"\}/, 'ctaLabel={""}');
  if (!layout.includes('ctaLabel={""}'))
    throw new Error(
      "The showcase layout no longer passes the header an action label",
    );
  // Long labels leave a tablet's row too narrow for the links on one line, so the header folds into its compact menu.
  if (compact)
    layout = layout.replace(
      /"label":"([^"]+)"/g,
      '"label":"$1 and everything else we make for you"',
    );
  const here = `const page = { url: new URL('${ORIGIN}/pricing/'), route: { id: '/pricing' } };`;
  return new Map(
    [...files, ["src/routes/+page.svelte", layout]].map(([path, source]) => [
      path,
      source.replace(/import \{ page \} from '\$app\/state';/, here),
    ]),
  );
}

describe.skipIf(!browserInstalled)(
  "Focus rings in the header menu without an action",
  () => {
    let browser: Browser;
    const sites = new Map<string, { script: string; css: string }>();
    beforeAll(async () => {
      for (const theme of THEMES) {
        const files = generateProject(
          createStarterState("showcase", "Focus Studio", false, theme),
        );
        const css = ["tokens", "theme", "components", "site"]
          .map((f) => files.get(`src/lib/siteorigin/styles/${f}.css`) ?? "")
          .join("\n");
        for (const compact of [false, true]) {
          const site = sitePage(files, compact);
          sites.set(`${theme}/${compact}`, {
            script: await bundle(site, site),
            css,
          });
        }
      }
      browser = await chromium.launch({
        headless: true,
        executablePath: chromium.executablePath(),
      });
    }, 180_000);
    afterAll(async () => {
      await browser?.close();
    });

    async function open(
      theme: string,
      compact: boolean,
      width: number,
      height: number,
    ): Promise<Page> {
      const { script, css } = sites.get(`${theme}/${compact}`)!;
      const page = await browser.newPage({
        viewport: { width, height },
        reducedMotion: "reduce",
      });
      await page.route("**/*", (r) => {
        const url = new URL(r.request().url());
        if (url.origin === ORIGIN && url.pathname === "/app.js")
          return r.fulfill({ contentType: "text/javascript", body: script });
        if (url.origin === ORIGIN && url.pathname === "/") {
          return r.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html lang="en" class="so-js"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="app"></div></body></html>`,
          });
        }
        return r.abort();
      });
      await page.goto(`${ORIGIN}/`);
      await page.addScriptTag({ url: "/app.js", type: "module" });
      await page.waitForFunction('typeof window.startSite === "function"');
      await page.evaluate(`window.startSite('dev')`);
      await page.waitForFunction(
        `parseFloat(document.documentElement.style.getPropertyValue('--so-header-offset')) > 0`,
      );
      return page;
    }

    const frames = (page: Page) =>
      page.evaluate(
        `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`,
      );

    describe.each(THEMES)("%s", (theme) => {
      // The last two cases narrow the theme's gutter to 16 px, which leaves the menu's rows less than a focus ring's room.
      it.each([
        [false, 320, 720, ""],
        [false, 390, 844, ""],
        [true, 820, 1180, ""],
        [false, 320, 720, "16px"],
        [true, 820, 1180, "16px"],
      ])(
        "compact %s, %ipx: each focused control in the open menu keeps its whole outline inside it %s",
        async (compact, width, height, gutter) => {
          const page = await open(theme, compact, width, height);
          try {
            if (gutter)
              await page.evaluate(
                `document.documentElement.style.setProperty('--so-container-gutter', '${gutter}')`,
              );
            if (compact)
              await expect
                .poll(() =>
                  page.evaluate(
                    `document.querySelector('.so-header').classList.contains('so-header--compact')`,
                  ),
                )
                .toBe(true);
            expect(
              await page.evaluate(
                `!!document.querySelector('.so-header__cta')`,
              ),
            ).toBe(false);
            // Open the menu from the keyboard, as a visitor does, then walk its controls with Tab.
            await page.focus(".so-header__toggle");
            await page.keyboard.press("Enter");
            await frames(page);
            const nav = (await page.evaluate(
              `(() => { const nav = document.querySelector('.so-header__nav'); return { scroll: nav.scrollWidth, client: nav.clientWidth, shown: getComputedStyle(nav).display !== 'none' }; })()`,
            )) as { scroll: number; client: number; shown: boolean };
            expect(nav.shown).toBe(true);
            expect(nav.scroll).toBeLessThanOrEqual(nav.client);
            // A row of links pulls its ends out only beside the open row's words, never in the column menu.
            expect(
              await page.evaluate(
                `getComputedStyle(document.querySelector('.so-header__list')).marginInlineEnd`,
              ),
            ).toBe("0px");
            // The controls the open menu shows, which Tab has to reach every one of.
            const controls = (await page.evaluate(
              `[...document.querySelectorAll('.so-header__nav :is(a[href], button)')].filter((el) => el.getClientRects().length).length`,
            )) as number;
            const clipped: string[] = [];
            let visited = 0;
            for (let press = 0; press < 40; press++) {
              await page.keyboard.press("Tab");
              await frames(page);
              const at = (await page.evaluate(`(() => {
            const el = document.activeElement;
            const nav = document.querySelector('.so-header__nav');
            if (!el || !nav.contains(el)) return null;
            const style = getComputedStyle(el);
            const ring = el.matches(':focus-visible') && style.outlineStyle !== 'none' ? parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset) : 0;
            const box = el.getBoundingClientRect();
            const frame = nav.getBoundingClientRect();
            // The menu scrolls, so it clips at its padding box: inside its borders, and inside the window.
            const left = Math.max(0, frame.left + nav.clientLeft);
            const right = Math.min(document.documentElement.clientWidth, frame.left + nav.clientLeft + nav.clientWidth);
            return { name: el.tagName + ' ' + (el.textContent || '').trim().slice(0, 30), ring, left: box.left - ring - left, right: right - (box.right + ring) };
          })()`)) as {
                name: string;
                ring: number;
                left: number;
                right: number;
              } | null;
              if (!at) break;
              visited++;
              expect(at.ring).toBeGreaterThan(0);
              if (at.left < -0.5 || at.right < -0.5)
                clipped.push(
                  `${at.name}: ${at.left.toFixed(1)}px start, ${at.right.toFixed(1)}px end`,
                );
            }
            expect(controls).toBeGreaterThan(2);
            expect(visited).toBe(controls);
            expect(clipped).toEqual([]);
          } finally {
            await page.close();
          }
        },
      );
    });
  },
);
