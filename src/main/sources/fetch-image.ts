/** Fetching a record's picture, in the sync worker. */
import { AdapterError } from './registry';
import type { ImageFetcher } from './run';

const MAX_REDIRECTS = 5;

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
    res = await fetch(address, { signal, redirect: 'manual', credentials: 'omit' }).catch(() => {
      throw new AdapterError('network');
    });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!next) break;
    await res.body?.cancel().catch(() => undefined);
    address = new URL(next, address).href;
    res = null;
  }
  if (!res) throw new AdapterError('image', 'a picture’s address redirects too often');
  if (!res.ok || !res.body) throw new AdapterError('image', `a picture could not be loaded (${res.status})`);
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new AdapterError('too-large', 'its pictures are too large to sync');
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
