import { describe, expect, it } from 'vitest';
import { base64UrlByteLength, isPreviewHeaderName, isPreviewHeaderValue, isPreviewLocation, isPreviewTarget, previewBrowserLocation, PreviewStream, PREVIEW_CACHE_CONTROL, type PreviewStreamFrame } from '@shared/live/preview';
import { toBase64Url } from '@shared/live/crypto';
import { MAX_PREVIEW_RESPONSE_BYTES, PREVIEW_CHUNK_BYTES } from '@shared/live/limits';

const head = (headers: Array<[string, string]> = [], status = 200): PreviewStreamFrame => ({ type: 'preview:response-head', status, headers });
const chunkOf = (bytes: number, seq: number): PreviewStreamFrame => ({ type: 'preview:response-chunk', seq, data: toBase64Url(new Uint8Array(bytes)) });
const end = (totalBytes: number): PreviewStreamFrame => ({ type: 'preview:response-end', totalBytes });
const abort: PreviewStreamFrame = { type: 'preview:abort', code: 'CANCELLED' };
const FULL_CHUNK = toBase64Url(new Uint8Array(PREVIEW_CHUNK_BYTES));

function run(stream: PreviewStream, frames: PreviewStreamFrame[]) {
  return frames.map((f) => stream.accept(f));
}

describe('preview response streams', () => {
  it('accept one head, numbered chunks and an end that counts them', () => {
    const steps = run(new PreviewStream('GET'), [head([['content-type', 'image/png']]), chunkOf(PREVIEW_CHUNK_BYTES, 0), chunkOf(10, 1), end(PREVIEW_CHUNK_BYTES + 10)]);
    expect(steps).toEqual([{ ok: true, done: false }, { ok: true, done: false }, { ok: true, done: false }, { ok: true, done: true }]);
  });

  it('accept an empty body, and a declared length that is met', () => {
    expect(run(new PreviewStream('GET'), [head(), end(0)]).at(-1)).toEqual({ ok: true, done: true });
    expect(run(new PreviewStream('GET'), [head([['content-length', '3']]), chunkOf(3, 0), end(3)]).at(-1)).toEqual({ ok: true, done: true });
  });

  it('refuse frames out of order', () => {
    expect(new PreviewStream('GET').accept(chunkOf(1, 0))).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    expect(new PreviewStream('GET').accept(end(0))).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    expect(run(new PreviewStream('GET'), [head(), head()]).at(-1)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    expect(run(new PreviewStream('GET'), [head(), chunkOf(1, 1)]).at(-1)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    expect(run(new PreviewStream('GET'), [head(), chunkOf(1, 0), chunkOf(1, 0)]).at(-1)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    // Nothing follows an end, or a refusal.
    expect(run(new PreviewStream('GET'), [head(), end(0), chunkOf(1, 0)]).at(-1)).toMatchObject({ ok: false });
    expect(run(new PreviewStream('GET'), [chunkOf(1, 0), head()]).at(-1)).toMatchObject({ ok: false });
  });

  it('refuse an end that does not match what arrived or what the head declared', () => {
    expect(run(new PreviewStream('GET'), [head(), chunkOf(5, 0), end(4)]).at(-1)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    expect(run(new PreviewStream('GET'), [head([['content-length', '10']]), chunkOf(5, 0), end(5)]).at(-1)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    expect(run(new PreviewStream('GET'), [head([['content-length', '10']]), chunkOf(11, 0)]).at(-1)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    expect(new PreviewStream('GET').accept(head([['content-length', '-1']]))).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
  });

  it('count the bytes as they arrive, whatever the head said', () => {
    const stream = new PreviewStream('GET');
    expect(stream.accept(head())).toEqual({ ok: true, done: false });
    const limit = MAX_PREVIEW_RESPONSE_BYTES / PREVIEW_CHUNK_BYTES;
    for (let seq = 0; seq < limit; seq++) expect(stream.accept({ type: 'preview:response-chunk', seq, data: FULL_CHUNK }).ok).toBe(true);
    expect(stream.received).toBe(MAX_PREVIEW_RESPONSE_BYTES);
    expect(stream.accept({ type: 'preview:response-chunk', seq: limit, data: toBase64Url(new Uint8Array(1)) })).toMatchObject({ ok: false, code: 'TOO_LARGE' });
  });

  it('refuse a head that gives its length twice', () => {
    expect(new PreviewStream('GET').accept(head([['content-length', '0'], ['content-length', '1']]))).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    expect(new PreviewStream('GET').accept(head([['content-length', '1'], ['content-length', '1']]))).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
  });

  it('hold a range response to the length of the range sent', () => {
    expect(run(new PreviewStream('GET'), [head([['content-range', 'bytes 0-99/5000'], ['content-length', '100']], 206), chunkOf(100, 0), end(100)]).at(-1)).toEqual({ ok: true, done: true });
    expect(run(new PreviewStream('GET'), [head([['content-range', 'bytes 0-99/5000'], ['content-length', '100']], 206), chunkOf(99, 0), end(99)]).at(-1)).toMatchObject({ ok: false });
  });

  it('refuse a declared length too large to show', () => {
    expect(new PreviewStream('GET').accept(head([['content-length', String(MAX_PREVIEW_RESPONSE_BYTES + 1)]]))).toMatchObject({ ok: false, code: 'TOO_LARGE' });
    // A HEAD answer only describes the body; nothing is sent.
    expect(new PreviewStream('HEAD').accept(head([['content-length', String(MAX_PREVIEW_RESPONSE_BYTES + 1)]]))).toEqual({ ok: true, done: false });
  });

  it('carry no body for HEAD or bodyless statuses, whatever length they describe', () => {
    expect(run(new PreviewStream('HEAD'), [head([['content-length', '5000']]), end(0)]).at(-1)).toEqual({ ok: true, done: true });
    // A 304 describes the cached body, which may be larger than any response could carry.
    expect(run(new PreviewStream('GET'), [head([['content-length', String(MAX_PREVIEW_RESPONSE_BYTES + 1)]], 304), end(0)]).at(-1)).toEqual({ ok: true, done: true });
    expect(run(new PreviewStream('GET'), [head([['content-length', '123']], 204), end(0)]).at(-1)).toEqual({ ok: true, done: true });
    expect(run(new PreviewStream('HEAD'), [head(), chunkOf(1, 0)]).at(-1)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    expect(run(new PreviewStream('GET'), [head([], 304), end(0)]).at(-1)).toEqual({ ok: true, done: true });
    for (const status of [204, 205, 304]) expect(run(new PreviewStream('GET'), [head([], status), chunkOf(1, 0)]).at(-1), String(status)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    // A 304 that describes its cached body still sends none.
    expect(run(new PreviewStream('GET'), [head([['content-length', '40']], 304), end(0)]).at(-1)).toEqual({ ok: true, done: true });
  });

  it('end on an abort, before the head or midway', () => {
    expect(new PreviewStream('GET').accept(abort)).toEqual({ ok: true, done: true });
    expect(run(new PreviewStream('GET'), [head(), chunkOf(1, 0), abort]).at(-1)).toEqual({ ok: true, done: true });
    expect(run(new PreviewStream('GET'), [abort, chunkOf(1, 0)]).at(-1)).toMatchObject({ ok: false });
    expect(run(new PreviewStream('GET'), [head(), end(0), abort]).at(-1)).toMatchObject({ ok: false });
    expect(run(new PreviewStream('GET'), [head(), chunkOf(1, 0), abort, chunkOf(1, 1)]).at(-1)).toMatchObject({ ok: false });
  });
});

describe('preview targets and headers', () => {
  it('keeps requests within the preview', () => {
    for (const ok of ['/', '/about/', '/a/b.css?x=1&y=/z', '/%E2%82%AC/']) expect(isPreviewTarget(ok), ok).toBe(true);
    for (const bad of ['', 'a', '//x', '/..', '/a/../b', '/a/%2E%2e/b', '/./a', '/a%2Fb', '/a%5cb', '/a\\b', '/a#b', '/a\tb', '/%zz', 42]) expect(isPreviewTarget(bad), String(bad)).toBe(false);
  });

  it('keeps clear of the development server’s own routes', () => {
    for (const bad of ['/__open-in-editor', '/__open-in-editor?file=src/app.html', '/%5f%5fopen-in-editor', '/__vite_ping', '/__inspect/', '/__brand.svg'])
      expect(isPreviewTarget(bad), bad).toBe(false);
    // Under a project's own base, the routes that act on the host are still refused.
    for (const bad of ['/site/__open-in-editor?file=x', '/a/b/__inspect/']) expect(isPreviewTarget(bad), bad).toBe(false);
    // SvelteKit's page data, Vite's client modules and pages with underscores stay reachable.
    for (const ok of ['/__data.json', '/about/__data.json', '/_app/version.json', '/@vite/client', '/@id/__x00__virtual:x.js', '/node_modules/.vite/deps/svelte.js?v=1', '/a/__notes/'])
      expect(isPreviewTarget(ok), ok).toBe(true);
  });

  it('sends a redirect to the same place under the room’s preview, fragment and all', () => {
    expect(isPreviewLocation('/about/#team')).toBe(true);
    expect(previewBrowserLocation('/s/abcdefghijkmnpqrstuvwxyz/preview', '/about/#team')).toBe('/s/abcdefghijkmnpqrstuvwxyz/preview/about/#team');
    expect(previewBrowserLocation('/s/abcdefghijkmnpqrstuvwxyz/preview/', '/')).toBe('/s/abcdefghijkmnpqrstuvwxyz/preview/');
    for (const bad of ['//evil.example/', 'https://evil.example/', '/a#b#c', '/a#b c', '/__open-in-editor#x']) {
      expect(isPreviewLocation(bad), bad).toBe(false);
      expect(previewBrowserLocation('/s/abcdefghijkmnpqrstuvwxyz/preview', bad)).toBeNull();
    }
  });

  it('keeps preview responses out of shared caches', () => {
    expect(PREVIEW_CACHE_CONTROL).toBe('private, no-cache');
    expect(isPreviewHeaderName('cache-control', 'response')).toBe(false);
  });

  it('passes on only values HTTP can carry', () => {
    expect(isPreviewHeaderValue('text/html,\tapplication/xhtml+xml;q=0.9')).toBe(true);
    expect(isPreviewHeaderValue('caf\u00e9')).toBe(true);
    for (const bad of ['a\r\nb', 'a\u0000', 'a\u0001', 'a\u007f', '\u2603', 'x'.repeat(4097)]) expect(isPreviewHeaderValue(bad), JSON.stringify(bad.slice(0, 8))).toBe(false);
  });

  it('allows only lowercase, listed header names', () => {
    expect(isPreviewHeaderName('range', 'request')).toBe(true);
    expect(isPreviewHeaderName('content-type', 'response')).toBe(true);
    expect(isPreviewHeaderName('content-type', 'request')).toBe(false);
    expect(isPreviewHeaderName('Range', 'request')).toBe(false);
    for (const name of ['cookie', 'authorization', 'proxy-authorization', 'x-forwarded-for', 'cf-connecting-ip']) expect(isPreviewHeaderName(name, 'request'), name).toBe(false);
    for (const name of ['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'access-control-allow-origin']) expect(isPreviewHeaderName(name, 'response'), name).toBe(false);
  });

  it('counts bytes from unpadded base64url length', () => {
    for (const n of [0, 1, 2, 3, 4, 255, PREVIEW_CHUNK_BYTES]) expect(base64UrlByteLength(toBase64Url(new Uint8Array(n)))).toBe(n);
  });
});
