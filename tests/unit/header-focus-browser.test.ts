/**
 * Focus under Foundation's sticky site header (#1544), in a real headless browser: the showcase's exported header and
 * page, mounted with the theme's stylesheets. A browser leaves an element it counts as on screen where it is, even
 * when the header covers it, so what takes keyboard focus has to come to rest below the header: walking back through
 * a page with Shift+Tab never leaves the focused element under it. The header's own links never move the page.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { generateProject } from '@generator/index';
import { bundle } from './generated-site';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://focus.test';
const THEMES = ['foundation', 'foundation-alt'];
const ROUTES = ['pricing', 'contact'];

/** The exported layout with one route's page inside it, as a single component the bundle can mount. */
function sitePage(files: Map<string, string>, route: string): Map<string, string> {
  const layout = files
    .get('src/routes/+layout.svelte')!
    // The stylesheets go in the page, and keeping typed drafts needs SvelteKit's router.
    .replace(/^\s*import '[^']+\.css';\n/gm, '')
    .replace(/^.*keepDrafts.*\n/gm, '')
    .replace("import { page } from '$app/state';", `import Body from './${route}/+page.svelte';\n\timport { page } from '$app/state';`)
    .replace('{@render children()}', '<Body />')
    .replace('let { children } = $props();', '');
  // The header reads the address it is on from SvelteKit, which this page has none of.
  const here = `const page = { url: new URL('${ORIGIN}/${route}/'), route: { id: '/${route}' } };`;
  return new Map([...files, ['src/routes/+page.svelte', layout]].map(([path, source]) => [path, source.replace(/import \{ page \} from '\$app\/state';/, here)]));
}

describe.skipIf(!browserInstalled)('Focus under the sticky site header', () => {
  let browser: Browser;
  const sites = new Map<string, { script: string; css: string }>();
  beforeAll(async () => {
    for (const theme of THEMES) {
      const files = generateProject(createStarterState('showcase', 'Focus Studio', false, theme));
      const css = ['tokens', 'theme', 'components', 'site'].map((f) => files.get(`src/lib/siteorigin/styles/${f}.css`) ?? '').join('\n');
      for (const route of ROUTES) {
        const site = sitePage(files, route);
        sites.set(`${theme}/${route}`, { script: await bundle(site, site), css });
      }
      // The same Pricing page under a header with a notice that links somewhere.
      const noticed = sitePage(files, 'pricing');
      noticed.set('src/routes/+page.svelte', noticed.get('src/routes/+page.svelte')!.replace('notice={""}', 'notice={"Now booking."}').replace('noticeLabel={""}', 'noticeLabel={"See dates"}').replace('noticeLink={null}', 'noticeLink={{"href":"/contact/"}}'));
      sites.set(`${theme}/notice`, { script: await bundle(noticed, noticed), css });
    }
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function open(theme: string, route: string, width: number, reducedMotion: 'reduce' | 'no-preference' = 'reduce'): Promise<Page> {
    const { script, css } = sites.get(`${theme}/${route}`)!;
    // Reduced motion turns smooth scrolling off, so each focus has finished scrolling by the next frame.
    const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion });
    await page.route('**/*', (r) => {
      const url = new URL(r.request().url());
      if (url.origin === ORIGIN && url.pathname === '/app.js') return r.fulfill({ contentType: 'text/javascript', body: script });
      if (url.origin === ORIGIN && url.pathname === '/') {
        return r.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en" class="so-js"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="app"></div></body></html>` });
      }
      return r.abort();
    });
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ url: '/app.js', type: 'module' });
    await page.waitForFunction('typeof window.startSite === "function"');
    await page.evaluate(`window.startSite('dev')`);
    await page.waitForFunction(`parseFloat(document.documentElement.style.getPropertyValue('--so-header-offset')) > 0`);
    // The page's layout has settled once its height holds still: sections lay themselves out again as they start.
    await page.waitForFunction(`(() => {
      const height = document.documentElement.scrollHeight;
      window.still = height === window.lastHeight ? window.still + 1 : 0;
      window.lastHeight = height;
      return window.still >= 5;
    })()`);
    return page;
  }

  const frames = (page: Page) => page.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`);

  /** Shift+Tab from the end of the page up to the header: how many stops there were, and those the header covers. */
  async function walkBack(page: Page): Promise<{ stops: number; covered: string[] }> {
    await page.evaluate(`(() => { const end = document.createElement('button'); end.id = 'end'; document.body.append(end); end.focus(); })()`);
    const covered: string[] = [];
    let stops = 0;
    while (stops < 400) {
      await page.keyboard.press('Shift+Tab');
      await frames(page);
      const at = (await page.evaluate(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el.closest('.so-header, .so-skip-link')) return null;
        const box = el.getBoundingClientRect();
        const header = document.querySelector('.so-header').getBoundingClientRect().bottom;
        return { name: el.tagName + ' ' + (el.textContent || el.getAttribute('name') || '').trim().slice(0, 40), top: box.top, height: box.height, header, room: innerHeight - header };
      })()`)) as { name: string; top: number; height: number; header: number; room: number } | null;
      if (!at) break;
      stops++;
      if (at.height <= at.room && at.top < at.header - 0.5) covered.push(`${at.name} at ${Math.round(at.top)}, header ends at ${Math.round(at.header)}`);
    }
    return { stops, covered };
  }

  describe.each(THEMES)('%s', (theme) => {
    it.each([
      ['pricing', 1280],
      ['pricing', 390],
      ['contact', 390]
    ])('walking back through %s at %ipx never leaves focus under the header', async (route, width) => {
      const page = await open(theme, route, width);
      try {
        const { stops, covered } = await walkBack(page);
        expect(stops).toBeGreaterThan(8);
        expect(covered).toEqual([]);
      } finally {
        await page.close();
      }
    });

    // A browser that has to bring an element in from off screen clears the header by itself; one already on screen,
    // behind the header, it only moves for the target's scroll margin.
    it.each([
      ['pricing', 1280, 'Talk to us', 'a[href]', 1],
      ['pricing', 1280, 'Talk to us', 'a[href]', 0.5],
      ['contact', 390, 'consultation visit', 'summary', 0.5]
    ])('on %s at %ipx, Shift+Tab brings “%s” (%s) out from under the header when %s of it is covered', async (route, width, label, selector, share) => {
      const page = await open(theme, route, width);
      try {
        // Focus starts on the control after the target, with the target scrolled that far under the header.
        const covered = (await page.evaluate(`(() => {
          const all = [...document.querySelectorAll('main a[href], main button, main summary, main input, main select, main textarea, footer a[href]')];
          const at = all.findIndex((el) => el.matches('${selector}') && el.textContent.includes('${label}'));
          window.target = all[at];
          all[at + 1].focus({ preventScroll: true });
          const header = document.querySelector('.so-header').getBoundingClientRect().bottom;
          scrollBy(0, target.getBoundingClientRect().top - (header - target.offsetHeight * ${share}));
          const box = target.getBoundingClientRect();
          return (Math.min(header, box.bottom) - box.top) / box.height;
        })()`)) as number;
        expect(covered).toBeCloseTo(share, 1);
        await page.keyboard.press('Shift+Tab');
        await frames(page);
        expect(await page.evaluate(`document.activeElement === target`)).toBe(true);
        const [top, header] = (await page.evaluate(`[target.getBoundingClientRect().top, document.querySelector('.so-header').getBoundingClientRect().bottom]`)) as number[];
        expect(top).toBeGreaterThanOrEqual(header);
      } finally {
        await page.close();
      }
    });

    it('brings a covered control out from under the header with smooth scrolling too', async () => {
      const page = await open(theme, 'pricing', 1280, 'no-preference');
      try {
        await page.evaluate(`(() => {
          const [first, second] = [...document.querySelectorAll('main a[href]')].slice(-2);
          window.target = first;
          second.focus({ preventScroll: true });
          scrollTo({ top: first.getBoundingClientRect().top + scrollY - 20, behavior: 'instant' });
        })()`);
        await page.keyboard.press('Shift+Tab');
        await expect.poll(() => page.evaluate(`document.activeElement === target && target.getBoundingClientRect().top >= document.querySelector('.so-header').getBoundingClientRect().bottom`)).toBe(true);
      } finally {
        await page.close();
      }
    });

    it('lands a jump to an anchor below the header, by the margin it always had', async () => {
      const page = await open(theme, 'pricing', 1280);
      try {
        await page.evaluate(`(() => { window.target = document.querySelector('main').children[1]; target.id = 'jump'; location.hash = 'jump'; })()`);
        await frames(page);
        const [top, header] = (await page.evaluate(`[target.getBoundingClientRect().top, document.querySelector('.so-header').getBoundingClientRect().bottom]`)) as number[];
        // 1rem below, or 2rem where two sections of one tone meet: never the header's height twice over.
        expect(top - header).toBeGreaterThanOrEqual(15);
        expect(top - header).toBeLessThanOrEqual(33);
      } finally {
        await page.close();
      }
    });

    it('shows the notice’s link when Shift+Tab reaches it on a scrolled page, without moving the page', async () => {
      const page = await open(theme, 'notice', 1280);
      try {
        await page.evaluate(`scrollTo(0, 900)`);
        await page.evaluate(`document.querySelector('.so-header__brand').focus()`);
        await page.keyboard.press('Shift+Tab');
        await frames(page);
        const at = () => page.evaluate(`[document.activeElement.matches('.so-header__notice-action'), document.querySelector('.so-header__notice-link').getBoundingClientRect().top, scrollY]`) as Promise<[boolean, number, number]>;
        const [onLink, top, y] = await at();
        expect(onLink).toBe(true);
        expect(top).toBeGreaterThanOrEqual(0);
        // The link's box reaches the band's edges, a fraction past the header's own top, so allow that.
        expect(Math.abs(y - 900)).toBeLessThanOrEqual(1);
        // On to the brand, and the notice is away again above the window.
        await page.keyboard.press('Tab');
        await frames(page);
        expect(await page.evaluate(`document.querySelector('.so-header__notice').getBoundingClientRect().bottom`)).toBeLessThanOrEqual(1);
      } finally {
        await page.close();
      }
    });

    it.each([1280, 390])('leaves the page where it is while focus moves through the header at %ipx', async (width) => {
      const page = await open(theme, 'pricing', width);
      try {
        await page.evaluate(`scrollTo(0, 900)`);
        await page.evaluate(`document.querySelector('.so-header__brand').focus()`);
        await frames(page);
        expect(await page.evaluate(`scrollY`)).toBe(900);
        // At phone width the links are in the menu, which is opened first.
        if (width < 500) {
          await page.keyboard.press('Tab');
          await page.keyboard.press('Enter');
          await frames(page);
        }
        for (let i = 0; i < 4; i++) {
          await page.keyboard.press('Tab');
          await frames(page);
          expect(await page.evaluate(`Boolean(document.activeElement.closest('.so-header'))`)).toBe(true);
          expect(await page.evaluate(`scrollY`)).toBe(900);
        }
      } finally {
        await page.close();
      }
    });
  });
});
