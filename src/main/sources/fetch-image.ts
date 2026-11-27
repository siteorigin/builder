/** Fetching a record's picture, in the sync worker. */
import { lookup } from 'node:dns/promises';
import { AdapterError } from './registry';
import { isLocalAddress } from './protocol';
import type { ImageFetcher } from './run';

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** What a host name resolves to, as the system says: every address. */
export type Lookup = (host: string) => Promise<Array<{ address: string }>>;
export const systemLookup: Lookup = (host) => lookup(host, { all: true });

/**
 * A picture from the web, read no further than `maxBytes`. It is fetched without the source's credentials, so none
 * goes to another server; each address on the way, redirects included, is checked by `check` before it is asked, and
 * by what its name resolves to: a name that leads to this computer or the local network, or that cannot be found, is
 * refused. (A name that resolves differently by the time it is asked is not caught.)
 */
export const createFetchImage = (resolve: Lookup = systemLookup, platformFetch: typeof fetch = (input, init) => fetch(input, init)): ImageFetcher => async (url, maxBytes, signal, check) => {
  const resolvesLocally = async (address: string) => {
    const host = new URL(address).hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    const found = await resolve(host).catch(() => null);
    if (!found?.length) throw new AdapterError('network', 'a picture’s address could not be found');
    return found.some((a) => isLocalAddress(a.address));
  };
  let address = url;
  let res: Response | null = null;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const problem = check(address);
    if (problem) throw new AdapterError('image', problem);
    if (await resolvesLocally(address)) throw new AdapterError('image', 'a picture is on this computer or the local network, which a sync never reads');
    res = await platformFetch(address, { signal, redirect: 'manual', credentials: 'omit' }).catch(() => {
      throw new AdapterError('network');
    });
    const next = REDIRECTS.has(res.status) ? res.headers.get('location') : null;
    if (!next) break;
    await res.body?.cancel().catch(() => undefined);
    address = new URL(next, address).href;
    res = null;
  }
  if (!res) throw new AdapterError('image', 'a picture’s address redirects too often');
  const refuse = async (e: AdapterError) => {
    await res!.body?.cancel().catch(() => undefined);
    throw e;
  };
  if (!res.ok || !res.body) return refuse(new AdapterError('image', `a picture could not be loaded (${res.status})`));
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) return refuse(new AdapterError('too-large', 'its pictures are too large to sync'));
  const chunks: Uint8Array[] = [];
  let read = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AdapterError('too-large', 'its pictures are too large to sync');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(read);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, mime: res.headers.get('content-type') ?? '' };
};

/**
 * Why a picture's host is not one a sync fetches from, or null: a name that resolves to this computer or the local
 * network, or to nothing. What a sample checks without fetching, as a sync checks it before it asks.
 */
export const createHostCheck =
  (resolve: Lookup = systemLookup) =>
  async (url: string): Promise<string | null> => {
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    } catch {
      return 'a picture’s address cannot be read';
    }
    const found = await resolve(host).catch(() => null);
    if (!found?.length) return 'a picture’s address could not be found';
    return found.some((a) => isLocalAddress(a.address)) ? 'a picture is on this computer or the local network, which a sync never reads' : null;
  };

export const fetchImage = createFetchImage();
export const checkHost = createHostCheck();
