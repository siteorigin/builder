/**
 * Waits on the viewer's own page go through selectors or polls from here: its policy refuses `eval`, which Playwright
 * needs to poll a predicate written as a string. The preview's pages have no such policy.
 *
 * The guest's viewer in a real headless browser, against the relay in Cloudflare's local simulator: a guest opens the
 * invite link, asks to join, waits, is let in, and watches the host's site in the frame, while the test plays the host
 * over the relay's own protocol and answers the preview requests that frame makes. The viewer is on
 * `relay.localhost:<port>` and each room's preview on `p-<label>.relay.localhost:<port>`, so the preview cookie works
 * as it does in production.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roomPreviewOrigin } from '../../src/shared/live/relay-url';
import { answerPreview, openRoom, reconnectHost, startRelay, wait, type HostPeer, type OpenedRoom, type Relay } from './relay-harness';

const browserInstalled = existsSync(chromium.executablePath());
const enc = (text: string) => new TextEncoder().encode(text);

let relay: Relay;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  if (!browserInstalled) return;
  relay = await startRelay({ HOST_RECONNECT_GRACE_MS: '60000' });
  origin = await relay.browserOrigin();
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await relay?.dispose();
}, 60_000);

/** The host's site, by path, which a test may change between reloads. */
type Site = Map<string, string>;

const page = (title: string, extra = '') => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><nav><a href="/">Home</a> <a href="/about/">About</a></nav>${extra}</body></html>`;

/**
 * Play the host's preview server: answer every preview request the room's host socket is sent from `site`, until
 * stopped. `host()` names the host's current socket, which changes when the host reconnects.
 */
function serve(host: () => HostPeer, site: Site) {
  let stopped = false;
  const asked: string[] = [];
  void (async () => {
    while (!stopped) {
      const request = host().take('preview:request', () => true);
      if (request) {
        asked.push(request.target);
        const html = site.get(request.target.split('?')[0]);
        if (html === undefined) answerPreview(host(), request.requestId, { status: 404, headers: [['content-type', 'text/plain']], body: enc('Not found') });
        else answerPreview(host(), request.requestId, { headers: [['content-type', request.target.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8']], body: enc(html) });
      }
      await wait(10);
    }
  })();
  return { asked, stop: () => (stopped = true) };
}

interface Scene {
  room: OpenedRoom;
  host: HostPeer;
  previewOrigin: string;
  context: BrowserContext;
  tab: Page;
  site: Site;
  server: ReturnType<typeof serve>;
  done: () => Promise<void>;
}

/** A room, its host serving `site`, and a guest's tab open on the invite link. */
async function scene(options: { site?: Site; duration?: '2h' | '30m' } = {}): Promise<Scene> {
  const room = await openRoom(relay, { projectName: 'Acme Bakery', duration: options.duration });
  const site = options.site ?? new Map([['/', page('Home')], ['/about/', page('About')]]);
  const s = { room, host: room.host } as Scene;
  s.site = site;
  s.server = serve(() => s.host, site);
  s.previewOrigin = await roomPreviewOrigin(origin, room.roomId);
  s.context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  s.tab = await s.context.newPage();
  await s.tab.goto(`${origin}/s/${room.roomId}`);
  s.done = async () => {
    s.server.stop();
    await s.context.close();
    s.host.close();
  };
  return s;
}

/** Ask to join under `name`, and wait for the host to hear of it. */
async function ask(s: Scene, name = 'Ann') {
  await s.tab.fill('#name', name);
  await s.tab.click('#join-button');
  const roster = await s.host.next('room:roster');
  const pending = roster.participants.find((p) => p.status === 'pending' && p.displayName === name.trim().replace(/\s+/g, ' '));
  expect(pending, 'the host hears of the request').toBeTruthy();
  return pending!.guestId;
}

/** The host lets the guest in; resolves once the frame shows the host's site. */
async function admit(s: Scene, guestId: string, role: 'viewer' | 'collaborator' = 'viewer', guestExpiresAt: number | null = null) {
  s.host.send('host-to-relay', { type: 'guest:admit', guestId, role, guestExpiresAt });
  await s.host.next('room:roster');
  await s.tab.waitForSelector('#connection[data-state="live"]');
  return preview(s);
}

/** The preview frame, once it is on a page of the site. */
async function preview(s: Scene): Promise<Frame> {
  for (let i = 0; i < 200; i++) {
    const frame = s.tab.frames().find((f) => f.url().startsWith(s.previewOrigin));
    if (frame) {
      await frame.waitForSelector('h1');
      return frame;
    }
    await wait(25);
  }
  throw new Error('No preview frame');
}

const heading = async (s: Scene) => (await preview(s)).textContent('h1');
const frameCount = (s: Scene) => s.tab.locator('iframe').count();

describe.skipIf(!browserInstalled)('the guest’s viewer', { timeout: 30_000 }, () => {
  it('asks for a name, waits for the host, and shows nothing of the site until the guest is let in', async () => {
    const s = await scene();
    try {
      expect(await s.tab.textContent('h1')).toBe('Join the live session');
      // A name that is only spaces is not sent.
      await s.tab.fill('#name', '   ');
      await s.tab.click('#join-button');
      expect(await s.tab.isVisible('#name-error')).toBe(true);
      await wait(200);
      expect(s.host.has('room:roster')).toBe(false);

      await ask(s, '  Ann   Lee ');
      await s.tab.waitForSelector('[data-phase="pending"]');
      expect(await s.tab.textContent('#screen-title')).toBe('Waiting for the host');
      expect(await s.tab.textContent('#screen-text')).toContain('Ann Lee');
      expect(await frameCount(s)).toBe(0);
      // The preview itself turns the guest away until the host lets them in, and shows nothing of the site.
      const direct = await s.tab.evaluate(async (url) => {
        const response = await fetch(url, { credentials: 'include' }).catch(() => null);
        return response ? { status: response.status, body: await response.text() } : null;
      }, `${s.previewOrigin}/`);
      // Cross-origin with no CORS: the fetch itself fails, which is the browser keeping the response from the page.
      expect(direct === null || direct.status === 401).toBe(true);
      const outsider = await browser.newContext();
      const response = await (await outsider.newPage()).goto(`${s.previewOrigin}/`);
      expect(response!.status()).toBe(401);
      expect(await response!.text()).not.toContain('Home');
      await outsider.close();
      expect(s.server.asked).toEqual([]);
    } finally {
      await s.done();
    }
  });

  it('shows the live site once admitted, behind a cookie only the preview origin holds, and reloads the page the guest is on', async () => {
    const s = await scene({ site: new Map([['/', page('Home')], ['/about/', page('About', '<div style="height:4000px"></div><p id="end">End</p>')]]) });
    try {
      const guestId = await ask(s);
      let frame = await admit(s, guestId);
      expect(await frame.textContent('h1')).toBe('Home');
      // The site may not navigate the viewer away from its own page.
      expect(await s.tab.getAttribute('iframe', 'sandbox')).not.toContain('allow-top-navigation');
      expect(await s.tab.textContent('#site-title')).toBe('Acme Bakery');
      expect(await s.tab.textContent('#role')).toBe('Viewer');
      expect(await s.tab.textContent('#time')).toMatch(/^Ends in (1h 59m|2h 00m)$/);
      const cookies = await s.context.cookies(s.previewOrigin);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatchObject({ name: 'so_preview', httpOnly: true, sameSite: 'Lax', path: '/', domain: new URL(s.previewOrigin).hostname });
      // The viewer's own origin holds nothing.
      expect(await s.context.cookies(origin)).toEqual([]);

      // The guest browses on their own, scrolls, and the host changes the page.
      await frame.click('a[href="/about/"]');
      await s.tab.waitForSelector('iframe');
      frame = await preview(s);
      await frame.waitForFunction(`document.querySelector('h1')?.textContent === 'About'`);
      await frame.evaluate(`window.scrollTo(0, 1500)`);
      s.site.set('/about/', page('About, updated', '<div style="height:4000px"></div>'));
      s.host.send('host-to-relay', { type: 'preview:reload' });
      for (let i = 0; i < 100 && (await heading(s).catch(() => null)) !== 'About, updated'; i++) await wait(50);
      frame = await preview(s);
      expect(await frame.textContent('h1')).toBe('About, updated');
      expect(new URL(frame.url()).pathname).toBe('/about/');
      await frame.waitForFunction(`window.scrollY === 1500`);
    } finally {
      await s.done();
    }
  });

  it('follows the host’s page and width, lets the guest browse on their own, and resizes to each preset', async () => {
    const s = await scene();
    try {
      // The host is already on a page when the guest comes in: the guest starts there.
      s.host.send('host-to-relay', { type: 'presence:update', presence: { pageId: 'pg_about', viewportWidth: 834, selection: null, previewPath: '/about/' } });
      const guestId = await ask(s);
      let frame = await admit(s, guestId);
      expect(await frame.textContent('h1')).toBe('About');
      expect(await frame.evaluate<number>(`window.innerWidth`)).toBe(834);

      s.host.send('host-to-relay', { type: 'presence:update', presence: { pageId: 'pg_home', viewportWidth: 1280, selection: null, previewPath: '/' } });
      await s.tab.waitForSelector('#live-session[data-frame-width="1280"]', { state: 'attached' });
      for (let i = 0; i < 100 && (await heading(s).catch(() => null)) !== 'Home'; i++) await wait(50);
      frame = await preview(s);
      expect(await frame.textContent('h1')).toBe('Home');
      expect(await frame.evaluate<number>(`window.innerWidth`)).toBe(1280);

      // A preset changes only the width: the guest still follows the host's page, until they stop following.
      await s.tab.click('[data-viewport="mobile"]');
      expect(await s.tab.isChecked('#follow')).toBe(true);
      await frame.waitForFunction(`window.innerWidth === 390`);
      await s.tab.uncheck('#follow');
      s.host.send('host-to-relay', { type: 'presence:update', presence: { pageId: 'pg_about', viewportWidth: 1024, selection: null, previewPath: '/about/' } });
      await wait(400);
      expect(await (await preview(s)).textContent('h1')).toBe('Home');
      await s.tab.click('[data-viewport="tablet"]');
      await (await preview(s)).waitForFunction(`window.innerWidth === 834`);
      expect(await s.tab.getAttribute('[data-viewport="tablet"]', 'aria-pressed')).toBe('true');
      await s.tab.click('[data-viewport="desktop"]');
      await (await preview(s)).waitForFunction(`window.innerWidth === 1280`);

      // Following again goes straight to where the host is, and Host takes the host's width again.
      await s.tab.check('#follow');
      await s.tab.click('[data-viewport="host"]');
      for (let i = 0; i < 100 && (await heading(s).catch(() => null)) !== 'About'; i++) await wait(50);
      frame = await preview(s);
      expect(await frame.textContent('h1')).toBe('About');
      expect(await frame.evaluate<number>(`window.innerWidth`)).toBe(1024);
    } finally {
      await s.done();
    }
  });

  it('removes the frame the moment the host removes the guest, and the cookie no longer opens the preview', async () => {
    const s = await scene();
    try {
      const guestId = await ask(s);
      await admit(s, guestId);
      s.host.send('host-to-relay', { type: 'guest:kick', guestId });
      await s.tab.waitForSelector('[data-phase="kicked"]');
      expect(await frameCount(s)).toBe(0);
      expect(await s.tab.textContent('#screen-title')).toBe('You were removed');
      const tab = await s.context.newPage();
      const response = await tab.goto(`${s.previewOrigin}/`);
      expect(response!.status()).toBe(403);
      // A reload does not take the place back.
      await s.tab.reload();
      expect(await s.tab.textContent('#screen-title')).toBe('Join the live session');
    } finally {
      await s.done();
    }
  });

  it('never shows the site when the guest is removed while its cookie is on the way', async () => {
    const s = await scene();
    try {
      // Count every frame the page ever makes, not only the ones left at the end.
      await s.tab.evaluate(`(() => {
        window.framesMade = 0;
        new MutationObserver((records) => {
          for (const record of records) for (const node of record.addedNodes) if (node.nodeName === 'IFRAME') window.framesMade++;
        }).observe(document.body, { childList: true, subtree: true });
      })()`);
      // The relay redeems the ticket and sets the cookie; its answer is held back from the page until after the kick.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let redeemed: number | null = null;
      let delivered = false;
      await s.tab.route(`${s.previewOrigin}/__siteorigin/admission`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        redeemed = response.status();
        await gate;
        await route.fulfill({ response });
        delivered = true;
      });
      const guestId = await ask(s);
      s.host.send('host-to-relay', { type: 'guest:admit', guestId, role: 'viewer', guestExpiresAt: null });
      for (let i = 0; i < 200 && redeemed === null; i++) await wait(25);
      expect(redeemed).toBe(204);
      s.host.send('host-to-relay', { type: 'guest:kick', guestId });
      await s.tab.waitForSelector('[data-phase="kicked"]');
      release();
      for (let i = 0; i < 200 && !delivered; i++) await wait(25);
      expect(delivered).toBe(true);
      await wait(300);
      expect(await s.tab.evaluate<number>(`window.framesMade`)).toBe(0);
      expect(await s.tab.getAttribute('#live-session', 'data-phase')).toBe('kicked');
    } finally {
      await s.done();
    }
  });

  it('says why when the host ends the session, and when the guest’s own access runs out', async () => {
    const s = await scene();
    try {
      const guestId = await ask(s);
      await admit(s, guestId);
      s.host.send('host-to-relay', { type: 'room:end' });
      await s.tab.waitForSelector('[data-phase="ended"]');
      expect(await frameCount(s)).toBe(0);
      // The status ends the visit at once; the close that follows names the reason on the same screen.
      await expect.poll(() => s.tab.textContent('#screen-title')).toBe('The host ended the session');
      // The bar stays, saying so, with the live controls gone.
      expect(await s.tab.textContent('#connection')).toBe('Ended');
      expect(await s.tab.isVisible('#follow')).toBe(false);
    } finally {
      await s.done();
    }

    const t = await scene();
    try {
      const guestId = await ask(t);
      await admit(t, guestId, 'viewer', Date.now() + 2500);
      await t.tab.waitForSelector('[data-phase="expired-guest"]', { timeout: 10_000 });
      expect(await frameCount(t)).toBe(0);
      expect(await t.tab.textContent('#screen-title')).toBe('Your access has ended');
    } finally {
      await t.done();
    }
  });

  it('says so while the host is reconnecting, waiting or watching, and carries on when the host is back', async () => {
    const s = await scene();
    try {
      const annId = await ask(s, 'Ann');
      await admit(s, annId);
      const bob = await s.context.browser()!.newContext({ viewport: { width: 1400, height: 900 } });
      const bobTab = await bob.newPage();
      await bobTab.goto(`${origin}/s/${s.room.roomId}`);
      await bobTab.fill('#name', 'Bob');
      await bobTab.click('#join-button');
      await s.host.next('room:roster');
      await bobTab.waitForSelector('[data-phase="pending"]');

      s.host.close();
      // Only the host is away: the site stays, and a band above it says so.
      await s.tab.waitForSelector('#connection[data-state="host-away"]');
      expect(await s.tab.isVisible('#host-note')).toBe(true);
      expect(await frameCount(s)).toBe(1);
      await expect.poll(() => bobTab.textContent('#screen-title')).toBe('The host is reconnecting');

      const asked = s.server.asked.length;
      s.host = (await reconnectHost(relay, s.room.roomId, s.room.keys)).host;
      await s.tab.waitForSelector('#connection[data-state="live"]');
      // Whatever the frame loaded while the host was away is loaded again.
      for (let i = 0; i < 100 && s.server.asked.length === asked; i++) await wait(25);
      expect(s.server.asked.slice(asked)).toContain('/');
      expect(await heading(s)).toBe('Home');
      await expect.poll(() => bobTab.textContent('#screen-title')).toBe('Waiting for the host');
      await bob.close();
    } finally {
      await s.done();
    }
  });

  it('takes its place back after its connection drops, and after the page is reloaded', async () => {
    const s = await scene();
    try {
      const guestId = await ask(s);
      await admit(s, guestId);
      await s.tab.reload();
      await s.tab.waitForSelector('#connection[data-state="live"]');
      expect(await heading(s)).toBe('Home');
      // Still the same guest: the host was never asked again.
      await wait(200);
      expect(s.host.take('room:roster', (r) => r.participants.some((p) => p.status === 'pending'))).toBeUndefined();
    } finally {
      await s.done();
    }
  });

  it('turns the guest away from a locked room, and lets them ask again after a decline', async () => {
    const s = await scene();
    try {
      s.host.send('host-to-relay', { type: 'room:set-locked', locked: true });
      await s.host.next('room:state');
      await s.tab.fill('#name', 'Ann');
      await s.tab.click('#join-button');
      await s.tab.waitForSelector('[data-phase="locked"]');
      expect(await s.tab.textContent('#screen-title')).toBe('This session is locked');

      s.host.send('host-to-relay', { type: 'room:set-locked', locked: false });
      await s.host.next('room:state');
      await s.tab.click('#screen-action');
      const roster = await s.host.next('room:roster');
      const guestId = roster.participants[0].guestId;
      await s.tab.waitForSelector('[data-phase="pending"]');
      s.host.send('host-to-relay', { type: 'guest:decline', guestId });
      await s.tab.waitForSelector('[data-phase="declined"]');
      await s.tab.click('#screen-action');
      expect(await s.tab.inputValue('#name')).toBe('Ann');
    } finally {
      await s.done();
    }
  });

  it('points at what the guest clicks, for the host alone, without the click doing anything else, and stops on Escape (#768)', async () => {
    // The editor's preview marks each element with where it is in the project (src/generator, idAttrs).
    const marked = `<!doctype html><html><head><title>Home</title></head><body style="margin:0"><h1>Home</h1><div style="height:1200px"></div><section data-so-ctx="page:pg_home|n_card" data-so-node="n_title" data-so-items="it%2C1,it_2"><a id="go" href="/about/" style="display:block;height:40px">About</a></section><div style="height:1200px"></div></body></html>`;
    const s = await scene({ site: new Map([['/', marked], ['/about/', page('About', '<a id="notes" href="/notes.txt">Notes</a>')], ['/notes.txt', 'Plain notes']]) });
    try {
      const guestId = await ask(s);
      const frame = await admit(s, guestId);
      expect(await s.tab.isDisabled('#point')).toBe(false);
      await s.tab.click('#point');
      expect(await s.tab.getAttribute('#point', 'aria-pressed')).toBe('true');
      expect(await s.tab.isVisible('#point-hint')).toBe(true);
      await frame.waitForSelector('html[data-siteorigin-pointing]', { state: 'attached' });
      await frame.click('#go');
      const pointed = await s.host.next('spotlight:pointed');
      expect(pointed).toMatchObject({ guestId, spotlight: { previewPath: '/', target: { owner: { kind: 'page', id: 'pg_home' }, instancePath: ['n_card'], nodeId: 'n_title', itemPath: ['it,1', 'it_2'] } } });
      // The point is where the click landed, as shares of the whole page.
      const expected = (await frame.evaluate(`(() => { const r = document.getElementById('go').getBoundingClientRect(); const d = document.documentElement; return { x: (r.left + r.width / 2 + scrollX) / d.scrollWidth, y: (r.top + r.height / 2 + scrollY) / d.scrollHeight }; })()`)) as { x: number; y: number };
      expect(pointed.spotlight.x).toBeCloseTo(expected.x, 2);
      expect(pointed.spotlight.y).toBeCloseTo(expected.y, 2);
      // One click: the link was not followed, and pointing is over.
      expect(new URL(frame.url()).pathname).toBe('/');
      expect(await s.tab.getAttribute('#point', 'aria-pressed')).toBe('false');
      expect(await frame.$('html[data-siteorigin-pointing]')).toBeNull();

      // Somewhere the page names nothing is pointed at as a point alone.
      await wait(600);
      await s.tab.click('#point');
      await frame.waitForSelector('html[data-siteorigin-pointing]', { state: 'attached' });
      await frame.click('h1');
      expect((await s.host.next('spotlight:pointed')).spotlight).toMatchObject({ previewPath: '/', target: null });

      // Escape stops pointing, and the next click is the site's own again.
      await s.tab.click('#point');
      await frame.waitForSelector('html[data-siteorigin-pointing]', { state: 'attached' });
      await s.tab.keyboard.press('Escape');
      await s.tab.waitForSelector('#point[aria-pressed="false"]');
      await frame.click('#go');
      await frame.waitForURL(/\/about\/$/);
      await wait(200);
      expect(s.host.has('spotlight:pointed')).toBe(false);

      // A page the site goes on to that has no bridge (a plain file) cannot be pointed at: Point waits for one that has.
      await s.tab.waitForSelector('#point:not([disabled])');
      await frame.click('#notes');
      await s.tab.waitForSelector('#point[disabled]');
    } finally {
      await s.done();
    }
  });

  it('offers a collaborator the invite link for SiteOrigin Builder', async () => {
    const s = await scene();
    try {
      await s.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      const guestId = await ask(s);
      await admit(s, guestId, 'collaborator');
      expect(await s.tab.textContent('#role')).toBe('Collaborator');
      await s.tab.click('#copy-invite');
      expect(await s.tab.isVisible('#handoff')).toBe(true);
      expect(await s.tab.inputValue('#handoff-link')).toBe(`${origin}/s/${s.room.roomId}`);
      await s.tab.click('#handoff-copy');
      expect(await s.tab.evaluate<string>(`navigator.clipboard.readText()`)).toBe(`${origin}/s/${s.room.roomId}`);
    } finally {
      await s.done();
    }
  });
});
