/**
 * The Endpoints panel's test requests (#1481): one request at a time to the project's own preview server, the running
 * Vite dev server, so an endpoint answers as it does while the author previews the site, with the project's .env. Only
 * that server is ever asked, at an address in the site (never one of Vite's own); the request is the author's, with
 * the preview's own Origin, so SvelteKit takes a form it is sent as the site's own; and what comes back is bounded:
 * no redirect is followed, the body is cut at a limit, and the request is given up after a time limit or when called
 * off. Nothing here depends on Electron, so it is unit tested directly.
 */
import { isPreviewTarget } from '@shared/live/preview';
import { ENDPOINT_METHODS, type EndpointRequest, type EndpointResponse } from '@shared/endpoints';
import { LIVE_GUEST_HEADER } from '../../runtime/policy';

export type { EndpointRequest, EndpointResponse };

export const ENDPOINT_REQUEST_LIMITS = { timeoutMs: 30_000, maxResponseBytes: 1024 * 1024, maxRequestBytes: 1024 * 1024, maxHeaders: 40, maxHeaderBytes: 8 * 1024 };

/** First parts of an address that are Vite's or the project's files, never the site's: the tester asks none of them. */
const NOT_SITE = /^\/(?:@|node_modules(?:\/|$|\?)|src(?:\/|$|\?)|\.svelte-kit(?:\/|$|\?)|\.)/i;

/** Headers the request's own transport sets, or the app does: never the author's to send. */
const TRANSPORT_HEADERS = new Set(['host', 'origin', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect', 'te', 'trailer', 'proxy-authorization', 'proxy-connection', LIVE_GUEST_HEADER]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Why `req` cannot be sent, in the editor's words, or null when it can. */
export function endpointRequestProblem(req: EndpointRequest): string | null {
  if (!req || typeof req !== 'object') return 'Nothing to send.';
  if (!(ENDPOINT_METHODS as readonly string[]).includes(req.method)) return 'Choose a request method.';
  if (typeof req.path !== 'string' || !isPreviewTarget(req.path) || NOT_SITE.test(req.path)) return 'Enter an address in the site, starting with /, such as /api/search?q=chairs.';
  const headers = req.headers ?? [];
  if (!Array.isArray(headers) || headers.length > ENDPOINT_REQUEST_LIMITS.maxHeaders) return `A request can have at most ${ENDPOINT_REQUEST_LIMITS.maxHeaders} headers.`;
  let size = 0;
  for (const h of headers) {
    if (!Array.isArray(h) || h.length !== 2 || typeof h[0] !== 'string' || typeof h[1] !== 'string') return 'Each header needs a name and a value.';
    const [name, value] = h;
    if (!HEADER_NAME.test(name)) return `“${name.slice(0, 40)}” cannot be a header’s name.`;
    if (TRANSPORT_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('proxy-')) return `The ${name} header is set for the request: leave it out.`;
    if (!HEADER_VALUE.test(value)) return `The ${name} header’s value cannot have line breaks or control characters.`;
    size += name.length + value.length;
  }
  if (size > ENDPOINT_REQUEST_LIMITS.maxHeaderBytes) return 'The request’s headers are too long.';
  if (req.body !== undefined && typeof req.body !== 'string') return 'The body must be text.';
  if (req.body && (req.method === 'GET' || req.method === 'HEAD')) return `A ${req.method} request has no body: choose POST, PUT or PATCH to send one.`;
  if (req.body && Buffer.byteLength(req.body) > ENDPOINT_REQUEST_LIMITS.maxRequestBytes) return 'The body is too large to send from here (over 1 MB).';
  return null;
}

/** Read at most `max` bytes of `body`, then stop reading it. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = max - size;
      if (value.byteLength > room) {
        chunks.push(Buffer.from(value.subarray(0, room)));
        size = max;
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks, size), truncated };
}

/**
 * Send `req` to the preview server at `origin` (`http://127.0.0.1:<port>`), and say what came back. `signal` calls it
 * off (a newer request, the panel closed, the project closed); the time limit gives it up.
 */
export async function sendEndpointRequest(origin: string, req: EndpointRequest, opts: { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number } = {}): Promise<EndpointResponse> {
  const problem = endpointRequestProblem(req);
  if (problem) return { ok: false, message: problem };
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)) return { ok: false, message: 'The preview is not running, so there is nothing to send the request to.' };
  const now = opts.now ?? (() => performance.now());
  const signals = [AbortSignal.timeout(ENDPOINT_REQUEST_LIMITS.timeoutMs), ...(opts.signal ? [opts.signal] : [])];
  const signal = AbortSignal.any(signals);
  const headers = new Headers();
  for (const [name, value] of req.headers ?? []) headers.append(name, value);
  // The site's own address, as a page of the site sending a form has it: SvelteKit refuses a form from another site.
  headers.set('origin', origin);
  const started = now();
  try {
    const res = await (opts.fetch ?? fetch)(`${origin}${req.path}`, { method: req.method, headers, body: req.body && req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined, redirect: 'manual', signal, cache: 'no-store' });
    const { bytes, truncated } = req.method === 'HEAD' ? { bytes: Buffer.alloc(0), truncated: false } : await readCapped(res.body, ENDPOINT_REQUEST_LIMITS.maxResponseBytes);
    return { ok: true, status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body: bytes.toString('utf8'), truncated, ms: Math.max(0, Math.round(now() - started)) };
  } catch (e) {
    if (opts.signal?.aborted) return { ok: false, message: 'The request was stopped.' };
    if (signal.aborted) return { ok: false, message: `No answer came within ${ENDPOINT_REQUEST_LIMITS.timeoutMs / 1000} seconds, so the request was given up.` };
    return { ok: false, message: `The request could not be sent: ${e instanceof Error ? e.message : String(e)}` };
  }
}
