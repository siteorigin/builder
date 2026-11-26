import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_CLOSE_CODES } from '../../src/shared/live/close-codes';
import { DISPLAY_NAME_MAX } from '../../src/shared/live/limits';
import { normalizeDisplayName } from '../../src/shared/live/messages';
import { PREVIEW_ADMISSION_PATH, roomPreviewOrigin } from '../../src/shared/live/relay-url';
import { VIEWPORT_PRESETS } from '../../src/shared/styles';
import * as viewerShared from '../../relay/viewer/shared.js';
import { admitGuest, admittedGuest, answerPreview, joinGuest, openRoom, ORIGIN, reconnectHost, startRelay, wait, type Relay } from './relay-harness';

/** The guest's viewer as the relay serves it, and what the relay tells guests for the viewer to show. */

let relay: Relay;
beforeAll(async () => {
  relay = await startRelay({ HOST_RECONNECT_GRACE_MS: '3000' });
}, 60_000);
afterAll(() => relay?.dispose());

const ROOM = 'c'.repeat(24);

describe('the invite link’s page', () => {
  it('is the viewer, with its room’s socket, preview origin and invite link, and a policy naming exactly those', async () => {
    const page = await relay.fetch(`/s/${ROOM}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const preview = await roomPreviewOrigin(ORIGIN, ROOM);
    expect(html).toContain(`data-room-id="${ROOM}"`);
    expect(html).toContain(`data-socket-url="ws://relay.test/s/${ROOM}/ws"`);
    expect(html).toContain(`data-preview-origin="${preview}"`);
    expect(html).toContain(`data-invite-link="${ORIGIN}/s/${ROOM}"`);
    expect(html).toContain(`data-name-max="${DISPLAY_NAME_MAX}"`);
    expect(html).toContain('data-protocol-version="1"');
    expect(html).toContain('<form id="join"');
    // Nothing of the site is in the page until the guest is let in: the frame is made by the script only then.
    expect(html).not.toContain('<iframe');
    const csp = page.headers.get('content-security-policy')!;
    expect(csp.split('; ')).toEqual([
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src ws://relay.test/s/${ROOM}/ws ${preview}`,
      `frame-src ${preview}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ]);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');

    const head = await relay.fetch(`/s/${ROOM}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await relay.fetch(`/s/${ROOM}`, { method: 'POST' })).status).toBe(405);
  });

  it('says how to run the relay when its host cannot give rooms their own preview origins', async () => {
    const page = await relay.fetch(`http://127.0.0.1/s/${ROOM}`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('relay.localhost');
    // A host of one label has no subdomains of the same site either.
    expect((await relay.fetch(`http://relay/s/${ROOM}`)).status).toBe(503);
  });
});

describe('the viewer’s files', () => {
  it('are served at their paths on the relay’s host, with their types, and nowhere else', async () => {
    for (const [path, type] of [
      ['/_viewer/viewer.js', 'javascript'],
      ['/_viewer/shared.js', 'javascript'],
      ['/_viewer/viewer.css', 'text/css'],
      ['/_viewer/mark.svg', 'image/svg+xml']
    ] as const) {
      const response = await relay.fetch(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain(type);
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect((await response.text()).length, path).toBeGreaterThan(100);
    }
    // The asset directory's own layout is never a route, and the bridge is only on preview origins.
    for (const path of ['/viewer.js', '/preview-bridge.js', '/_viewer/preview-bridge.js', '/_viewer/', '/__siteorigin/live.js']) expect((await relay.fetch(path)).status, path).toBe(404);
    expect((await relay.fetch('/_viewer/viewer.js', { method: 'POST' })).status).toBe(405);
  });

  it('keep to the contract they copy from src/shared', () => {
    expect(viewerShared.CLOSE_CODES).toEqual(LIVE_CLOSE_CODES);
    expect(viewerShared.PREVIEW_ADMISSION_PATH).toBe(PREVIEW_ADMISSION_PATH);
    expect(viewerShared.VIEWPORTS).toEqual({ desktop: VIEWPORT_PRESETS.desktop, tablet: VIEWPORT_PRESETS.tablet, mobile: VIEWPORT_PRESETS.phone });
    const names = [
      'Sam Lee',
      '  Sam \n\t Lee  ',
      'Café',
      '👩‍💻 Ana',
      '',
      '   ',
      '​',
      'Sam‮Lee',
      'Sam\u0007',
      'ㅤㅤ',
      '́́',
      'a'.repeat(40),
      'a'.repeat(41),
      '😀'.repeat(40),
      '😀'.repeat(41),
      '---',
      ...[...'\u115f\u1160\u200b\u2060\u2800\u3164\ufeff\uffa0\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u2066\u2067\u2068\u2069\u0000\u0001\u001f\u007f\u0085'].map((c) => `Ann${c}Lee`),
      'Zoë',
      'محمد',
      42,
      null
    ];
    for (const name of names) {
      expect(viewerShared.normalizeDisplayName(name, DISPLAY_NAME_MAX), JSON.stringify(name)).toBe(normalizeDisplayName(name));
      expect(viewerShared.normalizeDisplayName(name, 5), JSON.stringify(name)).toBe(normalizeDisplayName(name, 5));
    }
  });
});

describe('the reload bridge in the preview', () => {
  it('is added to whole HTML pages loaded in the viewer’s frame, and to nothing else', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    // Over a raw connection, as a browser sends it: Node's fetch overwrites Sec-Fetch-Mode with its own.
    const ask = async (path: string, dest: string | null, response: Parameters<typeof answerPreview>[2], extra: Record<string, string> = {}) => {
      const metadata: Record<string, string> = dest === 'iframe' ? { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' } : dest ? { 'sec-fetch-dest': dest, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' } : {};
      const pending = relay.http(`${room.previewOrigin}${path}`, { headers: { cookie: ann.cookie, ...metadata, ...extra } });
      const request = await room.host.next('preview:request');
      answerPreview(room.host, request.requestId, response);
      const answer = await pending;
      return { answer, body: await answer.text(), request };
    };
    const tag = `<script src="${room.previewOrigin}/__siteorigin/live.js"></script>`;
    const page = new TextEncoder().encode('<!doctype html><html><head><title>Home</title></head><body><h1>Hello</h1></body></html>');
    const framed = await ask('/', 'iframe', { headers: [['content-type', 'text/html; charset=utf-8'], ['content-length', String(page.length)], ['etag', '"v1"'], ['last-modified', 'Wed, 25 Nov 2026 09:00:00 GMT'], ['accept-ranges', 'bytes']], body: page }, { 'if-none-match': '"v0"', 'if-modified-since': 'Wed, 25 Nov 2026 08:00:00 GMT', range: 'bytes=0-10', 'if-range': '"v0"', accept: 'text/html' });
    expect(framed.answer.status).toBe(200);
    expect(framed.body).toBe(`<!doctype html><html><head>${tag}<title>Home</title></head><body><h1>Hello</h1></body></html>`);
    // A framed page is always asked for whole, so it always comes back with the bridge in it.
    expect(Object.fromEntries(framed.request.headers)).toEqual({ accept: 'text/html' });
    // The host's validators and length describe its own bytes, not these.
    for (const name of ['etag', 'content-length', 'last-modified', 'accept-ranges']) expect(framed.answer.headers.get(name), name).toBeNull();
    // The same page asked for otherwise keeps its validators, and its conditional request reaches the host.
    const plain = await ask('/', null, { headers: [['content-type', 'text/html'], ['etag', '"v1"']], body: page }, { 'if-none-match': '"v0"' });
    expect(plain.answer.headers.get('etag')).toBe('"v1"');
    expect(Object.fromEntries(plain.request.headers)).toMatchObject({ 'if-none-match': '"v0"' });

    const bodyOnly = await ask('/body/', 'iframe', { body: new TextEncoder().encode('<body><p>No head</p></body>') });
    expect(bodyOnly.body).toBe(`<body>${tag}<p>No head</p></body>`);
    const bare = await ask('/bare/', 'iframe', { body: new TextEncoder().encode('<p>Neither</p>') });
    expect(bare.body).toBe(`<p>Neither</p>${tag}`);
    // An error page is a page the guest can be on when the host fixes it.
    expect((await ask('/missing/', 'iframe', { status: 404, body: page })).body).toContain(tag);

    // Not in the frame, not HTML, or not a whole page: passed on as the host sent it.
    expect((await ask('/', 'document', { body: page })).body).not.toContain('live.js');
    expect((await ask('/', null, { body: page })).body).not.toContain('live.js');
    expect((await ask('/style.css', 'iframe', { headers: [['content-type', 'text/css']], body: new TextEncoder().encode('<head>') })).body).toBe('<head>');
    const utf16 = new Uint8Array([0x3c, 0, 0x70, 0, 0x3e, 0]);
    // A page in an encoding the rewriter cannot read passes as the host sent it.
    const wide = await ask('/wide/', 'iframe', { headers: [['content-type', 'text/html; charset=utf-16le']], body: utf16 });
    expect(wide.answer.status).toBe(200);
    expect(wide.body).toBe(new TextDecoder().decode(utf16));

    const bridge = await relay.fetch(`${room.previewOrigin}/__siteorigin/live.js`);
    expect(bridge.status).toBe(200);
    expect(bridge.headers.get('content-type')).toContain('javascript');
    expect(await bridge.text()).toContain('siteorigin-live:reload');
    room.host.close();
  });
});

describe('what guests are told about the host', () => {
  it('tells waiting and admitted guests when the host drops and when it proves itself again', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room, 'Ann');
    expect(await ann.guest.next('host:availability')).toEqual({ type: 'host:availability', connected: true });
    const bob = await joinGuest(relay, room.roomId, 'Bob');
    expect(await bob.guest.next('host:availability')).toEqual({ type: 'host:availability', connected: true });

    room.host.close();
    expect(await ann.guest.next('host:availability')).toEqual({ type: 'host:availability', connected: false });
    expect(await bob.guest.next('host:availability')).toEqual({ type: 'host:availability', connected: false });
    // A guest joining while the host is away is told so at once.
    const cat = await joinGuest(relay, room.roomId, 'Cat');
    expect(await cat.guest.next('host:availability')).toEqual({ type: 'host:availability', connected: false });

    const { host } = await reconnectHost(relay, room.roomId, room.keys);
    for (const guest of [ann, bob, cat]) expect(await guest.guest.next('host:availability')).toEqual({ type: 'host:availability', connected: true });

    // A host taking over from a live connection was never away: nobody is told it went.
    const again = await reconnectHost(relay, room.roomId, room.keys);
    expect((await host.closed()).code).toBe(LIVE_CLOSE_CODES.REPLACED);
    await wait(200);
    for (const guest of [ann, bob, cat]) expect(guest.guest.has('host:availability')).toBe(false);
    again.host.close();
  });

  it('shows a guest let in, or back, the page the host is on, without its selection', async () => {
    const room = await openRoom(relay);
    const selection = { owner: { kind: 'page' as const, id: 'pg_about' }, instancePath: [], nodeId: 'n_title' };
    room.host.send('host-to-relay', { type: 'presence:update', presence: { pageId: 'pg_about', viewportWidth: 834, selection, previewPath: '/about/' } });
    const ann = await joinGuest(relay, room.roomId, 'Ann');
    await room.host.next('room:roster');
    // Waiting guests see nothing of where the host is.
    await wait(100);
    expect(ann.guest.has('presence:changed')).toBe(false);
    await admitGuest(room.host, ann);
    expect(await ann.guest.next('presence:changed')).toEqual({ type: 'presence:changed', participant: { kind: 'host' }, presence: { pageId: 'pg_about', viewportWidth: 834, selection: null, previewPath: '/about/' } });

    // The host's latest presence is the one a returning guest sees, even after the room's object has slept.
    room.host.send('host-to-relay', { type: 'presence:update', presence: { pageId: 'pg_home', viewportWidth: 390, selection: null, previewPath: '/' } });
    await ann.guest.next('presence:changed');
    await relay.hibernate(room.roomId);
    ann.guest.close();
    await wait(100);
    const back = await relay.socket(`/s/${room.roomId}/ws`);
    back.send('guest-to-relay', { type: 'guest:join', version: 1, displayName: 'Ann', resumeToken: ann.resumeToken });
    expect((await back.next('guest:status')).status).toBe('admitted');
    expect(await back.next('host:availability')).toEqual({ type: 'host:availability', connected: true });
    expect(await back.next('presence:changed')).toEqual({ type: 'presence:changed', participant: { kind: 'host' }, presence: { pageId: 'pg_home', viewportWidth: 390, selection: null, previewPath: '/' } });

    // A host that reconnects is still where it was until it says otherwise.
    room.host.close();
    expect(await back.next('host:availability')).toEqual({ type: 'host:availability', connected: false });
    const { host } = await reconnectHost(relay, room.roomId, room.keys);
    const bob = await joinGuest(relay, room.roomId, 'Bob');
    await host.next('room:roster');
    await admitGuest(host, bob);
    expect(await bob.guest.next('presence:changed')).toMatchObject({ presence: { pageId: 'pg_home', previewPath: '/' } });
    // A selection alone does not change the page every copy of the room keeps.
    host.send('host-to-relay', { type: 'presence:update', presence: { pageId: 'pg_home', viewportWidth: 390, selection, previewPath: '/' } });
    expect((await bob.guest.next('presence:changed')).presence.selection).toEqual(selection);
    host.close();
  });
});
