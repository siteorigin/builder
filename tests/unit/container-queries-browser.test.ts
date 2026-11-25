/**
 * Container queries in real headless browsers (#667): the exported Home page, rendered on the server as the static
 * site ships it and shown with its own stylesheets and no script at all, places one Media Card in a wide 2fr column
 * and a narrow 1fr column, both as page columns and as the two slots of a project split layout. At one 1280px desktop
 * screen each wide card stays side by side and each narrow card stacks; a card with no query container around it
 * keeps its desktop row. The columns keep the width their grid gives them (a query container never sizes itself from
 * its content) and a sticky one still sticks.
 */
import { existsSync } from 'node:fs';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ElementNode } from '@shared/types';
import { makeInstance } from '@engine/install';
import { STYLES_DIR, generateProject } from '@generator/index';
import { removeRendered, serverHtml } from './generated-site';
import { containerSite } from './container-queries';

const ENGINES = ([['chromium', chromium], ['webkit', webkit]] as Array<[string, BrowserType]>).filter(([, engine]) => existsSync(engine.executablePath()));

/** The site above, with the page's sidebar column sticky beside a tall main column, and one more card on its own. */
async function site() {
  const { s, card } = containerSite();
  const home = s.pages[s.site.homePageId];
  (home.nodes.n_main as ElementNode).styles!.base!.minHeight = '2000px';
  Object.assign((home.nodes.n_side as ElementNode).styles!.base!, { position: 'sticky', inset: '0px auto auto auto', alignSelf: 'start' });
  const alone = makeInstance(card, { title: 'No container' });
  home.nodes[alone.id] = alone;
  home.rootIds.push(alone.id);
  const files = generateProject(s);
  const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  const html = await serverHtml(files, 'container-queries-');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`;
}

/** How the card titled `title` is laid out: its direction, its box and its column's, and where its title sits beside its picture. */
const cardLayout = (page: Page, title: string) =>
  page.evaluate((title) => {
    const heading = [...document.querySelectorAll('h3')].find((h) => h.textContent?.trim() === title);
    if (!heading) throw new Error(`No card titled ${title}`);
    const card = heading.parentElement!;
    const media = card.firstElementChild!.getBoundingClientRect();
    const text = heading.getBoundingClientRect();
    const column = card.parentElement!.getBoundingClientRect();
    return {
      direction: getComputedStyle(card).flexDirection,
      column: Math.round(column.width),
      columnTop: Math.round(column.top),
      beside: text.left >= media.right - 0.5 && Math.abs(text.top - media.top) < 1,
      below: text.top >= media.bottom - 0.5
    };
  }, title);

if (!ENGINES.length) describe.skip('container queries in a browser (needs Chromium or WebKit)', () => it('runs in a browser', () => {}));

describe.each(ENGINES)('container queries in %s', (_name, engine) => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const doc = await site();
    browser = await engine.launch({ headless: true, executablePath: engine.executablePath(), timeout: 30_000 });
    // No script at all: the static page and its stylesheets alone.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, javaScriptEnabled: false });
    page = await context.newPage();
    await page.setContent(doc);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    removeRendered();
  });

  it('lays one card out side by side in the wide column and stacked in the narrow one, at one desktop width', async () => {
    const main = await cardLayout(page, 'Main column');
    const side = await cardLayout(page, 'Sidebar column');
    expect(main).toMatchObject({ direction: 'row', column: 800, beside: true, below: false });
    expect(side).toMatchObject({ direction: 'column', column: 400, beside: false, below: true });
  });

  it('does the same in a layout component’s wide and narrow slots', async () => {
    expect(await cardLayout(page, 'Main slot')).toMatchObject({ direction: 'row', column: 800, beside: true });
    expect(await cardLayout(page, 'Sidebar slot')).toMatchObject({ direction: 'column', column: 400, below: true });
  });

  it('keeps the desktop layout where no query container is around the card', async () => {
    expect(await cardLayout(page, 'No container')).toMatchObject({ direction: 'row', beside: true });
  });

  it('keeps a sticky query container stuck while its row scrolls by', async () => {
    // Well into the 2000px main column, short of its end.
    await page.evaluate(() => window.scrollTo(0, 600));
    const main = await cardLayout(page, 'Main column');
    const side = await cardLayout(page, 'Sidebar column');
    expect(main.columnTop).toBeLessThanOrEqual(-600);
    expect(side).toMatchObject({ columnTop: 0, direction: 'column', column: 400 });
    await page.evaluate(() => window.scrollTo(0, 0));
  });
});
