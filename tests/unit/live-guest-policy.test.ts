import { createServer as createHttpServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { LIVE_GUEST_HEADER, liveGuestPlugin } from '../../src/runtime/policy';

/**
 * A live session guest is shown the project's site and nothing more: the preview server never forwards a guest's
 * request through the project's own `server.proxy` rules, judged where Vite decides to forward it.
 */

type Rule = { target?: string; changeOrigin?: boolean; bypass?: (req: unknown, res: unknown, opts: unknown) => unknown };

/** The rules as the plugin leaves them for Vite. */
function wrapped(proxy: Record<string, string | Rule | undefined>) {
  liveGuestPlugin().configureServer({ config: { server: { proxy: proxy as never } } });
  return proxy as Record<string, Rule | undefined>;
}
const req = (guest: boolean, url = '/api/x') => ({ url, headers: guest ? { [LIVE_GUEST_HEADER]: '1' } : {} });

describe('the live guest guard on each proxy rule', () => {
  it('refuses a guest whatever a rule would forward, and leaves the editor’s own requests alone', async () => {
    const rules = wrapped({ '/api': 'http://localhost:3000', '^/legacy/.*': { target: 'https://old.example' }, '/off': undefined });
    // A rule given as a target is read as Vite reads it.
    expect(rules['/api']).toMatchObject({ target: 'http://localhost:3000', changeOrigin: true });
    expect(await rules['/api']!.bypass!(req(true), {}, {})).toBe(false);
    expect(await rules['^/legacy/.*']!.bypass!(req(true, '/legacy/a'), {}, {})).toBe(false);
    expect(await rules['/api']!.bypass!(req(false), {}, {})).toBeUndefined();
    expect(rules['/off']).toBeUndefined();
  });

  it('keeps a local answer the project’s own bypass gives a guest, and nothing it would forward', async () => {
    const rules = wrapped({ '/': { target: 'http://localhost:3000', bypass: (r) => ((r as { url: string }).url.endsWith('.html') ? '/index.html' : undefined) } });
    expect(await rules['/']!.bypass!(req(true, '/page.html'), {}, {})).toBe('/index.html');
    expect(await rules['/']!.bypass!(req(true, '/data'), {}, {})).toBe(false);
    expect(await rules['/']!.bypass!(req(false, '/data'), {}, {})).toBeUndefined();
    // An answer the project's code has already sent stands too.
    expect(await rules['/']!.bypass!(req(true, '/data'), { writableEnded: true }, {})).toBeUndefined();
  });

  it('adds nothing for a project with no proxy rules', () => {
    expect(() => liveGuestPlugin().configureServer({ config: { server: {} } })).not.toThrow();
  });
});

describe('a real preview server with a proxy rule', () => {
  let secret: Server;
  let vite: ViteDevServer;
  let port: number;
  const root = mkdtempSync(join(tmpdir(), 'so-live-guest-'));

  beforeAll(async () => {
    // A service only the host's computer can reach, behind the project's proxy rule.
    secret = createHttpServer((_req, res) => res.end('private data'));
    await new Promise<void>((resolve) => secret.listen(0, '127.0.0.1', resolve));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Site</title>');
    vite = await createViteServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': `http://127.0.0.1:${(secret.address() as AddressInfo).port}` } },
      plugins: [
        // The project's own middleware, rewriting a local address into the proxied one before Vite forwards it.
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
      const r = request({ host: '127.0.0.1', port, path, headers: guest ? { [LIVE_GUEST_HEADER]: '1' } : {} }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      r.on('error', reject);
      r.end();
    });

  it('never forwards a guest, however the address reaches the rule, and still forwards the editor', async () => {
    expect(await get('/api/secret', true)).toMatchObject({ status: 404 });
    expect((await get('/shortcut', true)).body).not.toContain('private data');
    expect(await get('/api/secret', false)).toEqual({ status: 200, body: 'private data' });
    // The site itself is still the guest's.
    expect((await get('/', true)).body).toContain('<title>Site</title>');
  });
});
