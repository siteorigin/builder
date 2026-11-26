import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../../src/shared/live/crypto';
import type { Frame } from '../../src/shared/live/messages';
import { PREVIEW_CACHE_CONTROL } from '../../src/shared/live/preview';
import { HELD_CHUNK_OVERHEAD_BYTES, MAX_UNREAD_BYTES_PER_RESPONSE, PreviewTunnel } from '../../relay/src/preview-tunnel';

/**
 * The relay's preview tunnel on its own, with the host played directly: what each request holds, when it lets go, and
 * how its body ends, at the points a browser over a real connection cannot be made to stop.
 */

const ROOM = 'abcdefghijkmnpqrstuvwxyz';
const IDLE_MS = 150;
type ToHost = Frame<'relay-to-host', 'preview:request' | 'preview:abort'>;

function tunnelWithHost() {
  const sent: ToHost[] = [];
  const tunnel = new PreviewTunnel({ sendToHost: (_connection, frame) => (sent.push(frame), true), headTimeoutMs: IDLE_MS, idleTimeoutMs: IDLE_MS });
  const open = (guestId = 'ann', method: 'GET' | 'HEAD' = 'GET', signal: AbortSignal | null = null) => {
    const response = tunnel.open({ roomId: ROOM, guestId, hostConnectionId: 'host-1', method, target: '/', headers: [], signal });
    const request = sent.at(-1) as Frame<'relay-to-host', 'preview:request'>;
    return { response, requestId: request.requestId };
  };
  const host = (frame: Frame<'host-to-relay', 'preview:response-head' | 'preview:response-chunk' | 'preview:response-end' | 'preview:abort'>, connection = 'host-1') => tunnel.acceptHostFrame(connection, frame);
  const head = (requestId: string, status = 200, headers: Array<[string, string]> = [['content-type', 'text/html']]) => host({ type: 'preview:response-head', requestId, status, headers });
  const chunk = (requestId: string, seq: number, bytes: Uint8Array) => host({ type: 'preview:response-chunk', requestId, seq, data: toBase64Url(bytes) });
  const end = (requestId: string, totalBytes: number) => host({ type: 'preview:response-end', requestId, totalBytes });
  const aborts = () => sent.filter((frame): frame is Frame<'relay-to-host', 'preview:abort'> => frame.type === 'preview:abort');
  return { tunnel, open, host, head, chunk, end, aborts };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (n: number) => new Uint8Array(n).fill(7);

describe('bodies', () => {
  it('answers HEAD and bodyless statuses with no body, and passes on only the headers a guest may see', async () => {
    const t = tunnelWithHost();
    const headReq = t.open('ann', 'HEAD');
    t.head(headReq.requestId, 200, [['content-type', 'text/html'], ['content-length', '5120'], ['etag', '"x"']]);
    const response = await headReq.response;
    expect(response.body).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('etag')).toBe('"x"');
    expect(response.headers.get('cache-control')).toBe(PREVIEW_CACHE_CONTROL);
    // Its slot is held until the host's end arrives.
    expect(t.tunnel.inFlight('ann')).toBe(1);
    t.end(headReq.requestId, 0);
    expect(t.tunnel.inFlight('ann')).toBe(0);

    const moved = t.open();
    t.head(moved.requestId, 304, [['location', '/next/#top']]);
    const notModified = await moved.response;
    expect(notModified.body).toBeNull();
    expect(notModified.headers.get('location')).toBe(`/s/${ROOM}/preview/next/#top`);
  });

  it('lets a response go as soon as the host ends it with nothing left to read', async () => {
    const t = tunnelWithHost();
    const empty = t.open();
    t.head(empty.requestId);
    await empty.response;
    t.end(empty.requestId, 0);
    expect(t.tunnel.inFlight('ann')).toBe(0);
  });

  it('holds what is unread, with each chunk’s overhead, and lets it go as the guest reads it', async () => {
    const t = tunnelWithHost();
    const req = t.open();
    t.head(req.requestId);
    t.chunk(req.requestId, 0, bytes(100));
    t.chunk(req.requestId, 1, bytes(50));
    t.end(req.requestId, 150);
    expect(t.tunnel.heldBytes).toBe(150 + 2 * HELD_CHUNK_OVERHEAD_BYTES);
    const body = new Uint8Array(await (await req.response).arrayBuffer());
    expect(body.byteLength).toBe(150);
    expect(t.tunnel.heldBytes).toBe(0);
    expect(t.tunnel.inFlight('ann')).toBe(0);
  });

  it('ends the body as soon as its last chunk is read, with no further read', async () => {
    const t = tunnelWithHost();
    const req = t.open();
    t.head(req.requestId);
    t.chunk(req.requestId, 0, bytes(10));
    t.end(req.requestId, 10);
    const reader = (await req.response).body!.getReader();
    expect((await reader.read()).value!.byteLength).toBe(10);
    await reader.closed;
    expect(t.tunnel.inFlight('ann')).toBe(0);
  });

  it('lets an ended body that is never read go after the idle deadline, slot and bytes', async () => {
    const t = tunnelWithHost();
    const req = t.open();
    t.head(req.requestId);
    t.chunk(req.requestId, 0, bytes(1000));
    t.end(req.requestId, 1000);
    const response = await req.response;
    expect(t.tunnel.inFlight('ann')).toBe(1);
    await wait(IDLE_MS * 2);
    expect(t.tunnel.inFlight('ann')).toBe(0);
    expect(t.tunnel.heldBytes).toBe(0);
    await expect(response.arrayBuffer()).rejects.toThrow();
    // The host had already finished; it is not told to stop.
    expect(t.aborts()).toEqual([]);
  });

  it('fails a body between reads, so a reader waiting on it is told at once', async () => {
    const t = tunnelWithHost();
    const req = t.open();
    t.head(req.requestId);
    t.chunk(req.requestId, 0, bytes(10));
    const reader = (await req.response).body!.getReader();
    expect((await reader.read()).value!.byteLength).toBe(10);
    t.tunnel.abortGuest('ann');
    await expect(reader.closed).rejects.toThrow();
    expect(t.aborts()).toEqual([{ type: 'preview:abort', requestId: req.requestId, code: 'CANCELLED' }]);
    expect(t.tunnel.heldBytes).toBe(0);
  });

  it('stops a response that holds too much unread, counting many small chunks by their overhead', async () => {
    const t = tunnelWithHost();
    const req = t.open();
    t.head(req.requestId);
    const response = await req.response;
    const limit = Math.floor(MAX_UNREAD_BYTES_PER_RESPONSE / (1 + HELD_CHUNK_OVERHEAD_BYTES));
    for (let seq = 0; seq <= limit && t.aborts().length === 0; seq++) t.chunk(req.requestId, seq, bytes(1));
    expect(t.aborts()).toEqual([{ type: 'preview:abort', requestId: req.requestId, code: 'UNAVAILABLE' }]);
    expect(t.tunnel.heldBytes).toBe(0);
    expect(t.tunnel.inFlight('ann')).toBe(0);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
});

describe('ending requests', () => {
  it('answers the host’s own aborts with the matching status', async () => {
    const t = tunnelWithHost();
    const statuses: Record<string, number> = {};
    for (const code of ['TIMEOUT', 'UNAVAILABLE', 'TOO_LARGE'] as const) {
      const req = t.open();
      t.host({ type: 'preview:abort', requestId: req.requestId, code });
      statuses[code] = (await req.response).status;
    }
    expect(statuses).toEqual({ TIMEOUT: 504, UNAVAILABLE: 503, TOO_LARGE: 502 });
    expect(t.aborts()).toEqual([]);
  });

  it('fails a body whose end does not match what arrived, and tells the host why', async () => {
    const t = tunnelWithHost();
    const req = t.open();
    t.head(req.requestId);
    t.chunk(req.requestId, 0, bytes(10));
    const response = await req.response;
    t.end(req.requestId, 11);
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(t.aborts()).toEqual([{ type: 'preview:abort', requestId: req.requestId, code: 'INVALID_RESPONSE' }]);
  });

  it('times out a head that never comes, and tells the host', async () => {
    const t = tunnelWithHost();
    const req = t.open();
    expect((await req.response).status).toBe(504);
    expect(t.aborts()).toEqual([{ type: 'preview:abort', requestId: req.requestId, code: 'TIMEOUT' }]);
  });

  it('stops one guest’s requests without touching another’s', async () => {
    const t = tunnelWithHost();
    const ann = [t.open('ann'), t.open('ann')];
    const bea = t.open('bea');
    expect(t.tunnel.inFlight('ann')).toBe(2);
    expect(t.tunnel.inFlight('bea')).toBe(1);
    t.head(ann[0].requestId);
    t.head(bea.requestId);
    t.tunnel.abortGuest('ann');
    expect((await ann[1].response).status).toBe(403);
    await expect((await ann[0].response).arrayBuffer()).rejects.toThrow();
    t.chunk(bea.requestId, 0, bytes(3));
    t.end(bea.requestId, 3);
    expect(new Uint8Array(await (await bea.response).arrayBuffer())).toEqual(bytes(3));
  });

  it('ignores another host connection’s frames, and fails a replaced host’s requests', async () => {
    const t = tunnelWithHost();
    const req = t.open();
    t.head(req.requestId, 200, []);
    t.host({ type: 'preview:response-chunk', requestId: req.requestId, seq: 0, data: toBase64Url(bytes(5)) }, 'host-2');
    expect(t.tunnel.heldBytes).toBe(0);
    const waiting = t.open();
    t.tunnel.abortHost('host-1');
    expect((await waiting.response).status).toBe(503);
    await expect((await req.response).arrayBuffer()).rejects.toThrow();
  });

  it('lets a cancelled request go, and tells the host only while it is still sending', async () => {
    const t = tunnelWithHost();
    const before = new AbortController();
    const early = t.open('ann', 'GET', before.signal);
    before.abort();
    await early.response;
    expect(t.aborts()).toEqual([{ type: 'preview:abort', requestId: early.requestId, code: 'CANCELLED' }]);

    const after = new AbortController();
    const late = t.open('ann', 'GET', after.signal);
    t.head(late.requestId);
    t.chunk(late.requestId, 0, bytes(10));
    t.end(late.requestId, 10);
    await late.response;
    after.abort();
    expect(t.tunnel.inFlight('ann')).toBe(0);
    expect(t.tunnel.heldBytes).toBe(0);
    expect(t.aborts()).toHaveLength(1);
  });
});
