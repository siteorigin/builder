import { describe, expect, it } from 'vitest';
import { base64UrlByteLength, isPreviewHeaderName, isPreviewTarget, PreviewStream, type PreviewStreamFrame } from '@shared/live/preview';
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

  it('refuse a declared length too large to show', () => {
    expect(new PreviewStream('GET').accept(head([['content-length', String(MAX_PREVIEW_RESPONSE_BYTES + 1)]]))).toMatchObject({ ok: false, code: 'TOO_LARGE' });
    // A HEAD answer only describes the body; nothing is sent.
    expect(new PreviewStream('HEAD').accept(head([['content-length', String(MAX_PREVIEW_RESPONSE_BYTES + 1)]]))).toEqual({ ok: true, done: false });
  });

  it('carry no body for HEAD or bodyless statuses', () => {
    expect(run(new PreviewStream('HEAD'), [head([['content-length', '5000']]), end(0)]).at(-1)).toEqual({ ok: true, done: true });
    expect(run(new PreviewStream('HEAD'), [head(), chunkOf(1, 0)]).at(-1)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' });
    expect(run(new PreviewStream('GET'), [head([], 304), end(0)]).at(-1)).toEqual({ ok: true, done: true });
    expect(run(new PreviewStream('GET'), [head([], 204), chunkOf(1, 0)]).at(-1)).toMatchObject({ ok: false });
  });

  it('end on an abort, before the head or midway', () => {
    expect(new PreviewStream('GET').accept(abort)).toEqual({ ok: true, done: true });
    expect(run(new PreviewStream('GET'), [head(), chunkOf(1, 0), abort]).at(-1)).toEqual({ ok: true, done: true });
    expect(run(new PreviewStream('GET'), [abort, chunkOf(1, 0)]).at(-1)).toMatchObject({ ok: false });
  });
});

describe('preview targets and headers', () => {
  it('keeps requests within the preview', () => {
    for (const ok of ['/', '/about/', '/a/b.css?x=1&y=/z', '/%E2%82%AC/']) expect(isPreviewTarget(ok), ok).toBe(true);
    for (const bad of ['', 'a', '//x', '/..', '/a/../b', '/a/%2E%2e/b', '/./a', '/a%2Fb', '/a%5cb', '/a\\b', '/a#b', '/a\tb', '/%zz', 42]) expect(isPreviewTarget(bad), String(bad)).toBe(false);
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
