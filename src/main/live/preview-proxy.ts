import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { MAX_PREVIEW_HEADERS, MAX_PREVIEW_REQUESTS_IN_FLIGHT, MAX_PREVIEW_RESPONSE_BYTES, PREVIEW_CHUNK_BYTES } from '@shared/live/limits';
import type { Frame } from '@shared/live/messages';
import { isPreviewHeaderName, isPreviewHeaderValue, isPreviewLocation, isPreviewTarget, PREVIEW_METHODS, type PreviewAbortCode } from '@shared/live/preview';

/**
 * The host's end of the preview tunnel: a guest's preview request, passed on by the relay, is asked of the open
 * project's own preview server on loopback, and its answer goes back over the host's socket as a head, the body in
 * chunks, and an end. Only that one server is ever asked: the address is always 127.0.0.1 and the preview server's
 * port, never anything a frame names, and the path is the request's target exactly as the relay checked it, so a
 * guest cannot reach another host, another port or anything outside the preview. Each room's preview is its own
 * origin with the site at its root, so nothing in a response needs rewriting except a redirect's `Location`, which is
 * resolved against the target and kept only while it stays in the preview.
 */

export type PreviewRequestFrame = Frame<'relay-to-host', 'preview:request'>;
export type PreviewReplyFrame = Frame<'host-to-relay', 'preview:response-head' | 'preview:response-chunk' | 'preview:response-end' | 'preview:abort'>;

/** The loopback preview server to ask: always 127.0.0.1, on the open project's port. */
export interface LoopbackPreview {
  port: number;
}

/**
 * The preview server a DevServer status names (`http://127.0.0.1:<port>`), or null for anything else: another host,
 * another scheme, credentials, a path. Nothing but that loopback address is ever asked for the preview.
 */
export function loopbackPreview(url: string | null | undefined): LoopbackPreview | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  const port = Number(u.port);
  return Number.isInteger(port) && port > 0 && port < 65536 ? { port } : null;
}

export interface PreviewProxyOptions {
  /** Send a frame to the relay; false when the host's socket is gone. */
  send(frame: PreviewReplyFrame): boolean;
  /** The open project's preview server, or null while none is ready. */
  preview(): LoopbackPreview | null;
  /** Bytes waiting to go out on the host's socket. A response pauses while there are too many. */
  buffered(): number;
}

/** The most preview requests the host serves at once, for all guests: each guest may have its own share in flight. */
export const MAX_PROXY_REQUESTS = 64;
/** A response pauses reading from the preview server while this much is waiting on the socket, until it drains below LOW. */
export const SOCKET_HIGH_WATER_BYTES = 4 * PREVIEW_CHUNK_BYTES;
export const SOCKET_LOW_WATER_BYTES = PREVIEW_CHUNK_BYTES;
/** How long the preview server may go without sending anything before the request is given up. */
export const UPSTREAM_IDLE_MS = 60_000;
const DRAIN_POLL_MS = 20;

/** Statuses that never carry a body. */
const BODYLESS = new Set([204, 205, 304]);

interface Pending {
  requestId: string;
  guestId: string;
  req: ClientRequest | null;
  res: IncomingMessage | null;
  drain: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

/**
 * Where a redirect from the preview server goes, as the guest's browser should be sent there: resolved against the
 * request's target as a browser would, and kept only when it names a place on the same preview server (which is the
 * site at the root of the room's preview origin). Null for anything else: another host or port, another scheme, or a
 * path the preview may not be asked for.
 */
export function previewRedirect(location: string, target: string, port: number): string | null {
  const origin = `http://127.0.0.1:${port}`;
  let url: URL;
  try {
    url = new URL(location, new URL(target, origin));
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return isPreviewLocation(path) ? path : null;
}

/**
 * The response headers that may go back to the guest: those the protocol passes on, with values it accepts, a single
 * length, and the redirect resolved (previewRedirect). Cookies, the preview server's caching policy, its security
 * headers and anything naming the host's machine are never among them.
 */
export function previewResponseHeaders(raw: readonly string[], target: string, port: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let length: string | null = null;
  let location = false;
  for (let i = 0; i + 1 < raw.length && out.length < MAX_PREVIEW_HEADERS; i += 2) {
    const name = raw[i].toLowerCase();
    let value = raw[i + 1];
    if (!isPreviewHeaderName(name, 'response')) continue;
    if (name === 'content-length') {
      // One length only, and only one that is a length: Node's parser already refused a response that disagrees with itself.
      if (length !== null || !/^\d{1,15}$/.test(value)) continue;
      length = value;
    }
    if (name === 'location') {
      if (location) continue;
      const resolved = previewRedirect(value, target, port);
      if (resolved === null) continue;
      value = resolved;
      location = true;
    }
    if (!isPreviewHeaderValue(value)) continue;
    out.push([name, value]);
  }
  return out;
}

export class PreviewProxy {
  private readonly pending = new Map<string, Pending>();
  /** Connections to the preview server, kept alive between requests and closed with the proxy. */
  private agent = new Agent({ keepAlive: true, maxSockets: MAX_PROXY_REQUESTS });

  constructor(private readonly options: PreviewProxyOptions) {}

  /** How many requests are being answered now. */
  get size(): number {
    return this.pending.size;
  }

  /** Answer one guest preview request the relay passed on. */
  handle(frame: PreviewRequestFrame): void {
    const { requestId, guestId } = frame;
    // A request already being answered keeps its answer; the relay never reuses an ID while one is open.
    if (this.pending.has(requestId)) return;
    const preview = this.options.preview();
    if (!preview) return void this.options.send({ type: 'preview:abort', requestId, code: 'UNAVAILABLE' });
    let guestCount = 0;
    for (const p of this.pending.values()) if (p.guestId === guestId) guestCount++;
    if (this.pending.size >= MAX_PROXY_REQUESTS || guestCount >= MAX_PREVIEW_REQUESTS_IN_FLIGHT) return void this.options.send({ type: 'preview:abort', requestId, code: 'UNAVAILABLE' });
    // The relay has checked all of this already; the host checks again, since only it knows what it would reach.
    if (!(PREVIEW_METHODS as readonly string[]).includes(frame.method) || !isPreviewTarget(frame.target)) return this.refuse(requestId);

    const headers: Record<string, string> = {};
    for (const [rawName, value] of frame.headers) {
      const name = rawName.toLowerCase();
      if (!isPreviewHeaderName(name, 'request') || !isPreviewHeaderValue(value)) continue;
      headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
    }
    // The body goes to the guest as it is, and the protocol passes no Content-Encoding, so it must not be compressed.
    headers['accept-encoding'] = 'identity';
    // The preview server is asked as the editor asks it: the guest's host name never reaches it.
    headers.host = `127.0.0.1:${preview.port}`;

    const pending: Pending = { requestId, guestId, req: null, res: null, drain: null, done: false };
    this.pending.set(requestId, pending);
    const req = httpRequest({ host: '127.0.0.1', port: preview.port, method: frame.method, path: frame.target, headers, agent: this.agent, setHost: false });
    pending.req = req;
    req.setTimeout(UPSTREAM_IDLE_MS, () => this.fail(pending, 'TIMEOUT'));
    req.on('error', () => this.fail(pending, 'UNAVAILABLE'));
    req.on('response', (res) => this.respond(pending, frame, preview.port, res));
    req.end();
  }

  /** The relay stopped a request: the guest went away, timed out, or its access ended. Nothing more is sent for it. */
  abort(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (pending) this.finish(pending);
  }

  /** Stop every request: the socket they answer on has gone, or the session ended. */
  abortAll(): void {
    for (const pending of [...this.pending.values()]) this.finish(pending);
  }

  /** Stop everything and close the connections to the preview server. */
  dispose(): void {
    this.abortAll();
    this.agent.destroy();
    this.agent = new Agent({ keepAlive: true, maxSockets: MAX_PROXY_REQUESTS });
  }

  /** A request the host will not pass on: answered as not found, with nothing asked of the preview server. */
  private refuse(requestId: string): void {
    const body = Buffer.from('Not found.');
    if (!this.options.send({ type: 'preview:response-head', requestId, status: 404, headers: [['content-type', 'text/plain; charset=utf-8']] })) return;
    if (!this.options.send({ type: 'preview:response-chunk', requestId, seq: 0, data: body.toString('base64url') })) return;
    this.options.send({ type: 'preview:response-end', requestId, totalBytes: body.length });
  }

  private respond(pending: Pending, frame: PreviewRequestFrame, port: number, res: IncomingMessage): void {
    if (pending.done) return void res.destroy();
    pending.res = res;
    const { requestId } = pending;
    const status = res.statusCode ?? 0;
    if (status < 200 || status > 599) return this.fail(pending, 'INVALID_RESPONSE');
    const headers = previewResponseHeaders(res.rawHeaders, frame.target, port);
    const bodyless = frame.method === 'HEAD' || BODYLESS.has(status);
    const declared = headers.find(([name]) => name === 'content-length')?.[1];
    if (!bodyless && declared !== undefined && Number(declared) > MAX_PREVIEW_RESPONSE_BYTES) return this.fail(pending, 'TOO_LARGE');
    if (!this.send(pending, { type: 'preview:response-head', requestId, status, headers })) return;
    if (bodyless) {
      res.resume();
      if (this.send(pending, { type: 'preview:response-end', requestId, totalBytes: 0 })) this.finish(pending, true);
      return;
    }

    let seq = 0;
    let total = 0;
    let held: Buffer[] = [];
    let heldBytes = 0;
    const flush = (all: boolean): boolean => {
      while (heldBytes >= PREVIEW_CHUNK_BYTES || (all && heldBytes > 0)) {
        const joined = held.length === 1 ? held[0] : Buffer.concat(held, heldBytes);
        const chunk = joined.subarray(0, PREVIEW_CHUNK_BYTES);
        const rest = joined.subarray(chunk.length);
        held = rest.length ? [rest] : [];
        heldBytes = rest.length;
        if (!this.send(pending, { type: 'preview:response-chunk', requestId, seq: seq++, data: chunk.toString('base64url') })) return false;
      }
      return true;
    };
    res.on('data', (data: Buffer) => {
      if (pending.done) return;
      total += data.length;
      if (total > MAX_PREVIEW_RESPONSE_BYTES) return this.fail(pending, 'TOO_LARGE');
      held.push(data);
      heldBytes += data.length;
      if (!flush(false)) return;
      if (this.options.buffered() > SOCKET_HIGH_WATER_BYTES) this.waitForDrain(pending, res);
    });
    res.on('end', () => {
      if (pending.done) return;
      if (!flush(true)) return;
      if (this.send(pending, { type: 'preview:response-end', requestId, totalBytes: total })) this.finish(pending, true);
    });
    // A response that stops before its end (the preview server failed or restarted) is stopped for the guest too.
    res.on('error', () => this.fail(pending, 'UNAVAILABLE'));
    res.on('close', () => {
      if (!res.complete) this.fail(pending, 'UNAVAILABLE');
    });
  }

  /** Stop reading from the preview server until the socket has sent most of what is waiting. */
  private waitForDrain(pending: Pending, res: IncomingMessage): void {
    if (pending.drain || pending.done) return;
    res.pause();
    const check = () => {
      pending.drain = null;
      if (pending.done) return;
      if (this.options.buffered() > SOCKET_LOW_WATER_BYTES) {
        pending.drain = setTimeout(check, DRAIN_POLL_MS);
        return;
      }
      res.resume();
    };
    pending.drain = setTimeout(check, DRAIN_POLL_MS);
  }

  /** Send a frame for a request still open; a socket that has gone ends the request. */
  private send(pending: Pending, frame: PreviewReplyFrame): boolean {
    if (pending.done) return false;
    if (this.options.send(frame)) return true;
    this.finish(pending);
    return false;
  }

  /** End a request that cannot be answered: the relay is told why, and the preview server is asked no more. */
  private fail(pending: Pending, code: PreviewAbortCode): void {
    if (pending.done) return;
    this.finish(pending);
    this.options.send({ type: 'preview:abort', requestId: pending.requestId, code });
  }

  /**
   * Let a request go. One that did not reach its end drops whatever is still being read from the preview server; a
   * complete one leaves its connection to be used again.
   */
  private finish(pending: Pending, complete = false): void {
    if (pending.done) return;
    pending.done = true;
    if (pending.drain) clearTimeout(pending.drain);
    pending.drain = null;
    this.pending.delete(pending.requestId);
    if (complete) return;
    pending.res?.destroy();
    pending.req?.destroy();
  }
}
