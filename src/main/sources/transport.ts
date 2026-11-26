/**
 * How a kind of source asks its server, in the sync worker: with the platform's own fetch, at one origin only (the one
 * its settings name), so the credentials it sends never reach another server, by a redirect, a next page's address or
 * a converter's request. Every reply is read no further than a sync can bring, and answers in fixed reasons.
 */
import { AdapterError } from './registry';
import { MAX_RECORDS_BYTES } from './protocol';

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** The most requests one sync makes: a source with more pages than this is too large to sync. */
export const MAX_REQUESTS = 1000;
/** The most one reply may be, and all of them together. */
const MAX_REPLY_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * MAX_RECORDS_BYTES;

export interface JsonReply {
  body: unknown;
  headers: Headers;
  /** The address it was read at, after any redirect. */
  url: string;
}

export interface RequestInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

/** A source's server, as its reader asks it. */
export interface Transport {
  readonly origin: string;
  json(url: string, init?: RequestInit): Promise<JsonReply>;
}

/** The platform's fetch, or a stand-in in tests. */
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: 'manual'; signal: AbortSignal; credentials: 'omit' }) => Promise<Response>;

/** Why `url` is not one the transport asks, or null: the origin its source names, with nobody signed in by the address. */
function addressProblem(url: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'an address it was given cannot be read';
  }
  if (u.username || u.password) return 'an address it was given signs in';
  if (u.origin !== origin) return 'it was sent to another server, which a sync never asks';
  return null;
}

async function readCapped(res: Response, max: number): Promise<string> {
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new AdapterError('too-large', 'a reply is too large to sync');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > max) {
        await reader.cancel().catch(() => undefined);
        throw new AdapterError('too-large', 'a reply is too large to sync');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A reply's status as a fixed reason. */
function statusError(status: number): AdapterError {
  if (status === 401 || status === 403) return new AdapterError('auth', `the server answered ${status}`);
  if (status === 404) return Object.assign(new AdapterError('failed', 'the server has nothing at that address (404)'), { status });
  if (status === 429 || status >= 500) return new AdapterError('network', `the server answered ${status}; try again later`);
  return new AdapterError('failed', `the server answered ${status}`);
}

/** A transport to `origin` (as `new URL(...).origin` writes it). */
export function createTransport(origin: string, signal: AbortSignal, doFetch: Fetch = fetch as unknown as Fetch): Transport {
  let requests = 0;
  let total = 0;
  // One request at a time (a converter may ask several at once), so what they bring together is counted as it comes.
  let queue: Promise<unknown> = Promise.resolve();
  const ask = async (url: string, init: RequestInit): Promise<JsonReply> => {
    let address = url;
    let res: Response | null = null;
    let method = init.method ?? 'GET';
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      const problem = addressProblem(address, origin);
      if (problem) throw new AdapterError('failed', problem);
      if (++requests > MAX_REQUESTS) throw new AdapterError('too-large', `it needs more than ${MAX_REQUESTS} requests to read`);
      if (signal.aborted) throw new AdapterError('failed', 'the sync was stopped');
      // As browsers do: a redirect "see other", or an old-style one of a POST, asks the next address with GET.
      if (res && (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST'))) method = 'GET';
      const headers: Record<string, string> = { accept: 'application/json', ...(init.headers ?? {}) };
      if (method === 'POST' && init.body !== undefined) headers['content-type'] ??= 'application/json';
      res = await doFetch(address, { method, headers, ...(method === 'POST' && init.body !== undefined ? { body: init.body } : {}), redirect: 'manual', signal, credentials: 'omit' }).catch(() => {
        throw new AdapterError('network');
      });
      const next = REDIRECTS.has(res.status) ? res.headers.get('location') : null;
      if (!next) break;
      await res.body?.cancel().catch(() => undefined);
      try {
        address = new URL(next, address).href;
      } catch {
        throw new AdapterError('failed', 'the server redirected to an address that cannot be read');
      }
    }
    if (!res || REDIRECTS.has(res.status)) throw new AdapterError('failed', 'the server redirects too often');
    // A part of a reply is never the whole of one.
    if (!res.ok || res.status === 206) {
      await res.body?.cancel().catch(() => undefined);
      throw res.status === 206 ? new AdapterError('failed', 'the server sent only part of a reply') : statusError(res.status);
    }
    const text = await readCapped(res, Math.min(MAX_REPLY_BYTES, MAX_TOTAL_BYTES - total));
    total += Buffer.byteLength(text);
    try {
      return { body: JSON.parse(text) as unknown, headers: res.headers, url: address };
    } catch {
      throw new AdapterError('invalid', 'the server did not answer with JSON');
    }
  };
  return {
    origin,
    json(url, init = {}) {
      const next = queue.then(() => ask(url, init));
      queue = next.catch(() => undefined);
      return next;
    }
  };
}
