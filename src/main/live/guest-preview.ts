import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo, LookupFunction, Socket } from 'node:net';
import { MAX_HEADER_VALUE_LENGTH } from '@shared/live/limits';
import { isPreviewHeaderName, isPreviewHeaderValue, isPreviewLocation, isPreviewTarget, PREVIEW_METHODS } from '@shared/live/preview';
import { PREVIEW_ADMISSION_PATH } from '@shared/live/relay-url';

/**
 * The remote shell's view of a host's preview (#766). An admitted guest's preview cookie is SameSite=Lax and host-only
 * on the room's preview origin, and the editor's canvas is a frame of the app's own page, which that origin is
 * cross-site to: a browser would never send the cookie with it. So the guest's main process holds the cookie itself,
 * and a loopback server here serves the room's preview at `http://127.0.0.1:<port>`, asking the relay for each page
 * with the cookie added. The canvas then shows the host's site exactly as it shows a local project's preview, and the
 * cookie never reaches the app's pages.
 *
 * Only the room's preview origin is ever asked, only for GET and HEAD, only for paths within the preview, and only with
 * the request and response headers the tunnel itself passes on (shared/live/preview.ts).
 */

/** How long a ticket's redemption may take before it is given up; a ticket is good for a minute. */
export const REDEEM_TIMEOUT_MS = 15_000;
/** How long the relay may go without sending anything for a preview request before it is given up. */
export const UPSTREAM_IDLE_MS = 60_000;

/** The parts of an http(s) origin a request to it needs, with `.localhost` names reached on loopback. */
interface Upstream {
  secure: boolean;
  hostname: string;
  port: number;
  /** The Host header: the origin's host as written, with its port when it has one. */
  host: string;
  lookup?: LookupFunction;
}

/**
 * `localhost` and every name under it are loopback (RFC 6761), as browsers treat them: local development points the
 * app at `http://relay.localhost:8787`, and each room's preview is `p-<label>.relay.localhost`, which the operating
 * system's resolver may not know. The local relay listens on 127.0.0.1.
 */
const loopback: LookupFunction = (_hostname, options, callback) => {
  if ((options as { all?: boolean }).all) (callback as unknown as (err: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};

function upstreamOf(origin: string): Upstream {
  const url = new URL(origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('A preview origin is http or https.');
  const secure = url.protocol === 'https:';
  const hostname = url.hostname;
  const local = hostname === 'localhost' || hostname.endsWith('.localhost');
  return { secure, hostname, port: url.port ? Number(url.port) : secure ? 443 : 80, host: url.host, ...(local ? { lookup: loopback } : {}) };
}

function send(upstream: Upstream, options: { method: string; path: string; headers: Record<string, string>; signal?: AbortSignal }): ClientRequest {
  const request = upstream.secure ? httpsRequest : httpRequest;
  return request({
    hostname: upstream.hostname,
    port: upstream.port,
    method: options.method,
    path: options.path,
    headers: { ...options.headers, host: upstream.host },
    setHost: false,
    ...(upstream.lookup ? { lookup: upstream.lookup } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  });
}

/** The preview cookie a redemption set, as the `name=value` pair to send back, or null when it set none. */
export function previewCookieOf(setCookie: readonly string[] | string | undefined): string | null {
  for (const header of typeof setCookie === 'string' ? [setCookie] : (setCookie ?? [])) {
    const pair = header.split(';')[0].trim();
    // The relay's own names (relay/src/admission.ts): `__Host-so_preview` over HTTPS, `so_preview` over plain HTTP.
    if (/^(?:__Host-)?so_preview=[A-Za-z0-9._-]{1,1024}$/.test(pair)) return pair;
  }
  return null;
}

export type RedeemResult = { ok: true; cookie: string } | { ok: false; message: string };

/**
 * Redeem an admitted guest's preview ticket on the room's preview origin for its preview cookie. The request carries
 * no Origin, as the relay expects of the app's own main process (relay/src/index.ts): the ticket is what it checks.
 */
export function redeemPreviewTicket(previewOrigin: string, ticket: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RedeemResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: RedeemResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let req: ClientRequest;
    try {
      const body = JSON.stringify({ ticket });
      req = send(upstreamOf(previewOrigin), { method: 'POST', path: PREVIEW_ADMISSION_PATH, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, ...(options.signal ? { signal: options.signal } : {}) });
      req.on('response', (res) => {
        res.resume();
        if (res.statusCode !== 204) return done({ ok: false, message: `The relay refused the preview ticket (${res.statusCode}).` });
        const cookie = previewCookieOf(res.headers['set-cookie']);
        done(cookie ? { ok: true, cookie } : { ok: false, message: 'The relay gave no preview cookie.' });
      });
      req.on('error', (error) => done({ ok: false, message: `The preview could not be reached: ${error.message}` }));
      req.end(body);
    } catch (error) {
      return done({ ok: false, message: `The preview could not be reached: ${error instanceof Error ? error.message : String(error)}` });
    }
    const timer = setTimeout(() => {
      req.destroy();
      done({ ok: false, message: 'The relay took too long to admit the preview.' });
    }, options.timeoutMs ?? REDEEM_TIMEOUT_MS);
  });
}

/** Where the loopback server sends what it is asked: the room's preview origin, with the guest's current cookie. */
export interface GuestPreviewTarget {
  origin: string;
  cookie: string;
}

/**
 * The header that proves a request to the loopback server comes from the editor's own window: the main process adds
 * it to that window's requests alone (src/main/index.ts), with a secret made for each join. Any other program on this
 * computer, or a web page in a browser, that finds the port is refused, so an admitted preview is shown only where it
 * was admitted. It is never passed on.
 */
export const REMOTE_PREVIEW_HEADER = 'x-siteorigin-remote-preview';

/** Response headers the relay's preview sets itself and the canvas should keep: its caching policy, private and checked each time. */
const RELAY_RESPONSE_HEADERS = new Set(['cache-control']);

/**
 * The loopback server the remote shell's canvas loads the host's preview from. It holds no state of the session but
 * the target it is given: with none (before the cookie is in place, or once access has ended) every request is
 * answered 503, and requests still on their way are stopped.
 */
export class GuestPreviewServer {
  private server: Server | null = null;
  private port = 0;
  private target: GuestPreviewTarget | null = null;
  private readonly inflight = new Set<{ req: ClientRequest | null; res: ServerResponse }>();
  private readonly sockets = new Set<Socket>();
  /** The secret the editor's requests carry in REMOTE_PREVIEW_HEADER. */
  readonly secret = randomBytes(24).toString('base64url');

  /** The server's address once it is listening: `http://127.0.0.1:<port>`. */
  get url(): string | null {
    return this.server && this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  /** Start listening on a free loopback port; resolves with the server's address. */
  async start(): Promise<string> {
    if (this.url) return this.url;
    const server = createServer((req, res) => this.serve(req, res));
    // The preview's development client asks for a socket for hot updates, which the relay cannot carry.
    server.on('upgrade', (_req, socket: Socket) => socket.destroy());
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (this.server !== server) throw new Error('The preview server was closed while it started.');
    this.port = (server.address() as AddressInfo).port;
    return this.url!;
  }

  /** Serve the preview from `target` from now on; null answers every request 503 and stops those on their way. */
  setTarget(target: GuestPreviewTarget | null): void {
    const before = this.target;
    this.target = target;
    if (!target || (before && before.origin !== target.origin)) this.stopInflight();
  }

  /** Stop listening, and stop every request on its way. Safe to call more than once. */
  close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = 0;
    this.target = null;
    this.stopInflight();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private stopInflight(): void {
    for (const call of [...this.inflight]) {
      call.req?.destroy();
      if (!call.res.headersSent) this.answer(call.res, 503, 'The live session’s preview is not available right now.');
      else call.res.destroy();
    }
    this.inflight.clear();
  }

  private answer(res: ServerResponse, status: number, text: string): void {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(text);
  }

  private serve(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET';
    if (!(PREVIEW_METHODS as readonly string[]).includes(method)) {
      res.setHeader('allow', PREVIEW_METHODS.join(', '));
      return this.answer(res, 405, 'The preview is read-only.');
    }
    // Only pages that reached this server by its own address: another name that resolves here (a site rebinding its
    // own domain to this computer) is not the canvas.
    if (req.headers.host !== `127.0.0.1:${this.port}` || req.headers[REMOTE_PREVIEW_HEADER] !== this.secret) return this.answer(res, 403, 'Not this preview.');
    // A service worker would go on answering for the site after the guest's access ends.
    if (req.headers['service-worker'] !== undefined) return this.answer(res, 403, 'A live session’s preview cannot install a service worker.');
    const path = req.url ?? '/';
    if (!isPreviewTarget(path) || /[^\x21-\x7e]/.test(path)) return this.answer(res, 404, 'Not found.');
    const target = this.target;
    if (!target) return this.answer(res, 503, 'The live session’s preview is not available right now.');

    const headers: Record<string, string> = { cookie: target.cookie, 'accept-encoding': 'identity' };
    for (const [name, value] of Object.entries(req.headers)) {
      const text = Array.isArray(value) ? value.join(', ') : value;
      if (text !== undefined && isPreviewHeaderName(name, 'request') && isPreviewHeaderValue(text)) headers[name] = text;
    }
    const call: { req: ClientRequest | null; res: ServerResponse } = { req: null, res };
    this.inflight.add(call);
    const finish = () => this.inflight.delete(call);
    res.on('close', () => {
      finish();
      call.req?.destroy();
    });
    let upstream: ClientRequest;
    try {
      upstream = send(upstreamOf(target.origin), { method, path, headers });
    } catch {
      finish();
      return this.answer(res, 502, 'The live session’s preview could not be reached.');
    }
    call.req = upstream;
    upstream.setTimeout(UPSTREAM_IDLE_MS, () => upstream.destroy(new Error('timed out')));
    upstream.on('error', () => {
      finish();
      if (!res.headersSent) this.answer(res, 502, 'The live session’s preview could not be reached.');
      else res.destroy();
    });
    upstream.on('response', (up) => this.relay(up, res, method, finish));
    upstream.end();
  }

  /** Pass the relay's answer back to the canvas, with only the headers the preview passes on. */
  private relay(up: IncomingMessage, res: ServerResponse, method: string, finish: () => void): void {
    if (res.destroyed) {
      up.destroy();
      return finish();
    }
    const out: Array<[string, string]> = [];
    for (let i = 0; i + 1 < up.rawHeaders.length; i += 2) {
      const name = up.rawHeaders[i].toLowerCase();
      const value = up.rawHeaders[i + 1];
      if (value.length > MAX_HEADER_VALUE_LENGTH || !isPreviewHeaderValue(value)) continue;
      if (name === 'location' && !isPreviewLocation(value)) continue;
      if (isPreviewHeaderName(name, 'response') || RELAY_RESPONSE_HEADERS.has(name)) out.push([name, value]);
    }
    res.writeHead(up.statusCode ?? 502, out.flat());
    if (method === 'HEAD') {
      up.resume();
      res.end();
      return finish();
    }
    up.on('error', () => res.destroy());
    up.on('end', finish);
    up.pipe(res);
  }
}
