/**
 * The application menu's button off macOS (#1355), in a real browser: it sits at the top bar's left, opens the menu
 * under itself, and keeps Edit acting on the field that had focus, whether it is clicked (it never takes focus, and the
 * page never hears the press), reached by Tab and pressed, or pressed by F10 (the field gets focus back, with its
 * selection, before the menu opens), over a dialog too. macOS has none. Mounted as main.tsx mounts it: in a root of
 * its own after the screens'.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const browserInstalled = existsSync(chromium.executablePath());
const SITE = 'http://window-menu.test';
const renderer = (path: string) => JSON.stringify(resolve('src/renderer/src', path));

const ENTRY = [
  `import ${renderer('styles/index.css')};`,
  "import { createElement as h } from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import { flushSync } from 'react-dom';",
  `import { WindowChrome } from ${renderer('components/WindowMenuButton')};`,
  `import { markWindowChrome } from ${renderer('lib/window-chrome')};`,
  'markWindowChrome();',
  "const field = h('input', { id: 'field', defaultValue: 'Harbour Lane Studio' });",
  "const region = h('div', { id: 'region', contentEditable: true, suppressContentEditableWarning: true }, 'Fresh bread daily');",
  "const other = h('button', { id: 'other', type: 'button' }, 'Other');",
  "const plain = h('p', { id: 'plain' }, 'Some words');",
  // The screen's top bar, a drag region the button sits in.
  "const bar = h('header', { className: 'drag', style: { position: 'fixed', inset: '0 0 auto', height: 52 } });",
  "flushSync(() => createRoot(document.getElementById('root')).render(h('div', { style: { paddingTop: 80 } }, bar, field, region, other, plain)));",
  "const chrome = document.createElement('div');",
  "document.getElementById('root').after(chrome);",
  "flushSync(() => createRoot(chrome).render(h(WindowChrome)));",
  // A popover's way of closing on a press outside it, which a press of the button must never reach.
  "window.outside = 0;",
  "document.addEventListener('pointerdown', () => (window.outside += 1), true);",
  "document.addEventListener('mousedown', () => (window.outside += 1), true);",
  "document.addEventListener('click', () => (window.outside += 1));"
].join('\n');

/** The preload bridge: the menu records what had focus and the selection when it was asked to open, and stays open until closeMenu. */
const bridge = (platform: string) => `
  window.calls = [];
  window.listeners = {};
  window.send = (channel) => (window.listeners[channel] ?? []).forEach((cb) => cb());
  // Electron's window controls overlay on Windows: three 46px caption buttons at the right, until the test moves them.
  const overlay = new EventTarget();
  overlay.visible = true;
  overlay.right = 138;
  overlay.getTitlebarAreaRect = () => ({ x: 0, y: 0, width: overlay.visible ? innerWidth - overlay.right : 0, height: overlay.visible ? 52 : 0 });
  Object.defineProperty(navigator, 'windowControlsOverlay', { value: overlay, configurable: true });
  window.builder = new Proxy({}, {
    get: (_, key) => {
      if (key === 'platform') return ${JSON.stringify(platform)};
      if (key === 'popupMenu') return (at) => {
        const a = document.activeElement;
        window.calls.push({ at, active: a && (a.id || a.getAttribute('aria-label')), selection: a && 'selectionStart' in a && a.selectionStart !== null ? a.value.slice(a.selectionStart, a.selectionEnd) : String(getSelection()) });
        return new Promise((r) => (window.closeMenu = r));
      };
      if (key === 'on') return (channel, cb) => {
        (window.listeners[channel] ??= []).push(cb);
        return () => (window.listeners[channel] = window.listeners[channel].filter((l) => l !== cb));
      };
      return undefined;
    }
  });
`;

async function bundle(): Promise<{ script: string; styles: string }> {
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: Object.fromEntries(['shared', 'engine', 'generator', 'catalogue', 'agent', 'runtime'].map((n) => [`@${n}`, resolve('src', n)])) },
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'window-menu', enforce: 'pre', resolveId: (id) => (id === '\0entry' ? id : null), load: (id) => (id === '\0entry' ? ENTRY : null) }],
    build: { write: false, minify: false, cssCodeSplit: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const files = (Array.isArray(out) ? out[0] : out).output;
  const chunk = files.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The menu button did not bundle');
  const styles = files.map((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? String(o.source) : '')).join('\n');
  return { script: chunk.code, styles };
}

type Call = { at: { x: number; y: number }; active: string | null; selection: string };

describe.skipIf(!browserInstalled)('the application menu button (#1355)', { timeout: 120_000 }, () => {
  let browser: Browser;
  let bundled: { script: string; styles: string };

  beforeAll(async () => {
    [bundled, browser] = await Promise.all([bundle(), chromium.launch({ headless: true })]);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  }, 60_000);

  async function open(platform: string): Promise<Page> {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`${SITE}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: bundled.script });
      if (path === '/app.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: bundled.styles });
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script>${bridge(platform)}</script><script src="/app.js"></script>`
      });
    });
    await page.goto(`${SITE}/`);
    await page.locator('#field').waitFor();
    expect(errors).toEqual([]);
    return page;
  }
  const calls = (p: Page) => p.evaluate<Call[]>('window.calls');
  const button = (p: Page) => p.getByRole('button', { name: 'Application menu' });
  const closeMenu = (p: Page) => p.evaluate('window.closeMenu()');

  it('sits at the top bar’s left on Windows, with the caption buttons’ room kept at its right', async () => {
    const page = await open('win32');
    const box = await button(page).boundingBox();
    expect(box).toEqual({ x: 10, y: 12, width: 28, height: 28 });
    const room = () => page.evaluate(`[document.documentElement.dataset.chrome, getComputedStyle(document.documentElement).getPropertyValue('--chrome-start'), getComputedStyle(document.documentElement).getPropertyValue('--chrome-end')]`);
    expect(await room()).toEqual(['overlay', '36px', '138px']);
    // The window reports new geometry (a zoom, a scale change): the room follows it. Full screen hides the buttons.
    await page.evaluate("navigator.windowControlsOverlay.right = 111; navigator.windowControlsOverlay.dispatchEvent(new Event('geometrychange'))");
    expect(await room()).toEqual(['overlay', '36px', '111px']);
    await page.evaluate("navigator.windowControlsOverlay.visible = false; navigator.windowControlsOverlay.dispatchEvent(new Event('geometrychange'))");
    expect(await room()).toEqual(['overlay', '36px', '0px']);
    await page.context().close();
  });

  it('on Linux, has no caption buttons to make room for', async () => {
    const page = await open('linux');
    await expect(button(page).count()).resolves.toBe(1);
    expect(await page.evaluate(`[document.documentElement.dataset.chrome, getComputedStyle(document.documentElement).getPropertyValue('--chrome-start'), getComputedStyle(document.documentElement).getPropertyValue('--chrome-end')]`)).toEqual(['system', '36px', '0px']);
    await page.context().close();
  });

  it('is not on macOS, which keeps its menu bar', async () => {
    const page = await open('darwin');
    expect(await button(page).count()).toBe(0);
    await page.context().close();
  });

  it('comes after the screens, so its place is never part of their drag region', async () => {
    const page = await open('win32');
    expect(await page.evaluate("[!!(document.getElementById('root').compareDocumentPosition(document.querySelector('.window-menu-button')) & Node.DOCUMENT_POSITION_FOLLOWING), getComputedStyle(document.querySelector('.window-menu-button')).getPropertyValue('app-region') || getComputedStyle(document.querySelector('.window-menu-button')).getPropertyValue('-webkit-app-region')]")).toEqual([true, 'no-drag']);
    await page.context().close();
  });

  it('opens the menu under itself on a click, leaving focus and the selection in the field, and the page hears no press', async () => {
    const page = await open('win32');
    await page.locator('#field').click();
    await page.evaluate("document.getElementById('field').setSelectionRange(0, 7); window.outside = 0");
    await button(page).click();
    expect(await calls(page)).toEqual([{ at: { x: 10, y: 40 }, active: 'field', selection: 'Harbour' }]);
    expect(await page.evaluate('window.outside')).toBe(0);
    await expect(button(page).getAttribute('aria-expanded')).resolves.toBe('true');
    // A second press while it is open asks for nothing more.
    await button(page).click();
    expect(await calls(page)).toHaveLength(1);
    await closeMenu(page);
    await expect.poll(() => button(page).getAttribute('aria-expanded')).toBe('false');
    expect(await page.evaluate('document.activeElement.id')).toBe('field');
    await page.context().close();
  });

  it('reached by Tab and pressed, gives the field its focus and selection back before the menu opens', async () => {
    const page = await open('win32');
    await page.locator('#field').click();
    await page.evaluate("document.getElementById('field').setSelectionRange(8, 12)");
    // On through another control (the editable region, then Other) to the button, the last in the page.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect(await page.evaluate("document.activeElement.getAttribute('aria-label')")).toBe('Application menu');
    await page.keyboard.press('Enter');
    expect(await calls(page)).toEqual([{ at: { x: 10, y: 40 }, active: 'region', selection: '' }]);
    await closeMenu(page);
    // Shift+Tab back from the field to the button, with nothing between.
    await page.locator('#field').click();
    await page.evaluate("document.getElementById('field').setSelectionRange(8, 12)");
    await button(page).focus();
    await page.keyboard.press(' ');
    expect((await calls(page)).at(-1)).toEqual({ at: { x: 10, y: 40 }, active: 'field', selection: 'Lane' });
    await closeMenu(page);
    await page.context().close();
  });

  it('opens on F10 as a press of it does, the field it came from getting focus back if the button had it', async () => {
    const page = await open('win32');
    await page.locator('#field').click();
    await page.evaluate("document.getElementById('field').setSelectionRange(0, 7)");
    await page.evaluate("window.send('menu:open')");
    expect(await calls(page)).toEqual([{ at: { x: 10, y: 40 }, active: 'field', selection: 'Harbour' }]);
    await expect.poll(() => button(page).getAttribute('aria-expanded')).toBe('true');
    await closeMenu(page);
    await expect.poll(() => button(page).getAttribute('aria-expanded')).toBe('false');
    await button(page).focus();
    await page.evaluate("window.send('menu:open')");
    expect((await calls(page)).at(-1)).toMatchObject({ active: 'field', selection: 'Harbour' });
    await closeMenu(page);
    await page.context().close();
  });

  it('stays live over a dialog, which makes the screens inert, and Edit acts on the dialog’s field', async () => {
    const page = await open('win32');
    await page.evaluate(`(() => {
      document.getElementById('root').inert = true;
      const dialog = document.createElement('div');
      dialog.className = 'overlay-backdrop';
      dialog.innerHTML = '<div role="dialog"><input id="dialog-field" value="Site name"></div>';
      document.body.append(dialog);
    })()`);
    await page.locator('#dialog-field').click();
    await page.evaluate("document.getElementById('dialog-field').setSelectionRange(0, 4)");
    await button(page).click();
    expect(await calls(page)).toEqual([{ at: { x: 10, y: 40 }, active: 'dialog-field', selection: 'Site' }]);
    await closeMenu(page);
    await page.context().close();
  });

  it('gives an editable region its selection back, and opens on Arrow Down too', async () => {
    const page = await open('win32');
    await page.locator('#region').click();
    await page.evaluate("(() => { const t = document.getElementById('region').firstChild; const r = document.createRange(); r.setStart(t, 6); r.setEnd(t, 11); getSelection().removeAllRanges(); getSelection().addRange(r); })()");
    await button(page).focus();
    await page.keyboard.press('ArrowDown');
    expect(await calls(page)).toEqual([{ at: { x: 10, y: 40 }, active: 'region', selection: 'bread' }]);
    await closeMenu(page);
    await page.context().close();
  });

  it('forgets the field once a press lands on something else that takes no typing', async () => {
    const page = await open('win32');
    await page.locator('#field').click();
    await page.locator('#plain').click();
    await button(page).focus();
    await page.keyboard.press('Enter');
    expect((await calls(page)).map((c) => c.active)).toEqual(['Application menu']);
    await closeMenu(page);
    await page.context().close();
  });
});
