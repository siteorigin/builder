/**
 * The video player as a visitor uses it, in a real browser: nothing loads from the video's host until Play is
 * pressed, the keyboard alone can play it, and focus moves into the player. The editor's variant plays only in
 * Preview and drops the player on the way back to Edit (issue #73).
 */
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { compile } from 'svelte/compiler';
import { chromium, type Browser, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VIDEO_HELPER_FILE, VIDEO_JS, VIDEO_PLAYER_FILE, videoPlayerSvelte } from '@generator/video';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://player.test';
const YT = 'dQw4w9WgXcQ';
const PLAYER = `https://www.youtube-nocookie.com/embed/${YT}?autoplay=1`;
const GEN = '\0gen:';

/** Both variants of the player, compiled for the browser into one script that can mount either. */
async function bundle(): Promise<string> {
  const files = new Map<string, string>([
    [`clean/${VIDEO_PLAYER_FILE}`, videoPlayerSvelte(false)],
    [`clean/${VIDEO_HELPER_FILE}`, VIDEO_JS],
    [`dev/${VIDEO_PLAYER_FILE}`, videoPlayerSvelte(true)],
    [`dev/${VIDEO_HELPER_FILE}`, VIDEO_JS]
  ]);
  const entry = [
    "import { mount } from 'svelte';",
    `import Clean from ${JSON.stringify(GEN + 'clean/' + VIDEO_PLAYER_FILE)};`,
    `import Dev from ${JSON.stringify(GEN + 'dev/' + VIDEO_PLAYER_FILE)};`,
    "window.mountPlayer = (variant, props) => mount(variant === 'dev' ? Dev : Clean, { target: document.getElementById('app'), props });"
  ].join('\n');
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'player',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (importer?.startsWith(GEN) && id.startsWith('.')) {
            const path = posix.join(posix.dirname(importer.slice(GEN.length)), id);
            if (files.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          const source = files.get(path)!;
          const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'client', runes: true, css: 'injected' }).js.code : source;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The player did not bundle');
  return chunk.code;
}

describe.skipIf(!browserInstalled)('the video player in a browser', () => {
  let browser: Browser;
  let script: string;
  beforeAll(async () => {
    script = await bundle();
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  /** A page with the player mounted, and every request made to a video host so far. */
  async function open(variant: 'clean' | 'dev', props: Record<string, unknown>, setup = ''): Promise<{ page: Page; hosts: string[] }> {
    const page = await browser.newPage();
    const hosts: string[] = [];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN) {
        if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><script>${setup}</script></head><body><p><a href="#">Before</a></p><div id="app"></div></body></html>` });
      }
      hosts.push(route.request().url());
      // The host's player, stood in for: no test reaches the real YouTube or Vimeo.
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Player</title><button>Pause</button>' });
    });
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ url: '/app.js', type: 'module' });
    await page.waitForFunction('typeof window.mountPlayer === "function"');
    await page.evaluate(([v, p]) => (window as unknown as { mountPlayer: (v: string, p: unknown) => void }).mountPlayer(v as string, p), [variant, props] as const);
    return { page, hosts };
  }

  const active = (page: Page) => page.evaluate(`(() => { const a = document.activeElement; return a ? a.tagName + (a.getAttribute('src') ? ' ' + a.getAttribute('src') : '') : ''; })()`);

  it('plays from the keyboard alone, loading the host only when Play is pressed, with focus moved into the player', async () => {
    const { page, hosts } = await open('clean', { url: `https://youtu.be/${YT}`, title: 'Tour of our studio' });
    try {
      expect(await page.locator('iframe').count()).toBe(0);
      const button = page.getByRole('button', { name: /Play video\s*Tour of our studio\s*Loads the player from YouTube/ });
      await expect.poll(() => button.count()).toBe(1);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      expect(await button.evaluate((b) => b === document.activeElement)).toBe(true);
      expect(hosts).toEqual([]);
      await page.keyboard.press('Enter');
      const frame = page.locator('iframe');
      await expect.poll(() => frame.count()).toBe(1);
      expect(await frame.getAttribute('src')).toBe(PLAYER);
      expect(await frame.getAttribute('title')).toBe('Tour of our studio');
      expect(await frame.getAttribute('allow')).toContain('autoplay');
      await expect.poll(() => active(page)).toBe(`IFRAME ${PLAYER}`);
      await expect.poll(() => hosts).toEqual([PLAYER]);
      expect(await button.count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('plays with Space, at a 16:9 size as wide as its column', async () => {
    const { page } = await open('clean', { url: 'https://vimeo.com/76979871', title: '' });
    try {
      await page.setViewportSize({ width: 390, height: 800 });
      const button = page.getByRole('button', { name: /Play video\s*Video from Vimeo/ });
      await button.focus();
      await page.keyboard.press('Space');
      const frame = page.locator('iframe');
      await expect.poll(() => frame.count()).toBe(1);
      expect(await frame.getAttribute('src')).toBe('https://player.vimeo.com/video/76979871?dnt=1&autoplay=1');
      expect(await frame.getAttribute('title')).toBe('Video from Vimeo');
      const box = (await page.locator('.so-video').boundingBox())!;
      const body = await page.evaluate('document.getElementById("app").clientWidth');
      expect(box.width).toBe(body);
      expect(Math.abs(box.height - (box.width * 9) / 16)).toBeLessThan(1);
    } finally {
      await page.close();
    }
  });

  it('shows visitors nothing for an empty or unsupported address', async () => {
    for (const url of ['', 'https://example.com/tour.mp4']) {
      const { page, hosts } = await open('clean', { url, title: 'Tour' });
      try {
        expect(await page.locator('#app').innerHTML()).not.toMatch(/<(button|iframe|div|p)\b/);
        expect(hosts).toEqual([]);
      } finally {
        await page.close();
      }
    }
  });

  it('in the editor, plays only in Preview, and drops the player on the way back to Edit', async () => {
    const editing = "document.documentElement.setAttribute('data-so-editing', '');";
    const { page, hosts } = await open('dev', { url: `https://youtu.be/${YT}`, title: 'Tour' }, `window.__siteoriginBridge = true; ${editing}`);
    try {
      const button = page.getByRole('button', { name: /Play video\s*Tour/ });
      await button.focus();
      await page.keyboard.press('Enter');
      expect(await page.locator('iframe').count()).toBe(0);
      expect(hosts).toEqual([]);
      // Preview: the bridge takes the attribute off.
      await page.evaluate("document.documentElement.removeAttribute('data-so-editing')");
      await button.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.locator('iframe').count()).toBe(1);
      // Back to Edit: the player goes, its button comes back for a click to select the section.
      await page.evaluate(editing);
      await expect.poll(() => page.locator('iframe').count()).toBe(0);
      expect(await button.count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('in the editor, never plays before the editor has taken over the page', async () => {
    const { page, hosts } = await open('dev', { url: `https://youtu.be/${YT}`, title: 'Tour' });
    try {
      await page.getByRole('button', { name: /Play video\s*Tour/ }).click();
      await page.waitForTimeout(100);
      expect(await page.locator('iframe').count()).toBe(0);
      expect(hosts).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('in the editor, tells the author why there is no video, in a note Preview hides', async () => {
    for (const [url, words] of [
      ['', /No video yet\. Paste the address of a YouTube or Vimeo video/],
      ['https://example.com/tour.mp4', /isn’t a single YouTube or Vimeo video/]
    ] as const) {
      const { page } = await open('dev', { url, title: 'Tour' });
      try {
        const note = page.locator('[data-so-editor-only]');
        expect(await note.count()).toBe(1);
        expect(await note.innerText()).toMatch(words);
      } finally {
        await page.close();
      }
    }
  });
});
