/** Fetching a record's picture, in the sync worker. */
import { lookup } from 'node:dns/promises';
import { AdapterError } from './registry';
import { isLocalAddress } from './protocol';
import type { ImageFetcher } from './run';

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Why the host of `address` is not one a picture is fetched from, by what its name resolves to: a name that leads to
 * this computer or the local network is refused as its address would be. (A name that resolves differently by the
 * time it is asked is not caught.)
 */
async function resolvesLocally(address: string): Promise<boolean> {
  const host = new URL(address).hostname.replace(/^\[|\]$/g, '');
  const found = await lookup(host, { all: true }).catch(() => [] as Array<{ address: string }>);
  return found.some((a) => isLocalAddress(a.address));
}

/**
 * A picture from the web, read no further than `maxBytes`. It is fetched without the source's credentials, so none
 * goes to another server; each address on the way, redirects included, is checked by `check` before it is asked.
 */
export const fetchImage: ImageFetcher = async (url, maxBytes, signal, check) => {
  let address = url;
  let res: Response | null = null;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const problem = check(address);
    if (problem) throw new AdapterError('image', problem);
    if (await resolvesLocally(address)) throw new AdapterError('image', 'a picture is on this computer or the local network, which a sync never reads');
    res = await fetch(address, { signal, redirect: 'manual', credentials: 'omit' }).catch(() => {
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
