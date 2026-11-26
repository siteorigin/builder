/** Fetching a record's picture, in the sync worker. */
import { AdapterError } from './registry';
import type { ImageFetcher } from './run';

/**
 * A picture from the web, read no further than `maxBytes`. It is fetched without the source's credentials, so they
 * never go to another server, whatever address a record gives or a redirect leads to.
 */
export const fetchImage: ImageFetcher = async (url, maxBytes, signal) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new AdapterError('image', 'a picture is not at a web address');
  const res = await fetch(u, { signal, redirect: 'follow', credentials: 'omit' }).catch(() => {
    throw new AdapterError('network');
  });
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
