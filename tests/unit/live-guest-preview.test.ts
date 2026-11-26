/**
 * The remote shell's view of a host's preview (#766): the preview ticket is redeemed by the main process with no
 * Origin, and a loopback server serves the room's preview to the editor's window alone, with the preview cookie added
 * on the way and nothing else of the canvas's requests or the relay's answers passed through.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GuestPreviewServer, previewCookieOf, redeemPreviewTicket, REMOTE_PREVIEW_HEADER } from '../../src/main/live/guest-preview';

/** A stand-in for the relay's preview origin: it records what it was asked, and answers by path. */
const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = [];
let upstream: Server;
let port: number;
let stall: (() => void) | null = null;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.url === '/__siteorigin/admission') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ticket = JSON.parse(body).ticket;
        if (ticket === 'good-ticket-0123456789') {
          res.writeHead(204, { 'set-cookie': ['so_preview=v1.payload.mac; Path=/; Max-Age=60; HttpOnly; SameSite=Lax'] });
          return res.end();
        }
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('That preview ticket has already been used or has expired.');
      });
      return;
    }
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first');
      stall = () => res.destroy();
      return;
    }
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/elsewhere/' });
      return res.end();
    }
    if (req.url === '/away') {
      res.writeHead(302, { location: 'https://example.com/' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'site=1', 'cache-control': 'private, no-cache', etag: '"abc"', 'x-powered-by': 'Vite' });
    res.end(req.method === 'HEAD' ? undefined : `<!doctype html><title>${req.url}</title>`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  port = (upstream.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

const servers: GuestPreviewServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  seen.length = 0;
  stall = null;
});

/** Ask the loopback server as Chromium would: by its own address, with whatever headers are given. */
function ask(url: string, opts: { method?: string; headers?: Record<string, string>; path?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: Number(u.port), method: opts.method ?? 'GET', path: opts.path ?? '/', headers: { host: u.host, ...opts.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function served(target = true) {
  const server = new GuestPreviewServer();
  servers.push(server);
  const url = await server.start();
  if (target) server.setTarget({ origin: `http://p-room.relay.localhost:${port}`, cookie: 'so_preview=v1.payload.mac' });
  return { server, url, secret: { [REMOTE_PREVIEW_HEADER]: server.secret } };
}

describe('redeeming a preview ticket', () => {
  it('posts the ticket with no Origin, on loopback for a .localhost relay, and keeps the cookie it is given', async () => {
    const result = await redeemPreviewTicket(`http://p-room.relay.localhost:${port}`, 'good-ticket-0123456789');
    expect(result).toEqual({ ok: true, cookie: 'so_preview=v1.payload.mac' });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/__siteorigin/admission' });
    expect(seen[0].headers.origin).toBeUndefined();
    // Reached on loopback, but asked of the room's own preview host, which the relay routes by.
    expect(seen[0].headers.host).toBe(`p-room.relay.localhost:${port}`);
  });

  it('reports a ticket the relay refuses, and one it cannot reach', async () => {
    expect(await redeemPreviewTicket(`http://p-room.relay.localhost:${port}`, 'spent-ticket-0123456789')).toMatchObject({ ok: false });
    expect(await redeemPreviewTicket('http://127.0.0.1:1', 'good-ticket-0123456789', { timeoutMs: 2000 })).toMatchObject({ ok: false });
  });

  it('takes only the relay’s own preview cookie', () => {
    expect(previewCookieOf(['site=1', '__Host-so_preview=v1.a.b; Path=/; Secure'])).toBe('__Host-so_preview=v1.a.b');
    expect(previewCookieOf('so_preview=v1.a.b; HttpOnly')).toBe('so_preview=v1.a.b');
    expect(previewCookieOf(['other=1'])).toBeNull();
    expect(previewCookieOf(undefined)).toBeNull();
  });
});

describe('the loopback preview', () => {
  it('serves the room’s preview to the editor with the preview cookie, passing on only what the tunnel passes', async () => {
    const { url, secret } = await served();
    const res = await ask(url, { path: '/about/?tab=1', headers: { ...secret, accept: 'text/html', cookie: 'mine=1', 'x-other': 'no', 'sec-fetch-dest': 'iframe' } });
    expect(res.status).toBe(200);
    expect(res.body).toBe('<!doctype html><title>/about/?tab=1</title>');
    const asked = seen[0].headers;
    expect(seen[0].url).toBe('/about/?tab=1');
    expect(asked.cookie).toBe('so_preview=v1.payload.mac');
    expect(asked.host).toBe(`p-room.relay.localhost:${port}`);
    expect(asked.accept).toBe('text/html');
    // Neither the editor's own cookies, the secret, nor what Chromium says of the request leave this computer.
    for (const name of ['x-other', REMOTE_PREVIEW_HEADER, 'sec-fetch-dest', 'origin']) expect(asked[name]).toBeUndefined();
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.etag).toBe('"abc"');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('answers only the editor’s window: a request without its secret, or by another name, is refused', async () => {
    const { url, secret } = await served();
    expect((await ask(url)).status).toBe(403);
    expect((await ask(url, { headers: { [REMOTE_PREVIEW_HEADER]: 'guess' } })).status).toBe(403);
    expect((await ask(url, { headers: { ...secret, host: 'evil.example:80' } })).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('is read-only and stays within the preview', async () => {
    const { url, secret } = await served();
    expect((await ask(url, { method: 'POST', headers: secret })).status).toBe(405);
    expect((await ask(url, { path: '/__open-in-editor?file=x', headers: secret })).status).toBe(404);
    expect((await ask(url, { path: '/a/../b', headers: secret })).status).toBe(404);
    expect((await ask(url, { headers: { ...secret, 'service-worker': 'script' } })).status).toBe(403);
    expect(seen).toHaveLength(0);
    const head = await ask(url, { method: 'HEAD', headers: secret });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('keeps a redirect within the preview and drops one that leaves it', async () => {
    const { url, secret } = await served();
    expect((await ask(url, { path: '/moved', headers: secret })).headers.location).toBe('/elsewhere/');
    expect((await ask(url, { path: '/away', headers: secret })).headers.location).toBeUndefined();
  });

  it('answers 503 until the cookie is in place, and once access has ended, stops what is on its way', async () => {
    const { server, url, secret } = await served(false);
    expect((await ask(url, { headers: secret })).status).toBe(503);
    server.setTarget({ origin: `http://p-room.relay.localhost:${port}`, cookie: 'so_preview=v1.payload.mac' });
    const slow = ask(url, { path: '/slow', headers: secret }).catch((e: Error) => e);
    for (let i = 0; i < 100 && !stall; i++) await new Promise((r) => setTimeout(r, 5));
    server.setTarget(null);
    // The response already under way is cut off rather than left to finish from the relay.
    expect(await slow).toBeInstanceOf(Error);
    expect((await ask(url, { headers: secret })).status).toBe(503);
  });

  it('refuses the development client’s socket, and stops serving once closed', async () => {
    const { server, url, secret } = await served();
    const upgraded = await new Promise<string>((resolve) => {
      const u = new URL(url);
      const req = httpRequest({ host: '127.0.0.1', port: Number(u.port), path: '/', headers: { ...secret, host: u.host, connection: 'Upgrade', upgrade: 'websocket' } });
      req.on('upgrade', () => resolve('upgraded'));
      req.on('response', () => resolve('response'));
      req.on('error', () => resolve('refused'));
      req.end();
    });
    expect(upgraded).toBe('refused');
    await server.close();
    await expect(ask(url, { headers: secret })).rejects.toThrow();
    expect(server.url).toBeNull();
  });
});
