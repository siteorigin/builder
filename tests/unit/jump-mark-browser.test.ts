/**
 * Site Styles' jump links mark one section at a time (issue #1142). A click on a short section near the end (Yours)
 * left the scroll marking the section above it, while the pointer still over the clicked link gave that one the same
 * accent fill, so two links read as current.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextMark, sectionAtLine, startMark, type JumpEvent, type JumpMark } from '../../src/renderer/src/lib/jump-mark';

const COUNT = 6;
// Six sections; Yours (4) and Site (5) are short and sit at the end, so no scroll brings Yours to the line at 300.
const tops = (scroll: number) => [0, 400, 900, 1500, 1600, 1700].map((t) => t - scroll);
const scrollTo = (scroll: number, atEnd = false): JumpEvent => ({ type: 'scroll', tops: tops(scroll), line: 300, atEnd, count: COUNT });
const run = (events: JumpEvent[], from: JumpMark = startMark) => events.reduce(nextMark, from);

describe('the jump links mark', () => {
  it('the section that owns the reading line, and the last one at the end of the scroll', () => {
    expect(sectionAtLine(tops(0), 300, false, COUNT)).toBe(0);
    expect(sectionAtLine(tops(700), 300, false, COUNT)).toBe(2);
    expect(sectionAtLine(tops(1250), 300, true, COUNT)).toBe(5);
    expect(sectionAtLine([], 300, false, 0)).toBe(0);
  });

  it('the clicked section through the scroll it starts, even where the scroll alone would mark another', () => {
    // Yours clicked: the smooth scroll passes through Colors and Text and stops with Layout on the line.
    const mark = run([scrollTo(0), { type: 'jump', index: 4 }, scrollTo(300), scrollTo(800), scrollTo(1250)]);
    expect(mark.here).toBe(4);
  });

  it('the scroll again once the author scrolls on their own', () => {
    const held = run([{ type: 'jump', index: 4 }, scrollTo(1250)]);
    expect(run([{ type: 'input' }, scrollTo(1240)], held).here).toBe(3);
    expect(run([{ type: 'input' }, scrollTo(0)], held).here).toBe(0);
  });

  it('a later click over an earlier one', () => {
    expect(run([{ type: 'jump', index: 4 }, scrollTo(1250), { type: 'jump', index: 1 }, scrollTo(500)]).here).toBe(1);
  });

  it('a plain scroll as before when no link was clicked', () => {
    expect(run([scrollTo(300), scrollTo(700)]).here).toBe(2);
    expect(run([scrollTo(1250, true)]).here).toBe(5);
  });
});

const browserInstalled = existsSync(chromium.executablePath());
const css = [...['tokens.css', 'reset.css'].map((f) => resolve('src/renderer/src/styles', f)), resolve('src/renderer/src/panels/Inspector.css'), resolve('src/renderer/src/panels/SiteStyles.css')]
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');
const labels = ['Basics', 'Colors', 'Text', 'Layout', 'Yours', 'Site'];
const bar = (current: number) =>
  `<!doctype html><html><head><style>${css}</style></head><body><div class="panel-body ss"><div class="insp-head ss-head"><nav class="insp-jump">${labels
    .map((l, i) => `<button type="button" id="j${i}"${i === current ? ` aria-current="location"` : ''}>${l}</button>`)
    .join('')}</nav></div></div></body></html>`;

describe.skipIf(!browserInstalled)('the jump links in a browser', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
    page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  });
  afterAll(async () => {
    await browser?.close();
  });

  const look = (id: string) =>
    page.evaluate((sel) => {
      const s = getComputedStyle(document.querySelector(sel)!);
      return { background: s.backgroundColor, color: s.color, weight: s.fontWeight };
    }, `#${id}`);

  it('give a hovered link a look of its own, apart from the current one', async () => {
    await page.setContent(bar(2));
    const current = await look('j2');
    const resting = await look('j4');
    await page.hover('#j4');
    const hovered = await look('j4');
    expect(hovered.background).not.toBe(current.background);
    expect(hovered.color).not.toBe(current.color);
    expect(hovered.weight).not.toBe(current.weight);
    // Hover still answers the pointer.
    expect(hovered.background).not.toBe(resting.background);
  });

  it('keep the current link marked while the pointer is over it', async () => {
    await page.setContent(bar(2));
    const before = await look('j2');
    await page.hover('#j2');
    expect(await look('j2')).toEqual(before);
  });
});
