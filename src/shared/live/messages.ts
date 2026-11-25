import { z } from 'zod';
import type { ElementRef, OwnerKind } from '../types';
import type { ToolErrorCode } from '../ops';
import {
  DISPLAY_NAME_MAX,
  GUEST_ID_RE,
  GUEST_ROLES,
  LIVE_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  MAX_GUESTS,
  MAX_MESSAGE_LENGTH,
  MAX_ID_LENGTH,
  MAX_PREVIEW_HEADERS,
  MAX_PREVIEW_RESPONSE_BYTES,
  MAX_SELECTION_DEPTH,
  MAX_VIEWPORT_WIDTH,
  MIN_VIEWPORT_WIDTH,
  PREVIEW_CHUNK_BYTES,
  PROJECT_NAME_MAX,
  REQUEST_ID_RE,
  ROOM_ID_RE
} from './limits';
import { fromBase64Url, NONCE_BYTES, NONCE_RE, PUBLIC_KEY_BYTES, PUBLIC_KEY_RE, SIGNATURE_BYTES, SIGNATURE_RE } from './crypto';
import { SESSION_DURATION_IDS } from './expiry';
import { isPreviewHeaderName, isPreviewHeaderValue, isPreviewTarget, PREVIEW_ABORT_CODES, PREVIEW_METHODS } from './preview';

/**
 * Every frame of a live session, as JSON text over WebSocket, in four directions: host to relay, relay to host, guest
 * to relay and relay to guest. Each direction has its own union, so a frame that is valid one way (a host's command,
 * a relay's forwarded request carrying a guest ID) is refused when it arrives another way. Every object is strict:
 * a field the contract does not name is an error, never dropped. On an established socket the room is implicit, and
 * who sent a frame is what the relay knows of the socket, never what the frame claims.
 *
 * Times are integer milliseconds since the epoch on the relay's clock, which owns every deadline; `now` on the
 * frames that carry deadlines lets the other side show them without trusting its own clock.
 */

// ---------------------------------------------------------------------------
// Fields

/**
 * Characters a name may never hold: controls, the marks that reorder text, and invisible spaces, any of which could
 * make one name look like another in the waiting room. Joiners stay: emoji and some scripts need them.
 */
const UNSAFE_NAME_CHARS = /[\p{Cc}\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

/**
 * A display name as it travels: in Unicode normal form C, every run of spaces or line breaks made one space, trimmed,
 * 1 to `max` characters long, and holding none of the characters above. Null when nothing usable is left.
 */
export function normalizeDisplayName(raw: unknown, max = DISPLAY_NAME_MAX): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!name || UNSAFE_NAME_CHARS.test(name) || [...name].length > max) return null;
  return name;
}

/** A name exactly as `normalizeDisplayName` gives it: the sender normalizes, the reader refuses anything else. */
const label = (max: number) => z.string().refine((s) => normalizeDisplayName(s, max) === s, { message: `Must be 1 to ${max} characters, trimmed, with no control characters.` });
const id = (re: RegExp) => z.string().regex(re);
/** Canonical unpadded base64url of exactly `bytes` bytes. */
const b64 = (re: RegExp, bytes: number) => z.string().regex(re).refine((s) => fromBase64Url(s)?.length === bytes, { message: `Must be ${bytes} bytes as unpadded base64url.` });

const roomId = id(ROOM_ID_RE);
const guestId = id(GUEST_ID_RE);
const requestId = id(REQUEST_ID_RE);
const time = z.number().int().nonnegative();
const version = z.literal(LIVE_PROTOCOL_VERSION);
const role = z.enum(GUEST_ROLES);
const message = z.string().max(MAX_MESSAGE_LENGTH);
const publicKey = b64(PUBLIC_KEY_RE, PUBLIC_KEY_BYTES);
const signature = b64(SIGNATURE_RE, SIGNATURE_BYTES);
const nonce = b64(NONCE_RE, NONCE_BYTES);
const displayName = label(DISPLAY_NAME_MAX);
const projectName = label(PROJECT_NAME_MAX);

const msg = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => z.object({ type: z.literal(type), ...shape }).strict();

// ---------------------------------------------------------------------------
// Room, host identity and admission

/** What happened to a guest's place in the room, as the guest is told it. */
export const GUEST_STATUSES = ['pending', 'admitted', 'declined', 'kicked', 'expired', 'locked', 'ended'] as const;
export type GuestStatus = (typeof GUEST_STATUSES)[number];

/**
 * A host opens a room on the relay's host socket. The relay picks the room ID and the start time, and the session
 * ends `duration` after it starts (capped at 24 hours), on the relay's clock.
 */
const roomCreate = msg('room:create', { version, publicKey, duration: z.enum(SESSION_DURATION_IDS), projectName });
/** The relay's answer once a room is opened or a host has proved itself again: the room as it stands. */
const roomReady = msg('room:ready', { version, roomId, startedAt: time, expiresAt: time, locked: z.boolean(), now: time });
/** A host that lost its socket asks for its room back on the room's socket. */
const hostReconnect = msg('host:reconnect', { version, roomId });
/** The relay's single-use nonce for the host to sign (crypto.ts has the exact bytes). */
const hostChallenge = msg('host:challenge', { roomId, nonce });
const hostProof = msg('host:proof', { roomId, nonce, signature });

const guestJoin = msg('guest:join', { version, displayName });
const guestAdmit = msg('guest:admit', { guestId, role, guestExpiresAt: time.nullable() });
const guestDecline = msg('guest:decline', { guestId });
const guestKick = msg('guest:kick', { guestId });
const guestSetRole = msg('guest:set-role', { guestId, role });
/** Null takes the guest's own deadline away: it stays until the session ends. */
const guestSetExpiry = msg('guest:set-expiry', { guestId, guestExpiresAt: time.nullable() });
const roomSetExpiry = msg('room:set-expiry', { expiresAt: time });
/** A locked room turns away new join requests; everyone already in stays. */
const roomSetLocked = msg('room:set-locked', { locked: z.boolean() });
/** The host ends the session, also when it closes or switches the project. */
const roomEnd = msg('room:end', {});
const roomState = msg('room:state', { startedAt: time, expiresAt: time, locked: z.boolean(), now: time });

/**
 * A short-lived, single-use ticket an admitted guest redeems at the room's admission path for its preview cookie, so
 * no credential ever travels in a link or a preview address.
 */
const previewTicket = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);
const guestStatus = z.discriminatedUnion('status', [
  msg('guest:status', { status: z.literal('pending'), guestId }),
  msg('guest:status', { status: z.literal('admitted'), guestId, role, guestExpiresAt: time.nullable(), sessionExpiresAt: time, projectName, previewTicket: previewTicket.optional(), now: time }),
  msg('guest:status', { status: z.literal('declined') }),
  msg('guest:status', { status: z.literal('kicked') }),
  msg('guest:status', { status: z.literal('expired'), scope: z.enum(['guest', 'session']) }),
  msg('guest:status', { status: z.literal('locked') }),
  msg('guest:status', { status: z.literal('ended') })
]);

const participant = z.discriminatedUnion('status', [
  z.object({ guestId, displayName, status: z.literal('pending') }).strict(),
  z.object({ guestId, displayName, status: z.literal('admitted'), role, guestExpiresAt: time.nullable() }).strict()
]);
/** Everyone in the room. The host sees those waiting too (its join requests); guests see the admitted only. */
const roomRoster = msg('room:roster', { participants: z.array(participant).max(MAX_GUESTS) });

export const PROTOCOL_ERROR_CODES = [
  'INVALID_FRAME',
  'TOO_LARGE',
  'UNSUPPORTED_VERSION',
  'WRONG_STATE',
  'AUTH_FAILED',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'RATE_LIMITED',
  'FORBIDDEN',
  'INTERNAL'
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];
/** The relay refusing a frame or a step. An RPC's own failure is its rpc:response instead. */
const protocolError = msg('protocol:error', { code: z.enum(PROTOCOL_ERROR_CODES), message, requestId: requestId.optional() });

// ---------------------------------------------------------------------------
// Preview tunnel

const headers = (direction: 'request' | 'response') =>
  z
    .array(z.tuple([z.string().refine((n) => isPreviewHeaderName(n, direction), { message: `Not a ${direction} header the preview passes on.` }), z.string().refine(isPreviewHeaderValue, { message: 'Not a valid header value.' })]))
    .max(MAX_PREVIEW_HEADERS);

/** A guest's browser asking for a preview address; `target` is the path (and query) under the room's preview. */
const previewRequest = msg('preview:request', { requestId, guestId, method: z.enum(PREVIEW_METHODS), target: z.string().refine(isPreviewTarget, { message: 'Not a path within the preview.' }), headers: headers('request') });
const previewResponseHead = msg('preview:response-head', {
  requestId,
  status: z.number().int().min(200).max(599),
  headers: headers('response').refine((list) => list.every(([name, value]) => name !== 'location' || isPreviewTarget(value)), { message: 'A redirect must stay within the preview.' })
});
/** Chunks are numbered from zero with no gaps; each holds 1 to 256 KiB of the body. */
const previewResponseChunk = msg('preview:response-chunk', {
  requestId,
  seq: z.number().int().nonnegative(),
  data: z.string().refine(
    (s) => {
      const n = s.length <= Math.ceil((PREVIEW_CHUNK_BYTES * 4) / 3) ? fromBase64Url(s)?.length : undefined;
      return n !== undefined && n >= 1 && n <= PREVIEW_CHUNK_BYTES;
    },
    { message: `Must be 1 to ${PREVIEW_CHUNK_BYTES} bytes as unpadded base64url.` }
  )
});
const previewResponseEnd = msg('preview:response-end', { requestId, totalBytes: z.number().int().min(0).max(MAX_PREVIEW_RESPONSE_BYTES) });
/** Either end stops a response, before its head or midway. */
const previewAbort = msg('preview:abort', { requestId, code: z.enum(PREVIEW_ABORT_CODES) });
/** The project changed or the preview restarted: guests reload what they show. */
const previewReload = msg('preview:reload', {});

// ---------------------------------------------------------------------------
// Remote BuilderApi calls

/**
 * A `BuilderApi` method by its dotted name (`project.apply`). The frame carries any such name; the role decides what
 * runs (capabilities.ts), so a method no role may call is refused with a reason rather than as a malformed frame.
 */
const method = z.string().regex(/^[a-z][A-Za-z]{0,31}\.[a-z][A-Za-z]{0,63}$/);
/** Arguments travel as given; the host checks them against the method before anything runs. */
const args = z.array(z.unknown()).max(8);

/** The engine's own refusals, and what a live session adds: no permission, access ended, read-only, too large, and so on. */
const ENGINE_ERROR_CODES = ['INVALID_ARGUMENT', 'STALE_REVISION', 'SCOPE_MISMATCH', 'PATH_DENIED', 'VALIDATION_FAILED', 'CONFLICT', 'CANCELLED', 'BUSY'] as const satisfies readonly ToolErrorCode[];
export const RPC_ERROR_CODES = [...ENGINE_ERROR_CODES, 'PERMISSION_DENIED', 'EXPIRED', 'READ_ONLY', 'TOO_LARGE', 'UNAVAILABLE', 'INTERNAL'] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];
// Every engine refusal can be passed on as it is.
const _everyEngineCode: Exclude<ToolErrorCode, RpcErrorCode> extends never ? true : never = true;
void _everyEngineCode;

const rpcError = z.object({ code: z.enum(RPC_ERROR_CODES), message, recoverable: z.boolean(), operationIndex: z.number().int().nonnegative().optional() }).strict();
export type RpcError = z.infer<typeof rpcError>;

const rpcResponse = <E extends z.ZodRawShape>(extra: E) =>
  z.discriminatedUnion('ok', [
    msg('rpc:response', { ...extra, requestId, method, ok: z.literal(true), result: z.unknown() }),
    msg('rpc:response', { ...extra, requestId, method, ok: z.literal(false), error: rpcError })
  ]);

/** The host's editor events guests follow. Payloads are the host's own, made safe to share before they are sent. */
export const LIVE_EVENTS = ['project:changed', 'runtime:status'] as const;
export type LiveEvent = (typeof LIVE_EVENTS)[number];
const rpcEvent = <E extends z.ZodRawShape>(extra: E) => msg('rpc:event', { ...extra, event: z.enum(LIVE_EVENTS), payload: z.unknown() });

// ---------------------------------------------------------------------------
// Presence

const shortId = z.string().min(1).max(MAX_ID_LENGTH);
const OWNER_KINDS = ['page', 'shell', 'component', 'template'] as const satisfies readonly OwnerKind[];
const elementRef = z
  .object({
    owner: z.object({ kind: z.enum(OWNER_KINDS), id: shortId }).strict(),
    instancePath: z.array(shortId).max(MAX_SELECTION_DEPTH),
    nodeId: shortId,
    partId: shortId.optional(),
    itemPath: z.array(shortId).max(MAX_SELECTION_DEPTH).optional(),
    slot: shortId.optional()
  })
  .strict();
/** What a participant is looking at, replacing whatever it showed before. Null clears a page or a selection. */
const presence = z.object({ pageId: shortId.nullable(), viewportWidth: z.number().int().min(MIN_VIEWPORT_WIDTH).max(MAX_VIEWPORT_WIDTH), selection: elementRef.nullable() }).strict();
const presenceUpdate = msg('presence:update', { presence });
const presenceChanged = msg('presence:changed', { participant: z.discriminatedUnion('kind', [z.object({ kind: z.literal('host') }).strict(), z.object({ kind: z.literal('guest'), guestId }).strict()]), presence });

// Presence selections are the editor's own element references.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _selectionIsElementRef: Same<z.infer<typeof elementRef>, ElementRef> = true;
void _selectionIsElementRef;

// ---------------------------------------------------------------------------
// The four directions

const HOST_TO_RELAY = z.discriminatedUnion('type', [
  roomCreate,
  hostReconnect,
  hostProof,
  guestAdmit,
  guestDecline,
  guestKick,
  guestSetRole,
  guestSetExpiry,
  roomSetExpiry,
  roomSetLocked,
  roomEnd,
  previewResponseHead,
  previewResponseChunk,
  previewResponseEnd,
  previewAbort,
  previewReload,
  // The host answers the guest that asked, and sends events to one guest or, with no guest ID, to all admitted.
  rpcResponse({ guestId }),
  rpcEvent({ guestId: guestId.optional() }),
  presenceUpdate
]);

const RELAY_TO_HOST = z.discriminatedUnion('type', [
  roomReady,
  hostChallenge,
  roomState,
  roomRoster,
  previewRequest,
  previewAbort,
  // The relay names the guest a request came from; the host never takes a guest's word for it.
  msg('rpc:request', { guestId, requestId, method, args }),
  presenceChanged,
  protocolError
]);

const GUEST_TO_RELAY = z.discriminatedUnion('type', [guestJoin, msg('rpc:request', { requestId, method, args }), presenceUpdate]);

const RELAY_TO_GUEST = z.discriminatedUnion('type', [guestStatus, roomState, roomRoster, previewReload, rpcResponse({}), rpcEvent({}), presenceChanged, protocolError]);

export const FRAME_SCHEMAS = { 'host-to-relay': HOST_TO_RELAY, 'relay-to-host': RELAY_TO_HOST, 'guest-to-relay': GUEST_TO_RELAY, 'relay-to-guest': RELAY_TO_GUEST } as const;
export type Direction = keyof typeof FRAME_SCHEMAS;
export type HostToRelay = z.infer<typeof HOST_TO_RELAY>;
export type RelayToHost = z.infer<typeof RELAY_TO_HOST>;
export type GuestToRelay = z.infer<typeof GUEST_TO_RELAY>;
export type RelayToGuest = z.infer<typeof RELAY_TO_GUEST>;
export type FrameOf<D extends Direction> = z.infer<(typeof FRAME_SCHEMAS)[D]>;
/** One frame type of a direction, such as `Frame<'relay-to-host', 'rpc:request'>`. */
export type Frame<D extends Direction, T extends FrameOf<D>['type']> = Extract<FrameOf<D>, { type: T }>;
export type Presence = z.infer<typeof presence>;
export type Participant = z.infer<typeof participant>;

/** The `type` values a union's options carry; an option that is itself a union (guest:status, rpc:response) has one. */
function typesOf(schema: { options: readonly unknown[] }): ReadonlySet<string> {
  return new Set(schema.options.map((option) => ((option as { options?: readonly unknown[] }).options?.[0] ?? option) as { shape: { type: { value: string } } }).map((o) => o.shape.type.value));
}
/** The frame types each direction carries. */
export const FRAME_TYPES: Readonly<Record<Direction, ReadonlySet<string>>> = {
  'host-to-relay': typesOf(HOST_TO_RELAY),
  'relay-to-host': typesOf(RELAY_TO_HOST),
  'guest-to-relay': typesOf(GUEST_TO_RELAY),
  'relay-to-guest': typesOf(RELAY_TO_GUEST)
};

// ---------------------------------------------------------------------------
// Reading and writing frames

export type FrameErrorCode = 'NOT_TEXT' | 'TOO_LARGE' | 'INVALID_JSON' | 'UNKNOWN_TYPE' | 'INVALID';
export interface FrameError {
  code: FrameErrorCode;
  message: string;
  /** Where in the frame the first problem is, as a dotted path (`presence.selection.nodeId`). */
  path?: string;
}
export type FrameResult<T> = { ok: true; frame: T } | { ok: false; error: FrameError };

/** UTF-8 length of a string, counted without encoding it. A lone surrogate counts as the three bytes it is sent as. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const fail = (code: FrameErrorCode, message: string, path?: string): { ok: false; error: FrameError } => ({ ok: false, error: path ? { code, message, path } : { code, message } });

/**
 * Read one frame arriving in `direction`. The size is checked before anything is parsed; then the JSON, the frame's
 * type against what this direction carries, and its every field. Nothing here throws.
 */
export function parseFrame<D extends Direction>(direction: D, input: unknown): FrameResult<FrameOf<D>> {
  if (typeof input !== 'string') return fail('NOT_TEXT', 'Frames are JSON text.');
  // Every UTF-16 unit is at least one byte, so a string longer than the limit is too large without counting.
  if (input.length > MAX_FRAME_BYTES || utf8Length(input) > MAX_FRAME_BYTES) return fail('TOO_LARGE', `Frames are at most ${MAX_FRAME_BYTES} bytes.`);
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return fail('INVALID_JSON', 'The frame is not JSON.');
  }
  return checkFrame(direction, value);
}

/** Check a frame already read from JSON, as parseFrame does after parsing. */
export function checkFrame<D extends Direction>(direction: D, value: unknown): FrameResult<FrameOf<D>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID', 'A frame is a JSON object.');
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !FRAME_TYPES[direction].has(type)) return fail('UNKNOWN_TYPE', `${typeof type === 'string' ? `"${type.slice(0, 40)}"` : 'A frame with no type'} is not a frame sent ${direction.replace(/-/g, ' ')}.`, 'type');
  const parsed = FRAME_SCHEMAS[direction].safeParse(value);
  if (parsed.success) return { ok: true, frame: parsed.data as FrameOf<D> };
  const issue = parsed.error.issues[0];
  const path = issue.path.map(String).join('.');
  return fail('INVALID', `${path || 'frame'}: ${issue.message}`.slice(0, MAX_MESSAGE_LENGTH), path || undefined);
}

/** A frame as the text to send in `direction`, checked as its reader will check it, so nothing is sent that would be refused. */
export function encodeFrame<D extends Direction>(direction: D, frame: FrameOf<D>): FrameResult<string> {
  const checked = checkFrame(direction, frame);
  if (!checked.ok) return checked;
  const text = JSON.stringify(checked.frame);
  if (utf8Length(text) > MAX_FRAME_BYTES) return fail('TOO_LARGE', `Frames are at most ${MAX_FRAME_BYTES} bytes.`);
  return { ok: true, frame: text };
}
