import { describe, expect, it } from 'vitest';
import { checkFrame, encodeFrame, FRAME_TYPES, normalizeDisplayName, parseFrame, utf8Length, type Direction, type Frame, type FrameOf, type Presence } from '@shared/live/messages';
import { toBase64Url } from '@shared/live/crypto';
import { MAX_FRAME_BYTES, PREVIEW_CHUNK_BYTES } from '@shared/live/limits';

const T = Date.UTC(2026, 10, 25, 9, 0, 0);
const HOUR = 3_600_000;
const roomId = 'abcdefghijkmnpqrstuvwxyz';
const guestId = 'g_7Hq2';
const requestId = 'req_1';
const publicKey = toBase64Url(new Uint8Array(32).fill(7));
const nonce = toBase64Url(new Uint8Array(32).fill(9));
const signature = toBase64Url(new Uint8Array(64).fill(3));
const presence: Presence = { pageId: 'pg_home', viewportWidth: 1280, selection: { owner: { kind: 'page', id: 'pg_home' }, instancePath: ['n_card'], nodeId: 'n_title', itemPath: ['it_1'], slot: 'body' } };
const rpcError = { code: 'PERMISSION_DENIED', message: 'A viewer cannot edit.', recoverable: false } as const;

/** One valid frame of every type, in every direction it travels. */
const VALID: { [D in Direction]: FrameOf<D>[] } = {
  'host-to-relay': [
    { type: 'room:create', version: 1, publicKey, duration: '2h', projectName: 'Acme Bakery' },
    { type: 'host:reconnect', version: 1, roomId },
    { type: 'host:proof', roomId, nonce, signature },
    { type: 'guest:admit', guestId, role: 'viewer', guestExpiresAt: null },
    { type: 'guest:admit', guestId, role: 'collaborator', guestExpiresAt: T + HOUR },
    { type: 'guest:decline', guestId },
    { type: 'guest:kick', guestId },
    { type: 'guest:set-role', guestId, role: 'collaborator' },
    { type: 'guest:set-expiry', guestId, guestExpiresAt: null },
    { type: 'room:set-expiry', expiresAt: T + 8 * HOUR },
    { type: 'room:set-locked', locked: true },
    { type: 'room:end' },
    { type: 'preview:response-head', requestId, status: 200, headers: [['content-type', 'text/html; charset=utf-8'], ['cache-control', 'no-cache']] },
    { type: 'preview:response-head', requestId, status: 302, headers: [['location', '/about/']] },
    { type: 'preview:response-chunk', requestId, seq: 0, data: toBase64Url(new TextEncoder().encode('<h1>Hi</h1>')) },
    { type: 'preview:response-end', requestId, totalBytes: 11 },
    { type: 'preview:abort', requestId, code: 'TOO_LARGE' },
    { type: 'preview:reload' },
    { type: 'rpc:response', guestId, requestId, method: 'project.snapshot', ok: true, result: { revision: 3 } },
    { type: 'rpc:response', guestId, requestId, method: 'project.apply', ok: false, error: { ...rpcError, operationIndex: 2 } },
    { type: 'rpc:event', event: 'project:changed', payload: { revision: 4 } },
    { type: 'rpc:event', guestId, event: 'runtime:status', payload: { state: 'ready' } },
    { type: 'presence:update', presence },
    { type: 'presence:update', presence: { pageId: null, viewportWidth: 390, selection: null } }
  ],
  'relay-to-host': [
    { type: 'room:ready', version: 1, roomId, startedAt: T, expiresAt: T + 2 * HOUR, locked: false, now: T },
    { type: 'host:challenge', roomId, nonce },
    { type: 'room:state', startedAt: T, expiresAt: T + 4 * HOUR, locked: true, now: T + HOUR },
    {
      type: 'room:roster',
      participants: [
        { guestId: 'g_1', displayName: 'Sam Lee', status: 'pending' },
        { guestId: 'g_2', displayName: 'Ana 👩\u200d💻', status: 'admitted', role: 'collaborator', guestExpiresAt: T + HOUR }
      ]
    },
    { type: 'preview:request', requestId, guestId, method: 'GET', target: '/about/?ref=nav', headers: [['accept', 'text/html'], ['if-none-match', 'W/"abc"']] },
    { type: 'preview:abort', requestId, code: 'CANCELLED' },
    { type: 'rpc:request', guestId, requestId, method: 'project.apply', args: [{ operations: [] }] },
    { type: 'presence:changed', participant: { kind: 'guest', guestId }, presence },
    { type: 'protocol:error', code: 'ROOM_FULL', message: 'The room is full.' },
    { type: 'protocol:error', code: 'INVALID_FRAME', message: 'Bad frame.', requestId }
  ],
  'guest-to-relay': [
    { type: 'guest:join', version: 1, displayName: 'Sam Lee' },
    { type: 'rpc:request', requestId, method: 'project.snapshot', args: [] },
    { type: 'presence:update', presence }
  ],
  'relay-to-guest': [
    { type: 'guest:status', status: 'pending', guestId },
    { type: 'guest:status', status: 'admitted', guestId, role: 'viewer', guestExpiresAt: null, sessionExpiresAt: T + 2 * HOUR, projectName: 'Acme Bakery', previewTicket: 'tkt_0123456789abcdef', now: T },
    { type: 'guest:status', status: 'admitted', guestId, role: 'collaborator', guestExpiresAt: T + HOUR, sessionExpiresAt: T + 2 * HOUR, projectName: 'Acme Bakery', now: T },
    { type: 'guest:status', status: 'declined' },
    { type: 'guest:status', status: 'kicked' },
    { type: 'guest:status', status: 'expired', scope: 'guest' },
    { type: 'guest:status', status: 'expired', scope: 'session' },
    { type: 'guest:status', status: 'locked' },
    { type: 'guest:status', status: 'ended' },
    { type: 'room:state', startedAt: T, expiresAt: T + 2 * HOUR, locked: false, now: T },
    { type: 'room:roster', participants: [{ guestId, displayName: 'Sam Lee', status: 'admitted', role: 'viewer', guestExpiresAt: null }] },
    { type: 'preview:reload' },
    { type: 'rpc:response', requestId, method: 'project.snapshot', ok: true, result: null },
    { type: 'rpc:response', requestId, method: 'project.apply', ok: false, error: rpcError },
    { type: 'rpc:event', event: 'project:changed', payload: { revision: 5 } },
    { type: 'presence:changed', participant: { kind: 'host' }, presence },
    { type: 'protocol:error', code: 'TOO_LARGE', message: 'Frames are at most 786432 bytes.' }
  ]
};

const directions = Object.keys(VALID) as Direction[];
const json = (v: unknown) => JSON.stringify(v);

describe('valid frames', () => {
  it('cover every frame type of every direction', () => {
    for (const d of directions) expect(new Set(VALID[d].map((f) => f.type)), d).toEqual(new Set(FRAME_TYPES[d]));
  });

  it('round-trip through encoding and parsing unchanged', () => {
    for (const d of directions)
      for (const frame of VALID[d]) {
        const text = encodeFrame(d, frame as never);
        expect(text, `${d} ${frame.type}`).toMatchObject({ ok: true });
        const back = parseFrame(d, (text as { frame: string }).frame);
        expect(back, `${d} ${frame.type}`).toEqual({ ok: true, frame });
      }
  });

  it('narrow by type, with the relay naming the guest only where the host reads it', () => {
    const parsed = parseFrame('relay-to-host', json({ type: 'rpc:request', guestId, requestId, method: 'project.snapshot', args: [] }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.frame.type === 'rpc:request') {
      const from: string = parsed.frame.guestId;
      expect(from).toBe(guestId);
    }
    const fromGuest: Frame<'guest-to-relay', 'rpc:request'> = {
      type: 'rpc:request',
      requestId,
      method: 'project.snapshot',
      args: [],
      // @ts-expect-error a guest never names itself
      guestId
    };
    expect(checkFrame('guest-to-relay', fromGuest)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });
});

describe('refused frames', () => {
  const refused = (d: Direction, input: unknown) => {
    const r = parseFrame(d, typeof input === 'string' ? input : json(input));
    expect(r.ok, `${d} ${json(input)?.slice(0, 120)}`).toBe(false);
    return r.ok ? null : r.error;
  };

  it('need JSON text', () => {
    expect(parseFrame('guest-to-relay', new ArrayBuffer(4))).toEqual({ ok: false, error: { code: 'NOT_TEXT', message: expect.any(String) } });
    expect(parseFrame('guest-to-relay', undefined)).toMatchObject({ ok: false, error: { code: 'NOT_TEXT' } });
    expect(refused('guest-to-relay', '{"type":')).toMatchObject({ code: 'INVALID_JSON' });
    for (const v of ['[]', 'null', '42', '"guest:join"']) expect(refused('guest-to-relay', v)).toMatchObject({ code: 'INVALID' });
  });

  it('name a type this direction carries', () => {
    expect(refused('guest-to-relay', { type: 'guest:explode' })).toMatchObject({ code: 'UNKNOWN_TYPE', path: 'type' });
    expect(refused('guest-to-relay', { version: 1, displayName: 'Sam' })).toMatchObject({ code: 'UNKNOWN_TYPE' });
    expect(refused('guest-to-relay', { type: 'toString' })).toMatchObject({ code: 'UNKNOWN_TYPE' });
    // Host commands from a guest, and relay frames sent the wrong way, are refused by type.
    expect(refused('guest-to-relay', { type: 'guest:admit', guestId, role: 'collaborator', guestExpiresAt: null })).toMatchObject({ code: 'UNKNOWN_TYPE' });
    expect(refused('guest-to-relay', { type: 'preview:response-chunk', requestId, seq: 0, data: 'AA' })).toMatchObject({ code: 'UNKNOWN_TYPE' });
    expect(refused('host-to-relay', { type: 'rpc:request', guestId, requestId, method: 'project.snapshot', args: [] })).toMatchObject({ code: 'UNKNOWN_TYPE' });
    expect(refused('relay-to-guest', { type: 'host:challenge', roomId, nonce })).toMatchObject({ code: 'UNKNOWN_TYPE' });
  });

  it('carry exactly the fields of their type', () => {
    // A guest claiming another guest's identity, or a host command hidden in a guest frame.
    expect(refused('guest-to-relay', { type: 'rpc:request', guestId: 'g_other', requestId, method: 'project.apply', args: [] })).toMatchObject({ code: 'INVALID' });
    expect(refused('guest-to-relay', { type: 'guest:join', version: 1, displayName: 'Sam', role: 'collaborator' })).toMatchObject({ code: 'INVALID' });
    expect(refused('host-to-relay', { type: 'room:create', version: 1, duration: '2h', projectName: 'Acme' })).toMatchObject({ code: 'INVALID', path: 'publicKey' });
    expect(refused('relay-to-guest', { type: 'guest:status', status: 'admitted', guestId })).toMatchObject({ code: 'INVALID' });
    expect(refused('relay-to-guest', { type: 'guest:status', status: 'banished' })).toMatchObject({ code: 'INVALID', path: 'status' });
    expect(refused('relay-to-guest', { type: 'rpc:response', requestId, method: 'project.snapshot', ok: true, result: 1, error: rpcError })).toMatchObject({ code: 'INVALID' });
    expect(refused('host-to-relay', { type: 'rpc:response', requestId, method: 'project.snapshot', ok: true, result: 1 })).toMatchObject({ code: 'INVALID', path: 'guestId' });
  });

  it('use the current protocol version, valid IDs and real times', () => {
    expect(refused('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Sam' })).toMatchObject({ code: 'INVALID', path: 'version' });
    expect(refused('host-to-relay', { type: 'host:reconnect', version: 1, roomId: roomId.toUpperCase() })).toMatchObject({ path: 'roomId' });
    expect(refused('host-to-relay', { type: 'guest:kick', guestId: 'g 1' })).toMatchObject({ path: 'guestId' });
    expect(refused('guest-to-relay', { type: 'rpc:request', requestId: 'r'.repeat(65), method: 'project.snapshot', args: [] })).toMatchObject({ path: 'requestId' });
    expect(refused('guest-to-relay', { type: 'rpc:request', requestId, method: 'project', args: [] })).toMatchObject({ path: 'method' });
    expect(refused('guest-to-relay', { type: 'rpc:request', requestId, method: 'project.snapshot', args: Array(9).fill(0) })).toMatchObject({ path: 'args' });
    expect(refused('host-to-relay', { type: 'room:set-expiry', expiresAt: T + 0.5 })).toMatchObject({ path: 'expiresAt' });
    expect(refused('host-to-relay', { type: 'room:create', version: 1, publicKey, duration: '24h', projectName: 'Acme' })).toMatchObject({ path: 'duration' });
    expect(refused('host-to-relay', { type: 'guest:admit', guestId, role: 'host', guestExpiresAt: null })).toMatchObject({ path: 'role' });
  });

  it('hold keys, nonces and signatures in their one canonical spelling', () => {
    const last = publicKey.at(-1)!;
    const sameBytesOtherSpelling = publicKey.slice(0, -1) + String.fromCharCode(last.charCodeAt(0) + 1);
    expect(refused('host-to-relay', { type: 'room:create', version: 1, publicKey: sameBytesOtherSpelling, duration: '2h', projectName: 'Acme' })).toMatchObject({ path: 'publicKey' });
    expect(refused('host-to-relay', { type: 'host:proof', roomId, nonce, signature: signature.slice(2) })).toMatchObject({ path: 'signature' });
    expect(refused('relay-to-host', { type: 'host:challenge', roomId, nonce: `${nonce}=` })).toMatchObject({ path: 'nonce' });
  });

  it('refuse names that are blank, too long, untrimmed or disguised', () => {
    for (const displayName of ['', ' Sam', 'Sam ', 'Sam  Lee', 'x'.repeat(41), 'Sam\u202eeL', 'Sa\u200bm', 'Sam\nLee', 'Sam\u0007'])
      expect(refused('guest-to-relay', { type: 'guest:join', version: 1, displayName })).toMatchObject({ code: 'INVALID', path: 'displayName' });
  });

  it('are refused by their size in UTF-8 bytes, before any parsing', () => {
    // Fits in JavaScript string length, but not in bytes.
    const euros = json({ type: 'guest:join', version: 1, displayName: '€'.repeat(300_000) });
    expect(euros.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(refused('guest-to-relay', euros)).toMatchObject({ code: 'TOO_LARGE' });
    expect(refused('guest-to-relay', `{${' '.repeat(MAX_FRAME_BYTES)}`)).toMatchObject({ code: 'TOO_LARGE' });
    // Something within the limit is read as usual (and refused for what it is).
    expect(refused('guest-to-relay', `{${' '.repeat(MAX_FRAME_BYTES - 10)}`)).toMatchObject({ code: 'INVALID_JSON' });
  });

  it('are never encoded: an invalid frame, or one too large to send', () => {
    expect(encodeFrame('guest-to-relay', { type: 'guest:join', version: 1, displayName: ' x ' })).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    const huge = { type: 'rpc:response', guestId, requestId, method: 'project.snapshot', ok: true, result: 'x'.repeat(MAX_FRAME_BYTES) } as const;
    expect(encodeFrame('host-to-relay', huge)).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
  });
});

describe('preview frames', () => {
  const request = (target: string, headers: Array<[string, string]> = []) => ({ type: 'preview:request', requestId, guestId, method: 'GET', target, headers });
  const head = (headers: Array<[string, string]>, status = 200) => ({ type: 'preview:response-head', requestId, status, headers });
  const chunk = (data: string) => ({ type: 'preview:response-chunk', requestId, seq: 0, data });

  it('carry chunks of 1 byte up to 256 KiB, in canonical base64url', () => {
    expect(parseFrame('host-to-relay', json(chunk(toBase64Url(new Uint8Array(PREVIEW_CHUNK_BYTES).fill(255)))))).toMatchObject({ ok: true });
    expect(parseFrame('host-to-relay', json(chunk(toBase64Url(new Uint8Array(1)))))).toMatchObject({ ok: true });
    for (const data of [toBase64Url(new Uint8Array(PREVIEW_CHUNK_BYTES + 1)), '', 'AA==', 'A+/A', 'AB'])
      expect(parseFrame('host-to-relay', json(chunk(data))), data.slice(0, 8)).toMatchObject({ ok: false, error: { path: 'data' } });
  });

  it('ask only for paths within the preview', () => {
    for (const target of ['/', '/about/', '/_app/immutable/entry.js?v=2', '/search/?q=a/b', '/caf%C3%A9/'])
      expect(parseFrame('relay-to-host', json(request(target))), target).toMatchObject({ ok: true });
    for (const target of ['', 'about', '//evil.example/x', 'http://127.0.0.1:5173/', '/../secrets', '/a/./b', '/a/%2e%2E/b', '/a%2fb', '/a%5Cb', '/a\\b', '/a#frag', '/a b', '/a%00', '/%E0%A4%A', `/${'a'.repeat(2048)}`])
      expect(parseFrame('relay-to-host', json(request(target))), target).toMatchObject({ ok: false, error: { path: 'target' } });
    expect(parseFrame('relay-to-host', json({ ...request('/'), method: 'POST' }))).toMatchObject({ ok: false, error: { path: 'method' } });
  });

  it('pass on only the headers a read-only preview needs', () => {
    expect(parseFrame('relay-to-host', json(request('/', [['range', 'bytes=0-99']])))).toMatchObject({ ok: true });
    for (const header of [['cookie', 'a=b'], ['authorization', 'Bearer x'], ['host', '127.0.0.1'], ['Accept', 'text/html'], ['accept', 'a\r\nset-cookie: x']] as Array<[string, string]>)
      expect(parseFrame('relay-to-host', json(request('/', [header]))), header[0]).toMatchObject({ ok: false });
    for (const header of [['set-cookie', 'a=b'], ['connection', 'close'], ['transfer-encoding', 'chunked'], ['location', '//evil.example/'], ['location', 'http://127.0.0.1:5173/']] as Array<[string, string]>)
      expect(parseFrame('host-to-relay', json(head([header]))), header.join(': ')).toMatchObject({ ok: false });
    expect(parseFrame('host-to-relay', json(head([], 101)))).toMatchObject({ ok: false, error: { path: 'status' } });
  });
});

describe('display names and byte counts', () => {
  it('normalizes a name for sending', () => {
    expect(normalizeDisplayName('  Sam \t Lee \n')).toBe('Sam Lee');
    expect(normalizeDisplayName('Cafe\u0301')).toBe('Café');
    expect(normalizeDisplayName('👍'.repeat(40))).toBe('👍'.repeat(40));
    expect(normalizeDisplayName('👍'.repeat(41))).toBeNull();
    expect(normalizeDisplayName('👩\u200d💻 Ana')).toBe('👩\u200d💻 Ana');
    for (const bad of ['   ', 'Sam\u202e', '\u200bSam', 'Sam\u0000', 42, null]) expect(normalizeDisplayName(bad)).toBeNull();
  });

  it('counts UTF-8 bytes as they are sent', () => {
    expect(utf8Length('a')).toBe(1);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('\ud800')).toBe(3);
    const sample = 'Café 😀 € \u2028 x';
    expect(utf8Length(sample)).toBe(new TextEncoder().encode(sample).length);
  });
});
