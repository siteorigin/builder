/**
 * The video player as a visitor uses it, in a real browser: nothing loads from the video's host until Play is
 * pressed, the keyboard alone can play it, and focus moves into the player. The editor's variant runs beside the
 * real preview bridge, which the test drives as the editor does: it plays only in Preview, and the way back to Edit
 * drops the player (issue #73).
 */
import { existsSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VIDEO_HELPER_FILE, VIDEO_JS, VIDEO_PLAYER_FILE, videoPlayerSvelte } from '@generator/video';

const bridge = readFileSync(resolve('src/runtime/bridge.client.js'), 'utf8');
const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'http://player.test';
const SESSION = 'so-test';
const YT = 'dQw4w9WgXcQ';
const PLAYER = `https://www.youtube-nocookie.com/embed/${YT}?autoplay=1`;
const GEN = '\0gen:';

/** Holds the player's address and title as state, so a test can change them on the mounted player. */
const HARNESS = `<script>
	import Clean from './clean/${VIDEO_PLAYER_FILE}';
	import Dev from './dev/${VIDEO_PLAYER_FILE}';
	let { variant = 'clean', url: first = '', title: firstTitle = '' } = $props();
	let url = $state(first);
	let title = $state(firstTitle);
	window.setVideo = (next) => (url = next);
</script>

{#if variant === 'dev'}<Dev {url} {title} />{:else}<Clean {url} {title} />{/if}
`;

/** Both variants of the player, compiled for the browser into one script that mounts the harness. */
async function bundle(): Promise<string> {
  const files = new Map<string, string>([
    ['Harness.svelte', HARNESS],
    [`clean/${VIDEO_PLAYER_FILE}`, videoPlayerSvelte(false)],
    [`clean/${VIDEO_HELPER_FILE}`, VIDEO_JS],
    [`dev/${VIDEO_PLAYER_FILE}`, videoPlayerSvelte(true)],
    [`dev/${VIDEO_HELPER_FILE}`, VIDEO_JS]
  ]);
  const entry = [
    "import { mount } from 'svelte';",
    `import Harness from ${JSON.stringify(GEN + 'Harness.svelte')};`,
    "window.mountPlayer = (props) => mount(Harness, { target: document.getElementById('app'), props });"
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

  interface Opened {
    page: Page;
    /** The document the player is in: the page itself, or the preview frame inside the editor. */
    site: Frame;
    /** Every request made to a video host so far. */
    hosts: string[];
  }

  /**
   * The player mounted with these properties. `editor` puts the site in a frame of a stand-in editor, with the real
   * preview bridge (unless `bridgeLater`, which leaves it out until `startBridge`).
   */
  async function open(variant: 'clean' | 'dev', props: Record<string, unknown>, opts: { editor?: boolean; bridgeLater?: boolean } = {}): Promise<Opened> {
    const page = await browser.newPage();
    const hosts: string[] = [];
    const site = `<!doctype html><html><head></head><body><p><a href="#">Before</a></p><div id="app"></div></body></html>`;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN) {
        if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        if (url.pathname === '/bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
        if (url.pathname === '/site') return route.fulfill({ contentType: 'text/html', body: site });
        return route.fulfill({ contentType: 'text/html', body: opts.editor ? `<!doctype html><title>Editor</title><iframe name="${SESSION}" src="/site" style="width:800px;height:600px;border:0"></iframe>` : site });
      }
      hosts.push(route.request().url());
      // The host's player, stood in for: no test reaches the real YouTube or Vimeo.
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Player</title><button>Pause</button>' });
    });
    await page.goto(`${ORIGIN}/`);
    const frame = opts.editor ? await waitForFrame(page) : page.mainFrame();
    await frame.addScriptTag({ url: '/app.js', type: 'module' });
    await frame.waitForFunction('typeof window.mountPlayer === "function"');
    await frame.evaluate(`window.mountPlayer(${JSON.stringify({ variant, ...props })})`);
    const opened = { page, site: frame, hosts };
    if (opts.editor && !opts.bridgeLater) await startBridge(opened);
    return opened;
  }

  async function waitForFrame(page: Page): Promise<Frame> {
    await expect.poll(() => page.frame({ name: SESSION })?.url()).toBe(`${ORIGIN}/site`);
    const frame = page.frame({ name: SESSION })!;
    await frame.waitForLoadState();
    return frame;
  }

  /** Loads the preview bridge into the site, which starts it in Edit. */
  async function startBridge({ site }: Opened) {
    await site.addScriptTag({ url: '/bridge.js', type: 'module' });
    await site.waitForFunction('window.__siteoriginBridge === true && document.documentElement.hasAttribute("data-so-editing")');
  }

  /** Switches the preview between Edit and Preview, as the editor does. */
  async function mode({ page, site }: Opened, to: 'edit' | 'preview') {
    await page.evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify({ protocolVersion: 1, sessionId: SESSION, type: 'mode', payload: { mode: to } })}, '*')`);
    await site.waitForFunction(`document.documentElement.hasAttribute('data-so-editing') === ${to === 'edit'}`);
  }

  const active = (site: Frame) => site.evaluate(`(() => { const a = document.activeElement; return a ? a.tagName + (a.getAttribute('src') ? ' ' + a.getAttribute('src') : '') : ''; })()`);
  const frames = (site: Frame) => site.locator('iframe').count();
  const settle = (site: Frame) => site.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');

  it('plays from the keyboard alone, loading the host only when Play is pressed, with focus moved into the player', async () => {
    const { page, site, hosts } = await open('clean', { url: `https://youtu.be/${YT}`, title: 'Tour of our studio' });
    try {
      expect(await frames(site)).toBe(0);
      const button = site.getByRole('button', { name: /Play video\s*Tour of our studio\s*Loads the player from YouTube/ });
      await expect.poll(() => button.count()).toBe(1);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      expect(await active(site)).toBe('BUTTON');
      expect(hosts).toEqual([]);
      await page.keyboard.press('Enter');
      await expect.poll(() => frames(site)).toBe(1);
      const frame = site.locator('iframe');
      expect(await frame.getAttribute('src')).toBe(PLAYER);
      expect(await frame.getAttribute('title')).toBe('Tour of our studio');
      expect(await frame.getAttribute('allow')).toContain('autoplay');
      await expect.poll(() => active(site)).toBe(`IFRAME ${PLAYER}`);
      await expect.poll(() => hosts).toEqual([PLAYER]);
      expect(await button.count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('plays with Space, in a 16:9 frame as wide as its column', async () => {
    const { page, site } = await open('clean', { url: 'https://vimeo.com/76979871', title: '' });
    try {
      for (const width of [390, 1200]) {
        await page.setViewportSize({ width, height: 900 });
        const column = (await site.evaluate('document.getElementById("app").clientWidth')) as number;
        const box = (await site.locator('.so-video').boundingBox())!;
        expect(box.width).toBe(column);
        expect(Math.abs(box.height - (box.width * 9) / 16)).toBeLessThan(1);
      }
      const button = site.getByRole('button', { name: /Play video\s*Video from Vimeo/ });
      await button.focus();
      await page.keyboard.press('Space');
      await expect.poll(() => frames(site)).toBe(1);
      const frame = site.locator('iframe');
      expect(await frame.getAttribute('src')).toBe('https://player.vimeo.com/video/76979871?dnt=1&autoplay=1');
      expect(await frame.getAttribute('title')).toBe('Video from Vimeo');
      // The player fills the frame.
      expect(await frame.boundingBox()).toEqual(await site.locator('.so-video').boundingBox());
    } finally {
      await page.close();
    }
  });

  it('keeps the players’ minimum height on the narrowest phones', async () => {
    const { page, site } = await open('clean', { url: `https://youtu.be/${YT}`, title: 'Tour' });
    try {
      await page.setViewportSize({ width: 320, height: 700 });
      expect((await site.locator('.so-video').boundingBox())!.height).toBeGreaterThanOrEqual(200);
    } finally {
      await page.close();
    }
  });

  it('never plays an address the visitor did not press Play for, even one played before', async () => {
    const { page, site, hosts } = await open('clean', { url: `https://youtu.be/${YT}`, title: 'Tour' });
    try {
      await site.getByRole('button', { name: /Play video/ }).click();
      await expect.poll(() => frames(site)).toBe(1);
      await site.evaluate(`window.setVideo('https://vimeo.com/76979871')`);
      await expect.poll(() => frames(site)).toBe(0);
      expect(await site.getByRole('button', { name: /Loads the player from Vimeo/ }).count()).toBe(1);
      // Back to the first address: its button again, not its player.
      await site.evaluate(`window.setVideo('https://youtu.be/${YT}')`);
      await settle(site);
      expect(await frames(site)).toBe(0);
      expect(await site.getByRole('button', { name: /Loads the player from YouTube/ }).count()).toBe(1);
      // Through an empty address and back: still its button.
      await site.evaluate(`window.setVideo('')`);
      await expect.poll(() => site.getByRole('button').count()).toBe(0);
      await site.evaluate(`window.setVideo('https://youtu.be/${YT}')`);
      await settle(site);
      expect(await frames(site)).toBe(0);
      expect(hosts).toEqual([PLAYER]);
    } finally {
      await page.close();
    }
  });

  it('shows visitors nothing for an empty or unsupported address', async () => {
    for (const url of ['', 'https://example.com/tour.mp4']) {
      const { page, site, hosts } = await open('clean', { url, title: 'Tour' });
      try {
        await settle(site);
        expect(await site.evaluate('document.getElementById("app").children.length')).toBe(0);
        expect(((await site.evaluate('document.getElementById("app").innerText')) as string).trim()).toBe('');
        expect(hosts).toEqual([]);
      } finally {
        await page.close();
      }
    }
  });

  it('in the editor, plays only in Preview, with focus moved into the player, and drops it on the way back to Edit', async () => {
    const opened = await open('dev', { url: `https://youtu.be/${YT}`, title: 'Tour' }, { editor: true });
    const { page, site, hosts } = opened;
    try {
      const button = site.getByRole('button', { name: /Play video\s*Tour/ });
      // Edit: a press selects the section, so nothing plays.
      await button.click();
      await button.focus();
      await page.keyboard.press('Enter');
      await settle(site);
      expect(await frames(site)).toBe(0);
      expect(hosts).toEqual([]);
      await mode(opened, 'preview');
      await button.focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => frames(site)).toBe(1);
      await expect.poll(() => active(site)).toBe(`IFRAME ${PLAYER}`);
      await expect.poll(() => hosts).toEqual([PLAYER]);
      // Back to Edit: the player goes, and its button comes back for a click to select the section.
      await mode(opened, 'edit');
      await expect.poll(() => frames(site)).toBe(0);
      expect(await button.count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('in the editor, never plays before the bridge has taken over the page, and plays in Preview once it has', async () => {
    const opened = await open('dev', { url: `https://youtu.be/${YT}`, title: 'Tour' }, { editor: true, bridgeLater: true });
    const { page, site, hosts } = opened;
    try {
      const button = site.getByRole('button', { name: /Play video\s*Tour/ });
      await button.click();
      await settle(site);
      expect(await frames(site)).toBe(0);
      expect(hosts).toEqual([]);
      await startBridge(opened);
      await mode(opened, 'preview');
      await button.click();
      await expect.poll(() => frames(site)).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('in the editor, tells the author why there is no video, in a note Edit shows and Preview hides', async () => {
    for (const [url, words] of [
      ['', /No video yet\. Paste the address of a YouTube or Vimeo video/],
      ['https://example.com/tour.mp4', /isn’t a single YouTube or Vimeo video/]
    ] as const) {
      const opened = await open('dev', { url, title: 'Tour' }, { editor: true });
      try {
        const note = opened.site.locator('[data-so-editor-only]');
        expect(await note.innerText()).toMatch(words);
        expect(await note.isVisible()).toBe(true);
        await mode(opened, 'preview');
        expect(await note.isVisible()).toBe(false);
        await mode(opened, 'edit');
        expect(await note.isVisible()).toBe(true);
      } finally {
        await opened.page.close();
      }
    }
  });
});
