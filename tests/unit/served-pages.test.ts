/**
 * The pages the app itself answers a browser with when there is no site to show (src/shared/status-page.ts): the
 * relay's refusals opened in a tab or the viewer's frame (relay/src/pages.ts), and the exported website's preview when
 * its folder has gone or a page is missing (src/main/static-preview.ts). A browser opening the address gets a page;
 * every other client keeps the plain answer it always had, with the same status.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { StaticPreviews } from '../../src/main/static-preview';
import { statusPage } from '../../src/shared/status-page';
import { admittedGuest, openRoom, startRelay, wait, type Relay } from './relay-harness';

const DOCUMENT = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' };
const ROOM = 'c'.repeat(24);

describe('the status page', () => {
  it('is a whole, accessible document that follows the system theme, with every value escaped', () => {
    const html = statusPage({
      title: 'Page <not> found',
      heading: 'Nothing at "x"',
      text: ['No page at ', { code: '/<script>alert(1)</script>' }, '.'],
      next: 'Check & try again.',
      action: { label: 'Home', href: '/base/"><script>' },
      icon: 'unlink',
      tone: 'amber',
      brand: { mark: 'https://relay.test/_viewer/mark.svg', label: 'Export preview' }
    });
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('@media (prefers-color-scheme:dark)');
    expect(html).toContain('<title>Page &#60;not&#62; found · SiteOrigin Builder</title>');
    expect(html).toContain('<code>/&#60;script&#62;alert(1)&#60;/script&#62;</code>');
    expect(html).toContain('href="/base/&#34;&#62;&#60;script&#62;"');
    expect(html).not.toMatch(/<script/);
    expect(html).toContain('<main class="screen">');
    expect(html).toContain('<img src="https://relay.test/_viewer/mark.svg" alt=""');
    expect(html).toContain('<span>Export preview</span>');
  });

  it('in a frame is the viewer’s notice, with no brand line, and only the head it is given', () => {
    const html = statusPage({ title: 'Preview unavailable', heading: 'Gone', text: 'Gone.', icon: 'lock', framed: true, brand: { label: 'x' }, head: '<script src="https://p.test/b.js" data-refused></script>\n' });
    expect(html).toContain('<main class="veil"><div class="notice">');
    expect(html).toContain('<h2>Gone</h2>');
    expect(html).not.toContain('class="brand"');
    expect(html).toContain('<script src="https://p.test/b.js" data-refused></script>');
  });
});

describe('the relay’s refusals', () => {
  let relay: Relay;
  beforeAll(async () => {
    relay = await startRelay({ HOST_RECONNECT_GRACE_MS: '60000' });
  }, 60_000);
  afterAll(() => relay?.dispose());

  it('are a page only for a browser opening the address in a tab', async () => {
    const isPage = async (headers: Record<string, string>, method = 'GET') => {
      const answer = await relay.http('/s/not-a-room', { method, headers });
      await answer.arrayBuffer();
      return answer.headers.get('content-type')?.startsWith('text/html') ?? false;
    };
    expect(await isPage(DOCUMENT)).toBe(true);
    expect(await isPage(DOCUMENT, 'HEAD')).toBe(true);
    // Without Fetch Metadata, only a request that asks for HTML by name.
    expect(await isPage({ accept: 'text/html,application/xhtml+xml,*/*;q=0.8' })).toBe(true);
    expect(await isPage({ accept: 'text/html;q=0, text/plain' })).toBe(false);
    expect(await isPage({ accept: '*/*' })).toBe(false);
    expect(await isPage({})).toBe(false);
    // Any other destination keeps the text, even asking for HTML; the viewer's frame gets the framed notice.
    for (const dest of ['empty', 'script', 'image']) expect(await isPage({ 'sec-fetch-dest': dest, accept: 'text/html' }), dest).toBe(false);
    expect(await isPage({ ...DOCUMENT, upgrade: 'websocket' })).toBe(false);
    expect(await isPage(DOCUMENT, 'POST')).toBe(false);
  });

  it('are a page for a browser and the same line as before for anything else, chosen by the request', async () => {
    const page = await relay.http('/s/not-a-room', { headers: DOCUMENT });
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('vary')).toBe('Sec-Fetch-Dest, Accept');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('<h1>This invite link doesn’t work</h1>');
    expect(html).toContain('src="http://relay.test/_viewer/mark.svg"');

    const text = await relay.http('/s/not-a-room');
    expect(text.status).toBe(404);
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(text.headers.get('vary')).toBe('Sec-Fetch-Dest, Accept');
    expect(await text.text()).toBe('Not found.\n');

    expect(await (await relay.http('/', { headers: DOCUMENT })).text()).toContain('<h1>Page not found</h1>');
    const head = await relay.http('/s/not-a-room', { method: 'HEAD', headers: DOCUMENT });
    expect([head.status, head.headers.get('content-type'), await head.text()]).toEqual([404, 'text/html; charset=utf-8', '']);
    // A socket's address opened in a tab keeps its own status. (The runtime drops the hop-by-hop Upgrade header from
    // either answer, so it is not asserted here.)
    const socket = await relay.http('/ws/host', { headers: DOCUMENT });
    expect([socket.status, socket.headers.get('content-type')]).toEqual([426, 'text/html; charset=utf-8']);
    expect(await socket.text()).toContain('<h1>Page not found</h1>');
    // A live session's own socket address leads to its invite link.
    const room = await relay.http(`/s/${ROOM}/ws`, { headers: DOCUMENT });
    expect(room.status).toBe(426);
    const roomHtml = await room.text();
    expect(roomHtml).toContain('<h1>This isn’t the invite link</h1>');
    expect(roomHtml).toContain(`<a class="btn" href="/s/${ROOM}">Open the invite link</a>`);
  });

  it('never show a browser the relay’s own configuration', async () => {
    const broken = await startRelay({ RELAY_ORIGIN: 'not an origin' });
    try {
      const html = await (await broken.http(`/s/${ROOM}`, { headers: DOCUMENT })).text();
      expect(html).toContain('<h1>Live sessions aren’t available here</h1>');
      expect(html).not.toContain('RELAY_ORIGIN');
      // Its mark would be refused the same way, so the brand line is the name alone.
      expect(html).not.toContain('<img');
      const framed = await (await broken.http(`/s/${ROOM}`, { headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-site' } })).text();
      expect(framed).toContain('<h2>Live sessions aren’t available here</h2>');
      expect(framed).not.toContain('RELAY_ORIGIN');
      expect(await (await broken.http(`/s/${ROOM}`)).text()).toContain('RELAY_ORIGIN');
    } finally {
      await broken.dispose();
    }
  });

  it('on a room’s preview say why the guest can’t see it, in a tab and in the viewer’s frame', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const at = `${room.previewOrigin}/`;

    const locked = await relay.http(at, { headers: DOCUMENT });
    expect(locked.status).toBe(401);
    const html = await locked.text();
    expect(html).toContain('<h1>This preview is private</h1>');
    // A preview's page names the relay's own host for the mark: the preview origin serves none of the viewer's files.
    expect(html).toContain('src="http://relay.test/_viewer/mark.svg"');

    const framed = await relay.http(at, { headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-site' } });
    expect(framed.status).toBe(401);
    const notice = await framed.text();
    expect(notice).toContain(`<script src="${room.previewOrigin}/__siteorigin/live.js" data-refused></script>`);
    expect(notice).toContain('<h2>The preview isn’t available</h2>');

    // The host drops: the room's own answer is a page for a tab, and keeps its status and Retry-After.
    room.host.close();
    await wait(200);
    const away = await relay.http(at, { headers: { ...DOCUMENT, cookie: ann.cookie } });
    expect([away.status, away.headers.get('retry-after'), away.headers.get('x-relay-page'), away.headers.get('x-relay-refused')]).toEqual([503, '5', null, null]);
    const awayHtml = await away.text();
    expect(awayHtml).toContain('<h1>The host isn’t connected</h1>');
    expect(awayHtml).toContain('<a class="btn" href="">Try again</a>');
    // In the frame it is the notice, without the refusal signal: the viewer handles the host's absence itself.
    const awayFramed = await relay.http(at, { headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-site', cookie: ann.cookie } });
    expect([awayFramed.status, awayFramed.headers.get('retry-after'), awayFramed.headers.get('vary'), awayFramed.headers.get('x-relay-page')]).toEqual([503, '5', 'Sec-Fetch-Dest, Accept', null]);
    const awayNotice = await awayFramed.text();
    expect(awayNotice).toContain('<h2>The host isn’t connected</h2>');
    expect(awayNotice).not.toContain('data-refused');
    const plain = await relay.http(at, { headers: { cookie: ann.cookie } });
    expect([plain.status, plain.headers.get('content-type'), plain.headers.get('x-relay-page')]).toEqual([503, 'text/plain; charset=utf-8', null]);
    expect(await plain.text()).toBe('The host is not connected right now.\n');
  });

  it('on an ended session’s preview say it has ended', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    room.host.send('host-to-relay', { type: 'room:end' });
    await wait(200);
    const ended = await relay.http(`${room.previewOrigin}/`, { headers: { ...DOCUMENT, cookie: ann.cookie } });
    expect([ended.status, ended.headers.get('x-relay-page')]).toEqual([404, null]);
    expect(await ended.text()).toContain('<h1>This session has ended</h1>');
    const plain = await relay.http(`${room.previewOrigin}/`, { headers: { cookie: ann.cookie } });
    expect(await plain.text()).toBe('There is no live session here. It may have ended.\n');
    room.host.close();
  });
});

describe('the exported website’s preview pages', () => {
  let previews: StaticPreviews;
  let scratch: string;
  afterEach(() => {
    previews?.stopAll();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });
  const exported = (name: string) => {
    const root = join(scratch, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Home</title>');
    return root;
  };

  it('show a missing page with its address and the way home, under the site’s base path', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'served-pages-'));
    previews = new StaticPreviews();
    const url = await previews.serve(exported('site'), '/demo');
    const missing = await fetch(`${url}<b>pricing</b>/`);
    expect([missing.status, missing.headers.get('cache-control')]).toEqual([404, 'no-store']);
    const html = await missing.text();
    expect(html).toContain('<h1>Page not found</h1>');
    expect(html).toContain('<code>/demo/&#60;b&#62;pricing&#60;/b&#62;/</code>');
    expect(html).toContain('<a class="btn" href="/demo/">Go to the home page</a>');
    expect(html).toContain('<span>Export preview</span>');
    expect(html).not.toContain('<img');
  });

  it('send the author back to the app, not to a home page, when the export has none', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'served-pages-'));
    previews = new StaticPreviews();
    const root = join(scratch, 'empty');
    mkdirSync(root);
    const url = await previews.serve(root);
    for (const page of ['', 'pricing/']) {
      const html = await (await fetch(`${url}${page}`)).text();
      expect(html).not.toContain('Go to the home page');
      expect(html).toContain('Export the website again from SiteOrigin Builder, then open its preview.');
    }
  });

  it('say a moved export’s preview has stopped, and where to open a current one', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'served-pages-'));
    previews = new StaticPreviews();
    const root = exported('site');
    const url = await previews.serve(root);
    renameSync(root, join(scratch, 'moved'));
    const gone = await fetch(url);
    expect([gone.status, gone.headers.get('cache-control')]).toEqual([410, 'no-store']);
    const html = await gone.text();
    expect(html).toContain('<h1>This preview has stopped</h1>');
    expect(html).toContain('Open a current preview from the Export dialog in SiteOrigin Builder.');
  });
});
