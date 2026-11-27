import { describe, expect, it } from 'vitest';
import { checkFrame, encodeFrame, FRAME_TYPES, frameLimit, normalizeDisplayName, parseFrame, utf8Length, type Direction, type Frame, type FrameOf, type Presence } from '@shared/live/messages';
import { toBase64Url } from '@shared/live/crypto';
import { canCall } from '@shared/live/roles';
import { GUEST_FRAME_HEADROOM_BYTES, MAX_FRAME_BYTES, PREVIEW_CHUNK_BYTES } from '@shared/live/limits';

const T = Date.UTC(2026, 10, 25, 9, 0, 0);
const HOUR = 3_600_000;
const roomId = 'abcdefghijkmnpqrstuvwxyz';
const guestId = 'g_7Hq2';
const requestId = 'req_1';
const publicKey = toBase64Url(new Uint8Array(32).fill(7));
const nonce = toBase64Url(new Uint8Array(32).fill(9));
const signature = toBase64Url(new Uint8Array(64).fill(3));
const presence: Presence = { pageId: 'pg_home', viewportWidth: 1280, selection: { owner: { kind: 'page', id: 'pg_home' }, instancePath: ['n_card'], nodeId: 'n_title', itemPath: ['it_1'], slot: 'body' }, previewPath: '/' };
const rpcError = { code: 'PERMISSION_DENIED', message: 'A viewer cannot edit.', recoverable: false } as const;

/** One valid frame of every type, in every direction it travels. */
const target = { owner: { kind: 'page' as const, id: 'pg_home' }, instancePath: ['n_card'], nodeId: 'n_title', itemPath: ['it_1'] };
const spotlight = { previewPath: '/about/?ref=nav', target, x: 0.25, y: 1 };
const VALID: { [D in Direction]: FrameOf<D>[] } = {
  'host-to-relay': [
    { type: 'room:create', version: 2, publicKey, duration: '2h', projectName: 'Acme Bakery' },
    { type: 'host:reconnect', version: 2, roomId },
    { type: 'host:proof', roomId, nonce, signature },
    { type: 'guest:admit', guestId, role: 'viewer', guestExpiresAt: null },
    { type: 'guest:admit', guestId, role: 'collaborator', guestExpiresAt: T + HOUR },
    { type: 'guest:decline', guestId },
    { type: 'guest:kick', guestId },
    { type: 'guest:set-role', guestId, role: 'collaborator' },
    { type: 'guest:set-role', guestId, role: 'copy-editor' },
    { type: 'guest:set-expiry', guestId, guestExpiresAt: null },
    { type: 'room:set-expiry', expiresAt: T + 8 * HOUR },
    { type: 'room:set-locked', locked: true },
    { type: 'room:end' },
    { type: 'preview:response-head', requestId, status: 200, headers: [['content-type', 'text/html; charset=utf-8'], ['etag', 'W/"1f"']] },
    { type: 'preview:response-head', requestId, status: 302, headers: [['location', '/about/#team']] },
    { type: 'preview:response-chunk', requestId, seq: 0, data: toBase64Url(new TextEncoder().encode('<h1>Hi</h1>')) },
    { type: 'preview:response-end', requestId, totalBytes: 11 },
    { type: 'preview:abort', requestId, code: 'TOO_LARGE' },
    { type: 'preview:reload' },
    { type: 'preview:reload', revision: 12 },
    { type: 'rpc:response', guestId, requestId, method: 'project.snapshot', ok: true, result: { revision: 3 } },
    { type: 'rpc:response', guestId, requestId, method: 'project.apply', ok: false, error: { ...rpcError, operationIndex: 2 } },
    { type: 'rpc:event', event: 'project:changed', payload: { revision: 4 } },
    { type: 'rpc:event', guestId, event: 'runtime:status', payload: { state: 'ready' } },
    { type: 'presence:update', presence },
    { type: 'presence:update', presence: { pageId: null, viewportWidth: 390, selection: null, previewPath: null } },
    { type: 'activity:edit', guestId, target },
    { type: 'activity:edit', guestId, target: null }
  ],
  'relay-to-host': [
    { type: 'room:ready', version: 2, roomId, startedAt: T, expiresAt: T + 2 * HOUR, locked: false, now: T },
    { type: 'host:challenge', roomId, nonce },
    { type: 'room:state', startedAt: T, expiresAt: T + 4 * HOUR, locked: true, now: T + HOUR },
    {
      type: 'room:roster',
      participants: [
        { guestId: 'g_1', displayName: 'Sam Lee', status: 'pending' },
        { guestId: 'g_2', displayName: 'Ana 👩\u200d💻', status: 'admitted', role: 'collaborator', guestExpiresAt: T + HOUR, colorSlot: 3, connected: false }
      ]
    },
    { type: 'preview:request', requestId, guestId, method: 'GET', target: '/about/?ref=nav', headers: [['accept', 'text/html'], ['if-none-match', 'W/"abc"']] },
    { type: 'preview:abort', requestId, code: 'CANCELLED' },
    { type: 'rpc:request', guestId, requestId, method: 'project.apply', args: [{ operations: [] }] },
    { type: 'presence:changed', participant: { kind: 'guest', guestId }, presence },
    { type: 'spotlight:pointed', guestId, spotlight },
    { type: 'spotlight:pointed', guestId, spotlight: { previewPath: '/', target: null, x: 0, y: 0 } },
    { type: 'protocol:error', code: 'ROOM_FULL', message: 'The room is full.' },
    { type: 'protocol:error', code: 'INVALID_FRAME', message: 'Bad frame.', requestId }
  ],
  'guest-to-relay': [
    { type: 'guest:join', version: 2, displayName: 'Sam Lee' },
    { type: 'guest:join', version: 2, displayName: 'Sam Lee', resumeToken: 'rsm_0123456789abcdefghijk' },
    { type: 'guest:leave' },
    { type: 'rpc:request', requestId, method: 'project.snapshot', args: [] },
    { type: 'presence:update', presence },
    { type: 'spotlight:point', spotlight }
  ],
  'relay-to-guest': [
    { type: 'guest:status', status: 'pending', guestId, resumeToken: 'rsm_0123456789abcdefghijk' },
    { type: 'guest:status', status: 'admitted', guestId, role: 'viewer', guestExpiresAt: null, sessionExpiresAt: T + 2 * HOUR, projectName: 'Acme Bakery', previewTicket: 'tkt_0123456789abcdef', now: T },
    { type: 'guest:status', status: 'admitted', guestId, role: 'collaborator', guestExpiresAt: T + HOUR, sessionExpiresAt: T + 2 * HOUR, projectName: 'Acme Bakery', now: T },
    { type: 'guest:status', status: 'admitted', guestId, role: 'copy-editor', guestExpiresAt: null, sessionExpiresAt: T + 2 * HOUR, projectName: 'Acme Bakery', now: T },
    { type: 'guest:status', status: 'declined' },
    { type: 'guest:status', status: 'kicked' },
    { type: 'guest:status', status: 'expired', scope: 'guest' },
    { type: 'guest:status', status: 'expired', scope: 'session' },
    { type: 'guest:status', status: 'locked' },
    { type: 'guest:status', status: 'ended' },
    { type: 'room:state', startedAt: T, expiresAt: T + 2 * HOUR, locked: false, now: T },
    { type: 'host:availability', connected: false },
    { type: 'host:availability', connected: true },
    { type: 'room:roster', participants: [{ guestId, displayName: 'Sam Lee', status: 'admitted', role: 'viewer', guestExpiresAt: null, colorSlot: 0, connected: true }] },
    { type: 'preview:reload' },
    { type: 'rpc:response', requestId, method: 'project.snapshot', ok: true, result: null },
    { type: 'rpc:response', requestId, method: 'project.apply', ok: true, result: { ok: true, revision: 6 } },
    { type: 'rpc:response', requestId, method: 'project.apply', ok: false, error: rpcError },
    { type: 'rpc:event', event: 'project:changed', payload: { revision: 5 } },
    { type: 'presence:changed', participant: { kind: 'host' }, presence },
    { type: 'activity:edited', guestId, target },
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
    const hostRefusal: Frame<'host-to-relay', 'rpc:response'> = {
      type: 'rpc:response',
      guestId,
      requestId,
      // @ts-expect-error the host answers only the methods it was passed
      method: 'ai.providers',
      ok: false,
      error: rpcError
    };
    expect(checkFrame('host-to-relay', hostRefusal)).toMatchObject({ ok: false, error: { path: 'method' } });
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

  it('give a presence path only as a path within the preview, in its URL-encoded form', () => {
    for (const previewPath of ['', 'about/', '//other.test/', '/caf\u00e9/', '/a b/', '/a#b', '/a{b', '/a}b', '/a"b', '/a<b>', '/a`b', '/__open-in-editor', 42])
      expect(refused('host-to-relay', { type: 'presence:update', presence: { pageId: null, viewportWidth: 390, selection: null, previewPath } }), String(previewPath)).toMatchObject({ code: 'INVALID', path: 'presence.previewPath' });
    expect(parseFrame('host-to-relay', json({ type: 'presence:update', presence: { pageId: null, viewportWidth: 390, selection: null, previewPath: '/caf%C3%A9/?tab=1' } })).ok).toBe(true);
    expect(parseFrame('host-to-relay', json({ type: 'presence:update', presence: { pageId: null, viewportWidth: 390, selection: null, previewPath: "/search/o'neil/?filters[tag]=news|all" } })).ok).toBe(true);
  });

  it('name a type this direction carries', () => {
    expect(refused('guest-to-relay', { type: 'guest:explode' })).toMatchObject({ code: 'UNKNOWN_TYPE', path: 'type' });
    expect(refused('guest-to-relay', { version: 2, displayName: 'Sam' })).toMatchObject({ code: 'UNKNOWN_TYPE' });
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
    expect(refused('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Sam', role: 'collaborator' })).toMatchObject({ code: 'INVALID' });
    expect(refused('host-to-relay', { type: 'room:create', version: 2, duration: '2h', projectName: 'Acme' })).toMatchObject({ code: 'INVALID', path: 'publicKey' });
    // An admitted status missing only its session's end.
    expect(refused('relay-to-guest', { type: 'guest:status', status: 'admitted', guestId, role: 'viewer', guestExpiresAt: null, projectName: 'Acme', now: T })).toMatchObject({ code: 'INVALID', path: 'sessionExpiresAt' });
    expect(refused('relay-to-guest', { type: 'guest:status', status: 'pending', guestId })).toMatchObject({ code: 'INVALID', path: 'resumeToken' });
    expect(refused('relay-to-guest', { type: 'guest:status', status: 'banished' })).toMatchObject({ code: 'INVALID', path: 'status' });
    expect(refused('relay-to-guest', { type: 'rpc:response', requestId, method: 'project.snapshot', ok: true, result: 1, error: rpcError })).toMatchObject({ code: 'INVALID' });
    expect(refused('host-to-relay', { type: 'rpc:response', requestId, method: 'project.snapshot', ok: true, result: 1 })).toMatchObject({ code: 'INVALID', path: 'guestId' });
  });

  it('hold a roster of at most eight and a resume token of real length', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ guestId: `g_${i}`, displayName: `Guest ${i}`, status: 'pending' }));
    expect(refused('relay-to-host', { type: 'room:roster', participants: many })).toMatchObject({ code: 'INVALID', path: 'participants' });
    const admitted = many.map((p, i) => ({ ...p, status: 'admitted', role: 'viewer', guestExpiresAt: null, colorSlot: i % 8, connected: true }));
    expect(refused('relay-to-guest', { type: 'room:roster', participants: admitted })).toMatchObject({ code: 'INVALID', path: 'participants' });
    expect(parseFrame('relay-to-guest', json({ type: 'room:roster', participants: admitted.slice(0, 8) }))).toMatchObject({ ok: true });
    expect(refused('guest-to-relay', { type: 'guest:join', version: 2, displayName: 'Sam', resumeToken: 'short' })).toMatchObject({ code: 'INVALID', path: 'resumeToken' });
  });

  it('give each admitted guest one palette place of eight, and say whether it is connected (#768)', () => {
    const guest = (over: Record<string, unknown>) => ({ type: 'room:roster', participants: [{ guestId, displayName: 'Sam', status: 'admitted', role: 'viewer', guestExpiresAt: null, colorSlot: 0, connected: true, ...over }] });
    for (const colorSlot of [-1, 8, 1.5, '0', null]) expect(refused('relay-to-host', guest({ colorSlot })), String(colorSlot)).toMatchObject({ code: 'INVALID', path: 'participants.0.colorSlot' });
    expect(refused('relay-to-guest', guest({ connected: 'yes' }))).toMatchObject({ code: 'INVALID', path: 'participants.0.connected' });
    const { participants } = guest({});
    const { colorSlot: _slot, ...noSlot } = participants[0];
    expect(refused('relay-to-guest', { type: 'room:roster', participants: [noSlot] })).toMatchObject({ code: 'INVALID', path: 'participants.0.colorSlot' });
    expect(parseFrame('relay-to-guest', json(guest({ colorSlot: 7, connected: false })))).toMatchObject({ ok: true });
  });

  it('point only within the page and the preview, at an element named within bounds, and only toward the host (#768)', () => {
    const point = (over: Record<string, unknown>) => ({ type: 'spotlight:point', spotlight: { ...spotlight, ...over } });
    for (const x of [-0.01, 1.01, '0.5', null]) expect(refused('guest-to-relay', point({ x })), String(x)).toMatchObject({ code: 'INVALID', path: 'spotlight.x' });
    expect(refused('guest-to-relay', point({ y: 2 }))).toMatchObject({ code: 'INVALID', path: 'spotlight.y' });
    for (const previewPath of ['', 'about/', '//other.test/', '/a b/', '/a{b', '/__open-in-editor', null]) expect(refused('guest-to-relay', point({ previewPath })), String(previewPath)).toMatchObject({ code: 'INVALID', path: 'spotlight.previewPath' });
    expect(refused('guest-to-relay', point({ target: { ...target, nodeId: 'n'.repeat(129) } }))).toMatchObject({ code: 'INVALID', path: 'spotlight.target.nodeId' });
    expect(refused('guest-to-relay', point({ target: { ...target, instancePath: Array(17).fill('n') } }))).toMatchObject({ code: 'INVALID', path: 'spotlight.target.instancePath' });
    expect(refused('guest-to-relay', point({ target: { ...target, owner: { kind: 'site', id: 'x' } } }))).toMatchObject({ code: 'INVALID', path: 'spotlight.target.owner.kind' });
    expect(refused('guest-to-relay', point({ cursor: [1, 2] }))).toMatchObject({ code: 'INVALID' });
    // A guest never names who pointed, nor whose edit it was; the relay does, and only toward the host or collaborators.
    expect(refused('guest-to-relay', { type: 'spotlight:point', guestId: 'g_other', spotlight })).toMatchObject({ code: 'INVALID' });
    expect(refused('guest-to-relay', { type: 'spotlight:pointed', guestId, spotlight })).toMatchObject({ code: 'UNKNOWN_TYPE' });
    expect(refused('relay-to-guest', { type: 'spotlight:pointed', guestId, spotlight })).toMatchObject({ code: 'UNKNOWN_TYPE' });
    expect(refused('guest-to-relay', { type: 'activity:edit', guestId, target })).toMatchObject({ code: 'UNKNOWN_TYPE' });
    expect(refused('relay-to-host', { type: 'activity:edited', guestId, target })).toMatchObject({ code: 'UNKNOWN_TYPE' });
  });

  it('never show a guest anyone still waiting', () => {
    const waiting = { type: 'room:roster', participants: [{ guestId: 'g_1', displayName: 'Sam Lee', status: 'pending' }] };
    expect(parseFrame('relay-to-host', json(waiting))).toMatchObject({ ok: true });
    expect(refused('relay-to-guest', waiting)).toMatchObject({ code: 'INVALID', path: 'participants.0.status' });
  });

  it('take a usable Ed25519 key only', () => {
    const identity = toBase64Url(new Uint8Array(32).map((_, i) => (i === 0 ? 1 : 0)));
    expect(refused('host-to-relay', { type: 'room:create', version: 2, publicKey: identity, duration: '2h', projectName: 'Acme' })).toMatchObject({ path: 'publicKey' });
  });

  it('carry any method a guest names, but pass on and answer only those a guest may call', () => {
    // A guest's call to a host-only method is well-formed, so the relay can refuse it with its request ID...
    const call = { type: 'rpc:request', requestId, method: 'ai.providers', args: [] };
    expect(parseFrame('guest-to-relay', json(call))).toMatchObject({ ok: true });
    expect(canCall('collaborator', 'ai.providers')).toBe(false);
    expect(parseFrame('relay-to-guest', json({ type: 'rpc:response', requestId, method: 'ai.providers', ok: false, error: rpcError }))).toMatchObject({ ok: true });
    // ...but it never reaches the host, and nothing answers it as a success.
    expect(refused('relay-to-host', { ...call, guestId })).toMatchObject({ code: 'INVALID', path: 'method' });
    expect(refused('relay-to-guest', { type: 'rpc:response', requestId, method: 'ai.providers', ok: true, result: [] })).toMatchObject({ code: 'INVALID', path: 'method' });
    expect(refused('host-to-relay', { type: 'rpc:response', guestId, requestId, method: 'ai.providers', ok: false, error: rpcError })).toMatchObject({ code: 'INVALID', path: 'method' });
  });

  it('use the current protocol version, valid IDs and real times', () => {
    expect(refused('guest-to-relay', { type: 'guest:join', version: 3, displayName: 'Sam' })).toMatchObject({ code: 'INVALID', path: 'version' });
    expect(refused('host-to-relay', { type: 'host:reconnect', version: 2, roomId: roomId.toUpperCase() })).toMatchObject({ path: 'roomId' });
    expect(refused('host-to-relay', { type: 'guest:kick', guestId: 'g 1' })).toMatchObject({ path: 'guestId' });
    expect(refused('guest-to-relay', { type: 'rpc:request', requestId: 'r'.repeat(65), method: 'project.snapshot', args: [] })).toMatchObject({ path: 'requestId' });
    expect(refused('guest-to-relay', { type: 'rpc:request', requestId, method: 'project', args: [] })).toMatchObject({ path: 'method' });
    expect(refused('guest-to-relay', { type: 'rpc:request', requestId, method: 'project.snapshot', args: Array(9).fill(0) })).toMatchObject({ path: 'args' });
    expect(refused('host-to-relay', { type: 'room:set-expiry', expiresAt: T + 0.5 })).toMatchObject({ path: 'expiresAt' });
    expect(refused('host-to-relay', { type: 'room:create', version: 2, publicKey, duration: '24h', projectName: 'Acme' })).toMatchObject({ path: 'duration' });
    expect(refused('host-to-relay', { type: 'guest:admit', guestId, role: 'host', guestExpiresAt: null })).toMatchObject({ path: 'role' });
  });

  it('hold keys, nonces and signatures in their one canonical spelling', () => {
    const last = publicKey.at(-1)!;
    const sameBytesOtherSpelling = publicKey.slice(0, -1) + String.fromCharCode(last.charCodeAt(0) + 1);
    expect(refused('host-to-relay', { type: 'room:create', version: 2, publicKey: sameBytesOtherSpelling, duration: '2h', projectName: 'Acme' })).toMatchObject({ path: 'publicKey' });
    expect(refused('host-to-relay', { type: 'host:proof', roomId, nonce, signature: signature.slice(2) })).toMatchObject({ path: 'signature' });
    expect(refused('relay-to-host', { type: 'host:challenge', roomId, nonce: `${nonce}=` })).toMatchObject({ path: 'nonce' });
  });

  it('refuse names that are blank, too long, untrimmed or disguised', () => {
    for (const displayName of ['', ' Sam', 'Sam ', 'Sam  Lee', 'x'.repeat(41), '\u2800', '\u3164', 'Sam\u202eeL', 'Sa\u200bm', 'Sam\nLee', 'Sam\u0007', 'Sam\u061c', '\u200d', '\u0301'])
      expect(refused('guest-to-relay', { type: 'guest:join', version: 2, displayName })).toMatchObject({ code: 'INVALID', path: 'displayName' });
  });

  it('are refused by their size in UTF-8 bytes, before any parsing', () => {
    // Fits in JavaScript string length, but not in bytes.
    const euros = json({ type: 'guest:join', version: 2, displayName: '€'.repeat(300_000) });
    expect(euros.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(refused('guest-to-relay', euros)).toMatchObject({ code: 'TOO_LARGE' });
    expect(refused('host-to-relay', `{${' '.repeat(MAX_FRAME_BYTES)}`)).toMatchObject({ code: 'TOO_LARGE' });
    // Something within the limit is read as usual (and refused for what it is).
    expect(refused('host-to-relay', `{${' '.repeat(MAX_FRAME_BYTES - 10)}`)).toMatchObject({ code: 'INVALID_JSON' });
    expect(refused('guest-to-relay', `{${' '.repeat(frameLimit('guest-to-relay') - 10)}`)).toMatchObject({ code: 'INVALID_JSON' });
  });

  it('are never encoded: an invalid frame, or one too large to send', () => {
    expect(encodeFrame('guest-to-relay', { type: 'guest:join', version: 2, displayName: ' x ' })).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    const huge = { type: 'rpc:response', guestId, requestId, method: 'project.snapshot', ok: true, result: 'x'.repeat(MAX_FRAME_BYTES) } as const;
    expect(encodeFrame('host-to-relay', huge)).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
  });

  it('are never encoded when JSON cannot carry them as the reader needs them', () => {
    const answer = (result: unknown) => ({ type: 'rpc:response', guestId, requestId, method: 'project.snapshot', ok: true, result }) as const;
    // JSON drops an undefined result, which the reader then misses.
    expect(encodeFrame('host-to-relay', answer(undefined))).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'result' } });
    expect(encodeFrame('host-to-relay', answer(10n))).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    expect(encodeFrame('host-to-relay', { type: 'rpc:event', event: 'project:changed', payload: undefined })).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'payload' } });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(encodeFrame('host-to-relay', answer(cycle))).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });

  it('carry a guest’s AI access and its own AI request to that guest alone, never to everyone (#769)', () => {
    for (const event of ['ai:access', 'ai:turn'] as const) {
      expect(encodeFrame('host-to-relay', { type: 'rpc:event', guestId, event, payload: {} }), event).toMatchObject({ ok: true });
      expect(encodeFrame('host-to-relay', { type: 'rpc:event', event, payload: {} }), event).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'guestId' } });
      // The relay refuses one that names nobody, whoever wrote it.
      expect(parseFrame('host-to-relay', json({ type: 'rpc:event', event, payload: {} })), event).toMatchObject({ ok: false, error: { path: 'guestId' } });
      // A guest reads it as any other event, its payload as sent: the relay has taken the guest's ID off.
      const payload = { allowed: true, turnsLeft: 2, turn: { runId: 'run-1' } };
      expect(parseFrame('relay-to-guest', json({ type: 'rpc:event', event, payload })), event).toEqual({ ok: true, frame: { type: 'rpc:event', event, payload } });
    }
  });

  it('are as large as they are when written again', () => {
    // Fits as sent, but JSON writes each 1e20 out in twenty-one digits.
    const sent = `{"type":"rpc:request","requestId":"r1","method":"project.apply","args":[[${Array(60_000).fill('1e20').join(',')}]]}`;
    expect(utf8Length(sent)).toBeLessThan(frameLimit('guest-to-relay'));
    expect(refused('guest-to-relay', sent)).toMatchObject({ code: 'TOO_LARGE' });
    // A guest's frame is held to the guest's limit as written, not the host's: one that grows to between the two
    // is refused, though it would fit a host's frame.
    const grows = (count: number) => `{"type":"rpc:request","requestId":"r1","method":"project.apply","args":[[${Array(count).fill('1e3').join(',')}]]}`;
    // Each 1e3 is written as 1000: one byte more. Take just enough of them to pass the guest's limit as written.
    const written = (n: number) => utf8Length(JSON.stringify(JSON.parse(grows(n))));
    const between = Math.floor((frameLimit('guest-to-relay') - written(1) + 5) / 5) + 1;
    expect(written(between)).toBeGreaterThan(frameLimit('guest-to-relay'));
    expect(written(between)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(utf8Length(grows(between))).toBeLessThanOrEqual(frameLimit('guest-to-relay'));
    expect(refused('guest-to-relay', grows(between))).toMatchObject({ code: 'TOO_LARGE' });
  });

  it('from a guest leave room for the guest ID the relay adds', () => {
    expect(frameLimit('guest-to-relay')).toBe(MAX_FRAME_BYTES - GUEST_FRAME_HEADROOM_BYTES);
    const request = (size: number) => {
      const base = json({ type: 'rpc:request', requestId, method: 'project.apply', args: [''] });
      return json({ type: 'rpc:request', requestId, method: 'project.apply', args: ['x'.repeat(size - base.length)] });
    };
    const atGuestLimit = request(frameLimit('guest-to-relay'));
    expect(utf8Length(atGuestLimit)).toBe(frameLimit('guest-to-relay'));
    const fromGuest = parseFrame('guest-to-relay', atGuestLimit);
    expect(fromGuest).toMatchObject({ ok: true });
    // Passed on with the longest guest ID, it still fits.
    const forwarded = { ...(fromGuest as { frame: Frame<'guest-to-relay', 'rpc:request'> }).frame, method: 'project.apply' as const, guestId: 'g'.repeat(64) };
    expect(encodeFrame('relay-to-host', forwarded)).toMatchObject({ ok: true });
    expect(parseFrame('guest-to-relay', request(frameLimit('guest-to-relay') + 1))).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
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
    for (const target of ['/', '/about/', '/_app/immutable/entry.js?v=2', '/search/?q=a/b', '/caf%C3%A9/', '/__route.js', '/@fs//Users/host/site/node_modules/x.js'])
      expect(parseFrame('relay-to-host', json(request(target))), target).toMatchObject({ ok: true });
    for (const target of ['', 'about', '//evil.example/x', 'http://127.0.0.1:5173/', '/../secrets', '/a/./b', '/a/%2e%2E/b', '/a%2fb', '/a%5Cb', '/a\\b', '/a#frag', '/a b', '/a%00', '/%E0%A4%A', `/${'a'.repeat(2048)}`, '/__open-in-editor?file=/etc/hosts', '/%5F_open-in-editor', '/site/__OPEN-IN-EDITOR?file=x', '/site/__open-in-editor.json?file=x'])
      expect(parseFrame('relay-to-host', json(request(target))), target).toMatchObject({ ok: false, error: { path: 'target' } });
    expect(parseFrame('relay-to-host', json({ ...request('/'), method: 'POST' }))).toMatchObject({ ok: false, error: { path: 'method' } });
  });

  it('pass on only the headers a read-only preview needs', () => {
    expect(parseFrame('relay-to-host', json(request('/', [['range', 'bytes=0-99']])))).toMatchObject({ ok: true });
    for (const [header, path] of [
      [['cookie', 'a=b'], 'headers.0.0'],
      [['authorization', 'Bearer x'], 'headers.0.0'],
      [['host', '127.0.0.1'], 'headers.0.0'],
      [['Accept', 'text/html'], 'headers.0.0'],
      [['accept', 'a\r\nset-cookie: x'], 'headers.0.1'],
      [['accept', 'a\u0001b'], 'headers.0.1'],
      [['accept', 'snow \u2603'], 'headers.0.1'],
      [['accept', 'a\u007fb'], 'headers.0.1']
    ] as Array<[[string, string], string]>)
      expect(parseFrame('relay-to-host', json(request('/', [header]))), header[0]).toMatchObject({ ok: false, error: { code: 'INVALID', path } });
    for (const header of [['set-cookie', 'a=b'], ['connection', 'close'], ['transfer-encoding', 'chunked'], ['cache-control', 'public, max-age=3600']] as Array<[string, string]>)
      expect(parseFrame('host-to-relay', json(head([header]))), header[0]).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'headers.0.0' } });
    // A redirect that would leave the preview, on a real redirect status, even after one that stays.
    for (const location of ['//evil.example/', 'http://127.0.0.1:5173/', '/__open-in-editor']) {
      expect(parseFrame('host-to-relay', json(head([['location', location]], 302))), location).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'headers' } });
      expect(parseFrame('host-to-relay', json(head([['location', '/about/'], ['location', location]], 302))), location).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'headers' } });
    }
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
