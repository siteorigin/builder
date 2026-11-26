/**
 * Design captures of the guest's viewer (relay/viewer/): every phase from name entry to each end state, at desktop and
 * phone widths, in light and dark. Opt-in: it runs only with DESIGN_CAPTURE_DIR set, and writes one PNG per state,
 * width and theme there (`<state>--<width>--<theme>.png`). It never runs in CI.
 *
 *   DESIGN_CAPTURE_DIR=/abs/dir npx vitest run tests/unit/relay-viewer-capture.test.ts
 *   DESIGN_CAPTURE_ONLY=pending,kicked narrows it to some states.
 *
 * The page, its script, styles and Content Security Policy are the relay's own, served by the relay in Cloudflare's
 * local simulator. What reaches the page is played through its one seam, the room's socket: the guest's socket is
 * replaced by one that answers with the relay's own frames and close codes for each scene, so states the real relay
 * only reaches after minutes (a lost connection, a session's end) are as quick to reach as the rest. The preview's
 * admission answers as the relay does, and its frame loads a stand-in site from the room's real preview origin.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roomPreviewOrigin } from '../../src/shared/live/relay-url';
import { openRoom, startRelay, wait, type OpenedRoom, type Relay } from './relay-harness';

const OUT = process.env.DESIGN_CAPTURE_DIR ?? '';
const ONLY = (process.env.DESIGN_CAPTURE_ONLY ?? '').split(',').filter(Boolean);
const browserInstalled = existsSync(chromium.executablePath());

/** One step the stand-in socket takes: send a frame, close with a code, or wait. */
type Step = { frame: Record<string, unknown> } | { close: number } | { wait: number };

/**
 * A scene: what the socket does once the guest asks to join (`onJoin`), and on later connections (`onRejoin`, for
 * a viewer taking its place back). `open: false` is a socket that never opens. `admission` is how the preview ticket's
 * redemption answers. `act` drives the page to the state, and `ready` is the selector that says it is there.
 */
interface Scene {
  name: string;
  /** Start from a place already in this tab (a reload), so the viewer joins at once. */
  resume?: boolean;
  open?: boolean;
  onJoin?: Step[];
  onRejoin?: Step[];
  admission?: 'ok' | 'fail' | 'hang';
  /** `hang`: the site's pages never arrive, so the frame never finishes its first load. */
  site?: 'ok' | 'hang';
  /** Move the page's clock on this far each time a socket closes unasked, so long waits pass at once. */
  warpOnClose?: number;
  act?: (page: Page) => Promise<void>;
  ready: string;
  settle?: number;
}

const HOUR = 3_600_000;
const status = (s: Record<string, unknown>) => ({ frame: { type: 'guest:status', ...s } });
const pending: Step = status({ status: 'pending', resumeToken: 'resume-token' });
const presence = (previewPath: string, viewportWidth: number): Step => ({
  frame: { type: 'presence:changed', participant: { kind: 'host', id: 'host' }, presence: { pageId: 'pg_home', viewportWidth, selection: null, previewPath } }
});
/** Let in, as the relay says it, with the session's clock; `guestExpiresIn` is the guest's own deadline from now. */
const admitted = (role = 'viewer', guestExpiresIn: number | null = null): Step => ({
  frame: { type: 'guest:status', status: 'admitted', role, projectName: 'Acme Bakery', previewTicket: 'ticket-1', sessionExpiresAt: '__NOW+' + 2 * HOUR, guestExpiresAt: guestExpiresIn === null ? null : '__NOW+' + guestExpiresIn, now: '__NOW' }
});
const inRoom: Step[] = [pending, { wait: 50 }, presence('/', 1280), admitted()];
const live = '#connection[data-state="live"]';

/** Open (or, again, close) the phone's view options when the bar keeps them behind its button. */
async function openOptions(page: Page) {
  if (await page.isVisible('#bar-more')) await page.click('#bar-more');
}

async function askToJoin(page: Page, name = 'Ann Lee') {
  await page.fill('#name', name);
  await page.click('#join-button');
}

/** Join, get let in, watch the site live, then the rest of `then` arrives. */
function afterWatching(then: Step[], extra: Partial<Scene> = {}): Partial<Scene> {
  return {
    onJoin: [...inRoom, { wait: 1200 }, ...then],
    act: (page) => askToJoin(page),
    ...extra
  };
}

const SCENES: Scene[] = [
  { name: 'name', ready: '[data-phase="name"]' },
  { name: 'name-error', act: (page) => page.click('#join-button'), ready: '#name-error:not([hidden])' },
  { name: 'connecting', open: false, act: (page) => askToJoin(page), ready: '[data-phase="connecting"]' },
  { name: 'pending', onJoin: [pending], act: (page) => askToJoin(page), ready: '[data-phase="pending"]' },
  { name: 'pending-host-away', onJoin: [pending, { frame: { type: 'host:availability', connected: false } }], act: (page) => askToJoin(page), ready: '[data-phase="pending"]' },
  { name: 'admitted', onJoin: inRoom, act: (page) => askToJoin(page), ready: live, settle: 900 },
  { name: 'admitted-own-width', onJoin: inRoom, act: async (page) => { await askToJoin(page); await page.waitForSelector(live); await openOptions(page); await page.click('[data-viewport="tablet"]'); await openOptions(page); }, ready: live, settle: 900 },
  { name: 'admitted-options', onJoin: inRoom, act: async (page) => { await askToJoin(page); await page.waitForSelector(live); await openOptions(page); }, ready: live, settle: 900 },
  { name: 'admitted-countdown', onJoin: [pending, presence('/', 1280), admitted('viewer', 4 * 60_000 + 30_000)], act: (page) => askToJoin(page), ready: live, settle: 900 },
  { name: 'admitted-collaborator', onJoin: [pending, presence('/', 1280), admitted('collaborator')], act: async (page) => { await askToJoin(page); await page.waitForSelector(live); await openOptions(page); await page.click('#copy-invite'); }, ready: '#handoff:not([hidden])', settle: 900 },
  { name: 'admitted-slow', onJoin: inRoom, site: 'hang', act: (page) => askToJoin(page), ready: '#connection[data-state="slow"]', settle: 300 },
  { name: 'admitted-opening', onJoin: inRoom, admission: 'hang', act: (page) => askToJoin(page), ready: '[data-phase="admitted"]', settle: 400 },
  { name: 'admitted-preview-failed', onJoin: inRoom, admission: 'fail', act: (page) => askToJoin(page), ready: '[data-phase="admitted"]', settle: 600 },
  { name: 'admitted-host-away', ...afterWatching([{ frame: { type: 'host:availability', connected: false } }]), ready: '#host-note:not([hidden])', settle: 1700 },
  { name: 'admitted-reconnecting', open: true, ...afterWatching([{ close: 1006 }]), onRejoin: [], ready: '#connection[data-state="reconnecting"]', settle: 1700 },
  { name: 'admitted-time-up', onJoin: [pending, presence('/', 1280), admitted('viewer', 1500)], act: (page) => askToJoin(page), ready: '[data-phase="admitted"]', settle: 3200 },
  { name: 'unavailable', onJoin: [{ close: 1006 }], act: (page) => askToJoin(page), ready: '[data-phase="unavailable"]' },
  { name: 'lost', ...afterWatching([{ close: 1006 }]), onRejoin: [{ close: 1006 }], warpOnClose: 200_000, ready: '[data-phase="lost"]' },
  { name: 'replaced', ...afterWatching([{ close: 4003 }]), ready: '[data-phase="replaced"]' },
  { name: 'full', onJoin: [{ frame: { type: 'protocol:error', code: 'ROOM_FULL' } }, { close: 4005 }], act: (page) => askToJoin(page), ready: '[data-phase="full"]' },
  { name: 'locked', onJoin: [{ close: 4005 }], act: (page) => askToJoin(page), ready: '[data-phase="locked"]' },
  { name: 'declined', onJoin: [pending, { wait: 50 }, status({ status: 'declined' })], act: (page) => askToJoin(page), ready: '[data-phase="declined"]' },
  { name: 'kicked', ...afterWatching([status({ status: 'kicked' })]), ready: '[data-phase="kicked"]' },
  { name: 'expired-guest', ...afterWatching([status({ status: 'expired', scope: 'guest' })]), ready: '[data-phase="expired-guest"]' },
  { name: 'expired-session', ...afterWatching([status({ status: 'expired', scope: 'session' })]), ready: '[data-phase="expired-session"]' },
  { name: 'ended', ...afterWatching([status({ status: 'ended' }), { close: 1000 }]), ready: '[data-phase="ended"]' },
  { name: 'host-gone', ...afterWatching([status({ status: 'ended' }), { close: 4002 }]), ready: '[data-phase="host-gone"]' },
  { name: 'error', onJoin: [{ close: 1008 }], act: (page) => askToJoin(page), ready: '[data-phase="error"]' }
];

const WIDTHS = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
} as const;
const THEMES = ['light', 'dark'] as const;

/**
 * Installed in the page before its own script: the stand-in socket and admission. It runs in the viewer only, never
 * in the preview's frame. `__NOW` in a frame is the page's clock, so deadlines are measured from when it is sent.
 */
function installStandIns(scene: { open: boolean; onJoin: Step[]; onRejoin: Step[] | null; admission: string; warpOnClose: number; storageKey: string; resume: boolean }) {
  // The page's own globals, typed here rather than through the DOM lib, which would retype fetch and Response for
  // every file in the Node test project.
  const win = globalThis as unknown as { location: { hostname: string }; WebSocket: unknown; fetch: typeof fetch };
  if (win.location.hostname.startsWith('p-')) return;
  let warp = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => realNow() + warp;
  if (scene.resume) sessionStorage.setItem(scene.storageKey, JSON.stringify({ displayName: 'Ann Lee', resumeToken: 'resume-token' }));
  let joins = 0;
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string' && value.startsWith('__NOW')) return Date.now() + Number(value.slice(6) || 0);
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
    return value;
  };
  class StandInSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    constructor(public url: string) {
      super();
      if (!scene.open) return;
      setTimeout(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }, 30);
    }
    send(data: string) {
      const frame = JSON.parse(data);
      if (frame.type !== 'guest:join') return;
      const steps = joins++ === 0 ? scene.onJoin : (scene.onRejoin ?? scene.onJoin);
      void (async () => {
        for (const step of steps) {
          if (this.readyState !== 1) return;
          if ('wait' in step) await new Promise((r) => setTimeout(r, step.wait));
          else if ('frame' in step) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(fill(step.frame)) }));
          else {
            this.readyState = 3;
            warp += scene.warpOnClose;
            this.dispatchEvent(new CloseEvent('close', { code: step.close }));
          }
          await new Promise((r) => setTimeout(r, 20));
        }
      })();
    }
    close() {
      this.readyState = 3;
    }
  }
  win.WebSocket = StandInSocket;
  const realFetch = win.fetch.bind(win);
  win.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/__siteorigin/admission')) return realFetch(input, init);
    if (scene.admission === 'hang') return new Promise(() => {});
    return Promise.resolve(new Response(null, { status: scene.admission === 'fail' ? 500 : 204 }));
  };
}

/** The host's site, as the frame shows it: a small bakery's home page. */
const SITE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme Bakery</title>
<style>
body{margin:0;font:17px/1.6 Georgia,serif;color:#2b2118;background:#fbf6ef}
header{display:flex;justify-content:space-between;align-items:center;padding:20px 48px;background:#fff;border-bottom:1px solid #eadfce}
header b{font-size:24px;letter-spacing:.02em}nav a{margin-left:28px;color:#2b2118;text-decoration:none;font-family:system-ui;font-size:15px}
.hero{display:grid;grid-template-columns:1.1fr 1fr;gap:48px;align-items:center;padding:72px 48px}
.hero h1{font-size:56px;line-height:1.05;margin:0 0 20px}.hero p{font-size:20px;color:#6b5847;margin:0 0 28px}
.cta{display:inline-block;padding:14px 26px;border-radius:999px;background:#b5562b;color:#fff;font-family:system-ui;font-weight:600;text-decoration:none}
.photo{height:360px;border-radius:24px;background:linear-gradient(135deg,#e9b27d,#b5562b 60%,#6d2f17)}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:0 48px 72px}
.cards div{background:#fff;border-radius:18px;padding:24px;border:1px solid #eadfce}.cards h3{margin:0 0 8px}
@media (max-width:700px){header{padding:16px 20px}nav{display:none}.hero{grid-template-columns:1fr;padding:32px 20px}.hero h1{font-size:38px}.cards{grid-template-columns:1fr;padding:0 20px 40px}.photo{height:220px}}
</style></head><body>
<header><b>Acme Bakery</b><nav><a href="/">Home</a><a href="/menu/">Menu</a><a href="/about/">About</a><a href="/visit/">Visit us</a></nav></header>
<section class="hero"><div><h1>Bread worth getting up early for</h1><p>Sourdough, rye and pastries baked every morning in the heart of town since 1998.</p><a class="cta" href="/menu/">See today’s bakes</a></div><div class="photo"></div></section>
<section class="cards"><div><h3>Sourdough</h3><p>Three-day ferment, crackling crust.</p></div><div><h3>Pastries</h3><p>Laminated by hand, every single morning.</p></div><div><h3>Cakes to order</h3><p>Birthdays, weddings and everything between.</p></div></section>
</body></html>`;

let relay: Relay;
let browser: Browser;
let origin: string;
let room: OpenedRoom;
let preview: string;

describe.skipIf(!OUT || !browserInstalled)('design captures of the guest’s viewer', { timeout: 600_000 }, () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    relay = await startRelay();
    origin = await relay.browserOrigin();
    room = await openRoom(relay, { projectName: 'Acme Bakery' });
    preview = await roomPreviewOrigin(origin, room.roomId);
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    room?.host.close();
    await relay?.dispose();
  }, 60_000);

  it('captures every state at each width and theme', async () => {
    const scenes = ONLY.length ? SCENES.filter((s) => ONLY.includes(s.name)) : SCENES;
    const written: string[] = [];
    for (const scene of scenes) {
      for (const [width, device] of Object.entries(WIDTHS)) {
        for (const theme of THEMES) {
          const context = await browser.newContext({ ...device, colorScheme: theme, reducedMotion: 'reduce' });
          await context.route(`${preview}/**`, (route) => (scene.site === 'hang' ? undefined : route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: SITE })));
          await context.addInitScript(installStandIns, {
            open: scene.open ?? true,
            onJoin: scene.onJoin ?? [],
            onRejoin: scene.onRejoin ?? null,
            admission: scene.admission ?? 'ok',
            warpOnClose: scene.warpOnClose ?? 0,
            storageKey: `siteorigin-live:${room.roomId}`,
            resume: scene.resume ?? false
          });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(`${origin}/s/${room.roomId}`);
          await page.waitForSelector('[data-phase]');
          await scene.act?.(page);
          await page.waitForSelector(scene.ready, { state: 'attached', timeout: 15_000 });
          await wait(scene.settle ?? 250);
          // Verify after the settle, so a late frame cannot leave a different state on the image.
          expect(await page.locator(scene.ready).count(), `${scene.name} is still on screen`).toBeGreaterThan(0);
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
    expect(written.length).toBe(scenes.length * Object.keys(WIDTHS).length * THEMES.length);
  });
});
