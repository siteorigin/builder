import { createServer as createHttpServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { LIVE_GUEST_HEADER, liveGuestPlugin } from '../../src/runtime/policy';

/**
 * A live session guest is shown the project's site and nothing more: the preview server never sends a guest's request
 * on through the project's own `server.proxy` rules, however its options are set up, and never lets one reach the dev
 * server's own routes through a rewrite.
 */

type Bypass = (this: unknown, req: unknown, res: unknown, opts: unknown) => unknown;
type Rule = { target?: string; changeOrigin?: boolean; bypass?: Bypass; configure?: (proxy: unknown, opts: Rule) => void };
type Middleware = (req: { headers: Record<string, string>; url?: string }, res: { statusCode: number; setHeader(n: string, v: string): unknown; end(b?: string): unknown }, next: () => void) => void;

/** The plugin applied to a server with these rules: the rules as Vite then reads them, and the middleware it adds. */
function applied(proxy?: Record<string, string | Rule | undefined>) {
  const uses: Middleware[] = [];
  liveGuestPlugin().configureServer({ config: { server: { proxy: proxy as never } }, middlewares: { use: (fn) => uses.push(fn as never) } });
  return { rules: (proxy ?? {}) as Record<string, Rule | undefined>, uses };
}
const req = (guest: boolean, url = '/api/x') => ({ url, headers: guest ? { [LIVE_GUEST_HEADER]: '1' } : ({} as Record<string, string>) });
const res = (writableEnded = false) => ({ writableEnded });

describe('the live guest guard on each proxy rule', () => {
  it('refuses a guest whatever a rule would forward, and leaves the editor’s own requests alone', async () => {
    const { rules } = applied({ '/api': 'http://localhost:3000', '^/legacy/.*': { target: 'https://old.example' }, '/off': undefined });
    // A rule given as a target is read as Vite reads it; an object rule keeps its options.
    expect(rules['/api']).toMatchObject({ target: 'http://localhost:3000', changeOrigin: true });
    expect(rules['^/legacy/.*']).toMatchObject({ target: 'https://old.example' });
    expect(await rules['/api']!.bypass!(req(true), res(), {})).toBe(false);
    expect(await rules['^/legacy/.*']!.bypass!(req(true, '/legacy/a'), res(), {})).toBe(false);
    expect(await rules['/api']!.bypass!(req(false), res(), {})).toBeUndefined();
    expect(rules['/off']).toBeUndefined();
  });

  it('keeps a local answer the project’s own bypass gives a guest, but only a place in the preview', async () => {
    const own: Bypass = async (r) => {
      const url = (r as { url: string }).url;
      return url.endsWith('.html') ? '/index.html' : url === '/edit' ? '/__open-in-editor?file=/etc/hosts' : undefined;
    };
    const { rules } = applied({ '/': { target: 'http://localhost:3000', bypass: own } });
    expect(await rules['/']!.bypass!(req(true, '/page.html'), res(), {})).toBe('/index.html');
    expect(await rules['/']!.bypass!(req(true, '/edit'), res(), {})).toBe(false);
    expect(await rules['/']!.bypass!(req(true, '/data'), res(), {})).toBe(false);
    expect(await rules['/']!.bypass!(req(false, '/data'), res(), {})).toBeUndefined();
    // An answer the project's code has already sent stands, and Vite is told not to forward it.
    expect(await rules['/']!.bypass!(req(true, '/data'), res(true), {})).toBe('/data');
  });

  it('calls the project’s own bypass as Vite does, on the rule’s options', async () => {
    let self: unknown;
    const { rules } = applied({
      '/api': {
        target: 'http://localhost:3000',
        bypass(this: unknown) {
          self = this;
          return undefined;
        }
      }
    });
    const options = rules['/api']!;
    await options.bypass!.call(options, req(false), res(), options);
    expect(self).toBe(options);
  });

  it('guards a bypass a rule’s own configure sets, and stops a guest’s request about to be sent on', async () => {
    const { rules } = applied({ '/api': { target: 'http://localhost:3000', configure: (_proxy, opts) => void (opts.bypass = () => undefined) } });
    const listeners: Array<(proxyReq: { destroy(): void }, r: unknown) => void> = [];
    const opts = { ...rules['/api']! };
    rules['/api']!.configure!({ on: (_e: string, fn: never) => listeners.push(fn) }, opts);
    expect(await opts.bypass!(req(true), res(), {})).toBe(false);
    let destroyed = 0;
    for (const fn of listeners) fn({ destroy: () => destroyed++ }, req(true));
    for (const fn of listeners) fn({ destroy: () => destroyed++ }, req(false));
    expect(destroyed).toBe(1);
  });

  it('refuses a guest whose address something rewrote out of the preview', () => {
    const { uses } = applied();
    const ask = (url: string, guest: boolean) => {
      let passed = false;
      const r = { statusCode: 200, setHeader: () => undefined, end: () => undefined };
      for (const fn of uses) fn(req(guest, url), r, () => (passed = true));
      return passed ? 'passed' : r.statusCode;
    };
    expect(ask('/__open-in-editor?file=/etc/hosts', true)).toBe(404);
    expect(ask('/x/__inspect/', true)).toBe(404);
    expect(ask('/__open-in-editor?file=/etc/hosts', false)).toBe('passed');
    expect(ask('/about/', true)).toBe('passed');
    expect(ask('/@vite/client', true)).toBe('passed');
  });
});

describe('a real preview server with proxy rules', () => {
  let secret: Server;
  let vite: ViteDevServer;
  let port: number;
  /** Every request the private service received. */
  const reached: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'so-live-guest-'));

  beforeAll(async () => {
    // A service only the host's computer can reach, behind the project's proxy rules.
    secret = createHttpServer((r, s) => {
      reached.push(r.url ?? '');
      s.end('private data');
    });
    await new Promise<void>((resolve) => secret.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${(secret.address() as AddressInfo).port}`;
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Site</title>');
    vite = await createViteServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
        proxy: {
          '/api': target,
          // Answers some requests itself, and lets the rest go on.
          '/self': { target, bypass: (r, s) => void (r.url === '/self/local' && s?.end('local answer')) },
          // Its own configure replaces its bypass with one that lets everything go on.
          '/conf': { target, configure: (_proxy, opts) => void (opts.bypass = () => undefined) }
        }
      },
      plugins: [
        // The project's own middleware, rewriting a local address into a proxied one before Vite forwards it.
        { name: 'rewrites', configureServer: (server) => void server.middlewares.use((r, _res, next) => ((r.url = r.url === '/shortcut' ? '/api/secret' : r.url), next())) },
        liveGuestPlugin()
      ]
    });
    await vite.listen();
    port = (vite.httpServer!.address() as AddressInfo).port;
  }, 30_000);
  afterAll(async () => {
    await vite?.close();
    await new Promise<void>((resolve) => secret?.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const get = (path: string, guest: boolean) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, headers: guest ? { [LIVE_GUEST_HEADER]: '1' } : {} }, (response) => {
        let body = '';
        response.on('data', (d) => (body += d));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      r.on('error', reject);
      r.end();
    });

  it('never sends a guest’s request on, however it reaches a rule, and still forwards the editor’s', async () => {
    expect(await get('/api/secret', true)).toMatchObject({ status: 404 });
    expect((await get('/shortcut', true)).body).not.toContain('private data');
    expect((await get('/self/local', true)).body).toBe('local answer');
    expect((await get('/self/other', true)).body).not.toContain('private data');
    expect((await get('/conf/x', true)).body).not.toContain('private data');
    expect(reached).toEqual([]);
    expect(await get('/api/secret', false)).toEqual({ status: 200, body: 'private data' });
    expect(await get('/conf/x', false)).toEqual({ status: 200, body: 'private data' });
    expect(reached).toEqual(['/api/secret', '/conf/x']);
    // The site itself is still the guest's.
    expect((await get('/', true)).body).toContain('<title>Site</title>');
  });
});
