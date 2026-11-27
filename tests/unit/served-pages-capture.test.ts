/**
 * Design captures of the pages the app itself serves to a browser when there is no site to show: the relay's refusals
 * opened in a tab, its refused preview inside a frame, and the exported website's local preview when its folder has
 * moved or a page is missing. Opt-in: it runs only with DESIGN_CAPTURE_DIR set, and writes one PNG per state, width
 * and theme there (`<state>--<width>--<theme>.png`). It never runs in CI.
 *
 *   DESIGN_CAPTURE_DIR=/abs/dir npx vitest run tests/unit/served-pages-capture.test.ts
 *   DESIGN_CAPTURE_ONLY=relay-not-found,export-moved narrows it to some states.
 *
 * Every page is the real one: the relay answers from Cloudflare's local simulator and the export preview from
 * StaticPreviews over loopback, and the browser asks for each the way a person's browser does.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Frame, type Page, type Response } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticPreviews } from '../../src/main/static-preview';
import { roomPreviewOrigin } from '../../src/shared/live/relay-url';
import { admittedGuest, openRoom, startRelay, wait, type Relay } from './relay-harness';

const OUT = process.env.DESIGN_CAPTURE_DIR ?? '';
const ONLY = (process.env.DESIGN_CAPTURE_ONLY ?? '').split(',').filter(Boolean);
const browserInstalled = existsSync(chromium.executablePath());

const WIDTHS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
} as const;
const THEMES = ['light', 'dark'] as const;
/** A well-formed room ID no room has: its links reach the relay's pages, and nothing behind them. */
const ROOM = '23456789abcdefghijkmnpqr';

interface Scene {
  name: string;
  /** A preview cookie the browser holds for `preview` (a guest who was let in). */
  cookie?: () => { url: string; cookie: string };
  /** Open the page; resolves with the answer and where it rendered (the page, or the frame it is in). */
  open: (page: Page) => Promise<{ answer: Response; doc: Page | Frame }>;
  status: number;
}

/** Open an address in the tab. */
const visit = (url: () => string) => async (page: Page) => ({ answer: (await page.goto(url()))!, doc: page });

/**
 * Open an address in a frame filling the tab, as the viewer frames the preview but without the viewer or its bridge:
 * what a guest sees in the frame when the bridge script does not run.
 */
const framed = (url: () => string) => async (page: Page) => {
  await page.route('**/__siteorigin/live.js', (route) => route.abort());
  // The parent is on the relay's own origin, as the viewer is, so the preview's cookie is first-party to the frame.
  await page.goto(`${origin}/_viewer/viewer.css`);
  const answered = page.waitForResponse((r) => r.url() === url());
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%;background:#fff}</style><iframe src="${url()}"></iframe>`);
  const answer = await answered;
  const frame = page.frames().find((f) => f !== page.mainFrame())!;
  await frame.waitForLoadState('load');
  return { answer, doc: frame };
};

let relay: Relay;
/** A relay whose RELAY_ORIGIN is not an origin: it answers every address as unavailable. */
let broken: Relay;
let brokenOrigin: string;
let browser: Browser;
let previews: StaticPreviews;
let scratch: string;
let origin: string;
let preview: string;
let movedUrl: string;
let exportUrl: string;
let emptyUrl: string;
/** Rooms a guest was let into whose host then dropped, and whose host then ended the session. */
let away: { preview: string; cookie: string };
let ended: { preview: string; cookie: string };

const scenes = (): Scene[] => [
  { name: 'relay-not-found', status: 404, open: visit(() => `${origin}/s/not-a-room`) },
  { name: 'relay-page-not-found', status: 404, open: visit(() => `${origin}/`) },
  { name: 'preview-private', status: 401, open: visit(() => `${preview}/`) },
  { name: 'preview-host-away', status: 503, cookie: () => ({ url: away.preview, cookie: away.cookie }), open: visit(() => `${away.preview}/`) },
  { name: 'preview-session-ended', status: 404, cookie: () => ({ url: ended.preview, cookie: ended.cookie }), open: visit(() => `${ended.preview}/`) },
  { name: 'preview-refused-frame', status: 401, open: framed(() => `${preview}/`) },
  { name: 'preview-host-away-frame', status: 503, cookie: () => ({ url: away.preview, cookie: away.cookie }), open: framed(() => `${away.preview}/`) },
  { name: 'export-moved', status: 410, open: visit(() => movedUrl) },
  { name: 'export-missing', status: 404, open: visit(() => `${exportUrl}pricing/`) },
  { name: 'export-no-home', status: 404, open: visit(() => emptyUrl) },
  { name: 'relay-unavailable', status: 503, open: visit(() => `${brokenOrigin}/s/${ROOM}`) },
  { name: 'relay-room-address', status: 426, open: visit(() => `${origin}/s/${ROOM}/ws`) }
];

describe.skipIf(!OUT || !browserInstalled)('design captures of the pages the app serves', { timeout: 600_000 }, () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    relay = await startRelay();
    origin = await relay.browserOrigin();
    preview = await roomPreviewOrigin(origin, ROOM);
    const admitted = async (end: 'drop' | 'end') => {
      const room = await openRoom(relay, { projectName: 'Acme Bakery' });
      const guest = await admittedGuest(relay, room);
      if (end === 'end') room.host.send('host-to-relay', { type: 'room:end' });
      room.host.close();
      await wait(200);
      return { preview: await roomPreviewOrigin(origin, room.roomId), cookie: guest.cookie };
    };
    away = await admitted('drop');
    ended = await admitted('end');
    scratch = mkdtempSync(join(tmpdir(), 'served-pages-'));
    previews = new StaticPreviews();
    // An export with no 404.html of its own, and one whose folder is then moved away.
    const site = join(scratch, 'site');
    mkdirSync(site);
    writeFileSync(join(site, 'index.html'), '<!doctype html><title>Acme Bakery</title><h1>Acme Bakery</h1>');
    exportUrl = await previews.serve(site);
    const moved = join(scratch, 'moved');
    mkdirSync(moved);
    writeFileSync(join(moved, 'index.html'), '<!doctype html><title>Acme Bakery</title><h1>Acme Bakery</h1>');
    movedUrl = await previews.serve(moved);
    renameSync(moved, join(scratch, 'moved-away'));
    // An export with no home page at all.
    const empty = join(scratch, 'empty');
    mkdirSync(empty);
    emptyUrl = await previews.serve(empty);
    broken = await startRelay({ RELAY_ORIGIN: 'not an origin' });
    brokenOrigin = await broken.browserOrigin();
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    previews?.stopAll();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    await relay?.dispose();
    await broken?.dispose();
  }, 60_000);

  it('captures every page at each width and theme', async () => {
    const chosen = ONLY.length ? scenes().filter((s) => ONLY.includes(s.name)) : scenes();
    const written: string[] = [];
    for (const scene of chosen) {
      for (const [width, device] of Object.entries(WIDTHS)) {
        for (const theme of THEMES) {
          const context = await browser.newContext({ ...device, colorScheme: theme, reducedMotion: 'reduce' });
          if (scene.cookie) {
            const { url, cookie } = scene.cookie();
            const [name, value] = cookie.split(/=(.*)/s);
            await context.addCookies([{ name, value, url }]);
          }
          const page = await context.newPage();
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          const { answer, doc } = await scene.open(page);
          await page.waitForLoadState('load');
          await page.waitForTimeout(150);
          // Verify after the settle: the page answered as the state says, as a page, and its heading is on screen.
          expect(answer.status(), `${scene.name} answered`).toBe(scene.status);
          expect(answer.headers()['content-type'], `${scene.name} is a page`).toMatch(/^text\/html/);
          expect(await doc.locator('h1, h2').first().isVisible(), `${scene.name} shows its heading`).toBe(true);
          expect(errors, `${scene.name} ran without errors`).toEqual([]);
          const file = join(OUT, `${scene.name}--${width}--${theme}.png`);
          await page.screenshot({ path: file });
          written.push(file);
          await context.close();
        }
      }
    }
    const onDisk = readdirSync(OUT).filter((f) => f.endsWith('.png'));
    for (const file of written) expect(onDisk).toContain(file.split('/').pop());
    expect(written.length).toBe(chosen.length * Object.keys(WIDTHS).length * THEMES.length);
  });
});
