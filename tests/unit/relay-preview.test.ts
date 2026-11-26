import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBase64Url } from '../../src/shared/live/crypto';
import { MAX_PREVIEW_REQUESTS_IN_FLIGHT, PREVIEW_CHUNK_BYTES } from '../../src/shared/live/limits';
import { PREVIEW_CACHE_CONTROL, PREVIEW_REQUEST_HEADERS } from '../../src/shared/live/preview';
import { PREVIEW_ADMISSION_PATH } from '../../src/shared/live/relay-url';
import { admitGuest, admittedGuest, answerPreview, joinGuest, openRoom, ORIGIN, previewStatus, randomBytes, reconnectHost, redeemTicket, startRelay, wait, type Relay } from './relay-harness';

/** The preview tunnel: a guest's browser asks the relay, the relay asks the host's socket, the answer streams back. */

let relay: Relay;
beforeAll(async () => {
  // Distinct deadlines, so a test can tell which one fired.
  relay = await startRelay({ PREVIEW_HEAD_TIMEOUT_MS: '1000', PREVIEW_IDLE_TIMEOUT_MS: '4000' });
}, 60_000);
afterAll(() => relay?.dispose());

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

describe('tunnelled responses', () => {
  it('streams a response larger than 256 KiB in chunks, before the host has sent all of it', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const responding = relay.fetch(`${room.previewOrigin}/about?tab=team`, { headers: { cookie: ann.cookie, accept: 'text/html', 'if-none-match': '"v0"', authorization: 'Bearer secret', 'x-custom': 'no' } });
    const request = await room.host.next('preview:request');
    expect(request).toMatchObject({ guestId: ann.guestId, method: 'GET', target: '/about?tab=team' });
    // Only the allowed request headers reach the host: never cookies or credentials.
    expect(Object.fromEntries(request.headers)).toMatchObject({ accept: 'text/html', 'if-none-match': '"v0"' });
    for (const [name] of request.headers) expect(PREVIEW_REQUEST_HEADERS).toContain(name);

    const body = randomBytes(2 * PREVIEW_CHUNK_BYTES + 100_000);
    room.host.send('host-to-relay', { type: 'preview:response-head', requestId: request.requestId, status: 200, headers: [['content-type', 'text/html; charset=utf-8'], ['content-length', String(body.length)], ['etag', '"v1"']] });
    room.host.send('host-to-relay', { type: 'preview:response-chunk', requestId: request.requestId, seq: 0, data: toBase64Url(body.subarray(0, PREVIEW_CHUNK_BYTES)) });
    const response = await responding;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('etag')).toBe('"v1"');
    expect(response.headers.get('cache-control')).toBe(PREVIEW_CACHE_CONTROL);

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.byteLength).toBeGreaterThan(0);
    room.host.send('host-to-relay', { type: 'preview:response-chunk', requestId: request.requestId, seq: 1, data: toBase64Url(body.subarray(PREVIEW_CHUNK_BYTES, 2 * PREVIEW_CHUNK_BYTES)) });
    room.host.send('host-to-relay', { type: 'preview:response-chunk', requestId: request.requestId, seq: 2, data: toBase64Url(body.subarray(2 * PREVIEW_CHUNK_BYTES)) });
    room.host.send('host-to-relay', { type: 'preview:response-end', requestId: request.requestId, totalBytes: body.length });
    const rest: Uint8Array[] = [first.value!];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(value);
    }
    const received = new Uint8Array(rest.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const part of rest) {
      received.set(part, at);
      at += part.byteLength;
    }
    expect(received.byteLength).toBe(body.byteLength);
    expect(Buffer.from(received).equals(Buffer.from(body))).toBe(true);
    room.host.close();
  });

  it('keeps two responses apart when the host interleaves their chunks', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const a = relay.fetch(`${room.previewOrigin}/a.css`, { headers: { cookie: ann.cookie } });
    const first = await room.host.next('preview:request');
    const b = relay.fetch(`${room.previewOrigin}/b.js`, { headers: { cookie: ann.cookie } });
    const second = await room.host.next('preview:request');
    const bodyA = randomBytes(1500);
    const bodyB = randomBytes(2300);
    for (const request of [second, first]) room.host.send('host-to-relay', { type: 'preview:response-head', requestId: request.requestId, status: 200, headers: [['content-type', 'application/octet-stream']] });
    // B0, A0, B1, A1, B2: each chunk, short tails included, must land in its own response.
    for (let seq = 0; seq < 3; seq++) {
      for (const [request, body] of [[second, bodyB], [first, bodyA]] as const) {
        const part = body.subarray(seq * 1000, seq * 1000 + 1000);
        if (part.length) room.host.send('host-to-relay', { type: 'preview:response-chunk', requestId: request.requestId, seq, data: toBase64Url(part) });
      }
    }
    room.host.send('host-to-relay', { type: 'preview:response-end', requestId: first.requestId, totalBytes: bodyA.length });
    room.host.send('host-to-relay', { type: 'preview:response-end', requestId: second.requestId, totalBytes: bodyB.length });
    expect(Buffer.from(await readAll((await a).body!)).equals(Buffer.from(bodyA))).toBe(true);
    expect(Buffer.from(await readAll((await b).body!)).equals(Buffer.from(bodyB))).toBe(true);
    room.host.close();
  });

  it('passes a redirect within the preview to the browser as the host gave it', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const responding = relay.http(`${room.previewOrigin}/contact`, { headers: { cookie: ann.cookie }, redirect: 'manual' });
    const request = await room.host.next('preview:request');
    expect(request.target).toBe('/contact');
    answerPreview(room.host, request.requestId, { status: 308, headers: [['location', '/contact/?from=nav#form']] });
    const response = await responding;
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/contact/?from=nav#form');
    room.host.close();
  });

  it('serves the viewer’s routes only on the relay’s host and the preview only on the room’s own origin', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    // The old shared-origin layout is gone: nothing of a preview is served on the relay's own host.
    for (const path of [`/s/${room.roomId}/preview/`, `/s/${room.roomId}/preview`, `/s/${room.roomId}/admission`]) expect((await relay.fetch(path, { headers: { cookie: ann.cookie } })).status, path).toBe(404);
    // A preview origin serves no viewer, and opens no sockets.
    expect((await relay.fetch(`${room.previewOrigin}/s/${room.roomId}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
    expect((await relay.fetch(`${room.previewOrigin}/ws/host`, { headers: { upgrade: 'websocket' } })).status).toBe(404);
    // A host that only looks like a preview's is the relay's own (its viewer answers), never a preview.
    expect((await relay.fetch(`http://p-short.relay.test/s/${room.roomId}`, { headers: { cookie: ann.cookie } })).status).toBe(200);
    expect((await relay.fetch(`http://p-${'2'.repeat(33)}.relay.test/s/${room.roomId}`, { headers: { cookie: ann.cookie } })).status).toBe(200);
    // A preview nested under another preview is neither, so one room's pages cannot pose as another room's viewer.
    const label = new URL(room.previewOrigin).hostname.split('.')[0];
    const nested = `http://${label}.${new URL((await openRoom(relay)).previewOrigin).hostname}`;
    expect((await relay.fetch(`${nested}/`, { headers: { cookie: ann.cookie } })).status).toBe(404);
    expect((await relay.fetch(`${nested}${PREVIEW_ADMISSION_PATH}`, { method: 'OPTIONS', headers: { origin: 'http://x', 'access-control-request-method': 'POST' } })).status).toBe(404);
    // A preview of no room has nothing to show.
    expect((await relay.fetch(`http://p-${'2'.repeat(32)}.relay.test/`, { headers: { cookie: ann.cookie } })).status).toBe(404);
    await wait(50);
    expect(room.host.has('preview:request')).toBe(false);
    room.host.close();
  });

  it('answers HEAD with the head alone', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const responding = relay.fetch(`${room.previewOrigin}/`, { method: 'HEAD', headers: { cookie: ann.cookie } });
    const request = await room.host.next('preview:request');
    expect(request.method).toBe('HEAD');
    answerPreview(room.host, request.requestId, { headers: [['content-type', 'text/html'], ['content-length', '5120']] });
    const response = await responding;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    room.host.close();
  });
});

describe('stopping responses', () => {
  it('answers 504 and tells the host to stop when no head arrives in time', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const started = Date.now();
    const responding = relay.fetch(`${room.previewOrigin}/slow`, { headers: { cookie: ann.cookie } });
    const request = await room.host.next('preview:request');
    expect((await responding).status).toBe(504);
    // The head deadline (1 s here), not the idle one (4 s).
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await room.host.next('preview:abort')).toEqual({ type: 'preview:abort', requestId: request.requestId, code: 'TIMEOUT' });
    room.host.close();
  });

  it('answers 502 when the host breaks the stream’s order, and fails a body whose chunks skip ahead', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const early = relay.fetch(`${room.previewOrigin}/x`, { headers: { cookie: ann.cookie } });
    const first = await room.host.next('preview:request');
    room.host.send('host-to-relay', { type: 'preview:response-end', requestId: first.requestId, totalBytes: 0 });
    expect((await early).status).toBe(502);
    expect((await room.host.next('preview:abort')).code).toBe('INVALID_RESPONSE');

    const gap = relay.fetch(`${room.previewOrigin}/y`, { headers: { cookie: ann.cookie } });
    const second = await room.host.next('preview:request');
    answerPreview(room.host, second.requestId, { end: false });
    const response = await gap;
    room.host.send('host-to-relay', { type: 'preview:response-chunk', requestId: second.requestId, seq: 1, data: toBase64Url(randomBytes(10)) });
    await expect(readAll(response.body!)).rejects.toThrow();
    expect((await room.host.next('preview:abort')).code).toBe('INVALID_RESPONSE');
    room.host.close();
  });

  it('passes the host’s own abort on to the guest', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const responding = relay.fetch(`${room.previewOrigin}/gone`, { headers: { cookie: ann.cookie } });
    const request = await room.host.next('preview:request');
    room.host.send('host-to-relay', { type: 'preview:abort', requestId: request.requestId, code: 'UNAVAILABLE' });
    expect((await responding).status).toBe(503);
    room.host.close();
  });

  it('tells the host to stop when the guest stops reading midway', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    // Over the real port, so the guest going away closes a real connection, as a browser's would.
    const abort = new AbortController();
    // Uncompressed, so the first bytes reach the guest at once rather than waiting in an encoder's buffer.
    const responding = relay.http(`${room.previewOrigin}/video.mp4`, { headers: { cookie: ann.cookie, 'accept-encoding': 'identity' }, signal: abort.signal });
    const request = await room.host.next('preview:request');
    answerPreview(room.host, request.requestId, { headers: [['content-type', 'video/mp4']], body: randomBytes(1000), end: false });
    const response = await responding;
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => {});
    // The host is still sending: the next bytes find the guest gone. Well before the 1-second idle deadline.
    await wait(100);
    room.host.send('host-to-relay', { type: 'preview:response-chunk', requestId: request.requestId, seq: 1, data: toBase64Url(randomBytes(1000)) });
    expect(await room.host.next('preview:abort', 900)).toEqual({ type: 'preview:abort', requestId: request.requestId, code: 'CANCELLED' });
    room.host.close();
  });

  it('fails a kicked guest’s open response and tells the host to stop', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const responding = relay.fetch(`${room.previewOrigin}/big`, { headers: { cookie: ann.cookie } });
    const request = await room.host.next('preview:request');
    answerPreview(room.host, request.requestId, { body: randomBytes(1000), end: false });
    const response = await responding;
    room.host.send('host-to-relay', { type: 'guest:kick', guestId: ann.guestId });
    await expect(readAll(response.body!)).rejects.toThrow();
    expect((await room.host.next('preview:abort')).code).toBe('CANCELLED');
    room.host.close();
  });

  it('fails open responses when the host disconnects, and answers 503 until it is back', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const responding = relay.fetch(`${room.previewOrigin}/page`, { headers: { cookie: ann.cookie } });
    const request = await room.host.next('preview:request');
    answerPreview(room.host, request.requestId, { body: randomBytes(1000), end: false });
    const response = await responding;
    const waiting = relay.fetch(`${room.previewOrigin}/waiting`, { headers: { cookie: ann.cookie } });
    await room.host.next('preview:request');
    const closedAt = Date.now();
    room.host.close();
    await expect(readAll(response.body!)).rejects.toThrow();
    // Both fail as the host goes, well before any deadline.
    expect((await waiting).status).toBe(503);
    expect(Date.now() - closedAt).toBeLessThan(900);
    expect(await previewStatus(relay, room, ann.cookie)).toBe(503);

    const { host } = await reconnectHost(relay, room.roomId, room.keys);
    expect(await previewStatus(relay, { ...room, host }, ann.cookie)).toBe(204);
    host.close();
  });
});

describe('who may ask', () => {
  it('refuses tampered cookies, cookies from another room, and the development server’s own routes', async () => {
    const room = await openRoom(relay);
    const other = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    // Change the MAC's first character, which always changes a byte of it (its last may only change unused bits).
    const at = ann.cookie.lastIndexOf('.') + 1;
    const tampered = `${ann.cookie.slice(0, at)}${ann.cookie[at] === 'A' ? 'Q' : 'A'}${ann.cookie.slice(at + 1)}`;
    expect((await relay.fetch(`${room.previewOrigin}/`, { headers: { cookie: tampered } })).status).toBe(401);
    expect((await relay.fetch(`${other.previewOrigin}/`, { headers: { cookie: ann.cookie } })).status).toBe(401);
    expect((await relay.fetch(`${room.previewOrigin}/__open-in-editor?file=/etc/passwd`, { headers: { cookie: ann.cookie } })).status).toBe(404);
    expect((await relay.fetch(`${room.previewOrigin}/`, { method: 'POST', headers: { cookie: ann.cookie } })).status).toBe(405);
    await wait(50);
    expect(room.host.has('preview:request')).toBe(false);
    room.host.close();
    other.host.close();
  });

  it('holds each guest to its share of requests in flight', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const open = Array.from({ length: MAX_PREVIEW_REQUESTS_IN_FLIGHT }, (_, i) => relay.fetch(`${room.previewOrigin}/${i}`, { headers: { cookie: ann.cookie } }));
    const requests = [];
    for (let i = 0; i < MAX_PREVIEW_REQUESTS_IN_FLIGHT; i++) requests.push(await room.host.next('preview:request'));
    expect((await relay.fetch(`${room.previewOrigin}/one-more`, { headers: { cookie: ann.cookie } })).status).toBe(429);
    for (const request of requests) answerPreview(room.host, request.requestId, { status: 204, headers: [] });
    for (const response of await Promise.all(open)) expect(response.status).toBe(204);
    expect(await previewStatus(relay, room, ann.cookie)).toBe(204);
    room.host.close();
  });
});

describe('keeping rooms apart in the browser', () => {
  it('gives a guest admitted to two rooms a cookie for each room’s origin that the other room never accepts', async () => {
    const a = await openRoom(relay);
    const b = await openRoom(relay);
    expect(a.previewOrigin).not.toBe(b.previewOrigin);
    const inA = await admittedGuest(relay, a);
    const inB = await admittedGuest(relay, b);
    expect(await previewStatus(relay, a, inA.cookie)).toBe(204);
    expect(await previewStatus(relay, b, inB.cookie)).toBe(204);
    // Each room's cookie is for its own room only, wherever it is sent.
    expect((await relay.fetch(`${b.previewOrigin}/`, { headers: { cookie: inA.cookie } })).status).toBe(401);
    expect((await relay.fetch(`${a.previewOrigin}/`, { headers: { cookie: inB.cookie } })).status).toBe(401);
    await wait(50);
    expect(a.host.has('preview:request')).toBe(false);
    expect(b.host.has('preview:request')).toBe(false);
    a.host.close();
    b.host.close();
  });

  it('lets only the preview’s own pages load its files, while any page may still navigate to it', async () => {
    const room = await openRoom(relay);
    const ann = await admittedGuest(relay, room);
    const metadata = (site: string, mode: string, dest: string) => ({ cookie: ann.cookie, 'sec-fetch-site': site, 'sec-fetch-mode': mode, 'sec-fetch-dest': dest });
    // Over a raw connection: Node's fetch overwrites Sec-Fetch-Mode with its own `cors`.
    // Another room's preview is same-site, so a browser sends it this room's cookie: its loads are refused.
    for (const [site, mode, dest] of [['same-site', 'no-cors', 'script'], ['same-site', 'cors', 'empty'], ['same-site', 'no-cors', 'image'], ['cross-site', 'no-cors', 'style']]) {
      const refused = await relay.http(`${room.previewOrigin}/src/lib/data.js`, { headers: metadata(site, mode, dest) });
      await refused.arrayBuffer();
      expect(refused.status, `${site} ${mode} ${dest}`).toBe(403);
    }
    // A service worker would go on answering for the site after the guest's access ends.
    expect((await relay.http(`${room.previewOrigin}/sw.js`, { headers: { ...metadata('same-origin', 'same-origin', 'serviceworker'), 'service-worker': 'script' } })).status).toBe(403);
    await wait(50);
    expect(room.host.has('preview:request')).toBe(false);
    // The viewer's iframe navigating to the preview, and the preview's own loads, go through.
    expect(await previewStatus(relay, room, ann.cookie)).toBe(204);
    // Module scripts, fonts and SvelteKit's `__data.json` fetches are same-origin CORS loads from inside the iframe.
    for (const headers of [metadata('same-site', 'navigate', 'iframe'), metadata('same-origin', 'no-cors', 'script'), metadata('same-origin', 'cors', 'script'), metadata('same-origin', 'cors', 'empty'), metadata('same-origin', 'navigate', 'iframe'), metadata('none', 'navigate', 'document')]) {
      const responding = relay.http(`${room.previewOrigin}/`, { headers });
      const request = await room.host.next('preview:request');
      answerPreview(room.host, request.requestId, { status: 204, headers: [] });
      expect((await responding).status).toBe(204);
    }
    room.host.close();
  });

  it('reads only the `__Host-` cookie over HTTPS, so copies another host set under the same parent are ignored', async () => {
    const room = await openRoom(relay);
    const joined = await joinGuest(relay, room.roomId);
    await room.host.next('room:roster');
    const status = await admitGuest(room.host, joined);
    const redeemed = await redeemTicket(relay, room.roomId, status.previewTicket, { 'x-forwarded-proto': 'https' });
    const secureCookie = redeemed.cookie!;
    expect(secureCookie).toMatch(/^__Host-so_preview=/);
    const value = secureCookie.slice(secureCookie.indexOf('=') + 1);
    const https = { 'x-forwarded-proto': 'https' };
    // The same signed value under the plain name, as a sibling host could set for the parent domain, is not read.
    expect((await relay.fetch(`${room.previewOrigin}/`, { headers: { ...https, cookie: `so_preview=${value}` } })).status).toBe(401);
    // Four junk copies under the plain name do not crowd out the real cookie either.
    const junk = Array.from({ length: 4 }, () => 'so_preview=v1.junk.junk').join('; ');
    const responding = relay.fetch(`${room.previewOrigin}/`, { headers: { ...https, cookie: `${junk}; ${secureCookie}` } });
    const request = await room.host.next('preview:request');
    answerPreview(room.host, request.requestId, { status: 204, headers: [] });
    expect((await responding).status).toBe(204);
    room.host.close();
  });
});

describe('a relay with its public origin set', () => {
  let strict: Relay;
  beforeAll(async () => {
    strict = await startRelay({ RELAY_ORIGIN: ORIGIN });
  }, 60_000);
  afterAll(() => strict?.dispose());

  it('serves the viewer only at that origin and previews only directly under it', async () => {
    const room = await openRoom(strict);
    const ann = await admittedGuest(strict, room);
    expect(await previewStatus(strict, room, ann.cookie)).toBe(204);
    const label = new URL(room.previewOrigin).hostname.split('.')[0];
    expect((await strict.fetch(`http://other.test/s/${room.roomId}`)).status).toBe(404);
    expect((await strict.fetch(`http://${label}.other.test/`, { headers: { cookie: ann.cookie } })).status).toBe(404);
    expect((await strict.fetch(`http://${label}.relay.test:8443/`, { headers: { cookie: ann.cookie } })).status).toBe(404);
    room.host.close();
  });
});

describe('a relay whose public origin is written loosely or wrongly', () => {
  it('pins to the origin a loose spelling names, and serves nothing when it names no origin', async () => {
    const loose = await startRelay({ RELAY_ORIGIN: 'HTTP://Relay.Test:80/' });
    try {
      const room = await openRoom(loose);
      expect((await loose.fetch(`/s/${room.roomId}`)).status).toBe(200);
      expect((await loose.fetch(`http://other.test/s/${room.roomId}`)).status).toBe(404);
      room.host.close();
    } finally {
      await loose.dispose();
    }
    const wrong = await startRelay({ RELAY_ORIGIN: 'https://relay.test/viewer' });
    try {
      expect((await wrong.fetch('/s/abcdefghijkmnpqrstuvwxyz')).status).toBe(503);
      expect((await wrong.fetch('/ws/host', { headers: { upgrade: 'websocket' } })).status).toBe(503);
    } finally {
      await wrong.dispose();
    }
  }, 60_000);
});
