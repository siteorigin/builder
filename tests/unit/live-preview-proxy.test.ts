import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PREVIEW_CHUNK_BYTES } from '../../src/shared/live/limits';
import { checkFrame } from '../../src/shared/live/messages';
import { PreviewStream } from '../../src/shared/live/preview';
import { loopbackPreview, PreviewProxy, previewRedirect, SOCKET_HIGH_WATER_BYTES, type PreviewReplyFrame, type PreviewRequestFrame } from '../../src/main/live/preview-proxy';

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
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen.length = 0;
});

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
    for (const url of ['http://localhost:5173', 'http://10.0.0.2:5173', 'https://127.0.0.1:5173', 'http://u:p@127.0.0.1:5173', 'http://127.0.0.1:5173/base/', 'http://127.0.0.1', 'nonsense', null, undefined])
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

  it('streams a binary larger than one chunk byte for byte, in full chunks', async () => {
    const { proxy, result } = harness();
    const frame = request('/photo.bin');
    proxy.handle(frame);
    const r = await result(frame.requestId);
    expect(r.chunks.length).toBe(Math.ceil(BINARY.length / PREVIEW_CHUNK_BYTES));
    expect(r.chunks.slice(0, -1).every((c) => c.length === PREVIEW_CHUNK_BYTES)).toBe(true);
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

  it('refuses a compressed body, which the guest could not read without its encoding', async () => {
    const { proxy, result } = harness();
    const frame = request('/gzip');
    proxy.handle(frame);
    const r = await result(frame.requestId);
    expect(r.head).toBeUndefined();
    expect(r.abort?.code).toBe('INVALID_RESPONSE');
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
    while (!frames.some((f) => f.requestId === frame.requestId && f.type === 'preview:response-head')) await new Promise((r) => setTimeout(r, 5));
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

  it('stops every request when the socket goes', async () => {
    const { proxy } = harness();
    const before = closedEarly;
    proxy.handle(request('/slow'));
    proxy.handle(request('/slow'));
    while (proxy.size < 2) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
    proxy.abortAll();
    expect(proxy.size).toBe(0);
    const deadline = Date.now() + 2000;
    while (closedEarly < before + 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(closedEarly).toBe(before + 2);
  });
});
