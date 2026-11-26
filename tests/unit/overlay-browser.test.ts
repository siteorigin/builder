/**
 * Dialogs and drawers a design's yes/no state opens (#378), in a real browser. The exported page, rendered on the
 * server, hydrates with each one closed in the page; its buttons open it as a native modal that keeps the focus, and
 * Escape, a click on its backdrop or its own close button closes it, giving the focus back to the button that opened
 * it, in each placement on its own. A drawer runs along the edge the text's direction says; none prints. One the page
 * opens with (a notice) opens after hydration, and leaving the page closes them without taking the focus back. In the
 * editor, with the real preview bridge, Edit never opens one: a button of the editor's own shows it in place, so what
 * is inside can be selected and edited, and keeps it shown when it is rendered afresh, while Preview runs it as
 * visitors do, never before the editor has said it is previewing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { makeInstance } from '@engine/install';
import { generateProject } from '@generator/index';
import { P, prop, uiState } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { bundle, removeRendered, serverHtml } from './generated-site';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://dialogs.test';
const SESSION = 'so-test';
const NONE = { type: 'none' as const, target: '' };
/** `$app/navigation` for these pages: what runs before leaving the page is kept, for a test to call. */
const NAVIGATION = 'export const beforeNavigate = (fn) => (window.leaving ??= []).push(fn); export const afterNavigate = () => {};';

/**
 * A project whose Home places, twice, a design with a Book button that opens a booking dialog (its heading, which each
 * placement words, a line and two buttons inside: Close sets the state off, Not now toggles it) and a Menu button that
 * opens a drawer along the end edge, holding a jump to the Services section below the placements. With `notice`, it
 * places instead a design whose notice shows over the page until it is dismissed (`unless: dismissed`), which the page
 * opens with.
 */
function project(notice = false): ProjectState {
  const s = createStarterState('business', 'Test Studio', false);
  const def = notice
    ? FOUNDATION.managed({
        componentId: 'test.notice',
        name: 'Studio notice',
        category: 'content',
        tags: [],
        icon: 'sparkles',
        description: '',
        properties: {},
        parts: {},
        state: { dismissed: { type: 'boolean', label: 'Studio notice', initial: false } },
        build: (b) =>
          b.el('root', 'section', {}, [
            b.text('intro', 'p', 'Welcome'),
            b.el('notice', 'div', { unless: uiState('dismissed'), overlay: 'dialog' }, [
              b.text('notice-text', 'p', 'The studio is closed in August.'),
              b.link('dismiss', NONE, 'Got it', 'primary', { stateAction: { state: 'dismissed', op: 'set', value: true } })
            ])
          ])
      })
    : FOUNDATION.managed({
        componentId: 'test.booking',
        name: 'Booking',
        category: 'content',
        tags: [],
        icon: 'sparkles',
        description: '',
        properties: { title: P.str('Title', 'Book a consultation') },
        parts: {},
        state: { booking: { type: 'boolean', label: 'Booking form', initial: false }, menu: { type: 'boolean', label: 'Menu', initial: false } },
        build: (b) =>
          b.el('root', 'section', {}, [
            b.link('book', NONE, 'Book a consultation', 'primary', { stateAction: { state: 'booking', op: 'toggle' } }),
            b.link('open-menu', NONE, 'Menu', 'secondary', { stateAction: { state: 'menu', op: 'set', value: true } }),
            b.el('dialog', 'div', { when: uiState('booking'), overlay: 'dialog', styles: { base: { padding: '48px', display: 'grid' } } }, [
              b.text('title', 'h2', prop('title')),
              b.text('body', 'p', 'Tell us about your project.'),
              b.link('close', NONE, 'Close', 'secondary', { stateAction: { state: 'booking', op: 'set', value: false } }),
              b.link('not-now', NONE, 'Not now', 'text', { stateAction: { state: 'booking', op: 'toggle' } })
            ]),
            b.el('drawer', 'div', { when: uiState('menu'), overlay: 'drawer-end', ariaLabel: 'Site menu' }, [
              b.link('to-services', { type: 'anchor', target: 'services' }, 'Our services', 'link'),
              b.link('close-menu', NONE, 'Close menu', 'secondary', { stateAction: { state: 'menu', op: 'toggle' } })
            ])
          ])
      });
  s.components[def.id] = { ...def, owner: 'project' };
  const home = s.pages[s.site.homePageId];
  for (let i = 0; i < (notice ? 1 : 2); i++) {
    const node = makeInstance(def, {});
    home.nodes[node.id] = node;
    home.rootIds.push(node.id);
  }
  if (!notice) {
    home.nodes.services = { id: 'services', kind: 'text', tag: 'h2', text: 'Services', anchor: 'services' } as never;
    home.rootIds.push('services');
  }
  return s;
}

afterAll(removeRendered);

interface Site {
  ssr: string;
  css: string;
  script: string;
}

async function site(s: ProjectState, prefix: string): Promise<Site> {
  const clean = generateProject(s);
  const dev = generateProject(s, { instrument: true });
  return {
    ssr: await serverHtml(clean, prefix),
    css: ['tokens', 'theme', 'components', 'site'].map((f) => clean.get(`src/lib/siteorigin/styles/${f}.css`) ?? '').join('\n'),
    script: await bundle(clean, dev, NAVIGATION)
  };
}

describe.skipIf(!browserInstalled)('generated dialogs and drawers in a browser', () => {
  let browser: Browser;
  let booking: Site;
  let notice: Site;
  beforeAll(async () => {
    [booking, notice] = await Promise.all([site(project(), 'overlay-browser-'), site(project(true), 'overlay-notice-')]);
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  interface Opened {
    page: Page;
    /** The document the site is in: the page itself, or the preview frame inside the stand-in editor. */
    site: Frame;
    /** Console warnings and errors, and uncaught errors. */
    problems: string[];
  }

  /**
   * The site: the server-rendered page hydrated (`clean`), or the editor's variant mounted in a frame of a stand-in
   * editor with the real preview bridge, loaded after the site as the editor loads it (`dev`), which starts in Edit.
   * Every call to showModal is counted (`window.modals`). `before` runs in the page just before the site starts.
   */
  async function open(from: Site, variant: 'clean' | 'dev', before = ''): Promise<Opened> {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (m) => {
      if ((m.type() === 'warning' || m.type() === 'error') && !m.text().startsWith('Failed to load resource')) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    await page.addInitScript(`{
      window.modals = 0;
      const show = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function () { window.modals++; return show.call(this); };
    }`);
    const html = `<!doctype html><html lang="en" class="so-js"><head><style>${from.css}</style></head><body><div id="app">${variant === 'clean' ? from.ssr : ''}</div></body></html>`;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();
      if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: from.script });
      if (url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
      if (url.pathname === '/site') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname === '/') {
        const editor = `<!doctype html><title>Editor</title><script>window.sent = []; addEventListener('message', (e) => window.sent.push(e.data));</script><iframe name="${SESSION}" src="/site" style="width:1000px;height:700px;border:0"></iframe>`;
        return route.fulfill({ contentType: 'text/html', body: variant === 'dev' ? editor : html });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(`${ORIGIN}/`);
    let frame = page.mainFrame();
    if (variant === 'dev') {
      await expect.poll(() => page.frame({ name: SESSION })?.url()).toBe(`${ORIGIN}/site`);
      frame = page.frame({ name: SESSION })!;
      await frame.waitForLoadState();
    }
    await frame.addScriptTag({ url: '/app.js', type: 'module' });
    await frame.waitForFunction('typeof window.startSite === "function"');
    if (before) await frame.evaluate(before);
    await frame.evaluate(`window.startSite(${JSON.stringify(variant)})`);
    if (variant === 'dev') {
      // The site has mounted before the editor takes it over, as in the editor.
      await frame.waitForFunction('document.querySelector("[data-so-node=root]") !== null');
      await frame.addScriptTag({ url: '/bridge.js', type: 'module' });
      await frame.waitForFunction('window.__siteoriginBridge === true && document.documentElement.hasAttribute("data-so-editing")');
    }
    return { page, site: frame, problems };
  }

  /** Switches the preview between Edit and Preview, as the editor does. */
  async function mode({ page, site }: Opened, to: 'edit' | 'preview') {
    await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ protocolVersion: 1, sessionId: SESSION, type: 'mode', payload: { mode: to } })}, '*')`);
    await site.waitForFunction(`document.documentElement.getAttribute('data-so-bridge') === ${JSON.stringify(to)}`);
  }

  /** Sends the preview a message from the stand-in editor. */
  const post = ({ page }: Opened, type: string, payload: unknown) =>
    page.evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ protocolVersion: 1, sessionId: SESSION, type, payload })}, '*')`);

  /**
   * Each dialog and drawer in page order: whether it is open as a modal, whether it shows, and its accessible name's
   * source; and the open modal's index, the focused element's words and where it is, and whether the page scrolls.
   * (Scripts run in the page are written as strings: this file is type-checked without the DOM's types.)
   */
  const look = (site: Frame) =>
    site.evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('dialog')];
      const active = document.activeElement;
      return {
        modal: dialogs.map((d) => d.matches(':modal')),
        shown: dialogs.map((d) => d.checkVisibility()),
        focus: active && active !== document.body ? active.textContent.trim() : '',
        focusIn: dialogs.findIndex((d) => d.contains(active)),
        scrolls: getComputedStyle(document.documentElement).overflowY !== 'hidden'
      };
    })()`) as Promise<{ modal: boolean[]; shown: boolean[]; focus: string; focusIn: number; scrolls: boolean }>;
  const expanded = (site: Frame, name: string) =>
    site.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === ${JSON.stringify(name)}).map((b) => b.getAttribute('aria-expanded'))`) as Promise<string[]>;

  it('ships each dialog closed in the exported page, named and controlled by its button in each placement', async () => {
    const tags = [...booking.ssr.matchAll(/<dialog\b[^>]*>/g)].map((m) => m[0]);
    expect(tags).toHaveLength(4);
    for (const tag of tags) expect(tag).not.toMatch(/\sopen[\s=>]/);
    const ids = tags.map((t) => /\sid="([^"]+)"/.exec(t)![1]);
    expect(new Set(ids).size).toBe(4);
    // Every opener names a dialog the page has, the Book button the one beside it in its own placement.
    const openers = [...booking.ssr.matchAll(/<button\b[^>]*aria-haspopup="dialog"[^>]*>/g)].map((m) => m[0]);
    expect(openers).toHaveLength(4);
    expect(openers.map((b) => /aria-controls="([^"]+)"/.exec(b)![1])).toEqual([ids[0], ids[1], ids[2], ids[3]]);
    for (const b of openers) expect(b).toContain('aria-expanded="false"');
    // Each booking dialog is named by its own placement's heading, each drawer by its own name.
    const headings = [tags[0], tags[2]].map((t) => /aria-labelledby="([^"]+)"/.exec(t)![1]);
    expect(new Set(headings).size).toBe(2);
    for (const id of headings) expect(booking.ssr).toMatch(new RegExp(`<h2[^>]*id="${id.replace(/[.]/g, '\\.')}"[^>]*>Book a consultation</h2>`));
    for (const t of [tags[1], tags[3]]) expect(t).toContain('aria-label="Site menu"');
    // What is inside is in the page, and the close buttons inside are commands, not toggles that say they are pressed.
    expect(booking.ssr.match(/Tell us about your project\./g)).toHaveLength(2);
    expect(booking.ssr).not.toContain('aria-pressed');
  });

  it('opens a modal that keeps the focus, closes it by Escape, backdrop or button, and gives the focus back', async () => {
    const opened = await open(booking, 'clean');
    const { page, site, problems } = opened;
    try {
      await site.waitForFunction('document.querySelectorAll("dialog").length === 4');
      expect(await look(site)).toMatchObject({ modal: [false, false, false, false], shown: [false, false, false, false], scrolls: true });
      // The second placement's button, from the keyboard: its dialog opens, the focus inside it, the page held still.
      const book = site.getByRole('button', { name: 'Book a consultation' });
      await book.nth(1).focus();
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await look(site)).modal).toEqual([false, false, true, false]);
      expect(await look(site)).toMatchObject({ shown: [false, false, true, false], focusIn: 2, scrolls: false });
      expect(await expanded(site, 'Book a consultation')).toEqual(['false', 'true']);
      expect(await site.getByRole('dialog', { name: 'Book a consultation' }).count()).toBe(1);
      // Each booking dialog is named by the heading inside it.
      expect(await site.evaluate(`[...document.querySelectorAll('dialog')].filter((d, i) => i % 2 === 0).map((d) => d.contains(document.getElementById(d.getAttribute('aria-labelledby'))))`)).toEqual([true, true]);
      // Tab and Shift+Tab go round the dialog's own buttons; nothing behind it takes the focus, even when asked to.
      for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.keyboard.press(key);
        const now = await look(site);
        expect(now.focusIn === 2 || now.focus === '', `${key} left the dialog for "${now.focus}"`).toBe(true);
      }
      await site.evaluate(`document.querySelector('button').focus()`);
      expect((await look(site)).focus).not.toBe('Book a consultation');
      // A click inside it, in its padding, leaves it open.
      const box = (await site.locator('dialog').nth(2).boundingBox())!;
      await page.mouse.click(box.x + 10, box.y + 10);
      expect((await look(site)).modal).toEqual([false, false, true, false]);
      // Escape closes it, and the focus is back on the button that opened it.
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await look(site)).modal).toEqual([false, false, false, false]);
      expect(await look(site)).toMatchObject({ shown: [false, false, false, false], focus: 'Book a consultation', focusIn: -1, scrolls: true });
      expect(await site.evaluate(`document.activeElement === document.querySelectorAll('[aria-haspopup="dialog"]')[2]`)).toBe(true);
      await expect.poll(() => expanded(site, 'Book a consultation')).toEqual(['false', 'false']);
      // The first placement's, by pointer, closed by a click on its backdrop: the focus goes back to that button.
      await book.first().click();
      await expect.poll(async () => (await look(site)).modal).toEqual([true, false, false, false]);
      await page.mouse.click(8, 8);
      await expect.poll(async () => (await look(site)).modal).toEqual([false, false, false, false]);
      expect(await site.evaluate(`document.activeElement === document.querySelectorAll('[aria-haspopup="dialog"]')[0]`)).toBe(true);
      // A button a click does not focus (as in Safari) still gets the focus back: the dialog gives it back itself.
      await site.evaluate(`document.querySelectorAll('[aria-haspopup="dialog"]')[0].addEventListener('mousedown', (e) => e.preventDefault())`);
      await site.evaluate('document.activeElement.blur()');
      await book.first().click();
      await expect.poll(async () => (await look(site)).modal).toEqual([true, false, false, false]);
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await look(site)).modal[0]).toBe(false);
      await expect.poll(() => site.evaluate(`document.activeElement === document.querySelectorAll('[aria-haspopup="dialog"]')[0]`)).toBe(true);
      // Its own Close button, and Not now, which toggles the state, close it too.
      for (const name of ['Close', 'Not now']) {
        await book.first().click();
        await expect.poll(async () => (await look(site)).modal[0]).toBe(true);
        await site.locator('dialog').first().getByRole('button', { name }).click();
        await expect.poll(async () => (await look(site)).modal[0]).toBe(false);
        expect((await look(site)).focus).toBe('Book a consultation');
      }
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('runs a drawer along the end edge, the other side in right-to-left text, prints none, and closes on leaving', async () => {
    const opened = await open(booking, 'clean');
    const { page, site, problems } = opened;
    try {
      await site.waitForFunction('document.querySelectorAll("dialog").length === 4');
      const menu = site.getByRole('button', { name: 'Menu' }).first();
      // Where the page ends: beside the room kept for its scrollbar (scrollbar-gutter), which a classic scrollbar takes from the window.
      const edges = () => site.evaluate(`(() => { const r = document.querySelectorAll('dialog')[1].getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.height), Math.round(document.documentElement.getBoundingClientRect().right), innerHeight]; })()`) as Promise<number[]>;
      await menu.click();
      await expect.poll(async () => (await look(site)).modal).toEqual([false, true, false, false]);
      let [left, right, height, width, tall] = await edges();
      expect([right, height]).toEqual([width, tall]);
      expect(left).toBeGreaterThan(0);
      // Printed: the page without it or its backdrop. Back on screen it is still open.
      await page.emulateMedia({ media: 'print' });
      expect(await site.evaluate(`[...document.querySelectorAll('dialog')].map((d) => [getComputedStyle(d).display, getComputedStyle(d, '::backdrop').display])`)).toEqual([...Array(4)].map(() => ['none', 'none']));
      // Laid out for print, which the page's watchers see too, it is not taken for one its styles hide.
      await site.evaluate(`dispatchEvent(new Event('resize'))`);
      await page.waitForTimeout(100);
      expect(await site.getByText('Book a consultation', { exact: true }).first().isVisible()).toBe(true);
      await page.emulateMedia({ media: 'screen' });
      expect((await look(site)).modal).toEqual([false, true, false, false]);
      await site.getByRole('button', { name: 'Close menu' }).first().click();
      await expect.poll(async () => (await look(site)).modal[1]).toBe(false);
      // Right to left, the end edge is the left one.
      await site.evaluate(`document.documentElement.setAttribute('dir', 'rtl')`);
      await menu.click();
      await expect.poll(async () => (await look(site)).modal[1]).toBe(true);
      [left, right, height, width, tall] = await edges();
      expect([left, height]).toEqual([0, tall]);
      expect(right).toBeLessThan(width);
      // A jump from inside it to a section of the page closes it, so the section can be seen and used.
      await site.getByRole('link', { name: 'Our services' }).first().click();
      await expect.poll(async () => (await look(site)).modal[1]).toBe(false);
      expect(await site.evaluate('location.hash')).toBe('#services');
      // A jump to a place inside it leaves it open.
      await menu.click();
      await expect.poll(async () => (await look(site)).modal[1]).toBe(true);
      await site.evaluate(`{
        const drawer = document.querySelectorAll('dialog')[1];
        drawer.insertAdjacentHTML('beforeend', '<a href="#inside">More below</a><p id="inside">Inside</p>');
      }`);
      await site.getByRole('link', { name: 'More below' }).click();
      expect((await look(site)).modal[1]).toBe(true);
      // A jump to the top of the page leaves it.
      await site.evaluate(`document.querySelectorAll('dialog')[1].insertAdjacentHTML('beforeend', '<a href="#top">Back to top</a>')`);
      await site.getByRole('link', { name: 'Back to top' }).click();
      await expect.poll(async () => (await look(site)).modal[1]).toBe(false);
      await menu.click();
      await expect.poll(async () => (await look(site)).modal[1]).toBe(true);
      // Leaving the page closes it.
      await site.evaluate('window.leaving.forEach((fn) => fn())');
      await expect.poll(async () => (await look(site)).modal[1]).toBe(false);
      expect(await expanded(site, 'Menu')).toEqual(['false', 'false']);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('opens a notice the page starts with after hydration, and keeps it closed once dismissed', async () => {
    const { page, site, problems } = await open(notice, 'clean');
    try {
      expect(notice.ssr).not.toMatch(/<dialog\b[^>]*\sopen[\s=>]/);
      await expect.poll(async () => (await look(site)).modal).toEqual([true]);
      expect(await site.getByRole('dialog', { name: 'Studio notice' }).count()).toBe(1);
      await site.getByRole('button', { name: 'Got it' }).click();
      await expect.poll(async () => (await look(site)).modal).toEqual([false]);
      expect(await look(site)).toMatchObject({ shown: [false], scrolls: true });
      expect(await site.evaluate('window.modals')).toBe(1);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('never leaves an invisible modal: one its own styles hide closes, now or as the width changes', async () => {
    const { page, site, problems } = await open(booking, 'clean');
    try {
      await site.waitForFunction('document.querySelectorAll("dialog").length === 4');
      const book = site.getByRole('button', { name: 'Book a consultation' }).first();
      // Hidden by its own styles (as at a screen width it is hidden at): it opens and closes again, and says so.
      await site.evaluate(`document.querySelector('dialog').style.setProperty('display', 'none', 'important')`);
      await book.click();
      await expect.poll(() => expanded(site, 'Book a consultation')).toEqual(['false', 'false']);
      expect(await look(site)).toMatchObject({ modal: [false, false, false, false], scrolls: true });
      // Shown, it opens; hidden while open (the width changes), it closes.
      await site.evaluate(`document.querySelector('dialog').style.removeProperty('display')`);
      await book.click();
      await expect.poll(async () => (await look(site)).modal[0]).toBe(true);
      // Hidden by its own styles alone (a class or a media query of its own), with nothing else changing size.
      await site.evaluate(`document.querySelector('dialog').style.setProperty('display', 'none', 'important')`);
      await expect.poll(async () => (await look(site)).modal[0]).toBe(false);
      await expect.poll(() => expanded(site, 'Book a consultation')).toEqual(['false', 'false']);
      expect((await look(site)).scrolls).toBe(true);
      // Made fully transparent by its own styles, or hidden from sight, it cannot be seen either.
      await site.evaluate(`document.querySelector('dialog').style.removeProperty('display')`);
      for (const [property, value] of [['opacity', '0'], ['visibility', 'hidden']]) {
        await site.evaluate(`document.querySelector('dialog').style.setProperty(${JSON.stringify(property)}, ${JSON.stringify(value)}, 'important')`);
        await book.click();
        await expect.poll(() => expanded(site, 'Book a consultation')).toEqual(['false', 'false']);
        expect((await look(site)).modal[0]).toBe(false);
        await site.evaluate(`document.querySelector('dialog').style.removeProperty(${JSON.stringify(property)})`);
      }
      // One that fades in from nothing (a theme's entrance for dialogs) stays open.
      await site.evaluate(`document.head.insertAdjacentHTML('beforeend', '<style id="fade">dialog.so-overlay:modal { transition: opacity 0.3s; } @starting-style { dialog.so-overlay:modal { opacity: 0; } }</style>')`);
      await book.click();
      await expect.poll(async () => (await look(site)).modal[0]).toBe(true);
      await page.waitForTimeout(400);
      expect((await look(site)).modal[0]).toBe(true);
      expect(await expanded(site, 'Book a consultation')).toEqual(['true', 'false']);
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await look(site)).modal[0]).toBe(false);
      await site.evaluate(`document.getElementById('fade').remove()`);
      // Closed by something of its own (a form that closes it) just before the page changes size: it stays closed.
      await book.click();
      await expect.poll(async () => (await look(site)).modal[0]).toBe(true);
      await site.evaluate(`document.querySelector('dialog').close(); dispatchEvent(new Event('resize'))`);
      await expect.poll(() => expanded(site, 'Book a consultation')).toEqual(['false', 'false']);
      expect((await look(site)).modal[0]).toBe(false);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('opens a notice whose placement is not on screen once it shows', async () => {
    // The placement hidden as the page starts (inside a tab panel not chosen, say).
    const { page, site, problems } = await open(notice, 'clean', `document.querySelector('.so-foundation-test-notice__root').style.display = 'none'`);
    try {
      await page.waitForTimeout(200);
      expect(await site.evaluate('window.modals')).toBe(0);
      await site.evaluate(`document.querySelector('.so-foundation-test-notice__root').style.removeProperty('display')`);
      await expect.poll(async () => (await look(site)).modal).toEqual([true]);
      expect(await site.evaluate('window.modals')).toBe(1);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('in Edit opens nothing: its own button shows a dialog in place to select and edit, kept shown as it renders afresh', async () => {
    const opened = await open(booking, 'dev');
    const { page, site, problems } = opened;
    try {
      const selects = () => page.evaluate(`window.sent.filter((m) => m.type === 'select').map((m) => m.payload.chain?.[0]?.node)`) as Promise<string[]>;
      const hosts = () => site.evaluate(`[...document.querySelectorAll('[data-so-overlay]')].map((h) => h.checkVisibility())`) as Promise<boolean[]>;
      const toggles = site.locator('[data-so-overlay-peek]');
      // In Edit each dialog sits hidden in its place, beside the editor's button for it; nothing is a modal.
      await expect.poll(hosts).toEqual([false, false, false, false]);
      expect(await toggles.allTextContents()).toEqual(['Dialog: Booking form', 'Drawer: Menu', 'Dialog: Booking form', 'Drawer: Menu']);
      expect(await site.evaluate('document.querySelectorAll("dialog").length')).toBe(0);
      // A click on the Book button selects it and opens nothing.
      await site.getByRole('button', { name: 'Book a consultation' }).nth(1).click();
      await expect.poll(selects).toEqual(['book']);
      expect(await site.evaluate('window.modals')).toBe(0);
      expect(await expanded(site, 'Book a consultation')).toEqual(['false', 'false']);
      // The second placement's dialog shown in place, the first left as it is; showing it selects nothing.
      await toggles.nth(2).click();
      await expect.poll(hosts).toEqual([false, false, true, false]);
      expect(await toggles.nth(2).getAttribute('aria-expanded')).toBe('true');
      expect(await selects()).toEqual(['book']);
      // What is inside is selected by a click and edited in place.
      const title = site.locator('[data-so-overlay] [data-so-node="title"]').nth(1);
      await title.click();
      await expect.poll(selects).toEqual(['book', 'title']);
      const desc = { ctx: await title.getAttribute('data-so-ctx'), node: 'title', items: '' };
      await post(opened, 'beginTextEdit', { desc, editId: 'edit-1' });
      await site.waitForFunction(`document.querySelector('[data-so-overlay] [data-so-node="title"][contenteditable]') !== null`);
      expect(await title.getAttribute('contenteditable')).toBe('plaintext-only');
      await page.keyboard.press('End');
      await page.keyboard.type(' today');
      await post(opened, 'commitTextEdit', {});
      await expect
        .poll(() => page.evaluate(`window.sent.filter((m) => m.type === 'textCommit').map((m) => [m.payload.desc.node, m.payload.desc.ctx, m.payload.text])`))
        .toEqual([['title', desc.ctx, 'Book a consultation today']]);
      // Rendered afresh (Preview and back, or the whole site taken down and started again, as a hot update renders a
      // changed file), the same placement's dialog shows again, and only it.
      await mode(opened, 'preview');
      expect(await site.evaluate('document.querySelectorAll("[data-so-overlay]").length')).toBe(0);
      await mode(opened, 'edit');
      await expect.poll(hosts).toEqual([false, false, true, false]);
      await site.evaluate('window.stopSite(); window.startSite("dev")');
      await expect.poll(() => site.evaluate('document.querySelectorAll("[data-so-overlay]").length')).toBe(4);
      await expect.poll(hosts).toEqual([false, false, true, false]);
      await toggles.nth(2).click();
      await expect.poll(hosts).toEqual([false, false, false, false]);
      expect(await toggles.nth(2).getAttribute('aria-expanded')).toBe('false');
      // Copies of one placement inside copies of another, in the rows of two lists, share everything but the outer item
      // (the inner list's items are the same in each copy): each is shown on its own.
      await site.evaluate(`{
        const roots = document.querySelectorAll('.so-foundation-test-booking__root');
        const hostsNow = document.querySelectorAll('[data-so-overlay]');
        roots.forEach((root, i) => {
          root.setAttribute('data-so-items', 'inner-1');
          const row = document.createElement('div');
          row.setAttribute('data-so-items', 'row-' + (i + 1));
          root.before(row);
          row.append(root);
        });
        for (const el of [...roots[1].querySelectorAll('[data-so-ctx]'), roots[1]]) el.setAttribute('data-so-ctx', roots[0].getAttribute('data-so-ctx'));
        if (hostsNow[2].getAttribute('data-so-ctx') !== hostsNow[0].getAttribute('data-so-ctx')) throw new Error('not one placement');
      }`);
      await toggles.nth(2).click();
      await expect.poll(hosts).toEqual([false, false, true, false]);
      expect(await site.evaluate('window.modals')).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('in Preview runs a dialog as visitors do, steps aside for Edit and opens again after it', async () => {
    const opened = await open(booking, 'dev');
    const { site, problems } = opened;
    try {
      await mode(opened, 'preview');
      await site.getByRole('button', { name: 'Book a consultation' }).first().click();
      await expect.poll(async () => (await look(site)).modal).toEqual([true, false, false, false]);
      // Edit releases the page: no modal over the canvas, and the dialog is back in its place.
      await mode(opened, 'edit');
      await expect.poll(() => site.evaluate('document.querySelectorAll("dialog").length')).toBe(0);
      expect(await site.evaluate(`document.querySelector(':modal')`)).toBe(null);
      expect((await look(site)).scrolls).toBe(true);
      // Previewed again, the visitor's dialog is open as they left it.
      await mode(opened, 'preview');
      await expect.poll(async () => (await look(site)).modal).toEqual([true, false, false, false]);
      expect(problems).toEqual([]);
    } finally {
      await opened.page.close();
    }
  });

  it('opens a notice in the editor only once the editor says it is previewing', async () => {
    const opened = await open(notice, 'dev');
    const { page, site } = opened;
    try {
      // Mounted before the bridge, then in Edit: never opened.
      await page.waitForTimeout(200);
      expect(await site.evaluate('window.modals')).toBe(0);
      await mode(opened, 'preview');
      await expect.poll(async () => (await look(site)).modal).toEqual([true]);
      expect(await site.evaluate('window.modals')).toBe(1);
      // Dismissed in Preview, it stays dismissed through Edit and back.
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await look(site)).modal).toEqual([false]);
      await mode(opened, 'edit');
      await mode(opened, 'preview');
      await page.waitForTimeout(200);
      expect((await look(site)).modal).toEqual([false]);
      expect(await site.evaluate('window.modals')).toBe(1);
    } finally {
      await page.close();
    }
  });
});
