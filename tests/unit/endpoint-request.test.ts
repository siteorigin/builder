/**
 * The Endpoints panel's test requests (#1481): only to the project's own preview, at an address in the site, with the
 * site's own Origin, and bounded in what they send, how long they wait and how much they read. Run here against a
 * loopback server standing in for the preview.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { endpointRequestProblem, ENDPOINT_REQUEST_LIMITS, sendEndpointRequest } from '../../src/main/runtime/endpoint-request';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
async function preview(fn: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => fn(req, res, body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('what a test request may be', () => {
  it('goes to an address in the site, never one of the dev server’s or the project’s files', () => {
    const ok = (path: string) => endpointRequestProblem({ method: 'GET', path });
    expect(ok('/api/search?q=chairs')).toBeNull();
    expect(ok('/')).toBeNull();
    // An endpoint of the developer's own may have any address a page could.
    for (const p of ['/build/status', '/static/x', '/tests/run', '/scripts/x']) expect(ok(p), p).toBeNull();
    for (const p of ['api/search', '//evil.example/x', '/@fs/etc/passwd', '/@vite/client', '/node_modules/x', '/src/lib/x.js', '/%73rc/lib/x.js', '/SRC/lib/x.js', '/.svelte-kit/generated/x', '/.env', '/package.json', '/siteorigin/site.json', '/vite.config.js', '/__open-in-editor?file=x', '/a/../b', 'http://127.0.0.1/x', '/x#y', '/a b'])
      expect(ok(p), p).not.toBeNull();
  });

  it('carries the author’s headers, never the transport’s or the app’s own, and a body only with a method that takes one', () => {
    expect(endpointRequestProblem({ method: 'POST', path: '/api/x', headers: [['content-type', 'application/json'], ['authorization', 'Bearer t']], body: '{}' })).toBeNull();
    for (const h of ['host', 'Origin', 'content-length', 'connection', 'transfer-encoding', 'x-siteorigin-live-guest', 'proxy-anything'])
      expect(endpointRequestProblem({ method: 'GET', path: '/api/x', headers: [[h, 'x']] }), h).toContain('leave it out');
    expect(endpointRequestProblem({ method: 'GET', path: '/api/x', headers: [['x-a', 'one\r\ntwo']] })).toContain('line breaks');
    expect(endpointRequestProblem({ method: 'GET', path: '/api/x', headers: [['bad name', 'x']] })).toContain('cannot be a header');
    expect(endpointRequestProblem({ method: 'GET', path: '/api/x', body: 'x' })).toContain('has no body');
    expect(endpointRequestProblem({ method: 'TRACE' as never, path: '/api/x' })).toContain('method');
    expect(endpointRequestProblem({ method: 'POST', path: '/api/x', body: 'x'.repeat(ENDPOINT_REQUEST_LIMITS.maxRequestBytes + 1) })).toContain('too large');
    // Bytes, not characters: a body of three-byte characters a third as long is as large.
    expect(endpointRequestProblem({ method: 'POST', path: '/api/x', body: '€'.repeat(Math.ceil((ENDPOINT_REQUEST_LIMITS.maxRequestBytes + 1) / 3)) })).toContain('too large');
    expect(endpointRequestProblem({ method: 'GET', path: '/api/x', headers: Array.from({ length: 41 }, (_, i): [string, string] => [`x-h${i}`, 'v']) })).toContain('at most 40');
    expect(endpointRequestProblem({ method: 'GET', path: '/api/x', headers: [['x-big', 'v'.repeat(9000)]] })).toContain('too long');
  });
});

describe('a test request', () => {
  it('reaches the preview with the site’s own Origin, and says the status, headers, body and time taken', async () => {
    const at = await preview((req, res, body) => {
      res.writeHead(201, 'Created', { 'content-type': 'application/json', 'x-seen-origin': String(req.headers.origin), 'x-seen-auth': String(req.headers.authorization) });
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
    let t = 0;
    const r = await sendEndpointRequest(at, { method: 'POST', path: '/api/echo?q=1', headers: [['authorization', 'Bearer t']], body: '{"a":1}' }, { now: () => (t += 25) });
    expect(r).toMatchObject({ ok: true, status: 201, statusText: 'Created', truncated: false, ms: 25 });
    if (!r.ok) return;
    expect(JSON.parse(r.body)).toEqual({ method: 'POST', url: '/api/echo?q=1', body: '{"a":1}' });
    expect(r.headers).toEqual(expect.arrayContaining([['x-seen-origin', at], ['x-seen-auth', 'Bearer t']]));
  });

  it('shows a redirect as it came, without following it', async () => {
    const at = await preview((_req, res) => {
      res.writeHead(308, { location: 'https://example.com/elsewhere' });
      res.end();
    });
    const r = await sendEndpointRequest(at, { method: 'GET', path: '/api/old' });
    expect(r).toMatchObject({ ok: true, status: 308 });
    if (r.ok) expect(r.headers).toContainEqual(['location', 'https://example.com/elsewhere']);
  });

  it('reads at most the first megabyte of an answer', async () => {
    const at = await preview((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(ENDPOINT_REQUEST_LIMITS.maxResponseBytes + 5000));
    });
    const r = await sendEndpointRequest(at, { method: 'GET', path: '/api/big' });
    expect(r).toMatchObject({ ok: true, truncated: true });
    if (r.ok) expect(r.body.length).toBe(ENDPOINT_REQUEST_LIMITS.maxResponseBytes);
  });

  it('is called off when asked, and says so', async () => {
    const at = await preview(() => undefined);
    const stop = new AbortController();
    const sent = sendEndpointRequest(at, { method: 'GET', path: '/api/slow' }, { signal: stop.signal });
    setTimeout(() => stop.abort(), 50);
    expect(await sent).toEqual({ ok: false, message: 'The request was stopped.' });
  });

  it('is given up when no answer comes in time, with no one calling it off', async () => {
    const at = await preview(() => undefined);
    const limit = ENDPOINT_REQUEST_LIMITS.timeoutMs;
    ENDPOINT_REQUEST_LIMITS.timeoutMs = 100;
    try {
      expect(await sendEndpointRequest(at, { method: 'GET', path: '/api/slow' })).toEqual({ ok: false, message: 'No answer came within 0.1 seconds, so the request was given up.' });
    } finally {
      ENDPOINT_REQUEST_LIMITS.timeoutMs = limit;
    }
  });

  it('is sent only to the preview’s loopback address, and says when nothing is there', async () => {
    expect(await sendEndpointRequest('http://example.com', { method: 'GET', path: '/api/x' })).toMatchObject({ ok: false, message: expect.stringContaining('not running') });
    expect(await sendEndpointRequest('http://127.0.0.1:1', { method: 'GET', path: '/api/x' })).toMatchObject({ ok: false, message: expect.stringContaining('could not be sent') });
    expect(await sendEndpointRequest('http://127.0.0.1:1', { method: 'GET', path: '/@fs/etc/passwd' })).toMatchObject({ ok: false, message: expect.stringContaining('address in the site') });
  });
});
