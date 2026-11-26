import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PREVIEW_CHUNK_BYTES } from '../../src/shared/live/limits';
import { checkFrame } from '../../src/shared/live/messages';
import { PreviewStream } from '../../src/shared/live/preview';
import { FLUSH_MS, loopbackPreview, PreviewProxy, previewRedirect, previewResponseHeaders, SOCKET_HIGH_WATER_BYTES, type PreviewReplyFrame, type PreviewRequestFrame } from '../../src/main/live/preview-proxy';
import { LIVE_GUEST_HEADER } from '../../src/runtime/policy';

/**
 * The host's end of the preview tunnel, against a loopback server standing in for the project's Vite preview: what is
 * asked of it, what comes back to the relay, and what never gets through.
 */

const BINARY = new Uint8Array(1024 * 1024 + 12_345).map((_, i) => (i * 7919) % 251);
const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = [];
let closedEarly = 0;
let server: Server;
let port: number;

function routes(url: string, res: ServerResponse) {
  switch (url.split('?')[0]) {
    case '/':
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'session=1',
        'cache-control': 'max-age=3600',
        'content-security-policy': "frame-ancestors 'self'",
        server: 'vite',
        'x-content-type-options': 'nosniff'
      });
      return res.end('<!doctype html><title>Home</title><link rel="stylesheet" href="/app.css">');
    case '/app.css':
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('body { color: red }');
    case '/app.js':
      res.writeHead(200, { 'content-type': 'text/javascript', etag: '"v1"' });
      return res.end('export const x = 1;');
    case '/photo.bin':
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(BINARY.length) });
      return res.end(Buffer.from(BINARY));
    case '/contact/':
      res.writeHead(303, { location: 'thanks' });
      return res.end();
    case '/loopback-redirect':
      res.writeHead(302, { location: `http://127.0.0.1:${port}/elsewhere?x=1` });
      return res.end();
    case '/outside-redirect':
      res.writeHead(302, { location: 'https://evil.example/steal' });
      return res.end();
    case '/cached':
      res.writeHead(304, { etag: '"v1"' });
      return res.end();
    case '/reset':
      res.writeHead(205);
      return res.end();
    case '/range': {
      const part = Buffer.from(BINARY.subarray(100, 200));
      res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': `bytes 100-199/${BINARY.length}`, 'accept-ranges': 'bytes', 'content-length': String(part.length) });
      return res.end(part);
    }
    case '/nominated':
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'etag', etag: '"secret"' });
      return res.end('ok');
    case '/gzip':
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      return res.end('not really gzip');
    case '/identity':
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'identity' });
      return res.end('plain');
    case '/coded':
      res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'gzip, chunked' });
      return res.end('not really gzip');
    case '/hidden-length':
      // A length too large to carry, named as the connection's own so it is not passed on.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(40 * 1024 * 1024), connection: 'content-length' });
      return res.write('a');
    case '/nominated-two':
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'etag, last-modified', etag: '"x"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' });
      return res.end('ok');
    case '/trickle':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first');
      return setTimeout(() => res.end('last'), FLUSH_MS * 6);
    case '/reset-streaming': {
      // A 205 that carries a body anyway, and never ends.
      res.writeHead(205, { 'transfer-encoding': 'chunked' });
      const tick = setInterval(() => res.write('x'), 20);
      res.on('close', () => {
        clearInterval(tick);
        if (!res.writableFinished) closedEarly++;
      });
      return;
    }
    case '/hangup':
      return res.socket?.destroy();
    case '/upgrade':
      res.socket?.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: other\r\n\r\n');
      return;
    case '/huge':
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(40 * 1024 * 1024) });
      return res.write('a');
    case '/broken':
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100000' });
      res.write('partial');
      return setTimeout(() => res.socket?.destroy(), 20);
    case '/slow':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first');
      res.on('close', () => {
        if (!res.writableFinished) closedEarly++;
      });
      return;
    default:
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('missing');
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    routes(req.url ?? '/', res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(
  () =>
    new Promise<void>((resolve) => {
      // Responses held open by the tests, and kept-alive connections, would keep the server from closing.
      server.closeAllConnections();
      server.close(() => resolve());
    })
);
beforeEach(() => {
  seen.length = 0;
});

async function until(check: () => unknown, what: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let nextId = 0;
const request = (target: string, extra: Partial<PreviewRequestFrame> = {}): PreviewRequestFrame => ({ type: 'preview:request', requestId: `r${++nextId}`, guestId: 'g1', method: 'GET', target, headers: [], ...extra });

/** A proxy whose frames are collected, each checked as the relay will read it. */
function harness(opts: { preview?: () => { port: number } | null; buffered?: () => number } = {}) {
  const frames: PreviewReplyFrame[] = [];
  const proxy = new PreviewProxy({
    send: (frame) => {
      const checked = checkFrame('host-to-relay', frame);
      if (!checked.ok) throw new Error(`The proxy sent a frame the relay would refuse: ${checked.error.message}`);
      frames.push(frame);
      return true;
    },
    preview: opts.preview ?? (() => ({ port })),
    buffered: opts.buffered ?? (() => 0)
  });
  /** Wait for a request's last frame and rebuild its response, held to the stream rules the relay applies. */
  async function result(requestId: string, method: 'GET' | 'HEAD' = 'GET') {
    const deadline = Date.now() + 5000;
    const mine = () => frames.filter((f) => f.requestId === requestId);
    while (!mine().some((f) => f.type === 'preview:response-end' || f.type === 'preview:abort')) {
      if (Date.now() > deadline) throw new Error(`No end for ${requestId}: ${mine().map((f) => f.type).join(', ')}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    const stream = new PreviewStream(method);
    const chunks: Buffer[] = [];
    let head: Extract<PreviewReplyFrame, { type: 'preview:response-head' }> | undefined;
    let abort: Extract<PreviewReplyFrame, { type: 'preview:abort' }> | undefined;
    for (const f of mine()) {
      const { requestId: _id, ...step } = f;
      expect(stream.accept(step as never)).toMatchObject({ ok: true });
      if (f.type === 'preview:response-head') head = f;
      if (f.type === 'preview:response-chunk') chunks.push(Buffer.from(f.data, 'base64url'));
      if (f.type === 'preview:abort') abort = f;
    }
    return { head, abort, body: Buffer.concat(chunks), chunks, headers: Object.fromEntries(head?.headers ?? []) };
  }
  return { proxy, frames, result };
}

describe('the loopback preview address', () => {
  it('is only ever http://127.0.0.1 on a port', () => {
    expect(loopbackPreview('http://127.0.0.1:5173')).toEqual({ port: 5173 });
    expect(loopbackPreview('http://127.0.0.1:5173/')).toEqual({ port: 5173 });
    for (const url of ['http://localhost:5173', 'http://10.0.0.2:5173', 'https://127.0.0.1:5173', 'http://u:p@127.0.0.1:5173', 'http://127.0.0.1:5173/base/', 'http://127.0.0.1:5173/?x=1', 'http://127.0.0.1:5173/#x', 'http://127.0.0.1', 'nonsense', null, undefined])
      expect(loopbackPreview(url)).toBeNull();
  });
});

describe('redirects', () => {
  it('resolves a relative Location against the target and keeps only places in the preview', () => {
    expect(previewRedirect('thanks', '/contact/', 5173)).toBe('/contact/thanks');
    expect(previewRedirect('/about/#team', '/x', 5173)).toBe('/about/#team');
    expect(previewRedirect('http://127.0.0.1:5173/a?b=1', '/', 5173)).toBe('/a?b=1');
    expect(previewRedirect('http://127.0.0.1:9999/a', '/', 5173)).toBeNull();
    expect(previewRedirect('https://evil.example/', '/', 5173)).toBeNull();
    expect(previewRedirect('//evil.example/', '/', 5173)).toBeNull();
    expect(previewRedirect('/__open-in-editor?file=/etc/passwd', '/', 5173)).toBeNull();
    expect(previewRedirect('http://u:p@127.0.0.1:5173/a', '/', 5173)).toBeNull();
  });

  it('passes on one redirect only', () => {
    expect(previewResponseHeaders(['Location', '/one', 'Location', '/two', 'Content-Type', 'text/plain'], '/', 5173)).toEqual([['location', '/one'], ['content-type', 'text/plain']]);
  });
});

describe('tunnelling a preview request', () => {
  it('serves HTML, CSS and JS as the preview server gave them, with only the headers the protocol passes back', async () => {
    const { proxy, result } = harness();
    const pages = ['/', '/app.css', '/app.js'].map((target) => {
      const frame = request(target, { headers: [['accept', 'text/html'], ['accept-language', 'en']] });
      proxy.handle(frame);
      return frame.requestId;
    });
    const [html, css, js] = await Promise.all(pages.map((id) => result(id)));
    expect(html.head?.status).toBe(200);
    expect(html.body.toString()).toContain('<title>Home</title>');
    // Cookies, caching policy, security policy and the server's name never go back.
    expect(html.headers).toEqual({ 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
    expect(css.body.toString()).toBe('body { color: red }');
    expect(css.headers['content-type']).toBe('text/css');
    expect(js.body.toString()).toBe('export const x = 1;');
    expect(js.headers.etag).toBe('"v1"');
    expect(proxy.size).toBe(0);
  });

  it('streams a binary larger than one chunk byte for byte, in chunks no larger than the protocol allows', async () => {
    const { proxy, result } = harness();
    const frame = request('/photo.bin');
    proxy.handle(frame);
    const r = await result(frame.requestId);
    // Full chunks as the body arrives; a part of one goes out early only if the body stalls (FLUSH_MS).
    expect(r.chunks.length).toBeGreaterThanOrEqual(Math.ceil(BINARY.length / PREVIEW_CHUNK_BYTES));
    expect(r.chunks.every((c) => c.length > 0 && c.length <= PREVIEW_CHUNK_BYTES)).toBe(true);
    expect(Buffer.compare(r.body, Buffer.from(BINARY))).toBe(0);
    expect(r.headers['content-length']).toBe(String(BINARY.length));
  });

  it('asks the preview server as the editor does: never with the guest’s cookies, credentials or host, and uncompressed', async () => {
    const { proxy, result } = harness();
    // The relay never passes these on; the host refuses them all the same.
    const frame = request('/app.css', { headers: [['cookie', 'so_preview=secret'], ['authorization', 'Bearer x'], ['host', 'evil.example'], ['connection', 'upgrade'], ['x-forwarded-for', '1.2.3.4'], ['if-none-match', '"v0"'], ['accept-encoding', 'gzip']] as never });
    proxy.handle(frame);
    await result(frame.requestId);
    const asked = seen.find((s) => s.url === '/app.css')!;
    expect(asked.headers.cookie).toBeUndefined();
    expect(asked.headers.authorization).toBeUndefined();
    expect(asked.headers['x-forwarded-for']).toBeUndefined();
    expect(asked.headers.host).toBe(`127.0.0.1:${port}`);
    expect(asked.headers['accept-encoding']).toBe('identity');
    expect(asked.headers['if-none-match']).toBe('"v0"');
    // Marked as a guest's, so the preview server applies none of the project's own proxy rules to it.
    expect(asked.headers[LIVE_GUEST_HEADER]).toBe('1');
  });

  it('passes on the request headers the protocol allows, joining one given twice', async () => {
    const { proxy, result } = harness();
    const frame = request('/app.js', { headers: [['accept', 'text/javascript'], ['accept-language', 'en'], ['accept-language', 'fr;q=0.5']] });
    proxy.handle(frame);
    await result(frame.requestId);
    expect(seen.find((x) => x.url === '/app.js')?.headers).toMatchObject({ accept: 'text/javascript', 'accept-language': 'en, fr;q=0.5' });
  });

  it('refuses a method other than GET or HEAD, and a target that is not plain ASCII, without asking the preview server', async () => {
    const { proxy, result } = harness();
    for (const extra of [{ method: 'POST' as never, target: '/app.css' }, { target: '/caf\u00e9' }, { target: '/\u0101' }, { target: '/q?x=\u4e2d' }]) {
      const frame = request(extra.target, extra);
      expect(() => proxy.handle(frame)).not.toThrow();
      expect((await result(frame.requestId)).head?.status).toBe(404);
    }
    expect(seen).toEqual([]);
    expect(proxy.size).toBe(0);
  });

  it('never asks the preview server for a path outside the preview or one of the development server’s own routes', async () => {
    const { proxy, result } = harness();
    for (const target of ['/../etc/passwd', '/%2e%2e/secret', '/a/%2F/b', '//evil.example/x', 'http://evil.example/', '/__open-in-editor?file=/etc/passwd', '/x/__inspect/', '/@fs\\..\\x']) {
      const frame = request(target);
      proxy.handle(frame);
      const r = await result(frame.requestId);
      expect(r.head?.status).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it('passes a relative redirect on resolved against the target, and drops one that leaves the preview', async () => {
    const { proxy, result } = harness();
    const contact = request('/contact/');
    const loop = request('/loopback-redirect');
    const outside = request('/outside-redirect');
    for (const f of [contact, loop, outside]) proxy.handle(f);
    expect((await result(contact.requestId)).headers.location).toBe('/contact/thanks');
    expect((await result(loop.requestId)).headers.location).toBe('/elsewhere?x=1');
    const away = await result(outside.requestId);
    expect(away.head?.status).toBe(302);
    expect(away.headers.location).toBeUndefined();
  });

  it('answers HEAD and 304 with a head and an empty end', async () => {
    const { proxy, result } = harness();
    const head = request('/photo.bin', { method: 'HEAD' });
    const cached = request('/cached', { headers: [['if-none-match', '"v1"']] });
    const reset = request('/reset');
    proxy.handle(head);
    proxy.handle(cached);
    proxy.handle(reset);
    const h = await result(head.requestId, 'HEAD');
    expect(seen.find((x) => x.url === '/photo.bin')?.method).toBe('HEAD');
    expect(h.head?.status).toBe(200);
    expect(h.chunks).toEqual([]);
    expect(h.headers['content-length']).toBe(String(BINARY.length));
    const c = await result(cached.requestId);
    expect(c.head?.status).toBe(304);
    expect(c.chunks).toEqual([]);
    const z = await result(reset.requestId);
    expect(z.head?.status).toBe(205);
    expect(z.chunks).toEqual([]);
  });

  it('gives up the connection of a bodyless answer that goes on sending, so its slot is freed', async () => {
    const { proxy, result } = harness();
    const before = closedEarly;
    const frame = request('/reset-streaming');
    proxy.handle(frame);
    const r = await result(frame.requestId);
    expect(r.head?.status).toBe(205);
    expect(r.chunks).toEqual([]);
    await until(() => proxy.size === 0 && closedEarly === before + 1, 'the connection given up');
  });

  it('stops a response larger than the protocol allows before sending it', async () => {
    const { proxy, result } = harness();
    const frame = request('/huge');
    proxy.handle(frame);
    const r = await result(frame.requestId);
    expect(r.head).toBeUndefined();
    expect(r.abort?.code).toBe('TOO_LARGE');
  });

  it('stops the guest’s response when the preview server fails midway', async () => {
    const { proxy, result } = harness();
    const frame = request('/broken');
    proxy.handle(frame);
    const r = await result(frame.requestId);
    expect(r.head?.status).toBe(200);
    expect(r.abort?.code).toBe('INVALID_RESPONSE');
    expect(proxy.size).toBe(0);
  });

  it('refuses a compressed or otherwise coded body, which the guest could not read, and passes an identity one', async () => {
    const { proxy, result } = harness();
    for (const target of ['/gzip', '/coded']) {
      const frame = request(target);
      proxy.handle(frame);
      const r = await result(frame.requestId);
      expect(r.head).toBeUndefined();
      expect(r.abort?.code).toBe('INVALID_RESPONSE');
    }
    const plain = request('/identity');
    proxy.handle(plain);
    expect((await result(plain.requestId)).body.toString()).toBe('plain');
    // A HEAD has no body to decode, whatever coding it describes.
    const head = request('/gzip', { method: 'HEAD' });
    proxy.handle(head);
    expect((await result(head.requestId, 'HEAD')).head?.status).toBe(200);
  });

  it('stops a response whose declared length is too large even when the length is not passed on', async () => {
    const { proxy, result } = harness();
    const frame = request('/hidden-length');
    proxy.handle(frame);
    const r = await result(frame.requestId);
    expect(r.head).toBeUndefined();
    expect(r.abort?.code).toBe('TOO_LARGE');
  });

  it('sends what has arrived of a slow body without waiting to fill a chunk', async () => {
    const { proxy, frames, result } = harness();
    const frame = request('/trickle');
    proxy.handle(frame);
    await until(() => frames.some((f) => f.requestId === frame.requestId && f.type === 'preview:response-chunk'), 'the first part', 2000);
    expect(frames.some((f) => f.requestId === frame.requestId && f.type === 'preview:response-end')).toBe(false);
    const r = await result(frame.requestId);
    expect(r.chunks.length).toBe(2);
    expect(r.body.toString()).toBe('firstlast');
  });

  it('says the preview is unavailable when the preview server hangs up before answering, or switches protocol', async () => {
    const { proxy, result } = harness();
    const hangup = request('/hangup');
    const upgrade = request('/upgrade');
    proxy.handle(hangup);
    proxy.handle(upgrade);
    expect((await result(hangup.requestId)).abort?.code).toBe('UNAVAILABLE');
    expect((await result(upgrade.requestId)).abort?.code).toBe('INVALID_RESPONSE');
    expect(proxy.size).toBe(0);
  });

  it('passes ranges and their headers on, and drops headers the response names as its connection’s own', async () => {
    const { proxy, result } = harness();
    const range = request('/range', { headers: [['range', 'bytes=100-199'], ['if-range', '"v1"']] });
    const nominated = request('/nominated');
    proxy.handle(range);
    proxy.handle(nominated);
    const r = await result(range.requestId);
    expect(r.head?.status).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes 100-199/${BINARY.length}`);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.compare(r.body, Buffer.from(BINARY.subarray(100, 200)))).toBe(0);
    expect(seen.find((s) => s.url === '/range')?.headers).toMatchObject({ range: 'bytes=100-199', 'if-range': '"v1"' });
    const n = await result(nominated.requestId);
    expect(n.body.toString()).toBe('ok');
    expect(n.headers.etag).toBeUndefined();
    const two = request('/nominated-two');
    proxy.handle(two);
    const t = await result(two.requestId);
    expect(t.headers).toEqual({ 'content-type': 'text/plain' });
  });

  it('answers that the preview is unavailable while no preview server is ready', async () => {
    const { proxy, result } = harness({ preview: () => null });
    const frame = request('/');
    proxy.handle(frame);
    expect((await result(frame.requestId)).abort?.code).toBe('UNAVAILABLE');
    expect(seen).toEqual([]);
  });

  it('lets go of the preview server’s response when the relay stops the request', async () => {
    const { proxy, frames } = harness();
    const frame = request('/slow');
    const before = closedEarly;
    proxy.handle(frame);
    await until(() => frames.some((f) => f.requestId === frame.requestId && f.type === 'preview:response-head'), 'the head');
    proxy.abort(frame.requestId);
    const deadline = Date.now() + 2000;
    while (closedEarly === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(closedEarly).toBe(before + 1);
    expect(proxy.size).toBe(0);
    // Nothing more goes out for a request the relay stopped.
    expect(frames.filter((f) => f.requestId === frame.requestId).map((f) => f.type)).toEqual(['preview:response-head']);
  });

  it('stops reading from the preview server while the socket is backed up, and carries on once it drains', async () => {
    let backlog = SOCKET_HIGH_WATER_BYTES + 1;
    const { proxy, frames, result } = harness({ buffered: () => backlog });
    const frame = request('/photo.bin');
    proxy.handle(frame);
    const deadline = Date.now() + 2000;
    while (!frames.some((f) => f.requestId === frame.requestId && f.type === 'preview:response-chunk') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 100));
    // Paused after the first full chunk, with the rest still to come.
    expect(frames.filter((f) => f.requestId === frame.requestId && f.type === 'preview:response-chunk').length).toBeLessThan(Math.ceil(BINARY.length / PREVIEW_CHUNK_BYTES));
    expect(frames.some((f) => f.requestId === frame.requestId && f.type === 'preview:response-end')).toBe(false);
    backlog = 0;
    const r = await result(frame.requestId);
    expect(Buffer.compare(r.body, Buffer.from(BINARY))).toBe(0);
  });

  it('holds each guest to its share of requests in flight, and stops only the one the relay names', async () => {
    const { proxy, frames } = harness();
    const mine = Array.from({ length: 16 }, () => request('/slow'));
    for (const f of mine) proxy.handle(f);
    const extra = request('/slow');
    proxy.handle(extra);
    expect(frames.find((f) => f.requestId === extra.requestId)).toEqual({ type: 'preview:abort', requestId: extra.requestId, code: 'UNAVAILABLE' });
    // Another guest still gets its own.
    const other = request('/slow', { guestId: 'g2' });
    proxy.handle(other);
    expect(proxy.size).toBe(17);
    proxy.abort(mine[0].requestId);
    expect(proxy.size).toBe(16);
    proxy.abortAll();
  });

  it('tells the relay each request was stopped when the preview server stops or moves', async () => {
    const { proxy, frames } = harness();
    const a = request('/slow');
    const b = request('/slow');
    proxy.handle(a);
    proxy.handle(b);
    await until(() => frames.filter((f) => f.type === 'preview:response-head' && (f.requestId === a.requestId || f.requestId === b.requestId)).length === 2, 'both heads');
    proxy.cancelAll('UNAVAILABLE');
    expect(proxy.size).toBe(0);
    for (const id of [a.requestId, b.requestId]) expect(frames.filter((f) => f.requestId === id).at(-1)).toEqual({ type: 'preview:abort', requestId: id, code: 'UNAVAILABLE' });
  });

  it('stops every request when the socket goes', async () => {
    const { proxy } = harness();
    const before = closedEarly;
    proxy.handle(request('/slow'));
    proxy.handle(request('/slow'));
    // Both have reached the preview server before the socket goes.
    await until(() => seen.filter((x) => x.url === '/slow').length === 2, 'both requests upstream');
    proxy.abortAll();
    expect(proxy.size).toBe(0);
    const deadline = Date.now() + 2000;
    while (closedEarly < before + 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(closedEarly).toBe(before + 2);
  });
});
